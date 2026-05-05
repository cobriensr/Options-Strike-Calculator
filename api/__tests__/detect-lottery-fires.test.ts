// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/detect-lottery-fires.js';

const GUARD = { apiKey: '', today: '2026-05-01' };

// ============================================================
// Fixture builders — generate ws_option_trades-shaped tick rows that
// the v4 detector will accept on a single chain.
// ============================================================

function tick(
  optionChain: string,
  ticker: string,
  optionType: 'C' | 'P',
  strike: number,
  expiry: string,
  executedAtIso: string,
  overrides: {
    price?: number;
    size?: number;
    underlying_price?: number | null;
    side?: 'ask' | 'bid' | 'mid' | 'no_side';
    iv?: number | null;
    delta?: number | null;
    open_interest?: number | null;
  } = {},
) {
  return {
    ticker,
    option_chain: optionChain,
    option_type: optionType,
    strike,
    expiry,
    executed_at: executedAtIso,
    price: overrides.price ?? 0.5,
    size: overrides.size ?? 50,
    underlying_price: overrides.underlying_price ?? 1170,
    side: overrides.side ?? 'ask',
    implied_volatility: overrides.iv ?? 0.5,
    delta: overrides.delta ?? 0.18,
    open_interest: overrides.open_interest ?? 1000,
  };
}

/**
 * Six SNDK call ticks at 30s spacing — sums to 150 contracts on
 * OI=1000, all ask-side, IV/delta well above thresholds. The detector
 * fires once on this stream (entry = next print after trigger).
 */
function fireableSndkStream() {
  return [
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:30:00Z',
      { size: 50 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:30:30Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:31:00Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:31:30Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:32:00Z',
      { size: 20 },
    ),
    tick(
      'SNDK260501C01175000',
      'SNDK',
      'C',
      1175,
      '2026-05-01',
      '2026-05-01T13:32:30Z',
      { size: 20 },
    ),
  ];
}

describe('detect-lottery-fires handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCronGuard.mockReturnValue(GUARD);
    mockSql.mockResolvedValue([]);
    process.env.CRON_SECRET = 'test-secret';
  });

  it('returns skipped when no ticks are in the scan window', async () => {
    // Single SQL call: the SELECT returns []. The handler short-circuits
    // and never reaches macro / insert queries.
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'skipped',
      message: 'no ticks in scan window',
    });
    // Only the initial SELECT — no macro lookups, no inserts.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('inserts a fire when the v4 detector matches a chain', async () => {
    // Mock sequence:
    //   1. SELECT recent ticks → fireable SNDK stream
    //   2. SELECT prior fires per chain → [] (no cooldown seed)
    //   3. flow_data macro lookup → []
    //   4. spot_exposures macro lookup → []
    //   5. INSERT → [{ id: 42 }]
    // Note: SNDK is in the LOTTERY_V3_TICKERS list and DTE=0, so the
    // mode-classifier returns A_intraday_0DTE; the strike-exposures
    // query is gated on TICKERS_WITH_GEX_STRIKE which excludes SNDK,
    // so it is NOT called.
    mockSql
      .mockResolvedValueOnce(fireableSndkStream()) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([{ id: 42 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      // withCronInstrumentation spreads metadata flat into the response
      scanned: 6,
      chains: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('persists computeLotteryScore() output on the inserted row', async () => {
    // Same fixture as the basic insert test. The detector pulls
    // ticker=SNDK (weight 10), mode=A_intraday_0DTE (5),
    // entryPrice=0.5 (≤$0.50 → 5), tod=AM_open (13:30Z = 9:30 ET → 3),
    // optionType=C (2) → score 25. Pinning this guards the score
    // column wiring against future field renames in the INSERT.
    mockSql
      .mockResolvedValueOnce(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // The INSERT is the last mockSql call (after ticks SELECT, prior
    // fires, flow_data, spot_exposures). Score is the last bound value
    // before the closing `)` so it's the trailing slot in the call's
    // arg list.
    const insertCall = mockSql.mock.calls.at(-1) as unknown[];
    const score = insertCall.at(-1);
    expect(score).toBe(25);
  });

  it('issues the strike_exposures query for SPY (in TICKERS_WITH_GEX_STRIKE)', async () => {
    const spyStream = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'SPY',
      option_chain: 'SPY260501C00500000',
      strike: 500,
      underlying_price: 500,
    }));
    // 5 queries for non-strike tickers, 6 for strike tickers (extra
    // strike_exposures lookup): ticks, prior fires, flow_data,
    // spot_exposures, strike_exposures, insert.
    mockSql
      .mockResolvedValueOnce(spyStream) // ticks
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([]) // strike_exposures
      .mockResolvedValueOnce([{ id: 1 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ status: 'success', rows: 1 });
    expect(mockSql).toHaveBeenCalledTimes(6);
  });

  it('skips chains with fewer than the per-chain min prints', async () => {
    // Only 4 ticks — below PER_CHAIN_MIN_PRINTS (5). Handler bails
    // before macro lookups.
    const shortStream = fireableSndkStream().slice(0, 4);
    mockSql.mockResolvedValueOnce(shortStream);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      skippedShort: 1,
      totalFires: 0,
      inserted: 0,
    });
  });

  it('skips OUT_OF_UNIVERSE chains (e.g. unknown ticker)', async () => {
    const fakeStream = fireableSndkStream().map((t) => ({
      ...t,
      ticker: 'FAKE',
      option_chain: 'FAKE260501C00100000',
      strike: 100,
    }));
    mockSql
      .mockResolvedValueOnce(fakeStream) // ticks
      .mockResolvedValueOnce([]); // prior fires (chain passes min-prints)

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
    });
    // Ticks SELECT + prior-fires lookup — fire was detected but mode
    // classifier dropped it as OUT_OF_UNIVERSE so no macro lookups happen.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('continues with EMPTY_MACRO when the macro snapshot lookup throws', async () => {
    // Mock sequence: tick SELECT → prior-fires SELECT → flow_data
    // REJECTS → insert still happens because the cron catches macro
    // errors. The other two parallel macro queries are scheduled but
    // the .then chain on flow_data rejects first inside Promise.all,
    // so we only need one mocked query to drive the failure path.
    mockSql
      .mockResolvedValueOnce(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockRejectedValueOnce(new Error('flow_data ECONNRESET'))
      // Promise.all evaluates all three macro queries in parallel; the
      // remaining two are still consumed even though Promise.all
      // already short-circuited via the rejection.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99 }]); // insert proceeds with EMPTY_MACRO

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Fire still landed in the table — macro is display-only so a
    // transient flow_data outage must not drop alerts.
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
    });
  });

  it('honors ON CONFLICT (returns 0 inserted when DB returns no rows)', async () => {
    mockSql
      .mockResolvedValueOnce(fireableSndkStream())
      .mockResolvedValueOnce([]) // prior fires
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // insert returns no rows = ON CONFLICT hit

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 1,
      inserted: 0,
    });
  });

  it('seeds detector cooldown from prior-fire SELECT — no duplicate fire when within 5-min window', async () => {
    // Real-world dup pattern: a prior cron run fired on this chain at
    // T-3min. The detector's in-memory cooldown is 5min; without a DB
    // seed the next cron run (here) re-qualifies the same window and
    // emits a duplicate fire with a slightly later trigger_time_ct.
    //
    // The fireable stream's first tick is 13:30:00Z. We seed the
    // prior-fires SELECT with last_ms = 13:28:00Z (2 min before the
    // first tick → within the 5-min cooldown). detectChainFires must
    // suppress the fire entirely. No flow_data / spot / insert calls.
    const priorMs = Date.parse('2026-05-01T13:28:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSndkStream()) // ticks
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260501C01175000',
          last_ms: String(priorMs),
        },
      ]); // prior fires — cooldown active

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 0,
      totalFires: 0,
      inserted: 0,
      priorSeeds: 1,
    });
    // Exactly two SQL calls: the ticks SELECT and the prior-fires
    // lookup. No macro queries, no insert.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('still fires when prior-fire is older than the 5-min cooldown', async () => {
    // Same fixture, but the prior fire is 6 minutes before the first
    // tick — outside the cooldown window. detectChainFires lets the
    // current trigger through as if no prior had been recorded.
    const priorMs = Date.parse('2026-05-01T13:24:00Z');
    mockSql
      .mockResolvedValueOnce(fireableSndkStream())
      .mockResolvedValueOnce([
        {
          option_chain_id: 'SNDK260501C01175000',
          last_ms: String(priorMs),
        },
      ])
      .mockResolvedValueOnce([]) // flow_data
      .mockResolvedValueOnce([]) // spot_exposures
      .mockResolvedValueOnce([{ id: 7 }]); // insert

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._json).toMatchObject({
      status: 'success',
      rows: 1,
      totalFires: 1,
      inserted: 1,
      priorSeeds: 1,
    });
  });
});
