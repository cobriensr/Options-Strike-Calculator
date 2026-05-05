# Exit Simulation — Trail-30/10 vs Flow-Inversion

Sample: **55,124 fires** in the 15-day parquet window (2026-04-13 → 2026-05-01) with trade tape available for the option chain AND post-trigger flow data for the underlying.

## Aggregate P&L (mid-based, no costs)

| metric | trail-30/10 | flow-inversion | diff (inv-trail) |
| --- | ---: | ---: | ---: |
| median | +6.0 | -4.1 | -10.1 |
| mean | -0.8 | +7.1 | +7.9 |
| std | +50.2 | +96.5 | +46.3 |
| p10 | -71.2 | -65.1 | +6.1 |
| p25 | -30.6 | -30.3 | +0.2 |
| p75 | +27.8 | +20.4 | -7.4 |
| p90 | +48.4 | +70.3 | +21.9 |

- Win-rate trail:           55.0%
- Win-rate inversion:       44.0%
- Lottery rate trail:       1.61%
- Lottery rate inversion:   6.67%

## Cost-net P&L ($0.65 RT + 25% spread slippage / leg)

| metric | trail-30/10 net | flow-inversion net | diff |
| --- | ---: | ---: | ---: |
| median | -6.9 | -14.3 | -7.4 |
| mean | -17.0 | -9.1 | +7.9 |
| p25 | -46.9 | -46.6 | +0.3 |
| p75 | +17.6 | +10.3 | -7.3 |

## Inversion exit status breakdown

- `inversion`: 51,168 (92.8%)
- `eod_no_inversion_window_eod_fallback`: 1,962 (3.6%)
- `eod_no_inversion_found_eod_fallback`: 949 (1.7%)
- `eod_no_inversion_window`: 495 (0.9%)
- `inversion_eod_fallback`: 357 (0.6%)
- `eod_no_inversion_found`: 193 (0.4%)

## Stratified by mode

| mode | n | median trail | median inv | diff |
| --- | ---: | ---: | ---: | ---: |
| A_intraday_0DTE | 20,801 | +9.4 | -9.3 | -18.7 |
| B_multi_day_DTE1_3 | 34,323 | +4.0 | -2.0 | -6.0 |

## Stratified by tod

| tod | n | median trail | median inv | diff |
| --- | ---: | ---: | ---: | ---: |
| AM_open | 16,661 | +14.6 | -6.4 | -21.0 |
| LUNCH | 6,341 | +10.2 | -1.7 | -11.8 |
| MID | 18,829 | +10.9 | -3.4 | -14.4 |
| PM | 13,293 | -1.2 | -4.0 | -2.8 |

## Verdict

**TIE** — median diff (inversion - trail) is +0.8pp net. Within noise; no clear winner. Pick by simplicity / preference.