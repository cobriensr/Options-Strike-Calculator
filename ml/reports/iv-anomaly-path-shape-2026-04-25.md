# IV-Anomaly Path-Shape (Phase D1) — 2026-04-25
**Sample:** 15,886 alerts, 11,155 with premium trajectory, 6,536 touched ITM.

**Definitions:**

- `mae_to_peak_pct` — worst drawdown from entry on the way to peak (negative is bad)
- `mae_to_close_pct` — worst drawdown from entry holding to last trajectory sample
- `time_in_itm_pct` — % of post-first-ITM minutes where spot was ITM
- `n_itm_re_entries` — count of OTM→ITM transitions after first touch (whip-saw indicator)
- `peak_before_itm` — premium peaked BEFORE strike crossed (pure IV play, not directional)

**Caveat:** premium trajectory truncates when the alert's strike crosses ITM (snapshot table only stores OTM strikes). MAE_to_close is therefore the worst drawdown *on the OTM portion* of the path — does NOT capture post-ITM drawdowns (which exist when an ITM premium retraces and the strike re-OTMs).

## Drawdown before peak — eventual winners vs losers

Reading: a winner with median MAE -40% means the median *eventual winner* went down 40% before bouncing.

| outcome category | n | median MAE | p25 | p75 |
| --- | ---: | ---: | ---: | ---: |
| small_win (0-30%) | 4,152 | -1.1% | -11.9% | +0.0% |
| decent_win (30-100%) | 1,994 | -4.8% | -19.1% | +0.0% |
| big_win (>100%) | 858 | -10.3% | -36.7% | +0.0% |

## Per-ticker × regime × side — path-shape

| ticker | regime | side | n | med MAE→peak | med MAE→close | med peak% | med time in ITM | med re-entries | touched% | peak→ITM% |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IWM | chop | call | 77 | +0.0% | -71.8% | +26.6% | 100% | 0 | 49.4% | 91.7% |
| IWM | chop | put | 201 | -0.3% | -83.4% | +8.7% | 100% | 0 | 37.8% | 41.2% |
| IWM | mild_trend_up | call | 81 | -22.5% | -43.4% | +28.0% | 80% | 1 | 92.6% | 25.7% |
| IWM | mild_trend_up | put | 83 | -1.0% | -55.9% | +0.0% | 35% | 1 | 37.3% | 6.9% |
| META | chop | call | 30 | +0.0% | -94.8% | +3.2% | 40% | 0 | 56.7% | 0.0% |
| META | chop | put | 49 | -4.7% | -17.5% | +65.6% | 100% | 0 | 61.2% | 84.6% |
| META | mild_trend_down | call | 33 | +0.0% | -99.4% | +10.8% | nan% | nan | 0.0% | nan% |
| META | mild_trend_down | put | 23 | -8.7% | -34.4% | +90.8% | 25% | 0 | 60.9% | 92.9% |
| META | mild_trend_up | call | 64 | +0.0% | +0.0% | +0.0% | 100% | 0 | 81.2% | 5.6% |
| META | mild_trend_up | put | 87 | +0.0% | -50.0% | +26.2% | 100% | 0 | 17.2% | nan% |
| MSFT | chop | call | 28 | -3.7% | -57.1% | +17.8% | 46% | 1 | 71.4% | 42.1% |
| MSFT | chop | put | 17 | -28.4% | -67.5% | +0.0% | 70% | 0 | 82.4% | 14.3% |
| MSFT | mild_trend_down | call | 27 | -4.0% | -64.8% | +20.3% | 100% | 0 | 3.7% | nan% |
| MSFT | mild_trend_down | put | 26 | +0.0% | -99.1% | +0.0% | 13% | 0 | 34.6% | 0.0% |
| MSFT | mild_trend_up | call | 55 | +0.0% | +0.0% | +18.0% | 100% | 0 | 81.8% | 9.1% |
| MSFT | mild_trend_up | put | 109 | +0.0% | -4.3% | +12.4% | 21% | 0 | 25.7% | 50.0% |
| MU | mild_trend_up | put | 29 | -5.7% | -49.6% | +28.3% | 86% | 1 | 44.8% | 0.0% |
| NDXP | chop | call | 40 | +nan% | +nan% | +nan% | 100% | 0 | 97.5% | nan% |
| NDXP | chop | put | 25 | +nan% | -92.3% | +0.0% | nan% | nan | 0.0% | nan% |
| NDXP | mild_trend_up | call | 58 | +nan% | +nan% | +nan% | 100% | 0 | 98.3% | nan% |
| NDXP | mild_trend_up | put | 25 | +nan% | -50.0% | +0.0% | 81% | 1 | 4.0% | nan% |
| NVDA | chop | put | 77 | +0.0% | -2.0% | +20.9% | 100% | 0 | 24.7% | nan% |
| NVDA | mild_trend_up | call | 28 | -8.5% | -78.8% | +19.5% | 71% | 2 | 60.7% | 100.0% |
| NVDA | mild_trend_up | put | 95 | -1.0% | -97.2% | +0.0% | 57% | 1 | 22.1% | 0.0% |
| NVDA | strong_trend_up | put | 18 | +0.0% | -73.5% | +8.8% | nan% | nan | 0.0% | nan% |
| QQQ | chop | call | 701 | -7.6% | -45.0% | +9.7% | 100% | 0 | 62.9% | 39.1% |
| QQQ | chop | put | 1,200 | -1.9% | -80.4% | +5.2% | 81% | 0 | 32.2% | 24.1% |
| QQQ | mild_trend_up | call | 1,018 | -2.3% | -41.5% | +22.1% | 100% | 0 | 80.2% | 46.9% |
| QQQ | mild_trend_up | put | 2,086 | -1.1% | -80.8% | +1.8% | 53% | 0 | 25.6% | 17.2% |
| SNDK | chop | put | 10 | +nan% | +nan% | +nan% | 84% | 0 | 40.0% | nan% |
| SNDK | extreme_up | put | 11 | -1.7% | -95.0% | +1.4% | 98% | 1 | 100.0% | 90.9% |
| SPXW | chop | call | 837 | -1.9% | -80.6% | +4.2% | 100% | 0 | 32.5% | 37.1% |
| SPXW | chop | put | 1,516 | -7.1% | -86.6% | +6.8% | 100% | 0 | 30.1% | 31.6% |
| SPXW | mild_trend_up | call | 237 | -5.7% | -13.6% | +28.4% | 100% | 0 | 87.8% | 68.4% |
| SPXW | mild_trend_up | put | 601 | +0.0% | -90.7% | +0.0% | 70% | 0 | 22.3% | 15.7% |
| SPY | chop | call | 1,729 | -4.8% | -68.1% | +13.0% | 100% | 0 | 49.3% | 30.8% |
| SPY | chop | put | 2,964 | -2.3% | -68.2% | +5.1% | 82% | 0 | 35.9% | 30.2% |
| SPY | mild_trend_up | call | 125 | +0.0% | -16.7% | +10.8% | 100% | 0 | 100.0% | 66.0% |
| SPY | mild_trend_up | put | 386 | +0.0% | -96.2% | +0.0% | 29% | 0 | 30.8% | 10.6% |
| TSLA | chop | call | 254 | -6.2% | -65.8% | +18.9% | 80% | 0 | 50.8% | 54.5% |
| TSLA | chop | put | 341 | +0.0% | -64.9% | +0.0% | 94% | 0 | 46.6% | 16.2% |
| TSLA | mild_trend_up | call | 183 | -22.8% | -82.9% | +29.4% | 69% | 0 | 52.5% | 30.5% |
| TSLA | mild_trend_up | put | 237 | -0.4% | -94.9% | +2.9% | 65% | 1 | 28.3% | 17.4% |

## Winners (peak ≥ 30%) — MAE before peak by ticker × regime × side

Big numbers means "eventual winners endured deep drawdowns first". Indicates the regime/ticker is *psychologically punishing* even when right.

| ticker | regime | side | n winners | median MAE | p25 | p75 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| IWM | chop | call | 24 | -0.5% | -14.4% | +0.0% |
| IWM | chop | put | 37 | -7.8% | -20.4% | +0.0% |
| IWM | mild_trend_up | call | 37 | -27.5% | -45.4% | +0.0% |
| IWM | mild_trend_up | put | 10 | -0.5% | -4.3% | +0.0% |
| META | chop | call | 8 | +0.0% | -3.1% | +0.0% |
| META | chop | put | 9 | -40.2% | -73.7% | +0.0% |
| META | mild_trend_down | put | 12 | -5.1% | -11.4% | -1.1% |
| META | mild_trend_up | call | 9 | +0.0% | +0.0% | +0.0% |
| META | mild_trend_up | put | 6 | +0.0% | +0.0% | +0.0% |
| MSFT | chop | call | 8 | -3.4% | -7.8% | -1.5% |
| MSFT | mild_trend_down | call | 8 | -1.9% | -5.0% | +0.0% |
| MSFT | mild_trend_up | put | 8 | +0.0% | -14.7% | +0.0% |
| MU | mild_trend_up | put | 9 | -5.6% | -7.0% | +0.0% |
| NVDA | mild_trend_up | call | 6 | -3.8% | -5.9% | -2.2% |
| QQQ | chop | call | 231 | -15.9% | -46.9% | -0.9% |
| QQQ | chop | put | 182 | -5.5% | -20.5% | +0.0% |
| QQQ | mild_trend_up | call | 228 | -1.3% | -10.1% | +0.0% |
| QQQ | mild_trend_up | put | 210 | -4.8% | -17.2% | +0.0% |
| SPXW | chop | call | 153 | +0.0% | -11.9% | +0.0% |
| SPXW | chop | put | 287 | -14.1% | -31.0% | +0.0% |
| SPXW | mild_trend_up | call | 58 | -3.9% | -19.6% | +0.0% |
| SPXW | mild_trend_up | put | 41 | +0.0% | -10.2% | +0.0% |
| SPY | chop | call | 475 | -8.3% | -24.9% | +0.0% |
| SPY | chop | put | 558 | -6.4% | -18.1% | +0.0% |
| SPY | mild_trend_up | call | 18 | +0.0% | -15.1% | +0.0% |
| SPY | mild_trend_up | put | 23 | +0.0% | -0.6% | +0.0% |
| TSLA | chop | call | 95 | -12.5% | -30.5% | -0.2% |
| TSLA | chop | put | 40 | -2.8% | -23.6% | +0.0% |
| TSLA | mild_trend_up | call | 51 | -38.2% | -62.9% | -11.7% |
