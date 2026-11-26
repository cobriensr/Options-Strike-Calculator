# Interval B/A tape rebuild and live corrections: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interval B/A alerts get sweep and floor flags that mean something, an SPXW spot on every row, and the stretches the live feed never covered filled from the Full Tape. No live write is ever deleted or recomputed.

**Architecture:** One Python replay of today's live detector, `nightly/src/interval_ba_replay.py`, runs DuckDB over the Full Tape. It imports nothing from nightly's own modules, and two things use it:

- the one-off tool `scripts/interval_ba_tape.py`, run from the workstation over R2 with httpfs. Its modes are verify, rebuild, heal, export and undo.
- the nightly step `interval-ba-tape`, which runs on the downloaded day each morning.

uw-stream gets the flag fix and records its detector settings at each start. The banner poll stops returning past days.

**Tech Stack:**

- Python 3.12 (uw-stream, nightly) and Python 3.14 in `ml/.venv` (the tool, the scripts tests);
- DuckDB 1.5.x, psycopg2, asyncpg (uw-stream), boto3 (R2);
- TypeScript on Vercel Functions, React 19;
- Vitest and pytest.

**Spec:** `docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md` (owner-approved 2026-11-24). Also read these two (gitignored, so in the main checkout only):

- `F:\dev\strike-calculator\docs\tmp\interval-ba-rebuild-2026-11-24\detector-spec.md`. Its §2.1 reference query is validated, and §1–§4 are the detector rules.
- `F:\dev\strike-calculator\docs\tmp\interval-ba-rebuild-2026-11-24\tape-facts.md`: tape layouts and pitfalls.

## Global Constraints

- **Live rows.** A row with `source = 'live'` is never DELETEd. The only columns ever UPDATEd on one are `top_trade_is_sweep` and `top_trade_is_floor`, plus `underlying_price` on an SPXW row where it is NULL. `acknowledged` is never written on any row.
- **Detector constants (spec §9):**
  - ratio: `4 × ask ≥ 3 × total`;
  - floor: `total ≥ 25,000,000` cents;
  - bucket: 300 s on the UTC epoch;
  - multi-leg share: `2 × ml < total`;
  - multi-leg codes: `mlat, mlet, mlft, masl, mesl, mfsl, mlct, cbmo, mctp`;
  - confluence: backward 0–90 s, inclusive at both ends, same option type, other tickers.
- **Dates:**
  - `LIVE_START = date(2026, 5, 13)`;
  - `INSERT_MISSED_FROM = date(2026, 10, 29)`;
  - the rebuild days are the trading days 2026-01-02..2026-05-12, 2026-05-13 before its first live row, 2026-07-22 after its last live row, and 2026-07-23..2026-09-04.
- **Flags.** Sweep means `'intermarket_sweep'` is in the top trade's `report_flags`; floor means `'futures_floor'` is. Test membership, never equality.
- **Times leave DuckDB as `epoch_us` integers** and become aware UTC `datetime`s in Python. Never fetch a `TIMESTAMP` or `TIMESTAMPTZ` column: the nightly image has no `pytz`.
- **0DTE** means `expiry = CAST(to_timestamp(epoch(executed_at)) AT TIME ZONE 'America/Chicago' AS DATE)`.
- **Contracts.** Scan `underlying_symbol IN ('SPXW','SPY','QQQ','SPX')` (pushdown), then keep rows by OCC root: `left(option_chain_id, length(option_chain_id) - 15)` in `('SPXW','SPY','QQQ')`. Never use `[:-15]`.
- **DB writes:**
  - batches of 500 (`psycopg2.extras.execute_values`, `page_size=500`, and `fetch=True` whenever there is a `RETURNING`);
  - one transaction per day, with autocommit off;
  - inserts use `ON CONFLICT (option_chain, bucket_start) DO NOTHING`;
  - `confluence_tickers` is passed as a Python `list`, never a tuple. A tuple adapts to a row constructor, not a `TEXT[]`.
- **Tool time windows.** The tool refuses to write on weekdays from 08:15 to 16:00 CT, and on every day from 07:15 to 12:30 UTC. It checks both before the run and again before each day's write. `--allow-market-hours` overrides only the first window.
- **Pushes:**
  - uw-stream after 15:00 CT;
  - `nightly/src/**` after 15:00 CT and outside 07:15–12:30 UTC;
  - Vercel any time.

  The controller pushes; implementers never push.
- **Each task touches at most 5 files,** and its tests ship in the same commit.
- **No test touches a database, R2 or any non-loopback host.** The `nightly/`, `uw-stream/` and `scripts/` conftests block them. Patch at the module boundary (R3).
- **Never print** `DATABASE_URL`, an `R2_*` value, an endpoint or a bucket name.
- **Python** for the replay, the tool and the nightly step (owner, Q1).

## Review Focus

1. **The DST shift on the naive tape layout.** On 2026-03-09, the first EDT session in the naive `TIMESTAMP` layout, prints at 13:30Z get CT date 2026-03-09 and land on the UTC 300 s bucket grid. (Task 5, `test_naive_layout_after_dst_start`.)
2. **DOUBLE price noise.** A `DOUBLE` price of `0.05` (really 0.05000000000000000277) gives exactly 500 cents per contract, and a bucket at exactly 75% still fires. (Task 5, `test_double_price_noise_is_exact_cents`.)
3. **A settings change mid-session.** A second live boot during the session counts as a covering row. If its codes differ, the day's inserts are held. (Task 6, `test_mid_day_boot_with_other_codes_holds_inserts`.)
4. **A tape that re-lands after the day was healed.** The nightly clears the day's marker and redoes the day (Task 10, `test_relanded_day_marker_cleared_and_redone`). The redo removes replay rows the new tape no longer fires and keeps every live row (Task 6, `test_stale_replay_rows_removed_live_rows_kept`).
5. **A rebuilt day over the feed's 500-row cap.** A day with more than 500 alerts between 08:30 and 15:00 CT is flagged in `report.md`, and the dry run exits 1. (Task 7, `test_rebuild_dry_run_flags_a_day_over_500`.)

---

## Setup (controller, before Task 1)

- [ ] **Create the worktree.** `.worktrees/interval-ba-rebuild`, off `origin/main`, on branch `feat/interval-ba-rebuild`. Run `npm ci` in it.
- [ ] **Commit the two docs.** Copy the spec and this plan into the worktree. Commit them as `docs(interval-ba): Design and plan for the tape rebuild and live corrections`, after a passing `npm run review`.
- [ ] **Make sure the worktree's `nightly/.venv` has duckdb.** Install with `uv pip install -r nightly/requirements.txt -r nightly/requirements-dev.txt --python nightly/.venv/Scripts/python.exe`, per memory.
- [ ] **Ruling (ledger): confluence partners.** A tape row's confluence is computed over the day's complete replay fire set, all three tickers. That includes tape fires whose key has a live row (detector-spec §4.3 item 4). Live rows themselves are never partners. This is what the spec means by "the tape fires being written".
- [ ] **Ruling (ledger): loading the replay module.** The tool loads it with `importlib.util.spec_from_file_location("interval_ba_replay", <repo>/nightly/src/interval_ba_replay.py)`. It then sets `sys.modules["interval_ba_replay"] = module` **before** `spec.loader.exec_module(module)`. Without that step, `@dataclass` under `from __future__ import annotations` fails (probed on Python 3.14). Nightly's own folder never goes on `sys.path`.
- [ ] **Ruling (ledger): the R6 conflict key.** uw-stream's settings key `booted_at` is set once per process at import. A retry reuses it, so it is a stable key, not a per-attempt `now()`.

---

### Task 1: uw-stream reads sweep and floor from `report_flags`

**Files:**
- Modify: `uw-stream/src/handlers/interval_ba.py` (`:332`, `:339-340`, `:695-697`)
- Modify: `uw-stream/tests/test_interval_ba.py` (`:78-107` `_payload()`, `:156`, `:763-786`, `:1176`, `:1289-1301`, `:1620`, `:1676`)
- Modify: `uw-stream/tests/fixtures/interval_ba_sample.json`

**Interfaces:**
- Produces: `_has_flag(flags: Any, name: str) -> bool`, true only when `flags` is a list containing `name`. `_has_tag` is deleted.

- [ ] **Step 1: Write the failing tests.** `_payload()` gains `report_flags: list[str] | None = None`, which writes `payload["report_flags"]`.

```python
def test_sweep_comes_from_report_flags_not_tags():
    # tags carry no sweep marker, report_flags=["intermarket_sweep"] -> sweep True, floor False
def test_sweep_tag_alone_is_not_a_sweep():
    # tags=["ask_side","bullish","sweep"], report_flags=[] -> sweep False
def test_two_value_report_flags_set_both():
    # report_flags=["intermarket_sweep","futures_floor"] -> sweep True, floor True
@pytest.mark.parametrize("flags,name,expected", [...])
def test_has_flag(flags, name, expected):
    # replaces test_has_tag: None, "x", [], ["a"], ["intermarket_sweep"]
```

  Then update the existing tests and fixture:
  - `:156` and `:763-786` send `report_flags` instead of a `sweep` or `floor` tag.
  - The payloads at `:1176`, `:1620` and `:1676` drop the made-up `sweep` tag.
  - The fixture moves the marker to `"report_flags": ["intermarket_sweep"]`.
- [ ] **Step 2: Run them and see them fail.** From `uw-stream/`: `python -m pytest tests/test_interval_ba.py -q`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** At `:332`, read `report_flags = payload.get("report_flags") if isinstance(payload, dict) else None`. Set `is_sweep=_has_flag(report_flags, "intermarket_sweep")` and `is_floor=_has_flag(report_flags, "futures_floor")`.
- [ ] **Step 4: Run uw-stream's whole suite.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `fix(uw-stream): Read the Interval B/A sweep and floor flags from report_flags, where UW sends them`.

### Task 2: The banner poll returns only today's alerts

**Files:**
- Modify: `api/interval-ba-alerts.ts:223`
- Test: `api/__tests__/interval-ba-alerts.test.ts`

**Interfaces:**
- Produces: the `since` query's WHERE becomes `a.fired_at > ${since} AND a.expiry = ${today}`, with the same `today = getETDateStr(new Date())` as `:188`.

- [ ] **Step 1: Write the failing test.** `it("limits the since query to today's ET expiry")`: the `since` branch's SQL contains `a.expiry =` and binds `today`. The COALESCE assertions at `:234-270` stay.
- [ ] **Step 2: Run it.** `npx vitest run api/__tests__/interval-ba-alerts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the WHERE change. Add a comment: past-day rows (rebuilt or tape-added) must never reach the chime.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `fix(interval-ba): Keep the banner poll's cursor query to today's alerts`.

### Task 3: Migration for `source` and the two new tables

**Files:**
- Modify: `api/_lib/db-migrations.ts` (the next free id; the highest was 211 on 2026-11-24)
- Modify: `api/__tests__/db.test.ts`

**Interfaces:**
- Produces:
  - `interval_ba_alerts.source TEXT NOT NULL DEFAULT 'live'`, with a CHECK on `('live','replay')`;
  - the tables `interval_ba_live_settings` and `interval_ba_tape_days`, exactly as in spec §6.2, column names verbatim;
  - the statement `UPDATE ... SET source = 'replay' WHERE expiry < DATE '2026-05-13'`.

- [ ] **Step 1: Update `db.test.ts` first,** per CLAUDE.md "DB Migrations". The expected-output line is `#N: interval_ba source column, live settings and tape days tables`.
- [ ] **Step 2: Run it.** `npx vitest run api/__tests__/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add the migration.** One `statements:` migration holding spec §6.2's five statements in order: the column, the CHECK, the `UPDATE`, then the two `CREATE TABLE`s.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(db): Add interval_ba_alerts.source and the live-settings and tape-days tables`.
- [ ] **Step 6 (controller, after the push deploys):** apply the migration.
  1. Check for other sessions' unapplied migrations.
  2. Apply with `scripts/migrate-db.ts`.
  3. Read back with the read-only Neon MCP: the 17,893 rows with `expiry < 2026-05-13` say `replay`, and the rest say `live`.

### Task 4: uw-stream records its detector settings at start

**Files:**
- Modify: `uw-stream/src/handlers/interval_ba.py`
- Test: `uw-stream/tests/test_interval_ba.py`

**Interfaces:**
- Consumes: `interval_ba_live_settings` (Task 3, applied before this deploys).
- Produces:
  - **`_PROCESS_STARTED_AT = datetime.now(UTC)`,** set at import.
  - **`_live_settings_row(settings) -> tuple`,** in the table's column order:
    - `booted_at`;
    - `enabled`;
    - `tickers`: `sorted(t for t in settings.interval_ba_tickers if f"option_trades:{t}" in <the subscribed channel set config.py exposes>)`;
    - `ratio_threshold`, `premium_floor`, `window_sec`, `multi_leg_share_max`;
    - `multi_leg_codes`: `sorted(_MULTI_LEG_CODES)`;
    - `confluence_window_sec`.
  - **Module flags `_settings_recorded: bool` and `_settings_failure_reported: bool`.** No lock: `ON CONFLICT (booted_at)` makes a double write harmless.

- [ ] **Step 1: Write the failing tests.**

```python
async def test_first_flush_records_live_settings_once():
    # two handlers flush twice each -> one successful insert into "interval_ba_live_settings",
    # conflict_cols ("booted_at",), values = settings + sorted codes + 90
async def test_tickers_are_the_sorted_subscribed_enabled_ones():
    # interval_ba_tickers {SPY,SPXW,QQQ}, channels without option_trades:QQQ -> ["SPXW","SPY"]
async def test_settings_are_recorded_even_when_the_detector_is_off():
    # interval_ba_enabled False -> row written with enabled False
async def test_a_failed_settings_write_is_reported_once_and_retried_quietly():
    # insert raises on three flushes -> sentry_setup.capture_exception called once;
    # raw-tick flush and alert insert still happen; the fourth flush's success sets the flag
```

  The tests patch `sentry_setup.capture_exception`, which is what `interval_ba.py:54` uses. They don't patch `sentry_sdk`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** in `IntervalBAHandler._flush`, before the alert insert:
  - while `_settings_recorded` is False, write the row with `db.bulk_insert_ignore_conflict(table="interval_ba_live_settings", columns=..., rows=[row], conflict_cols=("booted_at",))`;
  - on an exception, report it only if `_settings_failure_reported` is False, then set that flag;
  - set `_settings_recorded` only on success.
- [ ] **Step 4: Run uw-stream's suite.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(uw-stream): Record the Interval B/A detector settings once per process start`.

### Task 5: The replay module: `replay_day`, `top_trade_flags` and `insert_alerts`

**Files:**
- Create: `nightly/src/interval_ba_replay.py`
- Create: `nightly/tests/test_interval_ba_replay.py`
- Create: `nightly/tests/test_interval_ba_drift.py`
- Modify: `.github/workflows/ci.yml`:
  - the `nightly` paths filter gets `uw-stream/src/config.py`, `uw-stream/src/handlers/interval_ba.py` and `uw-stream/src/handlers/recent_fires.py`;
  - the `ml` filter (`:69-80`) gets `nightly/src/interval_ba_replay.py`.

**Interfaces.** Everything below lives in `interval_ba_replay`, which imports only `duckdb`, `psycopg2`, `psycopg2.extras` and the standard library.

- Constants:
  - `TICKERS = ("SPXW", "SPY", "QQQ")`;
  - `RATIO_THRESHOLD = Decimal("0.75")`, `PREMIUM_FLOOR_DOLLARS = 250_000`, `WINDOW_SEC = 300`, `MULTI_LEG_SHARE_MAX = Decimal("0.5")`;
  - `MULTI_LEG_CODES: frozenset[str]`, the nine codes;
  - `CONFLUENCE_WINDOW_SEC = 90`, `LIVE_START`, `INSERT_MISSED_FROM`.
- `@dataclass(frozen=True) class TapeAlert`, with these fields in this order:

  ```
  option_chain, ticker, option_type ('C'|'P'), strike: Decimal, expiry: date,
  bucket_start, bucket_end, fired_at: datetime (aware UTC, ms),
  ratio_pct, ask_premium, total_premium: Decimal, trade_count: int,
  top_trade_premium: Decimal, top_trade_size: int, top_trade_executed_at: datetime,
  top_trade_is_sweep, top_trade_is_floor: bool,
  underlying_price: Decimal | None, confluence_tickers: tuple[str, ...]
  ```

  plus a property `key -> (option_chain, bucket_start)`.
- `ALERT_INSERT_COLUMNS: tuple[str, ...]`: the fields above, then `source`.
- `@dataclass(frozen=True) class Replay`, with `alerts: tuple[TapeAlert, ...]` sorted by `(fired_at, ticker, option_chain)`, and `root_label_mismatch: int`. The second field counts kept rows whose `underlying_symbol` differs from their root.
- `replay_day(con: duckdb.DuckDBPyConnection, tape: str, day: date) -> Replay`.
- `@dataclass(frozen=True) class LiveRow`, with `id, option_chain, ticker, bucket_start, fired_at, trade_count, ratio_pct, ask_premium, total_premium, top_trade_premium, top_trade_size, top_trade_executed_at, top_trade_is_sweep, top_trade_is_floor, underlying_price, source`.
- `top_trade_flags(con, tape: str, day: date, rows: Sequence[LiveRow]) -> dict[int, tuple[bool, bool] | None]`.
- `insert_alerts(cur, alerts: Sequence[TapeAlert]) -> int`, which returns the rows inserted. It calls `execute_values` with `page_size=500` and `fetch=True`, uses `ON CONFLICT (option_chain, bucket_start) DO NOTHING RETURNING id`, and writes `source='replay'` with `confluence_tickers` as a `list`.

- [ ] **Step 1: Write a fixture builder in the test file.** `_write_tape(tmp_path, rows, *, layout: Literal["naive", "tz"]) -> str` writes a parquet file with DuckDB `COPY`.
  - **The naive layout:** `executed_at TIMESTAMP`, prices as `DECIMAL(18,4)`, and `tags` and `report_flags` as bare comma strings.
  - **The tz layout:** `TIMESTAMPTZ`, `DOUBLE`, and brace-wrapped strings.
  - **The columns:** `executed_at, option_chain_id, underlying_symbol, expiry, price, size, tags, report_flags, upstream_condition_detail, underlying_price, canceled`.
- [ ] **Step 2: Write the failing tests.** Each runs on both layouts unless its name says otherwise.

  The detector rules:
  - `test_floor_exactly_250k_fires`, `test_floor_one_cent_short_does_not`
  - `test_ratio_exactly_75_percent_fires`
  - `test_multi_leg_share_exactly_half_does_not_fire`
  - `test_crossing_tick_can_be_a_bid_and_spot_comes_from_it`
  - `test_canceled_ticks_count`
  - `test_top_trade_tie_goes_to_earliest`
  - `test_bucket_frozen_after_fire`
  - `test_bucket_boundary_14_34_59_999_vs_14_35`

  Which rows the scan keeps:
  - `test_spx_root_and_non_0dte_rows_excluded`
  - `test_spxw_rows_labelled_spx_are_kept_and_counted`: `root_label_mismatch` is 1 and the alert still fires.

  Dates, money and times:
  - `test_naive_layout_after_dst_start` (Review Focus 1)
  - `test_double_price_noise_is_exact_cents` (Review Focus 2)
  - `test_ratio_rounds_half_even_and_spot_half_up`
  - `test_times_are_aware_utc_ms`

  Flags, spot and confluence:
  - `test_sweep_and_floor_from_two_value_report_flags`, `test_sweep_tag_alone_is_false`
  - `test_spxw_opening_seconds_spot_forward_fills`
  - `test_confluence_backward_asymmetric_90s_in_90_001s_out`: A gets `[]`, B gets `[A]`, C gets `[A,B]`.
  - `test_top_trade_flags_match_on_ms_size_premium`, `test_top_trade_flags_disagreeing_matches_give_none`

  The insert:
  - `test_insert_alerts_uses_fetch_true_and_lists` (patched `execute_values`). It asserts `fetch=True` and `page_size=500`, and that every `confluence_tickers` value passed is a `list`. It also checks `psycopg2.extensions.adapt(['SPY']).getquoted()` starts with `ARRAY[`.
  - `test_insert_alerts_counts_rows_across_pages`: 501 alerts give a count of 501.

  The suite runs under `nightly/.venv`, which has no `pytz`, so a column fetched as a timestamp fails the run.
- [ ] **Step 3: Write the drift test.** It reads three files from `REPO_ROOT` as text, with regexes and no imports from uw-stream:
  - `uw-stream/src/config.py`: the defaults for `interval_ba_ratio_threshold`, `interval_ba_premium_floor`, `interval_ba_window_sec` and `interval_ba_multi_leg_share_max`;
  - `uw-stream/src/handlers/interval_ba.py`: `_MULTI_LEG_CODES` and `_CONFLUENCE_WINDOW_SEC`;
  - `uw-stream/src/handlers/recent_fires.py`: the backward, inclusive window test.

  It asserts each one equals the module's constant.
- [ ] **Step 4: Run them.** From `nightly/`: `python -m pytest tests/test_interval_ba_replay.py tests/test_interval_ba_drift.py -q`. Expected: FAIL.
- [ ] **Step 5: Implement `replay_day`** from detector-spec §2.1:
  - window functions over `(chain, bucket)`, ordered by `executed_at, file_row_number`;
  - integer cents throughout;
  - rounding and confluence in Python with `Decimal`;
  - times selected as `epoch_us(...)`.

  Then implement `top_trade_flags` and `insert_alerts`.
- [ ] **Step 6: Run nightly's whole suite,** including `test_image_layout.py` for module-name uniqueness. Expected: PASS.
- [ ] **Step 7: Commit** after `npm run review`: `feat(nightly): Add the Interval B/A tape replay of today's live detector, with a drift test against uw-stream`.

### Task 6: `heal_day`, `live_spot` and the settings check

**Files:**
- Modify: `nightly/src/interval_ba_replay.py`
- Create: `nightly/tests/test_interval_ba_heal.py`
- Create, if it keeps both test files small: `nightly/tests/_interval_ba_tape.py`, the shared `_write_tape` builder moved out of Task 5's test file

**Interfaces:**
- Consumes: Task 5's `replay_day`, `Replay`, `top_trade_flags`, `insert_alerts`, `LiveRow` and `TapeAlert`.
- Produces:
  - **The settings type and its readers:**
    - `@dataclass(frozen=True) class LiveSettings`: `booted_at, enabled, tickers: tuple[str, ...], ratio_threshold: Decimal, premium_floor: Decimal, window_sec: int, multi_leg_share_max: Decimal, multi_leg_codes: frozenset[str], confluence_window_sec: int`;
    - `default_settings() -> LiveSettings`: the module's constants, all three tickers, `enabled`, and `booted_at=None`;
    - `read_covering_settings(conn, day: date) -> list[LiveSettings]`: the latest row with `booted_at` before the day's 00:00 CT, plus every row during the day. It returns `[]` only before the first row ever written.
  - **Live rows and their spot:**
    - `read_live_rows(conn, day: date) -> list[LiveRow]`;
    - `live_spot(con, tape: str, day: date, rows: Sequence[LiveRow]) -> dict[int, Decimal | None]`, for SPXW rows only.
  - **`@dataclass(frozen=True) class DayPlan`**, with:
    - `day` and `root_label_mismatch`;
    - the counts, named after the `interval_ba_tape_days` columns: `tape_alerts, live_rows, live_missed, live_only, value_mismatched, inserted, inserts_held: str | None, removed, flags_changed, flags_unmatched, spot_filled`;
    - `matched: int`;
    - the write lists: `inserts: tuple[TapeAlert, ...]`, `removes: tuple[int, ...]`, `flag_updates: tuple[tuple[int, bool, bool], ...]`, `spot_updates: tuple[tuple[int, Decimal], ...]`;
    - `sha256: str`, over a canonical JSON of the four write lists;
    - `to_json() -> dict` and `from_json(d) -> DayPlan`, so the tool can store the write lists.
  - **`heal_day(conn, con, tape: str, day: date, settings: Sequence[LiveSettings], *, insert_missed: bool, apply: bool) -> DayPlan`:**
    - It raises `ValueError` for `day < LIVE_START`.
    - When `insert_missed` is False, settings are not consulted, and the "on tickers" are all three.
    - When it is True and settings are `[]`, the inserts are held with `'no live settings record'`.
  - **The hold-reason strings, exactly:** `'no live settings record'`, `'live settings differ from the tape rule'`, `'live detector off'`.

- [ ] **Step 1: Write the failing tests.** Patch psycopg2 at the boundary.

  The dry run and what may be written:
  - `test_dry_run_writes_nothing_and_sha_is_stable`
  - `test_updates_touch_only_flags_and_null_spxw_spot_on_live_rows`: each SQL text names only those columns, `source = 'live'` and SPXW; no DELETE names a live id.

  `live_spot`:
  - `test_live_spot_uses_trade_count_th_tick_counting_canceled`
  - `test_live_spot_falls_back_to_asof_when_bucket_is_short`
  - `test_live_spot_forward_fills_opening_seconds`
  - `test_live_spot_ignores_spy_and_qqq_rows`

  Inserts and the settings check:
  - `test_insert_missed_false_inserts_nothing_and_counts_all_three_tickers`
  - `test_held_without_settings_record`, `test_held_when_codes_differ`, `test_held_when_detector_off`: each still plans the flags and spot.
  - `test_ticker_off_in_settings_is_not_inserted_or_counted`
  - `test_mid_day_boot_with_other_codes_holds_inserts` (Review Focus 3)
  - `test_outage_day_with_no_live_rows_is_not_held`

  Removals:
  - `test_stale_replay_rows_removed_live_rows_kept` (Review Focus 4)
  - `test_empty_replay_removes_nothing`

  Errors and bounds:
  - `test_db_error_mid_day_rolls_back_and_writes_no_marker` (R4): commit is never called, rollback is called, and the error propagates.
  - `test_day_before_live_start_is_refused`
  - `test_dayplan_json_round_trips`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement spec §6.4 steps 1–7 in one transaction.**
  - Set `conn.autocommit = False` and restore the old value in `finally`.
  - Upsert the `interval_ba_tape_days` row last.
  - `live_spot` follows spec §6.3:
    1. tick number `trade_count` of the bucket, in tape order (`executed_at, file_row_number`), counting canceled ticks;
    2. if that tick has no spot, the opening-seconds forward fill;
    3. if the bucket has fewer ticks than `trade_count`, as-of at `fired_at`.
- [ ] **Step 4: Run nightly's suite.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(nightly): Add the per-day Interval B/A tape pass over live rows (flags, SPXW spot, missed alerts, settings check)`.

### Task 7: The tool, part 1: `verify`, run folders, backup and `rebuild`

**Files:**
- Create: `scripts/interval_ba_tape.py`
- Create: `scripts/test_interval_ba_tape.py`

**Interfaces:**
- Consumes:
  - `interval_ba_replay`, loaded by file location (Setup ruling);
  - `ml/src/utils/r2.py`: `fulltape_connection(threads=4, memory_limit="3000MiB")` and `r2_url(day)`.
- Produces:
  - **`main(argv: list[str] | None = None) -> int`.** Exit codes: 0 ok, 1 error or failed check, 2 bad arguments, 3 refused.
  - **Subcommands** `verify`, `rebuild`, `heal`, `export` and `undo`. `heal`, `export` and `undo` exit 2 with "not yet" until Task 8.
  - **The run folder,** `docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/`. It holds:
    - `plan.json`: per day and ticker, the counts and the day's sha256, plus the module and tool git blob hashes and `root_label_mismatch`;
    - `days/<day>.json`: each day's full write lists, as `DayPlan.to_json()` or the rebuild equivalent;
    - `report.md`: counts per day, and before/after per ticker and month;
    - `backup.jsonl` and `<day>.applied` markers.
  - **Helpers** `new_run(mode) -> Path` and `load_plan(run) -> dict`.
  - **`take_backup(conn, run, r2) -> Path`.** It writes `backup.jsonl` and reads it back. It uploads to R2 at `backups/interval-ba-alerts/<stamp>.jsonl` with `sha256` and `rows` metadata, then checks that metadata with a HEAD.

- [ ] **Step 1: Write the failing tests.** Patch psycopg2, DuckDB and boto3.

  `verify`:
  - `test_verify_is_read_only`
  - `test_verify_reports_root_label_mismatch`

  The rebuild's day list:
  - `test_rebuild_refuses_days_outside_its_list`
  - `test_rebuild_on_05_13_inserts_only_before_first_live_row_and_skips_live_twins`: a tape twin of the first live row is skipped and listed in `report.md`, and the run does not stop.
  - `test_rebuild_on_07_22_inserts_only_after_last_live_row_and_skips_live_twins`
  - `test_rebuild_never_deletes_a_live_row`: the DELETE carries `source = 'replay'`.
  - `test_rebuild_stops_on_live_row_collision_on_a_full_rebuild_day`
  - `test_rebuild_dry_run_flags_a_day_over_500` (Review Focus 5)
  - `test_report_has_before_after_per_ticker_and_month`

  Apply and resume:
  - `test_apply_refuses_expect_mismatch`
  - `test_resume_counts_only_unapplied_days`
  - `test_apply_refuses_changed_module_hash`
  - `test_day_already_in_end_state_is_marked_and_skipped_before_the_sha_check`
  - `test_apply_stops_when_a_days_fresh_sha_differs`

  Backup:
  - `test_backup_readback_failure_stops_before_any_write`
  - `test_r2_metadata_mismatch_stops_before_any_write`
  - `test_resume_takes_no_new_backup`

  Windows and secrets:
  - `test_refuses_weekday_0815_to_1600_ct`
  - `test_refuses_0715_to_1230_utc_even_with_allow_market_hours`
  - `test_window_rechecked_before_each_days_write`: a run that enters the window mid-way stops before the next day.
  - `test_never_prints_secrets`
- [ ] **Step 2: Run them.** From the repo root with `ml/.venv`: `python -m pytest scripts/test_interval_ba_tape.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** spec §6.5, "Run folders, plans and applies" steps 1–6, plus the `rebuild` day list, windows and collision handling. Per day, the order is:
  1. the end-state check, which writes the marker and skips the day if it holds;
  2. the fresh-sha check;
  3. the window check;
  4. the transaction;
  5. the marker.

  It reads `DATABASE_URL` and `R2_*` from `.env.local` without printing them.
- [ ] **Step 4: Run the scripts tests.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(scripts): Add the Interval B/A tape tool: verify, backed-up runs and the rebuild of the never-live days`.

### Task 8: The tool, part 2: `heal`, `export` and `undo`

**Files:**
- Modify: `scripts/interval_ba_tape.py`
- Modify: `scripts/test_interval_ba_tape.py`

**Interfaces:**
- Consumes:
  - Task 6's `heal_day`, `DayPlan`, `default_settings` and `read_covering_settings`;
  - Task 7's run-folder and backup helpers.
- Produces:
  - **`heal --from D --to D [--assume-default-settings]`.** On `--apply` it takes `--expect-insert`, `--expect-remove`, `--expect-flags` and `--expect-spot`.
    - Before 10-29, `insert_missed` is False.
    - From 10-29, it is True, with the day's covering settings.
    - The flag supplies `[default_settings()]` only for a day whose covering list is empty.
  - **`export --from D --to D`.** It writes a parquet file to R2 at `research/interval-ba/replay-<to>.parquet`, and a copy to the run folder.
    - The schema is the `TapeAlert` fields in order:
      - text: `option_chain`, `ticker`, `option_type` VARCHAR;
      - numbers: `strike` DECIMAL(10,3); `ratio_pct` DECIMAL(5,2); `ask_premium`, `total_premium`, `top_trade_premium` DECIMAL(14,2); `underlying_price` DECIMAL(10,2) NULL; `trade_count`, `top_trade_size` INTEGER;
      - dates and times: `expiry` DATE; `bucket_start`, `bucket_end`, `fired_at`, `top_trade_executed_at` TIMESTAMPTZ in UTC, written from epoch microseconds;
      - the rest: `top_trade_is_sweep`, `top_trade_is_floor` BOOLEAN; `confluence_tickers` VARCHAR[].
    - The R2 metadata holds `sha256`, `rows`, the module's blob hash and the rule constants.
  - **`undo --run <folder>`.** It uses the run's `days/<day>.json` write lists to restore exactly what the run wrote.

- [ ] **Step 1: Write the failing tests.**

  `heal`:
  - `test_heal_refuses_day_before_live_start`
  - `test_heal_insert_missed_only_from_10_29`
  - `test_assume_default_settings_applies_only_to_uncovered_days`: a covered day in the same run uses its own row.
  - `test_heal_apply_checks_expect_totals_and_fresh_sha`

  `export`:
  - `test_export_writes_no_neon_row_and_records_hash_and_constants`
  - `test_export_schema_matches_the_named_columns_and_types`

  `undo`:
  - `test_undo_rebuild_day_restores_replay_rows_with_original_ids`
  - `test_undo_heal_day_restores_flags_and_spot_only_where_unchanged_since`
  - `test_undo_heal_day_deletes_only_the_replay_rows_it_inserted`
  - `test_undo_never_deletes_or_reinserts_a_live_row`
  - `test_undo_touches_only_the_runs_applied_or_end_state_days`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** per spec §6.5 (`heal`, `export`, `undo`).
- [ ] **Step 4: Run the scripts tests.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(scripts): Add heal, export and undo to the Interval B/A tape tool`.

### Task 9: Retire the three old Interval B/A scripts

**Files:**
- Delete: `scripts/backfill_interval_ba_alerts.py`
- Delete: `scripts/backfill_confluence_tags.py`
- Delete: `scripts/scrub_interval_ba_multileg.py`
- Modify: `scripts/README.md`: every line naming them
- Modify: `scripts/test_fulltape_parquet_dir.py`: the import at `:23`, the parametrize entry at `:53`, and the cases from `:115` on that test it

- [ ] **Step 1: Check the references.** Run `git grep -n "backfill_interval_ba_alerts\|backfill_confluence_tags\|scrub_interval_ba_multileg" -- ':!docs'`. Every hit must be in the files above; anything else stops the task and comes back as NEEDS_CONTEXT.
- [ ] **Step 2: Delete and edit.** Run the scripts tests. Expected: PASS.
- [ ] **Step 3: Commit** after `npm run review`: `chore(scripts): Retire the old Interval B/A backfill, confluence-tag and scrub scripts the tape tool replaces`.

### Ops step A (controller, read-only): parity

- [ ] **Push Tasks 1–9 through their windows.** Task 3's migration is applied before Task 4 is pushed.
- [ ] **Run the parity check** in the background: `ml/.venv/Scripts/python.exe scripts/interval_ba_tape.py verify --from 2026-10-29 --to 2026-11-23`. It must meet spec §8.2:
  - from 11-13, an exact match, except value differences at a same-microsecond tie (spec §8.2, owner 2026-11-25);
  - before 11-13, per session, ≤ 5% of rows differing in value and ≤ 2 keys differing, each one listed.

  Its `root_label_mismatch` total is reported to the owner either way. Anything over the limits stops the work and goes to the owner.

### Ops step B (controller, with the owner's go at each write): the production run

- [ ] **Run spec §8.3 steps 1–8 in order.**
  - Each dry run's `report.md` goes to the owner.
  - Each hand check goes to the owner in plain words, with one row each.
  - Each `--apply` waits for an explicit go.
  - Step 4 is one `heal` run with `--assume-default-settings`, which supplies the defaults only on days with no covering row.
- [ ] **Record in memory:** the run folders, the R2 backup keys, and the before/after counts.

### Task 10: The nightly step `interval-ba-tape`

**Files:**
- Create: `nightly/src/interval_ba_step.py`
- Create: `nightly/tests/test_interval_ba_step.py`
- Modify: `nightly/src/pipeline.py`. Add `lazy_step("interval-ba-tape", "interval_ba_step", INTERVAL_BA_DAY_BUDGET_SECONDS)` right after `outcome-check`.
- Modify: `nightly/src/constants.py`. Add `INTERVAL_BA_DAY_BUDGET_SECONDS = 900`, `INTERVAL_BA_MAX_DAY_FAILURES = 3`, `INTERVAL_BA_CACHE_DIR = WORK_DIR / "interval-ba"`, `INTERVAL_BA_DUCKDB_MEMORY` and `INTERVAL_BA_DUCKDB_THREADS = 2`.
- Modify: `nightly/tests/test_pipeline.py`. Update the order list, the reserve sum (now 8,400) and the (step, constant) table. Add `test_the_registered_interval_ba_tape_runs_interval_ba_step`.

**Interfaces:**
- Consumes:
  - from Task 6: `heal_day`, `DayPlan`, `read_covering_settings`, `INSERT_MISSED_FROM`;
  - from nightly: `StepContext` and `StepResult` (`steps.py`), `open_reader` and `connect_db` (`resources.py`), `TapeReader.fetch_day`, `release` and `landed_days`, and `calendar_nyse.trading_days`.
- Produces:
  - **`run(ctx: StepContext) -> StepResult`.** Its counts are `days_done, days_failed, days_left, days_waiting_tape, inserted, flags_changed, spot_filled, health_alerts`.
  - **`_report_health(day: date, plan: DayPlan) -> bool`.** It sends at most one `sentry_sdk.capture_message(level="error", tags={"service": "nightly", "step": "interval-ba-tape", "day": iso}, fingerprint=["interval-ba-live-health", phrase, iso])`. The phrase is the first of these that applies:
    1. `plan.inserts_held`;
    2. `"tape fired no alerts"`, when `tape_alerts == 0 and live_rows > 0`;
    3. `"live wrote no alerts"`, when `tape_alerts > 0 and live_rows == 0`;
    4. `"live missed alerts"`, when `live_missed >= 5 and live_missed * 10 > tape_alerts`;
    5. `"live and tape rows disagree"`, when either `matched >= 20 and value_mismatched * 20 > matched`, or `live_only >= 5 and live_only * 10 > live_rows`.

- [ ] **Step 0 (controller): set the DuckDB memory limit.** Read the nightly service's memory limit with the Railway MCP (`get-service-config` / `get-service-metrics`, both read-only). Set `INTERVAL_BA_DUCKDB_MEMORY` to the smaller of a quarter of it and `"2000MiB"`. Put the value in the brief and in a constants comment.
- [ ] **Step 1: Write the failing tests,** in the `test_enrich_step.py` style: a fake clock, with `open_reader`, `connect_db`, `heal_day`, `read_covering_settings` and `sentry_sdk` patched.

  The work list:
  - `test_work_list_is_trading_days_from_insert_missed_from_newest_first`
  - `test_skips_days_with_a_marker`
  - `test_day_without_tape_waits_without_alert`: `days_waiting_tape` counts it.
  - `test_relanded_day_marker_cleared_and_redone` (Review Focus 4)
  - `test_held_day_keeps_its_marker`

  The loop:
  - `test_one_connection_per_day_after_download`
  - `test_failing_day_does_not_stop_others`
  - `test_failure_cap_of_three_fails_the_step`
  - `test_deadline_leaves_partial_with_days_left`
  - `test_duckdb_limits_and_temp_dir_set`

  The health alerts:
  - `test_one_health_message_per_day_by_precedence`: one case per phrase.
  - `test_health_message_sent_even_when_days_left_or_a_day_failed`
  - `test_no_exception_text_in_detail`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Copy the loop shape of `enrich_step._enrich_days` (`enrich_step.py:259-302`).
  - **Work list:** `calendar_nyse.trading_days(INSERT_MISSED_FROM, ctx.last_session)`, minus days that have an `interval_ba_tape_days` row, newest first.
    - Days not in `reader.landed_days()` are counted in `days_waiting_tape` and wait.
    - Days that `ctx.tape` lists as `landed` or `relanded` have their marker deleted first.
  - **Per day:**
    1. fetch the tape;
    2. open a fresh DuckDB connection (limits, threads, `temp_directory`) and a fresh `connect_db()`;
    3. `heal_day(..., insert_missed=True, apply=True)`;
    4. `_report_health`;
    5. `release` the tape.
- [ ] **Step 4: Run nightly's whole suite,** including `test_main.py::test_deadline_constants_bound_the_run`. Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `feat(nightly): Add the interval-ba-tape step: correct live Interval B/A rows from the tape, add missed alerts, alert on live gaps`.

### Task 11: Nightly docs

**Files:**
- Modify: `nightly/README.md`:
  - the intro and the step list;
  - the reserve table and arithmetic. The sum becomes `900 + 300 + 900 + 1,800 + 900 + 8 × 300 + 2 × 600 = 8,400`, "fourteen" becomes "fifteen", and the pace figures are recomputed;
  - the `DATABASE_URL` writers paragraph;
  - the alert table, with the three hold reasons and four phrases;
  - line 1404.
- Modify: `CLAUDE.md`:
  - line 3;
  - the nightly block's step list and Neon writers;
  - the "6,900 s ... 6,000 s at the enrich budget's cap" numbers.

- [ ] **Step 1: Edit.** Use the `agents-md` skill for the CLAUDE.md wording. Recompute every number from `constants.py`.
- [ ] **Step 2: Commit** after `npm run review`: `docs(nightly): Describe the interval-ba-tape step, its Neon writes, alerts and the new reserve`.
- [ ] **Step 3 (controller): push.** Push Tasks 10 and 11 together, after Ops step B, after 15:00 CT and outside 07:15–12:30 UTC.
- [ ] **Step 4 (controller): check the next morning's run.** The step reports `ok`, and the new session has a row in `interval_ba_tape_days`.

### Task 12: UI copy and the spot caption

**Files:**
- Modify: `src/components/IntervalBAFeed/IntervalBARow.tsx:392-398`
- Modify: `src/components/IntervalBAFeed/IntervalBAFeed.tsx:13`, `:114-119`
- Modify: `src/__tests__/IntervalBARow.test.tsx:386,391`
- Modify: `src/__tests__/IntervalBAFeed.test.tsx:153`

- [ ] **Step 1: Write the failing tests.**
  - The caption reads `spx`, `spy` and `qqq` on SPXW, SPY and QQQ rows.
  - The header contains the spec §6.7 copy verbatim.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The caption is `alert.ticker === 'SPXW' ? 'spx' : alert.ticker.toLowerCase()`.
  - The header copy is verbatim from spec §6.7, including the Q2 clause.
  - Drop "6,851 backfilled rows" from the file comment.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `fix(interval-ba): Caption the spot with the row's own ticker, and say where the history comes from`. The controller pushes it after Task 10 is live.

### Task 13: The outcome script reads R2 and either source

**Files:**
- Modify: `scripts/enrich_interval_ba_outcomes.py`
- Create: `scripts/test_enrich_interval_ba_outcomes.py`

**Interfaces:**
- Consumes: `ml/src/utils/r2.py`, and the `export` parquet schema named in Task 8.
- Produces:
  - a `--source table|export` flag;
  - the tape read from R2;
  - SPXW chosen by OCC root;
  - t=0 at the last print at or before `fired_at`.

- [ ] **Step 1: Write the failing tests** on a small local parquet.
  - `test_t0_is_last_print_at_or_before_fired_at`
  - `test_spxw_selected_by_occ_root_not_underlying_symbol`
  - `test_reads_the_table_or_the_export_schema`
  - `test_rows_with_null_spot_are_skipped_only_when_the_tape_has_none`
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The output files and columns stay unchanged. A header comment names the t=0 change as a methodology change.
- [ ] **Step 4: Run the scripts tests.** Expected: PASS.
- [ ] **Step 5: Commit** after `npm run review`: `fix(scripts): Read the Interval B/A outcome tape from R2, anchor t=0 at the alert, and read the table or the full-year export`.
- [ ] **Step 6 (controller): regenerate the outcome CSVs.** After Ops step B, regenerate them with both sources. Move the old CSVs into `docs/tmp/interval-ba-outcomes-pre-rebuild/`.

---

## Order and pushes

| Task | Push window | Waits for |
|---|---|---|
| 1 | after 15:00 CT | — |
| 2 | any time | — |
| 3 (+ apply) | any time | other sessions' pending migrations checked |
| 4 | after 15:00 CT | 3 applied |
| 5, 6 | nightly window | — |
| 7, 8, 9 | any time | 5, 6 |
| Ops A | — | 1–9 pushed, 4 deployed |
| Ops B | — | Ops A passed; the owner's go at each write |
| 10, 11 | nightly window | Ops B, 4 deployed |
| 12 | any time | 10 live |
| 13 | any time | Ops B |

Tasks run one implementer at a time, in this order. Each task gets a task review. The whole branch gets a final review on the most capable model before the last push.

## What the plan review changed (2026-11-24)

**Two blockers fixed:**
- **Edge-day collisions.** On 05-13 and 07-22, keys that already have a live row are now skipped and listed instead of stopping the run. Only full-rebuild days stop on a collision.
- **`insert_alerts`.** It now passes lists, not tuples, for `TEXT[]`, and uses `fetch=True` so counts past 500 rows come out right.

**Loading and settings:**
- **Module registration.** The module is registered in `sys.modules` before `exec_module`.
- **The settings row's `tickers`.** It is sorted and reflects `WS_CHANNELS`.
- **Failure reporting.** A failed settings write is reported once per process, and the plan patches `sentry_setup`.
- **No asyncio lock.**
- **`--assume-default-settings`.** It applies per day, only where no covering row exists, and an empty settings list counts all three tickers.

**Tool runs:**
- **Run folder.** Each day's full write lists are stored in it.
- **Resume order.** The end-state check runs before the sha check.
- **Time windows.** They are checked again before each day's write.
- **The report.** It carries counts per ticker and month.

**Replay and nightly:**
- **The scan.** It includes `SPX` labels, keys on the OCC root, and reports `root_label_mismatch`.
- **Health phrases.** Two were added: "tape fired no alerts" and "live and tape rows disagree".
- **An empty replay** removes nothing.
- **The nightly work list** is built from the NYSE calendar, so `days_waiting_tape` counts.
- **The Review Focus 4 test** is split between the step and `heal_day`.
- **`live_spot`** covers SPXW rows only.

**Smaller fixes:**
- **The export schema** is named for Task 13.
- **The migration id** is now "the next free one".
- **R6.** The safe `booted_at` key is noted.

## As built (2026-11-25)

What the build changed from the tasks above. Everything else stands as written.

- **Task 6, `heal_day`'s signature.** It gained `expect_sha256: str | None = None` and raises `PlanChanged` (a `ValueError`) before any write when a fresh plan's sha256 differs from it, on a dry run too. The tool passes the plan's sha256 on apply (Task 7).
- **Task 6, the settings cover.** `read_covering_settings` returns the latest row booted before the day's 00:00 CT plus every row booted before 16:00 CT that day, not "every row during the day": SPXW 0DTE prints end at 15:59 CT, so a change deployed after the close belongs to the next session.
- **Task 6, the detector-off hold.** `'live detector off'` holds the inserts when `enabled` is false in any covering row, so a row that was replaced later the same day still holds the day. The held reasons are checked in this order: no record, another rule, detector off.
- **Task 6, removals.** The remove keeps a replay row someone acknowledged (`NOT a.acknowledged`), counted in `acknowledged_kept`.
- **Task 10, the image import checks.** `interval_ba_step` and `interval_ba_replay` joined the built-image import in `.github/workflows/ci.yml` and `IMAGE_IMPORT_CHECK` in `nightly/tests/test_image_layout.py` in Task 10, not later: `lazy_step` defers the import, so a bad one would otherwise show only at 07:15.
- **Task 10, the health counts.** They go in the `interval_ba_day` Sentry context, not extras: the SDK keeps only the first 10 extras, and the day has 13 counts.
- **Task 11, the reserve at the enrich cap.** The step takes the reserve to 8,400 s and the tape window to 6,000 s, as planned. The plan and the spec give only that case. At the enrich budget's 1,800 s cap they are 9,300 s and 5,100 s, so a 30-day catch-up no longer fits one night at the median pace (about 25 days). `nightly/README.md` has the arithmetic.
