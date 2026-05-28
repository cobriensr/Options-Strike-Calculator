import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/blob', () => ({
  list: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
  },
}));

import { list } from '@vercel/blob';

import { Sentry } from '../_lib/sentry.js';
import {
  _resetBundleCacheForTests,
  getBundle,
} from '../_lib/takeit-bundle-loader.js';
import type { TakeitBundle } from '../_lib/takeit-score.js';

function mockBundle(version: string): TakeitBundle {
  return {
    version,
    alert_type: 'lottery',
    trained_on_date: '2026-05-16',
    win_label_threshold_pct: 20.0,
    xgb_json_schema: '2.1',
    feature_cols: ['a'],
    top_tickers: [],
    categorical_cols: [],
    feature_derivation_constants: {},
    xgb_model: {
      learner: {
        learner_model_param: { base_score: '[5.0E-1]' },
        gradient_booster: {
          model: {
            trees: [
              {
                left_children: [-1],
                right_children: [-1],
                split_indices: [0],
                split_conditions: [0.5],
                default_left: [1],
                base_weights: [0.1],
              },
            ],
          },
        },
      },
    },
    isotonic: { x_thresholds: [0, 1], y_thresholds: [0, 1] },
  };
}

function mockListResponse(blobs: { pathname: string; url: string }[]) {
  // The loader fetches `entry.downloadUrl`, not `entry.url`, since
  // private blob stores reject the raw store URL with 403. Default
  // downloadUrl to the same value as url so existing test fixtures
  // (which only set `url`) keep matching against the fetch spy.
  vi.mocked(list).mockResolvedValueOnce({
    blobs: blobs.map((b) => ({ ...b, downloadUrl: b.url })),
    cursor: undefined,
    hasMore: false,
  } as Awaited<ReturnType<typeof list>>);
}

const MANIFEST_URL = 'https://blob.example/latest.json';
const BUNDLE_URL = 'https://blob.example/bundle.json';

describe('getBundle', () => {
  beforeEach(() => {
    _resetBundleCacheForTests();
    // resetAllMocks drains queued mockResolvedValueOnce values that would
    // otherwise leak between tests.
    vi.resetAllMocks();
    // Required by blobAuthHeaders() in takeit-bundle-loader; private store
    // fetches need an Authorization: Bearer header.
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  });

  it('fetches manifest then bundle on cold cache and caches the result', async () => {
    // First call: list manifest, fetch manifest JSON.
    mockListResponse([{ pathname: 'takeit/latest.json', url: MANIFEST_URL }]);
    // Then list bundle, fetch bundle JSON.
    mockListResponse([
      {
        pathname: 'takeit/lottery_classifier_v2026-05-16.json',
        url: BUNDLE_URL,
      },
    ]);

    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(
            JSON.stringify({
              lottery: 'takeit/lottery_classifier_v2026-05-16.json',
              silentboom: 'takeit/silentboom_classifier_v2026-05-16.json',
            }),
          );
        }
        if (url === BUNDLE_URL) {
          return new Response(JSON.stringify(mockBundle('v2026-05-16')));
        }
        throw new Error(`unexpected fetch url ${url as string}`);
      });

    const bundle = await getBundle('lottery');
    expect(bundle).not.toBeNull();
    expect(bundle?.version).toBe('v2026-05-16');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // manifest + bundle
    // Regression for 2026-05-20: both fetches must carry an Authorization
    // header — without it, private-store blob URLs 403.
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe('Bearer test-token');
    }
    fetchSpy.mockRestore();
  });

  it('returns null + Sentry warn when manifest fetch fails and no cached bundle exists', async () => {
    // With retry logic: 3 total attempts (initial + 2 retries), all fail.
    vi.useFakeTimers();
    vi.mocked(list)
      .mockRejectedValueOnce(new Error('blob unreachable'))
      .mockRejectedValueOnce(new Error('blob unreachable'))
      .mockRejectedValueOnce(new Error('blob unreachable'));
    const bundlePromise = getBundle('lottery');
    await vi.runAllTimersAsync();
    const bundle = await bundlePromise;
    expect(bundle).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.bundle.manifest_fetch_failed',
      expect.objectContaining({ level: 'warning' }),
    );
    vi.useRealTimers();
  });

  it('returns stale cached bundle when subsequent refresh fails (TTL expired)', async () => {
    // Use fake timers so we can advance past BUNDLE_REFRESH_TTL_MS and force
    // the loader down the refresh path, then break the refresh.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00Z'));

    // First call: cold load succeeds.
    mockListResponse([{ pathname: 'takeit/latest.json', url: MANIFEST_URL }]);
    mockListResponse([
      {
        pathname: 'takeit/lottery_classifier_v2026-05-16.json',
        url: BUNDLE_URL,
      },
    ]);
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(
            JSON.stringify({
              lottery: 'takeit/lottery_classifier_v2026-05-16.json',
              silentboom: 'takeit/silentboom_classifier_v2026-05-16.json',
            }),
          );
        }
        return new Response(JSON.stringify(mockBundle('v2026-05-16')));
      });

    const fresh = await getBundle('lottery');
    expect(fresh?.version).toBe('v2026-05-16');

    // Advance system time past the 15-min TTL — the next getBundle() MUST
    // re-attempt the manifest fetch instead of short-circuiting on cache.
    vi.setSystemTime(new Date('2026-05-16T12:20:00Z'));

    // Break the refresh by failing all 3 attempts (initial + 2 retries).
    fetchSpy.mockRestore();
    vi.mocked(list)
      .mockRejectedValueOnce(new Error('intermittent blob 503'))
      .mockRejectedValueOnce(new Error('intermittent blob 503'))
      .mockRejectedValueOnce(new Error('intermittent blob 503'));

    const stalePromise = getBundle('lottery');
    // Drain backoff delays so the retries complete without real wall-clock time.
    await vi.runAllTimersAsync();
    const stale = await stalePromise;
    // Fail-open: stale bundle is returned, NOT null.
    expect(stale?.version).toBe('v2026-05-16');
    // Sentry was alerted about the failed refresh.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.bundle.manifest_fetch_failed',
      expect.objectContaining({ level: 'warning' }),
    );

    vi.useRealTimers();
  });

  it('retries transient manifest failures and succeeds on the third attempt', async () => {
    // list() fails twice, then succeeds on the third attempt (attempt 0,1 fail; attempt 2 succeeds).
    vi.mocked(list)
      .mockRejectedValueOnce(new Error('blob 503 attempt 1'))
      .mockRejectedValueOnce(new Error('blob 503 attempt 2'))
      .mockResolvedValueOnce({
        blobs: [
          {
            pathname: 'takeit/latest.json',
            url: MANIFEST_URL,
            downloadUrl: MANIFEST_URL,
          },
        ],
        cursor: undefined,
        hasMore: false,
      } as Awaited<ReturnType<typeof list>>);
    // Bundle list succeeds on the first attempt.
    mockListResponse([
      {
        pathname: 'takeit/lottery_classifier_v2026-05-16.json',
        url: BUNDLE_URL,
      },
    ]);

    // Use fake timers so the backoff delays don't actually wait.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(
            JSON.stringify({
              lottery: 'takeit/lottery_classifier_v2026-05-16.json',
              silentboom: 'takeit/silentboom_classifier_v2026-05-16.json',
            }),
          );
        }
        return new Response(JSON.stringify(mockBundle('v2026-05-16')));
      });

    const bundlePromise = getBundle('lottery');
    // Drain all pending timers to flush the backoff delays.
    await vi.runAllTimersAsync();
    const bundle = await bundlePromise;

    expect(bundle).not.toBeNull();
    expect(bundle?.version).toBe('v2026-05-16');
    // list() should have been called 3 times for manifest (2 failures + 1 success)
    // plus 1 time for the bundle = 4 total.
    expect(vi.mocked(list)).toHaveBeenCalledTimes(4);
    // Sentry should have been notified about each retry attempt (2 retries).
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('takeit-bundle'),
      expect.objectContaining({ level: 'info' }),
    );

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('falls back to cached bundle when all manifest retries are exhausted', async () => {
    // First call: warm the cache with a successful load.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00Z'));

    mockListResponse([{ pathname: 'takeit/latest.json', url: MANIFEST_URL }]);
    mockListResponse([
      {
        pathname: 'takeit/lottery_classifier_v2026-05-16.json',
        url: BUNDLE_URL,
      },
    ]);
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(
            JSON.stringify({
              lottery: 'takeit/lottery_classifier_v2026-05-16.json',
              silentboom: 'takeit/silentboom_classifier_v2026-05-16.json',
            }),
          );
        }
        return new Response(JSON.stringify(mockBundle('v2026-05-16')));
      });

    const warmBundle = await getBundle('lottery');
    expect(warmBundle?.version).toBe('v2026-05-16');
    fetchSpy.mockRestore();

    // Advance past TTL so the next call re-attempts the manifest.
    vi.setSystemTime(new Date('2026-05-16T12:20:00Z'));

    // All 3 attempts (initial + 2 retries = MAX_RETRIES+1) fail.
    vi.mocked(list)
      .mockRejectedValueOnce(new Error('persistent failure 1'))
      .mockRejectedValueOnce(new Error('persistent failure 2'))
      .mockRejectedValueOnce(new Error('persistent failure 3'));

    const staleBundlePromise = getBundle('lottery');
    await vi.runAllTimersAsync();
    const staleBundle = await staleBundlePromise;

    // Fail-open: stale cached bundle returned, not null.
    expect(staleBundle).not.toBeNull();
    expect(staleBundle?.version).toBe('v2026-05-16');
    // Sentry captured the final failure.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'takeit.bundle.manifest_fetch_failed',
      expect.objectContaining({ level: 'warning' }),
    );
    // list() was called 2 times during warm load (manifest + bundle) and
    // 3 times during the retry-exhaustion phase = 5 total.
    expect(vi.mocked(list)).toHaveBeenCalledTimes(5);

    vi.useRealTimers();
  });

  it('throws fail-closed when bundle has an unsupported xgb_json_schema', async () => {
    mockListResponse([{ pathname: 'takeit/latest.json', url: MANIFEST_URL }]);
    mockListResponse([
      {
        pathname: 'takeit/lottery_classifier_v2026-05-16.json',
        url: BUNDLE_URL,
      },
    ]);
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(
            JSON.stringify({
              lottery: 'takeit/lottery_classifier_v2026-05-16.json',
              silentboom: 'takeit/silentboom_classifier_v2026-05-16.json',
            }),
          );
        }
        const bad = mockBundle('v2026-05-16');
        bad.xgb_json_schema = '9.99';
        return new Response(JSON.stringify(bad));
      });

    await expect(getBundle('lottery')).rejects.toThrow(
      'unsupported xgb_json_schema',
    );
    expect(Sentry.captureException).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
