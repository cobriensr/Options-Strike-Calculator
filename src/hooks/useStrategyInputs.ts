/**
 * useStrategyInputs — strategy / sizing / risk-control inputs.
 *
 * Owns three semantically distinct clusters that ended up grouped
 * here because they all configure the trade structure rather than
 * the market data:
 *
 *   1. IC & skew geometry
 *      - wingWidth (default 20)
 *      - showIC (default true)
 *      - contracts (default 20)
 *      - skewPct (default 3)
 *      - clusterMult (default 1)
 *
 *   2. Hedge sizing (FE-MATH-009)
 *      - breakevenTarget — multiplier of spot-to-hedge-strike
 *        distance used to size hedge contracts. 1.0 = cost-neutral,
 *        1.5 = default (moderate coverage), 3.0 = aggressive.
 *
 *   3. BWB (broken-wing butterfly) geometry
 *      - showBWB (default false)
 *      - bwbNarrowWidth (default 20)
 *      - bwbWideMultiplier (default 2)
 *
 *   4. Portfolio risk gate (FE-STATE-006)
 *      - portfolioRiskThresholdPct (default 12) — total effective
 *        max loss as % of NLV at which the warning fires. 12% is
 *        mid-range of audit's 10-15% suggestion.
 *
 * Extracted from useAppState in Phase 2P-1e.
 * Spec: docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18.md (Phase 2P)
 */

import { useState, type Dispatch, type SetStateAction } from 'react';

export interface UseStrategyInputsReturn {
  // IC & skew
  wingWidth: number;
  setWingWidth: Dispatch<SetStateAction<number>>;
  showIC: boolean;
  setShowIC: Dispatch<SetStateAction<boolean>>;
  contracts: number;
  setContracts: Dispatch<SetStateAction<number>>;
  skewPct: number;
  setSkewPct: Dispatch<SetStateAction<number>>;
  clusterMult: number;
  setClusterMult: Dispatch<SetStateAction<number>>;
  // Hedge
  breakevenTarget: number;
  setBreakevenTarget: Dispatch<SetStateAction<number>>;
  // BWB
  showBWB: boolean;
  setShowBWB: Dispatch<SetStateAction<boolean>>;
  bwbNarrowWidth: number;
  setBwbNarrowWidth: Dispatch<SetStateAction<number>>;
  bwbWideMultiplier: number;
  setBwbWideMultiplier: Dispatch<SetStateAction<number>>;
  // Portfolio risk gate
  portfolioRiskThresholdPct: number;
  setPortfolioRiskThresholdPct: Dispatch<SetStateAction<number>>;
}

export function useStrategyInputs(): UseStrategyInputsReturn {
  const [wingWidth, setWingWidth] = useState(20);
  const [showIC, setShowIC] = useState(true);
  const [contracts, setContracts] = useState(20);
  const [skewPct, setSkewPct] = useState(3);
  const [clusterMult, setClusterMult] = useState(1);

  // Hedge breakeven coverage target — audit FE-MATH-009.
  const [breakevenTarget, setBreakevenTarget] = useState(1.5);

  // BWB state
  const [showBWB, setShowBWB] = useState(false);
  const [bwbNarrowWidth, setBwbNarrowWidth] = useState(20);
  const [bwbWideMultiplier, setBwbWideMultiplier] = useState(2);

  // FE-STATE-006: aggregate portfolio risk threshold as % of NLV.
  const [portfolioRiskThresholdPct, setPortfolioRiskThresholdPct] =
    useState(12);

  return {
    wingWidth,
    setWingWidth,
    showIC,
    setShowIC,
    contracts,
    setContracts,
    skewPct,
    setSkewPct,
    clusterMult,
    setClusterMult,
    breakevenTarget,
    setBreakevenTarget,
    showBWB,
    setShowBWB,
    bwbNarrowWidth,
    setBwbNarrowWidth,
    bwbWideMultiplier,
    setBwbWideMultiplier,
    portfolioRiskThresholdPct,
    setPortfolioRiskThresholdPct,
  };
}
