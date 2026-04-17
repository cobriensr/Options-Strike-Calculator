/**
 * Owns all view state for the GexPerStrike panel plus the derived memos
 * that depend on it (windowed/filtered strikes, per-metric maxes, summary
 * aggregates). Pulling these out of the orchestrator keeps the component
 * purely a layout shell.
 */

import { useCallback, useMemo, useState } from 'react';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import { getNetCharm, getNetGamma, getNetVanna, type ViewMode } from './mode';
import type { GexSummary } from './SummaryCards';

const DEFAULT_VISIBLE = 15;
const MIN_VISIBLE = 5;
const MAX_VISIBLE = 50;
const STEP = 5;
const TRADING_MINUTES_PER_DAY = 390;

export const GEX_VIEW_LIMITS = {
  MIN_VISIBLE,
  MAX_VISIBLE,
} as const;

export interface GexViewState {
  visibleCount: number;
  viewMode: ViewMode;
  showCharm: boolean;
  showVanna: boolean;
  showDex: boolean;
  hovered: number | null;
  mousePos: { x: number; y: number };
  filtered: GexStrikeLevel[];
  price: number;
  maxGex: number;
  maxCharm: number;
  maxVanna: number;
  maxDelta: number;
  summary: GexSummary;
  setViewMode: (m: ViewMode) => void;
  toggleCharm: () => void;
  toggleVanna: () => void;
  toggleDex: () => void;
  handleLess: () => void;
  handleMore: () => void;
  handleHoverEnter: (idx: number, x: number, y: number) => void;
  handleHoverMove: (x: number, y: number) => void;
  handleHoverLeave: () => void;
}

export function useGexViewState(strikes: GexStrikeLevel[]): GexViewState {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);
  const [viewMode, setViewMode] = useState<ViewMode>('oi');
  const [showCharm, setShowCharm] = useState(true);
  const [showVanna, setShowVanna] = useState(true);
  const [showDex, setShowDex] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const price = strikes.length > 0 ? strikes[0]!.price : 0;

  const filtered = useMemo(() => {
    if (strikes.length === 0) return [];
    const atmIdx = strikes.findIndex((s) => s.strike >= price);
    const center = atmIdx >= 0 ? atmIdx : Math.floor(strikes.length / 2);
    const half = Math.floor(visibleCount / 2);
    const lo = Math.max(0, center - half);
    const hi = Math.min(strikes.length, lo + visibleCount);
    const window = strikes.slice(Math.max(0, hi - visibleCount), hi);
    return [...window].reverse();
  }, [strikes, price, visibleCount]);

  const { maxGex, maxCharm, maxVanna, maxDelta } = useMemo(() => {
    if (filtered.length === 0)
      return { maxGex: 1, maxCharm: 1, maxVanna: 1, maxDelta: 1 };
    return {
      maxGex: Math.max(
        ...filtered.map((d) => Math.abs(getNetGamma(d, viewMode))),
        1,
      ),
      maxCharm: Math.max(
        ...filtered.map((d) => Math.abs(getNetCharm(d, viewMode))),
        1,
      ),
      maxDelta: Math.max(...filtered.map((d) => Math.abs(d.netDelta)), 1),
      maxVanna: Math.max(
        ...filtered.map((d) => Math.abs(getNetVanna(d, viewMode))),
        1,
      ),
    };
  }, [filtered, viewMode]);

  const summary = useMemo<GexSummary>(() => {
    const totalGex = filtered.reduce((s, d) => s + getNetGamma(d, viewMode), 0);
    const totalCharm = filtered.reduce(
      (s, d) => s + getNetCharm(d, viewMode),
      0,
    );
    const totalVanna = filtered.reduce(
      (s, d) => s + getNetVanna(d, viewMode),
      0,
    );

    const totalGexOi = filtered.reduce((s, d) => s + d.netGamma, 0);
    const totalGexVol = filtered.reduce((s, d) => s + d.netGammaVol, 0);
    let flowPressurePct = 0;
    let flowSign: GexSummary['flowSign'] = 'neutral';
    if (Math.abs(totalGexOi) > 0) {
      flowPressurePct = (Math.abs(totalGexVol) / Math.abs(totalGexOi)) * 100;
      if (totalGexVol !== 0) {
        flowSign =
          totalGexOi > 0 === totalGexVol > 0 ? 'reinforcing' : 'opposing';
      }
    }

    const charmBurnRate = totalCharm / TRADING_MINUTES_PER_DAY;

    // GEX flip: full-array scan for the strike closest to spot where net
    // gamma sign flips. Uses the full strikes array so window size doesn't
    // alter the answer.
    let flipStrike = '—';
    let closestDist = Infinity;
    for (let i = 1; i < strikes.length; i++) {
      const prev = getNetGamma(strikes[i - 1]!, viewMode);
      const curr = getNetGamma(strikes[i]!, viewMode);
      if (prev === 0 || curr === 0) continue;
      if (Math.sign(prev) !== Math.sign(curr)) {
        const dist = Math.abs(strikes[i]!.strike - price);
        if (dist < closestDist) {
          closestDist = dist;
          flipStrike = String(strikes[i]!.strike);
        }
      }
    }

    return {
      totalGex,
      totalCharm,
      totalVanna,
      flipStrike,
      flowPressurePct,
      flowSign,
      charmBurnRate,
    };
  }, [filtered, strikes, viewMode, price]);

  const handleLess = useCallback(
    () => setVisibleCount((v) => Math.max(v - STEP, MIN_VISIBLE)),
    [],
  );
  const handleMore = useCallback(
    () => setVisibleCount((v) => Math.min(v + STEP, MAX_VISIBLE)),
    [],
  );
  const handleHoverEnter = useCallback((idx: number, x: number, y: number) => {
    setHovered(idx);
    setMousePos({ x, y });
  }, []);
  const handleHoverMove = useCallback(
    (x: number, y: number) => setMousePos({ x, y }),
    [],
  );
  const handleHoverLeave = useCallback(() => setHovered(null), []);
  const toggleCharm = useCallback(() => setShowCharm((v) => !v), []);
  const toggleVanna = useCallback(() => setShowVanna((v) => !v), []);
  const toggleDex = useCallback(() => setShowDex((v) => !v), []);

  return {
    visibleCount,
    viewMode,
    showCharm,
    showVanna,
    showDex,
    hovered,
    mousePos,
    filtered,
    price,
    maxGex,
    maxCharm,
    maxVanna,
    maxDelta,
    summary,
    setViewMode,
    toggleCharm,
    toggleVanna,
    toggleDex,
    handleLess,
    handleMore,
    handleHoverEnter,
    handleHoverMove,
    handleHoverLeave,
  };
}
