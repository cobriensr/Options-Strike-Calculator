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
      floorTrend: null,
      ceilingTrend: null,
      floorTrend5m: null,
      ceilingTrend5m: null,
      ...overrides,
    };
  }

  it('emits verdict, regime, and gravity on the first two lines', () => {
    const out = formatBiasForClaude(baseBias()).split('\n');
    expect(out[0]).toMatch(/^Verdict: /);
    expect(out[1]).toMatch(/Regime: Positive GEX/);
    expect(out[1]).toMatch(/Gravity: 6,900/);
    expect(out[1]).toMatch(/25 pts above spot/);
  });

  it('reports negative regime with the correct sign description', () => {
    const out = formatBiasForClaude(
      baseBias({ regime: 'negative', totalNetGex: -1.4e9, gravityOffset: -30 }),
    );
    expect(out).toMatch(/Negative GEX/);
    expect(out).toMatch(/30 pts below spot/);
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
    expect(out).toMatch(
      /Upside targets: 6,975 \(Sticky Pin, vol reinforcing\)/,
    );
    expect(out).toMatch(
      /Downside targets: 6,850 \(Fading Launchpad, vol opposing\)/,
    );
  });

  it('omits target lines when arrays are empty', () => {
    const out = formatBiasForClaude(baseBias());
    expect(out).not.toMatch(/Upside targets:/);
    expect(out).not.toMatch(/Downside targets:/);
  });

  it('appends 1m and 5m trend lines when trend values are present', () => {
    const bias = baseBias({
      ceilingTrend: 8.4,
      floorTrend: -3.1,
      ceilingTrend5m: 12.3,
      floorTrend5m: 5.7,
    });
    const out = formatBiasForClaude(bias);
    expect(out).toMatch(/1m GEX trend: ceiling \+8\.4% \| floor \u22123\.1%/);
    expect(out).toMatch(/5m GEX trend: ceiling \+12% \| floor \+5\.7%/);
  });

  it('skips trend lines entirely when both ceiling and floor are null', () => {
    const out = formatBiasForClaude(baseBias());
    expect(out).not.toMatch(/1m GEX trend:/);
    expect(out).not.toMatch(/5m GEX trend:/);
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
    expect(out).toMatch(/7,000 \(Max Launchpad\)/);
    expect(out).not.toMatch(/vol reinforcing|vol opposing/);
  });

  // Suppress the locale-string console output from unused imports
  vi.fn();
});
