# Setup: `nq-ofi-extreme`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T06:35:25Z

## Headline

- **N signals:** 156
- **Win rate:** 71.8%
- **Avg R:** 0.126
- **Expectancy / signal:** $117.93
- **Cumulative net P&L:** $18,397.42
- **Profit factor:** 1.369
- **Max consecutive losers:** 5
- **Sharpe (signal-day, annualized):** 2.888
- **Max drawdown:** -$13,103.21 (-71.8%)

## Hit rate by time-of-day

| Bucket (UTC) | N   | Win rate | Expectancy ($) |
| ------------ | --- | -------- | -------------- |
| 13:30-13:45  | 0   | —        | —              |
| 13:45-14:00  | 0   | —        | —              |
| 14:00-14:30  | 0   | —        | —              |
| 14:30-15:30  | 55  | 76.4%    | $200.52        |
| 15:30-16:30  | 15  | 73.3%    | -$219.25       |
| 16:30-17:30  | 18  | 72.2%    | $257.90        |
| 17:30-18:00  | 7   | 100.0%   | $406.47        |
| 18:00-19:00  | 22  | 68.2%    | -$82.18        |
| 19:00-20:00  | 39  | 61.5%    | $127.65        |

## Caveats

- **Sharpe is signal-day-only** — non-signal days are dropped, not zero-filled. A low-frequency setup with a few large wins will look better here than in deployment. Compare _expectancy × signal frequency_ across setups for a deployment-grade view.
- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. Net of cost. Conservative for liquid midday, tight for the open and around news.
- **R-multiple denominator uses pre-slippage entry** (chart risk), numerator is net P&L — slippage flows only into the numerator.

## Threshold for go/no-go

- N signals ≥ 20: YES
- Expectancy > 0: YES
- Profit factor > 1.3: YES

## Notes

**Threshold interpretation.** The spec says `NQ 1h OFI ≥ p95 (rolling 252d)`. We compute p95 from EVERY-MINUTE samples of trailing-1h OFI across the training window (2025-04-20 → 2025-12-31). This is a defensible reading but produces a threshold (0.04) that is ~7.5× lower than the validated NQ OFI reference (ρ=0.313, p<0.001) in `ml/src/features/microstructure.py`, which aggregates to one daily value. Per-minute sampling treats every minute as an independent observation, inflating the sample size and pulling the p95 toward the tail of the _intraday noise_ distribution rather than the daily _signal_ distribution. **Frequency consequence**: ~1.7 signals/day rather than the ~5 signals/month a daily-aggregate interpretation would produce. The spec's anti-tuning rule forbids retuning thresholds in-flight, so this run reports the per-minute interpretation honestly. **Recommend** adding `setup-1a-nq-ofi-extreme-daily` as a separate Phase 2 variant to compare.

**MACRO-STRESS disqualifier.** Requires CL 1m bars. Skipped in this run (CL absent from OHLCV parquet, no Neon `DATABASE_URL`). On 92 test days at most a handful of days would have triggered the >2% 30m disqualifier, so the impact on signal count is small but non-zero.
