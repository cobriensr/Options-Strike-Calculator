// @vitest-environment node

/**
 * api/_lib/ladder-skip.ts: the one rule for a strike ladder that is not
 * stored. Always a warning log and a named metric; from 09:40 ET also a
 * Sentry error naming the kind and the ticker. Mocks logger and sentry at
 * their module boundaries (R3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

const mockSentry = vi.hoisted(() => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
}));
const mockMetrics = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: mockMetrics,
}));

import { reportLadderSkip } from '../_lib/ladder-skip.js';
import type { LadderSkipKind } from '../_lib/strike-ladder.js';

// 2026-03-24 is EDT (UTC-4): 13:39Z = 09:39 ET, 13:40Z = 09:40 ET.
const BEFORE_0940_ET = new Date('2026-03-24T13:39:59.000Z');
const AT_0940_ET = new Date('2026-03-24T13:40:00.000Z');

const KINDS: Array<[LadderSkipKind, string, string]> = [
  ['stale', 'stale_cache_skip', 'stale UW cache'],
  ['stale_spot', 'stale_spot_skip', 'stale UW spot'],
  ['all_zero', 'zero_snapshot_skip', 'all-zero gamma'],
  ['empty', 'empty_ladder_skip', 'no strikes'],
  ['outside_window', 'outside_window_skip', 'inside the stored range'],
];

describe('reportLadderSkip', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(KINDS)(
    '%s: warns and counts %s whatever the time, with no Sentry before 09:40 ET',
    (kind, metric, wording) => {
      vi.setSystemTime(BEFORE_0940_ET);

      reportLadderSkip({
        job: 'fetch-strike-exposure',
        kind,
        ticker: 'SPY',
        expiry: '2026-03-24',
        detail: { rows: 12 },
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          ticker: 'SPY',
          expiry: '2026-03-24',
          rows: 12,
        }),
        expect.stringContaining(wording),
      );
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        `fetch_strike_exposure.${metric}`,
      );
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    },
  );

  it.each(KINDS)(
    '%s: from 09:40 ET also sends a Sentry error naming the kind and the ticker',
    (kind) => {
      vi.setSystemTime(AT_0940_ET);

      reportLadderSkip({
        job: 'fetch-strike-exposure',
        kind,
        ticker: 'QQQ',
        expiry: '2026-03-24',
      });

      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
      const [message, level] = mockSentry.captureMessage.mock.calls[0]!;
      expect(level).toBe('error');
      expect(message).toContain('fetch-strike-exposure');
      expect(message).toContain(kind);
      expect(message).toContain('QQQ 2026-03-24');
      expect(mockSentry.setTag).toHaveBeenCalledWith(
        'cron.job',
        'fetch-strike-exposure',
      );
    },
  );

  it('names the all-expiry job in the metric and omits a missing expiry', () => {
    vi.setSystemTime(AT_0940_ET);

    reportLadderSkip({ job: 'fetch-strike-all', kind: 'empty', ticker: 'SPX' });

    expect(mockMetrics.increment).toHaveBeenCalledWith(
      'fetch_strike_all.empty_ladder_skip',
    );
    const [message] = mockSentry.captureMessage.mock.calls[0]!;
    expect(message).toContain('SPX');
    expect(message).not.toContain('undefined');
  });
});
