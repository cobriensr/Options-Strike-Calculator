// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-04-20'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import handler from '../cron/fetch-day-ohlc.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { Sentry } from '../_lib/sentry.js';

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('fetch-day-ohlc handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockFetch.mockReset();
    process.env = {
      ...originalEnv,
      CRON_SECRET: 'test-secret',
      SIDECAR_URL: 'http://sidecar.local',
    };
    vi.mocked(cronGuard).mockReturnValue({
      apiKey: '',
      today: '2026-04-20',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('bails when cronGuard rejects', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips when SIDECAR_URL is unset', async () => {
    process.env.SIDECAR_URL = '';
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'SIDECAR_URL missing',
    });
  });

  it('skips gracefully when sidecar returns no rows (holiday/weekend)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [] }),
    });
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'no rows from sidecar',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('updates day_embeddings row with structured OHLC', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          {
            date: '2026-04-19',
            symbol: 'ESM6',
            summary: '…',
            open: 5300,
            high: 5320,
            low: 5285,
            close: 5310,
            range: 35,
            up_excursion: 20,
            down_excursion: 15,
          },
        ],
      }),
    });
    // UPDATE ... RETURNING date → one row returned
    mockSql.mockResolvedValueOnce([{ date: '2026-04-19' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'fetch-day-ohlc',
      updated: 1,
    });
    // Confirms target date (yesterday ET) drove the sidecar URL
    const fetchUrl = String(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(fetchUrl).toContain('from=2026-04-19');
    expect(fetchUrl).toContain('to=2026-04-19');
  });

  it('reports updated=0 when no matching day_embeddings row exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rows: [
          {
            date: '2026-04-19',
            open: 5300,
            high: 5320,
            low: 5285,
            close: 5310,
            range: 35,
            up_excursion: 20,
            down_excursion: 15,
          },
        ],
      }),
    });
    mockSql.mockResolvedValueOnce([]); // no row matched

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ updated: 0 });
  });

  it('500s and reports to Sentry on sidecar HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
