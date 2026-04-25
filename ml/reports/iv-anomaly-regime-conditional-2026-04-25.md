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
| chop | call | 3,251 | 16.7% | -32.0% | $-35 | $-8 | $6,976 | $-3,027 |
| chop | put | 5,535 | 3.7% | -74.0% | $-121 | $-26 | $3,212 | $-11,183 |
| extreme_up | call | 3 | 0.0% | -100.0% | $-3,400 | $-3,400 | $-3,400 | $-3,400 |
| extreme_up | put | 13 | 0.0% | -47.0% | $-1,177 | $-100 | $-2 | $-2,665 |
| mild_trend_down | call | 29 | 3.5% | -89.0% | $-36 | $-3 | $24 | $-196 |
| mild_trend_down | put | 30 | 0.0% | -66.0% | $-46 | $-16 | $-4 | $-183 |
| mild_trend_up | call | 1,660 | 40.2% | 64.0% | $109 | $-7 | $14,494 | $-6,002 |
| mild_trend_up | put | 3,573 | 0.5% | -90.0% | $-99 | $-35 | $104 | $-4,082 |
| strong_trend_up | call | 7 | 0.0% | -99.0% | $-414 | $-465 | $-98 | $-472 |
| strong_trend_up | put | 22 | 0.0% | -98.0% | $-143 | $-4 | $-1 | $-1,031 |

## Per-ticker × regime × side

Best strategy is re-picked per `(ticker, regime)` when n ≥ 30, else falls back to ticker-level Sharpe-ish pick.

| ticker | regime | side | best strat | n | win% | mean% | mean $ | median $ | max loss $ |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IWM | chop | call | eod | 76 | 38.2% | -27.0% | $-3 | $-2 | $-84 |
| IWM | chop | put | eod | 185 | 6.5% | -76.0% | $-22 | $-9 | $-192 |
| IWM | mild_trend_up | call | itm_touch | 80 | 26.2% | 195.0% | $-2 | $-3 | $-71 |
| IWM | mild_trend_up | put | itm_touch | 81 | 3.7% | -61.0% | $-12 | $-3 | $-113 |
| META | chop | call | itm_touch | 22 | 0.0% | -98.0% | $-29 | $-19 | $-65 |
| META | chop | put | itm_touch | 17 | 58.8% | 78.0% | $-41 | $23 | $-473 |
| META | mild_trend_down | call | itm_touch | 3 | 0.0% | -69.0% | $-121 | $-178 | $-178 |
| META | mild_trend_down | put | itm_touch | 18 | 0.0% | -47.0% | $-18 | $-9 | $-90 |
| META | mild_trend_up | call | eod | 44 | 88.6% | 125.0% | $77 | $60 | $-99 |
| META | mild_trend_up | put | eod | 44 | 4.5% | -47.0% | $-9 | $-1 | $-207 |
| MSFT | chop | call | eod | 28 | 71.4% | 42.0% | $20 | $23 | $-5 |
| MSFT | chop | put | eod | 17 | 0.0% | -100.0% | $-33 | $-28 | $-66 |
| MSFT | mild_trend_down | call | eod | 25 | 4.0% | -95.0% | $-23 | $-3 | $-196 |
| MSFT | mild_trend_down | put | eod | 12 | 0.0% | -94.0% | $-87 | $-112 | $-183 |
| MSFT | mild_trend_up | call | eod | 45 | 66.7% | 189.0% | $44 | $2 | $-32 |
| MSFT | mild_trend_up | put | eod | 42 | 7.1% | -74.0% | $-24 | $-8 | $-203 |
| MSTR | extreme_up | put | itm_touch | 2 | 0.0% | -4.0% | $-3 | $-3 | $-3 |
| MSTR | strong_trend_up | call | itm_touch | 6 | 0.0% | -100.0% | $-467 | $-465 | $-472 |
| MU | mild_trend_down | call | eod | 1 | 0.0% | -4.0% | $-102 | $-102 | $-102 |
| MU | mild_trend_up | put | eod | 26 | 7.7% | -73.0% | $-75 | $-51 | $-787 |
| MU | strong_trend_up | put | eod | 4 | 0.0% | -87.0% | $-764 | $-764 | $-1,031 |
| NDXP | chop | call | eod | 39 | 82.0% | 15.0% | $1,584 | $1,700 | $-1,849 |
| NDXP | chop | put | eod | 8 | 0.0% | -100.0% | $-113 | $-34 | $-676 |
| NDXP | mild_trend_up | call | eod | 57 | 52.6% | 20.0% | $1,085 | $61 | $-3,364 |
| NDXP | mild_trend_up | put | eod | 11 | 0.0% | -95.0% | $-68 | $-10 | $-506 |
| NVDA | chop | put | eod | 19 | 21.1% | -3.0% | $-6 | $-4 | $-46 |
| NVDA | mild_trend_up | call | eod | 28 | 0.0% | -75.0% | $-38 | $-44 | $-65 |
| NVDA | mild_trend_up | put | eod | 93 | 0.0% | -93.0% | $-39 | $-35 | $-210 |
| NVDA | strong_trend_up | call | eod | 1 | 0.0% | -94.0% | $-98 | $-98 | $-98 |
| NVDA | strong_trend_up | put | eod | 18 | 0.0% | -100.0% | $-5 | $-4 | $-26 |
| QQQ | chop | call | eod | 687 | 27.8% | 56.0% | $-3 | $-6 | $-489 |
| QQQ | chop | put | eod | 1,112 | 0.0% | -94.0% | $-75 | $-39 | $-858 |
| QQQ | mild_trend_up | call | eod | 902 | 34.5% | 14.0% | $-9 | $-10 | $-671 |
| QQQ | mild_trend_up | put | eod | 2,055 | 0.1% | -91.0% | $-66 | $-33 | $-827 |
| SMH | chop | put | itm_touch | 3 | 0.0% | -100.0% | $-71 | $-69 | $-95 |
| SNDK | extreme_up | call | itm_touch | 3 | 0.0% | -100.0% | $-3,400 | $-3,400 | $-3,400 |
| SNDK | extreme_up | put | itm_touch | 11 | 0.0% | -55.0% | $-1,391 | $-2,296 | $-2,665 |
| SNDK | mild_trend_up | put | itm_touch | 3 | 0.0% | -74.0% | $-57 | $-57 | $-57 |
| SPXW | chop | call | eod | 822 | 9.1% | -73.0% | $-177 | $-32 | $-3,027 |
| SPXW | chop | put | eod | 1,482 | 3.8% | -48.0% | $-310 | $-100 | $-11,183 |
| SPXW | mild_trend_up | call | eod | 214 | 72.0% | 247.0% | $590 | $253 | $-6,002 |
| SPXW | mild_trend_up | put | eod | 601 | 0.7% | -94.0% | $-269 | $-53 | $-4,082 |
| SPY | chop | call | itm_touch | 1,354 | 12.8% | -48.0% | $-16 | $-5 | $-214 |
| SPY | chop | put | itm_touch | 2,447 | 4.8% | -82.0% | $-45 | $-11 | $-599 |
| SPY | mild_trend_up | call | eod | 107 | 73.8% | 252.0% | $97 | $167 | $-675 |
| SPY | mild_trend_up | put | eod | 384 | 0.0% | -96.0% | $-71 | $-35 | $-470 |
| TSLA | chop | call | itm_touch | 223 | 9.9% | -60.0% | $-24 | $-4 | $-989 |
| TSLA | chop | put | itm_touch | 245 | 2.5% | -74.0% | $-33 | $-18 | $-401 |
| TSLA | mild_trend_up | call | eod | 183 | 1.6% | -85.0% | $-75 | $-43 | $-1,069 |
| TSLA | mild_trend_up | put | eod | 233 | 1.7% | -90.0% | $-91 | $-66 | $-557 |

## Sanity check — days per ticker × regime

| ticker | regime | n alerts | n days | mean Δ% |
| --- | --- | ---: | ---: | ---: |
| IWM | chop | 278 | 7 | +0.14% |
| IWM | mild_trend_up | 164 | 3 | +0.40% |
| META | chop | 79 | 4 | -0.12% |
| META | mild_trend_down | 56 | 2 | -0.31% |
| META | mild_trend_up | 151 | 3 | +0.56% |
| MSFT | chop | 45 | 1 | -0.10% |
| MSFT | mild_trend_down | 53 | 2 | -0.36% |
| MSFT | mild_trend_up | 164 | 6 | +0.47% |
| MSTR | extreme_up | 12 | 1 | +3.36% |
| MSTR | strong_trend_up | 17 | 2 | +1.57% |
| MU | mild_trend_down | 1 | 1 | -0.35% |
| MU | mild_trend_up | 29 | 2 | +0.45% |
| MU | strong_trend_up | 4 | 1 | +1.92% |
| NDXP | chop | 65 | 4 | +0.11% |
| NDXP | mild_trend_up | 83 | 6 | +0.34% |
| NVDA | chop | 80 | 1 | +0.05% |
| NVDA | mild_trend_up | 123 | 4 | +0.92% |
| NVDA | strong_trend_up | 19 | 1 | +1.01% |
| QQQ | chop | 1,901 | 5 | +0.14% |
| QQQ | mild_trend_up | 3,104 | 5 | +0.37% |
| SMH | chop | 5 | 1 | +0.08% |
| SMH | mild_trend_up | 4 | 3 | +0.83% |
| SNDK | chop | 17 | 2 | -0.04% |
| SNDK | extreme_up | 17 | 1 | +2.10% |
| SNDK | mild_trend_up | 4 | 1 | +0.62% |
| SNDK | strong_trend_down | 1 | 1 | -1.36% |
| SPXW | chop | 2,353 | 7 | +0.07% |
| SPXW | mild_trend_up | 838 | 3 | +0.42% |
| SPY | chop | 4,693 | 9 | +0.12% |
| SPY | mild_trend_up | 511 | 1 | +0.57% |
| TSLA | chop | 595 | 6 | -0.01% |
| TSLA | mild_trend_up | 420 | 2 | +0.50% |

## Per-(ticker, regime) BEST_STRATEGY picks

| ticker | regime | strategy |
| --- | --- | --- |
| IWM | chop | eod |
| IWM | mild_trend_up | itm_touch |
| META | chop | itm_touch |
| META | mild_trend_down | itm_touch |
| META | mild_trend_up | eod |
| MSFT | chop | eod |
| MSFT | mild_trend_down | eod |
| MSFT | mild_trend_up | eod |
| MSTR | extreme_up | itm_touch |
| MSTR | strong_trend_up | itm_touch |
| MU | mild_trend_down | eod |
| MU | mild_trend_up | eod |
| MU | strong_trend_up | eod |
| NDXP | chop | eod |
| NDXP | mild_trend_up | eod |
| NVDA | chop | eod |
| NVDA | mild_trend_up | eod |
| NVDA | strong_trend_up | eod |
| QQQ | chop | eod |
| QQQ | mild_trend_up | eod |
| SMH | chop | itm_touch |
| SMH | mild_trend_up | itm_touch |
| SNDK | chop | itm_touch |
| SNDK | extreme_up | itm_touch |
| SNDK | mild_trend_up | itm_touch |
| SNDK | strong_trend_down | itm_touch |
| SPXW | chop | eod |
| SPXW | mild_trend_up | eod |
| SPY | chop | itm_touch |
| SPY | mild_trend_up | eod |
| TSLA | chop | itm_touch |
| TSLA | mild_trend_up | eod |
