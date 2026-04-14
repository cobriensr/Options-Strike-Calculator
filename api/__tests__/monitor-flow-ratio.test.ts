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

// Intentionally NOT mocking alert-thresholds — tests import the real
// values so any threshold drift breaks tests and forces an update.
// Prior to 2026-04-07 this file mocked stale values (RATIO_DELTA_MIN: 0.4,
// no RATIO_PREMIUM_MIN) and the tests passed while production silently
// rejected every alert. Never mock thresholds.

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
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
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

    mockSql.mockResolvedValueOnce([]); // storeRatioReading INSERT; ratio=null so both ROC and surge return early

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      ratio: null,
      alerted: false,
    });
  });

  // ── Alert detection ──────────────────────────────────────

  it('does NOT fire alert when ratio delta < RATIO_DELTA_MIN (0.7)', async () => {
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '43000000',
        net_put_premium: '-55000000',
      }),
    ]);
    // absNpp=55M, absNcp=43M, ratio = 55/43 ≈ 1.279
    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading
          ratio: '1.15',
          abs_npp: '50000000',
          abs_ncp: '43000000',
        },
      ]);
    // delta = 1.279 - 1.15 = 0.129 < 0.7 — surge gate blocks
    // ROC mock returns [] so ROC also does not fire

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rocAlerted: false, alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('does NOT fire alert when ratio gate passes but premium floor (1M) blocks', async () => {
    // Low-volume ratio swing: big ratio move but tiny absolute premium
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '500000',
        net_put_premium: '-1000000',
      }),
    ]);
    // absNpp=1.0M, absNcp=0.5M, ratio=2.0
    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '0.6',
          abs_npp: '300000',
          abs_ncp: '500000',
        },
      ]);
    // ratioDelta = 2.0 - 0.6 = 1.4 ≫ 0.7 ✓ (surge ratio gate passes)
    // nppChange = 1.0M - 0.3M = 0.7M
    // ncpChange = 0.5M - 0.5M = 0
    // max driver premium = 0.7M < 1M → surge premium floor blocks

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rocAlerted: false, alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('fires alert when driver premium is in [1M, 5M) — locks in new $1M floor', async () => {
    // Regression guard: this exact scenario was suppressed under the
    // old $5M RATIO_PREMIUM_MIN. It fires under the calibrated $1M
    // floor. If anyone reverts the floor above $1.6M, this test breaks.
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '2000000',
        net_put_premium: '-3600000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '1.0',
          abs_npp: '2000000',
          abs_ncp: '2000000',
        },
      ]);
    // absNpp=3.6M, absNcp=2.0M, ratio=1.8
    // ratioDelta = 1.8 - 1.0 = 0.8 → warning tier [0.7, 0.9)
    // nppChange = 3.6M - 2.0M = 1.6M (in the [1M, 5M) band)
    // ncpChange = 0; max driver = 1.6M
    // → fires under current $1M floor; would fail under old $5M

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

  it('fires warning alert at ratio delta in [0.7, 0.9) — BEARISH when NPP drove it', async () => {
    // Current: absNpp=90M, absNcp=50M, ratio=1.8
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-90000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading, ratio = 1.0
          ratio: '1.0',
          abs_npp: '50000000',
          abs_ncp: '50000000',
        },
      ]);
    // delta = 1.8 - 1.0 = 0.8 → in warning tier [0.7, 0.9)
    // NPP delta = 90M - 50M = 40M, NCP delta = 50M - 50M = 0
    // |nppDelta| > |ncpDelta| and nppDelta > 0 → BEARISH
    // max driver premium = 40M ≫ 1M → premium floor passes

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

  it('fires alert when ratio collapses — BULLISH when NCP drove it', async () => {
    // Current: absNpp=40M, absNcp=80M, ratio=0.5
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '80000000',
        net_put_premium: '-40000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: prev reading, ratio = 1.222
          ratio: '1.222',
          abs_npp: '55000000',
          abs_ncp: '45000000',
        },
      ]);
    // delta = 0.5 - 1.222 = -0.722, |delta| = 0.722 → in [0.7, 0.9) warning
    // NPP delta = 40M - 55M = -15M, NCP delta = 80M - 45M = 35M
    // |ncpDelta| > |nppDelta| and ncpDelta > 0 → BULLISH (call side growing)
    // max driver premium = 35M ≫ 1M → premium floor passes

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

  it('sets severity to critical when |ratioDelta| >= 0.9', async () => {
    // Current: absNpp=100M, absNcp=50M, ratio=2.0
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-100000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '1.0',
          abs_npp: '50000000',
          abs_ncp: '50000000',
        },
      ]);
    // delta = 2.0 - 1.0 = 1.0 >= 0.9 → critical tier
    // NPP delta = 50M (≫ 1M) → premium floor passes

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

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
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

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '1.30',
          abs_npp: '78000000',
          abs_ncp: '60000000',
        },
      ]);
    // absNpp=78M, absNcp=20M, ratio=3.9, delta=2.6 ≫ 0.7 (critical tier)
    // nppDelta = 78M-78M = 0, ncpDelta = 20M-60M = -40M
    // |ncpDelta| > |nppDelta|, ncpDelta < 0 → BEARISH
    // max driver premium = 40M ≫ 1M → premium floor passes

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
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([]); // detectRatioSurge: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rocAlerted: false, alerted: false });
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
    // Same fixture as the "fires warning" test: delta 0.8, driver NPP $40M
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-90000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '1.0',
          abs_npp: '50000000',
          abs_ncp: '50000000',
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
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([]); // detectRatioSurge: no prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(checkForCombinedAlert)).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({ combined: false });
  });

  // ── ROC early-warning detection ──────────────────────────

  it('fires ROC alert when 1-min delta >= 2.0 and driver premium >= $500K', async () => {
    // Current: absNpp=30M, absNcp=10M, ratio=3.0
    // ROC prev (1-min ago): ratio=0.5 → delta=2.5 ≥ 2.0 ✓
    // nppChange = 30M - 10M = 20M ≫ 500K ✓
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '10000000',
        net_put_premium: '-30000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioROC: prev tick ~1 min ago
          ratio: '0.5',
          abs_npp: '10000000',
          abs_ncp: '10000000',
        },
      ])
      .mockResolvedValueOnce([]); // detectRatioSurge: no 5-min prev yet

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ rocAlerted: true, alerted: false });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({
        type: 'ratio_roc',
        severity: 'warning',
        direction: 'BEARISH',
      }),
    );
  });

  it('does NOT fire ROC alert when 1-min delta < 2.0', async () => {
    // delta = 1.8 - 1.6 = 0.2 < 2.0 → ROC gate blocks
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-90000000',
      }),
    ]);
    // absNpp=90M, absNcp=50M, ratio=1.8
    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioROC: prev tick 1-min ago, ratio close to current
          ratio: '1.6',
          abs_npp: '80000000',
          abs_ncp: '50000000',
        },
      ])
      .mockResolvedValueOnce([]); // detectRatioSurge: no 5-min prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._json).toMatchObject({ rocAlerted: false });
    const rocCall = vi
      .mocked(writeAlertIfNew)
      .mock.calls.find(([, a]) => a.type === 'ratio_roc');
    expect(rocCall).toBeUndefined();
  });

  it('does NOT fire ROC alert when delta passes but premium floor blocks', async () => {
    // Tiny premium swing with a big ratio jump (low-volume noise)
    // ratio: 0.2 → 2.5 = delta 2.3 ≥ 2.0 ✓ but premium < 500K
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '200000',
        net_put_premium: '-500000',
      }),
    ]);
    // absNpp=500K, absNcp=200K, ratio=2.5
    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioROC: prev tick
          ratio: '0.2',
          abs_npp: '200000',
          abs_ncp: '200000',
        },
      ])
      // nppChange = 500K - 200K = 300K < 500K → ROC premium floor blocks
      .mockResolvedValueOnce([]); // detectRatioSurge: no 5-min prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._json).toMatchObject({ rocAlerted: false, alerted: false });
    expect(vi.mocked(writeAlertIfNew)).not.toHaveBeenCalled();
  });

  it('ROC alert is always warning severity regardless of delta magnitude', async () => {
    // Extreme 1-min move: ratio 0.1 → 50 = delta 49.9 — still warning
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '5000000',
        net_put_premium: '-250000000',
      }),
    ]);
    // absNpp=250M, absNcp=5M, ratio=50
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          ratio: '0.1',
          abs_npp: '5000000',
          abs_ncp: '5000000',
        },
      ])
      .mockResolvedValueOnce([]); // detectRatioSurge: no 5-min prev

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({ type: 'ratio_roc', severity: 'warning' }),
    );
  });

  it('ROC and surge can both fire on the same tick when thresholds are met', async () => {
    // Current: ratio=5.0; ROC prev (1-min ago): ratio=2.5 → ROC delta=2.5 ≥ 2.0 ✓
    // Surge prev (5-min ago): ratio=1.0 → surge delta=4.0 ≥ 0.7 ✓
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '20000000',
        net_put_premium: '-100000000',
      }),
    ]);
    // absNpp=100M, absNcp=20M, ratio=5.0
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([
        {
          // detectRatioROC: 1-min ago
          ratio: '2.5',
          abs_npp: '60000000',
          abs_ncp: '20000000',
        },
      ])
      .mockResolvedValueOnce([
        {
          // detectRatioSurge: 5-min ago
          ratio: '1.0',
          abs_npp: '20000000',
          abs_ncp: '20000000',
        },
      ]);

    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._json).toMatchObject({ rocAlerted: true, alerted: true });
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({ type: 'ratio_roc' }),
    );
    expect(vi.mocked(writeAlertIfNew)).toHaveBeenCalledWith(
      '2026-03-24',
      expect.objectContaining({ type: 'ratio_surge' }),
    );
  });

  it('returns combined: false when alert fires but no iv_spike exists', async () => {
    // Same fixture as the "fires warning" test: delta 0.8, driver NPP $40M
    vi.mocked(uwFetch).mockResolvedValue([
      makeFlowTick({
        net_call_premium: '50000000',
        net_put_premium: '-90000000',
      }),
    ]);
    vi.mocked(writeAlertIfNew).mockResolvedValue(true);
    vi.mocked(checkForCombinedAlert).mockResolvedValue(false);

    mockSql
      .mockResolvedValueOnce([]) // storeRatioReading INSERT
      .mockResolvedValueOnce([]) // detectRatioROC SELECT prev (no prior tick)
      .mockResolvedValueOnce([
        {
          ratio: '1.0',
          abs_npp: '50000000',
          abs_ncp: '50000000',
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
