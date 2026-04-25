# IV-Anomaly Regime-Conditional (Phase D0) — 2026-04-25
**Sample:** 15,886 alerts, 10 trading days, 13 tickers.
**Regime label:** the **underlying ticker's own** daily % change (open ≈ first observed spot of day; close ≈ last observed spot).

**Thresholds:**

- chop: `|Δ| < 0.25%`
- mild_trend_(up|down): `0.25–1.0%`
- strong_trend_(up|down): `1.0–2.0%`
- extreme_(up|down): `>2.0%`

**Lookahead caveat:** uses the day's actual close to label regime. These numbers tell you 'given you correctly identify the regime at alert_ts, this is the available edge' — not 'this is what the alert predicts going forward.'

## Aggregate (all tickers)

### Regime × side

| regime | side | n | win% | mean% | mean $ | median $ | max gain $ | max loss $ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| chop | call | 2,223 | 17.9% | -30.0% | $-1 | $-8 | $14,494 | $-3,364 |
| chop | put | 3,875 | 2.4% | -85.0% | $-92 | $-24 | $104 | $-11,183 |
| extreme_down | call | 185 | 1.1% | -80.0% | $-87 | $-5 | $25 | $-3,400 |
| extreme_down | put | 204 | 8.8% | -73.0% | $-110 | $-33 | $67 | $-2,665 |
| extreme_up | call | 313 | 28.4% | -3.0% | $-17 | $-5 | $191 | $-472 |
| extreme_up | put | 758 | 7.3% | -77.0% | $-40 | $-5 | $18 | $-505 |
| mild_trend_down | call | 151 | 23.8% | -56.0% | $-72 | $-6 | $415 | $-2,100 |
| mild_trend_down | put | 137 | 7.3% | -60.0% | $-120 | $-34 | $279 | $-1,031 |
| mild_trend_up | call | 1,604 | 33.7% | 43.0% | $-2 | $-9 | $10,588 | $-2,422 |
| mild_trend_up | put | 3,055 | 2.2% | -72.0% | $-125 | $-40 | $3,212 | $-8,017 |
| strong_trend_up | call | 566 | 27.0% | 34.0% | $150 | $-10 | $3,242 | $-6,002 |
| strong_trend_up | put | 1,335 | 0.4% | -86.0% | $-190 | $-43 | $4 | $-4,082 |

## Per-ticker × regime × side

Best strategy is re-picked per `(ticker, regime)` when n ≥ 30, else falls back to ticker-level Sharpe-ish pick.

| ticker | regime | side | best strat | n | win% | mean% | mean $ | median $ | max loss $ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IWM | chop | call | itm_touch | 71 | 25.4% | 213.0% | $-4 | $-3 | $-71 |
| IWM | chop | put | itm_touch | 38 | 0.0% | -78.0% | $-22 | $-17 | $-113 |
| IWM | mild_trend_down | call | eod | 29 | 62.1% | 12.0% | $5 | $4 | $-19 |
| IWM | mild_trend_down | put | eod | 30 | 3.3% | -49.0% | $-14 | $-10 | $-49 |
| IWM | mild_trend_up | call | eod | 25 | 0.0% | -95.0% | $-15 | $-6 | $-84 |
| IWM | mild_trend_up | put | eod | 136 | 7.3% | -82.0% | $-24 | $-6 | $-192 |
| IWM | strong_trend_up | call | itm_touch | 26 | 19.2% | -15.0% | $-2 | $-2 | $-9 |
| IWM | strong_trend_up | put | itm_touch | 60 | 5.0% | -53.0% | $-7 | $-2 | $-63 |
| META | chop | call | itm_touch | 16 | 0.0% | -98.0% | $-55 | $-45 | $-178 |
| META | chop | put | itm_touch | 29 | 34.5% | 36.0% | $1 | $-7 | $-41 |
| META | mild_trend_down | call | eod | 8 | 0.0% | -100.0% | $-13 | $-17 | $-24 |
| META | mild_trend_down | put | eod | 14 | 57.1% | 99.0% | $-45 | $26 | $-473 |
| META | mild_trend_up | call | eod | 43 | 90.7% | 130.0% | $81 | $60 | $-10 |
| META | mild_trend_up | put | eod | 7 | 0.0% | -90.0% | $-52 | $-4 | $-207 |
| META | strong_trend_up | call | itm_touch | 2 | 0.0% | -46.0% | $-52 | $-52 | $-99 |
| META | strong_trend_up | put | itm_touch | 40 | 5.0% | -43.0% | $-4 | $-1 | $-90 |
| MSFT | chop | call | eod | 55 | 61.8% | 22.0% | $8 | $2 | $-32 |
| MSFT | chop | put | eod | 49 | 4.1% | -89.0% | $-30 | $-28 | $-203 |
| MSFT | extreme_up | call | eod | 18 | 88.9% | 471.0% | $118 | $166 | $-2 |
| MSFT | extreme_up | put | eod | 11 | 9.1% | -46.0% | $-8 | $-4 | $-26 |
| MSFT | mild_trend_down | call | eod | 25 | 4.0% | -95.0% | $-23 | $-3 | $-196 |
| MSFT | mild_trend_down | put | eod | 11 | 0.0% | -98.0% | $-99 | $-112 | $-183 |
| MSTR | extreme_up | call | itm_touch | 6 | 0.0% | -100.0% | $-467 | $-465 | $-472 |
| MSTR | extreme_up | put | itm_touch | 2 | 0.0% | -4.0% | $-3 | $-3 | $-3 |
| MU | chop | put | eod | 21 | 9.5% | -70.0% | $-52 | $-57 | $-137 |
| MU | extreme_up | call | eod | 1 | 0.0% | -4.0% | $-102 | $-102 | $-102 |
| MU | mild_trend_down | put | eod | 4 | 0.0% | -87.0% | $-764 | $-764 | $-1,031 |
| MU | strong_trend_up | put | eod | 5 | 0.0% | -87.0% | $-171 | $-20 | $-787 |
| NDXP | chop | call | eod | 69 | 52.2% | 16.0% | $673 | $185 | $-3,364 |
| NDXP | chop | put | eod | 10 | 0.0% | -100.0% | $-73 | $-9 | $-506 |
| NDXP | mild_trend_up | call | eod | 27 | 96.3% | 22.0% | $2,858 | $1,971 | $-641 |
| NDXP | mild_trend_up | put | eod | 9 | 0.0% | -94.0% | $-102 | $-21 | $-676 |
| NVDA | chop | put | eod | 19 | 21.1% | -3.0% | $-6 | $-4 | $-46 |
| NVDA | extreme_up | call | itm_touch | 28 | 0.0% | -75.0% | $-38 | $-44 | $-65 |
| NVDA | extreme_up | put | itm_touch | 76 | 0.0% | -92.0% | $-46 | $-35 | $-210 |
| NVDA | mild_trend_up | call | eod | 1 | 0.0% | -94.0% | $-98 | $-98 | $-98 |
| NVDA | mild_trend_up | put | eod | 35 | 0.0% | -97.0% | $-5 | $-2 | $-78 |
| QQQ | chop | call | eod | 630 | 18.7% | -43.0% | $-29 | $-14 | $-489 |
| QQQ | chop | put | eod | 1,260 | 0.1% | -94.0% | $-64 | $-34 | $-827 |
| QQQ | mild_trend_up | call | eod | 819 | 45.9% | 106.0% | $19 | $-1 | $-671 |
| QQQ | mild_trend_up | put | eod | 1,646 | 0.0% | -93.0% | $-75 | $-39 | $-858 |
| QQQ | strong_trend_up | call | eod | 140 | 5.7% | -55.0% | $-54 | $-45 | $-367 |
| QQQ | strong_trend_up | put | eod | 261 | 0.0% | -81.0% | $-58 | $-26 | $-608 |
| SMH | chop | put | eod | 3 | 0.0% | -100.0% | $-71 | $-69 | $-95 |
| SNDK | extreme_down | call | itm_touch | 3 | 0.0% | -100.0% | $-3,400 | $-3,400 | $-3,400 |
| SNDK | extreme_down | put | itm_touch | 11 | 0.0% | -55.0% | $-1,391 | $-2,296 | $-2,665 |
| SNDK | strong_trend_up | put | itm_touch | 3 | 0.0% | -74.0% | $-57 | $-57 | $-57 |
| SPXW | chop | call | eod | 289 | 22.5% | -25.0% | $-33 | $-23 | $-2,182 |
| SPXW | chop | put | eod | 686 | 0.9% | -88.0% | $-270 | $-52 | $-11,183 |
| SPXW | mild_trend_down | call | eod | 89 | 19.1% | -62.0% | $-117 | $-12 | $-2,100 |
| SPXW | mild_trend_down | put | eod | 78 | 1.3% | -86.0% | $-145 | $-38 | $-670 |
| SPXW | mild_trend_up | call | eod | 415 | 4.1% | -81.0% | $-229 | $-44 | $-2,422 |
| SPXW | mild_trend_up | put | eod | 605 | 8.8% | 10.0% | $-338 | $-88 | $-8,017 |
| SPXW | strong_trend_up | call | eod | 243 | 53.5% | 162.0% | $394 | $69 | $-6,002 |
| SPXW | strong_trend_up | put | eod | 714 | 0.0% | -93.0% | $-309 | $-108 | $-4,082 |
| SPY | chop | call | itm_touch | 1,076 | 11.7% | -44.0% | $-18 | $-6 | $-214 |
| SPY | chop | put | itm_touch | 1,760 | 3.8% | -82.0% | $-49 | $-13 | $-599 |
| SPY | extreme_up | call | eod | 214 | 26.2% | -33.0% | $-15 | $-4 | $-407 |
| SPY | extreme_up | put | eod | 574 | 8.7% | -80.0% | $-42 | $-3 | $-505 |
| SPY | mild_trend_up | call | eod | 107 | 73.8% | 252.0% | $97 | $167 | $-675 |
| SPY | mild_trend_up | put | eod | 384 | 0.0% | -96.0% | $-71 | $-35 | $-470 |
| SPY | strong_trend_up | call | eod | 155 | 6.5% | -76.0% | $-18 | $-10 | $-140 |
| SPY | strong_trend_up | put | eod | 252 | 0.0% | -85.0% | $-63 | $-44 | $-678 |
| TSLA | chop | call | itm_touch | 17 | 0.0% | -90.0% | $-30 | $-29 | $-46 |
| TSLA | extreme_down | call | eod | 182 | 1.1% | -79.0% | $-33 | $-5 | $-989 |
| TSLA | extreme_down | put | eod | 193 | 9.3% | -74.0% | $-37 | $-31 | $-377 |
| TSLA | extreme_up | call | itm_touch | 46 | 37.0% | 6.0% | $-5 | $-2 | $-33 |
| TSLA | extreme_up | put | itm_touch | 95 | 4.2% | -49.0% | $-27 | $-7 | $-401 |
| TSLA | mild_trend_up | call | eod | 167 | 1.8% | -83.0% | $-79 | $-47 | $-1,069 |
| TSLA | mild_trend_up | put | eod | 233 | 1.7% | -90.0% | $-91 | $-66 | $-557 |

## Sanity check — days per ticker × regime

| ticker | regime | n alerts | n days | mean Δ% |
| --- | --- | ---: | ---: | ---: |
| IWM | chop | 118 | 6 | +0.08% |
| IWM | mild_trend_down | 62 | 1 | -0.49% |
| IWM | mild_trend_up | 175 | 2 | +0.47% |
| IWM | strong_trend_up | 87 | 1 | +1.61% |
| META | chop | 87 | 3 | -0.01% |
| META | extreme_up | 8 | 1 | +2.54% |
| META | mild_trend_down | 36 | 1 | -0.28% |
| META | mild_trend_up | 99 | 2 | +0.62% |
| META | strong_trend_up | 56 | 2 | +1.68% |
| MSFT | chop | 137 | 3 | +0.21% |
| MSFT | extreme_up | 67 | 3 | +6.92% |
| MSFT | mild_trend_down | 52 | 2 | -0.40% |
| MSFT | mild_trend_up | 6 | 1 | +0.41% |
| MSTR | extreme_down | 7 | 1 | -4.53% |
| MSTR | extreme_up | 22 | 2 | +10.16% |
| MU | chop | 24 | 1 | -0.03% |
| MU | extreme_up | 1 | 1 | +10.79% |
| MU | mild_trend_down | 4 | 1 | -0.74% |
| MU | strong_trend_up | 5 | 1 | +1.38% |
| NDXP | chop | 96 | 6 | +0.10% |
| NDXP | mild_trend_up | 52 | 4 | +0.34% |
| NVDA | chop | 80 | 1 | -0.10% |
| NVDA | extreme_up | 105 | 2 | +2.25% |
| NVDA | mild_trend_up | 37 | 3 | +0.72% |
| QQQ | chop | 2,006 | 5 | +0.01% |
| QQQ | mild_trend_up | 2,583 | 4 | +0.54% |
| QQQ | strong_trend_up | 416 | 1 | +1.56% |
| SMH | chop | 5 | 1 | -0.02% |
| SMH | extreme_up | 4 | 3 | +10.72% |
| SNDK | extreme_down | 17 | 1 | -2.29% |
| SNDK | extreme_up | 2 | 2 | +8.59% |
| SNDK | mild_trend_down | 16 | 1 | -0.71% |
| SNDK | strong_trend_up | 4 | 1 | +1.33% |
| SPXW | chop | 1,000 | 3 | -0.13% |
| SPXW | mild_trend_down | 179 | 1 | -0.59% |
| SPXW | mild_trend_up | 1,030 | 3 | +0.66% |
| SPXW | strong_trend_up | 982 | 3 | +1.37% |
| SPY | chop | 3,458 | 7 | +0.01% |
| SPY | extreme_up | 809 | 1 | +2.57% |
| SPY | mild_trend_up | 511 | 1 | +0.53% |
| SPY | strong_trend_up | 426 | 1 | +1.13% |
| TSLA | chop | 17 | 1 | -0.13% |
| TSLA | extreme_down | 421 | 3 | -5.01% |
| TSLA | extreme_up | 159 | 2 | +10.81% |
| TSLA | mild_trend_up | 418 | 2 | +0.52% |

## Per-(ticker, regime) BEST_STRATEGY picks

| ticker | regime | strategy |
| --- | --- | --- |
| IWM | chop | itm_touch |
| IWM | mild_trend_down | eod |
| IWM | mild_trend_up | eod |
| IWM | strong_trend_up | itm_touch |
| META | chop | itm_touch |
| META | extreme_up | eod |
| META | mild_trend_down | eod |
| META | mild_trend_up | eod |
| META | strong_trend_up | itm_touch |
| MSFT | chop | eod |
| MSFT | extreme_up | eod |
| MSFT | mild_trend_down | eod |
| MSFT | mild_trend_up | eod |
| MSTR | extreme_down | itm_touch |
| MSTR | extreme_up | itm_touch |
| MU | chop | eod |
| MU | extreme_up | eod |
| MU | mild_trend_down | eod |
| MU | strong_trend_up | eod |
| NDXP | chop | eod |
| NDXP | mild_trend_up | eod |
| NVDA | chop | eod |
| NVDA | extreme_up | itm_touch |
| NVDA | mild_trend_up | eod |
| QQQ | chop | eod |
| QQQ | mild_trend_up | eod |
| QQQ | strong_trend_up | eod |
| SMH | chop | eod |
| SMH | extreme_up | eod |
| SNDK | extreme_down | itm_touch |
| SNDK | extreme_up | itm_touch |
| SNDK | mild_trend_down | itm_touch |
| SNDK | strong_trend_up | itm_touch |
| SPXW | chop | eod |
| SPXW | mild_trend_down | eod |
| SPXW | mild_trend_up | eod |
| SPXW | strong_trend_up | eod |
| SPY | chop | itm_touch |
| SPY | extreme_up | eod |
| SPY | mild_trend_up | eod |
| SPY | strong_trend_up | eod |
| TSLA | chop | itm_touch |
| TSLA | extreme_down | eod |
| TSLA | extreme_up | itm_touch |
| TSLA | mild_trend_up | eod |
