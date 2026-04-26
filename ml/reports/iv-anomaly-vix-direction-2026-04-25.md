# IV-Anomaly VIX Direction (Phase E3) — 2026-04-25

**Sample:** 15,886 alerts; 7,970 with VIX features computed.

**Method:** for each alert, computes VIX change over the 30-min window ending at alert_ts. Rising = +0.2pt or more; falling = -0.2pt or more; flat = in between.

## VIX regime × side (aggregate)

| vix_regime | side |     n |  win% |  mean% | mean $ |
| ---------- | ---- | ----: | ----: | -----: | -----: |
| falling    | call |   181 | 16.6% | -56.0% |  $-182 |
| falling    | put  |   207 | 18.4% |  51.0% |   $-10 |
| flat       | call | 2,521 | 23.6% |  -5.0% |     $1 |
| flat       | put  | 3,768 |  2.4% | -77.0% |  $-114 |
| rising     | call |    55 |  5.5% | -91.0% |   $234 |
| rising     | put  |   273 |  0.0% | -90.0% |  $-199 |
| unknown    | call | 2,193 | 26.5% |  12.0% |    $33 |
| unknown    | put  | 4,925 |  1.9% | -88.0% |  $-113 |

## Outer regime × VIX direction × side

| regime        | vix_regime | side |     n |  win% |  mean% | mean $ |
| ------------- | ---------- | ---- | ----: | ----: | -----: | -----: |
| chop          | falling    | call |   118 | 17.8% | -67.0% |   $-87 |
| chop          | falling    | put  |   137 | 27.7% | 119.0% |    $66 |
| chop          | flat       | call | 2,011 | 19.4% | -16.0% |   $-19 |
| chop          | flat       | put  | 2,691 |  3.1% | -72.0% |  $-106 |
| chop          | rising     | call |    55 |  5.5% | -91.0% |   $234 |
| chop          | rising     | put  |   266 |  0.0% | -91.0% |  $-202 |
| chop          | unknown    | call | 1,067 | 11.9% | -53.0% |   $-72 |
| chop          | unknown    | put  | 2,441 |  3.4% | -85.0% |  $-139 |
| mild_trend_up | falling    | call |    63 | 14.3% | -35.0% |  $-359 |
| mild_trend_up | falling    | put  |    69 |  0.0% | -83.0% |  $-160 |
| mild_trend_up | flat       | call |   500 | 41.0% |  43.0% |    $88 |
| mild_trend_up | flat       | put  | 1,057 |  0.8% | -90.0% |  $-139 |
| mild_trend_up | unknown    | call | 1,097 | 41.3% |  79.0% |   $145 |
| mild_trend_up | unknown    | put  | 2,440 |  0.4% | -91.0% |   $-81 |
