// @vitest-environment node

/**
 * Tests for the scraper's schedule-aware polling helpers
 * (`isInActivePollingWindow`, `expectedWindowEnd`, `parseSlotEnd`).
 *
 * Together these power the 1-min-cadence dedup loop in
 * `runTick`: scrape only when we expect a new UW slot, and skip the
 * insert + webhook when UW hasn't published the next slot yet.
 */

import { describe, it, expect } from 'vitest';
import {
  isInActivePollingWindow,
  expectedWindowEnd,
  parseSlotEnd,
} from '../dates.js';

describe('isInActivePollingWindow: 08:21-15:14 CT, Mon-Fri', () => {
  it('true at 08:21 CDT (window open)', () => {
    // 2026-05-06 13:21 UTC = 08:21 CDT (Wednesday).
    expect(isInActivePollingWindow(new Date('2026-05-06T13:21:00Z'))).toBe(
      true,
    );
  });

  it('false at 08:20 CDT (one min before open)', () => {
    expect(isInActivePollingWindow(new Date('2026-05-06T13:20:00Z'))).toBe(
      false,
    );
  });

  it('true at 15:14 CDT (window close)', () => {
    // 2026-05-06 20:14 UTC = 15:14 CDT.
    expect(isInActivePollingWindow(new Date('2026-05-06T20:14:00Z'))).toBe(
      true,
    );
  });

  it('false at 15:15 CDT (one min after window close)', () => {
    expect(isInActivePollingWindow(new Date('2026-05-06T20:15:00Z'))).toBe(
      false,
    );
  });

  it('false on Saturday inside time bounds', () => {
    // 2026-05-09 14:00 UTC = 09:00 CDT Saturday.
    expect(isInActivePollingWindow(new Date('2026-05-09T14:00:00Z'))).toBe(
      false,
    );
  });

  it('false on Sunday inside time bounds', () => {
    expect(isInActivePollingWindow(new Date('2026-05-10T19:00:00Z'))).toBe(
      false,
    );
  });

  it('DST-aware: 08:30 CST in November = 14:30 UTC, inside window', () => {
    // 2025-11-17 (Monday) is post-DST-end (Nov 2, 2025).
    expect(isInActivePollingWindow(new Date('2025-11-17T14:30:00Z'))).toBe(
      true,
    );
  });

  it('DST-aware: 13:30 UTC in November = 07:30 CST, before window', () => {
    expect(isInActivePollingWindow(new Date('2025-11-17T13:30:00Z'))).toBe(
      false,
    );
  });

  it('DST-aware: 21:00 UTC in November = 15:00 CST, inside window', () => {
    // CST is UTC-6; in DST-active May, 21:00 UTC would be 16:00 CDT
    // (outside window). The DST awareness flips this back inside on
    // CST dates — guards against the legacy hour-based UTC gate
    // silently dropping the entire close in winter.
    expect(isInActivePollingWindow(new Date('2025-11-17T21:00:00Z'))).toBe(
      true,
    );
  });

  it('CST exact lower bound: 08:21 CST = 14:21 UTC, inside window', () => {
    expect(isInActivePollingWindow(new Date('2025-11-17T14:21:00Z'))).toBe(
      true,
    );
  });

  it('CST one minute below lower bound: 08:20 CST = 14:20 UTC, outside', () => {
    expect(isInActivePollingWindow(new Date('2025-11-17T14:20:00Z'))).toBe(
      false,
    );
  });

  it('CST exact upper bound: 15:14 CST = 21:14 UTC, inside window', () => {
    expect(isInActivePollingWindow(new Date('2025-11-17T21:14:00Z'))).toBe(
      true,
    );
  });

  it('CST one minute above upper bound: 15:15 CST = 21:15 UTC, outside', () => {
    expect(isInActivePollingWindow(new Date('2025-11-17T21:15:00Z'))).toBe(
      false,
    );
  });
});

describe('expectedWindowEnd: most recently closed 10-min boundary in CT', () => {
  it('returns "08:30" at 08:30:00 CDT (boundary instant)', () => {
    // 2026-05-06 13:30 UTC = 08:30 CDT.
    expect(expectedWindowEnd(new Date('2026-05-06T13:30:00Z'))).toBe('08:30');
  });

  it('returns "08:30" mid-window at 08:35 CDT', () => {
    expect(expectedWindowEnd(new Date('2026-05-06T13:35:00Z'))).toBe('08:30');
  });

  it('returns "08:30" just before next boundary at 08:39:59 CDT', () => {
    expect(expectedWindowEnd(new Date('2026-05-06T13:39:59Z'))).toBe('08:30');
  });

  it('returns "08:40" at 08:40:00 CDT (next boundary just closed)', () => {
    expect(expectedWindowEnd(new Date('2026-05-06T13:40:00Z'))).toBe('08:40');
  });

  it('returns "15:00" at 15:02 CDT (debrief slot end)', () => {
    expect(expectedWindowEnd(new Date('2026-05-06T20:02:00Z'))).toBe('15:00');
  });

  it('returns "09:00" at 09:01 CDT (cross-hour boundary)', () => {
    expect(expectedWindowEnd(new Date('2026-05-06T14:01:00Z'))).toBe('09:00');
  });

  it('DST-aware: 09:00 CST in November maps correctly', () => {
    // 2025-11-17 15:01 UTC = 09:01 CST.
    expect(expectedWindowEnd(new Date('2025-11-17T15:01:00Z'))).toBe('09:00');
  });

  it('returns null before the first 10-min boundary of the day (00:05 CT)', () => {
    // 2026-05-06 05:05 UTC = 00:05 CDT. No closed boundary yet.
    expect(expectedWindowEnd(new Date('2026-05-06T05:05:00Z'))).toBeNull();
  });
});

describe('parseSlotEnd: extract end-time from UW slot label', () => {
  it('parses "08:20 - 08:30" → "08:30"', () => {
    expect(parseSlotEnd('08:20 - 08:30')).toBe('08:30');
  });

  it('parses "14:50 - 15:00" → "15:00" (debrief)', () => {
    expect(parseSlotEnd('14:50 - 15:00')).toBe('15:00');
  });

  it('pads single-digit hour: "8:20 - 8:30" → "08:30"', () => {
    expect(parseSlotEnd('8:20 - 8:30')).toBe('08:30');
  });

  it('tolerates extra whitespace', () => {
    expect(parseSlotEnd('  08:20  -  08:30  ')).toBe('08:30');
  });

  it('returns null on garbage', () => {
    expect(parseSlotEnd('Latest')).toBeNull();
    expect(parseSlotEnd('')).toBeNull();
    expect(parseSlotEnd('08:20-08:30-08:40')).toBeNull();
  });
});

describe('Integration: state-reset on transition out of active window', () => {
  // Models the reset-on-exit logic in runTick: when isInActivePollingWindow
  // flips to false AND lastCapturedWindowEnd is non-null, state goes to
  // null so the next trading day starts fresh.
  it('clears lastCapturedWindowEnd at the 15:14→15:15 CT boundary', () => {
    let lastCapturedWindowEnd: string | null = '15:00'; // captured debrief at 15:02

    type Step = { utc: string; ctLabel: string };
    const steps: Step[] = [
      { utc: '2026-05-06T20:14:00Z', ctLabel: '15:14 CDT' }, // still inside
      { utc: '2026-05-06T20:15:00Z', ctLabel: '15:15 CDT' }, // just outside
      { utc: '2026-05-06T20:30:00Z', ctLabel: '15:30 CDT' }, // outside
    ];

    const stateOverTime: Array<{ ct: string; state: string | null }> = [];
    for (const step of steps) {
      const now = new Date(step.utc);
      const inWindow = isInActivePollingWindow(now);
      if (!inWindow && lastCapturedWindowEnd !== null) {
        lastCapturedWindowEnd = null;
      }
      stateOverTime.push({ ct: step.ctLabel, state: lastCapturedWindowEnd });
    }

    expect(stateOverTime).toEqual([
      { ct: '15:14 CDT', state: '15:00' }, // still inside window — preserved
      { ct: '15:15 CDT', state: null }, // crossed out — reset
      { ct: '15:30 CDT', state: null }, // still outside — stays null
    ]);
  });
});

describe('Integration: dedup decision over a typical morning sequence', () => {
  // Demonstrates the schedule-aware dedup over realistic wall-clock
  // ticks. The boolean each row is "would runTick scrape?" — i.e.
  // `expectedWindowEnd(now) !== lastCapturedWindowEnd`.
  it('skips scrape between boundaries once a slot is captured', () => {
    let lastCapturedWindowEnd: string | null = null;
    const stepsThatScrape: string[] = [];

    type Step = { utc: string; ctLabel: string; capturedSlot?: string };
    const steps: Step[] = [
      // Pre-publish: UW still on yesterday's frozen slot. The scraper
      // detects the slot end ("15:00") differs from null → scrapes.
      { utc: '2026-05-06T13:21:00Z', ctLabel: '08:21 CDT' },
      // Captures "14:50 - 15:00" (yesterday's frozen). Skipped by
      // auto-playbook 422; we record the capture so dedup can skip
      // subsequent ticks until UW rolls.
      { utc: '2026-05-06T13:22:00Z', ctLabel: '08:22 CDT' },
      // ... UW rolls to "08:10 - 08:20" between 08:22 and 08:25.
      { utc: '2026-05-06T13:25:00Z', ctLabel: '08:25 CDT' },
      // Inside the same 10-min window after capture → dedup skips.
      { utc: '2026-05-06T13:27:00Z', ctLabel: '08:27 CDT' },
      // 08:30 boundary closes — expected window shifts to "08:30".
      { utc: '2026-05-06T13:30:00Z', ctLabel: '08:30 CDT' },
      // 08:33 — UW typically rolls by here.
      { utc: '2026-05-06T13:33:00Z', ctLabel: '08:33 CDT' },
      // After capture, dedup skips again until next boundary.
      { utc: '2026-05-06T13:38:00Z', ctLabel: '08:38 CDT' },
    ];

    // Simulate captures along the way: tick 2 (08:22) captures "15:00",
    // tick 3 (08:25) captures "08:20", tick 6 (08:33) captures "08:30".
    const captureAt: Record<string, string> = {
      '08:22 CDT': '15:00',
      '08:25 CDT': '08:20',
      '08:33 CDT': '08:30',
    };

    for (const step of steps) {
      const now = new Date(step.utc);
      const expected = expectedWindowEnd(now);
      const wouldScrape = expected !== lastCapturedWindowEnd;
      if (wouldScrape) stepsThatScrape.push(step.ctLabel);

      const captured = captureAt[step.ctLabel];
      if (wouldScrape && captured != null) {
        lastCapturedWindowEnd = captured;
      }
    }

    // 08:21, 08:22, 08:25, 08:30, 08:33 scrape. 08:27 and 08:38 skipped.
    expect(stepsThatScrape).toEqual([
      '08:21 CDT',
      '08:22 CDT',
      '08:25 CDT',
      '08:30 CDT',
      '08:33 CDT',
    ]);
  });
});
