/**
 * Test helper: route a mocked Neon `sql` function by SQL text instead of by
 * call order.
 *
 * The cron tests used to queue `mockSql.mockResolvedValueOnce(...)` in the
 * exact order the handler issues its queries, so reordering, merging or
 * parallelising a query rewrote most tests. With a router each query is
 * answered by what it asks for: the route whose pattern matches its SQL.
 *
 *   const router = createSqlRouter(mockSql, {
 *     ticks: /FROM ws_option_trades/,
 *     insert: /INSERT INTO lottery_finder_fires/,
 *   });
 *   router.on('ticks', rows);
 *   router.when('insert', (call) => call.params[0] === 'TSLA', [{ id: 7 }]);
 *
 * Both call shapes of the Neon driver are routed: the tagged template
 * (`sql\`SELECT ... ${x}\``) and `sql.query(text, params)`.
 *
 * Guards that keep the router from hiding a query:
 *   - SQL that no route matches rejects, naming the SQL, and is recorded in
 *     `unmatched`. Code that swallows the rejection (a fail-open catch) is
 *     still caught: call `assertNoUnmatched()` in `afterEach`.
 *   - SQL that two routes match rejects too. Patterns must be distinctive,
 *     so the route never depends on table order.
 *   - Every call that reached a route is recorded, so a test can assert which
 *     routes ran (`ran()`, `counts()`) and with which binds (`calls()`).
 *
 * Precedence for the answer to one call of a route: a `once()` answer
 * (consumed in order), else the first `when()` rule whose predicate accepts
 * the call, else the `on()` default, else `[]`.
 *
 * `createSqlRouter` replaces the implementation of the mock it is given, and
 * assigns its `.query`. `vi.resetAllMocks()` wipes both, so create the router
 * after the reset (in `beforeEach`).
 *
 * Not supported: `sql.transaction(...)` and `sql.unsafe(...)`. Define those on
 * the mock yourself if the code under test uses them.
 */

import { vi, type Mock } from 'vitest';

export interface SqlCall<R extends string = string> {
  route: R;
  /** The SQL, with `$1…$n` where each bound value sat in a tagged template. */
  text: string;
  /** The template's literal fragments; `null` for `sql.query` calls. */
  strings: readonly string[] | null;
  params: unknown[];
  via: 'template' | 'query';
}

export interface UnmatchedSqlCall {
  text: string;
  params: unknown[];
  via: 'template' | 'query';
}

export type SqlRows = unknown[];

/**
 * What a route answers: rows; an Error (the call rejects with that instance);
 * or a function of the call and its 0-based index within the route, which
 * returns rows, an Error or a promise of rows. A function that throws rejects,
 * and one that returns a never-settling promise hangs the query.
 */
export type SqlResponse<R extends string = string> =
  | SqlRows
  | Error
  | ((call: SqlCall<R>, nth: number) => SqlRows | Error | Promise<SqlRows>);

export interface SqlRouter<R extends string> {
  /** Default answer for the route (replaces any earlier default). */
  on(route: R, response: SqlResponse<R>): SqlRouter<R>;
  /** Answers for the route's next calls, one per call, consumed in order. */
  once(route: R, ...responses: SqlResponse<R>[]): SqlRouter<R>;
  /** Answer for calls the predicate accepts (standing rule, checked in order). */
  when(
    route: R,
    predicate: (call: SqlCall<R>) => boolean,
    response: SqlResponse<R>,
  ): SqlRouter<R>;
  /** Recorded calls in order: one route's, or every route's. */
  calls(route?: R): SqlCall<R>[];
  /** The route of every recorded call, in call order. */
  ran(): R[];
  /** Calls per route; routes that never ran are absent. */
  counts(): Partial<Record<R, number>>;
  /** SQL that no route (or more than one) matched. */
  readonly unmatched: readonly UnmatchedSqlCall[];
  /** Throws, naming the SQL, when any call was unmatched or ambiguous. */
  assertNoUnmatched(): void;
}

interface Rule<R extends string> {
  predicate: (call: SqlCall<R>) => boolean;
  response: SqlResponse<R>;
}

interface RouteState<R extends string> {
  pattern: RegExp;
  fallback: SqlResponse<R>;
  queue: SqlResponse<R>[];
  rules: Rule<R>[];
  seen: number;
}

const SNIPPET_CHARS = 400;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS
    ? `${flat.slice(0, SNIPPET_CHARS)}…`
    : flat;
}

/** A tagged template's text with `$1…$n` in place of each bound value. */
function templateText(strings: readonly string[]): string {
  let text = strings[0] ?? '';
  for (let i = 1; i < strings.length; i += 1) {
    text += `$${i}${strings[i]}`;
  }
  return text;
}

function isTemplateStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((part) => typeof part === 'string')
  );
}

export function createSqlRouter<R extends string>(
  sql: Mock,
  routes: Record<R, RegExp>,
): SqlRouter<R> {
  const names = Object.keys(routes) as R[];
  if (names.length === 0) {
    throw new Error('sql-router: define at least one route');
  }

  const state = new Map<R, RouteState<R>>();
  for (const name of names) {
    const pattern = routes[name];
    if (pattern.global || pattern.sticky) {
      // test() on a global or sticky RegExp advances lastIndex, so the same
      // SQL would match on one call and miss on the next.
      throw new Error(
        `sql-router: route "${name}" uses a global or sticky pattern; drop the g/y flag`,
      );
    }
    state.set(name, { pattern, fallback: [], queue: [], rules: [], seen: 0 });
  }

  const recorded: SqlCall<R>[] = [];
  const unmatched: UnmatchedSqlCall[] = [];

  const routeState = (route: R): RouteState<R> => {
    const found = state.get(route);
    if (!found) {
      throw new Error(
        `sql-router: unknown route "${route}" (routes: ${names.join(', ')})`,
      );
    }
    return found;
  };

  const reject = (
    why: string,
    text: string,
    params: unknown[],
    via: 'template' | 'query',
  ): Promise<never> => {
    unmatched.push({ text, params, via });
    return Promise.reject(
      new Error(
        `sql-router: ${why}:\n  ${snippet(text)}\nroutes: ${names.join(', ')}`,
      ),
    );
  };

  // Async, so a throwing predicate or responder rejects the query, as a
  // failing Neon call does, instead of throwing out of sql(...). It runs
  // synchronously up to its first await, so once() answers are consumed in
  // call order even when queries are issued in parallel.
  async function answer(
    entry: RouteState<R>,
    call: SqlCall<R>,
    nth: number,
  ): Promise<SqlRows> {
    const queued = entry.queue.shift();
    const response =
      queued ??
      entry.rules.find((rule) => rule.predicate(call))?.response ??
      entry.fallback;
    const value =
      typeof response === 'function' ? await response(call, nth) : response;
    if (value instanceof Error) throw value;
    return value;
  }

  function dispatch(
    text: string,
    strings: readonly string[] | null,
    params: unknown[],
    via: 'template' | 'query',
  ): Promise<SqlRows> {
    const matching = names.filter((name) =>
      routeState(name).pattern.test(text),
    );
    if (matching.length === 0) {
      return reject('no route matches this SQL', text, params, via);
    }
    if (matching.length > 1) {
      return reject(
        `ambiguous SQL, matched by routes ${matching.join(' and ')}`,
        text,
        params,
        via,
      );
    }
    const route = matching[0]!;
    const entry = routeState(route);
    const call: SqlCall<R> = { route, text, strings, params, via };
    recorded.push(call);
    const nth = entry.seen;
    entry.seen += 1;
    return answer(entry, call, nth);
  }

  sql.mockImplementation((...args: unknown[]): Promise<SqlRows> => {
    const [strings, ...params] = args;
    if (!isTemplateStrings(strings)) {
      return Promise.reject(
        new Error(
          'sql-router: sql() can only be called as a tagged template; use sql.query(text, params) for a string',
        ),
      );
    }
    return dispatch(templateText(strings), strings, params, 'template');
  });
  (sql as unknown as { query: Mock }).query = vi.fn(
    (text: string, params: unknown[] = []): Promise<SqlRows> =>
      dispatch(text, null, params, 'query'),
  );

  const router: SqlRouter<R> = {
    on(route, response) {
      routeState(route).fallback = response;
      return router;
    },
    once(route, ...responses) {
      routeState(route).queue.push(...responses);
      return router;
    },
    when(route, predicate, response) {
      routeState(route).rules.push({ predicate, response });
      return router;
    },
    calls(route) {
      if (route === undefined) return [...recorded];
      routeState(route);
      return recorded.filter((call) => call.route === route);
    },
    ran() {
      return recorded.map((call) => call.route);
    },
    counts() {
      const counts: Partial<Record<R, number>> = {};
      for (const call of recorded) {
        counts[call.route] = (counts[call.route] ?? 0) + 1;
      }
      return counts;
    },
    unmatched,
    assertNoUnmatched() {
      if (unmatched.length === 0) return;
      const list = unmatched.map((u) => `  ${snippet(u.text)}`).join('\n');
      throw new Error(
        `sql-router: ${unmatched.length} unmatched or ambiguous SQL call(s):\n${list}`,
      );
    },
  };
  return router;
}
