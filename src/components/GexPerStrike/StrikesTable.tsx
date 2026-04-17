/**
 * Price-ladder table rendering one row per visible strike.
 *
 * Layout: strike labels (left column), divergent bar chart (center),
 * charm/vanna/dex readouts (right column). The center axis is the
 * zero line; positive gamma bars grow right, negative grow left.
 * A spot line is drawn as a horizontal rule interpolated between the
 * two surrounding rows.
 *
 * All the percentage-based math for bar widths uses MAX_BAR_PCT as
 * the per-side ceiling (i.e. max bar width = MAX_BAR_PCT% of the chart
 * width), so overlays (charm/vanna/dex) are scaled down from that.
 */

import { theme } from '../../themes';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import {
  CHARM_POS,
  CHARM_NEG,
  VANNA_POS,
  VANNA_NEG,
  DEX_POS,
  DEX_NEG,
} from './colors';
import { formatNum } from './formatters';
import { getNetCharm, getNetGamma, getNetVanna, type ViewMode } from './mode';

const BAR_HEIGHT = 36;
const MAX_BAR_PCT = 45;

interface Props {
  filtered: GexStrikeLevel[];
  price: number;
  viewMode: ViewMode;
  showCharm: boolean;
  showVanna: boolean;
  showDex: boolean;
  maxGex: number;
  maxCharm: number;
  maxVanna: number;
  maxDelta: number;
  hovered: number | null;
  onHoverEnter: (idx: number, x: number, y: number) => void;
  onHoverMove: (x: number, y: number) => void;
  onHoverLeave: () => void;
  onFocusRow: (idx: number, x: number, y: number) => void;
  onBlurRow: () => void;
}

/**
 * Pixel offset for the spot price line within the chart area.
 * Returns null when spot falls outside the visible strike window.
 * Assumes `filtered` is descending (high strike → low strike).
 */
function computeSpotY(
  filtered: GexStrikeLevel[],
  price: number,
): number | null {
  if (filtered.length === 0) return null;
  const highest = filtered[0]!.strike;
  const lowest = filtered[filtered.length - 1]!.strike;
  if (price > highest || price < lowest) return null;

  const spotIdx = filtered.findIndex((d) => d.strike <= price);
  if (spotIdx < 0) return null;
  if (spotIdx === 0) return 0;

  const above = filtered[spotIdx - 1]!;
  const below = filtered[spotIdx]!;
  const frac = (above.strike - price) / (above.strike - below.strike);
  return (spotIdx - 1) * BAR_HEIGHT + BAR_HEIGHT * frac;
}

export function StrikesTable({
  filtered,
  price,
  viewMode,
  showCharm,
  showVanna,
  showDex,
  maxGex,
  maxCharm,
  maxVanna,
  maxDelta,
  hovered,
  onHoverEnter,
  onHoverMove,
  onHoverLeave,
  onFocusRow,
  onBlurRow,
}: Readonly<Props>) {
  const spotY = computeSpotY(filtered, price);

  return (
    <div
      className="flex overflow-x-auto"
      aria-label="0DTE gamma exposure per strike"
      role="img"
    >
      {/* Strike labels */}
      <div className="w-[56px] shrink-0">
        {filtered.map((d) => (
          <div
            key={d.strike}
            className="flex items-center justify-end pr-2 font-mono text-[11px]"
            style={{
              height: BAR_HEIGHT,
              fontWeight: Math.abs(d.strike - price) < 2.5 ? 700 : 400,
              color:
                Math.abs(d.strike - price) < 2.5
                  ? theme.accent
                  : Math.abs(d.strike - price) <= 10
                    ? theme.textSecondary
                    : theme.textMuted,
            }}
          >
            {d.strike}
          </div>
        ))}
      </div>

      {/* Bar chart */}
      <div className="relative min-w-0 flex-1">
        <div
          className="absolute top-0 bottom-0 left-1/2 w-px"
          style={{ background: 'rgba(255,255,255,0.06)' }}
        />

        {spotY != null && (
          <div
            className="absolute right-0 left-0 z-[2] h-px"
            style={{
              top: spotY,
              background: theme.accent,
              opacity: 0.5,
              boxShadow: `0 0 6px ${theme.accent}44`,
            }}
          />
        )}

        {filtered.map((d, i) => {
          const net = getNetGamma(d, viewMode);
          const charmView = getNetCharm(d, viewMode);
          const vannaView = getNetVanna(d, viewMode);
          const gexPct = net / maxGex;
          const charmPct = charmView / maxCharm;
          const vannaPct = vannaView / maxVanna;
          const deltaPct = d.netDelta / maxDelta;
          const isHov = hovered === i;

          return (
            <div
              key={d.strike}
              role="row"
              tabIndex={0}
              aria-label={`Strike ${d.strike} row`}
              className="relative flex cursor-crosshair items-center transition-colors duration-150"
              style={{
                height: BAR_HEIGHT,
                background: isHov ? 'rgba(255,255,255,0.02)' : 'transparent',
              }}
              onMouseEnter={(e) => onHoverEnter(i, e.clientX, e.clientY)}
              onMouseMove={(e) => onHoverMove(e.clientX, e.clientY)}
              onMouseLeave={onHoverLeave}
              onFocus={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onFocusRow(i, rect.right, rect.top);
              }}
              onBlur={onBlurRow}
            >
              {/* GEX bar */}
              <div
                className="absolute h-4 transition-all duration-200"
                style={{
                  left:
                    gexPct >= 0
                      ? '50%'
                      : `calc(50% + ${gexPct * MAX_BAR_PCT}%)`,
                  width: `${Math.abs(gexPct) * MAX_BAR_PCT}%`,
                  background:
                    net >= 0
                      ? `linear-gradient(90deg, transparent, ${isHov ? 'rgba(var(--success-rgb,0,230,118),0.8)' : 'rgba(var(--success-rgb,0,230,118),0.53)'})`
                      : `linear-gradient(270deg, transparent, ${isHov ? 'rgba(var(--danger-rgb,255,23,68),0.8)' : 'rgba(var(--danger-rgb,255,23,68),0.53)'})`,
                  borderRadius: net >= 0 ? '0 3px 3px 0' : '3px 0 0 3px',
                  boxShadow: isHov
                    ? `0 0 12px ${net >= 0 ? 'rgba(var(--success-rgb,0,230,118),0.2)' : 'rgba(var(--danger-rgb,255,23,68),0.2)'}`
                    : 'none',
                }}
              />

              {/* Charm overlay bar */}
              {showCharm && (
                <div
                  className="absolute h-[3px] rounded-sm transition-opacity duration-200"
                  style={{
                    bottom: 4,
                    left:
                      charmPct >= 0
                        ? '50%'
                        : `calc(50% + ${charmPct * MAX_BAR_PCT * 0.6}%)`,
                    width: `${Math.abs(charmPct) * MAX_BAR_PCT * 0.6}%`,
                    background: charmView >= 0 ? CHARM_POS : CHARM_NEG,
                    opacity: isHov ? 0.9 : 0.5,
                  }}
                />
              )}

              {/* Vanna dot */}
              {showVanna && (
                <div
                  className="absolute rounded-full transition-opacity duration-200"
                  style={{
                    top: 4,
                    left: `calc(50% + ${vannaPct * MAX_BAR_PCT * 0.5}%)`,
                    width: Math.max(4, Math.abs(vannaPct) * 10),
                    height: Math.max(4, Math.abs(vannaPct) * 10),
                    background:
                      vannaView >= 0 ? `${VANNA_POS}22` : `${VANNA_NEG}22`,
                    border: `1px solid ${vannaView >= 0 ? VANNA_POS : VANNA_NEG}`,
                    opacity: isHov ? 0.9 : 0.4,
                    transform: 'translate(-50%, 0)',
                  }}
                />
              )}

              {/* DEX diamond */}
              {showDex && (
                <div
                  className="absolute transition-opacity duration-200"
                  style={{
                    top: BAR_HEIGHT / 2 - 4,
                    left: `calc(50% + ${deltaPct * MAX_BAR_PCT * 0.5}%)`,
                    width: 7,
                    height: 7,
                    transform: 'translate(-50%, 0) rotate(45deg)',
                    background:
                      d.netDelta >= 0 ? `${DEX_POS}33` : `${DEX_NEG}33`,
                    border: `1px solid ${d.netDelta >= 0 ? DEX_POS : DEX_NEG}`,
                    opacity: isHov ? 0.9 : 0.4,
                  }}
                />
              )}

              {/* Hover value label */}
              {isHov && (
                <div
                  className="absolute text-[10px] font-semibold"
                  style={{
                    ...(net >= 0
                      ? {
                          left: `calc(50% + ${Math.abs(gexPct) * MAX_BAR_PCT}% + 6px)`,
                        }
                      : { right: 8 }),
                    color: net >= 0 ? theme.green : theme.red,
                  }}
                >
                  {formatNum(net)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right panel: charm/vanna/dex values */}
      <div
        className="w-[140px] shrink-0 border-l pl-2"
        style={{ borderColor: 'rgba(255,255,255,0.04)' }}
      >
        {filtered.map((d, i) => {
          const isHov = hovered === i;
          const charmView = getNetCharm(d, viewMode);
          const vannaView = getNetVanna(d, viewMode);
          return (
            <div
              key={d.strike}
              className="flex items-center gap-1.5 font-mono text-[10px] transition-opacity duration-150"
              style={{
                height: BAR_HEIGHT,
                opacity: isHov ? 1 : 0.4,
              }}
            >
              {showCharm && (
                <span
                  className="w-[56px] font-semibold"
                  style={{
                    color: charmView > 0 ? CHARM_POS : CHARM_NEG,
                  }}
                >
                  {charmView > 0 ? '▲' : '▼'} {formatNum(Math.abs(charmView))}
                </span>
              )}
              {showVanna && (
                <span
                  className="w-[46px] font-semibold"
                  style={{
                    color: vannaView > 0 ? VANNA_POS : VANNA_NEG,
                  }}
                >
                  {vannaView > 0 ? '▲' : '▼'} {formatNum(Math.abs(vannaView))}
                </span>
              )}
              {showDex && (
                <span
                  className="w-[46px] font-semibold"
                  style={{
                    color: d.netDelta > 0 ? DEX_POS : DEX_NEG,
                  }}
                >
                  {d.netDelta > 0 ? '▲' : '▼'} {formatNum(Math.abs(d.netDelta))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
