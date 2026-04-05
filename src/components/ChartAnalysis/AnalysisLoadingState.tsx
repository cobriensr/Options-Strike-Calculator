/**
 * AnalysisLoadingState — Confirmation dialog and loading indicator
 * for the chart analysis flow.
 */

import { theme } from '../../themes';
import type { AnalysisMode, UploadedImage } from './types';
import { MODE_LABELS } from './types';
import { tint } from '../../utils/ui-utils';

// ── Confirmation Bar ─────────────────────────────────────────

export function ConfirmationBar({
  images,
  mode,
  isBacktest,
  lastAnalysis,
  onCancel,
  onConfirm,
}: Readonly<{
  images: readonly UploadedImage[];
  mode: AnalysisMode;
  isBacktest: boolean;
  lastAnalysis: { structure: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  return (
    <div
      className="mb-3 flex items-center justify-between rounded-lg px-4 py-3"
      style={{
        backgroundColor: tint(theme.caution, '10'),
        border: '1.5px solid ' + tint(theme.caution, '30'),
      }}
    >
      <div>
        <div
          className="font-sans text-[11px] font-semibold"
          style={{ color: theme.caution }}
        >
          Send {images.length} image{images.length > 1 ? 's' : ''} to Opus?
          (~5{'\u201310'} min, billed on send)
        </div>
        <div className="text-muted mt-0.5 font-sans text-[10px]">
          {MODE_LABELS[mode].label} {'\u2022'}{' '}
          {images.map((img) => img.label).join(', ')}
          {!isBacktest && (
            <span style={{ color: theme.accent }}>
              {' \u2022'} Will fetch live positions from Schwab
            </span>
          )}
          {lastAnalysis && (mode === 'midday' || mode === 'review') && (
            <span style={{ color: theme.green }}>
              {' '}
              {'\u2022'} Includes previous {lastAnalysis.structure}{' '}
              recommendation
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
          style={{
            backgroundColor: theme.surfaceAlt,
            color: theme.textMuted,
          }}
        >
          Go Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="cursor-pointer rounded-md px-4 py-1.5 font-sans text-[10px] font-bold tracking-wider uppercase transition-opacity hover:opacity-90"
          style={{ backgroundColor: theme.accent, color: '#fff' }}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

// ── Loading Indicator ────────────────────────────────────────

export function LoadingIndicator({
  elapsed,
  THINKING_MESSAGES,
  cancelAnalysis,
}: Readonly<{
  elapsed: number;
  THINKING_MESSAGES: readonly string[];
  cancelAnalysis: () => void;
}>) {
  return (
    <div
      className="border-edge mb-3 overflow-hidden rounded-lg border p-4"
      style={{ backgroundColor: theme.surfaceAlt }}
    >
      {/* Pulsing bar */}
      <div
        className="mb-3 h-1 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: tint(theme.accent, '20') }}
      >
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor: theme.accent,
            width: `${Math.min(95, (elapsed / 600) * 100)}%`,
            transition: 'width 1s linear',
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <div
            className="mb-0.5 font-sans text-[11px] font-semibold"
            style={{ color: theme.accent }}
          >
            Opus is thinking...
          </div>
          <div className="text-muted font-sans text-[10px]">
            {
              THINKING_MESSAGES[
                Math.min(
                  Math.floor(elapsed / 50),
                  THINKING_MESSAGES.length - 1,
                )
              ]
            }
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="font-mono text-[12px] font-bold"
            style={{ color: theme.textMuted }}
          >
            {elapsed}s
          </div>
          <button
            type="button"
            onClick={cancelAnalysis}
            className="cursor-pointer rounded-md px-3 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
            style={{
              backgroundColor: tint(theme.red, '18'),
              color: theme.red,
              border: `1px solid ${tint(theme.red, '30')}`,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
