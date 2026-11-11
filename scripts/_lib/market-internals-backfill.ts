/**
 * Local backfill of `market_internals` from Schwab's settled 1-minute bars
 * (spec: docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.5 and
 * Tier 2). Logic for scripts/backfill-market-internals.ts; it lives here so
 * vitest covers it (scripts/_lib/**).
 *
 * It applies the same rules as the post-close cron, because it uses the same
 * code: api/_lib/market-internals-settle.ts (the session filter, the all-zero
 * bar, the bar count, the $TICK clamp signature, and the batched upsert that
 * REPLACES a stored row holding other values). What differs is the window
 * (`--from`/`--to` instead of the last five sessions) and the default, which
 * is a dry run: it reads Schwab and the table, prints per-day inserted /
 * updated / rejected counts, and writes nothing. `--apply` writes.
 *
 * Schwab serves about 35 sessions of 1-minute bars. A session older than that
 * comes back with no bar and is reported as incomplete (0 of 390), not
 * written.
 */

import { getETDateStr } from '../../src/utils/timezone.js';
import { isTradingDay, parseIsoDate } from '../../src/data/marketHours.js';
import {
  SETTLE_SYMBOLS,
  SettleFailure,
  diffBars,
  fetchWindow,
  parsePriceHistory,
  planSymbol,
  pricehistoryPath,
  readStoredBars,
  sessionProblems,
  settleSessions,
  upsertInternalBars,
  type ChangedBars,
  type SessionProblem,
  type SettleFailureKind,
  type SymbolPlan,
} from '../../api/_lib/market-internals-settle.js';
import { SCHWAB_BASE, redactBody } from './schwab-local.mjs';

// ── Arguments ───────────────────────────────────────────────────────────────

export interface CliArgs {
  apply: boolean;
  /** First session date of the window, `YYYY-MM-DD`; null: the cron's window. */
  from: string | null;
  /** Last session date of the window; null: the newest settled session. */
  to: string | null;
  /** Start inside the Schwab crons' busy window (a market holiday). */
  allowMarketHours: boolean;
  envFile: string | null;
}

const isDateArg = (value: string): boolean => parseIsoDate(value) !== null;

/** `--apply` is the only way to write; `--dry-run` just says the default aloud. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let apply = false;
  let dryRun = false;
  let from: string | null = null;
  let to: string | null = null;
  let allowMarketHours = false;
  let envFile: string | null = null;

  const valueOf = (i: number, flag: string): string => {
    const value = argv[i];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--apply') apply = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--allow-market-hours') allowMarketHours = true;
    else if (flag === '--from' || flag === '--to') {
      i += 1;
      const value = valueOf(i, flag);
      if (!isDateArg(value)) throw new Error(`${flag} must be YYYY-MM-DD`);
      if (flag === '--from') from = value;
      else to = value;
    } else if (flag === '--env-file') {
      i += 1;
      envFile = valueOf(i, flag);
    } else throw new Error(`unknown argument ${flag}`);
  }

  if (apply && dryRun) throw new Error('--apply and --dry-run contradict');
  if (to !== null && from === null) throw new Error('--to needs --from');
  if (from !== null && to !== null && from > to) {
    throw new Error('--from is after --to');
  }
  return { apply, from, to, allowMarketHours, envFile };
}

/** Trading days from `from` to `to` inclusive, oldest first. */
function tradingDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const day = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (day === null || end === null) return days;
  while (day <= end) {
    const iso = day.toISOString().slice(0, 10);
    if (isTradingDay(iso)) days.push(iso);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

/**
 * The sessions to settle: the cron's own window without `--from`, else the
 * trading days from `--from` to `--to` (default: the newest settled session).
 * A session still being traded is refused: its series is not final.
 */
export function resolveSessions(args: CliArgs, now: Date): string[] {
  if (args.from === null) return settleSessions(now);
  const newest = settleSessions(now, 1)[0] as string;
  const to = args.to ?? newest;
  if (to > newest) {
    throw new Error(`--to ${to} is after the newest settled session ${newest}`);
  }
  const sessions = tradingDaysBetween(args.from, to);
  if (sessions.length === 0) {
    throw new Error(`no trading day from ${args.from} to ${to}`);
  }
  return sessions;
}

// ── Schwab ──────────────────────────────────────────────────────────────────

/**
 * One authenticated GET of a Schwab pricehistory path, JSON body. A failure
 * is a SettleFailure that names it; the body of an error answer is masked
 * (redactBody) before it reaches a message.
 */
export async function fetchPriceHistory(
  path: string,
  token: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${SCHWAB_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SettleFailure(
      'schwab_error',
      `Schwab pricehistory request failed: ${reason}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SettleFailure(
      'schwab_error',
      `Schwab pricehistory ${res.status}: ${redactBody(text)}`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new SettleFailure(
      'malformed_payload',
      'Schwab pricehistory body is not JSON',
    );
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface DayReport {
  /** ET trading day, `YYYY-MM-DD`. */
  date: string;
  /** Rows the run inserted (dry run: would insert), over all four symbols. */
  inserted: number;
  /** Stored rows replaced because the settled values differ. */
  updated: number;
  /** Stored rows that already hold the settled values. */
  unchanged: number;
  /** All-zero bars rejected. */
  rejectedZero: number;
  /** Symbol-sessions that are not complete (incomplete or tick_clamped). */
  problems: SessionProblem[];
}

export interface SymbolFailure {
  symbol: string;
  failure: SettleFailureKind | 'db_error';
  error: string;
}

export interface BackfillReport {
  apply: boolean;
  sessions: string[];
  days: DayReport[];
  failures: SymbolFailure[];
}

/**
 * Fetch, plan and (with `apply`) write the settled bars of the four symbols
 * for `sessions`. A symbol that fails is recorded and the others still run.
 * `getToken` returns a Schwab access token, asked for again before each symbol
 * because a long run can outlast a 30-minute token.
 */
export async function runBackfill(opts: {
  apply: boolean;
  sessions: string[];
  getToken: () => Promise<string>;
}): Promise<BackfillReport> {
  const days = new Map<string, DayReport>(
    opts.sessions.map((date) => [
      date,
      {
        date,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        rejectedZero: 0,
        problems: [],
      },
    ]),
  );
  const failures: SymbolFailure[] = [];
  const { startMs, endMs } = fetchWindow(opts.sessions);

  for (const symbol of SETTLE_SYMBOLS) {
    let body: unknown;
    try {
      const token = await opts.getToken();
      body = await fetchPriceHistory(
        pricehistoryPath(symbol, startMs, endMs),
        token,
      );
    } catch (err) {
      // fetchPriceHistory names its own failures; what else can throw here is
      // the token (getToken: Redis, a refresh), which is a Schwab-side failure.
      failures.push({
        symbol,
        failure: err instanceof SettleFailure ? err.kind : 'schwab_error',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    let plan: SymbolPlan;
    try {
      plan = planSymbol(symbol, parsePriceHistory(body).candles, opts.sessions);
    } catch (err) {
      // A SettleFailure names itself (empty or malformed payload). Anything
      // else came out of our own parse or plan code: not Schwab's fault.
      failures.push({
        symbol,
        failure: err instanceof SettleFailure ? err.kind : 'unexpected',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const session of plan.sessions) {
      const day = days.get(session.date);
      if (day !== undefined) day.rejectedZero += session.zeroBars;
    }
    for (const problem of sessionProblems(plan)) {
      days.get(problem.date)?.problems.push(problem);
    }

    let changed: ChangedBars;
    try {
      ({ changed } = opts.apply
        ? await upsertInternalBars(plan.rows)
        : diffBars(plan.rows, await readStoredBars(symbol, opts.sessions)));
    } catch (err) {
      failures.push({
        symbol,
        failure: 'db_error',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const row of plan.rows) {
      const day = days.get(getETDateStr(new Date(row.ts)));
      if (day === undefined) continue;
      const verdict = changed.get(row.ts);
      if (verdict === 'inserted') day.inserted += 1;
      else if (verdict === 'updated') day.updated += 1;
      else day.unchanged += 1;
    }
  }

  return {
    apply: opts.apply,
    sessions: opts.sessions,
    days: [...days.values()],
    failures,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

const pad = (value: string | number, width: number): string =>
  String(value).padStart(width);

/** `$ADD incomplete 389/390` or `$TICK tick_clamped`. */
function describeProblem(p: SessionProblem): string {
  const count = p.kind === 'incomplete' ? ` ${p.bars}/${p.expected}` : '';
  return `${p.symbol} ${p.kind}${count}`;
}

/** The report as the lines the script prints. */
export function formatReport(report: BackfillReport): string {
  const verb = report.apply ? 'written' : 'would be written';
  const lines: string[] = [
    report.apply
      ? 'APPLY: the settled bars below were written.'
      : 'DRY RUN: nothing was written. Pass --apply to write.',
    `Sessions: ${report.sessions[0]} .. ${report.sessions.at(-1)} (${report.sessions.length})`,
    '',
    `${'date'.padEnd(12)}${pad('inserted', 10)}${pad('updated', 10)}${pad('unchanged', 11)}${pad('rejected0', 11)}  problems`,
  ];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let rejectedZero = 0;
  for (const day of report.days) {
    inserted += day.inserted;
    updated += day.updated;
    unchanged += day.unchanged;
    rejectedZero += day.rejectedZero;
    const problems = day.problems.map(describeProblem).join(', ');
    lines.push(
      `${day.date.padEnd(12)}${pad(day.inserted, 10)}${pad(day.updated, 10)}${pad(day.unchanged, 11)}${pad(day.rejectedZero, 11)}  ${problems}`,
    );
  }
  lines.push(
    '',
    `Total: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged, ${rejectedZero} all-zero bars rejected (${verb}).`,
  );
  if (report.failures.length > 0) {
    lines.push('', 'FAILED:');
    for (const f of report.failures) {
      lines.push(`  ${f.symbol} ${f.failure}: ${f.error}`);
    }
  }
  return lines.join('\n');
}
