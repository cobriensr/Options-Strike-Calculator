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
  signalTooltip,
} from '../../components/GexLandscape/classify';
import {
  CLASS_META,
  CLS_TOOLTIP,
  GAMMA_SIGN_CLASSES,
  GAMMA_SIGN_HEX,
  SPX_SPOT_BAND,
  VERDICT_META,
  VERDICT_TOOLTIP,
  gammaSignHex,
  trendColor,
} from '../../components/GexLandscape/constants';
import type { GexClassification } from '../../components/GexLandscape/types';
import { dealerClaims } from '../helpers/dealer-claims';

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
        delta5m: 5,
        delta15m: 5,
        delta30m: 5,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when any delta is null (sparse data)', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: null,
        delta15m: 5,
        delta30m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: null,
        delta30m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: 5,
        delta30m: null,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when any delta is exactly 0 (no sign)', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 0,
        delta15m: 5,
        delta30m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: 0,
        delta30m: 5,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: 5,
        delta30m: 0,
      }),
    ).toBe('neutral');
  });

  it('returns reinforcing when netGamma > 0 and all three deltas are positive', () => {
    expect(
      computeVolReinforcement({
        netGamma: 2.5e9,
        delta5m: 3.2,
        delta15m: 7.8,
        delta30m: 12.1,
      }),
    ).toBe('reinforcing');
  });

  it('returns reinforcing when netGamma < 0 and all three deltas are negative', () => {
    // Wall is getting more negative — being added to.
    expect(
      computeVolReinforcement({
        netGamma: -2.5e9,
        delta5m: -3.2,
        delta15m: -7.8,
        delta30m: -12.1,
      }),
    ).toBe('reinforcing');
  });

  it('returns opposing when netGamma > 0 and all three deltas are negative', () => {
    // Positive wall unwinding.
    expect(
      computeVolReinforcement({
        netGamma: 2.5e9,
        delta5m: -3.2,
        delta15m: -7.8,
        delta30m: -12.1,
      }),
    ).toBe('opposing');
  });

  it('returns opposing when netGamma < 0 and all three deltas are positive', () => {
    // Negative wall unwinding (less negative).
    expect(
      computeVolReinforcement({
        netGamma: -2.5e9,
        delta5m: 3.2,
        delta15m: 7.8,
        delta30m: 12.1,
      }),
    ).toBe('opposing');
  });

  it('returns neutral when signs are mixed across the three deltas', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: -3,
        delta30m: 7,
      }),
    ).toBe('neutral');
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: -5,
        delta15m: -3,
        delta30m: 7,
      }),
    ).toBe('neutral');
  });

  it('returns neutral when 2 of 3 deltas match but the third does not', () => {
    expect(
      computeVolReinforcement({
        netGamma: 1e9,
        delta5m: 5,
        delta15m: 7,
        delta30m: -2,
      }),
    ).toBe('neutral');
  });
});

// Owner decision D1 revised (2026-10-29): GEX Landscape is GEXBot taker
// flow, so its labels and tooltips describe the taker side and assert no
// market-maker or dealer behaviour.
const CLASSES: GexClassification[] = [
  'max-launchpad',
  'fading-launchpad',
  'sticky-pin',
  'weakening-pin',
];

describe('signalTooltip — taker-side description', () => {
  it('states the taker gamma and charm sides and the position', () => {
    expect(signalTooltip('max-launchpad', 'ceiling')).toBe(
      "In GEXBot's taker-side sign, traders (takers) are net short gamma and net long charm at this strike, which sits more than 25 pts above spot.",
    );
    expect(signalTooltip('weakening-pin', 'floor')).toBe(
      "In GEXBot's taker-side sign, traders (takers) are net long gamma and net short charm at this strike, which sits more than 25 pts below spot.",
    );
    expect(signalTooltip('sticky-pin', 'atm')).toBe(
      "In GEXBot's taker-side sign, traders (takers) are net long gamma and net long charm at this strike, which sits within 25 pts of spot.",
    );
  });

  it.each(CLASSES)('%s tooltips make no dealer claim', (cls) => {
    for (const dir of ['ceiling', 'floor', 'atm'] as const) {
      expect(dealerClaims(signalTooltip(cls, dir))).toEqual([]);
      expect(dealerClaims(CLASS_META[cls].signal(dir))).toEqual([]);
    }
    expect(dealerClaims(CLS_TOOLTIP[cls])).toEqual([]);
    expect(dealerClaims(CLASS_META[cls].badge)).toEqual([]);
  });
});

describe('verdict labels and prose — no dealer claims', () => {
  it.each(Object.keys(VERDICT_META) as Array<keyof typeof VERDICT_META>)(
    '%s',
    (verdict) => {
      const meta = VERDICT_META[verdict];
      expect(dealerClaims(meta.label)).toEqual([]);
      expect(dealerClaims(meta.desc)).toEqual([]);
      expect(dealerClaims(VERDICT_TOOLTIP[verdict])).toEqual([]);
      expect(meta.desc).toMatch(/net taker gamma is (positive|negative)/);
    },
  );

  it('keeps every emitted verdict distinguishable', () => {
    // gex-pull-down is always rewritten to gex-floor-below by computeBias,
    // so those two share the "below, long γ" wording.
    const emitted = Object.entries(VERDICT_META)
      .filter(([v]) => v !== 'gex-pull-down')
      .map(([, m]) => m.label);
    expect(new Set(emitted).size).toBe(emitted.length);
  });
});

describe('gamma-sign palette — two non-evaluative hues (owner decision D1 revised)', () => {
  // The UW-era colours read green = safe / amber, red = danger. On taker
  // flow only the sign is known, so colour carries the sign and nothing else,
  // the same way above and below spot.
  const VERDICT_SIGN: Record<
    Exclude<keyof typeof VERDICT_META, 'drifting-down' | 'drifting-up'>,
    'long' | 'short'
  > = {
    'gex-pull-up': 'long',
    'gex-pull-down': 'long',
    'gex-floor-below': 'long',
    rangebound: 'long',
    'breakout-risk-up': 'short',
    'breakdown-risk-down': 'short',
    volatile: 'short',
  };
  const EVALUATIVE = /green|emerald|red|amber|orange|yellow|lime|rose/;

  it.each(Object.entries(VERDICT_SIGN))(
    '%s is coloured by its gamma sign only',
    (verdict, sign) => {
      const m = VERDICT_META[verdict as keyof typeof VERDICT_META];
      expect({ color: m.color, bg: m.bg, border: m.border }).toEqual(
        GAMMA_SIGN_CLASSES[sign],
      );
    },
  );

  it('uses two distinct, non-evaluative hues', () => {
    expect(GAMMA_SIGN_CLASSES.long.color).not.toBe(
      GAMMA_SIGN_CLASSES.short.color,
    );
    expect(JSON.stringify(GAMMA_SIGN_CLASSES)).not.toMatch(EVALUATIVE);
    expect(GAMMA_SIGN_HEX.long).not.toBe(GAMMA_SIGN_HEX.short);
  });

  it.each(CLASSES)('%s class tints use its gamma-sign hue', (cls) => {
    const m = CLASS_META[cls];
    const hue =
      cls === 'max-launchpad' || cls === 'fading-launchpad' ? 'violet' : 'sky';
    expect(m.badgeText).toContain(hue);
    expect(m.badgeBg).toContain(hue);
    expect(`${m.badgeBg} ${m.badgeText} ${m.rowBg}`).not.toMatch(EVALUATIVE);
  });

  it('colours a value by sign alone: gammaSignHex and trendColor', () => {
    expect(gammaSignHex(5e8)).toBe(GAMMA_SIGN_HEX.long);
    expect(gammaSignHex(0)).toBe(GAMMA_SIGN_HEX.long);
    expect(gammaSignHex(-5e8)).toBe(GAMMA_SIGN_HEX.short);
    expect(trendColor(2.5)).toBe(GAMMA_SIGN_HEX.long);
    expect(trendColor(-2.5)).toBe(GAMMA_SIGN_HEX.short);
    expect(trendColor(null)).toBe('var(--color-muted)');
  });
});
