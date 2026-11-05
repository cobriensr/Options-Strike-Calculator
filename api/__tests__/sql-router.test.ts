// @vitest-environment node

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createSqlRouter,
  type SqlCall,
  type SqlRouter,
} from './helpers/sql-router.js';

const ROUTES = {
  users: /FROM users/,
  orders: /FROM orders/,
  insertOrder: /INSERT INTO orders/,
} as const;
type RouteName = keyof typeof ROUTES;

let sql: Mock;
let router: SqlRouter<RouteName>;

beforeEach(() => {
  sql = vi.fn();
  router = createSqlRouter(sql, ROUTES);
});

const selectUsers = (id: number) => sql`SELECT id FROM users WHERE id = ${id}`;
const selectOrders = (userId: number) =>
  sql`SELECT * FROM orders WHERE user_id = ${userId}`;
const insertOrder = (userId: number, total: number) =>
  sql`INSERT INTO orders (user_id, total) VALUES (${userId}, ${total}) RETURNING id`;

// A promise that never settles must still be pending after a macrotask
// boundary; Promise.race against an already-resolved sentinel shows it.
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const winner = await Promise.race([p, Promise.resolve(sentinel)]);
  return winner === sentinel;
}

describe('createSqlRouter: routing', () => {
  it('routes a tagged-template call to its route and answers [] by default', async () => {
    await expect(selectUsers(7)).resolves.toEqual([]);

    expect(router.ran()).toEqual(['users']);
    const [call] = router.calls('users');
    expect(call).toMatchObject({
      route: 'users',
      via: 'template',
      params: [7],
    });
    expect(call!.text).toBe('SELECT id FROM users WHERE id = $1');
    expect(call!.strings).toEqual(['SELECT id FROM users WHERE id = ', '']);
  });

  it('routes sql.query(text, params) the same way, recorded as a query call', async () => {
    router.on('orders', [{ id: 1 }]);

    const rows = await (
      sql as unknown as {
        query: (text: string, params: unknown[]) => Promise<unknown[]>;
      }
    ).query('SELECT * FROM orders WHERE user_id = $1', [9]);

    expect(rows).toEqual([{ id: 1 }]);
    expect(router.calls('orders')).toEqual([
      {
        route: 'orders',
        via: 'query',
        text: 'SELECT * FROM orders WHERE user_id = $1',
        strings: null,
        params: [9],
      },
    ]);
  });

  it('keeps the underlying mock recording, so bind-extraction helpers still read mock.calls', async () => {
    await insertOrder(3, 25);

    expect(sql).toHaveBeenCalledTimes(1);
    const [strings, ...binds] = sql.mock.calls[0] as [
      readonly string[],
      ...unknown[],
    ];
    expect(strings[0]).toContain('INSERT INTO orders');
    expect(binds).toEqual([3, 25]);
  });

  it('answers each route independently of the order the routes are called in', async () => {
    router.on('users', [{ id: 1 }]).on('orders', [{ id: 2 }]);

    const first = [await selectUsers(1), await selectOrders(1)];
    const second = [await selectOrders(1), await selectUsers(1)];

    expect(first).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    expect(second).toEqual([[{ id: 2 }], [{ id: 1 }]]);
  });

  it('records which routes ran, in call order, with counts for assertions', async () => {
    await selectOrders(1);
    await selectUsers(1);
    await selectOrders(2);
    await insertOrder(1, 5);

    expect(router.ran()).toEqual(['orders', 'users', 'orders', 'insertOrder']);
    expect(router.counts()).toEqual({ orders: 2, users: 1, insertOrder: 1 });
    expect(router.calls().map((c) => c.route)).toEqual(router.ran());
    expect(router.calls('orders').map((c) => c.params)).toEqual([[1], [2]]);
  });
});

describe('createSqlRouter: responses', () => {
  it('on() sets a constant answer and a later on() replaces it', async () => {
    router.on('users', [{ id: 1 }]);
    await expect(selectUsers(1)).resolves.toEqual([{ id: 1 }]);
    await expect(selectUsers(2)).resolves.toEqual([{ id: 1 }]);

    router.on('users', []);
    await expect(selectUsers(3)).resolves.toEqual([]);
  });

  it('once() answers the next calls of that route in order, then falls back to the default', async () => {
    router.on('insertOrder', []);
    router.once('insertOrder', [{ id: 1 }], [{ id: 2 }]);

    await expect(insertOrder(1, 1)).resolves.toEqual([{ id: 1 }]);
    await expect(insertOrder(1, 2)).resolves.toEqual([{ id: 2 }]);
    await expect(insertOrder(1, 3)).resolves.toEqual([]);
  });

  it('once() on one route does not shift the answers of another route', async () => {
    router.once('orders', [{ id: 10 }]);

    await expect(selectUsers(1)).resolves.toEqual([]);
    await expect(selectOrders(1)).resolves.toEqual([{ id: 10 }]);
  });

  it('when() answers only the calls its predicate accepts, by bound params', async () => {
    router.when('users', (call) => call.params[0] === 2, [{ id: 2 }]);

    await expect(selectUsers(1)).resolves.toEqual([]);
    await expect(selectUsers(2)).resolves.toEqual([{ id: 2 }]);
    await expect(selectUsers(2)).resolves.toEqual([{ id: 2 }]);
  });

  it('the first matching when() rule wins, and a once() answer beats every rule', async () => {
    router
      .when('users', () => true, [{ rule: 'first' }])
      .when('users', () => true, [{ rule: 'second' }]);
    await expect(selectUsers(1)).resolves.toEqual([{ rule: 'first' }]);

    router.once('users', [{ rule: 'once' }]);
    await expect(selectUsers(1)).resolves.toEqual([{ rule: 'once' }]);
    await expect(selectUsers(1)).resolves.toEqual([{ rule: 'first' }]);
  });

  it('rejects with the very Error instance it was given', async () => {
    const boom = new Error('connection lost');
    router.on('insertOrder', boom);

    await expect(insertOrder(1, 1)).rejects.toBe(boom);
    expect(router.counts()).toEqual({ insertOrder: 1 });
  });

  it('can fail one call and then recover: once(Error) then the default rows', async () => {
    router.on('users', [{ id: 1 }]).once('users', new Error('blip'));

    await expect(selectUsers(1)).rejects.toThrow('blip');
    await expect(selectUsers(1)).resolves.toEqual([{ id: 1 }]);
  });

  it('passes a responder function the call and its 0-based index within the route', async () => {
    const seen: [SqlCall<RouteName>, number][] = [];
    router.on('insertOrder', (call, nth) => {
      seen.push([call, nth]);
      return [{ id: 100 + nth }];
    });

    await expect(insertOrder(1, 5)).resolves.toEqual([{ id: 100 }]);
    await selectUsers(1); // another route: does not advance the index
    await expect(insertOrder(1, 6)).resolves.toEqual([{ id: 101 }]);

    expect(seen.map(([call, nth]) => [call.params, nth])).toEqual([
      [[1, 5], 0],
      [[1, 6], 1],
    ]);
  });

  it('turns a responder that returns an Error, or throws, into a rejection', async () => {
    router.once(
      'users',
      () => new Error('returned'),
      () => {
        throw new Error('thrown');
      },
    );

    await expect(selectUsers(1)).rejects.toThrow('returned');
    await expect(selectUsers(1)).rejects.toThrow('thrown');
  });

  it('rejects the query, rather than throwing out of sql(), when a when() predicate throws', async () => {
    router.when(
      'users',
      () => {
        throw new Error('bad predicate');
      },
      [],
    );

    let result: Promise<unknown> | undefined;
    expect(() => {
      result = selectUsers(1);
    }).not.toThrow();
    await expect(result).rejects.toThrow('bad predicate');

    // A broken predicate is a test bug, not a simulated database failure, so
    // it is recorded where a swallowing fail-open catch can't hide it. (A
    // responder that throws, by contrast, is a deliberate failure and isn't.)
    expect(router.unmatched).toHaveLength(1);
    expect(router.unmatched[0]).toMatchObject({
      text: 'SELECT id FROM users WHERE id = $1',
      params: [1],
      via: 'template',
    });
    expect(() => router.assertNoUnmatched()).toThrow(
      /1 unmatched.*bad predicate.*SELECT id FROM users/s,
    );
  });

  it('does not count a responder that throws as unmatched: that is a simulated failure', async () => {
    router.on('users', () => {
      throw new Error('simulated outage');
    });

    await expect(selectUsers(1)).rejects.toThrow('simulated outage');

    expect(router.unmatched).toHaveLength(0);
    router.assertNoUnmatched();
  });

  it('consumes once() answers in call order when queries are issued in parallel', async () => {
    router.once('orders', [{ id: 1 }], [{ id: 2 }], [{ id: 3 }]);

    const rows = await Promise.all([
      selectOrders(1),
      selectOrders(2),
      selectOrders(3),
    ]);

    expect(rows).toEqual([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]);
  });

  it('lets a responder hang, for deadline tests', async () => {
    router.on('orders', () => new Promise<never>(() => {}));

    expect(await isPending(selectOrders(1))).toBe(true);
    expect(router.counts()).toEqual({ orders: 1 });
  });
});

describe('createSqlRouter: unmatched and ambiguous SQL', () => {
  it('rejects SQL that no route matches, naming the SQL and the known routes', async () => {
    const result = sql`SELECT secret FROM vault WHERE id = ${1}`;

    await expect(result).rejects.toThrow(/no route matches/);
    await expect(result).rejects.toThrow('SELECT secret FROM vault');
    await expect(result).rejects.toThrow('users, orders, insertOrder');
    expect(router.ran()).toEqual([]);
  });

  it('records unmatched SQL, so assertNoUnmatched() catches one the code under test swallowed', async () => {
    router.assertNoUnmatched();

    // The caller swallows the rejection, as a fail-open catch would.
    await Promise.resolve(sql`SELECT 1 FROM vault`).catch(() => undefined);

    expect(router.unmatched).toHaveLength(1);
    expect(router.unmatched[0]!.text).toBe('SELECT 1 FROM vault');
    expect(() => router.assertNoUnmatched()).toThrow(
      /1 unmatched.*SELECT 1 FROM vault/s,
    );
  });

  it('applies to sql.query() too', async () => {
    const query = (
      sql as unknown as {
        query: (text: string, params: unknown[]) => Promise<unknown[]>;
      }
    ).query;

    await expect(query('DELETE FROM vault WHERE id = $1', [1])).rejects.toThrow(
      'DELETE FROM vault',
    );
    expect(router.unmatched[0]).toMatchObject({
      via: 'query',
      params: [1],
    });
  });

  it('rejects SQL that two routes match, naming both, instead of picking one', async () => {
    const result = sql`SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`;

    await expect(result).rejects.toThrow(/ambiguous/i);
    await expect(result).rejects.toThrow(/users.*orders/s);
    expect(router.unmatched).toHaveLength(1);
    expect(router.ran()).toEqual([]);
  });

  it('rejects a tagged call whose first argument is not a template, as the Neon driver does', async () => {
    await expect(
      (sql as unknown as (text: string) => Promise<unknown[]>)(
        'SELECT 1 FROM users',
      ),
    ).rejects.toThrow(/tagged template/);

    // Recorded, so assertNoUnmatched() catches it even when the caller's
    // fail-open catch swallowed the rejection.
    expect(router.unmatched).toHaveLength(1);
    expect(router.unmatched[0]).toMatchObject({
      text: 'SELECT 1 FROM users',
      via: 'template',
    });
    expect(() => router.assertNoUnmatched()).toThrow(
      /1 unmatched.*tagged template.*SELECT 1 FROM users/s,
    );
  });
});

describe('createSqlRouter: setup guards', () => {
  it('refuses a global or sticky pattern, whose lastIndex would make matching stateful', () => {
    expect(() => createSqlRouter(vi.fn(), { users: /FROM users/g })).toThrow(
      /global or sticky/,
    );
    expect(() => createSqlRouter(vi.fn(), { users: /FROM users/y })).toThrow(
      /global or sticky/,
    );
  });

  it('refuses an empty route table', () => {
    expect(() => createSqlRouter(vi.fn(), {})).toThrow(/at least one route/);
  });

  it('refuses a response registered for a route that is not in the table', () => {
    const loose = router as unknown as SqlRouter<string>;

    expect(() => loose.on('typo', [])).toThrow(/unknown route "typo"/);
    expect(() => loose.once('typo', [])).toThrow(/unknown route "typo"/);
    expect(() => loose.when('typo', () => true, [])).toThrow(
      /unknown route "typo"/,
    );
    expect(() => loose.calls('typo')).toThrow(/unknown route "typo"/);
  });
});
