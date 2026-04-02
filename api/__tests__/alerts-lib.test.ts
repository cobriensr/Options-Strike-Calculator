// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../_lib/alert-thresholds.js', () => ({
  ALERT_THRESHOLDS: {
    COOLDOWN_MINUTES: 5,
  },
}));

import { writeAlertIfNew } from '../_lib/alerts.js';
import type { AlertPayload } from '../_lib/alerts.js';
import logger from '../_lib/logger.js';

const MARKET_TIME = new Date('2026-03-24T16:00:00Z');

function makeAlert(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    type: 'iv_spike',
    severity: 'warning',
    direction: 'BEARISH',
    title: 'IV Spike: +4.8 vol pts in 5min',
    body: 'ATM 0DTE IV spiked',
    currentValues: { iv: 0.277, spxPrice: 6600 },
    deltaValues: { ivDelta: 0.048, priceDelta: -1.2 },
    ...overrides,
  };
}

describe('writeAlertIfNew', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes alert and returns true when no cooldown active', async () => {
    // First call: cooldown check returns empty (no recent alerts)
    mockSql.mockResolvedValueOnce([]);
    // Second call: INSERT
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew('2026-03-24', makeAlert());

    expect(result).toBe(true);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('returns false when alert is on cooldown', async () => {
    // Cooldown check returns a row — alert exists within window
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);

    const result = await writeAlertIfNew('2026-03-24', makeAlert());

    expect(result).toBe(false);
    // Only 1 call: the cooldown SELECT. No INSERT.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('calls logger.warn with alert metadata on successful write', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const alert = makeAlert({
      type: 'ratio_surge',
      severity: 'critical',
      direction: 'BULLISH',
      title: 'BULLISH Ratio Surge',
    });
    await writeAlertIfNew('2026-03-24', alert);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      {
        type: 'ratio_surge',
        severity: 'critical',
        direction: 'BULLISH',
        title: 'BULLISH Ratio Surge',
      },
      'Market alert fired',
    );
  });

  it('calls logger.debug when suppressed by cooldown', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);

    await writeAlertIfNew('2026-03-24', makeAlert({ type: 'iv_spike' }));

    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      { type: 'iv_spike' },
      'Alert suppressed — cooldown active',
    );
  });

  it('passes correct today and type to cooldown query', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ type: 'combined' }),
    );

    // The first mockSql call is the cooldown SELECT
    expect(mockSql).toHaveBeenCalled();
  });

  it('serializes currentValues and deltaValues as JSON in INSERT', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const alert = makeAlert({
      currentValues: { iv: 0.277 },
      deltaValues: { ivDelta: 0.048 },
    });
    const result = await writeAlertIfNew('2026-03-24', alert);

    expect(result).toBe(true);
    // Two calls: cooldown check + INSERT
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('handles different alert types correctly', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ type: 'ratio_surge', severity: 'extreme' }),
    );

    expect(result).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ratio_surge',
        severity: 'extreme',
      }),
      'Market alert fired',
    );
  });
});
