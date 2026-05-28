# Lottery Finder Rescore — Spec (2026-05-22)

## Goal

Replace the current `lottery_finder_fires.combined_score` calibration with a unified score model trained on the last 90 days of _aligned_ fires, optimizing for `realized_flow_inversion_pct` (with `realized_eod_pct` proxy for fires that never inverted). Fixes the structural bug where mode B fires (53% of volume) can never reach tier1/tier2 by design, and surfaces the strongest feature signals (TOD, vol/OI sweet spot, gamma convexity, DTE 1, low ask_pct) that the current formula either inverts or ignores.

## Background

- Investigation memo: `docs/tmp/lottery-rescore-eda-2026-05-22.md` (read this first — has the data tables and feature-lift rankings)
- Root cause: current `mode_weight = 0` for `B_multi_day_DTE1_3` puts mode B's theoretical max score at 20, below the t2=22 cutoff. **0 of 345,111 mode B fires have ever reached tier2 in entire table history.**
- 90-day aligned sample: 156,896 fires (after exclusions). Aligned-mode-B is the highest-EV segment in the dataset (51% win rate, 26% hit_25) while currently scoring 0 base points from mode_weight.

## Locked-in decisions (from walkthrough)

| #   | Decision                                                | Implication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Single unified score**                                | Mode/DTE are features in one global score. One leaderboard. Uniform cutoffs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **NULL outcome → eod proxy**                            | Training outcome column = `COALESCE(realized_flow_inversion_pct, realized_eod_pct)`. Recovers the 23% "never inverted" fires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Drop reload_tagged from scoring**                     | Stays as a UI badge (`feat(lottery)` commits already shipped). Zero score weight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | **Defer ETF UI**                                        | Ticker weights handle IWM/SLV/USO naturally (negative coefficients). Revisit toggle/separation after a week of new-score data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5   | **Linear weights (bucket-encoded), GBM only if weak**   | Phase 1 ships linear per-feature uplift. Escalate to GBM only if Phase 7 ranking quality fails. Matches existing TS sync pipeline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Alignment is a hard gate**                            | Misaligned fires get score = 0 / NULL — written to DB by cron but never surface in scored leaderboard. Consistent with flow_inversion outcome metric.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | **Audit inferred_structure outliers FIRST (blocks v1)** | Phase 0 audit script `scripts/audit-inferred-structure-outliers.mjs` shipped. **Verdict (2026-05-22): DROP from v1.** 100/100 sampled outlier rows have `flow_inversion_pct > peak_ceiling_pct`, mathematically impossible. Bug confirmed structure-tagged-only: 35.24% of structure rows have flow_inv>peak vs 0.50% of non-structure rows. Bulk of training data (429k non-structure) is clean. Structure-specific enrichment bug filed as separate follow-up — does NOT block this rescore project. v1 trains on non-structure rows only; structure can be re-added in v2 after enrichment fix. See `docs/tmp/inferred-structure-audit-2026-05-22.md` for the full audit report. |
| 8   | **Daily retrain via existing `make update`**            | New model plugs into the existing nightly pipeline (`make refit` is already part of `make update`). No new automation infra. Revisit cadence later if weight churn becomes an issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Feature plan (from EDA findings)

Ordered by lift concentration. All features computed at trigger time.

| Feature                      | Treatment                                                                     | Notes                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **alignment_at_entry**       | Hard gate (multiplier 0 or 1, or use as binary feature with very high weight) | Misaligned fires can still be detected but should not surface as scorable. Aligned = call+ncp>npp OR put+npp>ncp.                           |
| **tod**                      | 4-level weight: AM_open ≫ MID > LUNCH ≈ PM                                    | AM_open is 2.4× PM on mean and 2.2× on hit_25.                                                                                              |
| **dte**                      | DTE 1 highest, DTE 3 second, DTE 0 ≈ DTE 2                                    | DTE 1 mean 89 vs DTE 0 mean 59 — inverts current mode_weight.                                                                               |
| **vol_oi_quintile**          | Bucket-shaped (Q3 max, taper to Q1 and Q5)                                    | Sweet spot 0.10-0.15. Current `>=0.5` bonus is in Q5 (worst hit_25).                                                                        |
| **gamma_quintile**           | Monotonic-increasing weight                                                   | Q4 (0.041-0.066) gets the biggest bonus. Current `>=0.025` cutoff is too low.                                                               |
| **trigger_ask_pct_quintile** | Monotonic-decreasing weight                                                   | NEW feature. Q1 (0.52-0.53, near mid) = 108 mean vs Q5 (0.74-1.00) = 28.                                                                    |
| **option_type**              | Larger call bonus                                                             | C: 65 mean / 51% win; P: 50 mean / 40% win. Bump from +2 to +4 or model-derived.                                                            |
| **ticker_weight**            | From observed mean × win-rate                                                 | IWM/SLV/USO get negative coefficients. QQQ/SPY/AMZN/MSFT/SNDK/GOOGL get strong positive.                                                    |
| **inferred_structure**       | Bonus (median-derived, NOT mean)                                              | strangle/risk_reversal/isolated_leg/vertical median 17-59 vs null -3. Add a +N bonus where N comes from median uplift, not the 3,900% mean. |

### Features explicitly dropped from scoring

- `reload_tagged` (per decision 3 — UI only)
- `range_pos_at_trigger` (no lift across quintiles)
- `cheap_call_pm_tagged` (high-variance lottery profile, not pure edge — keep as UI filter)

### Features deferred / TBD

- `mkt_tide_*`, `spx_spot_gamma_*` regime features (not analyzed in this EDA round; defer to v2)
- `trigger_iv` (inverted-U with Q5 outliers — needs IV outlier capping before usable; defer)

## Phases

Each phase is independently shippable. Verification gate at the end of each.

### Phase 0 — Outcome view + data quality + structure audit (3-4h)

Establish the training-data substrate AND resolve the structure-outlier data quality question (per decision 7 — audit blocks v1).

**Files:**

- `api/_lib/db-migrations.ts` — add migration `lottery_finder_fires_outcome_view`:
  ```sql
  CREATE OR REPLACE VIEW lottery_finder_fires_with_outcome AS
  SELECT *,
    COALESCE(realized_flow_inversion_pct, realized_eod_pct) AS outcome_pct,
    ((option_type = 'C' AND cum_ncp_at_fire > cum_npp_at_fire)
     OR (option_type = 'P' AND cum_npp_at_fire > cum_ncp_at_fire)) AS is_aligned
  FROM lottery_finder_fires;
  ```
- `api/__tests__/db.test.ts` — append migration id to mock + update expected SQL call count
- `scripts/audit-inferred-structure-outliers.mjs` — NEW. Pulls the top-100 p99+ structure-tagged rows, joins entry/peak/expiry prices, computes the math step-by-step, flags rows where:
  - `realized_flow_inversion_pct > 1000` AND `peak_ceiling_pct < 200` (suspicious — flow_inv > peak shouldn't happen)
  - `entry_price < 0.10` (deep-OTM cheapie — legitimate huge % gains possible)
  - `option went to 0 then came back` (data weirdness)

**Data quality validations (one-shot, included with audit script):**

- Verify >99% coalesce coverage on last 90 days
- Cap `trigger_iv > 5.0` (data error guard) — flag rows for inspection
- Cap `trigger_vol_to_oi_window > 50` (fat-finger guard) — flag for inspection

**Verify:**

- View exists, returns expected shape; `outcome_pct` null rate <1% over 90 days
- Structure audit script run; produces `docs/tmp/inferred-structure-audit-2026-05-22.md` with verdict: (a) outliers legitimate → include in v1 model with median-derived weight, OR (b) outliers data errors → drop from v1, file separate bug for enrichment fix

### Phase 1 — Train new model (2-3h, Python in `ml/`)

**Files:**

- `ml/src/lottery_scoring.py` — rewrite to:
  1. Query `lottery_finder_fires_with_outcome` for last 90 days, aligned only
  2. Compute feature buckets (quintiles for continuous, raw for categorical)
  3. Fit ranking model — start simple: per-feature mean uplift weights normalized to integer 0-10 scale (matches current weight magnitudes)
  4. Output `lottery_score_weights.json` to `ml/output/`

**Verify:**

- Weights file generated with the 9 features above
- Spot-check: TOD weights show AM_open > PM
- Spot-check: DTE 1 weight > DTE 0 weight

### Phase 2 — Sync to TypeScript (1h)

**Files:**

- `scripts/sync_lottery_score_weights.py` — extend to emit the new schema (currently only handles ticker + mode + price + tod + option_type)
- `api/_lib/lottery-score-weights.ts` — gets rewritten by the sync script with new weights structure

**Verify:**

- `npm run lint` passes on the regenerated TS file
- The TS exports match what `lottery-finder.ts` expects (probably need to update the consumer in Phase 3)

### Phase 3 — Cron writer integration (3-4h)

**Files:**

- `api/cron/detect-lottery-fires.ts` — update `computeLotteryScore()` to:
  - Compute `is_aligned` flag (using cum_ncp/npp_at_fire)
  - Bucket continuous features into quintiles using thresholds emitted by Phase 1
  - Apply new weights
- `api/__tests__/detect-lottery-fires.test.ts` — update fixtures + assertions for new score formula

**Verify:**

- All cron tests pass
- A representative live fire scores within ±2 points of the expected score for its features

### Phase 4 — Backfill historical scores (1-2h)

**Files:**

- `scripts/backfill_lottery_scores.py` — already exists; verify it reuses the same `computeLotteryScore()` path (extract to shared module if not)

**Verify:**

- All 644k historical rows have updated `score` and `combined_score`
- Spot-check: 2026-05-21 now has at least one tier2+ fire (proves the structural fix works)
- Score distribution mean/median sanity vs Phase 1 training distribution

### Phase 5 — Re-derive tier cutoffs (1h)

**Files:**

- `ml/src/lottery_scoring.py` (or new script `ml/src/derive_tier_cutoffs.py`) — compute t1/t2 as percentiles of the post-backfill distribution
- `api/_lib/lottery-finder.ts` or wherever the cutoff constants live — replace `t1=24, t2=22`
- `docs/superpowers/specs/lottery-rescore-2026-05-22.md` (this file) — record final cutoffs

**Suggested cutoff method:** t1 = top 5% of last-30-day aligned distribution, t2 = top 15%. Avoids re-tuning every time the model retrains.

**Verify:**

- Both modes produce tier1 fires in the last 14 days
- ~5-15 tier1 + 15-40 tier2 per day on average (sanity vs current ~52/day per old calibration)

### Phase 6 — Observability (1h)

**Files:**

- `api/cron/detect-lottery-fires.ts` — add structured log on each run with `{tier1_count, tier2_count, tier3_count, total_fires}`
- `api/_lib/sentry.ts` (or wherever metrics live) — emit `lottery.fires.tier_count{tier=N}` daily aggregate
- New Sentry alert: `lottery_tier1_zero_streak` — fires if no tier1+ fires for 3 consecutive trading days (catches future calibration drift the way 5/19 + 5/21 would have)

**Verify:**

- Logs visible in Vercel dashboard
- Sentry alert configured + can be triggered in staging via manual deletion of a day's fires

### Phase 7 — Validation (final, ALWAYS LAST)

- `npm run review` — full pipeline must pass (tsc + eslint + prettier + vitest --coverage)
- Replay 5 known-good and 2 known-bad days; verify ranking matches intuition
- Side-by-side compare: top-20 fires under old vs new score for last 5 days; confirm new ranking favors aligned + AM + DTE-1 + Q3-vol-OI + Q4-gamma + low-ask_pct
- Add row to `docs/tmp/lottery-tracking.csv` recording the rescore-cutover date

## Data dependencies

- `lottery_finder_fires` table — exists, 644k rows
- `realized_flow_inversion_pct` — 77% populated (EDA verified)
- `realized_eod_pct` — 99.96% populated on NULL-flow-inversion subset
- `cum_ncp_at_fire`, `cum_npp_at_fire` — 78.6% populated (rest excluded from alignment scoring)
- New view: `lottery_finder_fires_with_outcome` (Phase 0)
- ML pipeline venv: `ml/.venv/bin/python` (existing)

## Coordination with parallel session

Recent commits and current uncommitted state from the parallel Claude session touch files this spec will modify:

- `d67ac753 fix(lottery): batch detect-lottery-fires ticks query under Neon 64MB cap` — touched `detect-lottery-fires.ts` (Phase 3 file)
- `5ffe3c95 feat(lottery,silent-boom): "was ✦" past-conviction pill` — touched UI components only
- Currently M: `api/_lib/lottery-score-weights.ts` (Phase 2 file), `api/_lib/periscope-analyzer-rules.ts` (unrelated)

**Strategy:** wait for parallel session's lottery work to commit cleanly before starting Phase 2/3. Phase 0-1 (Python + DB) are independent of parallel session work and can start immediately. Use a git worktree for Phase 2-3 if parallel work continues active.

## Open questions

_All resolved during walkthrough — see decisions 5-8 in the locked-in table above._

Open items remaining (genuinely undecided, will surface during implementation):

1. **Bucket thresholds for quintile features** — vol/OI, gamma, ask_pct, IV use fixed quintile boundaries derived from the training set. If the underlying distribution shifts, the bucket meanings drift. Acceptable for v1 since retraining is nightly (decision 8) — quintile boundaries re-derive every night with the rest of the model. Flagged for monitoring in Phase 6.
2. **Cutoff method** — t1=top 5% / t2=top 15% of last-30-day aligned distribution is the working default for Phase 5. Could instead use fixed-score thresholds (cleaner UX, but stale faster). Decide after seeing Phase 4 backfill distribution shape.

## Thresholds / constants (TBD until Phase 1)

These will be filled in by Phase 1 model training:

- TOD weights (4 buckets, target range 0-8)
- DTE weights (4 buckets, target range -2 to +8)
- Vol/OI quintile weights (5 buckets, target range -2 to +5)
- Gamma quintile weights (5 buckets, target range 0-6)
- Ask_pct quintile weights (5 buckets, target range -3 to +5)
- Option type C bonus (target +4 to +6)
- Ticker weights (per-ticker, target range -5 to +10)
- Inferred structure bonuses (median-derived; target +3 to +6)
- Tier cutoffs (Phase 5; target t1=top 5%, t2=top 15%)

## Done when

- 2026-05-21 (the original failure case) shows at least one tier2+ fire in the UI
- Mode B fires appear in tier1+ at expected rates (~30-50% of tier1+ given mode B is 53% of volume and aligned mode B is highest-EV segment)
- `npm run review` passes
- Sentry alert configured for `lottery_tier1_zero_streak`
- This spec doc is moved to a "shipped" state with final cutoffs recorded

## Out of scope

- `mkt_tide_*` regime features (v2)
- `trigger_iv` (needs data quality fix first)
- Index/ETF UI separation (deferred per decision 4)
- Rescoring `periscope_lottery_fires` table (different system, separate spec)
- Silent Boom / other alert systems (unrelated)
