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
  openingRangeHigh?: number;
  openingRangeLow?: number;
  openingRangePctConsumed?: number; // % of median expected range consumed
  vixTermSignal?: string;
  vixTermShape?: string;
  clusterPutMult?: number;
  clusterCallMult?: number;
  rvIvRatio?: string;
  rvAnnualized?: number;
  ivAccelMult?: number;
  prevClose?: number;
  overnightGap?: string;
  isBacktest?: boolean;
  dataNote?: string; // describes any missing data
  events?: Array<{ event: string; time: string; severity: string }>;
  // Chain-derived data (computed client-side, passed to analyze)
  topOIStrikes?: Array<{
    strike: number;
    putOI: number;
    callOI: number;
    totalOI: number;
    distFromSpot: number;
    distPct: string;
    side: 'put' | 'call' | 'both';
  }>;
  skewMetrics?: {
    put25dIV: number; // IV at ~25-delta put
    call25dIV: number; // IV at ~25-delta call
    atmIV: number; // ATM IV
    putSkew25d: number; // put25dIV - atmIV (vol pts)
    callSkew25d: number; // call25dIV - atmIV (vol pts)
    skewRatio: number; // |putSkew| / |callSkew|
  };
  /** Per-strike delta rungs sampled from the live option chain (puts + calls).
   *  Lets Claude map a target delta to an actual market strike instead of
   *  guessing from point distance. Omitted when chain data is unavailable. */
  targetDeltaStrikes?: {
    preferredDelta: number; // 12
    floorDelta: number; // 10
    puts: Array<{
      delta: number;
      strike: number;
      bid: number;
      ask: number;
      iv: number;
      oi: number;
    }>;
    calls: Array<{
      delta: number;
      strike: number;
      bid: number;
      ask: number;
      iv: number;
      oi: number;
    }>;
  };
  /** Pre-formatted structural bias summary from GEX Landscape, passed as-is to analyze. */
  gexLandscapeBias?: string | null;
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

// ── History-specific types ──────────────────────────────────

export interface DateEntry {
  date: string;
  total: number;
  entries: number;
  middays: number;
  reviews: number;
}

export interface AnalysisEntry {
  id: number;
  entryTime: string;
  mode: AnalysisMode;
  structure: string;
  confidence: string;
  suggestedDelta: number;
  spx: number | null;
  vix: number | null;
  vix1d: number | null;
  hedge: string | null;
  analysis: AnalysisResult;
  createdAt: string;
}

export type ModeFilter = 'all' | 'entry' | 'midday' | 'review';

export const CHART_LABELS = [
  'Periscope (Gamma)',
  'Periscope Charm (SPX)',
  'Delta Pressure',
  'Charm Pressure',
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
