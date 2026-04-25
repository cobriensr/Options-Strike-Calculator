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
| loser (<0%) | 4,151 | +0.0% | +0.0% | +0.0% |
| small_win (0-30%) | 4,152 | -1.1% | -11.9% | +0.0% |
| decent_win (30-100%) | 1,994 | -4.8% | -19.1% | +0.0% |
| big_win (>100%) | 858 | -10.3% | -36.7% | +0.0% |

## Per-ticker × regime × side — path-shape

| ticker | regime | side | n | med MAE→peak | med MAE→close | med peak% | med time in ITM | med re-entries | touched% | peak→ITM% |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IWM | chop | call | 77 | +0.0% | -56.4% | +24.2% | 100% | 0 | 83.1% | 20.8% |
| IWM | chop | put | 41 | +0.0% | -89.0% | +0.0% | 26% | 0 | 48.8% | 4.9% |
| IWM | mild_trend_down | call | 30 | -16.0% | -18.7% | +143.9% | 100% | 0 | 70.0% | 0.0% |
| IWM | mild_trend_down | put | 32 | +0.0% | -75.7% | +0.8% | 100% | 0 | 65.6% | 40.6% |
| IWM | mild_trend_up | call | 25 | +0.0% | -81.7% | +7.0% | 64% | 2 | 8.0% | 8.0% |
| IWM | mild_trend_up | put | 150 | +0.0% | -83.9% | +12.9% | 100% | 0 | 28.7% | 0.0% |
| IWM | strong_trend_up | call | 26 | -5.2% | -35.8% | +28.0% | 80% | 1 | 100.0% | 46.2% |
| IWM | strong_trend_up | put | 61 | +0.0% | -50.0% | +0.4% | 36% | 1 | 37.7% | 1.6% |
| META | chop | call | 46 | +0.0% | -95.5% | +5.1% | 40% | 0 | 19.6% | 0.0% |
| META | chop | put | 41 | -3.2% | -27.7% | +88.1% | 62% | 0 | 68.3% | 58.5% |
| META | mild_trend_down | put | 28 | +0.0% | -99.8% | +0.0% | 100% | 0 | 57.1% | 0.0% |
| META | mild_trend_up | call | 53 | +0.0% | +0.0% | +1.3% | 100% | 0 | 77.4% | 1.9% |
| META | mild_trend_up | put | 46 | +0.0% | -46.5% | +27.2% | 100% | 0 | 32.6% | 0.0% |
| META | strong_trend_up | call | 12 | +0.0% | -51.8% | +26.1% | 97% | 1 | 91.7% | 0.0% |
| META | strong_trend_up | put | 44 | +0.0% | -50.0% | +26.2% | nan% | nan | 0.0% | 0.0% |
| MSFT | chop | call | 55 | +0.0% | -47.1% | +17.8% | 96% | 1 | 78.2% | 18.2% |
| MSFT | chop | put | 82 | +0.0% | -67.5% | +0.0% | 57% | 0 | 46.3% | 3.7% |
| MSFT | extreme_up | call | 24 | +0.0% | -10.8% | +17.0% | 100% | 0 | 91.7% | 0.0% |
| MSFT | extreme_up | put | 43 | +0.0% | +0.0% | +0.0% | 15% | 0 | 14.0% | 0.0% |
| MSFT | mild_trend_down | call | 27 | +0.0% | -64.8% | +20.3% | 100% | 0 | 3.7% | 0.0% |
| MSFT | mild_trend_down | put | 25 | +0.0% | -99.1% | +0.0% | 13% | 0 | 28.0% | 0.0% |
| MSTR | extreme_up | call | 14 | -14.1% | -99.8% | +5.0% | 39% | 0 | 78.6% | 42.9% |
| MU | chop | put | 24 | -5.8% | -42.8% | +29.3% | 88% | 1 | 33.3% | 0.0% |
| NDXP | chop | call | 71 | +nan% | +nan% | +nan% | 100% | 0 | 97.2% | 0.0% |
| NDXP | chop | put | 25 | +nan% | +nan% | +nan% | 81% | 1 | 4.0% | 0.0% |
| NDXP | mild_trend_up | call | 27 | +nan% | +nan% | +nan% | 100% | 0 | 100.0% | 0.0% |
| NDXP | mild_trend_up | put | 25 | +0.0% | -71.1% | +0.0% | nan% | nan | 0.0% | 0.0% |
| NVDA | chop | put | 77 | +0.0% | -2.0% | +20.9% | 100% | 0 | 24.7% | 0.0% |
| NVDA | extreme_up | call | 28 | -8.2% | -78.8% | +19.5% | 71% | 2 | 60.7% | 60.7% |
| NVDA | extreme_up | put | 77 | +0.0% | -97.2% | +0.0% | 57% | 1 | 24.7% | 0.0% |
| NVDA | mild_trend_up | put | 36 | +0.0% | -50.0% | +17.3% | 100% | 0 | 5.6% | 0.0% |
| QQQ | chop | call | 639 | +0.0% | -42.7% | +6.8% | 100% | 0 | 62.9% | 12.1% |
| QQQ | chop | put | 1,367 | +0.0% | -79.8% | +7.1% | 84% | 0 | 28.9% | 4.8% |
| QQQ | mild_trend_up | call | 925 | -0.3% | -46.2% | +29.9% | 100% | 0 | 79.1% | 21.4% |
| QQQ | mild_trend_up | put | 1,658 | +0.0% | -83.5% | +0.0% | 42% | 0 | 25.3% | 0.4% |
| QQQ | strong_trend_up | call | 155 | +0.0% | -64.8% | +11.1% | 100% | 0 | 79.4% | 9.7% |
| QQQ | strong_trend_up | put | 261 | -1.1% | -78.3% | +8.4% | 100% | 0 | 40.6% | 5.7% |
| SNDK | extreme_down | put | 11 | -0.9% | -95.0% | +1.4% | 98% | 1 | 100.0% | 90.9% |
| SPXW | chop | call | 292 | +0.0% | -77.1% | +6.7% | 100% | 0 | 31.8% | 6.8% |
| SPXW | chop | put | 708 | +0.0% | -87.4% | +4.6% | 100% | 0 | 28.2% | 3.1% |
| SPXW | mild_trend_down | call | 89 | +0.0% | -81.3% | +0.2% | 98% | 0 | 34.8% | 14.6% |
| SPXW | mild_trend_down | put | 90 | +0.0% | -89.7% | +0.5% | 100% | 0 | 38.9% | 15.6% |
| SPXW | mild_trend_up | call | 425 | +0.0% | -82.2% | +5.2% | 100% | 0 | 35.8% | 6.4% |
| SPXW | mild_trend_up | put | 605 | +0.0% | -88.0% | +8.6% | 100% | 0 | 35.2% | 4.3% |
| SPXW | strong_trend_up | call | 268 | +0.0% | -34.4% | +14.6% | 100% | 0 | 76.1% | 21.6% |
| SPXW | strong_trend_up | put | 714 | +0.0% | -89.0% | +0.0% | 100% | 0 | 20.0% | 0.1% |
| SPY | chop | call | 1,324 | +0.0% | -69.1% | +14.7% | 100% | 0 | 46.8% | 8.2% |
| SPY | chop | put | 2,134 | +0.0% | -72.4% | +4.9% | 83% | 0 | 39.4% | 7.9% |
| SPY | extreme_up | call | 234 | +0.0% | -48.5% | +10.7% | 100% | 0 | 70.1% | 12.4% |
| SPY | extreme_up | put | 575 | -0.5% | -39.8% | +12.4% | 31% | 2 | 19.7% | 0.0% |
| SPY | mild_trend_up | call | 125 | +0.0% | -16.7% | +10.8% | 100% | 0 | 100.0% | 26.4% |
| SPY | mild_trend_up | put | 386 | +0.0% | -96.2% | +0.0% | 29% | 0 | 30.8% | 2.9% |
| SPY | strong_trend_up | call | 171 | +0.0% | -80.0% | +10.4% | 100% | 0 | 40.4% | 5.8% |
| SPY | strong_trend_up | put | 255 | +0.0% | -83.3% | +2.2% | 100% | 0 | 42.7% | 0.0% |
| TSLA | chop | call | 17 | +0.0% | -89.0% | +16.7% | 33% | 2 | 94.1% | 23.5% |
| TSLA | extreme_down | call | 193 | +0.0% | -66.0% | +17.0% | 100% | 0 | 35.8% | 17.1% |
| TSLA | extreme_down | put | 228 | +0.0% | -69.4% | +1.1% | 100% | 0 | 45.2% | 4.8% |
| TSLA | extreme_up | call | 46 | -8.2% | -63.4% | +74.2% | 80% | 0 | 100.0% | 56.5% |
| TSLA | extreme_up | put | 113 | +0.0% | -33.3% | +0.0% | 86% | 1 | 49.6% | 0.0% |
| TSLA | mild_trend_up | call | 181 | +0.0% | -79.7% | +37.4% | 100% | 0 | 51.9% | 8.3% |
| TSLA | mild_trend_up | put | 237 | -0.2% | -94.9% | +2.9% | 65% | 1 | 28.3% | 1.7% |

## Winners (peak ≥ 30%) — MAE before peak by ticker × regime × side

Big numbers means "eventual winners endured deep drawdowns first". Indicates the regime/ticker is *psychologically punishing* even when right.

| ticker | regime | side | n winners | median MAE | p25 | p75 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| IWM | chop | call | 33 | -9.3% | -45.4% | +0.0% |
| IWM | mild_trend_down | call | 8 | -17.3% | -21.9% | -12.7% |
| IWM | mild_trend_up | call | 9 | +0.0% | -2.3% | +0.0% |
| IWM | mild_trend_up | put | 35 | -8.5% | -20.4% | +0.0% |
| IWM | strong_trend_up | call | 11 | -26.8% | -35.8% | +0.0% |
| IWM | strong_trend_up | put | 7 | -2.9% | -5.7% | -0.5% |
| META | chop | call | 5 | +0.0% | -1.7% | +0.0% |
| META | chop | put | 20 | -7.0% | -32.8% | +0.0% |
| META | mild_trend_up | call | 9 | +0.0% | +0.0% | +0.0% |
| META | strong_trend_up | put | 5 | +0.0% | +0.0% | +0.0% |
| MSFT | chop | call | 9 | -3.7% | -18.7% | -2.0% |
| MSFT | chop | put | 8 | -2.4% | -32.4% | +0.0% |
| MSFT | mild_trend_down | call | 8 | -1.9% | -5.0% | +0.0% |
| MU | chop | put | 7 | -6.2% | -12.7% | +0.0% |
| NVDA | extreme_up | call | 6 | -3.8% | -5.9% | -2.2% |
| NVDA | mild_trend_up | put | 8 | +0.0% | +0.0% | +0.0% |
| QQQ | chop | call | 153 | -7.8% | -28.9% | +0.0% |
| QQQ | chop | put | 181 | -4.8% | -14.5% | +0.0% |
| QQQ | mild_trend_up | call | 283 | -6.1% | -20.2% | +0.0% |
| QQQ | mild_trend_up | put | 196 | -5.3% | -20.9% | +0.0% |
| QQQ | strong_trend_up | call | 23 | -12.8% | -21.9% | -1.9% |
| QQQ | strong_trend_up | put | 15 | -2.0% | -24.9% | +0.0% |
| SPXW | chop | call | 66 | +0.0% | -4.8% | +0.0% |
| SPXW | chop | put | 127 | -1.6% | -17.8% | +0.0% |
| SPXW | mild_trend_down | call | 15 | -10.5% | -13.6% | -5.3% |
| SPXW | mild_trend_down | put | 26 | -19.1% | -22.9% | -10.7% |
| SPXW | mild_trend_up | call | 78 | +0.0% | -12.8% | +0.0% |
| SPXW | mild_trend_up | put | 137 | -25.2% | -62.8% | -1.3% |
| SPXW | strong_trend_up | call | 52 | -6.1% | -26.7% | +0.0% |
| SPXW | strong_trend_up | put | 38 | -0.5% | -13.7% | +0.0% |
| SPY | chop | call | 403 | -10.5% | -26.7% | +0.0% |
| SPY | chop | put | 397 | -5.7% | -17.5% | +0.0% |
| SPY | extreme_up | call | 50 | -3.1% | -12.2% | +0.0% |
| SPY | extreme_up | put | 150 | -9.1% | -24.1% | -2.0% |
| SPY | mild_trend_up | call | 18 | +0.0% | -15.1% | +0.0% |
| SPY | mild_trend_up | put | 23 | +0.0% | -0.6% | +0.0% |
| SPY | strong_trend_up | call | 22 | +0.0% | -4.0% | +0.0% |
| SPY | strong_trend_up | put | 11 | -2.7% | -5.7% | +0.0% |
| TSLA | extreme_down | call | 66 | -9.9% | -29.4% | -0.5% |
| TSLA | extreme_down | put | 16 | +0.0% | -13.5% | +0.0% |
| TSLA | extreme_up | call | 29 | -23.8% | -33.7% | +0.0% |
| TSLA | extreme_up | put | 24 | -7.2% | -24.8% | +0.0% |
| TSLA | mild_trend_up | call | 47 | -41.6% | -66.7% | -16.2% |
