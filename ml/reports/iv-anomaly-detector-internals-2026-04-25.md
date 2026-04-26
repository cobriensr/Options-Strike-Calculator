# IV-Anomaly Detector Internals (Phase D4) — 2026-04-25

**Sample:** 15,886 alerts.

**Pattern definitions:**

- `flash` — duration <5 min AND firing_count <3
- `persistent` — duration ≥60 min OR firing_count ≥20
- `medium` — everything else

**Time-to-first-firing buckets:** time from session open (08:30 CT) to first firing of that (compound_key, date).

## Pattern (flash / medium / persistent) × side

| pattern    | side |     n |  win% |  mean% | mean $ |
| ---------- | ---- | ----: | ----: | -----: | -----: |
| flash      | call |   176 | 34.7% | -31.0% |   $636 |
| flash      | put  |   261 |  3.1% | -77.0% |  $-327 |
| medium     | call | 1,835 | 30.5% |  16.0% |   $-44 |
| medium     | put  | 2,743 |  3.2% | -69.0% |  $-185 |
| persistent | call | 2,939 | 20.0% |  -9.0% |     $8 |
| persistent | put  | 6,169 |  2.1% | -86.0% |   $-73 |

## Firing-count bucket × side

| fc_bucket | side |     n |  win% |  mean% | mean $ |
| --------- | ---- | ----: | ----: | -----: | -----: |
| fc_1      | call |   100 | 40.0% | -17.0% |   $907 |
| fc_1      | put  |   177 |  2.8% | -77.0% |  $-377 |
| fc_2to5   | call |   505 | 34.3% | -15.0% |   $-89 |
| fc_2to5   | put  |   717 |  1.9% | -77.0% |  $-258 |
| fc_6to20  | call | 1,844 | 27.7% |  14.0% |    $14 |
| fc_6to20  | put  | 3,440 |  4.7% | -64.0% |  $-170 |
| fc_21plus | call | 2,501 | 19.5% |  -7.0% |    $-8 |
| fc_21plus | put  | 4,839 |  0.9% | -93.0% |   $-43 |

## Duration bucket × side

| dur_bucket    | side |     n |  win% |  mean% | mean $ |
| ------------- | ---- | ----: | ----: | -----: | -----: |
| dur_under5min | call |   282 | 36.2% | -19.0% |   $340 |
| dur_under5min | put  |   361 |  3.3% | -77.0% |  $-315 |
| dur_5to60min  | call | 2,735 | 23.8% |  -5.0% |   $-30 |
| dur_5to60min  | put  | 3,936 |  2.2% | -75.0% |  $-136 |
| dur_over1hr   | call | 1,933 | 23.7% |  10.0% |    $20 |
| dur_over1hr   | put  | 4,876 |  2.6% | -86.0% |   $-81 |

## Time-to-first-firing × side

| ttf_bucket | side |     n |  win% |   mean% | mean $ |
| ---------- | ---- | ----: | ----: | ------: | -----: |
| midday     | put  |   349 |  0.0% | -100.0% |   $-86 |
| afternoon  | call | 4,950 | 24.4% |   -0.0% |    $11 |
| afternoon  | put  | 8,824 |  2.5% |  -80.0% |  $-115 |

## Pattern × regime × side

| regime        | pattern    | side |     n |  win% |  mean% | mean $ |
| ------------- | ---------- | ---- | ----: | ----: | -----: | -----: |
| chop          | flash      | call |   110 | 27.3% | -46.0% |   $298 |
| chop          | flash      | put  |   147 |  1.4% | -80.0% |  $-438 |
| chop          | medium     | call | 1,182 | 22.4% | -28.0% |   $-86 |
| chop          | medium     | put  | 1,522 |  5.1% | -57.0% |  $-180 |
| chop          | persistent | call | 1,959 | 12.6% | -33.0% |   $-23 |
| chop          | persistent | put  | 3,866 |  3.3% | -81.0% |   $-85 |
| mild_trend_up | flash      | call |    62 | 48.4% |  -4.0% | $1,279 |
| mild_trend_up | flash      | put  |   105 |  5.7% | -73.0% |  $-196 |
| mild_trend_up | medium     | call |   640 | 46.1% | 101.0% |    $53 |
| mild_trend_up | medium     | put  | 1,169 |  0.9% | -83.0% |  $-183 |
| mild_trend_up | persistent | call |   958 | 35.7% |  43.0% |    $71 |
| mild_trend_up | persistent | put  | 2,299 |  0.1% | -95.0% |   $-53 |

## Time-to-first × regime × side

| regime          | ttf_bucket | side |     n |  win% |   mean% | mean $ |
| --------------- | ---------- | ---- | ----: | ----: | ------: | -----: |
| chop            | midday     | put  |   115 |  0.0% | -100.0% |  $-105 |
| chop            | afternoon  | call | 3,251 | 16.7% |  -32.0% |   $-35 |
| chop            | afternoon  | put  | 5,420 |  3.8% |  -74.0% |  $-121 |
| mild_trend_down | afternoon  | put  |    30 |  0.0% |  -66.0% |   $-46 |
| mild_trend_up   | midday     | put  |   234 |  0.0% | -100.0% |   $-76 |
| mild_trend_up   | afternoon  | call | 1,660 | 40.2% |   64.0% |   $109 |
| mild_trend_up   | afternoon  | put  | 3,339 |  0.6% |  -90.0% |  $-101 |
