// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockCronGuard } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockCronGuard: vi.fn(),
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

import handler from '../cron/enrich-silent-boom-outcomes.js';

const GUARD = { apiKey: 'test-key', today: '2026-05-13' };

const baseAlert = {
  id: 1,
  optionChainId: 'SPY260513C00500000',
  bucketCt: new Date('2026-05-13T14:30:00Z'),
  entryPrice: 1.0,
};

describe('enrich-silent-boom-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockReturnValue(GUARD);
  });

  it('returns 401 when CRON_SECRET is missing/wrong (cronGuard returns null)', async () => {
    mockCronGuard.mockReturnValueOnce(null);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    // cronGuard handles the 401 itself; the wrapper short-circuits and
    // never runs the handler body, so no SELECT was issued.
    expect(mockSql).not.toHaveBeenCalled();
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

  it('enriches a fire with post-entry ticks and lands trail-30/10 in the right UPDATE slot', async () => {
    // Tape: entry $1.00, peak $1.50 (+50%) at t=2min, gives back 10pp to
    // $1.40 at t=3min → trail-30/10 exits at +40%; EoD price $1.20 (+20%).
    mockSql.mockResolvedValueOnce([baseAlert]); // SELECT alerts
    mockSql.mockResolvedValueOnce([
      { executedAt: new Date('2026-05-13T14:31:00Z'), price: 1.2 },
      { executedAt: new Date('2026-05-13T14:32:00Z'), price: 1.5 },
      { executedAt: new Date('2026-05-13T14:33:00Z'), price: 1.4 },
      { executedAt: new Date('2026-05-13T14:40:00Z'), price: 1.2 },
    ]); // SELECT ticks

    // Capture the UPDATE bind shape so we can confirm trail-30/10 lands
    // in the expected slot. The tagged-template call invokes mockSql with
    // (stringsArray, ...values).
    let updateValues: unknown[] = [];
    mockSql.mockImplementationOnce((..._args: unknown[]) => {
      // Drop the strings array; keep the bound parameter values in order.
      updateValues = _args.slice(1);
      return Promise.resolve([]);
    }); // UPDATE

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      message: expect.stringContaining('Enriched 1 fires'),
    });
    expect(mockSql).toHaveBeenCalledTimes(3);

    // UPDATE bind order from the handler:
    //   peak, minToPeak, r30, r60, r120, eod, trail30, id
    // Verify trail-30/10 = +40% lands in the 7th bind slot (index 6).
    expect(updateValues).toHaveLength(8);
    expect(updateValues[0]).toBeCloseTo(50, 5); // peak ceiling %
    expect(updateValues[6]).toBeCloseTo(40, 5); // trail-30/10 %
    expect(updateValues[7]).toBe(1); // id
  });

  it('skips fires with no post-entry ticks', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...baseAlert,
        id: 2,
        optionChainId: 'SPY260513P00495000',
        bucketCt: new Date('2026-05-13T20:59:00Z'),
        entryPrice: 0.5,
      },
    ]); // SELECT alerts
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
    // Two SELECTs (alerts, ticks); no UPDATE because ticks were empty.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
