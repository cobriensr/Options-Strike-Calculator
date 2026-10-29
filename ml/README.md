# ML Pipeline

Python ML and research code for the strike calculator: the daily day-type and structure models (Phases 1-2), the Take-It alert-scoring model and Lottery score weights that feed the app, the multileg matcher used by `classifier/`, and dated research studies (flow, MOC imbalance, Periscope, futures setups).

## Quick Start

Python 3.13 (what CI uses). From the repo root:

```bash
python -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt   # Windows: ml/.venv/Scripts/pip install -r ml/requirements.txt
```

Scripts read `DATABASE_URL` from the environment, or from a `.env` file at the repo root (`load_env()` in `ml/src/utils/__init__.py`).

```bash
cd ml
make health        # Windows: make health PYTHON=.venv/Scripts/python
make all           # health eda cluster visualize early backtest pin nope flow calibration
```

The Makefile defaults `PYTHON` to `.venv/Scripts/python` on Windows and `.venv/bin/python` elsewhere (chosen by `$(OS)`), so no override is needed on either. To run one script directly: `ml/.venv/bin/python ml/src/eda.py` (Windows: `ml/.venv/Scripts/python ml/src/eda.py`).

| make target                    | Runs                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `health`                       | `src/health.py` (a failure doesn't stop `make all`)         |
| `eda`                          | `src/eda.py`                                                |
| `cluster`                      | `src/clustering.py --plot`                                  |
| `visualize`                    | `src/visualize.py`                                          |
| `early` / `early-shap`         | `src/phase2_early.py` (`--shap` adds SHAP beeswarm plots)   |
| `backtest`                     | `src/backtest.py`                                           |
| `pin`                          | `src/pin_analysis.py`                                       |
| `nope`                         | `src/nope_eda.py`                                           |
| `flow`                         | `src/flow_eda.py`                                           |
| `calibration`                  | `src/calibration.py`. **Not working:** see below            |
| `milestone`                    | `src/milestone_check.py`                                    |
| `full`                         | health + all + backtest + milestone                         |
| `test` / `test-cov` / `review` | pytest / pytest with a 70% coverage floor / lint + test-cov |
| `lint` / `format`              | `ruff check --fix` + `ruff format` (write mode)             |
| `clean`                        | deletes `plots/*.png`                                       |

`make calibration` (also part of `make all`) reads `trace_live_analyses`, which was dropped in migration #128 when TRACE Live was removed from the app. It finds no rows, prints a warning, and produces nothing useful.

## Architecture

```text
ml/
  Makefile            make targets for the classic pipeline, tests and lint
  requirements.txt    pinned runtime + test/lint deps
  pyproject.toml      ruff, pytest and coverage config
  conftest.py         puts ml/src and ml/tests on sys.path
  src/                all pipeline code (see "Script Details" and "Other modules")
    utils/            shared constants, DB connection, feature groups, findings writer
    takeit/           Take-It model: training set, training, export, SHAP
    setups_backtest/  walk-forward backtest harness for 8 futures setups
    ...               research packages: imbalance/, nq_flow_leadership/, periscope_eda/, options_features/, features/
  tests/              pytest suite (52 test modules as of 2026-10-29)
  docs/               ROADMAP.md, PHASE-*.md, research findings write-ups
  plots/              generated plots, tracked in git (83 top-level PNGs plus 19 per-study subfolders, as of 2026-10-29)
  findings/, reports/ dated research outputs (JSON / Markdown)
  experiments/        saved experiment results (JSON, Markdown reports)
  output/             lottery_score_weights.json, synced into the app
  findings.json       consolidated pipeline findings (also upserted into the ml_findings table)
  notebooks/          exploratory scripts
  *.py at ml/ root    IV-anomaly study scripts (2026-04-25)
  data/               local training data and model bundles (gitignored)
  .venv/              virtual environment (gitignored)
```

## Data Flow

The classic scripts (`explore`, `eda`, `clustering`, `phase2_early`, `backtest`, `visualize`, `health`) read the daily feature vector through `utils.load_data(sql)`, which runs whatever SQL the caller passes. They use the same three-table join:

```text
training_features (daily feature vector, 100+ columns)
  LEFT JOIN outcomes (settlement, OHLC, VIX close)
  LEFT JOIN day_labels (Claude review labels, structure correctness)
```

The `build-features.ts` cron job populates `training_features` daily post-close by aggregating data from 15+ upstream tables. `save_section_findings()` writes each script's results into `ml/findings.json` and upserts the whole file into the `ml_findings` table, which the app's ML research carousel reads. Newer pipelines read other tables (see "Database Tables Used").

## Feature Groups

Features are defined as shared constants in `ml/src/utils/__init__.py` and composed into `ALL_NUMERIC_FEATURES` in each script. This prevents drift between scripts.

### Volatility (4 features)

`vix`, `vix1d`, `vix1d_vix_ratio`, `vix_vix9d_ratio`

### GEX (6 features)

`gex_oi_t1/t2`, `gex_vol_t1/t2`, `gex_dir_t1/t2`

### Greek Exposure (4 core + 2 charm OI in clustering)

`agg_net_gamma`, `dte0_net_charm`, `dte0_charm_pct`, `charm_slope`, `charm_oi_t1/t2`

### Flow Checkpoints (32 features in clustering, 20 in phase2)

Market Tide, SPX/SPY/QQQ net flow, ETF Tide, 0DTE flow, delta flow at T1-T2 (and T3-T4 in some scripts).

### Flow Aggregates (6 features)

`flow_agreement_t1/t2`, `etf_tide_divergence_t1/t2`, `ncp_npp_gap_spx_t1/t2`

### Per-Strike Greek Features (6 features, phase2 only)

`gamma_wall_above_dist`, `gamma_wall_below_dist`, `neg_gamma_nearest_dist`, `gamma_asymmetry`, `charm_max_pos_dist`, `charm_max_neg_dist`

### Dark Pool (7 features)

`dp_total_premium`, `dp_cluster_count`, `dp_top_cluster_dist`, `dp_support_premium`, `dp_resistance_premium`, `dp_support_resistance_ratio`, `dp_concentration`

Source: `dark_pool_prints` (SPY and QQQ off-lit prints from the uw-stream `off_lit_trades` channel; SPX levels are scaled from SPY), read through `api/_lib/dark-pool-query.ts` and aggregated daily by `build-features.ts`.

### Options Volume & Premium (15 features)

`opt_call_volume`, `opt_put_volume`, `opt_call_oi`, `opt_put_oi`, `opt_call_premium`, `opt_put_premium`, `opt_bullish_premium`, `opt_bearish_premium`, `opt_call_vol_ask`, `opt_put_vol_bid`, `opt_vol_pcr`, `opt_oi_pcr`, `opt_premium_ratio`, `opt_call_vol_vs_avg30`, `opt_put_vol_vs_avg30`

Source: Unusual Whales options activity API via `build-features.ts`.

### IV & PCR Dynamics (12 features)

`iv_open`, `iv_max`, `iv_range`, `iv_crush_rate`, `iv_spike_count`, `iv_at_t2`, `pcr_open`, `pcr_max`, `pcr_min`, `pcr_range`, `pcr_trend_t1_t2`, `pcr_spike_count`

Source: `iv_monitor` and `flow_ratio_monitor`, aggregated by `api/_lib/build-features-monitor.ts`. `flow_ratio_monitor` is written by `api/cron/monitor-flow-ratio.ts`. `iv_monitor` has had no live writer since 2026-04-30; only `scripts/backfill-iv-monitor.mjs` fills it.

### Max Pain (2 features)

`max_pain_0dte`, `max_pain_dist`

Source: `oi_per_strike` table via max pain calculation in `build-features.ts`.

### OI Change (11 features), Vol Surface (7 features)

`oic_*` open-interest change and premium features; IV term structure (`iv_ts_slope_0d_30d`, `iv_ts_contango`, `iv_ts_spread`), realized vol (`uw_rv_30d`, `uw_iv_rv_spread`, `uw_iv_overpricing_pct`) and `iv_rank`. Both are used by clustering and phase2.

### NOPE (7 features, nope_eda.py only)

`nope_t1`..`nope_t4`, `nope_am_mean`, `nope_am_sign_flips`, `nope_am_cum_delta`

### Futures (33 features, defined but unused)

ES/NQ/VX/ZN/RTY/CL/ES-options groups exist in `utils` and as nullable `training_features` columns. No ML script uses them and nothing populates them: there is no producer in `build-features`, and the VX and ES-options sources ended with Databento on 2026-09-29.

### Phase 2 Temporal Features (10 features, phase2 only)

`prev_day_range_pts`, `prev_day_vix_change`, `realized_vol_5d`, `realized_vol_10d`, `rv_iv_ratio`, `vix_term_slope`, `vvix_percentile`, `is_fomc`, `is_opex`, `days_to_next_event`

### Regime & Calendar (6-8 features)

`cluster_mult`, `dow_mult`, `sigma`, `regime_zone` (categorical), `day_of_week`, `is_friday`, `is_event_day`

### Calculator Outputs (3-4 features)

`ic_ceiling`, `put_spread_ceiling`, `call_spread_ceiling`, `sigma`

## Script Details

### explore.py

Pulls all data from `training_features` + `outcomes` + `day_labels` and prints summary statistics. Supports `--csv` export and date filtering.

### eda.py

Nine analysis sections:

1. **Rule Validation** -- tests trading rules (GEX -> range, VIX1D inversion, charm patterns, flow agreement)
2. **Confidence Calibration** -- is Claude's confidence predictive of accuracy?
3. **Structure Outcomes** -- which structures work, failure pattern analysis
4. **Feature Importance** -- point-biserial correlation with correctness, Kruskal-Wallis for range category, FDR correction
5. **Charm Pattern Deep Dive** -- charm x GEX interaction effects
6. **Flow Source Reliability** -- per-source direction prediction accuracy with Wilson CIs
7. **Dark Pool Signal** -- support/resistance ratio vs range, concentration analysis
8. **Options Volume & Premium** -- PCR vs settlement, bullish/bearish premium splits, unusual volume detection
9. **IV & PCR Dynamics** -- IV crush rate vs correctness, spike count vs range, PCR trend vs settlement

### clustering.py

Phase 1 unsupervised analysis:

- Runs KMeans, GMM, and Hierarchical clustering for k=2..min(6, n-1)
- PCA inside an impute → scale → PCA pipeline. Components = about one per 8 samples, clamped to 3-15 (and to the sample and feature counts)
- Silhouette, Calinski-Harabasz, Davies-Bouldin metrics
- Leave-one-out stability check
- Permutation test (is clustering better than chance?)
- Chi-squared outcome association tests
- Cluster profiles include: volatility, GEX, flow, dark pool, options PCR, IV, charm, calendar, outcomes

### phase2_early.py

Phase 2 supervised classification:

- Walk-forward expanding-window validation (no lookahead bias)
- 5 models compared: XGBoost, Logistic Regression, Random Forest, Naive Bayes, Decision Tree
- 3-class target: CCS / PCS / IC
- Per-class F1, log loss, majority-class and previous-day baselines
- XGBoost feature importance; SHAP beeswarm plots with `make early-shap` (`--shap`)
- Experiment results saved to `ml/experiments/`

### backtest.py

Simulates 0DTE credit spread trading:

- Claude Analysis strategy (confidence-based sizing)
- Majority Class baseline (always CCS)
- Equal Size baseline (1 contract)
- Equity curve plot with max drawdown highlighting
- P&L distribution histogram per strategy
- Profit factor, win rate, max drawdown metrics

### visualize.py

Seventeen plots saved to `ml/plots/`:

1. **correlations.png** -- feature correlation heatmap (incl. dark pool, options, IV features)
2. **range_by_regime.png** -- range by charm pattern, VIX regime, GEX regime
3. **flow_reliability.png** -- flow source direction accuracy with Wilson CIs
4. **structure_by_vix.png** -- structure accuracy per VIX regime
5. **rolling_accuracy.png** -- 10-day rolling model accuracy with a drift indicator
6. **flow_by_vix.png** -- flow signal reliability by VIX regime bucket
7. **gex_vs_range.png** -- GEX scatter colored by charm pattern and correctness
8. **timeline.png** -- 4-panel daily overview (range, VIX, GEX, flow agreement)
9. **structure_confidence.png** -- structure accuracy and confidence calibration
10. **day_of_week.png** -- range distribution by day of week
11. **stationarity.png** -- rolling means for VIX, GEX, flow, dark pool premium, options PCR, IV
12. **failure_heatmap.png** -- GEX vs VIX heatmap colored by accuracy rate
13. **dark_pool_vs_range.png** -- dark pool premium vs range, colored by support/resistance ratio
14. **cone_consumption.png** -- opening range cone consumption vs structure correctness
15. **prev_day_transition.png** -- previous day range/VIX change vs current day outcomes
16. **confidence_over_time.png** -- rolling accuracy by confidence level, for calibration drift
17. **feature_importance_comparison.png** -- EDA correlation vs XGBoost gain for the top features

### health.py

Five pipeline health checks:

1. **Data Freshness** -- are training_features, outcomes, day_labels current?
2. **Feature Completeness Trend** -- is completeness stable or declining?
3. **Label Extraction Health** -- label coverage vs feature coverage
4. **Column Coverage** -- null rates for key features (incl. dark pool, options PCR, IV, max pain)
5. **Stationarity Alerts** -- regime shift detection via z-scores on rolling means

### pin_analysis.py

Settlement pin risk analysis:

- Queries `strike_exposures` for per-strike gamma profiles at multiple time horizons
- Measures how often settlement lands near peak gamma strike
- Compares gamma-weighted centroid vs peak gamma as predictors
- Gamma asymmetry vs settlement direction analysis
- Integrates `oi_per_strike` and `max_pain_0dte` data

## Other modules

One line each, from each module's docstring. "Root `make`" means the repo-root `Makefile`, which sets `PYTHON := ml/.venv/Scripts/python` on Windows (`ml/.venv/bin/python` elsewhere, chosen by `$(OS)`) and `SHELL := /bin/bash`.

| Module                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                             | How it runs                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/nope_eda.py`                                                                                          | SPY NOPE EDA: directional, agreement and regime plots                                                                                                                                                                                                                                                               | `make nope`                                                                                                               |
| `src/flow_eda.py`                                                                                          | Flow Alerts EDA: distributions, time-of-day, direction, returns                                                                                                                                                                                                                                                     | `make flow`                                                                                                               |
| `src/calibration.py`                                                                                       | TRACE Live calibration: confidence vs actual hit rate. Its table is gone (see Quick Start)                                                                                                                                                                                                                          | `make calibration`                                                                                                        |
| `src/takeit/` (`build_training_set`, `train`, `export_model`, `shap_explainer`, `generate_parity_fixture`) | Take-It score: per-alert calibrated XGBoost win probability for Lottery and Silent Boom fires. Writes `ml/data/takeit/` and `ml/findings/takeit-v1-<date>/`. `scripts/upload_takeit_bundles.mjs` uploads the bundles to private Blob (`takeit/latest.json` manifest) for the TS scorer and the sidecar's SHAP route | from the repo root: `PYTHONPATH=. ml/.venv/bin/python -m ml.src.takeit.build_training_set`, then `-m ml.src.takeit.train` |
| `src/takeit_drift_monitor.py`                                                                              | Daily Take-It drift and validation: rolling AUC and reliability; writes `takeit_health_daily` and `plots/takeit-drift/`                                                                                                                                                                                             | root `make takeit-drift` (also run by root `make update`)                                                                 |
| `src/lottery_scoring.py`                                                                                   | Lottery fire score weights (rescore-v1). Writes `ml/output/lottery_score_weights.json`, which `scripts/sync_lottery_score_weights_v2.py` syncs into TS                                                                                                                                                              | root `make refit` (part of `make update`)                                                                                 |
| `src/score_components.py`                                                                                  | V2 lottery score component recovery                                                                                                                                                                                                                                                                                 | library                                                                                                                   |
| `src/enrich_lottery_outcomes.py`, `src/lottery_exit_policies.py`                                           | Realized exit-policy outcomes for `lottery_finder_fires`; the exit-policy math is reused by `scripts/enrich_silent_boom_outcomes.py`                                                                                                                                                                                | manual; the exit policies run via root `make enrich`                                                                      |
| `src/multileg_assembler.py`, `src/multileg_patterns.py`                                                    | Multileg spread pattern matcher for UW Full Tape trades. Source of truth for `classifier/_vendored_ml/`                                                                                                                                                                                                             | imported by the classifier service                                                                                        |
| `src/setups_backtest/`                                                                                     | Walk-forward harness, point-in-time features and metrics for 8 futures setups (NQ OFI extreme, NQ-leads-ES, overnight sweep, basis stress, zero-gamma magnet, CVD divergence, flight to safety, mega-cap earnings)                                                                                                  | `cd ml && .venv/bin/python -m src.setups_backtest.cli run --setup N --start ... --end ... --out ...`                      |
| `src/day_analog_parity.py`                                                                                 | Parity check: frozen Databento archive vs `futures_bars` for day analogs                                                                                                                                                                                                                                            | manual                                                                                                                    |
| `src/eod_flow_*.py`, `src/flow_archive.py`, `src/flow_outliers.py`, `src/flow_outcomes.py`                 | Bot EOD options-flow archive: ingest, baselines, bursts, decomposition, forward returns, outliers                                                                                                                                                                                                                   | manual                                                                                                                    |
| `src/moc_*.py`, `src/imbalance/`                                                                           | MOC / closing-auction imbalance study (phases 1-7)                                                                                                                                                                                                                                                                  | manual                                                                                                                    |
| `src/nq_flow_leadership/`                                                                                  | NQ flow leadership: flow features vs forward NQ returns, QQQ sweep backtest                                                                                                                                                                                                                                         | manual                                                                                                                    |
| `src/periscope_eda/`, `src/periscope_gamma_wall_lib.py`, `src/compute_realized_outcomes.py`                | Periscope read calibration and gamma-level studies (see [`periscope_eda/README.md`](src/periscope_eda/README.md))                                                                                                                                                                                                   | manual                                                                                                                    |
| `src/microstructure_eda.py`, `src/features/microstructure.py`                                              | Microstructure (TBBO/OFI) features over the local archive. The OFI finding was superseded on 2026-10-28 (see Docs)                                                                                                                                                                                                  | manual                                                                                                                    |
| `src/options_features/`                                                                                    | Per-bar options features, event calendars, VIX family series                                                                                                                                                                                                                                                        | library                                                                                                                   |
| `src/cross_section_eda*.py`, `src/payoff_eda_probe.py`, `src/vega_spike_eda.py`, `src/whale_plots.py`      | Lottery/Silent Boom cross-section EDA, payoff probe, vega spike EDA, whale-move plots                                                                                                                                                                                                                               | manual; `whale_plots.py` via root `make plots`                                                                            |
| `src/load_flow_alerts.py`                                                                                  | Loaders for `flow_alerts`                                                                                                                                                                                                                                                                                           | library                                                                                                                   |
| `src/utils/r2.py`                                                                                          | R2 parquet read helper for the UW Full Tape archive                                                                                                                                                                                                                                                                 | none (no active callers)                                                                                                  |

On Windows, use `ml/.venv/Scripts/python` (or `.venv/Scripts/python` from `ml/`) in place of the `bin/python` paths above.

## Database Tables Used

| Table                                        | Script                                                                                                      | Usage                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `training_features`                          | Classic scripts                                                                                             | Daily feature vector (primary data source)    |
| `outcomes`                                   | Classic scripts                                                                                             | Settlement, OHLC, VIX close for labeling      |
| `day_labels`                                 | Classic scripts                                                                                             | Claude review labels, structure correctness   |
| `strike_exposures`                           | pin_analysis.py                                                                                             | Per-strike gamma profiles at time checkpoints |
| `oi_per_strike`                              | pin_analysis.py                                                                                             | Daily open interest by strike                 |
| `lottery_finder_fires`, `silent_boom_alerts` | `takeit/build_training_set.py`, `lottery_scoring.py`, `enrich_lottery_outcomes.py`, `cross_section_eda*.py` | Fire features and outcomes                    |
| `takeit_health_daily`                        | `takeit_drift_monitor.py`                                                                                   | Drift metrics (write)                         |
| `periscope_analyses`                         | `compute_realized_outcomes.py`, `periscope_eda/`                                                            | Periscope read outcomes                       |
| `flow_alerts`                                | `load_flow_alerts.py`                                                                                       | Flow alerts                                   |
| `futures_bars`                               | `day_analog_parity.py`, `setups_backtest/`, `nq_flow_leadership/`                                           | 1-min futures bars                            |
| `economic_events`                            | `cross_section_eda*.py`                                                                                     | Event calendar                                |
| `ml_findings`                                | `utils.save_section_findings`                                                                               | Consolidated findings (write)                 |

## Database Tables NOT Yet Used by ML

These tables contain data that could be engineered into future features:

| Table                                     | Frequency | Potential Features                                                    |
| ----------------------------------------- | --------- | --------------------------------------------------------------------- |
| `futures_bars` (beyond the studies above) | 1-min     | Overnight price action, pre-market momentum (ES, NQ, RTY, CL, GC, ZN) |
| `iv_monitor`                              | 1-min     | Intraday IV time-series dynamics. No live writer since 2026-04-30     |
| `flow_ratio_monitor`                      | 1-min     | Intraday PCR dynamics (beyond daily aggregates)                       |
| `market_alerts`                           | On-demand | Alert frequency/severity as a feature                                 |
| `dark_pool_prints`                        | Per print | Intraday dark-pool cluster formation (SPY, QQQ)                       |
| `dark_pool_snapshots`                     | On-demand | Point-in-time DP state at analysis time                               |
| `lessons`                                 | Weekly    | Semantic similarity to current conditions (vector embeddings)         |
| `positions`                               | On-demand | Real vs simulated P&L validation                                      |

## Adding New Features

1. Add the column to `training_features` with a new migration in `api/_lib/db-migrations.ts` (and update `api/__tests__/db.test.ts`).
2. Compute it in `api/cron/build-features.ts` or one of its helpers (`api/_lib/build-features-*.ts`). If it can be NULL, add it to `NULLABLE_FEATURE_KEYS` in `api/_lib/build-features-upsert.ts`.
3. Add the column name to the right feature group in `ml/src/utils/__init__.py`.
4. Scripts that compose that group (clustering, phase2_early, eda) pick it up automatically.
5. For a categorical feature, add it to `CATEGORICAL_FEATURES` in `ml/src/clustering.py` and `ml/src/phase2_early.py`.
6. Optionally add it to `KEY_FEATURE_COLUMNS` in `ml/src/health.py` for monitoring.

## Tests

`make test` (pytest over `ml/tests/`), `make test-cov` (70% floor; the run-once research scripts are omitted from coverage, see `pyproject.toml`), `make review` (ruff auto-fix + test-cov). CI's ML Quality Gate runs `make review` on Python 3.13 whenever `ml/**` changes. On Windows add `PYTHON=.venv/Scripts/python`.

## Automation

`.github/workflows/ml-pipeline.yml` was built to run `make lint` and `make all` on a schedule (01:45 UTC Tue–Sat), upload `ml/plots/*.png` to private Vercel Blob under `ml-plots/latest/`, ask the app for a Claude read of each plot, and commit `findings.json` and the plots. A second job retrains the Take-It models, warns when a model's out-of-fold Brier score is above 0.27, and uploads new bundles. **The workflow is disabled (`disabled_manually`); its last run was 2026-04-17.** Run the steps by hand with `make all`.

The daily research refresh lives in the repo-root `Makefile`: `make nightly` (EOD options-flow ingest, plots, enrichment) and `make update` (enrich, refit, Take-It drift).

## Docs

- [docs/ROADMAP.md](docs/ROADMAP.md): phase plan and model list
- [docs/PHASE-0-DATA-INFRASTRUCTURE.md](docs/PHASE-0-DATA-INFRASTRUCTURE.md), [PHASE-1](docs/PHASE-1-DAY-TYPE-CLUSTERING.md), [PHASE-1.5](docs/PHASE-1.5-EXPLORATORY-ANALYSIS.md), [PHASE-2](docs/PHASE-2-STRUCTURE-CLASSIFICATION.md)
- [docs/FULL-TAPE-ML-ROADMAP.md](docs/FULL-TAPE-ML-ROADMAP.md), [docs/MOC-IMBALANCE-FINDING.md](docs/MOC-IMBALANCE-FINDING.md), [docs/PRESENTING-THE-DATA.md](docs/PRESENTING-THE-DATA.md)
- [docs/MICROSTRUCTURE-OFI-FINDING.md](docs/MICROSTRUCTURE-OFI-FINDING.md): the NQ order-flow (OFI) result, **superseded** by [docs/OFI-POINT-IN-TIME-2026-10-28.md](docs/OFI-POINT-IN-TIME-2026-10-28.md), a point-in-time test that found no predictive edge

## Dependencies

```bash
ml/.venv/bin/pip install -r ml/requirements.txt   # Windows: ml/.venv/Scripts/pip install -r ml/requirements.txt
```

Includes the test and lint tools (pytest, pytest-cov, hypothesis, ruff) and `shap`. `scikit-learn` is pinned to the same version as `sidecar/requirements.txt`, because the Take-It bundles pickle sklearn objects: bump both together and re-export.
