# Exit Simulation — Trail-30/10 vs Flow-Inversion

Sample: **47,658 fires** in the 15-day parquet window (2026-04-13 → 2026-05-01) with trade tape available for the option chain AND post-trigger flow data for the underlying.

## Aggregate P&L (mid-based, no costs)

| metric | trail-30/10 | flow-inversion | diff (inv-trail) |
| ------ | ----------: | -------------: | ---------------: |
| median |        +5.5 |           -3.7 |             -9.1 |
| mean   |        -1.4 |           +8.3 |             +9.8 |
| std    |       +49.2 |         +100.0 |            +50.9 |
| p10    |       -69.9 |          -61.6 |             +8.3 |
| p25    |       -30.3 |          -28.8 |             +1.5 |
| p75    |       +27.0 |          +19.9 |             -7.1 |
| p90    |       +45.8 |          +70.1 |            +24.3 |

- Win-rate trail: 54.7%
- Win-rate inversion: 44.4%
- Lottery rate trail: 1.30%
- Lottery rate inversion: 6.69%

## Cost-net P&L ($0.65 RT + 25% spread slippage / leg)

| metric | trail-30/10 net | flow-inversion net | diff |
| ------ | --------------: | -----------------: | ---: |
| median |            -8.1 |              -14.5 | -6.4 |
| mean   |           -18.4 |               -8.6 | +9.8 |
| p25    |           -47.2 |              -45.1 | +2.0 |
| p75    |           +16.5 |               +9.5 | -7.0 |

## Inversion exit status breakdown

- `inversion`: 43,897 (92.1%)
- `eod_no_inversion_window_eod_fallback`: 1,857 (3.9%)
- `eod_no_inversion_found_eod_fallback`: 944 (2.0%)
- `eod_no_inversion_window`: 447 (0.9%)
- `inversion_eod_fallback`: 322 (0.7%)
- `eod_no_inversion_found`: 191 (0.4%)

## Stratified by mode

| mode               |      n | median trail | median inv |  diff |
| ------------------ | -----: | -----------: | ---------: | ----: |
| A_intraday_0DTE    | 16,370 |         +8.9 |       -8.4 | -17.4 |
| B_multi_day_DTE1_3 | 31,288 |         +3.8 |       -2.2 |  -6.0 |

## Stratified by tod

| tod     |      n | median trail | median inv |  diff |
| ------- | -----: | -----------: | ---------: | ----: |
| AM_open | 14,114 |        +15.8 |       -5.0 | -20.8 |
| LUNCH   |  5,496 |         +8.5 |       -3.0 | -11.5 |
| MID     | 15,272 |         +9.9 |       -2.2 | -12.1 |
| PM      | 12,776 |         -1.2 |       -4.2 |  -3.0 |

## Verdict

**TIE** — median diff (inversion - trail) is +1.0pp net. Within noise; no clear winner. Pick by simplicity / preference.
