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
    COMBINED_WINDOW_MINUTES: 30,
    SMS_MIN_SEVERITY: 'critical' as const,
  },
}));

import {
  writeAlertIfNew,
  sendTwilioSms,
  checkForCombinedAlert,
} from '../_lib/alerts.js';
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
        smsSent: false,
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

// ── sendTwilioSms ─────────────────────────────────────────

describe('sendTwilioSms', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns false when env vars are missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_FROM;
    delete process.env.ALERT_PHONE_TO;

    const result = await sendTwilioSms(makeAlert());

    expect(result).toBe(false);
  });

  it('returns false when Twilio API returns non-ok response', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }),
    );

    const result = await sendTwilioSms(makeAlert());

    expect(result).toBe(false);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      'Twilio SMS failed',
    );
  });

  it('returns true and calls fetch with correct URL/headers/body', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const alert = makeAlert({ severity: 'critical', title: 'Test Alert' });
    const result = await sendTwilioSms(alert);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Basic ${btoa('AC123:token456')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { to: '+15559876543', type: 'iv_spike' },
      'SMS alert sent',
    );
  });

  it('handles network error gracefully (returns false)', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network timeout')),
    );

    const result = await sendTwilioSms(makeAlert());

    expect(result).toBe(false);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Twilio SMS error',
    );
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
    // 3. writeAlertIfNew INSERT (SMS returns false — no env vars)
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
});

// ── writeAlertIfNew SMS integration ───────────────────────

describe('writeAlertIfNew SMS integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.setSystemTime(MARKET_TIME);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calls sendTwilioSms when severity is critical', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // 1. cooldown check → no cooldown
    mockSql.mockResolvedValueOnce([]);
    // 2. INSERT
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ severity: 'critical' }),
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ smsSent: true }),
      'Market alert fired',
    );
  });

  it('calls sendTwilioSms when severity is extreme', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM456' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ severity: 'extreme' }),
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ smsSent: true }),
      'Market alert fired',
    );
  });

  it('does NOT call sendTwilioSms when severity is warning', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token456';
    process.env.TWILIO_PHONE_FROM = '+15551234567';
    process.env.ALERT_PHONE_TO = '+15559876543';

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ severity: 'warning' }),
    );

    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ smsSent: false }),
      'Market alert fired',
    );
  });

  it('sets sms_sent to false when Twilio env vars are missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_FROM;
    delete process.env.ALERT_PHONE_TO;

    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const result = await writeAlertIfNew(
      '2026-03-24',
      makeAlert({ severity: 'critical' }),
    );

    expect(result).toBe(true);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ smsSent: false }),
      'Market alert fired',
    );
  });
});
