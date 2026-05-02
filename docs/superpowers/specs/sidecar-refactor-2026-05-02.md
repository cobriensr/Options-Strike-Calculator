# Sidecar Refactor — Databento futures ingestion service — 2026-05-02

## Goal

Eliminate **structural duplication** in `sidecar/` Python files and fix
two real correctness gaps. Pulled from a parallel-agent assessment of all
16 source files (~5,500 LOC) plus 12 test files (~5,500 LOC). Mirrors
the structure of [api-refactor-2026-05-02](api-refactor-2026-05-02.md),
[src-refactor-2026-04-30](src-refactor-2026-04-30.md), and
[daemon-refactor-2026-05-01](daemon-refactor-2026-05-01.md): smallest
safe wins first, then high-impact consolidation, then targeted cleanups.

The sidecar is in **good shape overall** — modern Python type-hint
discipline, ~1:1 source/test LOC ratio, sound psycopg2 patterns, no
leaky exception handling. The two real concerns are: (1) a SQL CTE
duplicated 5+ times across `archive_query.py` with **tiebreak drift
between sites** that risks ML feature pipeline divergence, and (2)
`databento_client.py` is a god-object mixing options + futures + connection
lifecycle. Most other findings are taste-level cleanups.

## Constraints

- **No production behavior change.** The sidecar runs continuously on
  Railway ingesting Databento data; refactors must not change ingestion
  cadence, DB write semantics, Sentry tagging, or API contract.
- **Front-month CTE consolidation requires resolving the tiebreak
  inconsistency.** TBBO uses `contract ASC`, OHLCV doesn't. Pick one,
  document the rationale, lock with a regression test against existing
  fixtures.
- **`databento_client.py` split must preserve callback wiring.** The
  Databento SDK delivers events via callbacks; refactoring across class
  boundaries can silently re-route which callback fires when. Verify by
  running existing tests and spot-checking with a fixture replay if
  feasible.
- **Test runner is `pytest`, not `vitest`.** Run `pytest sidecar/tests/`
  per phase; root `npm run review` does NOT execute Python tests.
- **No `.js` extension issue** — sidecar is its own Python package, no
  cross-codebase TypeScript imports.
- Each phase ≤5 files (CLAUDE.md `## Pre-Work`).
- Each phase ends with `pytest sidecar/tests/` + a code-reviewer
  subagent verdict before commit.
- Commit directly to `main` (per memory `feedback_direct_to_main.md`).
- New code must ship with tests (per memory `feedback_always_test.md`).

## Files to create (new shared modules)

```
sidecar/src/_sql/front_month.py            # _front_month_cte() SQL builder
sidecar/src/_processors/batched_writer.py  # BatchedWriter[T] base class
sidecar/src/_routing/options_router.py     # OptionsRecordRouter (extracted)
sidecar/src/_routing/stat_handler.py       # STAT_TYPE_TO_KWARG table
sidecar/scripts/probe_live_access.py       # moved from sidecar root
sidecar/scripts/probe_cfe_access.py        # moved from sidecar root
```

(The `_sql/`, `_processors/`, `_routing/` package layout is one option;
flat `sidecar/src/front_month.py` etc. is also fine. Pick whichever keeps
the existing test imports stable.)

## Files to modify (consumers)

```
sidecar/requirements.txt                   # drop dead twilio dep
sidecar/src/main.py                        # env validation order fix
sidecar/src/archive_query.py               # adopt _front_month_cte (5+ sites)
sidecar/src/databento_client.py            # split + adopt STAT table
sidecar/src/quote_processor.py             # adopt BatchedWriter
sidecar/src/trade_processor.py             # adopt BatchedWriter
sidecar/src/db.py                          # _execute_values_batch helper
sidecar/src/health.py                      # route helper extraction
sidecar/src/theta_fetcher.py               # _fetch_strike_pair extraction
sidecar/src/theta_launcher.py              # typed dataclass for _state
sidecar/src/sentry_setup.py                # _apply_scope helper
```

## Phases

### Phase 1 — Critical correctness fixes + housekeeping (smallest, safest)

These are the highest-ROI-per-LOC items: small fixes for real bugs +
trivial dead-code removal.

**1a. `main.py` env validation order** (1 file + tests)

- Current: Theta launcher starts BEFORE the required env-var check
  (`DATABASE_URL` / `DATABENTO_API_KEY`). If env is missing, Theta runs
  for nothing then the sidecar dies — wasted Railway compute + confusing
  logs.
- Fix: validate required env at top of `main()`, fail fast, then start
  subsystems in dependency order.
- Add a test for the early-exit path.

**1b. Twilio dependency removal** (1 file)

- `twilio>=9.0.0` in `requirements.txt` is dead — alert engine removed
  2026-04-08 per `main.py` and `trade_processor.py` headers.
- Remove the line. Confirm no transitive imports remain.

**1c. Probe scripts move** (≤4 files)

- Move `sidecar/probe_live_access.py` and `sidecar/probe_cfe_access.py`
  to `sidecar/scripts/`.
- Not imported by any production or test code; preserved as ops runbooks
  via their docstrings.
- Update any documentation that references the old paths.

### Phase 2 — Front-month CTE consolidation (HIGH IMPACT)

**Goal:** One source of truth for front-month-contract resolution.
Resolves the latent tiebreak inconsistency that risks ML pipeline drift.

**2a. Create `_front_month_cte()` SQL builder** (≤3 files)

- New module `sidecar/src/_sql/front_month.py` (or flat
  `sidecar/src/front_month.py`).
- Function signature: `front_month_cte(symbol_root: str, date_filter_sql: str, *, ts_column: str = 'ts_event', tiebreak: Literal['none', 'contract_asc'] = 'none') -> str`
- Returns a parameterized SQL fragment producing a CTE chain
  `filtered → contract_volume → front_contract → fb`.
- Comprehensive docstring explaining each parameter + the tiebreak
  decision rationale.
- Add unit tests verifying SQL string output for each parameter
  combination (snapshot-style assertions on the SQL fragment).

**2b. Adopt in 5+ `archive_query.py` sites + resolve tiebreak** (≤2 files)

- Adopt in: `analog_days` (~L290-320), `day_features_batch` (~L784-817),
  `day_summary_batch` (~L908-935), `day_summary_prediction_batch`
  (~L1034-1060), `tbbo_ofi_percentile` (~L1421-1448).
- **Decide the tiebreak**: pick `contract ASC` (TBBO's current behavior)
  or no-tiebreak (OHLCV's). Default in plan: **`contract_asc`** to
  maintain TBBO compatibility, since OHLCV's no-tiebreak path is
  deterministic in practice given the volume tiebreak earlier in the
  CTE.
- Add a regression test that fires each adopted query against a known
  fixture and asserts the result is unchanged from the legacy version
  (capture pre-refactor output, lock as snapshot).
- Existing 1229-LOC `test_archive_query.py` should pass unchanged for
  the chosen tiebreak.

### Phase 3 — `databento_client.py` decomposition

**Goal:** Split the god-object so the implicit options-vs-futures fault
line becomes explicit.

**3a. STAT_TYPE_TO_KWARG dict** (1 file + tests)

- Replace `_handle_stat` (~L708-797, 90-LOC if/elif chain) with a
  `STAT_TYPE_TO_KWARG: dict[int, str]` mapping each stat type to the
  `upsert_options_daily(...)` kwarg name. The handler becomes ~15 LOC.
- Existing tests for `_handle_stat` MUST PASS unchanged.
- Add a test that locks the dict (each stat type → expected kwarg) so
  adding a new stat type forces a deliberate map update.

**3b. Split `OptionsRecordRouter` off `DatabentoClient`** (≤4 files)

- Extract `OptionsRecordRouter` owning `_option_definitions`,
  `_options_strikes`, `_definition_lag_drops`, `_handle_trade`,
  `_handle_stat`, `_handle_definition`. ~150 LOC moves out.
- `DatabentoClient` retains: connection lifecycle, futures-bar / TBBO /
  system / reconnect, ATM strike management, prefix→internal symbol
  resolution.
- The 16-field `__init__` shrinks substantially.
- Existing tests in `test_databento_client.py` (874 LOC) MUST PASS
  unchanged — split must preserve callback wiring exactly.
- Add a focused `test_options_router.py` for the new module.

### Phase 4 — Shared infrastructure

**4a. `BatchedWriter[T]` base class** (≤3 files)

- New `sidecar/src/_processors/batched_writer.py` (or flat).
- Generic `BatchedWriter[T]` provides: `_buffer: list[T]`, `_lock`,
  `add(item)`, `_flush_unlocked()`, `start_background_flush(interval_s)`,
  `stop()`. Subclasses override `_write(rows: list[T]) -> None`.
- `quote_processor` and `trade_processor` adopt it. Differences become
  explicit (trade_processor opts into time-based flush; quote_processor
  doesn't).
- Existing tests for both processors MUST PASS unchanged.
- Add tests for the base class covering: buffer growth, lock-then-IO
  ordering, background flush cadence, stop drains buffer.

**4b. `db.py` `_execute_values_batch` helper** (1 file + tests)

- Extract the verbatim pattern from `batch_insert_options_trades`,
  `batch_insert_top_of_book`, `batch_insert_trade_ticks`,
  `upsert_theta_option_eod_batch`:
  ```python
  if not rows:
      return
  with get_conn() as (conn, cur):
      execute_values(cur, sql, rows, page_size=500)
  ```
- New helper: `_execute_values_batch(sql: str, rows: list[tuple], page_size: int = 500) -> None`.
- Promote `page_size=500` to module constant `_DEFAULT_BATCH_PAGE_SIZE`.

### Phase 5 — Targeted cleanups (low priority)

**5a. `health.py` route helper extraction** (1 file + tests)

- 10× near-identical `_handle_archive_*` skeleton: parse_qs → urlparse →
  fullmatch YYYY-MM-DD → optional int → archive_query call →
  ValueError→404 → BLE001→500.
- Extract `_parse_date_param(qs, name)`, `_parse_int_range(qs, name, lo, hi)`,
  and a `_run_archive_query(qs, query_callable, *parsers)` shell.
- Promote `366 * 3` (3-year cap) to module-level `_BATCH_RANGE_MAX_DAYS`.
- Lazy-import `archive_query` once at module level via a holder.

**5b. `theta_fetcher.py` `_fetch_strike_pair` extraction** (1 file)

- `_fetch_root_range` (~99 LOC) has nested `exp × strike × {C,P}`
  loops. Extract `_fetch_strike_pair(client, root, exp, strike, ...)`
  helper. The per-contract retry/skip logic becomes unit-testable.

**5c. `theta_launcher.py` typed `_state` dataclass** (1 file)

- Module-level `_state: dict[str, Any]` becomes a typed dataclass (or
  `TypedDict`) so typos like `_state["shutdwn"]` fail at type-check time.

**5d. `sentry_setup.py` `_apply_scope` helper** (1 file)

- `capture_exception` and `capture_message` share their scope-and-tags
  block. Extract `_apply_scope(scope, tags, context)` to halve the
  duplication.

**5e. `db.py` `load_alert_config` silent fallback investigation** (1 file)

- Currently `except Exception: return {}` — silently masks config drift.
- Investigate: is empty config what callers actually want? Or should
  this propagate?
- Decision: either keep with a Sentry capture before the swallow, or
  propagate. Document either way.

### Verification (always last)

- `pytest sidecar/tests/` — clean.
- `cd sidecar && python -m pytest` — alternative invocation.
- Manual smoke: `cd sidecar && python -m src.main` (with env vars set)
  for ~30 seconds; confirm Sentry has no new errors.
- Final code-reviewer subagent on the full diff.

## Open questions

- **Q1: Front-month tiebreak default.** The plan picks `contract_asc`.
  Alternative: no-tiebreak. Decision affects ML feature pipeline if
  there's ever a tie that the volume CTE doesn't already break. **Going
  with**: `contract_asc` as the conservative default; add test that
  exercises a tied-volume case to verify the choice.
- **Q2: Package layout** — `_sql/`, `_processors/`, `_routing/` subdirs
  vs flat `sidecar/src/`. **Going with**: flat for now (matches existing
  layout); promote to subdirs only if a third file in each group
  emerges.
- **Q3: BatchedWriter generic vs concrete.** Generic `BatchedWriter[T]`
  lets the row type be expressive; concrete `BatchedWriter` with `Any`
  is simpler. **Going with**: generic — Python type-hints are already
  modern in this codebase.
- **Q4: `OptionsRecordRouter` ownership.** The router needs a reference
  back to `DatabentoClient` for symbol resolution. Should it hold a
  weak ref, a callback, or just take what it needs as constructor args?
  **Going with**: constructor args (most testable, no circular ref).
- **Q5: `db.py load_alert_config` fallback decision.** Need a one-pass
  read to decide whether silent-fallback is intentional. Default if
  unclear: keep silent fallback, add `sentry.capture_message` so
  drift is observable.

## Thresholds / constants to name

- `_BATCH_RANGE_MAX_DAYS = 366 * 3` (health.py — 3-year cap, ×3 sites)
- `_DEFAULT_BATCH_PAGE_SIZE = 500` (db.py — ×4 sites)
- `_DATABENTO_SHUTDOWN_SLEEP_S = 0.2` (databento_client.py L923)
- `_THETA_FETCHER_TAGS = {"component": "theta_fetcher"}` (theta_fetcher
  already has this; theta_launcher missing)

## Skip / defer

- **Symbol manager rename** — file is misnamed (mostly pure functions,
  no manager state) but renaming is churn for cosmetic gain. Skip.
- **`build_es_option_symbols` placeholder usage** — assessment flagged
  it as possibly orphaned. Defer; investigate only when next touching
  symbol_manager.
- **Modernizing logger_setup hardcoded extras allowlist** — small
  smell, not worth a phase.
- **Theta-file factoring** — `theta_fetcher`, `theta_launcher`,
  `theta_client` are 3 files for one external system but they're cleanly
  factored (subprocess + HTTP wire + orchestration). Don't combine.

## Done when

- All Phase 1-5 sub-tasks committed to `main`. ✅
- `pytest sidecar/tests/` green. ✅ (364 passed)
- Final code-reviewer subagent verdict = `pass`. ✅ (after 2 small
  final-review fixups landed)
- No production regressions observed in Sentry / Railway logs in the
  24h after the last commit lands.

## Outcome

Shipped phases (in commit order; 16 commits total):

| Phase | Commit    | Title                                                       |
| ----- | --------- | ----------------------------------------------------------- |
| plan  | b8a0dceb  | Plan doc                                                    |
| 1a    | 0e482b17  | main.py validate env BEFORE Theta launches                  |
| 1b    | b9fabe47  | Drop dead twilio dependency                                 |
| 1c    | 78f22856  | Move probe scripts to sidecar/scripts/                      |
| 2a    | 5e190059  | front_month_cte SQL builder + 19 tests                      |
| 2b    | 6c3bd2a2  | Adopt in 4 archive_query sites; standardize tiebreak        |
| 3a    | 0addf040  | STAT_TYPE_TO_KWARG dict (90 LOC if/elif → 25 LOC)           |
| 3b    | a1d2ba62  | Split OptionsRecordRouter off DatabentoClient (-129 LOC)    |
| 4a    | 146bd127  | BatchedWriter[T] base for quote/trade processors            |
| 4b    | 89cee6ef  | _execute_values_batch helper (4 callers)                    |
| 5a    | ed092a03  | health.py route helpers + named batch-range constant        |
| 5b    | bba0f044  | theta_fetcher `_fetch_strike_pair` extraction               |
| 5c    | 2315968e  | theta_launcher typed `_LauncherState` dataclass             |
| 5d    | 83ed6fde  | sentry_setup `_apply_scope` helper                          |
| 5e    | e19ea9ec  | load_alert_config Sentry observability + UndefinedTable     |
| 5.fu  | 41f3629f  | Final-review fixes: proc:Popen type + drop env Twilio block |

**Final at HEAD:**

- 13 source files modified, 7 new (front_month, batched_writer,
  options_router, plus their tests)
- Source LOC: +1,435 / −856 = **+579 net** (gain dominated by JSDoc
  and new helpers; consumer files all shrank — `databento_client.py`
  942 → 813, `archive_query.py` -56)
- Test LOC: +1,891 / -13 = **+1,878 net** (~169 new test cases)
- Tests: **364 passed** in 4.74s (baseline was 268 → grew through
  each phase)
- 16 commits; final code-reviewer verdict: pass

## Optional follow-up candidates (not blockers)

- **`analog_days` front-month CTE** — Phase 2b excluded it because the
  CTE chain (`es_bars / day_front / front_only / per_day / window_closes
  / path / target`) is structurally different from the canonical
  `filtered → contract_volume → front_contract → fb` shape the builder
  produces. A wider builder API could accommodate it; not worth a
  standalone phase, but if a future contributor extends `front_month_cte`
  for new callers, fold `analog_days` in then.
- **`_lock` compatibility shim in `quote_processor`** — accesses
  `self._tob_writer._lock` (a private base attribute) for backward-compat
  with existing concurrency tests. Acceptable transitional state.
  Worth removing once the legacy concurrency tests in
  `test_quote_processor.py` are rewritten to inspect the inner writers
  directly.
- **`logger_setup` hardcoded extras allowlist** — tiny smell, not worth
  a phase on its own; fold into the next edit that touches the logger.
