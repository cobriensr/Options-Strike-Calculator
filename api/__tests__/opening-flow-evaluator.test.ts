// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  evaluateOpeningFlow,
  InvalidTradingDateError,
} from '../_lib/opening-flow-evaluator.js';

beforeEach(() => {
  vi.resetAllMocks();
  mockSql.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('evaluateOpeningFlow', () => {
  it('throws InvalidTradingDateError on a malformed date', async () => {
    await expect(
      evaluateOpeningFlow('not-a-date', { now: new Date() }),
    ).rejects.toBeInstanceOf(InvalidTradingDateError);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns before_open status + null per-ticker payloads when now is pre-09:30 ET', async () => {
    // 2026-05-13 06:00 ET = 10:00 UTC. Open is at 13:30 UTC.
    const result = await evaluateOpeningFlow('2026-05-13', {
      now: new Date('2026-05-13T10:00:00Z'),
    });
    expect(result.windowStatus).toBe('before_open');
    expect(result.tickers.SPY).toEqual({
      slice1: null,
      slice2: null,
      signal: null,
    });
    expect(result.tickers.QQQ).toEqual({
      slice1: null,
      slice2: null,
      signal: null,
    });
    // No DB query when the window hasn't opened.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns slice1 status when now is mid-slice-1 (09:32 ET, only slice 1 queried)', async () => {
    // 09:32 ET on 2026-05-13 — 2 minutes into slice 1. Provide synthetic
    // winning-call trades so slice1 has data; slice2 must NOT be queried.
    mockSql.mockResolvedValueOnce([
      {
        executed_at: '2026-05-13T13:31:00Z',
        strike: 745,
        option_type: 'C',
        price: 1.36,
        size: 30_000,
      },
    ]);
    const result = await evaluateOpeningFlow('2026-05-13', {
      now: new Date('2026-05-13T13:32:00Z'),
    });
    expect(result.windowStatus).toBe('slice1');
    expect(result.tickers.SPY?.slice1).not.toBeNull();
    // slice2 is populated by evaluateRule with zero-counts (not yet
    // confirmed). The evaluator only suppresses the slice2 SQL query
    // during slice1 — it doesn't suppress the result shape.
    expect(result.tickers.SPY?.slice2?.confirms).toBe(false);
    expect(result.tickers.SPY?.slice2?.totalPremium).toBe(0);
    // 2 tickers × 1 query each = 2 SQL calls in slice1 phase
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns evaluating status at 09:42 ET (between slice2End and close)', async () => {
    // 09:42 ET — past slice 2 end (09:40), before close (09:45). Both
    // slice1 + slice2 queries run.
    const result = await evaluateOpeningFlow('2026-05-13', {
      now: new Date('2026-05-13T13:42:00Z'),
    });
    expect(result.windowStatus).toBe('evaluating');
    // 2 tickers × 2 queries = 4 SQL calls
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('returns closed status for a historical date (time-travel forces effective-now to 1h past open)', async () => {
    // Real wall-clock is days later, but the evaluator should ignore
    // that and pretend the request landed an hour past the requested
    // date's open — yielding 'closed' status.
    const result = await evaluateOpeningFlow('2026-05-13', {
      now: new Date('2026-05-19T20:00:00Z'),
    });
    expect(result.windowStatus).toBe('closed');
    // The asOfUtc reflects the synthetic effective-now (openMs + 1h),
    // not the wall-clock provided in `opts.now`.
    const asOfMs = Date.parse(result.asOfUtc);
    const openMs = Date.parse(result.openUtc);
    expect(asOfMs - openMs).toBe(60 * 60_000);
  });

  it('echoes the requested date, open ISO, and OFS constants on the result', async () => {
    const result = await evaluateOpeningFlow('2026-05-13', {
      now: new Date('2026-05-13T10:00:00Z'),
    });
    expect(result.date).toBe('2026-05-13');
    expect(result.openUtc).toBe('2026-05-13T13:30:00.000Z');
    expect(result.slice1EndUtc).toBe('2026-05-13T13:35:00.000Z');
    expect(result.slice2EndUtc).toBe('2026-05-13T13:40:00.000Z');
    // OFS constants are frozen on the result for historical replays.
    expect(typeof result.stopPct).toBe('number');
    expect(typeof result.exitMinutesFromEntry).toBe('number');
  });
});
