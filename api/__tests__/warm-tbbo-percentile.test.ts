// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/archive-sidecar.js', () => ({
  fetchTbboOfiPercentile: vi.fn(),
}));

import handler from '../cron/warm-tbbo-percentile.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { fetchTbboOfiPercentile } from '../_lib/archive-sidecar.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────

function makeCronReq(
  overrides: { method?: string; headers?: Record<string, string> } = {},
) {
  return mockRequest({
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? { authorization: 'Bearer test-secret' },
  });
}

function makePercentile(symbol: 'ES' | 'NQ') {
  return {
    symbol,
    window: '1h' as const,
    current_value: 0,
    percentile: 50,
    mean: 0,
    std: 1,
    count: 252,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

describe('warm-tbbo-percentile cron handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };

    // Default: cronGuard passes through. The handler only requires it
    // returns a non-null value — apiKey/today are unused here.
    vi.mocked(cronGuard).mockReturnValue({
      apiKey: '',
      today: '2026-04-19',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('happy path — both symbols warm successfully', async () => {
    vi.mocked(fetchTbboOfiPercentile)
      .mockResolvedValueOnce(makePercentile('ES'))
      .mockResolvedValueOnce(makePercentile('NQ'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ ok: true, es: true, nq: true });
    expect(fetchTbboOfiPercentile).toHaveBeenCalledTimes(2);
    expect(fetchTbboOfiPercentile).toHaveBeenNthCalledWith(1, 'ES', 0, '1h');
    expect(fetchTbboOfiPercentile).toHaveBeenNthCalledWith(2, 'NQ', 0, '1h');
    expect(logger.info).toHaveBeenCalled();
  });

  it('ES fails / NQ succeeds — still 200 with mixed flags', async () => {
    vi.mocked(fetchTbboOfiPercentile)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makePercentile('NQ'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ ok: true, es: false, nq: true });
  });

  it('both fail — returns 200 with ok:false (pre-warm is non-fatal)', async () => {
    vi.mocked(fetchTbboOfiPercentile)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ ok: false, es: false, nq: false });
    expect(logger.info).toHaveBeenCalled();
  });

  it('returns early when cronGuard rejects (missing CRON_SECRET)', async () => {
    // Simulate cronGuard rejecting (it sets its own 401 and returns null).
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const res = mockResponse();
    await handler(makeCronReq({ headers: {} }), res);

    expect(res._status).toBe(401);
    expect(fetchTbboOfiPercentile).not.toHaveBeenCalled();
  });

  it('returns early when cronGuard rejects non-GET method (405)', async () => {
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(405).json({ error: 'GET only' });
      return null;
    });

    const res = mockResponse();
    await handler(makeCronReq({ method: 'POST' }), res);

    expect(res._status).toBe(405);
    expect(fetchTbboOfiPercentile).not.toHaveBeenCalled();
  });

  it('passes marketHours: false and requireApiKey: false to cronGuard', async () => {
    vi.mocked(fetchTbboOfiPercentile).mockResolvedValue(makePercentile('ES'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(cronGuard).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        requireApiKey: false,
        marketHours: false,
      },
    );
  });

  it('fires both symbols in parallel (does not await ES before NQ)', async () => {
    // If the handler awaited ES before calling NQ, the second call would
    // not be registered until after the first resolves. Using
    // Promise.allSettled means both are invoked synchronously before any
    // await resolves. Assert both mock calls are recorded by the time we
    // inspect the mock, even before awaiting the handler.
    let resolveEs: (v: ReturnType<typeof makePercentile>) => void = () => {};
    const esPending = new Promise<ReturnType<typeof makePercentile>>((r) => {
      resolveEs = r;
    });

    vi.mocked(fetchTbboOfiPercentile)
      .mockReturnValueOnce(esPending)
      .mockResolvedValueOnce(makePercentile('NQ'));

    const res = mockResponse();
    const handlerPromise = handler(makeCronReq(), res);

    // Flush microtasks so Promise.allSettled has a chance to fire both.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchTbboOfiPercentile).toHaveBeenCalledTimes(2);

    resolveEs(makePercentile('ES'));
    await handlerPromise;
  });
});
