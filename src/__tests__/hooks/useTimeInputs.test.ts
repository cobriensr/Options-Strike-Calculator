import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTimeInputs } from '../../hooks/useTimeInputs';

// useTimeInputs seeds its 3 time fields from the current CT clock during
// market hours (9:30 AM – 4:00 PM ET), or 10:00 AM CT otherwise. The
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
});
