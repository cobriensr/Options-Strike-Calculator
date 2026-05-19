// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockCronGuard, mockFetchIntraday, mockSimulateInversion } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockCronGuard: vi.fn(),
    mockFetchIntraday: vi.fn(),
    mockSimulateInversion: vi.fn(),
  }));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),

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

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

vi.mock('../_lib/option-intraday.js', () => ({
  fetchAndCacheOptionIntraday: mockFetchIntraday,
}));

vi.mock('../_lib/flow-inversion.js', () => ({
  simulateFlowInversion: mockSimulateInversion,
}));

import handler from '../cron/enrich-lottery-outcomes.js';

const GUARD = { apiKey: 'test-key', today: '2026-05-02' };

const baseFire = {
  id: 1,
  optionChainId: 'SPY260502C00500000',
  underlyingSymbol: 'SPY',
  optionType: 'C' as const,
  date: new Date('2026-05-02T00:00:00Z'),
  triggerTimeCt: new Date('2026-05-02T14:29:00Z'),
  entryTimeCt: new Date('2026-05-02T14:30:00Z'),
  entryPrice: 1.5,
  expiry: new Date('2026-05-02'),
};

describe('enrich-lottery-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockReturnValue(GUARD);
    mockFetchIntraday.mockResolvedValue([]);
    mockSimulateInversion.mockReturnValue({
      exitPct: null,
      exitTs: null,
      status: 'no_post_trigger_prices',
    });
  });

  it('enriches fires with post-entry ticks and writes flow_inversion when computable', async () => {
    mockSql.mockResolvedValueOnce([baseFire]); // SELECT fires
    mockSql.mockResolvedValueOnce([
      { executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.6 },
      { executedAt: new Date('2026-05-02T14:32:00Z'), price: 1.8 },
      { executedAt: new Date('2026-05-02T14:33:00Z'), price: 1.7 },
      { executedAt: new Date('2026-05-02T14:40:00Z'), price: 1.9 },
    ]); // SELECT ticks
    mockSql.mockResolvedValueOnce([
      {
        ts: new Date('2026-05-02T14:35:00Z'),
        netCallPrem: '100',
        netPutPrem: '0',
      },
      {
        ts: new Date('2026-05-02T14:36:00Z'),
        netCallPrem: '-50',
        netPutPrem: '0',
      },
    ]); // loadMatchedFlow SELECT
    mockSql.mockResolvedValueOnce([]); // UPDATE

    mockFetchIntraday.mockResolvedValueOnce([
      { ts: new Date('2026-05-02T14:31:00Z'), mid: 1.55 },
    ]);
    mockSimulateInversion.mockReturnValueOnce({
      exitPct: 12.5,
      exitTs: new Date('2026-05-02T14:45:00Z'),
      status: 'inversion',
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('flow_inversion populated 1'),
    });
    expect(mockFetchIntraday).toHaveBeenCalledWith(
      'test-key',
      'SPY260502C00500000',
      '2026-05-02',
    );
    expect(mockSimulateInversion).toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('skips fires with no post-entry ticks', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseFire,
        id: 2,
        optionChainId: 'SPY260502P00495000',
        optionType: 'P',
        entryTimeCt: new Date('2026-05-02T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // ticks empty

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('skipped 1'),
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockFetchIntraday).not.toHaveBeenCalled();
  });

  it('returns early when no unenriched fires exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: 'No unenriched fires',
    });

    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
