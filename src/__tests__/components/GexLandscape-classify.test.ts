/**
 * Unit tests for GexLandscape `getDirection`.
 *
 * `getDirection` maps (strike, price) to ceiling / floor / atm using
 *   `SPX_SPOT_BAND`. Phase 3 of the MM swap narrowed this panel to
 *   SPX-only, so the multi-ticker `BAND_BY_TICKER` lookup is gone.
 *
 * Phase 3 of the 1-min GexBot rebuild dropped `computeGammaPressure`
 * along with the `PRESSURE_NEUTRAL_BAND_RATIO` constant; only
 * directional placement is asserted here.
 */

import { describe, expect, it } from 'vitest';
import { getDirection } from '../../components/GexLandscape/classify';
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
