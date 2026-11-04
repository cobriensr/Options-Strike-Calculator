// @vitest-environment node

/**
 * The wave-2 verdict rule (api/_lib/wave2-rule.ts), as an input/output
 * table. The cron (cron-wave2-confirmation.test.ts) and the one-shot
 * backfill (scripts/_lib/wave2-backfill.test.ts) both go through this
 * function, so its boundaries are pinned here once, to the second.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFIRMED_WINDOW_MIN,
  INSERT_MARGIN_MIN,
  LAGGING_WINDOW_MIN,
  LOTTERY_TABLE,
  SETTLE_AGE_MIN,
  SILENT_BOOM_TABLE,
  WAVE2_TABLES,
  wave2Verdict,
} from '../_lib/wave2-rule.js';

const TRIGGER = Date.parse('2026-05-21T14:00:00.000Z');
const sec = (s: number) => s * 1000;
const min = (m: number) => m * 60_000;

/** `now` far past every window, so only the follow-up decides. */
const LATE = TRIGGER + min(600);

describe('wave2Verdict', () => {
  it('pins the windows the owner specified: 30 and 60 minutes', () => {
    expect(CONFIRMED_WINDOW_MIN).toBe(30);
    expect(LAGGING_WINDOW_MIN).toBe(60);
  });

  it('settles a fire after the lagging window plus a 15-minute insert margin: 75 minutes', () => {
    expect(INSERT_MARGIN_MIN).toBe(15);
    expect(SETTLE_AGE_MIN).toBe(75);
    expect(SETTLE_AGE_MIN).toBe(LAGGING_WINDOW_MIN + INSERT_MARGIN_MIN);
  });

  it.each([
    ['1 s after the trigger', sec(1), 'confirmed'],
    ['29:59', min(29) + sec(59), 'confirmed'],
    ['exactly 30:00 (the bound is inclusive)', min(30), 'confirmed'],
    ['30:00.001, one millisecond past it', min(30) + 1, 'lagging'],
    ['30:01', min(30) + sec(1), 'lagging'],
    ['59:59', min(59) + sec(59), 'lagging'],
    ['exactly 60:00 (still lagging)', min(60), 'lagging'],
  ] as const)(
    'labels a follow-up %s as %s',
    (_label, offsetMs, expectedStatus) => {
      const followupMs = TRIGGER + offsetMs;
      expect(wave2Verdict(TRIGGER, followupMs, LATE)).toEqual({
        status: expectedStatus,
        detectedAtIso: new Date(followupMs).toISOString(),
      });
    },
  );

  it.each([
    ['a confirmed-range follow-up', min(1)],
    ['a lagging-range follow-up', min(45)],
    ['a follow-up at the 60:00 edge', min(60)],
  ] as const)(
    'does not label a fire with %s until it is 75 minutes old',
    (_label, followupOffsetMs) => {
      // The follow-up present now may not be the earliest one (an earlier
      // one can still be waiting to be written), so nothing is decided.
      const followupMs = TRIGGER + followupOffsetMs;
      for (const ageMs of [
        min(2),
        min(30),
        min(60),
        min(74),
        min(75) - sec(1),
        min(75) - 1,
      ]) {
        expect(wave2Verdict(TRIGGER, followupMs, TRIGGER + ageMs)).toBeNull();
      }
    },
  );

  it.each([
    ['a follow-up at +1 min', min(1), 'confirmed'],
    ['a follow-up at exactly +30:00', min(30), 'confirmed'],
    ['a follow-up at +30:00.001', min(30) + 1, 'lagging'],
    ['a follow-up at exactly +60:00', min(60), 'lagging'],
  ] as const)(
    'labels a fire with %s at exactly 75:00 old (the settle bound is inclusive): %s',
    (_label, followupOffsetMs, expectedStatus) => {
      const followupMs = TRIGGER + followupOffsetMs;
      expect(wave2Verdict(TRIGGER, followupMs, TRIGGER + min(75))).toEqual({
        status: expectedStatus,
        detectedAtIso: new Date(followupMs).toISOString(),
      });
    },
  );

  it('writes wave2_detected_at at millisecond precision, as the cron always has', () => {
    const verdict = wave2Verdict(TRIGGER, TRIGGER + min(10) + 123, LATE);
    expect(verdict?.detectedAtIso).toBe('2026-05-21T14:10:00.123Z');
  });

  it.each([
    ['59:59.999 old', min(60) - 1, null],
    ['exactly 60:00 old (the window is over, not yet settled)', min(60), null],
    ['74:59.999 old', min(75) - 1, null],
    ['exactly 75:00 old (inclusive)', min(75), 'fizzled'],
    ['75:00.001 old', min(75) + 1, 'fizzled'],
    ['3 hours old', min(180), 'fizzled'],
  ] as const)(
    'with no follow-up, a fire %s is %s',
    (_label, ageMs, expectedStatus) => {
      const verdict = wave2Verdict(TRIGGER, null, TRIGGER + ageMs);
      if (expectedStatus === null) {
        expect(verdict).toBeNull();
      } else {
        // A fizzled fire leaves wave2_detected_at alone: null, not a time.
        expect(verdict).toEqual({ status: 'fizzled', detectedAtIso: null });
      }
    },
  );

  it('treats a brand-new fire with no follow-up as not settled', () => {
    expect(wave2Verdict(TRIGGER, null, TRIGGER + sec(61))).toBeNull();
  });
});

describe('wave-2 table descriptors', () => {
  it('names each table with its own trigger-time column', () => {
    expect(LOTTERY_TABLE).toEqual({
      name: 'lottery',
      table: 'lottery_finder_fires',
      triggerCol: 'trigger_time_ct',
    });
    expect(SILENT_BOOM_TABLE).toEqual({
      name: 'silentboom',
      table: 'silent_boom_alerts',
      triggerCol: 'bucket_ct',
    });
  });

  it('lists lottery first, then silent boom, the order the cron runs them', () => {
    expect(WAVE2_TABLES).toEqual([LOTTERY_TABLE, SILENT_BOOM_TABLE]);
  });
});
