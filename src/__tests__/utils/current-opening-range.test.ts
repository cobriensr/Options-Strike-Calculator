import { describe, it, expect } from 'vitest';
import { currentOpeningRange } from '../../utils/current-opening-range';
import type { IntradayResponse } from '../../types/api';

// A held /api/intraday body: the range is from `sessionDate`, whatever day it
// is now. The rule reads `sessionDate` against the date clock (`etToday`), so
// a tab left open across a session boundary stops showing the old range.
const RANGE = {
  high: 6798.96,
  low: 6762.05,
  rangePts: 36.91,
  minutes: 30,
  complete: true,
} as const;

function intradayFrom(
  sessionDate: string | null,
  openingRange: IntradayResponse['openingRange'] = RANGE,
): IntradayResponse {
  return {
    today: { open: 6796.56, high: 6845.08, low: 6759.74, last: 6775.8 },
    openingRange,
    sessionDate,
    previousClose: 6795.99,
    candleCount: 78,
    marketOpen: false,
    asOf: '2026-11-20T21:00:00Z',
  };
}

describe('currentOpeningRange', () => {
  it.each([
    // [what the case is, sessionDate, etToday, current?]
    ["today's range on a trading day", '2026-11-24', '2026-11-24', true],
    ["Friday's range on Saturday", '2026-11-20', '2026-11-21', true],
    ["Friday's range on Sunday", '2026-11-20', '2026-11-22', true],
    [
      "Friday's range on Monday, a trading day",
      '2026-11-20',
      '2026-11-23',
      false,
    ],
    [
      "Thursday's range on Saturday: one session too old",
      '2026-11-19',
      '2026-11-21',
      false,
    ],
    [
      "Friday's range on a holiday Monday (Memorial Day 2026-05-25)",
      '2026-05-22',
      '2026-05-25',
      true,
    ],
    [
      "Friday's range on the Tuesday after that holiday, a trading day",
      '2026-05-22',
      '2026-05-26',
      false,
    ],
    [
      "Thursday's range on the Saturday after Good Friday (2026-04-04)",
      '2026-04-02',
      '2026-04-04',
      true,
    ],
    [
      'a holiday (Good Friday 2026-04-03) is not the last trading day before the Saturday',
      '2026-04-03',
      '2026-04-04',
      false,
    ],
    ['a range from the future', '2026-11-25', '2026-11-24', false],
  ])('%s', (_label, sessionDate, etToday, isCurrent) => {
    const intraday = intradayFrom(sessionDate);

    expect(currentOpeningRange(intraday, etToday)).toBe(
      isCurrent ? intraday.openingRange : null,
    );
  });

  it('is null when the body has no sessionDate', () => {
    expect(currentOpeningRange(intradayFrom(null), '2026-11-24')).toBeNull();
    expect(currentOpeningRange(intradayFrom(null), '2026-11-21')).toBeNull();
  });

  it('is null when there is no body', () => {
    expect(currentOpeningRange(null, '2026-11-24')).toBeNull();
    expect(currentOpeningRange(undefined, '2026-11-24')).toBeNull();
  });

  it('is null when the session has no range yet, even on the right date', () => {
    // Today's pre-9:30 indicative bars: sessionDate is today, range is null.
    expect(
      currentOpeningRange(intradayFrom('2026-11-24', null), '2026-11-24'),
    ).toBeNull();
  });

  it('returns the range as held, partial or complete', () => {
    const partial = { ...RANGE, minutes: 15, complete: false };

    expect(
      currentOpeningRange(intradayFrom('2026-11-24', partial), '2026-11-24'),
    ).toBe(partial);
  });

  it.each(['', 'not-a-date', '2026-13-45'])(
    'does not throw on a malformed etToday (%j)',
    (etToday) => {
      expect(
        currentOpeningRange(intradayFrom('2026-11-20'), etToday),
      ).toBeNull();
    },
  );
});
