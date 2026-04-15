# Scientific Skill Prompts for the ML Pipeline

> Generated 2026-04-06. Each prompt leverages a specific skill from [claude-scientific-skills](https://github.com/corinwagen/claude-scientific-skills) against the 0DTE SPX ML pipeline.

## Table of Contents

- [1. scikit-learn — Pipeline Hardening](#1-scikit-learn--pipeline-hardening)
- [2. SHAP — Deep Explainability](#2-shap--deep-explainability)
- [3. scikit-survival — Phase 5 Prototype](#3-scikit-survival--phase-5-prototype)
- [4. statsmodels — Strengthened Diagnostics](#4-statsmodels--strengthened-diagnostics)
- [5. matplotlib — Plot Refinements](#5-matplotlib--plot-refinements)
- [6. seaborn — Statistical Visualization](#6-seaborn--statistical-visualization)
- [7. TimesFM — Zero-Shot Range Forecasting](#7-timesfm--zero-shot-range-forecasting)
- [8. UMAP-learn — Enhanced Clustering](#8-umap-learn--enhanced-clustering)
- [9. aeon — Time Series Day-Type Classification](#9-aeon--time-series-day-type-classification)
- [10. Statistical Analysis — Power & Sample Size Planning](#10-statistical-analysis--power--sample-size-planning)
- [11. PyMC — Bayesian Calibration](#11-pymc--bayesian-calibration)
- [12. Scientific Visualization — Plot Style Guide](#12-scientific-visualization--plot-style-guide)

## Running Order

| Priority | Prompt                         | Rationale                                                         |
| -------- | ------------------------------ | ----------------------------------------------------------------- |
| 1st      | #1 (scikit-learn)              | Pipeline/ColumnTransformer refactor makes everything else cleaner |
| 2nd      | #2 (SHAP)                      | Builds on the pipeline from #1                                    |
| 3rd      | #4 (statsmodels)               | Strengthens existing EDA and health checks                        |
| 4th      | #5 + #6 (matplotlib + seaborn) | Visual improvements, can run in parallel                          |
| 5th      | #12 (Scientific Visualization) | Style system for all plots                                        |
| 6th      | #8 (UMAP)                      | Quick win for clustering improvement                              |
| 7th      | #10 (Statistical Analysis)     | Answers "when is my data big enough?"                             |
| 8th      | #7 (TimesFM)                   | Unblocks Phase 4 without waiting for 100+ days                    |
| 9th      | #9 (aeon)                      | Reframes day-type problem as time series                          |
| 10th     | #3 (scikit-survival)           | Builds Phase 5 infrastructure with proxy target                   |
| 11th     | #11 (PyMC)                     | Heaviest dependency, most valuable at small n                     |

## Dependency Notes

- **#7 (TimesFM)** requires installing the model — the skill includes a preflight checker that verifies RAM/GPU before downloading weights.
- **#11 (PyMC)** pulls in PyTensor and requires compilation. Consider whether Bayesian uncertainty estimates are worth the install complexity.
- **#3 (scikit-survival)** builds infrastructure for Phase 5 using a proxy target. When real timestamped exit data arrives, swap the target definition.
- All other prompts use libraries already in `ml/requirements.txt` or lightweight additions.

---

## 1. scikit-learn — Pipeline Hardening

**Applies to:** `ml/src/phase2_early.py`, `ml/src/utils.py`
**Phase:** Phase 2 (Structure Classification)

```
Using the scikit-learn skill, review my ML pipeline in ml/src/ and refactor
the model training in phase2_early.py to use proper scikit-learn patterns:

1. Replace the manual impute-then-scale-then-model chains with
   sklearn Pipeline + ColumnTransformer. My numeric features are defined
   in ml/src/utils.py as ALL_NUMERIC_FEATURES and my categorical features
   (dp_net_bias, charm_pattern, regime_zone) are in CATEGORICAL_FEATURES.

2. Add HalvingGridSearchCV for XGBoost hyperparameter tuning that respects
   my walk-forward temporal split (never random-split time series). The
   current XGBoost params are hardcoded in phase2_early.py — make them
   searchable over max_depth=[2,3,4], n_estimators=[30,50,75],
   learning_rate=[0.05,0.1,0.15], min_child_weight=[2,3,5].

3. Add a calibration check using CalibratedClassifierCV with
   method='isotonic' on the best model, and output a reliability diagram
   showing predicted probability vs actual frequency for each class.

4. The dataset is small (~35 labeled days, expanding weekly). All changes
   must work with expanding-window walk-forward validation — the current
   implementation trains on days 1..N and predicts day N+1.

Keep the existing multi-model comparison table output format. Add the
calibration plot to ml/plots/. Use the existing DB connection pattern
from utils.py.
```

---

## 2. SHAP — Deep Explainability

**Applies to:** `ml/src/phase2_early.py`, `ml/plots/`
**Phase:** Phase 2 (Structure Classification)

```
Using the SHAP skill, enhance my Phase 2 structure classifier in
ml/src/phase2_early.py with comprehensive model interpretability:

1. Add SHAP waterfall plots for the 3 most recent walk-forward predictions,
   showing WHY the model predicted CCS/PCS/IC for each specific day. Save
   to ml/plots/shap_waterfall_{date}.png. This is critical — I need to
   understand individual predictions, not just global importance.

2. Add a SHAP dependence plot for each of the top 5 features by mean
   |SHAP value|, with interaction coloring by the second-most-important
   interacting feature. Save to ml/plots/shap_dependence_{feature}.png.

3. Add a SHAP heatmap plot showing how feature contributions evolve across
   the walk-forward predictions chronologically — this reveals whether
   the model is learning different patterns over time or is stable.

4. Replace the current simple feature importance bar chart with a SHAP
   bar plot (mean |SHAP| per feature) which is more accurate than
   XGBoost's gain-based importance.

My model is XGBoost multi:softprob with 3 classes (CCS, PCS, IC). Use
TreeExplainer for exact Shapley values. The feature names come from
utils.py feature group lists. Gate all SHAP work behind the existing
--shap flag. Keep the current beeswarm plot too.
```

---

## 3. scikit-survival — Phase 5 Prototype

**Applies to:** New script `ml/src/phase5_prototype.py`
**Phase:** Phase 5 (Optimal Exit Timing)

```
Using the scikit-survival skill, create a new script ml/src/phase5_prototype.py
that builds a survival analysis prototype for my Phase 5: Optimal Exit Timing.

Context from my roadmap (ml/docs/ROADMAP.md): Phase 5 uses Cox proportional
hazards or random survival forest to predict optimal hold duration for 0DTE
credit spreads. It's currently blocked on timestamped exit data, but I can
bootstrap a proxy target from existing data.

Build the prototype:

1. Load data via utils.load_data(). The proxy survival target is:
   - Event time: hours from market open (9:30 ET) until the day's range
     first exceeds 50% of the final day_range_pts (from outcomes table).
     If it never does, the observation is censored at market close (4:00 ET).
   - Event indicator: 1 if 50% range was hit, 0 if censored.
   This simulates "time until your position would be tested."

2. Fit three models and compare:
   - CoxPHSurvivalAnalysis (baseline)
   - CoxnetSurvivalAnalysis with elastic net (alpha grid search)
   - RandomSurvivalForest (n_estimators=100, max_depth=3)

3. Use my existing feature groups from utils.py: VOLATILITY_FEATURES,
   GEX_FEATURES, FLOW_AGGREGATE_FEATURES, and GREEK_FEATURES as covariates.

4. Evaluate with concordance index and time-dependent AUC at t=1h, 2h, 3h.
   Plot Kaplan-Meier curves stratified by cluster assignment (from
   clustering.py output) and by VIX regime (vix < 18, 18-22, 22-28, >28).

5. Output a survival function plot showing predicted hold duration curves
   for a "typical CCS day" vs "typical IC day" using median feature values.
   Save all plots to ml/plots/survival_*.png.

Follow the same patterns as my other scripts: load_data(), feature groups
from utils.py, print summary tables to console, save plots to ml/plots/.
```

---

## 4. statsmodels — Strengthened Diagnostics

**Applies to:** `ml/src/eda.py`, `ml/src/health.py`
**Phase:** Phase 1.5 (EDA), Pipeline Health

```
Using the statsmodels skill, add rigorous statistical diagnostics to my
ml/src/eda.py and ml/src/health.py:

For eda.py, add a new Section 10: "Regression Diagnostics":

1. Fit an OLS regression of day_range_pts ~ vix + gex_oi_t1 + flow_agreement_t1
   + agg_net_gamma + dte0_net_charm. Print the full summary() table.
   Check and report: R², adjusted R², F-statistic p-value, and VIF for
   each predictor (flag multicollinearity at VIF > 5).

2. Run Breusch-Pagan test for heteroscedasticity and Durbin-Watson for
   autocorrelation on the residuals. If either fails, note the implication
   for my walk-forward predictions.

3. Fit a Logit model for structure_correct ~ top 10 features from Section 4
   (point-biserial ranking). Print odds ratios with 95% CIs. This gives
   interpretable "each unit increase in gex_dir_t1 multiplies the odds of
   correct structure by X."

For health.py, replace the current z-score regime shift detection with:

4. Augmented Dickey-Fuller test on rolling 20-day means of vix, gex_oi_t1,
   flow_agreement_t1, and dp_total_premium. Report test statistic, p-value,
   and whether the series is stationary at 5% significance.

5. Zivot-Andrews structural break test on the same series to detect a
   single endogenous break point — more appropriate than my current
   rolling z-score approach for detecting regime shifts.

Print all results in the same console output format as my existing
sections. No new dependencies beyond statsmodels (already installed).
```

---

## 5. matplotlib — Plot Refinements

**Applies to:** `ml/src/visualize.py`, `ml/plots/`
**Phase:** All phases (visualization layer)

```
Using the matplotlib skill, refine my ml/src/visualize.py to produce
more publication-quality output. My pipeline generates 21 plots to
ml/plots/ that are analyzed nightly by Claude vision and displayed in
the frontend ML Insights carousel.

Specific improvements:

1. timeline.png (the 4-panel daily overview): Add a shared x-axis date
   formatter that shows abbreviated weekday + date (e.g., "Mon 3/10").
   Add subtle gridlines on the VIX and GEX panels. The red vertical
   shading for failure days should use alpha=0.15 (currently too opaque
   in some renders). Add a tight_layout() with constrained_layout=True
   to prevent label clipping.

2. correlations.png: The heatmap with 100+ features is unreadable. Switch
   to a clustered correlation heatmap using scipy.cluster.hierarchy to
   group correlated features together. Add a dendrogram on the left axis.
   Only label features with |r| > 0.7 to any other feature. Use a
   diverging colormap (RdBu_r) centered at 0.

3. All plots: Create a shared style context at the top of visualize.py
   that sets: figure.dpi=150, font.size=10, axes.titlesize=13,
   axes.labelsize=11, savefig.bbox='tight', savefig.pad_inches=0.2.
   Apply this as a matplotlib style context manager so it doesn't affect
   other scripts.

4. Add a new composite plot ml/plots/model_comparison.png that shows
   the Phase 2 walk-forward results: left panel = grouped bar chart of
   accuracy per model with majority baseline as a horizontal dashed line,
   right panel = per-class F1 heatmap (models × classes). Pull the data
   from the latest experiment JSON in ml/experiments/.

Keep all existing plots working. Don't change the logic, just the
visual presentation.
```

---

## 6. seaborn — Statistical Visualization

**Applies to:** `ml/src/visualize.py`, `ml/src/eda.py`, `ml/plots/`
**Phase:** All phases (visualization layer)

```
Using the seaborn skill, enhance the statistical plots in ml/src/visualize.py
and ml/src/eda.py with seaborn's higher-level statistical features:

1. Replace the manual boxplot+swarmplot composition in range_by_regime.png
   with seaborn's catplot using kind="violin" with inner="stick" and an
   overlaid stripplot. Add automatic statistical annotations: for each
   panel (charm pattern, VIX regime, GEX regime), compute and display
   the Kruskal-Wallis H statistic and p-value as text in the upper right.
   Use a colorblind-safe palette (seaborn's "colorblind" or "Set2").

2. Create a new plot ml/plots/pairplot_top_features.png: use seaborn's
   PairGrid on the top 6 features by SHAP importance (or point-biserial
   if SHAP not available). Lower triangle = scatter with regression line
   colored by structure correctness. Diagonal = KDE by range_category.
   Upper triangle = Pearson r annotated. Limit to 6 features max to keep
   it readable.

3. Create ml/plots/feature_distributions.png: use seaborn's FacetGrid to
   show KDE distributions of the top 12 features, faceted in a 3×4 grid,
   with hue=range_category (NARROW/NORMAL/WIDE/EXTREME). This reveals
   which features actually separate narrow from wide days visually.

4. Improve flow_reliability.png: replace the horizontal bar chart with a
   seaborn pointplot showing accuracy as points with Wilson CI error bars,
   sorted by accuracy. Add a horizontal reference line at 0.5 with
   label "coin flip". Use markers: circle for USEFUL, X for ANTI-SIGNAL,
   diamond for inconclusive.

Use seaborn's set_theme(style="whitegrid", context="paper") for all new
plots. Save to ml/plots/ following existing naming conventions.
```

---

## 7. TimesFM — Zero-Shot Range Forecasting

**Applies to:** New script `ml/src/range_forecast.py`
**Phase:** Phase 4 (Intraday Range Regression) — early unlock

```
Using the TimesFM Forecasting skill, create a new script
ml/src/range_forecast.py that applies Google's TimesFM foundation model
to predict the daily SPX intraday range — this is my Phase 4 target
but I currently need 100+ days of API data before training a custom model.
TimesFM requires zero training.

Implementation:

1. Load the daily day_range_pts series from outcomes via utils.load_data().
   This is my univariate target: how many SPX points the market moves
   each trading day.

2. Run TimesFM point forecasts using a rolling backtest: for each day
   from day 20 onward, use all prior days as context and predict the
   next day's range. Collect predictions vs actuals.

3. Compare against these baselines (compute for the same prediction window):
   - Naive baseline: predict yesterday's range
   - 5-day rolling mean
   - VIX-implied range: vix / sqrt(252) * spx_open (from the data)
   - 20-day rolling median

4. Report: MAE, RMSE, and directional accuracy (did we predict
   NARROW/NORMAL/WIDE/EXTREME correctly using the same thresholds from
   utils.py: <30/30-60/60-100/>100 pts).

5. Generate prediction intervals using TimesFM's quantile outputs.
   Plot ml/plots/range_forecast.png showing: actual range as bars,
   TimesFM prediction as a line, 80% prediction interval as shading,
   VIX-implied baseline as a dashed line.

6. If TimesFM beats the VIX-implied baseline on MAE, print a summary
   showing by how much — this directly answers whether the model adds
   value beyond "VIX already prices expected range" (the concern in
   my ROADMAP.md).

Handle the small dataset gracefully — TimesFM should work with as few
as 20 context points. Use the existing venv and DB connection pattern.
```

---

## 8. UMAP-learn — Enhanced Clustering

**Applies to:** `ml/src/clustering.py`, `ml/plots/`
**Phase:** Phase 1 (Day Type Clustering)

```
Using the UMAP-learn skill, create an enhanced version of my Phase 1
clustering by adding UMAP as a dimensionality reduction alternative
to PCA in ml/src/clustering.py.

Current approach (keep it): PCA to ~8-10 components capturing 85% variance,
then KMeans/GMM/Hierarchical for k=2..6.

Add alongside it:

1. Run UMAP with n_components=2 and n_components=5 on the same
   standardized feature matrix. Use n_neighbors=15 (good for ~35-50
   samples), min_dist=0.1, metric='euclidean'. Important: set
   random_state=42 for reproducibility.

2. Run the same three clustering algorithms (KMeans, GMM, Hierarchical)
   on UMAP-5d embeddings for k=2..6. Add a new row to the metrics
   comparison table showing silhouette scores for UMAP-based clusters
   vs PCA-based clusters side by side.

3. Generate ml/plots/umap_clusters.png: 2×2 grid showing:
   - Top-left: PCA 2d scatter colored by best-k cluster assignment
   - Top-right: UMAP 2d scatter colored by same cluster assignment
   - Bottom-left: UMAP 2d colored by range_category
   - Bottom-right: UMAP 2d colored by structure correctness
   This directly reveals whether UMAP separates day types that PCA
   projects on top of each other.

4. Run the same stability and permutation tests on UMAP-based clusters.
   If UMAP silhouette > PCA silhouette AND stability >= 70%, report
   "UMAP clusters are preferred" and use those for the cluster profiles.

5. Add supervised UMAP as a diagnostic: fit with y=range_category to see
   the maximum possible separation. If supervised UMAP shows clear
   clusters but unsupervised doesn't, the signal is there but needs
   more data.

Add a --umap flag to clustering.py. When set, run both PCA and UMAP
pipelines and compare. Default behavior unchanged.
```

---

## 9. aeon — Time Series Day-Type Classification

**Applies to:** New script `ml/src/temporal_classification.py`
**Phase:** Phase 1 (Clustering) + Phase 2 (Classification) — alternative framing

```
Using the aeon skill, create a new script ml/src/temporal_classification.py
that reframes my day-type problem as a TIME SERIES classification task
instead of a point-in-time feature vector task.

The key insight: my build-features cron captures flow/GEX at checkpoints
T1-T8 (10:00 AM through 3:00 PM). Currently I treat T1 and T2 values as
independent features. But the SHAPE of the intraday trajectory (rising
flow, collapsing GEX, etc.) may be more predictive than point values.

Implementation:

1. From training_features, construct multivariate time series per day:
   - 8 timestamps (T1-T8) × N channels where channels are:
     mt_ncp, spx_ncp, flow_agreement, gex_oi, gex_dir, gex_vol
   - Each day becomes an 8×6 matrix (8 timesteps, 6 channels)
   - Target: range_category (NARROW/NORMAL/WIDE/EXTREME)

2. Run three aeon classifiers and compare:
   - MiniRocketMultivariate (fast, <1 second training, strong baseline)
   - HIVECOTEV2 (state-of-the-art ensemble, slower)
   - InceptionTimeClassifier (deep learning, if enough data)
   Use the same walk-forward temporal validation as phase2_early.py.

3. Also try aeon's time series clustering:
   - TimeSeriesKMeans with dtw metric for k=2..5
   - Compare cluster assignments with my PCA-based clustering results
   - Report adjusted Rand index between the two clusterings

4. Feature extraction comparison: run aeon's Catch22 transformer to
   extract 22 summary statistics per channel, producing 132 features.
   Compare these against my hand-engineered T1/T2 checkpoint features
   in a simple LogisticRegression classifier — does Catch22 find
   signal my feature engineering misses?

5. Output a comparison table: my current phase2 XGBoost accuracy vs
   MiniRocket accuracy vs Catch22+LogReg accuracy, all on the same
   walk-forward folds. Save to console and ml/experiments/.

This tells me whether the temporal shape of intraday data carries
signal beyond what my checkpoint features capture.
```

---

## 10. Statistical Analysis — Power & Sample Size Planning

**Applies to:** New script `ml/src/power_analysis.py`
**Phase:** All phases (data maturity assessment)

```
Using the Statistical Analysis skill, create a new script
ml/src/power_analysis.py that answers the critical question from my
PRESENTING-THE-DATA.md: "How many more trading days until finding X
becomes reliable?"

My pipeline has specific statistical questions with known sample sizes:

1. Structure accuracy comparison: PCS is 11/11 (100%), CCS is 17/19 (89%).
   Run a power analysis for Fisher's exact test: how many days until I can
   detect a true 10% accuracy difference between structures at
   alpha=0.05, power=0.80? Report the required n per group.

2. Flow source reliability: My best flow source is at 59% accuracy (19/32).
   Power analysis for a one-sample proportion test: how many observations
   to confirm this is significantly above 50% at alpha=0.05, power=0.80?
   Run for each flow source in my data.

3. Feature importance stability: My top feature (gex_dir_t1, r=0.412)
   was found with n=35. Power analysis for Pearson correlation: at what
   n does r=0.412 become significant at q<0.05 after FDR correction
   for 100 tests? This tells me when my feature rankings stabilize.

4. Cluster validity: My permutation test p=0.030 with n=35. Simulate:
   how does the permutation p-value distribution change at n=50, 75, 100?
   Bootstrap from existing data with replacement to project.

5. Phase 2 model lift: Current best model ties majority baseline at 80%.
   Power analysis for McNemar's test: how many walk-forward predictions
   to detect a 10% accuracy improvement (80% → 90%) at power=0.80?

6. Create a milestone projection table combining all the above:
   | Finding | Current n | Required n | Est. Date (1 day/session) |
   Show this in console output and save to ml/experiments/power_analysis.json.

Use scipy.stats for power calculations, or statsmodels.stats.power
where available. Reference the actual numbers from my latest data
by loading via utils.load_data().
```

---

## 11. PyMC — Bayesian Calibration

**Applies to:** New script `ml/src/bayesian_calibration.py`
**Phase:** Phase 1.5 (EDA) + Phase 2 (Classification) — uncertainty quantification

```
Using the PyMC skill, create ml/src/bayesian_calibration.py that replaces
frequentist confidence intervals with Bayesian posterior distributions
for my most important pipeline questions.

My pipeline has a small-sample problem (35 days) where frequentist CIs
are wide and uninformative. Bayesian inference with weakly informative
priors will give me more useful uncertainty estimates.

Implementation:

1. Structure accuracy estimation: Model each structure's accuracy as
   Beta-Binomial. Prior: Beta(1,1) (uniform). Posterior after observing
   CCS=17/19 correct, PCS=11/11, IC=3/4. Plot posterior distributions
   for each structure overlaid on one plot. Compute P(PCS_accuracy >
   CCS_accuracy) directly from posteriors — this answers "is PCS really
   more reliable or is it just a small sample artifact?"

2. Confidence calibration: Model P(correct | HIGH) and P(correct | MODERATE)
   as Beta-Binomial. Compute posterior P(HIGH_accuracy > MODERATE_accuracy).
   If this posterior probability < 0.75, print "Insufficient evidence that
   confidence level matters for sizing."

3. Flow source accuracy: Model each of my 9 flow sources as Beta(1,1)
   prior, update with observed directional accuracy. Rank sources by
   posterior mean and plot with 90% HDI intervals. Identify sources
   where the HDI excludes 0.5 (reliably informative) vs includes 0.5
   (indistinguishable from coin flip).

4. Bayesian regression for range prediction: Fit a simple Bayesian linear
   model: day_range_pts ~ Normal(mu, sigma) where
   mu = alpha + beta_vix * vix + beta_gex * gex_oi_t1 + beta_flow * flow_agreement_t1.
   Use weakly informative priors. Sample with NUTS (2000 draws, 4 chains).
   Plot posterior predictive check and report 90% HDI for each coefficient.

5. Model comparison: Compare the Bayesian linear model against an
   intercept-only model using WAIC or LOO. Does adding features improve
   range prediction beyond just using the sample mean?

Save all plots to ml/plots/bayesian_*.png. Print posterior summaries
(mean, sd, 90% HDI) in tabular format matching my existing console
output style. Use ArviZ for all diagnostics and plotting.
```

---

## 12. Scientific Visualization — Plot Style Guide

**Applies to:** New module `ml/src/plot_style.py`, `ml/src/visualize.py`
**Phase:** All phases (visualization layer)

```
Using the Scientific Visualization skill, audit my entire ml/src/visualize.py
and create a unified visual style system for all 21 plots that my nightly
pipeline generates.

Context: These plots are uploaded to Vercel Blob nightly and analyzed by
Claude vision. They're also shown in a frontend carousel. They need to be
clear at both full resolution and thumbnail size.

Deliverables:

1. Create ml/src/plot_style.py with a reusable style configuration:
   - Color palette: a 4-color qualitative palette for range categories
     (NARROW/NORMAL/WIDE/EXTREME) that is colorblind-safe (test with
     deuteranopia simulation). Also a 3-color palette for structure
     (CCS/PCS/IC) and a binary correct/incorrect palette.
   - Typography: consistent font sizes for title, axis labels, annotations,
     and legend across all plots.
   - Layout: standard figure sizes for single-panel (8×5), dual-panel
     (12×5), quad-panel (12×10), and the 4-panel timeline (14×12).
   - Export: DPI=150 for Blob upload, tight bbox, transparent=False.

2. Add a 2-line label system to all plots: first line is the plot title,
   second line (smaller, gray) shows "N={days} days | {start_date} to
   {end_date}" so every plot is self-documenting about its data scope.

3. Review each of my 21 plot types for readability issues:
   - Are axis labels getting clipped?
   - Are legends overlapping data?
   - Are colorbars properly labeled?
   - Are small-n groups visually flagged (e.g., faded/hatched when n<5)?
   For each issue found, fix it in visualize.py.

4. Add a confidence interval visualization standard: wherever I show
   accuracy or proportions, add Wilson CI error bars consistently.
   Currently some plots have them and some don't.

Import plot_style.py at the top of visualize.py and apply it globally.
Don't change any analysis logic, only visual presentation.
```

---

## Skills Reference

| #   | Skill                    | Status in Pipeline  | New Dependencies          |
| --- | ------------------------ | ------------------- | ------------------------- |
| 1   | scikit-learn             | Already installed   | None                      |
| 2   | SHAP                     | Optional (`--shap`) | `shap` (already optional) |
| 3   | scikit-survival          | Not installed       | `scikit-survival`         |
| 4   | statsmodels              | Already installed   | None                      |
| 5   | matplotlib               | Already installed   | None                      |
| 6   | seaborn                  | Already installed   | None                      |
| 7   | TimesFM                  | Not installed       | `timesfm`, `jax` (heavy)  |
| 8   | UMAP-learn               | Not installed       | `umap-learn`              |
| 9   | aeon                     | Not installed       | `aeon`                    |
| 10  | Statistical Analysis     | N/A (methodology)   | None                      |
| 11  | PyMC                     | Not installed       | `pymc`, `arviz` (heavy)   |
| 12  | Scientific Visualization | N/A (methodology)   | None                      |
