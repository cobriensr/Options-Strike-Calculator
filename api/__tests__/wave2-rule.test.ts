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
  LAGGING_WINDOW_MIN,
  LOTTERY_TABLE,
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

  it('labels a follow-up at once, without waiting for the fire to age', () => {
    // 2 minutes after the trigger, the follow-up already settles it.
    const followupMs = TRIGGER + min(1);
    expect(wave2Verdict(TRIGGER, followupMs, TRIGGER + min(2))).toEqual({
      status: 'confirmed',
      detectedAtIso: new Date(followupMs).toISOString(),
    });
  });

  it('writes wave2_detected_at at millisecond precision, as the cron always has', () => {
    const verdict = wave2Verdict(TRIGGER, TRIGGER + min(10) + 123, LATE);
    expect(verdict?.detectedAtIso).toBe('2026-05-21T14:10:00.123Z');
  });

  it.each([
    ['59:59.999 old', min(60) - 1, null],
    ['exactly 60:00 old (inclusive)', min(60), 'fizzled'],
    ['60:00.001 old', min(60) + 1, 'fizzled'],
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

  it('treats a brand-new fire with no follow-up as in flight', () => {
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
