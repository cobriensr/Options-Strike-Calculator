import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCalculation } from '../../hooks/useCalculation';

describe('useCalculation', () => {
  const defaults = {
    dSpot: '550',
    dSpx: '',
    dVix: '20',
    dIV: '',
    dMult: '1.15',
    ivMode: 'vix' as 'vix' | 'direct',
    timeHour: '10',
    timeMinute: '00',
    timeAmPm: 'AM' as 'AM' | 'PM',
    timezone: 'ET' as 'ET' | 'CT',
    spxRatio: 10,
    skewPct: 0,
  };

  function renderCalc(overrides: Partial<typeof defaults> = {}) {
    const props = { ...defaults, ...overrides };
    return renderHook(() =>
      useCalculation(
        props.dSpot,
        props.dSpx,
        props.dVix,
        props.dIV,
        props.dMult,
        props.ivMode,
        props.timeHour,
        props.timeMinute,
        props.timeAmPm,
        props.timezone,
        props.spxRatio,
        props.skewPct,
      ),
    );
  }

  it('returns results with valid inputs', () => {
    const { result } = renderCalc();
    expect(result.current.results).not.toBeNull();
    expect(result.current.errors).toEqual({});
  });

  it('calculates spot as spy * ratio', () => {
    const { result } = renderCalc({ dSpot: '550', spxRatio: 10 });
    expect(result.current.results?.spot).toBe(5500);
  });

  it('returns null results when spot is empty', () => {
    const { result } = renderCalc({ dSpot: '' });
    expect(result.current.results).toBeNull();
  });

  it('returns error for invalid spot', () => {
    const { result } = renderCalc({ dSpot: 'abc' });
    expect(result.current.errors['spot']).toBeDefined();
  });

  it('returns error for negative spot', () => {
    const { result } = renderCalc({ dSpot: '-10' });
    expect(result.current.errors['spot']).toBeDefined();
  });

  it('returns error for time before market open', () => {
    const { result } = renderCalc({
      timeHour: '9',
      timeMinute: '00',
      timeAmPm: 'AM',
    });
    expect(result.current.errors['time']).toContain('Before market open');
  });

  it('returns error for time at/after market close', () => {
    const { result } = renderCalc({
      timeHour: '4',
      timeMinute: '00',
      timeAmPm: 'PM',
    });
    expect(result.current.errors['time']).toContain('close');
  });

  it('accepts valid market hours time', () => {
    const { result } = renderCalc({
      timeHour: '10',
      timeMinute: '30',
      timeAmPm: 'AM',
    });
    expect(result.current.errors['time']).toBeUndefined();
  });

  it('converts CT to ET by adding 1 hour', () => {
    // 9:30 AM CT = 10:30 AM ET — valid
    const { result } = renderCalc({
      timeHour: '9',
      timeMinute: '30',
      timeAmPm: 'AM',
      timezone: 'CT',
    });
    expect(result.current.errors['time']).toBeUndefined();
  });

  it('returns error for invalid VIX', () => {
    const { result } = renderCalc({ dVix: 'abc' });
    expect(result.current.errors['vix']).toBeDefined();
  });

  it('returns error for invalid multiplier', () => {
    const { result } = renderCalc({ dMult: 'abc' });
    expect(result.current.errors['multiplier']).toBeDefined();
  });

  it('uses direct IV mode', () => {
    const { result } = renderCalc({
      ivMode: 'direct',
      dIV: '0.20',
      dVix: '20',
    });
    expect(result.current.results).not.toBeNull();
    expect(result.current.results?.sigma).toBeCloseTo(0.2);
  });

  it('returns error for invalid direct IV', () => {
    const { result } = renderCalc({ ivMode: 'direct', dIV: 'abc' });
    expect(result.current.errors['iv']).toBeDefined();
  });

  it('calculates sigma from VIX with multiplier', () => {
    const { result } = renderCalc({ dVix: '20', dMult: '1.15' });
    expect(result.current.results).not.toBeNull();
    // sigma = VIX/100 * mult = 0.20 * 1.15 = 0.23
    expect(result.current.results?.sigma).toBeCloseTo(0.23);
  });

  it('uses SPX direct ratio when SPX is provided', () => {
    const { result } = renderCalc({ dSpot: '550', dSpx: '5510' });
    // effectiveRatio = 5510/550 = 10.018...
    expect(result.current.results?.spot).toBeCloseTo(5510, 0);
  });

  it('populates allDeltas array', () => {
    const { result } = renderCalc();
    expect(result.current.results?.allDeltas.length).toBeGreaterThan(0);
  });

  it('handles early close hours', () => {
    // Re-render with earlyCloseHourET = 13 (1 PM)
    const { result } = renderHook(() =>
      useCalculation(
        '550',
        '',
        '20',
        '',
        '1.15',
        'vix',
        '1',
        '00',
        'PM',
        'ET',
        10,
        0,
        13,
      ),
    );
    expect(result.current.errors['time']).toContain('close');
  });
});
