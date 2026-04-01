// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    schwabFetch: vi.fn(),
  };
});

import handler from '../cron/compute-es-overnight.js';
import { schwabFetch } from '../_lib/api-helpers.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

const mockedSchwabFetch = schwabFetch as ReturnType<typeof vi.fn>;

// Fixed times — 2026-03-25 is a Wednesday
// 9:35 AM ET = 13:35 UTC (after cash open)
const AFTER_OPEN = new Date('2026-03-25T13:35:00.000Z');
// 9:00 AM ET = 13:00 UTC (before cash open)
const BEFORE_OPEN = new Date('2026-03-25T13:00:00.000Z');

/** Overnight bar aggregate row from the bars query */
function makeBarRow(overrides: Record<string, unknown> = {}) {
  return {
    globex_open: '5680.00',
    globex_high: '5720.00',
    globex_low: '5670.00',
    globex_close: '5710.00',
    vwap: '5695.00',
    total_volume: '450000',
    bar_count: '930',
    ...overrides,
  };
}

/** Previous settlement row */
function makePrevOutcome(settlement = '5700.00') {
  return { settlement };
}

/**
 * Set up mockSql to return the right data for sequential tagged template calls:
 *  1st call → overnight bars
 *  2nd call → previous outcome
 *  3rd call → historical volume (20d)
 *  4th call → upsert (returns [])
 */
function setupSqlSequence(
  bars: unknown[] = [makeBarRow()],
  prevOutcome: unknown[] = [makePrevOutcome()],
  histVol: unknown[] = [],
) {
  mockSql
    .mockResolvedValueOnce(bars)
    .mockResolvedValueOnce(prevOutcome)
    .mockResolvedValueOnce(histVol)
    .mockResolvedValueOnce([]);
}

describe('compute-es-overnight handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_OPEN);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5712.5, datetime: Date.now() }] },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  function authedReq() {
    return mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
  }

  // ── Method guard ────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ──────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when CRON_SECRET env is not set', async () => {
    delete process.env.CRON_SECRET;
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
  });

  // ── Time guard ──────────────────────────────────────────

  it('skips when before cash open (9:30 AM ET)', async () => {
    vi.setSystemTime(BEFORE_OPEN);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'Outside time window',
    });
  });

  // ── No bars ─────────────────────────────────────────────

  it('skips when no overnight bars found', async () => {
    mockSql.mockResolvedValueOnce([{ globex_open: null }]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
      reason: 'No overnight bars',
    });
  });

  // ── Happy path ──────────────────────────────────────────

  it('computes and stores overnight summary', async () => {
    setupSqlSequence();
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
    expect(res._json).toHaveProperty('tradeDate');
    expect(res._json).toHaveProperty('gap');
    expect(res._json).toHaveProperty('fillProbability');
    expect(res._json).toHaveProperty('fillScore');
    expect(res._json).toHaveProperty('barCount', 930);
    // 4 SQL calls: bars, prev outcome, hist vol, upsert
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('uses Schwab SPX open when available', async () => {
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5750.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // gap = 5750 - 5700 = +50
    expect(res._json).toMatchObject({
      stored: true,
      gap: '+50.0 UP',
    });
  });

  it('falls back to globex close when Schwab fails', async () => {
    mockedSchwabFetch.mockRejectedValue(new Error('Schwab down'));
    setupSqlSequence(
      [makeBarRow({ globex_close: '5710.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // gap = 5710 - 5700 = +10
    expect(res._json).toMatchObject({
      stored: true,
      gap: '+10.0 UP',
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('falls back to globex close when Schwab returns no candles', async () => {
    mockedSchwabFetch.mockResolvedValue({ ok: true, data: { candles: [] } });
    setupSqlSequence(
      [makeBarRow({ globex_close: '5710.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+10.0 UP' });
  });

  it('handles missing previous settlement (gap = 0)', async () => {
    setupSqlSequence([makeBarRow()], []);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // No prev close → gap = 0
    expect(res._json).toMatchObject({
      stored: true,
      gap: '+0.0 UP',
    });
  });

  // ── Classification correctness ──────────────────────────

  it('classifies gap DOWN when cash open < prev close', async () => {
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5680.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ gap: '-20.0 DOWN' });
  });

  it('uses 20d volume average when historical data exists', async () => {
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '400000',
    }));
    setupSqlSequence([makeBarRow()], [makePrevOutcome()], histVol);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── Error handling ──────────────────────────────────────

  it('returns 500 and captures exception on DB error', async () => {
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
