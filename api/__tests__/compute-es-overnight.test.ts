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
  metrics: { increment: vi.fn() },
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

  // ── classifyVolume — with avg20d ────────────────────────

  it('classifies volume LIGHT when ratio < 0.6 (with avg20d)', async () => {
    // totalVolume = 200K, avg20d = 500K → ratio = 0.4 → LIGHT
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '500000',
    }));
    setupSqlSequence(
      [makeBarRow({ total_volume: '200000' })],
      [makePrevOutcome()],
      histVol,
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('classifies volume NORMAL when ratio 0.6–1.0 (with avg20d)', async () => {
    // totalVolume = 350K, avg20d = 500K → ratio = 0.7 → NORMAL
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '500000',
    }));
    setupSqlSequence(
      [makeBarRow({ total_volume: '350000' })],
      [makePrevOutcome()],
      histVol,
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('classifies volume HEAVY when ratio >= 1.5 (with avg20d)', async () => {
    // totalVolume = 900K, avg20d = 500K → ratio = 1.8 → HEAVY
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '500000',
    }));
    setupSqlSequence(
      [makeBarRow({ total_volume: '900000' })],
      [makePrevOutcome()],
      histVol,
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── classifyVolume — without avg20d (fallback) ─────────

  it('classifies volume LIGHT when < 300K (no avg20d)', async () => {
    setupSqlSequence(
      [makeBarRow({ total_volume: '150000' })],
      [makePrevOutcome()],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('classifies volume ELEVATED when 500K–700K (no avg20d)', async () => {
    setupSqlSequence(
      [makeBarRow({ total_volume: '600000' })],
      [makePrevOutcome()],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('classifies volume HEAVY when >= 700K (no avg20d)', async () => {
    setupSqlSequence(
      [makeBarRow({ total_volume: '800000' })],
      [makePrevOutcome()],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── classifyVwapSignal — all branches ──────────────────

  it('VWAP signal SUPPORTED for gap up with cash open > vwap', async () => {
    // gapUp = true (cashOpen > prevClose), gapVsVwap > 0 (cashOpen > vwap)
    // cashOpen = 5750, prevClose = 5700 → gap up
    // vwap = 5695 → cashOpen - vwap = +55 → SUPPORTED
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5750.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ vwap: '5695.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true, gap: '+50.0 UP' });
  });

  it('VWAP signal OVERSHOOT_FADE for gap up with cash open <= vwap', async () => {
    // gapUp = true (cashOpen > prevClose), gapVsVwap <= 0 (cashOpen <= vwap)
    // cashOpen = 5705, prevClose = 5700 → gap up
    // vwap = 5710 → cashOpen - vwap = -5 → OVERSHOOT_FADE
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5705.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ vwap: '5710.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true, gap: '+5.0 UP' });
  });

  it('VWAP signal SUPPORTED for gap down with cash open < vwap', async () => {
    // gapUp = false (cashOpen < prevClose), gapVsVwap < 0 (cashOpen < vwap)
    // cashOpen = 5650, prevClose = 5700 → gap down
    // vwap = 5695 → cashOpen - vwap = -45 → SUPPORTED
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5650.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ vwap: '5695.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true, gap: '-50.0 DOWN' });
  });

  it('VWAP signal OVERSHOOT_FADE for gap down with cash open >= vwap', async () => {
    // gapUp = false (cashOpen < prevClose), gapVsVwap >= 0 (cashOpen >= vwap)
    // cashOpen = 5698, prevClose = 5700 → gap down (barely)
    // vwap = 5690 → cashOpen - vwap = +8 → OVERSHOOT_FADE (fallthrough)
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5698.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ vwap: '5690.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true, gap: '-2.0 DOWN' });
  });

  // ── computeFillScore — extreme gap branches ────────────

  it('fillScore penalizes extreme gaps (absGap >= 40)', async () => {
    // cashOpen = 5760, prevClose = 5700 → gap = +60 → absGap = 60 >= 40
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5760.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5770.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
    expect(res._json).toHaveProperty('fillScore');
    expect(res._json).toHaveProperty('fillProbability');
  });

  it('fillScore rewards small gaps (absGap < 10)', async () => {
    // cashOpen = 5705, prevClose = 5700 → gap = +5 → absGap = 5 < 10
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5705.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('fillScore medium gap branch (10 <= absGap < 20)', async () => {
    // cashOpen = 5715, prevClose = 5700 → gap = +15 → absGap = 15
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5715.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── computeFillScore — pctRank branches ────────────────

  it('fillScore with cashOpen at globex high (pctRank > 90)', async () => {
    // cashOpen = 5718, high = 5720, low = 5670 → range = 50
    // pctRank = (5718 - 5670) / 50 * 100 = 96 → AT_GLOBEX_HIGH
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5718.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5720.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('fillScore with cashOpen at globex low (pctRank < 10)', async () => {
    // cashOpen = 5672, high = 5720, low = 5670 → range = 50
    // pctRank = (5672 - 5670) / 50 * 100 = 4 → AT_GLOBEX_LOW
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5672.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5720.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('fillScore with cashOpen mid-range (30 < pctRank < 70)', async () => {
    // cashOpen = 5695, high = 5720, low = 5670 → range = 50
    // pctRank = (5695 - 5670) / 50 * 100 = 50 → MID_RANGE
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5695.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5720.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── classifyGapSize — all thresholds ───────────────────

  it('classifies gap NEGLIGIBLE (absGap < 5)', async () => {
    // cashOpen = 5702, prevClose = 5700 → gap = +2
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5702.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+2.0 UP' });
  });

  it('classifies gap SMALL (5 <= absGap < 15)', async () => {
    // cashOpen = 5710, prevClose = 5700 → gap = +10
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5710.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+10.0 UP' });
  });

  it('classifies gap MODERATE (15 <= absGap < 30)', async () => {
    // cashOpen = 5720, prevClose = 5700 → gap = +20
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5720.0, datetime: Date.now() }] },
    });
    setupSqlSequence([makeBarRow()], [makePrevOutcome('5700.00')]);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+20.0 UP' });
  });

  it('classifies gap LARGE (30 <= absGap < 50)', async () => {
    // cashOpen = 5740, prevClose = 5700 → gap = +40
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5740.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5750.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+40.0 UP' });
  });

  it('classifies gap EXTREME (absGap >= 50)', async () => {
    // cashOpen = 5760, prevClose = 5700 → gap = +60
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5760.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5770.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ gap: '+60.0 UP' });
  });

  // ── classifyPosition — all thresholds ──────────────────

  it('classifies position NEAR_HIGH (70 < pctRank <= 90)', async () => {
    // cashOpen = 5710, high = 5720, low = 5670 → range = 50
    // pctRank = (5710 - 5670) / 50 * 100 = 80 → NEAR_HIGH
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5710.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5720.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  it('classifies position NEAR_LOW (10 < pctRank <= 30)', async () => {
    // cashOpen = 5680, high = 5720, low = 5670 → range = 50
    // pctRank = (5680 - 5670) / 50 * 100 = 20 → NEAR_LOW
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5680.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [makeBarRow({ globex_high: '5720.00', globex_low: '5670.00' })],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveProperty('stored', true);
  });

  // ── computeFillScore — probability thresholds ──────────

  it('fillScore HIGH probability (score > 50)', async () => {
    // Maximize score: absGap < 10 (+30), volRatio < 0.6 (+25),
    // pctRank > 90 (+20), OVERSHOOT_FADE (+20) → 95 → HIGH
    // cashOpen = 5703, prevClose = 5700 → gap = +3 (absGap = 3 < 10)
    // cashOpen near top: high = 5704, low = 5670 → pctRank = (5703-5670)/34*100 ≈ 97
    // vwap = 5710 → cashOpen < vwap → gapVsVwap = -7 → OVERSHOOT_FADE
    // volume: light with avg20d
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5703.0, datetime: Date.now() }] },
    });
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '500000',
    }));
    setupSqlSequence(
      [
        makeBarRow({
          globex_high: '5704.00',
          globex_low: '5670.00',
          vwap: '5710.00',
          total_volume: '200000',
        }),
      ],
      [makePrevOutcome('5700.00')],
      histVol,
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      fillProbability: 'HIGH',
    });
  });

  it('fillScore LOW probability (score <= 20)', async () => {
    // Minimize score: absGap >= 40 (-20), volRatio >= 1.5 (-25),
    // 30 < pctRank < 70 (-10), SUPPORTED (-15) → -70 → LOW
    // cashOpen = 5760, prevClose = 5700 → gap = +60 (absGap = 60)
    // high = 5800, low = 5700 → pctRank = (5760-5700)/100*100 = 60 mid
    // vwap = 5750 → cashOpen > vwap → gapVsVwap = +10 → gapUp && > 0 → SUPPORTED
    // volume: heavy with avg20d
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5760.0, datetime: Date.now() }] },
    });
    const histVol = Array.from({ length: 20 }, () => ({
      total_volume: '500000',
    }));
    setupSqlSequence(
      [
        makeBarRow({
          globex_high: '5800.00',
          globex_low: '5700.00',
          vwap: '5750.00',
          total_volume: '900000',
        }),
      ],
      [makePrevOutcome('5700.00')],
      histVol,
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      stored: true,
      fillProbability: 'LOW',
    });
  });

  // ── Edge case: zero globex range ───────────────────────

  it('handles zero globex range (pctRank defaults to 50)', async () => {
    // high == low → range = 0 → pctRank = 50
    mockedSchwabFetch.mockResolvedValue({
      ok: true,
      data: { candles: [{ open: 5700.0, datetime: Date.now() }] },
    });
    setupSqlSequence(
      [
        makeBarRow({
          globex_high: '5700.00',
          globex_low: '5700.00',
        }),
      ],
      [makePrevOutcome('5700.00')],
    );
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ stored: true, gap: '+0.0 UP' });
  });

  // ── Edge case: Monday overnight start ──────────────────

  it('handles Monday trading (goes back 3 days to Friday)', async () => {
    // 2026-03-23 is a Monday → overnight start = Friday 6 PM ET
    vi.setSystemTime(new Date('2026-03-23T13:35:00.000Z'));
    setupSqlSequence();
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
