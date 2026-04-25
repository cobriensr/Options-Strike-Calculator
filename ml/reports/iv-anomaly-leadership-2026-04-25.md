# IV-Anomaly Leadership (Phase E1) — 2026-04-25
**Sample:** 15,886 alerts; 15,876 with leadership features computed.

**Method:** for each alert, computes correlations (SPX vs NQ/ES/RTY) and cumulative-return signs over the 15-minute window ending at alert_ts. Direction consistent = SPX, NQ, ES, RTY, AND the alerted underlying ALL moved the same direction. Alignment = SPX direction matches alert direction (call→up, put→down).

**Caveat:** SPX has 6.5h cash-session coverage; futures cover 24h. Alerts outside SPX session show 'missing' alignment (~few percent of sample).

## Aggregate — alignment vs side

Direct test of the user's question: alerts on tape that already agrees vs disagrees.

| alignment | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| aligned | call | 2,962 | 24.3% | -2.0% | $-8 |
| aligned | put | 2,649 | 2.0% | -87.0% | $-135 |
| contradicted | call | 1,987 | 24.6% | 2.0% | $40 |
| contradicted | put | 6,517 | 2.6% | -78.0% | $-104 |
| missing | call | 1 | 100.0% | 0.0% | $2 |
| missing | put | 7 | 14.3% | -74.0% | $-711 |

## Aggregate — direction_consistent vs side

All 5 of (SPX, NQ, ES, RTY, underlying) moved same direction over 15-min window.

| direction_consistent | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 1,897 | 22.3% | 3.0% | $-5 |
| False | put | 3,166 | 2.3% | -77.0% | $-99 |
| True | call | 3,053 | 25.8% | -2.0% | $21 |
| True | put | 6,007 | 2.5% | -82.0% | $-121 |

## Per-regime × alignment × side

Layered on top of D0's regime spine.

| regime | alignment | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | aligned | call | 1,730 | 13.1% | -40.0% | $-63 |
| chop | aligned | put | 1,905 | 2.3% | -85.0% | $-158 |
| chop | contradicted | call | 1,521 | 20.7% | -21.0% | $-3 |
| chop | contradicted | put | 3,624 | 4.4% | -68.0% | $-100 |
| mild_trend_up | aligned | call | 1,208 | 40.8% | 55.0% | $78 |
| mild_trend_up | aligned | put | 713 | 1.1% | -92.0% | $-75 |
| mild_trend_up | contradicted | call | 451 | 38.4% | 86.0% | $192 |
| mild_trend_up | contradicted | put | 2,859 | 0.4% | -90.0% | $-105 |

## Per-ticker × alignment × side

| ticker | alignment | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| IWM | aligned | call | 91 | 20.9% | -27.0% | $-6 |
| IWM | aligned | put | 85 | 7.1% | -73.0% | $-26 |
| IWM | contradicted | call | 65 | 47.7% | 247.0% | $2 |
| IWM | contradicted | put | 181 | 5.0% | -71.0% | $-15 |
| META | aligned | call | 49 | 65.3% | 56.0% | $41 |
| META | contradicted | put | 51 | 13.7% | -20.0% | $-9 |
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
| SPY | aligned | call | 882 | 16.9% | -28.0% | $-12 |
| SPY | aligned | put | 775 | 1.4% | -87.0% | $-51 |
| SPY | contradicted | call | 579 | 17.8% | -24.0% | $-1 |
| SPY | contradicted | put | 2,056 | 5.2% | -83.0% | $-47 |
| TSLA | aligned | call | 206 | 7.3% | -68.0% | $-46 |
| TSLA | aligned | put | 171 | 2.3% | -86.0% | $-59 |
| TSLA | contradicted | call | 200 | 5.0% | -75.0% | $-49 |
| TSLA | contradicted | put | 307 | 1.9% | -79.0% | $-62 |
