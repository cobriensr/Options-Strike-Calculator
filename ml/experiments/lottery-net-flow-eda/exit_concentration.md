# Inversion-Exit Lottery-Winner Concentration Check

Sample: **47,658 fires** with both exit policies simulated. Inversion lottery winners: **3,186** (6.69%). Trail lottery winners: **618** (1.30%).

**Decision rule (per `feedback_uniform_lift_is_leakage`)**: uniform lift across every stratum = leakage; concentrated lift in 1–2 strata = real edge. CV across strata is the test.

## By date

| date | n | lottery rate inv | lottery rate trail | lift |
| --- | ---: | ---: | ---: | ---: |
| 2026-05-01 | 3,080 | 18.64% | 5.71% | 12.92% |
| 2026-04-17 | 2,649 | 13.85% | 2.27% | 11.59% |
| 2026-04-27 | 1,479 | 13.66% | 3.31% | 10.34% |
| 2026-04-14 | 4,485 | 10.59% | 0.40% | 10.19% |
| 2026-04-23 | 3,965 | 9.66% | 1.19% | 8.47% |
| 2026-04-30 | 4,889 | 8.22% | 1.45% | 6.77% |
| 2026-04-24 | 2,447 | 7.60% | 2.66% | 4.94% |
| 2026-04-13 | 1,210 | 6.12% | 3.64% | 2.48% |
| 2026-04-15 | 3,395 | 5.77% | 0.91% | 4.86% |
| 2026-04-22 | 3,166 | 3.98% | 0.13% | 3.85% |
| 2026-04-21 | 3,933 | 2.01% | 0.46% | 1.55% |
| 2026-04-16 | 2,740 | 1.72% | 0.44% | 1.28% |
| 2026-04-20 | 1,386 | 1.01% | 0.36% | 0.65% |
| 2026-04-29 | 6,183 | 0.92% | 0.27% | 0.65% |
| 2026-04-28 | 2,651 | 0.15% | 0.04% | 0.11% |

CV(lottery_rate_inv) across 15 dates = **0.80**
→ **Mixed** — moderate concentration, investigate top dates.

## By ticker (top 15 by inversion lottery rate)

| ticker | n | lottery rate inv | lottery rate trail | mean inv | mean trail |
| --- | ---: | ---: | ---: | ---: | ---: |
| RDDT | 170 | 39.41% | 3.53% | +92.18% | +7.15% |
| SOFI | 100 | 32.00% | 9.00% | +68.35% | +19.57% |
| TSM | 274 | 26.28% | 5.47% | +61.48% | +6.75% |
| SOUN | 85 | 23.53% | 7.06% | +96.75% | +3.07% |
| SNDK | 1,454 | 23.31% | 8.46% | +57.36% | +12.46% |
| TEAM | 71 | 22.54% | 2.82% | +45.63% | +14.16% |
| TSLL | 165 | 21.82% | 3.64% | +37.15% | -5.11% |
| SMCI | 109 | 21.10% | 5.50% | +27.44% | -11.59% |
| WMT | 114 | 19.30% | 3.51% | +107.31% | +13.96% |
| UNH | 108 | 15.74% | 3.70% | +3.51% | -15.24% |
| GOOG | 961 | 13.53% | 2.71% | +23.39% | +5.51% |
| WDC | 164 | 13.41% | 6.71% | +0.13% | -6.94% |
| RIVN | 76 | 13.16% | 5.26% | -5.65% | -11.97% |
| TNA | 55 | 12.73% | 7.27% | -3.50% | -6.92% |
| SNOW | 165 | 12.73% | 4.24% | +5.85% | -3.50% |

CV across 50 tickers = **0.91**
→ **Mixed**.

## By mode

| stratum | n | lottery rate inv | lottery rate trail | lift |
| --- | ---: | ---: | ---: | ---: |
| A_intraday_0DTE | 16,370 | 10.26% | 2.98% | 7.28% |
| B_multi_day_DTE1_3 | 31,288 | 4.82% | 0.42% | 4.40% |

CV across 2 strata = **0.51**

## By tod

| stratum | n | lottery rate inv | lottery rate trail | lift |
| --- | ---: | ---: | ---: | ---: |
| AM_open | 14,114 | 9.61% | 1.83% | 7.78% |
| MID | 15,272 | 7.94% | 1.17% | 6.77% |
| LUNCH | 5,496 | 5.62% | 0.93% | 4.69% |
| PM | 12,776 | 2.42% | 1.03% | 1.39% |

CV across 4 strata = **0.49**

## By option_type

| stratum | n | lottery rate inv | lottery rate trail | lift |
| --- | ---: | ---: | ---: | ---: |
| C | 24,917 | 9.87% | 1.65% | 8.22% |
| P | 22,741 | 3.19% | 0.91% | 2.28% |

CV across 2 strata = **0.72**

## Top 20 (date, ticker) cells contributing inversion lottery winners

| date | ticker | winners |
| --- | --- | ---: |
| 2026-05-01 | SNDK | 244 |
| 2026-04-27 | TSLA | 183 |
| 2026-04-14 | META | 171 |
| 2026-04-14 | AMZN | 163 |
| 2026-04-15 | TSLA | 157 |
| 2026-04-30 | GOOG | 129 |
| 2026-04-17 | TSLA | 122 |
| 2026-04-22 | MU | 108 |
| 2026-05-01 | TSLA | 96 |
| 2026-04-23 | PLTR | 89 |
| 2026-04-23 | MU | 88 |
| 2026-04-23 | MSFT | 76 |
| 2026-04-14 | MU | 73 |
| 2026-04-30 | GOOGL | 73 |
| 2026-04-17 | SNDK | 69 |
| 2026-05-01 | RDDT | 67 |
| 2026-04-24 | TSM | 66 |
| 2026-04-30 | QQQ | 65 |
| 2026-04-30 | AMZN | 55 |
| 2026-04-14 | NVDA | 54 |

Top 5 (date, ticker) cells account for **28.8%** of all inversion lottery winners.

## Verdict

**Possibly uniform** — CV across date and ticker stays moderate. Rerun with stricter min_n to be sure, but treat the inversion-exit lottery uplift with suspicion: uniform lift is the fingerprint of data leakage or methodology bias.