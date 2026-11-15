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
import type {
  DeepReadonly,
  LotteryWeights,
} from '../_lib/lottery-weights-schema.js';
import {
  SEED_LOTTERY_WEIGHTS,
  SEED_LOTTERY_WEIGHTS_VERSION,
} from '../_lib/lottery-weights-seed.js';

const h = vi.hoisted(() => ({
  mockSql: vi.fn(),
  getDb: vi.fn(),
  withDbRetry: vi.fn(),
  // Set by the db mock below; a test swaps it in to run the real retry wrapper.
  realWithDbRetry: null as null | typeof import('../_lib/db.js').withDbRetry,
  captureMessage: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  h.realWithDbRetry = actual.withDbRetry;
  return {
    getDb: h.getDb,
    withDbRetry: h.withDbRetry,
    isRetryableDbError: actual.isRetryableDbError,
    TransientDbError: actual.TransientDbError,
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

/**
 * The loader's weights are read-only in the type. The freeze tests write to
 * them anyway, to prove the run-time freeze, so they drop the type here.
 */
const mutable = (weights: DeepReadonly<LotteryWeights>): LotteryWeights =>
  weights as LotteryWeights;

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

/**
 * A fresh loader (empty cache), the seed object that fresh copy holds, and the
 * `TransientDbError` class of the same module graph, so an error built from it
 * is the one the loader's classifier recognises by `instanceof`.
 */
async function freshLoader() {
  vi.resetModules();
  const { loadLotteryWeights } =
    await import('../_lib/lottery-weights-loader.js');
  const { SEED_LOTTERY_WEIGHTS: seed } =
    await import('../_lib/lottery-weights-seed.js');
  const { TransientDbError } = await import('../_lib/db.js');
  return { load: loadLotteryWeights, seed, TransientDbError };
}

/** The one D9 alert: its title, level `error` and the fingerprint for `kind`. */
function expectFallbackReported(kind: 'transient' | 'error'): void {
  expect(h.captureMessage).toHaveBeenCalledTimes(1);
  expect(h.captureMessage).toHaveBeenCalledWith(
    'lottery weights fallback to seed',
    expect.objectContaining({
      level: 'error',
      fingerprint: ['lottery-weights-fallback', kind],
    }),
  );
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
    expectFallbackReported('transient');
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
    expectFallbackReported('error');
  });

  it.each([
    ['a ticker weight out of range', { QQQQ: 99 }],
    ['a ticker key that is not a symbol', { qqqq: 1 }],
  ])(
    'a malformed ticker entry (%s) is named <ticker>, never by its symbol',
    async (_label, bad) => {
      const weights = refitWeights();
      weights.features.ticker_weights = bad as Record<string, number>;
      h.mockSql.mockResolvedValueOnce([
        activeRow(REFIT_VERSION, weights),
        takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
      ]);
      const { load } = await freshLoader();

      const result = await load();

      expect(result.fallback?.kind).toBe('error');
      expect(result.fallback?.reason).toMatch(
        /^active version refit-2026-11-12 fails validation at features\.ticker_weights\.<ticker>: /,
      );
      // The reason is what the alert and the log carry: no symbol anywhere in them.
      const sent = JSON.stringify([
        h.captureMessage.mock.calls,
        h.error.mock.calls,
      ]);
      expect(sent).toContain('<ticker>');
      expect(sent.toLowerCase()).not.toContain('qqqq');
    },
  );

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
    expectFallbackReported('error');
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
    expectFallbackReported('error');
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
    expectFallbackReported('error');
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
    expectFallbackReported('error');
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
    expectFallbackReported('error');
  });

  it.each([
    ['null', null],
    ['an object', { rows: [] }],
    ['a string', 'oops'],
  ])(
    'never throws: a query result that is %s, not rows, falls back',
    async (_label, result) => {
      h.mockSql.mockResolvedValueOnce(result);
      const { load, seed } = await freshLoader();

      const loaded = await load();

      // The reason is fixed text: it carries nothing from the result.
      expect(loaded.fallback).toEqual({
        kind: 'error',
        reason: 'the pointer query did not return rows',
      });
      expect(loaded.active).toEqual({ version: SEED_VERSION, weights: seed });
      expectFallbackReported('error');
    },
  );

  it('never throws: a row that is not an object also falls back', async () => {
    h.mockSql.mockResolvedValueOnce([null]);
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('error');
    expect(result.active.version).toBe(SEED_VERSION);
    expectFallbackReported('error');
  });

  it('a weights value that is not an object is rejected at the root', async () => {
    h.mockSql.mockResolvedValueOnce([
      activeRow(REFIT_VERSION, null),
      takeitRow(SEED_VERSION, structuredClone(SEED_LOTTERY_WEIGHTS)),
    ]);
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('error');
    expect(result.fallback?.reason).toMatch(
      /^active version refit-2026-11-12 fails validation at the root: /,
    );
    expectFallbackReported('error');
  });

  it('a rejection that is not an Error is reported by its text, kind error', async () => {
    h.mockSql.mockRejectedValueOnce('boom');
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback).toEqual({ kind: 'error', reason: 'boom' });
    expectFallbackReported('error');
  });

  it.each(['fetch failed', 'a cause the classifier would not match'])(
    'a TransientDbError from the retry wrapper (cause: %s) is a transient fallback',
    async (cause) => {
      const { load, TransientDbError } = await freshLoader();
      h.mockSql.mockRejectedValueOnce(new TransientDbError(new Error(cause)));

      const result = await load();

      expect(result.fallback).toEqual({ kind: 'transient', reason: cause });
      expectFallbackReported('transient');
    },
  );

  it('a store that stays down, through the real retry wrapper, is a transient fallback', async () => {
    h.mockSql.mockRejectedValue(new Error('fetch failed'));
    const { load } = await freshLoader();
    h.withDbRetry.mockImplementation(h.realWithDbRetry!);

    const pending = load();
    await vi.advanceTimersByTimeAsync(1_000); // the wrapper's one backoff
    const result = await pending;

    expect(h.mockSql).toHaveBeenCalledTimes(2);
    expect(result.fallback).toEqual({
      kind: 'transient',
      reason: 'fetch failed',
    });
    expectFallbackReported('transient');
  });

  it('never throws: a Sentry that throws does not stop the fallback', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('fetch failed'));
    h.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry down at https://o123.ingest.sentry.io');
    });
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('transient');
    expect(result.active.version).toBe(SEED_VERSION);
    // The log line of the fallback still went out.
    expect(h.error).toHaveBeenCalledTimes(1);
    // And the lost alert is not silent: one fixed warning names it, with nothing of
    // the exception, whose text can carry the host it could not reach.
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      { report: 'fallback alert' },
      'lottery weights report failed',
    );
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('sentry');
  });

  it('never throws: a logger that throws does not stop the alert or the fallback', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('fetch failed'));
    h.error.mockImplementationOnce(() => {
      throw new Error('logger down');
    });
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('transient');
    expectFallbackReported('transient');
    expect(h.warn).toHaveBeenCalledWith(
      { report: 'fallback log' },
      'lottery weights report failed',
    );
  });

  it('never throws: a logger that throws on the warning too is silent about it', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('fetch failed'));
    h.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    h.warn.mockImplementation(() => {
      throw new Error('logger down');
    });
    const { load } = await freshLoader();

    const result = await load();

    expect(result.fallback?.kind).toBe('transient');
    expect(result.active.version).toBe(SEED_VERSION);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('never throws: a logger that throws does not stop the cached version', async () => {
    h.mockSql
      .mockResolvedValueOnce(promotedRows())
      .mockRejectedValueOnce(new Error('fetch failed'));
    h.warn.mockImplementationOnce(() => {
      throw new Error('logger down');
    });
    const { load } = await freshLoader();

    const first = await load();
    vi.advanceTimersByTime(TTL_MS);

    expect(await load()).toBe(first);
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
    expectFallbackReported('error');
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

  it('the seed is deep-frozen on its own, before anything loads it', async () => {
    // The scorer's default tier cutoffs alias the seed, and nothing there goes
    // through the loader, so the freeze cannot depend on the loader doing it.
    const { seed } = await freshLoader();

    expect(() => {
      seed.features.ticker_weights.AAPL = 99;
    }).toThrow(TypeError);
    expect(() => {
      seed.cutoffs.t1 = 0;
    }).toThrow(TypeError);
    expect(() => {
      seed.features.composite_bonuses[0]!.match.ticker = 'ZZZ';
    }).toThrow(TypeError);
    expect(() => {
      seed.features.composite_bonuses.push(seed.features.composite_bonuses[0]!);
    }).toThrow(TypeError);
  });

  it('the fallback result cannot be mutated into the seed', async () => {
    h.mockSql.mockRejectedValueOnce(new Error('fetch failed'));
    const { load, seed } = await freshLoader();

    const result = await load();
    const features = mutable(result.active.weights).features;
    const composite = features.composite_bonuses[0]!;

    expect(() => {
      features.ticker_weights.AAPL = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutable(result.takeit.weights).cutoffs.t1 = 0;
    }).toThrow(TypeError);
    expect(() => {
      features.composite_bonuses.push(composite);
    }).toThrow(TypeError);
    expect(() => {
      composite.match.ticker = 'ZZZ';
    }).toThrow(TypeError);
    expect(() => {
      result.active.version = 'x';
    }).toThrow(TypeError);
    expect(seed.features.ticker_weights.AAPL).toBe(-1);
    expect(seed.cutoffs.t1).toBe(10);
    expect(seed.features.composite_bonuses[0]).toBe(composite);
  });

  it('a loaded pair is shared for up to a minute, so it cannot be mutated', async () => {
    h.mockSql.mockResolvedValueOnce(promotedRows());
    const { load } = await freshLoader();

    const result = await load();
    const active = mutable(result.active.weights);
    const composite = active.features.composite_bonuses[0]!;

    expect(() => {
      active.features.ticker_weights.AAPL = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutable(result.takeit.weights).cutoffs.t1 = 0;
    }).toThrow(TypeError);
    expect(() => {
      composite.match.ticker = 'ZZZ';
    }).toThrow(TypeError);
    expect(() => {
      result.active.version = 'x';
    }).toThrow(TypeError);
    expect(() => {
      result.fallback = { kind: 'error', reason: 'x' };
    }).toThrow(TypeError);
    // The next caller still gets the pair as it was loaded.
    const again = await load();
    expect(again).toBe(result);
    expect(again.active.weights.features.ticker_weights.AAPL).toBe(0);
  });

  it('is read-only in the type as well: a write to a loaded version does not compile', async () => {
    h.mockSql.mockResolvedValueOnce(promotedRows());
    const { load } = await freshLoader();

    const { active } = await load();

    // Each directive is an error if the line below it compiles, so removing
    // `DeepReadonly` from the loader's types fails tsc here.
    expect(() => {
      // @ts-expect-error a property of a loaded version is read-only
      active.weights.cutoffs.t1 = 0;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error a ticker weight is read-only
      active.weights.features.ticker_weights.AAPL = 99;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error a list of a loaded version has no push
      active.weights.features.composite_bonuses.push(
        active.weights.features.composite_bonuses[0]!,
      );
    }).toThrow(TypeError);
  });
});
