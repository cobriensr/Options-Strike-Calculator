# Lottery — Outcome Mining + Score Lineage (2026-05-22)

## Goal

Turn the nightly `make update` from a passive enrichment job into an active feedback loop that learns from today's realized outcomes. Three additions: (a) mine winning feature combinations the additive model is blind to, (b) mine losing combinations to detect failure modes, (c) attribute today's tier1 wins/losses to individual score components so we catch when a coefficient quietly becomes wrong.

## Background

- V2 scoring shipped as a hard-swap through Phases 0-7 of `docs/superpowers/specs/lottery-rescore-2026-05-22.md` (commits `a7583af9` → `d5e709b6`). Linear additive bucket-encoded model, cutoffs `t1=9 / t2=7`.
- Nightly currently enriches `realized_*_pct` outcome columns via `scripts/enrich_lottery_outcomes.py` but does **nothing** with them — they're a static product for tomorrow's analysis.
- The user's stated goal: _"make my scores better based on today's trading history."_ The way to do that is to feed today's outcomes back into model insights.
- This spec doesn't auto-modify scoring — it surfaces _candidate_ signals for human approval. Auto-application requires cross-validation infrastructure we don't have yet (v2 of this project).

## Locked-in design decisions

| #   | Decision                                                                     | Rationale                                                                                                                         |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Compute score components at read-time, not persist**                       | The V2 formula is deterministic given input fields + weights JSON. Re-deriving components is cheap and avoids a schema migration. |
| 2   | **Outputs to `docs/tmp/`**                                                   | Daily reports, not production data. Matches `feedback_scratch_files_in_docs_tmp.md`.                                              |
| 3   | **No auto-application of mined patterns in v1**                              | Human-in-the-loop review for now. Bandit-style auto-application is a separate spec.                                               |
| 4   | **Mining window = last 90 days, aligned, non-structure**                     | Matches the V2 training window from Phase 1. Same statistical population.                                                         |
| 5   | **Winner threshold: outcome ≥ +50%**                                         | Matches the existing `hit_50` metric tracked in the EDA.                                                                          |
| 6   | **Loser threshold: outcome ≤ -50%**                                          | Symmetric to winners.                                                                                                             |
| 7   | **Minimum support per candidate combo = 10 fires**                           | Filter noise. Per `feedback_uniform_lift_is_leakage.md`, real edge concentrates — small support is more noise than signal.        |
| 8   | **Outcome column = COALESCE(realized_flow_inversion_pct, realized_eod_pct)** | Same as Phase 1 training. Consistent metric.                                                                                      |

## Phases

### Phase 0 — Score component recovery (1h)

Build a deterministic Python helper that returns the V2 component breakdown for any fire.

**Files:**

- `ml/src/score_components.py` (NEW) — exports:
  ```python
  def compute_components(fire_row: dict, weights: dict) -> dict[str, int]:
      """Returns {'ticker', 'tod', 'dte', 'vol_oi_q', 'gamma_q', 'ask_pct_q', 'option_type', 'total'}"""
  ```
- `ml/tests/test_score_components.py` (NEW) — pull 100 random fires with non-null score from DB, assert `sum(components) == score` for all 100.

**Verify:** test passes; sum invariant holds across the sample.

### Phase 1 — Outcome-conditioned feature mining (winners + losers in one pass) (3h)

Implement combinatorial scan for both winning and losing combos (ideas #5 + #6 from the brainstorm fold into one script since they share infrastructure).

**Files:**

- `scripts/mine_outcome_patterns.py` (NEW)

**Algorithm:**

1. Query `lottery_finder_fires_with_outcome` (view from rescore Phase 0) for last 90-day aligned, non-structure fires
2. Build feature tuple per fire: `(ticker, tod, dte, vol_oi_q, gamma_q, ask_pct_q, option_type)` — quintile lookups via the weights JSON boundaries
3. Generate all 2- and 3-feature sub-tuples (skip singletons — those are already in the model; skip 4+ — combinatorial explosion)
4. For each sub-tuple appearing in ≥ 10 winner-fires OR ≥ 10 loser-fires:
   - Compute `lift_win = P(winner | sub-tuple) / P(winner)`
   - Compute `lift_loss = P(loser | sub-tuple) / P(loser)`
   - `net_score = lift_win - lift_loss` (positive = winning combo, negative = losing combo)
5. Sort by absolute `net_score`, output top 25 winning combos + top 25 losing combos
6. Write to `docs/tmp/lottery-composite-candidates-{YYYY-MM-DD}.md`

**Output schema (Markdown):**

```
## Top 25 winning composites (high lift_win, low lift_loss)
| Combo | Support (winners) | lift_win | lift_loss | net_score | Suggested bonus |

## Top 25 losing composites (high lift_loss, low lift_win)
| Combo | Support (losers) | lift_win | lift_loss | net_score | Suggested penalty |
```

**Verify:** Run script, sanity-check top winning combinations have plausible domain interpretations (e.g., `AMD + AM_open + DTE 1` reads as a real edge).

### Phase 2 — Score lineage attribution (3h)

Per-component attribution analysis. Detects "TOD bonus has been a net negative contributor on Mondays for 6 weeks" type insights (idea #8).

**Files:**

- `scripts/score_lineage_audit.py` (NEW)

**Algorithm:**

1. Pull last 30-day enriched aligned fires
2. For each fire, recover the 7 component contributions via `compute_components` (Phase 0 helper)
3. Bucket fires by: `(tier, day_of_week, outcome_class)` where outcome_class is win (≥50%) / push (-50 to 50%) / loss (≤-50%)
4. For each (DOW × component) cell, compute:
   - Mean component contribution in winners
   - Mean component contribution in losers
   - `attribution_gap = win_mean - loss_mean` (positive = component is a real predictor; negative = component is anti-predictive on this DOW)
5. Flag components where `attribution_gap < 0` for any DOW with ≥ 50 fires of support — these are the "stuck" coefficients
6. Write to `docs/tmp/lottery-score-lineage-{YYYY-MM-DD}.md`

**Output schema (Markdown):**

```
## Component attribution by DOW (last 30 days)
| DOW | Component | n_winners | n_losers | win_mean_contrib | loss_mean_contrib | attribution_gap | flag |

## ⚠️ Components flagged as anti-predictive (attribution_gap < 0)
| DOW | Component | gap | recommended action |
```

**Verify:** Spot-check that `tod=AM_open` contribution shows positive attribution in winners across most DOWs (sanity check that the algorithm itself isn't broken).

### Phase 3 — Wire into `make update` (30 min)

**Files:**

- `Makefile` — extend `update` target to call the two new scripts after `daily_tracker.py`.

```make
update: refit
	# ...existing steps...
	$(PYTHON) scripts/daily_tracker.py
	# Phase 3 of outcome-mining spec: add the two feedback-loop scripts
	$(PYTHON) scripts/mine_outcome_patterns.py
	$(PYTHON) scripts/score_lineage_audit.py
```

**Verify:** `make update` produces all 6 daily reports (4 existing + 2 new). Total runtime increase ≤ 5 min (mostly the combinatorial scan).

### Phase 4 — Validation (always last)

- `npm run review` clean (no Python lint regressions in the new scripts; ml/ has its own `make review:ml` target)
- Manual review of first night's outputs: do top combinations look plausible? Do lineage findings make sense?
- If any flagged component (`attribution_gap < 0`) shows up, decide whether to (a) update the weight manually, (b) add a per-DOW correction, or (c) dismiss as noise

## Open questions (genuinely undecided)

1. **Cross-feature confounding** — A composite "AMD + AM_open" might just be "AMD" with AM_open along for the ride. v1 reports raw lift; if reports are noisy, v2 should report _marginal_ lift (lift conditional on individual feature lifts).
2. **Statistical significance** — Currently a flat support threshold of 10. If outputs are noisy, add a chi-square test for "is this combo's lift significant vs random."
3. **Action loop** — Once we identify "TOD bonus is wrong on Mondays," how do we feed that into the model? v1 = human reads the report, refits manually. v2 = auto-suggest a per-DOW correction overlay.

## Done when

- 3 new files: `ml/src/score_components.py`, `scripts/mine_outcome_patterns.py`, `scripts/score_lineage_audit.py`
- 1 modified file: `Makefile` (add 2 lines)
- 2 new daily reports show up in `docs/tmp/` after running `make update`
- First night's output is reviewed and at least 1 insight is actionable (a candidate composite worth testing, or a flagged component worth fixing)

## Out of scope

- Auto-applying mined patterns to model weights (v2 of this spec)
- Real-time mining during market hours (batch nightly is sufficient)
- Cross-validation infrastructure (v2)
- Bandit-style multi-model serving (idea #9 from the brainstorm — separate spec)
- Trader feedback ingestion (idea #7 — separate spec)
