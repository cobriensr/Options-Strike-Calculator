// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks for the scoreLottery integration test below. Each mock exposes a
// vi.fn so individual tests can inject NaN-bearing feature records and
// assert the Sentry.captureMessage call wired in takeit-detect.ts.
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
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import {
  sanitizeScoringInputs,
  scoreLottery,
  scoreSilentBoom,
} from '../_lib/takeit-detect.js';
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

describe('sanitizeScoringInputs', () => {
  it('preserves finite numbers and nulls unchanged', () => {
    const input = { dte: 0, vol_oi: 0.5, ask_pct: null };
    expect(sanitizeScoringInputs(input)).toEqual(input);
  });

  it('replaces NaN with null (cannot route safely through trees)', () => {
    const result = sanitizeScoringInputs({ dte: Number.NaN, vol_oi: 0.5 });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBe(0.5);
  });

  it('replaces +Infinity and -Infinity with null', () => {
    const result = sanitizeScoringInputs({
      dte: Number.POSITIVE_INFINITY,
      vol_oi: Number.NEGATIVE_INFINITY,
    });
    expect(result.dte).toBeNull();
    expect(result.vol_oi).toBeNull();
  });

  it('returns the count of fields that were sanitized', () => {
    const { sanitized, rejectedCount } = sanitizeScoringInputs(
      { a: Number.NaN, b: 0.5, c: Number.POSITIVE_INFINITY, d: null },
      { withRejectedCount: true },
    );
    expect(rejectedCount).toBe(2);
    expect(sanitized.a).toBeNull();
    expect(sanitized.b).toBe(0.5);
    expect(sanitized.c).toBeNull();
    expect(sanitized.d).toBeNull();
  });

  it('handles an empty record (returns empty + zero rejected count)', () => {
    expect(sanitizeScoringInputs({})).toEqual({});
    const result = sanitizeScoringInputs({}, { withRejectedCount: true });
    expect(result).toEqual({ sanitized: {}, rejectedCount: 0 });
  });

  it('counts every non-finite when all features are bad', () => {
    const { sanitized, rejectedCount } = sanitizeScoringInputs(
      {
        a: Number.NaN,
        b: Number.POSITIVE_INFINITY,
        c: Number.NEGATIVE_INFINITY,
      },
      { withRejectedCount: true },
    );
    expect(rejectedCount).toBe(3);
    expect(sanitized).toEqual({ a: null, b: null, c: null });
  });
});

// Integration: prove the score functions actually fire Sentry.captureMessage
// when their feature builder emits a non-finite value. The unit tests above
// pin sanitizeScoringInputs in isolation; these tests pin the wiring inside
// scoreLottery / scoreSilentBoom that drives sanitization + Sentry alerting.
describe('scoreLottery / scoreSilentBoom sanitize wiring', () => {
  const FAKE_BUNDLE = { version: 'test-v1' } as never;
  const detectCtx = {
    bundle: FAKE_BUNDLE,
    ctx: {
      recentSameTypeFires: [],
      recentOtherTypeByChain: new Map(),
      recentOtherTypeByTickerDir: new Map(),
      priorSessionWinRateByTicker: new Map(),
    },
  };
  const lotteryRow = {
    option_chain_id: 'NVDA  260522P00225000',
    underlying_symbol: 'NVDA',
    option_type: 'P',
  } as LotteryAlertRow;
  const silentBoomRow = {
    option_chain_id: 'TSLA  260522C00800000',
    underlying_symbol: 'TSLA',
    option_type: 'C',
  } as SilentBoomAlertRow;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path stubs for the non-feature mocks. Individual tests
    // override featuresForLottery / featuresForSilentBoom to inject NaN.
    vi.mocked(featuresFromRow).mockReturnValue([]);
    vi.mocked(predictTakeitScore).mockReturnValue({
      prob_calibrated: 0.42,
      prob_raw: 0.41,
    } as never);
  });

  it('scoreLottery fires Sentry.captureMessage when sanitizer rejects inputs', () => {
    vi.mocked(featuresForLottery).mockReturnValueOnce({
      dte: 0,
      vol_oi: Number.NaN,
      ask_pct: Number.POSITIVE_INFINITY,
    });

    const result = scoreLottery(detectCtx, lotteryRow);

    // Score still flows through — sanitization is defense-in-depth, not a
    // hard failure. The calibrated prob comes from the mocked predictor.
    expect(result.prob).toBe(0.42);
    expect(result.features).toEqual({
      dte: 0,
      vol_oi: null,
      ask_pct: null,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [msg, ctx] = vi.mocked(Sentry.captureMessage).mock.calls[0] ?? [];
    expect(msg).toBe('takeit: 2 non-finite feature(s) sanitized');
    expect(ctx).toMatchObject({
      level: 'info',
      tags: { 'takeit.alert_type': 'lottery', 'takeit.sanitize': 'true' },
      extra: {
        option_chain_id: 'NVDA  260522P00225000',
        rejected_count: 2,
      },
    });
  });

  it('scoreLottery does NOT fire Sentry.captureMessage when all features are finite', () => {
    vi.mocked(featuresForLottery).mockReturnValueOnce({
      dte: 0,
      vol_oi: 0.5,
      ask_pct: null,
    });

    scoreLottery(detectCtx, lotteryRow);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('scoreSilentBoom fires Sentry.captureMessage tagged silentboom when sanitizer rejects inputs', () => {
    vi.mocked(featuresForSilentBoom).mockReturnValueOnce({
      premium_density: Number.NEGATIVE_INFINITY,
    });

    scoreSilentBoom(detectCtx, silentBoomRow);

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    const [msg, ctx] = vi.mocked(Sentry.captureMessage).mock.calls[0] ?? [];
    expect(msg).toBe('takeit: 1 non-finite feature(s) sanitized');
    expect(ctx).toMatchObject({
      level: 'info',
      tags: {
        'takeit.alert_type': 'silentboom',
        'takeit.sanitize': 'true',
      },
      extra: {
        option_chain_id: 'TSLA  260522C00800000',
        rejected_count: 1,
      },
    });
  });
});
