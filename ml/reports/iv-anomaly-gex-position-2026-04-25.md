# IV-Anomaly GEX Position (Phase E4) — 2026-04-25
**Sample:** 15,886 alerts; 11,702 with GEX features computed.

**Method:** for each alert, finds the top-3 abs_gex strikes for that (date, expiry) and checks the position of the *nearest* one relative to current spot. `alert_in_gex_zone` is true when the alert strike is between spot and the nearest top-3 GEX.

## Nearest top-3 GEX above/below spot × side

| gex_above_or_below | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| above_spot | call | 3,405 | 20.9% | 1.0% | $-15 |
| above_spot | put | 5,363 | 2.5% | -78.0% | $-64 |
| below_spot | call | 503 | 40.2% | 62.0% | $401 |
| below_spot | put | 1,381 | 0.4% | -93.0% | $-194 |
| missing | call | 1,042 | 28.5% | -32.0% | $-93 |
| missing | put | 2,429 | 3.5% | -78.0% | $-179 |

## Alert strike in gamma zone × side

| alert_in_gex_zone | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 2,434 | 30.6% | -2.0% | $-36 |
| False | put | 7,479 | 2.3% | -81.0% | $-109 |
| True | call | 2,516 | 18.4% | 2.0% | $56 |
| True | put | 1,694 | 2.9% | -77.0% | $-135 |

## SPX-family: regime × GEX position × side

| regime | gex_above_or_below | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | above_spot | call | 2,048 | 13.7% | -23.0% | $-29 |
| chop | above_spot | put | 3,033 | 3.6% | -70.0% | $-67 |
| chop | below_spot | call | 308 | 22.1% | -47.0% | $114 |
| chop | below_spot | put | 951 | 0.6% | -92.0% | $-219 |
| chop | missing | call | 622 | 24.3% | -43.0% | $-134 |
| chop | missing | put | 1,250 | 5.5% | -75.0% | $-196 |
| mild_trend_up | above_spot | call | 827 | 39.7% | 81.0% | $19 |
| mild_trend_up | above_spot | put | 1,758 | 0.2% | -93.0% | $-63 |
| mild_trend_up | below_spot | call | 195 | 68.7% | 234.0% | $854 |
| mild_trend_up | below_spot | put | 430 | 0.0% | -97.0% | $-138 |
| mild_trend_up | missing | call | 338 | 39.4% | -10.0% | $24 |
| mild_trend_up | missing | put | 944 | 0.5% | -85.0% | $-166 |
