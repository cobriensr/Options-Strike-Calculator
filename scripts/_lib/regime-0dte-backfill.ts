/**
 * Backfill of `flow_regime_0dte_daily`: the logic behind
 * scripts/backfill-regime-0dte.ts, which is a thin wrapper that calls
 * `runRegimeBackfill`. It lives here so vitest covers it (scripts/_lib/**); the
 * script used to run `main()` at import. It READS and WRITES the database
 * DATABASE_URL points at: production, in .env.local.
 *
 * PURPOSE
 *   Seeds the 0DTE gamma-regime self-scoring table for the historical window
 *   that predates the nightly `capture-regime-0dte` cron, so the panel's
 *   scorecard has back-history. Each row pairs the day's gate classification +
 *   the intraday down-triggers it fired with what the day actually did
 *   (open→close return, range, directional efficiency).
 *
 * SINGLE SOURCE OF TRUTH (resolves review findings #8, #7, #3)
 *   This does NOT reimplement the regime math. It imports and runs the EXACT
 *   same modules the production cron (api/cron/capture-regime-0dte.ts) uses, so
 *   a backfilled row is byte-for-byte consistent with a row the cron would later
 *   write for the same day:
 *     - `getGexStrikes` / `getPutIvSeries` / `getCandles30`  (real I/O helpers,
 *       which already do the stray-date CT guard AND `?? 0` NULL-coalescing on
 *       gamma columns — finding #7's NaN-on-NULL bug is fixed for free).
 *     - `evaluateRegime0dte` (the real pure evaluator — gexNear / gradeGate /
 *       flipStrike / ivBreak / mostlyRed / middayDeepNeg).  No JS reimpl, so no
 *       drift vs. the cron (finding #8).
 *     - the cron's skip-guard for holiday / data-outage days (finding #3).
 *     - `realizedOutcome` / `ctMinToHhmm` re-exported from the cron itself
 *       (pure, side-effect-free) for the realized-outcome + `*_at` columns.
 *
 * WINDOW RATIONALE
 *   Backfills only the intersection of trading days where ALL THREE source
 *   tables have data: an `gex_strike_0dte` OPEN-window profile (CT minute-of-day
 *   < 11:00) AND SPXW put `strike_iv_snapshots` AND SPX `index_candles_1m`. A
 *   day missing any one of these would silently fake a trigger from absent IV /
 *   candle history, so it is excluded rather than scored on partial data.
 *
 * DATE RANGE (spec: docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md,
 * "Script flags")
 *   `--from YYYY-MM-DD` and `--to YYYY-MM-DD` are inclusive calendar dates that
 *   limit the intersection above; either may be given alone. With neither, every
 *   intersection day runs, exactly as before. The range is applied inside the
 *   day-list statement, to each of its three tables, so a one-day run reads one
 *   day of `strike_iv_snapshots` (a ~92M-row table) through its (ticker, ts)
 *   index rather than grouping every SPXW put it has. A range that leaves no day
 *   to score is an error (exit 1), never a quiet success: it would otherwise
 *   look like a finished repair.
 *
 * BEHAVIOR
 *   DRY-RUN by default — computes every row, prints a table + tallies, writes
 *   NOTHING. Pass `--apply` to UPSERT into `flow_regime_0dte_daily` via the same
 *   `ON CONFLICT (date) DO UPDATE` statement as the cron (idempotent). Rows
 *   outside the range are never touched.
 *
 * Exit codes: 0 done, 1 any failure (a DB error included: nothing past it is
 * reported as success), 2 a bad flag or combination, with no SQL run.
 *
 * The per-day reads and the upsert keep their per-row loops: this file is a
 * move, and the range keeps a run small. Batching the upsert (R5) is later work.
 */

import { getDb, withDbRetry } from '../../api/_lib/db.js';
import { evaluateRegime0dte, REGIME_0DTE } from '../../api/_lib/regime-0dte.js';
import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from '../../api/_lib/regime-0dte-queries.js';
import {
  fetchDayOhlcFromPostgres,
  type DayOhlc,
} from '../../api/_lib/postgres-day-summary.js';
import {
  realizedOutcome,
  ctMinToHhmm,
} from '../../api/cron/capture-regime-0dte.js';

const USAGE =
  'usage: backfill-regime-0dte.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--apply]\n' +
  '  --from/--to: inclusive dates, either alone; with neither every candidate day runs\n' +
  '  dry run (nothing written) unless --apply';

// ============================================================
// CLI ARGS
// ============================================================

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RegimeBackfillArgs {
  /** Inclusive first date, or null for no lower bound. */
  from: string | null;
  /** Inclusive last date, or null for no upper bound. */
  to: string | null;
  apply: boolean;
}

/** A real calendar date written YYYY-MM-DD (no `2026-02-30`, no `2026-7-22`). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // A month 13 is an Invalid Date (toISOString throws); a day past the month's
  // end rolls over (02-30 becomes 03-02), so compare the round trip.
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Parse the flags. Anything unknown or contradictory is a UsageError (exit 2). */
export function parseArgs(argv: readonly string[]): RegimeBackfillArgs {
  let from: string | null = null;
  let to: string | null = null;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--from' || arg === '--to') {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a YYYY-MM-DD value`);
      }
      if (!isCalendarDate(value)) {
        throw new UsageError(`${arg} ${value} is not a YYYY-MM-DD date`);
      }
      if ((arg === '--from' ? from : to) != null) {
        throw new UsageError(`${arg} given twice`);
      }
      if (arg === '--from') from = value;
      else to = value;
      i += 1;
    } else if (arg === '--apply') {
      apply = true;
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }

  if (from != null && to != null && from > to) {
    throw new UsageError(`--from ${from} is after --to ${to}`);
  }
  return { from, to, apply };
}

// ============================================================
// SCORING
// ============================================================

type Sql = ReturnType<typeof getDb>;

interface BackfillRow {
  date: string;
  gate: string;
  gex_open: number | null;
  gex_mid: number | null;
  flip_minus_open_pct: number | null;
  mostly_red: boolean;
  mostly_red_at: string | null;
  iv_break: boolean;
  iv_break_at: string | null;
  iv_break_mag_pct: number | null;
  midday_deep_neg: boolean;
  oc_ret_pct: number | null;
  range_pct: number | null;
  dir_eff: number | null;
  big_down: boolean | null;
  big_up: boolean | null;
  // diagnostics for the printed table only — never written
  _green: number;
  _red: number;
  _skipped: boolean;
}

/**
 * Score one trading day through the EXACT cron orchestration:
 * read the time-anchored profiles + IV + candles, apply the skip-guard, run the
 * shared evaluator as-of the cash close, and map `state` → the DB columns.
 * Returns null for a guard-skipped day (no candles / thin open profile).
 */
async function backfillDay(d: string): Promise<BackfillRow | null> {
  const [openP, midP, putIv, candles30] = await Promise.all([
    getGexStrikes(d, 'open'),
    getGexStrikes(d, 'midday'),
    getPutIvSeries(d),
    getCandles30(d),
  ]);

  // Skip-guard (finding #3): mirror the cron — a holiday / data-outage day with
  // no candles or an under-populated OPEN profile has nothing to score.
  if (
    candles30.length === 0 ||
    openP.strikes.length < REGIME_0DTE.MIN_STRIKES
  ) {
    console.error(
      `[skip] ${d} candles=${candles30.length} openStrikes=${openP.strikes.length}`,
    );
    return null;
  }

  const sorted = [...candles30].sort((a, b) => a.ctMin - b.ctMin);

  const state = evaluateRegime0dte({
    nowCtMin: REGIME_0DTE.CLOSE_MIN,
    openProfile: openP,
    middayProfile: midP,
    currentProfile: null,
    putIv,
    candles30: sorted,
  });

  const ohlc: DayOhlc | null = await fetchDayOhlcFromPostgres(d);
  const outcome = realizedOutcome(ohlc);

  return {
    date: d,
    gate: state.gate,
    gex_open: state.gexAtOpen,
    gex_mid: state.triggers.middayDeepNeg.gexMid,
    flip_minus_open_pct: state.flipMinusOpenPct,
    mostly_red: state.triggers.mostlyRed.fired,
    mostly_red_at: ctMinToHhmm(state.triggers.mostlyRed.atCtMin),
    iv_break: state.triggers.ivBreak.fired,
    iv_break_at: ctMinToHhmm(state.triggers.ivBreak.atCtMin),
    iv_break_mag_pct: state.triggers.ivBreak.magPct,
    midday_deep_neg: state.triggers.middayDeepNeg.fired,
    oc_ret_pct: outcome?.ocRetPct ?? null,
    range_pct: outcome?.rangePct ?? null,
    dir_eff: outcome?.dirEff ?? null,
    big_down: outcome?.bigDown ?? null,
    big_up: outcome?.bigUp ?? null,
    _green: state.triggers.mostlyRed.green,
    _red: state.triggers.mostlyRed.red,
    _skipped: false,
  };
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * The day list: the intersection where an OPEN-window gex profile, SPXW put IV,
 * and SPX regular-session candles ALL exist — so no trigger is faked from
 * missing data. `from` / `to` (inclusive, null = unbounded) bound each of the
 * three tables: `gd.date` and `cd.date` as dates, `ivd` as a range on the bare
 * `ts` column over [from 00:00 CT, to+1 00:00 CT), which the (ticker, ts) index
 * serves (the same bound as `ctDayTsBounds`, api/_lib/gex-strike-day.ts). That
 * is the same intersection as bounding it once at the end, but it never groups
 * the whole of strike_iv_snapshots to answer a one-day run.
 */
async function candidateDays(
  sql: Sql,
  from: string | null,
  to: string | null,
): Promise<string[]> {
  const rows = (await withDbRetry(
    () => sql`
      WITH gd AS (
        SELECT date FROM gex_strike_0dte
        WHERE (extract(hour from timestamp AT TIME ZONE 'America/Chicago')*60
               + extract(minute from timestamp AT TIME ZONE 'America/Chicago'))::int
              < ${REGIME_0DTE.PERSIST_END_MIN}
          AND (${from}::date IS NULL OR date >= ${from}::date)
          AND (${to}::date IS NULL OR date <= ${to}::date)
        GROUP BY date
      ),
      ivd AS (
        SELECT date(ts AT TIME ZONE 'America/Chicago') AS d
        FROM strike_iv_snapshots
        WHERE ticker = 'SPXW' AND side = 'put'
          AND (${from}::date IS NULL
               OR ts >= ((${from}::date)::timestamp AT TIME ZONE 'America/Chicago'))
          AND (${to}::date IS NULL
               OR ts < (((${to}::date) + 1)::timestamp AT TIME ZONE 'America/Chicago'))
        GROUP BY 1
      ),
      cd AS (
        SELECT date FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
          AND (${from}::date IS NULL OR date >= ${from}::date)
          AND (${to}::date IS NULL OR date <= ${to}::date)
        GROUP BY date
      )
      SELECT gd.date
      FROM gd
      JOIN ivd ON ivd.d = gd.date
      JOIN cd ON cd.date = gd.date
      ORDER BY gd.date
    `,
    2,
    10_000,
  )) as { date: string | Date }[];

  return rows.map((r) =>
    r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
  );
}

async function upsertRow(sql: Sql, r: BackfillRow): Promise<void> {
  await withDbRetry(
    () => sql`
      INSERT INTO flow_regime_0dte_daily (
        date, gate,
        gex_open, gex_mid, flip_minus_open_pct,
        mostly_red, mostly_red_at,
        iv_break, iv_break_at, iv_break_mag_pct,
        midday_deep_neg,
        oc_ret_pct, range_pct, dir_eff, big_down, big_up
      ) VALUES (
        ${r.date}::date, ${r.gate},
        ${r.gex_open}, ${r.gex_mid}, ${r.flip_minus_open_pct},
        ${r.mostly_red}, ${r.mostly_red_at},
        ${r.iv_break}, ${r.iv_break_at}, ${r.iv_break_mag_pct},
        ${r.midday_deep_neg},
        ${r.oc_ret_pct}, ${r.range_pct}, ${r.dir_eff}, ${r.big_down}, ${r.big_up}
      )
      ON CONFLICT (date) DO UPDATE SET
        gate = EXCLUDED.gate,
        gex_open = EXCLUDED.gex_open,
        gex_mid = EXCLUDED.gex_mid,
        flip_minus_open_pct = EXCLUDED.flip_minus_open_pct,
        mostly_red = EXCLUDED.mostly_red,
        mostly_red_at = EXCLUDED.mostly_red_at,
        iv_break = EXCLUDED.iv_break,
        iv_break_at = EXCLUDED.iv_break_at,
        iv_break_mag_pct = EXCLUDED.iv_break_mag_pct,
        midday_deep_neg = EXCLUDED.midday_deep_neg,
        oc_ret_pct = EXCLUDED.oc_ret_pct,
        range_pct = EXCLUDED.range_pct,
        dir_eff = EXCLUDED.dir_eff,
        big_down = EXCLUDED.big_down,
        big_up = EXCLUDED.big_up
    `,
    2,
    10_000,
  );
}

/** Print the scored rows and the tallies, as the script always has. */
function printRows(rows: BackfillRow[], skipped: number): void {
  const f = (x: number | null, n = 2) =>
    x == null ? '   .  ' : Number(x).toFixed(n);
  const e = (x: number | null) =>
    x == null ? '   .   ' : Number(x).toExponential(2);
  console.log(
    'date        gate       gex_open   gex_mid    oc%    bigD  mRed(g/r) ivB@    midDN',
  );
  for (const r of rows) {
    console.log(
      `${r.date}  ${r.gate.padEnd(9)} ${e(r.gex_open)} ${e(r.gex_mid)} ` +
        `${f(r.oc_ret_pct).padStart(6)}  ${String(r.big_down).padEnd(5)} ` +
        `${r.mostly_red ? 'Y' : 'n'}(${r._green}/${r._red})    ` +
        `${(r.iv_break_at ?? '--').padEnd(6)}  ${r.midday_deep_neg ? 'Y' : 'n'}`,
    );
  }

  const tallies = {
    scored: rows.length,
    skipped,
    lean_down: rows.filter((r) => r.gate === 'lean_down').length,
    big_move: rows.filter((r) => r.gate === 'big_move').length,
    calm: rows.filter((r) => r.gate === 'calm').length,
    unknown: rows.filter((r) => r.gate === 'unknown').length,
    big_down: rows.filter((r) => r.big_down).length,
    mostly_red: rows.filter((r) => r.mostly_red).length,
    iv_break: rows.filter((r) => r.iv_break).length,
    midday_deep_neg: rows.filter((r) => r.midday_deep_neg).length,
  };
  console.log('\ntallies:', JSON.stringify(tallies));
}

// ============================================================
// RUN
// ============================================================

/** The run proper. Resolves to the exit code; a DB error rejects. */
async function runBackfill(args: RegimeBackfillArgs): Promise<number> {
  const { from, to, apply } = args;
  const ranged = from != null || to != null;
  const sql = getDb();

  let dates: string[];
  try {
    dates = await candidateDays(sql, from, to);
  } catch (err) {
    throw new Error(`listing the candidate days failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  if (ranged && dates.length === 0) {
    console.error(
      `no candidate day between ${from ?? 'the first'} and ${to ?? 'the last'}: ` +
        'a day needs a gex open profile, SPXW put IV and SPX regular candles',
    );
    return 1;
  }

  const rangeLabel = ranged ? ` | range=${from ?? '*'}..${to ?? '*'}` : '';
  console.log(
    `backfill ${dates.length} candidate days ` +
      `(${dates[0]} -> ${dates.at(-1)})${rangeLabel} | mode=${apply ? 'APPLY' : 'DRY-RUN'}\n`,
  );

  const rows: BackfillRow[] = [];
  let skipped = 0;
  for (const d of dates) {
    let row: BackfillRow | null;
    try {
      row = await backfillDay(d);
    } catch (err) {
      throw new Error(`scoring ${d} failed: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (row) rows.push(row);
    else skipped += 1;
  }

  printRows(rows, skipped);

  if (ranged && rows.length === 0) {
    console.error(
      `no day between ${from ?? 'the first'} and ${to ?? 'the last'} was scored ` +
        '(see the [skip] lines above)',
    );
    return 1;
  }

  if (!apply) {
    console.log('\nDRY-RUN — no rows written. Re-run with --apply to upsert.');
    return 0;
  }

  let n = 0;
  for (const r of rows) {
    try {
      await upsertRow(sql, r);
    } catch (err) {
      throw new Error(
        `upserting ${r.date} failed after ${n} rows: ${errorMessage(err)}`,
        { cause: err },
      );
    }
    n += 1;
  }
  const cnt = (await sql`
    SELECT count(*)::int AS c FROM flow_regime_0dte_daily
  `) as { c: number }[];
  console.log(
    `\nAPPLIED — upserted ${n} rows. ` +
      `flow_regime_0dte_daily now has ${cnt[0]?.c ?? '?'} rows.`,
  );
  return 0;
}

/**
 * Run the backfill the way the script's argv asks. Resolves to the exit code:
 * 0 done, 1 any failure (a DB error included: nothing past it is reported as
 * success), 2 a bad flag or combination, with no SQL run.
 */
export async function runRegimeBackfill(
  argv: readonly string[],
): Promise<number> {
  let args: RegimeBackfillArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set (run with --env-file=.env.local)');
    return 1;
  }

  try {
    return await runBackfill(args);
  } catch (err) {
    console.error('regime-0dte backfill failed:', err);
    return 1;
  }
}
