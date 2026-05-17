---
status: Likely Shipped
date: 2026-05-09
---

# Periscope Data Product — Phase plan for items 1-9

**Date:** 2026-05-09 (decisions locked + bug fixes 2026-05-10; auto-playbook re-review 2026-05-10 PM)
**Status:** spec ready, post-auto-playbook re-review applied. Phases 0 and 8 downscoped to "thin wiring on top of already-shipped infra"; Phase 4 reframed as a Claude-vs-ML comparison study; Phase 5 (data-product, lottery) renamed to disambiguate from auto-playbook spec's separately-numbered Phase 5 (historical backfill).
**Backfill scope (informs power of all phases):** 2025-11-10 → 2026-05-08 — actual delivery: **122 trading days, 2,035,982 rows** in `periscope_snapshots`. (Spec originally estimated ~125 days; 3 days dropped: 2025-11-11, 11-13, 11-17.) After RTH-gate + 10-min dedup (see Thresholds section), usable canonical slots ≈ 122 × 40 = 4,880. Plus SPX 1-min from `index_candles_1m` and ES/NQ 1-min from sidecar's Databento tables.

## Goal

Turn the new Periscope historical dataset into a stack of trading signals layered on top of the existing app. Each phase is a discrete signal/feature with measurable trading impact for 0DTE SPX directional + opportunistic credit spreads. Phases are sequenced so each builds on existing infrastructure (no new model framework, no new embedding pipeline) — extending `embeddings.ts`, the ML pipeline at `ml/`, the lottery + analyze stacks, **and the auto-playbook chat-runner that already lives at `api/_lib/periscope-chat-runner.ts`**.

## Foundation already shipped (post auto-playbook deploy, 2026-05-10)

The auto-playbook spec (`docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md`) shipped on 2026-05-10 and now generates a structured Claude playbook at every 10-min RTH slot (08:20–14:50 CT). That delivers, **for free**, several pieces the original data-product spec planned to build:

- **Slot embeddings** — `periscope_analyses.analysis_embedding` (vector, HNSW index) populated by `buildEmbeddingBestEffort` in `periscope-chat-runner.ts`. Wraps `buildPeriscopeSummary` (structural — spot, cone, regime, triggers, key levels). Same embedding space as the query side. **Phase 0 of this spec is no longer needed** — see below.
- **Analog retrieval** — `buildRetrievalBlock` + `fetchSimilarPastReads` in `api/_lib/periscope-retrieval.ts`. Top-K=3 cosine, 0.3 similarity floor, gold-star exclusion, `realized_r` + `realized_trigger_fired` enrichment. Already wired into the auto-playbook prompt. **Phase 8 of this spec downscopes** to "extend the same block to `api/analyze.ts`" — see Phase 8.
- **Claude-derived structured fields** on every auto-playbook row: `regime_tag`, `bias`, `cone_lower`, `cone_upper`, `long_trigger`, `short_trigger`, `key_levels` (jsonb), `panel_payload` (jsonb), `expected_dealer_behavior`, `confidence`, `futures_plan`. Available as features OR as labels for any phase that wants them. **Phase 4 reframes** around comparing Claude's `regime_tag` vs an ML classifier's prediction.
- **Realized-outcome enrichment** — `realized_r`, `realized_trigger_fired`, `realized_max_favorable_pts`, `realized_max_adverse_pts` populated by `ml/src/compute_realized_outcomes.py`. Every analog comes pre-tagged with "+0.6R, long_winner" for retrieval blocks.
- **Operational primitives** — `status` lifecycle (`in_progress` → `complete` | `failed` | `truncated`), `failure_reason`, `AUTO_PLAYBOOK_ENABLED` kill switch, two-phase persistence via `waitUntil`. Phases that depend on auto-playbook output should filter on `status='complete'`.

**Historical analog corpus is the gating cost.** For Phase 8 / Phase 4-comparison / Phase 9 to work against historical analogs (not just live forward firings), the dormant auto-playbook Phase 5 backfill (`scripts/backfill-periscope-playbooks.mjs`) must be run. Cost: **~$440 cached / ~$930 uncached one-time, ~6-12 hours overnight**. Decision deferred — Phases 1, 2, 3, 5-Lottery, 6, 7 all run on raw `periscope_snapshots` and don't need the corpus. The Claude-comparison + retrieval phases (4, 8, 9) DO need it.

## Phase ordering rationale

```text
        ┌──────────┬─────────────────┬──────────┬──────────┐
        ▼          ▼                 ▼          ▼          ▼
    PHASE 1   PHASE 2            PHASE 3   PHASE 7   PHASE 6
    (pin      (charm-drift)      (cone     (diverg-  (DP→
     pred)                        breach)   ence)     periscope)
        │          │                 │          │
        └──────────┴────┬────────────┘          │
                        ▼                       │
                  PHASE 5-Lottery               │
                  (lottery MM tag)              │
                        │                       │
                        └─────────┬─────────────┘
                                  ▼
                  PHASE 4 (Claude vs ML regime study)  ◀─ needs analog corpus
                                  │
                                  ▼
                  PHASE 8 (retrieval → analyze.ts)     ◀─ needs analog corpus
                                  │
                                  ▼
                  PHASE 9 (intraday ML predictor)      ◀─ needs analog corpus
                            (capstone)
```

Phases 1, 2, 3, 7, 6, 5-Lottery are pure research on raw `periscope_snapshots` — each can run as an isolated ml-pipeline-analyst subagent. Phase 4 is now a comparison rather than a green-field build, but still depends on a labeled training set + Claude regime tags from the analog corpus. Phase 8 is a small wiring change. Phase 9 remains the capstone.

## Open questions — locked decisions

- **Train/test split** (locked 2026-05-10): reserve the **most recent 20-30 trading days as an untouched hold-out** that no phase trains on or peeks at — Phase 9 will validate against it months from now. Remaining ~95-100 days run **walk-forward CV with 80-train / 20-test rolling 4-week windows** (~3 folds). Random K-fold is forbidden — temporal leakage would invalidate every signal.
- **Significance threshold** (locked 2026-05-10): a signal ships to production only if **median absolute effect ≥ 1.0 SPX point AND the phase-appropriate test is significant at α=0.05**. Per-phase tests:
  - Phases 1, 2, 3, 7 (continuous outcomes, fat-tailed) → **Wilcoxon signed-rank** (not t-test — tape distributions are non-normal)
  - Phase 5-Lottery (binary lottery hit/miss) → **Fisher exact** for small buckets, chi-square for large
  - Phases 4, 9 (predictors) → out-of-sample **R² + Sharpe**, not p-value alone
- **Kill criterion** (locked 2026-05-10): if median absolute effect **< 0.5 SPX point** OR significance test p > 0.10 on the most-powered test, the phase ships **only as research notes** (committed to `docs/superpowers/specs/`), no production wiring, no panel chip, no analyze block.
- **Live integration boundary** (locked 2026-05-10):
  - **UI panel**: binary or single-number signals — regime label, pin-distance estimate, divergence flag. User glances and decides.
  - **Analyze prompt block**: distributions, conditional probabilities, comparative analogs (Phase 8 retrieval). Claude weighs these in context.
  - **Both**: Phase 4 regime label (panel chip + analyze framing); Phase 9 prediction (panel dial + analyze numeric).

## Thresholds / constants

- **Slot embedding text length**: governed by `buildPeriscopeSummary` in `api/_lib/periscope-db.ts` (~200-300 tokens — cone summary + top-5 +γ strikes + top-5 charm + tally + sign-flip count + breach state). Used both as embedding input on insert (`buildEmbeddingBestEffort`) and as query text on retrieval (`buildRetrievalBlock`). Same builder both sides — embedding spaces stay aligned.
- **Retrieval K**: K=3 in production (`TOP_K` constant in `api/_lib/periscope-retrieval.ts`). Locked — tighter retrieval keeps prompt size down, and 3 analogs above the 0.3 cosine floor is enough grounding for Claude. Revisit only if analog quality drops noticeably after the auto-playbook Phase 5 backfill expands the corpus.
- **Pin window for #1 (pin prediction)**: 13:00 CT signal slot → 15:00 CT close as outcome
- **Charm-window slot for #2 (charm drift)**: 13:00 CT ± 1 slot (per skill convention)
- **Cone breach lookback**: include all breaches in 6-month window
- **ML predictor target horizons (Phase 9)**: 30, 60, 90 min forward. Locked — matches the 0DTE trading window (every horizon fits inside the same session for slots before ~13:30 CT). Longer horizons would dilute the training target without trading benefit since the user is 0DTE-only.
- **Ensemble weight cap on lottery score (Phase 5-Lottery)**: ±10pp adjustment, matches existing memory feedback for "earnings_this_week"
- **Snapshot dedup + RTH gate** (applies to ALL phases): every query against `periscope_snapshots` MUST (a) restrict to RTH `08:30–15:00 CT` and (b) collapse to one canonical row per `(date_trunc('10 minutes', captured_at), expiry, panel, strike)` bucket. When two `captured_at` values fall in the same bucket, prefer the live-ticker capture (`:48-49` second mark) over the backfill capture (`:00` second mark) — backfill was the bootstrap; live is the production source. SQL pattern: `SELECT DISTINCT ON (10min_bucket, expiry, panel, strike) … ORDER BY 10min_bucket, expiry, panel, strike, EXTRACT(SECOND FROM captured_at) DESC`.

---

## Phase 0 — Pre-flight (superseded by auto-playbook)

**Original plan**: build a separate `periscope_slot_embeddings` table + HNSW index + hourly embedding cron + one-shot backfill, costing ~$0.65 one-time + ~$0.05/day ongoing.

**Why deleted**: the auto-playbook (deployed 2026-05-10) already populates `periscope_analyses.analysis_embedding` (vector, HNSW index, same OpenAI text-embedding-3-large encoder) at every 10-min RTH slot. Both sides of the cosine comparison live in the same embedding space — `buildEmbeddingBestEffort` and `buildRetrievalBlock` both use `buildPeriscopeSummary` as the text source. A second embeddings table would be pure duplication.

**What this phase is now**: a 30-minute pre-flight check before kicking off Phases 4/8/9.

**Pre-flight checklist:**

1. Confirm `periscope_analyses.analysis_embedding` is populated for live slots: `SELECT COUNT(*) FROM periscope_analyses WHERE auto_generated AND analysis_embedding IS NOT NULL AND created_at > NOW() - INTERVAL '7 days';` — expect non-zero after Monday open.
2. Confirm the retrieval path returns analogs: hit `buildRetrievalBlock({mode: 'intraday', queryText: 'sample summary'})` from a one-off script and verify K rows back.
3. **Decide on the historical analog corpus**: run `scripts/backfill-periscope-playbooks.mjs --dry-run` to confirm the cost estimate, then either commit to the full ~$440-930 backfill OR proceed with live-only data (Phases 4/8/9 will improve weekly as fresh playbooks accumulate).

**No files to create or migrate.** This phase is a procedural gate, not engineering work.

---

## Phase 1 — Pin-strike prediction backtest

Validates whether the largest +γ strike near spot at 13:00 CT predicts the 15:00 close, with quantifiable distribution.

**Files to create:**

- `ml/src/periscope/pin_prediction.py`:
  - For each historical day, compute: predicted_pin = strike with max +γ within ±20 of spot at 13:00 CT slot
  - actual_close = SPX close at 15:00:00 CT (from `index_candles_1m`)
  - Distribution of |predicted_pin - actual_close| across all days
  - Conditional on: cone width, breach state, day-of-week, charm tally sign
- `ml/plots/periscope/pin_prediction.png` — distribution plot, miss-distance vs. day, conditional buckets
- Final report: `docs/tmp/periscope-pin-prediction-report-{date}.md` with median miss, 80th percentile, recommended condor wing distance

**Trading deliverable:** a single number (or 5 conditional numbers) the user uses to size iron condor wings every afternoon. Example output: "median pin-miss is 4.2 SPX points; 80th percentile is 11.5 points; recommend 12-point wings for 80% baseline win rate."

**Effort:** 1-2 days. Pure SQL + Python.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 2 — Charm-window EoD drift validation

Validates the periscope skill's claim: charm-zero strike position relative to spot at 13:00 CT predicts 13:00→15:00 close direction.

**Files to create:**

- `ml/src/periscope/charm_drift.py`:
  - For each historical day, compute charm-zero strike at 13:00 CT (using same algorithm as `periscope-format.ts:fetchCharmZeroStrike` — first cumulative sign change within ±100)
  - charm_above_spot = charm-zero > spot
  - move_to_close = SPX close at 15:00 - SPX close at 13:00
  - Group: charm-above (expect drift up) vs. charm-below (expect drift down)
  - Compute hit rate, mean / median move, Wilcoxon test (per locked Decisions threshold)
  - **Multi-instrument output**: every SPX point estimate is also reported in **ES futures points** (1:1 modulo basis — pull the live basis from sidecar's ES front-month minute bars) AND **NQ futures points** (multiply by trailing 30-day rolling β between SPX 1-min returns and NQ front-month 1-min returns from sidecar's `futures_bars_1m`). This matches the user's actual hedge instruments — SPX bias is unactionable for an NQ-futures trader without the conversion.
- Conditional on: cone breach state, charm tally magnitude, time-of-day (charm window peak is 13:00-14:30)
- `docs/tmp/periscope-charm-drift-report-{date}.md`

**Trading deliverable:** if hit rate ≥ 60% AND median move > 1 SPX point, this is a clean afternoon directional setup. Output spec: an alert that fires at 13:00 CT showing **all three instrument targets** (e.g. "expected drift +3.2 SPX / +3.2 ES / +14.5 NQ by 15:00, hit rate 0.64, n=78"), plus a position-sizing recommendation per instrument.

**Effort:** 1-2 days.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 3 — Cone breach extension distribution

For each historical cone breach event, compute the move from breach time to close. Bucket by:

- Direction (upper / lower)
- Time-of-day (morning / midday / afternoon)
- Adjacent +γ ceiling/floor strength
- Charm tally sign

**Files to create:**

- `ml/src/periscope/cone_breach_extension.py`
- `ml/plots/periscope/cone_breach_buckets.png`
- `docs/tmp/periscope-cone-breach-report-{date}.md`

**Trading deliverable:** a bucketed lookup table that says "given an upper-cone breach at 9:30 with +γ ceiling at +X pts above spot, expected R:R is N at Y SPX points." Use this for chase decisions on live breaches.

**Effort:** 1-2 days.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 4 — Regime classifier comparison study (Claude vs ML vs ground truth)

Original plan was to train an ML regime classifier and ship its label as a panel chip. With the auto-playbook live, every `pre_trade` row already has Claude's regime tag in `periscope_analyses.regime_tag` (categorical: `pin` / `drift-and-cap` / `cone-breach-up` / `cone-breach-down` / `chop` / etc.). The interesting question is now: **does an ML classifier beat Claude's prospective tag?** If yes, productionize the ML chip. If no, skip the chip — Claude's regime IS the regime label.

**Three-way comparison:**

1. **Claude's prospective `regime_tag`** at the `pre_trade` slot (08:20–08:30 CT auto-playbook output)
2. **ML classifier prediction** trained on first-slot structural features
3. **Ground truth** derived from EoD price action (cone breach state, close vs. 13:00 spot, intraday max-favorable / max-adverse)

**Files to create:**

- `ml/src/periscope/regime_ground_truth.py`:
  - For each historical day, compute the "actual" regime from `index_candles_1m` + `cone_breach_events`. Same labels Claude produces.
  - Output: `ml/data/periscope_regime_labels.parquet` keyed by trading_date.
- `ml/src/periscope/regime_classifier.py`:
  - Features (X): cone width, asymmetry, dominant +γ above/below in ±50, charm tally sign, top |charm| magnitude, vanna concentration — computed from `periscope_snapshots` at 08:20 CT slot
  - Target (y): the ground-truth label from `regime_ground_truth.py`
  - Models: logistic regression baseline, gradient boosting, calibrated random forest
  - Evaluation: walk-forward CV, confusion matrix, per-class precision/recall
- `ml/src/periscope/regime_comparison.py`:
  - Joins Claude's `regime_tag` (pre_trade rows from `periscope_analyses`) with ML predictions and ground truth
  - Reports: per-label precision/recall for Claude vs ML; agreement rate; cases where each beats the other
  - Plots: confusion matrices for both, calibration curves
- `docs/tmp/periscope-regime-comparison-{date}.md`

**Conditional production wiring** (only if ML beats Claude on out-of-sample accuracy by ≥5 percentage points OR is meaningfully better-calibrated):

- `api/_lib/periscope-regime-classifier.ts` — runtime scoring endpoint
- `api/_lib/periscope-format.ts` — surface ML chip alongside or in place of Claude's tag

**Trading deliverable:**

- **If ML wins**: a single chip on the panel at 08:30 CT — "ML: PIN (0.72) · Claude: drift-and-cap" — disagreement is a useful signal in itself.
- **If Claude wins**: confirms the auto-playbook is doing the job; no panel change. Ship the comparison report so future Claude model upgrades can be re-evaluated against the same baseline.

**Effort:** 4-5 days (ground-truth labels + classifier training + comparison + optional wiring).

**Subagent suitability:** ✅ ml-pipeline-analyst for ground-truth + classifier + comparison; manual integration only if production wiring is justified.

**Dependency:** historical analog corpus (auto-playbook Phase 5 backfill) populates Claude's `regime_tag` for the 122-day window. Without it, this phase only has live-forward Claude tags (~5/week).

---

## Phase 5-Lottery — MM-tailwind/headwind tag for Lottery + Silent Boom

> **Naming note:** the auto-playbook spec (`periscope-auto-playbook-2026-05-10.md`) also has a "Phase 5" — the historical playbook backfill script. To avoid ambiguity, this spec's Phase 5 is referred to as **Phase 5-Lottery** throughout this document and the execution plan below. The auto-playbook's Phase 5 is referenced as "auto-playbook Phase 5 backfill" or "the dormant backfill script."

Cross-table feature: for each historical **lottery_finder_fire AND silent_boom_fire**, look up the Periscope state at fire time and tag it. Both alert systems share the same MM-tailwind question — does dealer gamma topology support or fight the alert direction? — so the analysis runs once and the production hook lands in two places.

**Files to create:**

- `ml/src/periscope/lottery_mm_tailwind.py`:
  - Join `lottery_finder_fires` AND `silent_boom_fires` to nearest periscope_snapshots slot (same windowing logic for both — 10-min slot bucketing + RTH gate per the dedup convention)
  - Compute "MM tailwind score": tailwind=+1 if periscope's near-spot +γ topology supports the alert direction, headwind=-1 if opposes, neutral=0
  - Backtest: win rate by tailwind bucket, **stratified by alert source** (lottery vs silent boom). The MM-tailwind effect may be different magnitudes between the two — silent boom is a slower setup with more time for dealer hedging to play out, so the effect could be larger there.
  - Output: separate effect-size + p-value tables per source.

**Files to modify (production wiring — only if backtest validates):**

- **Lottery side**:
  - `api/_lib/lottery-score-weights.ts` — add ±10pp adjustment
  - `api/_lib/lottery-finder.ts` (`enrichFires`) — at fire time, query Periscope state and apply adjustment
- **Silent boom side**:
  - `api/_lib/silent-boom-score.ts` (`computeSilentBoomScore`) — extend the score input shape to accept an MM-tailwind adjustment
  - `api/_lib/silent-boom.ts` — at fire time, query Periscope state and apply adjustment to the tier classification
  - `api/__tests__/silent-boom-score.test.ts` — update fixtures for the new field

**Trading deliverable:** a more accurate score on **both** lottery and silent boom alerts. Validates or rejects the "MM-tailwind" hypothesis on each independently — could be real on one and noise on the other.

**Effort:** 2-3 days for the joint backtest + 1 day for silent-boom production wiring (lottery wiring was always in scope).

**Subagent suitability:** ✅ ml-pipeline-analyst for backtest; manual integration for production scoring (touches two scoring paths).

**Dependency:** independent of Phase 4. Both `regime_tag` (Claude's prospective label from the auto-playbook) and the raw periscope topology are available at fire time without needing a trained classifier.

---

## Phase 6 — Dark pool block → Periscope advance warning (with ongoing instrumentation)

Time-lagged correlation analysis. For each large DP print at strike X, look at sign-flip events (orange bars in periscope semantics) at X over the next 1, 5, 10, 20, 30 min. **Plus an ongoing measurement layer** so the relationship can be tracked over time as more data lands — the user explicitly wants visibility into "DP $ amount per orange-bar event" as a live diagnostic, not just a one-shot backtest.

**Files to create:**

- `ml/src/periscope/dp_advance_warning.py` — historical backtest:
  - Filter DP prints to "blocks" (≥X size, near-spot strikes — define X via the existing `darkpool_*` block-detection thresholds)
  - For each block, find sign-flip events at the same/adjacent strike in the next 30 min via `periscope_snapshots` panel-sign deltas
  - Lag correlation: does block timing precede sign-flip more than chance? Buckets by block $ size (e.g. $5M / $10M / $25M+ thresholds) so the tradeable signal threshold falls out of the data.
  - Output: lag distribution + dollar-size-conditioned hit rate.

**Ongoing instrumentation (added per user request):**

- New view or materialized table `dp_block_signflip_pairs` joining each DP block within the 6-month window (and going forward) to its nearest sign-flip event at the same strike within the next 30 min, with: `block_dollars`, `lag_minutes` (null if no flip occurred), `flip_direction` (positive→negative or negative→positive). Refreshed on a 10-min cron alongside the auto-playbook firings, so the "DP $ per orange bar" metric is queryable in real-time.
- A small dashboard / panel chip showing trailing-30-day correlation strength and current DP-block $-threshold above which sign-flip probability exceeds chance. Surfaces whether the signal is strengthening or decaying — protects against the case where Phase 6 validates today but stops working in 3 months.
- If validated and trailing-30-day correlation holds: alert at periscope panel level when a DP block fires near spot.

**Trading deliverable:** if the correlation holds, you get 10-20 min advance warning of regime changes on the periscope chart. Even without action, raises probability of a successful periscope-chat read. The instrumentation layer means you'll know when the signal is alive vs. dead without re-running the backtest.

**Effort:** 2-3 days for the backtest + 1-2 days for the instrumentation layer + dashboard. May produce null result on the backtest, in which case the instrumentation layer ships anyway as a research surface.

**Subagent suitability:** ✅ ml-pipeline-analyst for backtest; manual implementation for the materialized view + dashboard chip.

---

## Phase 7 — Spot-vs-flow divergence fade (with charm $ → SPX point sensitivity)

Pattern: SPX is up but charm tally ±100 is deeply negative (mechanical /ES SELL into close). Backtest the contrarian "fade spot, follow flow" trade in the last 90 minutes. **Beyond the binary fade signal**, this phase must also produce a quantified sensitivity coefficient: "X dollars of net charm corresponds to Y SPX points of expected fade move." Without that, an alert that says "charm tally is -340M, fade setup" is unactionable — the user can't size or place a target without knowing what the magnitude implies.

**Files to create:**

- `ml/src/periscope/spot_flow_divergence.py`:
  - Define divergence: |SPX move from 13:00 to current| > X AND sign(charm_tally_pm100) opposite of sign(spx_move)
  - Trade hypothesis: enter against spot, target the next +γ wall on the flow side, stop at recent extreme
  - Backtest expected R:R + hit rate (Wilcoxon test per locked Decisions threshold)
- `ml/src/periscope/charm_dollar_sensitivity.py` (new — per user request):
  - For all RTH slots in the 122-day window, regress the **forward 90-min SPX move** onto **charm tally pm_100 magnitude** (signed dollars), conditional on divergence regime (divergent vs. confirmatory days handled separately).
  - Output: regression coefficient β with 95% CI, plus an interpretable form — "each $100M of net charm tally pm_100 translates to N SPX points of expected forward-90-min move."
  - Stratify by time-of-day buckets (morning / midday / afternoon / late) — the charm coefficient may peak in the charm-window slot (13:00 CT ± 1) and decay before/after.
  - Multi-instrument: also report the ES + NQ point conversions per the Phase 2 multi-instrument convention.
- If validated: new alert type with quantified targets — "charm tally is -340M, divergence detected, expected fade target +3.4 SPX / +3.4 ES / +15.5 NQ points within 90 min, R:R 1.4 historical." Surfaced as a chip on the panel + an entry in the analyze prompt.

**Trading deliverable:** if hit rate >55% AND the sensitivity coefficient is statistically significant (Wilcoxon on β > 0 at α=0.05), a specific contrarian setup with **quantifiable, sized targets**. Adds counter-cyclical alpha to a directional book with explicit position sizing — not just "fade it" but "fade to this exact target."

**Effort:** 2-3 days for the divergence backtest + 1 day for the sensitivity regression. The two analyses share the same dataset so the second is mostly additional reporting.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 8 — Extend retrieval block to `/api/analyze.ts`

> **Largely already shipped.** The auto-playbook (`periscope-chat-runner.ts`) already embeds + retrieves + formats analog blocks for its own Claude calls via `buildRetrievalBlock` in `api/_lib/periscope-retrieval.ts`. K=3, cosine similarity, 0.3 floor, gold-star exclusion, `realized_r` + `realized_trigger_fired` enrichment per analog. This phase is the small wiring step to surface the same retrieval block in the SPX-wide `/api/analyze.ts` endpoint, where Claude analyzes user-submitted SPX trades (different audience from Periscope-only reads).

**Files to modify:**

- `api/analyze.ts` — call `buildRetrievalBlock({mode: 'intraday', queryText: <chart fingerprint summary>})` and append the result to the user content array, behind a feature flag `ANALYZE_PERISCOPE_RETRIEVAL_ENABLED`. The query text is the same `buildPeriscopeSummary` output the auto-playbook uses.
- `api/_lib/analyze-context.ts` — add a new context section for the analog block, positioned after the "Live periscope state" block.

**Files to create:**

- `api/__tests__/analyze-periscope-retrieval.test.ts` — verifies the block is included when the flag is on, omitted when off, and gracefully degrades when retrieval returns null.

**Optional enrichment** (only if needed after observing real analyze usage):

- Add per-analog "what played out" line beyond `realized_r` — e.g. "this analog was a long_winner that hit +2.3R within 45 min" — by joining `realized_max_favorable_pts` and `realized_trigger_fired`. Most of this data is already on the row; just needs richer formatting.

**Trading deliverable:** every `/api/analyze.ts` call gets data-grounded precedent — "this slot looks like 3 historical setups that played out as +0.6R, -0.4R, +1.2R." Without changing Claude's prompt structure or the user-facing UI.

**Effort:** 0.5–1 day. (Was 3-4 days when Phase 0 had to be built first.)

**Dependency:** historical analog corpus (auto-playbook Phase 5 backfill) for richer retrieval. Without it, retrieval returns only live-forward analogs (~5/week × N weeks since auto-playbook deploy).

---

## Phase 9 — Intraday-move predictor (the big one)

The frontier project. Multi-source feature fusion + ML model trained to predict SPX 30/60/90 min forward direction + magnitude.

**Files to create:**

- `ml/src/periscope/intraday_features.py` — feature inventory, computed at 10-min Periscope slot cadence. Sourced from existing tables/endpoints; no new ingestion required for any of these.
  - **Periscope structural features (raw `periscope_snapshots`)**: cone state, +γ topology, charm tally, charm-zero distance, sign flips, breach state, time-of-day.
  - **Auto-playbook Claude-derived features (`periscope_analyses` post-Phase-5 backfill)**: regime_tag (one-hot), bias (long/short/neutral), cone_lower / cone_upper deltas vs spot, long_trigger / short_trigger distances, confidence (low/med/high → 0/1/2). Plus structured `panel_payload` extractable numerics. **Filter to `status='complete'` rows only.**
  - **Realized-outcome rolling features**: trailing-30-day mean `realized_r`, hit rate, long-vs-short imbalance — captures recent calibration of the auto-playbook's own predictions.
  - **Analog-distance feature**: cosine similarity to nearest historical analog (top-1 via `fetchSimilarPastReads`); a measure of "how unusual is today's slot." Free byproduct of the existing retrieval infrastructure.
  - **Phase 4 ML regime prediction** (if Phase 4 ships an ML chip): one-hot label + confidence as a feature.
  - **UW Market Tide features** (existing infrastructure: `api/_lib/analyze-context-fetchers.ts` + `api/_lib/analyze-context-formatters.ts` + the cached UW market tide endpoint): current tide value, 1-hour delta, 1-day delta, premium ratio sign, and the running zero-crossings count. Captures the broader-market premium-flow regime context.
  - **UW SPY Net Flow features** (existing infrastructure: same `analyze-context-fetchers.ts` plus `build-features-labels.ts`): current SPY net premium flow, 30-min smoothed delta, sign vs SPX move (alignment / divergence). SPY is the highest-liquidity proxy for market-wide directional flow and tends to lead SPX 0DTE on regime turns.
  - **OTM Directional Greeks** (existing infrastructure: `api/greek-flow.ts` + `api/_lib/greek-flow-metrics.ts` + `api/_lib/db-greek-flow.ts`): OTM Dir Delta, OTM Dir Vega — both signed and unsigned. The signed direction is the dealer-positioning bias; the magnitude is the convexity exposure that gets unwound on a vol shock.
  - **0DTE Tide / Flow Ratio** (existing infrastructure: `api/cron/fetch-zero-dte-flow.ts` + `api/cron/monitor-flow-ratio.ts`): current 0DTE call/put premium ratio, 30-min delta, regime label (call-heavy / put-heavy / balanced). The 0DTE-specific premium ratio differs from the broader Market Tide because 0DTE flow tends to be more reactive and short-horizon — useful as a co-feature when the two diverge.
  - **Futures features (sidecar Databento `futures_bars_1m`)**: ES 1-min returns over 5/15/30 min windows, NQ 1-min returns, ES-vs-SPX correlation, ES bid-ask imbalance proxy. Per Phase 2's convention, NQ is the user's actual hedge instrument so its features are first-class, not just an SPX proxy.
  - **SPX 1-min (`index_candles_1m`)**: spot momentum, recent realized vol, % of cone width consumed.
  - **Per-instrument forward-target outputs**: predictions emitted for SPX, ES, AND NQ points (same multi-instrument convention as Phases 2 + 7).
- `ml/src/periscope/intraday_model.py`:
  - Targets: SPX move at +30, +60, +90 min from slot end
  - Models: gradient boosting (XGBoost or LightGBM), MLP baseline
  - Evaluation: walk-forward CV, Sharpe of signal-following strategy
  - Calibration: ensure predicted moves are well-calibrated to realized
- `api/cron/score-periscope-intraday.ts`: runs every 10 min during RTH (or piggybacks on the existing auto-playbook webhook), scores latest slot, persists predictions to a new `periscope_intraday_predictions` table.
- `src/components/Periscope/IntradayPrediction.tsx`: panel chip showing the live prediction with confidence band.

**Trading deliverable:** if signal Sharpe >1.0 (post-cost), this is a real intraday alpha generator. If Sharpe is between 0.3-0.7, it becomes a Bayesian prior on existing decisions. If <0.3, we still have bucketed conditional probabilities for the periscope chart's existing reads.

**Effort:** 2-3 weeks. Most of that is feature engineering + train/test infrastructure.

**Subagent suitability:** ml-pipeline-analyst for training.

**Dependency:** ideally Phase 4 comparison study (so we know whether Claude regime tag is the right feature OR whether the ML classifier should be the feature) and the auto-playbook Phase 5 backfill (provides the analog corpus for analog-distance features and the labeled regime training data).

---

## Execution plan

Backfill is complete (122 days × 40 RTH slots = 4,880 canonical slots in `periscope_snapshots`). Auto-playbook is deployed (2026-05-10) and starts firing forward Monday 2026-05-11 at 08:20 CT.

**Decision gate (do first):** decide whether to run the dormant auto-playbook Phase 5 backfill (~$440-930, ~6-12 hours). If yes → kick it off Sunday night so Monday morning has the historical analog corpus. If no → Phases 1, 2, 3, 6, 7, 5-Lottery still run; Phases 4, 8, 9 ship with thinner data and improve weekly as live auto-playbook rows accumulate.

1. **Pre-flight (30 min):** Phase 0 checklist — verify auto-playbook is writing live rows + retrieval works. No engineering work.
2. **Wave A — pure-structural research (parallel, Sunday or Monday):** kick off **Phase 1, 2, 3, 7** as 4 parallel ml-pipeline-analyst subagents. None require the analog corpus; all read raw `periscope_snapshots`. Output: 4 reports + go/no-go on each signal.
3. **Wave B — single-file cross-table analyses (parallel, after Wave A):** **Phase 5-Lottery** (joins lottery_finder_fires) and **Phase 6** (DP block → periscope sign-flip lag correlation). Independent of each other and of Wave A's results.
4. **Wave C — Claude-comparison + retrieval extension (after analog corpus is available, sequential):**
   1. **Phase 4** comparison study (Claude regime_tag vs ML classifier vs ground truth). Optional production wiring conditional on ML beating Claude.
   2. **Phase 8** wiring of `buildRetrievalBlock` into `/api/analyze.ts`. Half-day task.
5. **Wave D — capstone (2-3 weeks):** **Phase 9** intraday ML predictor. Eats outputs from all prior phases as features.

Each phase ships independently. The user can stop at any wave and have working signals.

## Files to create / modify (summary)

- **Migrations:** none for the data-product spec itself. (Auto-playbook spec already added migration #142 for `periscope_analyses` columns.) Phase 9 may add one for `periscope_intraday_predictions` if the predictor ships.
- **Backend:**
  - `api/analyze.ts` (modify, Phase 8) — wire `buildRetrievalBlock`
  - `api/_lib/analyze-context.ts` (modify, Phase 8) — add analog block to context
  - `api/__tests__/analyze-periscope-retrieval.test.ts` (new, Phase 8)
  - `api/_lib/periscope-regime-classifier.ts` (new, Phase 4 — only if ML beats Claude)
  - `api/cron/score-periscope-intraday.ts` (new, Phase 9)
  - `api/_lib/lottery-finder.ts`, `api/_lib/lottery-score-weights.ts` (modify, Phase 5-Lottery — lottery side)
  - `api/_lib/silent-boom-score.ts`, `api/_lib/silent-boom.ts` (modify, Phase 5-Lottery — silent boom side)
  - `api/__tests__/silent-boom-score.test.ts` (modify, Phase 5-Lottery — fixture updates)
  - `api/_lib/db-migrations.ts` (modify, Phase 6) — migration for `dp_block_signflip_pairs` materialized view or table
  - `api/cron/refresh-dp-signflip-pairs.ts` (new, Phase 6) — 10-min refresh cron alongside auto-playbook firings
- **ML:**
  - `ml/src/periscope/pin_prediction.py` (Phase 1)
  - `ml/src/periscope/charm_drift.py` (Phase 2 — multi-instrument SPX/ES/NQ output)
  - `ml/src/periscope/cone_breach_extension.py` (Phase 3)
  - `ml/src/periscope/regime_ground_truth.py` + `regime_classifier.py` + `regime_comparison.py` (Phase 4)
  - `ml/src/periscope/lottery_mm_tailwind.py` (Phase 5-Lottery — joint backtest for lottery + silent boom)
  - `ml/src/periscope/dp_advance_warning.py` (Phase 6)
  - `ml/src/periscope/spot_flow_divergence.py` + `charm_dollar_sensitivity.py` (Phase 7)
  - `ml/src/periscope/intraday_features.py` + `intraday_model.py` (Phase 9)
- **Scripts:** none new for the data-product spec. (Auto-playbook spec already provides `scripts/backfill-periscope-playbooks.mjs` for the analog corpus.)
- **Frontend:**
  - `src/components/Periscope/IntradayPrediction.tsx` (new, Phase 9)
  - `src/components/Periscope/DpSignflipDiagnostic.tsx` (new, Phase 6) — trailing-30-day correlation strength chip
  - `PeriscopePanel.tsx` (modify, Phase 4 conditional + Phase 6 + Phase 7 + Phase 9) — surface ML regime chip if Claude is beaten, DP-signflip diagnostic, charm-divergence chip with quantified target, intraday prediction dial

## Data dependencies

- `periscope_snapshots` — populated by backfill + live scraper. **Filter discipline (apply in every phase query)**: RTH gate `08:30–15:00 CT` + 10-min bucket dedup (see Thresholds). 122 days × 40 RTH slots = 4,880 canonical slots.
- `periscope_analyses` (post auto-playbook deploy) — Claude playbook output. Filter `status='complete' AND auto_generated=TRUE` for live forward rows. Available columns Phases 4/8/9 can use as features OR as labels:
  - **Embeddings**: `analysis_embedding` (vector, HNSW) — same space as the query side via `buildPeriscopeSummary`.
  - **Categorical**: `regime_tag`, `bias`, `mode` (pre_trade / intraday / debrief), `confidence`.
  - **Numeric**: `spot`, `cone_lower`, `cone_upper`, `long_trigger`, `short_trigger`, `realized_r`, `realized_max_favorable_pts`, `realized_max_adverse_pts`.
  - **Categorical realized**: `realized_trigger_fired` (long / short / neither).
  - **Structured JSON**: `key_levels`, `panel_payload`, `trade_types_recommended`, `trade_types_avoided`, `expected_dealer_behavior`, `futures_plan`.
  - **Token / cost telemetry**: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `duration_ms` — useful for Phase 9 cost monitoring if it scores at every slot.
- `cone_levels` + `cone_breach_events` (already populated)
- `index_candles_1m` (SPX 1-min, already exists)
- Sidecar's `futures_bars_1m` (ES, NQ minute bars from Databento — used for ES/NQ point conversion in Phases 2, 7, 9 and as raw features in Phase 9; confirm exact column names against `sidecar/src/db.py` before subagent dispatch)
- `lottery_finder_fires` + `silent_boom_fires` + `darkpool_*` tables (already exist; Phase 5-Lottery joins all three)
- **UW Market Tide** — fetched via the cached UW endpoint and surfaced in `api/_lib/analyze-context-fetchers.ts` / `analyze-context-formatters.ts`. Phase 9 feature.
- **UW SPY Net Flow** — fetched via the same cached UW path; formatted in `api/_lib/build-features-labels.ts`. Phase 9 feature.
- **OTM Directional Greeks** (`greek_flow_*` tables, populated by `scripts/backfill-greek-flow*` family + the live `api/greek-flow.ts` endpoint). OTM Dir Delta + OTM Dir Vega. Phase 9 features.
- **0DTE Tide / Flow Ratio** — populated by `api/cron/fetch-zero-dte-flow.ts`; ratio monitored by `api/cron/monitor-flow-ratio.ts`. Phase 9 feature.

## Risks

- **Overfitting**: 6 months of data on a non-stationary market. Walk-forward CV is mandatory; the 20-30 day untouched hold-out (locked in Decisions section) is the final guardrail.
- **Anti-bot regression**: if UW changes Periscope UI, the live scraper breaks and both the auto-playbook pipeline AND the live signal pipeline go dark. Already validated robust to several iterations; risk is real but manageable.
- **Auto-playbook drift**: if Claude's regime_tag distribution shifts (model upgrade, prompt revision, calibration drift), Phase 4's comparison study becomes stale. Re-run the comparison whenever the auto-playbook prompt changes materially.
- **Phase 9 may produce null result**: a real risk. Phase 8 (retrieval extension to analyze.ts) is a useful fallback if the predictor fails — Claude still gets analog precedents even without an ML signal.
- **Cost**: zero for the data-product spec itself (Phase 0 deleted, Phase 8 only adds ~$0.0001/embed at analyze-time). The optional auto-playbook Phase 5 backfill is ~$440-930 one-time and is the only material spend in the whole roadmap. Phase 9 scoring at every live RTH slot ≈ ~$2-5/day if the cron writes ML predictions — negligible.
