/**
 * Analyze-endpoint result types shared between `src/utils/analysis.ts`
 * (pure compute — builds previous-recommendation string) and
 * `src/components/ChartAnalysis/` (UI rendering).
 *
 * Lifted from `src/components/ChartAnalysis/types.ts` in Phase 3C to
 * fix the inverted dependency where the util imported a type from a
 * UI component. Only the subset transitively reachable from
 * `AnalysisResult` lives here; UI-only shapes (AnalysisContext,
 * UploadedImage, DateEntry, AnalysisEntry, MODE_LABELS, etc.) stay
 * co-located with the ChartAnalysis component.
 *
 * `src/components/ChartAnalysis/types.ts` re-exports these names so
 * existing component-relative imports continue to work without churn.
 */

export type AnalysisMode = 'entry' | 'midday' | 'review';

export interface ChartSignal {
  signal: string;
  confidence: string;
  note: string;
}

export interface EntryStep {
  timing?: string;
  condition?: string;
  sizePercent: number;
  delta: number;
  structure: string;
  note: string;
}

export interface AnalysisResult {
  mode: AnalysisMode;
  structure: string;
  confidence: string;
  suggestedDelta: number;
  reasoning: string;
  chartConfidence?: {
    marketTide?: ChartSignal;
    spxNetFlow?: ChartSignal;
    spyNetFlow?: ChartSignal;
    qqqNetFlow?: ChartSignal;
    periscope?: ChartSignal;
    netCharm?: ChartSignal;
    aggregateGex?: ChartSignal;
    periscopeCharm?: ChartSignal;
    darkPool?: ChartSignal;
    ivTermStructure?: ChartSignal;
    spxCandles?: ChartSignal;
    overnightGap?: ChartSignal;
    vannaExposure?: ChartSignal;
    pinRisk?: ChartSignal;
    skew?: ChartSignal;
    futuresContext?: ChartSignal;
    nopeSignal?: ChartSignal;
    deltaFlow?: ChartSignal;
    zeroGamma?: ChartSignal;
    netGexHeatmap?: ChartSignal;
    marketInternals?: ChartSignal;
    deltaPressure?: ChartSignal;
    charmPressure?: ChartSignal;
  };
  observations: string[];
  strikeGuidance?: {
    putStrikeNote?: string;
    callStrikeNote?: string;
    straddleCone?: { upper: number; lower: number; priceRelation: string };
    adjustments?: string[];
  } | null;
  managementRules?: {
    profitTarget?: string;
    stopConditions?: string[];
    timeRules?: string;
    flowReversalSignal?: string;
  } | null;
  entryPlan?: {
    entry1?: EntryStep;
    entry2?: EntryStep;
    entry3?: EntryStep;
    maxTotalSize?: string;
    noEntryConditions?: string[];
  } | null;
  directionalOpportunity?: {
    direction: 'LONG CALL' | 'LONG PUT';
    confidence: string;
    reasoning: string;
    entryTiming: string;
    stopLoss: string;
    profitTarget: string;
    keyLevels: {
      support: string | null;
      resistance: string | null;
      vwap: string | null;
    };
    signals: string[];
  } | null;
  risks: string[];
  hedge?: {
    recommendation: string;
    description: string;
    rationale: string;
    estimatedCost: string;
  } | null;
  periscopeNotes?: string | null;
  pressureAnalysis?: string | null;
  structureRationale: string;
  review?: {
    wasCorrect: boolean;
    whatWorked: string;
    whatMissed: string;
    optimalTrade: string;
    lessonsLearned: string[];
  } | null;
  imageIssues?: Array<{
    imageIndex: number;
    label: string;
    issue: string;
    suggestion: string;
  }>;
}
