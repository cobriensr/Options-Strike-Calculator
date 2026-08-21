// @vitest-environment node

/**
 * Unit tests for `mapWithConcurrency` (api/_lib/uw-fetch.ts).
 *
 * The helper is pure scheduling — no network — so the workers here are
 * hand-controlled deferreds: the test decides exactly when each item
 * settles and can observe which items were ever started.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
    uwRateLimit: vi.fn(),
  },
}));

import { mapWithConcurrency } from '../_lib/uw-fetch.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending microtask run (the helper's loops are promise-driven). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Build N deferred workers. `started` records the order items were pulled;
 * `settled` records the order they finished.
 */
function deferredWorkers(n: number) {
  const slots = Array.from({ length: n }, () => deferred<string>());
  const started: number[] = [];
  const settled: number[] = [];
  const worker = vi.fn(async (_item: number, idx: number) => {
    started.push(idx);
    try {
      return await slots[idx]!.promise;
    } finally {
      settled.push(idx);
    }
  });
  return { slots, started, settled, worker };
}

describe('mapWithConcurrency', () => {
  it('returns [] without invoking the worker for an empty input', async () => {
    const worker = vi.fn();
    await expect(mapWithConcurrency([], 3, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('maps every item, keeps input order, and never exceeds the limit', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6];
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = vi.fn(async (item: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Resolve out of input order (later items first) to prove the output
      // is placed by index, not by completion.
      await new Promise((r) => setTimeout(r, 10 - item));
      inFlight -= 1;
      return `r${item}`;
    });

    const out = await mapWithConcurrency(items, 3, worker);

    expect(out).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(worker).toHaveBeenCalledTimes(items.length);
    expect(maxInFlight).toBe(3);
  });

  it('pulls items in input-index order from the shared cursor', async () => {
    const items = [0, 1, 2, 3, 4];
    const { slots, started, worker } = deferredWorkers(items.length);

    const pending = mapWithConcurrency(items, 2, worker);
    await flush();
    expect(started).toEqual([0, 1]);

    slots[1]!.resolve('r1');
    await flush();
    expect(started).toEqual([0, 1, 2]);

    slots[0]!.resolve('r0');
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    slots[2]!.resolve('r2');
    slots[3]!.resolve('r3');
    await flush();
    slots[4]!.resolve('r4');

    await expect(pending).resolves.toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  // ── Fail-fast ──────────────────────────────────────────────
  //
  // Before: a rejected item took down the caller's Promise.all immediately,
  // but every OTHER runner kept pulling from the cursor until the list was
  // exhausted — a 66-date /pricehistory fan-out that hit a sidecar outage on
  // date 2 went on to fire the remaining 60 dates at the sidecar after the
  // caller had already moved on. Now the first rejection flips a shared flag:
  // runners finish the item they hold (nothing is cancelled) and then stop.

  it('stops dispatching new items after the first rejection; in-flight items finish', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const { slots, started, settled, worker } = deferredWorkers(items.length);
    const boom = new Error('sidecar 503 theta_busy');

    const pending = mapWithConcurrency(items, 3, worker);
    // Attach the rejection handler up front so the early rejection below is
    // never observed as unhandled while the test is still driving timers.
    const outcome = pending.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await flush();
    // The in-flight set is exactly the first `limit` items.
    expect(started).toEqual([0, 1, 2]);

    // Item 1 rejects while 0 and 2 are still in flight.
    slots[1]!.reject(boom);
    await flush();

    // The first rejection propagates — Promise.all semantics, same error the
    // caller always saw...
    await expect(outcome).resolves.toBe(boom);

    // ...and the runners that were holding items 0 and 2 finish them
    // (nothing is cancelled) but pull NOTHING further: items 3–7 are never
    // started, even once every in-flight item has settled.
    slots[0]!.resolve('r0');
    slots[2]!.resolve('r2');
    await flush();
    expect(settled).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(settled).toHaveLength(3);
    expect(started).toEqual([0, 1, 2]);
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it('propagates the FIRST rejection when several in-flight items reject', async () => {
    const items = [0, 1, 2];
    const { slots, worker } = deferredWorkers(items.length);
    const first = new Error('first');
    const second = new Error('second');

    const pending = mapWithConcurrency(items, 3, worker);
    const outcome = pending.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await flush();

    slots[2]!.reject(first);
    await flush();
    slots[0]!.reject(second);
    slots[1]!.resolve('r1');
    await flush();

    await expect(outcome).resolves.toBe(first);
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it('does not fail fast on a resolved item (a non-throwing worker is unaffected)', async () => {
    const items = [0, 1, 2, 3, 4];
    const worker = vi.fn(async (item: number) => item * 2);
    await expect(mapWithConcurrency(items, 2, worker)).resolves.toEqual([
      0, 2, 4, 6, 8,
    ]);
    expect(worker).toHaveBeenCalledTimes(5);
  });
});
