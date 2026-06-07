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
 * 15:00 CT cash close and settle. Reads the same three source tables as
 * the live endpoint via the Task-5 helpers, then runs a small day-OHLC
 * aggregate on index_candles_1m for the realized columns.
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
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  gexNear,
  gradeGate,
  flipStrike,
  countCandles,
  ivBreak,
  REGIME_0DTE,
} from '../_lib/regime-0dte.js';
import {
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
} from '../_lib/regime-0dte-queries.js';

/**
 * Format a CT minute-of-day (e.g. 660 = 11:00 CT) as a zero-padded
 * 'HH:MM' clock string for the `*_at` TEXT columns. Null in → null out
 * (the trigger did not fire).
 */
function ctMinToHhmm(ctMin: number | null): string | null {
  if (ctMin == null) return null;
  const h = Math.floor(ctMin / 60);
  const m = ctMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Neon returns NUMERIC columns as strings (full precision); nulls flow
// through. Accept all three at the read boundary.
type Numeric = string | number | null;

/** One day-OHLC aggregate row from index_candles_1m (NUMERIC → string). */
interface DayOhlcRow {
  day_open: Numeric;
  day_close: Numeric;
  day_hi: Numeric;
  day_lo: Numeric;
}

/**
 * Realized open→close return, intraday range, and directional efficiency
 * for the day, plus the big-up / big-down flags. Returns null when the
 * day's true open is missing or non-positive (can't normalize).
 */
function realizedOutcome(row: DayOhlcRow | undefined): {
  ocRetPct: number;
  rangePct: number;
  dirEff: number;
  bigDown: boolean;
  bigUp: boolean;
} | null {
  if (!row) return null;
  const open = Number(row.day_open ?? 0);
  const close = Number(row.day_close ?? 0);
  const hi = Number(row.day_hi ?? 0);
  const lo = Number(row.day_lo ?? 0);
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

    // gate + gex_open ← OPEN-minute profile at that minute's spot. This is the
    // forward open-gate the scorecard validates (NOT the coincident close).
    const gexOpen =
      openP.spot != null ? gexNear(openP.strikes, openP.spot) : null;
    const gate = gradeGate(gexOpen);

    // gex_mid + midday_deep_neg ← MIDDAY-minute profile at that minute's spot.
    const gexMid = midP.spot != null ? gexNear(midP.strikes, midP.spot) : null;
    const middayDeepNeg = gexMid != null && gexMid <= REGIME_0DTE.GATE_DEEP_NEG;

    // flip_minus_open_pct ← flip strike on the OPEN profile vs the open spot.
    const flip =
      openP.spot != null ? flipStrike(openP.strikes, openP.spot) : null;
    const flipMinusOpenPct =
      flip != null && openP.spot
        ? ((flip - openP.spot) / openP.spot) * 100
        : null;

    // mostly_red + iv_break stay full-day-series based. countCandles over the
    // 11:00-CT persistence window; ivBreak is EOD-capped internally via
    // CLOSE_MIN (min(nowCtMin, IVBREAK_WIN_END) inside the helper).
    const { green, red } = countCandles(sorted, REGIME_0DTE.PERSIST_END_MIN);
    const mostlyRedFired =
      green <= REGIME_0DTE.MOSTLY_RED_MAX_GREEN &&
      red >= REGIME_0DTE.MOSTLY_RED_MIN_RED;
    const mostlyRedAt = mostlyRedFired ? REGIME_0DTE.PERSIST_END_MIN : null;

    const iv = ivBreak(putIv, REGIME_0DTE.CLOSE_MIN);

    // Realized outcome: day open/close/hi/lo from the regular-session
    // SPX 1-min bars. One aggregate row per day.
    const sql = getDb();
    const ohlcRows = (await withDbRetry(
      () => sql`
        SELECT
          (array_agg(open  ORDER BY timestamp ASC))[1]  AS day_open,
          (array_agg(close ORDER BY timestamp DESC))[1] AS day_close,
          max(high) AS day_hi,
          min(low)  AS day_lo
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND market_time = 'r'
          AND date = ${today}::date
      `,
      2,
      10_000,
    )) as DayOhlcRow[];

    const outcome = realizedOutcome(ohlcRows[0]);

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
