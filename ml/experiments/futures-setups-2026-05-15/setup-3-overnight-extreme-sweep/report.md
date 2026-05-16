# Setup: `overnight-extreme-sweep`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T17:33:08Z

## Headline

- **N signals:** 7
- **Win rate:** 42.9%
- **Avg R:** 0.076
- **Expectancy / signal:** $135.00
- **Cumulative net P&L:** $945.00
- **Profit factor:** 1.326
- **Max consecutive losers:** 3
- **Sharpe (signal-day, annualized):** 1.970
- **Max drawdown:** -$2,345.00 (-71.3%)

## Hit rate by time-of-day

| Bucket (UTC) | N   | Win rate | Expectancy ($) |
| ------------ | --- | -------- | -------------- |
| 13:30-13:45  | 0   | —        | —              |
| 13:45-14:00  | 7   | 42.9%    | $135.00        |
| 14:00-14:30  | 0   | —        | —              |
| 14:30-15:30  | 0   | —        | —              |
| 15:30-16:30  | 0   | —        | —              |
| 16:30-17:30  | 0   | —        | —              |
| 17:30-18:00  | 0   | —        | —              |
| 18:00-19:00  | 0   | —        | —              |
| 19:00-20:00  | 0   | —        | —              |

## Caveats

- **Sharpe is signal-day-only** — non-signal days are dropped, not zero-filled. A low-frequency setup with a few large wins will look better here than in deployment. Compare _expectancy × signal frequency_ across setups for a deployment-grade view.
- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. Net of cost. Conservative for liquid midday, tight for the open and around news.
- **R-multiple denominator uses pre-slippage entry** (chart risk), numerator is net P&L — slippage flows only into the numerator.

## Threshold for go/no-go

- N signals ≥ 20: NO (insufficient sample)
- Expectancy > 0: YES
- Profit factor > 1.3: YES

## Notes

**Fires at minute 15 of RTH only.** This setup is one-shot per day — we evaluate exactly when the first 15min RTH window closes. Before minute 15: not enough data. After minute 15: window closed, no re-fire.

**Pattern**: classic auction-failure / liquidity-grab. ETH session (17:00 ET prior day → 09:30 ET) sets a range. First 15min of RTH sweeps one extreme (probably stop-running) then reverts inside the range. Reversion = failed auction → fade the sweep toward the opposite extreme.

**Econ-calendar disqualifier skipped.** No calendar feed in this backtest. CPI/FOMC/payrolls days will fire just like any other; flagged in metadata so the comparative report can discuss noise.
