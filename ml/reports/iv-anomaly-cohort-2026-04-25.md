# IV-Anomaly Cohort (Phase D3) — 2026-04-25
**Sample:** 15,886 alerts, 1,487 unique compound keys, 388 single-firing.

## Per-day win rate

Reveals whether headline numbers were driven by one anomalous day.

| date | n | win% | mean% | mean $ |
| --- | ---: | ---: | ---: | ---: |
| 2026-04-13 | 1,625 | 21.4% | 7.0% | $1 |
| 2026-04-14 | 2,220 | 11.8% | -66.0% | $-65 |
| 2026-04-15 | 2,492 | 3.9% | -84.0% | $-121 |
| 2026-04-16 | 994 | 2.3% | -75.0% | $-123 |
| 2026-04-17 | 1,725 | 4.5% | -85.0% | $-112 |
| 2026-04-20 | 1,131 | 9.7% | -68.0% | $-30 |
| 2026-04-21 | 1,222 | 25.6% | 86.0% | $-53 |
| 2026-04-22 | 1,008 | 10.9% | -62.0% | $-32 |
| 2026-04-23 | 900 | 6.8% | -81.0% | $-70 |
| 2026-04-24 | 1,089 | 5.6% | -71.0% | $-54 |

## First-of-day vs subsequent firings

| is_first_of_day | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 4,533 | 23.0% | -0.0% | $-13 |
| False | put | 8,523 | 2.5% | -80.0% | $-102 |
| True | call | 509 | 34.4% | -2.0% | $211 |
| True | put | 841 | 3.6% | -73.0% | $-225 |

## Single-firing keys vs multi-firing

Hypothesis: a key that fires once and never repeats may be noise vs a persistent setup.

| is_single_firing | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| False | call | 4,942 | 23.8% | -0.0% | $-8 |
| False | put | 9,187 | 2.6% | -80.0% | $-108 |
| True | call | 100 | 40.0% | -17.0% | $907 |
| True | put | 177 | 2.8% | -77.0% | $-377 |

## Firing-index bucket (1st, 2-5th, 6-20th, 21+)

| fi_bucket | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| 1st | call | 509 | 34.4% | -2.0% | $211 |
| 1st | put | 841 | 3.6% | -73.0% | $-225 |
| 2nd-5th | call | 1,323 | 29.6% | 2.0% | $-21 |
| 2nd-5th | put | 2,238 | 3.9% | -62.0% | $-164 |
| 6th-20th | call | 2,194 | 24.2% | 1.0% | $-3 |
| 6th-20th | put | 4,055 | 2.9% | -82.0% | $-103 |
| 21st+ | call | 1,016 | 11.6% | -7.0% | $-25 |
| 21st+ | put | 2,230 | 0.5% | -95.0% | $-40 |

## Alert-density quartile (regime proxy)

Days where lots of alerts fire across all tickers vs quiet days.

| density_q | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| q1_lowest | call | 1,760 | 22.4% | 19.0% | $-8 |
| q1_lowest | put | 2,364 | 4.7% | -59.0% | $-113 |
| q2 | call | 1,408 | 34.9% | 45.0% | $102 |
| q2 | put | 2,437 | 1.1% | -85.0% | $-96 |
| q3 | call | 1,056 | 24.1% | -40.0% | $-15 |
| q3 | put | 2,889 | 2.9% | -87.0% | $-111 |
| q4_highest | call | 818 | 9.2% | -71.0% | $-78 |
| q4_highest | put | 1,674 | 1.4% | -90.0% | $-142 |
