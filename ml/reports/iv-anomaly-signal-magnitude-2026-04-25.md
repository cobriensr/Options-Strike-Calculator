# IV-Anomaly Signal Magnitude (Phase D2) — 2026-04-25
**Sample:** 15,886 alerts, sliced by regime × side × signal-magnitude bucket.

**Key question:** does signal *strength* (e.g. 5σ z-score) predict better outcomes than signal *presence* alone? Phase C answered the count question (no). This answers magnitude.

## Z-score magnitude × regime × side

| regime | side | z_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | z_2to3 | 1,036 | 16.7% | -46.0% | $-32 | $-10 |
| chop | call | z_3to5 | 526 | 19.0% | -9.0% | $-25 | $-5 |
| chop | call | z_5plus | 109 | 18.4% | -14.0% | $98 | $-7 |
| chop | call | z_lt_2 | 547 | 18.6% | -26.0% | $36 | $-7 |
| chop | put | missing | 40 | 0.0% | -95.0% | $-99 | $-60 |
| chop | put | z_2to3 | 2,154 | 2.4% | -85.0% | $-85 | $-26 |
| chop | put | z_3to5 | 799 | 1.9% | -87.0% | $-80 | $-16 |
| chop | put | z_5plus | 175 | 2.3% | -87.0% | $-236 | $-7 |
| chop | put | z_lt_2 | 707 | 3.1% | -83.0% | $-93 | $-27 |
| extreme_down | call | z_2to3 | 59 | 0.0% | -87.0% | $-98 | $-5 |
| extreme_down | call | z_3to5 | 39 | 2.6% | -72.0% | $-111 | $-4 |
| extreme_down | call | z_lt_2 | 78 | 1.3% | -77.0% | $-77 | $-8 |
| extreme_down | put | z_2to3 | 57 | 5.3% | -76.0% | $-200 | $-35 |
| extreme_down | put | z_3to5 | 48 | 2.1% | -76.0% | $-37 | $-14 |
| extreme_down | put | z_lt_2 | 91 | 15.4% | -69.0% | $-88 | $-35 |
| extreme_up | call | z_2to3 | 87 | 42.5% | 31.0% | $-5 | $-4 |
| extreme_up | call | z_3to5 | 86 | 33.7% | -18.0% | $-7 | $-3 |
| extreme_up | call | z_lt_2 | 122 | 16.4% | -10.0% | $-24 | $-11 |
| extreme_up | put | z_2to3 | 398 | 12.1% | -72.0% | $-39 | $-3 |
| extreme_up | put | z_3to5 | 154 | 4.5% | -79.0% | $-36 | $-4 |
| extreme_up | put | z_lt_2 | 181 | 0.0% | -82.0% | $-36 | $-21 |
| mild_trend_down | call | z_2to3 | 62 | 27.4% | -46.0% | $-57 | $-8 |
| mild_trend_down | call | z_3to5 | 60 | 15.0% | -76.0% | $-129 | $-4 |
| mild_trend_down | put | z_2to3 | 90 | 5.6% | -61.0% | $-148 | $-34 |
| mild_trend_up | call | z_2to3 | 579 | 36.8% | 23.0% | $10 | $-7 |
| mild_trend_up | call | z_3to5 | 416 | 27.9% | 20.0% | $22 | $-8 |
| mild_trend_up | call | z_5plus | 105 | 17.1% | -30.0% | $-167 | $-27 |
| mild_trend_up | call | z_lt_2 | 500 | 38.4% | 103.0% | $1 | $-12 |
| mild_trend_up | put | missing | 73 | 0.0% | -90.0% | $-159 | $-102 |
| mild_trend_up | put | z_2to3 | 1,638 | 2.6% | -57.0% | $-111 | $-36 |
| mild_trend_up | put | z_3to5 | 526 | 1.7% | -89.0% | $-148 | $-58 |
| mild_trend_up | put | z_5plus | 131 | 2.3% | -91.0% | $-352 | $-48 |
| mild_trend_up | put | z_lt_2 | 687 | 1.8% | -89.0% | $-94 | $-39 |
| strong_trend_up | call | z_2to3 | 231 | 27.7% | 15.0% | $213 | $-11 |
| strong_trend_up | call | z_3to5 | 147 | 29.2% | 105.0% | $163 | $-8 |
| strong_trend_up | call | z_5plus | 51 | 31.4% | 85.0% | $-408 | $-20 |
| strong_trend_up | call | z_lt_2 | 135 | 22.2% | -28.0% | $242 | $-9 |
| strong_trend_up | put | z_2to3 | 711 | 0.1% | -87.0% | $-137 | $-34 |
| strong_trend_up | put | z_3to5 | 323 | 1.2% | -87.0% | $-230 | $-65 |
| strong_trend_up | put | z_5plus | 63 | 0.0% | -85.0% | $-341 | $-7 |
| strong_trend_up | put | z_lt_2 | 235 | 0.0% | -80.0% | $-238 | $-62 |

## Skew-delta magnitude × regime × side

| regime | side | skew_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | missing | 72 | 29.2% | 87.0% | $1 | $-3 |
| chop | call | skew_01to025 | 500 | 22.8% | -25.0% | $78 | $-8 |
| chop | call | skew_025to05 | 415 | 14.2% | -32.0% | $38 | $-7 |
| chop | call | skew_05plus | 483 | 9.5% | -40.0% | $-18 | $-4 |
| chop | call | skew_lt_001 | 753 | 20.9% | -38.0% | $-63 | $-22 |
| chop | put | missing | 153 | 6.5% | -64.0% | $-202 | $-102 |
| chop | put | skew_01to025 | 1,005 | 2.5% | -90.0% | $-62 | $-15 |
| chop | put | skew_025to05 | 526 | 0.9% | -87.0% | $-76 | $-20 |
| chop | put | skew_05plus | 540 | 2.6% | -82.0% | $-111 | $-13 |
| chop | put | skew_lt_001 | 1,651 | 2.3% | -85.0% | $-99 | $-37 |
| extreme_down | call | skew_05plus | 143 | 0.7% | -76.0% | $-19 | $-6 |
| extreme_down | put | skew_05plus | 143 | 9.8% | -77.0% | $-40 | $-34 |
| extreme_up | call | skew_01to025 | 78 | 24.4% | -11.0% | $-26 | $-4 |
| extreme_up | call | skew_025to05 | 63 | 12.7% | -17.0% | $-26 | $-27 |
| extreme_up | call | skew_05plus | 94 | 19.1% | -16.0% | $-27 | $-6 |
| extreme_up | call | skew_lt_001 | 65 | 56.9% | -14.0% | $-0 | $3 |
| extreme_up | put | missing | 77 | 1.3% | -73.0% | $-80 | $-55 |
| extreme_up | put | skew_01to025 | 171 | 0.0% | -97.0% | $-30 | $-4 |
| extreme_up | put | skew_025to05 | 117 | 0.0% | -97.0% | $-37 | $-35 |
| extreme_up | put | skew_05plus | 118 | 0.0% | -69.0% | $-36 | $-9 |
| extreme_up | put | skew_lt_001 | 275 | 19.6% | -59.0% | $-37 | $-2 |
| mild_trend_down | call | missing | 32 | 12.5% | -77.0% | $-55 | $-2 |
| mild_trend_down | call | skew_01to025 | 38 | 21.1% | -63.0% | $4 | $-7 |
| mild_trend_down | call | skew_lt_001 | 42 | 4.8% | -93.0% | $-265 | $-53 |
| mild_trend_down | put | skew_lt_001 | 72 | 2.8% | -74.0% | $-160 | $-40 |
| mild_trend_up | call | missing | 44 | 13.6% | -61.0% | $71 | $-4 |
| mild_trend_up | call | skew_01to025 | 326 | 36.5% | 21.0% | $30 | $-7 |
| mild_trend_up | call | skew_025to05 | 308 | 45.5% | 120.0% | $45 | $-4 |
| mild_trend_up | call | skew_05plus | 437 | 25.6% | 87.0% | $-51 | $-20 |
| mild_trend_up | call | skew_lt_001 | 489 | 33.3% | -20.0% | $-14 | $-9 |
| mild_trend_up | put | missing | 275 | 4.4% | -82.0% | $-137 | $-45 |
| mild_trend_up | put | skew_01to025 | 512 | 2.5% | -73.0% | $-80 | $-22 |
| mild_trend_up | put | skew_025to05 | 479 | 1.0% | -94.0% | $-86 | $-36 |
| mild_trend_up | put | skew_05plus | 512 | 1.6% | -89.0% | $-177 | $-52 |
| mild_trend_up | put | skew_lt_001 | 1,277 | 2.3% | -55.0% | $-134 | $-48 |
| strong_trend_up | call | skew_01to025 | 145 | 29.0% | 87.0% | $297 | $-10 |
| strong_trend_up | call | skew_025to05 | 93 | 15.1% | -42.0% | $23 | $-23 |
| strong_trend_up | call | skew_05plus | 120 | 5.8% | -62.0% | $-130 | $-18 |
| strong_trend_up | call | skew_lt_001 | 193 | 45.1% | 96.0% | $288 | $-4 |
| strong_trend_up | put | missing | 83 | 3.6% | -52.0% | $-155 | $-4 |
| strong_trend_up | put | skew_01to025 | 312 | 0.3% | -90.0% | $-150 | $-37 |
| strong_trend_up | put | skew_025to05 | 163 | 0.0% | -83.0% | $-157 | $-26 |
| strong_trend_up | put | skew_05plus | 165 | 0.0% | -72.0% | $-265 | $-70 |
| strong_trend_up | put | skew_lt_001 | 612 | 0.2% | -93.0% | $-203 | $-66 |

## Ask-mid divergence × regime × side

| regime | side | amd_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | amd_lt_03 | 2,211 | 17.9% | -31.0% | $-1 | $-8 |
| chop | put | amd_lt_03 | 3,840 | 2.3% | -85.0% | $-89 | $-24 |
| extreme_down | call | amd_lt_03 | 182 | 1.1% | -79.0% | $-89 | $-5 |
| extreme_down | put | amd_lt_03 | 202 | 8.4% | -73.0% | $-109 | $-33 |
| extreme_up | call | amd_lt_03 | 310 | 28.7% | -3.0% | $-17 | $-5 |
| extreme_up | put | amd_lt_03 | 753 | 7.3% | -76.0% | $-39 | $-5 |
| mild_trend_down | call | amd_lt_03 | 151 | 23.8% | -56.0% | $-72 | $-6 |
| mild_trend_down | put | amd_lt_03 | 137 | 7.3% | -60.0% | $-120 | $-34 |
| mild_trend_up | call | amd_lt_03 | 1,594 | 33.8% | 43.0% | $1 | $-9 |
| mild_trend_up | put | amd_lt_03 | 3,030 | 2.2% | -72.0% | $-119 | $-40 |
| strong_trend_up | call | amd_lt_03 | 559 | 27.2% | 36.0% | $152 | $-10 |
| strong_trend_up | put | amd_lt_03 | 1,330 | 0.4% | -86.0% | $-187 | $-43 |

## Vol/OI ratio × regime × side

| regime | side | vo_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | vo_10to50 | 1,018 | 18.1% | -23.0% | $-34 | $-11 |
| chop | call | vo_50to200 | 31 | 64.5% | 711.0% | $-269 | $27 |
| chop | call | vo_5to10 | 1,174 | 16.4% | -57.0% | $36 | $-6 |
| chop | put | vo_10to50 | 1,475 | 3.5% | -81.0% | $-94 | $-19 |
| chop | put | vo_200plus | 497 | 0.2% | -97.0% | $-97 | $-68 |
| chop | put | vo_50to200 | 633 | 0.0% | -91.0% | $-106 | $-27 |
| chop | put | vo_5to10 | 1,270 | 3.1% | -83.0% | $-81 | $-12 |
| extreme_down | call | vo_10to50 | 109 | 0.0% | -76.0% | $-75 | $-4 |
| extreme_down | call | vo_5to10 | 76 | 2.6% | -84.0% | $-105 | $-6 |
| extreme_down | put | vo_10to50 | 103 | 5.8% | -86.0% | $-45 | $-40 |
| extreme_down | put | vo_50to200 | 31 | 25.8% | -17.0% | $-212 | $-15 |
| extreme_down | put | vo_5to10 | 70 | 5.7% | -79.0% | $-160 | $-25 |
| extreme_up | call | vo_10to50 | 153 | 22.9% | -31.0% | $-16 | $-4 |
| extreme_up | call | vo_5to10 | 145 | 36.5% | 32.0% | $-18 | $-5 |
| extreme_up | put | vo_10to50 | 240 | 2.1% | -81.0% | $-35 | $-9 |
| extreme_up | put | vo_200plus | 286 | 9.1% | -74.0% | $-51 | $-38 |
| extreme_up | put | vo_50to200 | 126 | 14.3% | -73.0% | $-24 | $-3 |
| extreme_up | put | vo_5to10 | 106 | 5.7% | -77.0% | $-37 | $-2 |
| mild_trend_down | call | vo_10to50 | 55 | 7.3% | -88.0% | $-63 | $-14 |
| mild_trend_down | call | vo_5to10 | 68 | 42.6% | -32.0% | $-119 | $-1 |
| mild_trend_down | put | vo_10to50 | 60 | 10.0% | -33.0% | $-134 | $-40 |
| mild_trend_down | put | vo_5to10 | 68 | 5.9% | -80.0% | $-100 | $-31 |
| mild_trend_up | call | vo_10to50 | 723 | 34.7% | 43.0% | $7 | $-7 |
| mild_trend_up | call | vo_50to200 | 175 | 10.9% | -56.0% | $-17 | $-20 |
| mild_trend_up | call | vo_5to10 | 703 | 38.0% | 69.0% | $-8 | $-9 |
| mild_trend_up | put | vo_10to50 | 943 | 4.6% | -33.0% | $-113 | $-32 |
| mild_trend_up | put | vo_200plus | 814 | 1.5% | -91.0% | $-117 | $-66 |
| mild_trend_up | put | vo_50to200 | 579 | 0.3% | -89.0% | $-91 | $-25 |
| mild_trend_up | put | vo_5to10 | 719 | 1.4% | -88.0% | $-176 | $-37 |
| strong_trend_up | call | vo_10to50 | 288 | 22.9% | -19.0% | $53 | $-13 |
| strong_trend_up | call | vo_5to10 | 267 | 30.0% | 90.0% | $230 | $-9 |
| strong_trend_up | put | vo_10to50 | 540 | 0.6% | -80.0% | $-241 | $-71 |
| strong_trend_up | put | vo_200plus | 152 | 0.0% | -98.0% | $-337 | $-190 |
| strong_trend_up | put | vo_50to200 | 362 | 0.0% | -89.0% | $-44 | $-17 |
| strong_trend_up | put | vo_5to10 | 281 | 0.7% | -87.0% | $-198 | $-24 |

## Side-skew × regime × side

| regime | side | ss_bucket | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | ss_065to080 | 1,047 | 19.9% | -25.0% | $6 | $-11 |
| chop | call | ss_080to095 | 783 | 16.4% | -34.0% | $-3 | $-6 |
| chop | call | ss_095plus | 393 | 15.5% | -38.0% | $-15 | $-4 |
| chop | put | ss_065to080 | 1,672 | 2.3% | -84.0% | $-102 | $-33 |
| chop | put | ss_080to095 | 1,487 | 2.6% | -86.0% | $-87 | $-17 |
| chop | put | ss_095plus | 716 | 2.0% | -88.0% | $-81 | $-11 |
| extreme_down | call | ss_065to080 | 93 | 1.1% | -78.0% | $-106 | $-5 |
| extreme_down | call | ss_080to095 | 64 | 1.6% | -78.0% | $-84 | $-5 |
| extreme_down | put | ss_065to080 | 101 | 8.9% | -74.0% | $-104 | $-28 |
| extreme_down | put | ss_080to095 | 82 | 8.5% | -71.0% | $-132 | $-35 |
| extreme_up | call | ss_065to080 | 144 | 29.2% | 5.0% | $-7 | $-6 |
| extreme_up | call | ss_080to095 | 115 | 31.3% | -21.0% | $-31 | $-5 |
| extreme_up | call | ss_095plus | 54 | 20.4% | 14.0% | $-13 | $-3 |
| extreme_up | put | ss_065to080 | 308 | 5.5% | -76.0% | $-45 | $-19 |
| extreme_up | put | ss_080to095 | 305 | 9.2% | -75.0% | $-33 | $-4 |
| extreme_up | put | ss_095plus | 145 | 6.9% | -80.0% | $-41 | $-2 |
| mild_trend_down | call | ss_065to080 | 64 | 23.4% | -49.0% | $-73 | $-11 |
| mild_trend_down | call | ss_080to095 | 56 | 26.8% | -52.0% | $-108 | $-7 |
| mild_trend_down | call | ss_095plus | 31 | 19.4% | -74.0% | $-7 | $-4 |
| mild_trend_down | put | ss_065to080 | 67 | 4.5% | -79.0% | $-98 | $-36 |
| mild_trend_down | put | ss_080to095 | 42 | 7.1% | -64.0% | $-112 | $-27 |
| mild_trend_up | call | ss_065to080 | 761 | 34.0% | 40.0% | $-12 | $-10 |
| mild_trend_up | call | ss_080to095 | 570 | 34.0% | 38.0% | $9 | $-7 |
| mild_trend_up | call | ss_095plus | 273 | 31.9% | 64.0% | $5 | $-9 |
| mild_trend_up | put | ss_065to080 | 1,275 | 1.7% | -87.0% | $-146 | $-49 |
| mild_trend_up | put | ss_080to095 | 1,190 | 2.4% | -59.0% | $-108 | $-36 |
| mild_trend_up | put | ss_095plus | 590 | 2.7% | -65.0% | $-114 | $-29 |
| strong_trend_up | call | ss_065to080 | 275 | 24.7% | 30.0% | $144 | $-20 |
| strong_trend_up | call | ss_080to095 | 172 | 22.7% | 61.0% | $111 | $-9 |
| strong_trend_up | call | ss_095plus | 119 | 38.7% | 6.0% | $222 | $-3 |
| strong_trend_up | put | ss_065to080 | 543 | 0.2% | -87.0% | $-192 | $-49 |
| strong_trend_up | put | ss_080to095 | 516 | 0.4% | -85.0% | $-156 | $-29 |
| strong_trend_up | put | ss_095plus | 276 | 0.7% | -85.0% | $-247 | $-63 |

## Composite intensity quartile × regime × side

| regime | side | intensity_q | n | win% | mean% | mean $ | median $ |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| chop | call | q1_low | 697 | 19.8% | -45.0% | $-7 | $-11 |
| chop | call | q2 | 526 | 18.8% | -49.0% | $-3 | $-10 |
| chop | call | q3 | 528 | 18.9% | -1.0% | $21 | $-6 |
| chop | call | q4_high | 472 | 12.7% | -21.0% | $-12 | $-3 |
| chop | put | q1_low | 922 | 4.5% | -80.0% | $-107 | $-32 |
| chop | put | q2 | 1,184 | 1.9% | -85.0% | $-82 | $-23 |
| chop | put | q3 | 940 | 1.6% | -88.0% | $-79 | $-20 |
| chop | put | q4_high | 829 | 1.7% | -89.0% | $-104 | $-13 |
| extreme_down | call | q3 | 41 | 0.0% | -99.0% | $-92 | $-5 |
| extreme_down | call | q4_high | 98 | 1.0% | -74.0% | $-19 | $-4 |
| extreme_down | put | q1_low | 33 | 12.1% | -61.0% | $-247 | $-38 |
| extreme_down | put | q3 | 55 | 12.7% | -64.0% | $-29 | $-27 |
| extreme_down | put | q4_high | 95 | 6.3% | -86.0% | $-44 | $-30 |
| extreme_up | call | q1_low | 94 | 27.7% | -6.0% | $-23 | $-8 |
| extreme_up | call | q2 | 53 | 43.4% | 47.0% | $-5 | $-3 |
| extreme_up | call | q3 | 62 | 22.6% | -21.0% | $-12 | $-6 |
| extreme_up | call | q4_high | 104 | 25.0% | -16.0% | $-20 | $-3 |
| extreme_up | put | q1_low | 112 | 6.2% | -77.0% | $-50 | $-35 |
| extreme_up | put | q2 | 133 | 15.0% | -67.0% | $-57 | $-35 |
| extreme_up | put | q3 | 261 | 10.0% | -75.0% | $-20 | $-2 |
| extreme_up | put | q4_high | 252 | 0.8% | -83.0% | $-46 | $-28 |
| mild_trend_down | call | q2 | 37 | 35.1% | -28.0% | $-34 | $-8 |
| mild_trend_down | call | q3 | 56 | 16.1% | -67.0% | $-136 | $-9 |
| mild_trend_down | call | q4_high | 36 | 19.4% | -70.0% | $-50 | $-2 |
| mild_trend_down | put | q1_low | 53 | 1.9% | -82.0% | $-164 | $-44 |
| mild_trend_down | put | q2 | 35 | 8.6% | -67.0% | $-164 | $-36 |
| mild_trend_up | call | q1_low | 492 | 45.9% | 95.0% | $39 | $-5 |
| mild_trend_up | call | q2 | 309 | 35.9% | 20.0% | $-8 | $-8 |
| mild_trend_up | call | q3 | 379 | 28.2% | 29.0% | $26 | $-9 |
| mild_trend_up | call | q4_high | 424 | 22.6% | 14.0% | $-68 | $-15 |
| mild_trend_up | put | q1_low | 690 | 3.2% | -65.0% | $-115 | $-43 |
| mild_trend_up | put | q2 | 765 | 2.8% | -39.0% | $-107 | $-34 |
| mild_trend_up | put | q3 | 725 | 1.4% | -91.0% | $-126 | $-35 |
| mild_trend_up | put | q4_high | 875 | 1.6% | -91.0% | $-148 | $-54 |
| strong_trend_up | call | q1_low | 124 | 33.1% | 14.0% | $304 | $-10 |
| strong_trend_up | call | q2 | 139 | 30.9% | 15.0% | $251 | $-8 |
| strong_trend_up | call | q3 | 185 | 22.2% | 14.0% | $170 | $-16 |
| strong_trend_up | call | q4_high | 118 | 23.7% | 109.0% | $-160 | $-12 |
| strong_trend_up | put | q1_low | 355 | 0.3% | -86.0% | $-206 | $-58 |
| strong_trend_up | put | q2 | 350 | 0.0% | -87.0% | $-143 | $-27 |
| strong_trend_up | put | q3 | 358 | 0.6% | -86.0% | $-167 | $-49 |
| strong_trend_up | put | q4_high | 272 | 0.7% | -83.0% | $-259 | $-55 |
