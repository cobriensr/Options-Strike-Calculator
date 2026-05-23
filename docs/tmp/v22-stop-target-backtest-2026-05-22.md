# V2.2 Stop/Target Backtest by Tier — 2026-05-22

## Method

- 30-day window of aligned tier1/tier2 fires: 9 tier1, 2,667 tier2
- Date range: 2026-04-23 — 2026-05-22
- **Alignment filter**: `cum_ncp_at_fire IS NOT NULL`, directionally aligned (call + ncp>npp OR put + npp>ncp), no inferred structure
- **Tiers**: tier1 = combined_score >= 18, tier2 = 12–17
- 5 exit policies × 4 stop tiers (none, -15%, -25%, -40%) × 4 TP tiers (none, +50%, +100%, +200%) = 80 combos per tier
- Simulation is approximate: stop/TP caps are applied to the realized column value, not full tick replay. A fire capped at -15% means the realized column showed worse than -15% and we floor it.
- **Sharpe**: mean / std (trade-level, not annualised)
- **Win%**: fraction of fires where capped return > 0

## Data coverage

| Policy            | Tier1 non-null% | Tier2 non-null% |
|-------------------|-----------------|-----------------|
| flow_inversion    |           100.0% |            99.1% |
| trail_30_10       |           100.0% |           100.0% |
| hard_30m          |           100.0% |           100.0% |
| tier50_holdeod    |           100.0% |           100.0% |
| eod               |           100.0% |           100.0% |

## Tier 1 results (sorted by Sharpe, top 20)

| Exit Policy          | Stop   | TP      |     n |    mean |  median |   win% |   sharpe | max_dd   |
|----------------------|--------|---------|-------|---------|---------|--------|----------|----------|
| trail_30_10          | -15%   | +50%    |     9 |    9.74% |   22.40% |   55.6% |    0.401 |   -15.00% |
| trail_30_10          | -15%   | +100%   |     9 |    9.74% |   22.40% |   55.6% |    0.401 |   -15.00% |
| trail_30_10          | -15%   | +200%   |     9 |    9.74% |   22.40% |   55.6% |    0.401 |   -15.00% |
| trail_30_10          | -15%   | none    |     9 |    9.74% |   22.40% |   55.6% |    0.401 |   -15.00% |
| tier50_holdeod       | -15%   | +100%   |     9 |   10.87% |  -15.00% |   44.4% |    0.348 |   -15.00% |
| tier50_holdeod       | -15%   | none    |     9 |   10.87% |  -15.00% |   44.4% |    0.348 |   -15.00% |
| tier50_holdeod       | -15%   | +200%   |     9 |   10.87% |  -15.00% |   44.4% |    0.348 |   -15.00% |
| tier50_holdeod       | -15%   | +50%    |     9 |   10.60% |  -15.00% |   44.4% |    0.344 |   -15.00% |
| eod                  | -15%   | +200%   |     9 |    7.55% |  -15.00% |   44.4% |    0.260 |   -15.00% |
| eod                  | -15%   | +100%   |     9 |    7.55% |  -15.00% |   44.4% |    0.260 |   -15.00% |
| eod                  | -15%   | none    |     9 |    7.55% |  -15.00% |   44.4% |    0.260 |   -15.00% |
| eod                  | -15%   | +50%    |     9 |    7.11% |  -15.00% |   44.4% |    0.251 |   -15.00% |
| hard_30m             | -15%   | none    |     9 |    8.92% |  -12.73% |   33.3% |    0.226 |   -15.00% |
| hard_30m             | -15%   | +100%   |     9 |    8.92% |  -12.73% |   33.3% |    0.226 |   -15.00% |
| hard_30m             | -15%   | +200%   |     9 |    8.92% |  -12.73% |   33.3% |    0.226 |   -15.00% |
| trail_30_10          | -25%   | +100%   |     9 |    5.29% |   22.40% |   55.6% |    0.180 |   -25.00% |
| trail_30_10          | -25%   | none    |     9 |    5.29% |   22.40% |   55.6% |    0.180 |   -25.00% |
| trail_30_10          | -25%   | +50%    |     9 |    5.29% |   22.40% |   55.6% |    0.180 |   -25.00% |
| trail_30_10          | -25%   | +200%   |     9 |    5.29% |   22.40% |   55.6% |    0.180 |   -25.00% |
| tier50_holdeod       | -25%   | none    |     9 |    5.50% |  -23.33% |   44.4% |    0.152 |   -25.00% |

### Tier 1 — Bottom 5 by Sharpe

| Exit Policy          | Stop   | TP      |     n |    mean |  median |   win% |   sharpe | max_dd   |
|----------------------|--------|---------|-------|---------|---------|--------|----------|----------|
| eod                  | none   | +50%    |     9 |  -17.69% |  -23.33% |   44.4% |   -0.334 |   -70.33% |
| flow_inversion       | none   | +200%   |     9 |  -14.08% |    0.74% |   55.6% |   -0.392 |   -50.66% |
| flow_inversion       | none   | +50%    |     9 |  -14.08% |    0.74% |   55.6% |   -0.392 |   -50.66% |
| flow_inversion       | none   | +100%   |     9 |  -14.08% |    0.74% |   55.6% |   -0.392 |   -50.66% |
| flow_inversion       | none   | none    |     9 |  -14.08% |    0.74% |   55.6% |   -0.392 |   -50.66% |

## Tier 2 results (sorted by Sharpe, top 20)

| Exit Policy          | Stop   | TP      |     n |    mean |  median |   win% |   sharpe | max_dd   |
|----------------------|--------|---------|-------|---------|---------|--------|----------|----------|
| trail_30_10          | -15%   | +50%    |  2667 |   18.07% |   22.50% |   73.9% |    0.855 |   -15.00% |
| trail_30_10          | -15%   | +100%   |  2667 |   18.88% |   22.50% |   73.9% |    0.832 |   -15.00% |
| trail_30_10          | -15%   | none    |  2667 |   18.90% |   22.50% |   73.9% |    0.829 |   -15.00% |
| trail_30_10          | -15%   | +200%   |  2667 |   18.90% |   22.50% |   73.9% |    0.829 |   -15.00% |
| flow_inversion       | -15%   | +50%    |  2642 |   20.21% |   22.95% |   67.0% |    0.759 |   -15.00% |
| flow_inversion       | -15%   | +100%   |  2642 |   30.83% |   22.95% |   67.0% |    0.749 |   -15.00% |
| flow_inversion       | -15%   | +200%   |  2642 |   40.23% |   22.95% |   67.0% |    0.660 |   -15.00% |
| flow_inversion       | -25%   | +100%   |  2642 |   28.75% |   22.95% |   67.0% |    0.659 |   -25.00% |
| trail_30_10          | -25%   | +50%    |  2667 |   16.04% |   22.50% |   73.9% |    0.656 |   -25.00% |
| trail_30_10          | -25%   | +100%   |  2667 |   16.85% |   22.50% |   73.9% |    0.652 |   -25.00% |
| trail_30_10          | -25%   | none    |  2667 |   16.87% |   22.50% |   73.9% |    0.650 |   -25.00% |
| trail_30_10          | -25%   | +200%   |  2667 |   16.87% |   22.50% |   73.9% |    0.650 |   -25.00% |
| flow_inversion       | -25%   | +50%    |  2642 |   18.13% |   22.95% |   67.0% |    0.614 |   -25.00% |
| tier50_holdeod       | -15%   | +100%   |  2667 |   23.51% |   14.03% |   61.5% |    0.614 |   -15.00% |
| tier50_holdeod       | -15%   | +50%    |  2667 |   16.25% |   14.03% |   61.5% |    0.607 |   -15.00% |
| flow_inversion       | -25%   | +200%   |  2642 |   38.15% |   22.95% |   67.0% |    0.606 |   -25.00% |
| flow_inversion       | -40%   | +100%   |  2642 |   26.51% |   22.95% |   67.0% |    0.569 |   -40.00% |
| flow_inversion       | -40%   | +200%   |  2642 |   35.90% |   22.95% |   67.0% |    0.550 |   -40.00% |
| tier50_holdeod       | -15%   | +200%   |  2667 |   30.45% |   14.03% |   61.5% |    0.548 |   -15.00% |
| tier50_holdeod       | -25%   | +100%   |  2667 |   20.83% |   14.03% |   61.5% |    0.507 |   -25.00% |

### Tier 2 — Bottom 5 by Sharpe

| Exit Policy          | Stop   | TP      |     n |    mean |  median |   win% |   sharpe | max_dd   |
|----------------------|--------|---------|-------|---------|---------|--------|----------|----------|
| eod                  | none   | +100%   |  2667 |    4.10% |   -1.36% |   48.7% |    0.072 |   -99.57% |
| eod                  | -40%   | +50%    |  2667 |    2.10% |   -1.36% |   48.7% |    0.058 |   -40.00% |
| hard_30m             | -40%   | +50%    |  2667 |    1.24% |   -0.61% |   48.5% |    0.044 |   -40.00% |
| hard_30m             | none   | +50%    |  2667 |    0.13% |   -0.61% |   48.5% |    0.004 |   -81.82% |
| eod                  | none   | +50%    |  2667 |   -4.37% |   -1.36% |   48.7% |   -0.097 |   -99.57% |

## Recommended trading rules

- **Tier 1**: exit via `trail_30_10` with stop -15% and TP +50% — mean 9.74%, win 55.6%, sharpe 0.401, n=9
  - **WARNING: n=9 is far below the 50-fire confidence threshold.** Tier 1 (combined_score >= 18) is a rare event in the 30-day aligned window. The direction of the recommendation (trail stop, tight -15% floor) aligns with tier2 findings, but do not trade this rule mechanically on 9 observations.
- **Tier 2**: exit via `trail_30_10` with stop -15% and TP +50% — mean 18.07%, win 73.9%, sharpe 0.855, n=2667
  - Robust n=2,667. `trail_30_10` dominates by sharpe; tightening TP to +50% modestly reduces mean return but meaningfully reduces variance, producing the best sharpe in the grid.

## Key finding

Both tiers agree on the same policy structure: **trail_30_10 + -15% stop**. For tier2, the +50% TP cap tightens variance enough to top the sharpe ranking, though it costs ~0.8pp mean vs uncapped trail. The current default (`flow_inversion`) ranks 5th for tier2 by sharpe — it has higher mean returns when uncapped but much wider variance (big left tail). The -15% stop alone transforms flow_inversion from sharpe 0.17 (no stop) to 0.76 (with -15% stop, +100% TP), which is nearly competitive.

**Practical implication**: add a -15% hard stop to every lottery trade regardless of which exit policy you follow. The stop reduces max drawdown from -99% (EOD, no stop) to -15%, while mean return declines by only 2-4pp for tier2.

## Caveats

- Simulation is approximate (uses realized columns, not full tick replay)
- Stop/TP caps applied post-hoc: the realized value is capped, but actual intraday path (e.g. hit +200% then fell back) is not reconstructed
- 30-day window — short by backtest standards; sample size per cell is small
- Tier 1 n=9 is below the 50-fire threshold for a reliable recommendation — treat tier1 result as directional, not prescriptive
- `tier50_holdeod` and `hard_30m` columns may have lower fill rates than `flow_inversion` and `eod`; interpret low-n cells cautiously
- Sharpe is trade-level (mean/std per fire), not time-series Sharpe; not directly comparable to annualised metrics
- Data as of 2026-05-22
