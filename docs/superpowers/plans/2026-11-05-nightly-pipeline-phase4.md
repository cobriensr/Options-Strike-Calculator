# Nightly pipeline, phase 4: the safe nightly refit — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lottery V2 weights and tier cutoffs are refit by the nightly job and go live only after a candidate has passed history-tuned gates on 10 later sessions it never trained on. Every promotion and rejection reaches the owner, and every rescore keeps a copy of the scores it replaces. Take-It's input score stays pinned to the 06-17 weights.

**Architecture:**
- **Store.** Weights and cutoffs move from a generated TypeScript file to a versioned store in Neon (D5):
  - `lottery_score_versions` holds the versions;
  - `lottery_score_pointers` holds two named pointers, `active` and `takeit`;
  - `lottery_fire_value_snapshots` keeps a copy of every overwritten value.
- **TypeScript.** `api/_lib/lottery-score-weights-v2.ts` becomes a pure function of a Zod-validated weights object. A new loader reads both pointers. `detect-lottery-fires.ts` scores each fire twice (D8).
- **Python.** The nightly gains one step, `lottery-refit`, on phase 2's step runner (D2), registered with `lazy_step`. It runs one candidate at a time (D6):
  - train on the trailing 90 days;
  - match the feed cutoffs to the active version's tier shares;
  - shadow for 10 evaluated sessions;
  - then promote in one transaction: snapshot, rescore every fire, move the pointer. Or reject.
  - `PROMOTION_ENABLED = False` ships, so live scores cannot change until the owner says go.
- **The training population is defined once** (D7). It keeps the exchange's single-leg flag and the existing drop of impossible inversions. It adds no filter: the cron's corrupt inversions are gone before the first refit (the Facts below say how).

**Tech Stack:**
- TypeScript: Zod v4, Vitest, PGlite.
- Python 3.12 in the nightly image (ml venv 3.14 locally): pandas 3, numpy, psycopg2, pytest, ruff.
- Neon Postgres.

**Spec:** `docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md`. The parts that bind this plan:
- Phases item 4 and Goals 5–6;
- Facts → "The lottery refit";
- Decided → Refit;
- Owner answer 2;
- the Anti-goals.

**Builds on:** phase 2's plan, `docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md`. Its decisions D1–D4 are used verbatim: the image layout, the step runner with `lazy_step`, the budget table, `connect_db`. Phase 1 is `docs/superpowers/plans/2026-10-28-nightly-pipeline-phase1.md`.

**Build order (owner, 2026-11-06):** phase 2 (all tasks) → this plan's Tasks 1–22 (through the first shadow runs) → phase 3 (all tasks, built during the 10-session shadow) → this plan's Task 23 (promotion, which needs phase 3 complete). At runtime `pipeline.STEPS` runs the tape, phase 2's `enrich-outcomes` and `outcome-check`, then `lottery-refit` (this plan), then phase 3's `research-derive` and report steps.

---

## Facts measured for this plan (read-only, 2026-11-05)

Source: prod Neon, read-only session, aggregates only. The probe scripts are in `C:/Users/Charlie/AppData/Local/Temp/claude/F--dev-strike-calculator/6426a92a-55a0-45f2-a8f7-d6176b05cfde/scratchpad/phase4-plan/` (`p1`–`p10`, `scorer.py`). That is a temp folder and may be gone; Task 1 defines the procedure in full.

- **`lottery_finder_fires`:** 1,064,396 fires on 181 sessions.
  - Dates run 01-02 → 11-05. There are no fires 07-23 → 09-07 (a spec non-goal).
  - 425,138 are scorable (aligned, DTE 0–3).
  - **Multi-leg flag:** `anchor_leg_kind` is set on 1,064,394 of 1,064,396 rows (11-05). The classifier session backfilled it from the tape (memory `classifier-assessment-2026-10-28`). **Phase 2's deferred "backfill the flag" step is done**; this plan only verifies it (Task 1).
  - **Outcomes exist only where something enriched them:** 01-02 → 06-16 (parquet-built) and 10-20 → 11-05 (cron-built). The gap between is phase 2's backfill, which finishes before Task 1.
- **The old bug signature has moved from structure to source.** The signature is `realized_flow_inversion_pct > peak_ceiling_pct × 1.05`, measured on aligned rows before the 11-06 reset below.

  | Era | single-leg | multi_leg |
  |---|---|---|
  | parquet-built, by month Jan → Jun | 0.31, 0.23, 0.16, 0.24, 0.05, 1.01 % | 1.82, 0.80, 1.16, 1.48, 0.17, 0.92 % |
  | cron-built, Oct / Nov | 36.5 / 32.1 % | 27.3 / 27.0 % |

  - Before 06-17, by classifier label: NULL 0.38 %, isolated_leg 0.58 %, vertical 0.69 %, risk_reversal 0.57 %, strangle 0.71 %. The "35 % enrichment bug in structure rows" is gone from stored history.
- **The cron's flow inversion was corrupt, from a ×100 error. It is repaired outside this plan.**
  - **Cause (verified 11-05):** `deriveMid`'s first branch in `api/_lib/option-intraday.ts` dropped UW's ×100 multiplier. The bug dates from `a6ecb235` (05-05) and the fix shipped 11-05 (`c36ccac6`, `f387c743`). Phase 2's Task 7b deletes that module.
  - **Onset:** the cron first wrote inversions on 10-23, and its 4-day lookback reaches back to 10-20. 10-20 and 10-21 carry values but have no `peak_ceiling_pct`, so the signature reads 0 % on them although they are as corrupt as the rest.
  - **Size, before the reset:** on cron-built days 25–45 % of rows a day exceed peak × 1.05. 30.1 % of cron-built inversions exceed 1,000 %; in the parquet era 3.5 % exceed 200 %.
  - **The cron also wrote bad values in May and June.** The bad set is found by provenance, not by value: the fires whose (`option_chain_id`, `date`) has an `ok` row in `option_intraday_nbbo_fetches`. That is 111,645 rows (May 20,898; June 11,962; October 45,478; November 33,307), all with a cache. A value test misses them: a true −95 % exit reads about +400 % under the error.
  - **The reset is done, outside every plan (2026-11-06).** `realized_flow_inversion_pct` is NULL on those 111,645 rows, with a copy at R2 `backups/lottery-flow-inversion/2026-11-06-x100-reset.parquet`. Phase 2 deletes the cron's inversion pass (its Task 7), and its tape pass refills the NULLs. While a row is NULL, the outcome used here falls back to `realized_eod_pct` (D7). Nothing in this plan resets or rewrites an inversion.
  - The other outcome columns match across eras:

    | Column | parquet era p25 / p50 / p75 | cron era (before the reset) p25 / p50 / p75 |
    |---|---|---|
    | `realized_eod_pct` | −69.6 / −18.2 / 19.7 | −75.1 / −21.8 / 15.9 |
    | `realized_trail30_10_pct` | −29.1 / 17.8 / 28.2 | −32.5 / 17.2 / 28.7 |
    | `peak_ceiling_pct` | 11.7 / 35.0 / 89.2 | 10.2 / 33.3 / 91.1 |
    | `realized_flow_inversion_pct` | −36.0 / −3.1 / 31.1 | −37.6 / **28.2 / 4,659.9** |
- **The quintile-boundary bug is in stored history.**
  - Stored scores for 01-02 → 06-16 equal the 06-17 weights under the backfill's **left-closed** `<` on 100 % of Jan–May rows.
  - Live scores for Sep–Nov equal the **right-closed** TS scorer on 100 %.
  - 37,653 of 425,138 scorable fires (8.9 %) sit exactly on a boundary, where the two rules differ.
  - A further 8,251 fires (06-17 → 07-22) match neither rule against the 06-17 weights. They were scored correctly, with the 06-12 weights that were live then: the 06-17 weights reached the live scorer only on 09-07 (`f9f220fa`), and all 117,757 fires of 06-17 → 07-22 match the 06-12 weights (`36d48457`, right-closed). So a promotion's rescore (Task 15) replaces these scores with the promoted version's. It does not correct them.
- **Take-It input today:** `takeit_features->>'score'` equals the stored `score` on 150,168 of 150,168 fires since 06-17.
- **The 06-17 weights:**
  - `ml/output/lottery_score_weights.json` and the TS file are identical: 85 tickers, 7 composites, cutoffs t1/t2 = 10/6.
  - Trained on 134,899 rows from 03-19 to 06-16, with in-sample Spearman −0.064.
  - Spearman by era:
    - parquet-built Apr–Jun, bug rows dropped: −0.055 (n = 127,120);
    - cron-built since 10-20, bug rows dropped: −0.003 (n = 22,283).
- **Walk-forward gate tuning (parquet era).**
  - Setup:
    - 219,651 training-population rows on 103 sessions;
    - 11 cycles with cutoffs 03-13 → 05-29, every 5 sessions;
    - the production refit algorithm on a trailing 90-calendar-day window;
    - comparator: the previous cycle's candidate.
  - Training windows held 74,533–139,970 rows on 41–58 sessions.
  - Held-out pooled Spearman, candidate − comparator (Δρ):

    | Held-out sessions | mean | SD | cycles with Δρ ≥ 0 | corr with the next window's Δρ |
    |---|---|---|---|---|
    | 3 | 0.001 | 0.105 | 6/10 | 0.43 |
    | 5 | −0.007 | 0.072 | 6/10 | −0.31 |
    | 10 | 0.012 | 0.044 | 6/10 | −0.05 |

    So the ρ gate is a guard against clearly worse weights, not a selector of better ones.
  - Sign flips against the previous candidate: C/P in 1 of 10 cycles, DTE0 in 4 of 10.
  - Held-out windows of 10 sessions held 10,995–38,129 rows.
  - Day-level Spearman of the 06-17 weights has SD 0.178 (mean −0.03, 53 sessions).
- **Feed tiers (default view, stored scores, 13/10 on qas):**
  - since 06-17: daily tier1 share 1.6–14.9 % (p50 4.6 %), tier1+2 share 4.0–19.4 %;
  - since 10-20: tier1 p50 7.5 %, and qas p85/p95 = 16/22.
  - **Fixed 13/10 under walk-forward candidates:** held-out tier1 share candidate ÷ comparator has a median of 1.76 and runs up to 4.56. On most cycles the candidate's worst session had 0 tier1.
  - **Quantile-matched cutoffs** (trailing 20 sessions): median 1.13, within 0.73–1.43 in 9/10 cycles, one at 4.56. The matched cutoffs ran from 13/10 to 16/12.
- **The ticker EMA is a structural no-op, and the owner retired it (2026-11-06).** Starting from the 06-17 ticker weights, `compute_updates` moved 0 tickers on all 115 sessions with ≥ 100 rows (re-run 11-05; median 21 eligible tickers a night).
  - The 06-17 ticker weights span −1…5 and the implied weights −4…+5. `round(0.95·w + 0.05·implied)` moves only when |implied − w| ≥ 10, and the largest gap seen was 7.
  - A faster alpha would be needed to move anything: 0.10 gives 16 ticker moves over the 115 sessions, 0.20 gives 227, 0.50 gives 933.
  - The UTC `CURRENT_DATE` no-op sits on top of that.
  - So the nightly refit runs no EMA, and nothing writes the ticker-weight-history CSV. Task 16 deletes `online_ticker_update.py` and its Makefile call. Nothing else uses the script.

## Decisions (phase 4; phase 2's D1–D4 hold verbatim)

### D5 — the store is Neon

| Table | Columns | Rules |
|---|---|---|
| `lottery_score_versions` | `version TEXT PK`, `weights JSONB NOT NULL`, `status TEXT NOT NULL`, `trained_through DATE`, `created_at TIMESTAMPTZ DEFAULT now()`, `decided_at TIMESTAMPTZ`, `gate_report JSONB NOT NULL DEFAULT '{}'` | `version ~ '^(seed\|refit)-\d{4}-\d{2}-\d{2}$'`; `status IN ('seed','shadow','passed','promoted','rejected')`; partial unique index: at most one `shadow` |
| `lottery_score_pointers` | `name TEXT PK`, `version TEXT NOT NULL REFERENCES lottery_score_versions`, `updated_at` | `name IN ('active','takeit')` |
| `lottery_fire_value_snapshots` | `id BIGSERIAL PK`, `taken_at`, `reason TEXT`, `column_name TEXT`, `to_version TEXT NULL REFERENCES lottery_score_versions`, `fire_ids BIGINT[]`, `old_values DOUBLE PRECISION[]`, `old_tags TEXT[]` | `reason ~ '^[a-z][a-z0-9-]{1,40}$'`; `column_name IN ('score','realized_flow_inversion_pct')`; equal array lengths, 1–50,000 ids; `to_version` is set exactly when `column_name = 'score'` |
| `lottery_finder_fires` | `+ score_version TEXT` (nullable, no default) | NULL means scored before the store existed |

- **Seed row:** `seed-2026-06-17`, status `seed`, `trained_through` 2026-06-16. Both pointers start on it.
- **Version ids** are `refit-<trained_through>`, which gives one candidate per training session. `ON CONFLICT (version) DO NOTHING` makes a same-night re-run a no-op (R6).
- **Why Neon over a Blob manifest:**
  - promotion (snapshot, rescore, move the pointer) is one Postgres transaction;
  - the gate reports live next to the fires they describe;
  - the nightly job already has DB access (D4) and no Blob token;
  - restoring a snapshot is one `UPDATE … FROM unnest(...)`.
- **The weights object** (`schema_version` 1) is validated identically by Zod (TS) and `validate_weights` (Python). No unknown keys anywhere.

  | Field | Rule |
  |---|---|
  | `schema_version` | `1` |
  | `model_version` | non-empty string (the training method; `rescore-v1-2026-05-22`) |
  | `trained_through` | ISO date |
  | `features.ticker_weights` | 1–500 entries; key `^[A-Z][A-Z0-9.]{0,9}$`; int in [−5, 10] |
  | `features.tod_weights` | exactly `AM_open`, `MID`, `LUNCH`, `PM`; int in [−20, 20] |
  | `features.tod_weights_dow_overrides` | keys ⊆ Monday…Friday; each as `tod_weights` |
  | `features.dte_weights` | exactly `"0"`–`"3"`; int in [−20, 20] |
  | `features.{vol_oi,gamma,ask_pct}_quintile_weights` | 5 ints in [−20, 20] |
  | `features.{vol_oi,gamma,ask_pct}_quintile_boundaries` | 4 finite floats, strictly increasing |
  | `features.option_type_weights` | exactly `C`, `P`; int in [−20, 20] |
  | `features.composite_bonuses` | ≤ 50 entries. Each has: `match`, a non-empty subset of `ticker`, `tod`, `gamma_q`, `vol_oi_q`, `ask_pct_q`, where a q label is `"0"`–`"4"` or `"null"`; `bonus` int in [−10, 10]; `support` int ≥ 0; `win_rate` in [0, 1]; `note` string |
  | `cutoffs` | ints, `t1 > t2` (bare score; the cluster bonus) |
  | `feed_cutoffs` | ints, `tier1_min_score > tier2_min_score ≥ 0` (qas; the feed's tiers) |

  Python must reject `bool` where an int is required (`bool` is an `int` subclass).

### D6 — the candidate lifecycle (one at a time)

```
night k, no shadow:
  train on (k−90 days, k]  →  feed cutoffs matched to active
  →  creation checks  →  INSERT refit-k as 'shadow', or as 'rejected' + notice
night k+1 …, a shadow exists:
  evaluate each elapsed session except the newest (record it in gate_report.sessions.<date>)
  fewer than 10 evaluated sessions: wait   (20 elapsed sessions with < 10 evaluated → reject 'shadow_starved')
  10 evaluated: decide on exactly the first 10
     pass + PROMOTION_ENABLED + before 12:30 UTC + ≥ 1200 s left → promote (one transaction), notice
     pass + PROMOTION_ENABLED, but too late, too little time, or the rescore hits the step deadline
                                                                 → stay 'shadow' (the rescore rolls back whole), step 'partial'
     pass + PROMOTION_ENABLED = False                            → 'passed', notice ("promotion disabled")
     fail                                                        → 'rejected', notice
```

- **The spec's "later held-out window" is the shadow itself,** so the weights that get promoted are exactly the ones that were evaluated.
- **Refit cadence** becomes about one candidate every 11 sessions.
- **Evaluation lags one session (review N16).** Session s is evaluated on the run after session s+1 lands, so `s <= previous_trading_day(last_session)`. Its fires have then had two enrich passes, and a fire whose net flow arrived late has its tape inversion by then. The record is written once and never recomputed. A fire whose inversion is still NULL scores on `realized_eod_pct`, the outcome definition's fallback (D7), and stays so in the record. `sessions_elapsed` counts the same lagged range.
- **No ticker EMA.** The old `make update` nudge is retired (owner, 2026-11-06; Facts). Ticker weights come from the training alone.
- **The `takeit` pointer** is never written by any code in this plan.

### D7 — the training population, defined once (`ml/src/lottery_scoring.py`)

- **Population:**
  - aligned (call: `cum_ncp > cum_npp`; put: `cum_npp > cum_ncp`; both non-null);
  - `SINGLE_LEG_FILTER` (`anchor_leg_kind = 'single'`, the exchange's OPRA code on the anchor print), unchanged;
  - outcome present;
  - then in pandas, drop rows with `realized_flow_inversion_pct > peak_ceiling_pct × 1.05` (unchanged).
- **Window:** explicit, `date > through − 90 days AND date <= through`. No `CURRENT_DATE`.
- **The outcome is unchanged:** `COALESCE(realized_flow_inversion_pct, realized_eod_pct)`, a flow-inversion exit with a held-to-EOD fallback.
- Multi-leg, stock-tied and unknown rows stay out (the spec's default). The measurement above says their rows are clean, but they are a different population (memory `classifier-assessment`: win 37.6 % against 50.7 %). Owner answer 5.
- **No filter for the cron's inversions.** Those values no longer exist: phase 2 deleted the cron's pass, and the 111,645 affected rows were reset on 11-06 and are refilled from the tape (Facts). A row still waiting for its tape inversion falls back to `realized_eod_pct` through the `COALESCE`. The pandas drop above stays because it predates the cron and catches any impossible value.

### D8 — two scores per fire

- `detect-lottery-fires` loads `{active, takeit}` once per run.
- It writes `score = scoreLotteryV2(active)` and `score_version = active.version`.
- It passes `scoreLotteryV2(takeit)` as the Take-It row's `score`, computing it a second time only when the two versions differ.
- The cluster bonus uses `active.weights.cutoffs.t1`. The feed-tier monitor uses `active.weights.feed_cutoffs`.
- `api/_lib/takeit-features.ts` needs no change. Take-It's prior-fire context reads no stored lottery score; checked with grep, 2026-11-05.

### D9 — notices that reach the owner

- **Nightly** events carry tag `service=nightly`. Rule 6262727 emails each *new issue* at any level (memory `sentry-cron-alert-routing`), so every refit notice gets its own fingerprint.

  | Kind | Level | Title | Fingerprint |
  |---|---|---|---|
  | promoted | warning | `nightly refit promoted` | `["nightly-refit","promoted",version]` |
  | passed while promotion is disabled | warning | `nightly refit passed; promotion disabled` | `["nightly-refit","passed",version]` |
  | rejected after shadow | error | `nightly refit rejected` | `["nightly-refit","rejected",version]` |
  | rejected at creation | error | `nightly refit candidate rejected` | `["nightly-refit","candidate_rejected",first_reason]` (one issue per reason, so a thin-data streak emails once) |

  - **Accepted by the owner (2026-11-06):** the creation fingerprint carries the reason, not the version, so one email goes out per *new* reason. A reason that recurs opens no new issue and sends nothing. The Sentry issue count and the step's logs show the streak. A rejection after a shadow carries the version, so each one emails.
  - Tags: `step`, `refit`, `version`.
  - Extras: aggregates only: counts, ρ values, share ratios, cutoffs before and after, the number of ticker weights changed, and the labels of flipped signs (`C/P`, `DTE0`).
  - Never ticker-level rows.
- **Vercel:** the loader's seed fallback is a Sentry `error` (a Vercel `warning` emails nobody): `lottery weights fallback to seed`, fingerprint `["lottery-weights-fallback", kind]`.
  - Rules 6262727 and 6262822 cover the `nightly` service only. The Vercel project has its own rules (16804820 and 1a–1c, `docs/superpowers/specs/sentry-monitoring-2026-05-07.md`), and none of them matches a single occurrence of this message (1c filters on other phrases; 1a and 1b need a volume spike), so one fallback error would email nobody.
  - Task 9 adds a message rule for it, modelled on rule 1c. Creating it changes the owner's alerting, so it needs the owner's approval at execution time.

## Gate numbers (tuned above; Task 1 re-checks them on the tape-built window)

| Constant (`ml/src/lottery_refit_gates.py`) | Value | Basis |
|---|---|---|
| `TRAIN_WINDOW_DAYS` | `90` | unchanged |
| `MIN_TRAIN_ROWS` | `30_000` | parquet-era windows held 74,533–139,970; the 10-29 collapse was 196 |
| `MIN_TRAIN_SESSIONS` | `30` | parquet-era windows had 41–58 |
| `SHADOW_SESSIONS` | `10` | SD(Δρ) is 0.105 / 0.072 / 0.044 at 3 / 5 / 10 sessions (owner answer 3) |
| `SHADOW_MAX_SESSIONS` | `20` | 2 × `SHADOW_SESSIONS`: a starved shadow is rejected instead of waiting forever |
| `MIN_EVAL_ROWS_PER_SESSION` | `300` | parquet-era daily rows: p10 797, min 83 |
| `MIN_EVAL_ROWS` | `5_000` | 10-session held-out windows held 10,995–38,129 |
| ρ rule | pooled Spearman, candidate ≥ active, over the first 10 evaluated sessions | spec; passed 6/10 cycles |
| `TIER_SHARE_RATIO_BAND` | `(0.67, 1.5)` for both tier1 and tier1+2 | matched cutoffs: 0.73–1.43 in 9/10 |
| `TIER1_SHARE_BAND` | `(0.01, 0.15)`, the candidate's mean daily tier1 share | live since 06-17: 1.6–14.9 % |
| `FEED_CUTOFF_MATCH_SESSIONS` | `20` | |
| `FEED_CUTOFF_SEARCH_MAX` | `40` | qas p99 since 10-20 is 28 |
| no NaN | `validate_weights` (D5) | |

Nightly constants (`nightly/src/constants.py`):
- `REFIT_BUDGET_SECONDS = 1800`. This is this plan's row of phase 2's D2 budget table, which holds every phase's reserve. Nothing else in that table changes here;
- `PROMOTION_MIN_SECONDS = 1200`, to be re-measured in Task 22 (the rescore is timed on prod before the push);
- `PROMOTION_CUTOFF_UTC = time(12, 30)`, an hour before the earliest open (13:30 UTC in EDT);
- `PROMOTION_ENABLED = False`. This is a reviewed one-time switch with its reason in a comment (precedent: `PROMOTE_TO_LIVE` in `api/cron/refit-lottery-ticker-stats.ts`).

**Reserve and tape window after this plan** (D2's stage table, "After phase 4"): enrich 900–1,800 s + outcome check 300 s + refit 1,800 s = 3,000–3,900 s. The tape deadline falls to 14,100–15,000 s, and a tape day may start only in the first 10,500–11,400 s of the run. Task 21 puts that window in the README's first item and in `CLAUDE.md`. The tests assert on the constants and never on a hard-coded sum (Task 21).

## Global Constraints

- **From phases 1 and 2:**
  - no market data in logs or Sentry;
  - Python 3.12 in the image;
  - ruff: nightly `>=0.17,<0.18` at line length 100; `ml/` uses its own `ml/pyproject.toml`; `scripts/` files use isolated ruff `--select E4,E7,E9,F` and are never ruff-formatted;
  - constants, not env vars (R7). **This plan adds no env var.**
- **At most 5 files per task.** Every task ends with `npm run review` before its commit (the commit gate). Python tasks first run their suite and ruff.
- **Python environments:**
  - `ml/` tests: `cd ml && .venv/Scripts/python -m pytest -q <files>`, then `.venv/Scripts/python -m ruff check src tests && .venv/Scripts/python -m ruff format --check src tests`;
  - `scripts/` tests: `ml/.venv/Scripts/python -m pytest -q <files>`;
  - nightly: `cd nightly && .venv/Scripts/python -m pytest -q`, plus `ruff check` and `ruff format --check`.
- **`ml/src` files copied into the image must run on Python 3.12,** even though ml's ruff targets 3.13. Task 20's layout import test runs them under 3.12.
- **D1's six-place rule** applies to every newly reused file (Task 20; the CI filter may sit in its own task, as in Task 20b):
  - Dockerfile `COPY`;
  - watch path;
  - `.dockerignore` exception;
  - `IMAGE_FILES`;
  - the CI path filter;
  - the watch-path list in `nightly/README.md`.
- **Quintile bounds are right-closed everywhere:** a value ≤ b_k goes to quintile k.
- **DB writes:** ≤ 500 rows per statement (R5); conditional, or compare-and-set on the pointer (R6). A promotion is exactly one transaction.
- **Owner go-ahead before running anything that changes live scores, tiers or labels** (memory `no-silent-methodology-changes`). That is Task 23, marked **[OWNER GO-AHEAD]**. `PROMOTION_ENABLED` ships `False`. Two more steps need the owner's approval at execution time because they change prod or alerting: the migration run and the Sentry message rule (both Task 9).
- **Push and deploy order.** Every push that touches a Railway watch path goes **after 15:00 CT and outside 07:15–12:30 UTC** (phase 2's D1).
  - **P1:** Task 2 is pushed when it passes. Task 3 (migration #202) is pushed when it passes and phase 2's Task 1 (#201) is on origin/main. Neither has a runtime effect.
  - **P2:** Tasks 4–8 stay local until Task 9 has verified the migration on prod. They are pushed together.
  - **P3:** Tasks 12–17 (`ml/`, `scripts/`, Makefile) are pushed as they pass, except that Task 16 waits and goes with Task 17: between the two, `make update` would call the deleted script. Vercel ignores those paths. None of their files is a watch path: Task 20 adds the new ones, and Task 22 sets them on the service.
  - **P4:** Tasks 18–21, including Task 20b (`nightly/`, `.dockerignore`, `ci.yml`, docs), stay local until Task 22.
- **Prerequisite:** phase 2 is executed in full before Task 1 (build order). Task 1 needs `inversion_source` and the finished backfill. Task 3 needs phase 2's Task 1 on origin/main. Tasks 18 onward need D2's step runner with `lazy_step`, D2's budget table and D4's `connect_db`.

## Review Focus

1. **A promotion that fails or races halfway through a 1 M-row rescore** (an UPDATE error, SIGTERM, the watchdog, the step deadline, or the `active` pointer moved by hand). Expected: either every score, tag, status and pointer is new, or none is. Pinned by these tests in Task 15:
   - `test_promotion_rolls_back_when_an_update_fails`;
   - `test_promotion_aborts_when_the_active_pointer_moved`;
   - `test_concurrent_score_writer_aborts_the_rescore`;
   - `test_rescore_rolls_back_past_the_deadline`.
2. **The Vercel loader failing while a promoted version is active** (a Neon blip at cold start, an invalid row, a missing pointer). Expected: a stale cached version beats the seed. A fire is always written with the version that scored it in `score_version`. A seed fallback is a Sentry error and makes the run `partial`. Pinned by:
   - `serves the cached version on a transient error` (Task 4);
   - `falls back to the seed with an error when nothing is cached` (Task 4);
   - `a weights fallback marks the run partial and records the seed version` (Task 5).
3. **Python and TS disagreeing on a score** (boundary values, null features, the Monday override, composites with `"null"` labels, DTE 4, ties in alignment). Expected: identical scores. Pinned by the shared fixture `api/__tests__/fixtures/lottery-score-parity.json`, run by `replays the parity fixture` (Task 2) and `test_score_frame_matches_the_parity_fixture` (Task 12).
4. **A shadow that can never finish** (a thin session, holidays, a NULL-outcome day). Expected: one rejection with reason `shadow_starved` after 20 elapsed sessions and one notice, then a fresh candidate. Pinned by `test_shadow_starved_after_max_sessions` (Task 13) and `test_starved_shadow_is_rejected_once` (Task 19).
5. **The nightly re-run the same night** (Railway retry, `railway cron run`). Expected: no second candidate, no duplicate session entry, no second promotion. Pinned by `test_rerun_same_night_is_a_no_op` (Task 19), `test_insert_candidate_is_idempotent` (Task 18) and `test_record_session_eval_is_keyed_by_session` (Task 18).

---

### Task 1 (controller, read-only): Confirm the gate numbers on the tape-built window

**When:** after phase 2's backfill has finished (its Task 15 Step 5: `days_left = 0`, `days_failed = 0`, `days_waiting_tape = 0` and an empty work list). It must finish before Task 21 registers the step.

**Skills:** `statistical-analysis`, `scikit-learn`, `postgres-pro`.

- [ ] **Step 1: Coverage.** Count `anchor_leg_kind IS NULL` in the current 90-day window. Expected: ≤ 3. Tabulate `outcome_source` × `inversion_source` by month. Read-only connection; aggregates only; `DATABASE_URL` read inside the script from `.env.local`, never printed.
- [ ] **Step 2: Bug signature by source and leg kind.** On aligned rows with both values, measure the share with `realized_flow_inversion_pct > peak_ceiling_pct * 1.05` by `inversion_source` (`fulltape`, `bot_eod`, NULL) × `anchor_leg_kind`, and by month.
  - Expected: ≤ 2 % in every cell for both `single` and `multi_leg` (parquet-built months read 0.05–1.8 %). The NULL-source rows are the parquet-built values plus the fixed cron's last four sessions.
  - A cell above 2 % goes to the owner before Task 21.
  - This is the spec's "measure the old bug's signature on structure rows" (owner answer 5).
- [ ] **Step 3: Walk-forward on the tape-built era (06-17 → the last session).** The cron-era rows are clean once the tape has refilled the reset inversions, which phase 2's backfill has done. Use exactly the probe's cycle:
  - training population D7;
  - candidate = `lottery_scoring.train_weights` (Task 14) on a trailing 90-calendar-day window. If Task 14 hasn't landed, use the old `main()` body built from `lottery_scoring`'s `quintile_boundaries` and `compute_*_weights`, which is what the probe did;
  - cutoffs every 5 sessions from the 30th session of the era;
  - held-out = the next 5 and 10 sessions;
  - comparator = the previous cycle's candidate.

  Report training rows and sessions, Δρ (mean, SD, share ≥ 0), and the tier1 / tier1+2 share ratio with matched cutoffs.
- [ ] **Step 4: Tier band.** Score 06-17 → the last session with the seed (right-closed). Report the daily feed tier1 and tier1+2 shares (p05 / p50 / p95), and the share of sessions below 1 % or above 15 %.
- [ ] **Step 5: Decide.** A constant keeps its value unless the re-measured basis moves it by more than 25 %:
  - `MIN_TRAIN_ROWS` = 40 % of the smallest re-measured window, rounded down to 5,000;
  - `MIN_EVAL_ROWS_PER_SESSION` = the re-measured daily p10 ÷ 2.5, rounded down to 50;
  - band edges = the re-measured min and max, widened by 10 %.

  Edit the "Gate numbers" table in this plan (a docs commit). If Task 13 has already landed, the change is also a constants-only commit to `ml/src/lottery_refit_gates.py` (with its band-edge tests), made before Task 22's push. Send the owner the before/after table with answer 2's and answer 5's data.
- [ ] **Step 6:** Write the numbers to `docs/tmp/nightly-phase4-tuning.md` (local only).

### Task 2: Weights schema, frozen seed, parity fixture, pure scorer

**Skills:** `typescript-expert`, `zod`, `test-master`.

**Files:**
- Create: `api/_lib/lottery-weights-schema.ts`, `api/_lib/lottery-weights-seed.ts`, `api/__tests__/fixtures/lottery-score-parity.json`
- Modify: `api/_lib/lottery-score-weights-v2.ts`, `api/__tests__/lottery-score-weights-v2.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lottery-weights-schema.ts
  export const LotteryWeightsSchema;                          // z.object(...).strict(), D5's table
  export type LotteryWeights = z.infer<typeof LotteryWeightsSchema>;
  export type FeedTierCutoffs = LotteryWeights['feed_cutoffs']; // { tier1_min_score; tier2_min_score }
  export type CompositeBonus = LotteryWeights['features']['composite_bonuses'][number];
  export type TimeOfDay = 'AM_open' | 'MID' | 'LUNCH' | 'PM';
  // lottery-weights-seed.ts — FROZEN: this is version seed-2026-06-17; never edit
  export const SEED_LOTTERY_WEIGHTS_VERSION = 'seed-2026-06-17';
  export const SEED_LOTTERY_WEIGHTS: LotteryWeights;
  // lottery-score-weights-v2.ts
  export interface LotteryScoreInput { ticker: string; tod: TimeOfDay; dte: number;
    volOiWindow: number | null; gammaAtTrigger: number | null; triggerAskPct: number | null;
    optionType: 'C' | 'P'; isAligned: boolean; dayOfWeek?: string }
  export function assignQuintile(value: number, boundaries: ReadonlyArray<number>): number
  export function isAlignedFire(optionType: 'C' | 'P', cumNcp: number | null, cumNpp: number | null): boolean
  export function weekdayOf(dateIso: string): string    // the cron's `${date}T12:00:00Z` toLocaleDateString('en-US',{weekday:'long'})
  export function scoreLotteryV2(weights: LotteryWeights, args: LotteryScoreInput): number | null
  export function lotteryScoreTierV2(score: number | null, cutoffs: LotteryWeights['cutoffs']): 'tier1' | 'tier2' | 'tier3'
  /** @deprecated Task 5 deletes it */ export function computeLotteryScoreV2(args: LotteryScoreInput): number | null  // scoreLotteryV2(SEED_LOTTERY_WEIGHTS, args)
  /** @deprecated Task 5 deletes it */ export const LOTTERY_TIER_THRESHOLDS_V2: LotteryWeights['cutoffs']           // SEED_LOTTERY_WEIGHTS.cutoffs
  ```
- **Seed content:** today's TS constants, verbatim.
  - `model_version` `rescore-v1-2026-05-22`; `trained_through` `2026-06-16`;
  - composite keys snake_case (`win_rate`), as in `ml/output/lottery_score_weights.json`;
  - `cutoffs {t1: 10, t2: 6}`; `feed_cutoffs {tier1_min_score: 13, tier2_min_score: 10}`.
- **Fixture shape:**
  - `{ "version": "seed-2026-06-17", "weights": <SEED>, "cases": [{ "name", "fire": {...}, "expected": int | null }] }`;
  - each `fire` has `underlying_symbol, option_type, tod, dte, trigger_vol_to_oi_window, gamma_at_trigger, trigger_ask_pct, cum_ncp_at_fire, cum_npp_at_fire, date`, the DB column names, so Task 12 reads it as-is.

- [ ] **Step 1: Generate the fixture from today's code, before any edit.** Write ≥ 40 cases covering:
  - each of the 12 boundaries exactly, and 6 of them + 1e-9;
  - each continuous feature NULL;
  - Monday, Tuesday and a Saturday date;
  - each of the 7 composites matching and missing by one key;
  - a `gamma_q: "null"` composite probe;
  - misaligned call and put, `cum_ncp == cum_npp`, NULL cum;
  - DTE 0, 3 and 4;
  - an unknown ticker.

  Compute `expected` with a one-off `npx tsx -e` that imports the **current** `computeLotteryScoreV2`, deriving alignment and weekday the way the cron does (lines 805–821 at a02fef66). Commit no generator.

  **The fixture goes into the public repo, so every input is synthetic:** hand-written values, dates and tickers. No row is copied from Neon, R2 or any UW payload. The weights inside it are the seed's, which `api/_lib/lottery-score-weights-v2.ts` already publishes.
- [ ] **Step 2: Write the failing tests** in `lottery-score-weights-v2.test.ts`. Rewrite the existing suites against `scoreLotteryV2(SEED_LOTTERY_WEIGHTS, …)`, keeping every assertion, and add:
  - `replays the parity fixture`: every case through `isAlignedFire` + `weekdayOf` + `scoreLotteryV2(fixture.weights, …)` equals `expected`;
  - `fixture weights equal the seed`: `toEqual(SEED_LOTTERY_WEIGHTS)`;
  - `the seed parses` with `LotteryWeightsSchema`;
  - `the schema rejects`, one case each: an unknown key at the top level and in `features`, NaN or Infinity in a boundary, non-increasing boundaries, 3 boundaries, a ticker weight of 11, a fractional weight, `t1 <= t2`, `tier1_min_score <= tier2_min_score`, a `tod_weights` key missing, a q label `"5"`;
  - `scores with the weights it is given`: a copy of the seed with `ticker_weights.SNDK += 3` scores an SNDK fire exactly 3 higher;
  - `lotteryScoreTierV2 reads the cutoffs it is given`.
- [ ] **Step 3:** Run `npx vitest run api/__tests__/lottery-score-weights-v2.test.ts`. Expected: FAIL (no module `lottery-weights-schema`).
- [ ] **Step 4: Implement.**
  - The scorer body is today's, reading `weights.features.*`.
  - Delete the generated constants and the GENERATED header.
  - The doc block names the store (D5) and says the seed is frozen.
  - The test file's header comment (lines 3–7) stops saying the sync script regenerates the TS file and that weights shift on every retrain: the suites now score with the frozen seed.
- [ ] **Step 5:** Run the test, then `npm run review`. Expected: green. The two deprecated wrappers keep `detect-lottery-fires.ts` compiling.
- [ ] **Step 6:** Commit `refactor(lottery): Score from a validated weights object and freeze the 06-17 weights as the seed`. Push (P1).

### Task 3: Migration — the weights store, pointers, snapshots, `score_version`; retire the TS generator

**Skills:** `postgres-pro`, `test-master`. Follow `.claude/agents/db-migration-specialist.md` for the `db.test.ts` sequence.

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append), `api/__tests__/db.test.ts`, `Makefile` (delete the two `sync_lottery_score_weights_v2.py` lines and the history comment above the first, `Makefile:221-227`)
- Create: `api/__tests__/lottery-score-store-pglite.test.ts`
- Delete: `scripts/sync_lottery_score_weights_v2.py`

**Why the generator goes here:** after Task 2, a `make refit` or `make update` would re-render `lottery-score-weights-v2.ts` from the old template and undo Task 2. Task 2 is at five files, so this is the earliest task with room. Don't run `make refit` between Tasks 2 and 3.

**Interfaces:**
- Consumes: `SEED_LOTTERY_WEIGHTS`, `SEED_LOTTERY_WEIGHTS_VERSION` (Task 2).
- Produces: migration `#N`, where N is **202**: phase 2's Task 1 owns #201 (the top id was 200 at `06cad43f`). It contains D5's three tables, the partial unique index, `lottery_finder_fires.score_version`, the seed row and both pointers.
  - **Ordering:** push this task only after phase 2's Task 1 is on origin/main. Ids are only a convention, so re-read the top id on origin/main just before the push. If another session took 202, use the next free id and tell the main session.

**SQL shape:** `statements: (sql) => [...]`, in this order:
1. `SET LOCAL lock_timeout = '5s'`;
2. `CREATE TABLE IF NOT EXISTS lottery_score_versions`;
3. `CREATE UNIQUE INDEX IF NOT EXISTS lottery_score_versions_one_shadow ON lottery_score_versions (status) WHERE status = 'shadow'`;
4. `CREATE TABLE IF NOT EXISTS lottery_score_pointers`;
5. `CREATE TABLE IF NOT EXISTS lottery_fire_value_snapshots`;
6. `ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS score_version TEXT`;
7. ``INSERT INTO lottery_score_versions (version, weights, status, trained_through) VALUES (${SEED_LOTTERY_WEIGHTS_VERSION}, ${JSON.stringify(SEED_LOTTERY_WEIGHTS)}::jsonb, 'seed', '2026-06-16') ON CONFLICT (version) DO NOTHING``;
8. `INSERT INTO lottery_score_pointers (name, version) VALUES ('active', …), ('takeit', …) ON CONFLICT (name) DO NOTHING`.

The description cites the spec and D5, says NULL `score_version` means "scored before the store", and says the `takeit` pointer is moved only by a Take-It retrain.

- [ ] **Step 1: Write the failing PGlite test.** Apply the real migration that creates `lottery_finder_fires` (find it by `CREATE TABLE IF NOT EXISTS lottery_finder_fires`), then N. Tests:
  - `creates the store and points active and takeit at the seed`;
  - `the seed row parses and equals SEED_LOTTERY_WEIGHTS` (`LotteryWeightsSchema.parse(row.weights)` deep-equals);
  - `allows at most one shadow version`: a second `shadow` insert throws a unique violation, while a second `rejected` succeeds;
  - `rejects a pointer to an unknown version, an unknown pointer name and a malformed version id`;
  - `snapshot rows need equal array lengths and a version exactly for scores`;
  - `adds a nullable score_version with no default`;
  - `re-running keeps a moved pointer`: move `active` to an inserted `refit-2026-11-04`, apply again, and `active` is still `refit-2026-11-04`.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/lottery-score-store-pglite.test.ts`. Expected: FAIL.
- [ ] **Step 3: Append the migration.** Update `db.test.ts`:
  - `{ id: N }`;
  - `'#N: <description>'`;
  - `mockSql` +9 (8 statements + tracking INSERT);
  - `mockSql.transaction` +1;
  - extend the breakdown comments above both totals (CLAUDE.md "DB Migrations": the one above the `mockSql.transaction` total names the top migration id).
- [ ] **Step 4:** Delete the generator, its two Makefile lines and the history comment. Grep for `sync_lottery_score_weights_v2` outside `docs/`. What may remain, each for a later task: `scripts/README.md` (Task 17); `ml/README.md` and the `ml/src/score_components.py:106` docstring (Task 14); and `ml/src/lottery_refit_guard.py` and `scripts/online_ticker_update.py`, which Tasks 17 and 16 delete. Task 2's two `lottery-score-weights-v2` files no longer name it. Anything else stops the task. Run `make -n refit update` (prints only): no sync line.
- [ ] **Step 5:** Run both tests, then `npm run review`. Expected: green.
- [ ] **Step 6:** Commit `feat(db): Add the versioned lottery weights store with active and Take-It pointers`. Push (P1), once phase 2's Task 1 is on origin/main.

### Task 4: Weights loader

**Skills:** `backend-development`, `test-master`, `monitoring-expert`.

**Files:**
- Create: `api/_lib/lottery-weights-loader.ts`, `api/__tests__/lottery-weights-loader.test.ts`

**Interfaces:**
- Consumes: `getDb`, `withDbRetry`, `isRetryableDbError` (`api/_lib/db.ts`); `LotteryWeightsSchema`; the seed (Task 2).
- Produces:
  ```ts
  export interface VersionedWeights { version: string; weights: LotteryWeights }
  export interface WeightsFallback { reason: string; kind: 'transient' | 'error' }
  export interface LoadedLotteryWeights { active: VersionedWeights; takeit: VersionedWeights; fallback: WeightsFallback | null }
  export async function loadLotteryWeights(): Promise<LoadedLotteryWeights>   // never throws
  ```
- **Query:** `SELECT p.name, v.version, v.weights FROM lottery_score_pointers p JOIN lottery_score_versions v ON v.version = p.version WHERE p.name IN ('active','takeit')`, inside `withDbRetry(…, 1, 5_000)`.
- **Cache (R1):**
  - one module-level entry `{ value, loadedAt }`;
  - `WEIGHTS_CACHE_TTL_MS = 60_000`, a staleness knob, commented: a promotion reaches the crons within a minute;
  - one in-flight promise, dropped on settle.
- **Failure:**
  - **transient error, with a value cached:** return the cached value, `fallback: null`, and `logger.warn`;
  - **transient error, nothing cached:** both slots get the seed, `kind: 'transient'`;
  - **a row that fails Zod, or a missing pointer:** both get the seed, `kind: 'error'`.

  Every seed fallback sends one D9 Sentry error per cache period, and the fallback result is itself cached for the TTL.

- [ ] **Step 1: Write the failing tests** (mock `../_lib/db.js` at the module boundary; `vi.useFakeTimers()`; `vi.resetModules()` + dynamic import per test for a fresh cache):
  - `loads both pointers and validates them`;
  - `caches for 60 s, then reloads`;
  - `concurrent callers share one query`;
  - `serves the cached version on a transient error`;
  - `falls back to the seed with an error when nothing is cached` (kind `transient`; one `captureMessage` at level `error` with the D9 fingerprint);
  - `an invalid weights row falls back to the seed, kind error`;
  - `a missing takeit pointer falls back to the seed, kind error`;
  - `a rejected load is not cached` (the next call queries again).
- [ ] **Step 2:** Run `npx vitest run api/__tests__/lottery-weights-loader.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test, then `npm run review`. Expected: green.
- [ ] **Step 5:** Commit `feat(lottery): Load the active and Take-It weights versions with a seed fallback`. Hold (P2).

### Task 5: detect-lottery-fires scores twice

**Skills:** `backend-development`, `test-master`.

**Files:**
- Modify: `api/cron/detect-lottery-fires.ts`, `api/__tests__/detect-lottery-fires.test.ts`, `api/_lib/lottery-tier.ts`, `api/__tests__/lottery-tier.test.ts`, `api/_lib/lottery-score-weights-v2.ts` (delete the two deprecated wrappers)

**Interfaces:**
- Consumes: `loadLotteryWeights` (Task 4); `scoreLotteryV2`, `isAlignedFire`, `weekdayOf` (Task 2).
- Produces:
  ```ts
  // lottery-tier.ts (tierFromQualityScore + TIER_CUTOFFS_V2 stay until Task 6, delegating to the seed's feed_cutoffs)
  export function tierFromQas(qas: number | null, cutoffs: FeedTierCutoffs): LotteryScoreTier
  export function resolveMinQas(minTier: 'tier1' | 'tier2' | undefined, minScore: number | undefined, cutoffs: FeedTierCutoffs): number | undefined
  // detect-lottery-fires.ts
  function computeClusterSize(entries, thisTicker, triggerTimeMs, tier1MinScore: number): number   // t1 is now a parameter
  ```
- **Behavior (D8):**
  - one `loadLotteryWeights()` before Pass 1;
  - `isAligned = isAlignedFire(...)` and `dayOfWeek = weekdayOf(rec.date)` replace the inline code;
  - `score = scoreLotteryV2(active.weights, …)`;
  - `takeitScore` = `score` when `takeit.version === active.version`, else `scoreLotteryV2(takeit.weights, …)`;
  - `takeitRow.score = takeitScore`;
  - the INSERT gains `score_version = active.version`;
  - the cluster bonus passes `active.weights.cutoffs.t1`;
  - the tier monitor uses `tierFromQas(qas, active.weights.feed_cutoffs)`;
  - a non-null `fallback` adds `weightsFallback: kind` to `meta` and makes the run `partial`.

- [ ] **Step 1: Write the failing tests.**
  - **Setup.** Replace the `lottery-score-weights-v2.js` override mock with:
    - an override of `scoreLotteryV2`;
    - `vi.mock('../_lib/lottery-weights-loader.js')` returning `{ active: seed, takeit: seed, fallback: null }` by default.
  - **New tests:**
    - `scores the feed with the active version and Take-It with the pinned one`: active = seed with `SNDK += 3`. The INSERT's `score` is 3 above the `score` in `scoreLottery`'s row, and `score_version` = the active version;
    - `scores once when active and pinned are the same version` (a spy counts one call per fire);
    - `a weights fallback marks the run partial and records the seed version`;
    - `the cluster bonus counts tier1 by the active version's t1`;
    - `the tier monitor tiers on the active version's feed cutoffs`;
    - `tierFromQas` and `resolveMinQas` tables in `lottery-tier.test.ts`: boundaries; `null` → tier3; minTier wins; neither given → undefined.
  - The existing `tierFromQualityScore` tests move to `tierFromQas` with the seed cutoffs.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/detect-lottery-fires.test.ts api/__tests__/lottery-tier.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Delete `computeLotteryScoreV2` and `LOTTERY_TIER_THRESHOLDS_V2`. Grep `api/`, `src/` and `scripts/` for both names: no caller remains.
- [ ] **Step 4:** Run the two tests, then `npm run review`. Expected: green.
- [ ] **Step 5:** Commit `feat(lottery): Score fires with the active weights and Take-It with its pinned version`. Hold (P2).

### Task 6: Feed endpoint — `minTier` and the active feed cutoffs

**Skills:** `backend-development`, `zod`, `test-master`.

**Files:**
- Modify: `api/_lib/validation/lottery.ts`, `api/__tests__/validation/lottery.test.ts`, `api/lottery-finder.ts`, `api/__tests__/lottery-finder-endpoint.test.ts`, `api/_lib/lottery-tier.ts` (delete `tierFromQualityScore` and `TIER_CUTOFFS_V2`)

**Interfaces:**
- Consumes: `loadLotteryWeights`, `tierFromQas`, `resolveMinQas` (Tasks 4–5).
- **Validation:**
  - `lotteryFinderQuerySchema`, `lotteryExportQuerySchema` and `lotteryFinderTickerCountsQuerySchema` gain `minTier: z.enum(['tier1','tier2']).optional()`, one shared field;
  - a refine rejects `minTier` together with `minScore` (400, message `minTier and minScore are exclusive`).
- **Feed:**
  - `minQas = resolveMinQas(minTier, minScore, active.weights.feed_cutoffs)` replaces `minScore` in every `qasExprText(...) >= …` gate;
  - tiers come from `tierFromQas(qas, cutoffs)`;
  - `minTier` joins every cache key that `minScore` is in;
  - the response gains `tierCutoffs: { version: string; tier1MinScore: number; tier2MinScore: number }`.

- [ ] **Step 1: Write the failing tests** (mock the loader at its module boundary):
  - `minTier=tier1 gates on the active version's tier1 cutoff` (a version with 16/12 → the SQL binds 16);
  - `minScore still works`;
  - `minTier with minScore is a 400`;
  - `tiers rows with the active version's cutoffs`;
  - `returns tierCutoffs`;
  - `a weights fallback still serves the feed` (seed cutoffs; 200);
  - schema tests for all three schemas.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts api/__tests__/validation/lottery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Grep for `tierFromQualityScore` and `TIER_CUTOFFS_V2` outside `docs/`. After Task 5, every code and test hit is in this task's files: update them. The comments elsewhere have owners: `src/components/LotteryFinder/index.tsx:86-91` and `src/__tests__/LotteryFinderSection.test.tsx:1218-1229` (Task 8), and `scripts/feature_audit.py:34` (phase 3's Task 3b). A code or test hit anywhere else stops the task.
- [ ] **Step 4:** Run the tests, then `npm run review`. Expected: green.
- [ ] **Step 5:** Commit `feat(lottery): Tier the feed on the active weights version and accept minTier`. Hold (P2).

### Task 7: Export and ticker-count endpoints take `minTier`

**Skills:** `backend-development`, `test-master`.

**Files:**
- Modify: `api/lottery-export.ts`, `api/lottery-finder-ticker-counts.ts`, `api/__tests__/lottery-export.test.ts`, `api/__tests__/lottery-finder-ticker-counts.test.ts`

**Interfaces:**
- Consumes: `loadLotteryWeights`, `resolveMinQas`.
- Each handler resolves `minTier` the way the feed does. **Each keeps its own comparison:** the export compares bare `f.score`; the ticker counts compare whatever they do today. Only the number's source changes. (The export's bare-score comparison against a qas cutoff is pre-existing; it is flagged in Spec deltas, not changed.)

- [ ] **Step 1: Write the failing tests:**
  - `export minTier=tier2 binds the active tier2 cutoff`;
  - `ticker counts minTier=tier1 binds the active tier1 cutoff`;
  - for each endpoint, `minTier with minScore is a 400`.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, then `npm run review`. Expected: green.
- [ ] **Step 5:** Commit `feat(lottery): Accept minTier on the lottery export and ticker counts`. Hold (P2).

### Task 8: Lottery Finder sends `minTier`

**Skills:** `react-expert`, `test-master`.

**Files:**
- Modify: `src/components/LotteryFinder/index.tsx`, `src/components/LotteryFinder/types.ts`, `src/__tests__/LotteryFinderSection.test.tsx`

**Interfaces:**
- Consumes: the feed's `tierCutoffs` and the `minTier` param (Tasks 6–7).
- **Changes:**
  - `CONVICTION_TO_MIN_TIER: Record<ConvictionFloor, 'tier1' | 'tier2' | null>` replaces `CONVICTION_TO_MIN_SCORE`;
  - `TIER1_MIN_SCORE` and `TIER2_MIN_SCORE` are deleted, with the comment above them (`index.tsx:86-91`, which names `TIER_CUTOFFS_V2` and `tierFromQualityScore`);
  - the URL builders send `minTier`; the filter signature uses `t${minTier ?? 'x'}` (memory `never-vanish-architecture`: filters go in filterSig);
  - the export link sends `minTier`;
  - the two chip tooltips read `qas ≥ N` from the latest response's `tierCutoffs`, and drop the number while none has arrived;
  - `types.ts` adds `tierCutoffs?` to the response type and `minTier?` to the params type.

- [ ] **Step 1: Write the failing tests:**
  - `Tier 1 chip sends minTier=tier1`;
  - `Tier 2+ chip sends minTier=tier2`;
  - `chip tooltip shows the cutoff from tierCutoffs`;
  - `tooltip omits the number before a response`;
  - `export link carries minTier`.

  Delete the two `minScore=13/10` tests.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test, then `npm run review`. Expected: green.
- [ ] **Step 5:** Commit `feat(lottery-ui): Ask the server for a tier instead of hard-coding its cutoff`. Hold (P2).

### Task 9 (controller): Prod migration, Vercel deploy, first-session check

**Skills:** `postgres-pro`, `vercel-deployment`, `sentry:sentry-create-alert`.

- [ ] **Step 1:** Read `SELECT max(id) FROM schema_migrations`. List the pending ids on main and tell the owner which ones `scripts/migrate-db.ts` will apply. It applies every pending id, so run it only when the pending id is ours alone (#202); if another session's migration is pending, wait for that session to apply it, and don't apply it (phase 2's owner answer 1). Then wait for the owner's yes. In the 16:05–16:35 CT window, run `node --env-file=<repo>/.env.local --import tsx scripts/migrate-db.ts`. Verify:
  - `schema_migrations` has N;
  - both pointers are on `seed-2026-06-17`;
  - the seed row parses (a `tsx` one-liner with `LotteryWeightsSchema`);
  - `score_version` exists.
- [ ] **Step 2:** In a worktree at origin/main, rebase Tasks 4–8 and run `npm run review`. Push after 15:00 CT (Vercel only: Tasks 4–8 touch no Railway watch path). Verify the Vercel deployment is READY.
- [ ] **Step 3: The Vercel alert rule (the owner approves it first).** D9's fallback error reaches nobody without a rule.
  - Tell the owner what the rule does: a message-filter issue alert on the Vercel Sentry project, matching the title `lottery weights fallback to seed`, firing on a first-seen issue and on a regression, with rule 1c's email action. Wait for the owner's yes.
  - Create it the way `sentry-monitoring-2026-05-07.md` Phase 1 does (find by name, PUT if it exists, else POST; the `sentry:sentry-create-alert` skill covers the API).
  - Read it back through the Sentry MCP or `sentry api`: the filter, the action and the project are the ones above. Send no test event into prod Sentry.
- [ ] **Step 4: After the next session (read-only):**
  - `score_version = 'seed-2026-06-17'` on 100 % of that session's fires;
  - `takeit_features->>'score'` = `score` on 100 %;
  - 0 Sentry events `lottery weights fallback to seed`;
  - the session's feed tier1 share is inside 1.6–14.9 %;
  - the rule from Step 3 still reads back unchanged.

  A miss stops the plan for investigation.

### Task 10 (removed 2026-11-06: phase 2's Task 7 deletes the cron's flow-inversion pass)

### Task 11 (removed 2026-11-06: the reset ran on 2026-11-06 outside every plan, with a copy in R2; the tape pass refills the rows)

### Task 12: `ml/src/lottery_weights.py` — validation, version ids, the Python scorer

**Skills:** `pandas-pro`, `test-master`.

**Files:**
- Create: `ml/src/lottery_weights.py`, `ml/tests/test_lottery_weights.py`

**Interfaces:**
- Produces (numpy and pandas only; no `utils`, no scipy; runs on 3.12):
  ```python
  SCHEMA_VERSION = 1
  SEED_VERSION = "seed-2026-06-17"
  SCORE_COLUMNS = ("underlying_symbol", "option_type", "tod", "dte", "trigger_vol_to_oi_window",
                   "gamma_at_trigger", "trigger_ask_pct", "cum_ncp_at_fire", "cum_npp_at_fire", "date")
  class WeightsInvalid(ValueError): ...            # message: dotted path + rule name, never a value
  def validate_weights(w: Mapping[str, Any]) -> None              # D5's table
  def refit_version_id(trained_through: date) -> str               # "refit-YYYY-MM-DD"
  def assign_quintile(value: float | None, bounds: Sequence[float]) -> int | None   # right-closed
  def score_frame(w: Mapping[str, Any], df: pd.DataFrame) -> pd.Series            # Int64; <NA> = gated
  def load_pointer(conn, name: Literal["active", "takeit"]) -> tuple[str, dict]    # SELECT + validate
  ```
- `score_frame` mirrors `scoreLotteryV2`:
  - alignment via `cum_*`;
  - the weekday of `date` (pandas `day_name()`);
  - DTE outside 0–3 → `<NA>`;
  - a composite `"null"` label matches a NULL quintile.

- [ ] **Step 1: Write the failing tests:**
  - `test_score_frame_matches_the_parity_fixture`: read `api/__tests__/fixtures/lottery-score-parity.json` from the repo root; every case equals `expected` (`None` ↔ `<NA>`);
  - `test_assign_quintile_value_on_a_boundary_goes_low` (all 12 seed boundaries);
  - `test_validate_accepts_the_fixture_weights`;
  - `test_validate_rejects` (parametrized): each Task 2 schema case, plus `True` as a weight and a numpy NaN;
  - `test_error_message_names_the_path_not_the_value`;
  - `test_refit_version_id_format`;
  - `test_load_pointer_validates_the_row` (fake cursor; an invalid row raises `WeightsInvalid`);
  - `test_module_imports_without_scipy_or_utils` (a subprocess with `-I`; `scipy` and `utils` not in `sys.modules`).
- [ ] **Step 2:** Run `cd ml && .venv/Scripts/python -m pytest -q tests/test_lottery_weights.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Vectorise with `numpy.searchsorted(bounds, v, side="left")` for right-closed bins.
- [ ] **Step 4:** Run the test and ml's ruff check and format check. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(ml): Add one Python lottery scorer that matches the TS scorer exactly`. Push (P3).

### Task 13: `ml/src/lottery_refit_gates.py` — the gates

**Skills:** `statistical-analysis`, `pandas-pro`.

**Files:**
- Create: `ml/src/lottery_refit_gates.py`, `ml/tests/test_lottery_refit_gates.py`, `ml/tests/test_lottery_refit_gates_scipy.py`

**Interfaces:**
- Consumes: `score_frame`, `validate_weights` (Task 12).
- Produces: the "Gate numbers" constants, plus (the module imports numpy and pandas only, never scipy; the nightly image has no scipy and the step computes its in-sample ρ with `spearman` below):
  ```python
  INVERSION_BONUS = {1: -5, 2: -2, 3: 0, 4: 3, 5: 5}     # mirrors api/_lib/lottery-inversion-bonus.ts
  FEED_COLUMNS = SCORE_COLUMNS + ("round_trip_score_deduct", "fire_count_score_adjustment",
                                  "direction_gated", "inversion_quintile")
  @dataclass(frozen=True) class FeedCutoffs: tier1_min_score: int; tier2_min_score: int
  def spearman(x: pd.Series, y: pd.Series) -> float      # average-rank Pearson on pairwise non-null; nan if < 3 rows or constant
  def feed_qas(scores: pd.Series, feed: pd.DataFrame) -> pd.Series
      # GREATEST(0, score + rt + fc) + bonus; NaN where tier3 is forced (score NA, direction_gated, quintile 1–2)
  def daily_tier_shares(qas: pd.Series, feed: pd.DataFrame, cutoffs: FeedCutoffs) -> pd.DataFrame   # index date; tier1_share, tier12_share
  def match_feed_cutoffs(qas_candidate: pd.Series, qas_active: pd.Series, active: FeedCutoffs) -> FeedCutoffs
  @dataclass(frozen=True) class CreationVerdict: ok: bool; reasons: tuple[str, ...]; train_rows: int; train_sessions: int; tier1_share: float
  def check_creation(weights: Mapping, *, train_rows: int, train_sessions: int, tier1_share: float) -> CreationVerdict
  @dataclass(frozen=True) class ShadowVerdict:
      decision: Literal["wait", "pass", "reject"]; reasons: tuple[str, ...]; sessions: tuple[date, ...]
      eval_rows: int; rho_candidate: float; rho_active: float; tier1_ratio: float; tier12_ratio: float; tier1_share: float
  def decide_shadow(*, eval_frame: pd.DataFrame, feed_frame: pd.DataFrame, candidate: Mapping,
                    active: Mapping, sessions_elapsed: int) -> ShadowVerdict
  ```
- **Reason vocabulary** (fixed phrases): `too_few_train_rows`, `too_few_train_sessions`, `invalid_weights`, `tier1_share_out_of_band`, `shadow_starved`, `too_few_eval_rows`, `rho_undefined`, `rho_below_active`, `tier1_ratio_out_of_band`, `tier12_ratio_out_of_band`.
- **`match_feed_cutoffs`:**
  - the target share = the pooled share of the active's qas ≥ its cutoff (NaN counts below);
  - for c in 0…`FEED_CUTOFF_SEARCH_MAX`, take the c minimising |share(candidate ≥ c) − target|, breaking ties toward the larger c;
  - do this for tier1 and for tier2;
  - if tier2 ≥ tier1, set tier2 = tier1 − 1.
- **Ratios** are the mean daily share of the candidate (its cutoffs) ÷ that of the active (its cutoffs), with 0/0 = 1 and x/0 = inf.
- **`decide_shadow`:**
  - an evaluated session has ≥ `MIN_EVAL_ROWS_PER_SESSION` eval rows that score non-NA;
  - with fewer than `SHADOW_SESSIONS` evaluated: `reject shadow_starved` once `sessions_elapsed >= SHADOW_MAX_SESSIONS`, else `wait`;
  - otherwise evaluate exactly the first `SHADOW_SESSIONS` evaluated sessions, ascending;
  - the reasons list holds every failed check.

- [ ] **Step 1: Write the failing tests:**
  - `test_spearman_known_answers`: a literal table with ties and NaNs, its values computed once with scipy 1.17.1. It needs no scipy, so the nightly CI job (Task 20b) runs it;
  - `test_spearman_nan_on_constant_or_tiny`;
  - `test_feed_qas_forces_tier3_rows`;
  - `test_feed_qas_floors_at_zero_before_the_bonus`;
  - `test_inversion_bonus_matches_the_ts_map`: regex-parse `INVERSION_BONUS_BY_QUINTILE` from `api/_lib/lottery-inversion-bonus.ts`;
  - `test_match_feed_cutoffs_hand_built` (a known answer, the tie rule, and tier2 < tier1);
  - `test_check_creation_each_reason`;
  - `test_decide_waits_under_ten_sessions`;
  - `test_shadow_starved_after_max_sessions`;
  - `test_decide_uses_exactly_the_first_ten_sessions` (an 11th bad session changes nothing);
  - `test_rho_tie_passes` (equal weights → pass);
  - `test_rho_below_active_rejects`;
  - `test_ratio_band_edges` (0.67 and 1.5 pass; 0.66 and 1.51 fail);
  - `test_tier1_share_band`;
  - `test_too_few_eval_rows`;
  - `test_zero_over_zero_ratio_is_one`.

  In `test_lottery_refit_gates_scipy.py`, `test_spearman_matches_scipy`: random data with ties and NaNs against `scipy.stats.spearmanr`. It imports scipy with a plain `import`, not `importorskip`. The `ml` CI job installs scipy from `ml/requirements.txt`, so the test runs there and cannot skip without notice. The nightly CI job does not list this file.
- [ ] **Step 2:** Run `cd ml && .venv/Scripts/python -m pytest -q tests/test_lottery_refit_gates.py tests/test_lottery_refit_gates_scipy.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. The module docstring cites this plan's Facts and the gate table, and names the outcome definition.
- [ ] **Step 4:** Run the test and ml's ruff check and format check. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(ml): Add the lottery refit gates tuned on history`. Push (P3).

### Task 14: `lottery_scoring.py` — one training population, explicit window, pure training

**Skills:** `scikit-learn`, `pandas-pro`, `postgres-pro`.

**Files:**
- Modify: `ml/src/lottery_scoring.py`, `ml/tests/test_lottery_scoring.py`, `ml/tests/test_lottery_refit_guard.py` (delete its two `main` tests, `test_main_skips_training_and_leaves_weights_untouched` and `test_main_runs_training_before_cutoff`; the rest goes in Task 17)
- Modify (text only): `ml/README.md` (the `src/lottery_scoring.py` row: it trains for the nightly `lottery-refit` step, prints a dry run when run by hand, and writes no JSON), `ml/src/score_components.py` (the line-106 docstring stops naming the generator Task 3 deleted)

**Interfaces:**
- Consumes: `score_frame`, `validate_weights` (Task 12).
- Produces:
  ```python
  SINGLE_LEG_FILTER = "anchor_leg_kind = 'single'"              # unchanged
  TRAINING_FILTER_SQL: str        # D7: alignment AND SINGLE_LEG_FILTER AND outcome present (no inversion-source filter)
  TRAINING_COLUMNS: tuple[str, ...]   # SCORE_COLUMNS + outcome columns + "date"
  def fetch_frame(conn, start: date, end: date) -> pd.DataFrame   # date > start AND date <= end; adds outcome_pct; drops bug rows
  def drop_bug_rows(df: pd.DataFrame) -> pd.DataFrame
  def train_weights(df: pd.DataFrame, *, base: Mapping, trained_through: date) -> dict
      # the old main()'s weight computation; composite_bonuses and feed_cutoffs copied from base;
      # cutoffs t1/t2 = round(p95/p85) of score_frame on df; validated before return
  ```
- **Deletions:**
  - `FETCH_QUERY`, `fetch_training_data`, `apply_weights` and their tests (orphans);
  - the output JSON write;
  - the guard import and call.
- **Imports (the image has no scipy and no `utils`):** the module-level `from scipy import stats` (line 66) moves into `main()`, where the dry-run's in-sample Spearman is computed, and `from utils import get_connection` moves there too. The nightly step does not use `stats`: it computes `insample_rho` with `lottery_refit_gates.spearman` (Task 13) on `score_frame(weights, train_df)` against the training outcomes.
- **`main()`:**
  - `--through YYYY-MM-DD` (required);
  - prints a dry-run summary (rows, sessions, weights, in-sample Spearman) and writes nothing.
- **Comment:** the `SINGLE_LEG_FILTER` comment stops naming `scripts/online_ticker_update.py`, which Task 16 deletes.
- **Kept:** `quintile_boundaries`, `assign_quintile`, `compute_*_weights` and the scale constants (Task 1 and the nightly use them).

- [ ] **Step 1: Write the failing tests:**
  - `test_training_filter_sql_is_aligned_single_leg_with_an_outcome` (the text contains the alignment test, `SINGLE_LEG_FILTER` and the outcome-present test, and no `inversion_source`);
  - `test_fetch_frame_binds_an_explicit_window` (fake cursor; params are dates; no `CURRENT_DATE` anywhere in the module);
  - `test_drop_bug_rows`;
  - `test_train_weights_preserves_base_composites_and_feed_cutoffs`;
  - `test_train_weights_output_validates`;
  - `test_cutoffs_use_the_full_scorer`: on a frame with Monday rows and a composite match, `cutoffs == {t1: round(p95), t2: round(p85)}` of `score_frame(result, df)`;
  - `test_main_writes_nothing` (ml/output untouched);
  - `test_import_does_not_load_scipy_or_utils` (a subprocess with `-I` imports the module; `scipy` and `utils` are not in `sys.modules`).

  Keep the existing `compute_*` tests. Delete the `apply_weights` and `FETCH_QUERY` tests.
- [ ] **Step 2:** Run `cd ml && .venv/Scripts/python -m pytest -q tests/test_lottery_scoring.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Grep for `FETCH_QUERY`, `fetch_training_data` and `apply_weights` across `ml/` and `scripts/`.
- [ ] **Step 4:** Run the test, plus `tests/test_lottery_refit_guard.py` (its remaining tests still pass), plus ml's ruff check and format check. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `refactor(ml): Define the refit's training population once and train without side effects`. Push (P3).

### Task 15: `backfill_lottery_scores.py` — snapshot first, right-closed, one transaction

**Skills:** `postgres-pro`, `pandas-pro`.

**Files:**
- Modify: `scripts/backfill_lottery_scores.py`, `scripts/test_backfill_lottery_scores.py`

**Interfaces:**
- Consumes: `score_frame`, `load_pointer`, `SCORE_COLUMNS` (Task 12).
- Produces:
  ```python
  PAGE_ROWS = 50_000
  WRITE_ROWS = 500
  class PointerMoved(RuntimeError): ...
  class ConcurrentScoreWriter(RuntimeError): ...
  class RescoreDeadline(RuntimeError): ...
  @dataclass(frozen=True) class RescoreResult: scanned: int; changed: int; snapshot_rows: int; pointer_moved: bool
  def rescore_all(conn, *, to_version: str, weights: Mapping, reason: str,
                  expect_active: str | None, dry_run: bool,
                  deadline: float | None = None) -> RescoreResult   # deadline: a time.monotonic() value
  ```
- **`rescore_all`:** one transaction (`conn.autocommit = False` in a `try`; `commit` once; `rollback` on any exception and re-raise; autocommit restored in `finally`). In order:
  1. If `expect_active` is set: `SELECT version FROM lottery_score_pointers WHERE name = 'active' FOR UPDATE`; if it differs → `PointerMoved`.
  2. Keyset pages: `WHERE id > %s ORDER BY id LIMIT PAGE_ROWS`. Before each page and before each write batch, `time.monotonic() > deadline` (when a deadline is given) raises `RescoreDeadline`, which rolls the whole transaction back. The nightly step passes `ctx.deadline` (Task 19); the CLI passes none.
  3. Per page, the changed rows = new score distinct from `score`, OR `score_version` distinct from `to_version`. The first promotion therefore rewrites and snapshots every fire (about 1.06 M rows, about 2,130 UPDATE statements of 500), because `score_version` is NULL everywhere. About 31 K of them change value on the boundary and 06-17 → 07-22 rows alone, and the promoted weights change more. Then:
     - one snapshot row (`column_name 'score'`, `to_version`, ids, old scores as float8, old `score_version`s);
     - `execute_values` UPDATEs at `WRITE_ROWS` per statement: `… SET score = v.score, score_version = v.ver FROM (VALUES %s) v(id, score, ver, old) WHERE f.id = v.id AND f.score IS NOT DISTINCT FROM v.old RETURNING f.id`;
     - a returned count below the batch → `ConcurrentScoreWriter`.
  4. If `expect_active` is set:
     - `UPDATE lottery_score_versions SET status = 'promoted', decided_at = now() WHERE version = %s AND status IN ('shadow','passed') RETURNING version`;
     - `UPDATE lottery_score_pointers SET version = %s, updated_at = now() WHERE name = 'active' AND version = %s RETURNING name`.

     Each must return one row, else `PointerMoved`.
  5. `dry_run=True` runs reads only and returns the same counts.
- **CLI:**
  - `--version` (default: the active pointer), `--reason` (default `manual`), `--write`;
  - it is a dry run unless `--write` is given, so the old `make refit` line, which passes no flag, writes nothing;
  - it never moves a pointer;
  - `.env.local` is optional: the CLI loads it with `_cli_paths.load_env_file` (phase 2's Task 2b);
  - the guard call, the old `compute_score_v2` and `assign_quintile` and the JSON path are deleted.

- [ ] **Step 1: Write the failing tests** (fake connection recording statements, commit and rollback; fixture fires that include boundary values):
  - `test_boundary_value_now_lands_low` (the old `<` bug: a fire at `ask_pct = 0.625` gets the right-closed score);
  - `test_snapshot_precedes_each_update_and_holds_old_values`;
  - `test_only_changed_rows_are_written_and_snapshotted`;
  - `test_rescore_counts_come_from_returning`;
  - `test_promotion_moves_status_and_pointer_in_the_same_transaction`;
  - `test_promotion_rolls_back_when_an_update_fails`;
  - `test_promotion_aborts_when_the_active_pointer_moved`;
  - `test_concurrent_score_writer_aborts_the_rescore`;
  - `test_rescore_rolls_back_past_the_deadline` (a monotonic clock patched past `deadline` after the first page: `RescoreDeadline`, one rollback, no commit, no pointer or status UPDATE);
  - `test_first_promotion_rewrites_rows_whose_score_version_is_null` (an unchanged score with a NULL `score_version` is still snapshotted and stamped);
  - `test_never_touches_the_takeit_pointer` (no statement contains `'takeit'`);
  - `test_dry_run_writes_nothing`;
  - `test_cli_without_write_is_a_dry_run`;
  - `test_pages_by_id`.
- [ ] **Step 2:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_backfill_lottery_scores.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test and the isolated ruff on both files. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `fix(lottery): Rescore fires right-closed in one transaction and snapshot every replaced score`. Push (P3).

### Task 16: Retire the ticker EMA (`online_ticker_update.py`) and its history CSV

**Skills:** `test-master`.

**Files:**
- Delete: `scripts/online_ticker_update.py`, `scripts/test_online_ticker_update.py`
- Modify (comments only): `scripts/conftest.py`, `ml/conftest.py`, `scripts/test_no_database_guard.py`

**Why:** the owner retired the nightly ticker EMA and the ticker-weight-history CSV on 2026-11-06. The EMA moved 0 tickers on 115 sessions (Facts). The script's only other user is the guard Task 17 deletes, and `make update`, whose call Task 17 removes. So the whole script goes, with its `TODAY_QUERY`, `write_weights_json` and CSV code.

**What stays:**
- The refit's training sets the ticker weights (Task 14).
- The local `docs/tmp/lottery-ticker-weight-history.csv` is gitignored. It stays on disk as a record (6 rows on 11-05) and nothing writes it.
- `ml/output/lottery_score_weights.json` stays frozen as the seed's source.

- [ ] **Step 1: Grep** for `online_ticker_update`, `upsert_history_csv`, `HISTORY_CSV` and `lottery-ticker-weight-history` in every file type outside `docs/`. Expected: the two files above; `Makefile`, `scripts/README.md` and `ml/src/lottery_refit_guard.py` (Task 17); `ml/src/lottery_scoring.py`'s comment (Task 14); and the three comment sites above. Anything else stops the task.
- [ ] **Step 2:** Before the change, run `ml/.venv/Scripts/python -m pytest -q scripts/test_*.py` from the repo root and note the passed and skipped counts.
- [ ] **Step 3:** Delete the two files. In the three comment sites, stop naming the deleted script:
  - they say `ml/src` joins `sys.path` "from `online_ticker_update`" and that `lottery_scoring` then imports the real `utils`. Say instead that `backfill_lottery_scores` puts `ml/src` on the path, and drop the `lottery_scoring` clause: Task 14 moved its `utils` import into `main`;
  - the guard block in `ml/conftest.py` and in `scripts/conftest.py` must stay identical, or `scripts/test_guard_twins.py` fails.
- [ ] **Step 4:** Run the same command again. Expected: the same counts minus the deleted file's tests, and no new failure or skip. Then run ml's suite and the isolated ruff on the touched `scripts/` files.
- [ ] **Step 5:** Run `npm run review`, then commit `chore(lottery): Retire the ticker-weight EMA and its history CSV`. Hold it and push it with Task 17 (P3).

### Task 17: Retire the guard, the legacy enrich module and the Makefile's refit writes

**Files:**
- Delete: `ml/src/lottery_refit_guard.py`, `ml/tests/test_lottery_refit_guard.py`, `ml/src/enrich_lottery_outcomes.py`
- Modify: `Makefile`, `scripts/README.md`

**Interfaces:**
- **Makefile `refit`:**
  - `$(PYTHON) ml/src/lottery_scoring.py --through $(DATE)`;
  - `$(PYTHON) scripts/backfill_lottery_scores.py` (a dry run without `--write`);
  - a comment: the refit runs in the nightly service (`nightly/README.md`, "Refit"); these are dry runs.
- **Makefile `update`:** loses the EMA block, that is, its comment (V2.2 Phase E.8) and the `scripts/online_ticker_update.py` call (Task 16). The `echo` lines for the weight-history CSV and for the "UNCHANGED while … blocks the refit" weights file go too. The rest of `update` stays.
- `DATE` is the Makefile's existing `DATE ?= $(lastword $(PENDING_DATES))` (line 84).
- **Comments:** the guard comment in `refit` goes.
- **`scripts/README.md`:** the nightly-via-Makefile line stops naming `online_ticker_update.py` and `sync_lottery_score_weights_v2.py` (Task 3 deleted it).
- **The legacy `ml/src/enrich_lottery_outcomes.py` is deleted** (review S17). `scripts/enrich_lottery_outcomes.py` is the live module. The ml copy has no importer: the only `ml/tests` file that names it, `test_lottery_ticker_quality.py`, puts `scripts/` first on `sys.path` and tests the scripts copy. It shadows the scripts module as soon as `ml/src` precedes `scripts/` on the path, and `lottery_scoring.py:70`, `scripts/backfill_lottery_scores.py:42` and `scripts/enrich_silent_boom_outcomes.py:61` all put `ml/src` first. Task 20's collision test is the standing guard against a repeat.

- [ ] **Step 1: Grep for `lottery_refit_guard`, `refit_blocked` and `announce_skip`** in every file type. Expected: only the files above and docs. Grep `enrich_lottery_outcomes` with `ml/src` in the path or import context: expected, only the legacy file's own docstring.
- [ ] **Step 2:** Delete the files and edit the Makefile and the README line. Run `make -n refit update DATE=2026-11-04` (prints only). Expected: every refit command is a dry run, none writes weights, and no line calls `online_ticker_update` or a sync script.
- [ ] **Step 3:** Run `cd ml && .venv/Scripts/python -m pytest -q`, the scripts tests (`ml/.venv/Scripts/python -m pytest -q scripts/test_*.py` from the repo root, as in Task 16 Step 2) and ml's ruff. Expected: PASS, with the counts Task 16 recorded less the deleted tests.
- [ ] **Step 4:** Run `npm run review`, then commit `chore(lottery): Retire the refit guard and the generated weights file path`. Push (P3).

### Task 18: `nightly/src/weights_store.py`

**Skills:** `postgres-pro`.

**Files:**
- Create: `nightly/src/weights_store.py`, `nightly/tests/test_weights_store.py`
- Modify: `nightly/conftest.py` (append `ml/src` **after** `scripts/`, the order the image uses)

**Interfaces:**
- Consumes: `connect_db` (phase 2 D4); `validate_weights` (Task 12, in `ml/src/lottery_weights.py`). This is the first nightly task that imports from `ml/src`, so it puts `ml/src` on the test path. Without that line its tests would pass only by accident: `scripts/enrich_silent_boom_outcomes.py:61` adds the path when `test_enrich_step.py` imports it first.
- Produces:
  ```python
  @dataclass(frozen=True) class StoredVersion:
      version: str; weights: dict; status: str; trained_through: date | None; gate_report: dict
  def load_active(conn) -> StoredVersion
  def load_shadow(conn) -> StoredVersion | None
  def version_exists(conn, version: str) -> bool
  def insert_candidate(conn, version: str, weights: Mapping, *, status: Literal["shadow", "rejected"],
                       trained_through: date, report: Mapping) -> bool     # ON CONFLICT (version) DO NOTHING RETURNING
  def record_session_eval(conn, version: str, session: date, entry: Mapping) -> bool
      # gate_report = jsonb_set(gate_report, ARRAY['sessions', <iso>], entry) WHERE version = %s AND status = 'shadow' RETURNING
  def decide(conn, version: str, status: Literal["passed", "rejected"], verdict: Mapping) -> bool
      # status, decided_at, gate_report || {"verdict": …} WHERE version = %s AND status = 'shadow' RETURNING
  ```
- Every loaded `weights` is validated. JSON goes through `psycopg2.extras.Json`.

- [ ] **Step 1: Write the failing tests** (fake cursor):
  - `test_insert_candidate_is_idempotent` (the second insert returns False);
  - `test_record_session_eval_is_keyed_by_session`;
  - `test_decide_is_conditional_on_shadow`;
  - `test_load_shadow_none`;
  - `test_load_validates_weights`;
  - `test_module_never_writes_pointers` (no SQL text in the module contains `lottery_score_pointers` except in SELECTs).
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_weights_store.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, `ruff check` and `ruff format --check`. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Read and write lottery weights versions`. Hold (P4).

### Task 19: `nightly/src/refit_step.py` and its notices

**Skills:** `monitoring-expert`, `pandas-pro`.

**Files:**
- Create: `nightly/src/refit_step.py`, `nightly/tests/test_refit_step.py`
- Modify: `nightly/src/monitoring.py`, `nightly/tests/test_monitoring.py`, `nightly/src/constants.py`

**Interfaces:**
- Consumes:
  - `Step`, `StepContext`, `StepResult` (D2);
  - `connect_db` (D4);
  - `calendar_nyse.trading_days` and `previous_trading_day`;
  - Tasks 12–15, 18: `lottery_scoring.fetch_frame` and `train_weights`, `lottery_refit_gates.*` (including `spearman`), `backfill_lottery_scores.rescore_all`, `weights_store.*`.
- Produces:
  ```python
  # constants.py: REFIT_BUDGET_SECONDS, PROMOTION_MIN_SECONDS, PROMOTION_CUTOFF_UTC, PROMOTION_ENABLED (values above)
  # refit_step.py
  def fetch_feed_frame(conn, sessions: Sequence[date]) -> pd.DataFrame   # FEED_COLUMNS for those dates (LEFT JOIN lottery_ticker_stats)
  def run(ctx: StepContext) -> StepResult
  # monitoring.py
  RefitNotice = Literal["promoted", "passed", "rejected", "candidate_rejected"]
  def report_refit(kind: RefitNotice, *, version: str, reasons: Sequence[str],
                   extras: Mapping[str, int | float | str | list[str]]) -> None   # D9's table
  ```
- **`run` follows D6.**
  - **With no shadow:** build `refit-<last_session>`, unless it exists (then count `already_built`):
    - train (`fetch_frame` over the 90-day window, then `train_weights`) → `match_feed_cutoffs` over the last 20 trading sessions, stored back as `weights["feed_cutoffs"] = {"tier1_min_score", "tier2_min_score"}`;
    - `check_creation` → `insert_candidate`;
    - the report holds `creation: {verdict, train_window, insample_rho}`. `insample_rho` is `lottery_refit_gates.spearman` of `score_frame(weights, train_df)` against the training outcomes. There is no EMA and no ticker-weight update (owner, 2026-11-06).
  - **With a shadow:**
    - `elapsed = trading_days(trained_through + 1, previous_trading_day(last_session))`: evaluation lags one session (D6);
    - record each elapsed session not yet in `gate_report.sessions`;
    - `decide_shadow`;
    - act per D6. A promotion calls `rescore_all(..., reason="promotion", expect_active=active.version, dry_run=False, deadline=ctx.deadline)`. A `RescoreDeadline` (the rollback is complete) counts as `promotion_deferred`, and the version stays `shadow`.
  - **Counts:** `candidates_built`, `candidates_rejected`, `already_built`, `sessions_recorded`, `waiting`, `passed`, `promoted`, `rejected`, `promotion_deferred`, `rows_rescored`, `train_rows`, `eval_rows`.
  - **Status:** `partial` when a promotion is deferred, else `ok`. A rejection is `ok`, because its notice is the alert (Spec delta 10).
  - **Logs:** one line with the version, the decision and the counts. No weights, no tickers.

- [ ] **Step 1: Write the failing tests** (patch the consumed functions at the `refit_step` module boundary; a frozen `StepContext`):
  - `test_builds_a_shadow_when_none_exists`;
  - `test_thin_window_rejects_at_creation_with_one_notice`;
  - `test_rerun_same_night_is_a_no_op`;
  - `test_creation_report_holds_verdict_window_and_insample_rho` (the `insample_rho` equals `lottery_refit_gates.spearman`, and the report has no `ema_updates` key);
  - `test_feed_cutoffs_are_matched_to_the_active`;
  - `test_records_each_new_session_once`;
  - `test_newest_session_is_not_recorded_until_the_next_session_lands`;
  - `test_waits_under_ten_sessions`;
  - `test_starved_shadow_is_rejected_once`;
  - `test_pass_with_promotion_disabled_marks_passed_and_warns`;
  - `test_pass_promotes_in_one_call_and_warns`;
  - `test_promotion_after_cutoff_is_deferred_partial`;
  - `test_promotion_with_little_time_left_is_deferred`;
  - `test_rescore_deadline_defers_the_promotion` (`rescore_all` patched to raise `RescoreDeadline`: the version stays `shadow`, `promotion_deferred` is 1, the status is `partial`, no notice goes out; the call carries `deadline=ctx.deadline`);
  - `test_reject_after_shadow_errors_with_version_fingerprint`;
  - `test_never_moves_the_takeit_pointer`;
  - `test_logs_carry_no_ticker_or_weight`.

  In `test_monitoring.py`:
  - `test_report_refit_levels_titles_fingerprints` (D9's table);
  - `test_report_refit_tags_service_nightly`.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement. Import the `ml/src` and `scripts/` modules at the top of `refit_step`. The layout test in Task 20 proves they resolve in the image, and `pipeline` imports `refit_step` lazily (Task 21), so an `ImportError` fails this step only.
- [ ] **Step 4:** Run the nightly suite, `ruff check` and `ruff format --check`. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Refit lottery weights in shadow and promote only through the gates`. Hold (P4).

### Task 20: Image layout for the refit files (D1's six places, minus the CI filter)

**Skills:** `python-packaging`.

**Files:**
- Modify: `nightly/Dockerfile`, `.dockerignore`, `nightly/tests/test_image_layout.py`, `nightly/README.md`

**Interfaces:**
- `IMAGE_FILES` gains `ml/src/lottery_weights.py`, `ml/src/lottery_refit_gates.py`, `ml/src/lottery_scoring.py` and `scripts/backfill_lottery_scores.py`. Four files: the EMA script is gone (Task 16), so the image does not carry it.
- **Dockerfile:**
  - copies those files to their image paths;
  - `PYTHONPATH=/app/src:/app/scripts:/app/ml/src`;
  - the comment lists the six places.
- **`.dockerignore`:** `!scripts/backfill_lottery_scores.py` after phase 2's `scripts/*` line (the three-step pattern from `.dockerignore:24-26` that phase 2 already uses). `ml/src/` is not ignored.
- **`conftest.py`:** Task 18 already appended `ml/src` after `scripts/`. The `PYTHONPATH` above uses the same order.
- **`nightly/README.md`:** the four paths join the watch-path list, so phase 2's `test_readme_lists_every_watch_path` passes in this task and not in a later one.
- **This plan owns the `nightly/conftest.py` edit (Task 18), the `PYTHONPATH` entry and the collision test (this task).** Phase 3 adds none of them. It adds only its own files to `IMAGE_FILES` and the layout import.
- **Why the collision test matters:** `lottery_scoring.py:70`, `scripts/backfill_lottery_scores.py:42` and `scripts/enrich_silent_boom_outcomes.py:61` put `ml/src` at `sys.path[0]` when imported, which undoes the image's path order. A module name that exists in two of `nightly/src`, `scripts/` and `ml/src` would then resolve to the wrong one. The legacy `ml/src/enrich_lottery_outcomes.py` was the known case, and Task 17 deleted it.

- [ ] **Step 1: Write the failing tests:**
  - extend `test_dockerfile_copies_exactly_the_image_files` and `test_dockerignore_readmits_image_files`;
  - extend `test_scripts_import_in_the_image_layout`: copy into tmp, `PYTHONPATH` with `tmp/ml/src` last, and `import refit_step, lottery_scoring, backfill_lottery_scores` under the nightly venv (3.12) exits 0. `lazy_step` defers `refit_step`, so this import is where a missing file shows before a run. The venv has no scipy, so the import also proves `lottery_scoring` loads without it;
  - `test_no_image_module_name_collides`: no basename appears twice across `nightly/src`, the copied `scripts/` files and the copied `ml/src` files;
  - `test_readme_lists_every_watch_path` (phase 2's) passes with the four new lines.
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_image_layout.py`. Expected: FAIL.
- [ ] **Step 3:** Make the changes. If Docker is available, run `docker build -f nightly/Dockerfile .`. Otherwise Task 22 verifies the build.
- [ ] **Step 4:** Run the nightly suite. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `build(nightly): Ship the refit modules in the nightly image`. Hold (P4).

### Task 20b: CI path filter and shared-test commands for the refit files

**Skills:** `gha-security-review`.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- **The `nightly` path filter** gains:
  - the four new `IMAGE_FILES`;
  - their tests: `ml/tests/test_lottery_weights.py`, `ml/tests/test_lottery_refit_gates.py`, `ml/tests/test_lottery_scoring.py` and `scripts/test_backfill_lottery_scores.py`;
  - the two files those tests read from `api/`: `api/__tests__/fixtures/lottery-score-parity.json` (Task 12's parity test) and `api/_lib/lottery-inversion-bonus.ts` (Task 13's bonus-map test). Without them an edit to either would skip the job that reads it.
- **Phase 2's two extra nightly steps** (`working-directory: .`) grow: the isolated ruff takes the four new image files, and the shared pytest takes `scripts/test_backfill_lottery_scores.py`.
- **A new step**, with `working-directory: .`, runs `python -m pytest -q -p no:cacheprovider ml/tests/test_lottery_weights.py ml/tests/test_lottery_refit_gates.py ml/tests/test_lottery_scoring.py`. It is separate because ml has its own rootdir and conftest (`[tool.pytest.ini_options]` in `ml/pyproject.toml`); phase 3's Task 7b adds its ml tests to it. It does not take `ml/tests/test_lottery_refit_gates_scipy.py`: the nightly env has no scipy, and the `ml` job runs that file.

- [ ] **Step 1:** Edit the workflow. Check it with `actionlint` if installed, and read the diff for any `${{ }}` expression added.
- [ ] **Step 2:** From the repo root with `nightly/.venv/Scripts/python`, run the three commands exactly as the workflow now spells them. Expected: PASS.
- [ ] **Step 3:** Run `npm run review`, then commit `ci(workflow): Run the refit modules' tests in the nightly job`. Hold (P4).

### Task 21: Register the step and document it

**Skills:** `agents-md`.

**Files:**
- Modify: `nightly/src/pipeline.py`, `nightly/tests/test_pipeline.py`, `nightly/README.md`, `CLAUDE.md`

**Interfaces:**
- `pipeline.STEPS` gains `lazy_step("lottery-refit", "refit_step", REFIT_BUDGET_SECONDS)` **immediately after** `outcome-check` (phase 2's registration helper, D2 import isolation: `pipeline.py` imports no step module at load, so a bad shared file fails this step and not the tape). It trains on tonight's fresh outcomes and comes before phase 3's research steps.
- **This plan owns the pipeline order and reserve test, and its budget assertion, from here on.** Phase 3 extends the same test; it does not write a second one.
- **README:**
  - a "Refit" section: the lifecycle (D6), the gate table, the D9 alert titles, how to read `gate_report`;
  - the snapshot restore SQL, by hand and owner-approved only: `UPDATE lottery_finder_fires f SET score = s.v::int, score_version = s.t FROM (SELECT unnest(fire_ids) id, unnest(old_values) v, unnest(old_tags) t FROM lottery_fire_value_snapshots WHERE id = ANY(<ids>)) s WHERE f.id = s.id`, followed by moving `active` back;
  - the procedure for flipping `PROMOTION_ENABLED`;
  - the first item's tape window for this stage, 10,500–11,400 s (D2's stage table: the run deadline, less the 3,000–3,900 s reserve, less one 3,600 s tape day). Task 22 adds the measured days per night.
- **CLAUDE.md:** the `nightly/` block says it refits the lottery weights into `lottery_score_versions`, and its catch-up line carries the same stage window. The Backend section points at the store and the loader.
- The watch-path list in the README is not edited here: Task 20 added its lines.

- [ ] **Step 1: Write the failing tests** in `nightly/tests/test_pipeline.py` (phase 2's Task 12 created it):
  - `test_pipeline_order_and_reserve`:
    - the `STEPS` names equal `enrich-outcomes`, `outcome-check`, `lottery-refit`, in that order;
    - each step's `min_seconds` is its named constant (`ENRICH_DAY_BUDGET_SECONDS`, `OUTCOME_CHECK_BUDGET_SECONDS`, `REFIT_BUDGET_SECONDS`), imported from `constants`, never a literal;
    - the budget assertion: `reserve_seconds(STEPS)` equals the sum of those three constants, and `PROMOTION_MIN_SECONDS <= REFIT_BUDGET_SECONDS`, so the step's reserve covers a promotion. Nothing is a hard-coded total;
  - extend phase 2's `test_pipeline_imports_no_step_module_at_load`: neither `enrich_step` nor `refit_step` is in `sys.modules` after importing `pipeline`. (Phase 2's Task 13 registered `enrich_step` but was at five files and left the test alone.)

  Phase 2's `test_deadline_constants_bound_the_run` (`reserve_seconds(STEPS) + 2 * DAY_BUDGET_SECONDS <= RUN_DEADLINE_SECONDS`) covers the new reserve with no edit.
- [ ] **Step 2:** Edit. Run the nightly suite, then `npm run review`.
- [ ] **Step 3:** Commit `feat(nightly): Run the lottery refit after the outcome check`. Hold (P4).

### Task 22 (controller): Deploy the nightly step and watch the first runs

**Skills:** `railway:use-railway`, `postgres-pro`, `sentry-cli`.

- [ ] **Step 1:** Task 1 must be complete, and its numbers in the gate table and in `lottery_refit_gates.py`, before this push.
- [ ] **Step 2: Time the first promotion's rescore on prod** (read-only; outside 08:30–15:00 CT and the 16:40–18:40 CT enrich slots).
  - Run `ml/.venv/Scripts/python scripts/backfill_lottery_scores.py` without `--write`. It is a dry run: it reads every fire and writes nothing.
  - It scores with the active (seed) weights, so it shows the least a promotion would do. Record `scanned`, `changed` and the seconds. Expected: about 1.06 M changed (every `score_version` is NULL), about 31 K of them with a different score.
  - Writes cost more than reads. If twice the dry-run seconds exceeds `PROMOTION_MIN_SECONDS` (1,200), raise `PROMOTION_MIN_SECONDS`, keep `REFIT_BUDGET_SECONDS` at or above it (Task 21's test asserts that), correct the README's tape window, and tell the main session so phase 2's budget table row matches. The factor 2 is a guess until the first live promotion. The step deadline turns an overrun into a rolled-back retry, never into a half-written rescore.
  - Write the numbers to `docs/tmp/nightly-phase4-tuning.md`.
- [ ] **Step 3:** In the push window (after 15:00 CT, outside 07:15–12:30 UTC):
  - rebase the worktree on origin/main;
  - rerun the nightly suite, the shared-script tests and `npm run review`;
  - add the four watch paths (`/ml/src/lottery_weights.py`, `/ml/src/lottery_refit_gates.py`, `/ml/src/lottery_scoring.py`, `/scripts/backfill_lottery_scores.py`) to the service's existing list (phase 2's 10). Never replace the list;
  - push.

  Verify the build is `SUCCESS` and shows the four new `COPY`s.
- [ ] **Step 4: First run.**
  - The logs show `step lottery-refit` with `candidates_built 1`, or `candidates_rejected 1` and its reason.
  - A creation rejection appears in Sentry as `nightly refit candidate rejected`, and rule 6262727 fired (check through the Sentry MCP).
  - `lottery_score_versions` has the row; the pointers are unchanged.
  - Add the measured tape days per night (the README's window ÷ seconds per day) to the README's first item, a docs-only commit (the README is not a watch path).
- [ ] **Step 5: Each night,** relay `sessions_recorded` and the running ρ. At the 10th evaluated session, relay the verdict (expected: `passed; promotion disabled`, or `rejected` with its reasons).
- [ ] **Step 6: Update memory:**
  - `project_nightly_automation_goal`: phase 4 live in shadow; D5–D9; the four watch paths; the EMA and the weight-history CSV retired;
  - `project_lottery_tier_systems_and_feed_bug`: the cutoffs now live in the store;
  - a note that the ×100 cron inversion error is repaired (fix 11-05, reset 11-06, cron pass deleted in phase 2) and that phase 4 trains on tape inversions.

### Task 23 (controller) [OWNER GO-AHEAD]: Turn promotion on

- [ ] **Step 1: Preconditions:**
  - a `passed` verdict exists;
  - Task 1's numbers are in the table;
  - **phase 3 is complete**, all its tasks deployed, including its repointing of the research reports to the active weights (Cross-phase dependency 2). The reports then name the active version in their headers (phase 3 D8) and read the version the promotion activates. Promotion does not go ahead on the strength of reports that still read the seed;
  - the owner says "go" on the `passed` notice's numbers.
- [ ] **Step 2:** One-line commit: `PROMOTION_ENABLED = True`. Flip `test_pass_with_promotion_disabled_marks_passed_and_warns` to patch the constant explicitly. Run `npm run review`, then push after 15:00 CT and outside 07:15–12:30 UTC (`constants.py` is under `/nightly/src/**`, a watch path).
  - The **next** shadow that passes promotes. The approved `passed` version stays as a record: a newer shadow already holds the single shadow slot, so it isn't re-opened.
  - The owner approved the method, so the next candidate's notice is the promotion itself.
  - The wait is up to about 11 sessions.
- [ ] **Step 3: Watch the promotion night:**
  - the snapshot rows' id count equals `rows_rescored`;
  - `active` is on the new version and `takeit` on the seed;
  - the next session's fires carry the new `score_version`;
  - its feed tier1 share is inside the band;
  - the `nightly refit promoted` email arrived.

---

## Reconciliation with other sessions' work

- **Classifier retirement (10-29 → 11-05):**
  - `SINGLE_LEG_FILTER` already reads `anchor_leg_kind = 'single'` (`c7871384`), and the tape backfill of the kind is complete. Phase 4 keeps both and plans no new backfill.
  - The guard's condition (a) is met. (b) is Task 1 plus phase 2's backfill. (c) is Task 15 (the boundary rewrite) and Task 16, which retires the EMA script whose evening no-op was the second fix. Task 17 deletes the guard.
- **b0-timings router (11-05, `e6ad8881`, `0514c3c9`):** `detect-lottery-fires.test.ts` routes SQL by text. The loader is mocked at its module boundary, so Task 5 adds no route. `stageMs` may gain a `weightsLoad` stage; it is not required.
- **Phase 2's Tasks 7 and 7b** delete the cron's flow-inversion pass and the `api/_lib/option-intraday.ts` module it used. No `uw_intraday` source exists. This plan has no inversion task, and it references nothing from that module as live code. Phase 2 lands first (build order).
- **The 11-06 inversion reset** ran outside every plan (Facts). Its R2 copy is `backups/lottery-flow-inversion/2026-11-06-x100-reset.parquet`.
- **Take-It one-hot fix (`f3bea903`):** unaffected. The pinned score feeds the same feature.

## Spec deltas

1. **The store is three Neon tables** with two named pointers (`active`, `takeit`), not a Blob manifest (D5).
2. **Each version carries two cutoff sets:**
   - the bare-score `cutoffs` (the cluster bonus);
   - the feed's qas `feed_cutoffs` (the tiers the owner trades from).

   The feed cutoffs are quantile-matched to the active's tier shares over the trailing 20 sessions (owner answer 2). **This is a methodology change:** the feed's tier cutoffs stop being the fixed 13/10 and become a per-version value. Over the walk-forward cycles, the held-out tier1 share (candidate ÷ comparator) had a median of 1.76 under fixed cutoffs and 1.13 under matched ones, and matched stayed within 0.73–1.43 in 9 of 10 cycles; both peaked at 4.56 (Facts).
3. **The "later held-out window" is the 10-session shadow itself,** so evaluation and promotion use the same weights. Evaluation lags one session so late tape inversions arrive first (D6).
4. **One candidate at a time.** A refit happens about every 11 sessions instead of nightly. There is no ticker EMA (delta 13).
5. **The training population gets no new filter.** The spec's "measure the old bug's signature on structure rows" found the signature tracked the cron's corrupt inversions (a ×100 error), not spread structure. Phase 2 deleted that pass, the 11-06 reset removed the bad values, and the tape refills them (Facts). D7 keeps only the existing impossible-value drop.
6. **The multi-leg flag backfill phase 2 deferred is already done** (classifier session, 11-04; 1,064,394 of 1,064,396 rows on 11-05). This plan only verifies it.
7. **A promotion rescores every stored fire** (snapshot first, one transaction), and fires carry `score_version`. About 1.06 M rows are rewritten and about 31 K of them change value on the boundary and 06-17 → 07-22 rows alone; the promoted weights change more (owner answer 4). The 8,251 rows of 06-17 → 07-22 were scored correctly with the 06-12 weights then live, so the rescore replaces them and does not correct them. Of the 37,653 fires on a boundary, those stored left-closed are corrected to right-closed.
8. **`PROMOTION_ENABLED` ships `False`.** Until the owner's go-ahead, a passing shadow ends as `passed` with a notice.
9. **The generated TS file, `sync_lottery_score_weights_v2.py` (Task 3) and the refit guard (Task 17) are retired.**
   - `ml/output/lottery_score_weights.json` is frozen as the seed's source and no longer written.
   - `make refit` is a dry run.
   - `backfill_lottery_scores.py` writes only with `--write`.
   - Pre-existing and left alone: the legacy `scripts/sync_lottery_score_weights.py`, which reads the stale `ml/data/` JSON.
   - The bare cutoffs are now computed with the full scorer (Monday override and composites); the old `apply_weights` skipped both.
10. **A rejected refit doesn't fail the step or the run** (exit 0). Its Sentry error notice is the alert, so the cron monitor doesn't page twice.
11. **The client asks for `minTier`** instead of hard-coding 13/10. That affects three endpoints.
    - Noticed, not changed: `api/lottery-export.ts` compares the bare `score` against the qas cutoff the chip sends.
12. **Snapshots are generic** (`lottery_fire_value_snapshots` allows `score` and `realized_flow_inversion_pct`), but only scores use it in this plan. The 11-06 inversion reset kept its copy in R2 instead.
13. **The ticker EMA and the ticker-weight-history CSV are retired** (owner, 2026-11-06). The spec's Goal 4 gets a dated note from the main session. `scripts/online_ticker_update.py` is deleted (Task 16), `make update` loses its EMA step (Task 17), and the nightly refit takes its ticker weights from the training alone.
14. **The legacy `ml/src/enrich_lottery_outcomes.py` is deleted** (Task 17). It had no importer and shadowed `scripts/enrich_lottery_outcomes.py` whenever `ml/src` came first on the path.

## Cross-phase dependencies

1. **Phase 2 (executes first, in full):**
   - D2's `Step`, `StepContext`, `StepResult`, `run_steps`, `pipeline.STEPS` and `lazy_step`, and its budget table;
   - D4's `connect_db`;
   - D1's image layout and six-place rule, and the `.dockerignore` three-step pattern;
   - migration #201's `inversion_source` (Task 1 reads it; D7 no longer filters on it);
   - its enrich step and backfill, and its deletion of the cron's inversion pass;
   - its Task 15 measurement and its "backfill finished" definition.

   Phase 4's migration is #202 and waits for #201 on origin/main (Task 3).
2. **Phase 3 repoints the research reports to the active weights** (owner order, 2026-11-06). It does so before Task 23, with a test, and this plan edits none of them.
   - The scripts that read the frozen `ml/output/lottery_score_weights.json` are `daily_tracker.py`, `feature_audit.py`, `mine_outcome_patterns.py`, `score_lineage_audit.py`, `vix_regime_analysis.py` and `check_lottery_score_sum_invariant.py`. The nightly job runs the first four.
   - The store they read: `lottery_weights.load_pointer(conn, "active")` (Task 12) returns `(version, weights)`, validated. `weights["feed_cutoffs"]` is `{tier1_min_score, tier2_min_score}` (qas) and `weights["cutoffs"]` is `{t1, t2}` (bare score). `lottery_weights.score_frame` scores a frame. The tables are `lottery_score_versions` and `lottery_score_pointers`, and each fire carries `lottery_finder_fires.score_version` (NULL means scored before the store).
   - `feature_audit.py`'s hard-coded 13/10 (lines 39–40) comes from `feed_cutoffs`. `mine_outcome_patterns.py` and `score_lineage_audit.py` (line 87) still filter `inferred_structure IS NULL`, a predicate whose meaning changed when the classifier was retired. Phase 3 replaces it with the shared `SINGLE_LEG_FILTER` or the active definition and says which.
   - Each report's header names the active `version` and `model_version` (phase 3 D8). No report segments by `score_version`: a promotion rescores every fire, so afterwards all fires share one version.
   - The image already carries `ml/src/lottery_weights.py` from Task 20. The four reports run as subprocesses and connect with the child env's `DATABASE_URL` (phase 3 D6); only phase 3's in-process steps use `resources.connect_db`.
3. **The ticker-weight-history CSV is retired** (owner, 2026-11-06), with the EMA. Phase 3 does not seed, move or publish it, and nothing in this plan writes it. The local `docs/tmp/lottery-ticker-weight-history.csv` is gitignored and stays as it is.
4. **Phase 3, step order and the shared edits.** `lottery-refit` sits right after `outcome-check`; phase 3's steps go after it, registered with `lazy_step` or phase 3's `lazy_group_step`.
   - Task 21's `test_pipeline_order_and_reserve` is the one order and reserve test; phase 3 extends it with `research-derive` after `lottery-refit` and its own constants in the sum, including the unchanged `REFIT_BUDGET_SECONDS` (1,800).
   - Task 18 owns the `nightly/conftest.py` edit, and Task 20 the `PYTHONPATH` entry (`/app/ml/src` last) and `test_no_image_module_name_collides`. Phase 3 adds none of them.
   - The Railway watch-path list is added to, never set: phase 2's 10, plus this plan's 4 (Task 22), plus phase 3's own.
5. **The refit guard is deleted here** (Task 17) and is not copied into the image or registered as a step. The nightly job's one refit step is `lottery-refit`.
6. **Phase 3's drift monitor** is unaffected. Take-It's input stays pinned.
7. **A future Take-It retrain** must read the pinned score from `takeit_features->>'score'`, not the rescored `score`.

## Owner answers (2026-11-06)

1. **The cron's flow inversion (a ×100 error).** The cron's inversion pass is deleted in phase 2 (its Task 7), not here. The 111,645 affected values were reset to NULL on 11-06 with a copy in R2, and the tape pass refills them. This plan has no inversion task and D7 has no filter for them.
2. **Feed tier cutoffs per version: quantile-matched** to the active version's tier1/tier2 shares on the trailing 20 sessions, not fixed at 13/10. This is a methodology change, and the text says so (spec delta 2). Over the walk-forward cycles, the held-out tier1 share (candidate ÷ comparator) had a median of 1.76 under fixed cutoffs and 1.13 under matched ones, and matched stayed within 0.73–1.43 in 9 of 10 cycles; both peaked at 4.56 (Facts).
3. **Shadow length: 10 evaluated sessions** (Δρ SD 0.044).
4. **Rescore every stored fire on promotion, with a copy kept first.** The first promotion rewrites about 1.06 M rows, and about 31 K of them change value on the boundary and 06-17 → 07-22 rows alone. The 8,251 rows of 06-17 → 07-22 were scored correctly with the 06-12 weights then live, so the rescore replaces them and does not correct them (spec delta 7).
5. **Spread-leg and stock-tied fires stay out of training.**
6. **The ticker EMA is retired**, and so is the ticker-weight-history CSV. It moved 0 tickers on 115 of 115 sessions. Reversal of this plan's earlier default (keep it). Task 16 deletes the script and Task 17 its Makefile call (spec delta 13).
7. **Promotion go-ahead:** `PROMOTION_ENABLED` flips only after the owner approves the first `passed` notice's numbers, and only with phase 3 complete (Task 23).

Accepted without change, from the cross-phase review: one email per new creation-rejection reason (D9); the nightly downloads each tape day twice, once per enrich and once per research step, because R2 egress is free (phase 2's D2 puts the minutes in its budget table).
