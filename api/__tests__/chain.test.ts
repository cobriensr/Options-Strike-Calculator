// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwnerOrGuest: vi.fn(),
  schwabFetch: vi.fn(),
  setCacheHeaders: vi.fn(),
  isMarketOpen: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

import handler from '../chain.js';
import {
  rejectIfNotOwnerOrGuest,
  schwabFetch,
  isMarketOpen,
} from '../_lib/api-helpers.js';

/**
 * Build a minimal Schwab option contract for testing.
 */
function makeContract(
  putCall: 'PUT' | 'CALL',
  strike: number,
  overrides: Partial<{
    bid: number;
    ask: number;
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    volatility: number;
    totalVolume: number;
    openInterest: number;
    inTheMoney: boolean;
  }> = {},
) {
  return {
    putCall,
    symbol: `SPXW  260314${putCall === 'PUT' ? 'P' : 'C'}0${strike}000`,
    description: `SPXW Mar 14 2026 ${strike} ${putCall}`,
    bid: overrides.bid ?? 1.5,
    ask: overrides.ask ?? 2.0,
    last: 1.75,
    mark: 1.75,
    totalVolume: overrides.totalVolume ?? 100,
    openInterest: overrides.openInterest ?? 500,
    strikePrice: strike,
    delta: overrides.delta ?? (putCall === 'PUT' ? -0.1 : 0.1),
    gamma: overrides.gamma ?? 0.005,
    theta: overrides.theta ?? -0.5,
    vega: overrides.vega ?? 0.1,
    volatility: overrides.volatility ?? 20.0, // 20% IV
    daysToExpiration: 0,
    inTheMoney: overrides.inTheMoney ?? false,
    theoreticalValue: 1.75,
    expirationDate: '2026-03-14',
  };
}

/**
 * Build a Schwab chain response with given puts and calls.
 */
const DEFAULT_UNDERLYING = {
  symbol: '$SPX',
  last: 5700,
  close: 5690,
  change: 10,
};

function makeSchwabChain(
  puts: ReturnType<typeof makeContract>[],
  calls: ReturnType<typeof makeContract>[],
  underlying = DEFAULT_UNDERLYING,
) {
  const dateKey = '2026-03-14:0';

  const putMap: Record<string, ReturnType<typeof makeContract>[]> = {};
  for (const p of puts) {
    putMap[String(p.strikePrice)] = [p];
  }

  const callMap: Record<string, ReturnType<typeof makeContract>[]> = {};
  for (const c of calls) {
    callMap[String(c.strikePrice)] = [c];
  }

  return {
    symbol: '$SPX',
    status: 'SUCCESS',
    underlying,
    isDelayed: false,
    numberOfContracts: puts.length + calls.length,
    putExpDateMap: { [dateKey]: putMap },
    callExpDateMap: { [dateKey]: callMap },
  };
}

describe('GET /api/chain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest(), res);
    expect(res._status).toBe(401);
  });

  it('forwards error from schwabFetch', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: false,
      error: 'Token expired',
      status: 401,
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Token expired' });
  });

  it('returns empty chain when no contracts found', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: { symbol: '$SPX', last: 5700, close: 5690, change: 10 },
        isDelayed: false,
        numberOfContracts: 0,
        putExpDateMap: {},
        callExpDateMap: {},
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.error).toContain('No 0DTE contracts found');
    expect(json.puts).toEqual([]);
    expect(json.calls).toEqual([]);
    expect(json.targetDeltas).toEqual({});
  });

  it('returns puts, calls, and target deltas from chain data', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const puts = [
      makeContract('PUT', 5600, {
        delta: -0.05,
        bid: 1.0,
        ask: 1.2,
        volatility: 22.0,
      }),
      makeContract('PUT', 5650, {
        delta: -0.1,
        bid: 2.5,
        ask: 3.0,
        volatility: 20.0,
      }),
      makeContract('PUT', 5680, {
        delta: -0.15,
        bid: 4.0,
        ask: 4.5,
        volatility: 18.0,
      }),
    ];
    const calls = [
      makeContract('CALL', 5720, {
        delta: 0.15,
        bid: 4.0,
        ask: 4.5,
        volatility: 18.0,
      }),
      makeContract('CALL', 5750, {
        delta: 0.1,
        bid: 2.5,
        ask: 3.0,
        volatility: 20.0,
      }),
      makeContract('CALL', 5800, {
        delta: 0.05,
        bid: 1.0,
        ask: 1.2,
        volatility: 22.0,
      }),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(puts, calls),
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;

    // Underlying
    expect(json.underlying).toEqual({
      symbol: '$SPX',
      price: 5700,
      prevClose: 5690,
    });

    expect(json.expirationDate).toBe('2026-03-14');
    expect(json.daysToExpiration).toBe(0);

    // Puts and calls arrays
    const jsonPuts = json.puts as {
      strike: number;
      delta: number;
      iv: number;
    }[];
    const jsonCalls = json.calls as {
      strike: number;
      delta: number;
      iv: number;
    }[];
    expect(jsonPuts).toHaveLength(3);
    expect(jsonCalls).toHaveLength(3);

    // Verify first put is sorted by strike (ascending)
    expect(jsonPuts[0]!.strike).toBe(5600);
    expect(jsonPuts[0]!.delta).toBe(-0.05);
    expect(jsonPuts[0]!.iv).toBeCloseTo(0.22, 4);

    // Verify mid calculation: (1.0 + 1.2) / 2 = 1.10
    expect((jsonPuts[0] as unknown as { mid: number }).mid).toBe(1.1);

    // Target deltas: 5-delta should match 5600P / 5800C
    const td = json.targetDeltas as Record<
      number,
      { putStrike: number; callStrike: number }
    >;
    expect(td[5]).toBeDefined();
    expect(td[5]!.putStrike).toBe(5600);
    expect(td[5]!.callStrike).toBe(5800);

    // 10-delta should match 5650P / 5750C
    expect(td[10]).toBeDefined();
    expect(td[10]!.putStrike).toBe(5650);
    expect(td[10]!.callStrike).toBe(5750);

    // 15-delta should match 5680P / 5720C
    expect(td[15]).toBeDefined();
    expect(td[15]!.putStrike).toBe(5680);
    expect(td[15]!.callStrike).toBe(5720);
  });

  it('computes icCredit and width in targetDeltas', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const puts = [
      makeContract('PUT', 5600, { delta: -0.05, bid: 1.0, ask: 1.4 }),
    ];
    const calls = [
      makeContract('CALL', 5800, { delta: 0.05, bid: 2.0, ask: 2.6 }),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(puts, calls),
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const td = json.targetDeltas as Record<
      number,
      { icCredit: number; width: number; putMid: number; callMid: number }
    >;

    expect(td[5]).toBeDefined();
    // putMid = (1.0 + 1.4) / 2 = 1.20, callMid = (2.0 + 2.6) / 2 = 2.30
    expect(td[5]!.putMid).toBe(1.2);
    expect(td[5]!.callMid).toBe(2.3);
    expect(td[5]!.icCredit).toBe(3.5);
    expect(td[5]!.width).toBe(200); // 5800 - 5600
  });

  it('passes strikeCount query param to schwabFetch', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(
        [makeContract('PUT', 5650, { delta: -0.1 })],
        [makeContract('CALL', 5750, { delta: 0.1 })],
      ),
    });

    const req = mockRequest();
    req.query = { strikeCount: '60' };
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const url = vi.mocked(schwabFetch).mock.calls.at(-1)![0] as string;
    expect(url).toContain('strikeCount=60');
  });

  it('skips ITM puts (delta >= 0) when matching target deltas', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const puts = [
      // ITM put with positive delta — should be skipped
      makeContract('PUT', 5700, { delta: 0.5, inTheMoney: true }),
      makeContract('PUT', 5600, { delta: -0.05 }),
    ];
    const calls = [makeContract('CALL', 5800, { delta: 0.05 })];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(puts, calls),
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const td = json.targetDeltas as Record<number, { putStrike: number }>;
    // 5-delta should match the OTM put at 5600, not the ITM put at 5700
    expect(td[5]!.putStrike).toBe(5600);
  });

  it('skips ITM calls (delta <= 0) when matching target deltas', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const puts = [makeContract('PUT', 5600, { delta: -0.05 })];
    const calls = [
      // ITM call with negative delta — should be skipped
      makeContract('CALL', 5600, { delta: -0.5, inTheMoney: true }),
      makeContract('CALL', 5800, { delta: 0.05 }),
    ];

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(puts, calls),
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const td = json.targetDeltas as Record<number, { callStrike: number }>;
    expect(td[5]!.callStrike).toBe(5800);
  });

  it('handles empty contract list within a strike key', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    // Build chain with an empty contract array for one strike
    const dateKey = '2026-03-14:0';
    const putMap: Record<string, ReturnType<typeof makeContract>[]> = {
      '5600': [makeContract('PUT', 5600, { delta: -0.05 })],
      '5650': [], // empty list — should be skipped by flattenMap
    };
    const callMap: Record<string, ReturnType<typeof makeContract>[]> = {
      '5800': [makeContract('CALL', 5800, { delta: 0.05 })],
    };

    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: { symbol: '$SPX', last: 5700, close: 5690, change: 10 },
        isDelayed: false,
        numberOfContracts: 2,
        putExpDateMap: { [dateKey]: putMap },
        callExpDateMap: { [dateKey]: callMap },
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const jsonPuts = json.puts as { strike: number }[];
    // Only 1 put (the empty list at 5650 was skipped)
    expect(jsonPuts).toHaveLength(1);
    expect(jsonPuts[0]!.strike).toBe(5600);
  });

  it('returns null underlying when chain has no underlying', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: undefined as unknown,
        isDelayed: false,
        numberOfContracts: 0,
        putExpDateMap: {},
        callExpDateMap: {},
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.underlying).toBeNull();
  });

  it('falls back to nullish defaults when underlying fields are missing in buildResponse', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);

    const dateKey = '2026-03-14:0';
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: undefined as unknown,
        isDelayed: false,
        numberOfContracts: 1,
        putExpDateMap: {
          [dateKey]: {
            '5600': [makeContract('PUT', 5600, { delta: -0.05 })],
          },
        },
        callExpDateMap: {
          [dateKey]: {
            '5800': [makeContract('CALL', 5800, { delta: 0.05 })],
          },
        },
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.underlying).toEqual({
      symbol: '$SPX',
      price: 0,
      prevClose: 0,
    });
  });

  it('handles missing putExpDateMap/callExpDateMap (nullish coalescing)', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: { symbol: '$SPX', last: 5700, close: 5690, change: 10 },
        isDelayed: false,
        numberOfContracts: 0,
        putExpDateMap: undefined as unknown,
        callExpDateMap: undefined as unknown,
      },
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.error).toContain('No 0DTE contracts found');
    expect(json.puts).toEqual([]);
    expect(json.calls).toEqual([]);
  });

  it('sets shorter cache headers when market is closed', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(false);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(
        [makeContract('PUT', 5650, { delta: -0.1 })],
        [makeContract('CALL', 5750, { delta: 0.1 })],
      ),
    });

    const { setCacheHeaders } = await import('../_lib/api-helpers.js');
    const res = mockResponse();
    await handler(mockRequest(), res);

    expect(res._status).toBe(200);
    expect(vi.mocked(setCacheHeaders)).toHaveBeenCalledWith(res, 300, 60);
  });

  it('defaults strikeCount to 80', async () => {
    vi.mocked(rejectIfNotOwnerOrGuest).mockReturnValue(false);
    vi.mocked(isMarketOpen).mockReturnValue(true);
    vi.mocked(schwabFetch).mockResolvedValue({
      ok: true,
      data: makeSchwabChain(
        [makeContract('PUT', 5650, { delta: -0.1 })],
        [makeContract('CALL', 5750, { delta: 0.1 })],
      ),
    });

    const res = mockResponse();
    await handler(mockRequest(), res);

    const url = vi.mocked(schwabFetch).mock.calls[0]![0] as string;
    expect(url).toContain('strikeCount=80');
  });
});
