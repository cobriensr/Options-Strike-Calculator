// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { MARKET_MECHANICS_CONTEXT } from '../_lib/market-mechanics.js';

const PROMPT = MARKET_MECHANICS_CONTEXT;

/** Text between `<tag>` and `</tag>`, or null when the tag is absent. */
function section(tag: string): string | null {
  const open = PROMPT.indexOf(`<${tag}>`);
  const close = PROMPT.indexOf(`</${tag}>`);
  if (open === -1 || close === -1) return null;
  return PROMPT.slice(open, close);
}

describe('market mechanics framework — structure', () => {
  it('closes every opening section tag', () => {
    // Digits included so tags like <charm_and_0dte_regime> are checked too.
    const tags = [...PROMPT.matchAll(/<([a-z0-9_]+)>/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(PROMPT, `missing </${tag}>`).toContain(`</${tag}>`);
    }
  });

  it('contains no template-literal interpolation marker', () => {
    expect(PROMPT).not.toMatch(/\$\{/);
  });
});

describe('market mechanics framework — corrected gamma/charm claims', () => {
  // Amaya et al. (2025) measured the volatility effect of MM hedging
  // directly: it is modest, and charm is small next to the gamma hedge
  // per minute. These overstatements must not creep back in.

  it('drops the claims the paper contradicts', () => {
    expect(PROMPT).not.toContain('Why GEX Predicts Volatility Better Than VIX');
    expect(PROMPT).not.toMatch(/Charm is now first-order/);
    expect(PROMPT).not.toMatch(/customer-net-sold/);
    expect(PROMPT).not.toMatch(/dealers are mostly long 0DTE gamma/);
    expect(PROMPT).not.toMatch(/4-point difference/);
  });

  it('frames GEX as a regime label and a tilt on the implied range', () => {
    const gexVsVix = section('gex_vs_vix');
    expect(gexVsVix).toContain('regime label');
    expect(gexVsVix).toContain('tilt on that range');
  });

  it('frames charm as a late-session drift and long gamma as a default', () => {
    const charm = section('charm_and_0dte_regime');
    expect(charm).toContain('default, not a guarantee');
    expect(charm).toContain('late-session drift');
  });
});
