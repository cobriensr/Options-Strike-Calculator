/**
 * AnalysisHistoryItem — Summary bar + results for a single selected analysis.
 *
 * Displays the mode badge, structure, confidence, delta, market snapshot,
 * and delegates to AnalysisResultsView for the full result body.
 */

import { theme } from '../../themes';
import type { AnalysisEntry } from './types';
import { MODE_LABELS } from './types';
import { tint } from '../../utils/ui-utils';
import AnalysisResultsView from './AnalysisResults';

interface Props {
  readonly analysis: AnalysisEntry;
}

// ── Helpers ────────────────────────────────────────────────

function modeColor(m: string): string {
  if (m === 'entry') return theme.accent;
  if (m === 'midday') return theme.caution;
  return '#A78BFA';
}

function structureColor(structure: string): string {
  if (structure === 'IRON CONDOR') return theme.accent;
  if (structure === 'PUT CREDIT SPREAD') return theme.red;
  if (structure === 'CALL CREDIT SPREAD') return theme.green;
  return theme.caution;
}

function confidenceColor(confidence: string): string {
  if (confidence === 'HIGH') return theme.green;
  if (confidence === 'MODERATE') return theme.caution;
  return theme.red;
}

// ── No-op for image replace in history context ─────────────

function noopReplace(): void {
  // History entries don't support image replacement
}

// ── Component ──────────────────────────────────────────────

export default function AnalysisHistoryItem({ analysis }: Props) {
  const color = modeColor(analysis.mode);

  return (
    <>
      <div
        className="mb-3 flex items-center justify-between rounded-lg px-3 py-2"
        style={{
          backgroundColor: tint(color, '08'),
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(color, '15'),
              color,
            }}
          >
            {MODE_LABELS[analysis.mode].label}
          </span>
          <span
            className="font-mono text-[12px] font-bold"
            style={{ color: structureColor(analysis.structure) }}
          >
            {analysis.structure}
          </span>
          <span
            className="font-mono text-[10px] font-semibold"
            style={{ color: confidenceColor(analysis.confidence) }}
          >
            {analysis.confidence}
          </span>
          <span className="text-muted font-mono text-[10px]">
            {analysis.suggestedDelta}
            {'\u0394'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!!analysis.spx && (
            <span className="text-muted font-mono text-[10px]">
              SPX {Number(analysis.spx).toFixed(0)}
            </span>
          )}
          {!!analysis.vix && (
            <span className="text-muted font-mono text-[10px]">
              VIX {Number(analysis.vix).toFixed(1)}
            </span>
          )}
        </div>
      </div>

      <AnalysisResultsView
        analysis={analysis.analysis}
        mode={analysis.mode}
        onReplaceImage={noopReplace}
        defaultCollapsed
      />
    </>
  );
}
