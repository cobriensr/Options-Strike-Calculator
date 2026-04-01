/**
 * Flow checkpoint feature engineering for build-features cron.
 *
 * Extracts per-checkpoint NCP/NPP values for each flow source,
 * plus aggregated features: flow agreement, ETF divergence,
 * NCP-NPP gap.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import {
  type FeatureRow,
  type FlowRow,
  CHECKPOINTS,
  FLOW_SOURCES,
  AGREEMENT_SOURCES,
  num,
  findNearestCandle,
} from './build-features-types.js';

/** Count how many directional flow sources agree on direction. */
function computeFlowAgreement(
  allFlowRows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): number {
  let bullish = 0;
  let bearish = 0;

  for (const source of AGREEMENT_SOURCES) {
    const sourceRows = allFlowRows.filter((r) => r.source === source);
    const candle = findNearestCandle(sourceRows, targetMinutes, dateStr);
    if (!candle) continue;

    const ncp = num(candle.ncp);
    const npp = num(candle.npp);
    if (ncp == null || npp == null) continue;

    if (ncp > 0) bullish++;
    else if (ncp < 0) bearish++;
  }

  return Math.max(bullish, bearish);
}

/** Check if ETF Tide diverges from Net Flow at a checkpoint. */
function computeETFDivergence(
  allFlowRows: FlowRow[],
  targetMinutes: number,
  dateStr: string,
): boolean | null {
  const spyNet = findNearestCandle(
    allFlowRows.filter((r) => r.source === 'spy_flow'),
    targetMinutes,
    dateStr,
  );
  const spyETF = findNearestCandle(
    allFlowRows.filter((r) => r.source === 'spy_etf_tide'),
    targetMinutes,
    dateStr,
  );

  if (!spyNet || !spyETF) return null;
  const netNcp = num(spyNet.ncp);
  const etfNcp = num(spyETF.ncp);
  if (netNcp == null || etfNcp == null) return null;

  return (netNcp > 0 && etfNcp < 0) || (netNcp < 0 && etfNcp > 0);
}

/**
 * Engineer flow checkpoint features.
 * Mutates `features` in place with per-source checkpoint values
 * and aggregated flow metrics.
 */
export async function engineerFlowFeatures(
  sql: NeonQueryFunction<false, false>,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  const allFlowRows = (await sql`
    SELECT timestamp, source, ncp, npp
    FROM flow_data
    WHERE date = ${dateStr}
    ORDER BY timestamp ASC
  `) as FlowRow[];

  for (const cp of CHECKPOINTS) {
    for (const fs of FLOW_SOURCES) {
      const sourceRows = allFlowRows.filter((r) => r.source === fs.source);
      const candle = findNearestCandle(sourceRows, cp.minutes, dateStr);

      if (fs.prefix === 'delta_flow') {
        features[`${fs.prefix}_total_${cp.label}`] = candle
          ? num(candle.ncp)
          : null;
        features[`${fs.prefix}_dir_${cp.label}`] = candle
          ? num(candle.npp)
          : null;
      } else {
        features[`${fs.prefix}_ncp_${cp.label}`] = candle
          ? num(candle.ncp)
          : null;
        features[`${fs.prefix}_npp_${cp.label}`] = candle
          ? num(candle.npp)
          : null;
      }
    }

    // Aggregated flow features
    features[`flow_agreement_${cp.label}`] = computeFlowAgreement(
      allFlowRows,
      cp.minutes,
      dateStr,
    );
    features[`etf_tide_divergence_${cp.label}`] = computeETFDivergence(
      allFlowRows,
      cp.minutes,
      dateStr,
    );

    const spxCandle = findNearestCandle(
      allFlowRows.filter((r) => r.source === 'spx_flow'),
      cp.minutes,
      dateStr,
    );
    features[`ncp_npp_gap_spx_${cp.label}`] = spxCandle
      ? (num(spxCandle.ncp) ?? 0) - (num(spxCandle.npp) ?? 0)
      : null;
  }
}
