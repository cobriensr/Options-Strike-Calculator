# Phase 2: Structure Classification

**Status:** Early experiment running (25 labeled days, targeting 60-80)
**Prerequisites:** Phase 0 complete, 60-80 labeled trading days
**Goal:** Predict which structure (CCS, PCS, IC, SIT OUT) will be correct today, before chart analysis

---

## Problem Definition

Given the morning market state (VIX regime, GEX, first-hour flow, charm pattern, per-strike structure), predict which trade structure Claude's EOD review will mark as correct.

**Output:** Probability distribution across 4 classes:

```text
CCS: 68%  |  PCS: 18%  |  IC: 10%  |  SIT OUT: 4%
```

This is a **pre-analysis prior**, not a trading signal. It tells you "historically, days that looked like today were CCS days 68% of the time." The Claude chart analysis confirms or overrides this.

---

## Current Data Assessment (as of 2026-03-31)

### What we have

| Metric                                 | Count                                | Notes                                     |
| -------------------------------------- | ------------------------------------ | ----------------------------------------- |
| Days with features + labels + outcomes | 34                                   | Minimum for Phase 2 is 60-80              |
| Days with completeness >= 80%          | 25                                   | Used for walk-forward validation          |
| CCS labels                             | 19 (17 correct, 2 wrong)             | 56% of labels — majority class            |
| PCS labels                             | 11 (11 correct, 0 wrong)             | 32% of labels — perfect so far            |
| IC labels                              | 4 (3 correct, 1 wrong)               | 12% of labels — sparse                    |
| SIT OUT labels                         | 0                                    | Not yet observed                          |
| Feature completeness (labeled days)    | 95-98% for recent, 54-74% for oldest | Older days missing ETF tide, 0DTE sources |
| Periscope charm labels                 | 4 days                               | Too few for charm divergence feature      |

### Class imbalance problem

The majority class baseline (always predict CCS) is 55%. The model must beat this significantly to be useful. With only 4 IC days and 0 SIT OUT days, the model will struggle to learn minority classes.

**Mitigation strategies:**

1. **Class weighting** — XGBoost `scale_pos_weight` or `sample_weight` to penalize majority class errors more
2. **Stratified walk-forward** — Ensure each fold has all classes represented
3. **Binary cascade** — First predict "directional vs neutral" (CCS/PCS vs IC/SIT OUT), then predict direction within the directional bucket
4. **Accumulate more data** — The most reliable fix. At current rate, 60 labeled days by ~mid-May 2026

### Data gaps to address BEFORE Phase 2 training

These features should be added to `build-features.ts` while we wait for data accumulation:

#### 1. Previous day features (derivable from outcomes table)

| Feature                   | Derivation                                     | Why it matters                 |
| ------------------------- | ---------------------------------------------- | ------------------------------ |
| `prev_day_range_pts`      | Yesterday's `day_range_pts` from outcomes      | Momentum — wide days cluster   |
| `prev_day_direction`      | Yesterday's `settlement_direction` (UP/DOWN)   | Mean reversion vs continuation |
| `prev_day_vix_change`     | Today's VIX open minus yesterday's `vix_close` | Overnight vol shock            |
| `prev_day_range_category` | Yesterday's `range_category`                   | Regime persistence             |

#### 2. Trailing realized volatility

| Feature            | Derivation                                                        | Why it matters         |
| ------------------ | ----------------------------------------------------------------- | ---------------------- |
| `realized_vol_5d`  | Std dev of daily returns over last 5 trading days (from outcomes) | Recent vol regime      |
| `realized_vol_10d` | Std dev of daily returns over last 10 trading days                | Longer-term baseline   |
| `rv_iv_ratio`      | `realized_vol_5d / (VIX / sqrt(252))`                             | Rich/cheap implied vol |

#### 3. Event type specifics

Currently `is_event_day` is binary. Enrich with:

| Feature              | Source                                    | Why it matters                                       |
| -------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `event_type`         | `eventCalendar.ts` data                   | FOMC days behave differently from CPI days           |
| `is_fomc`            | Boolean                                   | FOMC days have unique vol compression then expansion |
| `is_opex`            | Boolean (3rd Friday or monthly/quarterly) | Options expiration affects gamma/charm dynamics      |
| `days_to_next_event` | Integer                                   | Market often pre-positions 1-2 days before events    |

#### 4. VIX term structure features

| Feature           | Derivation                             | Why it matters                                        |
| ----------------- | -------------------------------------- | ----------------------------------------------------- |
| `vix_term_slope`  | `(VIX9D - VIX1D) / VIX`                | Normalized term structure — contango vs backwardation |
| `vvix_percentile` | VVIX relative to trailing 20-day range | Vol-of-vol regime                                     |

---

## Model Architecture

### Multi-model comparison (implemented in `phase2_early.py`)

The pipeline runs 5 models through walk-forward validation and prints a comparison table. This determines whether XGBoost actually outperforms simpler baselines at the current sample size.

| Model                        | Type           | Key settings                            | NaN handling      |
| ---------------------------- | -------------- | --------------------------------------- | ----------------- |
| **XGBoost**                  | Gradient boost | depth=3, 50 trees, L1+L2 regularization | Native            |
| **Logistic Regression (L2)** | Linear         | C=1.0, StandardScaler, lbfgs solver     | Median imputation |
| **Random Forest (15)**       | Ensemble trees | 15 trees, depth=3                       | Median imputation |
| **Naive Bayes**              | Probabilistic  | Gaussian                                | Median imputation |
| **Decision Tree (d=2)**      | Single tree    | depth=2 (decision stump)                | Median imputation |

sklearn models are wrapped in `Pipeline(SimpleImputer → [StandardScaler →] Model)` since they can't handle NaN natively.

### Why this model set

- **XGBoost** — handles missing values natively, built-in regularization, feature importance
- **Logistic Regression** — interpretable coefficients, strong baseline for small n, handles high feature-to-sample ratios with L2 penalty
- **Random Forest** — feature importance, low variance with few trees, no feature scaling needed
- **Naive Bayes** — works surprisingly well with tiny datasets, fast
- **Decision Tree** — reveals simple decision rules the data supports, directly interpretable

At n < 100, simpler models often outperform complex ones. If logistic regression beats XGBoost, use it — interpretability matters for trading decisions.

### Feature groups (using T1-T2 features per EDA recommendation)

**Group 1: Volatility regime (always available)**

- `vix`, `vix1d`, `vix9d`, `vvix`
- `vix1d_vix_ratio`, `vix_vix9d_ratio`
- `vix_term_slope`, `vvix_percentile` (new)
- `prev_day_vix_change` (new)

**Group 2: GEX/Greek regime**

- `gex_oi_t1`, `gex_oi_t2`, `gex_dir_t1`, `gex_dir_t2`, `gex_vol_t1`, `gex_vol_t2`
- `agg_net_gamma`
- `dte0_net_charm`, `dte0_charm_pct`
- `charm_slope`, `charm_pattern` (one-hot encoded)

**Group 3: Flow signals (first hour)**

- `mt_ncp_t1`, `mt_npp_t1`, `mt_ncp_t2`, `mt_npp_t2`
- `spx_ncp_t1`, `spy_ncp_t1`, `qqq_ncp_t1` (+ t2 variants)
- `spy_etf_ncp_t1`, `qqq_etf_ncp_t1` (+ t2 variants)
- `flow_agreement_t1`, `flow_agreement_t2`
- `etf_tide_divergence_t1`, `ncp_npp_gap_spx_t1`

**Group 4: Per-strike structure**

- `gamma_wall_above_dist`, `gamma_wall_below_dist`
- `neg_gamma_nearest_dist`, `gamma_asymmetry`
- `charm_max_pos_dist`, `charm_max_neg_dist`
- `gamma_0dte_allexp_agree`

**Group 5: Calendar/context**

- `day_of_week`, `is_friday`
- `is_event_day`, `is_fomc`, `is_opex` (new)
- `regime_zone`, `cluster_mult`, `dow_mult`

**Group 6: Historical context (new)**

- `prev_day_range_pts`, `prev_day_direction`, `prev_day_range_category`
- `realized_vol_5d`, `realized_vol_10d`, `rv_iv_ratio`

**Group 7: Calculator outputs**

- `ic_ceiling`, `put_spread_ceiling`, `call_spread_ceiling`
- `sigma`, `opening_range_signal`, `opening_range_pct_consumed`

### Target encoding

```python
label_map = {
    "CALL CREDIT SPREAD": 0,
    "PUT CREDIT SPREAD": 1,
    "IRON CONDOR": 2,
    "SIT OUT": 3,
}
```

### Hyperparameters (starting point)

```python
params = {
    "objective": "multi:softprob",
    "num_class": 4,   # or 3 if SIT OUT still absent
    "max_depth": 3,    # shallow trees for small dataset
    "n_estimators": 50,  # few trees to prevent overfitting
    "learning_rate": 0.1,
    "min_child_weight": 3,  # prevent overfitting to rare classes
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 1.0,   # L1 regularization
    "reg_lambda": 2.0,  # L2 regularization
}
```

Low depth, few trees, high regularization — appropriate for 60-80 samples.

---

## Validation Strategy

### Walk-forward cross-validation

```text
Fold 1: Train on days 1-30,  predict day 31
Fold 2: Train on days 1-31,  predict day 32
Fold 3: Train on days 1-32,  predict day 33
...
Fold N: Train on days 1-79,  predict day 80
```

**Expanding window** (not sliding) because we don't have enough data to throw away old observations.

### Metrics

| Metric           | What it tells you                      | Target                                            |
| ---------------- | -------------------------------------- | ------------------------------------------------- |
| **Accuracy**     | Overall correct predictions            | Must beat 55% (majority class)                    |
| **Log loss**     | Calibration of probability estimates   | Lower is better                                   |
| **Per-class F1** | Precision/recall balance per structure | Focus on minority classes                         |
| **Brier score**  | Probability calibration                | When model says 70%, is it right 70% of the time? |

### Baselines to beat

| Baseline       | Method                                         | Expected accuracy |
| -------------- | ---------------------------------------------- | ----------------- |
| Majority class | Always predict CCS                             | 55%               |
| Previous day   | Predict yesterday's structure                  | ~40-50%           |
| VIX-only rule  | VIX < 20 → IC, VIX 20-25 → CCS, VIX > 25 → PCS | ~45-55%           |
| Rule 16 only   | Use GEX regime to pick structure               | ~50-60%           |

The model should target **65-70% accuracy** with well-calibrated probabilities.

---

## Feature Engineering TODO

These changes should be made to `build-features.ts` now so the features accumulate alongside existing data:

### Add to `training_features` table

```sql
-- Previous day features
prev_day_range_pts    DECIMAL(10,2),
prev_day_direction    TEXT,            -- 'UP' or 'DOWN'
prev_day_vix_change   DECIMAL(6,2),
prev_day_range_cat    TEXT,            -- 'NARROW', 'NORMAL', 'WIDE', 'EXTREME'

-- Trailing realized vol
realized_vol_5d       DECIMAL(10,6),
realized_vol_10d      DECIMAL(10,6),
rv_iv_ratio           DECIMAL(6,4),

-- VIX term structure
vix_term_slope        DECIMAL(6,4),
vvix_percentile       DECIMAL(5,4),

-- Event specifics
event_type            TEXT,            -- 'FOMC', 'CPI', 'JOBS', 'OPEX', 'OTHER', NULL
is_fomc               BOOLEAN,
is_opex               BOOLEAN,
days_to_next_event    INTEGER
```

### Implementation notes

**Previous day features:** Query outcomes table for `date = current_date - 1 business day`. Need a helper to find the previous trading day (skip weekends and holidays).

**Realized vol:** Query last 5/10 outcomes, compute `std(ln(settlement[i] / settlement[i-1]))`, annualize by `* sqrt(252)`.

**RV/IV ratio:** `realized_vol_5d / (vix / 100 / sqrt(252))` — but VIX is already annualized, so simplify to `realized_vol_5d / (vix / 100)`.

**Event specifics:** Parse from `eventCalendar.ts` data. The event calendar already exists in `src/data/eventCalendar.ts` — import and query by date.

**VVIX percentile:** Requires trailing 20-day VVIX values. Query `market_snapshots` for last 20 dates with VVIX, compute percentile rank of today's VVIX.

---

## Training Pipeline (Python)

```text
ml/
├── phase2_early.py          # Walk-forward multi-model comparison (implemented)
├── phase2_train.py          # Full training + deployment (future, at 60+ days)
├── phase2_predict.py        # Load model, predict today (future)
├── experiments/             # Saved experiment JSON files
│   └── phase2_early_YYYY-MM-DD_v2.json
└── plots/
    └── phase2_shap.png      # SHAP beeswarm (with --shap flag)
```

### Running the pipeline

```bash
cd ml

# Run the early feasibility experiment (multi-model comparison)
make early

# Run with SHAP feature importance plots
make early-shap

# Run the full pipeline (EDA + clustering + visualizations)
make all

# Run everything including backtest and milestones
make full
```

### What `make early` outputs

1. **Data summary** — labeled days, class distribution, feature count
2. **Model Comparison table** — all 5 models ranked by walk-forward accuracy with lift over majority baseline, log loss, and per-class F1
3. **XGBoost feature importance** — top 15 features by gain
4. **SHAP plot** (with `--shap`) — beeswarm plot for the most variable class
5. **Experiment JSON** — saved to `ml/experiments/` with full metrics for all models
6. **Verdict** — whether any model beats the majority class baseline

### Interpreting the comparison table

```text
  Model                      Acc    Lift  LogLoss  Per-Class F1
  ────────────────────── ─────── ─────── ────────  ──────────────────────
  Majority Baseline       80.0%       —         —  (always predict CCS)
  Previous-Day            80.0%  +0.0%         —  (repeat yesterday)
  ────────────────────── ─────── ─────── ────────  ──────────────────────
  XGBoost                 80.0%  +0.0%   0.7023  CCS=0.89  PCS=0.00  IC=0.00
  Logistic Reg (L2)       60.0% -20.0%   8.5278  CCS=0.75  PCS=0.00  IC=0.00
  ...
```

- **Acc** — walk-forward accuracy (expanding window, min 20 training days)
- **Lift** — accuracy minus majority baseline (positive = model adds value)
- **LogLoss** — lower is better; random baseline for 3-class is 1.099
- **Per-Class F1** — 0.00 means the model never predicted that class (common with small n)
- **`<-- best`** marker shows the top-performing model

---

## Serving Architecture

### Option A: Pre-computed daily prediction (recommended to start)

After the feature engineering cron runs each morning (~10:30 AM ET after T2 features are available):

1. Load the latest model from `models/structure_v1.json`
2. Build today's feature vector from `training_features`
3. Run inference
4. Write prediction to a `predictions` table
5. Surface in the calculator UI as a "Model Prior" badge

### Option B: On-demand prediction (later)

`POST /api/ml/predict` — accepts today's features, returns probabilities.
Requires either:

- ONNX Runtime in a Node.js Vercel function
- Python Vercel function with XGBoost installed

Defer this until the model proves useful with Option A.

---

## When to Start Training

### Minimum viable dataset

- **60 labeled days** with feature completeness > 80%
- At least **5 IC days** (currently 4)
- At least **1 SIT OUT day** (currently 0)
- If SIT OUT never occurs, train 3-class model and add it later

### Estimated timeline

- Current: 34 labeled days, 25 with completeness >= 80% (2026-03-31)
- +1 day per trading session
- 60 days: ~mid-May 2026
- 80 days: ~early June 2026

### Early experiment (running now)

`phase2_early.py` runs walk-forward validation with the current dataset. As of 2026-03-31 with 25 usable days (min_train=20, yielding 5 predictions), no model beats the 80% majority baseline. XGBoost ties it while all sklearn baselines underperform at 60%.

This is expected — 5 walk-forward folds is too few to draw conclusions. **Re-run `make early` weekly** as data accumulates. The comparison becomes meaningful at ~45 labeled days (25 predictions) and actionable at 60+ days.

---

## Risk Assessment

| Risk                                      | Likelihood         | Impact                        | Mitigation                                                  |
| ----------------------------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------- |
| Model just learns "predict CCS always"    | High with <50 days | Model is useless              | Class weighting, more data, binary cascade                  |
| Overfitting on 60-80 samples              | Medium             | False confidence              | Shallow trees, high regularization, walk-forward validation |
| Feature drift as system evolves           | Medium             | Model degrades silently       | Monthly retraining, tracking prediction accuracy            |
| SIT OUT never appears in labels           | Low-medium         | Can't predict it              | Train 3-class, add SIT OUT when observed                    |
| Key features are always null for old days | Low                | Reduced effective sample size | `feature_completeness` filter, imputation                   |

---

## Success Criteria

Phase 2 is successful if:

1. **Walk-forward accuracy > 60%** (beats 55% majority class baseline by meaningful margin)
2. **Log loss < 1.0** (probabilities are better than uniform random)
3. **Per-class recall > 30%** for each class (model doesn't ignore minority classes)
4. **Calibration within 15%** (when model says 70%, actual rate is 55-85%)
5. **Feature importance is interpretable** (top features align with trading domain knowledge)

If these aren't met, the appropriate action is to wait for more data, not to add model complexity.
