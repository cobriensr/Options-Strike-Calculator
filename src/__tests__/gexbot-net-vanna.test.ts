import { describe, expect, it } from 'vitest';

import { formatVannaMm, readNetVanna } from '../components/Gexbot/net-vanna';

describe('readNetVanna', () => {
  it.each([
    // [net −vanna $MM, hours to close, status, window (h), hours until in play]
    [799.9, 0.5, 'quiet', null, null],
    [-799.9, 0.5, 'quiet', null, null],
    [0, 3, 'quiet', null, null],
    // The vendor's words are "beyond $800MM" and "above $1,000MM": the
    // thresholds themselves do not qualify.
    [800, 0.5, 'quiet', null, null],
    [-800, 0.5, 'quiet', null, null],
    // Beyond 800: the last hour.
    [800.01, 1, 'in-play', 1, 0],
    [912, 0.25, 'in-play', 1, 0],
    [-912, 2.25, 'pending', 1, 1.25],
    [999.9, 1.5, 'pending', 1, 0.5],
    // Exactly 1,000 is not "above": still the last-hour tier.
    [1000, 1, 'in-play', 1, 0],
    [-1000, 2, 'pending', 1, 1],
    // Above 1,000: about the last two hours.
    [1000.01, 2, 'in-play', 2, 0],
    [-1204, 1.75, 'in-play', 2, 0],
    [1204, 5, 'pending', 2, 3],
  ] as const)(
    '%f $MM with %f h left is %s',
    (value, hours, status, windowHours, hoursUntilInPlay) => {
      const read = readNetVanna(value, hours);
      expect(read.status).toBe(status);
      expect(read.windowHours).toBe(windowHours);
      if (hoursUntilInPlay == null) expect(read.hoursUntilInPlay).toBeNull();
      else expect(read.hoursUntilInPlay).toBeCloseTo(hoursUntilInPlay, 12);
    },
  );

  it('reads the sign as the vendor defines it: + adds bids, − adds offers', () => {
    expect(readNetVanna(912, 0.5).side).toBe('bids');
    expect(readNetVanna(-912, 0.5).side).toBe('offers');
    expect(readNetVanna(0, 0.5).side).toBe('flat');
  });

  it('is closed once the session is over, whatever the size', () => {
    expect(readNetVanna(1500, 0)).toEqual({
      status: 'closed',
      side: 'bids',
      windowHours: null,
      hoursUntilInPlay: null,
    });
    expect(readNetVanna(100, -1).status).toBe('closed');
  });
});

describe('formatVannaMm', () => {
  it.each([
    [912.4, '+$912 MM'],
    [-1204.6, '−$1,205 MM'],
    [130.96, '+$131 MM'],
    [42.34, '+$42.3 MM'],
    [-0.44, '−$0.4 MM'],
    [0, '$0 MM'],
  ])('formats %f as %s', (value, text) => {
    expect(formatVannaMm(value)).toBe(text);
  });
});
