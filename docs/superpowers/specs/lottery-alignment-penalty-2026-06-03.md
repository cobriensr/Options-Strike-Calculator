# Lottery alignment: hard null-gate → score penalty (2026-06-03)

## Goal

Replace `computeLotteryScoreV2`'s hard null-gate on misaligned fires (flow
direction doesn't confirm the alert → `score = null` → feed renders tier3) with
a misalignment **score penalty**, so the strong-ticker misaligned subset the gate
currently discards can resurface through the existing scoring/inversion-bonus
machinery. Ship behind the existing tier surface — no new UI.

## Evidence (analysis 2026-06-03, read-only, on 471k enriched fires)

Misaligned fires identified exactly via stored `cum_ncp_at_fire` /
`cum_npp_at_fire` (not just null-score). Lottery cares about peak, not win-rate
(see exit-policy work / [[feedback_path_matters_not_endpoint]]):

| cohort | n | win% | peakHit≥50% | peakMean |
|---|---|---|---|---|
| aligned, all (scorer trains on this) | 230,216 | 46.5% | 38.1% | 79.0% |
| misaligned, all | 241,221 | 44.4% | 33.6% | 66.7% |
| misaligned, vol/OI Q5 | 47,750 | 41.8% | 34.6% | 76.4% |
| **misaligned, on good tickers (inv-quintile 4-5)** | **98,663** | 43.9% | **42.0%** | **91.6%** |

Two findings:
1. Misaligned fires on high-inversion-quintile tickers **out-peak aligned fires**
   (42.0% hit≥50 vs 38.1%, peakMean 91.6% vs 79.0%) — a large recoverable subset
   the hard gate throws away.
2. vol/OI shifts the misaligned payoff distribution up (peakMean 55%→76% across
   quintiles) — signal transfers on the peak dimension.

Conclusion: the signal is **ticker-conditional**, so a flat penalty alone is
insufficient — the existing inversion-quintile bonus (+5 for Q5 tickers,
`api/_lib/lottery-inversion-bonus.ts`) is the natural recovery lever. Drop the
hard gate and let misaligned fires flow through scoring with a penalty; the
bonus + vol/OI ranking resurfaces the strong ones.

## Design

`computeLotteryScoreV2` currently:
```
if (!isAligned) return null;           // <-- REMOVE (quality gate)
if (!(dteKey in DTE_WEIGHTS_V2)) return null;  // KEEP (universe gate)
```
Replace the alignment null-gate with an additive misalignment penalty:
```
let score = ...usual feature sum...;
if (!isAligned) score += MISALIGNMENT_PENALTY_V2;   // negative constant
return score;
```
Misaligned fires then tier normally on `qas = combined_score + inversionBonus`
(13/10). The penalty + inversion bonus + vol/OI together decide whether a
misaligned fire reaches tier1/2. The dte-universe null-gate stays.

### Two implementation options (decide before building)

- **Option A — penalty-only (recommended Phase 1, lower risk).** Keep the
  current aligned-trained feature weights; add `MISALIGNMENT_PENALTY_V2` as a
  tuned constant (not a retrained weight). Derive it by sweep (below). Rationale:
  the analysis shows the aligned-derived vol/OI + ticker signal already transfers
  to misaligned fires on peak metrics, so we don't need to refit every weight —
  just calibrate the demotion. Smallest blast radius; aligned fires' scores are
  unchanged.
- **Option B — full retrain on aligned+misaligned.** Retrain `lottery_scoring.py`
  on the combined population with `is_aligned` as a model feature (its fitted
  uplift = the penalty). More principled; lets all feature weights adapt. Larger
  blast radius (aligned fires' scores also move). Hold as Phase 2 only if A's
  validation is weak.

## Penalty derivation (tune-before-ship)

Sweep `MISALIGNMENT_PENALTY_V2 ∈ {0, -1, -2, -3, -5, -8}` (and finer near the
winner). For each, recompute qas + feed tier (13/10) for ALL enriched fires and
require:
1. **Recovered misaligned tier1/2 fires beat tier3 on peak** — the misaligned
   fires that reach tier1/2 under penalty P must have peakHit≥50% and peakMean
   ≥ the aligned tier2 baseline (else we're surfacing noise).
2. **Aligned tiers don't degrade** — aligned tier1/2 outcome separation holds.
3. **Volume sanity** — total tier1/2/day stays in a sane band (don't flood the
   feed; compare to the post-13/10 baseline of ~300/day).
Pick the P that maximizes recovered-subset peak quality subject to (2) and (3).
Walk-forward: derive P on an early window, confirm the recovered subset holds
out-of-sample on a later window (guard against [[feedback_uniform_lift_is_leakage]]).

## Files to create / modify
- `api/_lib/lottery-score-weights-v2.ts` — remove alignment null-gate; add
  `MISALIGNMENT_PENALTY_V2` const + apply in `computeLotteryScoreV2`.
- `api/cron/detect-lottery-fires.ts` — `isAligned` already computed (line ~645);
  it now flows into the penalty instead of nulling. Verify the stored `score` is
  non-null for misaligned post-change (downstream nullability assumptions).
- `ml/output/lottery_score_weights.json` + `ml/src/lottery_scoring.py` — Option A:
  add penalty constant to JSON; Option B: retrain with is_aligned feature.
- `scripts/sync_lottery_score_weights_v2.py` — render the penalty into the TS.
- `scripts/backfill_lottery_scores.py` — re-backfill `score` for historical
  misaligned rows (currently null) so the feed/research see the new scores.
- `api/__tests__/lottery-score-weights-v2.test.ts` — misaligned no longer null;
  penalty applied; dte-universe gate still nulls.
- `api/__tests__/detect-lottery-fires.test.ts` — misaligned insert now carries a
  score (was gated).

## Data dependencies
- `cum_ncp_at_fire`, `cum_npp_at_fire` (stored) — alignment reconstruction. ✓
- `lottery_ticker_stats.inversion_quintile` — recovery lever. ✓
- No new tables/migrations.

## Open questions (defaults noted)
1. **Option A vs B?** Default: A (penalty-only) first; B only if A under-validates.
2. **Backfill historical null scores?** Default: yes — re-backfill so research +
   feed reflect the new scoring; otherwise old misaligned rows stay null/tier3
   and create a train/serve discontinuity.
3. **Direction-gate interaction.** `direction_gated` rows are separately demoted
   to tier3 in the feed — leave that untouched (it's a different signal). Confirm
   no double-counting with misalignment.
4. **Does removing the gate change `countTier1FiresWithin` (cluster bonus, uses
   9/7 on bare score)?** Misaligned fires would now have bare scores ≥9 possible
   → could inflate cluster-bonus tier1 peers. Decide whether cluster-bonus should
   also require alignment.

## Thresholds / constants
- `MISALIGNMENT_PENALTY_V2`: TBD by sweep, candidate range 0…−8 (start near −3).
- Tier cutoffs unchanged: t1=13, t2=10 on qas.
- Validation: recovered tier1/2 peakHit≥50 ≥ aligned-tier2 baseline; aligned
  separation preserved; tier1/2 volume within ~1.5× the ~300/day post-13/10 base.

## Risk
Production scoring change immediately after the 2026-06-03 feed-cutoff fix —
sequence AFTER the feed change has soaked. Re-backfill is large (re-scores ~half
of all historical fires). Validate walk-forward before deploy.
