# Phase 1: Day Type Clustering

**Status:** Ready to build (after Phase 0 source name fix deploys)
**Prerequisites:** Phase 0 complete, backfilled features with corrected source names
**Goal:** Discover natural groupings in trading days that the rule-based system may not explicitly name

---

## Why Clustering First

1. **Zero labels required** — unsupervised, so all 31 days are usable immediately
2. **Validates feature engineering** — if clustering produces meaningful day types that align with trading intuition, the features are capturing real structure. If clusters are random, the features need work.
3. **Informs supervised models** — cluster assignments can become features for the Structure Classification model (Phase 2), and cluster-specific behavior reveals which features matter most

---

## Available Features (~60 usable after source name fix)

### Tier 1: Full coverage (31/31)

| Group | Features | Count |
|---|---|---|
| Volatility | VIX, regime_zone, dow_mult, cluster_mult | 4 |
| Market Tide | mt_ncp/npp at T1-T2 | 4 |
| Flow Agreement | flow_agreement at T1-T2 | 2 |
| Calendar | day_of_week, is_friday, is_event_day | 3 |
| Calculator | sigma, hours_remaining, ic_ceiling, put/call spread ceiling | 5 |
| Opening Range | opening_range_signal, opening_range_pct_consumed | 2 |
| **Per-source flow** | **spx/spy/qqq/zero_dte/delta_flow NCP/NPP at T1-T2** | **~16** |

### Tier 2: Near-complete (26-29/31)

| Group | Features | Count |
|---|---|---|
| VIX term structure | vix1d, vix1d_vix_ratio | 2 |
| GEX | gex_oi/vol/dir at T1-T4, gex_oi_slope | ~9 |
| Greek exposure | agg_net_gamma, dte0_net_charm, dte0_charm_pct | 3 |
| Charm | charm_slope, charm_pattern, charm_max_pos/neg_dist | 4 |
| ETF Tide | spy_etf/qqq_etf NCP/NPP at T1-T2 | 8 |

### Tier 3: Sparse (skip for now)

Gamma wall features (5-19/31) — too sparse for clustering. Will become useful as more data accumulates.

---

## Approach

### Step 1: Feature Selection and Preprocessing

With ~31 samples and ~50-60 features, we have a high-dimensional problem. Key preprocessing steps:

1. **Impute Tier 2 nulls** — Use median imputation for the 2-5 missing values per column. With 26-29/31 coverage, this is safe.
2. **Drop Tier 3** — Exclude gamma wall features entirely
3. **Encode charm_pattern** — One-hot encode the categorical charm pattern (5 categories)
4. **Standardize** — Z-score normalize all numeric features (mean=0, std=1). Critical for distance-based clustering.
5. **Dimensionality reduction** — PCA to reduce to ~8-10 components (capturing ~85% variance). This prevents the curse of dimensionality with only 31 samples.

### Step 2: Determine Number of Clusters

With 31 samples, expect 2-5 meaningful clusters. Methods:

- **Silhouette score** — For k=2 through k=6, compute average silhouette. Higher = better separation.
- **Elbow method** — Plot within-cluster sum of squares vs k. Look for the "elbow."
- **Domain validation** — Do the discovered clusters map to known day types? (VIX regimes, GEX regimes, event days)

### Step 3: Clustering Algorithms

Run three algorithms and compare:

| Algorithm | Why | When it works best |
|---|---|---|
| **K-Means** | Simple, interpretable centroids | Spherical, equal-size clusters |
| **Gaussian Mixture** | Soft assignments (probabilities) | Elliptical clusters, uncertainty quantification |
| **Hierarchical (Ward)** | Dendrogram shows structure at all levels | Small datasets, reveals nested groupings |

DBSCAN is NOT recommended for 31 samples — it needs density to work and will likely label most points as noise.

### Step 4: Interpretation

For each discovered cluster, characterize it by:

1. **Centroid features** — What are the mean VIX, GEX, flow agreement, charm pattern?
2. **Known day type overlap** — Does this cluster correspond to "deeply negative GEX days"? "VIX1D inversion days"? "All-negative charm days"?
3. **Outcome association** — What's the range category distribution? Structure correctness rate? Settlement direction?
4. **Naming** — Assign descriptive names based on dominant characteristics

### Step 5: Cluster Stability Check

With 31 samples, clusters could be fragile. Validate with:

- **Leave-one-out stability** — Remove each day, re-cluster, check if assignments change
- **Bootstrap resampling** — Resample with replacement 100x, check cluster consistency
- **New data validation** — As more days accumulate, do new days fall into expected clusters?

---

## Implementation

### Python notebook: `ml/clustering.py`

The script should:

1. Pull data via the explore.py `load_env()` + direct Postgres connection pattern
2. Preprocess (impute, encode, standardize, PCA)
3. Run K-Means, GMM, and Hierarchical for k=2..5
4. Print silhouette scores and cluster sizes
5. For the best k, print cluster centroids (de-standardized)
6. Cross-reference clusters with labels (range_category, recommended_structure, charm_pattern)
7. Save cluster assignments back to the DB (or CSV) for use in Phase 2

### Decisions for the trader

Before building, there are meaningful choices where your domain expertise matters:

**1. Feature weighting** — Should VIX/GEX features count more than flow features in determining day types? Default is equal weight (standardized), but you could double-weight features you consider more fundamental.

**2. Time horizon** — Should clustering use only T1 features (first 30 min — available for pre-analysis priors) or include T2-T4 (first 2 hours — better separation but less actionable for morning decisions)?

**3. Charm pattern treatment** — Should `charm_pattern` be one-hot encoded (treats each pattern as independent) or ordinal (all_negative=1, mixed=2, pcs/ccs_confirming=3, all_positive=4)?

---

## Expected Outcomes

### Optimistic (clusters are meaningful)

Discover 3-4 day types that map to trading-actionable regimes:
- **"Calm range day"** — Low VIX, positive GEX, high flow agreement → IC territory
- **"Directional breakout"** — High VIX1D/VIX, negative GEX, low flow agreement → CCS/PCS
- **"Hedging confusion"** — Mixed flow, ETF Tide divergence, moderate VIX → SIT OUT or small size
- **"VIX inversion premium"** — Low VIX1D/VIX ratio, any GEX → aggressive premium selling

### Realistic (mixed results)

Some clusters are meaningful, others are just noise from small sample size. The valuable output is feature importance — which features create the most separation — rather than the cluster labels themselves.

### What to do if clustering fails

If no stable clusters emerge, that's still useful information:
- The feature engineering may need different representations (e.g., ratios instead of raw values)
- The sample size may simply be too small — wait for 60+ days and retry
- Skip to Phase 2 (supervised classification) which may find structure that clustering can't

---

## Success Criteria

1. **At least one cluster** maps cleanly to a known day type (e.g., "all-negative GEX days" cluster together)
2. **Silhouette score > 0.25** for the chosen k (indicating at least weak structure)
3. **Cluster stability > 70%** in leave-one-out validation
4. **Outcomes differ across clusters** — range category or structure correctness varies meaningfully between clusters

---

## Data Milestone

Phase 1 can run now with 31 days. Results will be preliminary. Re-run at:
- **50 days** (~mid-April 2026) — more robust clustering, can try k=4-5
- **100 days** (~late May 2026) — stable clusters, ready to use as Phase 2 features
