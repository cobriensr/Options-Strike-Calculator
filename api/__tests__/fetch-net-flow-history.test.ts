// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockUwFetch, mockCronGuard } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
  metrics: {
    request: vi.fn(() => vi.fn()),
    uwRateLimit: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../_lib/api-helpers.js')>(
    '../_lib/api-helpers.js',
  );
  return {
    ...actual,
    cronGuard: mockCronGuard,
    cronJitter: vi.fn(async () => undefined),
    uwFetch: mockUwFetch,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import handler from '../cron/fetch-net-flow-history.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: 'test-key', today: '2026-05-02' };

const makeTick = (tape_time: string) => ({
  date: '2026-05-02',
  tape_time,
  net_call_premium: '500',
  net_call_volume: 10,
  net_put_premium: '-200',
  net_put_volume: 5,
  call_volume: 30,
  call_volume_ask_side: 18,
  call_volume_bid_side: 12,
  put_volume: 15,
  put_volume_ask_side: 7,
  put_volume_bid_side: 8,
});

describe('fetch-net-flow-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    // cronGuard is sync — return the guard directly (not a Promise).
    mockCronGuard.mockReturnValue(GUARD);
  });

  it('fetches all tickers, filters to session, and inserts via UNNEST', async () => {
    // Each uwFetch call returns one in-session tick + one off-session tick
    // (02:00 UTC = 21:00 CT, dropped by isInSessionCT).
    mockUwFetch.mockResolvedValue([
      makeTick('2026-05-02T15:00:00.000Z'), // 10:00 CT, kept
      makeTick('2026-05-02T02:00:00.000Z'), // off hours, dropped
    ]);
    // UNNEST INSERT returns one row per kept tick.
    mockSql.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // withCronInstrumentation spreads metadata at the top level of the
    // response, not under a nested `metadata` key.
    expect(res._json).toMatchObject({
      status: 'success',
      tickers: expect.any(Number),
    });
    expect(mockUwFetch).toHaveBeenCalled();
    const firstCall = mockUwFetch.mock.calls[0]!;
    expect(firstCall[1]).toMatch(
      /^\/stock\/[A-Z]+\/net-prem-ticks\?date=2026-05-02$/,
    );
    const insertCalls = mockSql.mock.calls.length;
    expect(insertCalls).toBeGreaterThan(0);
  });

  it('reports empty fetches without throwing when UW returns no rows', async () => {
    mockUwFetch.mockResolvedValue([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, number>;
    expect(json.totalStored).toBe(0);
    expect(json.totalFetched).toBe(0);
    expect(json.emptyTickers).toBeGreaterThan(0);
  });

  it('continues across tickers when a single fetch fails', async () => {
    mockUwFetch
      .mockRejectedValueOnce(new Error('UW API 502: bad gateway'))
      .mockResolvedValue([makeTick('2026-05-02T15:00:00.000Z')]);
    mockSql.mockResolvedValue([{ id: 1 }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    // Fallback preserved: the run still succeeds across the remaining
    // tickers despite the single failure (zero-stored row for the
    // failed ticker, never a throw).
    expect((res._json as { status: string }).status).toBe('success');
    // The swallowed UW failure is now visible in Sentry.
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ cron: 'fetch-net-flow-history' }),
      }),
    );
  });
});
