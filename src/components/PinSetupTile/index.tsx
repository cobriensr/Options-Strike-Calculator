/**
 * PinSetupTile — full-card widget rendered in the Pre-Market section
 * that surfaces the /api/pin-setup-status classification.
 *
 * Features:
 *   - Status badge (ARMED / WATCH / NOT_TRIGGERED) with semantic color
 *   - Magnet strike + net γ + spot + signed distance
 *   - Bias label with one-sentence mechanism explanation
 *   - Recommended trade-type chips (max 3 shown)
 *   - Inline SVG sparkline of gamma_dir trajectory
 *   - Date picker (live ⇄ historical) + Reset-to-Live
 *   - Historical outcome row when present
 *   - Stale indicator when snapshot is > 30 min old during market
 */

import { memo, useMemo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { getETDateStr } from '../../utils/timezone';
import {
  usePinSetupStatus,
  type PinSetupStatus,
} from '../../hooks/usePinSetupStatus';
import Sparkline from './Sparkline';
import {
  formatEvaluatedAt,
  formatGammaM,
  formatSignedFixed,
} from './formatters';

const STALE_MINUTES_THRESHOLD = 30;

const STATE_COLOR: Record<PinSetupStatus['state'], string> = {
  ARMED: theme.green,
  WATCH: theme.caution,
  NOT_TRIGGERED: theme.textMuted,
};

const BIAS_LABEL: Record<PinSetupStatus['bias'], string> = {
  'fade-rips': 'FADE RIPS',
  'fade-dips': 'FADE DIPS',
  'full-pin': 'FULL PIN',
  'no-signal': 'NO SIGNAL',
};

const BIAS_EXPLANATION: Record<PinSetupStatus['bias'], string> = {
  'fade-rips':
    'Dealer +γ caps pushes above the magnet — sell call premium / fade the rip.',
  'fade-dips':
    'Dealer +γ catches dips at the magnet — sell put premium / fade the dip.',
  'full-pin':
    'Spot is locked at the magnet. Iron condors and BWBs centered here are the +EV trade.',
  'no-signal': 'No structural wall today — directional plays have room to run.',
};

interface Props {
  readonly marketOpen: boolean;
}

export default memo(function PinSetupTile({ marketOpen }: Props) {
  const { data, loading, error, date, setDate, refresh } = usePinSetupStatus({
    marketOpen,
  });

  // Today (ET) — used to (a) seed the picker so it never reads "blank"
  // and (b) clamp `max` so future dates can't be picked.
  const today = useMemo(() => getETDateStr(new Date()), []);
  const stateColor = data ? STATE_COLOR[data.state] : theme.textMuted;

  const isStale = useMemo(() => {
    if (!marketOpen || data?.mode !== 'live') return false;
    return (data.staleMinutes ?? 0) > STALE_MINUTES_THRESHOLD;
  }, [data, marketOpen]);

  return (
    <div>
      {/* Header: title + state badge */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase">
            0DTE Pin Setup
          </h3>
          <div className="text-muted font-sans text-[10px]">
            Dealer +γ classifier ·{' '}
            {data?.mode === 'historical' ? 'historical' : 'live'}
          </div>
        </div>
        {data && (
          <span
            className="rounded-full px-2 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] whitespace-nowrap uppercase"
            style={{
              backgroundColor: tint(stateColor, '20'),
              color: stateColor,
            }}
            data-testid="pin-setup-state-badge"
          >
            {data.state.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Loading / error states */}
      {loading && !data && (
        <div className="text-tertiary py-2 font-sans text-[11px] italic">
          Loading…
        </div>
      )}
      {error && !data && (
        <div
          className="font-sans text-[11px]"
          style={{ color: theme.red }}
          role="alert"
        >
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Magnet line */}
          <div className="mb-1.5 flex items-baseline gap-2">
            <span
              className="font-mono text-[20px] leading-none font-extrabold"
              style={{ color: stateColor }}
            >
              {data.conditions.magnetStrike ?? '—'}
            </span>
            <span className="text-secondary font-sans text-[11px]">magnet</span>
            {isStale && (
              <span
                className="rounded px-1.5 py-0.5 font-sans text-[9px] font-bold tracking-wider uppercase"
                style={{
                  backgroundColor: tint(theme.caution, '20'),
                  color: theme.caution,
                }}
              >
                stale {data.staleMinutes}m
              </span>
            )}
          </div>

          {/* Detail line: γ · spot · distance — combined into a single
              text run so screen readers + tests see one logical sentence. */}
          <div
            className="text-secondary mb-2 font-sans text-[11px]"
            data-testid="pin-setup-detail"
          >
            {[
              data.conditions.netGammaAtMagnetM > 0
                ? `${formatGammaM(data.conditions.netGammaAtMagnetM)} γ`
                : '— γ',
              data.spot != null ? `spot ${data.spot.toFixed(1)}` : null,
              data.conditions.distanceToMagnet != null
                ? `${formatSignedFixed(data.conditions.distanceToMagnet)} from magnet`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>

          {/* Bias line */}
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-sans text-[10px] font-bold tracking-[0.06em] uppercase"
              style={{
                backgroundColor: tint(stateColor, '18'),
                color: stateColor,
              }}
            >
              {BIAS_LABEL[data.bias]}
            </span>
          </div>
          <div className="text-secondary mb-2 font-sans text-[11px] leading-snug">
            {BIAS_EXPLANATION[data.bias]}
          </div>

          {/* Recommended trade-type chips */}
          {data.recommendedTradeTypes.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {data.recommendedTradeTypes.slice(0, 3).map((tt) => (
                <span
                  key={tt}
                  className="rounded font-mono text-[10px]"
                  style={{
                    backgroundColor: theme.chipBg,
                    color: theme.textSecondary,
                    padding: '2px 6px',
                  }}
                >
                  {tt.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          )}

          {/* Sparkline */}
          <Sparkline points={data.trajectory} color={stateColor} />

          {/* Historical outcome */}
          {data.mode === 'historical' && data.outcome && (
            <div
              className="mt-2 rounded px-2 py-1.5 font-sans text-[11px]"
              style={{ backgroundColor: theme.surfaceAlt }}
            >
              <span className="text-tertiary font-bold tracking-wider uppercase">
                settled
              </span>{' '}
              <span className="text-secondary font-mono">
                {data.outcome.settle.toFixed(2)}
              </span>
              <span className="text-muted"> · </span>
              <span
                className="font-mono"
                style={{
                  color:
                    Math.abs(data.outcome.settleVsMagnet) <= 5
                      ? theme.green
                      : theme.red,
                }}
              >
                {formatSignedFixed(data.outcome.settleVsMagnet, 2)} from magnet
              </span>
            </div>
          )}

          {/* Footer: date picker + reset + evaluated-at */}
          <div
            className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2"
            style={{ borderColor: theme.border }}
          >
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="pin-setup-date"
                className="text-tertiary font-sans text-[10px] font-bold tracking-wider uppercase"
              >
                Date
              </label>
              <input
                id="pin-setup-date"
                type="date"
                // Default-display today so the picker never reads as
                // empty / "mm/dd/yyyy" — `date` stays null in live mode.
                value={date ?? today}
                max={today}
                onChange={(e) => {
                  const v = e.target.value;
                  // Empty (user cleared) OR today's date both mean
                  // "go live" — only past dates flip into historical
                  // mode. Without this, picking today would issue a
                  // historical-mode request to the server.
                  setDate(!v || v === today ? null : v);
                }}
                className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
                style={{
                  backgroundColor: theme.inputBg,
                  color: theme.text,
                  borderColor: theme.border,
                }}
              />
              {date && (
                <button
                  type="button"
                  onClick={() => setDate(null)}
                  className="rounded border px-1.5 py-0.5 font-sans text-[10px] font-bold tracking-wider uppercase"
                  style={{
                    backgroundColor: 'transparent',
                    color: theme.accent,
                    borderColor: theme.border,
                  }}
                >
                  Live
                </button>
              )}
            </div>
            <div className="text-muted font-sans text-[10px]">
              <button
                type="button"
                onClick={refresh}
                className="hover:underline"
                aria-label="Refresh pin setup data"
              >
                ↻
              </button>{' '}
              {formatEvaluatedAt(data.evaluatedAt)} CT
            </div>
          </div>
        </>
      )}
    </div>
  );
});
