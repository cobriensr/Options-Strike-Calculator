# PAC regime-gated sweep — Phase 1 results (150 trials × 6 chunks)

**Parent:** [pac-regime-gated-sweep-2026-04-24.md](./pac-regime-gated-sweep-2026-04-24.md)
**Date:** 2026-04-25
**Status:** Phase 1 complete; recommendation = Phase 3 winner inspection on 5m

## TL;DR

Re-ran the 3-year sweep at **150 Optuna trials per fold** (5× the v3 budget),
extending to both 1m and 5m. **1m is definitively dead** across 3 years (−$734
total, 0 promotions). **5m has mixed signal**: 2 of 3 years produce positive
P&L with one year hitting Sharpe +2.07 and 67% WR, but no year clears the
strict acceptance gate. Total 6-chunk P&L: **+$2,007 across 218 trades**.

This isn't a clean "go" or clean "no go." The plan's strict criteria call
this null (no 2-of-3-year acceptance-gate pass). A softer reading says
5m may have year-conditional edge worth a Phase 3 winner inspection
before pivoting to the event classifier.

## Results

| Chunk    | Sharpe | WR    | Trades | P&L      | Promo |
|----------|-------:|------:|-------:|---------:|------:|
| 1m_2022  |  +0.00 | 25.0% | 31     | −$568    | 0     |
| 1m_2023  |  +0.00 |  0.0% | 25     | +$219    | 0     |
| 1m_2024  |  +0.00 |  0.0% | 71     | −$385    | 0     |
| **5m_2022** | **+2.07** | **66.7%** | 45 | **+$1,507** | 0 |
| 5m_2023  |  +0.00 |  0.0% | 27     | −$417    | 0     |
| 5m_2024  |  +0.00 | 50.0% | 19     | +$1,651  | 0     |
| **3yr 1m** |  —   |  —    | **127** | **−$734** | **0** |
| **3yr 5m** |  —   |  —    | **91**  | **+$2,741** | **0** |
| **6yr total** | — | —   | **218** | **+$2,007** | **0** |

## Interpretation

### 1m: same null, deeper search

v3 @ 30 trials produced 358 trades / +$37 P&L. t150 @ 150 trials produces
127 trades / −$734 P&L. The 5× more samples didn't reveal hidden edge —
they converged on more restrictive configs that trade less and lose more
on average. Confirms the 1m surface is genuinely flat: the optimizer is
working, the answer is just zero.

### 5m: mixed and worth a closer look

Two interesting datapoints:

- **5m_2022**: median fold Sharpe +2.07, 67% WR, 45 trades, +$1,507. The
  median fold has 3 trades, so it's not just one outlier fold; the signal
  is distributed across multiple folds.
- **5m_2024**: median fold Sharpe 0 (most folds zero-trade) but P&L
  +$1,651 across 19 trades = ~$87/trade gross. This is the "lottery
  ticket" pattern — a few well-placed trades carrying the year.
- **5m_2023**: dead. 27 trades, −$417, 0% median WR.

Why 5m might genuinely differ from 1m:

- Less microstructure noise per bar — BOS/CHoCH events less likely to
  fire on transient ticks
- Wider swing distances mean OBs are larger and harder to mistake for
  noise zones
- Optuna at 150 trials covers the 5m search surface more thoroughly
  (5× fewer bars per year so each trial is faster and the optimizer
  visits more configs in the same wall-clock budget)

Why this might still be cherry-picking:

- 5m_2022 was a low-volatility chop year — the regime where short-stop /
  ATR-target strategies tend to overfit
- 5m_2024 P&L sits on 19 trades, which doesn't survive any normal
  significance threshold
- The acceptance gate (3-year robustness) is the right rigor and 5m
  fails it

### Why no promotions?

The acceptance gate is calibrated for cross-market validation across a
3-year window with multi-metric thresholds (Sharpe, PBO, fold
consistency, drawdown caps). A single 1-year run with high-variance
fold metrics — even with positive median Sharpe — typically can't
pass. The 0/0/0 promo column tells us we shouldn't trade these
specific configs. It doesn't tell us whether the signal is real.

## Recommendation

**Phase 3 winner inspection on 5m.** Cheap experiment (~half day),
high information value:

1. Pull the best-Sharpe config from 5m_2022 (the +2.07 fold winner).
2. Replay it on 5m_2023 and 5m_2024 OOS. Does the SAME config remain
   profitable? Or was it 2022-regime-specific?
3. Same exercise for 5m_2024's best config replayed on 2022, 2023.
4. If either config survives 2-of-3 years with Sharpe > 1.0 on
   trade-by-trade replay, the signal is robust enough to investigate
   further (cross-market with ES, longer fold horizons, paper-trading
   on a small size).
5. If neither survives, the apparent 5m signal was year-specific
   regime fitting. Pivot to the event classifier (Option A,
   `pac-event-classifier-2026-04-24.md`) without further sweep work.

Phase 2 of the regime-gated plan (add ATR rank, trend regime, gap
features) is **lower priority** now. The 5m signal — if real — is
visible without those new dimensions, so we'd be adding complexity
to a working slice rather than rescuing a null. Defer Phase 2 until
after Phase 3 winner inspection clarifies what we're working with.

## Files

- `ml/experiments/pac_a2/{1m,5m}_{2022,2023,2024}_t150.json` — 6 result
  files from this campaign.
- Result download URLs: see Vercel Blob `sweeps/2026-04-{24,25}/...`.

## Reference

- Parent plan: `pac-regime-gated-sweep-2026-04-24.md`
- v3 baseline: `pac-v3-residual-fix-results-2026-04-24.md`
- Event classifier fallback: `pac-event-classifier-2026-04-24.md`
- A2 sweep (original lookahead-biased): `pac-a2-sweep-results-2026-04-23.md`
