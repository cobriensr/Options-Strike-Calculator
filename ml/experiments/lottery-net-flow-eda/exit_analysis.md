# Exit-Quality Analysis — does flow peak before price?

Sample: 11,170 fires that hit ≥ 50% peak_ceiling AND have a matched-side flow peak in the same window.

## Lead distribution (minutes flow peak preceded option peak)

- Median lead: **+46.7 min**
- Mean lead: **+75.1 min**
- 25th–75th: +12.6 min .. +115.6 min
- 10th–90th: +0.8 min .. +190.8 min
- Pct of fires with lead > 0 (flow led): 93.2%
- Pct with lead >= 3 min (actionable): 84.8%
- Pct with lead <= 0 (flow lagged): 6.8%

## Stratified by mode

| stratum            |     n | median lead | mean lead | % lead>=3min |
| ------------------ | ----: | ----------: | --------: | -----------: |
| A_intraday_0DTE    | 4,368 |       +38.6 |     +62.2 |        79.8% |
| B_multi_day_DTE1_3 | 6,802 |       +64.6 |     +83.3 |        88.0% |

## Stratified by option type

| stratum |     n | median lead | mean lead | % lead>=3min |
| ------- | ----: | ----------: | --------: | -----------: |
| C       | 7,168 |       +64.1 |     +88.3 |        87.3% |
| P       | 4,002 |       +29.3 |     +51.4 |        80.4% |

## Stratified by tod

| stratum |     n | median lead | mean lead | % lead>=3min |
| ------- | ----: | ----------: | --------: | -----------: |
| AM_open | 4,274 |       +73.7 |     +98.8 |        87.0% |
| LUNCH   | 1,266 |       +39.2 |     +42.8 |        81.3% |
| MID     | 4,012 |       +57.4 |     +80.3 |        86.9% |
| PM      | 1,618 |       +14.8 |     +24.5 |        76.5% |

## Verdict

**SIGNAL** — flow peaks +46.7 min before price on the median fire, and 85% of fires have an actionable lead (>=3 min). Worth investing in a P&L simulation: 'exit at flow-peak + offset' vs trail-30/10. Need parquet option-price data to quantify the captured-pct improvement.
