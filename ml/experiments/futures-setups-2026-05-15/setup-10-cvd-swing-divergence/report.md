# Setup: `cvd-swing-divergence`

**Test window:** 2026-01-01 → 2026-04-17
**Generated:** 2026-05-16T22:57:57Z

## Headline

- **N signals:** 445
- **Win rate:** 32.4%
- **Avg R:** -0.359
- **Expectancy / signal:** -$20.45
- **Cumulative net P&L:** -$9,102.08
- **Profit factor:** 0.873
- **Max consecutive losers:** 18
- **Sharpe (signal-day, annualized):** -1.957
- **Max drawdown:** -$14,170.89 (-314.6%)

## Hit rate by time-of-day

| Bucket (UTC)  | N | Win rate | Expectancy ($) |
| ------------- | - | -------- | -------------- |
| 13:30-13:45 | 0 | — | — |
| 13:45-14:00 | 0 | — | — |
| 14:00-14:30 | 36 | 27.8% | -$85.09 |
| 14:30-15:30 | 96 | 38.5% | -$91.12 |
| 15:30-16:30 | 88 | 39.8% | $108.57 |
| 16:30-17:30 | 79 | 25.3% | -$44.17 |
| 17:30-18:00 | 34 | 32.4% | $92.91 |
| 18:00-19:00 | 63 | 25.4% | -$78.80 |
| 19:00-20:00 | 49 | 30.6% | -$31.64 |

## Caveats

- **Sharpe is signal-day-only** — non-signal days are dropped, not zero-filled. A low-frequency setup with a few large wins will look better here than in deployment. Compare *expectancy × signal frequency* across setups for a deployment-grade view.
- **Slippage = 1.5 ticks per side** plus **$1.25/side commission**. Net of cost. Conservative for liquid midday, tight for the open and around news.
- **R-multiple denominator uses pre-slippage entry** (chart risk), numerator is net P&L — slippage flows only into the numerator.

## Threshold for go/no-go

- N signals ≥ 20: YES
- Expectancy > 0: NO
- Profit factor > 1.3: NO

## Notes

**Setup 6 successor.** Setup 6 fired 856 times in 92 days because its 'new session high AND CVD < prior peak' check trivially passed in trending sessions. 6b replaces that with fractal-3 swing-pivot detection: a swing high needs the 3 bars before AND 3 bars after to all have lower highs. Plus a minimum retracement gate (≥5pts ES) between consecutive swings.

**Confirmation lag**: a swing pivot at minute T can only be confirmed at T+3 (after the 3 confirming bars print). So the evaluator's most-recent confirmed swing is always at-or-before now-3. This is point-in-time safe by construction.

**Target = session VWAP** (the natural mean-reversion magnet). Stop = 1pt past the current swing extreme.

**News-catalyst disqualifier**: still skipped (no econ feed). Could share the econ_calendar.csv from Setup 3 — TODO.
