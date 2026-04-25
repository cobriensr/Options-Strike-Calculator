# IV-Anomaly Signal Magnitude (Phase D2) — 2026-04-25
**Sample:** 15,886 alerts, sliced by regime × side × signal-magnitude bucket.

**Key question:** does signal *strength* (e.g. 5σ z-score) predict better outcomes than signal *presence* alone? Phase C answered the count question (no). This answers magnitude.

## Z-score magnitude × regime × side

| regime | side | z_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | z_2to3 | 1,352 | 15.8% | -44.0% | $-35 | $-9 |
| chop | call | z_3to5 | 879 | 18.0% | -37.0% | $-31 | $-6 |
| chop | call | z_5plus | 179 | 16.2% | -41.0% | $-115 | $-6 |
| chop | call | z_lt_2 | 834 | 16.9% | -3.0% | $-22 | $-8 |
| chop | put | missing | 47 | 0.0% | -91.0% | $-250 | $-76 |
| chop | put | z_2to3 | 3,027 | 4.5% | -66.0% | $-106 | $-27 |
| chop | put | z_3to5 | 1,137 | 2.5% | -87.0% | $-119 | $-20 |
| chop | put | z_5plus | 238 | 3.4% | -85.0% | $-333 | $-9 |
| chop | put | z_lt_2 | 1,086 | 3.0% | -81.0% | $-112 | $-28 |
| mild_trend_up | call | z_2to3 | 651 | 43.2% | 39.0% | $99 | $-5 |
| mild_trend_up | call | z_3to5 | 364 | 39.8% | 125.0% | $109 | $-4 |
| mild_trend_up | call | z_5plus | 113 | 25.7% | 46.0% | $-60 | $-45 |
| mild_trend_up | call | z_lt_2 | 527 | 39.9% | 56.0% | $131 | $-9 |
| mild_trend_up | put | missing | 69 | 0.0% | -93.0% | $-113 | $-95 |
| mild_trend_up | put | z_2to3 | 1,930 | 0.5% | -90.0% | $-84 | $-31 |
| mild_trend_up | put | z_3to5 | 666 | 1.1% | -89.0% | $-126 | $-39 |
| mild_trend_up | put | z_5plus | 158 | 0.0% | -91.0% | $-192 | $-7 |
| mild_trend_up | put | z_lt_2 | 750 | 0.3% | -93.0% | $-94 | $-40 |

## Skew-delta magnitude × regime × side

| regime | side | skew_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | missing | 104 | 25.0% | -48.0% | $-14 | $-2 |
| chop | call | skew_01to025 | 735 | 15.8% | -52.0% | $-17 | $-9 |
| chop | call | skew_025to05 | 551 | 14.9% | -19.0% | $-30 | $-7 |
| chop | call | skew_05plus | 773 | 14.5% | 14.0% | $-25 | $-4 |
| chop | call | skew_lt_001 | 1,088 | 18.9% | -55.0% | $-59 | $-18 |
| chop | put | missing | 270 | 6.3% | -70.0% | $-183 | $-29 |
| chop | put | skew_01to025 | 1,290 | 2.9% | -82.0% | $-86 | $-15 |
| chop | put | skew_025to05 | 671 | 1.5% | -86.0% | $-98 | $-23 |
| chop | put | skew_05plus | 862 | 2.4% | -81.0% | $-152 | $-19 |
| chop | put | skew_lt_001 | 2,442 | 4.9% | -65.0% | $-127 | $-40 |
| mild_trend_up | call | missing | 67 | 29.9% | 155.0% | $60 | $-2 |
| mild_trend_up | call | skew_01to025 | 335 | 53.1% | 122.0% | $312 | $5 |
| mild_trend_up | call | skew_025to05 | 332 | 43.7% | 87.0% | $146 | $-9 |
| mild_trend_up | call | skew_05plus | 471 | 18.3% | -19.0% | $-61 | $-24 |
| mild_trend_up | call | skew_lt_001 | 455 | 52.3% | 76.0% | $115 | $1 |
| mild_trend_up | put | missing | 299 | 3.3% | -74.0% | $-118 | $-54 |
| mild_trend_up | put | skew_01to025 | 692 | 0.4% | -96.0% | $-61 | $-27 |
| mild_trend_up | put | skew_025to05 | 604 | 0.0% | -95.0% | $-70 | $-30 |
| mild_trend_up | put | skew_05plus | 538 | 0.2% | -89.0% | $-124 | $-43 |
| mild_trend_up | put | skew_lt_001 | 1,440 | 0.3% | -90.0% | $-117 | $-36 |

## Ask-mid divergence × regime × side

| regime | side | amd_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | amd_lt_03 | 3,227 | 16.7% | -32.0% | $-34 | $-8 |
| chop | put | amd_lt_03 | 5,490 | 3.7% | -74.0% | $-116 | $-26 |
| mild_trend_down | put | amd_lt_03 | 30 | 0.0% | -66.0% | $-46 | $-16 |
| mild_trend_up | call | amd_lt_03 | 1,651 | 40.3% | 64.0% | $110 | $-7 |
| mild_trend_up | put | amd_lt_03 | 3,548 | 0.5% | -90.0% | $-98 | $-35 |

## Vol/OI ratio × regime × side

| regime | side | vo_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | vo_10to50 | 1,544 | 15.1% | -34.0% | $-40 | $-9 |
| chop | call | vo_50to200 | 92 | 28.3% | 196.0% | $24 | $-8 |
| chop | call | vo_5to10 | 1,615 | 17.5% | -43.0% | $-33 | $-7 |
| chop | put | vo_10to50 | 2,058 | 4.8% | -54.0% | $-112 | $-22 |
| chop | put | vo_200plus | 938 | 3.7% | -89.0% | $-155 | $-65 |
| chop | put | vo_50to200 | 856 | 2.3% | -87.0% | $-114 | $-16 |
| chop | put | vo_5to10 | 1,683 | 3.0% | -84.0% | $-115 | $-15 |
| mild_trend_up | call | vo_10to50 | 734 | 40.3% | 54.0% | $59 | $-5 |
| mild_trend_up | call | vo_50to200 | 151 | 17.2% | -34.0% | $-30 | $-20 |
| mild_trend_up | call | vo_5to10 | 772 | 44.3% | 92.0% | $183 | $-4 |
| mild_trend_up | put | vo_10to50 | 1,215 | 0.4% | -91.0% | $-128 | $-36 |
| mild_trend_up | put | vo_200plus | 756 | 0.5% | -92.0% | $-76 | $-60 |
| mild_trend_up | put | vo_50to200 | 838 | 0.0% | -89.0% | $-48 | $-23 |
| mild_trend_up | put | vo_5to10 | 764 | 1.3% | -90.0% | $-133 | $-25 |

## Side-skew × regime × side

| regime | side | ss_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | ss_065to080 | 1,534 | 17.2% | -34.0% | $-37 | $-11 |
| chop | call | ss_080to095 | 1,117 | 16.5% | -33.0% | $-35 | $-6 |
| chop | call | ss_095plus | 600 | 15.7% | -23.0% | $-29 | $-4 |
| chop | put | ss_065to080 | 2,374 | 3.0% | -81.0% | $-133 | $-34 |
| chop | put | ss_080to095 | 2,115 | 4.4% | -67.0% | $-109 | $-20 |
| chop | put | ss_095plus | 1,046 | 3.8% | -72.0% | $-116 | $-15 |
| mild_trend_up | call | ss_065to080 | 795 | 40.9% | 71.0% | $110 | $-8 |
| mild_trend_up | call | ss_080to095 | 592 | 37.7% | 58.0% | $91 | $-7 |
| mild_trend_up | call | ss_095plus | 273 | 43.6% | 54.0% | $142 | $-4 |
| mild_trend_up | put | ss_065to080 | 1,468 | 0.5% | -91.0% | $-107 | $-43 |
| mild_trend_up | put | ss_080to095 | 1,411 | 0.6% | -90.0% | $-83 | $-29 |
| mild_trend_up | put | ss_095plus | 694 | 0.4% | -90.0% | $-117 | $-30 |

## Composite intensity quartile × regime × side

| regime | side | intensity_q | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | q1_low | 879 | 19.0% | -31.0% | $-30 | $-13 |
| chop | call | q2 | 715 | 15.9% | -49.0% | $-32 | $-11 |
| chop | call | q3 | 868 | 17.1% | -16.0% | $-29 | $-7 |
| chop | call | q4_high | 789 | 14.3% | -32.0% | $-50 | $-3 |
| chop | put | q1_low | 1,287 | 5.4% | -67.0% | $-123 | $-32 |
| chop | put | q2 | 1,494 | 4.2% | -58.0% | $-107 | $-26 |
| chop | put | q3 | 1,426 | 3.3% | -85.0% | $-105 | $-18 |
| chop | put | q4_high | 1,328 | 2.0% | -88.0% | $-150 | $-26 |
| mild_trend_up | call | q1_low | 549 | 48.3% | 75.0% | $136 | $-1 |
| mild_trend_up | call | q2 | 350 | 48.3% | 52.0% | $148 | $0 |
| mild_trend_up | call | q3 | 344 | 36.6% | 59.0% | $204 | $-9 |
| mild_trend_up | call | q4_high | 417 | 25.7% | 62.0% | $-38 | $-20 |
| mild_trend_up | put | q1_low | 842 | 0.5% | -91.0% | $-124 | $-44 |
| mild_trend_up | put | q2 | 941 | 0.2% | -90.0% | $-82 | $-27 |
| mild_trend_up | put | q3 | 864 | 0.8% | -92.0% | $-92 | $-26 |
| mild_trend_up | put | q4_high | 926 | 0.7% | -90.0% | $-102 | $-38 |
