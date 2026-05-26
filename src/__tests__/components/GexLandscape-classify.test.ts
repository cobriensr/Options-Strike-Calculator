/**
 * Unit tests for GexLandscape classify helpers.
 *
 * `getDirection` maps (strike, price) to ceiling / floor / atm using
 *   `SPX_SPOT_BAND`. Phase 3 of the MM swap narrowed this panel to
 *   SPX-only, so the multi-ticker `BAND_BY_TICKER` lookup is gone.
 *
 * `computeVolReinforcement` (Phase 4 of the 1-min GexBot rebuild)
 *   implements Locked Decision #1: delta-trend agreement. All three
 *   deltas + netGamma must agree on sign to read as `reinforcing`;
 *   all three must oppose to read as `opposing`. Mixed, null, or
 *   zero → `neutral`.
 */

import { describe, expect, it } from 'vitest';
import {
  computeVolReinforcement,
  getDirection,
} from '../../components/GexLandscape/classify';
import { SPX_SPOT_BAND } from '../../components/GexLandscape/constants';

describe('getDirection — SPX-only spot band', () => {
  it('exposes the documented SPX spot band', () => {
    expect(SPX_SPOT_BAND).toBe(25);
  });

  it('strike 10pt above spot is atm (inside 25pt band)', () => {
    expect(getDirection(7040, 7030)).toBe('atm');
  });
  it('strike 26pt above spot is a ceiling (just outside band)', () => {
    expect(getDirection(7056, 7030)).toBe('ceiling');
  });
  it('strike 26pt below spot is a floor', () => {
    expect(getDirection(7004, 7030)).toBe('floor');
  });
  it('strike at the band edge (+25) is still atm (strict >)', () => {
    expect(getDirection(7055, 7030)).toBe('atm');
  });
  it('strike right at spot is atm', () => {
    expect(getDirection(7030, 7030)).toBe('atm');
  });
});

describe('computeVolReinforcement — delta-trend agreement', () => {
  it('returns neutral when netGamma is exactly 0', () => {
    expect(
      computeVolReinforcement({
        netGamma: 0,
        delta1m: 5,
        delta5m: 5,
        delta10m: 5,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when any delta is null (sparse data)', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: null,
        delta5m: 5,
        delta10m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: null,
        delta10m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: 5,
        delta10m: null,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when any delta is exactly 0 (no sign)', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 0,
        delta5m: 5,
        delta10m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: 0,
        delta10m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: 5,
        delta10m: 0,
      }),
    ).toBe('neutral');
  });

  it('returns reinforcing when netGamma > 0 and all three deltas are positive', () => {
    expect(
      computeVolReinforcement({
        netGamma: 2.5e9,
        delta1m: 3.2,
        delta5m: 7.8,
        delta10m: 12.1,
      }),
    ).toBe('reinforcing');
  });

  it('returns reinforcing when netGamma < 0 and all three deltas are negative', () => {
    // Wall is getting more negative — being added to.
    expect(
      computeVolReinforcement({
        netGamma: -2.5e9,
        delta1m: -3.2,
        delta5m: -7.8,
        delta10m: -12.1,
      }),
    ).toBe('reinforcing');
  });

  it('returns opposing when netGamma > 0 and all three deltas are negative', () => {
    // Positive wall unwinding.
    expect(
      computeVolReinforcement({
        netGamma: 2.5e9,
        delta1m: -3.2,
        delta5m: -7.8,
        delta10m: -12.1,
      }),
    ).toBe('opposing');
  });

  it('returns opposing when netGamma < 0 and all three deltas are positive', () => {
    // Negative wall unwinding (less negative).
    expect(
      computeVolReinforcement({
        netGamma: -2.5e9,
        delta1m: 3.2,
        delta5m: 7.8,
        delta10m: 12.1,
      }),
    ).toBe('opposing');
  });

  it('returns neutral when signs are mixed across the three deltas', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: -3,
        delta10m: 7,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: -5,
        delta5m: -3,
        delta10m: 7,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when 2 of 3 deltas match but the third does not', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta1m: 5,
        delta5m: 7,
        delta10m: -2,
      }),
    ).toBe('neutral');
  });
});
