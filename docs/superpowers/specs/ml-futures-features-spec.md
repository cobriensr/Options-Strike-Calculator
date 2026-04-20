# ML Futures Features Spec — Addendum

**Date:** 2026-04-05
**Parent spec:** `futures-data-integration-2026-04-05.md`
**Scope:** Expand the original ~32 planned futures features to ~50 by adding GC/DX features, cross-asset regime scores, and multi-timeframe momentum. Define implementation details, SQL patterns, edge cases, and Python-side updates.

---

## 1. Review of Existing Plan (32 Features)

The 32 features defined in `ml/src/utils.py` (lines 140-202) and the Phase 2 comment block in `build-features.ts` (lines 269-319) are well-designed and largely complete. Below is an assessment of each group.

### ES Features (8) -- Sound

| Feature                             | Assessment                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `es_momentum_t1` / `es_momentum_t2` | Good. 1H return at T1/T2 checkpoints. Aligns with the existing checkpoint system (10:00 AM and 10:30 AM ET). |
| `es_spx_basis_t1`                   | Good. Requires `spx_open` from `market_snapshots` (already computed) and ES price at T1 from `futures_bars`. |
| `es_volume_ratio_t1`                | Good. Requires a 20-day lookback of ES volume, computable from `futures_bars`.                               |
| `es_overnight_range`                | Good. Globex high - low from overnight bars (5 PM CT to 9:30 AM ET).                                         |
| `es_overnight_gap`                  | Good. Cash open - Globex close. Depends on `spx_open` being populated.                                       |
| `es_gap_fill_pct_t1`                | Good. Requires both gap direction and ES price movement by T1. Edge case: if gap is 0 pts, set to null.      |
| `es_vwap_deviation_t1`              | Good. Requires computing VWAP from overnight bars (sum of price\*volume / sum of volume).                    |

**Issue identified:** `es_momentum_t2` uses a different checkpoint time than the flow T2 (10:30 AM). This is fine -- but the comment says "1H return at T2" which implies the return over the hour ending at T2, not the return from open to T2. The implementation should compute `(ES_close_at_T2 - ES_close_at_T2_minus_60min) / ES_close_at_T2_minus_60min * 100`. Clarify in implementation.

### NQ Features (4) -- Sound, One Dependency Note

| Feature                | Assessment                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nq_momentum_t1`       | Good. Same pattern as ES.                                                                                                                                                                                                                                                                                        |
| `nq_es_ratio_t1`       | Good. NQ price / ES price at T1.                                                                                                                                                                                                                                                                                 |
| `nq_es_ratio_change`   | Good. Requires prior day close for both NQ and ES from `futures_bars`.                                                                                                                                                                                                                                           |
| `nq_qqq_divergence_t1` | **Dependency note:** Requires QQQ NCP from `flow_data` table at T1. The flow feature engineering already extracts `qqq_ncp_t1`, so this can be computed in the same pass -- just needs the sign of NQ momentum and the sign of QQQ NCP. Set to 1 if signs agree, -1 if they disagree, null if either is missing. |

### VX Features (5) -- Sound, Data Availability Concern

| Feature              | Assessment                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `vx_front_price`     | Good. From `futures_bars` where symbol = 'VX1'.                               |
| `vx_term_spread`     | Good. front - back.                                                           |
| `vx_term_slope_pct`  | Good. (front - back) / back \* 100.                                           |
| `vx_contango_signal` | Good. Binary signal.                                                          |
| `vx_basis`           | Good. VX front - spot VIX. Spot VIX is available from `market_snapshots.vix`. |

**Data availability concern:** VX streaming started after the other symbols. For backfill, Databento has VX OHLCV-1m history (15+ years at L0), so historical computation is fine. The concern is only for the gap period between when the sidecar went live and when VX streaming was added. For any date where `futures_bars` has no VX1/VX2 rows, all 5 VX features should be null. The `NULLABLE_FEATURE_KEYS` set in `build-features.ts` already lists all VX features, so completeness scoring handles this correctly.

### ZN Features (3) -- Sound, Correlation Requires Lookback

| Feature                 | Assessment                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zn_momentum_t1`        | Good.                                                                                                                                                                                                                                                                      |
| `zn_daily_change`       | Good. Prior day close-to-close % change.                                                                                                                                                                                                                                   |
| `spx_zn_correlation_5d` | **Implementation note:** Requires computing Pearson correlation of daily returns over the prior 5 trading days. This needs `outcomes.settlement` for SPX and `futures_bars` daily closes for ZN. Must handle the case where fewer than 5 days of data exist (return null). |

### RTY Features (2) -- Sound

Both features are straightforward sign-comparison signals.

### CL Features (3) -- Sound

| Feature                   | Assessment                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `cl_overnight_change_pct` | Requires prior day settlement from `futures_bars` (last bar of prior RTH session) and Globex close. |
| `cl_intraday_momentum_t1` | Cash open to T1 change.                                                                             |
| `cl_es_correlation_5d`    | Same pattern as `spx_zn_correlation_5d`.                                                            |

### ES Options Features (8) -- Sound, Most Complex Group

| Feature                     | Assessment                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `es_put_oi_concentration`   | From `futures_options_daily`. Max put OI at any strike / total put OI.                                                                                                                       |
| `es_call_oi_concentration`  | Same for calls.                                                                                                                                                                              |
| `es_options_max_pain_dist`  | Requires computing max pain from `futures_options_daily` OI distribution. Can reuse the max pain algorithm from `api/_lib/max-pain.ts`.                                                      |
| `es_spx_gamma_agreement`    | **Most complex feature.** Requires comparing ES options OI peaks against SPX gamma walls from `greek_exposure` snapshots. Returns 0-1 score based on distance between the two sets of walls. |
| `es_put_buy_aggressor_pct`  | From `futures_options_trades`. Filter to puts, count side='B' volume / total volume. **Requires tick trades data** which is the most storage-intensive table.                                |
| `es_call_buy_aggressor_pct` | Same for calls.                                                                                                                                                                              |
| `es_options_net_delta`      | From `futures_options_daily` where `delta` is not null. Sum of delta \* OI across ATM strikes.                                                                                               |
| `es_atm_iv`                 | From `futures_options_daily` where strike is nearest ATM.                                                                                                                                    |

**Dependency:** `es_put_buy_aggressor_pct` and `es_call_buy_aggressor_pct` require the `futures_options_trades` table to be populated. This is the most expensive backfill (12-month L1 data, ~200 MB). If trades backfill is deferred, these two features will be null for historical dates. The other 6 ES options features can be computed from `futures_options_daily` (Statistics schema, which is L0 with 15+ years of history).

### Overall Assessment

The 32-feature plan is solid. No features need to be removed. The main risks are:

1. VX data gap between sidecar launch and VX streaming activation (handled by nullable keys)
2. ES options trades backfill cost/size (can defer the 2 aggressor features)
3. Cross-symbol correlation features need careful lookback window management (first 5 days will be null)

---

## 2. New Features: GC (Gold) -- 5 Features

GC and DX were added to the sidecar subscription after the original feature plan was written. The sidecar already streams GC on `GLBX.MDP3` (COMEX) and DX on `IFUS.IMPACT` (ICE Futures US). Both symbols write to `futures_bars` with `symbol = 'GC'` and `symbol = 'DX'` respectively.

### Feature Definitions

```python
GC_FEATURES: list[str] = [
    "gc_overnight_change_pct",   # % change from prior settlement to Globex close
    "gc_intraday_momentum_t1",   # % change from cash open to T1
    "gc_es_inverse_5d",          # 5-day rolling correlation GC vs ES (expected negative in stress)
    "gc_safe_haven_signal",      # 1 if GC rising while ES falling at T1, 0 otherwise, -1 if GC falling while ES rising
    "gc_zn_agreement_t1",        # 1 if GC and ZN moving same direction at T1 (both safe havens bid), 0 otherwise
]
```

### Rationale for Each Feature

**`gc_overnight_change_pct`** -- Gold reacts to overnight geopolitical events faster than equities. A large overnight gold move (+/-1%+) before the cash equity open signals macro risk repricing that may persist into the 0DTE session.

**`gc_intraday_momentum_t1`** -- Measures gold's intraday direction by the T1 checkpoint. Gold strength during cash hours, when equities are also trading, is a stronger safe-haven signal than overnight moves (which may be Asia/Europe driven).

**`gc_es_inverse_5d`** -- The GC-ES correlation tells you whether gold is currently acting as a safe haven (negative correlation) or a risk asset (positive correlation, which happens during reflation trades). When correlation is strongly negative, GC moves become more relevant to SPX positioning.

**`gc_safe_haven_signal`** -- Binary signal for the classic flight-to-safety pattern: gold up + equities down. This is the key input to the cross-asset regime score (Section 4). Computed as:

- `sign(gc_momentum_t1) == 1 AND sign(es_momentum_t1) == -1` --> 1 (safe haven active)
- `sign(gc_momentum_t1) == -1 AND sign(es_momentum_t1) == 1` --> -1 (risk-on, gold sold)
- Otherwise --> 0 (no divergence)

**`gc_zn_agreement_t1`** -- When both safe-haven assets (gold and bonds) are moving in the same direction, the signal is stronger. If ZN up + GC up = "double safe haven bid" = strong risk-off. If ZN flat + GC up = could be inflation, not just fear. This disambiguates the safe-haven signal.

### SQL Query Pattern

```sql
-- GC bars for overnight change and T1 momentum
SELECT ts, open, high, low, close, volume
FROM futures_bars
WHERE symbol = 'GC'
  AND ts BETWEEN ($prior_close_ts) AND ($t1_ts)
ORDER BY ts ASC;
```

### Edge Cases

- GC Globex session is 5:00 PM - 4:00 PM CT (nearly 23 hours). Overnight range should use the same 5 PM CT to 9:30 AM ET window as ES for consistency.
- GC trades on COMEX (part of GLBX.MDP3), so no separate dataset subscription is needed -- it shares the CME client with ES, NQ, ZN, RTY, CL.
- If GC bars are missing for a date (sidecar downtime), all 5 features are null. Already handled by `NULLABLE_FEATURE_KEYS`.

---

## 3. New Features: DX (US Dollar Index) -- 4 Features

### Feature Definitions

```python
DX_FEATURES: list[str] = [
    "dx_overnight_change_pct",   # % change from prior settlement to Globex close
    "dx_intraday_momentum_t1",   # % change from cash open to T1
    "dx_es_inverse_5d",          # 5-day rolling correlation DX vs ES (expected negative)
    "dx_strength_headwind",      # 1 if DX rising >0.3% and ES flat/falling, 0 otherwise
]
```

### Rationale for Each Feature

**`dx_overnight_change_pct`** -- Dollar moves overnight reflect global macro flows (foreign central bank actions, trade data). A strong dollar overnight tends to be a headwind for equities at the open.

**`dx_intraday_momentum_t1`** -- Same logic as other intraday momentum features. DX strength during cash hours is more directly relevant to SPX than overnight moves.

**`dx_es_inverse_5d`** -- The dollar-equity inverse correlation is one of the strongest macro relationships. When DX-ES correlation is strongly negative (normal), a rising dollar compresses equity multiples. When correlation breaks down (goes positive), it signals unusual macro conditions (e.g., both rallying on safe-haven USD + tech AI rally).

**`dx_strength_headwind`** -- A practical binary feature: is the dollar strong enough to act as an equity headwind? Threshold of 0.3% intraday move is ~0.3 DX points, which is notable for a single session. Combined with ES flat/falling, this identifies sessions where dollar strength is weighing on equities.

### SQL Query Pattern

Same pattern as GC. DX bars are in `futures_bars` with `symbol = 'DX'`.

### Edge Cases

- DX trades on ICE Futures US (`IFUS.IMPACT`), which uses a **separate Databento Live client** in the sidecar (see `databento_client.py` line 128, `_start_ice_client()`). If the ICE client fails while the CME client is healthy, DX will be missing while other symbols are present. Feature engineering must not fail -- just null out the DX features.
- DX has different trading hours than CME products. ICE DX futures trade Sunday 6:00 PM - Friday 5:00 PM ET. The overnight window should still use the same 5 PM CT to 9:30 AM ET definition for consistency.
- DX is quoted in index points (e.g., 104.250), not dollars. % change calculations are the same as for any other instrument.

---

## 4. New Features: Cross-Asset Regime Scores -- 5 Features

These composite features combine signals from multiple instruments to produce regime-level indicators. They are derived from other features computed in the same pass, so they must be computed last.

### Feature Definitions

```python
REGIME_FEATURES: list[str] = [
    "regime_risk_score",         # Weighted risk-on/risk-off score (-1 to +1)
    "regime_flight_to_safety",   # 1 if ZN up + GC up + ES down at T1, 0 otherwise
    "regime_macro_stress",       # Composite stress score (0 to 1) from VX, ZN, GC, DX
    "regime_breadth_quality",    # Composite breadth score: ES+NQ+RTY agreement strength
    "regime_vol_regime",         # Categorical: COMPRESSED, NORMAL, ELEVATED, CRISIS
]
```

### Computation Details

**`regime_risk_score`** -- Weighted composite from the futures-panel-redesign spec's regime scoring algorithm, adapted for feature engineering:

```
score = 0
score += 0.30 * sign(es_momentum_t1)  * min(1, abs(es_momentum_t1) / 0.3)
score += 0.20 * sign(nq_momentum_t1)  * min(1, abs(nq_momentum_t1) / 0.3)
score += 0.15 * vx_contango_signal    # already -1/+1
score += 0.10 * (-sign(zn_momentum_t1)) * min(1, abs(zn_momentum_t1) / 0.2)
         # ZN inverted: ZN up = risk off = negative contribution
score += 0.10 * (-gc_safe_haven_signal)
         # GC safe haven active = risk off = negative contribution
score += 0.05 * sign(cl_intraday_momentum_t1) * min(1, abs(cl_intraday_momentum_t1) / 1.0)
score += 0.05 * (-sign(dx_intraday_momentum_t1)) * min(1, abs(dx_intraday_momentum_t1) / 0.3)
         # DX inverted: DX up = equity headwind = negative contribution
score += 0.05 * rty_es_divergence_t1  # +1 if aligned (broad), -1 if diverging

# Clamp to [-1, +1]
regime_risk_score = max(-1, min(1, score))
```

Weights match the futures-panel-redesign spec (ES 0.30, NQ 0.20, VX 0.20-->0.15 to accommodate GC/DX, ZN 0.10, GC 0.10, CL 0.05, DX 0.05) with RTY contributing to breadth. When any input is null, its weight is redistributed proportionally to non-null inputs to avoid regime score deflation.

**`regime_flight_to_safety`** -- Strict definition from the futures-panel-redesign spec: all three conditions must be true at T1:

- ZN 1H momentum > 0.1% (bonds rallying)
- GC 1H momentum > 0.1% (gold rallying)
- ES 1H momentum < -0.1% (equities selling)

Returns 1 if all three conditions met, 0 otherwise. This is the most actionable signal -- it means institutional capital is actively leaving equities for safe havens. The Claude analysis spec says this is a "TRENDING day signal" where the selloff has institutional sponsorship.

**`regime_macro_stress`** -- Continuous score from 0 (calm) to 1 (crisis):

```
stress = 0
# VX component: backwardation or high term spread
if vx_contango_signal == -1:
    stress += 0.30  # backwardation = near-term stress
elif vx_term_slope_pct is not null and abs(vx_term_slope_pct) < 2:
    stress += 0.15  # flat term structure = transitional

# ZN flight component
if zn_momentum_t1 is not null and zn_momentum_t1 > 0.15:
    stress += 0.25  # aggressive bond buying

# GC safe haven component
if gc_safe_haven_signal == 1:
    stress += 0.20

# DX stress component (strong dollar = equity stress)
if dx_intraday_momentum_t1 is not null and dx_intraday_momentum_t1 > 0.3:
    stress += 0.15

# VIX level component (from existing features)
if vx_front_price is not null and vx_front_price > 25:
    stress += 0.10
elif vx_front_price is not null and vx_front_price > 30:
    stress += 0.20  # replaces the 0.10 above

# Clamp to [0, 1]
regime_macro_stress = min(1.0, stress)
```

**`regime_breadth_quality`** -- Measures how broad the equity market move is:

```
agreement_count = 0
total = 0
for symbol in [es_momentum_t1, nq_momentum_t1, rty_momentum_t1]:
    if symbol is not null:
        total += 1
        if sign(symbol) == sign(es_momentum_t1):
            agreement_count += 1

if total >= 2:
    breadth = agreement_count / total  # 0.33, 0.67, or 1.0
    # Weight by magnitude: strong aligned moves score higher
    mag_factor = min(1, (abs(es_momentum_t1) + abs(nq_momentum_t1 or 0) + abs(rty_momentum_t1 or 0)) / (total * 0.3))
    regime_breadth_quality = breadth * 0.7 + mag_factor * 0.3
else:
    regime_breadth_quality = null
```

**`regime_vol_regime`** -- Categorical label derived from VIX and VX features:

- `COMPRESSED`: VIX < 15 AND vx_contango_signal == 1 AND vx_basis < 1
- `NORMAL`: VIX 15-22 AND vx_contango_signal == 1
- `ELEVATED`: VIX 22-30 OR vx_contango_signal == 0 (flat)
- `CRISIS`: VIX > 30 OR vx_contango_signal == -1 (backwardation)

This maps to IC viability: COMPRESSED (wide, aggressive), NORMAL (standard), ELEVATED (conservative, wider strikes), CRISIS (avoid IC, directional only).

### Implementation Note

Regime features depend on per-instrument features already being computed. In `buildFeaturesForDate()`, the futures feature engineering function must:

1. First compute all per-instrument features (ES, NQ, VX, ZN, RTY, CL, GC, DX)
2. Then compute ES options features
3. Then compute regime features from the per-instrument results

This is a natural ordering -- just ensure the regime computation happens at the end of `engineerFuturesFeatures()`.

---

## 5. Multi-Timeframe Momentum -- 6 Features

### Which Timeframes Add Signal for 0DTE?

With 1-minute bars available, we can aggregate to any timeframe. The question is which timeframes provide independent signal vs. redundant noise.

**Analysis of timeframes for 0DTE relevance:**

| Timeframe | Signal Content                                | 0DTE Relevance                                                                                                                   | Recommendation        |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 5 min     | Microstructure noise, HFT artifacts           | Low -- too noisy for credit spread decisions                                                                                     | Skip                  |
| 15 min    | Emerging trends, opening range breakouts      | Medium -- useful for confirming opening range                                                                                    | Include for ES only   |
| 30 min    | Session momentum, institutional flow cadence  | High -- aligns with how institutions build positions. This is the regime scoring timeframe from the futures-panel-redesign spec. | Include for ES and NQ |
| 1 hour    | Strong trend confirmation, the "T1" timeframe | Already captured by `*_momentum_t1` features                                                                                     | Already included      |
| 2 hour    | Mid-session trend, T1-to-T3 evolution         | Medium -- captures trend persistence through the 0DTE decay window                                                               | Include for ES        |
| 4 hour    | Context timeframe, macro drift                | Low for 0DTE -- too long for same-day decisions                                                                                  | Skip                  |

**Decision:** Add 15-min, 30-min, and 2-hour momentum for ES, plus 30-min for NQ. These complement the existing 1-hour features without adding excessive dimensionality.

### Feature Definitions

```python
MULTI_TF_FEATURES: list[str] = [
    "es_momentum_15m_t1",   # ES return over 15 min ending at T1 (%)
    "es_momentum_30m_t1",   # ES return over 30 min ending at T1 (%)
    "es_momentum_2h_t1",    # ES return over 2 hours ending at T1 (%)
    "nq_momentum_30m_t1",   # NQ return over 30 min ending at T1 (%)
    "es_momentum_accel_t1", # es_momentum_30m - es_momentum_15m (acceleration)
    "es_rth_vwap_dist_t1",  # ES price at T1 - RTH session VWAP (pts)
]
```

### Rationale

**`es_momentum_15m_t1`** -- Captures the most recent microtrend. Useful for detecting whether the move into T1 is accelerating or decelerating. The opening range is typically established in the first 15-30 minutes.

**`es_momentum_30m_t1`** -- The panel redesign spec uses 30-min momentum for regime scoring. This aligns the ML features with the frontend's regime detection. 30-min captures one full "rotation" of institutional order flow.

**`es_momentum_2h_t1`** -- At T1 (10:00 AM ET), a 2-hour lookback goes to 8:00 AM ET (pre-market). This captures the transition from overnight Globex to cash open, including any gap-and-go or gap-and-fade behavior. This is a different signal from `es_overnight_gap` because it includes the first 30 minutes of cash trading.

**`nq_momentum_30m_t1`** -- NQ's 30-min momentum provides the tech sector's immediate trend, complementing the 1H `nq_momentum_t1`. When NQ 30-min and NQ 1H disagree, the 30-min is more recent and may reflect a reversal in progress.

**`es_momentum_accel_t1`** -- Acceleration (30m momentum minus 15m momentum) tells you whether the trend is strengthening or weakening. Positive acceleration with positive momentum = strong trend. Negative acceleration with positive momentum = trend exhausting. This is a second-derivative feature that adds independent signal.

**`es_rth_vwap_dist_t1`** -- Distance from the session VWAP at T1. Institutional algorithms heavily reference VWAP. Trades above VWAP indicate buyers are in control; below VWAP indicates sellers. Unlike overnight VWAP (already captured by `es_vwap_deviation_t1`), this is the RTH (regular trading hours) VWAP starting from 9:30 AM ET.

### SQL Query Pattern

```sql
-- 15-min momentum: get ES close at T1 and 15 min before T1
WITH t1_bar AS (
    SELECT close FROM futures_bars
    WHERE symbol = 'ES' AND ts <= $t1_ts
    ORDER BY ts DESC LIMIT 1
),
t1_minus_15 AS (
    SELECT close FROM futures_bars
    WHERE symbol = 'ES' AND ts <= $t1_ts - interval '15 minutes'
    ORDER BY ts DESC LIMIT 1
)
SELECT
    (t1_bar.close - t1_minus_15.close) / t1_minus_15.close * 100 AS momentum_15m
FROM t1_bar, t1_minus_15;

-- RTH VWAP: volume-weighted average from 9:30 AM ET to T1
SELECT
    SUM(close * volume) / NULLIF(SUM(volume), 0) AS rth_vwap
FROM futures_bars
WHERE symbol = 'ES'
  AND ts >= $rth_open_ts   -- 9:30 AM ET on trade date
  AND ts <= $t1_ts;
```

---

## 6. Implementation Plan

### 6.1 New Module: `api/_lib/build-features-futures.ts`

Following the existing pattern (`build-features-flow.ts`, `build-features-gex.ts`, etc.), create a dedicated module for futures feature engineering.

```typescript
// api/_lib/build-features-futures.ts

export async function engineerFuturesFeatures(
  sql: NeonQueryFunction<false, false>,
  dateStr: string,
  features: FeatureRow,
): Promise<void> {
  // 1. Fetch all futures bars for the date + lookback window
  // 2. Compute per-instrument features (ES, NQ, VX, ZN, RTY, CL, GC, DX)
  // 3. Compute multi-timeframe features
  // 4. Compute ES options features (from futures_options_daily)
  // 5. Compute regime features (depends on per-instrument results)
}
```

### 6.2 Internal Structure

The function should be split into focused helper functions:

```
engineerFuturesFeatures()
  ├── fetchFuturesBarsForDate()     -- single query, all symbols
  ├── fetchPriorDayCloses()         -- for overnight change features
  ├── fetchRollingDailyCloses()     -- for 5-day correlation features
  ├── computeEsFeatures()
  ├── computeNqFeatures()
  ├── computeVxFeatures()
  ├── computeZnFeatures()
  ├── computeRtyFeatures()
  ├── computeClFeatures()
  ├── computeGcFeatures()           -- NEW
  ├── computeDxFeatures()           -- NEW
  ├── computeMultiTfFeatures()      -- NEW
  ├── computeEsOptionsFeatures()
  └── computeRegimeFeatures()       -- NEW (must be last)
```

### 6.3 SQL Query Strategy

**Minimize round trips.** Instead of querying per-symbol, fetch all bars for the date in one query and filter in TypeScript:

```sql
-- All futures bars from prior day 5 PM CT through T2
SELECT symbol, ts, open, high, low, close, volume
FROM futures_bars
WHERE ts BETWEEN $prior_5pm_ct AND $t2_ts
  AND symbol IN ('ES', 'NQ', 'VX1', 'VX2', 'ZN', 'RTY', 'CL', 'GC', 'DX')
ORDER BY symbol, ts ASC;
```

This returns ~9 symbols x ~1,050 bars = ~9,450 rows. At ~100 bytes/row, this is ~945 KB -- well within a single query's capacity.

**Rolling correlation lookback** requires 5 prior trading days of daily close data. Separate query:

```sql
-- Daily close prices for correlation computation (prior 6 trading days)
SELECT
    symbol,
    DATE(ts AT TIME ZONE 'America/New_York') AS trade_date,
    (ARRAY_AGG(close ORDER BY ts DESC))[1] AS daily_close
FROM futures_bars
WHERE symbol IN ('ES', 'ZN', 'CL', 'GC', 'DX')
  AND ts BETWEEN ($date - interval '10 days') AND ($date)
  AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') BETWEEN 9 AND 16
GROUP BY symbol, DATE(ts AT TIME ZONE 'America/New_York')
ORDER BY symbol, trade_date DESC
LIMIT 60;
```

**ES options daily** is a separate table with different structure:

```sql
-- ES options OI and Greeks for the analysis date
SELECT strike, option_type, open_interest, volume, implied_vol, delta, settlement
FROM futures_options_daily
WHERE underlying = 'ES'
  AND trade_date = $dateStr
  AND open_interest IS NOT NULL
ORDER BY open_interest DESC;
```

**ES options trades** (for aggressor features) if the table is populated:

```sql
-- Aggressor breakdown for ES options on the analysis date
SELECT
    option_type,
    SUM(CASE WHEN side = 'B' THEN size ELSE 0 END) AS buy_aggressor_vol,
    SUM(size) AS total_vol
FROM futures_options_trades
WHERE underlying = 'ES'
  AND trade_date = $dateStr
GROUP BY option_type;
```

### 6.4 T1/T2 Checkpoint Timing

The existing checkpoint system defines:

- T1 = 10:00 AM ET (600 minutes after midnight)
- T2 = 10:30 AM ET (630 minutes)
- T3 = 11:00 AM ET (660 minutes)
- T4 = 11:30 AM ET (690 minutes)

Futures features use T1 and T2 only. The bar timestamps are in UTC. Conversion:

```typescript
// ET to UTC during EDT (summer): ET + 4 hours
// ET to UTC during EST (winter): ET + 5 hours
// Use the timezone utility already imported in build-features-types.ts
const t1Utc = new Date(`${dateStr}T10:00:00-04:00`); // EDT
// Or use getETTime() to handle DST correctly
```

For multi-timeframe lookbacks, compute the UTC timestamp for each lookback start:

- 15-min: T1 minus 15 minutes
- 30-min: T1 minus 30 minutes
- 2-hour: T1 minus 120 minutes

### 6.5 DB Migration

A new migration is needed to add futures feature columns to `training_features`. This should be a single migration (next available ID after current max):

```sql
ALTER TABLE training_features
  -- ES features (8)
  ADD COLUMN IF NOT EXISTS es_momentum_t1         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_momentum_t2         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_spx_basis_t1        DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS es_volume_ratio_t1     DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_overnight_range     DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS es_overnight_gap       DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS es_gap_fill_pct_t1     DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_vwap_deviation_t1   DECIMAL(8,2),
  -- NQ features (4)
  ADD COLUMN IF NOT EXISTS nq_momentum_t1         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS nq_es_ratio_t1         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS nq_es_ratio_change     DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS nq_qqq_divergence_t1   SMALLINT,
  -- VX features (5)
  ADD COLUMN IF NOT EXISTS vx_front_price         DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS vx_term_spread         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS vx_term_slope_pct      DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS vx_contango_signal     SMALLINT,
  ADD COLUMN IF NOT EXISTS vx_basis               DECIMAL(8,4),
  -- ZN features (3)
  ADD COLUMN IF NOT EXISTS zn_momentum_t1         DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS zn_daily_change        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS spx_zn_correlation_5d  DECIMAL(8,4),
  -- RTY features (2)
  ADD COLUMN IF NOT EXISTS rty_momentum_t1        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS rty_es_divergence_t1   SMALLINT,
  -- CL features (3)
  ADD COLUMN IF NOT EXISTS cl_overnight_change_pct DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS cl_intraday_momentum_t1 DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS cl_es_correlation_5d    DECIMAL(8,4),
  -- GC features (5) NEW
  ADD COLUMN IF NOT EXISTS gc_overnight_change_pct DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS gc_intraday_momentum_t1 DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS gc_es_inverse_5d        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS gc_safe_haven_signal    SMALLINT,
  ADD COLUMN IF NOT EXISTS gc_zn_agreement_t1      SMALLINT,
  -- DX features (4) NEW
  ADD COLUMN IF NOT EXISTS dx_overnight_change_pct DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS dx_intraday_momentum_t1 DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS dx_es_inverse_5d        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS dx_strength_headwind    SMALLINT,
  -- ES Options features (8)
  ADD COLUMN IF NOT EXISTS es_put_oi_concentration   DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_call_oi_concentration  DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_options_max_pain_dist  DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS es_spx_gamma_agreement    DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_put_buy_aggressor_pct  DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_call_buy_aggressor_pct DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_options_net_delta       DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS es_atm_iv                 DECIMAL(8,6),
  -- Multi-timeframe features (6) NEW
  ADD COLUMN IF NOT EXISTS es_momentum_15m_t1      DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_momentum_30m_t1      DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_momentum_2h_t1       DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS nq_momentum_30m_t1      DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_momentum_accel_t1    DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS es_rth_vwap_dist_t1     DECIMAL(8,2),
  -- Regime features (5) NEW
  ADD COLUMN IF NOT EXISTS regime_risk_score        DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS regime_flight_to_safety  SMALLINT,
  ADD COLUMN IF NOT EXISTS regime_macro_stress      DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS regime_breadth_quality   DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS regime_vol_regime        TEXT;
```

After adding the migration to `db-migrations.ts`, update the `api/__tests__/db.test.ts` mock:

- Add `{ id: N }` to the applied-migrations mock
- Add the migration to the expected-output list
- Update the SQL call count (1 ALTER + 1 INSERT INTO schema_migrations)

### 6.6 Upsert Changes

The upsert in `build-features.ts` must be extended with all 52 new columns (existing 32 futures + 9 GC/DX + 6 multi-TF + 5 regime). This is the largest single change -- the INSERT and ON CONFLICT UPDATE lists both grow by 52 columns.

### 6.7 NULLABLE_FEATURE_KEYS Update

All 52 futures features must be added to `NULLABLE_FEATURE_KEYS` in `build-features.ts` to prevent completeness scoring from penalizing dates before the sidecar is live. The existing 32 are already listed (lines 132-165). Add the new 20:

```typescript
// GC features
'gc_overnight_change_pct',
'gc_intraday_momentum_t1',
'gc_es_inverse_5d',
'gc_safe_haven_signal',
'gc_zn_agreement_t1',
// DX features
'dx_overnight_change_pct',
'dx_intraday_momentum_t1',
'dx_es_inverse_5d',
'dx_strength_headwind',
// Multi-timeframe features
'es_momentum_15m_t1',
'es_momentum_30m_t1',
'es_momentum_2h_t1',
'nq_momentum_30m_t1',
'es_momentum_accel_t1',
'es_rth_vwap_dist_t1',
// Regime features
'regime_risk_score',
'regime_flight_to_safety',
'regime_macro_stress',
'regime_breadth_quality',
'regime_vol_regime',
```

---

## 7. Python-Side Updates (`ml/src/utils.py`)

### New Feature Groups

Add after the existing `CL_FEATURES` definition (line 181):

```python
GC_FEATURES: list[str] = [
    "gc_overnight_change_pct",   # % change from prior settlement to Globex close
    "gc_intraday_momentum_t1",   # % change from cash open to T1
    "gc_es_inverse_5d",          # 5-day rolling correlation GC vs ES
    "gc_safe_haven_signal",      # 1 = GC up + ES down, -1 = GC down + ES up, 0 = no divergence
    "gc_zn_agreement_t1",        # 1 = GC and ZN same direction at T1, 0 = not
]

DX_FEATURES: list[str] = [
    "dx_overnight_change_pct",   # % change from prior settlement to Globex close
    "dx_intraday_momentum_t1",   # % change from cash open to T1
    "dx_es_inverse_5d",          # 5-day rolling correlation DX vs ES
    "dx_strength_headwind",      # 1 = DX rising >0.3% + ES flat/falling, 0 = not
]

MULTI_TF_FEATURES: list[str] = [
    "es_momentum_15m_t1",        # ES return over 15 min ending at T1
    "es_momentum_30m_t1",        # ES return over 30 min ending at T1
    "es_momentum_2h_t1",         # ES return over 2 hours ending at T1
    "nq_momentum_30m_t1",        # NQ return over 30 min ending at T1
    "es_momentum_accel_t1",      # 30m momentum - 15m momentum (acceleration)
    "es_rth_vwap_dist_t1",       # ES price at T1 - RTH session VWAP (pts)
]

REGIME_FEATURES: list[str] = [
    "regime_risk_score",         # Weighted risk-on/risk-off score (-1 to +1)
    "regime_flight_to_safety",   # 1 if ZN up + GC up + ES down at T1
    "regime_macro_stress",       # Composite stress score (0 to 1)
    "regime_breadth_quality",    # Composite breadth score
    "regime_vol_regime",         # COMPRESSED, NORMAL, ELEVATED, CRISIS
]
```

### Updated FUTURES_FEATURES Aggregate

Replace the existing `FUTURES_FEATURES` definition (lines 194-202):

```python
FUTURES_FEATURES: list[str] = (
    ES_FEATURES
    + NQ_FEATURES
    + VX_FEATURES
    + ZN_FEATURES
    + RTY_FEATURES
    + CL_FEATURES
    + GC_FEATURES           # NEW
    + DX_FEATURES           # NEW
    + MULTI_TF_FEATURES     # NEW
    + ES_OPTIONS_FEATURES
    + REGIME_FEATURES       # NEW
)
```

### Impact on ML Scripts

- **clustering.py** -- Uses `FUTURES_FEATURES` for feature selection. The expanded list will automatically include new features. However, the imputer will need to handle the increased null rate for GC/DX (missing for pre-sidecar dates) and regime features (derived, so null whenever inputs are null). The existing `SimpleImputer` with `strategy='median'` handles this, and the `UserWarning` suppression (line 18) covers the all-NaN columns.

- **phase2_early.py** -- Uses individual feature group lists for targeted analysis. Add GC, DX, MULTI_TF, and REGIME feature groups to the analysis sections.

- **eda.py** -- Feature correlation analysis will automatically pick up new features if it reads from `FUTURES_FEATURES`.

---

## 8. Data Dependencies

### Features Computable from Backfilled Data Only

These features require only `futures_bars` (historically backfilled) and `market_snapshots` / `outcomes` (already populated):

| Feature                                                                       | Data Source                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `es_momentum_t1`, `es_momentum_t2`                                            | `futures_bars` (ES)                                 |
| `es_overnight_range`, `es_overnight_gap`, `es_gap_fill_pct_t1`                | `futures_bars` (ES) + `market_snapshots` (spx_open) |
| `es_vwap_deviation_t1`                                                        | `futures_bars` (ES)                                 |
| `es_volume_ratio_t1`                                                          | `futures_bars` (ES, 20-day lookback)                |
| `es_spx_basis_t1`                                                             | `futures_bars` (ES) + `market_snapshots` (spx_open) |
| `nq_momentum_t1`, `nq_es_ratio_t1`, `nq_es_ratio_change`                      | `futures_bars` (NQ, ES)                             |
| `nq_qqq_divergence_t1`                                                        | `futures_bars` (NQ) + `flow_data` (QQQ NCP)         |
| `vx_front_price`, `vx_term_spread`, `vx_term_slope_pct`, `vx_contango_signal` | `futures_bars` (VX1, VX2)                           |
| `vx_basis`                                                                    | `futures_bars` (VX1) + `market_snapshots` (VIX)     |
| `zn_momentum_t1`, `zn_daily_change`                                           | `futures_bars` (ZN)                                 |
| `spx_zn_correlation_5d`                                                       | `futures_bars` (ZN) + `outcomes` (settlement)       |
| `rty_momentum_t1`, `rty_es_divergence_t1`                                     | `futures_bars` (RTY, ES)                            |
| `cl_overnight_change_pct`, `cl_intraday_momentum_t1`                          | `futures_bars` (CL)                                 |
| `cl_es_correlation_5d`                                                        | `futures_bars` (CL) + `outcomes` (settlement)       |
| `gc_overnight_change_pct`, `gc_intraday_momentum_t1`                          | `futures_bars` (GC)                                 |
| `gc_es_inverse_5d`                                                            | `futures_bars` (GC) + `outcomes` (settlement)       |
| `gc_safe_haven_signal`, `gc_zn_agreement_t1`                                  | Derived from GC/ES/ZN momentum (above)              |
| `dx_overnight_change_pct`, `dx_intraday_momentum_t1`                          | `futures_bars` (DX)                                 |
| `dx_es_inverse_5d`                                                            | `futures_bars` (DX) + `outcomes` (settlement)       |
| `dx_strength_headwind`                                                        | Derived from DX/ES momentum (above)                 |
| All 6 multi-timeframe features                                                | `futures_bars` (ES, NQ)                             |
| All 5 regime features                                                         | Derived from per-instrument features (above)        |

**Total: 44 features computable from backfilled data.**

### Features Requiring `futures_options_daily` (EOD Statistics)

| Feature                    | Data Source                                               |
| -------------------------- | --------------------------------------------------------- |
| `es_put_oi_concentration`  | `futures_options_daily` (OI)                              |
| `es_call_oi_concentration` | `futures_options_daily` (OI)                              |
| `es_options_max_pain_dist` | `futures_options_daily` (OI at all strikes)               |
| `es_spx_gamma_agreement`   | `futures_options_daily` (OI) + `greek_exposure` snapshots |
| `es_options_net_delta`     | `futures_options_daily` (delta, OI)                       |
| `es_atm_iv`                | `futures_options_daily` (implied_vol)                     |

**Total: 6 features.** Statistics schema is L0 (15+ years of history), so these can be backfilled. The `fetch-es-options-eod.ts` cron (Phase 10 in parent spec) must be running for live dates.

### Features Requiring `futures_options_trades` (Tick Data)

| Feature                     | Data Source                           |
| --------------------------- | ------------------------------------- |
| `es_put_buy_aggressor_pct`  | `futures_options_trades` (side, size) |
| `es_call_buy_aggressor_pct` | `futures_options_trades` (side, size) |

**Total: 2 features.** These require L1 Trades data (12-month max history). These are the most storage-intensive features. Can be deferred -- the remaining 50 features work without them.

### Features Requiring Live Sidecar

All features can be computed from backfilled data. The sidecar is required only for:

- Populating `futures_bars` for **today's** date (live streaming)
- Populating `futures_options_trades` for today (live ES options trades)

For historical dates, all data comes from the one-time backfill script (`scripts/backfill-futures.ts`).

### VX Data Availability

VX (VIX futures) data was added to the sidecar subscription after ES/NQ/ZN/RTY/CL. The Databento historical backfill covers VX (it trades on XCBF.PITCH, which is included in the subscription), so all historical VX features can be computed.

For the gap period between initial sidecar launch and VX addition:

- If backfill is complete (covers the full year), there is no gap -- historical data covers everything.
- If there is any period where `futures_bars` has no VX1/VX2 rows, all 5 VX features + `vx_basis` are null.
- `regime_vol_regime` falls back to using `market_snapshots.vix` (spot VIX) when VX futures data is missing.
- `regime_risk_score` redistributes the VX weight (0.15) to other instruments when `vx_contango_signal` is null.

### GC and DX Data Availability

Both GC (COMEX) and DX (ICE) are included in the Databento subscription and have 15+ years of L0 history. The backfill script should include both symbols. The main concern is DX requiring a separate Databento client for `IFUS.IMPACT` -- if this client fails during live streaming, DX features are null but all CME features (including GC) remain healthy.

---

## 9. Total Feature Count

### By Group

| Group               | Count  | Features                                                                                                                                                                                                  |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ES Futures          | 8      | `es_momentum_t1`, `es_momentum_t2`, `es_spx_basis_t1`, `es_volume_ratio_t1`, `es_overnight_range`, `es_overnight_gap`, `es_gap_fill_pct_t1`, `es_vwap_deviation_t1`                                       |
| NQ Futures          | 4      | `nq_momentum_t1`, `nq_es_ratio_t1`, `nq_es_ratio_change`, `nq_qqq_divergence_t1`                                                                                                                          |
| VX Futures          | 5      | `vx_front_price`, `vx_term_spread`, `vx_term_slope_pct`, `vx_contango_signal`, `vx_basis`                                                                                                                 |
| ZN Futures          | 3      | `zn_momentum_t1`, `zn_daily_change`, `spx_zn_correlation_5d`                                                                                                                                              |
| RTY Futures         | 2      | `rty_momentum_t1`, `rty_es_divergence_t1`                                                                                                                                                                 |
| CL Futures          | 3      | `cl_overnight_change_pct`, `cl_intraday_momentum_t1`, `cl_es_correlation_5d`                                                                                                                              |
| **GC Futures**      | **5**  | `gc_overnight_change_pct`, `gc_intraday_momentum_t1`, `gc_es_inverse_5d`, `gc_safe_haven_signal`, `gc_zn_agreement_t1`                                                                                    |
| **DX Futures**      | **4**  | `dx_overnight_change_pct`, `dx_intraday_momentum_t1`, `dx_es_inverse_5d`, `dx_strength_headwind`                                                                                                          |
| **Multi-Timeframe** | **6**  | `es_momentum_15m_t1`, `es_momentum_30m_t1`, `es_momentum_2h_t1`, `nq_momentum_30m_t1`, `es_momentum_accel_t1`, `es_rth_vwap_dist_t1`                                                                      |
| ES Options          | 8      | `es_put_oi_concentration`, `es_call_oi_concentration`, `es_options_max_pain_dist`, `es_spx_gamma_agreement`, `es_put_buy_aggressor_pct`, `es_call_buy_aggressor_pct`, `es_options_net_delta`, `es_atm_iv` |
| **Regime**          | **5**  | `regime_risk_score`, `regime_flight_to_safety`, `regime_macro_stress`, `regime_breadth_quality`, `regime_vol_regime`                                                                                      |
|                     |        |                                                                                                                                                                                                           |
| **TOTAL**           | **53** |                                                                                                                                                                                                           |

### By Data Dependency

| Dependency                              | Count                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `futures_bars` only (+ existing tables) | 44                                                                           |
| `futures_options_daily` required        | 6                                                                            |
| `futures_options_trades` required       | 2                                                                            |
| Derived (no additional data)            | 1 (regime features computed from other features, counted individually above) |
| **Total unique features**               | **53**                                                                       |

### By Implementation Priority

| Priority              | Count | Rationale                                                                                    |
| --------------------- | ----- | -------------------------------------------------------------------------------------------- |
| P0 (implement first)  | 25    | ES (8) + NQ (4) + VX (5) + ZN (3) + RTY (2) + CL (3). Original plan, highest signal density. |
| P1 (implement second) | 15    | GC (5) + DX (4) + Multi-TF (6). New features, moderate complexity.                           |
| P2 (implement third)  | 11    | Regime (5) + ES Options basic (6). Depend on P0/P1 features or `futures_options_daily`.      |
| P3 (implement last)   | 2     | ES Options aggressor (2). Depend on `futures_options_trades` tick data.                      |

---

## 10. Claude Analysis Context Updates

When GC and DX features are live, the `futures-context.ts` formatter should be updated to include sections for both instruments. Currently it formats ES, NQ, VX, ZN, RTY, CL. Add:

```
Gold (/GC):
  Current: 2,350.40 | 1H: +0.52% | Day: +1.15%
  GC-ES Correlation (5d): -0.45 (inversely correlated — safe haven active)
  Signal: Gold strength + equity weakness = risk-off macro backdrop

US Dollar (/DX):
  Current: 104.25 | 1H: +0.35% | Day: +0.62%
  DX-ES Correlation (5d): -0.38 (normal inverse)
  Signal: Dollar strength = equity headwind. Watch for SPX resistance.
```

The `futures_context_rules` in the system prompt (already defined in the parent spec) should be extended with GC and DX rules:

```
GC Gold:
- GC rising while ES falling = classic flight to safety. Institutional capital
  moving to hard assets. TRENDING day likely — treat like ZN flight signal.
- GC rising with ES rising = reflation/inflation trade. Not a fear signal.
  Standard rules apply.
- GC falling while ES falling = deflation/liquidity crisis. More likely to
  reverse — watch for snapback.
- GC-ZN agreement (both rising) = strong institutional risk-off conviction.
  Higher confidence than either signal alone.

DX US Dollar Index:
- DX rising >0.3% intraday = equity headwind. Strong dollar compresses
  multinational earnings and EM flows. Reduce confidence on bullish SPX
  positions by one tier.
- DX falling while ES rising = goldilocks scenario. Weak dollar supports
  equity multiples. Favorable for credit spreads and bullish structures.
- DX spike >0.5% in 30 min = macro event (FOMC, employment data, tariff news).
  Treat as high-uncertainty until the move stabilizes.
```

---

## 11. Futures Feature Backfill Timing

The parent spec's build phases place ML features in Phase 7, depending on Phase 3 (historical backfill). The implementation order within Phase 7:

1. **DB migration** -- Add all 53 columns to `training_features` in a single migration
2. **Python-side** -- Update `ml/src/utils.py` with new feature groups (no functional change, just definitions)
3. **TypeScript implementation** -- Create `build-features-futures.ts` with P0 features (25 features)
4. **Wire up** -- Uncomment `await engineerFuturesFeatures(sql, dateStr, features)` in `build-features.ts`
5. **Backfill run** -- Trigger the build-features cron for all historical dates to populate the 25 P0 features
6. **Verify** -- Check feature completeness and null rates across historical dates
7. **P1 features** -- Add GC, DX, multi-TF features (15 more)
8. **P2 features** -- Add regime + ES options basic features (11 more)
9. **P3 features** -- Add aggressor features when `futures_options_trades` is populated (2 more)

Each step should be verifiable independently. After step 5, the ML pipeline can start training with futures features even before GC/DX/regime features are implemented.
