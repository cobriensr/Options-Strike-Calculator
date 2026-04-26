# PAC A2 sweep — causality-fix addendum

**Follow-up to:** [pac-a2-sweep-results-2026-04-23.md](./pac-a2-sweep-results-2026-04-23.md)
**Date:** 2026-04-24
**Scope:** re-ran the 3 × 1m chunks (2022, 2023, 2024 × NQ) against the causality-corrected PAC engine ([commit `a8eeb00`](../../ml/src/pac/engine.py) + deploy-fix [`f2989fa`](../../ml-sweep/railway.toml)).
**TL;DR:** the entire apparent edge in the original A2 report was lookahead artifact. With the BOS/CHOCH peek closed, all three years show ~zero systematic edge.

## What was wrong

The original A2 engine shift was `1 × swing_length`, which correctly handled `smc.swing_highs_lows`'s centered-window peek but missed two additional lookahead layers inside `smc.bos_choch`:

1. **Labeling peek (3 × swing_length on average).** `bos_choch` labels BOS at `last_positions[-2]` — the 3rd-most-recent swing in a 4-swing pattern — when the 4th swing has arrived and been confirmed. A label at bar T needs data through `max(P3 + swing_length, broken[T])`, which on 1m with default `swing_length = 5` is typically 15 bars of future info, sometimes much more.
2. **Broken-filter peek (unbounded).** `bos_choch` drops events whose levels were never broken later in the series (lines 335–360). Events that appear in output survived because of future break info; they shouldn't be visible to the backtest before the break actually occurs.

The fix in `ml/src/pac/engine.py` is a **per-event `knowable_at` relocation**: for each raw BOS/CHOCH event at pre-shift position `P0`, compute `knowable_at = max(P3 + swing_length, broken[P0])` and move the event's value to that row in the output. Events whose `knowable_at ≥ len(df)` are dropped (confirmed only by out-of-frame data).

See [`test_pac_engine_causality.py`](../../ml/tests/test_pac_engine_causality.py) for the strict parametric test (2 fixtures × 3 swing_lengths × 3 truncation points = 18 assertions on BOS/CHOCH/Level_bc/CHOCHPlus + FVG columns).

## Deploy trap worth documenting

The first re-run returned byte-identical output to the original A2. Root cause: `railway.toml`'s `watchPatterns = ["ml/src/**"]` did not recurse into `ml/src/pac/engine.py`. Railway's glob matcher needs the explicit `/*` suffix — `ml/src/**/*` — to trigger on deep files. `railway redeploy` rebuilds the currently-running image rather than pulling HEAD, so it can't fix a bad watchPattern.

Fix: narrowed patterns to `ml/src/**/*` and `ml/scripts/**/*` (commit [`f2989fa`](../../ml-sweep/railway.toml)). Verified via a fresh HEAD deploy that the engine change landed before re-running.

## Results

### 3-year OLD vs NEW

| Year    | Version | Promotions (XMkt / NQ-only / Rej) | Med Sharpe |    Med WR |   Med PF | Med Trades/fold | Total Trades |    Total P&L |
| ------- | ------- | --------------------------------- | ---------: | --------: | -------: | --------------: | -----------: | -----------: |
| 2022    | OLD     | 0 / **1** / 14                    |  **+9.81** | **69.6%** | **7.05** |               6 |          402 | **+$27,383** |
| 2022    | **NEW** | 0 / **0** / 15                    |  **+0.00** | **50.0%** | **2.05** |               2 |          184 |     **−$31** |
| 2023    | OLD     | 0 / **1** / 14                    |       0.00 |      0.0% |     0.00 |               2 |          586 | **+$13,051** |
| 2023    | **NEW** | 0 / **0** / 15                    |       0.00 |     28.6% |     0.65 |               6 |          165 |    **+$200** |
| 2024    | OLD     | 0 / 0 / 15                        |  **+4.40** | **41.2%** | **1.75** |               4 |          393 | **+$10,406** |
| 2024    | **NEW** | 0 / 0 / 15                        |  **+0.00** |      0.0% |     0.00 |               1 |           90 |    **+$878** |
| **3yr** | **OLD** | **0 / 2 / —**                     |          — |         — |        — |               — |    **1,381** | **+$50,841** |
| **3yr** | **NEW** | **0 / 0 / —**                     |          — |         — |        — |               — |      **439** |  **+$1,047** |

### What changed

- **Zero configs promoted** across all three years (vs 2 under OLD). No single config survives the acceptance gate on 1-year windows once the peek is gone.
- **Trade count fell 68%** (1,381 → 439). The lookahead was enabling entries that wouldn't have been visible live.
- **Total P&L fell 98%** ($50,841 → $1,047). $1,047 across 3 years × 15 configs is literally rounding error — no economic signal.
- **2024 is the cleanest collapse.** Original A2 called this one "the most credible datapoint" because +4.4 Sharpe at 41% WR looked plausibly real. NEW run shows 0.00 Sharpe, 0% median WR, 1 median trade/fold, $878 total — the apparent 2024 edge was fully lookahead too.

## Known residuals (bias down, not up)

Two smc library issues remain, both documented as xfail in the causality test:

1. **`swing_highs_lows` dedup.** A swing at bar T can be erased retroactively if a later same-type swing is more extreme.
2. **`smc.ob` reset.** An OB at bar T is zeroed out if a future high re-crosses its top.

Both cause _under-counting_ (live trader would have seen signals the post-hoc output erases), not over-counting. If we fixed them the NEW Sharpe numbers could tick up slightly — but the OLD-vs-NEW direction wouldn't change. None of these residuals can manufacture the +9.8 Sharpe the OLD engine produced.

## What this means for the PAC thesis

The strategy as tested — BOS/CHOCH entries on 1m NQ, 15-fold CPCV, 30 Optuna trials, current acceptance gate — **has no systematic edge** across three distinct market regimes (2022 chop, 2023 bull, 2024 high-vol). Three years × 15 configs × 15 folds = 675 independent oos samples giving a $1,047 total result.

Possible next-step branches (none are "PAC works as-built"):

- **Different timeframes.** Didn't re-test 5m here; the original A2 already showed 5m null, so that's probably dead too. 15m or 30m remain untested.
- **Different entry rules.** Current sweep uses `bos_breakout` and `choch_reversal`. Liquidity-sweep or OB-retest entries (once the OB reset residual is fixed) could behave differently.
- **Different markets.** A2 was NQ-only. Adding ES and running cross-market gate may reveal correlated edge that disappears when gated on both.
- **Different horizons.** 1-year windows are short. 2-year or 3-year folds with 60-trial Optuna may find configs that 1-year can't.

Before any of the above, it's also worth **fixing the two known residuals**. If the real edge is 0.1 Sharpe instead of 0.0, the OB/swing-dedup correction is the only thing that would reveal it.

## Files

- [`ml/src/pac/engine.py`](../../ml/src/pac/engine.py) — per-event `knowable_at` relocation + `_relocate_bos_events_causally` helper
- [`ml/tests/test_pac_engine_causality.py`](../../ml/tests/test_pac_engine_causality.py) — parametric strict-causality test + xfail residuals
- [`ml/experiments/pac_a2/1m_{2022,2023,2024}_fixed.json`](../../ml/experiments/pac_a2/) — the three NEW result files
- [`ml-sweep/railway.toml`](../../ml-sweep/railway.toml) — narrowed + recursive watchPatterns
