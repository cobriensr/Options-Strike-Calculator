/**
 * Unit tests for GexLandscape formatters. Pure functions — no React, no DOM.
 * The shared GexLandscape.test.tsx renders the index but never exercises
 * the formatBiasForClaude serializer or the small-value formatGex / fmtPct
 * branches, so this file pins those directly.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fmtGex,
  fmtPct,
  fmtTime,
  formatBiasForClaude,
} from '../../components/GexLandscape/formatters';
import type { BiasMetrics } from '../../components/GexLandscape/types';
import { dealerClaims } from '../helpers/dealer-claims';

describe('fmtGex', () => {
  it('formats values in the billions with one decimal and B suffix', () => {
    expect(fmtGex(2_500_000_000)).toBe('+2.5B');
    expect(fmtGex(-1_200_000_000)).toBe('\u22121.2B');
  });

  it('formats values in the millions with one decimal and M suffix', () => {
    expect(fmtGex(7_400_000)).toBe('+7.4M');
    expect(fmtGex(-3_100_000)).toBe('\u22123.1M');
  });

  it('formats values in the thousands with no decimals and K suffix', () => {
    expect(fmtGex(15_678)).toBe('+16K');
  });

  it('formats sub-thousand values without a unit suffix', () => {
    expect(fmtGex(950)).toBe('+950');
    expect(fmtGex(-12)).toBe('\u221212');
    expect(fmtGex(0)).toBe('+0');
  });

  it('uses the unicode minus sign for negative values', () => {
    expect(fmtGex(-1)).toContain('\u2212');
  });
});

describe('fmtPct', () => {
  it('returns an em-dash for null or undefined', () => {
    expect(fmtPct(null)).toBe('\u2014');
    expect(fmtPct(undefined)).toBe('\u2014');
  });

  it('uses one decimal for absolute values below 10', () => {
    expect(fmtPct(7.5)).toBe('+7.5%');
    expect(fmtPct(-2.1)).toBe('\u22122.1%');
  });

  it('drops decimals for absolute values 10 or higher', () => {
    expect(fmtPct(15.9)).toBe('+16%');
    expect(fmtPct(-42.3)).toBe('\u221242%');
  });

  it('treats zero as positive', () => {
    expect(fmtPct(0)).toBe('+0.0%');
  });
});

describe('fmtTime', () => {
  it('renders an ISO timestamp as Chicago-time HH:MM', () => {
    // 2026-04-14T20:30:00Z → 15:30 CT in DST
    const out = fmtTime('2026-04-14T20:30:00Z');
    expect(out).toMatch(/^03:30\s?PM$/i);
  });

  it('zero-pads single-digit hours', () => {
    // 2026-04-14T13:05:00Z → 08:05 AM CT
    const out = fmtTime('2026-04-14T13:05:00Z');
    expect(out).toMatch(/^08:05\s?AM$/i);
  });
});

describe('formatBiasForClaude', () => {
  function baseBias(overrides: Partial<BiasMetrics> = {}): BiasMetrics {
    return {
      verdict: 'gex-pull-up',
      regime: 'positive',
      totalNetGex: 2_500_000_000,
      gravityStrike: 6900,
      gravityOffset: 25,
      gravityGex: 1_800_000_000,
      upsideTargets: [],
      downsideTargets: [],
      floorTrend5m: null,
      ceilingTrend5m: null,
      floorTrend15m: null,
      ceilingTrend15m: null,
      floorTrend30m: null,
      ceilingTrend30m: null,
      priceTrend: null,
      ...overrides,
    };
  }

  it('emits the verdict, net taker gamma and largest-|γ| strike on the first two lines', () => {
    const out = formatBiasForClaude(baseBias()).split('\n');
    expect(out[0]).toBe(
      'Verdict: ▲ TOP ABOVE · LONG γ — Largest |γ| strike is more than 25 pts above spot; net taker gamma is positive (traders net long gamma)',
    );
    expect(out[1]).toBe(
      'Net taker gamma: +2.5B within ±50 pts (traders net long gamma) | Largest |γ| strike: 6,900 (25 pts above spot, +1.8B, taker-long)',
    );
  });

  it('reports negative net taker gamma as traders net short gamma', () => {
    const out = formatBiasForClaude(
      baseBias({
        verdict: 'breakdown-risk-down',
        regime: 'negative',
        totalNetGex: -1.4e9,
        gravityOffset: -30,
        gravityGex: -9e8,
      }),
    );
    expect(out).toMatch(
      /Net taker gamma: −1\.4B within ±50 pts \(traders net short gamma\)/,
    );
    expect(out).toMatch(/30 pts below spot, −900\.0M, taker-short\)/);
  });

  // Owner decision D1 revised (2026-10-29): this is GEXBot taker flow, so
  // the text Claude gets must not assert market-maker behaviour.

  it.each([
    'gex-pull-up',
    'gex-pull-down',
    'breakout-risk-up',
    'breakdown-risk-down',
    'rangebound',
    'volatile',
    'gex-floor-below',
    'drifting-down',
    'drifting-up',
  ] as const)('%s text makes no dealer or market-maker claim', (verdict) => {
    const out = formatBiasForClaude(
      baseBias({
        verdict,
        upsideTargets: [
          {
            strike: 6975,
            cls: 'sticky-pin',
            netGamma: 4e8,
            volReinforcement: 'reinforcing',
          },
        ],
        downsideTargets: [
          {
            strike: 6850,
            cls: 'max-launchpad',
            netGamma: -2.5e8,
            volReinforcement: 'opposing',
          },
        ],
        ceilingTrend5m: 2.5,
        floorTrend5m: -1.2,
      }),
    );
    expect(dealerClaims(out)).toEqual([]);
  });

  it('serializes upside and downside targets with classification labels', () => {
    const bias = baseBias({
      upsideTargets: [
        {
          strike: 6975,
          cls: 'sticky-pin',
          netGamma: 400_000_000,
          volReinforcement: 'reinforcing',
        },
      ],
      downsideTargets: [
        {
          strike: 6850,
          cls: 'fading-launchpad',
          netGamma: -250_000_000,
          volReinforcement: 'opposing',
        },
      ],
    });
    const out = formatBiasForClaude(bias);
    expect(out).toContain(
      'Largest |γ| >25 pts above spot: 6,975 (Takers +γ +charm, vol reinforcing)',
    );
    expect(out).toContain(
      'Largest |γ| >25 pts below spot: 6,850 (Takers −γ −charm, vol opposing)',
    );
  });

  it('omits target lines when arrays are empty', () => {
    const out = formatBiasForClaude(baseBias());
    expect(out).not.toMatch(/Largest \|γ\| >25 pts above spot:/);
    expect(out).not.toMatch(/Largest \|γ\| >25 pts below spot:/);
  });

  it('appends 5m, 15m, and 30m trend lines when trend values are present', () => {
    const bias = baseBias({
      ceilingTrend5m: 2.5,
      floorTrend5m: -1.2,
      ceilingTrend15m: 5.4,
      floorTrend15m: -2.6,
      ceilingTrend30m: 8.4,
      floorTrend30m: -3.1,
    });
    const out = formatBiasForClaude(bias);
    expect(out).toContain(
      '5m γ change: above spot +2.5% | below spot \u22121.2%',
    );
    expect(out).toContain(
      '15m γ change: above spot +5.4% | below spot \u22122.6%',
    );
    expect(out).toContain(
      '30m γ change: above spot +8.4% | below spot \u22123.1%',
    );
  });

  it('skips trend lines entirely when all ceiling and floor are null', () => {
    const out = formatBiasForClaude(baseBias());
    expect(out).not.toMatch(/5m γ change:/);
    expect(out).not.toMatch(/15m γ change:/);
    expect(out).not.toMatch(/30m γ change:/);
  });

  it('excludes the volTag when reinforcement is neutral', () => {
    const bias = baseBias({
      upsideTargets: [
        {
          strike: 7000,
          cls: 'max-launchpad',
          netGamma: 300_000_000,
          volReinforcement: 'neutral',
        },
      ],
    });
    const out = formatBiasForClaude(bias);
    expect(out).toContain('7,000 (Takers −γ +charm)');
    expect(out).not.toMatch(/vol reinforcing|vol opposing/);
  });

  it('includes price trend line when priceTrend is non-flat', () => {
    const bias = baseBias({
      verdict: 'drifting-down',
      priceTrend: {
        direction: 'down',
        changePct: -0.14,
        changePts: -9.8,
        consistency: 0.8,
      },
    });
    const out = formatBiasForClaude(bias);
    expect(out).toMatch(/Price trend: DRIFTING DOWN/);
    expect(out).toMatch(/-9\.8 pts/);
  });

  it('omits price trend line when priceTrend is null', () => {
    const out = formatBiasForClaude(baseBias());
    expect(out).not.toMatch(/Price trend:/);
  });

  it('omits price trend line when direction is flat', () => {
    const bias = baseBias({
      priceTrend: {
        direction: 'flat',
        changePct: 0,
        changePts: 0,
        consistency: 0,
      },
    });
    const out = formatBiasForClaude(bias);
    expect(out).not.toMatch(/Price trend:/);
  });

  // Suppress the locale-string console output from unused imports
  vi.fn();
});
