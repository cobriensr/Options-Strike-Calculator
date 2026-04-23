# PAC A2 sweep — 3yr × 2tf × NQ results

**Date:** 2026-04-23
**Scope:** 3 years (2022, 2023, 2024) × 2 timeframes (1m, 5m) × NQ only = 6 independent full CPCV+Optuna chunks run on Railway ml-sweep.
**Acceptance:** acceptance.yml v4. 6×2 = 15 CPCV folds per chunk, 30 Optuna trials per fold.
**Raw results:** `ml/experiments/pac_a2/{1m,5m}_{2022,2023,2024}.json`.
**Reproduce:** `ml/.venv/bin/python ml/scripts/compare_pac_a2.py`.

## Cross-chunk table

| Chunk | Folds | Configs | XMkt | NQ-only | Rejected | Med Sharpe | Med WR | Med PF | Med Trades | Total P&L | Train/Test Bars |
| ----- | -----:| -------:| ----:| -------:| --------:| ---------:| ------:| ------:| ----------:| ---------:| ---------------:|
| 1m_2022 | 15 | 15 | 0 | 1 | 14 | +9.81 | 69.6% | 7.05 | 6 | $27,383 | 235,837/118,036 |
| 1m_2023 | 15 | 15 | 0 | 1 | 14 | +0.00 | 0.0% | 0.00 | 2 | $13,051 | 235,359/117,798 |
| 1m_2024 | 15 | 15 | 0 | 0 | 15 | +4.40 | 41.2% | 1.75 | 4 | $10,406 | 235,556/117,898 |
| 5m_2022 | 15 | 15 | 0 | 0 | 15 | +0.00 | 0.0% | 0.00 | 1 | $10,914 | 46,979/23,608 |
| 5m_2023 | 15 | 15 | 0 | 0 | 15 | +0.00 | 0.0% | 0.00 | 1 | $2,322 | 46,887/23,562 |
| 5m_2024 | 15 | 15 | 0 | 0 | 15 | +0.00 | 0.0% | 0.00 | 0 | $4,118 | 46,927/23,582 |

**By timeframe (3-yr totals):**

| Timeframe | Folds | Configs | XMkt | NQ-only | Rejected | Med Sharpe | Med WR | Med PF | Med Trades/fold | Total P&L |
| --------- | -----:| -------:| ----:| -------:| --------:| ---------:| ------:| ------:| --------------:| ---------:|
| **1m** | 45 | 45 | 0 | 2 | 43 | +4.40 | 41.2% | 1.75 | 4 | $50,841 |
| **5m** | 45 | 45 | 0 | 0 | 45 | +0.00 | 0.0% | 0.00 | 1 | $17,355 |

Columns:
- **XMkt / NQ-only / Rejected** are gate verdicts counted at the
  `gate_result.*_count` level. Cross-market gates are unreachable here
  because A2 fires NQ only — all promotions are single-market.
- **Med Sharpe / WR / PF / Trades** are median OOS metrics across the
  15 CPCV folds, not over configs.
- **Total P&L** is the sum of fold-level `total_pnl_dollars` across all
  15 folds and all promoted+non-promoted configs in that chunk.
- **Train/Test Bars** sampled from fold 0.

## Takeaways

### 1. 1m beats 5m on every axis

- Promotion rate: 2/45 folds (4.4%) on 1m; 0/45 on 5m.
- Total P&L: $50,841 on 1m vs $17,355 on 5m (2.9× better, on 5× more
  bars — so per-bar the 5m is roughly 40% of the 1m efficiency).
- Median trades/fold: 4 on 1m vs 1 on 5m. Sample-size alone explains
  part of 5m's null result — with a median of 1 trade per fold, WR and
  Sharpe medians collapse to 0 whenever the median fold has no trade.

### 2. Year-over-year decay on 1m

2022 (Sharpe 9.8, WR 69.6%) → 2023 (Sharpe 0, WR 0%) → 2024 (Sharpe
4.4, WR 41%). Classic regime decay, but the variance between 2022 and
2023 is too large to attribute to regime alone — see the lookahead
caveat below.

### 3. 1m_2022 looks lookahead-inflated

A median **fold** Sharpe of +9.81 with WR 69.6% is implausibly good
even for cherry-picked Optuna best-configs on a single year. The known
Python PAC engine has a `smc.bos_choch` 4-swing pattern that labels
BOS at the H1 swing but requires H2 to validate — a one-bar lookahead.
On 1m this bug biases entries toward the "right side" of small moves;
on 5m the move needed to trigger the next swing is large enough that
the one-bar lookahead is smaller relative to the signal distance,
which is consistent with the 5m chunks all showing 0.

**2024's +4.4 Sharpe / 41% WR is the most credible 1m datapoint** —
elevated volatility shrinks the lookahead's relative advantage.

### 4. 5m is not a viable standalone strategy here

All 45 5m folds show median WR 0%. The positive total P&L
($17,355 summed across 45 folds and 45 configs = ~$386/fold-config)
is at the level of one good trade worth of noise. Any 5m evaluation
needs longer per-year windows, multi-year folds, or a completely
different entry rule before it's even measurable.

## Operational notes from the campaign

- **Total wall-clock: 3h 19min** for all 6 chunks (see log at
  `/tmp/sweep_chain_a2.log`).
- **Per-chunk: 53–55 min** for 1m, **9–10 min** for 5m. The 5× bar
  count ratio translates to 5× wall-clock on Optuna trials.
- **RSS peak: 587 MB** (1m_2024, the longest run). Well under the
  8 GB Railway cap. Memory is not the bottleneck.
- **Three different failure modes hit during the campaign** — each
  distinct, each now mitigated:
  1. Overnight full-sweep zombie (9+ hours stuck "running") →
     heartbeat + orphan recovery, commit `7bd0b89`.
  2. Scale-to-zero killing sweeps at ~T+8min → platform-level fix
     (disabled by user in the dashboard).
  3. Unrelated docs/data commits auto-redeploying the service → narrowed
     `railway.toml` watchPatterns to code-only paths, commit `866f7d6`.

## Follow-ups

**Blocking before trusting any PAC number:**
- Fix the `smc.bos_choch` lookahead bug. 1m_2022's Sharpe 9.8 is not
  actionable until this is resolved. Re-run just the 1m chunks after
  the fix — 5m can stay shelved.

**Not blocking but valuable:**
- Longer horizons (multi-year folds) for 5m — the 1-year window is too
  short to get out of the low-sample-size zone.
- Cross-market (NQ+ES) sweep. A2 was NQ-only to isolate Databento
  archive shape issues; now that the pipeline is proven the next sweep
  should pair with ES.
- Sensitivity run: re-fire 1m_2024 with `n-trials=5` and the lookahead
  fix to sanity-check that the same best-params direction survives a
  deliberately-undertuned Optuna search.

## Reference

- Service: `ml-sweep` on Railway (see `ml-sweep/README.md`).
- Driver script: `ml/scripts/full_cpcv_optuna_sweep.py`.
- Acceptance gate: `ml/src/pac/acceptance.yml` (v4).
- Chain script: `/tmp/sweep_chain_a2.sh`.
- Summary regenerator: `ml/scripts/compare_pac_a2.py`.
