# Ichimoku Strategy Sweep — Three Native Exits Tested

**Date:** 2026-04-25
**Predecessor:** `ichimoku-classifier-2026-04-25.md` (Ichimoku with PAC-style ±1.5R bracket — null).
**Code:** `ml/src/ichimoku_classifier/{labels,dataset}.py`, `ml/scripts/build_ichimoku_classifier_dataset.py` (`--strategy` flag), 23-test `ml/tests/test_ichimoku_labels.py`.
**Run outputs:** `ml/experiments/ichimoku_classifier/run_{kijun_stop_2r,cloud_stop_2r,tk_reversal_exit}_5m.json`.

## Why this run exists

The earlier Ichimoku null was potentially a false negative — we tested Ichimoku entries with PAC-style fixed ±1.5R brackets, which is **not** how Ichimoku is traditionally traded. This sweep tests **three traditional Ichimoku exit strategies**, agnostic of PAC settings:

- **Strategy A — Kijun stop + 2R target.** Stop at the Kijun line (most universal Ichimoku stop). Target at 2× stop_distance.
- **Strategy B — Cloud stop + 2R target.** Stop at the far cloud edge (cloud_bottom for long, cloud_top for short). Target at 2× stop_distance.
- **Strategy C — Kijun stop + TK-reversal exit.** Stop at Kijun, no fixed target. Exit on opposite TK cross or close re-crossing Kijun. Trend-following exit logic.

All three use the same `IchimokuEngine.batch_state` events (TK cross + cloud break + strong confluence) and the same trainer (`train_pac_classifier.py` — signal-agnostic). All three skip events where the Ichimoku stop level is on the wrong side of entry (e.g. long with Kijun above entry — trading against the dominant Ichimoku trend), matching traditional discretionary usage.

## Verdict by strategy

Edge bar: AUC > 0.55 AND Expected R/trade > 0.10 in EVERY walk-forward window.

| Strategy | W1 AUC | W2 AUC | W1 ER@p0.50 | W2 ER@p0.50 | Joint gate |
|---|---|---|---|---|---|
| A — Kijun + 2R | 0.506 | 0.501 | −0.043 | +0.162 (n=48) | **FAIL** |
| B — Cloud + 2R | **0.495** | **0.484** | −0.049 | −0.406 | **FAIL** (worse than random) |
| C — Kijun + TK reversal | **0.582** | **0.583** | −0.123 | −0.013 | **FAIL** (AUC passes, ER fails) |

## Strategy A — Kijun stop + 2R target

Same null pattern as before. AUC at noise. W2 has a tiny pocket of profitable high-confidence trades (n=48 at p≥0.50 with ER=+0.162) but n=12 at p≥0.60 flips to −0.182 — classic noise-pocket-instability. Skip rate: ~20% (events filtered out because Kijun was on the wrong side of entry).

## Strategy B — Cloud stop + 2R target — **inverted predictions!**

**Both windows have AUC < 0.50.** The model is learning a SLIGHTLY anti-correlated relationship between features and outcomes. This isn't random noise; it's mild systematic miscalibration. Possible reasons:

1. Cloud stops are **far** from entry (the cloud is often a few ATR away from price), so trades labeled "win" by the 2R target hit are dominated by very long trends — and the rolling features (ret_5b, ret_60b, etc.) pointing in the trend direction at entry might actually correlate with **mean reversion** afterward.
2. The cloud-stop filter selects a different event distribution (only events where cloud bottom < entry for longs — i.e., entries already above cloud) — and those events may have systematically different forward dynamics.

Either way: Strategy B is **worse than random**, which is itself a finding. If you saw a 0.484 AUC on a fresh model, you'd want to dig in — but here the magnitude is small (1.5pp below random) and we already know what to do (skip this strategy).

## Strategy C — Kijun stop + TK reversal exit — **AUC > 0.55 in both windows!**

This is the **first signal extractor across all our experiments (PAC v3, Ichimoku 5m, Ichimoku 1m, all three Ichimoku strategies) that has produced AUC above the 0.55 gate in both walk-forward windows.** That's notable enough to deserve careful interpretation.

### Why does AUC pop here?

Strategy C's labeling differs from A and B in a fundamental way: there's no fixed target. Trades exit on **either** stop (price touches Kijun) **or** a reversal signal (opposite TK cross / Kijun recross). The win/loss asymmetry is also different:

- **Stop hit** → realized_R = −1.0 (always full loss)
- **Reversal exit** → realized_R = (exit_close - entry) / stop_distance (continuous; can be tiny + or − or large in either direction)

This means **label_a=1 just means "exited with positive realized_R"** — could be +0.05R, could be +3R. So the model is learning to predict directional momentum at event time, not big profitable trades.

That's a **much weaker labeling task** than "predict whether 2R target hits before 1R stop", which is why AUC pops higher. The model is finding genuine directional signal, but the signal isn't strong enough to overcome the asymmetry between many small wins and occasional big losses.

### Why does Expected R fail anyway?

Look at W2:

| Threshold | n | ER |
|---|---|---|
| p ≥ 0.50 | 47 | −0.013 |
| p ≥ 0.55 | 19 | −0.123 |
| p ≥ 0.60 | 6 | −0.674 |

The high-confidence trades **lose money** even though the AUC is 0.583. Tells the same story: model ranking is correct on average (AUC > 0.55) but the highest-confidence pocket happens to land in noisy regions where realized_R is dominated by occasional large losses. This is **AUC-vs-ER disconnect** — a known pathology in classifier-driven trading where ranking ability doesn't translate to profitability.

### Top features (Strategy C, W2)

```
z_close_vwap              0.1055
minutes_from_rth_open     0.0921
rv_30b                    0.0798
```

Note: this is the **first time** any feature has cleared 0.10 importance in any of our experiments. That's a non-uniform fingerprint — `z_close_vwap` (price relative to session VWAP) carries 32% more signal than the next feature down. Combined with the AUC pop, that's actual signal — just not enough signal in the tradable direction.

## What this all means

Two precise updates to the prior null narrative:

1. **The Ichimoku null was sensitive to the exit logic.** Tested three native-exit strategies; one of them (TK reversal) has measurable AUC signal that PAC-style fixed brackets did NOT capture. The earlier `ichimoku-classifier-2026-04-25.md` verdict was technically correct ("PAC-style brackets give Ichimoku no edge") but overconfident as a generalization to all Ichimoku usage.

2. **Even with proper exits, Ichimoku doesn't clear the joint gate.** AUC > 0.55 alone is academic; if the high-confidence pocket loses money, it doesn't matter for trading. Strategy C's actual P&L expectation across the test years is mildly negative.

The AUC pop in Strategy C suggests there IS some real signal in price-action features at event time — but it's too weak / too noisy to overcome the win/loss asymmetry. To make Strategy C tradable, you'd need either:

- Asymmetric position sizing (size up on high-confidence, size down on marginal) — but XGBoost confidence doesn't directly map to expected R.
- A second filter on top of Model A (e.g. "only take trades when VIX is rising" or "only after 11 AM" — try to find the regime where the AUC translates to ER).
- More features, especially **non-price** features (UW flow, dark prints, GEX) — same conclusion as PAC's findings doc.

## Methodology notes

- All four runs used `seed=42` for reproducibility.
- Skip-on-wrong-side semantics: events where the Ichimoku stop is on the wrong side of entry (~17–20% of events) emit `no_data` rather than the trade. This matches traditional Ichimoku discretionary usage — you don't take longs against bearish Ichimoku.
- 23 unit tests for the labeler covering all three strategies' stop/target/exit mechanics + edge cases (NaN Kijun, no cloud data, event at last bar, stop-priority on tied bars).
- Strategy C uses 96-bar timeout (8 hours on 5m) instead of 48 to give trends room to play out before forced exit.

## Recommendation

Stop testing Ichimoku variants. The pattern across PAC + 3 Ichimoku strategies is consistent: **single-symbol price-action features on NQ 5m don't generalize into a tradable edge**, with one strategy now having weak but measurable AUC signal that doesn't translate to Expected R.

The next test that would be informative is **adding non-price features to the existing trainer** — UW flow flags, dark-print proximity, GEX position. The IV-anomaly work has already shown those data sources carry cross-asset signal in your data; bolting them onto the PAC or Ichimoku event datasets is the **conditional-edge** test we've been circling for the last few experiments.

Concretely:

1. Take the Ichimoku Strategy C dataset (the highest-AUC one).
2. Attach UW flow flags from `api/iv-anomalies.ts` data at each event_ts.
3. Re-train with the trainer.
4. If Strategy C AUC > 0.58 unconditionally and AUC > 0.65 on the flow-confirmed subset, that's actionable.

If THAT comes up null, the price-action-on-NQ-futures hypothesis is exhausted. Pivot fully to IV-anomaly work.
