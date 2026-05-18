// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every cross-module dependency takeit-detect imports. Each mock
// exposes a vi.fn so individual tests can override the implementation
// for branch coverage (bundle missing, prefetch throws, score throws).
vi.mock('../_lib/takeit-bundle-loader.js', () => ({
  getBundle: vi.fn(),
}));
vi.mock('../_lib/takeit-score.js', () => ({
  featuresFromRow: vi.fn(),
  predictTakeitScore: vi.fn(),
}));
vi.mock('../_lib/takeit-features.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/takeit-features.js')>();
  return {
    ...actual,
    featuresForLottery: vi.fn(),
    featuresForSilentBoom: vi.fn(),
  };
});
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

import {
  loadTakeitDetectContext,
  scoreLottery,
  scoreSilentBoom,
} from '../_lib/takeit-detect.js';
import { getBundle } from '../_lib/takeit-bundle-loader.js';
import { featuresFromRow, predictTakeitScore } from '../_lib/takeit-score.js';
import {
  featuresForLottery,
  featuresForSilentBoom,
} from '../_lib/takeit-features.js';
import { Sentry } from '../_lib/sentry.js';
import type {
  LotteryAlertRow,
  SilentBoomAlertRow,
} from '../_lib/takeit-features.js';

// Minimal fake bundle — the helpers under test never inspect its
// internals (those calls all hit the mocked predictTakeitScore /
// featuresFromRow). version is the only field surfaced back to the
// caller, so it has to be set.
const FAKE_BUNDLE = { version: 'test-v1' } as never;

const baseDeps = {
  fetchRecentSameType: vi.fn(),
  fetchRecentOtherTypeByChain: vi.fn(),
  fetchPriorSessionWinRateByTicker: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  baseDeps.fetchRecentSameType.mockResolvedValue([]);
  baseDeps.fetchRecentOtherTypeByChain.mockResolvedValue([]);
  baseDeps.fetchPriorSessionWinRateByTicker.mockResolvedValue([]);
});

describe('loadTakeitDetectContext', () => {
  it('returns null when getBundle resolves to null (bundle unreachable)', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(null);
    const ctx = await loadTakeitDetectContext('lottery', baseDeps);
    expect(ctx).toBeNull();
    // No prefetch fired
    expect(baseDeps.fetchRecentSameType).not.toHaveBeenCalled();
  });

  it('returns null + captures exception when getBundle throws (fail-closed)', async () => {
    vi.mocked(getBundle).mockRejectedValueOnce(new Error('schema mismatch'));
    const ctx = await loadTakeitDetectContext('lottery', baseDeps);
    expect(ctx).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('runs all three prefetches in parallel and builds the SequentialContext', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    baseDeps.fetchRecentSameType.mockResolvedValueOnce([
      {
        fire_time: new Date('2026-05-15T18:00:00Z'),
        underlying_symbol: 'NVDA',
        option_type: 'C',
      },
    ]);
    baseDeps.fetchRecentOtherTypeByChain.mockResolvedValueOnce([
      {
        option_chain_id: 'NVDA  260522P00225000',
        underlying_symbol: 'NVDA',
        option_type: 'P',
        fire_time: new Date('2026-05-15T17:58:00Z'),
      },
      {
        // Second row for the SAME chain — exercises the chainList push
        // branch (line 108 in takeit-detect.ts).
        option_chain_id: 'NVDA  260522P00225000',
        underlying_symbol: 'NVDA',
        option_type: 'P',
        fire_time: new Date('2026-05-15T17:59:00Z'),
      },
      {
        // Different chain, same ticker+option_type — exercises the
        // dirList push branch.
        option_chain_id: 'NVDA  260522P00230000',
        underlying_symbol: 'NVDA',
        option_type: 'P',
        fire_time: new Date('2026-05-15T17:55:00Z'),
      },
    ]);
    baseDeps.fetchPriorSessionWinRateByTicker.mockResolvedValueOnce([
      { underlying_symbol: 'NVDA', win_rate: 0.62 },
      { underlying_symbol: 'TSLA', win_rate: null },
    ]);

    const ctx = await loadTakeitDetectContext('lottery', baseDeps);
    expect(ctx).not.toBeNull();
    expect(ctx?.bundle).toBe(FAKE_BUNDLE);
    expect(ctx?.ctx.recentSameTypeFires).toHaveLength(1);
    expect(
      ctx?.ctx.recentOtherTypeByChain.get('NVDA  260522P00225000'),
    ).toHaveLength(2);
    expect(ctx?.ctx.recentOtherTypeByTickerDir.get('NVDA|P')).toHaveLength(3);
    expect(ctx?.ctx.priorSessionWinRateByTicker.get('NVDA')).toBe(0.62);
    expect(ctx?.ctx.priorSessionWinRateByTicker.get('TSLA')).toBeNull();
  });

  it('returns null + Sentry-captures when prefetch rejects', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    baseDeps.fetchRecentSameType.mockRejectedValueOnce(new Error('pg down'));
    const ctx = await loadTakeitDetectContext('lottery', baseDeps);
    expect(ctx).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      extra: { where: 'loadTakeitDetectContext.prefetch' },
    });
  });
});

describe('scoreLottery', () => {
  const detectCtx = {
    bundle: FAKE_BUNDLE,
    ctx: {
      recentSameTypeFires: [],
      recentOtherTypeByChain: new Map(),
      recentOtherTypeByTickerDir: new Map(),
      priorSessionWinRateByTicker: new Map(),
    },
  };
  const row = {
    option_chain_id: 'NVDA  260522P00225000',
    underlying_symbol: 'NVDA',
    option_type: 'P',
  } as LotteryAlertRow;

  it('returns null result when detectCtx is null (caller will skip scoring)', () => {
    const result = scoreLottery(null, row);
    expect(result).toEqual({ prob: null, version: null, features: null });
    expect(featuresForLottery).not.toHaveBeenCalled();
  });

  it('happy path: builds features, predicts score, returns prob_calibrated + version', () => {
    const fakeFeatures = { f1: 1, f2: 2 };
    vi.mocked(featuresForLottery).mockReturnValueOnce(fakeFeatures);
    vi.mocked(featuresFromRow).mockReturnValueOnce([1, 2]);
    vi.mocked(predictTakeitScore).mockReturnValueOnce({
      prob_calibrated: 0.72,
      prob_raw: 0.71,
    } as never);

    const result = scoreLottery(detectCtx, row);
    expect(result).toEqual({
      prob: 0.72,
      version: 'test-v1',
      features: fakeFeatures,
    });
  });

  it('catches predictTakeitScore throw, captures Sentry, returns null tuple', () => {
    vi.mocked(featuresForLottery).mockReturnValueOnce({});
    vi.mocked(featuresFromRow).mockReturnValueOnce([]);
    vi.mocked(predictTakeitScore).mockImplementationOnce(() => {
      throw new Error('tree corrupt');
    });

    const result = scoreLottery(detectCtx, row);
    expect(result).toEqual({ prob: null, version: null, features: null });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      extra: {
        alertType: 'lottery',
        option_chain_id: 'NVDA  260522P00225000',
      },
    });
  });
});

describe('scoreSilentBoom', () => {
  const detectCtx = {
    bundle: FAKE_BUNDLE,
    ctx: {
      recentSameTypeFires: [],
      recentOtherTypeByChain: new Map(),
      recentOtherTypeByTickerDir: new Map(),
      priorSessionWinRateByTicker: new Map(),
    },
  };
  const row = {
    option_chain_id: 'TSLA  260522C00800000',
    underlying_symbol: 'TSLA',
    option_type: 'C',
  } as SilentBoomAlertRow;

  it('returns null result when detectCtx is null', () => {
    const result = scoreSilentBoom(null, row);
    expect(result).toEqual({ prob: null, version: null, features: null });
  });

  it('happy path uses featuresForSilentBoom (NOT featuresForLottery)', () => {
    const fakeFeatures = { sb_f1: 9 };
    vi.mocked(featuresForSilentBoom).mockReturnValueOnce(fakeFeatures);
    vi.mocked(featuresFromRow).mockReturnValueOnce([9]);
    vi.mocked(predictTakeitScore).mockReturnValueOnce({
      prob_calibrated: 0.55,
      prob_raw: 0.5,
    } as never);

    const result = scoreSilentBoom(detectCtx, row);
    expect(result.prob).toBe(0.55);
    expect(result.features).toBe(fakeFeatures);
    expect(featuresForSilentBoom).toHaveBeenCalledOnce();
    expect(featuresForLottery).not.toHaveBeenCalled();
  });

  it('catches featuresForSilentBoom throw and tags Sentry with alertType=silentboom', () => {
    vi.mocked(featuresForSilentBoom).mockImplementationOnce(() => {
      throw new Error('feature build failed');
    });

    const result = scoreSilentBoom(detectCtx, row);
    expect(result).toEqual({ prob: null, version: null, features: null });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      extra: { alertType: 'silentboom' },
    });
  });
});
