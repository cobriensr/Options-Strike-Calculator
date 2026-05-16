# Alert Take-It Score (Lottery + Silent Boom) — 2026-05-16

## Goal

When a Lottery Finder or Silent Boom alert fires, surface a single calibrated probability of a winning outcome (`P(win) ∈ [0, 1]`) plus the top SHAP-derived green / red flags driving that probability, so the trader can decide "take it or skip it" in <5 seconds. Two separate models, one per alert type. Score-only (no take/skip recommendation).

## Motivation

Today the heuristic tier (computed via [computeLotteryScore](api/_lib/lottery-score-weights.js) / [computeSilentBoomScore](api/_lib/silent-boom-score.js)) is a static weighted sum of ticker × mode × price × time-of-day × option_type. It does not know:

- That `cheap_call_pm_tagged=True` historically drops Lottery Sharpe by 0.07 (−28.5% edge loss) — validated in [ml/findings.json](ml/findings.json).
- That `earnings_this_week` carries a ~16pp win-rate drag (`project_lottery_earnings_week_drag.md`, 3-day finding pending re-validation).
- That Silent Boom + flow-inversion pairing lifts Sharpe by +7.4% (`findings_microstructure.json`).
- That dealer −γ regime, Burst-storm co-fire, VIX regime, session phase, ITM/OTM status, and aggressive-premium flag all _interact_ in non-linear ways the heuristic cannot capture.

All of this is in the data. A gradient-boosted classifier trained on the enriched `peak_ceiling_pct` outcome column — i.e. "did this alert ever spike ≥20% from entry?" — collapses these signals into one calibrated number per fresh alert. The model judges alert quality at entry time; exit execution is the trader's job.

## Decisions Made During Scoping

1. **Score-only, no recommendation.** The model emits `P(win)` and SHAP top-3 green / red contributors. The trader decides. No threshold-based take/skip.
2. **One model per alert type.** Lottery and Silent Boom share most features but the physics differs (block-stealth vs aggressive single-strike conviction). Train two independent LightGBM classifiers; share feature engineering pipeline.
3. **New score lives alongside the existing tier.** Do not replace `score` / `score_tier` columns. Add `takeit_prob` + `takeit_top_features` JSONB. The trader compares the two for a calibration period (~2 weeks) before any UI culling.
4. **Walk-forward training, weekly retrain.** No leakage. Each Saturday cron retrains on the trailing 60 trading days; first 90 days seed training; remaining N validate.
5. **Win definition:** `peak_ceiling_pct ≥ 20%` for both alert types. The model answers "was there ever a tradeable spike from entry?" — not "did the trailing-stop exit pay off." This separates the alert-quality question (what the model can know from entry-time features) from the exit-execution question (which depends on the trader's discipline, not the alert). Rows where `peak_ceiling_pct` is null are dropped from training. The 20% threshold is tunable in Phase 1 once class balance is measured.
6. **Display:** numeric `P(win)` to 2 decimals (e.g. `0.62`) with color band:
   - `< 0.40` red
   - `0.40–0.55` amber
   - `0.55–0.70` green
   - `> 0.70` deep green
     Plus top-3 green flags and top-3 red flags (SHAP-sorted absolute contribution).
7. **Historical analogs deferred to Phase 5.** First ship the score + flags; add the "last 12 similar fires" panel after the model proves out.

## Data Dependencies

| Source                     | Path / Table                                                                                                                             | Coverage                             | Grain               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------- |
| Fulltape (per-print)       | `~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet`                                                                                | 92 days, 2026-01-02 → 2026-05-14     | Per print           |
| Lottery alerts + outcomes  | Postgres `lottery_finder_fires`                                                                                                          | All-time, enriched via existing cron | Per fire            |
| Silent Boom alerts         | Postgres `silent_boom_alerts`                                                                                                            | 2026-04-22 → present, enriched       | Per fire            |
| GEX / dealer regime        | Postgres `ws_gex_strike_expiry`, `compute-zero-gamma` output                                                                             | Live + historical snapshots          | Per minute          |
| VIX context                | `data/vix_family_daily.parquet` + `refresh-vix1d` snapshots                                                                              | All-time                             | Daily / 1min        |
| Macro events               | Postgres `economic_calendar`                                                                                                             | Forward + back                       | Per event           |
| Existing scoring artifacts | [ml/data/lottery_score_weights.json](ml/data/lottery_score_weights.json), [lottery_ticker_stats.json](ml/data/lottery_ticker_stats.json) | Active heuristic                     | Feature inputs only |

Join keys: `alert_id` (PK), `option_chain_id`, `executed_at` UTC. Watch out for the cumulative-vol trap (`feedback_uw_fulltape_vols_cumulative.md`) when computing print-time microstructure features.

## Feature Set (v1)

Shared between both models:

| Feature                              | Source                              | Why it matters                                 |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------- |
| `tier`                               | existing scoring column             | Baseline existing edge                         |
| `score_raw`                          | existing heuristic                  | Don't throw away                               |
| `ticker`                             | alert row                           | Per-ticker base rates                          |
| `option_type`                        | alert row                           | Call / put asymmetry                           |
| `dte`                                | alert row                           | 0DTE vs 1-3DTE physics differ                  |
| `otm_distance_pct`                   | alert row                           | OTM-aware (recent `underlying_price_at_spike`) |
| `session_phase` (1–5)                | derived from CT timestamp           | Maps to user's 5-phase day                     |
| `minute_of_day_ct`                   | alert row                           | Continuous time feature                        |
| `day_of_week`                        | alert row                           |                                                |
| `earnings_this_week`                 | tags / economic_calendar            | −16pp drag finding                             |
| `cheap_call_pm_tagged`               | tags                                | −28.5% Sharpe finding                          |
| `aggressive_premium_flag`            | tags (commit 217a1c75)              | Recent quality lift                            |
| `is_itm_at_fire`                     | alert row (commit 68c82e5b)         | OTM-aware filter                               |
| `burst_storm_badge`                  | derived (commit d5621932)           | Lottery-storm composite                        |
| `silent_boom_cofire_within_5min`     | cross-table join                    | Pairing signal                                 |
| `dealer_gamma_sign`                  | `ws_gex_strike_expiry` at fire time | +γ suppression vs −γ acceleration              |
| `zero_gamma_distance_pts`            | `compute-zero-gamma` snapshot       | Regime context                                 |
| `vix_close`, `vix_regime`            | VIX context                         | Vol regime                                     |
| `direction_gated`                    | existing column                     | Already a quality filter                       |
| `multi_leg_share`                    | bucket aggregate (silent_boom)      | Spread-leg suppression                         |
| `n_same_dir_fires_last_30min`        | rolling sequential cluster          | Momentum continuation proxy                    |
| `recent_3_fires_same_ticker_outcome` | outcome lookback                    | Per-ticker streak signal                       |

Lottery-only:

| Feature                  | Source               | Why                    |
| ------------------------ | -------------------- | ---------------------- |
| `mode`                   | A_intraday vs B_3DTE | Different exit physics |
| `flow_phase`             | existing column      | Lottery internal state |
| `est_premium_dollars`    | alert row            | Size-of-bet            |
| `flow_inversion_eta_min` | from 108-min median  | Expected exit window   |

Silent Boom only:

| Feature               | Source                       | Why                                       |
| --------------------- | ---------------------------- | ----------------------------------------- |
| `buy_premium_pct`     | bucket aggregate             | Stealth quality                           |
| `bucket_gamma_shares` | bucket aggregate             | Dealer exposure shift                     |
| `max_print_premium`   | bucket aggregate             | Single-print conviction                   |
| `ask_print_share`     | derived from fulltape deltas | Per-print ask-side share (NOT cumulative) |

## Phase 1 vs Phase 1.5 — What was actually pulled

Phase 1 (shipped) pulls everything available directly off the alert rows plus
sequential / co-fire / burst-storm derivatives. Several features in the v1 table
above require external joins or fulltape aggregation and are deferred to Phase 1.5
so Phase 2 can start training on the simpler feature set first:

| Feature                          | Status      | Notes                                                                       |
| -------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `dealer_gamma_sign`              | ✅ Phase 1  | Derived from `spx_spot_gamma_oi` already on the alert row.                  |
| `zero_gamma_distance_pts`        | ⏸ Phase 1.5 | Requires join to `zero_gamma_levels` at fire_time.                          |
| `vix_close`, `vix_regime`        | ⏸ Phase 1.5 | Requires daily VIX join.                                                    |
| `earnings_this_week`             | ⏸ Phase 1.5 | Join to `economic_events` or derive from fulltape `tags`.                   |
| `flow_inversion_eta_min`         | ⏸ Phase 1.5 | Static 108-min median initially; per-ticker median possible.                |
| `est_premium_dollars` (lottery)  | ⏸ Phase 1.5 | Computable from `entry_price` + window prints.                              |
| `buy_premium_pct` (silent boom)  | ⏸ Phase 1.5 | Bucket aggregate; fulltape per-print delta required (cumulative-vol trap).  |
| `bucket_gamma_shares`            | ⏸ Phase 1.5 | Same.                                                                       |
| `max_print_premium`              | ⏸ Phase 1.5 | Same.                                                                       |
| `ask_print_share`                | ⏸ Phase 1.5 | Same.                                                                       |

Phase 1.5 is its own slim sub-phase between Phase 1 and Phase 2, gated on Phase 2
delivering an honest AUC baseline first — if Phase 1 features alone beat the
heuristic by enough, Phase 1.5 may be skipped or trimmed to only the cheapest
joins.

## Phases

### Phase 1 — Training set assembly (EDA notebook, no production)

Output: `ml/data/takeit/lottery_training.parquet`, `ml/data/takeit/silentboom_training.parquet`. One row per enriched alert with all v1 features + `win` label + `realized_R` target.

Files:

- `ml/src/takeit/build_training_set.py` — joins Postgres alerts + outcomes with fulltape-derived per-print features + GEX/VIX snapshots.
- `ml/tests/test_takeit_build_training_set.py` — fixtures verify no leakage (feature time ≤ alert time), label correctness, no duplicate alert_ids.
- `ml/notebooks/takeit-eda.py` — class balance, per-feature univariate win-rate plots, missingness audit.

Verify: row counts match enriched alert counts to within label-availability filter; class balance reported; correlation matrix of features rendered to `ml/plots/takeit-feature-corr.png`.

### Phase 2 — Model training + calibration

Output: `ml/data/takeit/lottery_classifier.joblib`, `silentboom_classifier.joblib`. LightGBM binary classifier per alert type, calibrated with isotonic regression on a held-out fold.

Files:

- `ml/src/takeit/train.py` — walk-forward CV (5 folds, time-ordered), per-fold AUC + Brier, final model trained on full window, isotonic calibration on last 20% of data.
- `ml/src/takeit/shap_explainer.py` — TreeExplainer wrapper that returns top-3 positive + top-3 negative SHAP contributors per row in JSON-serializable form.
- `ml/tests/test_takeit_train.py` — smoke test on a fixture (100 rows) verifies model trains, predicts, and calibration reduces Brier.
- `ml/findings/takeit-v1-2026-05-XX/` — report dir with reliability curve, AUC, per-feature importance, and per-bucket calibration (by session_phase, ticker, dte) verifying no subgroup pathology.

Verify: out-of-fold AUC ≥ 0.62 for at least one of the two models (baseline = heuristic tier AUC, computed in Phase 1). Reliability curve within ±5pp of diagonal across 0.3–0.8 probability band. SHAP top-3 stability across folds ≥ 70% Jaccard.

### Phase 3 — Backend scoring + persistence

Output: every new alert lands with `takeit_prob` (real) and `takeit_top_features` (jsonb) populated.

Files:

- DB migration #N (next slot) — adds `takeit_prob`, `takeit_top_features`, `takeit_model_version` to both `lottery_finder_fires` and `silent_boom_alerts`. Backfill nulls.
- `api/_lib/takeit-score.ts` — loads model JSON export (LightGBM `model.txt` format) at cold start, computes prob inline. No Python in the hot path.
- `ml/src/takeit/export_model.py` — exports trained model to LightGBM text format + a JSON metadata sidecar (feature names, version, calibration spline).
- `api/cron/retrain-takeit.ts` — Saturday weekly cron triggers a Railway sidecar endpoint that re-runs `train.py` on the trailing 60 days and PUTs the new model to Vercel Blob; the Vercel function reloads on next cold start (no live hot-swap needed).
- Updates to `api/cron/detect-lottery-fires.ts` and `api/cron/detect-silent-boom.ts` to call `computeTakeitScore()` inline after the existing `computeLotteryScore()` / `computeSilentBoomScore()` calls.
- `api/__tests__/takeit-score.test.ts` — fixture verifies the TS scorer agrees with the Python scorer on a frozen set of 50 rows to within 1e-6.

Verify: detection cron tests still pass; smoke test against staging confirms `takeit_prob` is populated on new rows; backfill SQL fills historical rows from a one-shot script.

### Phase 4 — Frontend score tile

Output: a small "Take-It" tile on each [LotteryRow.tsx](src/components/LotteryFinder/LotteryRow.tsx) and Silent Boom row showing the probability, color band, and three green / three red flags. Click expands to show full SHAP waterfall.

Files:

- `src/components/AlertScore/TakeItScore.tsx` — presentation-only, takes `prob` + `top_features` props.
- `src/components/AlertScore/TakeItScoreExpanded.tsx` — modal/popover with full SHAP table.
- `src/components/LotteryFinder/LotteryRow.tsx` — wire props through.
- `src/components/SilentBoom/SilentBoomRow.tsx` — same.
- `src/__tests__/TakeItScore.test.tsx` — renders probability band correctly across [0.20, 0.45, 0.60, 0.75], renders red/green flag chips.
- `src/__tests__/TakeItScoreExpanded.test.tsx` — modal opens, lists all features, closes.

Verify: render in dev, eyeball that probabilities and flags display correctly on a known fire. Lighthouse / a11y unchanged.

### Phase 5 — Verification + ongoing calibration

Output: weekly Sentry-tracked metric of model calibration drift; trader-facing comparison of heuristic-tier vs takeit-prob across the last 30 days.

Files:

- `api/cron/audit-takeit-calibration.ts` — Monday cron computes Brier and reliability for the past week's fires (enriched outcomes now available) and emits a Sentry metric `takeit.brier.{lottery,silentboom}`.
- `docs/tmp/takeit-vs-heuristic-2026-05-XX.md` — first-month side-by-side: P(win) bucket × heuristic-tier bucket → realized win rate.

Verify: Sentry receives metrics for two consecutive Mondays; one-month report shows takeit-prob is monotonic in realized win rate (better than tier alone).

## Resolved Decisions

1. **Win label.** `peak_ceiling_pct ≥ 20%`. Rows where `peak_ceiling_pct` is null are dropped from training. The trail-30/10 metric is ignored — the model is judging alert quality at entry time, not exit execution. Threshold is tunable in Phase 1 once class balance is measured.
2. **SilentBoom sample gate.** Ship Lottery v1 first. Train script aborts SilentBoom training if `<500` labeled alerts available; auto-activates when the data ripens.
3. **Ticker encoding.** One-hot for the top-15 tickers + an `OTHER` bucket. LightGBM handles the cardinality fine.
4. **Model reload.** Vercel function cold-start is the propagation point. Worst-case ~1 hour from blob upload to live; acceptable for a weekly retrain cadence.

## Thresholds / Constants

```python
WIN_LABEL_THRESHOLD_PCT = 20       # peak_ceiling_pct ≥ this → win = 1
TRAINING_WINDOW_DAYS = 60
MIN_LABELED_SAMPLES = 500          # SilentBoom gate
WALK_FORWARD_FOLDS = 5
LIGHTGBM_NUM_LEAVES = 31
LIGHTGBM_MIN_DATA_IN_LEAF = 50
ISOTONIC_HOLDOUT_FRAC = 0.20
PROB_BANDS = [0.40, 0.55, 0.70]    # red / amber / green / deep-green
SHAP_TOP_K = 3                     # 3 green + 3 red flags surfaced
WEEKLY_RETRAIN_CRON = '0 12 * * 6' # Saturday noon UTC = 6 AM CT
BRIER_ALERT_THRESHOLD = 0.27       # Sentry-page if weekly Brier exceeds this
AUC_BASELINE_TIER = TBD            # filled in Phase 1; baseline to beat
```

## Out-of-Scope (v1)

- Historical-analogs panel ("last 12 similar fires") — deferred to v2.
- Recommended position size (Kelly) — deferred; user trades fixed size for now.
- Ensemble across alert types (a "is-the-day-tradeable" gate using both signals) — deferred.
- Auto-suppression of low-prob alerts from the feed — explicitly rejected; score-only is the v1 contract.
- Direct integration with `/api/analyze` (passing takeit-prob into the Claude context) — natural Phase 6.

## Risks

1. **Data leakage** is the highest-risk failure mode. Anti-mitigation: every feature has a strict `fire_time` cap; training set builder asserts `feature.ts ≤ alert.fire_time` on every row. Reviewer subagent at end of Phase 1 explicitly checks this.
2. **Distribution drift** as the user keeps shipping detector tweaks (e.g. recent ITM/OTM toggle, aggressive-premium chip changes the alert population). Weekly retrain on trailing 60 days is the mitigation; Phase 5 catches if drift outpaces retraining.
3. **SilentBoom sample thinness.** Only 17 days at spec time. Min-sample gate prevents shipping a noisy model; explicit in Phase 2.
4. **SHAP flag wording.** "Cheap-call PM tagged" means nothing to a trader at 11am. Phase 4 needs a feature → human-label mapping in `TakeItScore.tsx` so flags read like "🟢 Dealer −γ regime" not "🟢 dealer_gamma_sign=-1".
