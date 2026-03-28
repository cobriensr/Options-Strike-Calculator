/**
 * Analysis-related database operations.
 *
 * Handles saving Claude analysis responses and fetching previous
 * recommendations for analysis continuity.
 */

import { getDb } from './db.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ============================================================
// ANALYSIS
// ============================================================

/**
 * Save a Claude analysis response, linked to a snapshot if available.
 */
export async function saveAnalysis(
  context: {
    selectedDate?: string;
    entryTime?: string;
    spx?: number;
    vix?: number;
    vix1d?: number;
  },
  analysis: {
    mode?: string;
    structure: string;
    confidence: string;
    suggestedDelta: number | null | undefined;
    hedge?: { recommendation: string } | null;
    [key: string]: unknown;
  },
  snapshotId?: number | null,
) {
  const sql = getDb();

  const date = context.selectedDate ?? getETDateStr(new Date());
  const entryTime = context.entryTime ?? 'unknown';
  const mode = analysis.mode ?? 'entry';

  await sql`
    INSERT INTO analyses (
      snapshot_id, date, entry_time, mode, structure, confidence,
      suggested_delta, spx, vix, vix1d, hedge, full_response
    ) VALUES (
      ${snapshotId ?? null},
      ${date}, ${entryTime}, ${mode},
      ${analysis.structure}, ${analysis.confidence},
      ${analysis.suggestedDelta ?? 0},
      ${context.spx ?? null}, ${context.vix ?? null}, ${context.vix1d ?? null},
      ${analysis.hedge?.recommendation ?? null},
      ${JSON.stringify(analysis)}
    )
  `;
}

// ============================================================
// OUTCOMES (for future use)
// ============================================================

export async function saveOutcome(input: {
  date: string;
  settlement: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  vixClose?: number;
  vix1dClose?: number;
}) {
  const sql = getDb();
  const rangePts = Math.round(input.dayHigh - input.dayLow);
  const rangePct =
    input.dayOpen > 0 ? (input.dayHigh - input.dayLow) / input.dayOpen : null;
  const closeVsOpen = input.settlement - input.dayOpen;

  await sql`
    INSERT INTO outcomes (
      date, settlement, day_open, day_high, day_low,
      day_range_pts, day_range_pct, close_vs_open,
      vix_close, vix1d_close
    ) VALUES (
      ${input.date}, ${input.settlement},
      ${input.dayOpen}, ${input.dayHigh}, ${input.dayLow},
      ${rangePts}, ${rangePct}, ${closeVsOpen},
      ${input.vixClose ?? null}, ${input.vix1dClose ?? null}
    )
    ON CONFLICT (date) DO UPDATE SET
      settlement = EXCLUDED.settlement,
      day_open = EXCLUDED.day_open,
      day_high = EXCLUDED.day_high,
      day_low = EXCLUDED.day_low,
      day_range_pts = EXCLUDED.day_range_pts,
      day_range_pct = EXCLUDED.day_range_pct,
      close_vs_open = EXCLUDED.close_vs_open,
      vix_close = EXCLUDED.vix_close,
      vix1d_close = EXCLUDED.vix1d_close
  `;
}

// ============================================================
// PREVIOUS RECOMMENDATION (for analysis continuity)
// ============================================================

/**
 * Fetch the previous recommendation for a given date based on the current mode.
 *
 * Logic:
 *   - "entry" mode: No previous recommendation needed (returns null)
 *   - "midday" mode: Get the most recent analysis for this date
 *     (could be an entry or a previous midday — whatever came last)
 *   - "review" mode: Get the most recent midday analysis for this date,
 *     falling back to the most recent entry if no midday exists
 *
 * Returns a formatted string for Claude prompt context, or null if nothing found.
 */
export async function getPreviousRecommendation(
  date: string,
  currentMode: string,
): Promise<string | null> {
  if (currentMode === 'entry') return null;

  const sql = getDb();

  let rows;

  if (currentMode === 'midday') {
    // Get the most recent analysis for this date (any mode)
    rows = await sql`
      SELECT mode, entry_time, structure, confidence, suggested_delta, hedge,
             spx, vix, vix1d, full_response, created_at
      FROM analyses
      WHERE date = ${date}
      ORDER BY created_at DESC
      LIMIT 1
    `;
  } else if (currentMode === 'review') {
    // Prefer the most recent midday, fall back to most recent entry
    rows = await sql`
      SELECT mode, entry_time, structure, confidence, suggested_delta, hedge,
             spx, vix, vix1d, full_response, created_at
      FROM analyses
      WHERE date = ${date}
        AND mode IN ('midday', 'entry')
      ORDER BY
        CASE WHEN mode = 'midday' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
    `;
  } else {
    return null;
  }

  if (!rows || rows.length === 0) return null;

  const row = rows[0]!;
  const fullResponse = (
    typeof row.full_response === 'string'
      ? JSON.parse(row.full_response as string)
      : row.full_response
  ) as Record<string, unknown>;

  // Build a concise summary of the previous recommendation
  const lines: string[] = [
    `=== Previous ${(row.mode as string).toUpperCase()} Analysis (${row.entry_time}) ===`,
    `Structure: ${row.structure} | Confidence: ${row.confidence} | Delta: ${row.suggested_delta}Δ`,
    `SPX at analysis: ${row.spx} | VIX: ${row.vix} | VIX1D: ${row.vix1d}`,
    `Hedge: ${row.hedge ?? 'N/A'}`,
  ];

  // Include the reasoning
  if (fullResponse.reasoning) {
    lines.push(`Reasoning: ${fullResponse.reasoning}`);
  }

  // Include structure rationale for full context
  if (fullResponse.structureRationale) {
    lines.push(`Structure rationale: ${fullResponse.structureRationale}`);
  }

  // Include key management rules
  const mgmt = fullResponse.managementRules as
    | Record<string, unknown>
    | undefined;
  if (mgmt) {
    if (mgmt.profitTarget) lines.push(`Profit target: ${mgmt.profitTarget}`);
    if (Array.isArray(mgmt.stopConditions)) {
      lines.push('Stop conditions:');
      for (const stop of mgmt.stopConditions) {
        lines.push(`  - ${stop}`);
      }
    }
    if (mgmt.flowReversalSignal)
      lines.push(`Flow reversal signal: ${mgmt.flowReversalSignal}`);
  }

  // Include entry plan status
  const plan = fullResponse.entryPlan as Record<string, unknown> | undefined;
  if (plan) {
    lines.push(
      'Entry plan (RECOMMENDED strikes — actual fills are in "Current Open Positions"):',
    );
    if (plan.maxTotalSize) lines.push(`Max total size: ${plan.maxTotalSize}`);
    const e1 = plan.entry1 as Record<string, unknown> | undefined;
    const e2 = plan.entry2 as Record<string, unknown> | undefined;
    const e3 = plan.entry3 as Record<string, unknown> | undefined;
    if (e1?.sizePercent)
      lines.push(
        `Entry 1 (recommended): ${e1.structure} ${e1.delta}Δ at ${e1.sizePercent}% — ${e1.note ?? ''}`,
      );
    if (e2?.condition) lines.push(`Entry 2 condition: ${e2.condition}`);
    if (e3?.condition) lines.push(`Entry 3 condition: ${e3.condition}`);
  }

  // Include observations (top 3 for context)
  if (Array.isArray(fullResponse.observations)) {
    lines.push('Key observations at that time:');
    for (const obs of fullResponse.observations.slice(0, 3)) {
      lines.push(`  - ${obs}`);
    }
  }

  // Include strike guidance
  const strikes = fullResponse.strikeGuidance as
    | Record<string, unknown>
    | undefined;
  if (strikes) {
    if (strikes.putStrikeNote)
      lines.push(`Put strike guidance: ${strikes.putStrikeNote}`);
    if (strikes.callStrikeNote)
      lines.push(`Call strike guidance: ${strikes.callStrikeNote}`);
  }

  return lines.join('\n');
}
