# Nightly pipeline, phase 3: research outputs from the tape — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every research output `make nightly update` produced is rebuilt each night by the `nightly` Railway job from the R2 tape and Neon, and written to private R2 under `research/`. That covers the per-day chains, the rollup and headlines, the whale plots, the tracking CSV, the Take-It drift monitor and the dated reports. The job never commits an output. The row-level files already tracked in git stay (owner, 2026-11-06).

**Architecture:**
- **Eleven steps** are appended to `STEPS` (D2), after phase 2's steps and phase 4's `lottery-refit`. Each is registered lazily (Task 10), so a broken step module fails that step and not the tape.
  - One tape step, `research-derive`, fetches each stale tape day once. It writes three per-day state families to R2: chains, exit-policy rows and flow-inversion timings.
  - A fingerprint manifest (D7) tracks those families, so the nightly work is only new or changed days.
  - Ten report steps read that state plus Neon and publish dated outputs (D5).
- **The report scripts stay the local CLIs.** The job runs six of them, plus the tracker, as isolated subprocesses (D6). Their stdout and stderr go to a private R2 log, never to Railway logs or Sentry. The rollup, the quality sim and the drift monitor run in-process.
- **The image** follows D1's six-place rule. It adds DuckDB and matplotlib, and avoids scikit-learn, scipy and SQLAlchemy.
- **The four Neon reports read the active weights** from phase 4's store, not the frozen JSON (D8, Task 3b).

**Tech Stack:** Python 3.12; DuckDB 1.5; pandas 3; polars 2 in the image and 1.44 in the ml venv; matplotlib 3.10; psycopg2; boto3; pytest and moto; ruff. One small Node module for the pre-push guard, tested with Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md`. This plan covers phase 3, Goals item 4, "Decided → Research outputs", the Anti-goals, the Constraints, Owner answer 1 and "Owner decisions (2026-11-06)". It builds on the phase 2 plan, `docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md`, whose D1–D4 and budget table bind here verbatim, and on phase 4's `docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md` (its store, its `lottery-refit` step and the image edits it owns). It assumes phase 2 has shipped in full and phase 4's Tasks 1–22 are deployed.

**Build order (owner, 2026-11-06):** phase 2 (all tasks) → phase 4 Tasks 1–22 (through the first shadow runs) → this phase (all tasks, built during phase 4's 10-session shadow) → phase 4 Task 23 (promotion, which needs this phase complete). At runtime `pipeline.STEPS` runs the tape, phase 2's `enrich-outcomes` and `outcome-check`, phase 4's `lottery-refit`, then this phase's `research-derive` and report steps.

---

## Facts measured for this plan (read-only, 2026-11-05)

- **R2 (`theta-options-fulltape`):**
  - 212 tape objects, 2026-01-02 → 11-04. That equals `calendar_nyse.trading_days` for the range, so **05-29 is landed** too.
  - 243.6 GB in all; median object 1.09 GB, largest 1.74 GB. Every ETag is multipart.
  - Top-level prefixes are `fulltape/` and `gexbot-eod/`. `research/` is empty.
  - The only lifecycle rule aborts incomplete multipart uploads after 1 day; nothing expires.
- **Local by-day files** (main checkout): 44 files, 04-13 → 06-16, 4.8 MB. 04-27 and 04-28 are absent. 23 of the 44 (04-13 → 05-15) are tracked in git, as are `cumulative-rollup.json` and `cumulative-headlines.txt`.
  - From 04-13 to 11-04 there are 144 tape days, so 100 chains days must be built from the tape: 04-27, 04-28 and 06-17 → 11-04.
- **The tag map works, checked on 2026-06-15:**
  - **Against the existing by-day file:** chains built from the R2 tape with the map give 1,387 of 1,387 identical chains. Across 16 compared columns, one chain differs only in first and last price, from two prints with the same `executed_at`; Task 1 adds a tie-break.
  - **Against Blob `flow/`:** before 16:00 ET the tape gives the same 1,370 chains as the bot-eod rows, with all 9 aggregates identical.
  - **`equity_type`:** ETF (314 of 314) and Index (264 of 264) map from the tags. Common Stock, ADR and Unit become NULL, which the rollup already treats as single-name.
  - **Tag tokens:** there are 16. All 11,643,779 rows carry exactly one side token, and no row carries both `etf` and `index`.
  - The bot-eod CSV carried prints up to 16:56 ET, so building the tape's whole day matches the old by-day files.
- **A bug in the open window** (`analyze.py`):
  - On the Mac, DuckDB's `EXTRACT` ran in the host zone (CT), so `first_minute_utc BETWEEN 810 AND 840` has measured **13:30–14:00 CT** on every run so far.
  - Example, 05-15: 36 chains in the CT session, which is the headline's value, against 58 in a UTC session.
  - The headline labels this window "8:30-9:00 CT".
- **Neon:**
  - `lottery_finder_fires` has 1,064,396 rows. 784,700 are enriched, on 125 days from 01-02 to 11-05; 600,005 have an inversion, on 116 days (counted before the 11-06 reset below).
  - Enriched fires per day: median 5,859, max 15,964.
  - A per-day fingerprint query over every enriched fire takes 0.7 s.
  - Take-It rows in the last 30 days: 65,246 lottery and 1,865 silent boom.
  - The `ml_` rows in `takeit_health_daily` stop at 06-16 (10 dates).
  - Prod migrations stop at 200, and the phase 2 columns are absent, so phase 2 has not run. (Out of date by the build order: phases 2 and 4 are deployed before this phase starts. Task 0 checks.)
- **Local timings** (workstation; ml venv; the legacy 06-15 tape with 5,792 enriched fires):

  | Work | Seconds |
  |---|---|
  | chains build (DuckDB, local file) | 0.3 |
  | exit-policy derive, one day | 17.9 |
  | flow-timing derive, one day (read 1.0, net-flow queries 2.5 for 42 tickers, simulation 10.6) | 14.1 |
  | pull of all enriched fires (784,700 rows, 56 MB) | 6.3 |
  | rollup + headlines, 44 days | 3.1 |
  | whale plots, 14 PNGs, 44 days | 10.7 |
  | `daily_tracker.py` | 18.3 |
  | `feature_audit.py` (then a `UnicodeEncodeError` on `→` under Windows' default codepage; Linux UTF-8 is unaffected) | 26.4 |
  | `score_lineage_audit.py` | 3.7 |
  | `mine_outcome_patterns.py` | 8.9 |
  | drift read + compute + 2 plots | 1.7 |
  | quality sim (writes a 4.0 MB CSV) | 2.0 |

- **Why full nightly re-runs are out:** `exit_policy_search.py` and `flow_inversion_timing.py` re-read every enriched day's tape on every run. After phase 2's backfill that is about 176 days × (1.1 GB fetch + 32 s), roughly 2–3 h a night. Hence D7.
- **Dependencies:**
  - Every script `make update` runs needs only pandas, numpy, psycopg2, polars, DuckDB or matplotlib. The one exception is `takeit_drift_monitor.py`: it imports `sklearn.metrics.roc_auc_score`, plus `utils`, which pulls in scipy and SQLAlchemy.
  - The nightly venv runs polars 2.1.0. `whale_plots.py` has only run under polars 1.44, so Task 7 is its first run under 2.x.

**Added 2026-11-06 (cross-phase review and the inversion reset):**

- **The cron's flow inversions were corrupt (a ×100 error), and 111,645 of them were reset to NULL on 11-06** (fires whose (`option_chain_id`, `date`) has an `ok` row in `option_intraday_nbbo_fetches`; a copy is in R2 `backups/lottery-flow-inversion/2026-11-06-x100-reset.parquet`). Phase 2 deletes the cron's inversion pass, and its tape pass refills those rows. The exit-policy and flow-timing derives read inversions, so this phase starts only after that backfill has finished (Task 16 Step 1).
- **The ticker-weight-history CSV and the ticker EMA are retired** (owner, 2026-11-06; the EMA moved 0 tickers in 115 sessions). This phase seeds, moves and publishes no such CSV.
- **The frozen weights JSON is no longer read by any nightly step.** Phase 4 holds the weights in Neon, and Task 3b points the four Neon reports at the active version.

## Decisions (phase 3; phase 2's D1–D4 and budget table hold verbatim)

### D5 — R2 layout (bucket `R2_BUCKET_FULLTAPE`, prefix `research/`)

`{session}` is `ctx.last_session`. `{day}` is a tape day. A re-run for the same session overwrites that session's keys.

| Key | Holds | Written by | Kind |
|---|---|---|---|
| `research/_state/derive-manifest.json` | family → day → fingerprint (D7) | `research-derive`, seed | state |
| `research/_logs/{session}/{step}.log` | a script's captured stdout and stderr | every subprocess step, quality-sim | diagnostics |
| `research/eod-flow/by-day/{day}-chains.parquet` | per-chain EOD aggregates | `research-derive`; seed (44) | state |
| `research/eod-flow/{session}/cumulative-rollup.json`, `cumulative-headlines.txt` | rollup and headlines | `eod-flow-rollup` | output |
| `research/whale-plots/{session}/*.png` | the 14 charts | `whale-plots` | output |
| `research/exit-policy/derived/{day}.parquet` | per-fire policy values | `research-derive` | state |
| `research/exit-policy/{session}/lottery-exit-policy-search-*.md` | report | `exit-policy-report` | output |
| `research/flow-timing/derived/{day}.parquet` | per-fire inversion timing | `research-derive` | state |
| `research/flow-timing/{session}/flow-inversion-timing-*.md` | report | `flow-timing-report` | output |
| `research/feature-audit/{session}/lottery-feature-audit-*.md` | report | `feature-audit` | output |
| `research/outcome-mining/{session}/lottery-composite-candidates-*.md` | report | `outcome-mining` | output |
| `research/score-lineage/{session}/lottery-score-lineage-*.md` | report | `score-lineage` | output |
| `research/lottery-tracking/state/lottery-tracking.csv`; `research/lottery-tracking/{session}/lottery-tracking.csv` | appended CSV, plus a daily snapshot | `lottery-tracking`; seed | state + snapshot |
| `research/quality-sim/{session}/lottery-quality-sim-{session}.csv` | per-fire tier sim | `quality-sim` | output |
| `research/takeit-drift/{session}/takeit-drift-{session}.md`, `reliability_{feed}_{session}.png` | drift report and plots | `takeit-drift` | output |

The owner browses it in the Cloudflare dashboard: R2 → `theta-options-fulltape` → `research/`.

### D6 — how report steps run

- **Subprocess steps:** `whale-plots`, `exit-policy-report`, `flow-timing-report`, `feature-audit`, `outcome-mining`, `score-lineage` and `lottery-tracking`.
  - They run `[sys.executable, APP_ROOT/<script>, …]` with `cwd=APP_ROOT`.
  - stdout and stderr go to one log file, which is uploaded only to `research/_logs/`. These scripts print whole reports, so nothing of theirs reaches Railway logs or Sentry. Sentry gets the step name, the exit code and an exception class name, taken only from a traceback's last line or from a last line whose class name ends in `Error`, `Exception`, `Exit` or `Interrupt`. A line such as `SPXW: 12 fires` yields no class.
  - The child env carries no R2, UW or Sentry secret. `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are D4's direct DSN. `PGOPTIONS` and `PGCONNECT_TIMEOUT` are built from `DB_STATEMENT_TIMEOUT_MS` and `DB_CONNECT_TIMEOUT_SECONDS` (D4), never from literals.
- **In-process steps:** `research-derive`, `eod-flow-rollup`, `quality-sim` and `takeit-drift`. They call pure functions, use D4's `connect_db`, and redirect any prints to the step log.

### D7 — derived state and the manifest

- **What the fingerprint covers.** A family's day is fresh when its manifest entry equals the target:

  | Family | Target |
  |---|---|
  | chains | `f"{tape_etag}\|v{CHAINS_VERSION}"`, or the literal `"seed"` for the 44 seeded days, which are never rebuilt |
  | exit-policy | `f"{tape_etag}\|v{DERIVE_VERSION}\|{md5}"`, where md5 covers the canonical `id:has_inversion` list of the day's enriched fires |
  | flow-timing | `f"{tape_etag}\|v{DERIVE_VERSION}\|{md5}"`, where md5 covers the ids of the day's fires with an inversion |

- **Why that is enough.** An inversion value only goes from NULL to set, once (phase 2's conditional writes). The one exception, the 11-06 reset of 111,645 values to NULL, ran outside the plans and is refilled by phase 2's backfill before this phase's first run, so no manifest entry predates the refill. The fire fields the derive reads (chain, entry time and price, trigger time, type) are immutable.
- **Writes.** The objects are written first and the manifest afterwards, once per day. A killed run therefore loses at most the day in flight.
- **The stored fingerprint** is computed from the rows actually derived.
- **A malformed manifest** fails the step. It is never reset silently.

### D8 — the Neon reports read the active weights (review S9)

- **The four reports** (`feature_audit`, `daily_tracker`, `mine_outcome_patterns`, `score_lineage_audit`) call `lottery_weights.load_pointer(conn, "active")` (phase 4 Task 12) instead of reading `ml/output/lottery_score_weights.json`. The weights object has the same `features` and `cutoffs` shape the JSON had, so `score_components` is unchanged.
- **Cutoffs:** `feature_audit`'s T1/T2 split uses `weights["feed_cutoffs"]` (qas), replacing its hard-coded 13/10. `daily_tracker` uses the bare `weights["cutoffs"]` (`t1`, `t2`) on the stored `score`.
- **Population:** mining and lineage select `lottery_scoring.SINGLE_LEG_FILTER` in place of `inferred_structure IS NULL`. That is the filter phase 4 trains on (its D7), and the old predicate changed meaning when the classifier was retired. It is a methodology change to those two reports' populations (spec delta 11).
- **Segmentation:** each report's header names the active `version` and `model_version`, so cross-snapshot comparisons segment by it (memory `feature-audit-regime-segmentation`). The tracking CSV's header is unchanged.
- **Failure:** a failed read (`WeightsInvalid`, no `active` pointer, a DB error) ends the script non-zero. There is no fallback to the frozen JSON (R4). The step reports `script exited N (cls)`.
- **Not repointed:** `vix_regime_analysis.py` and `check_lottery_score_sum_invariant.py` also read the frozen JSON. They are local tools, not nightly steps, and the JSON stays frozen as the seed's source (phase 4), so they keep working.
- **Why now:** phase 4 Task 23 does not promote until this is deployed. Before the first promotion the active version is the seed, so only the mining and lineage population changes the reports' numbers.

---

## Global Constraints

- **Phase 1's and phase 2's Global Constraints still hold.** That includes D1 (the image rule), D2 (the step contract), D3 (the reader) and D4 (DB access); Python 3.12; nightly ruff `>=0.17,<0.18` at line length 100; and constants rather than env vars (R7). **Phase 3 adds no env var.**
- **Anti-goals, verbatim from the spec:**
  - "UW data shows up anywhere public: logs, a public Blob, a public endpoint, or the repo. Status lines with counts and dates are fine; rows of market data are not."
  - "A step reports success after writing nothing (rule R4)."
  - "Historical data is overwritten with no copy kept."
- **Constraints, verbatim from the spec:**
  - "Compute every session window in `America/New_York`."
  - "R2 and Blob stay private."
  - "The disk is wiped every run, so all state between runs lives in private storage, never on local disk."
- **R2 scope.** This pipeline lists and writes only `fulltape/` (tape) and `research/` (D5). It never touches `gexbot-eod/`. `ResearchStore` refuses any key outside `research/`.
- **Step results** carry int counts ≥ 0 and fixed `detail` phrases. A class name or an exit code may appear in a detail; a ticker, strike or price never may.
- **At most 5 edited files per task** (owner rule).
- **Commit gate:** every task ends with its Python suite and ruff, then `npm run review`, then the commit (`.githooks/pre-commit`).
- **Python environments:**
  - **`scripts/` tests:** `ml/.venv/Scripts/python -m pytest -q scripts/<file>`. Ruff on them: `python -m ruff check --isolated --select E4,E7,E9,F <files>`. Never `ruff format` them.
  - **`ml/` tests:** `cd ml && .venv/Scripts/python -m pytest -q tests/<file>`, plus `ruff check` and `ruff format --check` under ml's config. Do not undo the 11-04 ml formatting (`b7a8a976`).
  - **nightly:** `cd nightly && .venv/Scripts/python -m pytest -q`, then `ruff check src tests conftest.py` and `ruff format --check src tests conftest.py`. After Task 7b the shared `scripts/` and `ml/` tests also run in that venv (CI does).
- **No test reaches Neon or R2.** `scripts/conftest.py`, `ml/conftest.py` and `nightly/conftest.py` block it; the tests-no-db branch extends the `scripts/` and `ml/` blocks to every botocore call.
  - R2 tests use moto. A `scripts/` test that needs moto follows whatever override pattern the guard's docstring names.
  - The DB is faked at the module boundary (R3).
- **Prerequisites:** phase 2 is executed in full and phase 4's Tasks 1–22 are deployed (the build order above). Task 0 Step 1 checks both. Task 16 Step 1 also waits for phase 2's backfill to finish.
- **Push and deploy order.** The push window for every push that touches a Railway watch path is **after 15:00 CT and outside 07:15–12:30 UTC** (phase 2's D1). None of this phase's `scripts/` or `ml/src` files is on the service's list until Task 16 Step 2 adds it.
  - **P1:** Tasks 1, 3, 3b, 4 and 5 are pushed as each passes. Railway does not watch those paths yet and Vercel ignores `scripts/` and `ml/`. Task 5's Makefile edit triggers one harmless Vercel build.
  - **P2:** Task 2 is pushed as it passes. It touches no watch path: `load_env_file` comes from phase 2 (Task 2b), so this phase edits neither `_cli_paths.py` nor its test.
  - **P3:** Tasks 6–12, including 7b, stay in the worktree until Task 16.
  - **P4:** Task 13 (seed) runs from the worktree after Tasks 6 and 11 are committed.
  - **P5:** (removed 2026-11-06: Task 14 was removed.)
  - **P6:** Task 15 is pushed on its own. Commit it on a branch off origin/main (or cherry-pick it there) and push from that branch: a push from the worktree branch would carry Tasks 6–12 with it and redeploy the research steps before Task 16. Or hold it and push it with Task 16.
  - **P7:** Task 16 pushes Tasks 6–12 in the push window, after the Railway watch paths are updated and after phase 2's backfill has finished.

## Review Focus

1. **A tape day's layout varies:**
   - legacy days: 42 columns, possibly decimal128 numerics, a tz-naive `executed_at`, or a text `canceled` (`'f'`/`'t'`);
   - new days: 52 columns.

   Chains and derived rows must come out with one pinned schema and agree across layouts. Otherwise `whale_plots.load_data`'s strict `pl.concat` crashes on the mix of seeded and tape-built days. Pinned by:
   - `test_build_chains_layouts_agree_and_match_the_pinned_schema` (Task 1);
   - `test_derive_day_layouts_agree` (Task 2);
   - `test_whale_plots_reads_seeded_and_tape_built_days` (Task 4).
2. **The DST change (EDT → EST on 11-01) and the host time zone.** A 09:35 ET first print counts in the open window on both sides of 11-01, a 08:35 EST one doesn't, and no result depends on DuckDB's session zone. Pinned by:
   - `test_open_window_counts_0930_et_on_both_sides_of_dst`;
   - `test_results_do_not_depend_on_the_host_timezone`;
   - `test_headline_first_time_is_ct` (Task 1).
3. **The derive work set must shrink to zero:**
   - a day that derives 0 rows is recorded;
   - a day whose fires changed is re-derived once;
   - seeded chains are never rebuilt;
   - a run that dies mid-way loses at most one day.

   Pinned by:
   - `test_empty_derive_is_recorded_and_not_redone`;
   - `test_fingerprint_change_rederives_only_that_family`;
   - `test_seeded_chains_are_never_rebuilt`;
   - `test_manifest_survives_a_failure_mid_run` (Task 8).
4. **Honest status:**
   - a script that exits 0 having written nothing fails (`exit_policy_search.py`'s "no archive day" path does this today);
   - missing tracking state fails, and the state CSV never shrinks;
   - a rollup that lacks the last session is `partial`.

   Pinned by:
   - `test_exit_zero_without_output_is_failed`;
   - `test_rollup_partial_when_latest_session_missing` (Task 9);
   - `test_tracking_state_missing_fails_and_writes_nothing`;
   - `test_tracking_csv_never_shrinks` (Task 10).
5. **No market data in Railway logs or Sentry.** A script that prints a report, or raises with a ticker in its message, leaves only an exit code and a class name outside R2, and its child env carries no store secrets. Pinned by:
   - `test_nonzero_exit_names_the_class_only`;
   - `test_script_output_never_reaches_the_log`;
   - `test_script_env_carries_no_store_or_uw_secrets` (Task 9);
   - `test_scrub_redacts_duckdb_messages` (Task 9).
6. **A report that describes weights no longer live.** After a promotion the four Neon reports must use the promoted version, and a failed read must fail the report rather than fall back to the frozen seed JSON. Pinned by:
   - `test_feature_audit_splits_tiers_with_the_active_feed_cutoffs`;
   - `test_invalid_active_weights_fail_the_report_without_a_fallback`;
   - `test_no_report_reads_the_frozen_weights_json` (Task 3b).
7. **One broken step module must not stop the tape.** No step module is imported at load, and the drift monitor raises `ImportError`, not `SystemExit`, when a dependency is missing. Pinned by:
   - `test_pipeline_imports_no_step_module_at_load` (phase 2's, extended in Task 10);
   - `test_missing_dependency_raises_import_error_not_systemexit` (Task 4).

---

### Task 0: Preconditions and live numbers (controller; read-only)

**Skills:** `railway:use-railway`, `r2-storage`, `postgres-pro`.

- [ ] **Step 1:** Confirm that phase 2 is on origin/main as planned, and that phase 4's Tasks 1–22 are too:
  - `scripts/_tape_reader.py` exports D3's names;
  - `scripts/_cli_paths.load_env_file` exists (phase 2 Task 2b);
  - `nightly/src/steps.py`, `pipeline.py` (with `lazy_step` and `STEPS` names `enrich-outcomes`, `outcome-check` and `lottery-refit`) and `resources.py` (`connect_db`, `open_reader`, `direct_dsn`) exist, and `nightly/tests/test_pipeline.py` holds `test_pipeline_order_and_reserve` (phase 4 Task 21);
  - `enrich_lottery_outcomes.refit_ticker_inversion_stats(conn, sim_csv_path=None)` has no write path;
  - `nightly/tests/test_image_layout.py` defines `IMAGE_FILES`, with phase 4's four files in it;
  - `nightly/conftest.py` puts `ml/src` after `scripts/`, the Dockerfile `PYTHONPATH` ends in `/app/ml/src`, and `test_no_image_module_name_collides` exists (phase 4 Tasks 18 and 20);
  - `ml/src/lottery_weights.py` exports `load_pointer` and `ml/src/lottery_scoring.py` exports `SINGLE_LEG_FILTER` and imports without scipy;
  - on prod, `lottery_score_pointers` has an `active` row (read-only query, counts only);
  - `scripts/online_ticker_update.py` is gone (phase 4 Task 16).

  If any name differs, fix this plan's Interfaces first.
- [ ] **Step 2:** From the last three nights' `nightly` logs, record:
  - the `enrich-outcomes` `days_left`;
  - the per-day fetch seconds and bytes.

  `RESEARCH_DAY_BUDGET_SECONDS` (Task 8) stays 900, D2's table row. A fetch stops at `FETCH_DEADLINE_SECONDS` (600), so the slowest fetch plus 300 s cannot exceed 900. If a measured fetch needs more than 600 s, stop and tell the main session: D2's row changes first. Task 16 Step 1 does not start until phase 2's backfill has finished.
- [ ] **Step 3:** List R2: `research/` is empty, and the `fulltape/` day count is recorded. Count enriched days and fires in Neon. Write all of it to `docs/tmp/nightly-phase3-probe.md` (local only).

### Task 1: Chains from the tape (`scripts/_eod_flow.py`) and the analyze CLI

**Skills:** `pandas-pro`.

**Files:**
- Create: `scripts/_eod_flow.py`, `scripts/test_eod_flow.py`
- Modify: `scripts/eod-flow-analysis/analyze.py` (becomes the CLI over `_eod_flow`)

**Interfaces:**
- Consumes: `_tape_reader.TapeReader` (D3), used only by analyze's `--r2`.
- Produces (`_eod_flow`; the watchlist and filter constants move here unchanged):

  ```python
  SIDE_TAGS: Mapping[str, str] = {"ask_side": "ask", "bid_side": "bid", "mid_side": "mid"}
  NO_SIDE = "no_side"
  EQUITY_TYPE_TAGS: tuple[tuple[str, str], ...] = (("index", "Index"), ("etf", "ETF"))  # first match wins; else NULL
  CHAINS_COLUMNS: tuple[tuple[str, str], ...]   # the legacy 22 columns, in order, with DuckDB types (below)
  CHAINS_VERSION = 1
  CHAINS_START = date(2026, 4, 13)
  OPEN_WINDOW_ET_MINUTES = (570, 600)           # 09:30-10:00 ET inclusive = the old 810-840 intent
  REQUIRED_TAPE_COLUMNS: frozenset[str]          # id, underlying_symbol, executed_at, price, option_chain_id, tags,
                                                 # expiry, option_type, open_interest, strike, premium, volume,
                                                 # underlying_price, size, canceled
  class ChainsBuildError(Exception): ...         # names columns and counts only
  def connect(temp_dir: Path | None = None) -> duckdb.DuckDBPyConnection
                                                 # SET TimeZone='UTC'; threads 4 (the Dockerfile's POLARS_MAX_THREADS);
                                                 # memory_limit '4GB'; temp_directory = temp_dir when given
  def build_chains(tape_path: Path, day: date, out_path: Path, temp_dir: Path | None = None) -> int   # chain rows written
  def rollup(by_day_dir: Path) -> dict
  def write_headlines(rollup: dict) -> str
  ```

- `CHAINS_COLUMNS` copies `2026-06-15-chains.parquet` exactly:

  | Columns | Type |
  |---|---|
  | `trade_date` | VARCHAR |
  | `option_chain_id`, `ticker`, `underlying_symbol` | VARCHAR |
  | `strike` | DOUBLE |
  | `option_type` | VARCHAR |
  | `expiry` | DATE |
  | `equity_type`, `sector` | VARCHAR |
  | `total_size`, `total_premium` | DOUBLE |
  | `day_volume`, `day_oi` | BIGINT |
  | `ask_size`, `bid_size` | DOUBLE |
  | `first_ts`, `last_ts` | TIMESTAMPTZ |
  | `first_price`, `last_price`, `first_underlying`, `last_underlying` | DOUBLE |
  | `trade_count` | BIGINT |

**Rules for `build_chains`:**
- **Tag parse:** `string_split(trim(coalesce(tags, ''), '{}'), ',')`.
- **Side:** from `SIDE_TAGS`, else `no_side`.
- **`equity_type`:** from `EQUITY_TYPE_TAGS`.
- **`sector`:** `NULL::VARCHAR`.
- **Kept rows:**
  - `lower(CAST(canceled AS VARCHAR)) IN ('false', 'f', '0')`;
  - `open_interest > 0`;
  - `CAST(volume AS DOUBLE) / open_interest >= 5.0`;
  - `CAST(premium AS DOUBLE) >= 100000`;
  - no time cutoff (owner, 10-28).
- **Timestamps:** `CAST(executed_at AS TIMESTAMPTZ)`. A naive value is UTC under the UTC session.
- **Order:** `FIRST`/`LAST(... ORDER BY ts, id)` for the four first/last columns.
- **Ticker:** the SPXW and NDXP prefix override is kept.
- **Output:** every column is cast to `CHAINS_COLUMNS`, in order. DuckDB `COPY` writes `<out>.tmp`, which is then `os.replace`d. A required column missing from the tape raises `ChainsBuildError` and leaves no file.
- **Resources (review N10):** `connect` pins DuckDB's threads to 4, as the Dockerfile pins polars, and its memory to 4 GB, so a 1.7 GB day object can't take the container's memory. In the image the working directory `/app` is not writable, so the nightly passes `RESEARCH_WORK_DIR` as `temp_dir` and DuckDB spills there instead of failing.

**Rules for `rollup` and `write_headlines`:**
- The session runs in UTC. `read_parquet(glob, union_by_name=true)`.
- `first_minute_utc` becomes `first_minute_et`, from `timezone('America/New_York', first_ts)`. The window is `BETWEEN 570 AND 600`.
- The heading becomes `## 9:30-10:00 ET (8:30-9:00 CT) open-auction window directional flow %`.
- The winners' and losers' time column becomes `First CT`, formatted from `first_ts.astimezone(ZoneInfo("America/Chicago"))`.

**analyze.py CLI:**
- `--day YYYY-MM-DD`; a source `--tape-dir DIR | --r2`, required for day processing; `--by-day-dir` (default `output/by-day`); `--out-dir` (default `output/`); and `--rollup-only`, `--no-rollup`, `--force`.
- Without `--day`, it builds every source day from `CHAINS_START` on that lacks a by-day file.
- The bot-eod CSV source (`CSV_DIR`) is removed.
- It keeps printing the headlines; it is a local tool.

- [ ] **Step 1: Write the failing tests** in `scripts/test_eod_flow.py`. Fixture tapes are written with pyarrow in `tmp_path`.
  - `test_side_and_equity_type_come_from_tags`:
    - tags `{ask_side,bullish,etf}`, `{bid_side,index}`, `{mid_side}`, `{no_side,bearish}` and `{}`;
    - ask and bid sizes sum only their side;
    - `equity_type` comes out ETF, Index, then NULL.
  - `test_build_chains_layouts_agree_and_match_the_pinned_schema`:
    - the same prints written as the new layout (Float64, Boolean `canceled`, tz-aware `executed_at`, extra Utf8 `trading_hours` and `exchange_id`) and as the legacy layout (`decimal128(18,4)` for price, premium, strike and underlying_price; naive `executed_at`; text `canceled`);
    - the two give identical rows;
    - `pq.read_schema(out)` names and types equal `CHAINS_COLUMNS` (string, string, string, string, double, string, date32, string, string, double, double, int64, int64, double, double, timestamp[us, tz=UTC] ×2, double ×4, int64).
  - `test_filters_match_the_bot_eod_rules`:
    - dropped: a canceled print, OI 0, vol/OI 4.99 and premium 99,999.99;
    - kept: vol/OI 5.0, premium 100,000, and a print at 16:30 ET.
  - `test_first_and_last_price_break_ties_by_id`: two prints share `executed_at`; `first_price` comes from the smaller id and `last_price` from the larger, and the same on a second build.
  - `test_spxw_ndxp_ticker_override`.
  - `test_missing_required_column_fails_by_name`: no `tags` → the error names `tags`, and neither the output nor a `.tmp` exists.
  - `test_open_window_counts_0930_et_on_both_sides_of_dst`:
    - by-day fixtures with ask-dominant chains at `2026-10-30T13:35Z` (09:35 EDT) and `2026-11-03T14:35Z` (09:35 EST) are counted;
    - `2026-11-03T13:35Z` (08:35 EST) and `2026-11-03T15:01Z` (10:01 EST) are not;
    - `first_30min_directional` comes out `[1, 1]`.
  - `test_results_do_not_depend_on_the_host_timezone`:
    - `connect()` reports `current_setting('TimeZone') == 'UTC'`, `threads` 4 and a `memory_limit` of 4 GB, and `connect(tmp_path)` reports `temp_directory` as `tmp_path`;
    - the window query gives the same counts on a connection set to `America/Chicago`.
  - `test_headline_first_time_is_ct`: a winner at `2026-11-03T14:35Z` renders `08:35`, and the heading text matches the rule above.
  - `test_rollup_reads_mixed_seed_and_tape_days`: one seeded-style file (`equity_type 'Common Stock'`, `sector 'Tech'`) and one tape-built file give `len(days) == 2`, and `single_names` holds both kinds.
  - `test_analyze_cli_requires_a_source_for_day_processing`: `--day` with neither source → exit 2 naming both; `--rollup-only` needs none.
  - `test_analyze_cli_builds_a_day_from_a_tape_dir`: the by-day file, the rollup JSON and the headlines all land under the given dirs.
- [ ] **Step 2:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_eod_flow.py`. Expected: FAIL (no module).
- [ ] **Step 3:** Implement. `analyze.py` inserts `Path(__file__).resolve().parent.parent` (`scripts/`) on `sys.path`, imports `_eod_flow`, and imports `_tape_reader` inside `main` only.
- [ ] **Step 4:** Run the tests, plus the isolated ruff on the three files. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(eod-flow): Build per-day chains from the tape with tag-mapped side and ET windows`, and push (P1).

### Task 2: Per-day derive for the exit-policy and flow-inversion reports

**Skills:** `pandas-pro`, `postgres-pro`.

**Files:**
- Modify: `scripts/exit_policy_search.py`, `scripts/flow_inversion_timing.py`, `scripts/test_bot_eod_parquet_dir.py` (the source-group message)
- Create: `scripts/test_policy_timing_derive.py`

**Interfaces:**
- Consumes: `_cli_paths.load_env_file(path: Path) -> None` from phase 2 (Task 2b): the env file is optional and never overrides. This task edits neither `_cli_paths.py` nor its test, so it touches no watch path.
- Produces, in **each** script:

  ```python
  DERIVE_VERSION = 1
  DERIVED_COLUMNS: tuple[str, ...]
  FIRES_SQL: str                                     # main's existing SELECT, unchanged
  def fires_for_day(conn, day: date) -> pd.DataFrame # FIRES_SQL + AND date = %s
  def fingerprint_rows(fires: pd.DataFrame) -> str   # md5 hex of the canonical text below
  DAY_FINGERPRINT_SQL: str
  def day_fingerprints(conn) -> dict[date, str]
  def load_derived(derived_dir: Path, days: Iterable[str]) -> tuple[pd.DataFrame, list[str]]   # rows, days without a file
  ```

  | | exit-policy | flow-timing |
  |---|---|---|
  | `DERIVED_COLUMNS` | `id`, `at_15m`, `at_30m`, `at_45m`, `at_60m`, `at_90m`, `at_120m`, `at_180m`, `trail_25_10`, `trail_50_15`, `trail_75_25`, `cap25_floor10`, `flow_inv_or_trail50_15` | `id`, `minutes_to_inversion`, `realized_pct` |
  | `derive_day` | `derive_day(tape_path: Path, fires_for_date) -> pd.DataFrame` | `derive_day(conn, day: date, tape_path: Path, fires_for_date) -> pd.DataFrame` |
  | Canonical text | `",".join(f"{id}:{int(flow_inv is not null)}")`, ascending numeric id | `",".join(str(id))`, ascending numeric id |
  | SQL | `md5(string_agg(id::text \|\| ':' \|\| (realized_flow_inversion_pct IS NOT NULL)::int::text, ',' ORDER BY id))` over `peak_ceiling_pct IS NOT NULL`, `GROUP BY date` | `md5(string_agg(id::text, ',' ORDER BY id))` over `realized_flow_inversion_pct IS NOT NULL`, `GROUP BY date` |

**Rules:**
- `derive_day` is the current per-day body (`process_date`, and the timing loop body) without the file lookup. The numbers don't change.
  - It returns `DERIVED_COLUMNS` exactly: `id` int64, the rest float64, possibly 0 rows.
  - Timing rows keep only `status == 'inversion'`.
  - `process_date` keeps its signature and calls it.
- **CLI:**
  - a required, mutually exclusive `--parquet-dir DIR | --derived-dir DIR`;
  - `--out-dir DIR` (default `ROOT/docs/tmp`);
  - `load_env_file(ENV_FILE)`;
  - reports written with `encoding='utf-8'`.
- **`--derived-dir` mode** reads `{date}.parquet` for each fire date. Days without a file go into the existing skipped-days lines, worded `not derived yet` instead of `archive missing`.
- **The timing report** is built from the derived rows joined to the fires on `id`; ticker, mode, tier, dte and option_type come from the fires. Both modes build it the same way.

- [ ] **Step 1: Write the failing tests** in `scripts/test_policy_timing_derive.py`. Cursors are fake, at the module boundary; the parquet fixtures come in both layouts.
  - `test_derive_day_matches_process_date`: the exit frames from both paths are equal.
  - `test_derive_day_layouts_agree`: legacy and new layouts give equal frames, in both scripts.
  - `test_empty_derive_keeps_the_columns`: no chain → 0 rows, the exact columns and dtypes.
  - `test_fingerprint_canonical_form`:
    - ids `[10, 2, 1]` with flags `[1, 0, 1]` → `md5("1:1,2:0,10:1")`;
    - timing → `md5("1,2,10")`;
    - each `DAY_FINGERPRINT_SQL` contains its expression verbatim.
  - `test_day_fingerprints_parses_dates`: rows of `(date, md5)` → `dict[date, str]`.
  - `test_derived_dir_report_matches_parquet_dir_report`: the same fixture through both modes gives identical report text, for both scripts.
  - `test_derived_dir_lists_days_not_derived`.
  - `test_timing_derived_rows_join_fire_attributes`: a fire's tier changes, and the report follows the fire, not the derived file.
  - `test_missing_env_file_is_not_fatal`: both scripts, with `ENV_FILE` pointing at a missing path.
  - `test_reports_write_utf8`: a `→` in the report body is written.
- [ ] **Step 2:** Run them in the ml venv. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `test_update_reports_require_parquet_dir` to assert that the group message names both flags.
- [ ] **Step 4:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_policy_timing_derive.py scripts/test_bot_eod_parquet_dir.py`, plus the isolated ruff. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(reports): Derive exit-policy and flow-timing rows per day, and report from derived files`. Push (P2).

### Task 3: The Neon-only reports take an output dir and the session date

**Skills:** `postgres-pro`.

**Files:**
- Modify: `scripts/feature_audit.py`, `scripts/daily_tracker.py`, `scripts/mine_outcome_patterns.py`, `scripts/score_lineage_audit.py`
- Create: `scripts/test_report_cli.py`

**Interfaces** (all four gain `main(argv: list[str] | None = None)`, `_cli_paths.load_env_file(ENV_FILE)` and UTF-8 writes):

| Script | New arguments | Other changes |
|---|---|---|
| `feature_audit.py` | `--out-dir` (default `ROOT/docs/tmp`) | |
| `daily_tracker.py` | `--csv PATH` (default `ROOT/docs/tmp/lottery-tracking.csv`) | |
| `mine_outcome_patterns.py` | `--as-of YYYY-MM-DD` (default `date.today()`), `--out-dir` | `fetch_fires(as_of: date)`; `CURRENT_DATE - INTERVAL '90 days'` becomes `%(as_of)s::date - INTERVAL '90 days'`; the report's date and file name use `as_of` |
| `score_lineage_audit.py` | the same | the same, with its 30-day window |

- [ ] **Step 1: Write the failing tests** in `scripts/test_report_cli.py`. `psycopg2.connect` and `pd.read_sql`/`read_sql_query` are patched at each module's boundary.
  - `test_feature_audit_writes_into_out_dir`: a 300-row synthetic frame → `lottery-feature-audit-<date>.md` in `tmp`, and nothing under `ROOT/docs/tmp`.
  - `test_tracker_csv_path_is_respected_and_row_replaced`: an existing CSV with a `2026-11-04` row → after the run the row count is unchanged and that row is replaced.
  - `test_mining_window_is_anchored_to_as_of`:
    - the SQL contains `%(as_of)s::date - INTERVAL '90 days'` and no `CURRENT_DATE`;
    - the param is `date(2026, 11, 4)`;
    - the report is `lottery-composite-candidates-2026-11-04.md` in `--out-dir`. The analysis functions are patched to stubs.
  - `test_lineage_window_is_anchored_to_as_of`: the same, for 30 days.
  - `test_missing_env_file_is_not_fatal`: all four, with `ENV_FILE` pointing at a missing path.
- [ ] **Step 2:** Run them in the ml venv. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests, plus the isolated ruff on the five files. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(reports): Take the output dir and session date in the lottery research reports`, and push (P1).

### Task 3b: The four Neon reports read the active weights (review S9, D8)

**Skills:** `pandas-pro`, `postgres-pro`, `test-master`.

**Files:**
- Modify: `scripts/feature_audit.py`, `scripts/daily_tracker.py`, `scripts/mine_outcome_patterns.py`, `scripts/score_lineage_audit.py`
- Create: `scripts/test_report_weights.py`

**Interfaces:**
- Consumes (phase 4, deployed before this phase): `lottery_weights.load_pointer(conn, "active") -> (version, weights)` (validated; `WeightsInvalid` on a bad row), and `lottery_scoring.SINGLE_LEG_FILTER`. Each script puts `ml/src` on `sys.path`, as `mine_outcome_patterns.py` does today, before it imports them.
- Produces no new public names. Per script:

  | Script | Reads today | Reads now |
  |---|---|---|
  | `feature_audit.py` | `WEIGHTS_JSON`; `TIER1_CUTOFF = 13` and `TIER2_CUTOFF = 10` (lines 39–40), and the line-34 comment that names `TIER_CUTOFFS_V2` | `weights["feed_cutoffs"]` (`tier1_min_score`, `tier2_min_score`, qas) for the T1/T2 split, passed to the functions that use it. The regime header names `version`, `model_version` and `trained_through`: a store weights object has no `training_sample` or `trained_at`. |
  | `daily_tracker.py` | `weights_path` | `weights["cutoffs"]` (`t1`, `t2`) on the stored `score`. It prints the version. The CSV header is unchanged. |
  | `mine_outcome_patterns.py` | `WEIGHTS_PATH`; `AND inferred_structure IS NULL` | the active weights; `SINGLE_LEG_FILTER` in `FETCH_QUERY` in place of the `inferred_structure` predicate. The report header names the version. |
  | `score_lineage_audit.py` | `WEIGHTS_PATH`; the same predicate | the same |

**Rules:**
- `WEIGHTS_JSON`, `WEIGHTS_PATH`, `weights_path`, `TIER1_CUTOFF` and `TIER2_CUTOFF` are removed. There is no fallback to the frozen JSON; a failed read ends the script non-zero and writes nothing (D8).
- `score_components` is unchanged: the store's weights have the same `features` and `cutoffs` shape the JSON had.
- The mining and lineage population change is a methodology change, ordered with the repointing (spec delta 11).

- [ ] **Step 1: Write the failing tests** in `scripts/test_report_weights.py`. `psycopg2.connect`, `pd.read_sql`/`read_sql_query` and `lottery_weights.load_pointer` are patched at each module's boundary; the weights fixture differs from the seed's.
  - `test_feature_audit_splits_tiers_with_the_active_feed_cutoffs`: `feed_cutoffs` 16/12 → a qas of 17 is T1, 14 is T2 and 11 is T3 (13/10 would call 14 T1); the module has no `TIER1_CUTOFF` or `TIER2_CUTOFF`.
  - `test_feature_audit_header_names_the_active_version`: the regime lines carry the version, `model_version` and `trained_through`.
  - `test_tracker_classifies_with_the_active_bare_cutoffs`: `cutoffs` 12/8 → scores 12, 8 and 7 are T1, T2 and T3; the version is printed; the CSV header equals the old one.
  - `test_mining_and_lineage_score_with_the_active_weights`: boundaries and weights that differ from the seed's change the mining feature tuples and the lineage components.
  - `test_mining_and_lineage_select_the_single_leg_population`: each `FETCH_QUERY` contains `anchor_leg_kind = 'single'` and not `inferred_structure`.
  - `test_invalid_active_weights_fail_the_report_without_a_fallback`: `load_pointer` raises `WeightsInvalid` → each of the four exits non-zero, writes no file under its out dir, and never opens the JSON.
  - `test_no_report_reads_the_frozen_weights_json`: none of the four source files contains `lottery_score_weights.json`.
- [ ] **Step 2:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_report_weights.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_report_weights.py scripts/test_report_cli.py`, plus the isolated ruff on the five files. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(reports): Read the active lottery weights from the store in the nightly research reports`, and push (P1).

### Task 4: Whale plots and the Take-It drift monitor take explicit dirs and dates

**Skills:** `matplotlib`, `scikit-learn`, `pandas-pro`.

**Files:**
- Modify: `ml/src/whale_plots.py`, `ml/src/takeit_drift_monitor.py`, `ml/tests/test_takeit_drift_monitor.py`
- Create: `ml/tests/test_whale_plots.py`, `ml/tests/test_takeit_drift_auc_sklearn.py`

**Interfaces:**
- `whale_plots`:
  - `main(argv: list[str] | None = None) -> int`, with `--by-day-dir` (default `PARQUET_DIR`) and `--out-dir` (default `OUTPUT_DIR`);
  - `load_data(by_day_dir: Path)`;
  - `print_pipeline_summary(latest_date, out_dir)` prints only the date and the out dir. The Blob, archive and "commit" lines go.
- `takeit_drift_monitor` (no module-level `sklearn` or `utils` import, and no `except ImportError: sys.exit(1)` fallback):

  ```python
  def rolling_auc(y_true, y_pred) -> float        # Mann-Whitney with average ranks; NaN rules unchanged
  def fetch_recent_fires(conn, feed: str, lookback_days: int, as_of: date) -> pd.DataFrame   # date >= %s (as_of - lookback)
  def compute_feed_drift(df, feed: str, as_of: date) -> dict
  def plot_reliability(df, feed: str, as_of: date, plot_dir: Path) -> Path | None
  @dataclass(frozen=True)
  class DriftRun:
      report_path: Path; plot_paths: tuple[Path, ...]; metrics_written: int
  def run_drift(conn, as_of: date, report_dir: Path, plot_dir: Path) -> DriftRun
  def main(argv: list[str] | None = None) -> int  # --as-of (today), --out-dir (DOCS_TMP), --plot-dir (PLOT_DIR);
                                                  # `from utils import get_connection` inside main
  ```

- `run_drift` upserts with the existing `ON CONFLICT (date, feed, metric_name)` statement, with `date = as_of`. It counts executed upserts and commits.
- The header comment loses "committed by make update".
- **The import block** (lines 19–32: `try: import matplotlib … from sklearn.metrics import roc_auc_score … except ImportError: print(…); sys.exit(1)`) becomes plain imports; `matplotlib.use("Agg")` still precedes `pyplot`. The step runs in-process behind `lazy_step` (Task 10), so a missing dependency must raise `ImportError` inside the step. A `SystemExit` at import passes through `run_steps` and ends the run before the tape's Sentry check-in (phase 2 D2, review S10). `whale_plots.py` keeps its own fallback: it runs as a subprocess, where a non-zero exit is the failure.

- [ ] **Step 1: Write the failing tests:**
  - `test_rank_auc_matches_sklearn` (in `ml/tests/test_takeit_drift_auc_sklearn.py`, with a plain `import sklearn`): 25 seeded cases with ties (rounded predictions) → `abs(diff) < 1e-12`. It lives in its own file so the nightly env, which has no scikit-learn, never collects it, and the `ml` CI job (scikit-learn 1.8.0 in `ml/requirements.txt`) runs it and can't skip it silently (review N17).
  - `test_rolling_auc_ties_count_half`: `y=[0,1]`, `pred=[0.5,0.5]` → 0.5.
  - `test_missing_dependency_raises_import_error_not_systemexit`: a subprocess with cwd `ml/src` sets `sys.modules["matplotlib"] = None`, then imports the module; the child reports an `ImportError`, not a `SystemExit`.
  - `test_fetch_window_uses_as_of_param`: no `CURRENT_DATE` in the SQL; the param is `as_of - 30 days`.
  - `test_run_drift_writes_report_plots_and_counts_metrics`:
    - fixture frames for both feeds, with both classes;
    - `takeit-drift-2026-11-04.md` is written, plus `reliability_lottery_2026-11-04.png` and `reliability_silent_boom_2026-11-04.png`;
    - every upsert has date `2026-11-04`;
    - `metrics_written` equals the number of executes, at most 8.
  - `test_run_drift_skips_nan_metrics`: a single-class feed writes 0 metrics for that feed.
  - `test_import_needs_no_sklearn_or_ml_utils`: a subprocess with cwd `ml/src` imports the module, and asserts `'sklearn' not in sys.modules` and `'utils' not in sys.modules`.
  - `test_whale_plots_writes_only_to_out_dir`:
    - three CHAINS-schema fixture days with SPXW and NDXP chains that pass the checklist;
    - `main([...]) == 0`, with at least 12 PNGs in `out`;
    - the `ml/plots/whale-detection` mtimes are unchanged.
  - `test_whale_plots_reads_seeded_and_tape_built_days`: `equity_type 'Common Stock'` and `sector 'Tech'` on one day, NULLs on the others → `load_data` concatenates them.
  - Update the existing drift tests for the new parameters.
- [ ] **Step 2:** Run `cd ml && .venv/Scripts/python -m pytest -q tests/test_takeit_drift_monitor.py tests/test_whale_plots.py tests/test_takeit_drift_auc_sklearn.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run those tests, then `ruff check` and `ruff format --check` on the five files. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(ml): Point the whale plots and drift monitor at given dirs and the session date`, and push (P1).

### Task 5: Retire the Blob `flow/` write and the local backfill-flow step

**Files:**
- Modify: `scripts/ingest-flow.py`, `ml/tests/test_flow_ingest.py`, `Makefile`, `scripts/test_bot_eod_parquet_dir.py`

**Changes:**
- **`ingest-flow.py`** now runs: header check → row count → Bot-EOD archive parquet → closed-enum check (`side`, `option_type`, `equity_type`) on the archive → delete the CSV unless `--keep-csv`.
  - Delete:
    - `transform` and `CASH_SESSION_START_UTC`/`END_UTC`, the CDT-only window, used only for the Blob copy;
    - `parquet_local_path`, `LOCAL_PARQUET_ROOT` and `cleanup_empty_parents`;
    - every `_upload_*`, `_mpu_*`, `upload_to_blob`, `blob_pathname`, `_put_option_headers` and `_request_with_retry`, and the `BLOB_*` and `MULTIPART_*` constants;
    - `--dry-run`, `--skip-archive`, the token check, and any import left unused.
  - The docstring says the Blob archive is frozen at 46 days (04-13 → 06-16), and that its reader `ml/src/flow_archive.py` keeps working.
- **Makefile:**
  - delete `backfill-flow` and `backfill-flow-one`, with their use in `nightly-resume` and `nightly-one`, the help line, `.PHONY` and the header comment;
  - `analyze`, `analyze-one` and `dry-run` run `set -a && source $(ENV_FILE) && set +a && $(PYTHON) scripts/eod-flow-analysis/analyze.py --day $(DATE) [--no-rollup] --r2`;
  - `dry-run` drops `--dry-run`;
  - `check`'s env-file message drops `BLOB_READ_WRITE_TOKEN`;
  - the header says the Railway `nightly` job runs this nightly into R2 `research/`, and that nothing a local target writes is committed;
  - the `clean` text says the tracked parquets are frozen history, that new outputs are never committed, and that plots stay tracked.

- [ ] **Step 1: Write the failing tests:**
  - `test_ingest_writes_the_archive_and_never_touches_blob`:
    - a small valid CSV, with no `BLOB_READ_WRITE_TOKEN`;
    - exit 0, the archive exists and the CSV is deleted;
    - the module has no `requests` attribute and no `upload_to_blob`.
  - `test_keep_csv_keeps_it`.
  - `test_closed_enums_checked_on_the_archive`: an unknown `side` → the error names `side`.
  - `test_makefile_drops_backfill_flow_and_reads_the_tape` (in `test_bot_eod_parquet_dir.py`):
    - the Makefile text has no `backfill_net_flow_history` and no `backfill-flow`;
    - every `analyze.py --day` line carries `--r2`.
  - Delete the transform and Blob tests.
- [ ] **Step 2:** Run `cd ml && .venv/Scripts/python -m pytest -q tests/test_flow_ingest.py`, then `ml/.venv/Scripts/python -m pytest -q scripts/test_bot_eod_parquet_dir.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun them, plus ruff (ml config for the test file, isolated for `ingest-flow.py`). Run `make -n analyze-one DATE=2026-11-04` and check that the printed line ends in `--r2`. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `refactor(flow): Stop writing the Blob flow archive and drop the local net-flow backfill`, and push (P1).

### Task 6: R2 research store and the tape ETags

**Skills:** `r2-storage`.

**Files:**
- Modify: `nightly/src/r2_store.py`, `nightly/tests/test_r2_store.py`
- Create: `nightly/src/research_store.py`, `nightly/tests/test_research_store.py`

**Interfaces:**

```python
# r2_store.py
def make_client(settings: Settings)            # the existing client config moved here; R2Store uses it
R2Store.tape_etags(self) -> dict[date, str]     # one fulltape/ listing (_TAPE_RE keys only), ETag quotes stripped, no HEAD

# research_store.py
RESEARCH_PREFIX = "research/"
CONTENT_TYPES: Mapping[str, str]  # .md text/markdown; charset=utf-8 | .txt .log text/plain; charset=utf-8 |
                                  # .csv text/csv; charset=utf-8 | .json application/json | .png image/png |
                                  # .parquet application/vnd.apache.parquet
class ResearchKeyError(ValueError): ...
class ResearchStore:
    def __init__(self, settings: Settings) -> None
    def put_file(self, key: str, path: Path) -> int          # bytes; put_object with the file stream; HEAD
                                                            # ContentLength must equal the size, else delete + R2VerifyError
    def get_file(self, key: str, dest: Path) -> bool        # False = no object; get_object streamed to dest.part,
                                                            # size checked, renamed; .part removed on any error
    def put_json(self, key: str, obj: object) -> None
    def get_json(self, key: str) -> object | None           # None = no object; malformed → ValueError naming the key
    def list(self, prefix: str) -> dict[str, int]           # key → size, every page
    def sync_down(self, prefix: str, dest_dir: Path, names: Iterable[str] | None = None) -> list[Path]
```

**Rules:**
- **Keys:** every key or prefix must start with `research/` and contain no `..` and no backslash; anything else is a `ResearchKeyError`.
- **One client per store,** single-threaded; never `upload_file` or `download_file`.
- **TLS:** at import, `warnings.simplefilter("error", urllib3.exceptions.InsecureRequestWarning)` (memory `boto3-shared-client-unverified-tls`).
- **Logs:** key, bytes and seconds only.

- [ ] **Step 1: Write the failing tests** (moto `mock_aws`):
  - `test_keys_outside_research_are_refused`: `fulltape/x`, `gexbot-eod/x`, `research/../fulltape/x` and `research\\x`, for every method.
  - `test_put_file_round_trip_sets_content_type`: md, png, parquet.
  - `test_put_file_size_mismatch_deletes_and_raises`.
  - `test_get_file_missing_returns_false_and_leaves_nothing`.
  - `test_get_file_short_body_raises_and_leaves_no_part`.
  - `test_get_json_malformed_names_the_key`.
  - `test_list_pages_past_1000`: 1,001 objects.
  - `test_sync_down_restricted_to_names`.
  - `test_never_uses_transfer_threads`: `upload_file` and `download_file` are patched to raise.
  - `test_tape_etags_lists_only_tape_keys` (in `test_r2_store.py`):
    - a `gexbot-eod/` key, an `_unavailable` marker and a `_superseded` object are all excluded;
    - the quotes are stripped;
    - there are 0 `head_object` calls.
  - `test_make_client_config`: `verify=True`, s3v4, `max_attempts=5`, used by both stores.
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_research_store.py tests/test_r2_store.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Phase 1's `R2Store` tests stay green.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Add a research store on R2 and list tape ETags`. Hold (P3).

### Task 7: The image carries the research scripts (D1's six places, minus the CI filter)

**Skills:** `python-packaging`.

**Files:**
- Modify: `nightly/Dockerfile`, `nightly/requirements.txt`, `.dockerignore`, `nightly/tests/test_image_layout.py`, `nightly/README.md`

**Changes:**
- **`IMAGE_FILES`** gains 10 files:
  - `scripts/_eod_flow.py`, `scripts/exit_policy_search.py`, `scripts/flow_inversion_timing.py`, `scripts/feature_audit.py`, `scripts/daily_tracker.py`, `scripts/mine_outcome_patterns.py`, `scripts/score_lineage_audit.py`;
  - `ml/src/whale_plots.py`, `ml/src/takeit_drift_monitor.py`, `ml/src/score_components.py`.
  - `ml/output/lottery_score_weights.json` is not carried: after Task 3b no nightly step reads it (D8).
- **`requirements.txt`:**
  - `duckdb>=1.5.6,<1.6`, the ml pin; its comment says 2.0 binds ns timestamps differently;
  - `matplotlib>=3.10.8,<3.11`, for the whale plots and drift PNGs, Agg only;
  - a comment saying scikit-learn, scipy, SQLAlchemy and xgboost are deliberately absent.
- **Dockerfile:**
  - one `COPY --chown=nightly:nightly` per new file, to the same repo path under `/app`;
  - `MPLBACKEND=Agg` and `MPLCONFIGDIR=/tmp/matplotlib` in the `ENV` block (review N7), so the in-process drift step has a writable cache directory (the report subprocesses get their own under `RESEARCH_WORK_DIR`, Task 9).
- **`.dockerignore`:** `!scripts/<file>` for the 7 new `scripts/` files, after phase 2's `scripts/*` line (its three-step pattern; `!scripts/` is not repeated). `ml/src` is not excluded today.
- **`nightly/README.md`:** the ten paths join the watch-path list, so phase 2's `test_readme_lists_every_watch_path` passes in this task and not in a later one (D1's sixth place).
- **Not edited here:** `nightly/conftest.py`, the `PYTHONPATH` entry and the module-collision test. Phase 4 owns them: its Task 18 the conftest line, its Task 20 the rest (`ml/src` last on the path, `test_no_image_module_name_collides`). The CI edit is Task 7b.

- [ ] **Step 1: Write the failing tests:**
  - `test_dockerfile_copies_exactly_the_image_files` and `test_dockerignore_readmits_image_files` follow `IMAGE_FILES`, so they fail until the Dockerfile and `.dockerignore` carry the ten files.
  - Extend `test_scripts_import_in_the_image_layout`:
    - also import `_eod_flow, exit_policy_search, flow_inversion_timing, feature_audit, daily_tracker, mine_outcome_patterns, score_lineage_audit, whale_plots, takeit_drift_monitor`;
    - assert `'sklearn'`, `'scipy'` and `'sqlalchemy'` are not in `sys.modules` afterwards. The reports now import phase 4's `lottery_weights` and `lottery_scoring`, so this also guards them against a module-level scipy import (review S16).
  - `test_dockerfile_sets_matplotlib_env`: the `ENV` block carries `MPLBACKEND=Agg` and `MPLCONFIGDIR`.
  - `test_requirements_carry_no_sklearn_stack`.
  - Phase 2's `test_readme_lists_every_watch_path` passes with the ten new lines.
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_image_layout.py`. Expected: FAIL.
- [ ] **Step 3:** Make the changes, then `uv pip install --python nightly/.venv -r nightly/requirements-dev.txt`.
- [ ] **Step 4:** Run:
  - the nightly suite, ruff and format;
  - from the repo root with `nightly/.venv/Scripts/python`, the shared commands Task 7b puts in CI: the isolated ruff on the ten files, `python -m pytest -q -p no:cacheprovider scripts/test_eod_flow.py scripts/test_policy_timing_derive.py scripts/test_report_cli.py scripts/test_report_weights.py`, and `python -m pytest -q -p no:cacheprovider ml/tests/test_whale_plots.py ml/tests/test_takeit_drift_monitor.py`. This is `whale_plots`' first run under polars 2.x. If it fails, stop: fix `ml/src/whale_plots.py` and its test in a separate commit (Task 7a: same gate, both venvs) before this one;
  - `docker build -f nightly/Dockerfile .` if Docker is available. Record the image-size delta and the pip-install seconds.

  Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `build(nightly): Carry the research scripts, DuckDB and matplotlib in the image`. Hold (P3).

### Task 7b: CI path filter and shared-test commands for the research files

**Skills:** `gha-security-review`.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- **The `nightly` path filter** gains the ten new `IMAGE_FILES` and their tests: `scripts/test_eod_flow.py`, `scripts/test_policy_timing_derive.py`, `scripts/test_report_cli.py`, `scripts/test_report_weights.py`, `ml/tests/test_whale_plots.py` and `ml/tests/test_takeit_drift_monitor.py`.
- **Phase 2's two extra nightly steps** (`working-directory: .`) grow: the isolated ruff takes the ten new image files and the new `scripts/` tests, and the shared pytest takes the four `scripts/` test files.
- **Phase 4's ml step** (its Task 20b; separate because ml has its own rootdir and conftest) also takes `ml/tests/test_whale_plots.py` and `ml/tests/test_takeit_drift_monitor.py`. It does not take `ml/tests/test_takeit_drift_auc_sklearn.py`: the nightly env has no scikit-learn, and the `ml` job runs that file.

- [ ] **Step 1:** Edit the workflow. Check it with `actionlint` if installed, and read the diff for any `${{ }}` expression added.
- [ ] **Step 2:** From the repo root with `nightly/.venv/Scripts/python`, run the commands exactly as the workflow now spells them. Expected: PASS.
- [ ] **Step 3:** Run `npm run review`, then commit `ci(workflow): Run the research scripts' tests in the nightly job`. Hold (P3).

### Task 8: The `research-derive` step

**Skills:** `r2-storage`, `postgres-pro`.

**Files:**
- Create: `nightly/src/research_derive.py`, `nightly/tests/test_research_derive.py`
- Modify: `nightly/src/constants.py`

**Interfaces:**
- Consumes:
  - `connect_db` and `open_reader` (D4, phase 2);
  - `R2Store.tape_etags`, `ResearchStore` (Task 6);
  - `_eod_flow.build_chains`, `CHAINS_START`, `CHAINS_VERSION` (Task 1);
  - each script's `fires_for_day`, `fingerprint_rows`, `day_fingerprints`, `derive_day`, `DERIVE_VERSION`, `DERIVED_COLUMNS` (Task 2).
- Produces, as constants (all of phase 3's are here; the three budget rows are phase 3's rows of phase 2's D2 table):

  | Name | Value |
  |---|---|
  | `RESEARCH_WORK_DIR` | `WORK_DIR / "research"` |
  | `RESEARCH_TAPE_DIR` | `WORK_DIR / "research-tape"` |
  | `RESEARCH_DAY_BUDGET_SECONDS` | `900`: a 600 s worst-case fetch (`FETCH_DEADLINE_SECONDS`) plus about 2× the 90 s local derive of the largest (15,964-fire) day. It stays at or below `FETCH_DEADLINE_SECONDS` + 300, or D2's row changes first. |
  | `RESEARCH_MAX_DAY_FAILURES` | `3` |
  | `REPORT_BUDGET_SECONDS` | `300`: eight steps, 2,400 s reserved |
  | `LARGE_REPORT_BUDGET_SECONDS` | `600`: the two reports that pull every enriched fire, 1,200 s reserved |

- Produces, in `research_derive`:

  ```python
  MANIFEST_KEY = "research/_state/derive-manifest.json"
  SEED = "seed"
  FamilyName = Literal["chains", "exit-policy", "flow-timing"]
  FAMILY_KEYS: Mapping[FamilyName, Callable[[date], str]]   # D5's three state keys
  class ManifestError(Exception): ...
  @dataclass
  class Manifest:
      families: dict[str, dict[str, str]]                    # {"version": 1, "families": {...}} on disk
      @classmethod
      def load(cls, store: ResearchStore) -> "Manifest"      # empty when absent; ManifestError when malformed
      def get(self, family: FamilyName, day: date) -> str | None
      def set(self, family: FamilyName, day: date, fp: str) -> None
      def save(self, store: ResearchStore) -> None
  def targets(conn, etags: Mapping[date, str], last_session: date) -> dict[FamilyName, dict[date, str]]
  def stale_days(manifest: Manifest, targets) -> dict[date, tuple[FamilyName, ...]]
  def fresh_days(manifest: Manifest, targets, family: FamilyName) -> list[date]
  def run(ctx: StepContext) -> StepResult
  ```

- `targets` covers:
  - **chains:** landed days in `[CHAINS_START, last_session]`;
  - **the two fire families:** the days in their `day_fingerprints` ∩ landed, up to `last_session`.

  `fresh_days` treats `SEED` as fresh for chains only.
- **Registration is Task 10's** (`lazy_step("research-derive", "research_derive", RESEARCH_DAY_BUDGET_SECONDS)`), so this module is never imported at pipeline load.

**Behavior of `run`:**
- **Setup, once:**
  - `Manifest.load`;
  - `R2Store(settings).tape_etags()`;
  - one `connect_db`, then `targets`, then `stale_days`;
  - `open_reader(settings, RESEARCH_TAPE_DIR)`. This reader has its own cache directory and does not reuse `enrich-outcomes`' download: a day phase 2 fetched earlier in the same run is fetched again, up to 600 s each, 20 minutes in all across both steps. The owner accepted it on 2026-11-06 (R2 egress is free).
- **Each stale day, newest first:**
  - stop when `ctx.seconds_left() < RESEARCH_DAY_BUDGET_SECONDS`; the rest count as `days_left`;
  - `fetch_day(day, deadline=ctx.deadline)` once. `None` counts as `days_tape_missing`;
  - for each due family:
    - chains: `build_chains(..., temp_dir=RESEARCH_WORK_DIR)`;
    - the fire families: `fires_for_day`, then `derive_day`, writing a `DERIVED_COLUMNS` parquet even with 0 rows, with fingerprint `f"{etag}|v{DERIVE_VERSION}|{fingerprint_rows(fires)}"`;
    - `put_file`;
  - then `manifest.set` for each, and one `manifest.save`;
  - `release(day)` in `finally`.
- **Per-day failures:** an `Exception` counts in `days_failed` and is sent as one `capture_exception` tagged `step` and `day`. At `RESEARCH_MAX_DAY_FAILURES` the loop stops.
- **Status:**
  - `failed`: any `days_failed`, or a `ManifestError`;
  - `partial`: `days_left`, with detail `days left for the next night`; or the last session isn't landed, with detail `latest session tape not landed`;
  - otherwise `ok`.
- **Counts:** `days_planned`, `days_derived`, `days_left`, `days_failed`, `days_tape_missing`, `chains_written`, `exit_policy_written`, `flow_timing_written`, `rows_written`.
- **Logs:** one line per day: date, families, rows, seconds.

- [ ] **Step 1: Write the failing tests.** R2 is moto, holding fixture tape objects. `connect_db`, `open_reader` and the script functions are patched at the `research_derive` boundary.
  - `test_derives_stale_days_newest_first_with_one_fetch_each`.
  - `test_seeded_chains_are_never_rebuilt`.
  - `test_etag_change_rebuilds_chains_and_both_fire_families`.
  - `test_fingerprint_change_rederives_only_that_family`.
  - `test_empty_derive_is_recorded_and_not_redone`: the object is written and the manifest set; the second run plans 0 days.
  - `test_manifest_survives_a_failure_mid_run`: day 3's fetch raises → days 1–2 are in the saved manifest, and day 3 is not.
  - `test_stored_fp_comes_from_the_rows_used`: `fires_for_day` returns rows other than the pre-check's → the stored fingerprint is the rows' own.
  - `test_malformed_manifest_fails_without_resetting`: no manifest PUT; status `failed`.
  - `test_deadline_leaves_days_as_partial`.
  - `test_day_failures_isolated_capped_at_three_and_captured_with_day_tag`.
  - `test_latest_session_not_landed_is_partial`.
  - `test_only_fulltape_and_research_prefixes_are_listed`.
  - `test_counts_are_ints_and_detail_is_fixed`.
  - `test_cache_dir_is_the_research_tape_dir`: `open_reader` gets `RESEARCH_TAPE_DIR`, not phase 2's `ENRICH_CACHE_DIR`.
  - `test_research_day_budget_fits_the_fetch_deadline`: `RESEARCH_DAY_BUDGET_SECONDS <= _tape_reader.FETCH_DEADLINE_SECONDS + 300`. The comparison reads both constants; it hard-codes no sum.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Derive per-day research state from the tape, newest first`. Hold (P3).

### Task 9: The report runner, the rollup and the script report steps

**Skills:** `monitoring-expert`, `r2-storage`.

**Files:**
- Create: `nightly/src/research_reports.py`, `nightly/tests/test_research_reports.py`
- Modify: `nightly/src/monitoring.py`, `nightly/tests/test_monitoring.py`

**Interfaces:**
- Consumes:
  - `ResearchStore`, `R2Store.tape_etags` (Task 6);
  - `Manifest`, `targets`, `fresh_days`, the constants (Task 8);
  - `_eod_flow.rollup`, `write_headlines` (Task 1);
  - `resources.connect_db`, `direct_dsn` (D4), and `DB_STATEMENT_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_SECONDS` (phase 2, Task 8).

```python
APP_ROOT: Path            # the first parent of this file that holds scripts/ (/app in the image)
@dataclass(frozen=True)
class ScriptRun:
    returncode: int | None; timed_out: bool; error_class: str | None
def script_env(settings: Settings, step: str) -> dict[str, str]
def error_class(log_path: Path) -> str | None
    # the class of the log's last non-empty line, only when (a) that line ends a traceback block (it is the first unindented
    # line after the last "Traceback (most recent call last):"), or (b) the class name's last dotted segment ends in
    # Error, Exception, Exit or Interrupt. Pattern ^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?::|$); ≤ 100 chars. Never the message.
def run_script(script: str, argv: Sequence[str], *, log_path: Path, timeout: float,
               env: Mapping[str, str]) -> ScriptRun
def publish(store: ResearchStore, out_dir: Path, family: str, session: date) -> tuple[int, int]   # (files, bytes)
def publish_log(store: ResearchStore, log_path: Path, session: date, step: str) -> int
@dataclass(frozen=True)
class ScriptReport:
    step: str; family: str; script: str
    inputs: Literal["none", "chains", "exit-policy", "flow-timing"]
    outputs: tuple[str, ...]
    extra_args: Callable[[date, Path, Path], list[str]]   # (session, in_dir, out_dir)
REPORTS: tuple[ScriptReport, ...]
STEP_NAMES: frozenset[str]                               # "eod-flow-rollup" plus every REPORTS step
def run_report(report: ScriptReport, ctx: StepContext) -> StepResult   # not named report_step: monitoring.report_step is phase 2's (review N6)
def run_rollup(ctx: StepContext) -> StepResult           # step "eod-flow-rollup"
def run_step(name: str, ctx: StepContext) -> StepResult  # the entry point lazy_group_step calls (Task 10); KeyError for an unknown name
```

**`REPORTS`:** each step's `min_seconds` is a named constant registered in Task 10, not a field here.

| step | family | script | inputs | outputs | extra args |
|---|---|---|---|---|---|
| `whale-plots` | `whale-plots` | `ml/src/whale_plots.py` | chains | `*.png` | `--by-day-dir IN --out-dir OUT` |
| `exit-policy-report` | `exit-policy` | `scripts/exit_policy_search.py` | exit-policy | `lottery-exit-policy-search-*.md` | `--derived-dir IN --out-dir OUT` |
| `flow-timing-report` | `flow-timing` | `scripts/flow_inversion_timing.py` | flow-timing | `flow-inversion-timing-*.md` | `--derived-dir IN --out-dir OUT` |
| `feature-audit` | `feature-audit` | `scripts/feature_audit.py` | none | `lottery-feature-audit-*.md` | `--out-dir OUT` |
| `outcome-mining` | `outcome-mining` | `scripts/mine_outcome_patterns.py` | none | `lottery-composite-candidates-*.md` | `--as-of S --out-dir OUT` |
| `score-lineage` | `score-lineage` | `scripts/score_lineage_audit.py` | none | `lottery-score-lineage-*.md` | `--as-of S --out-dir OUT` |

**Rules:**
- **`script_env`** keeps `PATH`, `PYTHONPATH` and `POLARS_MAX_THREADS`, and sets:
  - `LANG=C.UTF-8`, `TZ=UTC`, `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`;
  - `HOME` and `MPLCONFIGDIR` under `RESEARCH_WORK_DIR`; `MPLBACKEND=Agg`;
  - `DATABASE_URL` and `DATABASE_URL_UNPOOLED` set to `direct_dsn(...)`;
  - `PGOPTIONS=-c statement_timeout=<DB_STATEMENT_TIMEOUT_MS>`, `PGAPPNAME=nightly-<step>`, `PGCONNECT_TIMEOUT=<DB_CONNECT_TIMEOUT_SECONDS>`, built from phase 2's two constants (review N18).

  It carries nothing else: no `R2_*`, `UW_API_KEY` or `SENTRY_DSN`.
- **Inputs:**
  - chains: `sync_down("research/eod-flow/by-day/", IN)`;
  - the fire families: only `research_derive.fresh_days(...)` files (`{day}.parquet`). This takes `Manifest.load`, `tape_etags` and one `connect_db` for `targets`.
- **Report step status:**

  | Outcome | Status | Detail |
  |---|---|---|
  | exit 0 and every output glob matched a non-empty file | `ok` | |
  | exit 0, an output missing | `failed` | `no output written` |
  | non-zero exit | `failed` | `script exited {code}`, plus ` ({cls})` when `error_class` found one |
  | timeout (`ctx.seconds_left()`) | `failed` | `script timed out` (the process is killed) |

  - Outputs are published to `research/{family}/{session}/` only on `ok`.
  - The log is always published.
  - Counts: `files_uploaded`, `bytes_uploaded`, `inputs_synced`, `log_uploaded`, `exit_code` (≥ 0; a timeout is 0, with `timed_out` = 1).
- **`run_rollup`:** sync the chains, then call `_eod_flow.rollup(IN)` and `write_headlines`. Write `cumulative-rollup.json` (indent 2, `default=str`) and `cumulative-headlines.txt` (UTF-8), then publish to `research/eod-flow/{session}/`.
  - `failed` (`no chains days`) when there are no days;
  - `partial` (`latest session not in rollup`) when `max(days) < last_session`;
  - otherwise `ok`.
  - It prints nothing. Counts: `days`, `files_uploaded`, `bytes_uploaded`.
- **`monitoring.scrub_event`** adds `duckdb` and `_duckdb` to the redacted module roots. DuckDB conversion errors quote cell values.
- **Registration is Task 10's.** This module is never imported at pipeline load.

- [ ] **Step 1: Write the failing tests.** Scripts are tiny Python files under a `tmp_path` `APP_ROOT` (patched). R2 is moto.
  - `test_run_report_publishes_outputs_and_log`.
  - `test_exit_zero_without_output_is_failed`.
  - `test_nonzero_exit_names_the_class_only`: the script raises `ValueError("SPY 450C premium 1,234,567")` → detail `script exited 1 (ValueError)`; neither the detail nor the counts contain `SPY`; the log is published.
  - `test_error_class_rejects_non_identifiers` (review S7): no class comes out of `[search] no fire produced…`, of `SPXW: 12 fires` as a last line with no traceback, of a 101-character class, or of a non-traceback last line such as `Wrote 12 files` or `NDXP: 3 chains`. A class does come out of `ValueError: SPY 450C` (class only, `ValueError`), `KeyboardInterrupt`, `SystemExit: 1`, and a log that ends a traceback with `psycopg2.errors.QueryCanceled: canceling statement` (`psycopg2.errors.QueryCanceled`, which matches no suffix and relies on the traceback rule).
  - `test_run_step_dispatches_by_name_and_rejects_an_unknown_one`: every name in `STEP_NAMES` reaches `run_rollup` or its `ScriptReport`; any other name raises `KeyError`.
  - `test_script_output_never_reaches_the_log`: under `caplog`, no record contains the script's printed marker.
  - `test_timeout_kills_the_script_and_fails`: a sleeping script with a 1 s timeout.
  - `test_script_env_carries_no_store_or_uw_secrets`: and its `DATABASE_URL` host has no `-pooler`.
  - `test_failed_run_publishes_no_outputs`.
  - `test_inputs_sync_only_fresh_derived_days`.
  - `test_rollup_ok_publishes_json_and_headlines`.
  - `test_rollup_partial_when_latest_session_missing`.
  - `test_script_env_builds_the_pg_timeouts_from_the_constants`: `PGOPTIONS` and `PGCONNECT_TIMEOUT` equal values built from `DB_STATEMENT_TIMEOUT_MS` and `DB_CONNECT_TIMEOUT_SECONDS`.
  - `test_scrub_redacts_duckdb_messages` (in `test_monitoring.py`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Run the research reports as isolated steps that publish to R2`. Hold (P3).

### Task 10: The tracking, quality-sim and drift steps, and the registration of all eleven

**Skills:** `postgres-pro`, `monitoring-expert`.

**Files:**
- Create: `nightly/src/research_db_steps.py`, `nightly/tests/test_research_db_steps.py`
- Modify: `nightly/src/pipeline.py`, `nightly/tests/test_pipeline.py`, `nightly/tests/test_image_layout.py`

**Interfaces:**
- Consumes:
  - `run_script`, `script_env`, `publish`, `publish_log` (Task 9);
  - `ResearchStore` (Task 6);
  - `connect_db` (D4);
  - `takeit_drift_monitor.run_drift` (Task 4);
  - `enrich_lottery_outcomes.refit_ticker_inversion_stats` (phase 2 Task 3, write-free).

```python
TRACKING_STATE_KEY = "research/lottery-tracking/state/lottery-tracking.csv"
class StateShrankError(Exception): ...
def csv_rows(path: Path) -> int                  # data rows, header excluded
def publish_state_csv(store: ResearchStore, state_key: str, snapshot_key: str, path: Path,
                      rows_before: int) -> int   # StateShrankError if rows < rows_before; snapshot first, then state
def run_tracking(ctx: StepContext) -> StepResult      # "lottery-tracking"
def run_quality_sim(ctx: StepContext) -> StepResult   # "quality-sim"
def run_takeit_drift(ctx: StepContext) -> StepResult  # "takeit-drift"
STEP_NAMES: frozenset[str]                            # those three
def run_step(name: str, ctx: StepContext) -> StepResult   # the entry point lazy_group_step calls; KeyError for an unknown name
```

**Behavior:**
- **`lottery-tracking`:**
  - `get_file(TRACKING_STATE_KEY)`. A missing object fails with `tracking state missing`; it never starts a new file.
  - Run `scripts/daily_tracker.py --csv <tmp>` through `run_script` (D6). Its exit must be 0.
  - The header must be unchanged and the rows must not shrink; otherwise it fails with `tracking state shrank` and nothing is uploaded.
  - `publish_state_csv` writes `research/lottery-tracking/{session}/lottery-tracking.csv`, then the state.
  - Counts: `rows_before`, `rows_after`, `files_uploaded`, `log_uploaded`.
- **`quality-sim`:**
  - On `connect_db`, run `enrich_lottery_outcomes.refit_ticker_inversion_stats(conn, sim_csv_path=OUT / f"lottery-quality-sim-{session}.csv")`, with stdout and stderr redirected to the step log.
  - 0 data rows fail with `no scored fires`.
  - Publish the CSV and the log. Counts: `csv_rows`, `files_uploaded`, `log_uploaded`.
- **`takeit-drift`:**
  - On `connect_db`, run `takeit_drift_monitor.run_drift(conn, ctx.last_session, OUT, OUT)`.
  - `metrics_written == 0` fails with `no drift metrics`.
  - Publish the md and the PNGs to `research/takeit-drift/{session}/`. Counts: `metrics_written`, `plots_written`, `files_uploaded`.
- **Registration of all eleven steps (D2's import isolation; review S10 and B2).**
  - `pipeline.py` gains `lazy_group_step(name, module, min_seconds)`. It is `lazy_step`'s form for a module that holds several steps: `run` imports `module` and calls `module.run_step(name, ctx)`. Phase 2's `lazy_step` is unchanged, and `research_derive`, which holds one step, uses it. No step module is imported at load.
  - `STEPS` appends the following after phase 4's `lottery-refit`, in this order:

    | Step | Registered with | Module | `min_seconds` |
    |---|---|---|---|
    | `research-derive` | `lazy_step` | `research_derive` | `RESEARCH_DAY_BUDGET_SECONDS` |
    | `eod-flow-rollup` | `lazy_group_step` | `research_reports` | `REPORT_BUDGET_SECONDS` |
    | `whale-plots` | `lazy_group_step` | `research_reports` | `REPORT_BUDGET_SECONDS` |
    | `exit-policy-report` | `lazy_group_step` | `research_reports` | `LARGE_REPORT_BUDGET_SECONDS` |
    | `flow-timing-report` | `lazy_group_step` | `research_reports` | `LARGE_REPORT_BUDGET_SECONDS` |
    | `feature-audit` | `lazy_group_step` | `research_reports` | `REPORT_BUDGET_SECONDS` |
    | `outcome-mining` | `lazy_group_step` | `research_reports` | `REPORT_BUDGET_SECONDS` |
    | `score-lineage` | `lazy_group_step` | `research_reports` | `REPORT_BUDGET_SECONDS` |
    | `lottery-tracking` | `lazy_group_step` | `research_db_steps` | `REPORT_BUDGET_SECONDS` |
    | `quality-sim` | `lazy_group_step` | `research_db_steps` | `REPORT_BUDGET_SECONDS` |
    | `takeit-drift` | `lazy_group_step` | `research_db_steps` | `REPORT_BUDGET_SECONDS` |

  - All eleven register in this task, not in Tasks 8 and 9, because phase 4's `test_pipeline_order_and_reserve` lists every step and would fail in any task that registered only some.
  - This task extends that test and its budget assertion. It writes no second order test.

- [ ] **Step 1: Write the failing tests:**
  - `test_tracking_state_missing_fails_and_writes_nothing`.
  - `test_tracking_csv_never_shrinks`: the fake script drops a row → `failed` with `tracking state shrank`, and no PUT.
  - `test_tracking_publishes_snapshot_then_state`: in the moto PUT order.
  - `test_quality_sim_is_select_only`: the fake cursor sees only `SELECT`s.
  - `test_quality_sim_empty_csv_fails`.
  - `test_drift_zero_metrics_fails`.
  - `test_drift_publishes_report_and_plots_dated_by_session`.
  - `test_run_step_dispatches_by_name_and_rejects_an_unknown_one` (in `test_research_db_steps.py`): the three names reach their functions; any other raises `KeyError`.
  - In `nightly/tests/test_pipeline.py`:
    - `test_pipeline_order_and_reserve`, extended from phase 4's (Task 21):
      - the `STEPS` names are `enrich-outcomes`, `outcome-check`, `lottery-refit`, then `research-derive`, `eod-flow-rollup`, `whale-plots`, `exit-policy-report`, `flow-timing-report`, `feature-audit`, `outcome-mining`, `score-lineage`, `lottery-tracking`, `quality-sim`, `takeit-drift`;
      - each step's `min_seconds` is its named constant, imported from `constants`, never a literal;
      - `reserve_seconds(STEPS)` equals the sum of those constants: phase 2's two, `REFIT_BUDGET_SECONDS` (1,800, unchanged), `RESEARCH_DAY_BUDGET_SECONDS`, 8 × `REPORT_BUDGET_SECONDS` and 2 × `LARGE_REPORT_BUDGET_SECONDS`. Nothing is a hard-coded total;
      - phase 4's `PROMOTION_MIN_SECONDS <= REFIT_BUDGET_SECONDS` stays.

      Phase 2's `test_deadline_constants_bound_the_run` (`reserve_seconds(STEPS) + 2 * DAY_BUDGET_SECONDS <= RUN_DEADLINE_SECONDS`) covers the new reserve with no edit.
    - `test_pipeline_imports_no_step_module_at_load` (phase 2's), extended: `research_derive`, `research_reports` and `research_db_steps` are not in `sys.modules` after importing `pipeline`.
    - `test_lazy_group_step_imports_late_and_dispatches_by_name`: the module is not imported before the run; two steps of a fake group module each receive their own name; a module that raises `ImportError` fails only its own step (`error == "ModuleNotFoundError"`) while a later step runs.
    - `test_every_group_step_name_is_registered`: every name in `research_reports.STEP_NAMES` and `research_db_steps.STEP_NAMES` appears in `STEPS`.
  - In `nightly/tests/test_image_layout.py`: the layout import also imports `research_derive, research_reports, research_db_steps`. The lazy registrations defer them, so a missing file would otherwise go unseen until a run.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff, format and the Task 7 shared-test commands. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Keep the tracking CSV in R2, run the quality sim and drift monitor, and register the research steps`. Hold (P3).

### Task 11: The one-time seed CLI

**Skills:** `r2-storage`.

**Files:**
- Create: `nightly/src/seed_research.py`, `nightly/tests/test_seed_research.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class SeedRule:
    pattern: str; key: str            # repo-relative glob; key template with {name} and {date} (YYYY-MM-DD in the name)
SEED_RULES: tuple[SeedRule, ...]
@dataclass(frozen=True)
class SeedItem:
    path: Path; key: str
@dataclass(frozen=True)
class SeedResult:
    uploaded: int; skipped_existing: int; chains_marked_seed: int
def plan_seed(repo_root: Path) -> list[SeedItem]
def run_seed(store: ResearchStore, items: Sequence[SeedItem], *, dry_run: bool) -> SeedResult
def main(argv: list[str] | None = None) -> int    # python -m seed_research --repo-root PATH [--dry-run]; prints counts per rule
```

**`SEED_RULES`:** `{date}` is the session in the file name. Owner answer 4 covers the dated-report rows. There is no ticker-weight-history rule: the CSV is retired.

| Pattern | Key |
|---|---|
| `scripts/eod-flow-analysis/output/by-day/*-chains.parquet` | `research/eod-flow/by-day/{name}` |
| `docs/tmp/lottery-tracking.csv` | `research/lottery-tracking/state/lottery-tracking.csv` |
| `docs/tmp/lottery-exit-policy-search-*.md` | `research/exit-policy/{date}/{name}` |
| `docs/tmp/flow-inversion-timing-*.md` | `research/flow-timing/{date}/{name}` |
| `docs/tmp/lottery-feature-audit-*.md` | `research/feature-audit/{date}/{name}` |
| `docs/tmp/lottery-composite-candidates-*.md` | `research/outcome-mining/{date}/{name}` |
| `docs/tmp/lottery-score-lineage-*.md` | `research/score-lineage/{date}/{name}` |
| `docs/tmp/lottery-quality-sim-*.csv` | `research/quality-sim/{date}/{name}` |
| `docs/tmp/takeit-drift-*.md`, `ml/plots/takeit-drift/reliability_*_*.png` | `research/takeit-drift/{date}/{name}` |

**Rules:**
- **Never overwrites:** an existing key is skipped.
- **Seed marks:** each by-day day whose key exists after the run and that has no manifest entry gets `"seed"` (D7).
- **Bad names:** a name with no parseable date is an error naming the file.
- **`--dry-run`:** no PUT.

- [ ] **Step 1: Write the failing tests:**
  - `test_plan_maps_each_rule`: on a fixture repo tree.
  - `test_existing_keys_are_never_overwritten`.
  - `test_chains_days_are_marked_seed_once`: a rerun makes 0 new marks.
  - `test_dry_run_writes_nothing`.
  - `test_main_prints_counts_only`: `capsys` shows no file contents.
  - `test_seeded_chains_are_skipped_by_research_derive`: through `research_derive.stale_days`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Add the one-time seed of local research state into R2`. Hold (P3).

### Task 12: Docs

**Skills:** `agents-md`.

**Files:**
- Modify: `nightly/README.md`, `CLAUDE.md`, `scripts/eod-flow-analysis/README.md`

**Content:**
- **`nightly/README.md`:**
  - "What it does" gains the eleven steps;
  - a "Research outputs" section:
    - D5's table, and how to browse it;
    - the manifest, and how to force a re-derive (delete that family's day entry, or the object, by hand);
    - `research/_logs/`;
    - the seed command (Task 13);
  - the alert table gains: `nightly step partial` for `research-derive` on catch-up nights (expected) and for `eod-flow-rollup`; and `nightly step failed` with each research detail phrase;
  - the push hazard names the research files too, with the push window (after 15:00 CT and outside 07:15–12:30 UTC). The watch-path lines themselves came in Task 7;
  - the first item's tape window for this stage: a day may start only in the first 6,000–6,900 s of a run (D2's stage table: the run deadline, less the 7,500–8,400 s reserve, less one 3,600 s tape day). Task 16 Step 4 adds the measured days per night;
  - a note that the job writes `ml_` rows to `takeit_health_daily`.
- **`CLAUDE.md`:** the `nightly/` block (research steps; R2 `research/`; writes `takeit_health_daily`), its catch-up line carrying the same stage window, and the Deployment watch-path note.
- **`scripts/eod-flow-analysis/README.md`:** tape source (`--tape-dir`/`--r2`), outputs in R2 (`research/eod-flow/`), the 09:30–10:00 ET window, and that nothing a local run writes is committed. The 23 tracked by-day files, the rollup and the headlines are frozen history (owner, 2026-11-06), and a local run rewrites the tracked rollup and headlines, which must not be committed. The `git add … <new-date>-chains.parquet` instruction (line 107) goes.

- [ ] **Step 1:** Edit. Phase 2's `test_readme_lists_every_watch_path` stays green: Task 7 already listed the ten paths.
- [ ] **Step 2:** Run the nightly suite, then `npm run review`.
- [ ] **Step 3:** Commit `docs(nightly): Document the research outputs, their R2 layout and the new watch paths`. Hold (P3).

### Task 13: Seed R2 from the main checkout (controller)

**Skills:** `r2-storage`.

- [ ] **Step 1:** From the worktree (Tasks 6 and 11 committed), with `.env.local` sourced into the shell and nothing echoed, run `nightly/.venv/Scripts/python -m seed_research --repo-root F:/dev/strike-calculator --dry-run` (cwd `nightly/src`). Check the counts: 44 by-day files, 1 state CSV, and the per-family report counts.
- [ ] **Step 2:** Run it without `--dry-run`, then rerun it: the second run uploads 0.
- [ ] **Step 3:** Verify by listing, counts only:
  - 44 objects under `research/eod-flow/by-day/`;
  - the manifest's chains map has 44 `"seed"` entries;
  - the tracking state CSV's data rows equal the local file's (27 on 11-05);
  - `grep -c InsecureRequestWarning` on the run log is 0.

### Task 14: (removed 2026-11-06: the row-level files already tracked in git stay by owner decision, so there is nothing to untrack)

### Task 15: Pre-push guard for the redeploy window (owner answer 3)

**Skills:** `test-master`, `git-advanced-workflows`.

**Files:**
- Create: `.githooks/pre-push`, `scripts/_lib/nightly-push-window.mjs`, `scripts/_lib/nightly-push-window.test.mjs`

**Interfaces:**

```js
export function imageSources(dockerfileText) // string[]: every non --from COPY source, plus 'nightly/Dockerfile' and '.dockerignore' (watch paths no COPY names; a COPY of an ignored file fails the build). Not the whole 'nightly/' prefix, so README and test pushes stay open
export function inBlockedWindow(now)         // boolean: 07:15:00 <= UTC time < 12:30:00
export function touchedImagePaths(changed, sources)   // string[]: exact files; a dir source matches by prefix
export async function main({ stdin, env, now, git })  // 0 allow, 1 block
```

- **The hook** is `#!/bin/sh` followed by `exec node "$(dirname "$0")/../scripts/_lib/nightly-push-window.mjs"`, with stdin passed through.
- **What it diffs:** each pre-push line, `git diff --name-only <remote>..<local>`. A new remote branch diffs against `origin/main`. A deletion (local sha all zeros) is allowed.
- **Bypass:** `NIGHTLY_PUSH_WINDOW_OK=1`.
- **The block message** names up to 5 paths and the time the window ends.

- [ ] **Step 1: Write the failing tests:**
  - window edges: 07:14:59 allowed; 07:15:00 and 12:29:59 blocked; 12:30:00 allowed;
  - a multi-source `COPY --chown=… a b ./dst/` is parsed;
  - the `nightly/src/` prefix matches;
  - a push that touches only `nightly/Dockerfile` is blocked inside the window;
  - a push that touches only `nightly/README.md` or `nightly/tests/` is allowed inside the window;
  - a push that touches only `.dockerignore` is blocked inside the window (review S6);
  - a push that touches only `api/` is allowed inside the window;
  - a branch deletion is allowed;
  - a new branch is diffed against `origin/main`;
  - the bypass env allows the push.
- [ ] **Step 2:** Run `npx vitest run scripts/_lib/nightly-push-window.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the test again. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `build(git): Refuse pushes that would redeploy nightly mid-run`, and push (P6).

### Task 16: Deploy, first runs, catch-up watch (controller)

**Skills:** `railway:use-railway`, `r2-storage`, `monitoring-expert`, `postgres-pro`.

- [ ] **Step 1: Precondition (hard): phase 2's backfill is finished.** Phase 2's Task 15 Step 5 defines it: one run reports `days_left = 0`, `days_failed = 0` and `days_waiting_tape = 0`, and a read-only `work_days` listing through the last session is empty. Phase 2 tells the main session when it is. Do not go on before then. While the backfill runs, `enrich-outcomes` keeps the early part of each run, so `research-derive` would get only about 2,500–2,900 s a night, and it would derive days whose inversions the backfill is still refilling and then derive them again. Phase 4's `lottery-refit` is deployed and its shadow is running.

  Then, in the push window (after 15:00 CT and outside 07:15–12:30 UTC):
  - in the worktree, `git fetch && git rebase origin/main`;
  - rerun the nightly suite, the shared `scripts/` and `ml/` tests (nightly venv) and `npm run review`.
- [ ] **Step 2:** **Add** these 10 paths to the Railway `nightly` watch paths, which already hold phase 2's 10 and phase 4's 4 (14 in all). Read the list first, add, read it back, and never replace it. After the change the list has 24: `/scripts/_eod_flow.py`, `/scripts/exit_policy_search.py`, `/scripts/flow_inversion_timing.py`, `/scripts/feature_audit.py`, `/scripts/daily_tracker.py`, `/scripts/mine_outcome_patterns.py`, `/scripts/score_lineage_audit.py`, `/ml/src/whale_plots.py`, `/ml/src/takeit_drift_monitor.py` and `/ml/src/score_components.py`.
- [ ] **Step 3:** Run `git push origin HEAD:main`. Verify:
  - the build is `SUCCESS`;
  - the log shows the 10 new `COPY`s and the installs of `duckdb` and `matplotlib`;
  - the build seconds, against the last phase 4 build.

  A failed build leaves the old deployment serving, so fix forward in the window.
- [ ] **Step 4:** Trigger `railway cron run --service nightly`, or wait for 07:15 UTC. Watch:
  - `step research-derive` day lines, newest first;
  - each report step `ok`, or `partial` during catch-up;
  - 0 `InsecureRequestWarning`;
  - Sentry check-ins;
  - the tape days landed and the seconds each took. Work out how many days a night lands (the 6,000–6,900 s window ÷ seconds per day) and add that figure to the README's first item (a docs-only commit; the README is not a watch path).

  In R2, verify by listing that each family has its `{session}/` objects and that `research/_logs/{session}/` holds 8 logs: the 7 subprocess steps plus quality-sim.
- [ ] **Step 5:** Fingerprint parity, read-only. For 3 days, `DAY_FINGERPRINT_SQL`'s md5 must equal the md5 part of the manifest entry, for both fire families.
- [ ] **Step 6:** Each night until `research-derive` `days_left` is 0, relay `days_derived`, `days_left` and the written counts. That is about 176 fire days plus the 100 chains days, sharing fetches: roughly 3–4.5 h of derive over 2–4 nights. The estimate assumes Step 1's precondition, so nothing else competes for the early part of the run.
- [ ] **Step 7:** Final checks, counts only:
  - the headlines' per-day rows equal the by-day object count;
  - the open-window section uses the ET heading;
  - `whale-plots` published 14 PNGs (13 if the latest session had no whales for plot 03);
  - `takeit_health_daily` has `ml_` rows for the session;
  - the feature audit, mining and lineage reports in R2 name the active version in their headers (`seed-2026-06-17` until phase 4 promotes), and the tracker's log names it.
- [ ] **Step 8:** Update memory:
  - `project_nightly_automation_goal`: phase 3 live; D5–D8; 24 watch paths; the pre-push guard; the open-window fix; the reports read the active weights;
  - `reference_eod_flow_data_archives`: by-day, rollup and headlines now live in R2 `research/eod-flow/`;
  - `feedback_keep_ml_plots_in_git`: the nightly plots go to R2 only, and `ml/plots/` stays tracked.

  Then tell the main session that phase 3 is complete: phase 4's Task 23 (promotion) waits for it. Report to the owner.

---

## Runtime and budget

These are phase 3's rows of phase 2's D2 budget table. Every `min_seconds` is a named constant (Task 8), and the tests assert on the constants (Task 10), never on a total.

| Step | Constant (`min_seconds`) | Tape day fetched inside it | Measured locally | Steady-state estimate on Railway |
|---|---|---|---|---|
| `research-derive` | `RESEARCH_DAY_BUDGET_SECONDS` 900 | once per stale day, up to 600 s of the 900 | 32 s compute per 5.8K-fire day, plus the fetch | 1–3 days × 60–90 s |
| `eod-flow-rollup` | `REPORT_BUDGET_SECONDS` 300 | none | 3.1 s (44 days) | ~15 s (144+ days) |
| `whale-plots` | `REPORT_BUDGET_SECONDS` 300 | none | 10.7 s | ~40 s |
| `exit-policy-report` | `LARGE_REPORT_BUDGET_SECONDS` 600 | none | 6.3 s pull + report | ~45 s |
| `flow-timing-report` | `LARGE_REPORT_BUDGET_SECONDS` 600 | none | similar | ~30 s |
| `feature-audit` | `REPORT_BUDGET_SECONDS` 300 | none | 26.4 s | ~45 s |
| `outcome-mining` | `REPORT_BUDGET_SECONDS` 300 | none | 8.9 s | ~15 s |
| `score-lineage` | `REPORT_BUDGET_SECONDS` 300 | none | 3.7 s | ~10 s |
| `lottery-tracking` | `REPORT_BUDGET_SECONDS` 300 | none | 18.3 s | ~30 s |
| `quality-sim` | `REPORT_BUDGET_SECONDS` 300 | none | 2.0 s | ~10 s |
| `takeit-drift` | `REPORT_BUDGET_SECONDS` 300 | none | 1.7 s | ~10 s |

- **This phase's reserve:** 4,500 s: 900 + 8 × 300 + 2 × 600.
- **All phases:** 7,500 s with `enrich-outcomes` at its 900 floor, and 8,400 s at its 1,800 cap (D2). Phase 4's `lottery-refit` (`REFIT_BUDGET_SECONDS`, 1,800) is in that sum and is unchanged here.
- **Fits the run:** phase 2's `test_deadline_constants_bound_the_run` asserts `reserve_seconds(STEPS) + 2 × DAY_BUDGET_SECONDS <= RUN_DEADLINE_SECONDS`. Worked from the constants at the cap, that is 8,400 + 7,200 = 15,600 ≤ 18,000. This plan restates no total in a test.
- **The tape's window shrinks again.** The tape stops at 9,600–10,500 s, and a day may start only in the first 6,000–6,900 s (D2's stage table, "After phase 3"). The tape still plans up to 30 days, so a long backlog takes more nights. Task 12 puts the window in the README and `CLAUDE.md`, and Task 16 Step 4 adds the measured days per night.
- **Two downloads of a day.** `enrich-outcomes` and `research-derive` each fetch a day with their own reader: up to 600 s each, 20 minutes in all in the worst case. The owner accepted it on 2026-11-06 (R2 egress is free) over folding the two steps together.
- **Steady state:** about 6–8 min a night.
- **Catch-up:** the first 2–4 nights are mostly `research-derive` (partial), once phase 2's backfill has finished (Task 16 Step 1).

## Reconciliation with other sessions' work

- **10-29 `da8fb0e7`** made `--parquet-dir` required, with a skip for missing days, in `exit_policy_search.py` and `flow_inversion_timing.py`. Task 2 keeps both and adds `--derived-dir`.
- **10-29 `2b18ffd5`** deleted the `backfill-alerts/` output, so there is no `backfill-alerts/` path to handle.
- **10-29 `c7871384`:** `online_ticker_update.py` trained on exchange single-leg fires. Phase 4's Task 16 deletes the script with the EMA (owner, 2026-11-06), so this phase has nothing to do with it.
  - `mine_outcome_patterns.py` and `score_lineage_audit.py` still filter `inferred_structure IS NULL`, a predicate whose meaning changed when the classifier was retired. Task 3b replaces it with phase 4's `SINGLE_LEG_FILTER` (D8). That is a methodology change to those reports, made with the repointing the owner ordered.
- **Phase 2's amendments (2026-11-06):** `load_env_file` is phase 2's Task 2b, so Task 2 touches no watch path. `lazy_step`, the budget table (D2) and the `DB_*` constants are phase 2's, and this phase's steps and subprocess env use them.
- **Phase 4's amendments (2026-11-06):** its Task 18 owns the `nightly/conftest.py` edit and its Task 20 the `PYTHONPATH` entry and the module-collision test, and its Task 21 owns `test_pipeline_order_and_reserve` and the `lottery-refit` registration. This phase adds none of the first three and extends the last (Task 10).
- **11-04 `b7a8a976`** ruff-formatted `ml/`. Task 4 keeps `ruff format --check` green.
- **tests-no-db** (`fix/2026-11-04-tests-no-db`, not on origin/main at `a02fef66`) blocks every botocore call in the `scripts/` and `ml/` conftests. Phase 3's R2 tests live in `nightly/` (moto, behind the socket guard) to stay clear of it.
- **`ml/src/utils/r2.py` now has a caller,** `ml/src/anchor_backfill_extract.py`. Phase 2's "delete it in phase 3" recommendation is withdrawn.
- **05-29 is in R2** (212 of 212 sessions), against phase 2's facts. Nothing special-cases it.
- **The weights JSON** (`ml/output/lottery_score_weights.json`, 06-17 retrain, `f9f220fa`) stays frozen as the seed's source (phase 4). The refit guard that held it is deleted (phase 4 Task 17). The four nightly reports no longer read it (Task 3b), so the image does not carry it.

## Spec deltas

1. **Incremental derive (D7) replaces full re-runs** for the two tape-replay reports and the chains. The report numbers are the same; the nightly tape reads drop from about 176 days to the new or changed days.
2. **`analyze.py`'s bot-eod CSV source is removed;** it reads only the tape.
   - Tape-built days carry all prints, like the old CSV (verified on 06-15).
   - Their `equity_type` is only ETF, Index or NULL, and `sector` is NULL.
   - The 44 seeded bot-eod days are kept as they are and never rebuilt.
3. **The open-window bug is fixed** (owner answer 1). The window was measured in the host's zone (CT on the Mac), so the "8:30–9:00 CT" headline has shown 13:30–14:00 CT on every run.
   - The window is now 09:30–10:00 ET, the label's intent.
   - Headline times are shown in CT explicitly.
   - Each night's rollup recomputes all of history, so every past day is corrected too, and every day's "%InOpen" changes (05-15 goes from 36 to 58).
4. **The drift monitor drops scikit-learn.** It uses an exact rank AUC (pinned to sklearn in a test), and its `utils` import moves into `main`. The image carries neither scikit-learn, scipy nor SQLAlchemy.
5. **Windows and dates follow the session:**
   - the drift monitor, `mine_outcome_patterns.py` and `score_lineage_audit.py` anchor their windows and dates to `--as-of` (the session), not to Neon's UTC `CURRENT_DATE` or the run's calendar date;
   - `takeit_health_daily` rows are dated by session, as the local evening runs effectively were;
   - the mining and lineage windows move by at most one day at the edge.
6. **Blob retirement deletes `ingest-flow.py`'s CDT window** along with the Blob copy that was its only user. The Bot-EOD archive write stays.
7. **`backfill-alerts/` is already gone** (10-29); no gitignore line is added.
8. **The by-day series still starts on 04-13** (owner answer 2). The tape fills 04-27, 04-28 and 06-17 onward.
9. **Script output** (full reports, tracebacks) lands only in private R2 `research/_logs/`. This is a new diagnostics family.
10. **The ticker-weight-history CSV is retired with the ticker EMA** (owner, 2026-11-06; the EMA moved 0 tickers in 115 sessions). The spec's Goal 4 lists the CSV and gets a dated note. This phase seeds, moves and publishes none, and phase 4 writes none.
11. **The four Neon reports read the active weights from phase 4's store** (Task 3b, D8), not the frozen JSON.
    - `feature_audit`'s T1/T2 split moves from the hard-coded 13/10 to the active `feed_cutoffs`; `daily_tracker` uses the active bare `cutoffs`.
    - **Methodology change:** mining and lineage swap `inferred_structure IS NULL` for `SINGLE_LEG_FILTER`, the population phase 4 trains on. The old predicate's meaning changed when the classifier was retired.
    - Before the first promotion the active weights equal the seed, so only that population change moves the reports' numbers.
12. **R2 scope:** the spec says listings read only `fulltape/`; the job now also reads and writes `research/`. It still never touches `gexbot-eod/`.
13. **Watch paths:** 24 in all: phase 2's 10, phase 4's 4 and this phase's 10, added to the list and never set over it (Task 16 Step 2). The weights JSON is not carried, because no nightly step reads it after Task 3b. A pre-push guard (owner answer 3) refuses pushes that would redeploy mid-run, and counts `.dockerignore` as an image path.
14. **Tracked files stay (owner, 2026-11-06).** The spec's "Row-level files stop being tracked in git" is not carried out.
    - The 23 tracked by-day parquets, `cumulative-rollup.json` and `cumulative-headlines.txt` stay where they are, as does the tracked `docs/tmp/lottery-tracking.csv`, frozen at 06-16. R2 holds the live copies.
    - The tracked PNGs in `ml/plots/whale-detection/` and `ml/plots/takeit-drift/` also stay (memory `keep-ml-plots-in-git`).
    - The anti-goal still holds for new outputs: the job never commits, and its outputs go to R2 only.
15. **The research-derive download is separate.** It does not reuse phase 2's enrich download of the same day, so the newest day is fetched twice a night (~1.1 GB extra; up to 600 s each, 20 minutes in all in the worst case). Accepted by the owner, 2026-11-06: R2 egress is free.
16. **The tape's catch-up window shrinks again.** After this phase a tape day may start only in the first 6,000–6,900 s of a run (D2's stage table), so "up to 30 days of catch-up" in one night is no longer reachable. The README and `CLAUDE.md` state the window (Task 12).

## Owner answers (2026-11-06)

1. **The open-window fix: yes.** The open-window section measures 09:30–10:00 ET (8:30–9:00 CT), as labelled, and history is recomputed. It had been showing 13:30–14:00 CT, so every day's "%InOpen" changes (05-15 goes from 36 to 58).
2. **The by-day series keeps 04-13.** 01-02 would add about 67 days and shift the rollup's top lists and the whale plots' p95 thresholds.
3. **The pre-push guard: yes** (Task 15). Git refuses a push that touches an image file between 07:15 and 12:30 UTC unless `NIGHTLY_PUSH_WINDOW_OK=1` is set. It covers `/.dockerignore` too (review S6).
4. **Seed the old dated reports: yes.** The roughly 150 dated reports and quality-sim CSVs from 05-05 → 06-16 (`docs/tmp`), plus the drift PNGs, go into R2. They exist only on this workstation.
5. **UW-derived files already tracked in the public repo: leave them.** That covers the 14 whale-detection PNGs, the drift PNGs, the by-day parquets, the rollup and the headlines. The owner said to ignore the question, so no task removes them (Task 14 is removed). The nightly job still never commits its outputs.

Also accepted by the owner on 2026-11-06, from the cross-phase review: each day is downloaded twice (`enrich-outcomes` and `research-derive`; R2 egress is free), and Task 16 does not start before phase 2's backfill has finished.

No output is recommended for dropping: with D7, all eleven steps together add about 6–8 minutes a night.

## Cross-phase dependencies

1. **Phase 2 (executes first, in full):**
   - D2's `Step`, `StepContext`, `run_steps`, `pipeline.STEPS`, `lazy_step` and the budget table; `report_step` in `monitoring.py` stays phase 2's, which is why this phase names its runner `run_report`;
   - D4's `connect_db` and the `DB_STATEMENT_TIMEOUT_MS` and `DB_CONNECT_TIMEOUT_SECONDS` constants;
   - D1's image layout and six-place rule, and the `.dockerignore` three-step pattern;
   - `scripts/_cli_paths.load_env_file` (Task 2b);
   - its backfill, finished before Task 16 (the "backfill finished" definition in its Task 15 Step 5).
2. **Phase 4, Tasks 1–22 (deployed before this phase starts):**
   - the store: `lottery_weights.load_pointer(conn, "active")`, `score_frame` and `SCORE_COLUMNS` in `ml/src/lottery_weights.py`; `lottery_scoring.SINGLE_LEG_FILTER`; the tables `lottery_score_versions` and `lottery_score_pointers`. Task 3b reads them;
   - the `lottery-refit` step, registered with `lazy_step` right after `outcome-check`, and `test_pipeline_order_and_reserve` in `nightly/tests/test_pipeline.py`. Task 10 extends that test;
   - Task 18's `nightly/conftest.py` edit, and Task 20's `PYTHONPATH` entry (`/app/ml/src` last) and `test_no_image_module_name_collides`. This phase adds none of them;
   - four watch paths (14 in all with phase 2's). Task 16 Step 2 adds this phase's 10 to the list and never sets it;
   - one refit step: phase 4 deletes the refit guard (its Task 17) and the ticker EMA (its Task 16), so nothing of them joins the image.
3. **What phase 4's Task 23 needs from this phase:** this phase complete and deployed, in particular Task 3b's repointing, so the reports follow the version a promotion activates. Task 16 Step 8 tells the main session.
4. **Data:** `takeit_health_daily` `ml_` rows are keyed by session date. Take-It's input stays pinned to the 06-17 weights, so the drift monitor is unaffected by a promotion.
