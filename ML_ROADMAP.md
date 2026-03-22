# Machine Learning Roadmap

## Overview

The 0DTE Options Strike Calculator generates two rich datasets every trading day:

1. **Structured market snapshots** — VIX, VIX1D, sigma, regime zone, delta ceilings, opening range, aggregate GEX, and 40+ other features captured at each analysis run
2. **Claude analysis outputs** — structure recommendation, confidence level, per-chart signals, management rules, and end-of-day review with lessons learned

Combined with **outcomes** (settlement price, actual P&L, whether stops triggered), these datasets form the foundation for predictive models that can augment the existing rule-based system.

This document outlines planned ML applications as sufficient labeled data is accumulated through daily trading.

---

## Planned Models

### 1. Structure Classification — "What structure wins today?"

**Model type:** Gradient boosted classifier (XGBoost or LightGBM)

**Training features (from market snapshots):**

- VIX, VIX1D, VIX9D, VVIX
- VIX1D/VIX ratio, VIX/VIX9D ratio
- Aggregate GEX (OI and Volume)
- Regime zone, DOW multiplier, clustering multiplier
- Opening range signal and percent consumed
- Day of week, is Friday, is event day
- Overnight gap, previous close distance
- Delta guide ceilings (IC, CCS, PCS)

**Labels:** Correct structure for the day (IC, CCS, PCS, SIT OUT) — determined by end-of-day review

**Use case:** Pre-analysis sanity check. Before opening any charts, the model provides a probability distribution: "Based on today's snapshot, historical CCS days had similar profiles 73% of the time." This doesn't replace the Claude analysis — it sets a prior expectation that the chart analysis confirms or overrides.

**Data requirement:** 100+ labeled trading days (backtests + live trades)

---

### 2. Intraday Range Regression — "How far will SPX move today?"

**Model type:** Gradient boosted regressor or neural network

**Training features:**

- Morning snapshot features (same as above)
- VIX1D/VIX ratio (key predictor of intraday vs multi-day vol expectations)
- Aggregate GEX regime (positive/negative/deeply negative)
- Day of week, event flags
- Historical realized vol (trailing 5-day, 10-day)

**Target:** Actual intraday range (high minus low) or settlement distance from open

**Use case:** Directly predicts whether the straddle cone will be consumed, partially used, or exceeded. This automates and improves what Rule 16 does heuristically with GEX thresholds. A model trained on thousands of historical days would provide calibrated confidence intervals: "Today's profile produces a 40+ pt range 78% of the time."

**Data requirement:** Available now — 30+ years of historical intraday price and volatility data can be used immediately. This is the first model to build.

---

### 3. Optimal Exit Timing (Survival Analysis) — "When should I close?"

**Model type:** Cox proportional hazards or random survival forest

**Training features:**

- Entry snapshot features
- Structure selected (IC, CCS, PCS)
- Charm regime (supportive, decaying, all-negative)
- Aggregate GEX at entry
- Confidence level
- Day of week, VIX regime

**Events:**

- Time to 50% profit
- Time to first stop condition trigger
- Time to optimal exit (determined retrospectively from review data)

**Use case:** Given today's entry conditions and structure, predict the optimal hold duration. Preliminary observations from the first two weeks of trading suggest patterns:

- High-conviction CCS days hit 50% profit in 2-3 hours
- All-negative charm days should exit by noon ET
- Deeply negative GEX days need exits by 11:30 AM ET
- Friday afternoon compression reduces marginal theta after 1:00 PM ET

A survival model formalizes these relationships and discovers new ones that the rule set may not yet capture.

**Data requirement:** 50-100 labeled trading days with timestamped exit data

---

### 4. Day Type Clustering — "What kind of day is this?"

**Model type:** Unsupervised clustering (k-means, DBSCAN, or Gaussian mixture)

**Input features:** Full snapshot feature set, normalized

**Use case:** Discover natural groupings in trading days that the current 16 rules partially capture but may not perfectly delineate. The current rule system handles known patterns (FOMC days, all-negative charm, deeply negative GEX, Friday VIX > 19). Clustering may reveal unnamed day types — combinations of features that historically produce specific outcomes but don't map cleanly to any single rule.

Example hypothesis: there may be a cluster where VIX is moderate (18-22), GEX is mildly positive, charm is mixed, and flow is neutral — a day type where ICs perform exceptionally well but the current rules don't specifically identify as high-conviction IC setups.

**Data requirement:** 200+ trading days for meaningful cluster separation

---

## Data Infrastructure

The existing database schema already captures the required training data:

| Table              | Purpose                | Key Fields                                                      |
| ------------------ | ---------------------- | --------------------------------------------------------------- |
| `market_snapshots` | Feature vectors        | 50+ calculator state fields per analysis run                    |
| `analyses`         | Model outputs + labels | Structure, confidence, delta, chart signals, full JSON response |
| `outcomes`         | Ground truth           | Settlement, day range, close vs open                            |
| `positions`        | Position-specific data | Strikes, spreads, P&L, Greeks                                   |

All tables are linked by date, enabling joins across features, predictions, and outcomes.

---

## Implementation Timeline

| Phase       | Model                     | Prerequisite                            | Status            |
| ----------- | ------------------------- | --------------------------------------- | ----------------- |
| **Phase 1** | Intraday Range Regression | 30 years of historical data (available) | Ready to build    |
| **Phase 2** | Structure Classification  | 100+ labeled trading days               | Accumulating data |
| **Phase 3** | Optimal Exit Timing       | 50-100 days with timestamped exits      | Accumulating data |
| **Phase 4** | Day Type Clustering       | 200+ trading days                       | Accumulating data |

Phase 1 can begin immediately using the existing historical dataset. Phases 2-4 require continued daily trading with the current rule-based system, which is generating labeled training data with every session.

---

## Design Philosophy

The ML models are designed to **augment, not replace** the existing system. The 16 empirical rules and Claude-powered chart analysis remain the primary decision-making framework. ML provides:

- **Pre-analysis priors** — What does historical data suggest before looking at today's charts?
- **Calibrated thresholds** — Where should the GEX regime boundaries actually be, based on thousands of data points instead of a handful?
- **Pattern discovery** — What day types exist that the rules don't yet name?
- **Management optimization** — When is the statistically optimal exit time given today's entry conditions?

The rule-based system captures domain expertise. The ML system validates and extends it with data.
