/**
 * One-off backfill of `flow_regime_0dte_daily` from the live source tables.
 *
 * PURPOSE
 *   Seeds the 0DTE gamma-regime self-scoring table for the historical window
 *   that predates the nightly `capture-regime-0dte` cron, so the panel's
 *   scorecard has back-history. Each row pairs the day's gate classification +
 *   the intraday down-triggers it fired with what the day actually did
 *   (open→close return, range, directional efficiency).
 *
 * SINGLE SOURCE OF TRUTH (resolves review findings #8, #7, #3)
 *   This script does NOT reimplement the regime math. It imports and runs the
 *   EXACT same modules the production cron (api/cron/capture-regime-0dte.ts)
 *   uses, so a backfilled row is byte-for-byte consistent with a row the cron
 *   would later write for the same day:
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
 * BEHAVIOR
 *   DRY-RUN by default — computes every row, prints a table + tallies, writes
 *   NOTHING. Pass `--apply` to UPSERT into `flow_regime_0dte_daily` via the same
 *   `ON CONFLICT (date) DO UPDATE` statement as the cron (idempotent).
 *
 * RUN (from the repo root; DATABASE_URL in .env.local is PROD — DRY-RUN only)
 *   node --import tsx --env-file=.env.local scripts/backfill-regime-0dte.ts
 *   node --import tsx --env-file=.env.local scripts/backfill-regime-0dte.ts --apply
 */

import { getDb } from '../api/_lib/db.ts';
import { withDbRetry } from '../api/_lib/db.ts';
import { evaluateRegime0dte, REGIME_0DTE } from '../api/_lib/regime-0dte.ts';
import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from '../api/_lib/regime-0dte-queries.ts';
import {
  fetchDayOhlcFromPostgres,
  type DayOhlc,
} from '../api/_lib/postgres-day-summary.ts';
import {
  realizedOutcome,
  ctMinToHhmm,
} from '../api/cron/capture-regime-0dte.ts';

const APPLY = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set (run with --env-file=.env.local)');
  process.exit(1);
}

const sql = getDb();

// CT minute-of-day expression, used only for the date-intersection query below.
const ctMin = (col: string) =>
  `(extract(hour from ${col} AT TIME ZONE 'America/Chicago')*60` +
  `+extract(minute from ${col} AT TIME ZONE 'America/Chicago'))::int`;

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

async function main(): Promise<void> {
  // The day list: intersection where an OPEN-window gex profile, SPXW put IV,
  // and SPX regular-session candles ALL exist — so no trigger is faked from
  // missing data. (Same intersection logic as the original scratch script.)
  const dateRows = (await withDbRetry(
    () => sql`
      WITH gd AS (
        SELECT date FROM gex_strike_0dte
        WHERE ${sql.unsafe(ctMin('timestamp'))} < ${REGIME_0DTE.PERSIST_END_MIN}
        GROUP BY date
      ),
      ivd AS (
        SELECT date(ts AT TIME ZONE 'America/Chicago') AS d
        FROM strike_iv_snapshots
        WHERE ticker = 'SPXW' AND side = 'put'
        GROUP BY 1
      ),
      cd AS (
        SELECT date FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
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

  const dates = dateRows.map((r) =>
    r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
  );

  console.log(
    `backfill ${dates.length} candidate days ` +
      `(${dates[0]} -> ${dates.at(-1)}) | mode=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`,
  );

  const rows: BackfillRow[] = [];
  let skipped = 0;
  for (const d of dates) {
    const row = await backfillDay(d);
    if (row) rows.push(row);
    else skipped += 1;
  }

  // print
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

  if (!APPLY) {
    console.log('\nDRY-RUN — no rows written. Re-run with --apply to upsert.');
    return;
  }

  let n = 0;
  for (const r of rows) {
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
    n += 1;
  }
  const cnt = (await sql`
    SELECT count(*)::int AS c FROM flow_regime_0dte_daily
  `) as { c: number }[];
  console.log(
    `\nAPPLIED — upserted ${n} rows. ` +
      `flow_regime_0dte_daily now has ${cnt[0]?.c ?? '?'} rows.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
