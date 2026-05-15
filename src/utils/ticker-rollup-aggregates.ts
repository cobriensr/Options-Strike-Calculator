/**
 * Pure aggregation helpers for the per-ticker rollup header in
 * Silent Boom and Lottery Finder. Spec:
 * docs/superpowers/specs/ticker-rollup-aggregates-2026-05-15.md
 *
 * Each panel maps its native alert/fire shape into `RollupAlertSummary[]`
 * and feeds it to `computeRollupAggregates()`. The shape is intentionally
 * minimal — only the fields needed by the five chips.
 */

export interface RollupAlertSummary {
  /** 'C' for call, 'P' for put — matches the project-wide OptionType. */
  optionType: 'C' | 'P';
  /** Market Tide NCP - NPP at trigger time. Null = pre-Phase-4 row. */
  mktTideDiff: number | null;
  /** Phase 4 direction-gate flag. */
  directionGated: boolean;
  /** ISO timestamp at fire/trigger (CT-anchored or UTC; we only diff). */
  triggeredAt: string;
  strike: number;
}

export type Bias = 'bull' | 'bear' | 'mixed';

export type TideAggregate =
  | { dir: 'up' | 'down'; align: 'aligned' | 'counter' }
  | { dir: 'mixed'; align: 'mixed' }
  | { dir: 'unknown'; align: 'unknown' };

export interface RollupAggregates {
  bias: Bias | null;
  tide: TideAggregate;
  /** Null when count < 2 (no spread to measure). */
  spreadMinutes: number | null;
  gatedCount: number;
  /**
   * Min/max strike across distinct strike values (a 68C and a 68P count
   * once at 68 — chain anchor matters more than side for concentration).
   * Null when fewer than 2 distinct strikes.
   */
  strikeRange: { min: number; max: number; spreadPts: number } | null;
}

export function computeRollupAggregates(
  rows: readonly RollupAlertSummary[],
): RollupAggregates {
  if (rows.length === 0) {
    return {
      bias: null,
      tide: { dir: 'unknown', align: 'unknown' },
      spreadMinutes: null,
      gatedCount: 0,
      strikeRange: null,
    };
  }

  const bias = computeBias(rows);
  const tide = computeTide(rows, bias);
  const spreadMinutes = computeSpreadMinutes(rows);
  const gatedCount = rows.reduce((n, r) => n + (r.directionGated ? 1 : 0), 0);
  const strikeRange = computeStrikeRange(rows);

  return { bias, tide, spreadMinutes, gatedCount, strikeRange };
}

function computeBias(rows: readonly RollupAlertSummary[]): Bias {
  let calls = 0;
  let puts = 0;
  for (const r of rows) {
    if (r.optionType === 'C') calls += 1;
    else puts += 1;
  }
  if (calls > 0 && puts === 0) return 'bull';
  if (puts > 0 && calls === 0) return 'bear';
  return 'mixed';
}

function computeTide(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
): TideAggregate {
  let pos = 0;
  let neg = 0;
  let nonNull = 0;
  for (const r of rows) {
    if (r.mktTideDiff == null) continue;
    nonNull += 1;
    if (r.mktTideDiff > 0) pos += 1;
    else if (r.mktTideDiff < 0) neg += 1;
  }
  if (nonNull === 0) return { dir: 'unknown', align: 'unknown' };

  let dir: 'up' | 'down' | 'mixed';
  if (pos > 0 && neg === 0) dir = 'up';
  else if (neg > 0 && pos === 0) dir = 'down';
  else dir = 'mixed';

  if (dir === 'mixed' || bias === 'mixed') {
    return { dir: 'mixed', align: 'mixed' };
  }
  const aligned =
    (bias === 'bull' && dir === 'up') || (bias === 'bear' && dir === 'down');
  return { dir, align: aligned ? 'aligned' : 'counter' };
}

function computeSpreadMinutes(
  rows: readonly RollupAlertSummary[],
): number | null {
  if (rows.length < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    const t = Date.parse(r.triggeredAt);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return null;
  }
  return Math.round((max - min) / 60_000);
}

function computeStrikeRange(
  rows: readonly RollupAlertSummary[],
): RollupAggregates['strikeRange'] {
  const distinct = new Set<number>();
  for (const r of rows) distinct.add(r.strike);
  if (distinct.size < 2) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of distinct) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max, spreadPts: max - min };
}

/** Format `spreadMinutes` for display — `Δ 8min` or `Δ 2.5h`. */
export function formatSpreadDuration(minutes: number): string {
  if (minutes <= 60) return `Δ ${minutes}min`;
  return `Δ ${(minutes / 60).toFixed(1)}h`;
}

/** Render bias chip text. */
export function formatBiasLabel(bias: Bias): string {
  if (bias === 'bull') return '↑ bull';
  if (bias === 'bear') return '↓ bear';
  return '~ mixed';
}

/** Render tide chip text. */
export function formatTideLabel(tide: TideAggregate): string {
  if (tide.dir === 'unknown') return 'tide —';
  if (tide.dir === 'mixed') return 'tide mixed';
  const arrow = tide.dir === 'up' ? '↑' : '↓';
  return `tide ${arrow} ${tide.align}`;
}
