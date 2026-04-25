# IV-Anomaly GEX Position (Phase E4) — 2026-04-25
**Sample:** 15,886 alerts; 11,702 with GEX features computed.

**Method:** for each alert, finds the top-3 abs_gex strikes for that (date, expiry) and checks the position of the *nearest* one relative to current spot. `alert_in_gex_zone` is true when the alert strike is between spot and the nearest top-3 GEX.

## Nearest top-3 GEX above/below spot × side

| gex_above_or_below | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| above_spot | call | 3,497 | 20.5% | -0.0% | $-16 |
| above_spot | put | 5,554 | 2.8% | -77.0% | $-64 |
| below_spot | call | 503 | 40.2% | 62.0% | $401 |
| below_spot | put | 1,381 | 0.4% | -93.0% | $-194 |
| missing | call | 1,042 | 28.5% | -32.0% | $-93 |
| missing | put | 2,429 | 3.5% | -78.0% | $-179 |

## Alert strike in gamma zone × side

| alert_in_gex_zone | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 2,525 | 30.1% | -3.0% | $-37 |
| False | put | 7,490 | 2.4% | -81.0% | $-109 |
| True | call | 2,517 | 18.2% | 2.0% | $56 |
| True | put | 1,874 | 3.6% | -74.0% | $-130 |

## SPX-family: regime × GEX position × side

| regime | gex_above_or_below | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | above_spot | call | 1,415 | 14.2% | -24.0% | $-5 |
| chop | above_spot | put | 2,416 | 2.1% | -89.0% | $-43 |
| chop | below_spot | call | 245 | 32.2% | -27.0% | $230 |
| chop | below_spot | put | 558 | 0.0% | -91.0% | $-201 |
| chop | missing | call | 475 | 17.5% | -53.0% | $-104 |
| chop | missing | put | 780 | 2.8% | -77.0% | $-176 |
| extreme_up | above_spot | call | 161 | 14.3% | -43.0% | $-19 |
| extreme_up | above_spot | put | 371 | 0.0% | -97.0% | $-38 |
| extreme_up | missing | call | 53 | 62.3% | -4.0% | $-2 |
| extreme_up | missing | put | 203 | 24.6% | -48.0% | $-48 |
| mild_trend_down | above_spot | call | 95 | 27.4% | -42.0% | $-5 |
| mild_trend_down | below_spot | put | 51 | 0.0% | -100.0% | $-32 |
| mild_trend_down | missing | put | 32 | 3.1% | -37.0% | $-265 |
| mild_trend_up | above_spot | call | 988 | 35.6% | 85.0% | $-27 |
| mild_trend_up | above_spot | put | 1,644 | 3.4% | -57.0% | $-105 |
| mild_trend_up | below_spot | call | 70 | 42.9% | -6.0% | $889 |
| mild_trend_up | below_spot | put | 254 | 2.4% | -96.0% | $-125 |
| mild_trend_up | missing | call | 335 | 34.6% | -17.0% | $-84 |
| mild_trend_up | missing | put | 882 | 0.1% | -87.0% | $-175 |
| strong_trend_up | above_spot | call | 302 | 5.6% | -69.0% | $-35 |
| strong_trend_up | above_spot | put | 472 | 0.6% | -79.0% | $-79 |
| strong_trend_up | below_spot | call | 179 | 46.9% | 212.0% | $455 |
| strong_trend_up | below_spot | put | 518 | 0.0% | -94.0% | $-237 |
| strong_trend_up | missing | call | 83 | 62.6% | 27.0% | $172 |
| strong_trend_up | missing | put | 297 | 0.0% | -89.0% | $-309 |
