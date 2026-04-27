# Ichimoku Strategy C — Variant Sweep to Push Profitability

**Date:** 2026-04-25
**Predecessor:** `ichimoku-strategies-2026-04-25.md` (Strategy C: AUC > 0.55 in both windows but Expected R fails).
**Code:** `ml/src/ichimoku_classifier/labels.py` extended with `use_trailing_stop` + `win_threshold_r` knobs; 6 new tests.
**Run outputs:** `ml/experiments/ichimoku_classifier/run_tk_rev_{trailing,thresh_05,combined}_5m.json`.

## Why this run exists

Strategy C had a known pathology: AUC > 0.55 (genuine ranking signal) but Expected R/trade < 0.10 (high-confidence trades lose money in W2). Two natural levers to fix the win/loss asymmetry:

1. **Trailing Kijun stop** — let winners run by ratcheting stop with the Kijun line in the trade's favor only.
2. **Higher win threshold** — relabel "win" as `realized_R > +0.5R` (not just `> 0`). Force the model to predict big winners.

This sweep tests each lever individually + combined.

## Results

| Variant                   | Description                          | W1 AUC    | W2 AUC    | W1 ER @p0.50  | W2 ER @p0.50     | Joint gate                                |
| ------------------------- | ------------------------------------ | --------- | --------- | ------------- | ---------------- | ----------------------------------------- |
| Baseline C                | Static stop, threshold=0             | 0.582     | 0.583     | −0.12 (n=129) | −0.01 (n=47)     | AUC ✓, ER ✗                               |
| **Variant 1: Trailing**   | **Trailing Kijun stop, threshold=0** | **0.560** | **0.567** | −0.09 (n=107) | **+0.31 (n=40)** | **AUC ✓ ✓, W2 ER ✓**                      |
| Variant 2: Threshold 0.5R | Static stop, threshold=0.5           | 0.544     | 0.536     | +1.56 (n=52)  | +1.11 (n=11)     | AUC borderline, ER huge but small samples |
| Variant 3: Combined       | Trailing + threshold=0.5             | 0.517     | 0.532     | +0.09 (n=20)  | +3.05 (n=5)      | AUC tanks, samples too small              |

## Variant 1 — Trailing Kijun stop is the winner

**This is the first time across PAC + 6 Ichimoku strategies that any signal extractor has shown both AUC > 0.55 and Expected R > 0.10 simultaneously in a walk-forward window.** Specifically W2 (train=2022+2023, test=2024): AUC=0.567 + ER@p0.50=+0.31 on n=40 trades.

W1 still has marginally negative ER at p0.50 (−0.09 vs baseline's −0.12), so this isn't a clean pass on the joint gate across BOTH windows. But the W2 result is the most credible non-null we've seen:

- **n=40 trades** is enough sample to be more than just noise (vs Variant 2's n=11 in W2)
- **+0.31R per trade** is meaningfully tradable
- **AUC > 0.55 in both windows** confirms ranking quality
- **Top feature consistent across windows:** `z_close_vwap` (0.092 W1 / 0.101 W2)

### Why does trailing help?

Same dataset, same events, same exit triggers — the only difference is stop placement. The trailing stop converts **two distinct things**:

1. Some "stop hits" that would have been −1R losses now exit at the trailed stop level, locking in partial profit → the loss magnitude is smaller.
2. Some trades that would have stopped out and then recovered now ride further in the favorable direction before reversing.

Net effect: the **distribution of realized_R** shifts right. Bigger wins, smaller losses, fewer −1R full stops. Average per-trade outcome improves.

### Why does AUC DROP slightly with trailing?

AUC went from 0.58 → 0.56. The labels changed: under baseline C, "stop hit" was always label_a=0 (always −1R). Under trailing, some stop hits are label_a=1 (profitable trailing-stop exits). That makes the binary classification task **harder** — the model can't just learn "predict the stop-hit-likely events as losses" because some of them are wins now.

A classic case: AUC isn't the right metric for trading. Expected R captures actual profitability; AUC captures the model's ability to rank the binary outcome. **The right metric for "should I take this trade?" is Expected R, and trailing improved it.**

## Variant 2 — Threshold 0.5R: ER pops, samples too small

Variant 2 has dramatic Expected R numbers (+1.56 W1, +1.11 W2 at p≥0.50) but AUC dropped to 0.54 / 0.54 — just below the 0.55 gate. And the take rate at p≥0.50 in W2 is **0.16%** (n=11 trades for the year). At p≥0.55, n=1; at p≥0.60, n=0.

Interpretation: raising the win threshold to +0.5R reclassified ~half of "wins" as "losses" (most reversal exits land between 0 and 0.5R). The base rate of `label_a=1` dropped, so the model's confidence calibration shifted — only a tiny tail of events get P>0.5. Those events ARE big winners, but the sample is too small for the result to be reliable.

If trade frequency mattered less to you (e.g., you're OK with 11 trades/year), this could be tradable. But you can't statistically distinguish +1R/trade real-edge from +1R/trade luck on n=11.

## Variant 3 — Combined: most trade-friendly numbers, most degenerate samples

Variant 3 (trailing + threshold 0.5) has **+3.05R per trade in W2** but on **n=5 trades for the year**. That's 5 data points. Could be real, could be luck — impossible to tell. Definitely not basable.

## What changes from this experiment

The Strategy C variants confirm one thing clearly: **trailing stops are the right exit logic for Ichimoku.** Even on baseline labels (no threshold), trailing flipped W2 from −0.01R to +0.31R. The static-stop baseline was leaving money on the table.

The win-threshold variants are interesting but degenerate to small-sample regimes that can't be evaluated robustly. Skipping for now.

## Practical takeaway

If you wanted to actually trade Ichimoku Strategy C with trailing stops on NQ 5m, what would Year 3 (2024) look like at the model's p≥0.50 threshold?

- **40 trades for the year** (~3.3/month)
- **Expected R ≈ +0.31 per trade** → annual edge ≈ +12.4R
- Bet sizing at $50/R (small) → annual ~$620 / contract
- Bet sizing at $500/R → annual ~$6,200 / contract

W1 (test=2023) has marginally negative ER at p≥0.50, so the consistency across years isn't perfect. But the combination of "AUC > 0.55 in both windows + W2 ER > 0.10 with n=40" is the closest we've come to a tradable signal across all our PAC + Ichimoku experiments.

## Caveats — be honest

1. **This is one walk-forward window passing.** W1 (test=2023) had ER=−0.09 at p≥0.50. Edge is not consistent across both years; only W2 cleared. A true joint gate would require BOTH windows to pass simultaneously — Variant 1 doesn't.
2. **n=40 in W2 is enough to be meaningful but not enough to be conclusive.** Standard error on Expected R with n=40 and assumed σ≈1 is ~0.16, so +0.31 ± 0.32 covers everything from −0.01 to +0.63. Not a confident result.
3. **Slippage/commissions ignored.** Real NQ trading at 1-tick slippage = 0.25 points; with stop_distance ≈ 25 points, that's a ~1% drag per trade. Not enough to flip the sign but worth modeling.
4. **No higher-timeframe context.** This is still single-symbol, single-timeframe. Real Ichimoku trades use HTF bias — adding `daily_kijun_position` or `4h_cloud_color` features could push the result further.

## Recommendation

**Variant 1 (trailing Kijun stop) is the right baseline to extend.** Two productive next steps:

1. **Conditional edge with non-price features.** Take the Variant 1 dataset, attach UW flow flags / dark-print proximity / GEX position at each event_ts (the IV-anomaly features that have shown signal in your data). Re-train. If Variant 1 + flow features clears the joint gate in BOTH windows, that's actionable.

2. **Multi-timeframe context.** Add HTF Ichimoku state — daily Kijun/cloud color/distance from cloud at the event ts. Costs more code but tests the "Ichimoku is multi-timeframe" hypothesis directly.

Either is a reasonable afternoon's work. My read: option 1 first, because the IV-anomaly features have already been shown to carry edge independently — combining a near-passing price-action signal with an independent edge source is the most likely path to a clean joint-gate pass.

If neither path moves the needle, the price-action-on-NQ-5m hypothesis is exhausted and pivoting to the IV-anomaly work makes sense.

---

## Update — 1m timeframe disconfirms W2 pop

After the initial 5m run, we re-ran Variant 1 on **1m** with the same trailing-stop logic. The 1m archive has ~5× more events than 5m for the same calendar window, so it provides a much tighter statistical test of whether the W2 5m ER=+0.31 was real signal or noise.

### Results

| Timeframe | Window | AUC       | ER @p0.50 | n trades | ER @p0.60 (n) |
| --------- | ------ | --------- | --------- | -------- | ------------- |
| **5m**    | W1     | 0.560     | −0.09     | 107      | +0.65 (n=10)  |
| **5m**    | W2     | 0.567     | **+0.31** | 40       | −0.73 (n=3)   |
| **1m**    | W1     | 0.552     | **−0.08** | 243      | −0.33 (n=40)  |
| **1m**    | W2     | **0.577** | **−0.07** | 26       | +0.10 (n=4)   |

### Verdict — 5m W2 was noise

With 5× more events, the trailing variant on 1m has:

- **Same AUC pop** (0.55–0.58) → ranking signal IS real and timeframe-stable.
- **Expected R is negative or near-zero** in both 1m windows at p≥0.50, including W1 with n=243 (a sample size where ±0.10 around zero is well within the SE band).
- **`z_close_vwap` importance jumped from 0.10 → 0.16** on 1m → less uniform feature distribution, model finds signal more confidently when it has more data, but the signal still doesn't translate to profitable trade selection.

The 5m W2 ER=+0.31 on n=40 sat within ±0.32 of zero (the SE band noted above as a caveat). The 1m run with much tighter CIs disconfirms it. **This is exactly the noise outcome the original caveats warned about.**

### Honest interpretation

The trailing-stop trick **does** convert −1R full stops into smaller losses or partial-profit exits, and it **does** preserve the AUC > 0.55 ranking signal. But the AUC signal isn't strong enough to overcome the win/loss-magnitude asymmetry that breaks confidence-based trade selection. In other words, the model can rank events better than random, but the rank doesn't predict whether the eventual exit will be a tradable winner.

This corroborates the diagnosis from the original Strategy C findings: the AUC-vs-ER disconnect is a real pathology of this labeling regime, not a noise artifact. Adding the trailing stop didn't fix the asymmetry; it just shifted some losses smaller without enabling the model to systematically pick the bigger winners.

### Updated recommendation

The two paths in the recommendation above (conditional non-price features, HTF context) are still the right next moves IF you want to keep pushing on price-action edge. But the 1m disconfirmation pushes my read meaningfully toward **option 3: pivot to IV-anomaly work**.

Reasoning:

- Three signal extractors (PAC v3, Ichimoku 5m, Ichimoku 1m) and four exit regimes (PAC bracket, Ichimoku Kijun-stop+2R, cloud-stop+2R, TK-reversal, trailing) have all produced AUC at or near random AND/OR Expected R that doesn't survive timeframe scaling.
- The IV-anomaly stack already has cross-asset findings showing actual signal (`ml/findings/iv-anomaly-*`).
- Continuing to interrogate price-action setups is increasingly low-EV at this point.

If you still want option 1 (Variant 1 + UW flow features), it's a reasonable last test before declaring price-action dead in this stack. But the 1m result should adjust expectations downward — Variant 1 isn't a "near pass" anymore; it's a clean null with consistent AUC signal that doesn't translate.
