// @vitest-environment node

/**
 * Time-gate test for auto-prefill-premarket, with the REAL cronGuard.
 *
 * auto-prefill-premarket.test.ts stubs cronGuard, so the cron's `timeCheck`
 * never runs there. This file lets the real guard evaluate it under fake
 * time, in both DST regimes and on a market holiday. The schedule is
 * `30 13,14 * * 1-5` UTC: 13:30 is the CDT cash open and 14:30 the CST one,
 * and the gate must keep the slot that falls before the open (and every slot
 * on a holiday) from writing.
 *
 * Only the DB handle and the log/telemetry modules are replaced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/auto-prefill-premarket.js';

async function runAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

describe('auto-prefill-premarket time gate (real cronGuard)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    vi.useFakeTimers();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it.each([
    ['EDT 13:30 UTC slot (09:30 ET)', '2026-07-15T13:30:00.000Z'],
    ['EDT 14:30 UTC slot (10:30 ET)', '2026-07-15T14:30:00.000Z'],
    ['EST 14:30 UTC slot (09:30 ET)', '2026-12-02T14:30:00.000Z'],
  ])('runs at the %s', async (_label, iso) => {
    const res = await runAt(iso);

    expect(res._json).not.toMatchObject({ reason: 'Outside time window' });
    // The bars SELECT is the first DB call of a run that got past the gate.
    expect(mockSql).toHaveBeenCalled();
  });

  it('skips the EST 13:30 UTC slot, which is 08:30 ET and before the open', async () => {
    const res = await runAt('2026-12-02T13:30:00.000Z');

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips Thanksgiving even at the 14:30 UTC slot (09:30 ET)', async () => {
    // 2026-11-26 is a Thursday and a full NYSE holiday. The old predicate
    // only compared the clock, so it ran and wrote a pre-market row.
    const res = await runAt('2026-11-26T14:30:00.000Z');

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips Good Friday at the 13:30 UTC slot (09:30 EDT)', async () => {
    const res = await runAt('2026-04-03T13:30:00.000Z');

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('?force=1 still bypasses the gate on a holiday', async () => {
    vi.setSystemTime(new Date('2026-11-26T14:30:00.000Z'));
    const res = mockResponse();
    await handler(
      mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
        query: { force: '1' },
      }),
      res,
    );

    expect(mockSql).toHaveBeenCalled();
  });
});
