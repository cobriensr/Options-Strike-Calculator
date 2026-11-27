import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asOfFrom,
  formatClosedLabel,
  HttpStatusError,
  isCarriedOver,
  isIsoDateTimeWithOffset,
  isTransientStatus,
  nextFinalFetchMs,
  sessionOpenMs,
} from '../../utils/closed-session';

describe('sessionOpenMs', () => {
  it.each([
    ['a winter (EST) trading day', '2026-11-23', '2026-11-23T14:30:00Z'],
    ['a summer (EDT) trading day', '2026-04-17', '2026-04-17T13:30:00Z'],
    [
      'a half day, which still opens at 09:30 ET',
      '2026-11-27',
      '2026-11-27T14:30:00Z',
    ],
  ])('is 09:30 ET on %s', (_label, etDate, iso) => {
    expect(sessionOpenMs(etDate)).toBe(Date.parse(iso));
  });

  it.each([
    ['a Saturday', '2026-11-21'],
    ['a Sunday', '2026-11-22'],
    ['Thanksgiving', '2026-11-26'],
    ['a malformed date', 'not-a-date'],
    ['an impossible date', '2026-02-30'],
  ])('is null on %s', (_label, etDate) => {
    expect(sessionOpenMs(etDate)).toBeNull();
  });
});

describe('isCarriedOver', () => {
  // Mon 2026-11-23, 09:30:05 ET (EST): five seconds into the session.
  const now = new Date('2026-11-23T14:30:05Z');

  it('is true for a capture from the prior session', () => {
    expect(isCarriedOver('2026-11-20T21:00:49Z', true, now)).toBe(true);
  });

  it('is true for a capture one second before the open', () => {
    expect(isCarriedOver('2026-11-23T14:29:59Z', true, now)).toBe(true);
  });

  it('is false for a capture at the open instant', () => {
    expect(isCarriedOver('2026-11-23T14:30:00Z', true, now)).toBe(false);
  });

  it('is false for a capture after the open', () => {
    expect(isCarriedOver('2026-11-23T14:30:04Z', true, now)).toBe(false);
  });

  it('is false when nothing was captured', () => {
    expect(isCarriedOver(null, true, now)).toBe(false);
  });

  it('is false while the market is closed', () => {
    expect(isCarriedOver('2026-11-20T21:00:49Z', false, now)).toBe(false);
  });

  it('is false for a capture that is not a timestamp', () => {
    expect(isCarriedOver('garbage', true, now)).toBe(false);
  });

  it('is false when today has no session to carry over into', () => {
    // Thanksgiving: no open to compare against.
    const holiday = new Date('2026-11-26T16:00:00Z');
    expect(isCarriedOver('2026-11-25T21:00:49Z', true, holiday)).toBe(false);
  });

  it('reads the open on the EDT clock in summer', () => {
    // 09:30:05 EDT is 13:30:05Z.
    const summer = new Date('2026-04-17T13:30:05Z');
    expect(isCarriedOver('2026-04-17T13:29:59Z', true, summer)).toBe(true);
    expect(isCarriedOver('2026-04-17T13:30:00Z', true, summer)).toBe(false);
  });

  it('takes today from the ET date, not the UTC date', () => {
    // 21:00 EST Sun 11-22 is 02:00Z Mon 11-23: ET says Sunday, no session.
    const lateSunday = new Date('2026-11-23T02:00:00Z');
    expect(isCarriedOver('2026-11-20T21:00:49Z', true, lateSunday)).toBe(false);
  });
});

describe('nextFinalFetchMs', () => {
  it('is 3 minutes after the close on the same trading day', () => {
    expect(nextFinalFetchMs(new Date('2026-11-20T20:00:00Z'))).toBe(
      Date.parse('2026-11-20T21:03:00Z'),
    ); // Fri
  });

  it('skips Thanksgiving to the half-day Friday, 13:00 ET + 3 min', () => {
    expect(nextFinalFetchMs(new Date('2026-11-26T15:00:00Z'))).toBe(
      Date.parse('2026-11-27T18:03:00Z'),
    );
  });

  it('skips a weekend to Monday', () => {
    expect(nextFinalFetchMs(new Date('2026-11-28T15:00:00Z'))).toBe(
      Date.parse('2026-11-30T21:03:00Z'),
    ); // Sat -> Mon
  });

  it('is strictly after the instant it is given', () => {
    expect(nextFinalFetchMs(new Date('2026-11-20T21:03:00Z'))).toBe(
      Date.parse('2026-11-23T21:03:00Z'),
    );
  });

  it('is the same instant when asked one millisecond before it', () => {
    expect(nextFinalFetchMs(new Date('2026-11-20T21:02:59.999Z'))).toBe(
      Date.parse('2026-11-20T21:03:00Z'),
    );
  });

  it('reads the close on the EDT clock in summer', () => {
    expect(nextFinalFetchMs(new Date('2026-04-17T15:00:00Z'))).toBe(
      Date.parse('2026-04-17T20:03:00Z'),
    );
  });

  it('follows the clock change: Friday closes at 20:00Z (EDT), Monday at 21:00Z (EST)', () => {
    // US DST ended Sunday 2026-11-01.
    expect(nextFinalFetchMs(new Date('2026-10-30T20:30:00Z'))).toBe(
      Date.parse('2026-11-02T21:03:00Z'),
    );
  });

  it('moves on to the next trading day late on the evening of a close', () => {
    // 22:00 EST Fri 11-20 is 03:00Z Sat 11-21; Friday's close is behind it.
    expect(nextFinalFetchMs(new Date('2026-11-21T03:00:00Z'))).toBe(
      Date.parse('2026-11-23T21:03:00Z'),
    );
  });

  it('lands on the half-day close on Christmas Eve', () => {
    expect(nextFinalFetchMs(new Date('2026-12-23T22:00:00Z'))).toBe(
      Date.parse('2026-12-24T18:03:00Z'),
    );
  });

  describe('with no trading day in the search window', () => {
    afterEach(() => {
      vi.doUnmock('../../data/marketHours');
      vi.resetModules();
    });

    it('is null', async () => {
      vi.resetModules();
      vi.doMock('../../data/marketHours', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../data/marketHours')>()),
        isTradingDay: () => false,
      }));
      const mod = await import('../../utils/closed-session');
      expect(mod.nextFinalFetchMs(new Date('2026-11-20T20:00:00Z'))).toBeNull();
    });
  });
});

describe('formatClosedLabel', () => {
  it('gives the weekday and Central time of the capture', () => {
    expect(
      formatClosedLabel(
        '2026-11-20T21:00:49Z',
        new Date('2026-11-21T15:00:00Z'),
      ),
    ).toBe('Fri 3:00 PM CT');
  });

  it('reads the capture on its own CT offset (CDT capture, CST now)', () => {
    expect(
      formatClosedLabel(
        '2026-10-30T20:00:49Z',
        new Date('2026-11-02T13:00:00Z'),
      ),
    ).toBe('Fri 3:00 PM CT');
  });

  it('stays undated at exactly 6 days', () => {
    expect(
      formatClosedLabel(
        '2026-11-20T21:00:49Z',
        new Date('2026-11-26T21:00:49Z'),
      ),
    ).toBe('Fri 3:00 PM CT');
  });

  it('adds the date past 6 days', () => {
    expect(
      formatClosedLabel(
        '2026-11-20T21:00:49Z',
        new Date('2026-11-26T21:00:50Z'),
      ),
    ).toBe('Fri Nov 20 3:00 PM CT');
  });

  it('writes a single-digit day without padding', () => {
    expect(
      formatClosedLabel(
        '2026-11-06T21:00:49Z',
        new Date('2026-11-20T15:00:00Z'),
      ),
    ).toBe('Fri Nov 6 3:00 PM CT');
  });

  it('dates the capture by its Central day, not its UTC day', () => {
    // 02:00Z Sat 11-21 is 20:00 CST Fri 11-20.
    expect(
      formatClosedLabel(
        '2026-11-21T02:00:00Z',
        new Date('2026-12-05T15:00:00Z'),
      ),
    ).toBe('Fri Nov 20 8:00 PM CT');
  });

  it('shows a half-day capture at noon CT', () => {
    expect(
      formatClosedLabel(
        '2026-11-27T18:00:49Z',
        new Date('2026-11-28T15:00:00Z'),
      ),
    ).toBe('Fri 12:00 PM CT');
  });

  it('is empty for a capture that is not a timestamp', () => {
    expect(formatClosedLabel('garbage', new Date('2026-11-21T15:00:00Z'))).toBe(
      '',
    );
  });
});

// The sanitizer both GEXBot hooks run an unchecked body's `asOf` through before
// it reaches the closed label and the carried-over check.
describe('asOfFrom', () => {
  it.each([
    ['a UTC timestamp with milliseconds', '2026-11-20T21:00:50.036Z'],
    ['a UTC timestamp without milliseconds', '2026-11-20T21:00:50Z'],
    ['a timestamp with an offset', '2026-11-20T16:00:50-05:00'],
  ])('returns %s unchanged', (_label, raw) => {
    expect(asOfFrom(raw)).toBe(raw);
  });

  // `Date.parse` alone accepts several of these ("2026" and "5" read as a year
  // and a month), which would otherwise pass as a capture time.
  it.each([
    ['a number', 1_764_000_000],
    ['a number that reads as a year', 2026],
    ['a string that reads as a year', '2026'],
    ['a string that reads as a month', '5'],
    ['a date with no time', '2026-11-20'],
    ['a date and time with a space', '2026-11-20 21:00:50'],
    ['an empty string', ''],
    ['text that is not a date', 'yesterday'],
    ['a date-time shape that does not parse', '2026-11-20Tgarbage'],
    ['a date-time shape out of range', '2026-13-45T25:61:61Z'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { at: '2026-11-20T21:00:50.036Z' }],
    ['an array holding a timestamp', ['2026-11-20T21:00:50.036Z']],
  ])('returns null for %s', (_label, raw) => {
    expect(asOfFrom(raw)).toBeNull();
  });

  // Shapes `Date.parse` reads but `z.iso.datetime({ offset: true })` refuses.
  // The analyze schema checks the forwarded `asOf` with that rule, so a looser
  // client check would let one of these through and 400 the whole analyze call.
  it.each([
    ['no zone', '2026-11-20T21:00:49'],
    ['no seconds', '2026-11-20T21:00Z'],
    ['an offset with no colon', '2026-11-20T21:00:49+0000'],
    ['a lower-case z', '2026-11-20T21:00:49.000z'],
  ])('returns null for a timestamp with %s', (_label, raw) => {
    expect(Number.isFinite(Date.parse(raw))).toBe(true);
    expect(asOfFrom(raw)).toBeNull();
  });
});

describe('isIsoDateTimeWithOffset', () => {
  it.each([
    '2026-11-20T21:00:50.036Z',
    '2026-11-20T21:00:50Z',
    '2026-11-20T16:00:50-05:00',
    new Date('2026-11-20T21:00:50.036Z').toISOString(),
  ])('accepts %s', (raw) => {
    expect(isIsoDateTimeWithOffset(raw)).toBe(true);
  });

  it.each([
    '2026-11-20T21:00:49',
    '2026-11-20T21:00Z',
    '2026-11-20T21:00:49+0000',
    '2026-11-20T21:00:49.000z',
    '2026-11-20',
    '',
    1_764_000_000,
    null,
    undefined,
    ['2026-11-20T21:00:50.036Z'],
  ])('rejects %j', (raw) => {
    expect(isIsoDateTimeWithOffset(raw)).toBe(false);
  });
});

describe('HttpStatusError', () => {
  it('carries the status and reads "HTTP <status>"', () => {
    const err = new HttpStatusError(503);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.message).toBe('HTTP 503');
    expect(err.name).toBe('HttpStatusError');
  });

  it('puts the source in front of the message when it has one', () => {
    const err = new HttpStatusError(500, 'gex-landscape');
    expect(err.status).toBe(500);
    expect(err.message).toBe('gex-landscape: HTTP 500');
  });

  // The hooks tell "another try can help" from "refused" by the carried status.
  it.each([
    [503, true],
    [429, true],
    [401, false],
    [404, false],
  ])('hands a %i to isTransientStatus as %s', (status, transient) => {
    expect(isTransientStatus(new HttpStatusError(status).status)).toBe(
      transient,
    );
  });
});

describe('isTransientStatus', () => {
  it.each([0, 408, 429, 500, 502, 503, 599])('is true for %i', (status) => {
    expect(isTransientStatus(status)).toBe(true);
  });

  it.each([200, 204, 301, 400, 401, 403, 404, 422, 499])(
    'is false for %i',
    (status) => {
      expect(isTransientStatus(status)).toBe(false);
    },
  );
});
