/**
 * GET /api/cron/capture-regime-0dte
 *
 * Nightly self-scoring cron for the live 0DTE gamma-regime panel. After
 * the cash close it evaluates the day's regime AS IF it were 15:00 CT
 * (so every intraday trigger has seen the full session) and records the
 * verdict + the realized outcome to `flow_regime_0dte_daily`. This turns
 * the panel into a self-validating scorecard: each row pairs the gate
 * classification and the intraday down-triggers it fired with what the
 * day actually did (open→close return, range, directional efficiency).
 *
 * Runs once daily at 30 21 * * 1-5 (16:30 ET / 15:30 CT) — after the
 * 15:00 CT cash close and settle. Reads the same source tables as the
 * live endpoint via the Task-5 helpers and grades the day through the
 * SAME pure evaluator (`evaluateRegime0dte`, evaluated as-of the cash
 * close) — no inline gate/trigger derivation. Realized columns come from
 * the shared `fetchDayOhlcFromPostgres` SPX day-OHLC helper. After
 * computing today's open gate it also self-monitors the hand-calibrated
 * `GATE_DEEP_NEG` cutoff for OI-scale drift.
 *
 * Idempotent — ON CONFLICT (date) DO UPDATE means a re-run for the same
 * trading day overwrites the row rather than erroring, so backfills and
 * accidental re-fires are safe.
 *
 * Guard: a holiday / data-outage day has no candles or no GEX strikes for
 * `ctx.today`. Rather than write a junk all-null row, the cron logs and
 * exits cleanly with status 'skipped' (no DB write).
 *
 * marketHours: false — runs post-close, outside the RTH cron window.
 * requireApiKey: false — reads only our own Neon tables.
 *
 * Task 7 of docs/superpowers/plans/2026-06-07-regime-0dte-panel.md
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { evaluateRegime0dte, REGIME_0DTE } from '../_lib/regime-0dte.js';
import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from '../_lib/regime-0dte-queries.js';
import {
  fetchDayOhlcFromPostgres,
  type DayOhlc,
} from '../_lib/postgres-day-summary.js';

/**
 * Format a CT minute-of-day (e.g. 660 = 11:00 CT) as a zero-padded
 * 'HH:MM' clock string for the `*_at` TEXT columns. Null in → null out
 * (the trigger did not fire).
 */
export function ctMinToHhmm(ctMin: number | null): string | null {
  if (ctMin == null) return null;
  const h = Math.floor(ctMin / 60);
  const m = ctMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Realized open→close return, intraday range, and directional efficiency
 * for the day, plus the big-up / big-down flags. Returns null when the
 * day's true open is missing or non-positive (can't normalize).
 *
 * Consumes the shared `DayOhlc` from `fetchDayOhlcFromPostgres` (same
 * `symbol='SPX' AND market_time='r'` SPX 1-min source as the live panel) so
 * the day's OHLC is read through one canonical helper, not a duplicated query.
 */
export function realizedOutcome(ohlc: DayOhlc | null): {
  ocRetPct: number;
  rangePct: number;
  dirEff: number;
  bigDown: boolean;
  bigUp: boolean;
} | null {
  if (!ohlc) return null;
  const { open, high: hi, low: lo, close } = ohlc;
  if (!Number.isFinite(open) || open <= 0) return null;
  const ocRetPct = ((close - open) / open) * 100;
  const rangePct = ((hi - lo) / open) * 100;
  const range = hi - lo;
  // dir_eff = |close-open| / (hi-lo); a flat-range day (hi==lo) has
  // undefined efficiency → 0 rather than a divide-by-zero.
  const dirEff = range > 0 ? Math.abs(close - open) / range : 0;
  return {
    ocRetPct,
    rangePct,
    dirEff,
    bigDown: ocRetPct <= -1,
    bigUp: ocRetPct >= 1,
  };
}

/**
 * Linear-interpolation percentile (type-7, the numpy/Excel default) of a
 * numeric sample. `p` in [0,1]. Assumes a non-empty, finite input; callers
 * gate on length first.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sortedAsc[lo] as number;
  const hiVal = sortedAsc[hi] as number;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

const DRIFT_TRAILING_ROWS = 30;
const DRIFT_MIN_ROWS = 20;
const DRIFT_PCTILE = 0.12; // GATE_DEEP_NEG was the 12th pct of open-spot gexNear
const DRIFT_TOLERANCE = 0.5; // warn when GATE_DEEP_NEG is > ±50% off the pct

/**
 * Self-monitor the hand-calibrated `GATE_DEEP_NEG` cutoff. Reads the trailing
 * ~30 recorded `gex_open` values (today's value passed in since its row isn't
 * upserted yet), computes their 12th percentile, and warns (logger + Sentry,
 * fingerprint `regime-0dte.gate_deep_neg_drift`) when `GATE_DEEP_NEG` is more
 * than ±50% off that percentile — the signal that the OI scale has drifted and
 * the constant needs recalibration. No-op until ≥20 rows exist.
 */
async function checkGateDeepNegDrift(
  sql: ReturnType<typeof getDb>,
  today: string,
  todayGexOpen: number,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT gex_open
      FROM flow_regime_0dte_daily
      WHERE gex_open IS NOT NULL
        AND date < ${today}::date
      ORDER BY date DESC
      LIMIT ${DRIFT_TRAILING_ROWS}
    `,
    2,
    10_000,
  )) as { gex_open: string | number | null }[];

  const sample = rows
    .map((r) => Number(r.gex_open))
    .filter((v) => Number.isFinite(v));
  // Include today's value so the window reflects the current measurement too.
  sample.push(todayGexOpen);

  if (sample.length < DRIFT_MIN_ROWS) return;

  sample.sort((a, b) => a - b);
  const pct = percentile(sample, DRIFT_PCTILE);
  // Relative gap vs the empirical percentile magnitude (both are negative).
  const rel =
    pct === 0
      ? Infinity
      : Math.abs(REGIME_0DTE.GATE_DEEP_NEG - pct) / Math.abs(pct);

  if (rel > DRIFT_TOLERANCE) {
    const payload = {
      gateDeepNeg: REGIME_0DTE.GATE_DEEP_NEG,
      empiricalP12: pct,
      relDrift: rel,
      sampleSize: sample.length,
    };
    log.warn(payload, 'regime-0dte.gate_deep_neg_drift');
    Sentry.captureMessage(
      `regime-0dte.gate_deep_neg_drift: GATE_DEEP_NEG ${REGIME_0DTE.GATE_DEEP_NEG} ` +
        `vs trailing 12th-pct ${pct.toFixed(3)} (rel ${(rel * 100).toFixed(0)}%)`,
    );
  }
}

export default withCronInstrumentation(
  'capture-regime-0dte',
  async (ctx): Promise<CronResult> => {
    const today = ctx.today;

    // The 0DTE gamma profile MIGRATES with spot through the session, so each
    // recorded field must be reconstructed from its TIME-CORRECT profile —
    // not the single EOD snapshot. The OPEN-minute profile (at the open spot)
    // gives the forward gate the GATE_DEEP_NEG calibration validated; the
    // MIDDAY-minute profile gives the midday deep-neg check. Reading the EOD
    // profile and evaluating it at the open spot finds no strikes in band and
    // reads ~0 — a coincident close-gate, not the forward open-gate signal.
    const [openP, midP, putIv, candles30] = await Promise.all([
      getGexStrikes(today, 'open'),
      getGexStrikes(today, 'midday'),
      getPutIvSeries(today),
      getCandles30(today),
    ]);

    // Holiday / data-outage guard: with no candles or an under-populated OPEN
    // profile there is nothing meaningful to score. Exit cleanly, no junk row.
    if (
      candles30.length === 0 ||
      openP.strikes.length < REGIME_0DTE.MIN_STRIKES
    ) {
      ctx.logger.info(
        { today, candles: candles30.length, openStrikes: openP.strikes.length },
        'capture-regime-0dte: no data for today, skipping',
      );
      return {
        status: 'skipped',
        message: 'no candles/strikes for today',
        metadata: { today },
      };
    }

    const sorted = [...candles30].sort((a, b) => a.ctMin - b.ctMin);

    // SINGLE SOURCE OF TRUTH: the cron grades the day through the SAME pure
    // evaluator the live endpoint uses — no inline gate/trigger derivation. It
    // evaluates as-of the cash close (CLOSE_MIN = 15:00 CT) so every intraday
    // trigger has seen the full session. The gate is OPEN-anchored (openProfile),
    // the midday deep-neg from the MIDDAY profile; currentProfile is null because
    // the scorecard records only the open/midday fields, never live gexNearSpot.
    const state = evaluateRegime0dte({
      nowCtMin: REGIME_0DTE.CLOSE_MIN,
      openProfile: openP,
      middayProfile: midP,
      currentProfile: null,
      putIv,
      candles30: sorted,
    });

    const gate = state.gate;
    const gexOpen = state.gexAtOpen; // OPEN-profile net GEX (the forward gate)
    const gexMid = state.triggers.middayDeepNeg.gexMid; // MIDDAY-profile net GEX
    const middayDeepNeg = state.triggers.middayDeepNeg.fired;
    const flipMinusOpenPct = state.flipMinusOpenPct;
    const mostlyRedFired = state.triggers.mostlyRed.fired;
    const mostlyRedAt = state.triggers.mostlyRed.atCtMin;
    const iv = state.triggers.ivBreak;

    const sql = getDb();

    // DRIFT GUARD: GATE_DEEP_NEG is a hand-calibrated constant (12th-percentile
    // of open-spot gexNear over the calibration window). If the live OI scale
    // drifts, that cutoff silently mis-classifies. Self-monitor it: pull the
    // trailing ~30 recorded gex_open values, compute their ~12th percentile,
    // and warn if GATE_DEEP_NEG is more than ±50% off it. Needs ≥20 rows to be
    // meaningful; skipped otherwise (early in the table's life).
    if (gexOpen != null) {
      await checkGateDeepNegDrift(sql, today, gexOpen, ctx.logger);
    }

    // Realized outcome via the shared SPX day-OHLC helper (same SPX / market_time
    // = 'r' source). One canonical query — no duplicate inline OHLC scan. The
    // helper has its own try/catch (returns null on failure) and uses getDb()
    // internally, so it isn't re-wrapped in withDbRetry here.
    const ohlc: DayOhlc | null = await fetchDayOhlcFromPostgres(today);
    const outcome = realizedOutcome(ohlc);

    // UPSERT one row per trading day. ON CONFLICT (date) DO UPDATE makes
    // re-runs idempotent — a later fire overwrites the day's scorecard row.
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
          ${today}::date, ${gate},
          ${gexOpen}, ${gexMid}, ${flipMinusOpenPct},
          ${mostlyRedFired},
          ${ctMinToHhmm(mostlyRedAt)},
          ${iv.fired},
          ${ctMinToHhmm(iv.atCtMin)},
          ${iv.magPct},
          ${middayDeepNeg},
          ${outcome?.ocRetPct ?? null},
          ${outcome?.rangePct ?? null},
          ${outcome?.dirEff ?? null},
          ${outcome?.bigDown ?? null},
          ${outcome?.bigUp ?? null}
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

    ctx.logger.info(
      {
        today,
        gate,
        gexOpen,
        gexMid,
        mostlyRed: mostlyRedFired,
        ivBreak: iv.fired,
        middayDeepNeg,
        ocRetPct: outcome?.ocRetPct ?? null,
        bigDown: outcome?.bigDown ?? null,
      },
      'capture-regime-0dte completed',
    );

    return {
      status: 'success',
      rows: 1,
      metadata: {
        today,
        gate,
        bigDown: outcome?.bigDown ?? null,
        ocRetPct: outcome?.ocRetPct ?? null,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
