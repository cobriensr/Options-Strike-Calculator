# Periscope Data Product — Phase plan for items 1-9

**Date:** 2026-05-09 (decisions locked + bug fixes 2026-05-10)
**Status:** spec ready — execution gated on `periscope-auto-playbook-2026-05-10.md` shipping. After auto-playbook is live, this spec gets a re-review before phase dispatch (the new structured `panel_payload` corpus changes what Phase 8 retrieves and reshapes Phase 4's training input).
**Backfill scope (informs power of all phases):** 2025-11-10 → 2026-05-08 — actual delivery: **122 trading days, 2,035,982 rows** in `periscope_snapshots`. (Spec originally estimated ~125 days; 3 days dropped: 2025-11-11, 11-13, 11-17.) After RTH-gate + 10-min dedup (see Thresholds section), usable canonical slots ≈ 122 × 40 = 4,880. Plus SPX 1-min from `index_candles_1m` and ES/NQ 1-min from sidecar's Databento tables.

## Goal

Turn the new Periscope historical dataset into a stack of trading signals layered on top of the existing app. Each phase is a discrete signal/feature with measurable trading impact for 0DTE SPX directional + opportunistic credit spreads. Phases are sequenced so each builds on existing infrastructure (no new model framework, no new embedding pipeline) — extending `embeddings.ts`, the ML pipeline at `ml/`, and the lottery + analyze stacks.

## Phase ordering rationale

```
                    PHASE 0 (embedding infra, foundation)
                            │
        ┌──────────┬────────┼────────┬──────────┐
        ▼          ▼        ▼        ▼          ▼
    PHASE 1   PHASE 2   PHASE 3   PHASE 4   PHASE 7
    (pin      (charm    (cone     (regime   (divergence)
     pred)     drift)    breach)   class)
        │          │        │        │          │
        └──────────┴────┬───┴────────┘          │
                        ▼                       ▼
                    PHASE 5                 PHASE 6
                    (lottery tag)           (DP advance)
                        │                       │
                        └───────────┬───────────┘
                                    ▼
                                PHASE 8
                                (retrieval-augmented analyze)
                                    │
                                    ▼
                                PHASE 9
                                (intraday ML predictor)
```

Phases 1-4, 7 are pure research (statistical analyses on historical data). Each can run as an isolated subagent investigation in parallel once the backfill completes. Output is a notebook/report + a number that says "do this trade" or "this signal doesn't survive validation."

## Open questions — locked decisions

- **Train/test split** (locked 2026-05-10): reserve the **most recent 20-30 trading days as an untouched hold-out** that no phase trains on or peeks at — Phase 9 will validate against it months from now. Remaining ~95-100 days run **walk-forward CV with 80-train / 20-test rolling 4-week windows** (~3 folds). Random K-fold is forbidden — temporal leakage would invalidate every signal.
- **Significance threshold** (locked 2026-05-10): a signal ships to production only if **median absolute effect ≥ 1.0 SPX point AND the phase-appropriate test is significant at α=0.05**. Per-phase tests:
  - Phases 1, 2, 3, 7 (continuous outcomes, fat-tailed) → **Wilcoxon signed-rank** (not t-test — tape distributions are non-normal)
  - Phase 5 (binary lottery hit/miss) → **Fisher exact** for small buckets, chi-square for large
  - Phases 4, 9 (predictors) → out-of-sample **R² + Sharpe**, not p-value alone
- **Kill criterion** (locked 2026-05-10): if median absolute effect **< 0.5 SPX point** OR significance test p > 0.10 on the most-powered test, the phase ships **only as research notes** (committed to `docs/superpowers/specs/`), no production wiring, no panel chip, no analyze block.
- **Live integration boundary** (locked 2026-05-10):
  - **UI panel**: binary or single-number signals — regime label, pin-distance estimate, divergence flag. User glances and decides.
  - **Analyze prompt block**: distributions, conditional probabilities, comparative analogs (Phase 8 retrieval). Claude weighs these in context.
  - **Both**: Phase 4 regime label (panel chip + analyze framing); Phase 9 prediction (panel dial + analyze numeric).

## Thresholds / constants

- **Slot embedding text length**: ~200-300 tokens (cone summary + top-5 +γ strikes + top-5 charm + tally + sign-flip count + breach state)
- **Retrieval K**: 5 neighbors for "similar slots" lookup
- **Pin window for #1 (pin prediction)**: 13:00 CT signal slot → 15:00 CT close as outcome
- **Charm-window slot for #2 (charm drift)**: 13:00 CT ± 1 slot (per skill convention)
- **Cone breach lookback**: include all breaches in 6-month window
- **ML predictor target horizons (#9)**: 30, 60, 90 min forward
- **Ensemble weight cap on lottery score (#5)**: ±10pp adjustment, matches existing memory feedback for "earnings_this_week"
- **Snapshot dedup + RTH gate** (applies to ALL phases): every query against `periscope_snapshots` MUST (a) restrict to RTH `08:30–15:00 CT` and (b) collapse to one canonical row per `(date_trunc('10 minutes', captured_at), expiry, panel, strike)` bucket. When two `captured_at` values fall in the same bucket, prefer the live-ticker capture (`:48-49` second mark) over the backfill capture (`:00` second mark) — backfill was the bootstrap; live is the production source. SQL pattern: `SELECT DISTINCT ON (10min_bucket, expiry, panel, strike) … ORDER BY 10min_bucket, expiry, panel, strike, EXTRACT(SECOND FROM captured_at) DESC`.

---

## Phase 0 — Periscope slot embedding infrastructure

**Foundation for #8 + cross-cutting use in #4/#9.** Existing infra at `api/_lib/embeddings.ts` (text-embedding-3-large, 2000 dims) is reused.

**Files to create:**

- Migration #142 in `api/_lib/db-migrations.ts`:
  ```sql
  CREATE TABLE periscope_slot_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    expiry          DATE NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL UNIQUE,
    text            TEXT NOT NULL,
    embedding       vector(2000) NOT NULL,
    embedding_model TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX periscope_slot_embeddings_vec_idx
    ON periscope_slot_embeddings USING hnsw (embedding vector_cosine_ops);
  CREATE INDEX periscope_slot_embeddings_expiry_idx
    ON periscope_slot_embeddings (expiry, captured_at);
  ```
- `api/_lib/periscope-slot-embeddings.ts`:
  - `slotToText(view: PeriscopeView): string` — deterministic text representation. Format:
    ```
    Date: 2025-11-14
    Slot: 14:30 CT
    Spot: 6734.11
    Cone: 6720-6750 (30pts wide, 1pt downside skew)
    +γ ceiling: 6745 (8.4K, +11)
    +γ floor: 6720 (3.2K, -14)
    -γ accel: 6750 (-12K), 6740 (-5K)
    Charm tally ±50: -340M
    Charm tally ±100: -180M
    Top |charm|: 6730 (-200M), 6740 (-180M)
    Charm-zero strike: 6735
    Sign flips: 6730→6740
    Cone breach: lower at 13:50 CT (4pts past)
    ```
  - `embedSlot(view): Promise<number[]>` — wraps `embeddings.ts` + caches by captured_at
  - `findNearestSlots(currentEmbedding, k=5, excludeDate?)`: returns historical analogs
- New cron `api/cron/embed-periscope-slots.ts`: runs hourly, picks up un-embedded slots from `periscope_snapshots`, generates embeddings in batches of 50
- One-shot backfill script `scripts/backfill-periscope-slot-embeddings.ts` to embed the historical 4,800+ slots after backfill completes
- Tests for the text generator (deterministic snapshot)

**Files to modify:**

- `api/_lib/db-migrations.ts` — add migration
- `api/__tests__/db.test.ts` — update mock counts

**Cost estimate:** 4,800 slots × ~$0.00013/embed (text-embedding-3-large at 2000 dims) ≈ $0.65 one-time, plus ~$0.05/day ongoing.

**Deliverable:** every periscope_snapshots slot has an embedding queryable via HNSW index in <10ms.

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
  - Compute hit rate, mean / median move, t-test
- Conditional on: cone breach state, charm tally magnitude, time-of-day (charm window peak is 13:00-14:30)
- `docs/tmp/periscope-charm-drift-report-{date}.md`

**Trading deliverable:** if hit rate ≥ 60% AND median move > 1 SPX point, this is a clean afternoon directional setup. Output spec: an alert that fires at 13:00 CT, plus a position-sizing recommendation.

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

## Phase 4 — Pre-market regime classifier

Train a classifier on first-slot features (08:30 CT, before market opens for trading) to predict end-of-day regime.

**Files to create:**

- `ml/src/periscope/regime_classifier.py`:
  - Features (X): cone width, asymmetry, dominant +γ above/below in ±50, charm tally sign, top |charm| magnitude, vanna concentration
  - Target (y): end-of-day regime label, derived from 13:00 / 15:00 prices + cone breach state. Labels: pin / drift-and-cap / cone-breach-up / cone-breach-down / chop
  - Models tried: logistic regression baseline, gradient boosting, calibrated random forest
  - Evaluation: walk-forward CV, confusion matrix, per-class precision/recall
- `api/_lib/periscope-regime-classifier.ts` — runtime scoring endpoint that loads the trained model and returns predicted regime + confidence
- `api/_lib/periscope-format.ts` — append predicted regime to the JSON exposed by `/api/periscope-exposure`, surfaces in the panel

**Trading deliverable:** a single chip on the panel at 08:30 CT that says e.g. "PIN | confidence 0.72". Frames the morning playbook before any trade is taken.

**Effort:** 4-5 days (classifier training + validation + production wiring).

**Subagent suitability:** partial (ml-pipeline-analyst for training; manual integration for runtime scoring).

---

## Phase 5 — Lottery MM-tailwind/headwind tag

Cross-table feature: for each historical lottery_finder_fire, look up the Periscope state at fire time and tag it.

**Files to create:**

- `ml/src/periscope/lottery_mm_tailwind.py`:
  - Join lottery_finder_fires to nearest periscope_snapshots slot
  - Compute "MM tailwind score": tailwind=+1 if periscope's near-spot +γ topology supports the lottery direction, headwind=-1 if opposes, neutral=0
  - Backtest: lottery win rate by tailwind bucket
- `api/_lib/lottery-score-weights.ts` — add ±10pp adjustment if backtest validates effect
- `api/_lib/lottery-finder.ts` — at fire time, query Periscope state and apply adjustment

**Trading deliverable:** a more accurate score on lottery alerts. Validates or rejects the "MM-tailwind" hypothesis with empirical hit-rate delta.

**Effort:** 2-3 days.

**Subagent suitability:** ✅ ml-pipeline-analyst for backtest; manual integration for production scoring.

**Dependency:** validates faster after Phase 4 because regime label can be a feature.

---

## Phase 6 — Dark pool block → Periscope advance warning

Time-lagged correlation analysis. For each large DP print at strike X, look at sign-flip events at X over the next 1, 5, 10, 20 min in Periscope.

**Files to create:**

- `ml/src/periscope/dp_advance_warning.py`:
  - Filter DP prints to "blocks" (≥X size, near-spot strikes)
  - For each block, find sign-flip events at the same/adjacent strike in the next 30 min
  - Lag correlation: does block timing precede sign-flip more than chance?
- If validated: alert at periscope panel level when a DP block fires near spot

**Trading deliverable:** if the correlation holds, you get 10-20 min advance warning of regime changes on the periscope chart. Even without action, raises probability of a successful periscope-chat read.

**Effort:** 2-3 days. May produce null result.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 7 — Spot-vs-flow divergence fade

Pattern: SPX is up but charm tally ±100 is deeply negative (mechanical /ES SELL into close). Backtest the contrarian "fade spot, follow flow" trade in the last 90 minutes.

**Files to create:**

- `ml/src/periscope/spot_flow_divergence.py`:
  - Define divergence: |SPX move from 13:00 to current| > X AND sign(charm_tally_pm100) opposite of sign(spx_move)
  - Trade hypothesis: enter against spot, target the next +γ wall on the flow side, stop at recent extreme
  - Backtest expected R:R + hit rate
- If validated: new alert type, maybe surfaced as a chip on the panel

**Trading deliverable:** if hit rate >55%, a specific contrarian setup with quantifiable edge. Adds counter-cyclical alpha to a directional book.

**Effort:** 2-3 days.

**Subagent suitability:** ✅ ml-pipeline-analyst.

---

## Phase 8 — Retrieval-augmented analyze ("this slot looks like X")

Uses Phase 0's slot embeddings. At every analyze request, find K=5 nearest historical analog slots; surface them in the prompt block Claude sees.

**Files to create:**

- `api/_lib/periscope-analog-retrieval.ts`:
  - `findHistoricalAnalogs(currentSlotIso): { date, slot_ct, similarity, eod_outcome }[]`
  - Joins periscope_slot_embeddings (Phase 0) with periscope_analyses (Claude playbooks) and SPX close trajectory
  - Computes EoD outcome for each analog (regime label from Phase 4 + actual close move)
- `api/_lib/analyze-context.ts` — append "Historical analogs" block to Claude's prompt:
  ```
  ## Historical analogs (top 5 by structural similarity)
  - 2026-02-15 13:30 CT (sim 0.94): drift-and-cap, closed at +0.4% from this slot
  - 2026-01-08 13:30 CT (sim 0.91): cone-breach-up, closed at +1.2%
  - ...
  ```
- Cache the analog block per slot to avoid recomputing on retries

**Trading deliverable:** every Periscope Chat read includes data-grounded precedent. When today's setup has a clear analog, the analog's EoD outcome distribution informs the trade. When it's unprecedented, you'll know.

**Effort:** 3-4 days.

**Dependency:** Phase 0 must be complete + backfill embedded.

---

## Phase 9 — Intraday-move predictor (the big one)

The frontier project. Multi-source feature fusion + ML model trained to predict SPX 30/60/90 min forward direction + magnitude.

**Files to create:**

- `ml/src/periscope/intraday_features.py`:
  - **Periscope features**: cone state, +γ topology, charm tally, charm-zero distance, sign flips, breach state, time-of-day
  - **Futures features (sidecar Databento)**: ES 1-min returns over 5/15/30 min windows, NQ 1-min returns, ES-vs-SPX correlation, ES bid-ask imbalance proxy
  - **SPX 1-min**: spot momentum, recent realized vol, % of cone width consumed
  - All features computed at 10-min Periscope slot cadence
- `ml/src/periscope/intraday_model.py`:
  - Targets: SPX move at +30, +60, +90 min from slot end
  - Models: gradient boosting (XGBoost or LightGBM), MLP baseline
  - Evaluation: walk-forward CV, Sharpe of signal-following strategy
  - Calibration: ensure predicted moves are well-calibrated to realized
- `api/cron/score-periscope-intraday.ts` (or similar): runs every 10 min during RTH, scores latest slot, persists predictions
- `src/components/Periscope/IntradayPrediction.tsx`: panel chip showing the live prediction with confidence band

**Trading deliverable:** if signal Sharpe >1.0 (post-cost), this is a real intraday alpha generator. If Sharpe is between 0.3-0.7, it becomes a Bayesian prior on existing decisions. If <0.3, we still have bucketed conditional probabilities for the periscope chart's existing reads.

**Effort:** 2-3 weeks. Most of that is feature engineering + train/test infrastructure.

**Subagent suitability:** ml-pipeline-analyst for training.

**Dependency:** ideally Phase 4 (regime classifier outputs become a feature) and Phase 8 (analog distance becomes a feature).

---

## Execution plan

Once backfill completes (~Sunday 1 AM CT):

1. **Sunday morning:** kick off Phase 0 (embedding infra) AND Phases 1, 2, 3, 7 in parallel as 4 ml-pipeline-analyst subagents. Phases 1-3 + 7 are independent and pure research.
2. **Monday morning:** review research outputs; commit any signals that pass thresholds. Decide: drop weak signals, productionize strong ones.
3. **Monday afternoon → Tue:** Phase 4 (regime classifier) — depends on a clean training set, output feeds Phase 5.
4. **Wed-Thu:** Phase 5 (lottery tag) + Phase 6 (DP advance warning) in parallel.
5. **Fri-following Mon:** Phase 8 (retrieval) — needs Phase 0 done + Phase 4 regime labels.
6. **Following 2-3 weeks:** Phase 9 (intraday ML predictor) as the capstone.

Each phase ships independently. The user can stop at any phase and have working signals.

## Files to create / modify (summary)

- **Migrations:** 1 new migration (#142) for `periscope_slot_embeddings`
- **Backend:**
  - `api/_lib/periscope-slot-embeddings.ts` (new)
  - `api/_lib/periscope-analog-retrieval.ts` (new, Phase 8)
  - `api/_lib/periscope-regime-classifier.ts` (new, Phase 4)
  - `api/cron/embed-periscope-slots.ts` (new)
  - `api/cron/score-periscope-intraday.ts` (new, Phase 9)
  - `api/_lib/lottery-finder.ts`, `api/_lib/lottery-score-weights.ts` (modify, Phase 5)
  - `api/_lib/analyze-context.ts` (modify, Phase 8)
- **ML:**
  - `ml/src/periscope/pin_prediction.py` (Phase 1)
  - `ml/src/periscope/charm_drift.py` (Phase 2)
  - `ml/src/periscope/cone_breach_extension.py` (Phase 3)
  - `ml/src/periscope/regime_classifier.py` (Phase 4)
  - `ml/src/periscope/lottery_mm_tailwind.py` (Phase 5)
  - `ml/src/periscope/dp_advance_warning.py` (Phase 6)
  - `ml/src/periscope/spot_flow_divergence.py` (Phase 7)
  - `ml/src/periscope/intraday_features.py` + `intraday_model.py` (Phase 9)
- **Scripts:** `scripts/backfill-periscope-slot-embeddings.ts` (one-shot)
- **Frontend:**
  - `src/components/Periscope/IntradayPrediction.tsx` (new, Phase 9)
  - `PeriscopePanel.tsx` (modify — surface regime label, intraday score)

## Data dependencies

- `periscope_snapshots` (already populated by backfill)
- `cone_levels` + `cone_breach_events` (already populated)
- `index_candles_1m` (SPX 1-min, already exists)
- Sidecar's `futures_bars_1m` or equivalent (ES, NQ — need to confirm table names with sidecar's `db.py`)
- `lottery_finder_fires`, `darkpool_*` tables (already exist)
- `periscope_analyses` (already has `embedding` column for analog retrieval)

## Risks

- **Overfitting**: 6 months of data on a non-stationary market. Walk-forward CV is mandatory.
- **Anti-bot regression**: if UW changes Periscope UI, the live scraper breaks and the live signal pipeline goes dark. Already validated robust to several iterations; risk is real but manageable.
- **Phase 9 may produce null result**: a real risk. Phase 8 (analog retrieval) is a useful fallback if predictor fails.
- **Cost**: ~$0.65 one-time for backfill embeddings, ~$0.05/day for ongoing slot embeddings, ~$2-5/day if Phase 9 scores at every slot — negligible.
