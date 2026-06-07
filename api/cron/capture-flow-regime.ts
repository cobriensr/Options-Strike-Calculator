/**
 * GET /api/cron/capture-flow-regime
 *
 * Flow Regime Recognition badge — live capture cron (Phase 2 of
 * docs/superpowers/specs/flow-regime-badge-2026-06-06.md).
 *
 * Every 5 min during market hours this:
 *   1. Computes the CURRENT 30-min ET RTH slot
 *      (slot = (et_minute − 570) / 30, RTH = [09:30, 16:00) ET).
 *   2. Reads ws_option_trades for TODAY (ET) from the slot's start
 *      minute up to "now".
 *   3. Builds FlowTradeRow[] and computes the two detrend-robust ratio
 *      metrics via the Phase 1 lib (computeFlowMetrics), scores them
 *      against the committed baseline (evaluateFlowRegime).
 *   4. UPSERTs the (date, slot) snapshot via ON CONFLICT DO UPDATE so
 *      the in-progress bucket is refined on every tick until it closes.
 *
 * Outside RTH the cron no-ops (status 'skipped') — there is no current
 * slot to capture. ws_option_trades is ALREADY restricted to the
 * ~50-ticker WS Lottery universe, so no extra ticker filter is needed;
 * computeFlowMetrics applies the index-set restriction for the
 * idx0dte_put_share numerator internally.
 *
 * RECOGNITION ONLY — the snapshot scores "is today's flow abnormal for
 * this time of day, as it forms"; it does NOT forecast direction.
 *
 * marketHours: true — only runs inside the RTH cron window.
 * requireApiKey: false — reads only our own ws_option_trades table.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  computeFlowMetrics,
  evaluateFlowRegime,
  slotForEtMinute,
  FLOW_REGIME_BASELINE,
  type FlowTradeRow,
} from '../_lib/flow-regime.js';
import {
  getETDateStr,
  getETTotalMinutes,
  etWallClockToUtcIso,
} from '../../src/utils/timezone.js';

/**
 * Minimum trades in the (in-progress) bucket before we attach a
 * directional regime/color. Below this the net-delta tilt is dominated
 * by one or two prints — early in a slot a single large bid-side put can
 * push ndTilt ≈ −1 and flash a false "bearish/red". The baseline slots
 * aggregate thousands of trades, so a live bucket with < 50 trades is a
 * thin/degraded window: we still persist the raw metrics + n_trades for
 * transparency, but force regime 'normal'/color 'gray' so the badge reads
 * low-confidence rather than a spurious signal. During RTH the ~50-ticker
 * universe (incl. very active SPXW/QQQ) clears this within seconds of a
 * slot opening, so this only suppresses genuinely sparse windows.
 */
const MIN_BUCKET_TRADES = 50;

/**
 * Raw shape of one ws_option_trades row from Neon. NUMERIC columns
 * come back as STRINGS (price/strike/delta/underlying_price); delta and
 * underlying_price are NULLABLE in the schema. We coerce explicitly
 * before building FlowTradeRow so a raw null/string never reaches the
 * numeric metric math.
 */
interface WsOptionTradeRow {
  ticker: string;
  option_type: string;
  strike: string;
  expiry: string | Date;
  executed_at: string | Date;
  price: string;
  size: number;
  underlying_price: string | null;
  side: string;
  delta: string | null;
}

function toDateStr(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

export default withCronInstrumentation(
  'capture-flow-regime',
  async (ctx): Promise<CronResult> => {
    const now = new Date();
    // ET trading day — matches the table's DATE semantics and the
    // endpoint's default, keeping date alignment across cron/endpoint.
    const date = getETDateStr(now);

    // Current 30-min RTH slot. Null outside [09:30, 16:00) ET → no-op.
    const etMinute = getETTotalMinutes(now);
    const slot = slotForEtMinute(etMinute);
    if (slot === null) {
      ctx.logger.info(
        { date, etMinute },
        'capture-flow-regime: outside RTH, skipping',
      );
      return {
        status: 'skipped',
        message: 'outside RTH',
        metadata: { date, etMinute },
      };
    }

    // Lower bound = the slot's start minute as a UTC instant; upper
    // bound = now. This window is the in-progress bucket so far.
    const slotStartEtMinute =
      FLOW_REGIME_BASELINE.rth_start_minute +
      slot * FLOW_REGIME_BASELINE.bucket_minutes;
    const slotStartIso = etWallClockToUtcIso(date, slotStartEtMinute);
    if (slotStartIso === null) {
      // getETDateStr should never produce a malformed date; defensive.
      ctx.logger.warn(
        { date, slotStartEtMinute },
        'capture-flow-regime: could not resolve slot start, skipping',
      );
      return {
        status: 'skipped',
        message: 'invalid slot start',
        metadata: { date, slot },
      };
    }
    const nowIso = now.toISOString();

    // ws_option_trades is already restricted to the WS universe, so no
    // ticker filter. canceled = FALSE matches the parquet/baseline
    // convention. withDbRetry: Neon HTTP serverless can blip.
    const sql = getDb();
    const rows = (await withDbRetry(
      () => sql`
        SELECT
          ticker,
          option_type,
          strike,
          expiry,
          executed_at,
          price,
          size,
          underlying_price,
          side,
          delta
        FROM ws_option_trades
        WHERE canceled = FALSE
          AND executed_at >= ${slotStartIso}::timestamptz
          AND executed_at < ${nowIso}::timestamptz
      `,
      2,
      10_000,
    )) as WsOptionTradeRow[];

    // Coerce NUMERIC-as-string + nullable columns to plain numbers
    // BEFORE the metric math. delta/underlying_price null → 0 (a null
    // delta contributes 0 to both the net-delta numerator and the
    // |delta| denominator, which is the documented evaluator behavior).
    const tradeRows: FlowTradeRow[] = rows.map((r) => ({
      ticker: r.ticker,
      optionType: r.option_type,
      expiry: toDateStr(r.expiry),
      tradeDateEt: date,
      side: r.side,
      delta: r.delta != null ? Number(r.delta) : 0,
      size: r.size,
      price: r.price != null ? Number(r.price) : 0,
    }));

    const sums = computeFlowMetrics(tradeRows);
    const evaluated = evaluateFlowRegime({ sums, slot });

    // Low-confidence gate: a thin bucket can produce an extreme tilt off a
    // couple of prints. Keep the raw metrics/percentiles, but suppress the
    // directional regime/color to normal/gray below the floor so the badge
    // never flashes a false signal on near-zero data.
    const lowConfidence = tradeRows.length < MIN_BUCKET_TRADES;
    const result = lowConfidence
      ? { ...evaluated, regime: 'normal' as const, color: 'gray' as const }
      : evaluated;

    // UPSERT — ON CONFLICT (date, slot) refines the in-progress bucket
    // on each 5-min tick. Percentiles are NULL when the slot lacks
    // baseline depth (hasBaseline === false).
    await withDbRetry(
      () => sql`
        INSERT INTO flow_regime_snapshots (
          date, slot, computed_at,
          nd_tilt, idx0dte_put_share,
          nd_percentile, idxput_percentile,
          regime, color, n_trades
        ) VALUES (
          ${date}::date, ${slot}, NOW(),
          ${result.ndTilt}, ${result.idx0dtePutShare},
          ${result.ndPercentile}, ${result.idxputPercentile},
          ${result.regime}, ${result.color}, ${tradeRows.length}
        )
        ON CONFLICT (date, slot) DO UPDATE SET
          computed_at = NOW(),
          nd_tilt = EXCLUDED.nd_tilt,
          idx0dte_put_share = EXCLUDED.idx0dte_put_share,
          nd_percentile = EXCLUDED.nd_percentile,
          idxput_percentile = EXCLUDED.idxput_percentile,
          regime = EXCLUDED.regime,
          color = EXCLUDED.color,
          n_trades = EXCLUDED.n_trades
      `,
      2,
      10_000,
    );

    ctx.logger.info(
      {
        date,
        slot,
        nTrades: tradeRows.length,
        regime: result.regime,
        color: result.color,
        hasBaseline: result.hasBaseline,
        lowConfidence,
      },
      'capture-flow-regime completed',
    );

    return {
      status: 'success',
      rows: 1,
      metadata: {
        date,
        slot,
        nTrades: tradeRows.length,
        regime: result.regime,
        hasBaseline: result.hasBaseline,
        lowConfidence,
      },
    };
  },
  { marketHours: true, requireApiKey: false },
);
