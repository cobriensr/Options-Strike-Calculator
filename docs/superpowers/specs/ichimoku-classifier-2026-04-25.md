# Ichimoku Event Classifier — Results

**Date:** 2026-04-25
**Predecessor:** `pac-classifier-phase2-results-2026-04-25.md` (PAC null result).
**Code:** `ml/src/ichimoku/engine.py`, `ml/scripts/build_ichimoku_classifier_dataset.py`. Trainer reused unchanged from `ml/scripts/train_pac_classifier.py` (signal-agnostic schema).
**Run outputs:** `ml/experiments/ichimoku_classifier/run_5m_NQ.json`, `run_1m_NQ.json`.

## Why we ran this

After PAC came up null on NQ 5m, the question was: **is the null a PAC problem or a "popular indicator on liquid futures" problem?** Ichimoku is a different signal mechanic (trend + cloud, not structure events) and is mechanically much easier to test (deterministic, parametric). If Ichimoku also nulled, that's evidence the issue is the **test surface**, not the indicator choice.

## Verdict: NULL on both timeframes

Same gates as PAC (AUC > 0.55 AND Expected R/trade > 0.10 in every walk-forward window).

| Timeframe | Window              | n_train | n_test | AUC       | Expected R @ p0.50 | Verdict    |
| --------- | ------------------- | ------- | ------ | --------- | ------------------ | ---------- |
| **5m**    | W1 (2022→2023)      | 6,913   | 7,020  | **0.502** | +0.025             | FAIL       |
| **5m**    | W2 (2022+2023→2024) | 13,933  | 6,945  | **0.511** | +0.001             | FAIL       |
| **1m**    | W1 (2022→2023)      | 33,962  | 34,117 | **0.501** | −0.019             | FAIL       |
| **1m**    | W2 (2022+2023→2024) | 68,079  | 34,892 | **0.512** | +0.115             | FAIL (AUC) |

For comparison, PAC re-run after a small bug fix (see Methodology Note below):

| Timeframe | Window | AUC   | Expected R @ p0.50                           |
| --------- | ------ | ----- | -------------------------------------------- |
| PAC 5m    | W1     | 0.508 | −0.013                                       |
| PAC 5m    | W2     | 0.510 | +0.219 (12.8% take rate; collapses at p0.60) |

**Three independent signal-extractors, same null fingerprint.**

## Sample sizes (Ichimoku fires much more than PAC)

Ichimoku produces **3.5× more events** at 5m and **17× more events** at 1m than PAC, because TK crosses + cloud breaks fire whenever the indicators cross — no swing-confirmation gating like PAC requires.

| Year | Ichimoku 5m | Ichimoku 1m | PAC 5m |
| ---- | ----------- | ----------- | ------ |
| 2022 | 6,913       | 33,962      | 1,978  |
| 2023 | 7,020       | 34,117      | 1,896  |
| 2024 | 6,945       | 34,892      | 1,945  |

So data scarcity is **definitively not** the reason for null. With 100K+ Ichimoku 1m events, any real edge would emerge.

## Threshold sweeps tell the same story

Tempting "high-confidence" pockets appear at p≥0.55 for several configurations, but they're:

1. Small (often <2% take rate, hundreds of trades/year)
2. **Threshold-unstable** — sign flips between p0.55 and p0.60

**Ichimoku 1m W2** at p0.50 shows ER = +0.115 (272 trades). Tightening to p0.55 → +0.271 (61 trades). Tightening further to p0.60 → +0.471 (17 trades). On the surface, "the model gets MORE accurate as confidence rises" — but with 17 trades you can't distinguish that from luck. The same effect appears in pure noise.

The classic confirmation a pocket is **real** is **monotone improvement with thousands of trades** — none of these qualify.

## Feature importance: uniform fingerprint, again

Top 5 features (Ichimoku 5m W2):

```
signal_direction          0.0822
rv_30b                    0.0807
minutes_to_rth_close      0.0792
signal_type               0.0784
ret_240b                  0.0784
```

Top 5 features (Ichimoku 1m W2):

```
signal_direction          0.0845
minutes_from_rth_open     0.0811
rv_30b                    0.0811
minutes_to_rth_close      0.0810
atr_14                    0.0802
```

Same uniform distribution between 0.078–0.085. No feature dominates. **Textbook "no signal" fingerprint** — identical to what PAC showed.

Note: `signal_direction` (long vs short) leads slightly but the spread is only 1pp above the next features. A real-edge model would have ONE feature at 0.15+ and a long tail.

## Methodology note: `__year` leak fix

While interpreting the initial Ichimoku 1m results, `__year` showed up as a top-5 feature with importance 0.073. That's the internal column the trainer uses to track walk-forward windows — it should NOT be passed as a feature. Bug located and patched (`__year` added to `_NON_FEATURE_COLS` in `train_pac_classifier.py`). All four runs above (Ichimoku 5m + 1m, PAC 5m re-run) were re-trained after the fix; verdicts unchanged. PAC 5m W2's Expected R @ p0.50 changed from +0.090 to +0.219 with the fix, but the higher-threshold collapse pattern remained, so still null.

## What this means

The accumulated evidence — **three independent signal extractors (PAC v3, Ichimoku 5m, Ichimoku 1m) on the same test surface, all producing null with the same uniform-importance fingerprint** — strongly suggests that the bottleneck is **NOT** the choice of indicator. It is one or more of:

1. **The test surface itself** (NQ futures, single-symbol, fixed ±1.5R bracket). Liquid futures + a popular indicator family + a symmetric bracket = the obvious dimensions of edge are arbed away.
2. **Lack of higher-timeframe context.** Both PAC and Ichimoku tested at the timeframe alone — no daily/weekly bias features.
3. **Lack of cross-asset context.** SPY/QQQ/VIX features were ripped out (`ea2fc70`).
4. **Lack of order-flow / dark-print / options-positioning features.** None of these popped indicators incorporate them.

Notably, the **IV-anomaly detector work** is the one signal that has shown actual cross-asset confluence findings in your data (`ml/findings/iv-anomaly-*`). That work uses **data sources retail traders generally don't have** — UW options flow, dark prints, Greek exposure, gamma positioning, macro events. That's the asymmetric-information story.

## Recommendation

Stop testing pure-price-action indicators on NQ 1m/5m. The result is going to be the same. The next test that would be informative is **the same trainer + a signal that uses a non-price data source** — e.g., add UW flow flag features to the existing PAC dataset and see if the conditional-on-flow event subset has edge. That tests the right hypothesis: "PAC events conditional on smart-money flow context have edge that PAC events alone don't."

Concretely, three forward-direction options:

1. **PAC + UW flow conditional**. Take the PAC 5m dataset, attach UW unusual-volume + bullish/bearish flow flags at each event ts, retrain. ~30 min work.
2. **Pivot fully to IV-anomaly work**. That's the productive vein.
3. **Stop algorithmic backtesting and accept the IV-anomaly + discretionary-execution model.** Use PAC and Ichimoku visually for confluence with IV anomalies, not as triggers.

My read: **option 1** is worth one more afternoon (the data exists, the harness exists, it's the right next test of the conditional-edge hypothesis). After that, **pivot to option 2 or 3** based on what option 1 shows.
