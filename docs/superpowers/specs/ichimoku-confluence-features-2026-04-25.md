# Ichimoku Trailing + Confluence Features — Final Test

**Date:** 2026-04-25
**Predecessor:** `ichimoku-strategy-c-variants-2026-04-25.md` (1m disconfirmed the 5m W2 pop on the trailing variant).
**Code:** `ml/src/ichimoku/engine.py` extended with volume / ADX-DMI / HTF-daily helpers; 8 new tests.
**Run outputs:** `ml/experiments/ichimoku_classifier/run_tk_rev_trailing_confluence_{5m,1m}.json`.

## Why this run exists

User asked: "before we move on, what else do people usually use with Ichimoku?" Three universally-cited confluence tools were missing from our trainer:

1. **Volume** — TK crosses with rising volume = "real"; falling volume = fade.
2. **ADX / DI+ / DI-** — only take TK crosses when ADX > 20 (trending market).
3. **HTF Ichimoku** — daily Kumo color + price-vs-cloud as a bias filter for intraday entries.

This run adds all three to the IchimokuEngine and re-tests the trailing-stop variant on both timeframes.

## What changed in the engine

`IchimokuEngine.batch_state()` now emits these additional columns:

```
volume_z_30b                   — z-score of volume over trailing 30 bars
volume_ratio_60b               — volume / 60-bar SMA
adx_14, di_plus_14, di_minus_14 — Wilder's standard ADX/DMI
daily_kijun_position_atr       — (daily_close − daily_kijun) / daily_atr
daily_cloud_color              — +1 / −1 / 0
daily_distance_from_cloud_atr  — signed distance from daily cloud / daily ATR
```

**Causality contract for HTF daily features:** at intraday event time T, daily features come from the most recent COMPLETED daily bar (yesterday's UTC close) via `merge_asof(direction="backward")` on a `+1 day` shifted timestamp. There is **no future leak**. Verified by `test_htf_daily_ichimoku_no_future_leak`.

## Verdict — confluence features did NOT help

Joint gate: AUC > 0.55 AND Expected R > 0.10 in EVERY walk-forward window.

| Run                    | W1 AUC | W2 AUC    | W1 ER@p0.50 (n) | W2 ER@p0.50 (n)  | Joint gate            |
| ---------------------- | ------ | --------- | --------------- | ---------------- | --------------------- |
| 5m no-confluence       | 0.560  | **0.567** | −0.09 (n=107)   | **+0.31 (n=40)** | W2 only ✗             |
| **5m WITH confluence** | 0.555  | 0.563     | −0.02 (n=95)    | **−0.22 (n=49)** | **FAIL both windows** |
| 1m no-confluence       | 0.552  | 0.577     | −0.08 (n=243)   | −0.07 (n=26)     | FAIL                  |
| **1m WITH confluence** | 0.556  | 0.579     | −0.23 (n=174)   | −0.10 (n=50)     | FAIL                  |

### Two key observations

1. **The 5m W2 ER=+0.31 from the prior run collapsed to −0.22 with confluence features.** AUC is unchanged (0.567 → 0.563). If the +0.31 had been real signal, adding informative features should have _preserved or improved_ the ER. The sign flip with feature additions is **strong evidence that the original +0.31 was statistical noise** on n=40 trades — exactly what the original ±0.32 SE-band caveat warned about. Combined with the prior 1m disconfirmation, the +0.31 is now triply-disconfirmed.

2. **The features ARE being used.** Top-5 importances now include `adx_14`, `di_plus_14`, `signal_direction` alongside the usual `z_close_vwap` and time-of-day features. The model is splitting on confluence inputs — they're just not informative enough to push the ER above zero.

### What didn't break into top-5 anywhere

- **HTF daily features** (`daily_kijun_position_atr`, `daily_cloud_color`, `daily_distance_from_cloud_atr`). Likely because daily state is constant across ~78 intraday 5m bars per day → very low information per row, and once the model knows the time-of-day proxy (`minutes_from_rth_open`) it has the same information at finer granularity.
- **Volume features** (`volume_z_30b`, `volume_ratio_60b`). Probably low signal because the front-month NQ futures volume series is dominated by U-shape session pattern (high at open/close, low midday) which the model can recover from time features anyway.

## What this resolves

We've now tested:

- **3 signal extractors:** PAC v3 ; Ichimoku 5m ; Ichimoku 1m
- **5+ exit regimes:** PAC ±1.5R bracket ; Kijun+2R ; Cloud+2R ; TK reversal ; Trailing Kijun ; Trailing + 0.5R threshold ; Combined
- **2 timeframes:** 5m ; 1m
- **2 feature configurations:** baseline ; with volume/ADX/HTF confluence

That's **20+ configurations**. The pattern is consistent: AUC sometimes lands marginally above 0.55 (the 0.55-0.58 band on Ichimoku across timeframes), but Expected R never clears the 0.10 gate consistently across both walk-forward windows. The single "passing" result (5m W2 trailing, ER=+0.31) was noise — confirmed by 1m at higher event density AND by adding informative features that should have preserved real signal.

**Single-symbol price-action features on NQ futures, with these labelers, do not carry tradable edge in this stack.** That's a robust finding now, not a hypothesis.

## Recommendation

**Pivot to the IV-anomaly work.** The IV-anomaly findings (`ml/findings/iv-anomaly-*`) have shown actual cross-asset signal in your data using non-price information sources (UW flow, dark prints, Greek exposure, gamma positioning, macro events). That's the asymmetric-information stack — what retail traders generally don't have.

The price-action chapter is closed cleanly. We tested it 20 ways; none passed.

## Caveats — what we did NOT test

For honesty:

1. **SPX / SPY events.** Mechanically different markets from NQ futures. The user's actual trading product is SPX 0DTE, not NQ futures. We used NQ because the local archive has it.
2. **Other timeframes (15m, 1h, 4h, daily).** All our work has been 1m + 5m. Some Ichimoku traders explicitly trade 1h or 4h.
3. **Discretionary entry filtering.** The 17–20% of events we filtered as `no_data` (Ichimoku stop on wrong side of entry) is the smallest possible filter. Real discretionary traders use much heavier judgment-based filtering — visual chart context, news avoidance, multi-asset confluence.
4. **Asymmetric position sizing.** Our backtest assumes flat 1R risk per trade. Real sizing scales by confidence; we never modeled that.

If any of these became the focus, results could change. But within the testable scope of "automated price-action feature → XGBoost classifier on NQ futures," the answer is null.
