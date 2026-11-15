// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';

import { DeadlineError, withDeadline } from '../_lib/deadline.js';
import { isRetryableDbError } from '../_lib/db.js';
import {
  FLOW_BREAKER_FAILURES,
  FLOW_PHASE_BUDGET_MS,
  FLOW_SERIES_DEADLINE_MS,
  FLOW_SERIES_MIN_DEADLINE_MS,
  fetchTickerFlowSeries,
  flowAtFireTime,
  nextFlowSeriesDeadlineMs,
  type TickerFlowSeries,
} from '../_lib/ticker-flow-snapshot.js';

function series(
  rows: Array<{ ts: string; cumNcp: number; cumNpp: number }>,
): TickerFlowSeries {
  return {
    ts: rows.map((r) => Date.parse(r.ts)),
    cumNcp: rows.map((r) => r.cumNcp),
    cumNpp: rows.map((r) => r.cumNpp),
  };
}

describe('flowAtFireTime', () => {
  it('returns {null, null} on empty series', () => {
    const empty: TickerFlowSeries = { ts: [], cumNcp: [], cumNpp: [] };
    expect(flowAtFireTime(empty, new Date('2026-05-12T14:00:00Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });

  it('returns {null, null} when fireTs precedes the earliest tick', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T13:59:59Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });

  it('returns the exact-match tick', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
      { ts: '2026-05-12T14:10:00Z', cumNcp: 350, cumNpp: -120 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:05:00Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('returns the largest tick at or before fireTs', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
      { ts: '2026-05-12T14:10:00Z', cumNcp: 350, cumNpp: -120 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:07:30Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('returns the last tick when fireTs is past the series', () => {
    const s = series([
      { ts: '2026-05-12T14:00:00Z', cumNcp: 100, cumNpp: -50 },
      { ts: '2026-05-12T14:05:00Z', cumNcp: 200, cumNpp: -80 },
    ]);
    expect(flowAtFireTime(s, new Date('2026-05-12T21:00:00Z'))).toEqual({
      cumNcp: 200,
      cumNpp: -80,
    });
  });

  it('handles a single-row series', () => {
    const s = series([{ ts: '2026-05-12T14:00:00Z', cumNcp: 42, cumNpp: -7 }]);
    expect(flowAtFireTime(s, new Date('2026-05-12T14:00:00Z'))).toEqual({
      cumNcp: 42,
      cumNpp: -7,
    });
    expect(flowAtFireTime(s, new Date('2026-05-12T14:00:01Z'))).toEqual({
      cumNcp: 42,
      cumNpp: -7,
    });
    expect(flowAtFireTime(s, new Date('2026-05-12T13:59:59Z'))).toEqual({
      cumNcp: null,
      cumNpp: null,
    });
  });
});

describe('fetchTickerFlowSeries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A Neon-shaped tagged template: every call is one query that went out.
  const dbReturning = (impl: () => Promise<unknown[]>) =>
    vi.fn(impl) as unknown as Parameters<typeof fetchTickerFlowSeries>[0] &
      ReturnType<typeof vi.fn>;

  it('turns the rows into running totals and parses string timestamps and NUMERICs', async () => {
    const db = dbReturning(async () => [
      { ts: '2026-05-01T13:30:00Z', cum_ncp: '100.5', cum_npp: '-20' },
      { ts: new Date('2026-05-01T13:31:00Z'), cum_ncp: 250, cum_npp: null },
    ]);

    const series = await fetchTickerFlowSeries(db, 'SNDK', '2026-05-01');

    expect(series).toEqual({
      ts: [
        Date.parse('2026-05-01T13:30:00Z'),
        Date.parse('2026-05-01T13:31:00Z'),
      ],
      cumNcp: [100.5, 250],
      cumNpp: [-20, 0],
    });
  });

  it('asks Neon once: a transient failure surfaces at once and no retry copy goes out', async () => {
    vi.useFakeTimers();
    const db = dbReturning(() => Promise.reject(new Error('fetch failed')));

    await expect(
      fetchTickerFlowSeries(db, 'SNDK', '2026-05-01'),
    ).rejects.toSatisfy(isRetryableDbError);
    // withDbRetry's backoff is 1 s, then 2 s: let both pass.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(db).toHaveBeenCalledTimes(1);
  });

  it('leaves no orphan retry behind once the caller’s deadline has given up on a hung query', async () => {
    vi.useFakeTimers();
    const db = dbReturning(() => new Promise<never>(() => {}));

    const run = withDeadline(
      fetchTickerFlowSeries(db, 'SNDK', '2026-05-01'),
      FLOW_SERIES_DEADLINE_MS,
      'ticker flow series',
    );
    const outcome = run.then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(FLOW_SERIES_DEADLINE_MS);
    expect(await outcome).toBeInstanceOf(DeadlineError);
    // The old per-attempt timeout (10 s) plus its 1 s backoff would have
    // started a second copy before the deadline even passed; a minute later
    // it would be running for nobody.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(db).toHaveBeenCalledTimes(1);
  });

  it('rethrows a genuine query error unchanged, so the caller can tell it from a blip', async () => {
    const broken = new Error('column "net_call_prem" does not exist');
    const db = dbReturning(() => Promise.reject(broken));

    await expect(fetchTickerFlowSeries(db, 'SNDK', '2026-05-01')).rejects.toBe(
      broken,
    );
    expect(isRetryableDbError(broken)).toBe(false);
  });
});

describe('nextFlowSeriesDeadlineMs', () => {
  it('pins the numbers the crons’ 60 s budget was checked against', () => {
    expect(FLOW_SERIES_DEADLINE_MS).toBe(15_000);
    expect(FLOW_PHASE_BUDGET_MS).toBe(25_000);
    expect(FLOW_SERIES_MIN_DEADLINE_MS).toBe(5_000);
    expect(FLOW_BREAKER_FAILURES).toBe(2);
  });

  it.each([
    // [failures so far, ms already spent waiting, expected next deadline]
    { failures: 0, spentMs: 0, expected: 15_000 },
    { failures: 0, spentMs: 6_000, expected: 15_000 },
    { failures: 0, spentMs: 10_000, expected: 15_000 },
    // The budget trims a deadline that would run past it.
    { failures: 0, spentMs: 12_000, expected: 13_000 },
    { failures: 1, spentMs: 15_000, expected: 10_000 },
    // One failure leaves the breaker closed; two open it.
    { failures: 1, spentMs: 0, expected: 15_000 },
    { failures: 2, spentMs: 0, expected: null },
    { failures: 3, spentMs: 0, expected: null },
    // Less than the old 5 s deadline left: not worth starting.
    { failures: 0, spentMs: 20_000, expected: 5_000 },
    { failures: 0, spentMs: 20_001, expected: null },
    { failures: 0, spentMs: 25_000, expected: null },
    { failures: 0, spentMs: 40_000, expected: null },
  ])(
    'after $failures failure(s) and $spentMs ms spent: $expected',
    ({ failures, spentMs, expected }) => {
      expect(nextFlowSeriesDeadlineMs(failures, spentMs)).toBe(expected);
    },
  );

  it('keeps a whole phase of failures and slow answers inside the budget', () => {
    // Worst case: every call takes its full deadline until the breaker or the
    // budget stops the run.
    let failures = 0;
    let spentMs = 0;
    for (;;) {
      const deadline = nextFlowSeriesDeadlineMs(failures, spentMs);
      if (deadline == null) break;
      spentMs += deadline;
      failures += 1;
    }
    expect(spentMs).toBeLessThanOrEqual(FLOW_PHASE_BUDGET_MS);
    expect(failures).toBe(FLOW_BREAKER_FAILURES);

    // Worst case with no failures: slow answers just under the deadline.
    spentMs = 0;
    let calls = 0;
    for (;;) {
      const deadline = nextFlowSeriesDeadlineMs(0, spentMs);
      if (deadline == null) break;
      spentMs += deadline - 1;
      calls += 1;
    }
    expect(spentMs).toBeLessThanOrEqual(FLOW_PHASE_BUDGET_MS);
    expect(calls).toBeGreaterThan(1);
  });
});
