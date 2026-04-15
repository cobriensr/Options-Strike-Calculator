// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn(
      (fn: (s: { setTransactionName: () => void }) => unknown) =>
        fn({ setTransactionName: vi.fn() }),
    ),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockCheckBot, mockRejectIfNotOwner } = vi.hoisted(() => ({
  mockCheckBot: vi.fn(),
  mockRejectIfNotOwner: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  checkBot: mockCheckBot,
  rejectIfNotOwner: mockRejectIfNotOwner,
}));

import handler from '../nope-intraday';

describe('GET /api/nope-intraday', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCheckBot.mockResolvedValue({ isBot: false });
    mockRejectIfNotOwner.mockReturnValue(false);
  });

  it('rejects non-GET methods with 405', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects bots with 403', async () => {
    mockCheckBot.mockResolvedValueOnce({ isBot: true });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(403);
  });

  it('rejects non-owner via rejectIfNotOwner', async () => {
    mockRejectIfNotOwner.mockImplementationOnce((_req, res) => {
      res.status(401).json({ error: 'Not owner' });
      return true;
    });
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed date', async () => {
    const req = mockRequest({ method: 'GET', query: { date: 'not-a-date' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('returns empty payload when nope_ticks has no rows', async () => {
    mockSql.mockResolvedValueOnce([]); // distinct dates → empty
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ticker: 'SPY',
      date: null,
      availableDates: [],
      points: [],
    });
  });

  it('falls back to latest available date when none requested', async () => {
    mockSql.mockResolvedValueOnce([{ d: '2026-04-13' }, { d: '2026-04-14' }]);
    mockSql.mockResolvedValueOnce([
      {
        timestamp: '2026-04-14T13:30:00Z',
        nope: '0.0001',
        nope_fill: '0.0002',
      },
    ]);
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect((res._json as { date: string }).date).toBe('2026-04-14');
    expect((res._json as { points: unknown[] }).points).toHaveLength(1);
  });

  it('returns parsed numeric points for the requested date', async () => {
    mockSql.mockResolvedValueOnce([{ d: '2026-04-14' }]);
    mockSql.mockResolvedValueOnce([
      {
        timestamp: '2026-04-14T13:30:00Z',
        nope: '-0.000648',
        nope_fill: '-0.000434',
      },
      {
        timestamp: '2026-04-14T13:31:00Z',
        nope: '0.000123',
        nope_fill: '0.000099',
      },
    ]);
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-14' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const body = res._json as {
      points: { timestamp: string; nope: number; nope_fill: number }[];
    };
    expect(body.points).toHaveLength(2);
    expect(body.points[0]!.nope).toBeCloseTo(-0.000648, 10);
    expect(body.points[1]!.nope_fill).toBeCloseTo(0.000099, 10);
  });

  it('handles Date-object timestamps from Neon driver', async () => {
    mockSql.mockResolvedValueOnce([{ d: new Date('2026-04-14T00:00:00Z') }]);
    mockSql.mockResolvedValueOnce([
      {
        timestamp: new Date('2026-04-14T13:30:00Z'),
        nope: '0.0001',
        nope_fill: '0.0001',
      },
    ]);
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      date: string;
      points: { timestamp: string }[];
    };
    expect(body.date).toBe('2026-04-14');
    expect(body.points[0]!.timestamp).toBe('2026-04-14T13:30:00.000Z');
  });

  it('returns 500 on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB down'));
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(500);
  });
});
