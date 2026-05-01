/**
 * Label extraction + upsert helpers — extracted from
 * `api/cron/build-features.ts` during the Phase 4c refactor
 * (api-refactor-2026-05-02).
 *
 * Scope: pulls structured labels out of the latest `review` analysis for
 * a date, derives outcome-driven labels (settlement direction, range
 * category, flow-vs-settlement agreement), then upserts the result into
 * `day_labels`. Behaviour unchanged — handler used to own this verbatim.
 */
import { getDb } from './db.js';
import { Sentry } from './sentry.js';
import logger from './logger.js';
import {
  AGREEMENT_SOURCES,
  num,
  findNearestCandle,
  type FeatureRow,
  type FlowRow,
} from './build-features-types.js';

// ── Label extraction from review analyses ──────────────────────

export async function extractLabelsForDate(
  dateStr: string,
): Promise<FeatureRow | null> {
  const sql = getDb();

  const reviews = await sql`
    SELECT id, full_response
    FROM analyses
    WHERE date = ${dateStr} AND mode = 'review'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (reviews.length === 0) return null;

  const row = reviews[0]!;
  const analysisId = row.id as number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any;
  try {
    resp =
      typeof row.full_response === 'string'
        ? JSON.parse(row.full_response)
        : row.full_response;
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err, date: dateStr }, 'Failed to parse review full_response');
    return null;
  }

  const review = resp?.review ?? {};
  const chartConf = resp?.chartConfidence ?? {};

  const labels: FeatureRow = {
    date: dateStr,
    analysis_id: analysisId,
    structure_correct: review.wasCorrect ?? null,
    recommended_structure: resp?.structure ?? null,
    confidence: resp?.confidence ?? null,
    suggested_delta: resp?.suggestedDelta ?? null,
    charm_diverged: chartConf?.periscopeCharm?.signal === 'CONTRADICTS' || null,
    naive_charm_signal: chartConf?.netCharm?.signal ?? null,
    spx_flow_signal: chartConf?.spxNetFlow?.signal ?? null,
    market_tide_signal: chartConf?.marketTide?.signal ?? null,
    spy_flow_signal: chartConf?.spyNetFlow?.signal ?? null,
    gex_signal: chartConf?.aggregateGex?.signal ?? null,
  };

  // Derived labels from outcomes
  const outcomes = await sql`
    SELECT settlement, day_open, day_high, day_low, day_range_pts
    FROM outcomes
    WHERE date = ${dateStr}
    LIMIT 1
  `;

  if (outcomes.length > 0) {
    const o = outcomes[0]!;
    const settlement = Number(o.settlement);
    const dayOpen = Number(o.day_open);
    const rangePts = Number(o.day_range_pts);

    labels.settlement_direction =
      settlement > dayOpen ? 'UP' : settlement < dayOpen ? 'DOWN' : 'FLAT';

    labels.range_category =
      rangePts < 30
        ? 'NARROW'
        : rangePts < 60
          ? 'NORMAL'
          : rangePts < 100
            ? 'WIDE'
            : 'EXTREME';

    // Flow was directional? Compare majority flow at T2 vs settlement direction
    const flowRows = await sql`
      SELECT timestamp, source, ncp
      FROM flow_data
      WHERE date = ${dateStr}
      ORDER BY timestamp ASC
    `;

    const allFlowT2 = flowRows as FlowRow[];
    let bullishCount = 0;
    let bearishCount = 0;

    for (const source of AGREEMENT_SOURCES) {
      const sourceRows = allFlowT2.filter((r) => r.source === source);
      const candle = findNearestCandle(sourceRows, 630, dateStr);
      if (!candle) continue;
      const ncp = num(candle.ncp);
      if (ncp == null) continue;
      if (ncp > 0) bullishCount++;
      else if (ncp < 0) bearishCount++;
    }

    const flowDirection =
      bullishCount > bearishCount
        ? 'UP'
        : bearishCount > bullishCount
          ? 'DOWN'
          : null;
    labels.flow_was_directional =
      flowDirection != null
        ? flowDirection === labels.settlement_direction
        : null;
  }

  // Compute label completeness
  const labelKeys = [
    'structure_correct',
    'charm_diverged',
    'naive_charm_signal',
    'spx_flow_signal',
    'market_tide_signal',
    'gex_signal',
    'settlement_direction',
    'range_category',
    'flow_was_directional',
  ];
  const nonNull = labelKeys.filter((k) => labels[k] != null).length;
  labels.label_completeness =
    Math.round((nonNull / labelKeys.length) * 100) / 100;

  return labels;
}

// ── Upsert ─────────────────────────────────────────────────────

export async function upsertLabels(l: FeatureRow): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO day_labels (
      date, analysis_id,
      structure_correct, recommended_structure, confidence, suggested_delta,
      charm_diverged, naive_charm_signal, spx_flow_signal,
      market_tide_signal, spy_flow_signal, gex_signal,
      flow_was_directional, settlement_direction, range_category,
      label_completeness
    ) VALUES (
      ${l.date}, ${l.analysis_id},
      ${l.structure_correct}, ${l.recommended_structure},
      ${l.confidence}, ${l.suggested_delta},
      ${l.charm_diverged}, ${l.naive_charm_signal}, ${l.spx_flow_signal},
      ${l.market_tide_signal}, ${l.spy_flow_signal}, ${l.gex_signal},
      ${l.flow_was_directional}, ${l.settlement_direction}, ${l.range_category},
      ${l.label_completeness}
    )
    -- Same COALESCE pattern as upsertFeatures: when extractLabelsForDate
    -- can't reach a downstream source (e.g. analyses table missing a row,
    -- or outcomes still pending), it returns labels with undefined fields
    -- which would clobber existing values without this guard.
    ON CONFLICT (date) DO UPDATE SET
      analysis_id = COALESCE(EXCLUDED.analysis_id, day_labels.analysis_id),
      structure_correct = COALESCE(EXCLUDED.structure_correct, day_labels.structure_correct),
      recommended_structure = COALESCE(EXCLUDED.recommended_structure, day_labels.recommended_structure),
      confidence = COALESCE(EXCLUDED.confidence, day_labels.confidence),
      suggested_delta = COALESCE(EXCLUDED.suggested_delta, day_labels.suggested_delta),
      charm_diverged = COALESCE(EXCLUDED.charm_diverged, day_labels.charm_diverged),
      naive_charm_signal = COALESCE(EXCLUDED.naive_charm_signal, day_labels.naive_charm_signal),
      spx_flow_signal = COALESCE(EXCLUDED.spx_flow_signal, day_labels.spx_flow_signal),
      market_tide_signal = COALESCE(EXCLUDED.market_tide_signal, day_labels.market_tide_signal),
      spy_flow_signal = COALESCE(EXCLUDED.spy_flow_signal, day_labels.spy_flow_signal),
      gex_signal = COALESCE(EXCLUDED.gex_signal, day_labels.gex_signal),
      flow_was_directional = COALESCE(EXCLUDED.flow_was_directional, day_labels.flow_was_directional),
      settlement_direction = COALESCE(EXCLUDED.settlement_direction, day_labels.settlement_direction),
      range_category = COALESCE(EXCLUDED.range_category, day_labels.range_category),
      label_completeness = COALESCE(EXCLUDED.label_completeness, day_labels.label_completeness)
  `;
}
