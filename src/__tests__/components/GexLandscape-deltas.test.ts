/**
 * Unit tests for GexLandscape deltas helpers (computeDeltaMap,
 * findClosestSnapshot, computeSmoothedStrikes). Pure functions — no React.
 */

import { describe, expect, it } from 'vitest';
import {
  computeDeltaMap,
  computeSmoothedStrikes,
  findClosestSnapshot,
} from '../../components/GexLandscape/deltas';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import type { Snapshot } from '../../components/GexLandscape/types';

function makeStrike(overrides: Partial<GexStrikeLevel> = {}): GexStrikeLevel {
  return {
    strike: 5800,
    price: 5795,
    callGammaOi: 5e11,
    putGammaOi: -3e11,
    netGamma: 2e11,
    callGammaVol: 1e11,
    putGammaVol: -5e10,
    netGammaVol: 5e10,
    volReinforcement: 'reinforcing',
    callGammaAsk: -1e8,
    callGammaBid: 2e8,
    putGammaAsk: 5e7,
    putGammaBid: -1.5e8,
    callCharmOi: 1e9,
    putCharmOi: -8e8,
    netCharm: 2e8,
    callCharmVol: 5e8,
    putCharmVol: -4e8,
    netCharmVol: 1e8,
    callDeltaOi: 5e9,
    putDeltaOi: -3e9,
    netDelta: 2e9,
    callVannaOi: 1e8,
    putVannaOi: -6e7,
    netVanna: 4e7,
    callVannaVol: 5e7,
    putVannaVol: -3e7,
    netVannaVol: 2e7,
    ...overrides,
  };
}

describe('computeDeltaMap', () => {
  it('returns the % change in netGamma between matched strikes', () => {
    const prev = [makeStrike({ strike: 5800, netGamma: 100 })];
    const curr = [makeStrike({ strike: 5800, netGamma: 120 })];
    const map = computeDeltaMap(curr, prev);
    expect(map.get(5800)).toBeCloseTo(20, 5);
  });

  it('uses absolute previous magnitude as the denominator', () => {
    // (120 - (-100)) / |-100| * 100 = 220
    const prev = [makeStrike({ strike: 5800, netGamma: -100 })];
    const curr = [makeStrike({ strike: 5800, netGamma: 120 })];
    expect(computeDeltaMap(curr, prev).get(5800)).toBeCloseTo(220, 5);
  });

  it('returns null for strikes missing from the previous snapshot', () => {
    const map = computeDeltaMap(
      [makeStrike({ strike: 5900, netGamma: 100 })],
      [makeStrike({ strike: 5800, netGamma: 100 })],
    );
    expect(map.get(5900)).toBeNull();
  });

  it('returns null when the previous gamma is exactly zero (avoids div/0)', () => {
    const prev = [makeStrike({ strike: 5800, netGamma: 0 })];
    const curr = [makeStrike({ strike: 5800, netGamma: 50 })];
    expect(computeDeltaMap(curr, prev).get(5800)).toBeNull();
  });
});

describe('findClosestSnapshot', () => {
  function snap(ts: number): Snapshot {
    return { ts, strikes: [] };
  }

  it('returns null for an empty buffer', () => {
    expect(findClosestSnapshot([], 1000)).toBeNull();
  });

  it('returns the snapshot with the smallest timestamp diff', () => {
    const buf = [snap(900), snap(990), snap(1100)];
    expect(findClosestSnapshot(buf, 1000)?.ts).toBe(990);
  });

  it('returns null when nothing falls within the tolerance window', () => {
    const buf = [snap(0), snap(500_000)];
    // Default toleranceMs = 120_000 — both are way outside
    expect(findClosestSnapshot(buf, 1_000_000)).toBeNull();
  });

  it('respects a custom tolerance argument', () => {
    const buf = [snap(900), snap(1500)];
    expect(findClosestSnapshot(buf, 1000, 50)).toBeNull();
    expect(findClosestSnapshot(buf, 1000, 200)?.ts).toBe(900);
  });
});

describe('computeSmoothedStrikes', () => {
  it('returns the current snapshot unchanged when no buffer entries are recent', () => {
    const current = [makeStrike({ strike: 5800, netGamma: 100, netCharm: 50 })];
    const out = computeSmoothedStrikes(current, [], 60_000);
    expect(out).toEqual(current);
  });

  it('averages netGamma and netCharm across the current snapshot and recent buffer', () => {
    const current = [makeStrike({ strike: 5800, netGamma: 300, netCharm: 90 })];
    const buf: Snapshot[] = [
      {
        ts: 60_000,
        strikes: [makeStrike({ strike: 5800, netGamma: 200, netCharm: 60 })],
      },
      {
        ts: 120_000,
        strikes: [makeStrike({ strike: 5800, netGamma: 100, netCharm: 30 })],
      },
    ];
    const [out] = computeSmoothedStrikes(current, buf, 240_000);
    // average of 300 + 200 + 100 over 3 = 200; 90 + 60 + 30 = 60
    expect(out!.netGamma).toBeCloseTo(200, 5);
    expect(out!.netCharm).toBeCloseTo(60, 5);
  });

  it('drops buffer snapshots outside the smoothing window', () => {
    const current = [makeStrike({ strike: 5800, netGamma: 300, netCharm: 90 })];
    const buf: Snapshot[] = [
      {
        ts: 1_000,
        strikes: [makeStrike({ strike: 5800, netGamma: 100, netCharm: 30 })],
      },
    ];
    // windowMs = 5min default; nowTs = 10min, buf is 9min old → outside window
    const [out] = computeSmoothedStrikes(current, buf, 600_000);
    expect(out!.netGamma).toBe(300);
    expect(out!.netCharm).toBe(90);
  });

  it('preserves a strike that has no history in the buffer', () => {
    const current = [
      makeStrike({ strike: 5800, netGamma: 100 }),
      makeStrike({ strike: 5900, netGamma: 200 }),
    ];
    const buf: Snapshot[] = [
      {
        ts: 60_000,
        strikes: [makeStrike({ strike: 5800, netGamma: 50 })],
      },
    ];
    const out = computeSmoothedStrikes(current, buf, 120_000);
    expect(out.find((s) => s.strike === 5900)?.netGamma).toBe(200);
    expect(out.find((s) => s.strike === 5800)?.netGamma).toBeCloseTo(75, 5);
  });
});
