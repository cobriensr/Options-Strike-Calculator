# PAC regime-gated sweep — deeper search + new dimensions

**Parent:** [pac-v3-residual-fix-results-2026-04-24.md](./pac-v3-residual-fix-results-2026-04-24.md)
(v3 null result, fully-causal engine).
**Date:** 2026-04-24
**Status:** planning

## Goal

Test whether PAC has systematic edge **conditional on market regime**, now that
we've proved unconditional PAC does not (v3: $37 across 675 OOS samples).
Find a regime filter combination that makes BOS/CHoCH entries profitable, or
definitively rule that out and move to branch (3) PAC-as-context.

If Phase 2 produces no 2-of-3-year pass, pure PAC entries are dead in every
form we can realistically test and the next meaningful experiment is either
(3) PAC-as-context, (4) PAC + flow composite, or a different entry
framework entirely.

## Honest framing: what we're NOT doing

The v3 addendum called this branch "add regime filters." Having read
`ml/src/pac_backtest/sweep.py`, I can report that Optuna ALREADY searches 15
dimensions including every filter a trader would naturally reach for:

| Existing dimension        | Cardinality | Covers |
| ------------------------- | ----------: | ------ |
| `entry_trigger`           |           5 | BOS/CHoCH variants |
| `exit_trigger`            |           4 | OPPOSITE_CHOCH, ATR_TARGET, etc. |
| `stop_placement`          |           3 | ATR, SWING_EXTREME, OB_BOUNDARY |
| `session`                 |           4 | RTH, RTH_EX_LUNCH, etc. |
| `session_bucket`          |           4 | open / lunch / close / any |
| `iv_tercile_filter`       |           4 | low / mid / high / any |
| `event_day_filter`        |           3 | skip / events_only / any |
| `min_ob_volume_z`         |           3 | None / 1.0 / 2.0 |
| `min_ob_pct_atr`          |           2 | None / 50.0 |
| `entry_vs_ob`             |           4 | above / below / any |
| `min_z_entry_vwap`        |           2 | None / 1.0 |
| `min_adx_14`              |           3 | None / 20 / 30 |
| `on_opposite_signal`      |           3 | HOLD_AND_SKIP / etc. |
| `exit_after_n_bos`        |           4 | None / 2 / 3 / 4 |
| `stop_atr_multiple`       |          11 | 0.5..3.0 step 0.25 |
| `target_atr_multiple`     |          13 | 1.0..4.0 step 0.25 |

Total combinatorial space ≈ 2.7M configs. Current Optuna budget is **30
trials per fold × 15 folds = 450 trials** against that 2.7M space. We're
sampling 0.017% of the configuration manifold. There is no reason to
expect Optuna's TPE sampler — even with smart priors — to find a high-
quality regime combination in that few trials.

So Phase 1 below isn't "add filters" — it's **sample the existing space
more deeply** before declaring regime-gated PAC dead. Phases 2 and 3 add
targeted new dimensions only if Phase 1 hints at signal.

## Phases

### Phase 1 — deeper existing sweep (~3h wall-clock)

Re-run the same 1m NQ × 3-year campaign with **n-trials raised from 30 to
150**. Keep everything else identical: same causality-fixed engine, same
acceptance gate, same configs, same CPCV 6×2 folds. Just 5× more samples
per fold.

**Rationale.** Our pattern recognition has been running on 30-trial results.
If the space has a signal in 0.1% of configs, 30 trials gives us a 3%
chance of hitting it per fold; 150 trials gives 14%. Across 15 folds
that's the difference between "almost certainly miss" and "likely see
once." Cheap way to check whether we're under-exploring.

**Outcome cases:**

- **Phase 1 null** (Sharpe ~0, 0 promotions): existing regime dimensions
  don't have the answer. Proceed to Phase 2.
- **Phase 1 positive on ≥1 year** (1+ config NQ-only passes, Sharpe >1):
  document the winning regime(s), proceed to Phase 2 only to broaden
  confidence with more dimensions.
- **Phase 1 cross-market or multi-year pass**: we found something. Skip
  Phase 2, fire a bigger validation sweep at 300+ trials to confirm.

**Files to modify:** none. Just fire sweeps with `n-trials: 150`.

### Phase 2 — new regime dimensions (~5h wall-clock + ~2h build)

Add **3 high-value filter dimensions** Optuna doesn't currently search:

1. **`atr_14_regime`** — categorical `{None, "low", "mid", "high"}`.
   Analogous to `iv_tercile_filter` but based on rolling ATR rank.
   Tests "only trade in high-vol" vs "only trade in compression" vs
   either. Cheap to compute (we already have `atr_14` feature).

2. **`trend_regime`** — categorical `{None, "trend_up", "trend_down", "trend_either"}`.
   Trend direction inferred from `di_plus_14 - di_minus_14` over a
   20-bar window. Tests whether BOS/CHoCH entries work better when
   aligned with prevailing trend vs counter-trend.

3. **`overnight_gap_regime`** — categorical `{None, "gap_up", "gap_down", "gap_small"}`.
   Uses first-bar open vs prior-day close. Tests whether PAC structure
   resolves differently after opening gaps.

Plus raise `n-trials` to 150 with the enlarged space so the total
configuration coverage remains comparable to Phase 1.

**Files to modify:**

- `ml/src/pac/features.py` — add `atr_14_regime`, `trend_regime_dmi`,
  `overnight_gap_regime` columns.
- `ml/src/pac_backtest/params.py` — add 3 new `StrategyParams` fields.
- `ml/src/pac_backtest/loop.py` — filter predicates for the new fields.
- `ml/src/pac_backtest/sweep.py` — 3 new `trial.suggest_categorical`.
- `ml/tests/test_pac_features.py` — unit tests for each new feature.
- `ml/tests/test_pac_backtest_filters.py` — filter-application tests.

**Deploy + sweep:** same 3-year chain as Phase C of the residual fix
(`1m_2022 → 1m_2023 → 1m_2024` sequential), ~55min/year at 150 trials.

### Phase 3 — winner inspection + out-of-sample (~half day)

If Phase 1 or 2 produces a config passing the acceptance gate on ≥1
year, inspect the winner:

- Does the same config pass on the OTHER 2 years (temporal robustness)?
- What's its filter profile — is it a cherry-picked regime or something
  principled?
- Does it survive a higher-trial-count re-run (confirm not overfit to
  TPE's search path)?
- What's its PBO (probability of backtest overfitting) from the
  existing cross-market sweep tooling?

If the winner survives all 4 checks on ≥2 of 3 years, we have something
genuinely worth paper-trading. If not, the pattern match was spurious.

## Done-when

- **Go path:** A config passes acceptance gate on ≥2 years with Sharpe
  >1.0 and survives Phase 3 stress tests. Move to live paper-trading
  design.
- **No-go path:** All of Phase 1 + Phase 2 + Phase 3 produce no
  consistent passing config. Pure-PAC-as-systematic-entry is
  definitively dead; move to branch (3) PAC-as-context or pivot.

## Non-goals

- **Not touching the engine.** Phases 0/A/B/C of the causality fix are
  done. This plan only extends the sweep space + adds features.
- **Not testing different timeframes.** 5m already null in the original
  A2, 15m/30m untested but out of scope here. Revisit if this plan
  returns null.
- **Not adding flow context.** Branch (4) PAC + flow composite is its
  own multi-week effort.

## Open questions

- **Q1:** Should Phase 1 run on 1m OR also re-test 5m with deeper trials?
  Original A2 5m was 0 promotions at 30 trials, same under-exploration
  concern. Default: skip 5m to save wall-clock, revisit if 1m Phase 1
  surprises.
- **Q2:** Should I replace TPE with random sampling for Phase 1?
  TPE's prior is "past trials were informative" — but on a null-edge
  surface, TPE will over-concentrate on spurious local optima. Random
  sampling gives more uniform coverage. Default: stick with TPE for
  comparability with prior runs; if Phase 1 is null and Phase 2 also
  null, rerun Phase 2 once with random sampler as a control.
- **Q3:** Should the acceptance gate be relaxed for this exploration?
  Current gate is calibrated for 3-year robustness. Running on 1-year
  windows we may be gate-starved. Default: keep the gate strict; relax
  only if Phase 2 shows promising individual-fold results the gate
  rejects.

## Reference

- Parent plan: `pac-residual-causality-fix-2026-04-24.md`
- v3 null result: `pac-v3-residual-fix-results-2026-04-24.md`
- Optuna search surface: `ml/src/pac_backtest/sweep.py` (v4, ~15 dims)
- Acceptance gate: `ml/src/pac_backtest/acceptance.yml` (v4)
