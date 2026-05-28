// Descriptive "suspicious flow" cluster detector — feed-computed, no persistence.
// A (ticker, side) is a suspicious cluster when >= MIN_CLUSTER_STRIKES distinct
// strikes co-fire that day as cheap, OTM, ask-side 0DTE options.
// NOTE: descriptive attention-flag only — the cohort is net negative-expectancy
// (see docs/superpowers/specs/2026-05-27-suspicious-flow-and-takeit-floor-design.md).

export const MIN_CLUSTER_STRIKES = 3;
export const MAX_CHEAP_ENTRY = 1.5;
export const MIN_CLUSTER_ASK_PCT = 0.7;

export interface ClusterCandidateRow {
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strike: number;
  dte: number;
  entryPrice: number;
  spot: number | null;
  askPct: number;
}

export function clusterKey(symbol: string, side: 'C' | 'P'): string {
  return `${symbol}|${side}`;
}

function isClusterMember(r: ClusterCandidateRow): boolean {
  if (r.dte !== 0) return false;
  if (r.spot == null) return false;
  if (r.entryPrice > MAX_CHEAP_ENTRY) return false;
  if (r.askPct < MIN_CLUSTER_ASK_PCT) return false;
  // ATM (strike == spot) counts as OTM, per the design-spec definition.
  const otm = r.optionType === 'C' ? r.strike >= r.spot : r.strike <= r.spot;
  return otm;
}

// Returns Map<`${symbol}|${side}`, distinctStrikeCount> for sides meeting the threshold.
export function computeSuspiciousClusters(
  rows: ClusterCandidateRow[],
): Map<string, number> {
  const strikesByKey = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!isClusterMember(r)) continue;
    const key = clusterKey(r.underlyingSymbol, r.optionType);
    let set = strikesByKey.get(key);
    if (!set) {
      set = new Set<number>();
      strikesByKey.set(key, set);
    }
    set.add(r.strike);
  }
  const out = new Map<string, number>();
  for (const [key, set] of strikesByKey) {
    if (set.size >= MIN_CLUSTER_STRIKES) out.set(key, set.size);
  }
  return out;
}
