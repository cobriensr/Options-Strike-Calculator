// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../_lib/alerts.js', () => ({
  writeAlertIfNew: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  uwFetch: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/alert-thresholds.js', () => ({
  ALERT_THRESHOLDS: {
    IV_JUMP_MIN: 0.03,
    IV_PRICE_MAX_MOVE: 5,
    IV_LOOKBACK_MINUTES: 5,
    COOLDOWN_MINUTES: 5,
  },
}));

import handler from '../cron/monitor-iv.js';
import { cronGuard, uwFetch } from '../_lib/api-helpers.js';
import { writeAlertIfNew } from '../_lib/alerts.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

const MARKET_TIME = new Date('2026-03-24T16:00:00Z');

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('monitor-iv handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(MARKET_TIME);

    // Default: cronGuard succeeds
    vi.mocked(cronGuard).mockReturnValue({
      apiKey: 'test-uw-key',
      today: '2026-03-24',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Guard ────────────────────────────────────────────────

  it('returns early when cronGuard returns null', async () => {
    vi.mocked(cronGuard).mockReturnValue(null);
    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Handler returns immediately, no status set beyond default
    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── No data ──────────────────────────────────────────────

  it('returns skipped when no 0DTE IV data from UW', async () => {
    // uwFetch returns rows with no 0DTE entry (days > 1)
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 7, volatility: '0.20', implied_move_perc: '1.2', percentile: '45' },
    ]);
    // SPX price query returns nothing
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      skipped: true,
      reason: 'no 0DTE IV data',
    });
  });

  it('returns skipped when uwFetch returns empty array', async () => {
    vi.mocked(uwFetch).mockResolvedValue([]);
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      skipped: true,
    });
  });

  it('returns skipped when volatility is NaN', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: 'N/A', implied_move_perc: '1.2', percentile: '45' },
    ]);
    mockSql.mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
  });

  // ── Happy path ───────────────────────────────────────────

  it('stores IV reading on happy path', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.250', implied_move_perc: '1.5', percentile: '55' },
    ]);
    // getLatestSpxPrice: flow_ratio_monitor returns price
    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([])  // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      iv: 0.25,
      spxPrice: 6600,
      alerted: false,
    });
    expect(mockSql).toHaveBeenCalled();
  });

  // ── Alert detection ──────────────────────────────────────

  it('does NOT fire alert when IV delta < threshold', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.250', implied_move_perc: '1.5', percentile: '55' },
    ]);
    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([])  // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.240', spx_price: '6600' }]); // prev reading

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('fires alert when IV spikes >= 3 vol pts while SPX < 5 pt move', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.277', implied_move_perc: '1.8', percentile: '72' },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }])  // getLatestSpxPrice
      .mockResolvedValueOnce([])                        // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.229', spx_price: '6600' }]); // prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: true });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        type: 'iv_spike',
        direction: 'BEARISH',
      }),
    );
  });

  it('does NOT fire alert when IV spikes but SPX also moved >= 5 pts', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.277', implied_move_perc: '1.8', percentile: '72' },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6607' }])  // getLatestSpxPrice (current)
      .mockResolvedValueOnce([])                        // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.229', spx_price: '6600' }]); // prev (7 pt diff)

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('sets severity to critical when IV delta >= 5 vol pts', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.300', implied_move_perc: '2.0', percentile: '80' },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6601' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ volatility: '0.229', spx_price: '6600' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        severity: 'critical',
      }),
    );
  });

  it('does not fire alert when no previous reading exists', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.277', implied_move_perc: '1.8', percentile: '72' },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([])                       // storeIvReading INSERT
      .mockResolvedValueOnce([]);                      // detectIvSpike: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  // ── SPX price fallback ───────────────────────────────────

  it('returns null spxPrice when neither monitor nor flow_data has price', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.250', implied_move_perc: '1.5', percentile: '55' },
    ]);
    // flow_ratio_monitor empty, flow_data empty
    mockSql
      .mockResolvedValueOnce([])  // flow_ratio_monitor
      .mockResolvedValueOnce([])  // flow_data fallback
      .mockResolvedValueOnce([])  // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      spxPrice: null,
    });
  });

  // ── Error handling ───────────────────────────────────────

  it('returns 500 and captures to Sentry on error', async () => {
    vi.mocked(uwFetch).mockRejectedValue(new Error('UW API down'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
    expect(vi.mocked(Sentry.setTag)).toHaveBeenCalledWith(
      'cron.job',
      'monitor-iv',
    );
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('returns 500 when DB throws during storeIvReading', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      { date: '2026-03-24', days: 0, volatility: '0.250', implied_move_perc: '1.5', percentile: '55' },
    ]);
    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }])
      .mockRejectedValueOnce(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });
});
