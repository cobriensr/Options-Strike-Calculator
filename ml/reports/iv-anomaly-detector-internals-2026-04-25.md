# IV-Anomaly Detector Internals (Phase D4) — 2026-04-25
**Sample:** 15,886 alerts.

**Pattern definitions:**

- `flash` — duration <5 min AND firing_count <3
- `persistent` — duration ≥60 min OR firing_count ≥20
- `medium` — everything else

**Time-to-first-firing buckets:** time from session open (08:30 CT) to first firing of that (compound_key, date).

## Pattern (flash / medium / persistent) × side

| pattern | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| flash | call | 176 | 34.7% | -31.0% | $636 |
| flash | put | 259 | 2.7% | -78.0% | $-329 |
| medium | call | 1,848 | 29.8% | 16.0% | $-45 |
| medium | put | 2,767 | 3.6% | -67.0% | $-183 |
| persistent | call | 3,018 | 20.1% | -9.0% | $7 |
| persistent | put | 6,338 | 2.2% | -85.0% | $-74 |

## Firing-count bucket × side

| fc_bucket | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| fc_1 | call | 100 | 40.0% | -17.0% | $907 |
| fc_1 | put | 177 | 2.8% | -77.0% | $-377 |
| fc_2to5 | call | 508 | 34.1% | -15.0% | $-90 |
| fc_2to5 | put | 725 | 2.3% | -76.0% | $-255 |
| fc_6to20 | call | 1,854 | 27.0% | 13.0% | $14 |
| fc_6to20 | put | 3,472 | 4.9% | -63.0% | $-169 |
| fc_21plus | call | 2,580 | 19.5% | -7.0% | $-8 |
| fc_21plus | put | 4,990 | 1.1% | -92.0% | $-44 |

## Duration bucket × side

| dur_bucket | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| dur_under5min | call | 282 | 36.2% | -19.0% | $340 |
| dur_under5min | put | 359 | 3.1% | -77.0% | $-317 |
| dur_5to60min | call | 2,775 | 23.4% | -5.0% | $-30 |
| dur_5to60min | put | 3,960 | 2.5% | -74.0% | $-135 |
| dur_over1hr | call | 1,985 | 23.4% | 9.0% | $18 |
| dur_over1hr | put | 5,045 | 2.7% | -85.0% | $-82 |

## Time-to-first-firing × side

| ttf_bucket | side | n | win% | mean% | mean $ |
| --- | --- | ---: | ---: | ---: | ---: |
| midday | put | 360 | 0.0% | -100.0% | $-86 |
| afternoon | call | 5,042 | 24.1% | -1.0% | $10 |
| afternoon | put | 9,004 | 2.7% | -79.0% | $-114 |

## Pattern × regime × side

| regime | pattern | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | flash | call | 76 | 28.9% | -26.0% | $469 |
| chop | flash | put | 86 | 2.3% | -76.0% | $-408 |
| chop | medium | call | 838 | 23.9% | -15.0% | $-25 |
| chop | medium | put | 1,009 | 3.9% | -73.0% | $-183 |
| chop | persistent | call | 1,309 | 13.4% | -41.0% | $-12 |
| chop | persistent | put | 2,780 | 1.8% | -90.0% | $-49 |
| extreme_down | medium | put | 41 | 17.1% | -56.0% | $-374 |
| extreme_down | persistent | call | 155 | 0.0% | -81.0% | $-15 |
| extreme_down | persistent | put | 161 | 6.8% | -78.0% | $-43 |
| extreme_up | medium | call | 131 | 34.4% | 21.0% | $-20 |
| extreme_up | medium | put | 79 | 5.1% | -64.0% | $-72 |
| extreme_up | persistent | call | 167 | 23.4% | -18.0% | $-14 |
| extreme_up | persistent | put | 664 | 7.5% | -78.0% | $-34 |
| mild_trend_down | medium | call | 49 | 18.4% | -77.0% | $-227 |
| mild_trend_down | medium | put | 92 | 10.9% | -49.0% | $-134 |
| mild_trend_down | persistent | call | 100 | 26.0% | -45.0% | $2 |
| mild_trend_down | persistent | put | 36 | 0.0% | -79.0% | $-60 |
| mild_trend_up | flash | call | 63 | 41.3% | -31.0% | $1,099 |
| mild_trend_up | flash | put | 109 | 1.8% | -82.0% | $-324 |
| mild_trend_up | medium | call | 556 | 37.0% | 35.0% | $-109 |
| mild_trend_up | medium | put | 1,052 | 3.5% | -57.0% | $-130 |
| mild_trend_up | persistent | call | 985 | 31.3% | 53.0% | $-11 |
| mild_trend_up | persistent | put | 1,894 | 1.5% | -80.0% | $-110 |
| strong_trend_up | flash | put | 38 | 5.3% | -78.0% | $-293 |
| strong_trend_up | medium | call | 246 | 36.2% | 103.0% | $102 |
| strong_trend_up | medium | put | 494 | 0.6% | -82.0% | $-309 |
| strong_trend_up | persistent | call | 302 | 18.9% | -18.0% | $171 |
| strong_trend_up | persistent | put | 803 | 0.0% | -88.0% | $-112 |

## Time-to-first × regime × side

| regime | ttf_bucket | side | n | win% | mean% | mean $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| chop | midday | put | 104 | 0.0% | -100.0% | $-145 |
| chop | afternoon | call | 2,223 | 17.9% | -30.0% | $-1 |
| chop | afternoon | put | 3,771 | 2.4% | -85.0% | $-91 |
| extreme_down | afternoon | call | 185 | 1.1% | -80.0% | $-87 |
| extreme_down | afternoon | put | 204 | 8.8% | -73.0% | $-110 |
| extreme_up | midday | put | 57 | 0.0% | -100.0% | $-64 |
| extreme_up | afternoon | call | 313 | 28.4% | -3.0% | $-17 |
| extreme_up | afternoon | put | 701 | 7.8% | -75.0% | $-38 |
| mild_trend_down | afternoon | call | 151 | 23.8% | -56.0% | $-72 |
| mild_trend_down | afternoon | put | 137 | 7.3% | -60.0% | $-120 |
| mild_trend_up | midday | put | 199 | 0.0% | -100.0% | $-62 |
| mild_trend_up | afternoon | call | 1,604 | 33.7% | 43.0% | $-2 |
| mild_trend_up | afternoon | put | 2,856 | 2.4% | -70.0% | $-129 |
| strong_trend_up | afternoon | call | 566 | 27.0% | 34.0% | $150 |
| strong_trend_up | afternoon | put | 1,335 | 0.4% | -86.0% | $-190 |
