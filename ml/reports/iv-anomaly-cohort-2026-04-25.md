# IV-Anomaly Cohort (Phase D3) — 2026-04-25

**Sample:** 15,886 alerts, 1,487 unique compound keys, 388 single-firing.

## Per-day win rate

Reveals whether headline numbers were driven by one anomalous day.

| date       |     n |  win% |  mean% | mean $ |
| ---------- | ----: | ----: | -----: | -----: |
| 2026-04-13 | 1,625 | 21.4% |   7.0% |     $1 |
| 2026-04-14 | 2,092 | 12.1% | -67.0% |   $-64 |
| 2026-04-15 | 2,483 |  3.7% | -85.0% |  $-121 |
| 2026-04-16 |   892 |  1.6% | -78.0% |  $-127 |
| 2026-04-17 | 1,682 |  3.6% | -87.0% |  $-114 |
| 2026-04-20 | 1,125 | 10.0% | -67.0% |   $-29 |
| 2026-04-21 | 1,222 | 25.6% |  86.0% |   $-53 |
| 2026-04-22 | 1,013 | 11.8% | -61.0% |   $-32 |
| 2026-04-23 |   900 |  6.8% | -81.0% |   $-70 |
| 2026-04-24 | 1,089 |  5.6% | -72.0% |   $-54 |

## First-of-day vs subsequent firings

| is_first_of_day | side |     n |  win% |  mean% | mean $ |
| --------------- | ---- | ----: | ----: | -----: | -----: |
| False           | call | 4,445 | 23.3% |   0.0% |   $-12 |
| False           | put  | 8,341 |  2.4% | -81.0% |  $-102 |
| True            | call |   505 | 34.6% |  -2.0% |   $213 |
| True            | put  |   832 |  3.4% | -74.0% |  $-226 |

## Single-firing keys vs multi-firing

Hypothesis: a key that fires once and never repeats may be noise vs a persistent setup.

| is_single_firing | side |     n |  win% |  mean% | mean $ |
| ---------------- | ---- | ----: | ----: | -----: | -----: |
| False            | call | 4,850 | 24.1% |   0.0% |    $-8 |
| False            | put  | 8,996 |  2.4% | -81.0% |  $-108 |
| True             | call |   100 | 40.0% | -17.0% |   $907 |
| True             | put  |   177 |  2.8% | -77.0% |  $-377 |

## Firing-index bucket (1st, 2-5th, 6-20th, 21+)

| fi_bucket | side |     n |  win% |  mean% | mean $ |
| --------- | ---- | ----: | ----: | -----: | -----: |
| 1st       | call |   505 | 34.6% |  -2.0% |   $213 |
| 1st       | put  |   832 |  3.4% | -74.0% |  $-226 |
| 2nd-5th   | call | 1,309 | 29.7% |   2.0% |   $-20 |
| 2nd-5th   | put  | 2,202 |  3.6% | -63.0% |  $-165 |
| 6th-20th  | call | 2,167 | 24.3% |   1.0% |    $-2 |
| 6th-20th  | put  | 3,969 |  2.8% | -83.0% |  $-103 |
| 21st+     | call |   969 | 12.4% |  -5.0% |   $-23 |
| 21st+     | put  | 2,170 |  0.3% | -96.0% |   $-38 |

## Alert-density quartile (regime proxy)

Days where lots of alerts fire across all tickers vs quiet days.

| density_q  | side |     n |  win% |  mean% | mean $ |
| ---------- | ---- | ----: | ----: | -----: | -----: |
| q1_lowest  | call | 1,739 | 22.7% |  21.0% |    $-8 |
| q1_lowest  | put  | 2,288 |  4.9% | -59.0% |  $-113 |
| q2         | call | 1,402 | 35.3% |  45.0% |   $103 |
| q2         | put  | 2,437 |  1.1% | -84.0% |   $-96 |
| q3         | call |   991 | 24.7% | -42.0% |   $-13 |
| q3         | put  | 2,783 |  2.5% | -88.0% |  $-112 |
| q4_highest | call |   818 |  9.2% | -71.0% |   $-78 |
| q4_highest | put  | 1,665 |  1.0% | -92.0% |  $-143 |
