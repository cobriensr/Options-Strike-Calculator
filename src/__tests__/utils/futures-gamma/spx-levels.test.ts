import { describe, it, expect } from 'vitest';
import type { GexStrikeLevel } from '../../../hooks/useGexPerStrike';
import {
  buildEsLevels,
  computeSessionPhaseBoundaries,
  deriveSpxLevels,
  type LevelHistoryBuffer,
  type SpxLevels,
} from '../../../utils/futures-gamma/spx-levels';

// ── Fixtures ──────────────────────────────────────────────────────────

function strike(
  s: number,
  netGamma: number,
  price: number,
  netCharm = 0,
): GexStrikeLevel {
  return {
    strike: s,
    price,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement: 'neutral',
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

// ── deriveSpxLevels ───────────────────────────────────────────────────

describe('deriveSpxLevels', () => {
  it('returns all-null on empty input', () => {
    const out = deriveSpxLevels([]);
    expect(out.callWall).toBeNull();
    expect(out.putWall).toBeNull();
    expect(out.zeroGamma).toBeNull();
    expect(out.gammaPin).toBeNull();
    expect(out.spot).toBeNull();
    expect(out.netGex).toBe(0);
    expect(out.topUpsideRow).toBeNull();
    expect(out.topDownsideRow).toBeNull();
  });

  it('picks call wall (largest +netGamma) and put wall (largest |−netGamma|)', () => {
    const spot = 5800;
    const strikes = [
      strike(5790, -5_000_000, spot),
      strike(5800, +1_000_000, spot),
      strike(5810, +8_000_000, spot),
      strike(5780, -12_000_000, spot),
      strike(5820, +3_000_000, spot),
    ];
    const out = deriveSpxLevels(strikes);
    expect(out.callWall).toBe(5810);
    expect(out.putWall).toBe(5780);
  });

  it('picks gamma pin as the largest |netGamma| anywhere', () => {
    const spot = 5800;
    const strikes = [
      strike(5790, -5_000_000, spot),
      strike(5810, +8_000_000, spot),
      strike(5780, -12_000_000, spot), // dominant magnitude
    ];
    expect(deriveSpxLevels(strikes).gammaPin).toBe(5780);
  });

  it('sums netGamma into netGex', () => {
    const spot = 5800;
    const strikes = [
      strike(5790, -1, spot),
      strike(5800, 4, spot),
      strike(5810, -2, spot),
    ];
    expect(deriveSpxLevels(strikes).netGex).toBe(1);
  });

  it('isolates topUpsideRow / topDownsideRow on either side of spot', () => {
    const spot = 5800;
    const strikes = [
      strike(5790, -2_000_000, spot),
      strike(5780, -10_000_000, spot), // strongest below
      strike(5810, +5_000_000, spot),
      strike(5820, +9_000_000, spot), // strongest above
    ];
    const out = deriveSpxLevels(strikes);
    expect(out.topUpsideRow?.strike).toBe(5820);
    expect(out.topDownsideRow?.strike).toBe(5780);
  });

  it('reads spot off the first row (every row carries the same price field)', () => {
    const out = deriveSpxLevels([
      strike(5790, -1, 5801.23),
      strike(5800, 1, 5801.23),
    ]);
    expect(out.spot).toBe(5801.23);
  });

  it('returns null walls when no positive/negative gamma is present', () => {
    const spot = 5800;
    // All zeros → no qualifying call wall and no qualifying put wall.
    const out = deriveSpxLevels([strike(5800, 0, spot)]);
    expect(out.callWall).toBeNull();
    expect(out.putWall).toBeNull();
  });

  it('falls back gracefully when first-row price is 0 (spot is null-coalesced)', () => {
    // strike at spot=0 — the helper treats spot as 0 (truthy fallback in the
    // outer hook would substitute), and the above/below-spot pickers gate
    // on `spot !== null`. Sanity-check that nothing throws.
    const out = deriveSpxLevels([strike(5800, 1, 0)]);
    expect(out.spot).toBe(0);
    expect(out.netGex).toBe(1);
  });
});

// ── buildEsLevels ─────────────────────────────────────────────────────

const EMPTY_HISTORY: LevelHistoryBuffer = {};

const SPX_FIXTURE: SpxLevels = {
  callWall: 5810,
  putWall: 5790,
  zeroGamma: 5800,
  gammaPin: 5810,
  spot: 5800,
  netGex: 1_000_000,
  topUpsideRow: null,
  topDownsideRow: null,
};

describe('buildEsLevels', () => {
  it('returns empty levels + null derived when basis is missing', () => {
    const { levels, derived } = buildEsLevels(
      SPX_FIXTURE,
      null,
      5805,
      EMPTY_HISTORY,
      null,
    );
    expect(levels).toEqual([]);
    expect(derived.esCallWall).toBeNull();
    expect(derived.esPutWall).toBeNull();
    expect(derived.esZeroGamma).toBeNull();
    expect(derived.esGammaPin).toBeNull();
    expect(derived.esMaxPain).toBeNull();
  });

  it('returns empty levels + null derived when esPrice is missing', () => {
    const { levels, derived } = buildEsLevels(
      SPX_FIXTURE,
      12,
      null,
      EMPTY_HISTORY,
      null,
    );
    expect(levels).toEqual([]);
    expect(derived.esCallWall).toBeNull();
  });

  it('translates each SPX level through the basis to ES space', () => {
    // basis = +12.32 → SPX 5810 → ES 5822.32 → tick 5822.25.
    const { levels, derived } = buildEsLevels(
      SPX_FIXTURE,
      12.32,
      5805,
      EMPTY_HISTORY,
      null,
    );
    const callWall = levels.find((l) => l.kind === 'CALL_WALL');
    const putWall = levels.find((l) => l.kind === 'PUT_WALL');
    const zeroGamma = levels.find((l) => l.kind === 'ZERO_GAMMA');
    expect(callWall?.esPrice).toBeCloseTo(5822.25, 10);
    expect(putWall?.esPrice).toBeCloseTo(5802.25, 10);
    expect(zeroGamma?.esPrice).toBeCloseTo(5812.25, 10);
    expect(derived.esCallWall).toBeCloseTo(5822.25, 10);
    expect(derived.esPutWall).toBeCloseTo(5802.25, 10);
    expect(derived.esZeroGamma).toBeCloseTo(5812.25, 10);
    expect(derived.esGammaPin).toBeCloseTo(5822.25, 10);
  });

  it('does not emit MAX_PAIN as a rendered row but exposes esMaxPain on derived', () => {
    const { levels, derived } = buildEsLevels(
      SPX_FIXTURE,
      0,
      5800,
      EMPTY_HISTORY,
      5795, // SPX max-pain
    );
    expect(levels.find((l) => l.kind === 'MAX_PAIN')).toBeUndefined();
    expect(derived.esMaxPain).toBeCloseTo(5795, 10);
  });

  it('skips levels whose SPX strike is null', () => {
    const partial: SpxLevels = {
      ...SPX_FIXTURE,
      callWall: null,
      putWall: 5790,
      zeroGamma: null,
      gammaPin: null,
    };
    const { levels, derived } = buildEsLevels(
      partial,
      0,
      5800,
      EMPTY_HISTORY,
      null,
    );
    expect(levels.map((l) => l.kind)).toEqual(['PUT_WALL']);
    expect(derived.esCallWall).toBeNull();
    expect(derived.esZeroGamma).toBeNull();
    expect(derived.esGammaPin).toBeNull();
  });

  it('signed distance: positive when level is above price, negative when below', () => {
    const { levels } = buildEsLevels(
      SPX_FIXTURE,
      0,
      5800,
      EMPTY_HISTORY,
      null,
    );
    const callWall = levels.find((l) => l.kind === 'CALL_WALL');
    const putWall = levels.find((l) => l.kind === 'PUT_WALL');
    expect(callWall?.distanceEsPoints).toBeGreaterThan(0); // 5810 above 5800
    expect(putWall?.distanceEsPoints).toBeLessThan(0); // 5790 below 5800
  });
});

// ── computeSessionPhaseBoundaries ────────────────────────────────────

describe('computeSessionPhaseBoundaries', () => {
  it('emits four ET-offset ISO strings keyed open/lunch/power/close', () => {
    const out = computeSessionPhaseBoundaries('2026-04-30');
    expect(out).toHaveProperty('open');
    expect(out).toHaveProperty('lunch');
    expect(out).toHaveProperty('power');
    expect(out).toHaveProperty('close');
    // CT 08:30 = ET 09:30 — ISO local time portion should be '09:30:00'.
    expect(out.open).toMatch(/^2026-04-30T09:30:00[+-]\d{2}:\d{2}$/);
    expect(out.lunch).toMatch(/^2026-04-30T12:30:00[+-]\d{2}:\d{2}$/);
    expect(out.power).toMatch(/^2026-04-30T15:30:00[+-]\d{2}:\d{2}$/);
    expect(out.close).toMatch(/^2026-04-30T16:30:00[+-]\d{2}:\d{2}$/);
  });

  it('uses EDT offset (-04:00) on a summer date', () => {
    const out = computeSessionPhaseBoundaries('2026-07-15');
    expect(out.open).toMatch(/-04:00$/);
  });

  it('uses EST offset (-05:00) on a winter date', () => {
    const out = computeSessionPhaseBoundaries('2026-01-15');
    expect(out.open).toMatch(/-05:00$/);
  });

  it('produces parseable Dates that round-trip to the right minute', () => {
    const out = computeSessionPhaseBoundaries('2026-06-15');
    const open = new Date(out.open);
    // ET 09:30 in EDT → 13:30 UTC.
    expect(open.getUTCHours()).toBe(13);
    expect(open.getUTCMinutes()).toBe(30);
  });
});
