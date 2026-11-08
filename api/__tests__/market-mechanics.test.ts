// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { MARKET_MECHANICS_CONTEXT } from '../_lib/market-mechanics.js';
import { SPOTGAMMA_MECHANICS_CONTEXT } from '../_lib/spotgamma-mechanics.js';

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

describe('market mechanics framework — charm hedge direction', () => {
  // As time passes OTM delta decays toward 0, so a dealer short an OTM put
  // or long an OTM call BUYS futures; short calls / long puts SELL. The old
  // text had charm pulling price toward high-OI strikes from both sides,
  // which inverts the put-side direction and the long-call hedge action.

  it('drops the inverted charm-direction claims', () => {
    expect(PROMPT).not.toContain('upward pressure toward high-OI put strikes');
    expect(PROMPT).not.toContain(
      'downward pressure toward high-OI call strikes',
    );
    expect(PROMPT).not.toContain('gravitational pull toward large-OI strikes');
    expect(PROMPT).not.toContain(
      "the dealer's long call position contributes less positive delta, and the dealer SELLS",
    );
    expect(PROMPT).not.toContain(
      'The charm-driven convergence that had been building toward that strike',
    );
  });

  it('ties charm direction to dealer positioning, not OI location', () => {
    const charm = section('charm_and_0dte_regime');
    expect(charm).toContain('not a pull toward any strike');
    expect(charm).toContain(
      'depends on how dealers are positioned, not on where OI sits',
    );
    expect(charm).toContain(
      'flip the sign relative to OTM for the same position',
    );
    expect(charm).not.toContain('per-strike decoder');
  });

  it('makes the straddle-cone charm funnel conditional on dealer side', () => {
    const cone = section('straddle_cone_mechanics');
    expect(cone).not.toContain(
      'Dealers long OTM gamma (hedging their short ATM straddle)',
    );
    expect(cone).toContain('When dealers are long the wings');
    expect(cone).toContain('lean against a move toward either edge');
  });

  it('drops the magnetic-pull claim from the SpotGamma blue-zone bullet', () => {
    expect(SPOTGAMMA_MECHANICS_CONTEXT).not.toContain(
      'gradual magnetic pull downward',
    );
    expect(SPOTGAMMA_MECHANICS_CONTEXT).toContain('does not pull price down');
  });
});
