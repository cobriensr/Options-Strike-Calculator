import type { AnalysisResult } from '../components/ChartAnalysis/types';

/**
 * Build a concise previous recommendation string from a client-side analysis result.
 * This is a FALLBACK — the backend now auto-fetches from DB via getPreviousRecommendation().
 * This client-side version is used when:
 *   - DB doesn't have the previous analysis yet (first run, no save)
 *   - Backtesting mode where analyses may not be saved
 */
export function buildPreviousRecommendation(prev: AnalysisResult): string {
  const parts = [
    `Structure: ${prev.structure}, Delta: ${prev.suggestedDelta}, Confidence: ${prev.confidence}`,
    `Reasoning: ${prev.reasoning}`,
  ];
  const e1 = prev.entryPlan?.entry1;
  if (e1) {
    const timing = e1.timing || e1.condition || '';
    parts.push(`Entry 1: ${e1.structure} ${String(e1.delta)}Δ at ${timing}`);
  }
  if (prev.hedge) {
    parts.push(
      `Hedge: ${prev.hedge.recommendation} — ${prev.hedge.description}`,
    );
  }
  if (prev.managementRules?.profitTarget) {
    parts.push(`Profit target: ${prev.managementRules.profitTarget}`);
  }
  if (prev.managementRules?.stopConditions) {
    parts.push(
      `Stop conditions: ${prev.managementRules.stopConditions.join('; ')}`,
    );
  }
  return parts.join('. ');
}
