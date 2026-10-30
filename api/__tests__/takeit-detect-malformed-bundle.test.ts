// @vitest-environment node
/**
 * A malformed Take-It bundle must surface as a Sentry event and a null
 * probability, never as a NaN takeit_prob.
 *
 * Unlike takeit-detect.test.ts, which mocks the scorer, this file runs the
 * real loader, schema and scorer. Only the boundaries are mocked: Vercel
 * Blob's list() and a spy on the global fetch (together, the bundle source),
 * Sentry, and the feature builders (so a row needs no real alert fields).
 *
 * The malformed bundle is one whose tree has `split_conditions: []`, so its
 * leaf has no value. Before the per-node array-length check it passed
 * validation and scored as NaN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/blob', () => ({
  list: vi.fn(),
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
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

import { list } from '@vercel/blob';

import { Sentry } from '../_lib/sentry.js';
import { _resetBundleCacheForTests } from '../_lib/takeit-bundle-loader.js';
import {
  loadTakeitDetectContext,
  scoreLottery,
  scoreSilentBoom,
} from '../_lib/takeit-detect.js';
import {
  featuresForLottery,
  featuresForSilentBoom,
} from '../_lib/takeit-features.js';
import type {
  LotteryAlertRow,
  SilentBoomAlertRow,
} from '../_lib/takeit-features.js';
import { BundleSchemaError } from '../_lib/takeit-score.js';
import type { TakeitBundle } from '../_lib/takeit-score.js';

const MANIFEST_URL = 'https://blob.example/latest.json';
const BUNDLE_URL = 'https://blob.example/bundle.json';
const BUNDLE_PATH = 'takeit/lottery_classifier_v-bad.json';

/** One feature `a`, base_score 0.5, and one leaf tree with no leaf value. */
function malformedBundle(): TakeitBundle {
  return {
    version: 'v-bad',
    alert_type: 'lottery',
    trained_on_date: '2026-10-26',
    win_label_threshold_pct: 20,
    xgb_json_schema: '2.1',
    feature_cols: ['a'],
    top_tickers: [],
    categorical_cols: [],
    feature_derivation_constants: {},
    xgb_model: {
      learner: {
        learner_model_param: { base_score: '[5E-1]' },
        gradient_booster: {
          model: {
            trees: [
              {
                left_children: [-1],
                right_children: [-1],
                split_indices: [0],
                split_conditions: [],
                default_left: [0],
                base_weights: [0],
              },
            ],
          },
        },
      },
    },
    isotonic: {
      x_thresholds: [0.25, 0.5, 1],
      y_thresholds: [0.125, 0.5, 0.75],
      out_of_bounds: 'clip',
    },
  };
}

/** Serve the manifest and `bundle` from the mocked Blob store. */
function serveFromBlob(bundle: TakeitBundle): void {
  // The loader lists by exact path as the prefix: the manifest, then the
  // bundle path the manifest names.
  vi.mocked(list).mockImplementation(async (opts) => {
    const pathname = opts?.prefix ?? '';
    const url = pathname === BUNDLE_PATH ? BUNDLE_URL : MANIFEST_URL;
    return {
      blobs: [{ pathname, url, downloadUrl: url }],
      cursor: undefined,
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof list>>;
  });
  vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (url === MANIFEST_URL) {
      return new Response(
        JSON.stringify({ lottery: BUNDLE_PATH, silentboom: BUNDLE_PATH }),
      );
    }
    if (url === BUNDLE_URL) return new Response(JSON.stringify(bundle));
    throw new Error(`unexpected fetch url ${String(url)}`);
  });
}

const noPriorFires = {
  fetchRecentSameType: vi.fn(),
  fetchRecentOtherTypeByChain: vi.fn(),
  fetchPriorSessionWinRateByTicker: vi.fn(),
};

const emptySequentialContext = {
  recentSameTypeFires: [],
  recentOtherTypeByChain: new Map(),
  recentOtherTypeByTickerDir: new Map(),
  priorSessionWinRateByTicker: new Map(),
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

/** The single Error captured by Sentry.captureException call `index`. */
function capturedError(index: number): Error {
  const err = vi.mocked(Sentry.captureException).mock.calls[index]?.[0];
  if (!(err instanceof Error)) {
    throw new Error(`captureException call ${index} has no Error`);
  }
  return err;
}

beforeEach(() => {
  _resetBundleCacheForTests();
  vi.resetAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  noPriorFires.fetchRecentSameType.mockResolvedValue([]);
  noPriorFires.fetchRecentOtherTypeByChain.mockResolvedValue([]);
  noPriorFires.fetchPriorSessionWinRateByTicker.mockResolvedValue([]);
  vi.mocked(featuresForLottery).mockReturnValue({ a: 1 });
  vi.mocked(featuresForSilentBoom).mockReturnValue({ a: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a bundle with split_conditions: [] from Blob', () => {
  it('is rejected at load, captured to Sentry twice, reported as an error, and scores as null', async () => {
    serveFromBlob(malformedBundle());
    const onPrefetchFailure = vi.fn();

    const detectCtx = await loadTakeitDetectContext(
      'lottery',
      noPriorFires,
      onPrefetchFailure,
    );

    // The bundle never reaches the scorer, so no prefetch runs either.
    expect(detectCtx).toBeNull();
    expect(noPriorFires.fetchRecentSameType).not.toHaveBeenCalled();

    // getBundle captures and rethrows; loadTakeitDetectContext captures again.
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    const err = capturedError(0);
    expect(capturedError(1)).toBe(err);
    expect(err).toBeInstanceOf(BundleSchemaError);
    expect(err.name).toBe('BundleSchemaError');
    expect(err.message).toBe(
      'TakeitBundle validation failed at xgb_model.learner.gradient_booster.model.trees.0: ' +
        'split_conditions length 0 != left_children length 1',
    );
    expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[1]).toEqual({
      extra: { alertType: 'lottery', targetPath: BUNDLE_PATH },
    });
    expect(vi.mocked(Sentry.captureException).mock.calls[1]?.[1]).toEqual({
      extra: { alertType: 'lottery', where: 'loadTakeitDetectContext' },
    });

    // The cron hears it as an error (a bad upload or a bug), so the run
    // reports 'error' rather than 'success' with every takeit_prob NULL.
    expect(onPrefetchFailure).toHaveBeenCalledExactlyOnceWith({
      reason: err.message,
      kind: 'error',
    });

    // With no context, the cron writes takeit_prob = NULL.
    expect(scoreLottery(detectCtx, lotteryRow)).toEqual({
      prob: null,
      version: null,
      features: null,
    });
  });
});

describe('a bundle with split_conditions: [] that skipped load-time validation', () => {
  // The scorer's own guard: the non-finite logit throws inside the per-row
  // try/catch, which captures it and returns a null probability.
  it.each([
    [
      'scoreLottery',
      'lottery',
      () =>
        scoreLottery(
          { bundle: malformedBundle(), ctx: emptySequentialContext },
          lotteryRow,
        ),
      lotteryRow.option_chain_id,
    ],
    [
      'scoreSilentBoom',
      'silentboom',
      () =>
        scoreSilentBoom(
          { bundle: malformedBundle(), ctx: emptySequentialContext },
          silentBoomRow,
        ),
      silentBoomRow.option_chain_id,
    ],
  ])(
    '%s returns prob: null and captures the BundleSchemaError, not NaN',
    (where, alertType, score, optionChainId) => {
      expect(score()).toEqual({ prob: null, version: null, features: null });

      expect(Sentry.captureException).toHaveBeenCalledOnce();
      const err = capturedError(0);
      expect(err).toBeInstanceOf(BundleSchemaError);
      expect(err.name).toBe('BundleSchemaError');
      expect(err.message).toBe('logit not finite: NaN');
      expect(vi.mocked(Sentry.captureException).mock.calls[0]?.[1]).toEqual({
        extra: { alertType, where, option_chain_id: optionChainId },
      });
    },
  );
});
