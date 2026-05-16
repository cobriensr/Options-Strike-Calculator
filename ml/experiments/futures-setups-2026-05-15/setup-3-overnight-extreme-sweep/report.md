# Setup: `overnight-extreme-sweep`

**Test window:** 2025-04-20 → 2026-04-17
**Generated:** 2026-05-16T22:18:51Z

## Headline

- **N signals:** 31
- **Win rate:** 32.3%
- **Avg R:** 0.599
- **Expectancy / signal:** $65.65
- **Cumulative net P&L:** $2,035.00
- **Profit factor:** 1.177
- **Max consecutive losers:** 8
- **Sharpe (signal-day, annualized):** 1.034
- **Max drawdown:** -$4,927.50 (-167.6%)

## Hit rate by time-of-day

| Bucket (UTC)  | N | Win rate | Expectancy ($) |
| ------------- | - | -------- | -------------- |
| 13:30-13:45 | 0 | — | — |
| 13:45-14:00 | 31 | 32.3% | $65.65 |
| 14:00-14:30 | 0 | — | — |
| 14:30-15:30 | 0 | — | — |
| 15:30-16:30 | 0 | — | — |
| 16:30-17:30 | 0 | — | — |
| 17:30-18:00 | 0 | — | — |
| 18:00-19:00 | 0 | — | — |
| 19:00-20:00 | 0 | — | — |

## Caveats

- **Sharpe is signal-day-only** — non-signal days are dropped, not zero-filled. A low-frequency setup with a few large wins will look better here than in deployment. Compare *expectancy × signal frequency* across setups for a deployment-grade view.
- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. Net of cost. Conservative for liquid midday, tight for the open and around news.
- **R-multiple denominator uses pre-slippage entry** (chart risk), numerator is net P&L — slippage flows only into the numerator.

## Threshold for go/no-go

- N signals ≥ 20: YES
- Expectancy > 0: YES
- Profit factor > 1.3: NO

## Notes

**Fires at minute 15 of RTH only.** This setup is one-shot per day — we evaluate exactly when the first 15min RTH window closes. Before minute 15: not enough data. After minute 15: window closed, no re-fire.

**Pattern**: classic auction-failure / liquidity-grab. ETH session (17:00 ET prior day → 09:30 ET) sets a range. First 15min of RTH sweeps one extreme (probably stop-running) then reverts inside the range. Reversion = failed auction → fade the sweep toward the opposite extreme.

**Econ-calendar disqualifier enabled.** Curated CSV at ``ml/data/econ_calendar.csv`` lists FOMC / CPI / NFP / PCE dates over 2025-04 → 2026-04 (~50 events). If today is one of those dates, the signal is skipped — sweeps on news days are news-driven, not auction-failure.
