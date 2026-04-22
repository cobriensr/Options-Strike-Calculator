# PAC Backtest Search Space Expansion → Live-Trading Decision Tree

**Date:** 2026-04-20
**Owner:** @cobriensr
**Status:** scoping → ready for Phase 1
**Parent spec:** [pac-backtester-2026-04-18.md](pac-backtester-2026-04-18.md) (E1.4d — slots between E1.4c and E1.5)
**Acceptance bump:** v3 → v4 (locked thresholds unchanged; only the search space grows)

---

## Goal

Expand the Optuna sweep's parameter space so it tests **the same dimensions the live trader uses to decide**. The current search space (8 dims) captures entry trigger family, stop/target ATR multiples, broad session bucket, IV tercile, and event-day flag. The user's actual Friday journal documents 14 additional context features per trade — and those features currently do not gate any backtest entry. Until they do, the sweep cannot answer the user's central question:

> _"When a new market structure appears with an order block, do I enter the trade or do I ignore it? What if I am already in a trade? Do I exit, or exit and flip?"_

This spec adds:

1. **Entry-quality filters** (8 new dimensions) so the sweep can decide which structure events deserve a trade.
2. **Position-management dimension** (new) — explicit rules for HOLD vs EXIT vs FLIP when an opposite signal fires mid-trade.
3. **A trade-context snapshot** on every executed trade so post-hoc cohort analysis is possible without re-running the sweep.

The output is a sweep result that says, for every CHoCH+/CHoCH/BOS event in 16 years of NQ + ES history: _"with these confluences, take it; without them, skip it; if you're already in, do this."_ That is the strategy he is asking for.

## Context

- The 6-month validation sweep (2026-04-20) emitted `bos_breakout` as winner on every NQ fold but the cross-market gate failed because the ES per-fold drawdown metric had a tiny-base bug (fixed in [metrics.py:140-156](../../ml/src/pac_backtest/metrics.py#L140) by anchoring DD% to a $25K starting equity).
- The user's [Friday journal](../../15m-nq-luxalgo.xlsx and `strat-stats-fixed-csv.csv`) shows 13 trades with VWAP, OB strength (volume z, %ATR), ADX 14, sub-session bucketing, OB-anchored stops, BoS counts, prior-day H/L, and event-day flag — none of which currently gate entries in the backtest.
- Position management is currently implicit in [loop.py](../../ml/src/pac_backtest/loop.py): exits trigger on the configured `ExitTrigger` and new entries can only fire when no trade is open. The "what if a new opposite signal fires while I'm in a trade?" question has no explicit param.
- Acceptance discipline (Harvey 2017 pre-registration): the new dimensions go into `acceptance.yml v4` BEFORE running the sweep. After the sweep, no new dims may be added to explain results — only future versions may.

## Repos Touched

| Repo                | Role                                                   |
| ------------------- | ------------------------------------------------------ |
| `strike-calculator` | All work — pac engine + sweep + acceptance + new tests |

---

## What we are adding

### A. Entry-quality filters (8 dims)

Each filter has an explicit "off" option so Optuna can decide it doesn't matter. Defaults reflect "no filter applied" so existing baselines remain reproducible.

| #   | Param name                  | Type / values                                                                         | Live-journal column it mirrors                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `session_bucket`            | `pre_market` / `ny_open` / `am` / `lunch` / `pm` / `close` / `any`                    | `Session`                                      |
| 2   | `min_ob_volume_z`           | None / 0.5 / 1.0 / 1.5 / 2.0                                                          | `Z OB Volume` (derived from `OB Volume`)       |
| 3   | `min_ob_pct_atr`            | None / 30 / 50 / 75                                                                   | `OB % ATR`                                     |
| 4   | `entry_vs_ob`               | `any` / `above_ob_mid` / `inside_ob` / `below_ob_mid`                                 | `Entry vs OB`                                  |
| 5   | `stop_placement` (extended) | adds `OB_BOUNDARY` to existing `N_ATR` / `SWING_EXTREME`                              | implicit in his stops sitting at OB top/bottom |
| 6   | `min_z_entry_vwap`          | None / 0.5 / 1.0 / 1.5 (signed by direction)                                          | `Z Entry`, `VWAP ±1SD`                         |
| 7   | `min_adx_14`                | None / 15 / 20 / 25 / 30                                                              | `ADX 14`                                       |
| 8   | `vix_term_filter`           | None / `vix1d_under_vix` / `vix9d_under_vix` (continuous as a binary structural flag) | `VIX 1D / VIX`, `VIX 9D / VIX`                 |

### B. Position-management dimension (new)

| Param name           | Values             | What it does when an opposite signal fires while in a trade                                                 |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `on_opposite_signal` | `HOLD_AND_SKIP`    | Ignore the new signal entirely. Current trade runs to its configured exit.                                  |
|                      | `EXIT_ONLY`        | Close current trade at next-bar-open. Do not open new trade.                                                |
|                      | `EXIT_AND_FLIP`    | Close current at next-bar-open AND open opposite at the same bar (with full slippage applied to both legs). |
|                      | `HOLD_AND_TIGHTEN` | Keep position; move stop to breakeven on receipt of opposite signal.                                        |

This is a **first-class** sweep dimension. We expect winners to differ by trigger family — reversal entries (CHoCH+) often want EXIT_AND_FLIP; continuation entries (BOS) often want HOLD_AND_SKIP because BoS confirms the trend and an opposite CHoCH may be noise.

### C. Exit logic additions

| #   | Param name              | Type / values    | Notes                                                                                                             |
| --- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| 9   | `exit_after_n_bos`      | None / 2 / 3 / 4 | Exit when N same-direction BoS events have printed since entry. Direct test of the "exit after 2 BoS" hypothesis. |
| 10  | `partial_exit_at_1r`    | bool             | Take half off at 1R; trail the remainder.                                                                         |
| 11  | `move_stop_to_be_at_1r` | bool             | Move stop to entry once price reaches 1R MFE.                                                                     |

### D. Per-trade context snapshot

Add a `Trade.entry_features: dict[str, float]` field. At entry, snapshot the bar's:

- VWAP distance (raw and z-score)
- OB volume z-score, OB %ATR, OB age in bars
- Entry distance to OB mid (in ticks)
- ADX 14
- VIX, VIX1D/VIX, VIX9D/VIX, VVIX
- Session bucket
- Minutes from RTH open / to RTH close
- ES↔NQ correlation (last 30 bars) — _stretch_, only if cheap

This makes post-hoc cohort analysis (E1.4e, future) possible without re-running the sweep. Each cohort question — _"what's the win rate for CHoCH+ above VWAP with ADX > 25?"_ — becomes a one-line `pandas.groupby` on the resulting DataFrame.

---

## Phases

Phases are independently shippable. Each ends in a green test suite + ruff clean + a commit. Verification phase is always last.

### Phase 1 — PAC engine: compute the new features (no behavior change)

Adds feature computation only. No filter is wired into entries yet, so the sweep is unaffected. Verifies the math is correct in isolation.

Files:

- [`ml/src/pac/features.py`](../../ml/src/pac/features.py) (new) — `add_session_features()`, `add_vwap_features()`, `add_adx14()`, `add_event_calendar()`, `add_session_bucket()`. Each takes the enriched bar DataFrame, returns it with new columns appended.
- [`ml/src/pac/engine.py`](../../ml/src/pac/engine.py) — `PACEngine.batch_state()` now calls the feature additions after structure tagging.
- `ml/tests/test_pac_features.py` (new) — unit tests per feature with hand-checked expected values.

Acceptance: existing pac engine tests still pass; new feature tests pass; ruff clean.

### Phase 2 — Trade-context snapshot

Adds the entry-features snapshot to `Trade` so every backtest trade carries the context the trader used to filter live.

Files:

- [`ml/src/pac_backtest/trades.py`](../../ml/src/pac_backtest/trades.py) — add `entry_features: dict[str, float] = field(default_factory=dict)` to `Trade`.
- [`ml/src/pac_backtest/loop.py`](../../ml/src/pac_backtest/loop.py) — populate `entry_features` from the entry bar at trade open.
- `ml/tests/test_pac_backtest_trades.py` — assert snapshot is populated and round-trips through `trades_to_dataframe()`.

Acceptance: all backtest tests still pass; new snapshot test passes.

### Phase 3 — Search-space expansion in `params.py` + `sweep.py`

Wire the 8 entry-quality filters + 3 exit additions + position-management dim into Optuna.

Files:

- [`ml/src/pac_backtest/params.py`](../../ml/src/pac_backtest/params.py) — extend `StrategyParams` with the new fields; add `OnOppositeSignal` StrEnum; extend `StopPlacement` with `OB_BOUNDARY`; add `SessionBucket` StrEnum (replaces existing `SessionFilter` in role; old class kept as alias for one release for migration).
- [`ml/src/pac_backtest/sweep.py`](../../ml/src/pac_backtest/sweep.py) — `_sample_params()` adds suggest calls for each new dim; `_params_to_vector()` is extended in lockstep so DSR effective-trial estimation remains valid.
- [`ml/src/pac_backtest/loop.py`](../../ml/src/pac_backtest/loop.py) — entry path applies the new filters in sequence; exit path handles `on_opposite_signal` branching.
- `ml/tests/test_pac_backtest_loop.py` — add scenarios for each `on_opposite_signal` value (HOLD, EXIT, FLIP, HOLD_AND_TIGHTEN).
- `ml/tests/test_pac_backtest_sweep.py` — assert the new params appear in the search space and in `_params_to_vector` output.

Acceptance: all existing tests pass; new branch tests pass; sweep on the synthetic 600-bar fixture still completes < 30s.

### Phase 4 — Acceptance bump v3 → v4 + audit stamping

Files:

- [`ml/src/pac_backtest/acceptance.yml`](../../ml/src/pac_backtest/acceptance.yml) — bump `version: 3` → `version: 4`. Update `committed_ts`. Set `commit_hash_when_locked: null` (re-stamped after commit lands). The threshold block (PBO, DSR, OOS/IS Sharpe, min trades, max DD, PF, param stability) is **unchanged** — this is the discipline. We are widening the search; we are not loosening the gate.
- [`ml/src/pac_backtest/acceptance.py`](../../ml/src/pac_backtest/acceptance.py) — extend the loaded model to include the new dim names if you parse them; if it's pure threshold reading it stays untouched.
- [`ml/scripts/stamp_acceptance_hash.py`](../../ml/scripts/stamp_acceptance_hash.py) — re-run with `--force` once the v4 commit lands.

Acceptance: `acceptance.yml` parses; `stamp_acceptance_hash.py --force` writes the new SHA; one commit on its own dedicated to the bump.

### Phase 5 — Validation sweep (6-month) + cross-market gate review

Re-run the validation sweep on the same 6-month window (2024-07-01 → 2024-12-31) with the new search space. Compare per-market gate result to the v3 sweep. Goal is **diagnostic, not promotional** — we expect winners to shift; what matters is whether the cross-market gate now accepts a config that survives all four buckets.

Run command:

```bash
ml/.venv/bin/python -m pac_backtest.run_sweep \
  --start 2024-07-01 --end 2024-12-31 \
  --markets NQ,ES \
  --n-trials 50 \
  --output-dir ml/experiments/sweeps
```

Estimated runtime: ~90 minutes (search space ~3× larger than v3 → expect roughly 2× wall clock vs the 45-min v3 baseline, since Optuna's TPE concentrates samples).

Acceptance: sweep completes; `summary.json` has either ≥1 cross-market pass OR a clearly-explainable failure (e.g. ES still fails, but for a different reason than v3); a one-page `findings.md` written next to the sweep output describing what changed vs v3.

### Phase 6 — Verification

- `ml/.venv/bin/python -m pytest ml/tests/test_pac*.py ml/tests/test_pac_backtest*.py -q`
- `ml/.venv/bin/ruff check ml/src/pac ml/src/pac_backtest ml/tests`
- Confirm `acceptance.yml` v4 stamped with commit SHA
- Confirm trade snapshot populated on a sample trade from the new sweep output

---

## Open Questions

1. **Should we test the position-management dim across all entry triggers, or restrict to opposite-direction signals only?** Default: opposite-direction only (a CHoCH+ short while you're long counts; another CHoCH+ long while you're long does not). Cleaner and matches live trader intuition.
2. **Sub-session boundaries** — current default proposal is Pre-Market (before 8:30 CT) / NY Open (8:30–10:00) / am (10:00–11:30) / lunch (11:30–13:00) / pm (13:00–15:00) / close (15:00–close). User's Friday journal uses NY Open / NY Mid-Day / NY Afternoon / Pre-Market — close enough to map cleanly.
3. **OB volume z-score baseline window** — z relative to last 20 bars? last 100? Last full session? Default proposal: last 50 bars (matches typical PAC visual sense of "this OB looks heavy").
4. **VIX term ratios as continuous vs binary** — proposal is a binary structural flag (`vix1d_under_vix` true/false) since structure is what matters; the continuous ratios remain in the trade-context snapshot for cohort analysis.
5. **Position sizing dim deferred?** Vol-scaled / risk-parity sizing was in the brainstorm but is NOT in v4. Reason: sizing changes Sharpe by 2-3× independently of edge — keeping it fixed at 1 contract for v4 keeps the dimensions we vary purely about decision quality. Sizing → v5.

## Thresholds (frozen — from v3)

The whole point of pre-registration is that these don't change:

| Threshold                                       | Value |
| ----------------------------------------------- | ----- |
| `pbo_max`                                       | 0.3   |
| `dsr_min_95ci`                                  | 0.0   |
| `oos_vs_is_sharpe_min`                          | 0.7   |
| `min_trades_per_fold`                           | 200   |
| `max_drawdown_pct`                              | 0.2   |
| `profit_factor_min`                             | 1.4   |
| `param_stability_max_drop`                      | 0.3   |
| `cross_market_gate.require_pass_on_all_markets` | true  |

## Files Created / Modified

**New:**

- `docs/superpowers/specs/pac-search-space-expansion-2026-04-20.md` (this spec)
- `ml/src/pac/features.py`
- `ml/tests/test_pac_features.py`

**Modified:**

- `ml/src/pac/engine.py`
- `ml/src/pac_backtest/params.py`
- `ml/src/pac_backtest/loop.py`
- `ml/src/pac_backtest/sweep.py`
- `ml/src/pac_backtest/trades.py`
- `ml/src/pac_backtest/acceptance.yml` (v3 → v4 bump)
- `ml/tests/test_pac_backtest_loop.py`
- `ml/tests/test_pac_backtest_sweep.py`
- `ml/tests/test_pac_backtest_trades.py`

## Data Dependencies

- None new. Every feature is computable from existing 1m OHLCV + the VIX overlay we already pull. No Theta Data, no new Databento product, no new env vars.

## Out of Scope (deferred to E1.4e or later)

- Cohort analysis layer (post-hoc trade grouping with multiple-testing correction) — its own spec after v4 sweep results land.
- Vol-scaled / Kelly position sizing — v5.
- HTF (15m) structure alignment as a filter — v5; needs a second engine pass on resampled bars.
- Cross-asset filters (DXY, 10Y, BTC) — requires data we don't have in `ml/data/archive/`.
- Tape-speed / CVD divergence — requires TBBO L1 we have only ~1 year of; sample size insufficient.
- Trailing stop variants beyond `move_stop_to_be_at_1r` — v5.

## Definition of Done

1. `acceptance.yml v4` is committed and stamped with its commit SHA.
2. The 6-month validation sweep completes with the new search space.
3. The sweep output `summary.json` either:
   - Promotes ≥1 config through the cross-market gate, OR
   - Cleanly identifies why the strategy still fails (with a one-page write-up vs v3).
4. Every new feature has a unit test with a hand-calculated expected value.
5. Per-trade `entry_features` snapshots are populated and round-trip through serialization.
6. The user can answer his question: _"When a new structure with OB appears, do I enter?"_ by reading the v4 winner's filter values: `min_ob_volume_z`, `entry_vs_ob`, `min_z_entry_vwap`, `min_adx_14`, `session_bucket` — these are his entry checklist. And: _"What if I'm in a trade?"_ → the winner's `on_opposite_signal` value tells him.

---

**Estimated total effort:** 10-12 hours of dev across phases 1–4, plus ~90 minutes for the v4 sweep run, plus 1-2 hours of result interpretation. One full focused day, or 2-3 evening sessions.
