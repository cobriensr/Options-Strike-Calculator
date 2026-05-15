// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
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
});
