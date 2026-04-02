// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { ALERT_THRESHOLDS } from '../_lib/alert-thresholds.js';

describe('ALERT_THRESHOLDS', () => {
  it('exports all expected threshold keys', () => {
    expect(ALERT_THRESHOLDS).toEqual({
      IV_JUMP_MIN: 0.03,
      IV_PRICE_MAX_MOVE: 5,
      IV_LOOKBACK_MINUTES: 5,
      RATIO_DELTA_MIN: 0.7,
      RATIO_LOOKBACK_MINUTES: 5,
      RATIO_PREMIUM_MIN: 5_000_000,
      COOLDOWN_MINUTES: 5,
      COMBINED_WINDOW_MINUTES: 30,
      SMS_MIN_SEVERITY: 'warning',
    });
  });

  it('SMS_MIN_SEVERITY is a valid severity level', () => {
    const validSeverities = ['warning', 'critical', 'extreme'];
    expect(validSeverities).toContain(ALERT_THRESHOLDS.SMS_MIN_SEVERITY);
  });
});
