# Machine Learning Roadmap

## Overview

The 0DTE Options Strike Calculator generates rich datasets every trading day from multiple sources:

1. **Structured market snapshots** — VIX, VIX1D, sigma, regime zone, delta ceilings, opening range, and 40+ other features captured at each analysis run
2. **Intraday flow time series** — 14 API data sources fetched every 5 minutes during market hours, providing 5,600+ data points per trading day across flow, Greek exposure, GEX panels, and per-strike profiles
3. **Claude analysis outputs** — structure recommendation, confidence level, per-chart signals, management rules, and end-of-day review with lessons learned
4. **Position data** — actual strikes, spreads, P&L, and management decisions from paperMoney CSV uploads

Combined with **outcomes** (settlement price, actual P&L, whether stops triggered), these datasets form the foundation for predictive models that can augment the existing rule-based system.

This document outlines planned ML applications as sufficient labeled data is accumulated through daily trading.

---

## Data Pipeline (as of March 2026)

### API Data Sources (10 crons, 14 sources)

| Source                     | Table              | Cron                    | Update Freq | Key Fields                                    |
| -------------------------- | ------------------ | ----------------------- | ----------- | --------------------------------------------- |
| Market Tide (all-in)       | `flow_data`        | `fetch-flow`            | 5 min       | NCP, NPP, net_volume                          |
| Market Tide (OTM)          | `flow_data`        | `fetch-flow`            | 5 min       | NCP, NPP, net_volume                          |
| SPX Net Flow               | `flow_data`        | `fetch-net-flow`        | 5 min       | NCP, NPP, net_volume                          |
| SPY Net Flow               | `flow_data`        | `fetch-net-flow`        | 5 min       | NCP, NPP, net_volume                          |
| QQQ Net Flow               | `flow_data`        | `fetch-net-flow`        | 5 min       | NCP, NPP, net_volume                          |
| SPY ETF Tide               | `flow_data`        | `fetch-etf-tide`        | 5 min       | NCP, NPP, net_volume                          |
| QQQ ETF Tide               | `flow_data`        | `fetch-etf-tide`        | 5 min       | NCP, NPP, net_volume                          |
| 0DTE Index Flow            | `flow_data`        | `fetch-zero-dte-flow`   | 5 min       | NCP, NPP, net_volume                          |
| 0DTE Delta Flow            | `flow_data`        | `fetch-greek-flow`      | 5 min       | total_delta, dir_delta, volume                |
| Greek Exposure (agg)       | `greek_exposure`   | `fetch-greek-exposure`  | 5 min       | gamma, charm, delta, vanna (all expiries)     |
| Greek Exposure (by expiry) | `greek_exposure`   | `fetch-greek-exposure`  | 5 min       | charm, delta, vanna per expiration            |
| Spot GEX Panel             | `spot_exposures`   | `fetch-spot-gex`        | 5 min       | OI/Vol/Dir gamma, charm, vanna + price        |
| Per-Strike 0DTE            | `strike_exposures` | `fetch-strike-exposure` | 5 min       | gamma, charm, delta per strike (0DTE only)    |
| Per-Strike All-Expiry      | `strike_exposures` | `fetch-strike-all`      | 5 min       | gamma, charm, delta per strike (all expiries) |

### Data Volume Estimates

| Metric                                                   | Per Day     | Per Month (21 trading days) | 30-Day Backfill   |
| -------------------------------------------------------- | ----------- | --------------------------- | ----------------- |
| Flow candles (9 sources x ~78 candles)                   | ~700        | ~14,700                     | ~21,000           |
| Greek exposure rows                                      | ~56         | ~1,176                      | ~1,680            |
| Spot GEX candles                                         | ~112        | ~2,352                      | ~3,360            |
| Strike exposure rows (0DTE, ~81 strikes x ~78 snapshots) | ~6,318      | ~132,678                    | Cron-only         |
| Strike exposure rows (all-expiry)                        | ~6,318      | ~132,678                    | Cron-only         |
| **Total rows/day**                                       | **~13,500** | **~283,500**                | Backfill complete |

### API Usage

- Current: ~1,092 calls/day (2.7% of 40,000 basic tier limit)
- Headroom: 38,908 unused calls/day for additional endpoints or higher-frequency polling

---

## Planned Models

### 1. Structure Classification — "What structure wins today?"

**Model type:** Gradient boosted classifier (XGBoost or LightGBM)

**Training features (from market snapshots + API data):**

_Static features (from calculator context):_

- VIX, VIX1D, VIX9D, VVIX
- VIX1D/VIX ratio, VIX/VIX9D ratio
- Regime zone, DOW multiplier, clustering multiplier
- Opening range signal and percent consumed
- Day of week, is Friday, is event day
- Overnight gap, previous close distance
- Delta guide ceilings (IC, CCS, PCS)

_Flow features (from API — first 30 min):_

- Market Tide NCP/NPP at 30 min, direction, divergence magnitude
- SPX Net Flow NCP/NPP at 30 min, NCP-NPP gap
- SPY Net Flow NCP/NPP at 30 min
- QQQ Net Flow NCP/NPP at 30 min
- SPY/QQQ ETF Tide NCP/NPP (hedging divergence signal)
- 0DTE Index-Only NCP/NPP (isolated from weekly noise)
- 0DTE Delta Flow total/directionalized (conviction without premium)
- Flow agreement score: how many of the 9 flow sources agree on direction (0-9)
- ETF Tide divergence flag: SPY/QQQ Net Flow vs ETF Tide disagree (binary)

_Greek/GEX features (from API):_

- Aggregate OI Net Gamma (Rule 16 regime)
- Volume GEX and Directionalized GEX
- OI GEX trend (improving or deteriorating from session start)
- 0DTE net charm (from greek_exposure table)
- 0DTE charm as % of total charm
- Charm pattern classification: CCS-confirming, PCS-confirming, all-negative, all-positive, mixed

_Per-strike features (engineered from strike_exposures):_

- Nearest positive gamma wall above ATM: distance (pts) and magnitude
- Nearest positive gamma wall below ATM: distance (pts) and magnitude
- Nearest negative gamma zone: distance (pts) and magnitude
- Gamma asymmetry ratio: sum(positive gamma above ATM) / sum(positive gamma below ATM)
- Net charm slope: average charm above ATM minus average charm below ATM
- Max positive charm strike and distance from ATM
- Max negative charm strike and distance from ATM
- 0DTE vs all-expiry gamma agreement: do the top walls align? (binary)

**Labels:** Correct structure for the day (IC, CCS, PCS, SIT OUT) — determined by end-of-day review

**Use case:** Pre-analysis sanity check. Before opening any charts, the model provides a probability distribution: "Based on today's snapshot, historical CCS days had similar profiles 73% of the time." This doesn't replace the Claude analysis — it sets a prior expectation that the chart analysis confirms or overrides.

**Data requirement:** 100+ labeled trading days (backtests + live trades)

---

### 2. Intraday Range Regression — "How far will SPX move today?"

**Model type:** Gradient boosted regressor or neural network

**Training features:**

- Morning snapshot features (same static features as above)
- VIX1D/VIX ratio (key predictor of intraday vs multi-day vol expectations)
- Aggregate GEX regime (OI + Volume + Directionalized)
- Per-strike gamma concentration: how concentrated is gamma around ATM vs spread out?
- Charm pattern: all-negative days historically produce larger ranges
- Day of week, event flags
- Historical realized vol (trailing 5-day, 10-day)
- ETF Tide divergence: hedging divergence historically produces smaller ranges
- 0DTE Index Flow vs aggregate SPX flow divergence

**Target:** Actual intraday range (high minus low) or settlement distance from open

**Use case:** Directly predicts whether the straddle cone will be consumed, partially used, or exceeded. This automates and improves what Rule 16 does heuristically with GEX thresholds. A model trained on thousands of historical days would provide calibrated confidence intervals: "Today's profile produces a 40+ pt range 78% of the time."

**Data requirement:** Available now — 30+ years of historical intraday price and volatility data can be used immediately for the base model. The API data enriches this with GEX/charm features starting from the 30-day backfill.

---

### 3. Optimal Exit Timing (Survival Analysis) — "When should I close?"

**Model type:** Cox proportional hazards or random survival forest

**Training features:**

_Entry-time features:_

- Entry snapshot features
- Structure selected (IC, CCS, PCS)
- Charm regime (supportive, decaying, all-negative — from per-strike API data)
- Aggregate GEX at entry (OI, Volume, Directionalized — all three)
- Confidence level
- Day of week, VIX regime
- Periscope Charm override status: did Periscope Charm contradict naive all-negative? (binary)
- Flow agreement score at entry
- Delta flow direction at entry (from 0DTE Greek flow)

_Time-varying covariates (from intraday API data):_

- GEX trend: is OI GEX improving or deteriorating since entry?
- Flow reversal: has the NCP/NPP relationship changed since entry?
- Gamma wall proximity: is the nearest negative gamma zone approaching the short strike?
- Charm decay rate: how fast is the protective wall's charm declining?
- Delta flow momentum: is 0DTE delta flow accelerating in the adverse direction?

**Events:**

- Time to 50% profit
- Time to first stop condition trigger
- Time to optimal exit (determined retrospectively from review data)

**Use case:** Given today's entry conditions and structure, predict the optimal hold duration. Preliminary observations from the first two weeks of trading suggest patterns:

- High-conviction CCS days hit 50% profit in 2-3 hours
- All-negative charm days should exit by noon ET (unless Periscope Charm overrides)
- Deeply negative GEX days need exits by 11:30 AM ET
- Friday afternoon compression reduces marginal theta after 1:00 PM ET
- Periscope Charm override extends safe hold by 1-2 hours on average

The intraday API data enables time-varying covariates — the model can update its prediction every 5 minutes as new flow and GEX data arrives, rather than relying solely on entry-time features.

**Data requirement:** 50-100 labeled trading days with timestamped exit data

---

### 4. Day Type Clustering — "What kind of day is this?"

**Model type:** Unsupervised clustering (k-means, DBSCAN, or Gaussian mixture)

**Input features:** Full snapshot feature set + first-hour API flow/GEX features, normalized

**Use case:** Discover natural groupings in trading days that the current 16 rules partially capture but may not perfectly delineate. The current rule system handles known patterns (FOMC days, all-negative charm, deeply negative GEX, Friday VIX > 19, VIX1D extreme inversion, ETF Tide hedging divergence). Clustering may reveal unnamed day types.

Example hypotheses:

- A cluster where VIX is moderate (18-22), GEX is mildly positive, charm is mixed, and flow is neutral — a day type where ICs perform exceptionally well but the current rules don't specifically identify as high-conviction IC setups.
- A cluster where 0DTE index flow diverges from aggregate SPX flow while ETF Tide shows hedging divergence — a day type where the "noise" in SPX flow is systematically identifiable.
- A cluster where delta flow surges while premium flow (NCP) is flat — spread-based institutional positioning that premium flow alone misses.

**Data requirement:** 200+ trading days for meaningful cluster separation

---

### 5. Naive vs Periscope Charm Divergence Predictor — "Is the naive chart wrong today?"

**Model type:** Binary classifier (logistic regression or gradient boosted)

**Training features:**

- VIX level (higher VIX = more institutional hedging = more naive assumption failures)
- VIX1D/VIX ratio
- Aggregate GEX regime
- SPX Net Flow NPP magnitude (high NPP = heavy put buying = customer/MM split distorted)
- ETF Tide divergence flag
- Flow agreement score
- Day of week (monthly/quarterly expiration effects)
- Naive charm pattern classification from per-strike API data

**Label:** Did Periscope Charm materially contradict naive charm? (binary, from review data)

**Use case:** On days when you don't have Periscope screenshots yet (pre-market, or if UW is slow), this model predicts whether the naive charm readings are likely to be misleading. If the model says "82% chance naive charm is wrong today," the trader knows to wait for Periscope Charm before applying the all-negative protocol.

This directly addresses the March 24 lesson: naive showed all-negative, Periscope showed massive positive walls. The model learns which market conditions produce these divergences.

**Data requirement:** 50+ trading days with both naive and Periscope Charm readings labeled for agreement/divergence. This data is being generated daily.

---

### 6. Flow-Price Divergence Detector — "Is this flow signal hedging or directional?"

**Model type:** Gradient boosted classifier

**Training features:**

- SPX NCP/NPP magnitude and direction
- SPX price direction over same window
- Market Tide NCP/NPP
- SPY NCP/NPP
- ETF Tide NCP/NPP (the hedging divergence signal)
- 0DTE Index Flow NCP/NPP
- 0DTE Delta Flow total/directionalized
- VIX level (VIX 25+ regime changes interpretation per Rule 10)

**Label:** Was the SPX flow directional or hedging? (from review data — determined by whether the flow predicted the settlement direction)

**Use case:** Automates Rule 10 (SPX Net Flow Hedging Divergence). Currently the rule says "trust SPX flow at VIX 25+, discount it when 3+ signals contradict." A model trained on labeled outcomes can learn the precise conditions under which SPX flow is hedging vs directional, without relying on a fixed VIX threshold or signal-count heuristic.

The new 0DTE index flow and delta flow sources provide additional features that the original Rule 10 didn't have — delta flow showing institutional positioning through spreads/combos rather than outright premium, and 0DTE-isolated flow removing weekly/monthly noise.

**Data requirement:** 100+ labeled trading days

---

## Data Infrastructure

The database schema captures all required training data:

| Table              | Purpose                        | Key Fields                                             | Records/Day |
| ------------------ | ------------------------------ | ------------------------------------------------------ | ----------- |
| `market_snapshots` | Static feature vectors         | 50+ calculator state fields per analysis run           | 1-4         |
| `flow_data`        | Intraday flow time series      | NCP, NPP, net_volume across 9 sources                  | ~700        |
| `greek_exposure`   | Daily Greek exposure by expiry | gamma, charm, delta, vanna per expiration              | ~56         |
| `spot_exposures`   | Intraday GEX panel             | OI/Vol/Dir gamma, charm, vanna + price                 | ~112        |
| `strike_exposures` | Per-strike Greek profile       | gamma, charm, delta per strike (0DTE + all-expiry)     | ~12,600     |
| `analyses`         | Model outputs + labels         | Structure, confidence, delta, chart signals, full JSON | 1-4         |
| `positions`        | Position-specific data         | Strikes, spreads, P&L, Greeks                          | 1-4         |
| `lessons`          | Curated trading lessons        | Lesson text, source session, tags                      | Growing     |

All tables are linked by date, enabling joins across features, predictions, and outcomes.

### Feature Engineering Pipeline (planned)

The raw intraday data requires feature engineering before ML consumption:

**Flow features:** NCP/NPP at fixed time checkpoints (30 min, 60 min, 90 min), rate of change, acceleration, NCP-NPP gap, convergence/divergence velocity, flow agreement score across sources.

**GEX features:** OI GEX at checkpoints, GEX trend (slope from session start), Volume GEX offset ratio, regime transition points (when did GEX cross a threshold?).

**Per-strike features:** Gamma wall distance from ATM, gamma asymmetry ratio, charm slope, charm pattern classification, 0DTE vs all-expiry agreement score, max wall magnitude and location.

**Derived features:** ETF Tide hedging divergence score, Periscope Charm override likelihood, flow-price divergence score, delta flow vs premium flow divergence.

---

## Implementation Timeline

| Phase       | Model                          | Prerequisite                                                           | Status                           |
| ----------- | ------------------------------ | ---------------------------------------------------------------------- | -------------------------------- |
| **Phase 1** | Intraday Range Regression      | 30 years historical data (available) + API backfill (30 days complete) | Ready to build                   |
| **Phase 2** | Structure Classification       | 100+ labeled trading days                                              | Accumulating data (~8 days live) |
| **Phase 3** | Optimal Exit Timing            | 50-100 days with timestamped exits + intraday API data                 | Accumulating data                |
| **Phase 4** | Day Type Clustering            | 200+ trading days with full feature set                                | Accumulating data                |
| **Phase 5** | Charm Divergence Predictor     | 50+ days with Periscope vs naive comparison                            | Accumulating data                |
| **Phase 6** | Flow-Price Divergence Detector | 100+ labeled days with 0DTE flow data                                  | Accumulating data                |

Phase 1 can begin immediately using the existing historical dataset enriched with 30 days of backfilled API data. Phases 2-6 require continued daily trading with the current rule-based system, which generates labeled training data with every session.

---

## Design Philosophy

The ML models are designed to **augment, not replace** the existing system. The 16 empirical rules and Claude-powered chart analysis remain the primary decision-making framework. ML provides:

- **Pre-analysis priors** — What does historical data suggest before looking at today's charts?
- **Calibrated thresholds** — Where should the GEX regime boundaries actually be, based on thousands of data points instead of a handful?
- **Pattern discovery** — What day types exist that the rules don't yet name?
- **Management optimization** — When is the statistically optimal exit time given today's entry conditions?
- **Signal validation** — Is the naive charm chart likely to be wrong today? Is SPX flow hedging or directional?

The rule-based system captures domain expertise. The API pipeline provides precise, structured data. The ML system validates and extends both with historical patterns.

---

## API Coverage Summary

**Automated via API (no screenshots needed):**

- Market Tide (all-in + OTM)
- SPX / SPY / QQQ Net Flow
- SPY / QQQ ETF Tide
- 0DTE Index-Only Net Flow
- 0DTE Delta Flow
- Aggregate Greek Exposure (gamma + charm + delta + vanna)
- Intraday GEX Panel (OI + Volume + Directionalized)
- Per-Strike 0DTE Profile (naive gamma + charm per strike)
- Per-Strike All-Expiry Profile (multi-day gamma anchors)

**Still requires screenshots (proprietary Periscope data):**

- Periscope Gamma — confirmed MM gamma exposure per strike
- Periscope Charm — confirmed MM charm exposure per strike

**API utilization:** ~1,092 calls/day of 40,000 limit (2.7%). Significant headroom for additional endpoints or higher-frequency polling if needed.
