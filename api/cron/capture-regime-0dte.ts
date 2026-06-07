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
  evaluateRegime0dte,
  gexNear,
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

/**
 * Pick the midday anchor spot from the 30-min candles: the close of the
 * first bucket at/after ctMin 780 (≈13:00 CT). When no bucket starts that
 * late (a short/early-close session), fall back to the bucket whose start
 * is nearest to 780; if there are no candles at all, return null.
 */
function middaySpotFromCandles(
  candles30: { ctMin: number; close: number }[],
): number | null {
  if (candles30.length === 0) return null;
  const atOrAfter = candles30
    .filter((c) => c.ctMin >= REGIME_0DTE.MIDDAY_AFTER_MIN)
    .sort((a, b) => a.ctMin - b.ctMin);
  if (atOrAfter[0]) return atOrAfter[0].close;
  // Fallback: nearest bucket to the midday minute.
  const nearest = [...candles30].sort(
    (a, b) =>
      Math.abs(a.ctMin - REGIME_0DTE.MIDDAY_AFTER_MIN) -
      Math.abs(b.ctMin - REGIME_0DTE.MIDDAY_AFTER_MIN),
  )[0];
  return nearest ? nearest.close : null;
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

    // Read the three live source tables via the shared helpers.
    const [{ strikes, spot }, putIv, candles30] = await Promise.all([
      getGexStrikes(today),
      getPutIvSeries(today),
      getCandles30(today),
    ]);

    // Holiday / data-outage guard: with no candles or no GEX strikes there
    // is nothing meaningful to score. Exit cleanly without a junk row.
    if (candles30.length === 0 || strikes.length === 0) {
      ctx.logger.info(
        { today, candles: candles30.length, strikes: strikes.length },
        'capture-regime-0dte: no data for today, skipping',
      );
      return {
        status: 'skipped',
        message: 'no candles/strikes for today',
        metadata: { today },
      };
    }

    // Day anchors from the 30-min candles (sorted by bucket start).
    const sorted = [...candles30].sort((a, b) => a.ctMin - b.ctMin);
    const openSpot = sorted[0]?.open ?? null;
    const closeSpot = sorted.at(-1)?.close ?? spot ?? null;
    const middaySpot = middaySpotFromCandles(sorted);

    if (closeSpot == null) {
      ctx.logger.warn(
        { today },
        'capture-regime-0dte: no close spot resolvable, skipping',
      );
      return {
        status: 'skipped',
        message: 'no close spot',
        metadata: { today },
      };
    }

    // Evaluate at 15:00 CT so every intraday trigger has seen the full day.
    const state = evaluateRegime0dte({
      nowCtMin: REGIME_0DTE.CLOSE_MIN,
      spot: closeSpot,
      openSpot,
      gexStrikes: strikes,
      putIv,
      candles30: sorted,
    });

    // GEX context at the open and midday anchors (net-GEX sum within the
    // ±band around each spot). gexNear returns null when the band is empty
    // or the spot is unknown.
    const gexOpen = openSpot != null ? gexNear(strikes, openSpot) : null;
    const gexMid = middaySpot != null ? gexNear(strikes, middaySpot) : null;

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
          ${today}::date, ${state.gate},
          ${gexOpen}, ${gexMid}, ${state.flipMinusOpenPct},
          ${state.triggers.mostlyRed.fired},
          ${ctMinToHhmm(state.triggers.mostlyRed.atCtMin)},
          ${state.triggers.ivBreak.fired},
          ${ctMinToHhmm(state.triggers.ivBreak.atCtMin)},
          ${state.triggers.ivBreak.magPct},
          ${state.triggers.middayDeepNeg.fired},
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
        gate: state.gate,
        gexOpen,
        gexMid,
        mostlyRed: state.triggers.mostlyRed.fired,
        ivBreak: state.triggers.ivBreak.fired,
        middayDeepNeg: state.triggers.middayDeepNeg.fired,
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
        gate: state.gate,
        bigDown: outcome?.bigDown ?? null,
        ocRetPct: outcome?.ocRetPct ?? null,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
