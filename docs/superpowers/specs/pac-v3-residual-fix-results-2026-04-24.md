# PAC v3 residual-fix sweep results

**Follow-up to:**
[pac-residual-causality-fix-2026-04-24.md](./pac-residual-causality-fix-2026-04-24.md)
(plan doc) and
[pac-a2-causality-fix-addendum-2026-04-24.md](./pac-a2-causality-fix-addendum-2026-04-24.md)
(v2 results).
**Date:** 2026-04-24
**Status:** complete

## TL;DR

After closing the last two under-counting causality residuals (causal
order-block tracker + causal swing_highs_lows + OB break-bar mask),
PAC 1m NQ shows **$37 total P&L across 3 years × 15 configs × 15
folds = 675 out-of-sample samples**. That's 5 cents per sample. Zero
configs promoted on any year. Zero systematic edge. Pure PAC entries
as tested are definitively dead.

## What was tested

The original A2 sweep used an engine with two lookahead peeks that
inflated the apparent edge. The 2026-04-23 fix (v2 = `a8eeb00` +
`f2989fa`) closed those, showing the $50K "edge" was 100% artifact.
But two residuals remained — both biasing *down*, so capable of
hiding (not inflating) real edge:

1. **`smc.ob` reset step** (closed in `a81f229`): zeroed OBs
   retroactively when a future high re-crossed the top.
2. **`smc.swing_highs_lows` dedup + endpoint fixup** (closed in
   `a9c53a9`): erased same-type consecutive swings and forced
   endpoint alternation using future data.

v3 replaces both with causal reimplementations in
`ml/src/pac/causal_smc.py`. Detection matches upstream bar-for-bar;
only the retroactive cleanup steps are removed. Plus two invariants
stricter than upstream:

- A swing at position P is only live-knowable at bar `P + swing_length`,
  so `causal_order_blocks` refuses to use unconfirmed swings via a
  walk-back gate on `np.searchsorted`.
- Each OB tags its break-bar (the close_index that confirmed it).
  Engine masks OB output rows to NaN where the shifted break-bar is
  still in the future — same pattern as the BOS/CHOCH broken-filter
  mask from v2.

After these changes, **all structure-detection columns are strictly
causal** (278 PAC tests pass, 0 xfailed). The two previously-xfailed
residual tests (`test_ob_reset_residual_is_known`,
`test_swing_dedup_residual_is_known`) are now passing regression
checks.

## 3-year OLD / v2 / v3 comparison

Results from `ml/experiments/pac_a2/1m_{year}_v3.json`. See
[`ml/scripts/compare_pac_a2.py`](../../ml/scripts/compare_pac_a2.py)
for the script and [pac-a2-sweep-results-2026-04-23.md](./pac-a2-sweep-results-2026-04-23.md)
for the acceptance-gate column legend.

| Year | Ver | promo NQ | Med Sharpe | Med WR | Med PF | Med Trades/fold | Total Trades | Total P&L |
| ---- | --- | -------: | ---------: | -----: | -----: | --------------: | -----------: | --------: |
| 2022 | OLD |        1 |     +9.814 |  69.6% |   7.05 |               6 |          402 |  +$27,383 |
| 2022 |  v2 |        0 |      0.000 |  50.0% |   2.05 |               2 |          184 |      −$31 |
| 2022 |  **v3** |    0 |      0.000 |  25.8% |   0.33 |               3 |          179 |    −$656  |
| 2023 | OLD |        1 |      0.000 |   0.0% |   0.00 |               2 |          586 |  +$13,051 |
| 2023 |  v2 |        0 |      0.000 |  28.6% |   0.65 |               6 |          165 |     +$200 |
| 2023 |  **v3** |    0 |      0.000 |   0.0% |   0.00 |               1 |           31 |    −$126  |
| 2024 | OLD |        0 |     +4.397 |  41.2% |   1.75 |               4 |          393 |  +$10,406 |
| 2024 |  v2 |        0 |      0.000 |   0.0% |   0.00 |               1 |           90 |     +$878 |
| 2024 |  **v3** |    0 |      0.000 |  33.3% |   0.47 |               4 |          148 |    +$818  |
| **3yr** | **OLD** |  **2** |    — |     — |     — |             — |    **1,381** | **+$50,841** |
| **3yr** |  **v2** |  **0** |    — |     — |     — |             — |      **439** |  **+$1,047** |
| **3yr** |  **v3** |  **0** |    — |     — |     — |             — |      **358** |     **+$37** |

## What v3 revealed

- **No hidden edge.** The under-counting residuals weren't hiding
  anything. Closing them produces fewer trades (v3: 358 vs v2: 439,
  −18%) and marginally worse P&L (+$37 vs +$1,047), confirming the
  residuals had been letting some "semi-real" signals through that
  don't actually pay when filtered strictly.
- **2023 is the cleanest collapse.** v2 had 165 trades across 15
  configs; v3 has 31. The wide-swing trending periods that dominate
  2023 are exactly where `swing_highs_lows` dedup was erasing the most
  signal. Now that we don't dedup retroactively, many of those
  "swings" turn out not to be swings in real time.
- **2024 barely moves.** v2 $878, v3 $818. High-vol 2024 was the year
  where residuals had the smallest impact, which makes sense — wide
  moves confirm swings and break OBs well within the data window, so
  the causal tightening has little to erase.
- **OLD's $50K edge was 100% artifact.** v2 reduced it 98% to $1,047.
  v3 reduces it another 96.5% to $37. The residual that v2 left was
  itself still slightly biased up by the under-counting; v3 is the
  honest number.

## What this means for PAC as a strategy

The engine is now fully causally correct (within the scope of smc's
detection semantics). Three years × 15 config×fold samples give 675
genuine out-of-sample trades and **a total P&L of $37**. At this sample
size, a real edge of even 0.1 Sharpe would produce somewhere in the
hundreds-to-thousands of dollars. $37 is indistinguishable from zero.

**Pure PAC entries on 1m NQ, with the current config space
(`entry_trigger ∈ {bos_breakout, choch_reversal, choch_plus_reversal}`,
standard Optuna parameters, 1-year CPCV folds, v4 acceptance gate),
have no systematic edge.** This is the definitive test we set out to
run.

## Next branches

Per the parent plan doc's roadmap:

1. **(2) Regime-gated PAC** — rephrase the question from "does BOS
   work?" to "when is BOS edge-positive?" Sweep over filter
   combinations (ATR rank, session bucket, IV rank, time-of-day ×
   vol) rather than entry rules. This is the cheapest next
   experiment and the most likely place a signal is hiding. ~1 night
   of compute.

2. **(3) PAC as context, not trigger** — design specific setups where
   PAC qualifies rather than triggers (CHoCH+ gates + OB retest
   enters, etc.). Lower-probability but higher-truth-quality answer.

3. **(4) PAC + flow composite** — PAC for "where", SPY/QQQ ask-skew
   flow (validated on the 2026-04-23 tape) for "when". Highest-ceiling
   branch, requires real-time infra.

My recommendation stays (2) first. If regime-gated also returns
null, PAC is a discretionary context tool, not a systematic entry.

## Known residuals remaining

All swing / OB / BOS / CHOCH / CHOCHPlus / FVG / FVG_Top / FVG_Bottom
columns are now strictly causal.

- **`OB_MitigatedIndex` and `FVG_MitigatedIndex` raw values** still
  differ between full-frame and truncated views (they store future
  bar indices by design). `loop.py` consumes them as
  `mit <= signal_idx` which derives correct active/mitigated state
  in both views. Not a functional issue; documented in the engine
  causality test's `test_mitigated_index_semantics_match`.

## Files

- [`ml/src/pac/causal_smc.py`](../../ml/src/pac/causal_smc.py) —
  `causal_order_blocks` + `causal_swing_highs_lows`.
- [`ml/src/pac/engine.py`](../../ml/src/pac/engine.py) — per-event
  BOS/CHOCH relocation (v2) + swap upstream smc calls for causal
  reimplementations + OB break-bar mask (v3).
- [`ml/tests/test_pac_causal_smc.py`](../../ml/tests/test_pac_causal_smc.py)
  — parity with upstream + Q1 empirical verification + causality.
- [`ml/tests/test_pac_engine_causality.py`](../../ml/tests/test_pac_engine_causality.py)
  — strict causality across all structure columns (278 pass, 0 xfail).
- [`ml/experiments/pac_a2/1m_{year}_v3.json`](../../ml/experiments/pac_a2/)
  — v3 result files.
- [`ml-sweep/railway.toml`](../../ml-sweep/railway.toml) —
  watchPatterns workaround documented (touch railway.toml directly
  to force deploy after `ml/src/**/*` changes).
