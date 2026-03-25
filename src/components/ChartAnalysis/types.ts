export type AnalysisMode = 'entry' | 'midday' | 'review';

export interface AnalysisContext {
  selectedDate?: string;
  entryTime?: string;
  spx?: number;
  spy?: number;
  vix?: number;
  vix1d?: number;
  vix9d?: number;
  vvix?: number;
  sigma?: number;
  sigmaSource?: string; // 'VIX1D' | 'VIX × 1.15' | 'manual'
  T?: number;
  hoursRemaining?: number;
  deltaCeiling?: number;
  putSpreadCeiling?: number;
  callSpreadCeiling?: number;
  regimeZone?: string;
  clusterMult?: number;
  dowLabel?: string;
  openingRangeSignal?: string;
  openingRangeAvailable?: boolean; // false if before 10:00 AM ET
  vixTermSignal?: string;
  vixTermShape?: string;
  clusterPutMult?: number;
  clusterCallMult?: number;
  rvIvRatio?: string;
  rvAnnualized?: number;
  ivAccelMult?: number;
  overnightGap?: string;
  isBacktest?: boolean;
  dataNote?: string; // describes any missing data
  events?: Array<{ event: string; time: string; severity: string }>;
}

export interface UploadedImage {
  id: string;
  file: File;
  preview: string;
  label: string;
}

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
  risks: string[];
  hedge?: {
    recommendation: string;
    description: string;
    rationale: string;
    estimatedCost: string;
  } | null;
  periscopeNotes?: string | null;
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

export const CHART_LABELS = [
  'Periscope (Gamma)',
  'Periscope Charm (SPX)',
] as const;

export const MODE_LABELS: Record<
  AnalysisMode,
  { label: string; desc: string }
> = {
  entry: {
    label: 'Pre-Trade',
    desc: 'Full analysis before opening a position',
  },
  midday: { label: 'Mid-Day', desc: 'Check if conditions changed since entry' },
  review: { label: 'Review', desc: 'End-of-day retrospective' },
};
