# Meta-Detectors for Lottery & Silent Boom

**Status:** Active plan, scoped 2026-05-16.
**Companion doc:** [deferred-non-0dte-detectors-2026-05-16.md](./deferred-non-0dte-detectors-2026-05-16.md) for the surface detectors dropped from this scope.

## Goal

Add four meta-detectors that operate on existing Lottery Finder and Silent Boom flow data to improve detector precision, fix systematic mislabeling, and generate cleaner training data for takeit retrains — without adding any new external data feeds.

## Why this scope

A 2026-05-16 conversation traced YouTube-MM-careers-transcript framing back to a structural gap: both existing detectors are loud-flow-event-driven and treat every qualifying print as if it's directionally informed. Empirically (memory `project_whale_multileg_dominance`), 76% of $1M+ "whale" prints are spread legs being mislabeled as directional bets. The takeit score is therefore being trained on systematically corrupted labels.

The four meta-detectors fix this without requiring new data ingestion:

1. **Multileg assembler** — re-labels prints as spread legs vs isolated bets (correctness fix)
2. **Wave-2 confirmation** — adds follow-through tracking + generates `fizzled` training labels
3. **Time-of-day conditioning** — session-phase feature so identical prints score differently by time
4. **Forced-flow penalty** — score modifier for bilateral / cross-name / calendar / cross-asset-stress flow

Surface detectors (skew shock, synthetic basis, term structure inversion) were considered and deferred — see companion doc — because all carry edge primarily at 7-60 DTE and the user trades 0DTE.

---

## Phases

### Phase 1 — Multileg assembler (parquet validation)

**Scope:** Pure-Python detector in `ml/`, validated against 90-day historical parquet before any live code is written. No `api/` changes in this phase.

**Why first:** The 76% mislabeling baseline is the ground truth. If the matcher can't reproduce that, downstream phases inherit garbage data.

**Files to create:**

- `ml/src/multileg_assembler.py` — pattern matcher
- `ml/src/multileg_patterns.py` — pattern template definitions (data, not code)
- `ml/tests/test_multileg_assembler.py` — unit tests with synthetic fixtures
- `ml/experiments/multileg-assembler-validation/run.py` — runs against 90-day parquet
- `ml/experiments/multileg-assembler-validation/report.md` — validation results

**Pattern set v1 (4 patterns):**

- Vertical (2 strikes, same side, same expiry, opposite directions)
- Strangle (OTM call + OTM put, same expiry, same direction)
- Risk reversal (OTM put + OTM call, same expiry, opposite directions)
- Butterfly (3 equidistant strikes, body 2× wings, opposite directions)

Iron condor and diagonals deferred to v2 — combinatorics explode false-positive risk.

**Validation gate:**

- Reclassification rate of $1M+ prints lands in 65-85% range (baseline 76%)
- Manual spot-check of 50 random matches confirms ≥80% are visually plausible structures
- Tunable params logged for the live wire phase: window size (default 90s), strike-spacing tolerance, size-ratio tolerance, confidence band

**Done when:** Validation report shows reclassification rate in target band and spot-check passes.

---

### Phase 2 — Multileg assembler (live wire)

**Scope:** Wire validated matcher into detect crons and takeit feature pipeline.

**Matcher home: sidecar Python** (decided 2026-05-16). Follows the existing SHAP fill pattern (`api/cron/takeit-fill-shap.ts` → sidecar). Keeps Python pattern library co-located with the matcher built in Phase 1; avoids re-implementing pattern logic in two languages.

**Files to create/modify:**

- `sidecar/src/multileg_server.py` — new endpoint, co-located with takeit_server per recent commit `6e4ed77b`
- `api/_lib/multileg-client.ts` — sidecar caller
- `api/_lib/db-migrations.ts` — add migration N+1 for new columns on `lottery_fires` and `silent_boom` tables: `inferred_structure TEXT`, `is_isolated_leg BOOLEAN`, `match_confidence REAL`
- `api/cron/detect-lottery-fires.ts` — call multileg-client, populate new columns
- `api/cron/detect-silent-boom.ts` — same
- `api/_lib/takeit-features.ts` — surface `is_isolated_leg` + `inferred_structure` as features
- `api/__tests__/db.test.ts` — bump migration count + mock sequence
- `api/__tests__/takeit-features.test.ts` — update fixtures
- `sidecar/tests/test_multileg_routes.py` — new
- `sidecar/vercel.json` already exists (recent untracked file)

**Data dependencies:** None — all data already in Neon.

**Done when:** New Lottery / Silent Boom alerts in prod carry the three new fields and `npm run review` passes.

---

### Phase 3 — Time-of-day conditioning

**Scope:** Feature engineering only. No new tables, no new crons.

**Independent of Phase 1/2:** Can run in parallel.

**Files to modify:**

- `api/_lib/takeit-features.ts` — add `session_phase` categorical feature
- `api/__tests__/takeit-features.test.ts` — fixture updates

**Session phases (CT, hard-coded v1):**

- `pre_open` — before 08:30
- `open` — 08:30-09:00
- `opening_30` — 09:00-09:30
- `morning` — 09:30-11:00
- `lunch` — 11:00-13:00
- `afternoon` — 13:00-14:00
- `closing` — 14:00-15:00

**Open question:** Hard-coded splits vs empirical clustering of historical alert outcomes? Default pick: **hard-coded v1**, revisit if SHAP shows the feature concentrates importance in 1-2 phases (suggesting the boundaries are wrong).

**Done when:** Next takeit retrain consumes `session_phase`, SHAP plot shows non-trivial importance, AUC on held-out set does not regress.

---

### Phase 4 — Wave-2 confirmation

**Scope:** New cron that tracks follow-through on every Lottery / Silent Boom fire.

**Independent of Phase 1/2/3:** Can run in parallel.

**Files to create/modify:**

- `api/cron/wave2-confirmation.ts` — new cron, runs every 5 min during market hours
- `api/__tests__/wave2-confirmation.test.ts` — new
- `api/_lib/db-migrations.ts` — migration N+2: add `wave2_status TEXT` and `wave2_detected_at TIMESTAMPTZ` to both `lottery_fires` and `silent_boom`
- `vercel.json` — register cron, every 5 min during market hours

**Logic:**

- For each fire in the last 60 min with `wave2_status IS NULL`, scan for a second qualifying event on the same ticker, same direction
- If found within 30 min → `wave2_status = 'confirmed'`
- If found 30-60 min → `wave2_status = 'lagging'`
- If 60 min has elapsed with nothing → `wave2_status = 'fizzled'`

**Downstream consumers:**

- Takeit retrain (next scheduled GH Actions run) gets `wave2_status` as a target-side label for the meta-classifier or as a feature for the SHAP fill
- UI can render a small badge on alert tiles

**Done when:** Cron runs without errors for 3 trading days, status distribution is reasonable (not all `fizzled`, not all `confirmed`).

---

### Phase 5 — Forced-flow penalty

**Depends on Phase 2** (uses multileg labels for cross-name detection).

**Open question:** Score multiplier on takeit prob vs new feature in the model? Default pick: **new feature**, so the model can learn interactions (e.g., a `forced_flow_score=0.8` print with `inferred_structure='vertical'` may still be informed; a multiplier would zero it out incorrectly).

**Files to create/modify:**

- `api/_lib/forced-flow.ts` — new
- `api/_lib/takeit-features.ts` — add 4 features
- `api/__tests__/takeit-features.test.ts` — fixture updates

**Penalty components (each a separate feature):**

- `bilateral_flow_score` — same ticker calls AND puts both qualify within 10 min window
- `cross_name_cluster_score` — N≥5 tickers from same sector all alert within 5 min
- `calendar_adjacency_flag` — quarter-end last hour, day-after-FOMC, day-after-CPI, day-after-NFP
- `cross_asset_stress_flag` — VIX intraday change > +3pts at alert time

**Data dependencies:** All exist — VIX is already fetched, sector mapping is in the Lottery universe definition, calendar dates are computable.

**Done when:** Backtest on held-out 30 days shows forced-flow features have non-zero SHAP importance, and the takeit retrain consumes them without AUC regression.

---

### Phase 6 — Verification, retrain, calibration, ship

**Files to modify:**

- `api/cron/audit-takeit-calibration.ts` — already exists (recent untracked) — extend to check new features
- Backtest script: compare takeit-v1 vs takeit-v2 (with new features) on 30-day held-out

**Done when:**

- `npm run review` passes
- GH Actions weekly retrain has consumed all new features
- Held-out AUC ≥ takeit-v1 AUC (no regression) and ideally +2pp or better
- Calibration audit cron confirms predicted vs realized lottery / silentboom win rates stay within calibration band

---

## Data dependencies

**None new.** Entire scope operates on data already in Neon or already computed by sidecar.

## Open questions (with default picks)

1. **Multileg pattern set v1: 4 or 6?** → Decided: 4 (vertical, strangle, RR, butterfly); add iron condor + diagonals in v2.
2. **Time-of-day boundaries: hard-coded vs empirical?** → Default: hard-coded 7-phase split, revisit after SHAP review.
3. **Forced-flow: multiplier or feature?** → Default: feature, let model learn interactions.
4. **Wave-2 storage: column on existing table vs new table?** → Default: column (2 columns: status + detected_at); new table only if we need historical wave-2 events log.

## Thresholds / constants (agreed during scoping)

| Constant                                     | Value                                 |
| -------------------------------------------- | ------------------------------------- |
| Multileg window                              | 90 seconds                            |
| Multileg `is_isolated_leg` confidence cutoff | match_confidence < 0.5                |
| Multileg validation target reclassification  | 65-85% (baseline 76%)                 |
| Wave-2 confirmed window                      | 0-30 min after fire                   |
| Wave-2 lagging window                        | 30-60 min after fire                  |
| Wave-2 fizzled cutoff                        | 60 min                                |
| Wave-2 cron cadence                          | every 5 min during market hours       |
| Forced-flow bilateral window                 | 10 min                                |
| Forced-flow cross-name cluster N             | 5 tickers same sector in 5 min        |
| Forced-flow cross-asset stress trigger       | VIX intraday change > +3pts           |
| Takeit AUC regression tolerance              | no regression vs v1; +2pp target lift |

## Phase sequencing

```text
Phase 1 (parquet validation, ml/ only)
  ↓
Phase 2 (multileg live wire, api/ + sidecar)
  ↓
Phase 5 (forced-flow, depends on Phase 2 labels)
  ↓
Phase 6 (verification + retrain + ship)

Phase 3 (time-of-day) — parallel to 1/2/4
Phase 4 (wave-2)       — parallel to 1/2/3
```

Phases 3 and 4 can land in any order relative to 1/2. Phase 5 is the only hard dependency. Phase 6 is the gate.

## Out of scope

- Skew shock, synthetic basis, term structure inversion → see [deferred doc](./deferred-non-0dte-detectors-2026-05-16.md)
- Absence-of-flow / decay detector (dropped during scoping — baseline modeling cost too high vs marginal edge)
- Iron condor and diagonal pattern matching (v2 of multileg assembler)
- UI surfacing of new fields beyond Phase 4's optional badge (can ship without)
- Cross-asset regime detector — separate plan doc when ready (highest-leverage future build)
