import { memo, useState } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { SettlementResult } from './types';

interface Props {
  r: SettlementResult;
  remainingHigh: number;
  remainingLow: number;
}

export default memo(function DeltaRow({
  r,
  remainingHigh,
  remainingLow,
}: Props) {
  const [showTooltip, setShowTooltip] = useState(false);

  const width = r.callStrike - r.putStrike;
  const closerSide =
    Math.abs(r.callCushion) < Math.abs(r.putCushion) ? 'call' : 'put';
  const closerCushion = closerSide === 'call' ? r.callCushion : r.putCushion;
  const minCushion = Math.min(Math.abs(r.callCushion), Math.abs(r.putCushion));

  // Bar positions as percentages within the strike range
  const lowPct = Math.max(
    0,
    Math.min(100, ((remainingLow - r.putStrike) / width) * 100),
  );
  const highPct = Math.max(
    0,
    Math.min(100, ((remainingHigh - r.putStrike) / width) * 100),
  );
  const barLeft = lowPct;
  const barWidth = Math.max(1, highPct - lowPct);

  // Tightness thresholds for survived rows
  const TIGHT_PTS = 25; // < 25 pts cushion = close call
  const WARN_PTS = 50; // < 50 pts = caution

  // Color logic
  let rowColor: string;
  let barColor: string;
  if (r.survived) {
    if (minCushion < TIGHT_PTS) {
      rowColor = '#D97706';
      barColor = '#D97706';
    } else if (minCushion < WARN_PTS) {
      rowColor = theme.caution;
      barColor = theme.caution;
    } else {
      rowColor = theme.green;
      barColor = theme.green;
    }
  } else if (r.settledSafe) {
    rowColor = theme.caution;
    barColor = theme.caution;
  } else {
    rowColor = theme.red;
    barColor = theme.red;
  }

  // Tightness label for survived rows
  let tightnessLabel = '';
  if (r.survived) {
    if (minCushion < TIGHT_PTS) tightnessLabel = 'CLOSE CALL';
    else if (minCushion < WARN_PTS) tightnessLabel = 'TIGHT';
  }

  return (
    <div className="bg-surface border-edge overflow-hidden rounded-lg border">
      <div className="flex items-center gap-3 p-2.5 pb-1">
        {/* Delta label */}
        <div className="w-[44px] shrink-0">
          <span
            className="font-mono text-[14px] font-bold"
            style={{ color: rowColor }}
          >
            {r.delta}
            {'\u0394'}
          </span>
        </div>

        {/* Verdict text */}
        <div className="min-w-0 flex-1">
          {r.survived ? (
            <span className="font-sans text-[11px]" style={{ color: rowColor }}>
              Safe by {Math.abs(closerCushion).toFixed(0)} pts
              <span className="text-muted ml-1 text-[10px]">
                (nearest: {closerSide} side)
              </span>
              {tightnessLabel && (
                <span
                  className="ml-1.5 rounded-sm px-1 py-0.5 font-sans text-[8px] font-bold tracking-wider"
                  style={{
                    backgroundColor: tint(rowColor, '18'),
                    color: rowColor,
                  }}
                >
                  {tightnessLabel}
                </span>
              )}
            </span>
          ) : r.settledSafe ? (
            <span
              className="font-sans text-[11px]"
              style={{ color: theme.caution }}
            >
              Breached intraday, settled safe{' '}
              <span
                className="font-sans text-[10px] font-bold"
                style={{ color: theme.green }}
              >
                {' \u2014 max profit'}
              </span>
            </span>
          ) : (
            <span
              className="font-sans text-[11px]"
              style={{ color: theme.red }}
            >
              {r.callBreached && r.putBreached
                ? `Both sides breached \u2014 settled at ${r.settlement.toFixed(0)}`
                : r.callBreached
                  ? `Call breached by ${Math.abs(r.callCushion).toFixed(0)} pts \u2014 settled at ${r.settlement.toFixed(0)}`
                  : `Put breached by ${Math.abs(r.putCushion).toFixed(0)} pts \u2014 settled at ${r.settlement.toFixed(0)}`}
            </span>
          )}
        </div>
      </div>

      {/* Closest approach detail — always shown */}
      <div className="flex gap-4 px-2.5 pb-1.5 font-sans text-[10px]">
        <span className="text-muted">
          Put: SPX low {remainingLow.toFixed(0)}, strike{' '}
          {r.putStrike.toFixed(0)}
          {' \u2192 '}
          <span
            style={{
              color: r.putBreached
                ? theme.red
                : Math.abs(r.putCushion) < TIGHT_PTS
                  ? '#D97706'
                  : theme.textMuted,
            }}
          >
            {r.putCushion >= 0
              ? `${Math.abs(r.putCushion).toFixed(0)} pts cushion`
              : `breached by ${Math.abs(r.putCushion).toFixed(0)}`}
          </span>
        </span>
        <span className="text-muted">
          Call: SPX high {remainingHigh.toFixed(0)}, strike{' '}
          {r.callStrike.toFixed(0)}
          {' \u2192 '}
          <span
            style={{
              color: r.callBreached
                ? theme.red
                : Math.abs(r.callCushion) < TIGHT_PTS
                  ? '#D97706'
                  : theme.textMuted,
            }}
          >
            {r.callCushion >= 0
              ? `${Math.abs(r.callCushion).toFixed(0)} pts cushion`
              : `breached by ${Math.abs(r.callCushion).toFixed(0)}`}
          </span>
        </span>
      </div>

      {/* Visual bar */}
      <div className="px-2.5 pb-2.5">
        <div className="relative">
          {/* Strike labels */}
          <div className="mb-0.5 flex justify-between font-mono text-[8px]">
            <span style={{ color: tint(theme.red, 'AA') }}>
              {r.putStrike.toFixed(0)}
            </span>
            <span style={{ color: tint(theme.green, 'AA') }}>
              {r.callStrike.toFixed(0)}
            </span>
          </div>

          {/* Track */}
          <div
            className="relative h-[6px] w-full overflow-visible rounded-full"
            style={{ backgroundColor: theme.surfaceAlt }}
          >
            {/* Actual price range — with tooltip on hover */}
            <button
              type="button"
              aria-label={`${r.delta} delta price range: low ${remainingLow.toFixed(0)}, high ${remainingHigh.toFixed(0)}`}
              className="absolute top-0 h-full cursor-pointer rounded-full"
              style={{
                left: `${barLeft}%`,
                width: `${barWidth}%`,
                backgroundColor: tint(barColor, '50'),
                border: `1px solid ${tint(barColor, '80')}`,
                padding: 0,
              }}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
              onFocus={() => setShowTooltip(true)}
              onBlur={() => setShowTooltip(false)}
            >
              {showTooltip && (
                <div
                  className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 rounded-md px-2.5 py-1.5 font-mono text-[10px] leading-snug whitespace-nowrap shadow-lg"
                  style={{
                    backgroundColor: '#1a1a2e',
                    color: '#e0e0e0',
                    border: '1px solid #444',
                  }}
                >
                  <div>
                    Low: <strong>{remainingLow.toFixed(2)}</strong>
                  </div>
                  <div>
                    High: <strong>{remainingHigh.toFixed(2)}</strong>
                  </div>
                  <div>
                    Range:{' '}
                    <strong>{(remainingHigh - remainingLow).toFixed(2)}</strong>{' '}
                    pts
                  </div>
                </div>
              )}
            </button>

            {/* Breach overflow indicators */}
            {r.putBreached && (
              <div
                className="absolute top-0 left-0 h-full rounded-l-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingLow - r.putStrike) / width) * 100)}%`,
                  backgroundColor: tint(rowColor, '40'),
                  borderLeft: `2px solid ${rowColor}`,
                }}
              />
            )}
            {r.callBreached && (
              <div
                className="absolute top-0 right-0 h-full rounded-r-full"
                style={{
                  width: `${Math.min(20, Math.abs((remainingHigh - r.callStrike) / width) * 100)}%`,
                  backgroundColor: tint(rowColor, '40'),
                  borderRight: `2px solid ${rowColor}`,
                }}
              />
            )}
          </div>

          {/* Cushion labels below the bar */}
          <div className="mt-0.5 flex justify-between font-mono text-[8px]">
            <span style={{ color: r.putBreached ? rowColor : theme.textMuted }}>
              {r.putCushion > 0 ? '\u2212' : '+'}
              {Math.abs(r.putCushion).toFixed(0)}
            </span>
            <span
              style={{ color: r.callBreached ? rowColor : theme.textMuted }}
            >
              {r.callCushion >= 0 ? '+' : '\u2212'}
              {Math.abs(r.callCushion).toFixed(0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
