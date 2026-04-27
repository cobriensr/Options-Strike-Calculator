/**
 * TRACELiveHeader — always-visible top strip.
 *
 * Renders the synthesis headline, conviction + override + agreement chips,
 * spot, predicted close, last-update timestamp, and (in live mode) the
 * countdown to the next expected capture. Mirrors the SummaryCard pattern
 * from ChartAnalysis: tinted rounded box with a colored border, font-mono
 * pills for status, font-sans for the headline.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { TraceLiveDetail } from './types';
import type { UseTraceLiveCountdownReturn } from './hooks/useTraceLiveCountdown';

interface Props {
  readonly detail: TraceLiveDetail | null;
  readonly isLive: boolean;
  readonly countdown: UseTraceLiveCountdownReturn;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}

function confidenceColor(confidence: string | null): string {
  switch (confidence) {
    case 'high':
      return theme.green;
    case 'medium':
      return theme.accent;
    case 'low':
      return theme.caution;
    case 'no_trade':
      return theme.red;
    default:
      return theme.textMuted;
  }
}

function formatLocalTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function TRACELiveHeader({
  detail,
  isLive,
  countdown,
  loading,
  onRefresh,
}: Readonly<Props>) {
  const accent = confidenceColor(detail?.confidence ?? null);

  return (
    <div
      className="rounded-[10px] p-3.5"
      style={{
        backgroundColor: tint(accent, '0C'),
        border: `1.5px solid ${tint(accent, '30')}`,
      }}
    >
      {/* Headline */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className="font-sans text-[15px] font-bold"
          style={{ color: accent }}
        >
          {detail?.headline ?? (loading ? 'Loading…' : 'No captures yet')}
        </span>

        {detail?.confidence && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(accent, '18'),
              color: accent,
            }}
          >
            {detail.confidence.replace('_', ' ')}
          </span>
        )}

        {detail?.overrideApplied && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(theme.accent, '18'),
              color: theme.accent,
            }}
            title="Gamma override fired — pin level taken from dominant +γ node"
          >
            OVERRIDE
          </span>
        )}

        {/* Novelty flag — fires when this setup is far from any of the
            20 closest historical embeddings. Threshold (0.45) is a
            conservative starting point against typical TRACE-live cosine
            distances of 0.05-0.40 for similar-regime captures; tune
            after a few weeks of data + the calibration ML pipeline. */}
        {detail?.noveltyScore != null && detail.noveltyScore > 0.45 && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(theme.red, '18'),
              color: theme.red,
            }}
            title={`Novelty score ${detail.noveltyScore.toFixed(3)} — this setup is far from any of the 20 closest historical patterns. Model calibration may not apply; consider reduced sizing.`}
          >
            ⚠ NOVEL
          </span>
        )}

        {isLive ? (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(theme.green, '18'),
              color: theme.green,
            }}
          >
            ▶ LIVE
          </span>
        ) : (
          <span
            className="text-muted rounded-full px-2 py-0.5 font-mono text-[10px]"
            style={{ backgroundColor: theme.surfaceAlt }}
          >
            HISTORICAL
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="text-secondary flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
        {detail?.spot != null && (
          <span>
            Spot{' '}
            <span className="text-tertiary font-semibold">
              {detail.spot.toFixed(2)}
            </span>
          </span>
        )}
        {detail?.predictedClose != null && (
          <span>
            Predicted{' '}
            <span className="text-tertiary font-semibold">
              {detail.predictedClose.toFixed(2)}
            </span>
          </span>
        )}
        {detail?.capturedAt && (
          <span>
            Updated{' '}
            <span className="text-tertiary font-semibold">
              {formatLocalTime(detail.capturedAt)}
            </span>{' '}
            ET
          </span>
        )}
        {isLive && countdown.label && (
          <span style={{ color: countdown.isOverdue ? theme.red : undefined }}>
            {countdown.isOverdue ? 'Overdue' : 'Next'}{' '}
            <span className="font-semibold">{countdown.label}</span>
          </span>
        )}
        <button
          type="button"
          className="text-muted hover:text-tertiary ml-auto cursor-pointer text-[10px] underline-offset-2 hover:underline"
          onClick={onRefresh}
          aria-label="Refresh TRACE Live"
        >
          refresh
        </button>
      </div>
    </div>
  );
}

export default memo(TRACELiveHeader);
