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

interface DriftTarget {
  strike: number;
  cls: GexClassification;
  netGamma: number;
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral';
}

interface BiasMetrics {
  verdict:
    | 'gex-pull-up'
    | 'gex-pull-down'
    | 'breakout-risk-up'
    | 'breakdown-risk-down'
    | 'rangebound'
    | 'volatile';
  regime: 'positive' | 'negative'; // sign of total net GEX across all strikes
  totalNetGex: number;
  gravityStrike: number; // strike with the largest absolute GEX
  gravityOffset: number; // signed distance from spot (+ = above, − = below)
  gravityGex: number; // netGamma at that strike
  upsideTargets: DriftTarget[]; // top 2 above spot by |netGamma|
  downsideTargets: DriftTarget[]; // top 2 below spot by |netGamma|
  floorTrend: number | null; // avg 1m Δ% for below-spot strikes
  ceilingTrend: number | null; // avg 1m Δ% for above-spot strikes
  floorTrend5m: number | null; // avg 5m Δ% for below-spot strikes
  ceilingTrend5m: number | null; // avg 5m Δ% for above-spot strikes
}

interface VerdictMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  desc: string;
}

const VERDICT_META: Record<BiasMetrics['verdict'], VerdictMeta> = {
  'gex-pull-up': {
    label: '↑ GEX PULL',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15',
    border: 'border-emerald-500/30',
    desc: 'Largest GEX wall is above spot — MMs will pull price toward it',
  },
  'gex-pull-down': {
    label: '↓ GEX PULL',
    color: 'text-red-400',
    bg: 'bg-red-500/15',
    border: 'border-red-500/30',
    desc: 'Largest GEX wall is below spot — MMs will pull price toward it',
  },
  'breakout-risk-up': {
    label: '↑ BREAKOUT RISK',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    desc: 'Neg GEX regime — dealers amplify moves; largest wall above spot may give',
  },
  'breakdown-risk-down': {
    label: '↓ BREAKDOWN RISK',
    color: 'text-orange-400',
    bg: 'bg-orange-500/15',
    border: 'border-orange-500/30',
    desc: 'Neg GEX regime — dealers amplify moves; largest wall below spot may give',
  },
  rangebound: {
    label: '● RANGE-BOUND',
    color: 'text-sky-400',
    bg: 'bg-sky-500/15',
    border: 'border-sky-500/30',
    desc: 'Positive GEX regime — dealers counter moves; price pinned near largest wall',
  },
  volatile: {
    label: '⚡ VOLATILE',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/30',
    desc: 'Negative GEX regime — dealers amplify moves in both directions; follow breakouts',
  },
};

const VERDICT_TOOLTIP: Record<BiasMetrics['verdict'], string> = {
  'gex-pull-up':
    'The biggest GEX wall is above current price. MMs are long gamma there — as price rises toward it, they buy shares to stay hedged, which helps pull price up. Watch your upside drift targets for where price may go.',
  'gex-pull-down':
    'The biggest GEX wall is below current price. MMs are long gamma there — as price falls toward it, they sell shares to stay hedged, which helps pull price down. Watch your downside drift targets for where price may go.',
  'breakout-risk-up':
    'Total GEX is negative — MMs are short gamma and amplify moves instead of dampening them. The biggest concentration is above spot. If price breaks through that level, dealers buy more and add fuel to the rally.',
  'breakdown-risk-down':
    'Total GEX is negative — MMs are short gamma and amplify moves instead of dampening them. The biggest concentration is below spot. If price breaks through that level, dealers sell more and add fuel to the decline.',
  rangebound:
    'Total GEX is positive and the biggest wall is close to spot. MMs are countering moves from both sides — selling into rallies, buying into dips. Expect a choppy day. Fade moves toward the edges rather than chasing breakouts.',
  volatile:
    'Total GEX is negative and the biggest concentration is near spot. MMs amplify moves without a clear directional pull. A breakout in either direction can accelerate fast. Wait for a clear move before committing to a direction.',
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
 * Algorithm:
 *   Regime  = sign of total net GEX across all strikes in the window
 *             Positive → dealers counter moves (dampened / range-bound day)
 *             Negative → dealers amplify moves  (trending / volatile day)
 *
 *   Gravity = strike with the largest |netGamma| above or below spot
 *             This is where MMs have the heaviest hedge book — price drifts toward it
 *
 *   Verdict = gravity direction × regime
 *             Above + Positive → gex-pull-up        (MMs pull price up to wall)
 *             Above + Negative → breakout-risk-up    (no dampener above; acceleration risk)
 *             Below + Positive → gex-pull-down       (MMs pull price down to wall)
 *             Below + Negative → breakdown-risk-down (no dampener below; breakdown risk)
 *             ATM   + Positive → rangebound
 *             ATM   + Negative → volatile
 */
function computeBias(
  rows: GexStrikeLevel[],
  currentPrice: number,
  gexDeltaMap: Map<number, number | null>,
  gexDelta5mMap: Map<number, number | null>,
): BiasMetrics {
  const above = rows.filter((s) => s.strike > currentPrice + SPOT_BAND);
  const below = rows.filter((s) => s.strike < currentPrice - SPOT_BAND);

  // Regime: sign of total net GEX
  let totalNetGex = 0;
  for (const s of rows) totalNetGex += s.netGamma;
  const regime: 'positive' | 'negative' =
    totalNetGex >= 0 ? 'positive' : 'negative';

  // GEX gravity: strike with the largest absolute GEX above or below spot
  let gravityRow: GexStrikeLevel | null = null;
  for (const s of [...above, ...below]) {
    if (
      gravityRow === null ||
      Math.abs(s.netGamma) > Math.abs(gravityRow.netGamma)
    ) {
      gravityRow = s;
    }
  }
  const gravityOffset = gravityRow ? gravityRow.strike - currentPrice : 0;

  // Verdict: gravity direction × regime
  let verdict: BiasMetrics['verdict'];
  if (Math.abs(gravityOffset) <= SPOT_BAND) {
    verdict = regime === 'negative' ? 'volatile' : 'rangebound';
  } else if (gravityOffset > 0) {
    verdict = regime === 'negative' ? 'breakout-risk-up' : 'gex-pull-up';
  } else {
    verdict = regime === 'negative' ? 'breakdown-risk-down' : 'gex-pull-down';
  }

  // Drift targets: top 2 above and below spot by |netGamma|
  const byAbsGex = (a: GexStrikeLevel, b: GexStrikeLevel) =>
    Math.abs(b.netGamma) - Math.abs(a.netGamma);
  const toTarget = (s: GexStrikeLevel): DriftTarget => ({
    strike: s.strike,
    cls: classify(s.netGamma, s.netCharm),
    netGamma: s.netGamma,
    volReinforcement: s.volReinforcement,
  });
  const upsideTargets = [...above].sort(byAbsGex).slice(0, 2).map(toTarget);
  const downsideTargets = [...below].sort(byAbsGex).slice(0, 2).map(toTarget);

  // Aggregate 1m Δ% trends above and below spot
  const avg = (vals: (number | null | undefined)[]) => {
    let sum = 0;
    let count = 0;
    for (const v of vals) {
      if (v !== null && v !== undefined) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  };

  return {
    verdict,
    regime,
    totalNetGex,
    gravityStrike: gravityRow?.strike ?? currentPrice,
    gravityOffset,
    gravityGex: gravityRow?.netGamma ?? 0,
    upsideTargets,
    downsideTargets,
    floorTrend: avg(below.map((s) => gexDeltaMap.get(s.strike))),
    ceilingTrend: avg(above.map((s) => gexDeltaMap.get(s.strike))),
    floorTrend5m: avg(below.map((s) => gexDelta5mMap.get(s.strike))),
    ceilingTrend5m: avg(above.map((s) => gexDelta5mMap.get(s.strike))),
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
    return computeBias(base, currentPrice, gexDeltaMap, gexDelta5mMap);
  }, [smoothedRows, rows, currentPrice, gexDeltaMap, gexDelta5mMap]);

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
        const floorTrend5mColor =
          bias.floorTrend5m === null
            ? 'var(--color-muted)'
            : bias.floorTrend5m >= 0
              ? '#4ade80'
              : '#f87171';
        const ceilTrend5mColor =
          bias.ceilingTrend5m === null
            ? 'var(--color-muted)'
            : bias.ceilingTrend5m <= 0
              ? '#4ade80'
              : '#fbbf24';
        return (
          <div className={`mb-3 rounded-lg border p-3 ${vm.bg} ${vm.border}`}>
            {/* Verdict + Regime */}
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={`cursor-help rounded border px-2 py-0.5 font-mono text-[11px] font-bold ${vm.color} ${vm.bg} ${vm.border}`}
                  title={VERDICT_TOOLTIP[bias.verdict]}
                >
                  {vm.label}
                </span>
                <span className="text-secondary font-mono text-[11px]">
                  {vm.desc}
                </span>
              </div>
              <span
                className={`shrink-0 cursor-help rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${bias.regime === 'positive' ? 'bg-sky-500/20 text-sky-400' : 'bg-amber-500/20 text-amber-400'}`}
                title={
                  bias.regime === 'positive'
                    ? 'MMs are net long gamma — they trade against moves, buying dips and selling rips like shock absorbers. Expect tighter ranges and faded breakouts today.'
                    : 'MMs are net short gamma — they trade with moves, buying rallies and selling drops like fuel. Expect wider ranges and breakouts that accelerate today.'
                }
              >
                {bias.regime === 'positive' ? 'POS GEX — dampened' : 'NEG GEX — trending'}
                {' '}
                <span className="font-normal opacity-70">
                  {fmtGex(bias.totalNetGex)}
                </span>
              </span>
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-[auto_1px_1fr_1px_1fr_1px_auto_1px_auto] items-start gap-x-4">
              {/* GEX gravity */}
              <div
                className="cursor-help"
                title="The single strike with the largest absolute GEX in the window. This is where MMs have the heaviest hedge book and do the most delta hedging. Price naturally drifts toward this level over the session."
              >
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

              {/* Upside drift targets */}
              <div
                title="Top 2 strikes above spot by absolute GEX — where the most MM hedging activity sits overhead. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
              >
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  ↑ Drift Targets
                </div>
                {bias.upsideTargets.length === 0 ? (
                  <div
                    className="font-mono text-[12px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    —
                  </div>
                ) : (
                  bias.upsideTargets.map((t) => {
                    const isConfluence =
                      t.strike === maxChanged1mStrike ||
                      t.strike === maxChanged5mStrike;
                    return (
                      <div
                        key={t.strike}
                        className="flex items-baseline gap-1.5"
                        title={CLS_TOOLTIP[t.cls]}
                      >
                        <span className="font-mono text-[12px] font-semibold text-emerald-400">
                          {t.strike.toLocaleString()}
                        </span>
                        <span
                          className={`font-mono text-[9px] ${CLASS_META[t.cls].badgeText}`}
                        >
                          {CLASS_META[t.cls].badge}
                        </span>
                        <span
                          className="font-mono text-[9px]"
                          style={{
                            color: t.netGamma >= 0 ? '#4ade80' : '#fbbf24',
                          }}
                        >
                          {fmtGex(t.netGamma)}
                        </span>
                        {t.volReinforcement === 'reinforcing' && (
                          <span
                            className="font-mono text-[9px] text-emerald-400"
                            title="Volume confirms OI structure here"
                          >
                            ✓
                          </span>
                        )}
                        {t.volReinforcement === 'opposing' && (
                          <span
                            className="font-mono text-[9px] text-red-400"
                            title="Volume contradicts OI structure here"
                          >
                            ✗
                          </span>
                        )}
                        {isConfluence && (
                          <span
                            className="font-mono text-[9px] text-amber-400"
                            title="Most actively changing GEX level — high-conviction target"
                          >
                            ⚡
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Divider */}
              <div className="h-full w-px bg-white/10" />

              {/* Downside drift targets */}
              <div
                title="Top 2 strikes below spot by absolute GEX — where the most MM hedging activity sits below you. Positive regime: price gets pulled toward the first target. Negative regime: a break through can accelerate toward the second."
              >
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  ↓ Drift Targets
                </div>
                {bias.downsideTargets.length === 0 ? (
                  <div
                    className="font-mono text-[12px]"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    —
                  </div>
                ) : (
                  bias.downsideTargets.map((t) => {
                    const isConfluence =
                      t.strike === maxChanged1mStrike ||
                      t.strike === maxChanged5mStrike;
                    return (
                      <div
                        key={t.strike}
                        className="flex items-baseline gap-1.5"
                        title={CLS_TOOLTIP[t.cls]}
                      >
                        <span className="font-mono text-[12px] font-semibold text-red-400">
                          {t.strike.toLocaleString()}
                        </span>
                        <span
                          className={`font-mono text-[9px] ${CLASS_META[t.cls].badgeText}`}
                        >
                          {CLASS_META[t.cls].badge}
                        </span>
                        <span
                          className="font-mono text-[9px]"
                          style={{
                            color: t.netGamma >= 0 ? '#4ade80' : '#fbbf24',
                          }}
                        >
                          {fmtGex(t.netGamma)}
                        </span>
                        {t.volReinforcement === 'reinforcing' && (
                          <span
                            className="font-mono text-[9px] text-emerald-400"
                            title="Volume confirms OI structure here"
                          >
                            ✓
                          </span>
                        )}
                        {t.volReinforcement === 'opposing' && (
                          <span
                            className="font-mono text-[9px] text-red-400"
                            title="Volume contradicts OI structure here"
                          >
                            ✗
                          </span>
                        )}
                        {isConfluence && (
                          <span
                            className="font-mono text-[9px] text-amber-400"
                            title="Most actively changing GEX level — high-conviction target"
                          >
                            ⚡
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Divider */}
              <div className="h-full w-px bg-white/10" />

              {/* 1m Trend */}
              <div
                className="cursor-help"
                title="Average % change in net GEX for strikes above (Ceil) and below (Floor) spot vs. the last 1-minute snapshot. Floor growing (green) = support hardening. Ceiling growing (amber) = resistance building. Ceiling shrinking (green) = that overhead wall is weakening."
              >
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

              {/* Divider */}
              <div className="h-full w-px bg-white/10" />

              {/* 5m Trend */}
              <div
                className="cursor-help"
                title="Average % change in net GEX for strikes above (Ceil) and below (Floor) spot vs. the snapshot 5 minutes ago. Confirms whether the 1m trend is part of a sustained move or just a brief spike."
              >
                <div
                  className="mb-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                  style={{ color: 'var(--color-tertiary)' }}
                >
                  5m Trend
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
                    style={{ color: floorTrend5mColor }}
                  >
                    {fmtPct(bias.floorTrend5m)}
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
                    style={{ color: ceilTrend5mColor }}
                  >
                    {fmtPct(bias.ceilingTrend5m)}
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
