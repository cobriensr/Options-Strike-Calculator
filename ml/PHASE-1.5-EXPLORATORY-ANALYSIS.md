# Phase 1.5: Exploratory Data Analysis

**Status:** Ready to run
**Prerequisites:** Phase 0 complete, Phase 1 clustering done
**Goal:** Validate trading rules, calibrate confidence, and identify high-signal features before building supervised models

---

## Why This Phase

With 31 days of structured data, we're between phases — not enough for supervised ML (need 60-80 days), but too much to leave unanalyzed. This phase extracts maximum trading insight from the existing data using descriptive statistics, not ML.

Every finding here is immediately actionable: it either validates a rule you're already trading, challenges an assumption worth re-examining, or identifies which features to prioritize when Phase 2 arrives.

---

## Analyses

### 1. Rule Validation

The 16 trading rules make specific testable claims. With 31 days of outcomes, we can check:

| Rule | Claim | Test |
|---|---|---|
| Rule 16 (GEX regime) | Negative GEX → wider ranges | Correlate `gex_oi_t1` with `day_range_pts` |
| VIX1D inversion | VIX1D << VIX → range-bound | Correlate `vix1d_vix_ratio` with `day_range_pts` |
| All-negative charm | → trending day, larger moves | Compare range by `charm_pattern` |
| Flow agreement | High agreement → directional | Compare `flow_agreement_t1` vs `settlement_direction` |
| ETF Tide divergence | → hedging, range-bound | Compare `etf_tide_divergence_t1` vs `range_category` |
| Friday + high VIX | → sit out or small IC | Compare Friday outcomes vs other days at VIX > 19 |

### 2. Confidence Calibration

The Claude analysis assigns confidence (HIGH, MODERATE, LOW). Questions:

- **Accuracy by confidence:** Is HIGH more correct than MODERATE?
- **Range by confidence:** Do HIGH confidence days produce tighter ranges?
- **Should confidence affect sizing?** If HIGH ≈ MODERATE in accuracy, confidence isn't adding signal.

### 3. Structure Outcome Analysis

With 29 labeled days (26 correct, 3 incorrect):

- **Which structures failed?** What were the conditions when `structure_correct = false`?
- **CCS vs PCS vs IC:** Range distributions, correctness rates, VIX/GEX profiles
- **Optimal structure hindsight:** Does the data suggest a simpler rule? (e.g., "CCS when VIX > 22, PCS when VIX < 20")

### 4. Feature Importance (Pre-ML)

Without training a model, we can still rank features by predictive power:

- **Point-biserial correlation** of each feature with `structure_correct` (binary)
- **ANOVA F-statistic** of each feature across `range_category` (categorical)
- **Mutual information** between features and `recommended_structure`

This tells Phase 2 which features to prioritize and which to drop.

### 5. Charm Pattern Deep Dive

With 29 days of charm patterns + outcomes:

- **Range by charm:** Do `all_negative` days really produce wider ranges?
- **Structure by charm:** Does charm pattern predict the correct structure?
- **Charm vs GEX interaction:** Are `all_negative` charm + negative GEX days the widest?

### 6. Flow Agreement Analysis

Flow agreement is one of the strongest features from Phase 1 clustering. Dig deeper:

- **Agreement vs range:** Higher agreement → narrower or wider?
- **Agreement vs direction accuracy:** Does high agreement at T1 predict settlement direction?
- **Agreement evolution:** Does T1 → T2 agreement change predict anything?

---

## Output

The EDA script produces a text report covering all analyses above. No plots required (though clustering.py already generates those). The report is designed to be read in terminal output and identifies:

- Rules that hold (with evidence)
- Rules that may need refinement (with data)
- Features ranked by predictive signal
- Confidence calibration results

---

## How This Feeds Phase 2

The EDA findings directly shape the Structure Classification model:

1. **Feature selection:** Top-ranked features from the importance analysis become the primary inputs
2. **Baseline definition:** "Always predict CCS" accuracy (16/29 = 55%) is the bar Phase 2 must beat
3. **Class imbalance:** CCS=16, PCS=9, IC=4 — Phase 2 needs class weighting or oversampling
4. **Rule-based baseline:** Convert validated rules into a simple decision tree as the baseline model
