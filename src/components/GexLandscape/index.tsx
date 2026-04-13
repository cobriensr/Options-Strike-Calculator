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
  // Previous snapshot strikes for Δ% computation.
  const prevStrikesRef = useRef<GexStrikeLevel[]>([]);
  const [gexDeltaMap, setGexDeltaMap] = useState<Map<number, number | null>>(new Map());

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

  // Scroll ATM row into view only on initial data arrival.
  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (!loading && rows.length > 0 && spotRowRef.current) {
      spotRowRef.current.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      hasScrolledRef.current = true;
    }
  }, [loading, rows.length]);

  // Compute GEX Δ% whenever strikes updates (new snapshot from poll).
  useEffect(() => {
    const prev = prevStrikesRef.current;
    if (prev.length === 0 || strikes.length === 0) {
      prevStrikesRef.current = strikes;
      return;
    }
    const prevByStrike = new Map(prev.map((s) => [s.strike, s.netGamma]));
    const deltas = new Map<number, number | null>();
    for (const s of strikes) {
      const prevGamma = prevByStrike.get(s.strike);
      deltas.set(
        s.strike,
        prevGamma === undefined || prevGamma === 0
          ? null
          : ((s.netGamma - prevGamma) / Math.abs(prevGamma)) * 100,
      );
    }
    setGexDeltaMap(deltas);
    prevStrikesRef.current = strikes;
  }, [strikes]);

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

  // Strike | Classification | Signal | Net GEX | GEX Δ% | Charm | Vol
  const cols = 'grid-cols-[76px_130px_1fr_88px_68px_76px_56px]';

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
          <div className="px-3 py-2 text-right">GEX Δ%</div>
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
            const dir = getDirection(s.strike, currentPrice);
            const cls = classify(s.netGamma, s.netCharm);
            const meta = CLASS_META[cls];
            const pct = gexDeltaMap.get(s.strike) ?? null;

            return (
              <div
                key={s.strike}
                ref={isSpot ? spotRowRef : undefined}
                role="listitem"
                className={[
                  `border-edge/30 hover:bg-surface-alt/60 grid border-b transition-colors ${cols}`,
                  isSpot ? 'border-l-2 border-l-sky-400/40 bg-sky-500/10' : meta.rowBg,
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
                    className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeBg} ${meta.badgeText}`}
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
                  <span className={`font-mono text-[10px] ${meta.badgeText}`}>
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

                {/* GEX Δ% */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        pct === null
                          ? 'var(--color-muted)'
                          : pct >= 0
                            ? 'rgba(74,222,128,0.85)'
                            : 'rgba(248,113,113,0.85)',
                    }}
                  >
                    {fmtPct(pct)}
                  </span>
                </div>

                {/* Charm */}
                <div className="flex items-center justify-end px-3 py-1.5">
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        s.netCharm >= 0 ? 'rgba(74,222,128,0.75)' : 'rgba(248,113,113,0.75)',
                    }}
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
