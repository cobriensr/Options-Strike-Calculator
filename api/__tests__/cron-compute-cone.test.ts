// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ─────────────────────────────────────────────────────

const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
  transaction: vi.fn(),
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  schwabFetch: vi.fn(),
  cronGuard: vi.fn((req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'GET only' });
      return null;
    }
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization ?? '';
    if (!secret || authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    const isMarketHours =
      utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour <= 21;
    if (!isMarketHours) {
      res.status(200).json({ skipped: true, reason: 'Outside time window' });
      return null;
    }
    return {
      apiKey: '',
      today: now.toISOString().slice(0, 10),
    };
  }),
}));

import handler from '../cron/compute-cone.js';
import { schwabFetch } from '../_lib/api-helpers.js';

// ── Fixtures ──────────────────────────────────────────────────

// 2026-05-08 = Friday; 13:32Z = 9:32 EDT (1 min after compute-cone's
// scheduled fire). Inside the market-hours window the test cronGuard
// mock requires.
const MARKET_TIME = new Date('2026-05-08T13:32:00.000Z');
const TODAY = '2026-05-08';

function makeSPXWContract(
  putCall: 'PUT' | 'CALL',
  strike: number,
  mark: number,
) {
  return {
    putCall,
    // OSI-format with SPXW root (whitespace-padded) so the cron's
    // first-token root filter accepts it.
    symbol: `SPXW  260508${putCall === 'PUT' ? 'P' : 'C'}${String(Math.round(strike * 1000)).padStart(8, '0')}`,
    bid: mark - 0.25,
    ask: mark + 0.25,
    mark,
    strikePrice: strike,
    expirationDate: '2026-05-08T21:00:00.000Z',
  };
}

interface ChainOpts {
  spot?: number;
  callStrikes?: Array<[number, number]>; // [strike, mark]
  putStrikes?: Array<[number, number]>;
  expiry?: string;
}

function makeChain(opts: ChainOpts = {}) {
  const spot = opts.spot ?? 5800;
  const expiry = opts.expiry ?? TODAY;
  const expKey = `${expiry}:0`;
  const callExpDateMap: Record<string, Record<string, unknown[]>> = {
    [expKey]: {},
  };
  const putExpDateMap: Record<string, Record<string, unknown[]>> = {
    [expKey]: {},
  };
  for (const [strike, mark] of opts.callStrikes ?? []) {
    callExpDateMap[expKey]![String(strike)] = [
      makeSPXWContract('CALL', strike, mark),
    ];
  }
  for (const [strike, mark] of opts.putStrikes ?? []) {
    putExpDateMap[expKey]![String(strike)] = [
      makeSPXWContract('PUT', strike, mark),
    ];
  }
  return {
    symbol: '$SPX',
    status: 'SUCCESS',
    underlying: { symbol: '$SPX', last: spot, close: spot },
    callExpDateMap,
    putExpDateMap,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('compute-cone handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth + method guards ──────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 without CRON_SECRET', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Happy path ────────────────────────────────────────────

  it('persists a symmetric cone when call mark = put mark', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: makeChain({
        spot: 5800,
        callStrikes: [
          [5795, 8.0],
          [5800, 10.0], // ATM
          [5805, 8.5],
        ],
        putStrikes: [
          [5795, 8.5],
          [5800, 10.0], // ATM, same mark as ATM call
          [5805, 8.0],
        ],
      }),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    // Single INSERT into cone_levels — verify the SQL tagged template was
    // called with the right interpolated values.
    expect(mockSql).toHaveBeenCalledTimes(1);
    const callArgs = mockSql.mock.calls[0]!;
    // strings are at index 0, interpolated values follow at 1+. Just verify
    // the values landed in the expected cone math.
    const values = callArgs.slice(1) as unknown[];
    // Order matches the INSERT VALUES (...) tuple in compute-cone.ts:
    //   today, NOW(), spot, atm_strike,
    //   call_premium, put_premium,
    //   cone_upper, cone_lower, cone_width, asymmetry
    expect(values[0]).toBe(TODAY); // date
    // NOW() is literal SQL, not interpolated, so the spot value lands at index 1.
    expect(values[1]).toBe(5800); // spot_at_calc
    expect(values[2]).toBe(5800); // atm_strike
    expect(values[3]).toBe(10); // call_premium
    expect(values[4]).toBe(10); // put_premium
    expect(values[5]).toBe(5810); // cone_upper = 5800 + 10
    expect(values[6]).toBe(5790); // cone_lower = 5800 - 10
    expect(values[7]).toBe(20); // cone_width
    expect(values[8]).toBe(0); // asymmetry = put - call = 0
  });

  it('records positive asymmetry when put mark > call mark', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: makeChain({
        spot: 5800,
        callStrikes: [[5800, 8.0]],
        putStrikes: [[5800, 12.0]],
      }),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const values = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(values[5]).toBe(5808); // cone_upper
    expect(values[6]).toBe(5788); // cone_lower
    expect(values[7]).toBe(20); // cone_width
    expect(values[8]).toBe(4); // asymmetry = 12 - 8 = +4 (downside-skewed)
  });

  it('falls back to the put at the call ATM strike when sides disagree', async () => {
    // Asymmetric chain: calls have a 5pt gap on the upper side, puts have
    // a 5pt gap on the lower side, so pickAtmContract picks DIFFERENT ATM
    // strikes per side. The fallback in extractAtmMarks should re-look-up
    // the put at the call's ATM strike (5800) and use that mark.
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: makeChain({
        spot: 5803,
        callStrikes: [
          [5800, 10.0], // call ATM (3 away)
          [5810, 4.0],
        ],
        putStrikes: [
          [5800, 12.0], // present at call's ATM strike — fallback should use this
          [5805, 8.0], // put picker would pick this (2 away) — disagrees
        ],
      }),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const values = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(values[2]).toBe(5800); // atm_strike pinned to the call's pick
    expect(values[3]).toBe(10); // call_premium
    expect(values[4]).toBe(12); // put_premium re-looked-up at 5800, NOT 8.0
  });

  it('rejects non-SPXW contracts at the same strike (OSI root filter)', async () => {
    // Build a chain where strike 5800 has BOTH an SPXW contract (mark 10)
    // and an SPX monthly contract (mark 25) at the same strike. The cron's
    // root filter must pick the SPXW one — a regression to a substring or
    // missing filter would silently use the SPX monthly's mark and break
    // the cone math.
    const spxwCall = makeSPXWContract('CALL', 5800, 10);
    const spxMonthlyCall = {
      putCall: 'CALL' as const,
      symbol: `SPX   261218C${String(Math.round(5800 * 1000)).padStart(8, '0')}`,
      bid: 24.5,
      ask: 25.5,
      mark: 25, // very different from the SPXW mark
      strikePrice: 5800,
      expirationDate: '2026-12-18T21:00:00.000Z',
    };
    const spxwPut = makeSPXWContract('PUT', 5800, 10);
    const spxMonthlyPut = {
      putCall: 'PUT' as const,
      symbol: `SPX   261218P${String(Math.round(5800 * 1000)).padStart(8, '0')}`,
      bid: 19.5,
      ask: 20.5,
      mark: 20,
      strikePrice: 5800,
      expirationDate: '2026-12-18T21:00:00.000Z',
    };

    const expKey = `${TODAY}:0`;
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: { symbol: '$SPX', last: 5800, close: 5800 },
        callExpDateMap: { [expKey]: { '5800': [spxMonthlyCall, spxwCall] } },
        putExpDateMap: { [expKey]: { '5800': [spxMonthlyPut, spxwPut] } },
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).toHaveBeenCalledTimes(1);
    const values = mockSql.mock.calls[0]!.slice(1) as unknown[];
    // The 'SPX  ' monthly contracts (mark 25/20) appear FIRST in the
    // contracts array; if the root filter is broken the cron picks them
    // and call_premium = 25, put_premium = 20. With the filter intact,
    // it picks the SPXW contracts and call/put premium = 10 each.
    expect(values[3]).toBe(10); // call_premium = SPXW mark, NOT SPX monthly
    expect(values[4]).toBe(10); // put_premium = SPXW mark, NOT SPX monthly
  });

  it('picks the strike closest to spot as ATM', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: makeChain({
        spot: 5803,
        callStrikes: [
          [5795, 12.0],
          [5800, 9.0], // closer (3 away)
          [5805, 6.0], // closer still (2 away) → ATM
          [5810, 4.0],
        ],
        putStrikes: [
          [5795, 4.0],
          [5800, 6.0],
          [5805, 9.0], // ATM
          [5810, 12.0],
        ],
      }),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const values = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(values[2]).toBe(5805); // atm_strike picked as closest to 5803
  });

  // ── Failure paths ─────────────────────────────────────────

  it('does not INSERT when Schwab fetch fails', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'upstream',
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does not INSERT when underlying.last is invalid', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: {
        symbol: '$SPX',
        status: 'SUCCESS',
        underlying: { symbol: '$SPX', last: 0, close: 0 },
        callExpDateMap: {},
        putExpDateMap: {},
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does not INSERT when ATM contracts are missing', async () => {
    vi.mocked(schwabFetch).mockResolvedValueOnce({
      ok: true,
      data: makeChain({
        spot: 5800,
        callStrikes: [], // empty chain
        putStrikes: [],
      }),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql).not.toHaveBeenCalled();
  });
});
