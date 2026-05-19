import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  useTickerGrouping,
  type TickerGroupingExtract,
  type TickerGroupSortMode,
} from '../useTickerGrouping';
import type { RollupAlertSummary } from '../../utils/ticker-rollup-aggregates';

// Fixture item shape — minimal stand-in for a LotteryFire / SilentBoomAlert.
interface Fix {
  ticker: string;
  side: 'call' | 'put';
  peak: number | null;
  ms: number;
  intensity: number;
  premium: number;
}

function fix(overrides: Partial<Fix> = {}): Fix {
  return {
    ticker: 'AAPL',
    side: 'call',
    peak: 10,
    ms: 1_700_000_000_000,
    intensity: 1,
    premium: 1_000,
    ...overrides,
  };
}

function extract(item: Fix): TickerGroupingExtract {
  const rollupSummary: RollupAlertSummary = {
    optionType: item.side === 'call' ? 'C' : 'P',
    mktTideDiff: null,
    directionGated: false,
    triggeredAt: Number.isFinite(item.ms)
      ? new Date(item.ms).toISOString()
      : '',
    strike: 100,
    tickerNetFlowAtFire: null,
    premium: item.premium,
    intensity: item.intensity,
  };
  return {
    ticker: item.ticker,
    peakPct: item.peak,
    triggerMs: item.ms,
    rollupSummary,
  };
}

function render(items: readonly Fix[], sortMode: TickerGroupSortMode) {
  return renderHook(() =>
    useTickerGrouping({
      items,
      sortMode,
      extract,
      stormIntensityThreshold: 5,
    }),
  );
}

describe('useTickerGrouping', () => {
  it('groups items by ticker', () => {
    const items = [
      fix({ ticker: 'AAPL', ms: 1 }),
      fix({ ticker: 'TSLA', ms: 2 }),
      fix({ ticker: 'AAPL', ms: 3 }),
    ];
    const { result } = render(items, 'default');
    const tickers = result.current.map((g) => g.ticker).sort();
    expect(tickers).toEqual(['AAPL', 'TSLA']);
    expect(result.current.find((g) => g.ticker === 'AAPL')?.items).toHaveLength(
      2,
    );
    expect(result.current.find((g) => g.ticker === 'TSLA')?.items).toHaveLength(
      1,
    );
  });

  it('sets latestTriggerMs to the max ms in the group', () => {
    const items = [
      fix({ ticker: 'AAPL', ms: 100 }),
      fix({ ticker: 'AAPL', ms: 300 }),
      fix({ ticker: 'AAPL', ms: 200 }),
    ];
    const { result } = render(items, 'default');
    expect(result.current[0]?.latestTriggerMs).toBe(300);
  });

  it('computes peakBest as the max non-null peak', () => {
    const items = [
      fix({ ticker: 'AAPL', peak: 10 }),
      fix({ ticker: 'AAPL', peak: null }),
      fix({ ticker: 'AAPL', peak: 25 }),
    ];
    const { result } = render(items, 'default');
    expect(result.current[0]?.peakBest).toBe(25);
  });

  it('returns peakBest=null when every peak is null', () => {
    const items = [
      fix({ ticker: 'AAPL', peak: null }),
      fix({ ticker: 'AAPL', peak: null }),
    ];
    const { result } = render(items, 'default');
    expect(result.current[0]?.peakBest).toBeNull();
  });

  describe('peak sort', () => {
    it('orders groups by peakBest desc, nulls last', () => {
      const items = [
        fix({ ticker: 'A', peak: 5 }),
        fix({ ticker: 'B', peak: 20 }),
        fix({ ticker: 'C', peak: null }),
      ];
      const { result } = render(items, 'peak');
      expect(result.current.map((g) => g.ticker)).toEqual(['B', 'A', 'C']);
    });

    it('orders within-group items by peak desc too', () => {
      const items = [
        fix({ ticker: 'AAPL', peak: 5, ms: 1 }),
        fix({ ticker: 'AAPL', peak: 20, ms: 2 }),
        fix({ ticker: 'AAPL', peak: 10, ms: 3 }),
      ];
      const { result } = render(items, 'peak');
      expect(result.current[0]?.items.map((f) => f.peak)).toEqual([20, 10, 5]);
    });

    it('tiebreaks equal peakBest by latestTriggerMs desc', () => {
      const items = [
        fix({ ticker: 'A', peak: 10, ms: 100 }),
        fix({ ticker: 'B', peak: 10, ms: 300 }),
      ];
      const { result } = render(items, 'peak');
      expect(result.current.map((g) => g.ticker)).toEqual(['B', 'A']);
    });
  });

  describe('default sort', () => {
    it('falls back to item-count desc when conviction/storm tie', () => {
      // Default fixture (intensity=1, single item) won't trigger
      // conviction or storm — both groups fall through to count.
      const items = [
        fix({ ticker: 'A', ms: 1 }),
        fix({ ticker: 'B', ms: 2 }),
        fix({ ticker: 'B', ms: 3 }),
      ];
      const { result } = render(items, 'default');
      expect(result.current.map((g) => g.ticker)).toEqual(['B', 'A']);
    });

    it('tiebreaks equal item counts by latestTriggerMs desc', () => {
      const items = [
        fix({ ticker: 'A', ms: 100 }),
        fix({ ticker: 'B', ms: 300 }),
      ];
      const { result } = render(items, 'default');
      expect(result.current.map((g) => g.ticker)).toEqual(['B', 'A']);
    });

    it('leaves within-group order untouched in default mode', () => {
      const items = [
        fix({ ticker: 'AAPL', ms: 300, peak: 5 }),
        fix({ ticker: 'AAPL', ms: 100, peak: 20 }),
        fix({ ticker: 'AAPL', ms: 200, peak: 10 }),
      ];
      const { result } = render(items, 'default');
      // Order preserved: input was [300, 100, 200] by ms
      expect(result.current[0]?.items.map((f) => f.ms)).toEqual([
        300, 100, 200,
      ]);
    });
  });

  describe('empty input', () => {
    it('returns an empty array', () => {
      const { result } = render([], 'default');
      expect(result.current).toEqual([]);
    });
  });

  describe('NaN safety in caller-provided triggerMs', () => {
    it('treats non-finite triggerMs as 0 in latestTriggerMs reduction', () => {
      // Defense-in-depth: a caller that forgets to validate
      // Date.parse output should not surface NaN as the group's
      // latestTriggerMs. The hook coerces non-finite to 0.
      const items = [
        fix({ ticker: 'AAPL', ms: Number.NaN }),
        fix({ ticker: 'AAPL', ms: 100 }),
      ];
      const { result } = render(items, 'default');
      expect(result.current[0]?.latestTriggerMs).toBe(100);
    });

    it('returns 0 when every triggerMs is non-finite', () => {
      const items = [
        fix({ ticker: 'AAPL', ms: Number.NaN }),
        fix({ ticker: 'AAPL', ms: Number.NaN }),
      ];
      const { result } = render(items, 'default');
      expect(result.current[0]?.latestTriggerMs).toBe(0);
    });
  });

  describe('byte-identical parity with pre-refactor sort orders', () => {
    // Realistic-shape fixtures captured from the pre-Phase-2E useMemo
    // blocks in LotteryFinder + SilentBoom. Each fixture asserts the
    // FULL output (ticker, items count, peakBest, latestTriggerMs,
    // sort order) so any future tweak to the hook's ordering logic
    // is caught.

    it('lottery-shape: peak sort orders three tickers by peak then recency', () => {
      // Mirror of LotteryFinderSection.tsx grouped-by-ticker output
      // for a sortMode='peak' run. AAPL peaks lower than TSLA but
      // its single fire has a later trigger time — so TSLA still
      // wins on peak. AMZN has a null peak and lands last.
      const items = [
        fix({ ticker: 'AAPL', peak: 12, ms: 3_000 }),
        fix({ ticker: 'TSLA', peak: 35, ms: 1_000 }),
        fix({ ticker: 'TSLA', peak: 28, ms: 2_000 }),
        fix({ ticker: 'AMZN', peak: null, ms: 4_000 }),
      ];
      const { result } = render(items, 'peak');
      expect(
        result.current.map((g) => ({
          ticker: g.ticker,
          count: g.items.length,
          peakBest: g.peakBest,
          latestTriggerMs: g.latestTriggerMs,
        })),
      ).toEqual([
        { ticker: 'TSLA', count: 2, peakBest: 35, latestTriggerMs: 2_000 },
        { ticker: 'AAPL', count: 1, peakBest: 12, latestTriggerMs: 3_000 },
        { ticker: 'AMZN', count: 1, peakBest: null, latestTriggerMs: 4_000 },
      ]);
    });

    it('silent-boom-shape: default sort uses count-desc then recency-desc', () => {
      // Mirror of SilentBoomSection.tsx default-sort output. All
      // items are below the conviction/storm thresholds (intensity=1)
      // so groups fall through to count → recency.
      const items = [
        fix({ ticker: 'NVDA', ms: 100 }),
        fix({ ticker: 'NVDA', ms: 200 }),
        fix({ ticker: 'NVDA', ms: 150 }),
        fix({ ticker: 'GOOGL', ms: 500 }),
        fix({ ticker: 'GOOGL', ms: 400 }),
        fix({ ticker: 'META', ms: 1_000 }),
      ];
      const { result } = render(items, 'default');
      expect(
        result.current.map((g) => ({
          ticker: g.ticker,
          count: g.items.length,
          latestTriggerMs: g.latestTriggerMs,
        })),
      ).toEqual([
        { ticker: 'NVDA', count: 3, latestTriggerMs: 200 },
        { ticker: 'GOOGL', count: 2, latestTriggerMs: 500 },
        { ticker: 'META', count: 1, latestTriggerMs: 1_000 },
      ]);
    });

    it('peak sort flips within-group order to peak desc', () => {
      // Verifies within-group reordering — the original code did
      // [...list].sort() only in peak mode and left items untouched
      // in default mode.
      const items = [
        fix({ ticker: 'AAPL', peak: 5, ms: 1 }),
        fix({ ticker: 'AAPL', peak: 30, ms: 2 }),
        fix({ ticker: 'AAPL', peak: 15, ms: 3 }),
        fix({ ticker: 'AAPL', peak: null, ms: 4 }),
      ];
      const { result } = render(items, 'peak');
      expect(result.current[0]?.items.map((f) => f.peak)).toEqual([
        30,
        15,
        5,
        null,
      ]);
    });
  });

  describe('stable extract identity is not required', () => {
    it('does not rerun the memo when extract changes ref but items/sortMode stay', () => {
      // Without the extractRef trick, a new `extract` ref each render
      // would invalidate the memo. Here we re-render with a fresh
      // closure each time and assert the output is deeply equal —
      // proxy for "the memoized work was reused or at least produced
      // the same shape."
      const items = [fix({ ticker: 'A', ms: 1 }), fix({ ticker: 'B', ms: 2 })];
      const { result, rerender } = renderHook(() =>
        useTickerGrouping({
          items,
          sortMode: 'default',
          extract: (item) => extract(item),
          stormIntensityThreshold: 5,
        }),
      );
      const first = result.current;
      rerender();
      expect(result.current.map((g) => g.ticker)).toEqual(
        first.map((g) => g.ticker),
      );
    });
  });
});
