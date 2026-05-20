import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStrategyInputs } from '../useStrategyInputs';

describe('useStrategyInputs', () => {
  describe('IC & skew defaults', () => {
    it('seeds wingWidth=20, showIC=true, contracts=20, skewPct=3, clusterMult=1', () => {
      const { result } = renderHook(() => useStrategyInputs());
      expect(result.current.wingWidth).toBe(20);
      expect(result.current.showIC).toBe(true);
      expect(result.current.contracts).toBe(20);
      expect(result.current.skewPct).toBe(3);
      expect(result.current.clusterMult).toBe(1);
    });
  });

  describe('Hedge defaults', () => {
    it('seeds breakevenTarget=1.5 (moderate coverage)', () => {
      const { result } = renderHook(() => useStrategyInputs());
      expect(result.current.breakevenTarget).toBe(1.5);
    });
  });

  describe('BWB defaults', () => {
    it('seeds showBWB=false, bwbNarrowWidth=20, bwbWideMultiplier=2', () => {
      const { result } = renderHook(() => useStrategyInputs());
      expect(result.current.showBWB).toBe(false);
      expect(result.current.bwbNarrowWidth).toBe(20);
      expect(result.current.bwbWideMultiplier).toBe(2);
    });
  });

  describe('Portfolio risk gate default', () => {
    it('seeds portfolioRiskThresholdPct=12 (FE-STATE-006 mid-range)', () => {
      const { result } = renderHook(() => useStrategyInputs());
      expect(result.current.portfolioRiskThresholdPct).toBe(12);
    });
  });

  describe('setters', () => {
    it('updates IC fields', () => {
      const { result } = renderHook(() => useStrategyInputs());
      act(() => result.current.setWingWidth(25));
      act(() => result.current.setShowIC(false));
      act(() => result.current.setContracts(10));
      act(() => result.current.setSkewPct(5));
      act(() => result.current.setClusterMult(2));
      expect(result.current.wingWidth).toBe(25);
      expect(result.current.showIC).toBe(false);
      expect(result.current.contracts).toBe(10);
      expect(result.current.skewPct).toBe(5);
      expect(result.current.clusterMult).toBe(2);
    });

    it('updates hedge breakevenTarget', () => {
      const { result } = renderHook(() => useStrategyInputs());
      act(() => result.current.setBreakevenTarget(3.0));
      expect(result.current.breakevenTarget).toBe(3.0);
    });

    it('updates BWB fields', () => {
      const { result } = renderHook(() => useStrategyInputs());
      act(() => result.current.setShowBWB(true));
      act(() => result.current.setBwbNarrowWidth(15));
      act(() => result.current.setBwbWideMultiplier(3));
      expect(result.current.showBWB).toBe(true);
      expect(result.current.bwbNarrowWidth).toBe(15);
      expect(result.current.bwbWideMultiplier).toBe(3);
    });

    it('updates portfolioRiskThresholdPct', () => {
      const { result } = renderHook(() => useStrategyInputs());
      act(() => result.current.setPortfolioRiskThresholdPct(15));
      expect(result.current.portfolioRiskThresholdPct).toBe(15);
    });
  });
});
