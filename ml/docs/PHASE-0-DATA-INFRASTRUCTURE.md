# Phase 0: Data Infrastructure

**Status:** Not started
**Prerequisite for:** All ML models (Phases 1-6)
**Estimated effort:** 2-3 weeks

---

## Why Phase 0 Exists

Every model in the ML roadmap needs two things that don't exist yet:

1. **Daily feature vectors** — The raw tables (`flow_data`, `strike_exposures`, `spot_exposures`) store time series. ML models need one row per trading day with 80-100 engineered features.
2. **Structured labels** — Supervised models need labeled outcomes. The EOD review analyses already contain these labels in unstructured JSONB, but nothing extracts them into a queryable format.

Phase 0 builds the data infrastructure that every subsequent phase depends on. No model code, no Python, no training — just the plumbing that turns raw data into ML-ready datasets.

---

## Architecture

```text
┌─────-────────────────────────────────────────────────────┐
│                  EXISTING DATA PIPELINE                  │
│  10 cron jobs → raw tables (flow, greeks, strikes, etc.) │
│  EOD review  → analyses table (full_response JSONB)      │
└──────-────────────────┬──────────────────────────────────┘
                        │
          ┌─────────────▼───────────────┐
          │  0a: EOD OUTCOMES CRON      │  Vercel cron, ~4:30 PM ET
          │  Schwab API → outcomes      │  SPX settlement, OHLC, VIX close
          └────────────┬────────────────┘
                       │
          ┌────────────▼────────────────┐
          │  0b: FEATURE ENGINEERING    │  Vercel cron, ~4:45 PM ET
          │  Raw tables → features      │  80-100 columns per trading day
          │  Analyses → labels          │  Structured labels from reviews
          └────────────┬────────────────┘
                       │
          ┌────────────▼────────────────┐
          │  0c: EXPORT ENDPOINT        │  GET /api/ml/export
          │  Features + outcomes +      │  JSON for Python consumption
          │  labels → joined dataset    │
          └────────────┬────────────────┘
                       │
          ┌────────────▼────────────────┐
          │  PYTHON NOTEBOOKS           │  Local / Colab
          │  pd.DataFrame(data)         │  Training happens here
          │  XGBoost, scikit-learn      │
          └─────────────────────────────┘
```

---

## 0a: EOD Outcomes Cron

**File:** `/api/cron/fetch-outcomes.ts`
**Schedule:** `30 20,21 * * 1-5` (covers both DST scenarios for ~4:30 PM ET)
**Dependencies:** Schwab API (existing `schwabFetch` helper)

### What it does

After market close, fetches public market data and writes to the existing `outcomes` table:

| Field           | Source                                           | Timing                |
| --------------- | ------------------------------------------------ | --------------------- |
| `settlement`    | SPX last price from `/api/intraday` final candle | Available ~4:05 PM ET |
| `day_open`      | First 5-min candle open                          | Available ~4:05 PM ET |
| `day_high`      | Max high across all candles                      | Available ~4:05 PM ET |
| `day_low`       | Min low across all candles                       | Available ~4:05 PM ET |
| `day_range_pts` | `day_high - day_low`                             | Computed              |
| `day_range_pct` | `(day_high - day_low) / day_open`                | Computed              |
| `close_vs_open` | `settlement - day_open`                          | Computed              |
| `vix_close`     | VIX last price from Schwab quotes                | Available ~4:20 PM ET |
| `vix1d_close`   | VIX1D last price from Schwab quotes              | Available ~4:20 PM ET |

### Design decisions

- **Idempotent:** `ON CONFLICT (date) DO NOTHING` — safe to run multiple times
- **Internal time check:** Only executes between 4:20-5:00 PM ET. Outside this window, returns 200 with "skipped" message
- **Calls Schwab directly** via `schwabFetch`, not through cached API endpoints
- **No dependency on paper trading** — this is public market data, works regardless of account type

### Why not use `/api/yesterday`?

The yesterday endpoint returns the _previous_ day's data. We need _today's_ data immediately after close. The intraday endpoint provides today's completed candles by 4:05 PM ET, giving us the settlement price same-day.

---

## 0b: Feature Engineering + Label Extraction

**File:** `/api/cron/build-features.ts`
**Schedule:** `45 20,21 * * 1-5` (15 min after outcomes cron)
**Max duration:** 300s (for initial backfill)
**Dependencies:** All raw data tables + outcomes + analyses

### New tables

#### `training_features`

One row per trading day. ~100 columns organized into feature groups:

**Static features (from `market_snapshots`):**

- VIX, VIX1D, VIX9D, VVIX
- VIX1D/VIX ratio, VIX/VIX9D ratio
- Regime zone, cluster multiplier, DOW multiplier
- Opening range signal, percent consumed
- Day of week, is Friday, is event day
- IC ceiling, put spread ceiling, call spread ceiling
- SPX open, sigma, hours remaining

**Flow checkpoint features (from `flow_data`):**

Fixed clock times with ±2 minute tolerance (nearest candle):

| Checkpoint | ET Time  | Minutes after open |
| ---------- | -------- | ------------------ |
| T1         | 10:00 AM | 30 min             |
| T2         | 10:30 AM | 60 min             |
| T3         | 11:00 AM | 90 min             |
| T4         | 11:30 AM | 120 min            |
| T5         | 12:00 PM | 150 min            |
| T6         | 1:00 PM  | 210 min            |
| T7         | 2:00 PM  | 270 min            |
| T8         | 3:00 PM  | 330 min            |

Per source per checkpoint:

- `{source}_ncp_t{N}` — NCP value at checkpoint
- `{source}_npp_t{N}` — NPP value at checkpoint
- `{source}_ncp_roc_t{N}` — Rate of change from previous checkpoint

Aggregated flow features:

- `flow_agreement_t{N}` — How many of 9 sources agree on direction (0-9)
- `etf_tide_divergence_t{N}` — SPY/QQQ Net Flow vs ETF Tide disagree (binary)
- `ncp_npp_gap_spx_t{N}` — SPX NCP minus NPP (magnitude of directional conviction)

**GEX checkpoint features (from `spot_exposures`):**

- `gex_oi_t{N}` — OI gamma at checkpoint
- `gex_vol_t{N}` — Volume gamma at checkpoint
- `gex_dir_t{N}` — Directionalized gamma at checkpoint
- `gex_oi_slope` — Linear slope of OI GEX from T1 to T8 (trend)
- `charm_oi_t{N}` — OI charm at checkpoint

**Greek exposure features (from `greek_exposure`):**

- `agg_net_gamma` — Aggregate OI net gamma (Rule 16 regime)
- `dte0_net_charm` — 0DTE net charm
- `dte0_charm_pct` — 0DTE charm as % of total charm

**Per-strike engineered features (from `strike_exposures`):**

- `gamma_wall_above_dist` — Distance (pts) to nearest positive gamma wall above ATM
- `gamma_wall_above_mag` — Magnitude of nearest positive gamma wall above ATM
- `gamma_wall_below_dist` — Distance (pts) to nearest positive gamma wall below ATM
- `gamma_wall_below_mag` — Magnitude of nearest positive gamma wall below ATM
- `neg_gamma_nearest_dist` — Distance to nearest negative gamma zone
- `neg_gamma_nearest_mag` — Magnitude of nearest negative gamma zone
- `gamma_asymmetry` — sum(positive gamma above ATM) / sum(positive gamma below ATM)
- `charm_slope` — Average charm above ATM minus average charm below ATM
- `charm_max_pos_dist` — Distance from ATM to max positive charm strike
- `charm_max_neg_dist` — Distance from ATM to max negative charm strike
- `gamma_0dte_allexp_agree` — Do top gamma walls align between 0DTE and all-expiry? (binary)
- `charm_pattern` — Classification enum (see below)

**Metadata:**

- `date` (PRIMARY KEY)
- `feature_completeness` — Score 0.0-1.0 indicating what fraction of features are non-null
- `created_at`

#### Charm Pattern Classification

This requires domain-specific thresholds. Initial classification rules (to be refined):

| Pattern          | Condition                                                      |
| ---------------- | -------------------------------------------------------------- |
| `all_negative`   | >80% of strikes within ±50 pts of ATM have negative net charm  |
| `all_positive`   | >80% of strikes within ±50 pts of ATM have positive net charm  |
| `ccs_confirming` | Positive charm concentrated above ATM (upside walls holding)   |
| `pcs_confirming` | Positive charm concentrated below ATM (downside walls holding) |
| `mixed`          | No dominant pattern                                            |

> **NOTE:** These thresholds need refinement based on trading experience. The initial implementation will use conservative defaults and log the raw distributions so thresholds can be tuned.

#### Gamma Wall Detection

A "wall" is defined as a strike where net gamma exceeds a significance threshold:

- **Positive wall:** `net_gamma > mean + 1.5 * stddev` of all strikes in range
- **Negative zone:** `net_gamma < mean - 1.5 * stddev` of all strikes in range

This statistical approach adapts to daily variance rather than using a fixed magnitude cutoff. The 1.5x multiplier is tunable.

#### `day_labels`

One row per trading day. Extracted from `analyses` where `mode = 'review'`:

| Column                  | Type        | Source in review JSON                                                 |
| ----------------------- | ----------- | --------------------------------------------------------------------- |
| `date`                  | DATE PK     | `analyses.date`                                                       |
| `structure_correct`     | BOOLEAN     | `full_response.review.wasCorrect`                                     |
| `recommended_structure` | TEXT        | `full_response.structure`                                             |
| `optimal_structure`     | TEXT        | Parsed from `full_response.review.optimalTrade`                       |
| `charm_diverged`        | BOOLEAN     | `full_response.chartConfidence.periscopeCharm.signal = 'CONTRADICTS'` |
| `naive_charm_signal`    | TEXT        | `full_response.chartConfidence.netCharm.signal`                       |
| `spx_flow_signal`       | TEXT        | `full_response.chartConfidence.spxNetFlow.signal`                     |
| `market_tide_signal`    | TEXT        | `full_response.chartConfidence.marketTide.signal`                     |
| `spy_flow_signal`       | TEXT        | `full_response.chartConfidence.spyNetFlow.signal`                     |
| `gex_signal`            | TEXT        | `full_response.chartConfidence.aggregateGex.signal`                   |
| `confidence`            | TEXT        | `full_response.confidence`                                            |
| `suggested_delta`       | INTEGER     | `full_response.suggestedDelta`                                        |
| `label_completeness`    | DECIMAL     | Fraction of non-null label columns                                    |
| `analysis_id`           | INTEGER     | FK to `analyses.id`                                                   |
| `created_at`            | TIMESTAMPTZ |                                                                       |

**Derived labels** (computed from outcomes + features, not from review JSON):

| Column                 | Type    | Derivation                                                              |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `flow_was_directional` | BOOLEAN | Did majority flow direction at T2 match settlement direction?           |
| `settlement_direction` | TEXT    | `UP` if settlement > open, `DOWN` otherwise                             |
| `range_category`       | TEXT    | `NARROW` (<30 pts), `NORMAL` (30-60), `WIDE` (60-100), `EXTREME` (>100) |

### Backfill behavior

On first run, the cron detects that `training_features` is empty and processes ALL historical dates that have data in the raw tables. This preserves your existing ~30 days of data. After backfill, it only processes the current day.

The backfill:

1. Queries `SELECT DISTINCT date FROM flow_data ORDER BY date`
2. For each date, builds the feature vector and writes to `training_features`
3. For each date with a review-mode analysis, extracts labels to `day_labels`
4. Logs progress: "Backfilled 30/30 days, 28 with labels"

### Handling older reviews with different schemas

Older review analyses may be missing fields (e.g., `chartConfidence.periscopeCharm` didn't exist in early reviews). The extraction uses optional chaining:

```typescript
const charmDiverged =
  response?.chartConfidence?.periscopeCharm?.signal === 'CONTRADICTS' ?? null;
```

Missing fields result in `NULL` values, not errors. The `label_completeness` score tracks this.

---

## 0c: Export Endpoint

**File:** `/api/ml/export.ts`
**Method:** GET
**Auth:** Owner-only (existing cookie auth)

### Query parameters

| Param                    | Type    | Default | Description                        |
| ------------------------ | ------- | ------- | ---------------------------------- |
| `after`                  | DATE    | none    | Only include days after this date  |
| `before`                 | DATE    | none    | Only include days before this date |
| `minFeatureCompleteness` | DECIMAL | 0.0     | Minimum feature completeness score |
| `minLabelCompleteness`   | DECIMAL | 0.0     | Minimum label completeness score   |
| `format`                 | TEXT    | `json`  | `json` or `csv`                    |

### Response

Joins `training_features` + `outcomes` + `day_labels` on date. Returns all columns as a flat array of objects — one object per trading day.

Example usage from Python:

```python
import requests
import pandas as pd

resp = requests.get(
    "https://your-app.vercel.app/api/ml/export",
    params={"minFeatureCompleteness": 0.5, "format": "json"},
    cookies={"owner": "YOUR_COOKIE"}
)
df = pd.DataFrame(resp.json())
print(f"Dataset: {len(df)} days, {len(df.columns)} features")
```

---

## Evaluation Strategy (applies to all future phases)

These principles apply to every model trained on the exported data:

### Temporal cross-validation (mandatory)

Never random-split time series data. Use walk-forward validation:

1. Train on days 1 through N
2. Predict day N+1
3. Slide forward, retrain, predict N+2
4. Report average accuracy across all forward predictions

### Baseline comparisons (mandatory)

Every model must beat:

- **Majority class baseline** — Always predict the most common label
- **Previous day baseline** — Predict whatever happened yesterday
- **Rule-based baseline** — What the existing 16 rules would predict

### Calibration check

When a model says "73% probability of CCS," verify that ~73% of such predictions are actually correct. Use reliability diagrams.

### Feature importance tracking

After training, log feature importances. If a feature the trader considers critical (e.g., VIX1D/VIX ratio) ranks low, that's a conversation worth having — either the model found something surprising, or the feature engineering needs work.

---

## What's NOT in Phase 0

- No model training
- No Python code
- No ML libraries
- No prediction serving

Phase 0 is purely data infrastructure. The output is a clean, queryable dataset that Python notebooks can consume directly. Model training begins in Phase 1 (Day Type Clustering).
