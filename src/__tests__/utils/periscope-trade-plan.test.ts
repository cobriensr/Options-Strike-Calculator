import { describe, it, expect } from 'vitest';
import {
  computeTradePlan,
  fmtSigned,
  type TradePlan,
} from '../../utils/periscope-trade-plan';
import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';

/**
 * Coverage-fill tests for `computeTradePlan`. The public entry is the only
 * exported function from `periscope-trade-plan.ts`; the internal helpers
 * `buildSummary` and `buildWaitZone` are exercised by constructing views
 * that route through to each branch.
 *
 * Source uses two key constants (private to the module):
 *   - NEAR_WALL_PTS = 15
 *   - CHARM_TALLY_NOISE_THRESHOLD = 1_000_000
 *
 * We pass values clearly above/below those thresholds rather than importing
 * them.
 */

const NEAR = 10; // < 15 ⇒ "near spot"
const FAR = 30; // > 15 ⇒ "not near spot"
const CHARM_HIGH = 2_000_000; // > 1M ⇒ above noise
const CHARM_LOW = 100_000; // < 1M ⇒ flat / noise

interface ViewOverrides {
  spot?: number;
  ceiling?: PeriscopeView['gamma']['ceiling'];
  floor?: PeriscopeView['gamma']['floor'];
  charmNear?: number;
  charmWide?: number;
  breaches?: PeriscopeView['breaches'];
  cone?: PeriscopeView['cone'];
}

function makeView(overrides: ViewOverrides = {}): PeriscopeView {
  const spot = overrides.spot ?? 6000;
  return {
    capturedAt: '2026-05-10T15:00:00Z',
    priorCapturedAt: null,
    expiry: '2026-05-10',
    spot,
    gamma: {
      ceiling: overrides.ceiling ?? null,
      floor: overrides.floor ?? null,
      accelTop: [],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: overrides.charmNear ?? 0,
      tallyWide100: overrides.charmWide ?? 0,
      topByAbs: [],
      charmZeroStrike: null,
    },
    vanna: { topByAbs: [] },
    signFlips: [],
    cone: overrides.cone ?? null,
    breaches: overrides.breaches ?? [],
  };
}

function ranked(strike: number, value: number, spot: number) {
  return { strike, value, ptsFromSpot: strike - spot };
}

/** Wrapper so a test can express its case shape inline. */
function plan(overrides: ViewOverrides): TradePlan {
  return computeTradePlan(makeView(overrides));
}

describe('computeTradePlan — bias classifier', () => {
  it("returns bias='long-only' when long is safe and short is not safe", () => {
    // ceiling far above (not capped), no floor (short is noTradeReason avoid)
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: null,
      charmNear: CHARM_HIGH, // charmDir = 'up' ⇒ long.verdict = 'safe'
      charmWide: CHARM_HIGH,
    });
    expect(result.long.verdict).toBe('safe');
    expect(result.short.verdict).toBe('avoid');
    expect(result.bias).toBe('long-only');
  });

  it("returns bias='short-only' when short is safe and long is not safe", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: null,
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: -CHARM_HIGH, // charmDir = 'down' ⇒ short.verdict = 'safe'
      charmWide: -CHARM_HIGH,
    });
    expect(result.short.verdict).toBe('safe');
    expect(result.long.verdict).toBe('avoid');
    expect(result.bias).toBe('short-only');
  });

  it("returns bias='fade-only' when neither side is safe and charm is flat", () => {
    // Both walls far (no avoid from wall proximity), charm flat ⇒ both plans
    // become 'conditional', so neither 'avoid' (bypasses no-trade branch) and
    // neither 'safe' (bypasses long-only / short-only) ⇒ fade-only.
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.long.verdict).toBe('conditional');
    expect(result.short.verdict).toBe('conditional');
    expect(result.bias).toBe('fade-only');
  });

  it("returns bias='two-sided' as the fallback when neither single-side branch applies and charm is not flat", () => {
    // ceiling NEAR (long ⇒ avoid), floor FAR (short ⇒ conditional, since
    // charmDir = 'up' not 'down'), charm not flat ⇒ falls through to the
    // final else ⇒ two-sided.
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + NEAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.long.verdict).toBe('avoid');
    expect(result.short.verdict).toBe('conditional');
    expect(result.bias).toBe('two-sided');
  });
});

describe('computeTradePlan — regime classifier', () => {
  it("returns regime='drift-and-cap' when a wall sits near spot", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + NEAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.regime).toBe('drift-and-cap');
  });

  it("returns regime='chop' when no wall is near spot and charm is flat", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.regime).toBe('chop');
  });

  it("returns regime='drift-and-cap' (else branch) when no wall near spot but charm has direction", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.regime).toBe('drift-and-cap');
  });
});

describe('computeTradePlan — buildSummary regime prefixes', () => {
  it("regime='pin' produces a summary starting with 'Pin setup'", () => {
    // Both walls within NEAR_WALL_PTS ⇒ pinCandidate path (separate from
    // buildSummary, but the summary string still leads with 'Pin setup').
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + NEAR, 1e9, spot),
      floor: ranked(spot - NEAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.regime).toBe('pin');
    expect(result.summary.startsWith('Pin setup')).toBe(true);
  });

  it("regime='drift-and-cap' produces a summary starting with 'Drift-and-cap setup'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + NEAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.regime).toBe('drift-and-cap');
    expect(result.summary.startsWith('Drift-and-cap setup')).toBe(true);
  });

  it("regime='chop' produces a summary starting with 'Range / chop'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.regime).toBe('chop');
    expect(result.summary.startsWith('Range / chop')).toBe(true);
  });
});

describe('computeTradePlan — buildSummary wall clauses', () => {
  it("includes 'bracketed by +γ {floor}/{ceiling}' when both walls are present", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.summary).toContain(
      `bracketed by +γ ${spot - FAR}/${spot + FAR}`,
    );
  });

  it("includes '+γ ceiling {strike} caps upside' when only ceiling is present", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: null,
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.summary).toContain(`+γ ceiling ${spot + FAR} caps upside`);
    expect(result.summary).not.toContain('bracketed by');
  });

  it("includes '+γ floor {strike} catches downside' when only floor is present", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: null,
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: -CHARM_HIGH,
      charmWide: -CHARM_HIGH,
    });
    expect(result.summary).toContain(`+γ floor ${spot - FAR} catches downside`);
    expect(result.summary).not.toContain('bracketed by');
  });
});

describe('computeTradePlan — buildSummary charm clauses', () => {
  it("describes positive charm above noise as 'mechanical buy into close'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.summary).toContain('mechanical buy into close');
    expect(result.summary).not.toContain('charm flow flat');
  });

  it("describes negative charm above noise as 'mechanical sell into close'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: -CHARM_HIGH,
      charmWide: -CHARM_HIGH,
    });
    expect(result.summary).toContain('mechanical sell into close');
    expect(result.summary).not.toContain('charm flow flat');
  });

  it("describes charm below noise as 'charm flow flat'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.summary).toContain('charm flow flat');
    expect(result.summary).not.toContain('mechanical');
  });

  it("summary string ends with 'bias: {bias}.'", () => {
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.bias).toBe('fade-only');
    expect(result.summary.endsWith(`bias: ${result.bias}.`)).toBe(true);
  });
});

describe('computeTradePlan — buildWaitZone branches', () => {
  it('returns null when no actionable setup (both triggers null AND both verdicts avoid)', () => {
    // ceiling NEAR (long avoid, trigger null), floor null (short
    // noTradeReason avoid, trigger null). Both avoid + both null ⇒ null.
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + NEAR, 1e9, spot),
      floor: null,
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.long.verdict).toBe('avoid');
    expect(result.short.verdict).toBe('avoid');
    expect(result.long.trigger).toBeNull();
    expect(result.short.trigger).toBeNull();
    expect(result.waitZone).toBeNull();
  });

  it("returns '{short}-{long} - no edge until either trigger fires.' when both triggers are present", () => {
    // Both walls FAR + charm flat ⇒ both plans 'conditional', both with
    // triggers (spot+2 / spot-2).
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: CHARM_LOW,
      charmWide: CHARM_LOW,
    });
    expect(result.long.trigger).toBe(spot + 2);
    expect(result.short.trigger).toBe(spot - 2);
    expect(result.waitZone).toBe(
      `${(spot - 2).toFixed(0)}–${(spot + 2).toFixed(0)} — no edge until either trigger fires.`,
    );
  });

  it("returns 'Below {long} (current {spot}) - no long edge.' when only the long trigger is present", () => {
    // ceiling FAR + charm up ⇒ long safe with trigger=spot+2; floor null ⇒
    // short noTradeReason with trigger null.
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: ranked(spot + FAR, 1e9, spot),
      floor: null,
      charmNear: CHARM_HIGH,
      charmWide: CHARM_HIGH,
    });
    expect(result.long.trigger).toBe(spot + 2);
    expect(result.short.trigger).toBeNull();
    expect(result.waitZone).toBe(
      `Below ${(spot + 2).toFixed(0)} (current ${spot.toFixed(0)}) — no long edge.`,
    );
  });

  it("returns 'Above {short} (current {spot}) - no short edge.' when only the short trigger is present", () => {
    // floor FAR + charm down ⇒ short safe with trigger=spot-2; ceiling null
    // ⇒ long noTradeReason with trigger null.
    const spot = 6000;
    const result = plan({
      spot,
      ceiling: null,
      floor: ranked(spot - FAR, 1e9, spot),
      charmNear: -CHARM_HIGH,
      charmWide: -CHARM_HIGH,
    });
    expect(result.short.trigger).toBe(spot - 2);
    expect(result.long.trigger).toBeNull();
    expect(result.waitZone).toBe(
      `Above ${(spot - 2).toFixed(0)} (current ${spot.toFixed(0)}) — no short edge.`,
    );
  });
});

describe('fmtSigned', () => {
  it('formats values >= 1M with M suffix and explicit sign', () => {
    expect(fmtSigned(2_500_000)).toBe('+2.5M');
    expect(fmtSigned(-2_500_000)).toBe('-2.5M');
    expect(fmtSigned(1_000_000)).toBe('+1.0M');
  });

  it('formats values in [1K, 1M) with K suffix and explicit sign', () => {
    expect(fmtSigned(2_500)).toBe('+2.5K');
    expect(fmtSigned(-2_500)).toBe('-2.5K');
    expect(fmtSigned(1_000)).toBe('+1.0K');
    expect(fmtSigned(999_999)).toBe('+1000.0K');
  });

  it('formats values < 1K with no suffix and explicit sign', () => {
    expect(fmtSigned(500)).toBe('+500');
    expect(fmtSigned(-500)).toBe('-500');
    expect(fmtSigned(0)).toBe('+0');
    expect(fmtSigned(999)).toBe('+999');
    expect(fmtSigned(-999)).toBe('-999');
  });

  it('rounds the < 1K branch to integer (no decimals)', () => {
    expect(fmtSigned(123.456)).toBe('+123');
    expect(fmtSigned(-123.456)).toBe('-123');
    expect(fmtSigned(123.567)).toBe('+124');
  });
});
