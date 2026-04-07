/**
 * GexPerStrike — 0DTE gamma exposure per strike with center-diverging bars,
 * charm/vanna overlays, hover tooltips, spot price line, and summary cards.
 *
 * Visual design: strikes listed vertically with horizontal bars extending
 * left (negative gamma, red) or right (positive gamma, green) from a center
 * axis. Charm and vanna are toggle-able overlays shown as thin bars and dots.
 * Hovering a row reveals a rich tooltip with full greek breakdown.
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { theme } from '../themes';
import { SectionBox } from './ui';
import type { GexStrikeLevel } from '../hooks/useGexPerStrike';

// ── Constants ────────────────────────────────────────────

const DEFAULT_VISIBLE = 15;
const MIN_VISIBLE = 5;
const MAX_VISIBLE = 50;
const STEP = 5;
const BAR_HEIGHT = 36;
const MAX_BAR_PCT = 45; // max bar width as % of chart area

type ViewMode = 'oi' | 'directional';

// Overlay colors that complement the dark theme
const CHARM_POS = '#ffd740';
const CHARM_NEG = '#ff6e40';
const VANNA_POS = '#40c4ff';
const VANNA_NEG = '#e040fb';
const DEX_POS = '#69f0ae';
const DEX_NEG = '#ff8a80';

interface Props {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  onRefresh: () => void;
}

// ── Formatters ───────────────────────────────────────────

function formatNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return '';
  }
}

function getNetGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.netGamma;
  return s.callGammaAsk + s.callGammaBid + s.putGammaAsk + s.putGammaBid;
}

// ── Tooltip ──────────────────────────────────────────────

function GexTooltip({
  data,
  viewMode,
  x,
  y,
}: Readonly<{
  data: GexStrikeLevel;
  viewMode: ViewMode;
  x: number;
  y: number;
}>) {
  const netGex = getNetGamma(data, viewMode);
  const charmEffect = data.netCharm > 0 ? 'Strengthening' : 'Weakening';
  const vannaDir =
    data.netVanna > 0
      ? 'Sell pressure if IV drops'
      : 'Buy pressure if IV drops';
  const volLabel =
    data.volReinforcement === 'reinforcing'
      ? 'Reinforcing'
      : data.volReinforcement === 'opposing'
        ? 'Opposing'
        : '—';

  return (
    <div
      className="pointer-events-none fixed z-50 min-w-[260px] rounded-md border border-[rgba(255,255,255,0.08)] p-3 font-mono text-[11px] shadow-xl backdrop-blur-xl"
      style={{
        left: x + 16,
        top: y - 120,
        backgroundColor: 'rgba(10,10,18,0.96)',
        color: theme.textSecondary,
      }}
    >
      <div
        className="mb-2 border-b border-[rgba(255,255,255,0.06)] pb-1.5 text-[13px] font-bold"
        style={{ color: theme.text }}
      >
        Strike {data.strike}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1">
        {/* Header row */}
        <span />
        <span className="text-[9px]" style={{ color: theme.textMuted }}>
          Net
        </span>
        <span className="text-[9px]" style={{ color: theme.textMuted }}>
          C / P
        </span>

        {/* GEX */}
        <span>GEX</span>
        <span
          className="font-semibold"
          style={{ color: netGex >= 0 ? theme.green : theme.red }}
        >
          {formatNum(netGex)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: theme.green }}>
            {formatNum(data.callGammaOi)}
          </span>
          {' / '}
          <span style={{ color: theme.red }}>{formatNum(data.putGammaOi)}</span>
        </span>

        {/* Charm */}
        <span>Charm</span>
        <span
          className="font-semibold"
          style={{
            color: data.netCharm >= 0 ? CHARM_POS : CHARM_NEG,
          }}
        >
          {formatNum(data.netCharm)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: CHARM_POS }}>
            {formatNum(data.callCharmOi)}
          </span>
          {' / '}
          <span style={{ color: CHARM_NEG }}>{formatNum(data.putCharmOi)}</span>
        </span>

        {/* DEX */}
        <span>DEX</span>
        <span
          className="font-semibold"
          style={{ color: data.netDelta >= 0 ? DEX_POS : DEX_NEG }}
        >
          {formatNum(data.netDelta)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: DEX_POS }}>{formatNum(data.callDeltaOi)}</span>
          {' / '}
          <span style={{ color: DEX_NEG }}>{formatNum(data.putDeltaOi)}</span>
        </span>

        {/* Vanna */}
        <span>Vanna</span>
        <span
          className="font-semibold"
          style={{
            color: data.netVanna >= 0 ? VANNA_POS : VANNA_NEG,
          }}
        >
          {formatNum(data.netVanna)}
        </span>
        <span className="text-[10px]">
          <span style={{ color: VANNA_POS }}>
            {formatNum(data.callVannaOi)}
          </span>
          {' / '}
          <span style={{ color: VANNA_NEG }}>{formatNum(data.putVannaOi)}</span>
        </span>
      </div>

      {/* Analysis section */}
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-[rgba(255,255,255,0.06)] pt-2">
        <span>Charm Effect</span>
        <span
          style={{
            color: data.netCharm > 0 ? CHARM_POS : CHARM_NEG,
          }}
        >
          {charmEffect}
        </span>
        <span>Vanna Hedge</span>
        <span
          className="text-[10px]"
          style={{
            color: data.netVanna > 0 ? VANNA_POS : VANNA_NEG,
          }}
        >
          {vannaDir}
        </span>
        <span>Vol Flow</span>
        <span
          className="text-[10px]"
          style={{
            color:
              data.volReinforcement === 'reinforcing'
                ? theme.green
                : data.volReinforcement === 'opposing'
                  ? theme.red
                  : theme.textMuted,
          }}
        >
          {volLabel}
        </span>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────

export default memo(function GexPerStrike({
  strikes,
  loading,
  error,
  timestamp,
  onRefresh,
}: Props) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [viewMode, setViewMode] = useState<ViewMode>('oi');
  const [showCharm, setShowCharm] = useState(true);
  const [showVanna, setShowVanna] = useState(true);
  const [showDex, setShowDex] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const price = strikes.length > 0 ? strikes[0]!.price : 0;

  // Center around ATM
  const filtered = useMemo(() => {
    if (strikes.length === 0) return [];
    const atmIdx = strikes.findIndex((s) => s.strike >= price);
    const center = atmIdx >= 0 ? atmIdx : Math.floor(strikes.length / 2);
    const half = Math.floor(visibleCount / 2);
    const lo = Math.max(0, center - half);
    const hi = Math.min(strikes.length, lo + visibleCount);
    return strikes.slice(Math.max(0, hi - visibleCount), hi);
  }, [strikes, price, visibleCount]);

  // Compute scales
  const { maxGex, maxCharm, maxVanna, maxDelta } = useMemo(() => {
    if (filtered.length === 0)
      return { maxGex: 1, maxCharm: 1, maxVanna: 1, maxDelta: 1 };
    return {
      maxGex: Math.max(
        ...filtered.map((d) => Math.abs(getNetGamma(d, viewMode))),
        1,
      ),
      maxCharm: Math.max(...filtered.map((d) => Math.abs(d.netCharm)), 1),
      maxDelta: Math.max(...filtered.map((d) => Math.abs(d.netDelta)), 1),
      maxVanna: Math.max(...filtered.map((d) => Math.abs(d.netVanna)), 1),
    };
  }, [filtered, viewMode]);

  // Summary stats
  const summary = useMemo(() => {
    const totalGex = filtered.reduce((s, d) => s + getNetGamma(d, viewMode), 0);
    const totalCharm = filtered.reduce((s, d) => s + d.netCharm, 0);
    const totalVanna = filtered.reduce((s, d) => s + d.netVanna, 0);
    // GEX flip: first strike where sign changes
    let flipStrike = '—';
    for (let i = 1; i < filtered.length; i++) {
      const prev = getNetGamma(filtered[i - 1]!, viewMode);
      const curr = getNetGamma(filtered[i]!, viewMode);
      if (Math.sign(prev) !== Math.sign(curr) && prev !== 0) {
        flipStrike = String(filtered[i]!.strike);
        break;
      }
    }
    return { totalGex, totalCharm, totalVanna, flipStrike };
  }, [filtered, viewMode]);

  const handleLess = useCallback(
    () => setVisibleCount((v) => Math.max(v - STEP, MIN_VISIBLE)),
    [],
  );
  const handleMore = useCallback(
    () => setVisibleCount((v) => Math.min(v + STEP, MAX_VISIBLE)),
    [],
  );
  const toggleView = useCallback(
    () => setViewMode((v) => (v === 'oi' ? 'directional' : 'oi')),
    [],
  );

  const totalStrikes = strikes.length;
  const badge =
    totalStrikes > 0 ? `${filtered.length} of ${totalStrikes}` : null;

  const headerRight = (
    <div className="flex items-center gap-2">
      {timestamp && (
        <span className="text-muted font-sans text-[10px]">
          {formatTime(timestamp)}
        </span>
      )}
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh GEX data"
        className="text-accent hover:text-primary disabled:text-muted cursor-pointer font-sans text-[10px] font-semibold transition-colors disabled:cursor-default"
      >
        &#x21bb;
      </button>
      <div className="border-edge flex items-center gap-0.5 rounded border">
        <button
          onClick={handleLess}
          disabled={visibleCount <= MIN_VISIBLE}
          aria-label="Show fewer strikes"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          &minus;
        </button>
        <span className="text-secondary min-w-[20px] text-center font-mono text-[10px]">
          {visibleCount}
        </span>
        <button
          onClick={handleMore}
          disabled={visibleCount >= MAX_VISIBLE || visibleCount >= totalStrikes}
          aria-label="Show more strikes"
          className="text-secondary hover:text-primary disabled:text-muted cursor-pointer px-1.5 py-0.5 font-mono text-xs font-bold disabled:cursor-default"
        >
          +
        </button>
      </div>
    </div>
  );

  // ── Loading / Error / Empty ────────────────────────────

  if (loading) {
    return (
      <SectionBox
        label="0DTE GEX Per Strike"
        collapsible
        headerRight={headerRight}
      >
        <div className="text-muted animate-pulse text-center font-sans text-xs">
          Loading GEX data...
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox
        label="0DTE GEX Per Strike"
        collapsible
        headerRight={headerRight}
      >
        <div className="text-muted text-center font-sans text-xs">{error}</div>
      </SectionBox>
    );
  }

  if (filtered.length === 0) {
    return (
      <SectionBox
        label="0DTE GEX Per Strike"
        badge={badge}
        collapsible
        headerRight={headerRight}
      >
        <div className="border-edge-strong bg-surface rounded-[14px] border-2 border-dashed px-8 py-8 text-center">
          <div className="text-muted mb-1 text-[20px]">{'\u2014'}</div>
          <p className="text-secondary m-0 font-sans text-[13px]">
            No 0DTE GEX data available for this session.
          </p>
          <p className="text-muted m-0 mt-1 font-sans text-[11px]">
            Data appears after the first cron fetch of the day.
          </p>
        </div>
      </SectionBox>
    );
  }

  // ── Spot line position ─────────────────────────────────

  const spotIdx = filtered.findIndex((d) => d.strike >= price);
  const spotY = (() => {
    if (spotIdx < 0) return null;
    if (spotIdx > 0) {
      const prev = filtered[spotIdx - 1]!;
      const curr = filtered[spotIdx]!;
      const frac = (price - prev.strike) / (curr.strike - prev.strike);
      return (spotIdx - 1) * BAR_HEIGHT + BAR_HEIGHT * frac;
    }
    return spotIdx * BAR_HEIGHT;
  })();

  return (
    <SectionBox
      label="0DTE GEX Per Strike"
      badge={badge}
      collapsible
      headerRight={headerRight}
    >
      {/* Controls: overlays + OI/Dir */}
      <div className="text-muted mb-2 flex items-center gap-3 font-mono text-[10px]">
        <span className="text-[9px] tracking-wider uppercase">Overlays</span>
        {(
          [
            {
              key: 'charm',
              label: 'CHARM',
              color: CHARM_POS,
              active: showCharm,
              toggle: () => setShowCharm((v) => !v),
            },
            {
              key: 'vanna',
              label: 'VANNA',
              color: VANNA_POS,
              active: showVanna,
              toggle: () => setShowVanna((v) => !v),
            },
            {
              key: 'dex',
              label: 'DEX',
              color: DEX_POS,
              active: showDex,
              toggle: () => setShowDex((v) => !v),
            },
          ] as const
        ).map((o) => (
          <button
            key={o.key}
            onClick={o.toggle}
            className="cursor-pointer rounded px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide transition-all"
            style={{
              background: o.active ? `${o.color}15` : 'transparent',
              border: `1px solid ${o.active ? o.color + '40' : 'rgba(255,255,255,0.06)'}`,
              color: o.active ? o.color : theme.textMuted,
            }}
          >
            {o.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {(['oi', 'directional'] as const).map((m) => (
            <button
              key={m}
              onClick={toggleView}
              className="cursor-pointer rounded px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide"
              style={{
                background:
                  viewMode === m ? 'rgba(255,255,255,0.06)' : 'transparent',
                border: `1px solid ${viewMode === m ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'}`,
                color: viewMode === m ? theme.text : theme.textMuted,
              }}
            >
              {m === 'oi' ? 'OI' : 'VOL'}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="text-muted mb-2 flex items-center gap-5 font-mono text-[10px]">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: theme.green }}
          />
          +Gamma
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: theme.red }}
          />
          -Gamma
        </span>
        {showCharm && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-[3px] w-2 rounded-sm"
              style={{ background: CHARM_POS }}
            />
            Charm
          </span>
        )}
        {showVanna && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full border"
              style={{
                background: `${VANNA_POS}22`,
                borderColor: VANNA_POS,
              }}
            />
            Vanna
          </span>
        )}
        {showDex && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rotate-45 border"
              style={{
                background: `${DEX_POS}22`,
                borderColor: DEX_POS,
              }}
            />
            DEX
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-px"
            style={{ background: theme.accent }}
          />
          SPOT
        </span>
      </div>

      {/* Chart area */}
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
          {/* Center axis */}
          <div
            className="absolute top-0 bottom-0 left-1/2 w-px"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          />

          {/* Spot price line */}
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

          {/* Rows */}
          {filtered.map((d, i) => {
            const net = getNetGamma(d, viewMode);
            const gexPct = net / maxGex;
            const charmPct = d.netCharm / maxCharm;
            const vannaPct = d.netVanna / maxVanna;
            const deltaPct = d.netDelta / maxDelta;
            const isHov = hovered === i;

            return (
              <div
                key={d.strike}
                className="relative flex cursor-crosshair items-center transition-colors duration-150"
                style={{
                  height: BAR_HEIGHT,
                  background: isHov ? 'rgba(255,255,255,0.02)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  setHovered(i);
                  setMousePos({ x: e.clientX, y: e.clientY });
                }}
                onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHovered(null)}
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
                      background: d.netCharm >= 0 ? CHARM_POS : CHARM_NEG,
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
                        d.netVanna >= 0 ? `${VANNA_POS}22` : `${VANNA_NEG}22`,
                      border: `1px solid ${d.netVanna >= 0 ? VANNA_POS : VANNA_NEG}`,
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
                      color: d.netCharm > 0 ? CHARM_POS : CHARM_NEG,
                    }}
                  >
                    {d.netCharm > 0 ? '▲' : '▼'}{' '}
                    {formatNum(Math.abs(d.netCharm))}
                  </span>
                )}
                {showVanna && (
                  <span
                    className="w-[46px] font-semibold"
                    style={{
                      color: d.netVanna > 0 ? VANNA_POS : VANNA_NEG,
                    }}
                  >
                    {d.netVanna > 0 ? '▲' : '▼'}{' '}
                    {formatNum(Math.abs(d.netVanna))}
                  </span>
                )}
                {showDex && (
                  <span
                    className="w-[46px] font-semibold"
                    style={{
                      color: d.netDelta > 0 ? DEX_POS : DEX_NEG,
                    }}
                  >
                    {d.netDelta > 0 ? '▲' : '▼'}{' '}
                    {formatNum(Math.abs(d.netDelta))}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom summary cards */}
      <div className="mt-3 grid grid-cols-4 gap-2 font-mono text-[10px]">
        {(
          [
            {
              label: 'TOTAL NET GEX',
              value: formatNum(summary.totalGex),
              color: summary.totalGex >= 0 ? theme.green : theme.red,
            },
            {
              label: 'NET CHARM',
              value: formatNum(summary.totalCharm),
              color: summary.totalCharm >= 0 ? CHARM_POS : CHARM_NEG,
            },
            {
              label: 'NET VANNA',
              value: formatNum(summary.totalVanna),
              color: summary.totalVanna >= 0 ? VANNA_POS : VANNA_NEG,
            },
            {
              label: 'GEX FLIP',
              value: summary.flipStrike,
              color: theme.text,
            },
          ] as const
        ).map((card) => (
          <div
            key={card.label}
            className="rounded-md border p-2.5"
            style={{
              background: 'rgba(255,255,255,0.02)',
              borderColor: 'rgba(255,255,255,0.04)',
            }}
          >
            <div
              className="mb-1 text-[9px] font-semibold tracking-wide"
              style={{ color: theme.textMuted }}
            >
              {card.label}
            </div>
            <div
              className="text-[14px] font-bold"
              style={{ color: card.color }}
            >
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* Tooltip */}
      {hovered !== null && filtered[hovered] && (
        <GexTooltip
          data={filtered[hovered]}
          viewMode={viewMode}
          x={mousePos.x}
          y={mousePos.y}
        />
      )}
    </SectionBox>
  );
});
