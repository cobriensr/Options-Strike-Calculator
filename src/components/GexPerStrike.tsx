/**
 * GexPerStrike — dashboard widget showing 0DTE gamma exposure by strike.
 *
 * Ranked by absolute GEX magnitude (largest impact first), like dark pool
 * levels ranked by premium. Each row shows:
 *   - Strike price (ATM marked with ◄)
 *   - Distance from current price (e.g., +5pts, -12pts)
 *   - GEX bar proportional to magnitude
 *   - Net GEX $ value (positive = green, negative = red)
 *   - Call vs Put gamma breakdown
 *
 * Sort toggles between "By GEX" (magnitude) and "By Strike" (ascending).
 * OI/Dir toggle switches between open-interest-based and directionalized view.
 * Visible count controls ±5 (default 15, range 5–50).
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { theme } from '../themes';
import { SectionBox } from './ui';
import type { GexStrikeLevel } from '../hooks/useGexPerStrike';

const DEFAULT_VISIBLE = 15;
const MIN_VISIBLE = 5;
const MAX_VISIBLE = 50;
const STEP = 5;

type ViewMode = 'oi' | 'directional';
type SortMode = 'gex' | 'strike';

interface Props {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  onRefresh: () => void;
}

function formatGex(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '+';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Compact format for call/put columns */
function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
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

/** Net gamma for the active view mode */
function getNetGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.netGamma;
  return s.callGammaAsk + s.callGammaBid + s.putGammaAsk + s.putGammaBid;
}

/** Call gamma for the active view mode */
function getCallGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.callGammaOi;
  return s.callGammaAsk + s.callGammaBid;
}

/** Put gamma for the active view mode */
function getPutGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.putGammaOi;
  return s.putGammaAsk + s.putGammaBid;
}

function formatDist(strike: number, price: number): string {
  const diff = Math.round(strike - price);
  if (diff === 0) return 'ATM';
  return `${diff > 0 ? '+' : ''}${diff}pts`;
}

/**
 * Charm effect on gamma level:
 *   - positive charm + positive gamma = strengthening (level holds)
 *   - positive charm + negative gamma = strengthening (acceleration)
 *   - negative charm + positive gamma = weakening (level eroding)
 *   - negative charm + negative gamma = weakening (acceleration fading)
 *
 * "Strengthening" means charm is pushing the gamma effect further from zero.
 * "Weakening" means charm is pulling the gamma effect toward zero.
 */
function getCharmEffect(
  netGamma: number,
  netCharm: number,
): 'strengthening' | 'weakening' | 'neutral' {
  if (netCharm === 0 || netGamma === 0) return 'neutral';
  // Same sign = charm is reinforcing gamma's direction
  const sameSign =
    (netGamma > 0 && netCharm > 0) || (netGamma < 0 && netCharm < 0);
  return sameSign ? 'strengthening' : 'weakening';
}

export default memo(function GexPerStrike({
  strikes,
  loading,
  error,
  timestamp,
  onRefresh,
}: Props) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [viewMode, setViewMode] = useState<ViewMode>('oi');
  const [sortBy, setSortBy] = useState<SortMode>('gex');

  const price = strikes.length > 0 ? strikes[0]!.price : 0;

  // Sort: by absolute GEX (desc) or by strike (asc)
  const sorted = useMemo(() => {
    if (sortBy === 'strike') return strikes;
    return [...strikes].sort(
      (a, b) =>
        Math.abs(getNetGamma(b, viewMode)) - Math.abs(getNetGamma(a, viewMode)),
    );
  }, [strikes, sortBy, viewMode]);

  const filtered = useMemo(
    () => sorted.slice(0, visibleCount),
    [sorted, visibleCount],
  );

  const maxAbsGamma = useMemo(
    () =>
      filtered.length > 0
        ? Math.max(
            ...filtered.map((s) => Math.abs(getNetGamma(s, viewMode))),
            1,
          )
        : 1,
    [filtered, viewMode],
  );

  const handleLess = useCallback(
    () => setVisibleCount((v) => Math.max(v - STEP, MIN_VISIBLE)),
    [],
  );
  const handleMore = useCallback(
    () => setVisibleCount((v) => Math.min(v + STEP, MAX_VISIBLE)),
    [],
  );
  const toggleSort = useCallback(
    () => setSortBy((s) => (s === 'gex' ? 'strike' : 'gex')),
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
      <button
        onClick={toggleView}
        aria-label={`Switch to ${viewMode === 'oi' ? 'directional' : 'OI'} view`}
        className="text-accent hover:text-primary border-edge cursor-pointer rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-colors"
      >
        {viewMode === 'oi' ? 'OI' : 'Dir'}
      </button>
      <button
        onClick={toggleSort}
        aria-label={`Sort by ${sortBy === 'gex' ? 'strike' : 'GEX magnitude'}`}
        className="text-accent hover:text-primary border-edge cursor-pointer rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-colors"
      >
        {sortBy === 'gex' ? 'By GEX' : 'By Strike'}
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

  return (
    <SectionBox
      label="0DTE GEX Per Strike"
      badge={badge}
      collapsible
      headerRight={headerRight}
    >
      <table
        className="w-full border-collapse"
        aria-label="0DTE gamma exposure per strike"
      >
        <thead className="sr-only">
          <tr>
            <th>Strike</th>
            <th>Distance</th>
            <th>GEX Bar</th>
            <th>GEX $</th>
            <th>Charm</th>
            <th>Call γ</th>
            <th>Put γ</th>
            <th>Flow</th>
            <th>DEX</th>
            <th>Vanna</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s) => (
            <StrikeRow
              key={s.strike}
              level={s}
              price={price}
              viewMode={viewMode}
              maxAbsGamma={maxAbsGamma}
            />
          ))}
        </tbody>
      </table>
    </SectionBox>
  );
});

function StrikeRow({
  level,
  price,
  viewMode,
  maxAbsGamma,
}: Readonly<{
  level: GexStrikeLevel;
  price: number;
  viewMode: ViewMode;
  maxAbsGamma: number;
}>) {
  const netGamma = getNetGamma(level, viewMode);
  const callGamma = getCallGamma(level, viewMode);
  const putGamma = getPutGamma(level, viewMode);
  const isPositive = netGamma >= 0;
  const barPct = Math.max((Math.abs(netGamma) / maxAbsGamma) * 100, 2);
  const charmEffect = getCharmEffect(netGamma, level.netCharm);
  const isAtm = Math.abs(level.strike - price) < 2.5;
  const dist = formatDist(level.strike, price);

  return (
    <tr
      className="flex items-center gap-2 py-1.5"
      style={isAtm ? { backgroundColor: 'rgba(255,255,255,0.04)' } : undefined}
    >
      {/* Strike */}
      <td
        className="w-[52px] shrink-0 text-right font-mono text-sm font-bold"
        style={{ color: isAtm ? theme.accent : theme.text }}
      >
        {level.strike}
      </td>

      {/* Distance from ATM */}
      <td
        className="w-[46px] shrink-0 text-right font-mono text-[10px]"
        style={{
          color: isAtm
            ? theme.accent
            : level.strike > price
              ? theme.green
              : theme.red,
        }}
      >
        {dist}
      </td>

      {/* GEX bar */}
      <td className="min-w-0 flex-1">
        <div
          className="h-[14px] rounded-sm transition-[width] duration-300"
          style={{
            width: `${barPct}%`,
            backgroundColor: isPositive ? theme.green : theme.red,
            opacity: 0.6,
          }}
          aria-label={`${formatGex(netGamma)} gamma exposure`}
        />
      </td>

      {/* Net GEX value */}
      <td
        className="w-[64px] shrink-0 text-right font-mono text-xs font-semibold"
        style={{ color: isPositive ? theme.green : theme.red }}
      >
        {formatGex(netGamma)}
      </td>

      {/* Charm effect indicator */}
      <td
        className="w-[68px] shrink-0 text-right font-mono text-[10px]"
        title={`Net charm: ${formatGex(level.netCharm)} — ${charmEffect === 'strengthening' ? 'reinforcing gamma' : charmEffect === 'weakening' ? 'eroding gamma' : 'neutral'}`}
      >
        {charmEffect === 'strengthening' && (
          <span style={{ color: theme.green }}>▲</span>
        )}
        {charmEffect === 'weakening' && (
          <span style={{ color: theme.red }}>▼</span>
        )}
        <span className="text-secondary ml-0.5">
          {formatCompact(level.netCharm)}
        </span>
      </td>

      {/* Call gamma */}
      <td className="w-[58px] shrink-0 text-right font-mono text-[10px]">
        <span style={{ color: theme.green }}>C</span>
        <span className="text-secondary ml-1">{formatCompact(callGamma)}</span>
      </td>

      {/* Put gamma */}
      <td className="w-[58px] shrink-0 text-right font-mono text-[10px]">
        <span style={{ color: theme.red }}>P</span>
        <span className="text-secondary ml-1">{formatCompact(putGamma)}</span>
      </td>

      {/* Vol vs OI reinforcement */}
      <td
        className="w-[24px] shrink-0 text-center font-mono text-[10px]"
        title={
          level.volReinforcement === 'reinforcing'
            ? "Today's flow reinforces this level"
            : level.volReinforcement === 'opposing'
              ? "Today's flow opposes this level"
              : 'No vol signal'
        }
      >
        {level.volReinforcement === 'reinforcing' && (
          <span style={{ color: theme.green }}>&#x25CF;</span>
        )}
        {level.volReinforcement === 'opposing' && (
          <span style={{ color: theme.red }}>&#x25CB;</span>
        )}
      </td>

      {/* DEX (net delta) */}
      <td
        className="text-muted w-[52px] shrink-0 text-right font-mono text-[10px]"
        title={`DEX: C ${formatCompact(level.callDeltaOi)} / P ${formatCompact(level.putDeltaOi)}`}
      >
        {formatCompact(level.netDelta)}
      </td>

      {/* Vanna */}
      <td
        className="text-muted w-[48px] shrink-0 text-right font-mono text-[10px]"
        title={`Vanna: C ${formatCompact(level.callVannaOi)} / P ${formatCompact(level.putVannaOi)}`}
      >
        {formatCompact(level.netVanna)}
      </td>
    </tr>
  );
}
