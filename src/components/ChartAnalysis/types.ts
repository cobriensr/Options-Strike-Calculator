// AnalysisMode, ChartSignal, EntryStep, AnalysisResult lifted to
// src/types/analysis.ts (Phase 3C). Re-exported here so existing
// component-relative `from './types'` imports keep working.
export type {
  AnalysisMode,
  ChartSignal,
  EntryStep,
  AnalysisResult,
} from '../../types/analysis';

import type { AnalysisMode, AnalysisResult } from '../../types/analysis';

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
  targetDeltaStrikes?: TargetDeltaStrikes;
  /** Pre-formatted structural bias summary from GEX Landscape, passed as-is to analyze. */
  gexLandscapeBias?: string | null;
}

/** One rung: a chain strike selected as the nearest match for a target |delta|. */
export interface DeltaRung {
  delta: number; // absolute delta as decimal (0.12 = 12Δ)
  strike: number;
  bid: number;
  ask: number;
  iv: number; // decimal (0.25 = 25%)
  oi: number;
}

/** Compact view of the live option chain for strike selection. */
export interface TargetDeltaStrikes {
  preferredDelta: number; // 12
  floorDelta: number; // 10
  puts: DeltaRung[];
  calls: DeltaRung[];
}

export interface UploadedImage {
  id: string;
  file: File;
  preview: string;
  label: string;
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
