// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/db.js')>();
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    // Real classifier — drives sendDbErrorResponse's transient/500 split.
    isRetryableDbError: actual.isRetryableDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

import handler from '../opening-flow-signal.js';
import { Sentry } from '../_lib/sentry.js';
import {
  evaluateRule,
  evaluateSlice1,
  evaluateSlice2,
  pickContract,
  type RawTrade,
} from '../_lib/opening-flow.js';

/** Build a synthetic slice-1 trade list that aggregates to specific tickets. */
function ticketTrades(
  tickets: Array<{
    strike: number;
    side: 'call' | 'put';
    premium: number;
    volume: number;
  }>,
): RawTrade[] {
  const out: RawTrade[] = [];
  for (const t of tickets) {
    // premium = price * size * 100 -> derive price for the desired total premium
    const price = t.premium / (t.volume * 100);
    out.push({
      executedAt: '2026-05-13T13:30:00Z',
      strike: t.strike,
      optionTypeChar: t.side === 'call' ? 'C' : 'P',
      price,
      size: t.volume,
    });
  }
  return out;
}

describe('opening-flow rule library', () => {
  describe('evaluateSlice1', () => {
    it('aggregates and sorts $1M+ tickets by premium', () => {
      const trades = ticketTrades([
        { strike: 745, side: 'call', premium: 3_350_000, volume: 24_683 },
        { strike: 746, side: 'call', premium: 1_510_000, volume: 16_421 },
        { strike: 743, side: 'put', premium: 1_170_000, volume: 11_223 },
        // Sub-$1M: should be excluded
        { strike: 750, side: 'call', premium: 500_000, volume: 5000 },
      ]);
      const r = evaluateSlice1(trades);
      expect(r.tickets.length).toBe(3);
      expect(r.tickets[0]?.strike).toBe(745); // largest first
      expect(r.tickets[0]?.premium).toBeCloseTo(3_350_000, -2);
      expect(r.biasSide).toBe('call');
      expect(r.biasRatio).toBeGreaterThan(0.5);
    });

    it('detects top-3 same side', () => {
      const same = ticketTrades([
        { strike: 745, side: 'call', premium: 3_000_000, volume: 20_000 },
        { strike: 744, side: 'call', premium: 2_000_000, volume: 15_000 },
        { strike: 746, side: 'call', premium: 1_500_000, volume: 12_000 },
        { strike: 743, side: 'put', premium: 1_100_000, volume: 8_000 },
      ]);
      const r = evaluateSlice1(same);
      expect(r.top3SameSide).toBe(true);
      expect(r.biasSide).toBe('call');
    });

    it('flags top-3 mixed', () => {
      const mixed = ticketTrades([
        { strike: 745, side: 'call', premium: 3_000_000, volume: 20_000 },
        { strike: 744, side: 'put', premium: 2_000_000, volume: 15_000 },
        { strike: 746, side: 'call', premium: 1_500_000, volume: 12_000 },
      ]);
      const r = evaluateSlice1(mixed);
      expect(r.top3SameSide).toBe(false);
    });

    it('returns empty result when no tickets qualify', () => {
      const r = evaluateSlice1([]);
      expect(r.tickets.length).toBe(0);
      expect(r.biasSide).toBeNull();
      expect(r.top3SameSide).toBe(false);
    });
  });

  describe('evaluateSlice2', () => {
    it('computes bias share across ALL trades (no $1M filter)', () => {
      const trades: RawTrade[] = [
        // 78% calls is the SPY 5/14 number
        {
          executedAt: 'x',
          strike: 745,
          optionTypeChar: 'C',
          price: 1,
          size: 78_000,
        },
        {
          executedAt: 'x',
          strike: 743,
          optionTypeChar: 'P',
          price: 1,
          size: 22_000,
        },
      ];
      const r = evaluateSlice2(trades, 'call');
      expect(r.biasShare).toBeCloseTo(0.78, 2);
      expect(r.confirms).toBe(true);
    });

    it('rejects when bias share < 60%', () => {
      const trades: RawTrade[] = [
        {
          executedAt: 'x',
          strike: 745,
          optionTypeChar: 'C',
          price: 1,
          size: 55_000,
        },
        {
          executedAt: 'x',
          strike: 743,
          optionTypeChar: 'P',
          price: 1,
          size: 45_000,
        },
      ];
      const r = evaluateSlice2(trades, 'call');
      expect(r.confirms).toBe(false);
    });
  });

  describe('pickContract', () => {
    it('picks highest-volume bias-side ticket (NOT largest-premium)', () => {
      // Largest premium is 745C, but highest volume is 744C
      const r = evaluateSlice1(
        ticketTrades([
          { strike: 745, side: 'call', premium: 3_500_000, volume: 18_000 },
          { strike: 744, side: 'call', premium: 2_500_000, volume: 25_000 },
          { strike: 746, side: 'call', premium: 1_500_000, volume: 12_000 },
        ]),
      );
      const c = pickContract(r.tickets, 'call');
      expect(c?.strike).toBe(744);
      expect(c?.volume).toBe(25_000);
    });
  });

  describe('evaluateRule', () => {
    const winningSlice1 = ticketTrades([
      { strike: 745, side: 'call', premium: 3_350_000, volume: 24_683 },
      { strike: 744, side: 'call', premium: 2_530_000, volume: 13_554 },
      { strike: 746, side: 'call', premium: 1_510_000, volume: 16_421 },
    ]);
    const winningSlice2: RawTrade[] = [
      {
        executedAt: 'x',
        strike: 745,
        optionTypeChar: 'C',
        price: 1,
        size: 78_000,
      },
      {
        executedAt: 'x',
        strike: 743,
        optionTypeChar: 'P',
        price: 1,
        size: 22_000,
      },
    ];

    it('fires the signal when both conditions hold and slice 2 is complete', () => {
      const r = evaluateRule({
        slice1Trades: winningSlice1,
        slice2Trades: winningSlice2,
        slice2Complete: true,
      });
      expect(r.signal.fired).toBe(true);
      if (r.signal.fired) {
        expect(r.signal.side).toBe('call');
        expect(r.signal.contract.strike).toBe(745); // highest volume in winningSlice1
        expect(r.signal.contract.volume).toBe(24_683);
      }
    });

    it('blocks when slice 2 incomplete', () => {
      const r = evaluateRule({
        slice1Trades: winningSlice1,
        slice2Trades: winningSlice2,
        slice2Complete: false,
      });
      expect(r.signal.fired).toBe(false);
      if (!r.signal.fired) expect(r.signal.reason).toBe('window_not_complete');
    });

    it('blocks when top-3 mixed', () => {
      const mixed = ticketTrades([
        { strike: 745, side: 'call', premium: 3_000_000, volume: 20_000 },
        { strike: 744, side: 'put', premium: 2_000_000, volume: 15_000 },
        { strike: 746, side: 'call', premium: 1_500_000, volume: 12_000 },
      ]);
      const r = evaluateRule({
        slice1Trades: mixed,
        slice2Trades: winningSlice2,
        slice2Complete: true,
      });
      expect(r.signal.fired).toBe(false);
      if (!r.signal.fired) expect(r.signal.reason).toBe('top3_mixed');
    });

    it('blocks when slice-2 bias share < 60%', () => {
      const weakSlice2: RawTrade[] = [
        {
          executedAt: 'x',
          strike: 745,
          optionTypeChar: 'C',
          price: 1,
          size: 55_000,
        },
        {
          executedAt: 'x',
          strike: 743,
          optionTypeChar: 'P',
          price: 1,
          size: 45_000,
        },
      ];
      const r = evaluateRule({
        slice1Trades: winningSlice1,
        slice2Trades: weakSlice2,
        slice2Complete: true,
      });
      expect(r.signal.fired).toBe(false);
      if (!r.signal.fired) expect(r.signal.reason).toBe('s2_below_60');
    });

    it('blocks when no tickets qualify', () => {
      const r = evaluateRule({
        slice1Trades: [],
        slice2Trades: [],
        slice2Complete: true,
      });
      expect(r.signal.fired).toBe(false);
      if (!r.signal.fired) expect(r.signal.reason).toBe('no_tickets');
    });
  });
});

describe('opening-flow-signal endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns before_open status outside the window', async () => {
    // Force the system clock to 06:00 ET (well before 09:30 ET open).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:00:00Z'));
    mockSql.mockResolvedValue([]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      windowStatus: string;
      tickers: Record<string, unknown>;
    };
    expect(body.windowStatus).toBe('before_open');
    expect(body.tickers).toHaveProperty('SPY');
    expect(body.tickers).toHaveProperty('QQQ');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('fires SPY signal for a historical date when DB returns winning trades', async () => {
    // First call is `readOpeningFlowSnapshot` — return [] so the
    // endpoint falls back to live-compute (the legacy path under test).
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockImplementation(async () => {
      // Both slice1 and slice2 queries get this — simplified: 745C dominant for both
      return [
        {
          executed_at: '2026-05-13T13:30:00Z',
          strike: 745,
          option_type: 'C',
          price: 1.36,
          size: 24_683,
        },
        {
          executed_at: '2026-05-13T13:30:30Z',
          strike: 744,
          option_type: 'C',
          price: 1.87,
          size: 13_554,
        },
        {
          executed_at: '2026-05-13T13:31:00Z',
          strike: 746,
          option_type: 'C',
          price: 0.92,
          size: 16_421,
        },
        {
          executed_at: '2026-05-13T13:31:30Z',
          strike: 743,
          option_type: 'P',
          price: 1.05,
          size: 11_223,
        },
      ];
    });

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-13' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      windowStatus: string;
      tickers: Record<
        string,
        {
          signal: {
            fired: boolean;
            side?: string;
            contract?: { strike: number; volume: number };
          };
        }
      >;
    };
    // Historical date forces effective-now past close -> 'closed' status.
    expect(body.windowStatus).toBe('closed');
    expect(body.tickers.SPY?.signal.fired).toBe(true);
    expect(body.tickers.SPY?.signal.side).toBe('call');
    // Highest-volume call across the synthetic trades is 745C (24,683)
    expect(body.tickers.SPY?.signal.contract?.strike).toBe(745);
  });

  it('returns 400 on invalid date format', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toBe('invalid query');
  });

  it('reads from opening_flow_signals table for a historical date when a snapshot exists', async () => {
    // Single SQL call expected — the store's table SELECT. Evaluator
    // SQL (slice1 + slice2 ws_option_trades queries) MUST NOT run.
    const SAMPLE_SPY = {
      ticker: 'SPY',
      window_status: 'closed',
      slice1: {
        tickets: [],
        callPremium: 1_000_000,
        putPremium: 500_000,
        biasSide: 'call',
        biasRatio: 2,
        top3SameSide: true,
      },
      slice2: {
        totalPremium: 1_500_000,
        biasPremium: 1_100_000,
        biasShare: 0.733,
        confirms: true,
      },
      signal: {
        fired: true,
        side: 'call',
        contract: {
          strike: 745,
          side: 'call',
          premium: 1_000_000,
          volume: 24_000,
          avgFill: 1.36,
        },
        entryPrice: 1.36,
      },
      as_of_utc: '2026-05-13T13:50:00Z',
      // Neon NUMERIC binds back as string — verify the store coerces.
      stop_pct: '0.3',
      exit_minutes_from_entry: 60,
    };
    const SAMPLE_QQQ = {
      ticker: 'QQQ',
      window_status: 'closed',
      slice1: null,
      slice2: null,
      signal: { fired: false, reason: 'no_tickets' },
      as_of_utc: '2026-05-13T13:50:00Z',
      stop_pct: '0.3',
      exit_minutes_from_entry: 60,
    };
    mockSql.mockResolvedValueOnce([SAMPLE_SPY, SAMPLE_QQQ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-13' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      windowStatus: string;
      asOfUtc: string;
      stopPct: number;
      exitMinutesFromEntry: number;
      tickers: Record<
        string,
        {
          slice1: unknown;
          slice2: { biasShare: number; confirms: boolean } | null;
          signal: { fired: boolean; side?: string };
        }
      >;
    };
    expect(body.windowStatus).toBe('closed');
    expect(body.asOfUtc).toBe('2026-05-13T13:50:00Z');
    // NUMERIC string '0.3' must coerce to number 0.3.
    expect(body.stopPct).toBe(0.3);
    expect(typeof body.stopPct).toBe('number');
    expect(body.exitMinutesFromEntry).toBe(60);
    expect(body.tickers.SPY?.signal.fired).toBe(true);
    expect(body.tickers.SPY?.signal.side).toBe('call');
    expect(body.tickers.SPY?.slice2?.biasShare).toBe(0.733);
    expect(body.tickers.QQQ?.signal.fired).toBe(false);
    expect(body.tickers.QQQ?.slice1).toBeNull();

    // Exactly ONE SQL call — the store's SELECT. The evaluator's
    // ws_option_trades queries did NOT run.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('falls back to live compute when no stored snapshot exists for a historical date', async () => {
    // First call: store query returns [] (no row captured). Subsequent
    // calls: evaluator's slice1 + slice2 SELECTs over ws_option_trades.
    mockSql.mockResolvedValueOnce([]); // store SELECT
    mockSql.mockResolvedValue([]); // evaluator queries — empty trades

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-13' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      windowStatus: string;
      tickers: Record<
        string,
        { slice1: unknown; slice2: unknown; signal: { fired: boolean } }
      >;
    };
    // Historical date forces effectiveNow past close → 'closed'.
    expect(body.windowStatus).toBe('closed');
    // Empty trade tape → no signal for either ticker.
    expect(body.tickers.SPY?.signal.fired).toBe(false);
    expect(body.tickers.QQQ?.signal.fired).toBe(false);
    // Store SELECT (1) + per-ticker slice1+slice2 (2 × 2 = 4) = 5 calls.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('skips the store and live-computes when date matches today (ET)', async () => {
    // Pin the wall-clock to a known ET moment so getETDateStr is
    // deterministic. 2026-05-13T20:00:00Z = 16:00 ET — well past
    // close, so the evaluator's effective window is 'closed'.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T20:00:00Z'));
    // Evaluator's slice1 + slice2 queries return empty.
    mockSql.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-13' }, // === today in ET
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { windowStatus: string };
    expect(body.windowStatus).toBe('closed');
    // 4 evaluator calls (SPY slice1, SPY slice2, QQQ slice1, QQQ slice2)
    // — the store SELECT must NOT run for today's date.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('returns 400 when date passes Zod regex but evaluator rejects (month 13)', async () => {
    // `2026-13-01` matches the Zod regex `^\d{4}-\d{2}-\d{2}$` so it
    // reaches the evaluator, which then throws
    // `InvalidTradingDateError` because etWallClockToUtcIso rejects
    // the impossible month. Endpoint must map that to a 400, not a 500.
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-13-01' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    const body = res._json as { error: string };
    expect(body.error).toContain('invalid trading date');
    // No DB query — evaluator throws before any SQL runs.
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('degrades to 503 + Retry-After on a transient db timeout (no Sentry)', async () => {
    // Historical date → first SQL call is the store SELECT; reject it
    // with the per-attempt timeout signature.
    mockSql.mockRejectedValue(new Error('db attempt timeout'));

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-13' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns 500 + captures Sentry on a generic (non-transient) error', async () => {
    mockSql.mockRejectedValue(new Error('boom'));

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-13' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: 'Internal server error' });
    expect(res._headers['Retry-After']).toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
