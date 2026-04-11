// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb: (scope: object) => unknown) =>
      cb({ setTransactionName: vi.fn() }),
    ),
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/schwab.js', () => ({
  redis: { set: vi.fn().mockResolvedValue('OK') },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

import handler, { parseCboeCsv } from '../cron/refresh-vix1d.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { redis } from '../_lib/schwab.js';
import { Sentry } from '../_lib/sentry.js';

// ── Fixture CSV ───────────────────────────────────────────────

const SAMPLE_CSV = `DATE,OPEN,HIGH,LOW,CLOSE
04/10/2026,9.850000,20.380000,9.610000,19.070000
04/09/2026,10.890000,14.590000,10.170000,14.070000
04/08/2026,13.890000,18.610000,12.700000,16.480000
`;

const SAMPLE_MAP = {
  '2026-04-10': { o: 9.85, h: 20.38, l: 9.61, c: 19.07 },
  '2026-04-09': { o: 10.89, h: 14.59, l: 10.17, c: 14.07 },
  '2026-04-08': { o: 13.89, h: 18.61, l: 12.7, c: 16.48 },
};

// ── parseCboeCsv unit tests ───────────────────────────────────

describe('parseCboeCsv', () => {
  it('parses a well-formed CSV into the date-keyed map', () => {
    const result = parseCboeCsv(SAMPLE_CSV);
    expect(result['2026-04-10']).toEqual({ o: 9.85, h: 20.38, l: 9.61, c: 19.07 });
    expect(result['2026-04-09']).toEqual({ o: 10.89, h: 14.59, l: 10.17, c: 14.07 });
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('converts MM/DD/YYYY dates to YYYY-MM-DD', () => {
    const csv = `DATE,OPEN,HIGH,LOW,CLOSE\n01/05/2025,10.0,12.0,9.0,11.0\n`;
    expect(parseCboeCsv(csv)).toHaveProperty('2025-01-05');
  });

  it('pads single-digit month and day', () => {
    const csv = `DATE,OPEN,HIGH,LOW,CLOSE\n3/7/2025,10.0,12.0,9.0,11.0\n`;
    expect(parseCboeCsv(csv)).toHaveProperty('2025-03-07');
  });

  it('skips rows with non-numeric values', () => {
    const csv = `DATE,OPEN,HIGH,LOW,CLOSE\n04/10/2026,bad,20.38,9.61,19.07\n04/09/2026,10.89,14.59,10.17,14.07\n`;
    const result = parseCboeCsv(csv);
    expect(result).not.toHaveProperty('2026-04-10');
    expect(result).toHaveProperty('2026-04-09');
  });

  it('skips rows with fewer than 5 columns', () => {
    const csv = `DATE,OPEN,HIGH,LOW,CLOSE\n04/10/2026,9.85,20.38\n`;
    expect(Object.keys(parseCboeCsv(csv))).toHaveLength(0);
  });

  it('returns empty map for empty CSV body', () => {
    expect(parseCboeCsv('DATE,OPEN,HIGH,LOW,CLOSE\n')).toEqual({});
  });
});

// ── Handler tests ─────────────────────────────────────────────

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

beforeEach(() => {
  vi.mocked(cronGuard).mockReturnValue({ apiKey: '', today: '2026-04-11' });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_CSV),
    }),
  );
});

describe('refresh-vix1d handler', () => {
  it('returns early when cronGuard fails without touching Redis', async () => {
    vi.mocked(cronGuard).mockReturnValueOnce(null);
    const req = makeCronReq();
    const res = mockResponse();
    await handler(req, res);
    // cronGuard returned null → handler exited early; Redis was never touched
    expect(vi.mocked(redis.set)).not.toHaveBeenCalled();
  });

  it('fetches CBOE CSV and stores parsed map in Redis', async () => {
    const req = makeCronReq();
    const res = mockResponse();
    await handler(req, res);
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      'vix1d:daily-map',
      expect.objectContaining(SAMPLE_MAP),
      expect.objectContaining({ ex: expect.any(Number) }),
    );
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, dayCount: 3 });
  });

  it('returns 502 when CBOE fetch returns non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    const req = makeCronReq();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(502);
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  it('returns 500 when CSV parses to empty map', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('DATE,OPEN,HIGH,LOW,CLOSE\n'),
      }),
    );
    const req = makeCronReq();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });

  it('returns 500 on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('NetworkError')),
    );
    const req = makeCronReq();
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
