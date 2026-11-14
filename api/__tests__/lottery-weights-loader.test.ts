// @vitest-environment node
//
// Tests for the lottery weights loader (phase 4, Task 4). The loader reads the
// `active` and `takeit` pointers from the weights store, caches the result for
// 60 s, and falls back to the frozen seed, with a Sentry error, when it can't.
//
// Mocked at the module boundary: `../_lib/db.js` (the query function and the
// retry wrapper; the real transient-error classifier stays), the Sentry module
// and the logger. Each test imports a fresh copy of the loader, so each starts
// with an empty cache.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LotteryWeights } from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';

const h = vi.hoisted(() => ({
  mockSql: vi.fn(),
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  captureMessage: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb: h.getDb,
    withDbRetry: h.withDbRetry,
    isRetryableDbError: actual.isRetryableDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: h.captureMessage },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: h.warn, error: h.error },
}));

const TTL_MS = 60_000;
const SEED_VERSION = SEED_LOTTERY_WEIGHTS_VERSION;
const REFIT_VERSION = 'refit-2026-11-12';
const NEXT_VERSION = 'refit-2026-11-13';

interface Row {
  name: string;
  version: string;
  weights: unknown;
}

/** Valid weights that are not the seed: AAPL's ticker weight raised by one. */
function refitWeights(): LotteryWeights {
  const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
  copy.model_version = 'refit-test';
  copy.features.ticker_weights.AAPL =
    (copy.features.ticker_weights.AAPL ?? 0) + 1;
  return copy;
}

const activeRow = (version: string, weights: unknown): Row => ({
  name: 'active',
  version,
  weights,
});
const takeitRow = (version: string, weights: unknown): Row => ({
  name: 'takeit',
  version,
  weights,
});

/** A promoted `active` version and Take-It still pinned to the seed. */
const promotedRows = (version = REFIT_VERSION): Row[] => [
  activeRow(version, refitWeights()),
  takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
];

/** A fresh loader (empty cache) and the seed object that fresh copy holds. */
async function freshLoader() {
  vi.resetModules();
  const { loadLotteryWeights } =
    await import('../_lib/lottery-weights-loader.js');
  const { SEED_LOTTERY_WEIGHTS: seed } =
    await import('../_lib/lottery-weights-seed.js');
  return { load: loadLotteryWeights, seed };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
  h.getDb.mockReturnValue(h.mockSql);
  h.withDbRetry.mockImplementation((fn: () => Promise<unknown>) => fn());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadLotteryWeights', () => {
  it('loads both pointers and validates them', async () => {
    // The takeit row comes first: the slots are chosen by pointer name.
    h.mockSql.mockResolvedValueOnce([
      takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
      activeRow(REFIT_VERSION, refitWeights()),
    ]);
    const { load } = await freshLoader();

    const result = await load();

    expect(result).toEqual({
      active: { version: REFIT_VERSION, weights: refitWeights() },
      takeit: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
      fallback: null,
    });
    // One query joins the pointers to their versions, inside the retry wrapper.
    expect(h.mockSql).toHaveBeenCalledTimes(1);
    const text = (h.mockSql.mock.calls[0]![0] as string[])
      .join('')
      .replaceAll(/\s+/g, ' ');
    expect(text).toContain(
      'FROM lottery_score_pointers p JOIN lottery_score_versions v ON v.version = p.version',
    );
    expect(text).toContain("WHERE p.name IN ('active','takeit')");
    expect(h.withDbRetry).toHaveBeenCalledWith(expect.any(Function), 1, 5_000);
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('caches for 60 s, then reloads', async () => {
    h.mockSql
      .mockResolvedValueOnce(promotedRows(REFIT_VERSION))
      .mockResolvedValueOnce(promotedRows(NEXT_VERSION));
    const { load } = await freshLoader();

    const first = await load();
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(await load()).toBe(first);
    expect(h.mockSql).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const reloaded = await load();
    expect(h.mockSql).toHaveBeenCalledTimes(2);
    expect(reloaded.active.version).toBe(NEXT_VERSION);
  });

  it('concurrent callers share one query', async () => {
    let release!: (rows: Row[]) => void;
    h.mockSql.mockReturnValueOnce(
      new Promise<Row[]>((resolve) => {
        release = resolve;
      }),
    );
    const { load } = await freshLoader();

    const pending = [load(), load(), load()];
    release(promotedRows());
    const [first, second, third] = await Promise.all(pending);

    expect(h.mockSql).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('serves the cached version on a transient error', async () => {
    h.mockSql
      .mockResolvedValueOnce(promotedRows())
      .mockRejectedValueOnce(new Error('fetch failed'));
    const { load } = await freshLoader();

    const first = await load();
    vi.advanceTimersByTime(TTL_MS);
    const second = await load();

    expect(second).toBe(first);
    expect(second.fallback).toBeNull();
    expect(second.active.version).toBe(REFIT_VERSION);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).not.toHaveBeenCalled();
  });

  it('falls back to the seed with an error when nothing is cached', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('db attempt timeout'));
    const { load, seed } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({
      kind: 'transient',
      reason: 'db attempt timeout',
    });
    expect(result.active).toEqual({ version: SEED_VERSION, weights: seed });
    expect(result.takeit).toEqual({ version: SEED_VERSION, weights: seed });
    expect(result.active.weights).toBe(seed);
    expect(result.takeit.weights).toBe(seed);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).toHaveBeenCalledWith(
      'lottery weights fallback to seed',
      expect.objectContaining({
        level: 'error',
        fingerprint: ['lottery-weights-fallback', 'transient'],
      }),
    );
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it('an invalid weights row falls back to the seed, kind error', async () => {
    h.mockSql.mockResolvedValueOnce([
      activeRow(REFIT_VERSION, { ...refitWeights(), schema_version: 2 }),
      takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
    ]);
    const { load, seed } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('error');
    expect(result.fallback?.reason).toMatch(
      /^active version refit-2026-11-12 fails validation at schema_version: /,
    );
    expect(result.active).toEqual({ version: SEED_VERSION, weights: seed });
    expect(result.takeit).toEqual({ version: SEED_VERSION, weights: seed });
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).toHaveBeenCalledWith(
      'lottery weights fallback to seed',
      expect.objectContaining({
        level: 'error',
        fingerprint: ['lottery-weights-fallback', 'error'],
      }),
    );
  });

  it('an invalid takeit row replaces both slots, not only its own', async () => {
    h.mockSql.mockResolvedValueOnce([
      activeRow(REFIT_VERSION, refitWeights()),
      takeitRow(SEED_VERSION, { ...refitWeights(), unknown_key: 1 }),
    ]);
    const { load, seed } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('error');
    expect(result.fallback?.reason).toMatch(/^takeit version seed-2026-06-17/);
    expect(result.active).toEqual({ version: SEED_VERSION, weights: seed });
    expect(result.takeit).toEqual({ version: SEED_VERSION, weights: seed });
  });

  it('a missing takeit pointer falls back to the seed, kind error', async () => {
    h.mockSql.mockResolvedValueOnce([activeRow(REFIT_VERSION, refitWeights())]);
    const { load, seed } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({
      kind: 'error',
      reason: 'no takeit pointer',
    });
    expect(result.active).toEqual({ version: SEED_VERSION, weights: seed });
    expect(result.takeit).toEqual({ version: SEED_VERSION, weights: seed });
    expect(h.captureMessage).toHaveBeenCalledWith(
      'lottery weights fallback to seed',
      expect.objectContaining({
        fingerprint: ['lottery-weights-fallback', 'error'],
      }),
    );
  });

  it.each([
    [
      'a missing active pointer',
      [takeitRow(SEED_VERSION, SEED_LOTTERY_WEIGHTS)],
    ],
    ['no pointer rows at all', []],
  ])('%s falls back to the seed, kind error', async (_label, rows) => {
    h.mockSql.mockResolvedValueOnce(rows);
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({
      kind: 'error',
      reason: 'no active pointer',
    });
    expect(result.active.version).toBe(SEED_VERSION);
  });

  it('a non-transient database error falls back to the seed, kind error', async () => {
    // What a prod database without migration #208 returns.
    h.mockSql.mockRejectedValueOnce(
      new Error('relation "lottery_score_pointers" does not exist'),
    );
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({
      kind: 'error',
      reason: 'relation "lottery_score_pointers" does not exist',
    });
    expect(result.active.version).toBe(SEED_VERSION);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('never throws: a client that cannot be built also falls back', async () => {
    h.getDb.mockImplementationOnce(() => {
      throw new Error('DATABASE_URL not configured');
    });
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({
      kind: 'error',
      reason: 'DATABASE_URL not configured',
    });
    expect(h.mockSql).not.toHaveBeenCalled();
  });

  it('a bad row is not masked by the cached version', async () => {
    h.mockSql
      .mockResolvedValueOnce(promotedRows())
      .mockResolvedValueOnce([
        activeRow(NEXT_VERSION, { ...refitWeights(), schema_version: 2 }),
        takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
      ]);
    const { load } = await freshLoader();

    await load();
    vi.advanceTimersByTime(TTL_MS);
    const result = await load();

    expect(result.fallback?.kind).toBe('error');
    expect(result.active.version).toBe(SEED_VERSION);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('a rejected load is not cached', async () => {
    h.mockSql
      .mockResolvedValueOnce(promotedRows(REFIT_VERSION))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(promotedRows(NEXT_VERSION));
    const { load } = await freshLoader();

    const first = await load();
    vi.advanceTimersByTime(TTL_MS);
    expect(await load()).toBe(first);
    expect(h.mockSql).toHaveBeenCalledTimes(2);

    // The rejected reload left the entry as it was, so the very next call
    // queries again instead of waiting out a fresh 60 s.
    const recovered = await load();
    expect(h.mockSql).toHaveBeenCalledTimes(3);
    expect(recovered.active.version).toBe(NEXT_VERSION);
    expect(recovered.fallback).toBeNull();
  });

  it('caches the seed fallback for 60 s and reports it once per period', async () => {
    const blip = new Error('fetch failed');
    h.mockSql
      .mockRejectedValueOnce(blip)
      .mockRejectedValueOnce(blip)
      .mockResolvedValueOnce(promotedRows());
    const { load } = await freshLoader();

    const first = await load();
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(await load()).toBe(first);
    expect(h.mockSql).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).toHaveBeenCalledTimes(1);

    // The next period fails again. A cached fallback is not a loaded
    // version, so the result is a fresh fallback and a second error.
    vi.advanceTimersByTime(1);
    const second = await load();
    expect(h.mockSql).toHaveBeenCalledTimes(2);
    expect(second.fallback?.kind).toBe('transient');
    expect(h.captureMessage).toHaveBeenCalledTimes(2);

    // Recovery: the next period reads the store and reports nothing.
    vi.advanceTimersByTime(TTL_MS);
    const recovered = await load();
    expect(recovered.fallback).toBeNull();
    expect(recovered.active.version).toBe(REFIT_VERSION);
    expect(h.captureMessage).toHaveBeenCalledTimes(2);
  });

  it('the fallback result cannot be mutated into the seed', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('fetch failed'));
    const { load, seed } = await freshLoader();

    const result = await load();
    const features = result.active.weights.features;
    const composite = features.composite_bonuses[0]!;

    expect(() => {
      features.ticker_weights.AAPL = 99;
    }).toThrow(TypeError);
    expect(() => {
      result.takeit.weights.cutoffs.t1 = 0;
    }).toThrow(TypeError);
    expect(() => {
      features.composite_bonuses.push(composite);
    }).toThrow(TypeError);
    expect(() => {
      composite.match.ticker = 'ZZZ';
    }).toThrow(TypeError);
    expect(seed.features.ticker_weights.AAPL).toBe(-1);
    expect(seed.cutoffs.t1).toBe(10);
    expect(seed.features.composite_bonuses[0]).toBe(composite);
  });
});
