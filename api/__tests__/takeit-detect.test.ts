// @vitest-environment node
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

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
  awaitWinRateWarmup,
  loadTakeitDetectContext,
  priorSessionWinRatesForDay,
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

describe('loadTakeitDetectContext prefetch deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = <T>() => new Promise<T>(() => {});

  it('gives up after 5 s, sends one fingerprinted Sentry warning and tells the caller', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    baseDeps.fetchRecentSameType.mockReturnValueOnce(never());
    const onPrefetchFailure = vi.fn();

    const pending = loadTakeitDetectContext(
      'lottery',
      baseDeps,
      onPrefetchFailure,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(onPrefetchFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    const reason = 'Take-It prefetch passed its 5000 ms deadline';
    expect(onPrefetchFailure).toHaveBeenCalledExactlyOnceWith({
      reason,
      kind: 'timeout',
    });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const [err, hint] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect((err as Error).message).toBe(reason);
    expect(hint).toMatchObject({
      level: 'warning',
      fingerprint: ['takeit-detect', 'lottery', 'prefetch-timeout'],
      tags: { 'takeit.alert_type': 'lottery' },
      extra: {
        alertType: 'lottery',
        where: 'loadTakeitDetectContext.prefetch',
      },
    });
  });

  it('reports a genuine prefetch error at error level, under the error fingerprint, after one attempt per query', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    baseDeps.fetchRecentOtherTypeByChain.mockRejectedValueOnce(
      new Error('relation "silent_boom_alerts" does not exist'),
    );
    const onPrefetchFailure = vi.fn();

    const ctx = await loadTakeitDetectContext(
      'silentboom',
      baseDeps,
      onPrefetchFailure,
    );

    expect(ctx).toBeNull();
    // 'error' tells the cron this is a bug, so the run reports 'error'.
    expect(onPrefetchFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'relation "silent_boom_alerts" does not exist',
      kind: 'error',
    });
    expect(baseDeps.fetchRecentSameType).toHaveBeenCalledOnce();
    expect(baseDeps.fetchRecentOtherTypeByChain).toHaveBeenCalledOnce();
    expect(baseDeps.fetchPriorSessionWinRateByTicker).toHaveBeenCalledOnce();
    // A broken query (renamed table or column) is a bug, not Neon being
    // slow: it pages.
    expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[1]).toMatchObject(
      {
        level: 'error',
        fingerprint: ['takeit-detect', 'silentboom', 'prefetch-error'],
      },
    );
  });

  it('reports a transient prefetch rejection (a Neon blip) at warning level under the error fingerprint', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    baseDeps.fetchRecentSameType.mockRejectedValueOnce(
      new Error('fetch failed'),
    );
    const onPrefetchFailure = vi.fn();

    await loadTakeitDetectContext('lottery', baseDeps, onPrefetchFailure);

    expect(onPrefetchFailure).toHaveBeenCalledExactlyOnceWith({
      reason: 'fetch failed',
      kind: 'transient',
    });
    expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[1]).toMatchObject(
      {
        level: 'warning',
        fingerprint: ['takeit-detect', 'lottery', 'prefetch-error'],
      },
    );
  });

  it('does not call onPrefetchFailure when the prefetch succeeds', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(FAKE_BUNDLE);
    const onPrefetchFailure = vi.fn();

    const ctx = await loadTakeitDetectContext(
      'lottery',
      baseDeps,
      onPrefetchFailure,
    );

    expect(ctx).not.toBeNull();
    expect(onPrefetchFailure).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not call onPrefetchFailure when the bundle is missing (nothing was prefetched)', async () => {
    vi.mocked(getBundle).mockResolvedValueOnce(null);
    const onPrefetchFailure = vi.fn();

    await loadTakeitDetectContext('lottery', baseDeps, onPrefetchFailure);

    expect(onPrefetchFailure).not.toHaveBeenCalled();
  });
});

// The win-rate cache is module state that outlives a test, as it outlives
// a request in production. Every test below uses ET dates no other test
// uses, so no test can see another's entry.
describe('priorSessionWinRatesForDay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const NVDA = [{ underlying_symbol: 'NVDA', win_rate: 0.5 }];
  const TSLA = [{ underlying_symbol: 'TSLA', win_rate: 0.25 }];

  it('loads once per ET day, for dates before that day, then serves the cached rows', async () => {
    const load = vi.fn().mockResolvedValue(NVDA);

    const first = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-05',
      load,
    );
    const second = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-05',
      load,
    );

    expect(first).toEqual(NVDA);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledExactlyOnceWith('2026-01-05');
  });

  it('shares one in-flight load between callers that arrive before it settles', async () => {
    let resolveLoad: (rows: typeof NVDA) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<typeof NVDA>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const a = priorSessionWinRatesForDay('lottery', '2026-01-06', load);
    const b = priorSessionWinRatesForDay('lottery', '2026-01-06', load);
    resolveLoad(NVDA);

    await expect(a).resolves.toEqual(NVDA);
    await expect(b).resolves.toEqual(NVDA);
    expect(load).toHaveBeenCalledOnce();
  });

  it('reloads when the ET date changes and keeps only the newest day', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(NVDA)
      .mockResolvedValueOnce(TSLA)
      .mockResolvedValueOnce(NVDA);

    await priorSessionWinRatesForDay('lottery', '2026-01-07', load);
    const nextDay = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-08',
      load,
    );
    // The new day replaced the old entry: asking for the old day again
    // is a miss, not a second resident entry.
    await priorSessionWinRatesForDay('lottery', '2026-01-07', load);

    expect(nextDay).toEqual(TSLA);
    expect(load.mock.calls).toEqual([
      ['2026-01-07'],
      ['2026-01-08'],
      ['2026-01-07'],
    ]);
  });

  it('does not cache a failed load: the next call for the same day retries', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('db attempt timeout'))
      .mockResolvedValueOnce(NVDA);

    await expect(
      priorSessionWinRatesForDay('lottery', '2026-01-09', load),
    ).rejects.toThrow('db attempt timeout');
    const retried = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-09',
      load,
    );

    expect(retried).toEqual(NVDA);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a load for the old day that fails after the date rolled leaves the new day cached', async () => {
    let rejectOld: (err: Error) => void = () => {};
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce(TSLA);

    const old = priorSessionWinRatesForDay('lottery', '2026-01-12', load);
    await priorSessionWinRatesForDay('lottery', '2026-01-13', load);
    rejectOld(new Error('fetch failed'));
    await expect(old).rejects.toThrow('fetch failed');

    const cached = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-13',
      load,
    );
    expect(cached).toEqual(TSLA);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps one entry per alert type, so lottery and silent boom never share rows', async () => {
    const lotteryLoad = vi.fn().mockResolvedValue(NVDA);
    const silentBoomLoad = vi.fn().mockResolvedValue(TSLA);

    const lottery = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-14',
      lotteryLoad,
    );
    const silentBoom = await priorSessionWinRatesForDay(
      'silentboom',
      '2026-01-14',
      silentBoomLoad,
    );

    expect(lottery).toEqual(NVDA);
    expect(silentBoom).toEqual(TSLA);
    expect(lotteryLoad).toHaveBeenCalledOnce();
    expect(silentBoomLoad).toHaveBeenCalledOnce();
  });

  it('keeps a slow load for up to 120 s, then drops a hung one so a later run can retry it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const load = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(NVDA);

    const hung = priorSessionWinRatesForDay('lottery', '2026-01-15', load);
    const settled = expect(hung).rejects.toThrow(
      'Take-It win-rate load passed its 120000 ms deadline',
    );
    // Still in flight (and shared) just before the cap.
    await vi.advanceTimersByTimeAsync(119_999);
    await expect(
      Promise.race([
        priorSessionWinRatesForDay('lottery', '2026-01-15', load).then(
          () => 'settled',
        ),
        Promise.resolve('pending'),
      ]),
    ).resolves.toBe('pending');
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    const retried = await priorSessionWinRatesForDay(
      'lottery',
      '2026-01-15',
      load,
    );
    expect(retried).toEqual(NVDA);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('awaitWinRateWarmup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Fake the clock too: the budget is measured from the run's start time.
  const fakeClock = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-06-05T13:26:00Z'));
  };

  it('resolves once the warm-up load lands', async () => {
    let resolveLoad: (rows: unknown[]) => void = () => {};
    const warmup = new Promise<unknown[]>((resolve) => {
      resolveLoad = resolve;
    });
    let done = false;
    const waiting = awaitWinRateWarmup(warmup, Date.now()).then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);
    resolveLoad([]);
    await waiting;
    expect(done).toBe(true);
  });

  it('never rejects: a failed warm-up is left for the next run to retry', async () => {
    await expect(
      awaitWinRateWarmup(Promise.reject(new Error('fetch failed')), Date.now()),
    ).resolves.toBeUndefined();
  });

  it('waits until 45 s after the run started: a run 30 s in gives up after 15 s', async () => {
    fakeClock();
    const startTimeMs = Date.now() - 30_000;
    let done = false;
    const waiting = awaitWinRateWarmup(new Promise(() => {}), startTimeMs).then(
      () => {
        done = true;
      },
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });

  it('does not wait at all once the run is past 45 s, leaving room for the check-in and response', async () => {
    fakeClock();
    const startTimeMs = Date.now() - 50_000;

    await awaitWinRateWarmup(new Promise(() => {}), startTimeMs);

    expect(vi.getTimerCount()).toBe(0);
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
    // sanitizeScoringInputs returns a fresh object; deep-equal instead of
    // identity. All-finite inputs are passed through value-equal.
    expect(result.features).toEqual(fakeFeatures);
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
