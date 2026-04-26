# PAC Event Classifier — Phase 2 Results

**Date:** 2026-04-25
**Predecessor:** `pac-event-classifier-2026-04-24.md` (the original plan).
**Code:** `ml/scripts/build_pac_classifier_dataset.py` + `ml/scripts/train_pac_classifier.py`.
**Run output:** `ml/experiments/pac_classifier/run_5m_NQ.json`.

## Verdict: NULL — gates not cleared

Edge bar (from the original plan):

> Model A AUC > 0.55 AND Expected R/trade > 0.10 in every walk-forward window

**Both windows failed both gates.**

| Window                          | AUC (Model A) | Expected R @ p0.50 | Verdict                                |
| ------------------------------- | ------------- | ------------------ | -------------------------------------- |
| W1 (train=2022, test=2023)      | **0.501**     | **−0.030**         | FAIL                                   |
| W2 (train=2022+2023, test=2024) | **0.509**     | **+0.090**         | FAIL (AUC; Expected R just below 0.10) |

## Sample sizes

5,819 events across 3 years (NQ 5m, all event types: BOS + CHOCH + CHOCHPLUS).
~95% resolved, ~5% timeout. No data scarcity.

| Year | Events | Resolved | Timeout   |
| ---- | ------ | -------- | --------- |
| 2022 | 1,978  | 1,901    | 77 (3.9%) |
| 2023 | 1,896  | 1,811    | 85 (4.5%) |
| 2024 | 1,945  | 1,848    | 97 (5.0%) |

## Model A — binary target/stop classifier

XGBoost (n=300, depth=4, lr=0.05, min_child_weight=5, subsample=0.8). Default seed 42.

- **W1: AUC = 0.501** — within noise band of random for n_test=1,811.
- **W2: AUC = 0.509** — same.

Threshold sweeps tell the same story:

| Window | Threshold | Expected R/trade | Take rate | Notes                |
| ------ | --------- | ---------------- | --------- | -------------------- |
| W1     | p ≥ 0.50  | −0.030           | 29%       | losing pocket        |
| W1     | p ≥ 0.55  | −0.009           | 19%       | flat                 |
| W1     | p ≥ 0.60  | −0.026           | 12%       | losing               |
| W2     | p ≥ 0.50  | +0.090           | 12%       | just below gate      |
| W2     | p ≥ 0.55  | **+0.203**       | 6%        | **n≈117 — unstable** |
| W2     | p ≥ 0.60  | −0.141           | 2.4%      | collapses            |

W2's **p≥0.55** pocket looks tempting (+0.20R on 6% of events) but the sample is ~117 trades and tightening to p≥0.60 flips the sign. Not a stable edge — looks like noise that happened to align with the top decile in 2024.

## Model B — signed forward-return regressor

Both windows produced **negative R²** (worse than predicting the mean) and Spearman correlations indistinguishable from zero (W1: −0.006, W2: +0.027). The 30-min forward dollar return at the event timestamp is **not predictable** from the engine + rolling features.

## Feature importance (Model A, W2)

Top 8 features all sit between 0.050 and 0.054 — a uniform distribution that is the textbook fingerprint of "no feature carries signal":

```
session_bucket    0.0544
ret_5b            0.0533
ret_60b           0.0517
bos_density_60b   0.0514
rv_30b            0.0510
z_close_vwap      0.0510
di_plus_14        0.0510
adx_14            0.0500
```

Compare: a real-edge model would show one or two features dominating at 0.15+ and a long tail at <0.02.

## What this means

Combined with the Phase 3 winner inspection results (config-search PAC sweeps showed marginal 5m_2022 edge but failed OOS on 2024 configs), this confirms: **there is no broad PAC edge on NQ 5m that an event-level classifier can capture against fixed +1.5R/-1R targets over 2022–2024.**

The prior findings:

- 1m: definitively null in CPCV (`pac-v3-residual-fix-results-2026-04-24.md`)
- 5m: mixed regime-conditional, doesn't transfer (`pac-phase3-winner-inspection-2026-04-25.md`)
- Event classifier: null on both labels, no feature carries signal

…are consistent. PAC structure events on NQ futures, with these features and these horizons, are at-or-near efficient.

## What we did NOT test (out of scope here)

1. **Different stop/target multiples.** The +1.5R/-1R bracket was fixed; classifier might find edge with asymmetric bracket (e.g., +2R/-1R or +1R/-0.5R).
2. **Cross-asset features.** Phase 1b was ripped out (`ea2fc70`) per the user's decision to skip paid data subs. Untested whether SPY/QQQ/VIX context would have surfaced the regime conditioning Phase 3 hinted at.
3. **Different event types in isolation.** Currently treats BOS/CHOCH/CHOCHPLUS as features the model can split on, but we didn't train per-type models. Possible (but unlikely) one type carries edge while another dilutes it.
4. **SPX / SPY events instead of NQ.** Mechanically these are different markets; the user's main trading product is SPX 0DTE. NQ futures was used because the local archive has it; SPX index has no futures, ES would be the equivalent. Untested.

## Recommendation

Don't keep tuning the PAC classifier on this configuration. The signal isn't there. Three more-promising directions to consider:

1. **Try SPX / ES 5m** — same engine + features, different market. Cheap to run, just point the builder at `--symbol ES`.
2. **Asymmetric brackets** — +1R/-0.5R is the standard 0DTE setup. Re-build with different `stop_atr_mult` / `target_r_mult` defaults and re-run.
3. **Pivot away from PAC structure events entirely** — the IV-anomaly detector work in `ml/findings/iv-anomaly-*` has been more productive lately; doubling down there may have higher ROI than continuing to interrogate PAC.

Phase 3 (SHAP analysis) is **not worth running** on a null model — SHAP would just confirm the uniform feature importances we already observed. Skip Phase 3, escalate to a strategy-level decision.
