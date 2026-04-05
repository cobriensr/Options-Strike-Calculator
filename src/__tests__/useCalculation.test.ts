import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCalculation } from '../hooks/useCalculation';
import type { IVMode, AmPm, Timezone } from '../types';

// ============================================================
// HELPERS
// ============================================================

/** Default args that produce valid results (10:00 AM CT = 11:00 AM ET) */
function renderCalc(
  overrides: Partial<{
    dSpot: string;
    dSpx: string;
    dVix: string;
    dIV: string;
    dMult: string;
    ivMode: IVMode;
    timeHour: string;
    timeMinute: string;
    timeAmPm: AmPm;
    timezone: Timezone;
    spxRatio: number;
    skewPct: number;
    earlyCloseHourET?: number;
  }> = {},
) {
  const args = {
    dSpot: '572',
    dSpx: '',
    dVix: '19',
    dIV: '',
    dMult: '1.15',
    ivMode: 'vix' as IVMode,
    timeHour: '10',
    timeMinute: '00',
    timeAmPm: 'AM' as AmPm,
    timezone: 'CT' as Timezone,
    spxRatio: 10,
    skewPct: 5,
    ...overrides,
  };

  return renderHook(() =>
    useCalculation(
      args.dSpot,
      args.dSpx,
      args.dVix,
      args.dIV,
      args.dMult,
      args.ivMode,
      args.timeHour,
      args.timeMinute,
      args.timeAmPm,
      args.timezone,
      args.spxRatio,
      args.skewPct,
      args.earlyCloseHourET,
    ),
  );
}

// ============================================================
// TESTS
// ============================================================

describe('useCalculation', () => {
  // ── Null / Invalid Spot ──────────────────────────────────

  it('returns null results when spot price is empty', () => {
    const { result } = renderCalc({ dSpot: '' });
    expect(result.current.results).toBeNull();
    expect(Object.keys(result.current.errors)).toHaveLength(0);
  });

  it('returns null results when spot price is NaN', () => {
    const { result } = renderCalc({ dSpot: 'abc' });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['spot']).toBeDefined();
  });

  it('returns null results when spot price is negative', () => {
    const { result } = renderCalc({ dSpot: '-100' });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['spot']).toBeDefined();
  });

  it('returns null results when spot price is zero', () => {
    const { result } = renderCalc({ dSpot: '0' });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['spot']).toBeDefined();
  });

  // ── Time Validation ─────────────────────────────────────

  it('returns error for time before market open (9:29 AM ET)', () => {
    // 9:29 AM ET — 1 minute before open
    const { result } = renderCalc({
      timeHour: '9',
      timeMinute: '29',
      timeAmPm: 'AM',
      timezone: 'ET',
    });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['time']).toMatch(/before market open/i);
  });

  it('returns error for time at market close (4:00 PM ET)', () => {
    const { result } = renderCalc({
      timeHour: '4',
      timeMinute: '00',
      timeAmPm: 'PM',
      timezone: 'ET',
    });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['time']).toMatch(/after market close/i);
  });

  it('returns error for time after market close (4:01 PM ET)', () => {
    const { result } = renderCalc({
      timeHour: '4',
      timeMinute: '01',
      timeAmPm: 'PM',
      timezone: 'ET',
    });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['time']).toMatch(/after market close/i);
  });

  it('accepts time exactly at market open (9:30 AM ET)', () => {
    const { result } = renderCalc({
      timeHour: '9',
      timeMinute: '30',
      timeAmPm: 'AM',
      timezone: 'ET',
    });
    expect(result.current.errors['time']).toBeUndefined();
    expect(result.current.results).not.toBeNull();
  });

  it('accepts time just before market close (3:59 PM ET)', () => {
    const { result } = renderCalc({
      timeHour: '3',
      timeMinute: '59',
      timeAmPm: 'PM',
      timezone: 'ET',
    });
    expect(result.current.errors['time']).toBeUndefined();
    expect(result.current.results).not.toBeNull();
  });

  // ── Invalid VIX ─────────────────────────────────────────

  it('returns error for invalid VIX (NaN)', () => {
    const { result } = renderCalc({ dVix: 'abc' });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['vix']).toBeDefined();
  });

  it('returns null when VIX is empty (sigma resolves to null)', () => {
    const { result } = renderCalc({ dVix: '' });
    expect(result.current.results).toBeNull();
  });

  // ── Valid Typical Inputs ────────────────────────────────

  it('returns valid results for typical inputs (spot=572, spx=5720, vix=19, 10:00 AM CT)', () => {
    const { result } = renderCalc();
    const { results, errors } = result.current;

    expect(Object.keys(errors)).toHaveLength(0);
    expect(results).not.toBeNull();
    expect(results!.spot).toBeCloseTo(5720, 0);
    expect(results!.sigma).toBeGreaterThan(0);
    expect(results!.T).toBeGreaterThan(0);
    expect(results!.hoursRemaining).toBeGreaterThan(0);
    expect(results!.allDeltas.length).toBeGreaterThan(0);
  });

  // ── CT Timezone Conversion ──────────────────────────────

  it('handles CT timezone correctly (adds 1 hour to convert to ET)', () => {
    // 9:00 AM CT = 10:00 AM ET (valid)
    const { result: ctResult } = renderCalc({
      timeHour: '9',
      timeMinute: '00',
      timeAmPm: 'AM',
      timezone: 'CT',
    });
    expect(ctResult.current.errors['time']).toBeUndefined();
    expect(ctResult.current.results).not.toBeNull();

    // 8:29 AM CT = 9:29 AM ET (before open)
    const { result: earlyResult } = renderCalc({
      timeHour: '8',
      timeMinute: '29',
      timeAmPm: 'AM',
      timezone: 'CT',
    });
    expect(earlyResult.current.errors['time']).toMatch(/before market open/i);
  });

  it('produces identical results for equivalent CT and ET times', () => {
    // 10:00 AM CT = 11:00 AM ET
    const { result: ctResult } = renderCalc({
      timeHour: '10',
      timeMinute: '00',
      timeAmPm: 'AM',
      timezone: 'CT',
    });
    const { result: etResult } = renderCalc({
      timeHour: '11',
      timeMinute: '00',
      timeAmPm: 'AM',
      timezone: 'ET',
    });

    expect(ctResult.current.results).not.toBeNull();
    expect(etResult.current.results).not.toBeNull();
    expect(ctResult.current.results!.hoursRemaining).toBeCloseTo(
      etResult.current.results!.hoursRemaining,
      6,
    );
    expect(ctResult.current.results!.T).toBeCloseTo(
      etResult.current.results!.T,
      6,
    );
  });

  // ── Direct IV Mode ──────────────────────────────────────

  it('returns results with correct sigma when IV mode is direct', () => {
    const { result } = renderCalc({
      ivMode: 'direct',
      dIV: '0.22',
      dVix: '',
      dMult: '',
    });
    const { results, errors } = result.current;

    expect(Object.keys(errors)).toHaveLength(0);
    expect(results).not.toBeNull();
    expect(results!.sigma).toBeCloseTo(0.22, 6);
  });

  it('returns null when sigma resolves to null (empty IV input in direct mode)', () => {
    const { result } = renderCalc({
      ivMode: 'direct',
      dIV: '',
      dVix: '',
      dMult: '',
    });
    expect(result.current.results).toBeNull();
  });

  it('returns error for invalid direct IV (NaN)', () => {
    const { result } = renderCalc({
      ivMode: 'direct',
      dIV: 'xyz',
      dVix: '',
      dMult: '',
    });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['iv']).toBeDefined();
  });

  // ── Early Close Day ─────────────────────────────────────

  it('returns error for time after early close', () => {
    // Early close at 1:00 PM ET — 1:00 PM ET should be after close
    const { result } = renderCalc({
      timeHour: '1',
      timeMinute: '00',
      timeAmPm: 'PM',
      timezone: 'ET',
      earlyCloseHourET: 13,
    });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['time']).toMatch(/after market close/i);
  });

  it('accepts time before early close', () => {
    // Early close at 1:00 PM ET — 12:59 PM ET should be valid
    const { result } = renderCalc({
      timeHour: '12',
      timeMinute: '59',
      timeAmPm: 'PM',
      timezone: 'ET',
      earlyCloseHourET: 13,
    });
    expect(result.current.errors['time']).toBeUndefined();
    expect(result.current.results).not.toBeNull();
  });

  // ── Result Structure ────────────────────────────────────

  it('results contain allDeltas array with expected delta values', () => {
    const { result } = renderCalc();
    const deltas = result.current.results!.allDeltas;

    expect(deltas.length).toBe(6); // 5, 8, 10, 12, 15, 20

    // Verify each delta target is represented
    const deltaValues = deltas.map((d) => d.delta);
    expect(deltaValues).toEqual([5, 8, 10, 12, 15, 20]);
  });

  it('hoursRemaining is positive for valid inputs', () => {
    const { result } = renderCalc();
    expect(result.current.results!.hoursRemaining).toBeGreaterThan(0);
  });

  it('T (time to expiry) is positive and less than 1 for 0DTE', () => {
    const { result } = renderCalc();
    const T = result.current.results!.T;
    expect(T).toBeGreaterThan(0);
    expect(T).toBeLessThan(1);
  });

  it('hoursRemaining is at most 6.5 (full trading day)', () => {
    // 9:30 AM ET — should be exactly 6.5 hours remaining
    const { result } = renderCalc({
      timeHour: '9',
      timeMinute: '30',
      timeAmPm: 'AM',
      timezone: 'ET',
    });
    expect(result.current.results!.hoursRemaining).toBeCloseTo(6.5, 6);
  });

  // ── VIX Passthrough ─────────────────────────────────────

  it('passes vix value through to results when available', () => {
    const { result } = renderCalc({ dVix: '19' });
    expect(result.current.results!.vix).toBe(19);
  });

  it('vix is undefined in results when VIX input is empty', () => {
    const { result } = renderCalc({
      ivMode: 'direct',
      dIV: '0.20',
      dVix: '',
    });
    expect(result.current.results!.vix).toBeUndefined();
  });

  // ── SPX Direct Override ─────────────────────────────────

  it('uses direct SPX/SPY ratio when both SPX and SPY are provided', () => {
    // SPY=572, SPX=5720 → ratio = 10 → spot = 572 * 10 = 5720
    const { result: defaultResult } = renderCalc({
      dSpot: '572',
      dSpx: '5720',
    });
    expect(defaultResult.current.results!.spot).toBeCloseTo(5720, 0);

    // SPY=572, SPX=5730 → ratio = 5730/572 ≈ 10.0175 → spot = 572 * 10.0175 ≈ 5730
    const { result: overrideResult } = renderCalc({
      dSpot: '572',
      dSpx: '5730',
    });
    expect(overrideResult.current.results!.spot).toBeCloseTo(5730, 0);
  });

  // ── Sigma from VIX Mode ─────────────────────────────────

  it('sigma = vix * multiplier / 100 in VIX mode', () => {
    const { result } = renderCalc({
      dVix: '20',
      dMult: '1.15',
      ivMode: 'vix',
    });
    // sigma = 20 * 1.15 / 100 = 0.23
    expect(result.current.results!.sigma).toBeCloseTo(0.23, 6);
  });

  // ── Invalid Multiplier ──────────────────────────────────

  it('returns error for invalid multiplier (NaN)', () => {
    const { result } = renderCalc({ dMult: 'abc' });
    expect(result.current.results).toBeNull();
    expect(result.current.errors['multiplier']).toBeDefined();
  });

  // ── Edge Cases ──────────────────────────────────────────

  it('returns error for NaN time hour', () => {
    const { result } = renderCalc({ timeHour: 'x' });
    expect(result.current.errors['time']).toBeDefined();
    expect(result.current.results).toBeNull();
  });

  it('returns error for NaN time minute', () => {
    const { result } = renderCalc({ timeMinute: 'x' });
    expect(result.current.errors['time']).toBeDefined();
    expect(result.current.results).toBeNull();
  });
});
