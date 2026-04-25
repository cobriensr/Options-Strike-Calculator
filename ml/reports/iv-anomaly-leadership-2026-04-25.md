# IV-Anomaly Leadership (Phase E1) — 2026-04-25
**Sample:** 15,886 alerts; 15,876 with leadership features computed.

**Method:** for each alert, computes correlations (SPX vs NQ/ES/RTY) and cumulative-return signs over the 15-minute window ending at alert_ts. Direction consistent = SPX, NQ, ES, RTY, AND the alerted underlying ALL moved the same direction. Alignment = SPX direction matches alert direction (call→up, put→down).

**Caveat:** SPX has 6.5h cash-session coverage; futures cover 24h. Alerts outside SPX session show 'missing' alignment (~few percent of sample).

## Aggregate — alignment vs side

Direct test of the user's question: alerts on tape that already agrees vs disagrees.

| alignment | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| aligned | call | 3,034 | 24.1% | -3.0% | $-10 |
| aligned | put | 2,718 | 2.5% | -85.0% | $-133 |
| contradicted | call | 2,007 | 24.1% | 2.0% | $39 |
| contradicted | put | 6,639 | 2.7% | -78.0% | $-104 |
| missing | call | 1 | 100.0% | 0.0% | $2 |
| missing | put | 7 | 14.3% | -74.0% | $-711 |

## Aggregate — direction_consistent vs side

All 5 of (SPX, NQ, ES, RTY, underlying) moved same direction over 15-min window.

| direction_consistent | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 1,938 | 21.7% | 2.0% | $-7 |
| False | put | 3,267 | 2.9% | -76.0% | $-98 |
| True | call | 3,104 | 25.7% | -2.0% | $20 |
| True | put | 6,097 | 2.5% | -82.0% | $-121 |

## Per-regime × alignment × side

Layered on top of D0's regime spine.

| regime | alignment | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | aligned | call | 1,315 | 13.7% | -49.0% | $-56 |
| chop | aligned | put | 1,343 | 1.5% | -86.0% | $-102 |
| chop | contradicted | call | 908 | 23.9% | -3.0% | $80 |
| chop | contradicted | put | 2,531 | 2.8% | -85.0% | $-87 |
| extreme_down | aligned | call | 73 | 1.4% | -86.0% | $-151 |
| extreme_down | aligned | put | 114 | 9.7% | -76.0% | $-50 |
| extreme_down | contradicted | call | 112 | 0.9% | -75.0% | $-46 |
| extreme_down | contradicted | put | 90 | 7.8% | -70.0% | $-185 |
| extreme_up | aligned | call | 214 | 31.8% | 8.0% | $-19 |
| extreme_up | aligned | put | 159 | 1.3% | -85.0% | $-42 |
| extreme_up | contradicted | call | 99 | 21.2% | -28.0% | $-12 |
| extreme_up | contradicted | put | 599 | 8.8% | -74.0% | $-39 |
| mild_trend_down | aligned | call | 67 | 16.4% | -62.0% | $-176 |
| mild_trend_down | aligned | put | 74 | 10.8% | -57.0% | $-81 |
| mild_trend_down | contradicted | call | 84 | 29.8% | -51.0% | $10 |
| mild_trend_down | contradicted | put | 60 | 1.7% | -65.0% | $-168 |
| mild_trend_up | aligned | call | 879 | 38.6% | 55.0% | $-1 |
| mild_trend_up | aligned | put | 885 | 3.0% | -87.0% | $-182 |
| mild_trend_up | contradicted | call | 725 | 27.7% | 30.0% | $-2 |
| mild_trend_up | contradicted | put | 2,168 | 1.9% | -66.0% | $-100 |
| strong_trend_up | aligned | call | 486 | 27.4% | 37.0% | $149 |
| strong_trend_up | aligned | put | 143 | 0.7% | -87.0% | $-322 |
| strong_trend_up | contradicted | call | 79 | 24.1% | 19.0% | $159 |
| strong_trend_up | contradicted | put | 1,191 | 0.3% | -86.0% | $-173 |

## Per-ticker × alignment × side

| ticker | alignment | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| IWM | aligned | call | 86 | 12.8% | -37.0% | $-7 |
| IWM | aligned | put | 84 | 7.1% | -73.0% | $-26 |
| IWM | contradicted | call | 65 | 46.1% | 244.0% | $1 |
| IWM | contradicted | put | 180 | 4.4% | -70.0% | $-15 |
| META | aligned | call | 49 | 65.3% | 56.0% | $41 |
| META | aligned | put | 35 | 34.3% | 30.0% | $-18 |
| META | contradicted | put | 55 | 14.6% | -17.0% | $-9 |
| MSFT | aligned | call | 58 | 55.2% | 122.0% | $23 |
| MSFT | aligned | put | 31 | 3.2% | -80.0% | $-37 |
| MSFT | contradicted | call | 40 | 47.5% | 6.0% | $16 |
| MSFT | contradicted | put | 40 | 5.0% | -87.0% | $-37 |
| NDXP | aligned | call | 65 | 52.3% | 3.0% | $364 |
| NDXP | contradicted | call | 31 | 90.3% | 50.0% | $3,225 |
| NVDA | aligned | put | 55 | 5.5% | -79.0% | $-11 |
| NVDA | contradicted | put | 75 | 1.3% | -82.0% | $-43 |
| QQQ | aligned | call | 1,027 | 27.3% | 14.0% | $-20 |
| QQQ | aligned | put | 920 | 0.1% | -94.0% | $-75 |
| QQQ | contradicted | call | 562 | 39.5% | 66.0% | $18 |
| QQQ | contradicted | put | 2,247 | 0.0% | -91.0% | $-67 |
| SPXW | aligned | call | 564 | 28.4% | 23.0% | $-2 |
| SPXW | aligned | put | 564 | 3.4% | -80.0% | $-405 |
| SPXW | contradicted | call | 471 | 14.4% | -43.0% | $-39 |
| SPXW | contradicted | put | 1,512 | 2.6% | -54.0% | $-256 |
| SPY | aligned | call | 957 | 17.6% | -28.0% | $-15 |
| SPY | aligned | put | 815 | 1.4% | -87.0% | $-54 |
| SPY | contradicted | call | 595 | 17.3% | -22.0% | $-1 |
| SPY | contradicted | put | 2,155 | 4.9% | -82.0% | $-50 |
| TSLA | aligned | call | 208 | 7.2% | -68.0% | $-47 |
| TSLA | aligned | put | 194 | 7.2% | -78.0% | $-54 |
| TSLA | contradicted | call | 204 | 3.4% | -75.0% | $-49 |
| TSLA | contradicted | put | 327 | 3.7% | -76.0% | $-62 |
