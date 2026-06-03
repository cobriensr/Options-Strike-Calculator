# Lottery feed tier recalibration + monitor coupling (2026-06-03)

## Goal

Fix a verified production bug: the Lottery Finder feed has shown **0 tier1 / 0
tier2 for weeks** because its tier cutoffs (24/22) are on a score scale the
current V2 score can't reach — and recouple the cron's tier monitor to the feed
so this class of bug can't hide again.

## Diagnosis (verified against source + DB)

- Feed tiers on `qas = combined_score + inversionBonus` with cutoffs
  **tier1 ≥ 24 / tier2 ≥ 22** (`api/_lib/lottery-tier.ts` `TIER_CUTOFFS_V2`,
  last set 2026-05-20, calibrated on the *old* combined_score scale).
- Phase 3 (2026-05-22) switched the `score` column to bare `computeLotteryScoreV2`
  (a 9/7-scale score, max ~17). Nobody recalibrated the feed cutoffs.
- `combined_score` (generated) = `GREATEST(0, score + round_trip_deduct +
  fire_count_adj + gammaCase)`. Inversion bonus ∈ [-5, +5]. So max observed
  `qas` over 30 days = **22**; p95 = 13, p85 = 10. tier1 (≥24) is mathematically
  impossible; tier2 (≥22) near-impossible.
- Why it hid: the cron's "zero tier1 for 3 days" Sentry alert buckets with
  `LOTTERY_TIER_THRESHOLDS_V2` (9/7) on the **bare** score (different logic than
  the feed), so it saw ~159 tier1/day and never fired.
- The score itself works: among scored fires, score≥7 wins 56.8% / peak-hit≥50%
  47.4% vs score<0 at 41.2% / 35.4%. The signal exists; only the badge math is broken.

## Chosen cutoffs

`qas` percentile-derived (matches the Python training's 95th/85th philosophy),
validated on 230,216 enriched fires:

| cutoffs | tier1 | tier2 | tier1 win / hit≥50 |
|---|---|---|---|
| **t1≥13 / t2≥10** (chosen) | 4.5% | 7.5% | 59.8% / 54.8% |

Monotonic separation confirmed; restores ~300 tier1/2 alerts/day (vs 0 today).

## Phases

### Phase 1 — recalibrate feed cutoffs (the bug fix)
- `api/_lib/lottery-tier.ts`: `TIER_CUTOFFS_V2` 24/22 → **13/10**.
- `api/__tests__/lottery-tier.test.ts`: update the "locked cutoffs" assertion.
- `api/__tests__/lottery-finder-endpoint.test.ts`: the two round-trip-deduct
  demotion tests encode the old arithmetic — rewrite fixtures to demonstrate
  valid transitions under 13/10 (a −3 deduct can move at most one tier;
  tier1→tier3 in one −3 step is no longer arithmetically possible). Update the
  `< 22` comment on the floor test.

### Phase 2 — recouple the cron tier monitor
- `api/cron/detect-lottery-fires.ts`: after the insert loop, run one summary
  query computing the **exact feed tier distribution** for today's fires —
  `qas = combined_score + inversionBonus(s.inversion_quintile)`, tiered with the
  shared `TIER_CUTOFFS_V2`, `direction_gated → tier3`, `score IS NULL → gated`.
  Log `feedTier1/feedTier2/feedTier3`; repoint the Sentry alert comment to
  `feedTier1:0`. Keep the existing bare-score `insertedTier*` as raw insert
  diagnostics. Import cutoffs from `lottery-tier.ts` so monitor + feed can never
  silently diverge again.
- `api/__tests__/detect-lottery-fires.test.ts`: the suite asserts SQL call
  counts — update the mock sequence + counts for the added summary query.

## Out of scope (flagged, not changed)
- `LOTTERY_TIER_THRESHOLDS_V2` (9/7) still drives the V2.2 cluster-bonus logic
  (`countTier1FiresWithin`) — an internal scoring mechanism, not a display tier.
  Left untouched; changing it would alter scoring.
- The alignment hard-null gate (53% of fires → null → tier3). Real but modest
  signal; revisit as a score penalty vs gate (needs retrain). Separate work.
- `feature_audit.py` 18/12 thresholds (research script) — fix after the feed
  tiering is settled so it mirrors production.

## Thresholds / constants
- Feed tier cutoffs: t1 = 13, t2 = 10 (on qas).
- Inversion bonus: {1:-5, 2:-2, 3:0, 4:+3, 5:+5}, NULL→0 (unchanged).
