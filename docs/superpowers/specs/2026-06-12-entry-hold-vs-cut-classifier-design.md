# At-Entry "Hold-vs-Cut" Classifier — Design (2026-06-12)

## Goal

For each lottery-finder / silent-boom fire, predict **at entry** whether it is a tail winner
worth holding to close. Hold the predicted winners to EOD; trail/cut the rest. This directly
attacks the trader's core complaint ("I cut the real winners too early — 500% instead of 2000%")
by separating, at entry, the fires you should let run from the ones you should cut fast.

This is the Project A pivot: the 6-month exit-timing study (see
`docs/tmp/exit-engine-6month-verdict.md`) proved per-minute *exit* timing is a dead end for
lottery (tail-dominated; hold-EOD is the only positive-mean policy) and only loses-less for SB
(negative entry edge). The binding lever for both is **entry-side selection**, which this model
provides.

## Decision and label

One row per fire. The label is computed from the per-minute path datasets already built
(`decision_dataset/` for lottery, `decision_dataset_sb/` for SB), using the on-path baselines we
already compute:

- `hold_eod_ret` = realized return holding to last tick (the `eod` on-path baseline; mid basis,
  costs applied).
- `cut_ret` = realized return under the reference early-cut policy **`trail30_10`** (activate a
  trailing stop at +30% from entry, exit at 10pp giveback from running peak; if +30% never hit,
  hold to last tick).
- **`should_have_held = 1 if hold_eod_ret > cut_ret else 0`.** Ties (`hold_eod_ret == cut_ret`,
  e.g. neither armed) label **0** — holding adds variance for no gain, so the default is cut.

The model predicts `p_hold = P(should_have_held = 1)` from entry-time features only.

**Policy:** `p_hold >= threshold` → hold to close; else → trail/cut (`trail30_10`).

## How the policy is scored (the real success test)

Month-level expanding walk-forward (train on prior months, test on next), identical split to
A2/A3. For each OOS fire:

- `model_gated_ret = hold_eod_ret if predicted_hold else cut_ret`

Equal-weight-mean comparison table per detector:

| policy | definition |
| --- | --- |
| **MODEL-GATED** | per-fire hold/cut chosen by `p_hold >= threshold` |
| always-hold | every fire held to EOD (`hold_eod_ret`) |
| always-cut | every fire cut via `trail30_10` (`cut_ret`) |
| ORACLE | per-fire `max(hold_eod_ret, cut_ret)` — perfect-foresight ceiling |

Sweep `threshold ∈ {0.3,0.4,0.5,0.6,0.7}`; report each, mark best by OOS mean.

## Features (entry-time only, one row per fire)

Sourced by joining DB fire metadata to the **entry tick** (`minutes_since_entry == 0`) of the
path dataset, plus the computed label.

**Shared entry-tick (from the path dataset):** `iv_level`, `delta`, `gamma`, `otm_distance_pct`,
`spread_pct`, `entry_price`, `minutes_to_close`, `option_type`, `mode`.

**Lottery DB metadata (`lottery_finder_fires`):** `score`, `score_tier`, `takeit_prob`,
`spx_spot_gamma_oi` (sign), fire-count/burst, conviction/cheap/OTM-sweep/earnings tags,
`mkt_tide_diff`, `mkt_tide_otm_diff`, `zero_dte_diff`, `direction_gated`, `dte`.

**SB DB metadata (`silent_boom_alerts`):** `score`, `score_tier`, `takeit_prob`, `spike_ratio`,
`ask_pct`, `baseline_volume`, `vol_oi`, `open_interest`, `spx_spot_gamma_oi`, `mkt_tide_diff`,
`mkt_tide_otm_diff`, `zero_dte_diff`, `multi_leg_share`, `direction_gated`, `dte`.

Per-source feature lists (shared core + source-specific extras). Missing/NULL metadata →
imputed sentinel + presence flag; XGBoost handles NaN natively, so prefer leaving NaN.

### Leakage discipline (critical guardrail)

- An explicit **allow-list** of entry-known columns defines the feature matrix.
- A hard assertion rejects any column matching `realized_*`, `peak_ceiling_*`, `minutes_to_peak`,
  `enriched_*`, `round_trip_*`, or any per-minute path feature (`running_peak_pct`,
  `drawdown_from_peak_pct`, `slope_*`, `realized_vol_*`, `minutes_since_entry`, `ret_from_entry_pct`,
  `y_has_upside`, `fold`, `p_upside`). These are outcomes or look-ahead.
- **Uniform-lift check:** after training, stratify OOS lift by score-tier / mode / DTE bucket.
  Uniform lift across every stratum is a leakage fingerprint (per
  `feedback_uniform_lift_is_leakage`); real edge concentrates. Report the per-stratum table.

## Architecture / files

New modules in the worktree `exit_engine` package, reusing `onpath_policies.onpath_baselines`
(hold/cut returns), the walk-forward fold logic, `model.train_classifier`, and `costs`.

- `ml/src/exit_engine/entry_features.py` — `build_entry_rows(source, conn)`: load DB fire
  metadata, join entry-tick from the path dataset, compute `hold_eod_ret`/`cut_ret`/label, emit
  one row per fire. Source-parameterized (`lottery` | `silentboom`). Owns the allow-list +
  leakage assertion.
- `ml/experiments/exit-timing-engine/run_b1_entry_dataset.py` — build
  `entry_dataset[_sb].parquet` (small, one row/fire). Honors `EXIT_SOURCE` / `EXIT_DATASET_DIR`.
- `ml/experiments/exit-timing-engine/run_b2_entry_model.py` — month walk-forward classifier +
  policy backtest vs always-hold / always-cut / oracle; threshold sweep; per-stratum lift table;
  writes `b2_entry_model[_sb].md`.

## Testing

- `entry_features` label correctness: synthetic paths where hold>cut and hold<cut produce the
  right `should_have_held` (incl. the tie→0 case).
- Leakage assertion: a frame containing a banned column raises.
- Entry-tick join: per-fire row takes greeks from `minutes_since_entry==0`, not a later tick.
- A tiny synthetic fixture exercises `build_entry_rows` end-to-end (no DB; inject a fake fires
  frame + path frame).

## Pre-registered success criteria (per detector)

1. **Primary:** MODEL-GATED OOS mean > max(always-hold, always-cut).
2. **Secondary:** oracle gap closed = `(model − better_of_two) / (oracle − better_of_two)` ≥ ~15%.
3. **Guardrail:** classifier OOS AUC > 0.55, else declare no-signal and stop (don't ship a
   coin-flip). Report the per-stratum lift table to rule out leakage.

## Open questions / defaults

- Reference cut policy = `trail30_10` (body-optimal from the verdict). **Default accepted.**
- Tie-break (`hold==cut`) → label 0. **Default accepted.**
- Hurdle for "winner" is implicit in the hold>cut comparison (no separate magnitude hurdle in v1).
- SB absolute levels remain soft (ask-entry markdown, 31.6% rebuild match); the hold-vs-cut
  *label* is a within-fire comparison on identical basis, so it is robust to that offset.
