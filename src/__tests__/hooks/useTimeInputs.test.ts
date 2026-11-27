import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTimeInputs } from '../../hooks/useTimeInputs';

// useTimeInputs seeds its 3 time fields from the current CT clock during
// market hours (9:30 AM ET to the day's close: 4:00 PM ET, or 1:00 PM ET on an
// early-close day; none on a weekend or holiday), or 10:00 AM CT otherwise. The
// AUD-L8 fix reads the clock ONCE so the seeded hour/minute/AM-PM can't
// tear across a minute / AM-PM boundary.

describe('useTimeInputs', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('defaults to 10:00 AM CT outside market hours', () => {
    vi.useFakeTimers();
    // 2026-03-18T05:00:00Z → 1:00 AM ET (pre-market) → fallback to 10:00 CT.
    vi.setSystemTime(new Date('2026-03-18T05:00:00Z'));

    const { result } = renderHook(() => useTimeInputs());

    expect(result.current.timeHour).toBe('10');
    expect(result.current.timeMinute).toBe('00');
    expect(result.current.timeAmPm).toBe('AM');
    expect(result.current.timezone).toBe('CT');
  });

  it('seeds from the CT clock during market hours (rounding minute to 5)', () => {
    vi.useFakeTimers();
    // 2026-03-18T18:07:00Z (EDT) → 2:07 PM ET → 1:07 PM CT.
    vi.setSystemTime(new Date('2026-03-18T18:07:00Z'));

    const { result } = renderHook(() => useTimeInputs());

    expect(result.current.timeHour).toBe('1'); // 13:07 CT → 1 PM
    expect(result.current.timeMinute).toBe('05'); // 7 → floor to nearest 5
    expect(result.current.timeAmPm).toBe('PM');
  });

  it('reads the clock once — hour/minute/AM-PM derive from a single instant', () => {
    // Simulate a clock that advances across the noon (AM→PM) boundary on
    // each successive no-arg `new Date()` read. A torn implementation that
    // read the clock separately per field would seed an inconsistent
    // 11:59 AM hour with a 12:0x PM minute/AM-PM. The single-read fix must
    // pin every field to the FIRST read.
    const RealDate = Date;
    // First no-arg read → 11:59:59 AM CT (EDT, CT = UTC-5). Any subsequent
    // no-arg read crosses into 12:00 PM CT — the boundary we must NOT cross.
    const instants = [
      '2026-06-10T16:59:59Z',
      '2026-06-10T17:00:00Z',
      '2026-06-10T17:00:01Z',
      '2026-06-10T17:00:02Z',
    ];
    let call = 0;
    class MockDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length > 0) {
          super(...(args as ConstructorParameters<typeof Date>));
        } else {
          const iso = instants[Math.min(call, instants.length - 1)]!;
          call += 1;
          super(iso);
        }
      }
    }
    vi.stubGlobal('Date', MockDate);

    const { result } = renderHook(() => useTimeInputs());

    // All three fields must reflect the SAME 11:59 AM instant (the first
    // read), not a mix of 11:59 AM and 12:00 PM.
    expect(result.current.timeHour).toBe('11');
    expect(result.current.timeMinute).toBe('55'); // 59 → floor to nearest 5
    expect(result.current.timeAmPm).toBe('AM');

    vi.unstubAllGlobals();
  });

  // The seed window is the day's real session: it ends at the calendar close
  // (1:00 PM ET on an early-close day, not a fixed 4:00 PM ET) and is empty on
  // a weekend or NYSE holiday. Outside it the hook seeds the 10:00 AM CT
  // default so useCalculation stays valid.
  describe('the seed follows the session calendar', () => {
    function seedAt(iso: string) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(iso));
      const { result } = renderHook(() => useTimeInputs());
      return {
        hour: result.current.timeHour,
        minute: result.current.timeMinute,
        ampm: result.current.timeAmPm,
      };
    }
    const DEFAULT_SEED = { hour: '10', minute: '00', ampm: 'AM' };

    it.each([
      // 18:30Z = 13:30 ET = 12:30 CT, half an hour after the 1:00 PM ET close.
      ['Black Friday 2026 (EST)', '2026-11-27T18:30:00Z'],
      ['Christmas Eve 2026 (EST)', '2026-12-24T18:30:00Z'],
      // 17:30Z = 13:30 ET in EDT: the offset shift must not move the close.
      ['day before July 4th 2025 (EDT)', '2025-07-03T17:30:00Z'],
    ])(
      'seeds the 10:00 AM CT default after the half-day close: %s',
      (_n, iso) => {
        expect(seedAt(iso)).toEqual(DEFAULT_SEED);
      },
    );

    it('seeds the real CT clock before the half-day close', () => {
      // 17:35Z = 12:35 ET = 11:35 CT, 25 minutes before the 1:00 PM ET close.
      // (10:00 CT would not tell the clock from the default.)
      expect(seedAt('2026-11-27T17:35:00Z')).toEqual({
        hour: '11',
        minute: '35',
        ampm: 'AM',
      });
    });

    it('treats the half-day close minute as closed and the minute before it as open', () => {
      // The close is exclusive, as the full-day 4:00 PM ET close is.
      expect(seedAt('2026-11-27T17:59:00Z')).toEqual({
        hour: '11',
        minute: '55',
        ampm: 'AM',
      });
      expect(seedAt('2026-11-27T18:00:00Z')).toEqual(DEFAULT_SEED);
    });

    it('seeds the real CT clock at the same 12:30 PM CT on a normal day', () => {
      // Same wall-clock instant as the Black Friday case above, on the Wednesday
      // before Thanksgiving: the session runs to 4:00 PM ET, so 1:30 PM ET is open.
      expect(seedAt('2026-11-25T18:30:00Z')).toEqual({
        hour: '12',
        minute: '30',
        ampm: 'PM',
      });
    });

    it('seeds the default after the normal 4:00 PM ET close', () => {
      // 21:30Z = 16:30 ET = 15:30 CT.
      expect(seedAt('2026-11-25T21:30:00Z')).toEqual(DEFAULT_SEED);
    });

    it.each([
      ['Thanksgiving 2026', '2026-11-26T17:35:00Z'],
      ['Christmas 2026', '2026-12-25T17:35:00Z'],
      ['Independence Day observed 2026', '2026-07-03T17:35:00Z'],
    ])('seeds the default all day on a market holiday: %s', (_n, iso) => {
      // 17:35Z is 12:35 ET (EST) or 13:35 ET (EDT): inside the 9:30-16:00 ET
      // hours of a trading day, so only the holiday calendar can make it closed.
      expect(seedAt(iso)).toEqual(DEFAULT_SEED);
    });

    it.each([
      ['Saturday', '2026-11-28T17:35:00Z'],
      ['Sunday', '2026-11-29T17:35:00Z'],
    ])('seeds the default all day on a weekend: %s', (_n, iso) => {
      expect(seedAt(iso)).toEqual(DEFAULT_SEED);
    });
  });
});
