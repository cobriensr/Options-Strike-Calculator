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
  uwFetch: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../_lib/alert-thresholds.js', () => ({
  ALERT_THRESHOLDS: {
    RATIO_DELTA_MIN: 0.4,
    RATIO_LOOKBACK_MINUTES: 5,
    COOLDOWN_MINUTES: 5,
  },
}));

import handler from '../cron/monitor-flow-ratio.js';
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

function makeFlowTick(overrides = {}) {
  return {
    timestamp: '2026-03-24T16:00:00Z',
    date: '2026-03-24',
    net_call_premium: '50000000',
    net_put_premium: '-80000000',
    net_volume: '100000',
    underlying_price: '6600',
    ...overrides,
  };
}

describe('monitor-flow-ratio handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(MARKET_TIME);

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

    expect(vi.mocked(uwFetch)).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── No data ──────────────────────────────────────────────

  it('returns skipped when no flow ticks returned', async () => {
    // uwFetch parser extracts from nested structure; simulate empty
    vi.mocked(uwFetch).mockResolvedValue([]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-flow-ratio',
      skipped: true,
      reason: 'no flow data',
    });
  });

  it('returns skipped when tick values are NaN', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: 'invalid',
        net_put_premium: 'invalid',
        underlying_price: 'invalid',
      }),
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-flow-ratio',
      skipped: true,
      reason: 'invalid values',
    });
  });

  // ── Ratio computation ────────────────────────────────────

  it('computes correct ratio (|NPP|/|NCP|) and stores reading', async () => {
    // NCP = 50M, NPP = -80M → absNpp = 80M, absNcp = 50M, ratio = 1.6
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-80000000',
      }),
    ]);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]); // detectRatioSurge SELECT prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'monitor-flow-ratio',
      ratio: 1.6,
      absNpp: 80000000,
      absNcp: 50000000,
      spxPrice: 6600,
      alerted: false,
    });
    expect(mockSql).toHaveBeenCalled();
  });

  it('handles NCP = 0 gracefully (ratio = null)', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '0',
        net_put_premium: '-80000000',
      }),
    ]);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]); // detectRatioSurge: ratio is null, returns early

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ratio: null,
      alerted: false,
    });
  });

  // ── Alert detection ──────────────────────────────────────

  it('does NOT fire alert when ratio delta < 0.4', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '43000000',
        net_put_premium: '-55000000',
      }),
    ]);
    // absNpp=55M, absNcp=43M, ratio = 55/43 ≈ 1.279
    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading
          ratio: '1.15',
          abs_npp: '50000000',
          abs_ncp: '43000000',
        },
      ]);
    // delta = 1.279 - 1.15 = 0.129 < 0.4

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('fires alert when ratio surges >= 0.4 (BEARISH when NPP drove it)', async () => {
    // Current: absNpp=80M, absNcp=50M, ratio=1.6
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-80000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading
          ratio: '1.15',
          abs_npp: '50000000',
          abs_ncp: '43000000',
        },
      ]);
    // delta = 1.6 - 1.15 = 0.45 >= 0.4
    // NPP delta = 80M - 50M = 30M, NCP delta = 50M - 43M = 7M
    // |nppDelta| > |ncpDelta| and nppDelta > 0 → BEARISH

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: true });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        type: 'ratio_surge',
        direction: 'BEARISH',
        severity: 'warning',
      }),
    );
  });

  it('fires alert when ratio collapses >= 0.4 (BULLISH when NCP drove it)', async () => {
    // Current: absNpp=50M, absNcp=80M, ratio=0.625
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '80000000',
        net_put_premium: '-50000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading
          ratio: '1.10',
          abs_npp: '55000000',
          abs_ncp: '50000000',
        },
      ]);
    // delta = 0.625 - 1.10 = -0.475, |delta| = 0.475 >= 0.4
    // NPP delta = 50M - 55M = -5M, NCP delta = 80M - 50M = 30M
    // |ncpDelta| > |nppDelta| and ncpDelta > 0 → BULLISH (call side growing)

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: true });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        type: 'ratio_surge',
        direction: 'BULLISH',
      }),
    );
  });

  it('sets severity to critical when |ratioDelta| >= 0.6', async () => {
    // Current: absNpp=100M, absNcp=50M, ratio=2.0
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-100000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ratio: '1.15',
        abs_npp: '50000000',
        abs_ncp: '43000000',
      },
    ]);
    // delta = 2.0 - 1.15 = 0.85 >= 0.6

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        severity: 'critical',
      }),
    );
  });

  // ── Direction classification ─────────────────────────────

  it('classifies BEARISH when NPP increase > NCP increase', async () => {
    // NPP grew more than NCP → put side drove the change → BEARISH
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '45000000',
        net_put_premium: '-90000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ratio: '1.10',
        abs_npp: '50000000',
        abs_ncp: '45000000',
      },
    ]);
    // absNpp=90M, absNcp=45M, ratio=2.0, delta=0.9
    // nppDelta = 90M-50M = 40M, ncpDelta = 45M-45M = 0
    // |nppDelta| > |ncpDelta|, nppDelta > 0 → BEARISH

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({ direction: 'BEARISH' }),
    );
  });

  it('classifies BEARISH when NCP decrease > NPP decrease', async () => {
    // Call premium collapsed → NCP shrank → ncpDelta < 0 → BEARISH
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '20000000',
        net_put_premium: '-78000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ratio: '1.30',
        abs_npp: '78000000',
        abs_ncp: '60000000',
      },
    ]);
    // absNpp=78M, absNcp=20M, ratio=3.9, delta=2.6 >= 0.4
    // nppDelta = 78M-78M = 0, ncpDelta = 20M-60M = -40M
    // |ncpDelta| > |nppDelta|, ncpDelta < 0 → BEARISH

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({ direction: 'BEARISH' }),
    );
  });

  it('does not fire alert when no previous reading exists', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeFlowTick()]);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]); // detectRatioSurge: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
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
      'monitor-flow-ratio',
    );
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it('returns 500 when DB throws during storeRatioReading', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeFlowTick()]);
    mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalled();
  });

  // ── Combined alert integration ────────────────────────────

  it('calls checkForCombinedAlert with ratio_surge when alert fires', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-80000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(true);

    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ratio: '1.15',
        abs_npp: '50000000',
        abs_ncp: '43000000',
      },
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).toHaveBeenCalledWith(
      '2026-03-24',
      'ratio_surge',
    );
    expect(res._json).toMatchObject({ combined: true });
  });

  it('does not call checkForCombinedAlert when no alert fires', async () => {
    vi.mocked(uwFetch).mockResolvedValue([makeFlowTick()]);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]); // detectRatioSurge: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ combined: false });
  });

  it('returns combined: false when alert fires but no iv_spike exists', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-80000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(false);

    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ratio: '1.15',
        abs_npp: '50000000',
        abs_ncp: '43000000',
      },
    ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).toHaveBeenCalled();
    expect(res._json).toMatchObject({
      alerted: true,
      combined: false,
    });
  });
});
