/**
 * Unit tests for the WS-row → GexStrikeLevel projection that powers
 * `useGexLandscapeData`. The projection is the load-bearing piece of
 * the adapter — testing the pure function is much cleaner than driving
 * the full hook with a mocked `useGexStrikeExpiry`.
 */

import { describe, it, expect } from 'vitest';
import { projectExpiryRowToStrike } from '../../hooks/useGexLandscapeData';
import type { GexStrikeExpiryRow } from '../../hooks/useGexStrikeExpiry';

function makeRow(
  overrides: Partial<GexStrikeExpiryRow> = {},
): GexStrikeExpiryRow {
  return {
    ticker: 'SPY',
    expiry: '2026-05-04',
    strike: 720,
    ts_minute: '2026-05-04T19:30:00.000Z',
    price: 722.5,
    call_gamma_oi: 0,
    put_gamma_oi: 0,
    call_charm_oi: 0,
    put_charm_oi: 0,
    call_vanna_oi: 0,
    put_vanna_oi: 0,
    call_gamma_vol: 0,
    put_gamma_vol: 0,
    call_charm_vol: 0,
    put_charm_vol: 0,
    call_vanna_vol: 0,
    put_vanna_vol: 0,
    call_gamma_ask_vol: 0,
    call_gamma_bid_vol: 0,
    put_gamma_ask_vol: 0,
    put_gamma_bid_vol: 0,
    call_charm_ask_vol: 0,
    call_charm_bid_vol: 0,
    put_charm_ask_vol: 0,
    put_charm_bid_vol: 0,
    call_vanna_ask_vol: 0,
    call_vanna_bid_vol: 0,
    put_vanna_ask_vol: 0,
    put_vanna_bid_vol: 0,
    ...overrides,
  };
}

describe('projectExpiryRowToStrike', () => {
  it('renames bid/ask vol fields to GexStrikeLevel naming', () => {
    const row = makeRow({
      call_gamma_ask_vol: 1234,
      call_gamma_bid_vol: -567,
      put_gamma_ask_vol: 89,
      put_gamma_bid_vol: -42,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.callGammaAsk).toBe(1234);
    expect(out.callGammaBid).toBe(-567);
    expect(out.putGammaAsk).toBe(89);
    expect(out.putGammaBid).toBe(-42);
  });

  it('passes strike + price through unchanged', () => {
    const row = makeRow({ strike: 5310, price: 5318.42 });
    const out = projectExpiryRowToStrike(row);
    expect(out.strike).toBe(5310);
    expect(out.price).toBe(5318.42);
  });

  it('derives netGamma / netCharm / netVanna from call+put OI sums', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: -50,
      call_charm_oi: 200,
      put_charm_oi: 75,
      call_vanna_oi: -30,
      put_vanna_oi: 15,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBe(50);
    expect(out.netCharm).toBe(275);
    expect(out.netVanna).toBe(-15);
  });

  it('derives netGammaVol / netCharmVol / netVannaVol from call+put vol sums', () => {
    const row = makeRow({
      call_gamma_vol: 10,
      put_gamma_vol: -3,
      call_charm_vol: 5,
      put_charm_vol: 8,
      call_vanna_vol: -2,
      put_vanna_vol: 1,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGammaVol).toBe(7);
    expect(out.netCharmVol).toBe(13);
    expect(out.netVannaVol).toBe(-1);
  });

  it('marks volReinforcement reinforcing when netGammaOi and netGammaVol agree (positive)', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: 20,
      put_gamma_vol: 5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeGreaterThan(0);
    expect(out.netGammaVol).toBeGreaterThan(0);
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement reinforcing when both nets are negative', () => {
    const row = makeRow({
      call_gamma_oi: -100,
      put_gamma_oi: -50,
      call_gamma_vol: -20,
      put_gamma_vol: -5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeLessThan(0);
    expect(out.netGammaVol).toBeLessThan(0);
    expect(out.volReinforcement).toBe('reinforcing');
  });

  it('marks volReinforcement opposing when nets disagree in sign', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: -20,
      put_gamma_vol: -5,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBeGreaterThan(0);
    expect(out.netGammaVol).toBeLessThan(0);
    expect(out.volReinforcement).toBe('opposing');
  });

  it('marks volReinforcement neutral when net OI is exactly zero', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: -100,
      call_gamma_vol: 50,
      put_gamma_vol: 25,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGamma).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('marks volReinforcement neutral when net vol is exactly zero', () => {
    const row = makeRow({
      call_gamma_oi: 100,
      put_gamma_oi: 50,
      call_gamma_vol: 25,
      put_gamma_vol: -25,
    });
    const out = projectExpiryRowToStrike(row);
    expect(out.netGammaVol).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('coalesces null inputs to 0 across every numeric field', () => {
    const row: GexStrikeExpiryRow = {
      ticker: 'SPY',
      expiry: '2026-05-04',
      strike: 720,
      ts_minute: '2026-05-04T19:30:00.000Z',
      price: null,
      call_gamma_oi: null,
      put_gamma_oi: null,
      call_charm_oi: null,
      put_charm_oi: null,
      call_vanna_oi: null,
      put_vanna_oi: null,
      call_gamma_vol: null,
      put_gamma_vol: null,
      call_charm_vol: null,
      put_charm_vol: null,
      call_vanna_vol: null,
      put_vanna_vol: null,
      call_gamma_ask_vol: null,
      call_gamma_bid_vol: null,
      put_gamma_ask_vol: null,
      put_gamma_bid_vol: null,
      call_charm_ask_vol: null,
      call_charm_bid_vol: null,
      put_charm_ask_vol: null,
      put_charm_bid_vol: null,
      call_vanna_ask_vol: null,
      call_vanna_bid_vol: null,
      put_vanna_ask_vol: null,
      put_vanna_bid_vol: null,
    };
    const out = projectExpiryRowToStrike(row);
    expect(out.price).toBe(0);
    expect(out.callGammaOi).toBe(0);
    expect(out.putGammaOi).toBe(0);
    expect(out.netGamma).toBe(0);
    expect(out.callGammaVol).toBe(0);
    expect(out.putGammaVol).toBe(0);
    expect(out.netGammaVol).toBe(0);
    expect(out.callGammaAsk).toBe(0);
    expect(out.callGammaBid).toBe(0);
    expect(out.putGammaAsk).toBe(0);
    expect(out.putGammaBid).toBe(0);
    expect(out.callCharmOi).toBe(0);
    expect(out.putCharmOi).toBe(0);
    expect(out.netCharm).toBe(0);
    expect(out.callCharmVol).toBe(0);
    expect(out.putCharmVol).toBe(0);
    expect(out.netCharmVol).toBe(0);
    expect(out.callVannaOi).toBe(0);
    expect(out.putVannaOi).toBe(0);
    expect(out.netVanna).toBe(0);
    expect(out.callVannaVol).toBe(0);
    expect(out.putVannaVol).toBe(0);
    expect(out.netVannaVol).toBe(0);
    expect(out.volReinforcement).toBe('neutral');
  });

  it('defaults delta fields to 0 (no NaN) since the WS channel does not publish them', () => {
    const row = makeRow({ call_gamma_oi: 100, put_gamma_oi: 50 });
    const out = projectExpiryRowToStrike(row);
    expect(out.callDeltaOi).toBe(0);
    expect(out.putDeltaOi).toBe(0);
    expect(out.netDelta).toBe(0);
    expect(Number.isNaN(out.callDeltaOi)).toBe(false);
    expect(Number.isNaN(out.putDeltaOi)).toBe(false);
    expect(Number.isNaN(out.netDelta)).toBe(false);
  });
});
