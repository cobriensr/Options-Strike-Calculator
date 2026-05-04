# Dir-Delta vs All-NCP Inversion — Head-to-Head

Sample: **41,941 fires** with both inversion variants computable on the 15-day parquet window (2026-04-13 → 2026-05-01).

## Headline lottery rate

- **trail-30/10**: 1.43%
- **inversion (all-NCP)**: 6.84%
- **inversion (Dir Delta)**: 6.82%
- **Dir Delta − all-NCP**: -0.02%

## P&L distribution (mid-based, no costs)

| metric | trail | inv_all | inv_dd | inv_dd − inv_all |
| ------ | ----: | ------: | -----: | ---------------: |
| median |  +6.5 |    -3.6 |   -1.4 |             +2.2 |
| mean   |  -1.0 |    +8.6 |  +10.9 |             +2.3 |
| std    | +50.5 |  +103.0 | +103.2 |             +0.2 |
| p10    | -72.4 |   -64.4 |  -60.9 |             +3.4 |
| p25    | -30.1 |   -30.0 |  -25.4 |             +4.6 |
| p75    | +27.6 |   +20.9 |  +22.9 |             +2.0 |
| p90    | +47.0 |   +71.5 |  +72.2 |             +0.6 |

## Lottery rate after costs

- inv_all net: 5.65%
- inv_dirdelta net: 5.68%
- delta: 0.03%

## Stratified by mode

| mode               |      n | rate trail | rate inv_all | rate inv_dd | dd − all |
| ------------------ | -----: | ---------: | -----------: | ----------: | -------: |
| A_intraday_0DTE    | 15,932 |      2.98% |       10.24% |       9.40% |   -0.85% |
| B_multi_day_DTE1_3 | 26,009 |      0.48% |        4.76% |       5.24% |    0.48% |

## Stratified by tod

| tod     |      n | rate trail | rate inv_all | rate inv_dd | dd − all |
| ------- | -----: | ---------: | -----------: | ----------: | -------: |
| AM_open | 12,234 |      2.02% |        9.34% |       9.49% |    0.15% |
| LUNCH   |  4,856 |      0.99% |        6.01% |       5.15% |   -0.86% |
| MID     | 13,335 |      1.33% |        8.50% |       8.79% |    0.28% |
| PM      | 11,516 |      1.11% |        2.61% |       2.41% |   -0.21% |

## Stratified by option_type

| option_type |      n | rate trail | rate inv_all | rate inv_dd | dd − all |
| ----------- | -----: | ---------: | -----------: | ----------: | -------: |
| C           | 22,056 |      1.79% |       10.12% |      10.36% |    0.24% |
| P           | 19,885 |      1.04% |        3.21% |       2.89% |   -0.32% |

## By date

| date_str   |     n | rate trail | rate inv_all | rate inv_dd | dd − all |
| ---------- | ----: | ---------: | -----------: | ----------: | -------: |
| 2026-04-13 | 1,163 |      3.78% |        6.36% |       6.88% |    0.52% |
| 2026-04-14 | 2,907 |      0.52% |       10.46% |       7.91% |   -2.55% |
| 2026-04-15 | 2,754 |      1.13% |        7.01% |       7.26% |    0.25% |
| 2026-04-16 | 2,052 |      0.58% |        2.00% |       6.04% |    4.04% |
| 2026-04-17 | 2,647 |      2.27% |       13.86% |      14.17% |    0.30% |
| 2026-04-20 |   988 |      0.51% |        1.42% |       1.82% |    0.40% |
| 2026-04-21 | 2,666 |      0.68% |        2.51% |       1.91% |   -0.60% |
| 2026-04-22 | 2,908 |      0.14% |        4.30% |       4.30% |    0.00% |
| 2026-04-23 | 3,598 |      1.28% |        8.53% |       7.25% |   -1.28% |
| 2026-04-24 | 2,373 |      2.70% |        7.54% |       7.63% |    0.08% |
| 2026-04-27 | 1,479 |      3.31% |       13.66% |      14.94% |    1.28% |
| 2026-04-28 | 2,554 |      0.04% |        0.16% |       0.39% |    0.23% |
| 2026-04-29 | 6,183 |      0.27% |        0.92% |       1.05% |    0.13% |
| 2026-04-30 | 4,889 |      1.45% |        8.22% |       8.84% |    0.61% |
| 2026-05-01 | 2,780 |      5.86% |       19.21% |      17.52% |   -1.69% |

## Concentration check on Dir-Delta winners

- CV(lottery_rate_dirdelta) across `date_str`: 0.71
- CV(lottery_rate_dirdelta) across `ticker`: 1.06
- CV(lottery_rate_dirdelta) across `mode`: 0.40
- CV(lottery_rate_dirdelta) across `tod`: 0.51

## Verdict (per spec decision rule)

**TIE** — Dir Delta lottery rate is -0.02pp vs all-NCP, within the ±2pp tie band. Keep all-NCP. Move to Dir Vega for genuine signal exploration.
