// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// ── Mocks ────────────────────────────────────────────────

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn(async () => ({ isBot: false })),
  isMarketOpen: vi.fn(() => false),
  setCacheHeaders: vi.fn(
    (res: { setHeader: (k: string, v: string) => unknown }) => {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      res.setHeader('Vary', 'Cookie');
    },
  ),
}));

vi.mock('../_lib/max-pain.js', () => ({
  fetchMaxPain: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The handler uses getETDateStr to derive "today" — freeze the clock so
// assertions on the 0DTE expiry match are deterministic across runs.
const FROZEN_NOW = new Date('2026-04-20T15:30:00Z');

import handler from '../max-pain-current.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { fetchMaxPain } from '../_lib/max-pain.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// Resolve "today" the same way the handler does so tests adapt if the
// ET date rollover shifts (e.g. if the frozen UTC clock lands before
// midnight ET on a DST boundary). Matches api-helpers' getETDateStr.
const TODAY_ET = FROZEN_NOW.toLocaleDateString('en-CA', {
  timeZone: 'America/New_York',
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  vi.mocked(rejectIfNotOwner).mockReturnValue(false);
  vi.mocked(checkBot).mockResolvedValue({ isBot: false });
  vi.mocked(fetchMaxPain).mockReset();
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe('GET /api/max-pain-current', () => {
  it('returns 405 for POST', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'GET only' });
  });

  it('returns 401 for non-owner', async () => {
    vi.mocked(rejectIfNotOwner).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Not authenticated' });
      return true;
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
    expect(fetchMaxPain).not.toHaveBeenCalled();
  });

  it('returns 403 when botid detects a bot', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
    expect(fetchMaxPain).not.toHaveBeenCalled();
  });

  it('returns maxPain for exact 0DTE match', async () => {
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'ok',
      data: [
        { expiry: TODAY_ET, max_pain: '5800' },
        { expiry: '2026-04-30', max_pain: '5750' },
      ],
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    expect(res._status).toBe(200);
    const body = res._json as {
      ticker: string;
      maxPain: number | null;
      asOf: string;
    };
    expect(body.ticker).toBe('SPX');
    expect(body.maxPain).toBe(5800);
    expect(body.asOf).toBe(FROZEN_NOW.toISOString());
  });

  it('falls back to nearest upcoming expiry when no 0DTE match', async () => {
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'ok',
      data: [
        { expiry: '2026-04-30', max_pain: '5750' },
        { expiry: '2026-05-16', max_pain: '5700' },
      ],
    });

    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);

    const body = res._json as { maxPain: number | null };
    expect(res._status).toBe(200);
    expect(body.maxPain).toBe(5750);
  });

  it('returns maxPain null when UW returns empty', async () => {
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({ kind: 'empty' });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { maxPain: number | null };
    expect(body.maxPain).toBeNull();
  });

  it('returns maxPain null with 200 when UW fails (never throws)', async () => {
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'error',
      reason: 'HTTP 503',
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { maxPain: number | null; ticker: string };
    expect(body.maxPain).toBeNull();
    expect(body.ticker).toBe('SPX');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('catches unexpected throws and degrades to null (never 500s)', async () => {
    vi.mocked(fetchMaxPain).mockRejectedValueOnce(new Error('socket timeout'));
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    // Per the endpoint contract, max-pain is a nice-to-have: we never 500
    // the frontend just because the UW call fell over in an unusual way.
    expect(res._status).toBe(200);
    const body = res._json as { maxPain: number | null; ticker: string };
    expect(body.maxPain).toBeNull();
    expect(body.ticker).toBe('SPX');
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns maxPain null when the chosen entry has an invalid strike', async () => {
    vi.mocked(fetchMaxPain).mockResolvedValueOnce({
      kind: 'ok',
      data: [{ expiry: TODAY_ET, max_pain: 'not-a-number' }],
    });
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    const body = res._json as { maxPain: number | null };
    expect(body.maxPain).toBeNull();
  });
});
