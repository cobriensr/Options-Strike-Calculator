# Setup: `cvd-divergence-fade`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T20:39:18Z

## Headline

- **N signals:** 856
- **Win rate:** 20.2%
- **Avg R:** -0.331
- **Expectancy / signal:** -$41.50
- **Cumulative net P&L:** -$35,520.68
- **Profit factor:** 0.731
- **Max consecutive losers:** 24
- **Sharpe (signal-day, annualized):** -5.176
- **Max drawdown:** -$37,371.71 (-3157.1%)

## Hit rate by time-of-day

| Bucket (UTC) | N   | Win rate | Expectancy ($) |
| ------------ | --- | -------- | -------------- |
| 13:30-13:45  | 0   | —        | —              |
| 13:45-14:00  | 0   | —        | —              |
| 14:00-14:30  | 114 | 28.9%    | -$44.88        |
| 14:30-15:30  | 309 | 22.3%    | -$49.08        |
| 15:30-16:30  | 143 | 17.5%    | -$25.54        |
| 16:30-17:30  | 92  | 17.4%    | -$14.92        |
| 17:30-18:00  | 48  | 12.5%    | $7.82          |
| 18:00-19:00  | 66  | 9.1%     | -$95.35        |
| 19:00-20:00  | 84  | 21.4%    | -$51.16        |

## Caveats

- **Sharpe is signal-day-only** — non-signal days are dropped, not zero-filled. A low-frequency setup with a few large wins will look better here than in deployment. Compare _expectancy × signal frequency_ across setups for a deployment-grade view.
- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. Net of cost. Conservative for liquid midday, tight for the open and around news.
- **R-multiple denominator uses pre-slippage entry** (chart risk), numerator is net P&L — slippage flows only into the numerator.

## Threshold for go/no-go

- N signals ≥ 20: YES
- Expectancy > 0: NO
- Profit factor > 1.3: NO

## Notes

**KNOWN ISSUE — divergence detector over-fires.** The spec says 'new session high AND CVD lower-high'. We interpret this as: current bar high == running session max AND current CVD < prior CVD peak. In a steadily trending session this fires every minute (every new bar IS the session high), and CVD oscillates naturally, so the divergence condition is almost always 'satisfied' even when there's no actual swing structure. **Result: 856 signals in 92 days (~9/day), 20.2% WR, -$41.50 expectancy, -$35,520 cum P&L.** This is the single largest losing setup in the run.

**Proper interpretation** would require swing-high detection: prior peak must be FOLLOWED by a meaningful retracement before the new high counts. That's the trader's mental model of 'divergence'. The spec's anti-tuning rule forbids retrofit, so this run reports the permissive read honestly — and the data clearly says 'no edge'.

**Recommendation**: do not productionize Setup 6 as written. A future revision with proper swing-pivot detection (e.g., fractal highs requiring N-bar lookback on each side) might salvage the thesis, but should be tested as a NEW setup, not a retune.

**News catalyst disqualifier**: skipped (no econ-calendar feed).
