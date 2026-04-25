# IV-Anomaly VIX Direction (Phase E3) — 2026-04-25
**Sample:** 15,886 alerts; 9,310 with VIX features computed.

**Method:** for each alert, computes VIX change over the 30-min window ending at alert_ts. Rising = +0.2pt or more; falling = -0.2pt or more; flat = in between.

## VIX regime × side (aggregate)

| vix_regime | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| falling | call | 258 | 15.1% | -57.0% | $-170 |
| falling | put | 324 | 18.5% | 107.0% | $7 |
| flat | call | 2,891 | 21.2% | -8.0% | $-8 |
| flat | put | 4,365 | 2.0% | -85.0% | $-118 |
| rising | call | 74 | 4.0% | -92.0% | $170 |
| rising | put | 356 | 1.7% | -87.0% | $-173 |
| unknown | call | 1,819 | 30.8% | 23.0% | $57 |
| unknown | put | 4,319 | 2.1% | -88.0% | $-112 |

## Outer regime × VIX direction × side

| regime | vix_regime | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | falling | call | 92 | 17.4% | -56.0% | $-260 |
| chop | falling | put | 78 | 44.9% | 12.0% | $-5 |
| chop | flat | call | 1,856 | 19.9% | -21.0% | $16 |
| chop | flat | put | 3,008 | 1.9% | -86.0% | $-84 |
| chop | rising | call | 60 | 0.0% | -98.0% | $-17 |
| chop | rising | put | 306 | 0.0% | -92.0% | $-195 |
| chop | unknown | call | 215 | 5.6% | -82.0% | $-25 |
| chop | unknown | put | 483 | 0.0% | -94.0% | $-90 |
| extreme_down | flat | call | 171 | 1.2% | -78.0% | $-30 |
| extreme_down | flat | put | 160 | 7.5% | -78.0% | $-38 |
| extreme_down | rising | put | 33 | 18.2% | -55.0% | $-28 |
| extreme_up | unknown | call | 294 | 28.6% | -1.0% | $-8 |
| extreme_up | unknown | put | 744 | 7.4% | -77.0% | $-39 |
| mild_trend_down | flat | call | 118 | 29.7% | -44.0% | $-87 |
| mild_trend_down | flat | put | 106 | 0.9% | -77.0% | $-107 |
| mild_trend_down | unknown | call | 33 | 3.0% | -96.0% | $-21 |
| mild_trend_down | unknown | put | 31 | 29.0% | -2.0% | $-164 |
| mild_trend_up | falling | call | 58 | 24.1% | -54.0% | $-277 |
| mild_trend_up | falling | put | 104 | 24.0% | 442.0% | $181 |
| mild_trend_up | flat | call | 529 | 32.7% | 87.0% | $-28 |
| mild_trend_up | flat | put | 650 | 2.8% | -86.0% | $-230 |
| mild_trend_up | unknown | call | 1,014 | 34.5% | 26.0% | $14 |
| mild_trend_up | unknown | put | 2,284 | 1.1% | -91.0% | $-109 |
| strong_trend_up | falling | call | 108 | 8.3% | -60.0% | $-35 |
| strong_trend_up | falling | put | 141 | 0.0% | -87.0% | $-115 |
| strong_trend_up | flat | call | 198 | 15.2% | -54.0% | $-98 |
| strong_trend_up | flat | put | 428 | 0.2% | -83.0% | $-222 |
| strong_trend_up | unknown | call | 260 | 43.9% | 140.0% | $417 |
| strong_trend_up | unknown | put | 766 | 0.5% | -87.0% | $-185 |
