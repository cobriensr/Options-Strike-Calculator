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
      dir === 'ceiling'
        ? 'Hard Ceiling'
        : dir === 'floor'
          ? 'Hard Floor'
          : 'Pin Zone',
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
    'Market makers will ADD fuel to a move here, not resist it — and that pressure grows as the day goes on. If price breaks through, expect acceleration, not a bounce.',
  'fading-launchpad':
    'Market makers will amplify moves here, but only early in the session. Their hedging pressure fades as the day wears on, so this level is most dangerous in the morning.',
  'sticky-pin':
    'Market makers are actively pushing back against any move through this level, and that resistance gets stronger as the day progresses. The most reliable wall on the board.',
  'weakening-pin':
    'Market makers are dampening moves here, but their ability to hold the line fades over time. Can act as support or resistance early in the day; less reliable into the close.',
};

function signalTooltip(cls: GexClassification, dir: Direction): string {
  const mechanic =
    cls === 'max-launchpad' || cls === 'fading-launchpad'
      ? 'Market makers add fuel to moves here — they buy when price rises and sell when it falls.'
      : 'Market makers absorb moves here — they sell into rallies and buy into dips.';
  const position =
    dir === 'ceiling'
      ? 'This strike is above current price — it is overhead resistance.'
      : dir === 'floor'
        ? 'This strike is below current price — it is downside support.'
        : 'This strike is right at the money — pressure is balanced in both directions.';
  const charm =
    cls === 'max-launchpad' || cls === 'sticky-pin'
      ? 'The influence at this level builds as the session ages.'
      : 'The influence at this level fades as the session ages.';
  return `${mechanic} ${position} ${charm}`;
}

function charmTooltip(netCharm: number): string {
  return netCharm >= 0
    ? 'Positive: market maker hedging pressure at this level is growing throughout the day — the structural effect gets stronger into the close.'
    : 'Negative: market maker hedging pressure at this level is draining throughout the day — the structural effect weakens into the close.';
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

// ── Structural bias ───────────────────────────────────────────────────────────

interface BiasMetrics {
  verdict: 'bullish' | 'bearish' | 'rangebound' | 'volatile' | 'neutral';
  floorRatio: number; // 0–1: share of charm-weighted pin GEX that is below spot
  gravityStrike: number; // strike with the largest absolute GEX
  gravityOffset: number; // signed distance from spot (+ = above, − = below)
  gravityGex: number; // netGamma at that strike
  nearestSupport: {
    strike: number;
    cls: GexClassification;
    hardening: boolean;
  } | null;
  nearestResistance: {
    strike: number;
    cls: GexClassification;
    hardening: boolean;
  } | null;
  floorTrend: number | null; // avg 1m Δ% for below-spot strikes
  ceilingTrend: number | null; // avg 1m Δ% for above-spot strikes
}

interface VerdictMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  desc: string;
}

const VERDICT_META: Record<BiasMetrics['verdict'], VerdictMeta> = {
  bullish: {
    label: 'BULLISH LEAN',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/30',
    desc: 'Floor is stronger — MMs defend below while ceiling may crack',
  },
  bearish: {
    label: 'BEARISH LEAN',
    color: 'text-red-400',
    bg: 'bg-red-500/15',
    border: 'border-red-500/30',
    desc: 'Ceiling is heavier — MMs cap above while floor may give',
  },
  rangebound: {
    label: 'RANGE-BOUND',
    color: 'text-sky-400',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/30',
    desc: 'MMs pinning from both sides — fade moves toward the edges',
  },
  volatile: {
    label: 'VOLATILE',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    desc: 'Launchpads dominate — follow breakouts, do not fade moves',
  },
  neutral: {
    label: 'NEUTRAL',
    color: 'text-secondary',
    bg: 'bg-surface-alt',
    border: 'border-edge',
    desc: 'Balanced structure — no clear directional edge from GEX alone',
  },
};

/**
 * Average netGamma and netCharm for each strike across the current snapshot
 * and all buffer entries within `windowMs` (default 5 minutes).
 *
 * Smoothing makes the structural bias verdict stable: small minute-to-minute
 * GEX fluctuations won't flip the signal. The Δ% columns in the table still
 * show raw real-time changes — only the verdict inputs are smoothed.
 */
function computeSmoothedStrikes(
  current: GexStrikeLevel[],
  buf: Snapshot[],
  nowTs: number,
  windowMs = 5 * 60 * 1000,
): GexStrikeLevel[] {
  const recent = buf.filter((snap) => snap.ts >= nowTs - windowMs);
  if (recent.length === 0) return current;
  return current.map((s) => {
    const history = recent
      .map((snap) => snap.strikes.find((r) => r.strike === s.strike))
      .filter((r): r is GexStrikeLevel => r !== undefined);
    if (history.length === 0) return s;
    const all = [s, ...history];
    const avgGamma = all.reduce((sum, r) => sum + r.netGamma, 0) / all.length;
    const avgCharm = all.reduce((sum, r) => sum + r.netCharm, 0) / all.length;
    return { ...s, netGamma: avgGamma, netCharm: avgCharm };
  });
}

/**
 * Synthesise a directional bias verdict from the current strike landscape.
 *
 * Score logic:
 *   Bullish factors  = strong floor below (positive-GEX pins below spot)
 *                    + explosive ceiling above (negative-GEX launchpads above spot)
 *   Bearish factors  = strong ceiling above (positive-GEX pins above spot)
 *                    + explosive floor below (negative-GEX launchpads below spot)
 *
 * Each level's GEX is charm-weighted so hardening levels carry more influence
 * (1.25×) and weakening levels carry less (0.75×).
 */
function computeBias(
  rows: GexStrikeLevel[],
  currentPrice: number,
  gexDeltaMap: Map<number, number | null>,
): BiasMetrics {
  const above = rows.filter((s) => s.strike > currentPrice + SPOT_BAND);
  const below = rows.filter((s) => s.strike < currentPrice - SPOT_BAND);
  const cw = (s: GexStrikeLevel) => (s.netCharm >= 0 ? 1.25 : 0.75);

  // Charm-weighted pin GEX (positive = structural resistance/support)
  const ceilingPin = above.reduce(
    (sum, s) => sum + Math.max(0, s.netGamma) * cw(s),
    0,
  );
  const floorPin = below.reduce(
    (sum, s) => sum + Math.max(0, s.netGamma) * cw(s),
    0,
  );

  // Charm-weighted launch GEX (negative = accelerant; use abs value)
  const ceilingLaunch = above.reduce(
    (sum, s) => sum + Math.max(0, -s.netGamma) * cw(s),
    0,
  );
  const floorLaunch = below.reduce(
    (sum, s) => sum + Math.max(0, -s.netGamma) * cw(s),
    0,
  );

  const totalPin = ceilingPin + floorPin;
  const totalLaunch = ceilingLaunch + floorLaunch;
  const launchPct =
    totalPin + totalLaunch > 0 ? totalLaunch / (totalPin + totalLaunch) : 0;

  const bullScore = floorPin + ceilingLaunch;
  const bearScore = ceilingPin + floorLaunch;
  const dirTotal = bullScore + bearScore;
  const balanceRatio = dirTotal > 0 ? bullScore / dirTotal : 0.5;

  let verdict: BiasMetrics['verdict'];
  if (launchPct > 0.65) verdict = 'volatile';
  else if (balanceRatio > 0.58) verdict = 'bullish';
  else if (balanceRatio < 0.42) verdict = 'bearish';
  else if (totalPin >= totalLaunch) verdict = 'rangebound';
  else verdict = 'neutral';

  // Balance bar ratio (pin GEX only)
  const totalPinForRatio = floorPin + ceilingPin;
  const floorRatio = totalPinForRatio > 0 ? floorPin / totalPinForRatio : 0.5;

  // GEX gravity: strike with largest absolute GEX in the full window
  let gravityRow: GexStrikeLevel | null = null;
  for (const s of [...above, ...below]) {
    if (
      gravityRow === null ||
      Math.abs(s.netGamma) > Math.abs(gravityRow.netGamma)
    ) {
      gravityRow = s;
    }
  }

  // Nearest non-ATM levels on each side (closest to spot)
  const nearestResistanceRow = above.at(-1) ?? null; // lowest above (descending sort)
  const nearestSupportRow = below[0] ?? null; // highest below (descending sort)

  const toLevel = (s: GexStrikeLevel) => ({
    strike: s.strike,
    cls: classify(s.netGamma, s.netCharm),
    hardening: s.netCharm >= 0,
  });

  // Aggregate 1m Δ% trends above and below spot
  const avg = (vals: (number | null | undefined)[]) => {
    const nums = vals.filter((v): v is number => v !== null && v !== undefined);
    return nums.length > 0
      ? nums.reduce((a, b) => a + b, 0) / nums.length
      : null;
  };

  return {
    verdict,
    floorRatio,
    gravityStrike: gravityRow?.strike ?? currentPrice,
    gravityOffset: gravityRow ? gravityRow.strike - currentPrice : 0,
    gravityGex: gravityRow?.netGamma ?? 0,
    nearestSupport: nearestSupportRow ? toLevel(nearestSupportRow) : null,
    nearestResistance: nearestResistanceRow
      ? toLevel(nearestResistanceRow)
      : null,
    floorTrend: avg(below.map((s) => gexDeltaMap.get(s.strike))),
    ceilingTrend: avg(above.map((s) => gexDeltaMap.get(s.strike))),
  };
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
  const [gexDeltaMap, setGexDeltaMap] = useState<Map<number, number | null>>(
    new Map(),
  );
  const [gexDelta5mMap, setGexDelta5mMap] = useState<
    Map<number, number | null>
  >(new Map());
  // 5-minute smoothed strikes — updated in the snapshot effect so the ref read
  // happens inside an effect (not during render), satisfying react-hooks/purity.
  const [smoothedRows, setSmoothedRows] = useState<GexStrikeLevel[]>([]);

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
    return rows.reduce(
      (best, s) =>
        Math.abs(s.strike - currentPrice) < Math.abs(best.strike - currentPrice)
          ? s
          : best,
      rows[0]!,
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

  // Structural bias synthesis — directional verdict + key levels + trends.
  // Uses smoothedRows (5-min avg) so small per-snapshot GEX fluctuations don't
  // flip the verdict. Falls back to raw rows until enough history accumulates.
  const bias = useMemo(() => {
    const base = smoothedRows.length > 0 ? smoothedRows : rows;
    return computeBias(base, currentPrice, gexDeltaMap);
  }, [smoothedRows, rows, currentPrice, gexDeltaMap]);

  // When the viewed date changes, reset scroll and all Δ% tracking so the new
  // date's first snapshot gets a clean baseline instead of comparing against
  // the previous date's strikes.
  useEffect(() => {
    hasScrolledRef.current = false;
    snapshotBufferRef.current = [];
    setGexDeltaMap(new Map());
    setGexDelta5mMap(new Map());
    setSmoothedRows([]);
  }, [selectedDate]);

  // Scroll ATM row into view only on initial data arrival.
  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (!loading && rows.length > 0 && spotRowRef.current) {
      spotRowRef.current.scrollIntoView?.({
        block: 'center',
        behavior: 'instant',
      });
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
    setGexDeltaMap(
      prev1m ? computeDeltaMap(strikes, prev1m.strikes) : new Map(),
    );

    // 5m delta — find the snapshot closest to 5 minutes ago.
    const snap5m = findClosestSnapshot(buf, now - 5 * 60 * 1000);
    setGexDelta5mMap(
      snap5m ? computeDeltaMap(strikes, snap5m.strikes) : new Map(),
    );

    // Push current snapshot and persist the updated buffer.
    buf.push({ strikes, ts: now });
    snapshotBufferRef.current = buf;

    // Smooth only the strikes within the display window (same filter as rows)
    // so the bias panel never shows out-of-range strikes.
    const price = strikes[0]?.price ?? 0;
    const windowStrikes = strikes.filter(
      (s) => Math.abs(s.strike - price) <= PRICE_WINDOW,
    );
    setSmoothedRows(computeSmoothedStrikes(windowStrikes, buf, now));
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
              color: isLive
                ? '#00e676'
                : isScrubbed
                  ? '#ffd740'
                  : 'var(--color-secondary)',
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
        className={`text-secondary hover:text-primary disabled:text-muted text-base transition-colors disabled:cursor-default${loading ? 'animate-spin' : ''}`}
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
        <div className="text-danger py-4 text-center font-mono text-[13px]">
          {error}
        </div>
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
      {/* ── Bias synthesis panel ─────────────────────────────────────────── */}
      {(() => {
        const vm = VERDICT_META[bias.verdict];
        const floorPct = Math.round(bias.floorRatio * 100);
        const ceilPct = 100 - floorPct;
        // Floor trend: positive = floor hardening (bullish) = green
        // Ceiling trend: positive = ceiling hardening (bearish) = amber; negative = softening (bullish) = green
        const floorTrendColor =
          bias.floorTrend === null
            ? 'var(--color-muted)'
            : bias.floorTrend >= 0
              ? '#4ade80'
              : '#f87171';
        const ceilTrendColor =
          bias.ceilingTrend === null
            ? 'var(--color-muted)'
            : bias.ceilingTrend <= 0
              ? '#4ade80'
              : '#fbbf24';
        return (
          <div className={`mb-3 rounded-lg border p-3 ${vm.bg} ${vm.border}`}>
            {/* Verdict */}
            <div className="mb-2.5 flex items-center gap-2.5">
              <span
                className={`rounded border px-2 py-0.5 font-mono text-[11px] font-bold ${vm.color} ${vm.bg} ${vm.border}`}
              >
                {vm.label}
              </span>
              <span className="text-secondary font-mono text-[11px]">
                {vm.desc}
              </span>
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-[1fr_auto_1fr_1px_auto_1px_auto] items-start gap-x-4">
              {/* Nearest support */}
              <div>
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Support
                </div>
                {bias.nearestSupport ? (
                  <>
                    <div className="font-mono text-[13px] font-semibold text-emerald-400">
                      {bias.nearestSupport.strike.toLocaleString()}
                    </div>
                    <div
                      className="font-mono text-[10px]"
                      style={{ color: 'var(--color-secondary)' }}
                    >
                      {CLASS_META[bias.nearestSupport.cls].badge}
                      {' · '}
                      {bias.nearestSupport.hardening
                        ? 'hardening'
                        : 'softening'}
                    </div>
                  </>
                ) : (
                  <div
                    className="font-mono text-[13px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    —
                  </div>
                )}
              </div>

              {/* Floor vs ceiling balance bar — centered */}
              <div className="flex min-w-[120px] flex-col items-center">
                <div
                  className="mb-1 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Floor vs Ceiling
                </div>
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-black/20">
                  <div
                    className="h-full bg-emerald-500/60 transition-all duration-500"
                    style={{ width: `${floorPct}%` }}
                  />
                  <div
                    className="h-full bg-amber-500/60 transition-all duration-500"
                    style={{ width: `${ceilPct}%` }}
                  />
                </div>
                <div className="mt-0.5 flex w-full justify-between font-mono text-[9px]">
                  <span className="text-emerald-400/80">{floorPct}% floor</span>
                  <span className="text-amber-400/80">{ceilPct}% ceiling</span>
                </div>
              </div>

              {/* Nearest resistance */}
              <div className="text-right">
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  Resistance
                </div>
                {bias.nearestResistance ? (
                  <>
                    <div className="font-mono text-[13px] font-semibold text-amber-400">
                      {bias.nearestResistance.strike.toLocaleString()}
                    </div>
                    <div
                      className="font-mono text-[10px]"
                      style={{ color: 'var(--color-secondary)' }}
                    >
                      {CLASS_META[bias.nearestResistance.cls].badge}
                      {' · '}
                      {bias.nearestResistance.hardening
                        ? 'hardening'
                        : 'softening'}
                    </div>
                  </>
                ) : (
                  <div
                    className="font-mono text-[13px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    —
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="h-full w-px bg-white/10" />

              {/* GEX gravity */}
              <div>
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  GEX Gravity
                </div>
                <div
                  className="font-mono text-[13px] font-semibold"
                  style={{ color: 'var(--color-primary)' }}
                >
                  {bias.gravityOffset === 0
                    ? 'ATM'
                    : `${bias.gravityOffset > 0 ? '↑' : '↓'} ${Math.abs(bias.gravityOffset)}pts`}
                </div>
                <div
                  className="font-mono text-[10px]"
                  style={{ color: 'var(--color-secondary)' }}
                >
                  {bias.gravityStrike.toLocaleString()} ·{' '}
                  {fmtGex(bias.gravityGex)}
                </div>
              </div>

              {/* Divider */}
              <div className="h-full w-px bg-white/10" />

              {/* Floor / ceiling trends */}
              <div>
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  1m Trend
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span
                    className="font-mono text-[9px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Floor
                  </span>
                  <span
                    className="font-mono text-[12px] font-semibold"
                    style={{ color: floorTrendColor }}
                  >
                    {fmtPct(bias.floorTrend)}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span
                    className="font-mono text-[9px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Ceil
                  </span>
                  <span
                    className="font-mono text-[12px] font-semibold"
                    style={{ color: ceilTrendColor }}
                  >
                    {fmtPct(bias.ceilingTrend)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="border-edge overflow-hidden rounded-lg border">
        {/* Sticky column header */}
        <div
          className={`border-edge-heavy bg-surface-alt sticky top-0 grid border-b font-mono text-[10px] font-semibold tracking-wider uppercase ${cols}`}
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
                        s.netCharm >= 0
                          ? 'rgba(74,222,128,0.75)'
                          : 'rgba(248,113,113,0.75)',
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
            [
              'max-launchpad',
              'Neg γ + Pos θ_t — accelerant, builds into close',
            ],
            [
              'fading-launchpad',
              'Neg γ + Neg θ_t — accelerant that weakens over time',
            ],
            [
              'sticky-pin',
              'Pos γ + Pos θ_t — wall that strengthens into close',
            ],
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
