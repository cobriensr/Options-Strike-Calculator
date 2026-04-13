/**
 * GexLandscape — Strike classification table using the 4-quadrant
 * gamma × charm framework (Negative/Positive Gamma × Negative/Positive Charm).
 *
 * Each strike within ±50 pts of spot is labelled as one of:
 *   Max Launchpad    — neg gamma + pos charm  (accelerant that builds into close)
 *   Fading Launchpad — neg gamma + neg charm  (accelerant that weakens over time)
 *   Sticky Pin       — pos gamma + pos charm  (wall that strengthens into close)
 *   Weakening Pin    — pos gamma + neg charm  (wall losing grip as day ages)
 *
 * Direction context (Ceiling / Floor) is overlaid based on strike vs. spot.
 * GEX Δ% shows the % change in net gamma since the previous 1-min snapshot.
 * Vol reinforcement signals whether intraday flow confirms OI structure.
 *
 * Reuses the same gexStrike data passed to GexPerStrike — no extra fetch.
 */

import { memo, useMemo, useEffect, useRef, useState } from 'react';
import { SectionBox } from '../ui';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';

// ── Types ─────────────────────────────────────────────────────────────────────

type GexClassification =
  | 'max-launchpad'
  | 'fading-launchpad'
  | 'sticky-pin'
  | 'weakening-pin';

export interface GexLandscapeProps {
  strikes: GexStrikeLevel[];
  loading: boolean;
  error: string | null;
  timestamp: string | null;
  onRefresh: () => void;
  selectedDate: string;
  onDateChange: (date: string) => void;
  isLive: boolean;
  isToday: boolean;
  isScrubbed: boolean;
  canScrubPrev: boolean;
  canScrubNext: boolean;
  onScrubPrev: () => void;
  onScrubNext: () => void;
  onScrubLive: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max points from spot to include in the table (≈20 strikes at 5-pt intervals). */
const PRICE_WINDOW = 50;

/** Points from spot within which a strike is considered "at money". */
const SPOT_BAND = 12;

// ── Classification ────────────────────────────────────────────────────────────

function classify(netGamma: number, netCharm: number): GexClassification {
  if (netGamma < 0 && netCharm >= 0) return 'max-launchpad';
  if (netGamma < 0 && netCharm < 0) return 'fading-launchpad';
  if (netGamma >= 0 && netCharm >= 0) return 'sticky-pin';
  return 'weakening-pin';
}

type Direction = 'ceiling' | 'floor' | 'atm';

function getDirection(strike: number, price: number): Direction {
  if (strike > price + SPOT_BAND) return 'ceiling';
  if (strike < price - SPOT_BAND) return 'floor';
  return 'atm';
}

interface ClassMeta {
  badge: string;
  badgeBg: string;
  badgeText: string;
  rowBg: string;
  signal: (dir: Direction) => string;
}

const CLASS_META: Record<GexClassification, ClassMeta> = {
  'max-launchpad': {
    badge: 'Max Launchpad',
    badgeBg: 'bg-amber-500/25',
    badgeText: 'text-amber-400',
    rowBg: 'bg-amber-500/5',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Ceiling Breakout Risk'
        : dir === 'floor'
          ? 'Floor Collapse Risk'
          : 'Launch Zone',
  },
  'fading-launchpad': {
    badge: 'Fading Launchpad',
    badgeBg: 'bg-yellow-600/20',
    badgeText: 'text-yellow-500/80',
    rowBg: 'bg-yellow-600/5',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Weakening Ceiling'
        : dir === 'floor'
          ? 'Weakening Floor'
          : 'Fading Launch',
  },
  'sticky-pin': {
    badge: 'Sticky Pin',
    badgeBg: 'bg-emerald-500/25',
    badgeText: 'text-emerald-400',
    rowBg: 'bg-emerald-500/5',
    signal: (dir) =>
      dir === 'ceiling' ? 'Hard Ceiling' : dir === 'floor' ? 'Hard Floor' : 'Pin Zone',
  },
  'weakening-pin': {
    badge: 'Weakening Pin',
    badgeBg: 'bg-emerald-500/10',
    badgeText: 'text-emerald-600',
    rowBg: '',
    signal: (dir) =>
      dir === 'ceiling'
        ? 'Softening Ceiling'
        : dir === 'floor'
          ? 'Softening Floor'
          : 'Weak Pin',
  },
};

// ── Tooltips ─────────────────────────────────────────────────────────────────

const CLS_TOOLTIP: Record<GexClassification, string> = {
  'max-launchpad':
    'Neg γ + Pos charm — dealers are short gamma (pro-cyclical: buy rallies, sell drops) AND their delta is growing as the day ages. Price accelerates through this level; it is not a wall.',
  'fading-launchpad':
    'Neg γ + Neg charm — dealers are short gamma (amplify moves) but charm is draining their delta over time. Launch risk fades toward close; strongest early session.',
  'sticky-pin':
    'Pos γ + Pos charm — dealers are long gamma (counter-cyclical: sell rallies, buy dips) AND their hedging power grows with time. Strongest wall; gets stickier into close.',
  'weakening-pin':
    'Pos γ + Neg charm — dealers are long gamma (dampen moves) but charm is bleeding off their delta. Pin may hold early; loses grip toward close.',
};

function signalTooltip(cls: GexClassification, dir: Direction): string {
  const mechanic =
    cls === 'max-launchpad' || cls === 'fading-launchpad'
      ? 'Neg gamma: pro-cyclical dealers amplify whichever direction price is moving.'
      : 'Pos gamma: counter-cyclical dealers sell strength and buy weakness, damping moves.';
  const position =
    dir === 'ceiling'
      ? 'Strike is above spot — functions as resistance.'
      : dir === 'floor'
        ? 'Strike is below spot — functions as support.'
        : 'Strike is at the money — directional pressure is symmetric.';
  const charm =
    cls === 'max-launchpad' || cls === 'sticky-pin'
      ? 'Charm is positive — this structure strengthens as the session ages.'
      : 'Charm is negative — this structure weakens as the session ages.';
  return `${mechanic} ${position} ${charm}`;
}

function charmTooltip(netCharm: number): string {
  return netCharm >= 0
    ? 'Charm + (positive): dealer delta grows over time. More futures buying is required as the day ages — upward delta pressure builds into close.'
    : 'Charm − (negative): dealer delta shrinks over time. Hedging pressure bleeds off toward close — structural influence fades.';
}

// ── Delta helpers ─────────────────────────────────────────────────────────────

interface Snapshot {
  strikes: GexStrikeLevel[];
  ts: number; // unix ms from snapshot timestamp
}

/** Compute % change in netGamma from prev → current for each strike. */
function computeDeltaMap(
  current: GexStrikeLevel[],
  prev: GexStrikeLevel[],
): Map<number, number | null> {
  const prevByStrike = new Map(prev.map((s) => [s.strike, s.netGamma]));
  const result = new Map<number, number | null>();
  for (const s of current) {
    const prevGamma = prevByStrike.get(s.strike);
    result.set(
      s.strike,
      prevGamma === undefined || prevGamma === 0
        ? null
        : ((s.netGamma - prevGamma) / Math.abs(prevGamma)) * 100,
    );
  }
  return result;
}

/**
 * Find the snapshot in `buf` whose timestamp is closest to `targetTs`.
 * Returns null if no snapshot falls within `toleranceMs` of the target,
 * so callers get an empty column rather than a misleading comparison.
 */
function findClosestSnapshot(
  buf: Snapshot[],
  targetTs: number,
  toleranceMs = 120_000,
): Snapshot | null {
  if (!buf.length) return null;
  let closest: Snapshot | null = null;
  let minDiff = Infinity;
  for (const snap of buf) {
    const diff = Math.abs(snap.ts - targetTs);
    if (diff < minDiff) {
      minDiff = diff;
      closest = snap;
    }
  }
  return minDiff <= toleranceMs ? closest : null;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '+';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '+';
  return abs >= 10 ? `${sign}${abs.toFixed(0)}%` : `${sign}${abs.toFixed(1)}%`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

const GexLandscape = memo(function GexLandscape({
  strikes,
  loading,
  error,
  timestamp,
  onRefresh,
  selectedDate,
  onDateChange,
  isLive,
  isScrubbed,
  canScrubPrev,
  canScrubNext,
  onScrubPrev,
  onScrubNext,
  onScrubLive,
}: GexLandscapeProps) {
  const spotRowRef = useRef<HTMLDivElement>(null);
  // Scroll to ATM row only once on initial data arrival; never on scrub.
  const hasScrolledRef = useRef(false);
  // Rolling buffer of recent snapshots for Δ% computations (1m and 5m).
  const snapshotBufferRef = useRef<Snapshot[]>([]);
  const [gexDeltaMap, setGexDeltaMap] = useState<Map<number, number | null>>(new Map());
  const [gexDelta5mMap, setGexDelta5mMap] = useState<Map<number, number | null>>(new Map());

  const currentPrice = strikes[0]?.price ?? 0;

  // Filter to ±PRICE_WINDOW pts, sort descending: ceiling at top, floor at bottom.
  const rows = useMemo(
    () =>
      strikes
        .filter((s) => Math.abs(s.strike - currentPrice) <= PRICE_WINDOW)
        .sort((a, b) => b.strike - a.strike),
    [strikes, currentPrice],
  );

  // Find the strike closest to spot for the ATM indicator.
  const spotStrike = useMemo(() => {
    if (!rows.length) return null;
    return rows.reduce((best, s) =>
      Math.abs(s.strike - currentPrice) < Math.abs(best.strike - currentPrice) ? s : best,
    );
  }, [rows, currentPrice]);

  // Strike with the largest absolute 1m GEX Δ% (excludes ATM row).
  const maxChanged1mStrike = useMemo(() => {
    let maxAbs = 0;
    let maxStrike: number | null = null;
    for (const s of rows) {
      const pct = gexDeltaMap.get(s.strike) ?? null;
      if (pct === null) continue;
      const abs = Math.abs(pct);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxStrike = s.strike;
      }
    }
    return maxAbs > 0 ? maxStrike : null;
  }, [gexDeltaMap, rows]);

  // Strike with the largest absolute 5m GEX Δ% (excludes ATM row).
  const maxChanged5mStrike = useMemo(() => {
    let maxAbs = 0;
    let maxStrike: number | null = null;
    for (const s of rows) {
      const pct = gexDelta5mMap.get(s.strike) ?? null;
      if (pct === null) continue;
      const abs = Math.abs(pct);
      if (abs > maxAbs) {
        maxAbs = abs;
        maxStrike = s.strike;
      }
    }
    return maxAbs > 0 ? maxStrike : null;
  }, [gexDelta5mMap, rows]);

  // When the viewed date changes, reset scroll and all Δ% tracking so the new
  // date's first snapshot gets a clean baseline instead of comparing against
  // the previous date's strikes.
  useEffect(() => {
    hasScrolledRef.current = false;
    snapshotBufferRef.current = [];
    setGexDeltaMap(new Map());
    setGexDelta5mMap(new Map());
  }, [selectedDate]);

  // Scroll ATM row into view only on initial data arrival.
  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (!loading && rows.length > 0 && spotRowRef.current) {
      spotRowRef.current.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      hasScrolledRef.current = true;
    }
  }, [loading, rows.length]);

  // Compute 1m and 5m GEX Δ% on each new snapshot.
  // Uses a rolling buffer keyed by snapshot timestamp to avoid duplicate
  // processing and to support arbitrary lookback windows.
  useEffect(() => {
    if (!timestamp || strikes.length === 0) return;
    const now = new Date(timestamp).getTime();

    // Guard: don't process the same snapshot twice (e.g. re-render with same data).
    if (snapshotBufferRef.current.at(-1)?.ts === now) return;

    // Prune entries older than 10 minutes to keep the buffer bounded.
    const cutoff = now - 10 * 60 * 1000;
    const buf = snapshotBufferRef.current.filter((snap) => snap.ts >= cutoff);

    // 1m delta — compare against the most recent buffered snapshot.
    const prev1m = buf.at(-1);
    setGexDeltaMap(prev1m ? computeDeltaMap(strikes, prev1m.strikes) : new Map());

    // 5m delta — find the snapshot closest to 5 minutes ago.
    const snap5m = findClosestSnapshot(buf, now - 5 * 60 * 1000);
    setGexDelta5mMap(snap5m ? computeDeltaMap(strikes, snap5m.strikes) : new Map());

    // Push current snapshot and persist the updated buffer.
    buf.push({ strikes, ts: now });
    snapshotBufferRef.current = buf;
  }, [strikes, timestamp]);

  // ── Header controls ────────────────────────────────────────────────────────

  const headerRight = (
    <div className="flex items-center gap-2">
      {/* Scrubber */}
      <div className="flex items-center gap-1">
        <button
          onClick={onScrubPrev}
          disabled={!canScrubPrev}
          className="border-edge text-secondary hover:text-primary disabled:text-muted rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default"
          aria-label="Previous snapshot"
        >
          ‹
        </button>
        {timestamp && (
          <span
            className="font-mono text-[11px]"
            style={{
              color: isLive ? '#00e676' : isScrubbed ? '#ffd740' : 'var(--color-secondary)',
            }}
          >
            {fmtTime(timestamp)} CT
          </span>
        )}
        <button
          onClick={onScrubNext}
          disabled={!canScrubNext}
          className="border-edge text-secondary hover:text-primary disabled:text-muted rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default"
          aria-label="Next snapshot"
        >
          ›
        </button>
        {isScrubbed && (
          <button
            onClick={onScrubLive}
            className="font-mono text-[10px] font-bold transition-opacity hover:opacity-80"
            style={{ color: '#00e676' }}
            aria-label="Resume live"
          >
            LIVE
          </button>
        )}
      </div>

      {/* Date picker */}
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => onDateChange(e.target.value)}
        className="border-edge bg-surface text-secondary rounded border px-1.5 py-0.5 font-mono text-[11px]"
        aria-label="Select date"
      />

      {/* Status badge */}
      {isLive && (
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
          style={{ background: 'rgba(0,230,118,0.15)', color: '#00e676' }}
        >
          LIVE
        </span>
      )}
      {isScrubbed && (
        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-400">
          SCRUBBED
        </span>
      )}

      {/* Refresh */}
      <button
        onClick={onRefresh}
        disabled={loading}
        className={`text-secondary hover:text-primary disabled:text-muted text-base transition-colors disabled:cursor-default${loading ? ' animate-spin' : ''}`}
        title="Refresh"
        aria-label="Refresh GEX landscape"
      >
        ↻
      </button>
    </div>
  );

  // ── Body states ────────────────────────────────────────────────────────────

  if (loading && rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
          Loading GEX landscape…
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-danger py-4 text-center font-mono text-[13px]">{error}</div>
      </SectionBox>
    );
  }

  if (rows.length === 0) {
    return (
      <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
        <div className="text-muted py-8 text-center font-mono text-[13px]">
          No strike data available
        </div>
      </SectionBox>
    );
  }

  // ── Table ──────────────────────────────────────────────────────────────────

  // Strike | Classification | Signal | Net GEX | 1m Δ% | 5m Δ% | Charm | Vol
  const cols = 'grid-cols-[76px_130px_1fr_88px_68px_68px_76px_56px]';

  return (
    <SectionBox label="GEX LANDSCAPE" headerRight={headerRight} collapsible>
      <div className="border-edge overflow-hidden rounded-lg border">
        {/* Sticky column header */}
        <div
          className={`border-edge-heavy bg-surface-alt sticky top-0 grid border-b font-mono text-[10px] font-semibold uppercase tracking-wider ${cols}`}
          style={{ color: 'var(--color-tertiary)' }}
        >
          <div className="px-3 py-2 text-right">Strike</div>
          <div className="px-3 py-2">Classification</div>
          <div className="px-3 py-2">Signal</div>
          <div className="px-3 py-2 text-right">Net GEX</div>
          <div className="px-3 py-2 text-right">1m Δ%</div>
          <div className="px-3 py-2 text-right">5m Δ%</div>
          <div className="px-3 py-2 text-right">Charm</div>
          <div className="px-3 py-2 text-center">Vol</div>
        </div>

        {/* Scrollable rows */}
        <div
          className="max-h-[540px] overflow-y-auto"
          role="list"
          aria-label="GEX strike landscape"
        >
          {rows.map((s) => {
            const isSpot = s.strike === spotStrike?.strike;
            const isAboveSpot = s.strike > currentPrice;
            const isMax1m = !isSpot && s.strike === maxChanged1mStrike;
            const isMax5m = !isSpot && s.strike === maxChanged5mStrike;
            // Confluence: same strike leads BOTH timeframes — stronger signal.
            const isConfluence = isMax1m && isMax5m;
            const isHighlighted = isMax1m || isMax5m;
            const dir = getDirection(s.strike, currentPrice);
            const cls = classify(s.netGamma, s.netCharm);
            const meta = CLASS_META[cls];
            const pct1m = gexDeltaMap.get(s.strike) ?? null;
            const pct5m = gexDelta5mMap.get(s.strike) ?? null;

            return (
              <div
                key={s.strike}
                ref={isSpot ? spotRowRef : undefined}
                role="listitem"
                className={[
                  `border-edge/30 hover:bg-surface-alt/60 grid border-b transition-colors ${cols}`,
                  isSpot
                    ? 'border-l-2 border-l-sky-400/40 bg-sky-500/10'
                    : isConfluence
                      ? isAboveSpot
                        ? 'border-l-2 border-l-green-400/60 bg-green-500/20'
                        : 'border-l-2 border-l-red-400/60 bg-red-500/20'
                      : isHighlighted
                        ? isAboveSpot
                          ? 'border-l-2 border-l-green-400/40 bg-green-500/10'
                          : 'border-l-2 border-l-red-400/40 bg-red-500/10'
                        : meta.rowBg,
                ].join(' ')}
              >
                {/* Strike + ATM label */}
                <div className="flex flex-col items-end justify-center px-3 py-1">
                  <span
                    className={`font-mono text-[12px] font-semibold ${isSpot ? 'text-sky-300' : 'text-secondary'}`}
                  >
                    {s.strike.toLocaleString()}
                  </span>
                  {isSpot && (
                    <span className="font-mono text-[9px] font-bold text-sky-400/80">
                      ATM
                    </span>
                  )}
                </div>

                {/* Classification badge */}
                <div className="flex items-center px-3 py-1.5">
                  <span
                    className={`inline-block cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeBg} ${meta.badgeText}`}
                    title={CLS_TOOLTIP[cls]}
                  >
                    {meta.badge}
                  </span>
                </div>

                {/* Direction signal */}
                <div className="flex items-center gap-1 px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        dir === 'ceiling'
                          ? 'rgba(125,185,232,0.6)'
                          : dir === 'floor'
                            ? 'rgba(232,125,125,0.6)'
                            : 'rgba(255,255,255,0.35)',
                    }}
                  >
                    {dir === 'ceiling' ? '↑' : dir === 'floor' ? '↓' : '●'}
                  </span>
                  <span
                    className={`cursor-help font-mono text-[10px] ${meta.badgeText}`}
                    title={signalTooltip(cls, dir)}
                  >
                    {meta.signal(dir)}
                  </span>
                </div>

                {/* Net GEX */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: s.netGamma >= 0 ? '#4ade80' : '#fbbf24' }}
                  >
                    {fmtGex(s.netGamma)}
                  </span>
                </div>

                {/* 1m GEX Δ% */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        pct1m === null
                          ? 'var(--color-muted)'
                          : pct1m >= 0
                            ? 'rgba(74,222,128,0.85)'
                            : 'rgba(248,113,113,0.85)',
                    }}
                  >
                    {fmtPct(pct1m)}
                  </span>
                </div>

                {/* 5m GEX Δ% */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        pct5m === null
                          ? 'var(--color-muted)'
                          : pct5m >= 0
                            ? 'rgba(74,222,128,0.85)'
                            : 'rgba(248,113,113,0.85)',
                    }}
                  >
                    {fmtPct(pct5m)}
                  </span>
                </div>

                {/* Charm */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="cursor-help font-mono text-[11px]"
                    style={{
                      color:
                        s.netCharm >= 0 ? 'rgba(74,222,128,0.75)' : 'rgba(248,113,113,0.75)',
                    }}
                    title={charmTooltip(s.netCharm)}
                  >
                    {fmtGex(s.netCharm)}
                  </span>
                </div>

                {/* Vol reinforcement */}
                <div className="flex items-center justify-center px-3 py-1.5">
                  {s.volReinforcement === 'reinforcing' && (
                    <span
                      className="font-mono text-[12px] text-emerald-400"
                      title="Volume reinforcing OI structure"
                      aria-label="Volume reinforcing"
                    >
                      ✓
                    </span>
                  )}
                  {s.volReinforcement === 'opposing' && (
                    <span
                      className="font-mono text-[12px] text-red-400"
                      title="Volume opposing OI structure"
                      aria-label="Volume opposing"
                    >
                      ✗
                    </span>
                  )}
                  {s.volReinforcement === 'neutral' && (
                    <span
                      className="text-muted font-mono text-[12px]"
                      title="Volume neutral"
                      aria-label="Volume neutral"
                    >
                      ○
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend — centered */}
      <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 px-1">
        {(
          [
            ['max-launchpad', 'Neg γ + Pos θ_t — accelerant, builds into close'],
            ['fading-launchpad', 'Neg γ + Neg θ_t — accelerant that weakens over time'],
            ['sticky-pin', 'Pos γ + Pos θ_t — wall that strengthens into close'],
            ['weakening-pin', 'Pos γ + Neg θ_t — wall losing grip as day ages'],
          ] as [GexClassification, string][]
        ).map(([cls, desc]) => {
          const m = CLASS_META[cls];
          return (
            <div key={cls} className="flex items-center gap-1.5">
              <span
                className={`inline-block rounded px-1 py-0 font-mono text-[9px] font-semibold ${m.badgeBg} ${m.badgeText}`}
              >
                {m.badge}
              </span>
              <span className="text-muted font-mono text-[9px]">{desc}</span>
            </div>
          );
        })}
      </div>
    </SectionBox>
  );
});

export default GexLandscape;
