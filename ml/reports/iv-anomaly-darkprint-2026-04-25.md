# IV-Anomaly Dark-Print Proximity (Phase E2) — 2026-04-25
**Sample:** 3,191 SPXW alerts (E2 is SPXW-only; dark_pool_levels is SPX-attributed only). 1,751 have non-zero dark-print premium at the alerted strike.

**Bands:**

- `at_strike` — alert strike ± 5pts (SPX 5-pt grid; basically same strike)
- `near_strike` — alert strike ± 25pts (broader magnetic zone)

## At-strike DP premium bucket × side

| dp_prem_at_strike | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| none | call | 734 | 19.8% | -8.0% | $-75 |
| none | put | 653 | 2.8% | -73.0% | $-587 |
| 200to500M | call | 85 | 35.3% | 31.0% | $263 |
| 200to500M | put | 246 | 2.4% | -90.0% | $-176 |
| 500Mplus | call | 203 | 24.6% | -14.0% | $67 |
| 500Mplus | put | 1,144 | 3.1% | -47.0% | $-168 |

## At-strike DP premium × regime × side

| regime | dp_bucket | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | none | call | 269 | 20.4% | -28.0% | $-55 |
| chop | none | put | 257 | 2.3% | -68.0% | $-514 |
| chop | 200to500M | put | 148 | 0.0% | -100.0% | $-166 |
| chop | 500Mplus | put | 276 | 0.0% | -100.0% | $-103 |
| mild_trend_down | none | call | 80 | 10.0% | -72.0% | $-151 |
| mild_trend_down | 500Mplus | put | 54 | 0.0% | -96.0% | $-95 |
| mild_trend_up | none | call | 208 | 2.4% | -85.0% | $-190 |
| mild_trend_up | none | put | 159 | 6.9% | -72.0% | $-687 |
| mild_trend_up | 200to500M | call | 35 | 0.0% | -100.0% | $-92 |
| mild_trend_up | 200to500M | put | 34 | 17.6% | -30.0% | $-130 |
| mild_trend_up | 500Mplus | call | 162 | 7.4% | -73.0% | $-319 |
| mild_trend_up | 500Mplus | put | 412 | 8.7% | 45.0% | $-221 |
| strong_trend_up | none | call | 177 | 43.5% | 140.0% | $62 |
| strong_trend_up | none | put | 216 | 0.0% | -83.0% | $-631 |
| strong_trend_up | 200to500M | call | 30 | 66.7% | 194.0% | $681 |
| strong_trend_up | 200to500M | put | 64 | 0.0% | -99.0% | $-224 |
| strong_trend_up | 500Mplus | call | 36 | 91.7% | 242.0% | $1,783 |
| strong_trend_up | 500Mplus | put | 402 | 0.0% | -98.0% | $-167 |

## Share of day's total DP premium at this strike

| share_bucket | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| lt5pct | call | 397 | 12.3% | -77.0% | $-76 |
| lt5pct | put | 249 | 0.8% | -59.0% | $-744 |
| 5to15pct | call | 129 | 24.8% | 181.0% | $-73 |
| 5to15pct | put | 165 | 7.3% | -84.0% | $-450 |
| 15to30pct | call | 132 | 16.7% | 1.0% | $72 |
| 15to30pct | put | 115 | 3.5% | -73.0% | $-530 |
| 30to50pct | call | 184 | 29.9% | 12.0% | $79 |
| 30to50pct | put | 286 | 3.1% | -89.0% | $-489 |
| 50plus | call | 194 | 36.6% | -13.0% | $-19 |
| 50plus | put | 1,268 | 2.6% | -51.0% | $-127 |
