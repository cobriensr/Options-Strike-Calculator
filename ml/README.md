# ML Pipeline

Machine learning pipeline for 0DTE SPX structure classification and day-type analysis.

## Quick Start

```bash
# All scripts use the venv at ml/.venv
ml/.venv/bin/python ml/health.py           # Check pipeline health first
ml/.venv/bin/python ml/explore.py           # Export/summarize data
ml/.venv/bin/python ml/eda.py               # Full exploratory analysis
ml/.venv/bin/python ml/clustering.py --plot # Day-type clustering with plots
ml/.venv/bin/python ml/phase2_early.py      # Structure classification
ml/.venv/bin/python ml/backtest.py          # P&L backtesting
ml/.venv/bin/python ml/visualize.py         # Generate all plots
ml/.venv/bin/python ml/pin_analysis.py      # Settlement pin risk
ml/.venv/bin/python ml/milestone_check.py   # Data milestone tracker
```

## Architecture

```
ml/
  utils.py            Shared constants, DB connection, feature group definitions
  explore.py          Data export and summary statistics
  eda.py              Exploratory data analysis (9 analysis sections)
  clustering.py       Phase 1: Unsupervised day-type clustering (KMeans/GMM/Hierarchical)
  phase2_early.py     Phase 2: Supervised structure classification (XGBoost walk-forward)
  backtest.py         P&L simulation comparing strategies
  visualize.py        8 publication-quality plots
  pin_analysis.py     Settlement pin risk analysis using per-strike gamma
  health.py           Pipeline health monitoring (freshness, completeness, stationarity)
  milestone_check.py  Data milestone tracker and script recommendations
  plots/              Generated plots (tracked in git)
  experiments/        Saved experiment results (JSON)
  .venv/              Python virtual environment
```

## Data Flow

All scripts query from the same three core tables via `utils.load_data()`:

```
training_features (daily feature vector, 100+ columns)
  LEFT JOIN outcomes (settlement, OHLC, VIX close)
  LEFT JOIN day_labels (Claude review labels, structure correctness)
```

The `build-features.ts` cron job populates `training_features` daily post-close by aggregating data from 15+ upstream tables.

## Feature Groups

Features are defined as shared constants in `utils.py` and composed into `ALL_NUMERIC_FEATURES` in each script. This prevents drift between scripts.

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

### Dark Pool (9 numeric + 1 categorical)

`dp_total_premium`, `dp_buyer_initiated`, `dp_seller_initiated`, `dp_cluster_count`, `dp_top_cluster_dist`, `dp_support_premium`, `dp_resistance_premium`, `dp_support_resistance_ratio`, `dp_concentration`

Categorical: `dp_net_bias` (one-hot encoded)

Source: `dark_pool_levels` table, populated every 1 minute during market hours by `fetch-darkpool.ts`. Features are aggregated daily by `build-features.ts`.

### Options Volume & Premium (15 features)

`opt_call_volume`, `opt_put_volume`, `opt_call_oi`, `opt_put_oi`, `opt_call_premium`, `opt_put_premium`, `opt_bullish_premium`, `opt_bearish_premium`, `opt_call_vol_ask`, `opt_put_vol_bid`, `opt_vol_pcr`, `opt_oi_pcr`, `opt_premium_ratio`, `opt_call_vol_vs_avg30`, `opt_put_vol_vs_avg30`

Source: Unusual Whales options activity API via `build-features.ts`.

### IV & PCR Dynamics (12 features)

`iv_open`, `iv_max`, `iv_range`, `iv_crush_rate`, `iv_spike_count`, `iv_at_t2`, `pcr_open`, `pcr_max`, `pcr_min`, `pcr_range`, `pcr_trend_t1_t2`, `pcr_spike_count`

Source: `iv_monitor` and `flow_ratio_monitor` tables (1-minute granularity), aggregated daily by `build-features.ts`.

### Max Pain (2 features)

`max_pain_0dte`, `max_pain_dist`

Source: `oi_per_strike` table via max pain calculation in `build-features.ts`.

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
7. **Dark Pool Signal** -- DP bias vs settlement, support/resistance ratio vs range, concentration analysis
8. **Options Volume & Premium** -- PCR vs settlement, bullish/bearish premium splits, unusual volume detection
9. **IV & PCR Dynamics** -- IV crush rate vs correctness, spike count vs range, PCR trend vs settlement

### clustering.py

Phase 1 unsupervised analysis:

- Runs KMeans, GMM, and Hierarchical clustering for k=2..6
- PCA dimensionality reduction (85% variance threshold)
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
- XGBoost feature importance + optional SHAP beeswarm plots
- Experiment results saved to `ml/experiments/`

### backtest.py

Simulates 0DTE credit spread trading:

- Claude Analysis strategy (confidence-based sizing)
- Majority Class baseline (always CCS)
- Equal Size baseline (1 contract)
- Equity curve plot with max drawdown highlighting
- Profit factor, win rate, max drawdown metrics

### visualize.py

Eight plots saved to `ml/plots/`:

1. **correlations.png** -- feature correlation heatmap (incl. dark pool, options, IV features)
2. **range_by_regime.png** -- range by charm pattern, VIX regime, GEX regime
3. **flow_reliability.png** -- flow source direction accuracy with Wilson CIs
4. **gex_vs_range.png** -- GEX scatter colored by charm pattern and correctness
5. **timeline.png** -- 4-panel daily overview (range, VIX, GEX, flow agreement)
6. **structure_confidence.png** -- structure accuracy and confidence calibration
7. **day_of_week.png** -- range distribution by day of week
8. **stationarity.png** -- rolling means for VIX, GEX, flow, dark pool premium, options PCR, IV

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

## Database Tables Used

| Table               | Script          | Usage                                         |
| ------------------- | --------------- | --------------------------------------------- |
| `training_features` | All scripts     | Daily feature vector (primary data source)    |
| `outcomes`          | All scripts     | Settlement, OHLC, VIX close for labeling      |
| `day_labels`        | All scripts     | Claude review labels, structure correctness   |
| `strike_exposures`  | pin_analysis.py | Per-strike gamma profiles at time checkpoints |
| `oi_per_strike`     | pin_analysis.py | Daily open interest by strike                 |

## Database Tables NOT Yet Used by ML

These tables contain data that could be engineered into future features:

| Table                    | Frequency | Potential Features                                            |
| ------------------------ | --------- | ------------------------------------------------------------- |
| `es_bars`                | 1-min     | Overnight price action, pre-market momentum                   |
| `es_overnight_summaries` | Daily     | Gap analysis, VWAP signal, fill probability                   |
| `iv_monitor`             | 1-min     | Intraday IV time-series dynamics (beyond daily aggregates)    |
| `flow_ratio_monitor`     | 1-min     | Intraday PCR dynamics (beyond daily aggregates)               |
| `market_alerts`          | On-demand | Alert frequency/severity as a feature                         |
| `dark_pool_levels`       | 1-min     | Intraday DP cluster formation dynamics                        |
| `dark_pool_snapshots`    | On-demand | Point-in-time DP state at analysis time                       |
| `economic_events`        | Daily     | Event type detail, surprise values (reported vs forecast)     |
| `lessons`                | Weekly    | Semantic similarity to current conditions (vector embeddings) |
| `positions`              | On-demand | Real vs simulated P&L validation                              |

## Adding New Features

1. Add the feature column to `training_features` via a new migration in `api/_lib/db.ts`
2. Populate it in `api/cron/build-features.ts`
3. Add the column name to the appropriate feature group list in `ml/utils.py`
4. The feature will automatically be included in clustering, classification, and EDA
5. For categorical features, add to `CATEGORICAL_FEATURES` in clustering.py and phase2_early.py
6. Optionally add to `KEY_FEATURE_COLUMNS` in health.py for monitoring

## Dependencies

```bash
ml/.venv/bin/pip install psycopg2-binary pandas sqlalchemy numpy scikit-learn xgboost matplotlib seaborn scipy statsmodels
# Optional: ml/.venv/bin/pip install shap  (for SHAP beeswarm plots)
```
