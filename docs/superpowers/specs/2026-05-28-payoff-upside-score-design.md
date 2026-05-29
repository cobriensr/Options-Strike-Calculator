# Payoff / "Upside" Score — Design

**Date:** 2026-05-28
**Status:** Design approved; **build gated on ~mid-June re-probe** (see Phase 0).
**Author:** brainstorming session (Charles + Claude)

## Goal

Add a second alert-quality score — the **Upside score** — that predicts *trade magnitude* (how big the move is) as a deliberately orthogonal complement to the take-it score, which predicts *probability* (`P(peak ≥ +20%)`). Together they give the trader expected value, not just hit-rate: `EV ≈ P(win) × payoff`. Take-it nailed `P(win)`; payoff is the untouched multiplicand, and a 0DTE lottery trader lives on the right tail.

## Why this is a real edge (EDA validation, 2026-05-28)

Probe: `ml/src/payoff_eda_probe.py`. Saved finding: `memory/project_payoff_orthogonal_to_takeit.md`.

- **Orthogonal (robust, full 90-day population):** take-it explains only **8–10%** of variance in `peak_ceiling_pct` (eta²); 90% residual. Inside the `>0.70` take-it band, Lottery P90 peak is still **+279%** — a high win-probability says almost nothing about magnitude.
- **Different feature physics:** take-it (probability) is **flow/macro-driven** (`mkt_tide_diff`, `flow_quad`, ETF flows). Payoff (magnitude) is **structure/time-driven** (`is_itm_at_fire`, `otm_distance_pct`, `session_phase`, `dte`, `entry_price`). One cannot proxy the other.
- **Predictable:** best target is **`log1p(peak_ceiling_pct)`** — test Spearman 0.46 (Lottery) / 0.41 (SB), p ≪ 0.001; a P90 quantile head beats a constant-quantile baseline by +13% (Lottery). Raw peak and `realized_trail30_10` R are noisier (SB trail R unpredictable, Spearman 0.03 n.s.).

**Caveat that gates the build:** the predictability numbers rest on ~8 days of `takeit_features` history (JSONB populated since ~2026-05-20). The orthogonality result is rock-solid; the *model-strength* estimate is thin. We therefore spec now and build after a 30+ day re-probe.

## Decisions locked

| Decision | Choice |
| --- | --- |
| Direction | Payoff / magnitude model (the missing EV multiplicand) |
| Target | `log1p(peak_ceiling_pct)` (mean head) + **P90 quantile head** (moonshot tail) |
| Models | Two independent: Lottery + Silent Boom |
| UX | **2-D quadrant** (PRIME / MOONSHOT / GRIND / SKIP) + "expected peak ~X%" chip; optional EV sort |
| Infra | Reuse take-it rails (XGBoost → Blob bundle → TS tree-traversal scorer → parity gate → weekly retrain) |
| Timing | Spec now; build at re-probe (~mid-June, batched with the 2026-06-16 GexBot re-probe) |

## Architecture

The feature set is **identical** to take-it, so feature engineering is reused wholesale, not duplicated.

```
ml/src/payoff/            ← clone of ml/src/takeit/ (label + objective swapped)
  config.py               WIN label → log1p(peak); objective reg:squarederror; P90 loss=quantile,alpha=0.9
  build_training_set.py   reuse takeit feature assembly; target = log1p(peak_ceiling_pct)
  train.py                walk-forward; train mean head + P90 head; report Spearman + pinball
  export_model.py         JSON bundle (mean tree dump + P90 tree dump + base scores), no isotonic
  generate_parity_fixture.py

api/_lib/
  payoff-features.ts      re-exports takeit-features.ts (same PIT vector — zero duplication)
  payoff-score.ts         tree traversal like takeit-score.ts but REGRESSION:
                          pred = base + Σ tree.predict(features); expected_peak_pct = expm1(pred)
                          float32 parity discipline; NO sigmoid, NO isotonic
  payoff-bundle-loader.ts Vercel Blob fetch + in-process cache (clone of takeit-bundle-loader)
  payoff-bundle-schema.ts bundle JSON validation
  payoff-quadrant.ts      maps (takeit_prob, expected_peak_pct) → quadrant label + thresholds

api/cron/
  detect-lottery-fires.ts   call computePayoffScore inline (alongside computeTakeitScore)
  detect-silent-boom.ts     "
  audit-payoff-drift.ts     rolling test-set Spearman + pinball (clone audit-takeit-calibration)
  audit-payoff-health.ts    null-rate / pred distribution (clone audit-takeit-health)

src/components/
  PayoffScore/              UpsideChip (expected peak %) + QuadrantBadge + tests
  LotteryFinder/, SilentBoom/  render the chip/badge; add EV sort + payoff filters
```

### Scorer detail (regression vs take-it's classifier)

Take-it: `sigmoid(base + Σtrees)` → isotonic calibration → probability.
Payoff: `base + Σtrees` (in log1p space) → `expm1()` → expected peak %. The P90 head is a second, independently-trained tree ensemble (quantile loss α=0.9) exported in the same bundle. The TS tree-walk, `default_left` NaN routing, and `Math.fround` float32 quantization are copied verbatim from `takeit-score.ts`; only the final activation differs.

## UX: the quadrant

Orthogonal axes must not be collapsed into one number, or the second score's value (texture) is lost.

```
                 high payoff
                      │
      MOONSHOT 🌙     │   PRIME 💎
   (low prob, big)    │ (high prob, big)
  ────────────────────┼────────────────────  high prob
       SKIP ✕         │   GRIND ⚙
   (low prob, small)  │ (high prob, small)
                 low payoff
```

- **Expected-peak chip:** `expm1(payoff_pred_log)` → "exp. peak ~+X%", with a secondary "P90 ~+Y%" for the moonshot ceiling.
- **Quadrant badge:** PRIME / MOONSHOT / GRIND / SKIP, color-coded.
- **EV sort (optional):** `takeit_prob × expected_peak_pct` for traders who want one ranked list.
- **Filters:** quadrant chip filter; min expected-peak floor (parallels the existing take-it floor).

## Data dependencies & migration

One numbered migration in `db-migrations.ts` (update `db.test.ts` mock sequence + count), adding to **both** `lottery_finder_fires` and `silent_boom_alerts`:

- `payoff_pred_log` NUMERIC — raw model output (log1p space)
- `payoff_expected_peak_pct` NUMERIC — `expm1(payoff_pred_log)`, the interpretable chip value
- `payoff_p90_pct` NUMERIC — P90 quantile head output (back-transformed)
- `payoff_model_version` TEXT
- Partial indexes mirroring the take-it ones: `(date DESC, payoff_expected_peak_pct DESC) WHERE payoff_expected_peak_pct IS NOT NULL`

Other deps: model bundles uploaded to Vercel Blob (clone `upload_takeit_bundles.mjs`); weekly retrain GH Actions job; `takeit_features` JSONB (already populated — payoff reuses it).

## Thresholds / constants (provisional — TUNE at re-probe)

Per `feedback_tune_before_ship`, all cutoffs are tuned on the 30+ day re-probe data before shipping. Provisional starting points:

- **Quadrant prob split:** `takeit_prob ≥ 0.55` = "high prob" (reuses take-it's existing green band).
- **Quadrant payoff split:** `expected_peak_pct ≥` the trailing-cohort **median** predicted peak (per table) = "high payoff". (Percentile split is regime-robust vs a fixed % which drifts.)
- **Quality gate to ship:** Lottery log1p test-Spearman **> 0.35** on a proper walk-forward split.
- Model HPs: clone take-it (`n_estimators 300, max_depth 5, lr 0.05, min_child_weight 50, subsample/colsample 0.8`); P90 head `loss=quantile, alpha=0.9`.
- Parity tolerance: max abs diff `< 1e-6` (TS vs Python), build-blocking.

## Phases (each independently shippable)

**Phase 0 — Re-probe gate (~mid-June, batch with 2026-06-16 GexBot re-probe).** Re-run `payoff_eda_probe.py` with 30+ days of `takeit_features`; proper walk-forward split. Confirm Lottery log1p Spearman > 0.35 and lock quadrant cutoffs. *Go/no-go for everything below.*

**Phase 1 — ML pipeline (`ml/` only).** `ml/src/payoff/` (config, build_training_set, train mean+P90, export, parity fixture) + pytest. Output: validated bundles + parity fixture.

**Phase 2 — TS scorer.** `payoff-features.ts` (re-export), `payoff-score.ts`, `payoff-bundle-loader.ts`, `payoff-bundle-schema.ts`, `payoff-quadrant.ts` + parity-gate test (`payoff-score.parity.test.ts`) + unit tests.

**Phase 3 — DB + detect wiring.** Migration (+ `db.test.ts` update); call `computePayoffScore` inline in both detect crons; backfill script for historical enriched rows.

**Phase 4 — UI.** `PayoffScore/` (UpsideChip + QuadrantBadge), wire into LotteryFinder + SilentBoom rows, EV sort, payoff filters, render tests.

**Phase 5 — Monitoring + retrain.** `audit-payoff-drift.ts`, `audit-payoff-health.ts` (+ vercel.json cron registration + tests), weekly GH Actions retrain, runbook.

## Error handling

- **Fail-open** like take-it: if the bundle is unavailable or scoring throws, store NULL payoff columns and render no chip — never block a fire from surfacing.
- Null/missing features route via `default_left` (inherited from take-it scorer).
- Quadrant badge renders only when *both* `takeit_prob` and `payoff_expected_peak_pct` are present; otherwise show the lone chip that exists.

## Testing

- Parity gate (TS ≡ Python, 1e-6) — build-blocking.
- Feature unit tests inherited from take-it; add scorer + quadrant-mapping unit tests.
- Migration test mock-sequence update.
- UI render tests for chip + quadrant.
- Regression drift monitor (rolling Spearman + pinball), cloning the take-it audit crons.

## Open questions (defaults noted)

1. **Payoff split = percentile or absolute %?** *Default: trailing-cohort median percentile* (regime-robust). Revisit at re-probe.
2. **Which `peak` for the target — capped or raw?** Raw peak has 11,425% / 30,293% outliers. *Default: keep `log1p` (no cap); the log transform already tames the tail and the EDA confirms it's well-behaved.*
3. **EV sort default-on or opt-in?** *Default: opt-in sort mode; quadrant + chip are the always-on surface.*
4. **Backfill depth?** *Default: all enriched rows with non-null `takeit_features` (~since 2026-05-20).*
```
