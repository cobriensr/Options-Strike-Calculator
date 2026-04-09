/**
 * End-to-end integration tests for the GexTarget pipeline.
 *
 * These scenarios differ from the component tests (`gex-target.components`)
 * and pipeline-in-isolation tests (`gex-target.pipeline`) in intent:
 *
 * - Component tests check "does each scorer compute what the formula says."
 * - Pipeline tests check "does each pipeline step do its job in isolation."
 * - These integration tests check "does the whole system produce the right
 *   trading intuitions on realistic multi-strike snapshot sequences."
 *
 * Each scenario corresponds to one row of Appendix D's "Integration
 * scenarios" test matrix in
 * `docs/superpowers/plans/gex-target-rebuild.md`. The fixture builders
 * mirror the shape used in `gex-target.pipeline.test.ts` (those helpers
 * aren't exported, so we duplicate the minimum needed to build realistic
 * multi-strike histories).
 */

import { describe, it, expect } from 'vitest';
import { computeGexTarget, proximity } from '../../utils/gex-target';
import type {
  GexSnapshot,
  GexStrikeRow,
  MagnetFeatures,
} from '../../utils/gex-target';

// ── Fixture builders ─────────────────────────────────────────────────

/**
 * Build a `GexStrikeRow` with benign zero defaults. Tests override only
 * the columns they exercise so the assertions stay focused on the
 * behaviour under test.
 */
function makeRow(overrides: Partial<GexStrikeRow> = {}): GexStrikeRow {
  return {
    strike: 6780,
    price: 6780,
    callGammaOi: 0,
    putGammaOi: 0,
    callGammaVol: 0,
    putGammaVol: 0,
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    callCharmVol: 0,
    putCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    ...overrides,
  };
}

/**
 * Build one board snapshot at a given timestamp, spot, and list of rows.
 */
function makeSnapshot(
  timestamp: string,
  price: number,
  strikes: GexStrikeRow[],
): GexSnapshot {
  return { timestamp, price, strikes };
}

/**
 * Construct a 1-minute-cadence history of `count` snapshots starting at
 * `startUtcIso`. `mkRows(i, ts)` receives the snapshot index (0 = oldest)
 * and its ISO timestamp; callers return the full strike list for that
 * minute. Spot at snapshot `i` is `spotAt(i)` so scenarios that need
 * price drift can thread movement through the sequence.
 */
function makeHistory(options: {
  count: number;
  startUtcIso: string;
  spotAt: (i: number) => number;
  mkRows: (i: number, spot: number) => GexStrikeRow[];
}): GexSnapshot[] {
  const base = new Date(options.startUtcIso).getTime();
  const snapshots: GexSnapshot[] = [];
  for (let i = 0; i < options.count; i++) {
    const ts = new Date(base + i * 60_000).toISOString();
    const spot = options.spotAt(i);
    snapshots.push(makeSnapshot(ts, spot, options.mkRows(i, spot)));
  }
  return snapshots;
}

// ── Scenario 1 — Symmetric call wall (positive direction) ────────────

describe('integration: symmetric call wall forming above spot', () => {
  it('picks the growing call wall as target with positive finalScore and wallSide CALL', () => {
    // Spot 6780. Call wall at 6790 (10 pts above) is building at ~30%
    // per minute across the full 61-snapshot history, so every delta
    // horizon saturates the flow scorer in the positive direction.
    // Nine peer strikes are static at a smaller magnitude so they can't
    // out-dominate. Spot drifts up 1 pt over the last 5 minutes so the
    // price-confirm term also reinforces upward.
    //
    // Timestamps start at 19:40 UTC so the 60th snapshot lands at
    // 20:40 UTC = 15:40 CDT (clamped by extractor to 180 minutes after
    // noon CT, so charm runs at full weight).
    //
    // Charm is positive and aligned with the gamma sign (both positive),
    // giving charmSign = +1 and pushing the composite up further.
    //
    // Key assertion: finalScore > 0, wallSide = 'CALL', target = 6790,
    // rankByScore = 1, tier at least MEDIUM. Matches the call-wall arm
    // of Appendix D's "symmetric case" row.
    const snapshots = makeHistory({
      count: 61,
      startUtcIso: '2026-04-08T19:40:00Z',
      spotAt: (i) => {
        // Flat for the first 56 minutes, then drift up 1 pt over the
        // final 5 minutes so priceConfirm has a clean positive signal.
        if (i < 56) return 6780;
        return 6780 + (i - 56) * 0.2;
      },
      mkRows: (i, spot) => {
        const rows: GexStrikeRow[] = [];
        // Call wall at 6790 growing exponentially in OI gamma.
        rows.push(
          makeRow({
            strike: 6790,
            price: spot,
            callGammaOi: 1e6 * Math.pow(1.3, i),
            // Give it some volume so clarity > 0 (calls only → clarity 1).
            callGammaVol: 1e4,
            // Positive charm aligned with gamma sign.
            callCharmOi: 5e8,
          }),
        );
        // Nine static peer strikes bracketing spot so pickUniverse has
        // ten rows to work with. Their gamma is big enough to land in
        // the universe but small enough that 6790 dominates.
        const peerStrikes = [
          6760, 6765, 6770, 6775, 6780, 6785, 6795, 6800, 6805,
        ];
        for (const k of peerStrikes) {
          rows.push(
            makeRow({
              strike: k,
              price: spot,
              callGammaOi: 5e5,
              callGammaVol: 1e3,
            }),
          );
        }
        return rows;
      },
    });

    const result = computeGexTarget(snapshots);

    // A target is picked at all.
    expect(result.oi.target).not.toBeNull();
    // It's the growing strike, not one of the static peers.
    expect(result.oi.target?.strike).toBe(6790);
    // Wall side tracks sign(gexDollars); gamma is positive → CALL.
    expect(result.oi.target?.wallSide).toBe('CALL');
    // Growing gamma → positive flow → positive composite.
    expect(result.oi.target?.finalScore).toBeGreaterThan(0);
    // The composite should clear at least the MEDIUM threshold (0.3).
    // HIGH is also acceptable — the exact tier depends on the exact
    // weight of the saturating horizons. Don't peg the magnitude.
    expect(['MEDIUM', 'HIGH']).toContain(result.oi.target?.tier);
    // It's the #1 ranked entry by score.
    expect(result.oi.target?.rankByScore).toBe(1);
    // And the leaderboard has the full universe (10 strikes).
    expect(result.oi.leaderboard.length).toBe(10);
  });
});

// ── Scenario 2 — Symmetric put wall (growing short gamma) ────────────

describe('integration: symmetric put wall forming below spot', () => {
  it('picks the growing put wall with negative finalScore and wallSide PUT', () => {
    // Mirror of Scenario 1 on the put side. Spot 6780, put wall at 6770
    // (10 pts below) has gexDollars becoming more negative over time
    // (gamma growing in the negative direction). That makes every
    // deltaGex horizon NEGATIVE, so flowConfluence is strongly
    // negative, and finalScore ends up negative. wallSide reads the
    // sign of gexDollars (negative → PUT) regardless of finalScore
    // sign, so it still labels PUT.
    //
    // Spot drifts DOWN by 1 pt over the final 5 minutes so priceConfirm
    // is positive (falling spot toward a below-spot strike is
    // "confirmation"). With a positive priceConfirm, the composite's
    // priceConfirm term is actually positive — but its magnitude is
    // small relative to the negative flow term, so the sign of
    // finalScore is still driven by flow.
    //
    // Charm is positive in sign (+ charmNet × negative gexDollars =
    // negative charmSign), so the charm contribution to finalScore is
    // negative, reinforcing the direction of flow. This is the
    // "growing put wall with supportive charm decay" archetype.
    //
    // Key assertion: finalScore < 0, wallSide = 'PUT', target = 6770.
    // This proves the model is sign-symmetric — the same shape on the
    // negative side produces a mirror result without special casing.
    const snapshots = makeHistory({
      count: 61,
      startUtcIso: '2026-04-08T19:40:00Z',
      spotAt: (i) => {
        if (i < 56) return 6780;
        return 6780 - (i - 56) * 0.2;
      },
      mkRows: (i, spot) => {
        const rows: GexStrikeRow[] = [];
        // Put wall at 6770: put gamma grows in magnitude over time, so
        // putGammaOi scales exponentially. gexDollars = (callGamma +
        // putGamma) × spot × 100, and putGamma here is huge and
        // negative-sense (we model it as a positive-magnitude put OI
        // that the caller reports as positive). UW's convention is
        // that both call and put gamma are reported positive; the net
        // sign comes from whether the strike is a call-wall or
        // put-wall based on the order-book skew. For this test we
        // instead drive the sign by placing a large NEGATIVE
        // callGammaOi, which is the cleanest way to get a negative
        // gexDollars inside the simplified scoring convention. That
        // mirrors how the pipeline test uses negative gamma to rank by
        // |gexDollars|.
        rows.push(
          makeRow({
            strike: 6770,
            price: spot,
            callGammaOi: -1e6 * Math.pow(1.3, i),
            // Put-heavy volume → callRatio = -1 → clarity = 1.
            putGammaVol: 1e4,
            // Positive charmOi (so charmSign = sign(-gex) × sign(+charm)
            // = -1 → negative charmScore → negative charm contribution).
            callCharmOi: 5e8,
          }),
        );
        const peerStrikes = [
          6755, 6760, 6765, 6775, 6780, 6785, 6790, 6795, 6800,
        ];
        for (const k of peerStrikes) {
          rows.push(
            makeRow({
              strike: k,
              price: spot,
              callGammaOi: 5e5,
              callGammaVol: 1e3,
            }),
          );
        }
        return rows;
      },
    });

    const result = computeGexTarget(snapshots);

    expect(result.oi.target).not.toBeNull();
    expect(result.oi.target?.strike).toBe(6770);
    // Wall side tracks sign(gexDollars), which is negative → PUT.
    expect(result.oi.target?.wallSide).toBe('PUT');
    // The growing-short-gamma side produces NEGATIVE finalScore. This
    // is the sign symmetry check — the thing the model must get right.
    expect(result.oi.target?.finalScore).toBeLessThan(0);
    // MEDIUM or HIGH tier — magnitude is what matters for the tier.
    expect(['MEDIUM', 'HIGH']).toContain(result.oi.target?.tier);
    expect(result.oi.target?.rankByScore).toBe(1);
  });
});

// ── Scenario 3 — Churning board, no target ───────────────────────────

describe('integration: churning board with no dominant trend', () => {
  it('returns null target for every mode when every strike is small and noisy', () => {
    // Ten strikes, all with moderate |gexDollars| that tick slightly up
    // and down each minute in a pseudo-random but deterministic way.
    // No strike grows consistently, no strike dominates in size, price
    // is flat. Every strike's finalScore should stay below the LOW
    // threshold by the end of the window.
    //
    // Magnitudes are chosen so that:
    //   - flowConfluence is small (tiny weighted_pct)
    //   - clarity is ~0.5 (balanced call/put volume)
    //   - dominance is low (all strikes similar size)
    // Composite should never clear the MEDIUM threshold (0.3), and the
    // target should be null because the top-score strike has tier NONE
    // or LOW (target selection requires tier !== NONE).
    const strikes = [
      6750, 6755, 6760, 6765, 6770, 6775, 6785, 6790, 6795, 6800,
    ];
    const snapshots = makeHistory({
      count: 61,
      startUtcIso: '2026-04-08T19:40:00Z',
      spotAt: () => 6780,
      mkRows: (i, spot) => {
        return strikes.map((strike, idx) => {
          // Deterministic tiny jitter in [-0.005, +0.005] of a base
          // 1e6 gamma. At prevGexDollars ~ 1e6*6780*100 = 6.78e11,
          // a +/-0.005e6 delta is ~0.7% per minute — well below the
          // SCALE_FLOW_PCT = 0.3 saturation, so flow stays tiny.
          const phase = Math.sin((i + idx) * 1.3) * 0.005;
          return makeRow({
            strike,
            price: spot,
            callGammaOi: 1e6 * (1 + phase),
            // Balanced volume → clarity near 0.
            callGammaVol: 1e3,
            putGammaVol: 1e3,
          });
        });
      },
    });

    const result = computeGexTarget(snapshots);

    // No target in any mode — this is the "board churning" case that
    // the panel renders as "no confluence."
    expect(result.oi.target).toBeNull();
    expect(result.vol.target).toBeNull();
    expect(result.dir.target).toBeNull();
    // Leaderboards still populated (universe is picked by |GEX $|,
    // which is non-zero). OI leaderboard has all 10 strikes; VOL has
    // up to 10 but volume columns are small and may produce a smaller
    // universe.
    expect(result.oi.leaderboard.length).toBe(10);
    // Every OI strike should be LOW or NONE — nothing clears MEDIUM.
    for (const entry of result.oi.leaderboard) {
      expect(['LOW', 'NONE']).toContain(entry.tier);
    }
  });
});

// ── Scenario 4 — Morning partial window (sparse history) ─────────────

describe('integration: morning partial window with only 8 snapshots', () => {
  it('picks a target even when 20m and 60m horizons are null', () => {
    // Only 8 snapshots exist (session started 8 minutes ago). That means
    // the latest snapshot has:
    //   - deltaGex_1m available (prior snapshot exists)
    //   - deltaGex_5m available (snapshot 2 positions back exists)
    //   - deltaGex_20m = null (would need 28 snapshots in window)
    //   - deltaGex_60m = null
    //
    // flowConfluence should drop the null horizons and renormalize
    // the surviving weights. The 1m and 5m horizons alone should still
    // be enough to pick a target when a strike is growing cleanly.
    //
    // This is the "scoring works with reduced horizons" case from
    // Appendix D.
    const snapshots = makeHistory({
      count: 8,
      startUtcIso: '2026-04-08T14:30:00Z',
      spotAt: () => 6780,
      mkRows: (i, spot) => {
        const rows: GexStrikeRow[] = [];
        // Strong growing strike at 6785 (5 pts above spot so proximity
        // stays near 1). 30% per minute growth like in Scenario 1.
        rows.push(
          makeRow({
            strike: 6785,
            price: spot,
            callGammaOi: 1e6 * Math.pow(1.3, i),
            callGammaVol: 1e4,
            callCharmOi: 5e8,
          }),
        );
        // Nine static peer strikes.
        const peerStrikes = [
          6760, 6765, 6770, 6775, 6780, 6790, 6795, 6800, 6805,
        ];
        for (const k of peerStrikes) {
          rows.push(
            makeRow({
              strike: k,
              price: spot,
              callGammaOi: 5e5,
              callGammaVol: 1e3,
            }),
          );
        }
        return rows;
      },
    });

    // Doesn't throw on sparse history.
    expect(() => computeGexTarget(snapshots)).not.toThrow();

    const result = computeGexTarget(snapshots);

    // A target can still be picked with only 1m/5m data.
    expect(result.oi.target).not.toBeNull();
    // It should be the growing strike.
    expect(result.oi.target?.strike).toBe(6785);

    // Directly verify the horizon population on the picked target:
    const f: MagnetFeatures | undefined = result.oi.target?.features;
    expect(f).toBeDefined();
    // 1m and 5m are populated (8 snapshots is enough for both).
    expect(f?.deltaGex_1m).not.toBeNull();
    expect(f?.deltaGex_5m).not.toBeNull();
    // 20m and 60m are null because history is too short to reach back.
    expect(f?.deltaGex_20m).toBeNull();
    expect(f?.deltaGex_60m).toBeNull();
  });
});

// ── Scenario 5 — Afternoon charm kill ────────────────────────────────

describe('integration: afternoon charm kill', () => {
  it('drags down finalScore when charm opposes the gamma direction at full afternoon weight', () => {
    // Build two parallel fixtures that differ ONLY in the sign of
    // charmOi on the dominant growing strike. At 15:00 UTC-5 (3:00 PM
    // CT), minutesAfterNoonCT clamps to 180, so charm runs at the full
    // 1.0 todWeight — this is the scenario where charm moves the
    // composite the most.
    //
    // Fixture A: charmOi is positive (aligned with gamma sign) →
    //             charmSign = +1 → charm contribution is positive →
    //             finalScore higher.
    //
    // Fixture B: charmOi is negative (opposing) → charmSign = -1 →
    //             charm contribution is negative → finalScore lower.
    //
    // The other factors (flow, price, clarity, dominance, proximity)
    // are identical between the two fixtures, so the delta in
    // finalScore is purely the charm contribution.
    //
    // Key assertion: finalScore(B) < finalScore(A) (charm kill drags
    // the composite down). The tier of B may or may not drop — the
    // RELATIVE assertion is the robust one.
    const buildHistory = (charmSign: 1 | -1) =>
      makeHistory({
        count: 61,
        // 20:00 UTC = 15:00 CDT = 3:00 PM CT (minutesAfterNoonCT = 180).
        // The 60th snapshot is 1 hour later, so the full window covers
        // 2:00-3:00 PM CT. The extractor reads the LATEST snapshot's
        // timestamp, so the charm todWeight computation uses 3:00 PM.
        startUtcIso: '2026-04-08T19:00:00Z',
        spotAt: () => 6780,
        mkRows: (i, spot) => {
          const rows: GexStrikeRow[] = [];
          rows.push(
            makeRow({
              strike: 6790,
              price: spot,
              callGammaOi: 1e6 * Math.pow(1.3, i),
              callGammaVol: 1e4,
              callCharmOi: charmSign * 5e8,
            }),
          );
          const peerStrikes = [
            6760, 6765, 6770, 6775, 6780, 6785, 6795, 6800, 6805,
          ];
          for (const k of peerStrikes) {
            rows.push(
              makeRow({
                strike: k,
                price: spot,
                callGammaOi: 5e5,
                callGammaVol: 1e3,
              }),
            );
          }
          return rows;
        },
      });

    const aligned = computeGexTarget(buildHistory(1));
    const opposing = computeGexTarget(buildHistory(-1));

    // Both should pick the same strike (everything else is identical).
    expect(aligned.oi.target?.strike).toBe(6790);
    expect(opposing.oi.target?.strike).toBe(6790);

    // The core relative assertion: opposing charm produces a strictly
    // smaller composite. This is the "charm kill" invariant — charm
    // matters in the direction of the gamma sign, and the spec says
    // afternoon is when it matters most.
    const alignedScore = aligned.oi.target?.finalScore ?? 0;
    const opposingScore = opposing.oi.target?.finalScore ?? 0;
    expect(opposingScore).toBeLessThan(alignedScore);

    // Sanity: charm components specifically flipped sign between the
    // two fixtures, so the full composite delta should be non-trivial
    // (not just floating-point noise).
    const delta = alignedScore - opposingScore;
    expect(delta).toBeGreaterThan(0.01);
  });
});

// ── Scenario 6 — Proximity veto ──────────────────────────────────────

describe('integration: proximity veto for a far-out strike', () => {
  it('rejects a 50-point-away strike as target even with otherwise perfect factors', () => {
    // Spot 6780. Strike 6830 is 50 points above — proximity at that
    // distance is exp(-2500/450) = exp(-5.555...) ≈ 0.00387. That's a
    // ~99.6% gate on the flowConfluence and priceConfirm terms (they
    // multiply through proximity), and ~99.6% on charm too.
    //
    // The composite formula's only non-proximity-gated term is the
    // clarity bias W4 × (clarity - 0.5), which caps at ±0.075. That's
    // well below the MEDIUM threshold of 0.3, so 6830 can never be a
    // MEDIUM or HIGH target no matter how strong its flow looks.
    //
    // Meanwhile a closer strike at 6785 (5 pts above) has proximity
    // ≈ 0.946 — it can still reach MEDIUM/HIGH with moderate flow,
    // even though we deliberately give it WEAKER raw flow than 6830.
    //
    // Key assertion: target is NOT 6830 (a closer, weaker strike wins),
    // AND the proximity scorer computation for 6830 matches the
    // analytic Gaussian exp(-d²/2σ²) with σ = 15 points.
    const snapshots = makeHistory({
      count: 61,
      startUtcIso: '2026-04-08T19:40:00Z',
      spotAt: () => 6780,
      mkRows: (i, spot) => {
        const rows: GexStrikeRow[] = [];
        // The "perfect but far" strike: huge flow, strong charm, big
        // gamma, at 50 points away. Proximity crushes it.
        rows.push(
          makeRow({
            strike: 6830,
            price: spot,
            callGammaOi: 5e6 * Math.pow(1.3, i),
            callGammaVol: 1e5,
            callCharmOi: 5e8,
          }),
        );
        // The "closer but weaker" strike: only 5 pts from spot. Growth
        // is 10% per minute — slower than 6830 — but its proximity is
        // essentially 1.0 so it isn't gated.
        rows.push(
          makeRow({
            strike: 6785,
            price: spot,
            callGammaOi: 1e6 * Math.pow(1.1, i),
            callGammaVol: 1e4,
            callCharmOi: 3e8,
          }),
        );
        // Eight more filler strikes to make a proper universe.
        const peerStrikes = [6760, 6765, 6770, 6775, 6790, 6795, 6800, 6805];
        for (const k of peerStrikes) {
          rows.push(
            makeRow({
              strike: k,
              price: spot,
              callGammaOi: 5e5,
              callGammaVol: 1e3,
            }),
          );
        }
        return rows;
      },
    });

    const result = computeGexTarget(snapshots);

    // The proximity Gaussian for distFromSpot = 50 with σ = 15:
    //   exp(-(50²) / (2 × 15²)) = exp(-2500 / 450) ≈ 0.00387
    // Recompute via the exported scorer to confirm this is what the
    // pipeline actually sees for the far strike.
    const mockFar: MagnetFeatures = {
      strike: 6830,
      spot: 6780,
      distFromSpot: 50,
      gexDollars: 0,
      deltaGex_1m: null,
      deltaGex_5m: null,
      deltaGex_20m: null,
      deltaGex_60m: null,
      callRatio: 0,
      charmNet: 0,
      deltaNet: 0,
      vannaNet: 0,
      minutesAfterNoonCT: 0,
      prevGexDollars: null,
    };
    // The analytic value — this is what the proximity scorer must
    // compute for the far strike, regardless of any other factor.
    expect(proximity(mockFar)).toBeCloseTo(Math.exp(-2500 / 450), 5);
    // It's effectively a veto: less than 1% of a full-credit strike.
    expect(proximity(mockFar)).toBeLessThan(0.01);

    // The picked target should NOT be 6830. A closer strike is chosen
    // as target (or the result is null) even though 6830 has the
    // strongest raw flow and the biggest gamma.
    expect(result.oi.target?.strike).not.toBe(6830);

    // Find 6830 in the leaderboard and sanity-check its score. It may
    // not be in the top 10 at all if other strikes out-rank it by size,
    // but if it's there its finalScore should be small.
    const farEntry = result.oi.leaderboard.find((s) => s.strike === 6830);
    if (farEntry) {
      // Far strike's composite should be tiny — less than the 0.3
      // MEDIUM threshold, regardless of how strong its raw flow looks.
      // The clarity bias alone caps it at ±0.075, and the multiplicative
      // terms are crushed by proximity ≈ 0.004.
      expect(Math.abs(farEntry.finalScore)).toBeLessThan(0.3);
    }
  });
});

// ── Scenario 7 — Three-mode divergence ───────────────────────────────

describe('integration: three-mode divergence', () => {
  it('produces independent OI and VOL targets when the same snapshots favour different column sets', () => {
    // Construct a fixture where:
    //   - Strike 6800 has huge OI gamma that grows quickly → OI target
    //   - Strike 6770 has huge VOL gamma that grows quickly → VOL target
    //   - The directionalized (ask/bid) columns are balanced and flat,
    //     so the DIR mode sees a churning board.
    //
    // The three modes must produce INDEPENDENT results because each
    // reads its own column set in `computeGexDollars`. There must be no
    // cross-contamination: the OI leaderboard cannot be swayed by the
    // VOL columns.
    const snapshots = makeHistory({
      count: 61,
      startUtcIso: '2026-04-08T19:40:00Z',
      spotAt: () => 6780,
      mkRows: (i, spot) => {
        const rows: GexStrikeRow[] = [];
        // 6800 dominates OI, is tiny in VOL.
        rows.push(
          makeRow({
            strike: 6800,
            price: spot,
            callGammaOi: 1e6 * Math.pow(1.3, i),
            callGammaVol: 1,
            // Balanced DIR so DIR mode sees nothing.
            callGammaAsk: 50,
            callGammaBid: 50,
            callCharmOi: 5e8,
          }),
        );
        // 6770 dominates VOL, is tiny in OI.
        rows.push(
          makeRow({
            strike: 6770,
            price: spot,
            callGammaOi: 1,
            callGammaVol: 1e6 * Math.pow(1.3, i),
            callGammaAsk: 50,
            callGammaBid: 50,
            callCharmVol: 5e8,
          }),
        );
        // Filler strikes. Keep them small across all column sets so
        // the leaderboards resolve cleanly.
        const peerStrikes = [
          6755, 6760, 6765, 6775, 6780, 6785, 6790, 6795, 6805,
        ];
        for (const k of peerStrikes) {
          rows.push(
            makeRow({
              strike: k,
              price: spot,
              callGammaOi: 5e5,
              callGammaVol: 5e5,
              callGammaAsk: 10,
              callGammaBid: 10,
            }),
          );
        }
        return rows;
      },
    });

    const result = computeGexTarget(snapshots);

    // OI pipeline reads OI columns only: 6800 dominates.
    expect(result.oi.leaderboard[0]?.strike).toBe(6800);
    // VOL pipeline reads VOL columns only: 6770 dominates.
    expect(result.vol.leaderboard[0]?.strike).toBe(6770);
    // They MUST be different strikes — this is the no-cross-
    // contamination proof.
    expect(result.oi.leaderboard[0]?.strike).not.toBe(
      result.vol.leaderboard[0]?.strike,
    );

    // If the OI target is picked, it's 6800; if VOL target is picked,
    // it's 6770. Either may be null if the composite doesn't clear the
    // LOW threshold, but the leaderboard rank order is the guarantee.
    if (result.oi.target) {
      expect(result.oi.target.strike).toBe(6800);
    }
    if (result.vol.target) {
      expect(result.vol.target.strike).toBe(6770);
    }

    // All three modes return valid TargetScore objects (never throw,
    // never undefined).
    expect(result.oi.leaderboard).toBeDefined();
    expect(result.vol.leaderboard).toBeDefined();
    expect(result.dir.leaderboard).toBeDefined();
  });
});

// ── Scenario 8 — Empty or minimal input ──────────────────────────────

describe('integration: empty and minimal input', () => {
  it('returns three empty TargetScores for an empty snapshot array', () => {
    // The top-level entry point must not throw on empty input — the
    // hook layer calls this before any data is loaded.
    expect(() => computeGexTarget([])).not.toThrow();

    const result = computeGexTarget([]);
    expect(result.oi.target).toBeNull();
    expect(result.vol.target).toBeNull();
    expect(result.dir.target).toBeNull();
    expect(result.oi.leaderboard).toEqual([]);
    expect(result.vol.leaderboard).toEqual([]);
    expect(result.dir.leaderboard).toEqual([]);
  });

  it('returns three empty TargetScores for a single-snapshot history', () => {
    // A single snapshot has no prior, so every horizon is null. The
    // pipeline short-circuits to empty TargetScores because
    // `snapshots.length < 2`.
    const single = [
      makeSnapshot('2026-04-08T19:40:00Z', 6780, [
        makeRow({ strike: 6780, callGammaOi: 1e6 }),
      ]),
    ];

    expect(() => computeGexTarget(single)).not.toThrow();

    const result = computeGexTarget(single);
    expect(result.oi.target).toBeNull();
    expect(result.vol.target).toBeNull();
    expect(result.dir.target).toBeNull();
    expect(result.oi.leaderboard).toEqual([]);
    expect(result.vol.leaderboard).toEqual([]);
    expect(result.dir.leaderboard).toEqual([]);
  });
});
