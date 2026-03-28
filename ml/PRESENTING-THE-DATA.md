# Presenting the ML Data: A Storytelling Guide

> How to read, present, and act on the outputs from clustering.py, eda.py, and visualize.py.
> Written for the system's owner and anyone reviewing these results.

---

## How to Read This Guide

Each section below maps to one script's output. For every analysis, you'll find:

1. **The headline** -- what the analysis answers in plain English
2. **How to read the output** -- what each number, chart, or table means
3. **What actions to take** -- specific trading decisions the data supports
4. **When to distrust it** -- where the data is thin or inconclusive

---

## Part 1: The EDA Report (eda.py)

Run: `make eda` or `python3 eda.py`

The EDA report tests whether your 16 trading rules hold up against actual market outcomes. It answers one meta-question: **"Is what I believe about the market actually true in my data?"**

### Section 1: Rule Validation

**What it answers:** Do the heuristic rules (negative GEX = wider range, VIX1D inversion = tighter range, etc.) hold in practice?

**How to read it:**

```text
  Positive GEX days (n=5):   62 pts avg range
  Negative GEX days (n=27):  87 pts avg range
  Effect size: Cohen's d = 0.85 (large)
  >> CONFIRMED -- negative GEX adds +25 pts to avg range
```

- **n=** is the sample count. Below 10, treat any finding as a hypothesis, not a conclusion.
- **Cohen's d** measures practical significance, not just statistical significance:
  - Small (d < 0.5): The difference exists but isn't large enough to change your trading
  - Medium (0.5-0.8): Worth adjusting strike width or position size
  - Large (d > 0.8): Strong enough to drive structure selection
- **CONFIRMED / NOT CONFIRMED** tells you whether the direction matches the rule. A confirmed rule with small effect size still holds -- it just doesn't move the needle much.

**Actions:**

- Rules marked CONFIRMED with large effect size: continue relying on them
- Rules marked NOT CONFIRMED: investigate why. Small sample? The rule may be downstream of Periscope Charm data that naive charm doesn't capture.
- Rules with n < 5 on one side: no action yet -- wait for more data

### Section 2: Confidence Calibration

**What it answers:** When Claude says "HIGH confidence," does the trade actually work more often?

**How to read it:**

```text
  HIGH           17/19 correct (89%)
  MODERATE       10/12 correct (83%)
```

- If HIGH is meaningfully more accurate than MODERATE (gap > 5%), confidence IS useful for **position sizing** -- go bigger on HIGH, smaller on MODERATE.
- If they're similar, treat all trades the same size regardless of stated confidence.

**Actions:**

- Gap > 10%: Use confidence for 2x/1x sizing (HIGH = full size, MODERATE = half)
- Gap 5-10%: Use confidence as a tiebreaker, not a primary sizing input
- Gap < 5%: Ignore confidence level for sizing

### Section 3: Structure Outcomes

**What it answers:** Which trade structures (PCS, CCS, IC) are actually working?

**How to read it:**

```text
  PUT CREDIT SPREAD        10/10 (100%)  CI [72%-100%]  avg range 76 pts
  CALL CREDIT SPREAD       14/17 (82%)   CI [59%-94%]   avg range 85 pts
  IRON CONDOR               3/4  (75%)   CI [30%-95%]   avg range 72 pts
```

- **CI [lo%-hi%]** is the 95% Wilson confidence interval. This is the plausible range of the "true" accuracy. Wide intervals mean the sample is too small to be sure.
- PCS at 100% with CI [72%-100%] means: "We're 95% sure the true PCS accuracy is at least 72%." That's strong.
- IC at 75% with CI [30%-95%] means: "We genuinely don't know if IC works -- could be anywhere from 30% to 95%." Wait for more data before trusting this.

**The failure analysis** lists every day the structure call was wrong, with the market conditions that day. Look for patterns:

```text
  PATTERN: All failures had negative GEX.
  PATTERN: 2/3 failures had charm_pattern = 'all_negative'
```

**Actions:**

- Structures with CI lower bound > 60%: continue trading them with confidence
- Structures with CI spanning below 50%: treat as unproven -- reduce size
- Failure patterns: add these as additional checkpoints before entry. If all failures share a condition (deeply negative GEX), add an explicit "pause and verify" step when that condition appears.

### Section 4: Feature Importance

**What it answers:** Which market features best predict whether the structure call will be correct, and which best predict the day's range?

**How to read it:**

```text
  gex_dir_t1                        r=+0.412  p=0.018  q=0.142  (higher = MORE correct)
  delta_flow_total_t1               r=-0.385  p=0.027  q=0.142  (higher = LESS correct)
```

- **r** = correlation strength. Positive means higher values of this feature coincide with more correct calls.
- **p** = raw p-value (chance of seeing this correlation by luck).
- **q** = FDR-adjusted p-value (corrected for testing many features at once). **This is the number that matters.**
  - q < 0.05 (**): strong evidence
  - q < 0.10 (*): suggestive evidence
  - q > 0.10: could be noise -- don't act on it
- **H=** (in the range section) is the Kruskal-Wallis test statistic -- higher means the feature separates NARROW/NORMAL/WIDE/EXTREME days more cleanly.

**Actions:**

- Features with q < 0.10: prioritize these in your pre-analysis scan. If GEX direction is the top predictor, always check it first.
- Features with high H-scores for range: use these to set strike width expectations before entering.
- Features that rank low despite seeming important: the feature engineering may not capture the right signal. Consider revising how it's computed.

### Section 5: Charm Pattern Deep Dive

**What it answers:** Does the naive charm pattern (all-negative, all-positive, mixed, etc.) predict outcomes?

**How to read it:**

```text
  all_negative           n= 8   range  68 pts   accuracy 88%   bearish (2U/6D)  -> CCS
  pcs_confirming         n= 5   range  91 pts   accuracy 80%   bullish (4U/1D)  -> PCS
```

- **range** = average day range in points for days with that charm pattern
- **accuracy** = how often the structure call was correct
- **bias** = settlement direction tendency (bullish/bearish/neutral)
- **->** = most common recommended structure for this pattern

The **Charm + GEX interaction** table is especially valuable. It shows which combinations produce the widest and narrowest ranges:

```text
  all_negative + neg GEX  n= 6   range 95 pts avg
  mixed        + pos GEX  n= 4   range 55 pts avg
```

**Actions:**

- Wide-range combos: widen strikes, consider IC → directional spread
- Narrow-range combos: tighten strikes, favor IC
- If all-negative charm is surprisingly NARROW: this confirms that naive charm is unreliable -- Periscope Charm likely contradicts it. Always wait for Periscope before applying all-negative protocols.

### Section 6: Flow Source Reliability

**What it answers:** Which flow data sources actually predict where SPX settles?

**How to read it:**

```text
  QQQ Net Flow         19/32 (59%)  CI [42%-75%]  USEFUL (ns)
  SPY Net Flow          8/32 (25%)  CI [12%-43%]  ANTI-SIGNAL *
```

- **USEFUL \*** = the confidence interval is entirely above 50%. Statistically significant signal.
- **ANTI-SIGNAL \*** = the CI is entirely below 50%. The source is reliably wrong -- fade it.
- **(ns)** = "not significant" -- the observed accuracy is above/below 50% but the CI still includes 50%. Could be chance. Monitor as data grows.

**Actions:**

- **USEFUL \*** sources: weight these heavily in directional analysis
- **ANTI-SIGNAL \*** sources: either ignore or use as a contrarian indicator
- **COIN FLIP** sources: don't use for directional conviction
- **(ns)** sources: promising but unproven -- keep tracking

### Key Findings Summary

The final summary section gives you the headline numbers computed dynamically from current data. No hardcoded stats -- every number reflects the actual dataset.

---

## Part 2: The Clustering Report (clustering.py)

Run: `make cluster` or `python3 clustering.py --plot`

Clustering answers: **"Are there natural types of trading days that my rules don't explicitly name?"**

### The Metrics Table

```text
    k  K-Means       GMM     Hier.          CH        DB     GMM BIC           Sizes (KM)
  ---  ----------  ----------  ----------  ----------  --------  ------------  --------------------
    2       0.185       0.193       0.172       18.5     1.432      4521.3          [23, 8]
    3       0.162       0.158       0.149       15.2     1.589      4612.7        [15, 10, 6]
```

**How to read it:**

| Metric | What it measures | Good values |
|--------|-----------------|-------------|
| Silhouette (K-Means, GMM, Hier.) | How well-separated the clusters are | > 0.25 = meaningful, > 0.50 = strong |
| CH (Calinski-Harabasz) | Between-cluster vs within-cluster variance | Higher is better (compare across k, not absolute) |
| DB (Davies-Bouldin) | Average cluster similarity | Lower is better (< 1.0 is good) |
| GMM BIC | Model complexity penalty | Lower is better (compare across k) |
| Sizes | How many days in each cluster | Avoid clusters with < 5 days |

**The "best k" is selected by average silhouette across all 3 algorithms.** If the best silhouette is < 0.20, the clusters are weak -- treat them as hypotheses.

### Cluster Profiles

```text
  --- Cluster 0 (23 days, 74%) ---
  VIX: 20.3 avg (14.2-28.5)
  GEX OI (T1): -35.2B avg
  Flow Agreement (T1): 5.1 avg
  Charm: mixed=10, all_negative=8, ccs_confirming=5
  Range: NORMAL=12, WIDE=6, NARROW=3, EXTREME=2
  Correct: 20/23 (87%)
```

Read each cluster as a "day type recipe." Cluster 0 above is a "typical mixed day" -- moderate VIX, negative GEX, middling flow agreement, variety of charm patterns. Structure calls are 87% accurate.

**Naming your clusters:** After reading the profiles, assign descriptive names:

- "Calm Range Day" (low VIX, positive GEX, high flow agreement, mostly NARROW)
- "Volatility Expansion Day" (high VIX, deeply negative GEX, low agreement, WIDE/EXTREME)
- "Directional Breakout" (moderate VIX, mixed GEX, strong flow agreement one way)

### Validity Tests

```text
  Stability: 81% of days keep their cluster assignment
  Permutation p: 0.030
  Chi-squared: range_category  chi2=8.42  p=0.038  Cramer's V=0.35 (moderate) *
```

- **Stability > 70%:** Clusters are robust. Removing any single day doesn't reshuffle everything.
- **Stability < 70%:** Clusters are fragile. Wait for more data.
- **Permutation p < 0.05:** The clusters are significantly better than random groupings. Real structure exists.
- **Permutation p > 0.10:** The observed clusters could arise from noise. Don't trust them yet.
- **Chi-squared with \*:** Cluster membership is significantly associated with that outcome. The clusters predict something real.
- **Cramer's V:** Effect size for the association. Weak (< 0.3), moderate (0.3-0.5), strong (> 0.5).

**Actions:**

- If permutation p < 0.05 AND outcomes differ across clusters: use cluster assignment as a feature in Phase 2 classification
- If permutation p > 0.10: clusters are not reliable. Skip cluster features in Phase 2. Wait for 50+ days and re-run.
- Cluster profiles with extreme characteristics (all failures in one cluster, extreme ranges in another): add these as named regimes to your pre-analysis checklist

---

## Part 3: The Plots (visualize.py)

Run: `make visualize` or `python3 visualize.py`

### Plot-by-Plot Reading Guide

#### 1. correlations.png -- Feature Correlation Heatmap

**What to look for:**

- **Dark red squares (r > 0.7):** These features are near-duplicates. Using both in a model wastes information. Example: SPY ETF ↔ SPX Flow at r=0.93 -- one is redundant.
- **Dark blue squares (r < -0.5):** Inverse relationships. VIX ↔ GEX OI at r=-0.55 confirms that high VIX correlates with negative gamma exposure.
- **Row/column for Day Range:** Which features correlate most with range? These are your best predictors for setting strike width.

**Action:** If two features you rely on are r > 0.8, pick the one that's available earlier in the trading day (T1 > T2) and drop the other from your mental model.

#### 2. range_by_regime.png -- What Drives Day Range?

**Three panels, one question: "What market conditions produce wide vs narrow days?"**

- **Left (Charm Pattern):** Compare box heights. If "all_negative" produces the narrowest box, your rule that "all-negative = trending day" may need Periscope confirmation.
- **Center (VIX Regime):** The expected staircase -- higher VIX = wider range. Check if the jumps between regimes are proportional to your strike width adjustments.
- **Right (GEX Regime):** Deep negative GEX should show the widest box. If "Mild Negative" and "Positive" look similar, the GEX threshold between them may be wrong.

**White dots are individual days** (spread via swarmplot so they don't overlap). With small samples, the dots matter more than the box. A box with 3 dots and one outlier is unreliable. Each group shows an **n= label** at the bottom so you immediately know the sample size.

**Action:** If a regime shows a range box entirely above your typical IC width (e.g., all dots above 80 pts when your IC width is 70 pts), that regime should NOT get IC structures. Groups with n < 5 should be treated as anecdotal.

#### 3. flow_reliability.png -- Flow Source Accuracy

**Horizontal bars with error bars (Wilson 95% CI).**

- Bars with `*` have CIs that don't include 50% -- the signal is statistically significant.
- The vertical dashed line at 50% is the "coin flip" boundary.
- Error bars that cross the 50% line mean: "this source might be random."

**The footer** summarizes which sources to trust and which to fade, with a note that `*` marks statistical significance.

**Action:** Sort your pre-analysis flow review to check high-accuracy sources first. If SPY Net Flow is an anti-signal, invert its reading or ignore it entirely.

#### 4. gex_vs_range.png -- GEX Regime and Outcomes

**Two scatter panels sharing the same GEX (x) vs Range (y) axes.**

- **Left (by charm pattern):** Look for clusters of colors. If all red (all-negative charm) dots are in the upper-left (negative GEX + wide range), the charm-GEX interaction is real.
- **Right (by correctness):** Green circles = correct structure calls, red X marks = failures. Are failures concentrated in a specific GEX zone? If all failures are left of GEX=0, negative GEX is where analysis breaks down.

**Action:** Draw a mental box around the failure zone. When today's GEX falls in that zone, reduce position size or sit out.

#### 5. timeline.png -- Daily Overview

**Four aligned panels showing how regime features evolve across trading days.**

This is your narrative chart -- read it left to right as a story:

- **Panel 1 (Range bars):** Height = day range. Blue = correct, red = failure, orange = extreme. "MISS" labels mark where the structure call failed. Each bar has a small **structure label** (PCS/CCS/IC) rotated vertically. **Red vertical shading** runs across all 4 panels on failure days so you can instantly see what VIX, GEX, and flow agreement looked like when the call was wrong. Look for whether failures cluster in time (regime shift?) or are evenly scattered (random noise).
- **Panel 2 (VIX/VIX1D lines):** Watch for crossovers and divergences. When VIX1D dips far below VIX (inversion), the next few days should show narrower ranges.
- **Panel 3 (GEX bars):** Green = positive gamma, red = negative. Persistent red runs suggest extended volatility regimes.
- **Panel 4 (Flow Agreement):** Green bars (6+) = strong consensus. Red bars (< 4) = confusion. Look for whether high-agreement days (green) correspond to smaller range bars above.

**The footer** shows total days, accuracy, average range, and a legend reminder.

**Action:** Look for **temporal patterns** that your point-in-time analysis misses. The red shading makes cross-panel failure analysis effortless -- scan down each red column to see the VIX, GEX, and flow conditions at the time of the miss. Do failures happen after regime transitions? Do several red GEX days in a row produce wider ranges than isolated ones?

#### 6. structure_confidence.png -- Structure and Confidence Performance

**Left panel (Structure Accuracy):**

- Stacked horizontal bars: green = correct, red = incorrect
- Count labels show exact numbers

**Right panel (Confidence Calibration):**

- Bar height = accuracy percentage for HIGH/MODERATE/LOW confidence
- Error bars = 95% Wilson CI
- **Faded bars (low alpha)** have n < 3 and should be ignored
- If HIGH bar is clearly above MODERATE (non-overlapping error bars), confidence calibration is working

**Action:** If the error bars for HIGH and MODERATE overlap heavily, stop using confidence for sizing decisions -- it's not discriminating.

#### 7. day_of_week.png -- Range by Day of Week

**Boxplots with individual dots (swarmplot) and dual statistics.**

Each day shows three pieces of information above its box:

- **avg** = mean range (sensitive to outliers)
- **med** = median range (robust to outliers -- trust this more)
- **n=** = sample count

When avg and median diverge significantly (e.g., "avg 98 / med 88"), outliers are pulling the mean up. The median is a more reliable guide for setting default strike widths.

**Action:** If one day consistently shows wider median range (not just mean), either widen your strikes on that day or reduce position size. Days with n < 5 should not drive decisions.

#### 8. stationarity.png -- Feature Stationarity Check

**Multi-panel rolling means for VIX, GEX, Range, and Flow Agreement.**

This is the most important diagnostic plot for knowing whether your data is trustworthy.

- **Flat rolling mean:** The feature is stationary. Models trained on this data should generalize.
- **Trending rolling mean:** The feature's distribution is shifting. Models trained on the early data may not work on recent data.
- **Step change:** A regime shift happened. Check if this corresponds to a market event (tariffs, Fed, etc.). Consider splitting your analysis into before/after periods.

**Action:** If you see a clear trend in any feature's rolling mean, your clustering and EDA results may be capturing the trend rather than stable patterns. Re-run the analysis after 20+ more days to see if the finding persists or was a temporary regime artifact.

---

## Part 4: How to Present Results to Others

### The 5-Minute Briefing

When sharing these results with another trader, follow this structure:

**1. The Headline (30 seconds)**
> "We've analyzed 30+ days of 0DTE trading data. The system's structure calls are 90% accurate overall, but all 3 failures happened on days with negative GEX. SPX Net Flow is anti-predictive -- we should ignore or fade it."

**2. What's Working (1 minute)**
> Show `structure_confidence.png`. Point to PCS at 100%, CCS at 82%. Show the confidence calibration: HIGH confidence calls are more accurate than MODERATE.

**3. What's Not Working (1 minute)**
> Show `flow_reliability.png`. Point to SPY Net Flow at 25% with `*` -- statistically significant anti-signal. Show `gex_vs_range.png` right panel -- all red X failures cluster in negative GEX territory.

**4. What We Don't Know Yet (1 minute)**
> "IC has only 4 data points -- the confidence interval spans 30% to 95%. We can't draw conclusions yet. The charm pattern rule appears contradicted but may reflect naive vs. Periscope divergence."

**5. Recommended Actions (1.5 minutes)**
> "Three changes: (1) Stop using SPY Net Flow for directional reads. (2) Add a negative GEX checkpoint before CCS entries. (3) Size positions by confidence level -- full on HIGH, half on MODERATE."

### The Written Report

When documenting findings for future reference:

```markdown
# ML Analysis Report — [Date]
## Dataset: [N] trading days ([start] to [end])

## Summary
- Overall accuracy: X/Y (Z%)
- Best structure: [name] at [accuracy] CI [lo%-hi%]
- Most failures: [condition]
- Most predictive feature: [name] (q = [value])

## Key Findings
1. [Rule name] is [CONFIRMED/NOT CONFIRMED] (Cohen's d = X, [size])
2. [Flow source] is [USEFUL/ANTI-SIGNAL] (p = X, CI [lo%-hi%])
3. Clusters [are/are not] meaningful (permutation p = X)

## Actionable Changes
- [ ] Change 1 (supported by: [evidence])
- [ ] Change 2 (supported by: [evidence])
- [ ] Change 3 (supported by: [evidence])

## Data Gaps
- [Feature] needs N more days before conclusions
- [Cluster/finding] is unstable (stability = X%)

## Next Milestone
- Phase 2 ready at [N] labeled days (est. [date])
```

---

## Part 5: When Not to Trust the Numbers

### Red Flags

| Signal | What it means | What to do |
|--------|--------------|------------|
| n < 10 for any group | Sample too small for reliable statistics | Report the finding but don't act on it |
| CI spans > 40 percentage points | Massive uncertainty | Wait for more data before changing behavior |
| q > 0.10 (FDR-adjusted) | Could be chance after correcting for multiple tests | Treat as hypothesis, not finding |
| Permutation p > 0.10 | Clusters no better than random | Don't use cluster labels as features |
| Stability < 70% | Removing one day reshuffles clusters | Clusters are fragile; re-run at 50+ days |
| Stationarity plot shows trend | Data regime is shifting | Findings may not generalize forward |
| All failures in one condition | Pattern may be real or coincidence with 3 failures | Add as checkpoint, but don't hard-block trades |
| LOW confidence at 100% (n=1) | One data point means nothing | Ignore completely |

### The Small-n Mindset

At 30 days, every finding is provisional. The right mental model:

- **Strong evidence:** Multiple tests agree, effect is large (d > 0.8), CI is narrow, q < 0.05
- **Suggestive evidence:** Direction is clear but CI is wide, q between 0.05-0.10, moderate effect
- **Hypothesis only:** n < 10, wide CI, q > 0.10, small effect size

As data accumulates (50, 100, 200 days), re-run and watch which findings strengthen vs. vanish.

---

## Part 6: The Pipeline at a Glance

```text
                    ┌──────────────────────────────────────────────────────┐
                    │              14 API Sources (every 5 min)           │
                    │   Market Tide, SPX/SPY/QQQ Flow, ETF Tide, GEX,    │
                    │   Greek Exposure, 0DTE Flow, Strike Profiles        │
                    └────────────────────┬─────────────────────────────────┘
                                         │
                                         v
                    ┌──────────────────────────────────────────────────────┐
                    │          build-features.ts (daily cron)             │
                    │   Raw time series -> T1/T2/T3/T4 checkpoint values  │
                    │   -> flow agreement, GEX regime, charm pattern     │
                    │   -> 80-100 engineered features per day             │
                    └────────────────────┬─────────────────────────────────┘
                                         │
                    ┌────────────────────┼─────────────────────────────────┐
                    │                    │                                 │
                    v                    v                                 v
          ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
          │ training_features│  │    outcomes      │  │      day_labels         │
          │  (daily features)│  │ (settlement,     │  │ (structure correct,     │
          │                  │  │  range, VIX      │  │  charm diverged,        │
          │                  │  │  close)          │  │  flow signals)          │
          └────────┬─────────┘  └────────┬─────────┘  └────────┬──────────────┘
                   │                     │                      │
                   └─────────────────────┼──────────────────────┘
                                         │
                                         v
                    ┌──────────────────────────────────────────────────────┐
                    │                 Python ML Scripts                    │
                    │                                                      │
                    │   eda.py ──────> Console report (rule validation,    │
                    │                  confidence calibration, feature      │
                    │                  importance, flow reliability)        │
                    │                                                      │
                    │   clustering.py ──> Console report + 2 PNG plots     │
                    │                     (PCA scatter, feature heatmap)   │
                    │                                                      │
                    │   visualize.py ──> 8 PNG plots (correlations,        │
                    │                    regime analysis, timeline,         │
                    │                    stationarity)                      │
                    └──────────────────────────────────────────────────────┘

    Run everything: cd ml && make all
```

---

## Milestones Ahead

| Days Accumulated | What Unlocks | Action |
|-----------------|-------------|--------|
| **30 (now)** | Clustering + EDA (provisional) | Review this guide. Identify 2-3 actionable changes. |
| **45** | Phase 2 early experiment | Run walk-forward XGBoost. Does it beat 55% majority baseline? |
| **50** | Re-run clustering | Do clusters stabilize? Does permutation p hold? |
| **60-80** | Phase 2 full training | Train structure classifier. Target 65-70% accuracy. |
| **100** | Intraday Range Regression | Enough API-enriched days for range prediction. |
| **200** | All models mature | Clusters are stable, CIs are narrow, Phase 2 calibrated. |
