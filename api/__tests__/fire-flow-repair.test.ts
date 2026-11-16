// @vitest-environment node

/**
 * The parts of the post-close flow repair (api/_lib/fire-flow-repair.ts) that
 * need no database: the lookback dates, the status merge, and the two
 * constants that are pinned to vercel.json (the maxDuration the deadline is
 * measured from, and the UTC hour of the day's last slot). The SQL, the budget
 * and the residual accounting run for real in fire-flow-repair-pglite.test.ts;
 * the crons' use of the result in enrich-lottery-outcomes.test.ts and
 * enrich-silent-boom-outcomes.test.ts.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withDbRetry } from '../_lib/db.js';
import {
  FLOW_REPAIR_CHECK_ATTEMPT_MS,
  FLOW_REPAIR_CHECK_RETRIES,
  FLOW_REPAIR_CRON_MAX_DURATION_MS,
  FLOW_REPAIR_LAST_SLOT_UTC_HOUR,
  FLOW_REPAIR_MARGIN_MS,
  FLOW_REPAIR_WRITE_ATTEMPT_MS,
  FLOW_REPAIR_WRITE_RETRIES,
  lookbackDates,
  worseStatus,
} from '../_lib/fire-flow-repair.js';
import type { CronStatus } from '../_lib/cron-instrumentation.js';
import { FLOW_SERIES_DEADLINE_MS } from '../_lib/ticker-flow-snapshot.js';

interface VercelConfig {
  crons: Array<{ path: string; schedule: string }>;
  functions: Record<string, { maxDuration?: number }>;
}

const vercel = JSON.parse(
  readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'),
) as VercelConfig;

const JOBS = ['enrich-lottery-outcomes', 'enrich-silent-boom-outcomes'];

describe('lookbackDates', () => {
  it.each([
    // A Monday: the weekend and the two weekdays before it.
    [
      '2026-11-16',
      ['2026-11-16', '2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12'],
    ],
    // A month, a leap day and a year boundary.
    [
      '2026-03-02',
      ['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27', '2026-02-26'],
    ],
    [
      '2028-03-01',
      ['2028-03-01', '2028-02-29', '2028-02-28', '2028-02-27', '2028-02-26'],
    ],
    [
      '2027-01-02',
      ['2027-01-02', '2027-01-01', '2026-12-31', '2026-12-30', '2026-12-29'],
    ],
  ])(
    '%s covers itself and the four calendar days before it',
    (today, dates) => {
      expect(lookbackDates(today)).toEqual(dates);
    },
  );
});

describe('worseStatus', () => {
  it.each<[CronStatus, CronStatus, CronStatus]>([
    ['success', 'success', 'success'],
    ['success', 'partial', 'partial'],
    ['partial', 'success', 'partial'],
    ['partial', 'partial', 'partial'],
    ['error', 'success', 'error'],
    ['success', 'error', 'error'],
    ['error', 'partial', 'error'],
    ['partial', 'error', 'error'],
  ])('the worse of %s and %s is %s', (a, b, worse) => {
    expect(worseStatus(a, b)).toBe(worse);
  });
});

describe('the time margin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Fake-clock milliseconds the REAL `withDbRetry` takes to give up on a call
   * that never answers: every attempt runs to its timeout, with the backoff
   * between attempts. (Measured, so a change to the retry loop moves it.)
   */
  async function giveUpMs(retries: number, attemptMs: number): Promise<number> {
    vi.useFakeTimers();
    let settled = false;
    const gaveUp = withDbRetry(
      () => new Promise<never>(() => {}),
      retries,
      attemptMs,
    )
      .catch(() => undefined)
      .then(() => {
        settled = true;
      });
    const stepMs = 500;
    let elapsed = 0;
    while (!settled && elapsed < 600_000) {
      await vi.advanceTimersByTimeAsync(stepMs);
      elapsed += stepMs;
    }
    await gaveUp;
    return elapsed;
  }

  it('a ticker-day in flight when the deadline passes finishes inside FLOW_REPAIR_MARGIN_MS', async () => {
    const write = await giveUpMs(
      FLOW_REPAIR_WRITE_RETRIES,
      FLOW_REPAIR_WRITE_ATTEMPT_MS,
    );
    const check = await giveUpMs(
      FLOW_REPAIR_CHECK_RETRIES,
      FLOW_REPAIR_CHECK_ATTEMPT_MS,
    );

    // A group that started just before the deadline reads its series (up to its
    // own deadline), then writes one chunk and checks what the write left. No
    // later chunk starts once the deadline has passed.
    const worstCase = FLOW_SERIES_DEADLINE_MS + write + check;

    // The measurement is not vacuous: one attempt takes at least its timeout.
    expect(write).toBeGreaterThanOrEqual(FLOW_REPAIR_WRITE_ATTEMPT_MS);
    expect(check).toBeGreaterThanOrEqual(FLOW_REPAIR_CHECK_ATTEMPT_MS);
    expect(worstCase).toBeLessThanOrEqual(FLOW_REPAIR_MARGIN_MS);
    // 15 s series + (2 x 10 s attempts + 1 s backoff) + 5 s check.
    expect(worstCase).toBe(41_000);
  });
});

describe('what the repair assumes of vercel.json', () => {
  it.each(JOBS)(
    '%s has the maxDuration the repair deadline is measured from',
    (job) => {
      const entry = vercel.functions[`api/cron/${job}.ts`];
      expect(entry?.maxDuration).toBe(FLOW_REPAIR_CRON_MAX_DURATION_MS / 1000);
    },
  );

  it.each(JOBS)(
    '%s has its last slot of the day in the UTC hour the alarm waits for, and no slot after it',
    (job) => {
      const cron = vercel.crons.find((c) => c.path === `/api/cron/${job}`);
      expect(cron, `${job} is scheduled`).toBeDefined();
      const hours = cron!.schedule
        .split(' ')[1]!
        .split(',')
        .map((h) => Number.parseInt(h, 10));
      expect(hours.length).toBeGreaterThan(1);
      expect(Math.max(...hours)).toBe(FLOW_REPAIR_LAST_SLOT_UTC_HOUR);
      // Only that one slot is in the last hour: the earlier slots stay quiet.
      expect(
        hours.filter((h) => h >= FLOW_REPAIR_LAST_SLOT_UTC_HOUR),
      ).toHaveLength(1);
    },
  );
});
