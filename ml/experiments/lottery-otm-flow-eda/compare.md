# OTM-NCP vs All-NCP Inversion — Head-to-Head

Sample: **47,658 fires** with both inversion variants computable on the 15-day parquet window (2026-04-13 → 2026-05-01).

## Headline lottery rate

- **trail-30/10**:        1.30%
- **inversion (all-NCP)**: 6.69%
- **inversion (OTM-NCP)**: 5.86%
- **OTM − all-NCP**:       -0.82%

## P&L distribution (mid-based, no costs)

| metric | trail | inv_all | inv_otm | inv_otm − inv_all |
| --- | ---: | ---: | ---: | ---: |
| median | +5.5 | -3.7 | -3.9 | -0.2 |
| mean | -1.4 | +8.3 | +6.3 | -2.0 |
| std | +49.2 | +100.0 | +100.5 | +0.5 |
| p10 | -69.9 | -61.6 | -64.3 | -2.7 |
| p25 | -30.3 | -28.8 | -29.3 | -0.5 |
| p75 | +27.0 | +19.9 | +18.9 | -1.0 |
| p90 | +45.8 | +70.1 | +63.2 | -7.0 |

## Lottery rate after costs ($0.65 RT + 25% spread / leg)

- inv_all net: 5.54%
- inv_otm net: 4.89%
- delta:       -0.65%

## Stratified by mode

| mode | n | rate trail | rate inv_all | rate inv_otm | otm − all |
| --- | ---: | ---: | ---: | ---: | ---: |
| A_intraday_0DTE | 16,370 | 2.98% | 10.26% | 9.16% | -1.09% |
| B_multi_day_DTE1_3 | 31,288 | 0.42% | 4.82% | 4.14% | -0.68% |

## Stratified by tod

| tod | n | rate trail | rate inv_all | rate inv_otm | otm − all |
| --- | ---: | ---: | ---: | ---: | ---: |
| AM_open | 14,114 | 1.83% | 9.61% | 8.62% | -0.98% |
| LUNCH | 5,496 | 0.93% | 5.62% | 4.44% | -1.18% |
| MID | 15,272 | 1.17% | 7.94% | 6.66% | -1.28% |
| PM | 12,776 | 1.03% | 2.42% | 2.48% | 0.06% |

## Stratified by option_type

| option_type | n | rate trail | rate inv_all | rate inv_otm | otm − all |
| --- | ---: | ---: | ---: | ---: | ---: |
| C | 24,917 | 1.65% | 9.87% | 8.75% | -1.12% |
| P | 22,741 | 0.91% | 3.19% | 2.70% | -0.49% |

## By date

| date_str | n | rate trail | rate inv_all | rate inv_otm | otm − all |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-04-13 | 1,210 | 3.64% | 6.12% | 5.04% | -1.07% |
| 2026-04-14 | 4,485 | 0.40% | 10.59% | 8.05% | -2.54% |
| 2026-04-15 | 3,395 | 0.91% | 5.77% | 5.48% | -0.29% |
| 2026-04-16 | 2,740 | 0.44% | 1.72% | 2.88% | 1.17% |
| 2026-04-17 | 2,649 | 2.27% | 13.85% | 11.55% | -2.30% |
| 2026-04-20 | 1,386 | 0.36% | 1.01% | 1.52% | 0.51% |
| 2026-04-21 | 3,933 | 0.46% | 2.01% | 1.96% | -0.05% |
| 2026-04-22 | 3,166 | 0.13% | 3.98% | 3.66% | -0.32% |
| 2026-04-23 | 3,965 | 1.19% | 9.66% | 6.53% | -3.13% |
| 2026-04-24 | 2,447 | 2.66% | 7.60% | 7.52% | -0.08% |
| 2026-04-27 | 1,479 | 3.31% | 13.66% | 16.70% | 3.04% |
| 2026-04-28 | 2,651 | 0.04% | 0.15% | 0.64% | 0.49% |
| 2026-04-29 | 6,183 | 0.27% | 0.92% | 0.78% | -0.15% |
| 2026-04-30 | 4,889 | 1.45% | 8.22% | 6.81% | -1.41% |
| 2026-05-01 | 3,080 | 5.71% | 18.64% | 16.23% | -2.40% |

## Concentration check on OTM-NCP winners

- CV(lottery_rate_otm) across `date_str`: 0.80
- CV(lottery_rate_otm) across `ticker`: 0.96
- CV(lottery_rate_otm) across `mode`: 0.53
- CV(lottery_rate_otm) across `tod`: 0.48

Per `feedback_uniform_lift_is_leakage`: high CV (≥1.0) = concentrated edge; low CV (<0.5) = uniform = leakage. CVs near or above the all-NCP CVs imply OTM didn't change the concentration shape.

## Verdict (per spec decision rule)

**TIE** — OTM-NCP inversion lottery rate is -0.82pp vs all-NCP, within the ±2pp practical-significance tie band. The OTM filter neither meaningfully helps nor hurts. Keep all-NCP as the default — simpler is better — and move on to the next feature (Dir Delta) for genuine signal exploration.