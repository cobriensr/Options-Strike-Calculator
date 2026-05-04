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

import handler from '../cron/enrich-lottery-outcomes.js';

const GUARD = { apiKey: '', today: '2026-05-02' };

describe('enrich-lottery-outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    mockCronGuard.mockResolvedValue(GUARD);
  });

  it('enriches fires with post-entry ticks', async () => {
    // Mock unenriched fires query
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        optionChainId: 'SPY260502C00500000',
        entryTimeCt: new Date('2026-05-02T14:30:00Z'),
        entryPrice: 1.5,
        expiry: new Date('2026-05-02'),
      },
    ]);

    // Mock post-entry ticks query
    mockSql.mockResolvedValueOnce([
      { executedAt: new Date('2026-05-02T14:31:00Z'), price: 1.6 },
      { executedAt: new Date('2026-05-02T14:32:00Z'), price: 1.8 },
      { executedAt: new Date('2026-05-02T14:33:00Z'), price: 1.7 },
      { executedAt: new Date('2026-05-02T14:40:00Z'), price: 1.9 },
    ]);

    // Mock UPDATE query
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        message: expect.stringContaining('Enriched 1 fires'),
      }),
    );

    // Verify UPDATE was called
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('skips fires with no post-entry ticks', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 2,
        optionChainId: 'SPY260502P00495000',
        entryTimeCt: new Date('2026-05-02T20:59:00Z'),
        entryPrice: 0.5,
        expiry: new Date('2026-05-02'),
      },
    ]);

    // No post-entry ticks
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        message: expect.stringContaining('skipped 1'),
      }),
    );

    // Verify no UPDATE was called (only 2 queries: fires + ticks)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns early when no unenriched fires exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        message: 'No unenriched fires',
      }),
    );

    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
