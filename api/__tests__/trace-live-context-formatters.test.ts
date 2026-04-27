import { describe, expect, it } from 'vitest';
import {
  computeDominantNode,
  formatGammaMagnitude,
  formatGexLandscapeForClaude,
  formatImageLabel,
  formatSessionContext,
} from '../_lib/trace-live-context-formatters.js';
import type {
  TraceGexLandscape,
  TraceImage,
  TraceStrikeRow,
} from '../_lib/trace-live-types.js';

const MINUS = '−';

describe('formatGammaMagnitude', () => {
  it('formats billions with B suffix and explicit + sign', () => {
    expect(formatGammaMagnitude(3_400_000_000)).toBe('+3.40B');
  });

  it('formats negative millions with U+2212 minus', () => {
    expect(formatGammaMagnitude(-712_000_000)).toBe(`${MINUS}712.00M`);
  });

  it('formats thousands with K suffix', () => {
    expect(formatGammaMagnitude(45_500)).toBe('+45.50K');
  });

  it('formats sub-thousand values with no suffix', () => {
    expect(formatGammaMagnitude(123)).toBe('+123.00');
  });

  it('returns em-dash for non-finite inputs', () => {
    expect(formatGammaMagnitude(Number.NaN)).toBe('—');
    expect(formatGammaMagnitude(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

function makeStrike(
  strike: number,
  dollarGamma: number,
  extra: Partial<TraceStrikeRow> = {},
): TraceStrikeRow {
  return { strike, dollarGamma, ...extra };
}

describe('computeDominantNode', () => {
  // The override rule fires when ratio ≥ 10 OR magnitude ≥ 5B. These tests
  // pin the threshold edges so the rule's wiring stays calibrated.

  it('returns null when no positive gamma strikes are within band', () => {
    const strikes = [makeStrike(6000, -1e9), makeStrike(6010, -2e9)];
    expect(computeDominantNode(strikes, 6005, 30)).toBeNull();
  });

  it('returns Infinity ratio when only one +γ strike exists in band', () => {
    const strikes = [makeStrike(6005, 3e9), makeStrike(6020, -1e9)];
    const dom = computeDominantNode(strikes, 6005, 30);
    expect(dom).not.toBeNull();
    expect(dom!.strike).toBe(6005);
    expect(dom!.ratio).toBe(Infinity);
  });

  it('computes ratio of largest +γ to next-largest +γ', () => {
    // top is 5B, next is 0.5B → ratio 10 (override threshold edge)
    const strikes = [
      makeStrike(6005, 5e9),
      makeStrike(6010, 0.5e9),
      makeStrike(6020, 0.3e9),
    ];
    const dom = computeDominantNode(strikes, 6005, 30);
    expect(dom!.strike).toBe(6005);
    expect(dom!.magnitude).toBe(5e9);
    expect(dom!.ratio).toBeCloseTo(10, 5);
  });

  it('respects the band — strikes outside ±band are excluded', () => {
    const strikes = [
      makeStrike(5970, 10e9), // 35 below spot — outside ±30 band
      makeStrike(6005, 1e9),
    ];
    const dom = computeDominantNode(strikes, 6005, 30);
    expect(dom!.strike).toBe(6005);
    expect(dom!.magnitude).toBe(1e9);
  });

  it('absolute-magnitude threshold: 5B alone fires the override regardless of ratio', () => {
    // ratio is only 2x but magnitude is 5B — override should still consider it dominant
    const strikes = [makeStrike(6005, 5e9), makeStrike(6010, 2.5e9)];
    const dom = computeDominantNode(strikes, 6005, 30);
    expect(dom!.magnitude).toBe(5e9);
    expect(dom!.ratio).toBe(2);
    // The override-fires decision happens in formatGexLandscapeForClaude — see below.
  });
});

const baseGex: TraceGexLandscape = {
  regime: 'positive_gamma',
  atmStrike: 6000,
  strikes: [
    makeStrike(6005, 5.5e9, { charm: -1e8, classification: 'sticky-pin' }),
    makeStrike(6000, 0.5e9, { charm: 1e7, classification: 'weakening-pin' }),
  ],
};

describe('formatGexLandscapeForClaude', () => {
  it('emits "Override rule FIRES" when magnitude ≥ 5B', () => {
    const text = formatGexLandscapeForClaude(baseGex, 6005);
    expect(text).toContain('Override rule FIRES');
    expect(text).toContain('Pin level');
  });

  it('emits "does not fire" when below threshold', () => {
    const weak: TraceGexLandscape = {
      ...baseGex,
      strikes: [
        makeStrike(6005, 1e9),
        makeStrike(6000, 0.5e9),
        makeStrike(6010, 0.3e9),
      ],
    };
    const text = formatGexLandscapeForClaude(weak, 6005);
    expect(text).toContain('Override rule does not fire');
  });

  it('marks the ATM strike with *ATM*', () => {
    const text = formatGexLandscapeForClaude(baseGex, 6005);
    // 6000 is the atmStrike — the row for 6000 should carry the marker
    const atmLine = text
      .split('\n')
      .find((l) => l.includes('6000') && l.includes('*ATM*'));
    expect(atmLine).toBeDefined();
  });

  it('renders the regime label and ATM strike header', () => {
    const text = formatGexLandscapeForClaude(baseGex, 6005);
    expect(text).toContain('Regime: positive_gamma');
    expect(text).toContain('ATM strike: 6000 (spot 6005.00)');
  });

  it('omits net/total/drift sections when those fields are absent', () => {
    const text = formatGexLandscapeForClaude(baseGex, 6005);
    expect(text).not.toContain('Net GEX');
    expect(text).not.toContain('Drift targets');
  });

  it('renders net/total/drift sections when supplied', () => {
    const full: TraceGexLandscape = {
      ...baseGex,
      netGex: 6e9,
      totalPosGex: 6e9,
      totalNegGex: 0,
      driftTargetsUp: [6010, 6020],
      driftTargetsDown: [5990],
    };
    const text = formatGexLandscapeForClaude(full, 6005);
    expect(text).toContain('Net GEX: +6.00B');
    expect(text).toContain('Drift targets ↑: 6010, 6020');
    expect(text).toContain('Drift targets ↓: 5990');
  });
});

describe('formatImageLabel', () => {
  const base: TraceImage = {
    chart: 'gamma',
    slot: 'close',
    capturedAt: '2026-04-23T19:30:00Z',
    mediaType: 'image/png',
    data: 'AAAA',
  };

  it('renders a Gamma label', () => {
    const out = formatImageLabel(base, 6005);
    expect(out).toBe(
      '[Gamma Heatmap — slot=close, captured 2026-04-23T19:30:00Z, spot=6005.00]',
    );
  });

  it('renders a Charm label', () => {
    const out = formatImageLabel({ ...base, chart: 'charm' }, 6005);
    expect(out).toContain('Charm Pressure Heatmap');
  });

  it('renders a Delta label', () => {
    const out = formatImageLabel({ ...base, chart: 'delta' }, 6005);
    expect(out).toContain('Delta Pressure Heatmap');
  });
});

describe('formatSessionContext', () => {
  it('emits ET clock + minutes-to-close + phase label for a valid UTC ISO', () => {
    // 19:30 UTC on 2026-04-23 (DST) = 15:30 ET → late session, 30 min to close.
    const text = formatSessionContext({
      capturedAt: '2026-04-23T19:30:00Z',
      etTimeLabel: '15:30 ET',
      spot: 6005.5,
      stabilityPct: 67.3,
    });
    expect(text).toContain('Capture date (ET): 04/23/2026');
    expect(text).toContain('Capture time (ET clock): 15:30');
    expect(text).toContain('LATE SESSION (last hour)');
    expect(text).toContain('Minutes to 4:00 PM ET cash close: 30');
    expect(text).toContain(
      '(Raw UTC for reference only: 2026-04-23T19:30:00Z)',
    );
    expect(text).toContain('SPX spot: 6005.50');
    expect(text).toContain('Stability%: 67.3%');
  });

  it('classifies an early-morning capture as MORNING SESSION', () => {
    // 14:30 UTC on 2026-04-23 (DST) = 10:30 ET → morning session.
    const text = formatSessionContext({
      capturedAt: '2026-04-23T14:30:00Z',
      spot: 6000,
      stabilityPct: 35,
    });
    expect(text).toContain('Capture time (ET clock): 10:30');
    expect(text).toContain('MORNING SESSION');
    expect(text).toContain('Minutes to 4:00 PM ET cash close: 330');
  });

  it('emits the placeholder when stability is null', () => {
    const text = formatSessionContext({
      capturedAt: '2026-04-23T19:30:00Z',
      spot: 6000,
      stabilityPct: null,
    });
    expect(text).toContain('not visible / pre-2025-Q2 capture');
  });

  it('falls back to raw capturedAt when the timestamp is malformed', () => {
    const text = formatSessionContext({
      capturedAt: 'not-a-date',
      spot: 6000,
      stabilityPct: undefined,
    });
    expect(text).toContain('Capture time: not-a-date');
    expect(text).not.toContain('Capture time (ET clock)');
  });
});
