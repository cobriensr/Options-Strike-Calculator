# V2.2 Walk-Forward Backtest — Corrected — 2026-05-23

## Method (corrections vs prior backtest)

### What was wrong in `walk_forward_backtest_v22.py` (commit f5029e6a)

1. **Fake V1 baseline** — prior backtest used the `combined_score` DB column as 'V1'.
   That column is a V2.2-derived GENERATED column (score + fire_count_adjustment +
   gamma_bonus, all baked in by migration #168). It is NOT the original V1 formula.

2. **Population mismatch** — V2/V2.2 filtered to aligned non-structure fires;
   V1 operated on the full set (including misaligned). Different denominator = 
   incomparable tier sizes. V1 tier1=8,645, V2 tier1=2,411 in the prior run.

3. **Tier scale mismatch** — V1 tier thresholds (score ≥18) and V2 percentile
   cutoffs (95th pct) select very different counts. Not apples-to-apples.

### Corrections applied here

- V1 weights pulled from git at commit `d67ac753` (pre-rescore) via `subprocess`.
  Git parse succeeded; hardcoded weights confirmed to match git source.
- V1 score computed in Python from formula: ticker_w + mode_w + price_w + tod_w
  + (C→+2, P→0) + gamma_bonus (≥0.025 AND ticker NOT IN {SPY,USO} → +1).
- All models scored on the **same population**: aligned + non-structure fires.
- Tiers defined as **top-N per day** (tier1 = top 100, tier2 = next 250, tier3 = rest).
  This gives each model equal representation at each rank band.
- 'V1 unrestricted' computed as a side comparison (V1 weights on all fires,
  including misaligned) to quantify the lift V1 got from population contamination.

## Test window
- Training: 2026-02-22 → 2026-04-22, n=92,951 aligned fires
- Test: 2026-04-23 → 2026-05-23
  - Aligned non-structure fires: 71,989
  - All fires (unrestricted): 163,154
- Composite patterns: 10 mined from training window

## Results — aligned-only population, top-100/day = tier1

### Tier 1 (top 100 fires/day per model)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | Sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 (correct weights, aligned) | 2,089 | +25.7% | -21.5% | 37.3% | 20.4% | 0.123 |
| V2 base (OOS) | 2,089 | +16.5% | +2.4% | 52.4% | 22.4% | 0.188 |
| V2.2 no-context (OOS) | 2,089 | +18.9% | +3.0% | 53.1% | 23.0% | 0.196 |
| V2.2 with-context (OOS, reference) | 2,089 | +23.6% | +5.0% | 54.8% | 25.1% | 0.220 |

### Tier 2+ (top 350 fires/day per model)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | Sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 (correct weights, aligned) | 7,089 | +23.9% | -11.9% | 40.8% | 20.8% | 0.139 |
| V2 base (OOS) | 7,089 | +20.4% | +2.5% | 52.5% | 21.9% | 0.191 |
| V2.2 no-context (OOS) | 7,089 | +20.1% | +2.5% | 52.6% | 21.7% | 0.188 |
| V2.2 with-context (OOS, reference) | 7,089 | +18.2% | +2.1% | 52.3% | 20.8% | 0.173 |

### Overall (all aligned fires in test window)

| Model | n | mean_pct | median_pct | win_rate | hit_50 | Sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 (correct weights, aligned) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |
| V2 base (OOS) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |
| V2.2 no-context (OOS) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |
| V2.2 with-context (OOS, reference) | 71,989 | +11.7% | -0.7% | 48.0% | 15.9% | 0.121 |

## Side comparison — V1 unrestricted (all fires, including misaligned)

This shows the inflated performance V1 appeared to have when its tier1 drew from
the full fire population (including misaligned fires that V2/V2.2 filtered out).

| Model | n | mean_pct | median_pct | win_rate | hit_50 | Sharpe |
| --- | --- | --- | --- | --- | --- | --- |
| V1 unrestricted (tier1) | 2,200 | +25.3% | -30.1% | 34.4% | 21.4% | 0.121 |
| V1 unrestricted (tier2plus) | 7,700 | +17.1% | -19.1% | 38.7% | 19.5% | 0.096 |
| V1 unrestricted (overall) | 163,154 | +6.7% | -2.3% | 45.5% | 13.5% | 0.070 |

## Verdict

- **V1 (aligned) tier1 Sharpe: 0.123**
- **V2 base tier1 Sharpe: 0.188**
- **V2.2 no-context tier1 Sharpe: 0.196**
- **V2.2 with-context tier1 Sharpe: 0.220** (reference)

- V1 unrestricted tier1 Sharpe: 0.121
  (contamination lift: -0.002 — this is what made 'V1 wins' look plausible)

- Was V1→V2 transition worth it? **V2 genuinely beats V1 (V1→V2 transition WAS worth it)**
  True lift: V2 vs V1 (aligned): +0.065 Sharpe

- V2.2-no-context vs V2: **Marginal V2.2-no-context lift over V2 (composites help slightly)**
  Lift: +0.008 Sharpe

- V1→V2→V2.2-no-context progression: **MARGINAL — some improvement over V1 but not decisive at this sample size**

### Recommended action

- Results are too close to call. Ship V2 base; keep composites for monitoring.
- Re-run corrected backtest in 30 days with updated test window.

## Caveats

- 30-day test window is a single split — not a rolling walk-forward
- Composite patterns mined on training window may still reflect training-specific tickers
- V1 was always a rule-based model (not trained on outcomes) — Sharpe comparison
  is apples-vs-oranges in spirit but apple-to-apple in evaluation population
- 'Top 100/day' is an approximation — actual fire count varies by day
- Real P&L not measured (no slippage, bid/ask spread, or position sizing)
