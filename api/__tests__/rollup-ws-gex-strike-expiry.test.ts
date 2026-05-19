// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockQuery } = vi.hoisted(() => {
  const queryFn = vi.fn();
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    query: typeof queryFn;
  };
  fn.query = queryFn;
  return { mockSql: fn, mockQuery: queryFn };
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

import handler from '../cron/rollup-ws-gex-strike-expiry.js';
import { Sentry } from '../_lib/sentry.js';

// Monday 22:30 UTC = 6:30 PM EDT — the scheduled cron firing time.
// cronGuard derives `today` via getETDateStr(new Date()), so on this
// clock the cron's today is 2026-05-18.
const RUN_TIME = new Date('2026-05-18T22:30:00.000Z');

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('rollup-ws-gex-strike-expiry handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.query = mockQuery;
    mockQuery.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(RUN_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('returns 405 on non-GET', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(401);
  });

  it('returns 401 on wrong bearer', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('rolls up rows and reports inserted count', async () => {
    // Simulate 490,110 new rows inserted (the 5/15 size).
    const inserted = Array.from({ length: 490_110 }, (_, i) => ({ id: i }));
    mockQuery.mockResolvedValueOnce(inserted);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      today: '2026-05-18',
      inserted: 490_110,
    });
    const body = res._json as { durationMs: number };
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('issues a single INSERT...SELECT with sargable predicates', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);

    const [sqlText, params] = mockQuery.mock.calls[0]!;
    // The rollup is one INSERT INTO strike_exposures … SELECT FROM
    // ws_gex_strike_expiry with ON CONFLICT DO NOTHING.
    expect(sqlText).toContain('INSERT INTO strike_exposures');
    expect(sqlText).toContain('FROM ws_gex_strike_expiry');
    expect(sqlText).toContain('ON CONFLICT');
    expect(sqlText).toContain('DO NOTHING');
    // Both the expiry filter and the ts_minute->date filter pin to
    // the same param so we only roll 0DTE rows for the target ET date.
    expect(sqlText).toContain('expiry = $1::date');
    expect(sqlText).toContain(
      "(ts_minute AT TIME ZONE 'America/New_York')::date = $1::date",
    );
    // WS payload doesn't carry delta — rolled-up rows must NULL it.
    expect(sqlText).toContain('NULL::numeric AS call_delta_oi');
    expect(sqlText).toContain('NULL::numeric AS put_delta_oi');
    // SPX → SPXW remap on copy so strike_exposures is uniformly
    // SPXW-labeled for the 0DTE chain (the heatmap dropdown only
    // allows SPXW; UW pushes the chain data under ticker='SPX').
    expect(sqlText).toContain(
      "CASE WHEN ticker = 'SPX' THEN 'SPXW' ELSE ticker END",
    );
    expect(params).toEqual(['2026-05-18']);
  });

  it('tags Sentry on the success path', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'rollup-ws-gex-strike-expiry',
    );
  });

  it('captures errors to Sentry and returns 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'rollup failed' });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'rollup-ws-gex-strike-expiry',
    );
  });
});
