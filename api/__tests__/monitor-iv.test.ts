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
  checkForCombinedAlert: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
  cronJitter: vi.fn(() => Promise.resolve()),
  uwFetch: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

// Intentionally NOT mocking alert-thresholds — see the same rationale
// in monitor-flow-ratio.test.ts. Tests import the real values so any
// drift breaks tests instead of silently passing with stale mocks.

import handler from '../cron/monitor-iv.js';
import { cronGuard, uwFetch } from '../_lib/api-helpers.js';
import { writeAlertIfNew, checkForCombinedAlert } from '../_lib/alerts.js';
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
      {
        date: '2026-03-24',
        days: 7,
        volatility: '0.20',
        implied_move_perc: '1.2',
        percentile: '45',
      },
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
      {
        date: '2026-03-24',
        days: 0,
        volatility: 'N/A',
        implied_move_perc: '1.2',
        percentile: '45',
      },
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
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);
    // getLatestSpxPrice: flow_ratio_monitor returns price
    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([]) // storeIvReading INSERT
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

  it('does NOT fire alert when IV delta < IV_JUMP_MIN (0.01)', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);
    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.245', spx_price: '6600' }]); // prev reading
    // delta = 0.250 - 0.245 = 0.005 < 0.01 → no alert

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('fires warning alert at IV delta in [0.01, 0.02) while SPX < 5 pt move', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.255',
        implied_move_perc: '1.8',
        percentile: '72',
      },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.240', spx_price: '6600' }]); // prev
    // delta = 0.255 - 0.240 = 0.015 → warning tier [0.01, 0.02)

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: true });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        type: 'iv_spike',
        direction: 'BEARISH',
        severity: 'warning',
      }),
    );
  });

  it('does NOT fire alert when IV spikes but SPX also moved >= 5 pts', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.255',
        implied_move_perc: '1.8',
        percentile: '72',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6607' }]) // getLatestSpxPrice (current)
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([{ volatility: '0.240', spx_price: '6600' }]); // prev (7 pt diff)
    // delta = 0.015 passes IV gate, but |spxMove| = 7 ≥ 5 → price-move filter blocks

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('sets severity to critical when IV delta >= 2 vol pts', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.265',
        implied_move_perc: '2.0',
        percentile: '80',
      },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6601' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ volatility: '0.240', spx_price: '6600' }]);
    // delta = 0.265 - 0.240 = 0.025 >= 0.02 → critical tier

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
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.277',
        implied_move_perc: '1.8',
        percentile: '72',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }]) // getLatestSpxPrice
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  // ── SPX price fallback ───────────────────────────────────

  it('returns null spxPrice when flow_ratio_monitor empty and flow_data empty', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);
    // flow_ratio_monitor empty → fall through to flow_data → also empty
    // → short-circuit return null, never query market_snapshots.
    mockSql
      .mockResolvedValueOnce([]) // flow_ratio_monitor
      .mockResolvedValueOnce([]) // flow_data liveness check
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      spxPrice: null,
    });
    // 4 calls = flow_ratio_monitor + flow_data + INSERT + detectIvSpike
    // SELECT. No market_snapshots query because flow_data short-circuits
    // the fallback when no 0DTE liveness row exists.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('fallback pulls SPX price from market_snapshots when flow_data has rows', async () => {
    // Primary source (flow_ratio_monitor) is empty, but flow_data shows
    // zero_dte_index is alive for today. The fix should then read the
    // most recent market_snapshots.spx value instead of returning null.
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([]) // flow_ratio_monitor → empty
      .mockResolvedValueOnce([{ '?column?': 1 }]) // flow_data liveness: row exists
      .mockResolvedValueOnce([{ spx: '6612.50' }]) // market_snapshots latest
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      iv: 0.25,
      spxPrice: 6612.5,
    });
  });

  it('fallback returns null only when market_snapshots is also empty', async () => {
    // flow_ratio_monitor empty, flow_data has rows, BUT market_snapshots
    // is empty too (e.g. very early session before first snapshot).
    // Should return null and the alert handler degrades to IV-only gating.
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([]) // flow_ratio_monitor empty
      .mockResolvedValueOnce([{ '?column?': 1 }]) // flow_data has rows
      .mockResolvedValueOnce([]) // market_snapshots empty
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      spxPrice: null,
    });
    // 5 calls = flow_ratio_monitor + flow_data + market_snapshots +
    // INSERT + detectIvSpike SELECT. A regression that drops the
    // market_snapshots query entirely would fail this assertion even
    // though the mock sequence would still consume correctly.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('primary path (flow_ratio_monitor) short-circuits fallback', async () => {
    // When flow_ratio_monitor has a price, market_snapshots must NOT be
    // queried. Guarded with a strict mock sequence — an extra query would
    // desynchronize downstream mocks and the test would fail.
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6599.75' }]) // flow_ratio_monitor hit
      .mockResolvedValueOnce([]) // storeIvReading INSERT
      .mockResolvedValueOnce([]); // detectIvSpike SELECT prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-iv',
      iv: 0.25,
      spxPrice: 6599.75,
    });
    // Exactly 3 SQL calls: fallback path was never reached.
    expect(mockSql).toHaveBeenCalledTimes(3);
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
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
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

  // ── Combined alert integration ────────────────────────────

  it('calls checkForCombinedAlert with iv_spike when alert fires', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.277',
        implied_move_perc: '1.8',
        percentile: '72',
      },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ volatility: '0.229', spx_price: '6600' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).toHaveBeenCalledWith(
      '2026-03-24',
      'iv_spike',
    );
    expect(res._json).toMatchObject({ combined: true });
  });

  it('does not call checkForCombinedAlert when no alert fires', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.250',
        implied_move_perc: '1.5',
        percentile: '55',
      },
    ]);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ combined: false });
  });

  it('returns combined: false when alert fires but no ratio_surge exists', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      {
        date: '2026-03-24',
        days: 0,
        volatility: '0.277',
        implied_move_perc: '1.8',
        percentile: '72',
      },
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(false);

    mockSql
      .mockResolvedValueOnce([{ spx_price: '6600' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ volatility: '0.229', spx_price: '6600' }]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).toHaveBeenCalled();
    expect(res._json).toMatchObject({
      alerted: true,
      combined: false,
    });
  });
});
