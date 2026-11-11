// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
    COMBINED_WINDOW_MINUTES: 30,
  },
}));

import { writeAlertIfNew, checkForCombinedAlert } from '../_lib/alerts.js';
import type { AlertPayload, AlertSeverity } from '../_lib/alerts.js';
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

/** The static SQL text of the nth tagged-template call, with each
 *  interpolated value replaced by "?". */
function sqlText(callIndex: number): string {
  const strings = mockSql.mock.calls[callIndex]![0] as readonly string[];
  return strings.join('?');
}

/** The interpolated values of the nth tagged-template call. */
function sqlValues(callIndex: number): unknown[] {
  return mockSql.mock.calls[callIndex]!.slice(1);
}

describe('writeAlertIfNew', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

    // Exact-match object: a stray extra key (a delivery flag, say) fails.
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

    await writeAlertIfNew('2026-03-24', makeAlert({ type: 'combined' }));

    // The first mockSql call is the cooldown SELECT
    expect(sqlText(0)).toContain('SELECT 1 FROM market_alerts');
    expect(sqlValues(0)).toEqual(['combined', '2026-03-24', 5]);
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
    expect(sqlValues(1)).toEqual([
      '2026-03-24',
      MARKET_TIME.toISOString(),
      'iv_spike',
      'warning',
      'BEARISH',
      alert.title,
      alert.body,
      '{"iv":0.277}',
      '{"ivDelta":0.048}',
    ]);
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

  it('INSERT no longer names the sms_sent column', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    await writeAlertIfNew('2026-03-24', makeAlert());

    // The column stays in the table with its DEFAULT FALSE; the writer just
    // no longer sets it.
    const insert = sqlText(1);
    expect(insert).toContain('INSERT INTO market_alerts');
    expect(insert).not.toContain('sms_sent');
    expect(sqlValues(1)).toHaveLength(9);
  });

  it.each<AlertSeverity>(['warning', 'critical', 'extreme'])(
    'makes no outbound HTTP call for a %s alert',
    async (severity) => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
      mockSql.mockResolvedValueOnce([]);
      mockSql.mockResolvedValueOnce([]);

      const result = await writeAlertIfNew(
        '2026-03-24',
        makeAlert({ severity }),
      );

      expect(result).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  // ── Failure modes (R4) ──────────────────────────────────

  it('rejects, writes nothing and logs no alert when the cooldown query fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));

    await expect(writeAlertIfNew('2026-03-24', makeAlert())).rejects.toThrow(
      'connection lost',
    );

    // Only the cooldown SELECT ran: no INSERT, no "alert fired" log.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('rejects and logs no alert when the INSERT fails', async () => {
    mockSql.mockResolvedValueOnce([]); // cooldown check
    mockSql.mockRejectedValueOnce(new Error('insert failed'));

    await expect(writeAlertIfNew('2026-03-24', makeAlert())).rejects.toThrow(
      'insert failed',
    );

    expect(mockSql).toHaveBeenCalledTimes(2);
    // A failed write must not be reported as a fired alert.
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

// ── checkForCombinedAlert ─────────────────────────────────

describe('checkForCombinedAlert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns false when no other alert type exists in the window', async () => {
    // SELECT for other alert type → empty
    mockSql.mockResolvedValueOnce([]);

    const result = await checkForCombinedAlert('2026-03-24', 'iv_spike');

    expect(result).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns true and writes combined/extreme alert when other type exists', async () => {
    // 1. checkForCombinedAlert SELECT other alert → found
    mockSql.mockResolvedValueOnce([
      {
        direction: 'BEARISH',
        current_values: { ratio: 1.8 },
        delta_values: { ratioDelta: 0.5 },
      },
    ]);
    // 2. writeAlertIfNew cooldown check → no cooldown
    mockSql.mockResolvedValueOnce([]);
    // 3. writeAlertIfNew INSERT
    mockSql.mockResolvedValueOnce([]);

    const result = await checkForCombinedAlert('2026-03-24', 'iv_spike');

    expect(result).toBe(true);
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('checks for ratio_surge when justFired is iv_spike', async () => {
    // Return empty — just verify the function was called
    mockSql.mockResolvedValueOnce([]);

    await checkForCombinedAlert('2026-03-24', 'iv_spike');

    // The query should look for ratio_surge (the other type)
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('checks for iv_spike when justFired is ratio_surge', async () => {
    // 1. SELECT for iv_spike → found
    mockSql.mockResolvedValueOnce([
      {
        direction: 'BEARISH',
        current_values: { iv: 0.3 },
        delta_values: { ivDelta: 0.05 },
      },
    ]);
    // 2. writeAlertIfNew cooldown → no cooldown
    mockSql.mockResolvedValueOnce([]);
    // 3. writeAlertIfNew INSERT
    mockSql.mockResolvedValueOnce([]);

    const result = await checkForCombinedAlert('2026-03-24', 'ratio_surge');

    expect(result).toBe(true);
  });

  it('combined alert has severity extreme and type combined', async () => {
    // 1. SELECT other alert → found
    mockSql.mockResolvedValueOnce([
      {
        direction: 'BULLISH',
        current_values: { ratio: 0.6 },
        delta_values: { ratioDelta: -0.5 },
      },
    ]);
    // 2. writeAlertIfNew cooldown → no cooldown
    mockSql.mockResolvedValueOnce([]);
    // 3. writeAlertIfNew INSERT
    mockSql.mockResolvedValueOnce([]);

    await checkForCombinedAlert('2026-03-24', 'iv_spike');

    // The logger.warn from writeAlertIfNew should show the combined alert
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'combined',
        severity: 'extreme',
      }),
      'Market alert fired',
    );
  });

  it('rejects when the other-alert lookup fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      checkForCombinedAlert('2026-03-24', 'iv_spike'),
    ).rejects.toThrow('connection lost');

    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('rejects and logs no combined alert when its INSERT fails', async () => {
    mockSql.mockResolvedValueOnce([
      {
        direction: 'BEARISH',
        current_values: { ratio: 1.8 },
        delta_values: { ratioDelta: 0.5 },
      },
    ]);
    mockSql.mockResolvedValueOnce([]); // writeAlertIfNew cooldown
    mockSql.mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      checkForCombinedAlert('2026-03-24', 'iv_spike'),
    ).rejects.toThrow('insert failed');

    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
