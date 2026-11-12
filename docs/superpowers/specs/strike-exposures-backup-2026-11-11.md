# strike_exposures backup: implementation plan (2026-11-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `strike_exposures` a real backup: one Parquet file per session day in the private R2 bucket. Export every stored day now, and from then on export each new day every night. The table is about 96 % rows that exist nowhere else.

**Architecture:**
- One Python module, `scripts/strike_exposures_backup.py`. It reads one day in a single read-only REPEATABLE READ snapshot, keyset-paging on the table's unique key, and writes an exact-typed Parquet file.
- It uploads that file to `backups/strike_exposures/<date>.parquet` and verifies the upload. It decides which days need work from the objects already in R2 plus an id high-water mark.
- Phase A runs it by hand: the one-time history export, plus `verify` and `restore`.
- Phase B registers the same module as a step in the Railway `nightly` service. That waits until nightly phase 2, which brings Neon access and the step runner, is on main.

**Tech stack:** Python 3.12, psycopg2 2.9.11, pyarrow 23.0.1, boto3 1.43.x. These are the `ml/.venv` pins, and nightly phase 2 pins the same psycopg2 and pyarrow. Tests use pytest under `scripts/conftest.py`, which blocks every real DB connect and every boto3 call.

**Evidence and owner decisions:**
- Database facts: `docs/tmp/live-data-integrity-2026-11-06/strike-exposures-backup-db-facts.md`.
- Re-derive verdict: `docs/tmp/live-data-integrity-2026-11-06/strike-exposures-backup-uw-rederive.md`.
- Both files are gitignored, so their key numbers are copied below.
- Owner, 2026-11-11: back the table up for real. Run the daily export in the `nightly` service. Keep every file.

## Why

- **Size.** 74.17M rows, 20.17 GiB in Neon, 179 dates from 2026-01-12 on, with a gap from 07-23 to 09-07. About 1.05M rows per trading day, flat since June:
  - Friday: 2.7M to 3.6M rows;
  - Monday and Wednesday: 0.72M to 1.0M;
  - Tuesday and Thursday: 0.35M to 0.48M.
- **It was never backed up.** The weekly `backup-tables` cron dies on it, and the 2026-11-11 fix drops it from that job.
- **It can't be re-derived.** UW's REST history is one end-of-day book per date. The per-minute websocket rollup series from 05-15 on (about 71.3M rows) and the 5-minute cron snapshots from 03-25 on (about 2.7M) exist only in this table. The websocket source table is deleted at 12:00 UTC the next day.
- **It is insert-only.** All 7 writers use `ON CONFLICT DO NOTHING`, and `pg_stat_user_tables` shows 0 updates and 0 deletes. A past day can still gain rows after its first night, from a late rollup, `rescue-rollup-ws-gex-strike-expiry.mjs` or a backfill script. So a day's file is replaced when its day gains rows.

## Phases

| Phase | Ships | Size | Blocked on |
| --- | --- | --- | --- |
| A | `scripts/strike_exposures_backup.py` with `export`, `status`, `verify` and `restore`, plus tests. Then the one-time export of every stored day. | 3 code tasks and 1 run | nothing |
| B | A `nightly` step that exports each new session and changed days every night, plus a weekly full count check. | 1 to 2 tasks | nightly phase 2 on main (`feat/nightly-phase2`, another session) |

Phase A alone is a complete backup that someone has to re-run by hand. Phase B removes the "by hand".

## Files

**Phase A:**
- Create `scripts/strike_exposures_backup.py`: the module and CLI (`main(argv)`).
- Create `scripts/test_strike_exposures_backup.py`: the tests. Run them with `ml/.venv/Scripts/pytest scripts/test_strike_exposures_backup.py -q`. CI runs `scripts/test_*.py`.
- Modify `docs/superpowers/specs/strike-exposures-backup-2026-11-11.md` (this file): add the run log for Task 4.

**Phase B** (sketch; plan it in full once phase 2 is on main):
- `nightly/src/steps.py` registry, or a new `nightly/src/strike_exposures_step.py`.
- `nightly/Dockerfile`, plus the 6-place file-set rule written at the top of that Dockerfile on the phase 2 branch.
- `nightly/README.md` and the tests.

## Data dependencies

- **New:** the R2 prefix `backups/strike_exposures/` in the existing bucket (`R2_BUCKET_FULLTAPE`). It sits beside `fulltape/`, `gexbot-eod/` and `backups/lottery-flow-inversion/`. Nightly's tape listing reads only `fulltape/`, so it never sees these keys.
- **New:** one state object, `backups/strike_exposures/_state.json`.
- **No migration and no new env var.**
  - Phase A reads `DATABASE_URL` and `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_FULLTAPE` from `.env.local`, through `scripts/_cli_paths.load_env_file`.
  - Phase B uses the env nightly phase 2 already has.
- **Neon load.** A full export reads about 74M rows, roughly 3,700 pages of 20,000. Run it outside 13:00 to 23:00 UTC, to stay clear of market hours and the 22:30 UTC rollup.

## Global constraints

- **Exact values.** NUMERIC must become Parquet `decimal128` with the column's own precision and scale: `strike` and `price` are (10,2), and the 16 greek columns are (30,4). Never float. timestamptz becomes `timestamp[us, tz=UTC]`. `date` and `expiry` become `date32`.
- **Ids are kept.** A restore re-inserts the original ids.
- **One snapshot per day.**
  - Each day is read inside `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`. Its `count(*)` comes from the same snapshot.
  - Every read in a snapshot goes through the private context manager `_read_snapshot(conn)` (Task 1). It refuses a connection that is not idle, because a BEGIN inside an open transaction is only a server WARNING and the read would silently run in the caller's transaction. It turns autocommit on for the BEGIN and puts the caller's setting back after the ROLLBACK, on success and on failure. If the connection dropped (`conn.closed`), it sends no ROLLBACK and restores nothing, so the `OperationalError` that explains the failure reaches the caller. Used by one thread per connection.
  - A written row count that differs from that count is an error, and nothing is uploaded.
  - Every statement runs with `SET LOCAL statement_timeout = '60s'`.
- **Paging.**
  - Keyset on the unique key, in index order: `WHERE date = %s AND ("timestamp", ticker, strike, expiry) > (%s, %s, %s, %s) ORDER BY date, "timestamp", ticker, strike, expiry LIMIT %s`.
  - The first page drops the row comparison.
  - Never OFFSET, and never `LIMIT` without the `ORDER BY`: that combination becomes a Seq Scan and times out on a Friday.
- **Which days.**
  - Only dates before today's ET date. Today's rows are never exported until the session is over and the next run comes.
  - A date with 0 rows is skipped, not exported.
- **Uploads are verified.**
  - `upload_file` (one thread, as nightly's `R2Store`), then `head_object`. The upload counts only if `ContentLength` equals the local file size and the object metadata `rows` equals the snapshot count. An object that fails that check is deleted, so a key that exists means a day that verified.
  - `_state.json` is written only after every day in the run has verified, and only by a run that did everything that was due: not with `--date`, not when `--limit-days` left days undone, not with `--dry-run`.
- **Object metadata.** Keys `rows`, `min-id`, `max-id`, `sha256` (of the file), `exported-at` (ISO UTC) and `format` (`"1"`). Values are ASCII only.
- **No secrets.** Never print a secret or a connection string, and never put a cell value in an error. Logs carry dates, counts, byte sizes and durations.
- **R2 client.** One boto3 client per thread (memory `boto3-shared-client-tls`). Phase A is single-threaded.
- **Restore.**
  - Default is `--dry-run`. Writes need `--apply`.
  - It inserts in batches of 500 rows with `INSERT ... ON CONFLICT (date, "timestamp", ticker, strike, expiry) DO NOTHING` and the original `id` and `created_at`. It never UPDATEs or DELETEs. The conflict target is the unique key and nothing else, so a restored row whose `id` is already taken by a different row raises instead of being skipped silently.
  - After an `--apply` that inserted rows, it moves the id sequence past the restored ids, in one short transaction: `BEGIN`, `LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE`, then `setval(pg_get_serial_sequence('strike_exposures', 'id'), GREATEST((SELECT max(id) FROM strike_exposures), <the sequence's last_value>))`, then `COMMIT`. No sequence name is written in the code.
    - `pg_get_serial_sequence` returns a `schema.name` already quoted for use as an identifier. The sequence's `last_value` is read straight from that sequence (`SELECT last_value FROM <that name>`, with the name placed by `psycopg2.sql.SQL`, since it comes from the catalog). A role without the privilege then gets an error. Reading it from `pg_sequences` instead would be wrong: that view shows NULL without the privilege, and `GREATEST` ignores NULL, so the `setval` would quietly fall back to `max(id)` and could move the sequence backwards. If `pg_sequences` is ever used, match it with `format('%I.%I', schemaname, sequencename)`, because the returned name is quoted.
    - If `pg_get_serial_sequence` returns NULL (the column is not a serial) or `last_value` is NULL, the restore fails with a fixed message and runs no `setval`. It never falls back to `max(id)` alone.
    - The lock keeps live writers out until the `setval` commits. Without it, an insert between reading `last_value` and the `setval` could have its id handed out again. SHARE ROW EXCLUSIVE blocks INSERT and not SELECT.
    - `GREATEST` keeps the sequence from moving backwards while the lock is held. In production the sequence is ahead of `max(id)` (it was at 94.2M with `max(id)` at 94.22M, because rolled-back inserts consume ids), so a restore of old days leaves it where it is.
    - Without the `setval`, the next live insert after a restore into an emptied or partial table could be handed a restored id.
  - Running `--apply` against production needs the owner's explicit OK, each time.

## Thresholds and constants

| Name | Value | Why |
| --- | --- | --- |
| `PAGE_ROWS` | 20_000 | Measured at 0.76 to 1.29 s per page on the unique-key keyset (db-facts) |
| `STATEMENT_TIMEOUT` | `'60s'` | 2x the 30 s probe budget. A page must never get near it |
| `PREFIX` | `backups/strike_exposures/` | |
| `STATE_KEY` | `backups/strike_exposures/_state.json` | Holds `{"high_water_id": int, "updated_at": iso}` |
| `FORMAT_VERSION` | `"1"` | Raise it when the column list or the types change |
| `DELTA_MAX_IDS` | 5_000_000 | The id delta query (`WHERE id > $1 GROUP BY date`) costs about 5.6 s per 1M ids, because `date` is not in the pkey and every row needs a heap fetch (measured on prod, read-only, 2026-11-11; db-facts, "Planner statements"). A normal night is 0.5M to 2.8M ids. About 10M ids (roughly two missed weeks) passes the 60 s timeout, and then planning would fail every night and could not recover. Past this many ids since the stored mark, the delta is skipped and every day is counted: each count is at most about 1.3 s (the busiest Friday, 2.78M rows, measured 1.2 s), so about 45 to 60 s spread over many statements |
| `RESTORE_BATCH` | 500 | Repo batch rule (R5) |
| Parquet | zstd, one row group per page | |

## Deciding which days to export (`plan_days`)

A day is due when any of these holds:

1. **It has no object.** The days in the DB come from a loose index scan over `idx_strike_exp_date_ticker`: a recursive CTE, `SELECT min(date) ... WHERE date > prev`. Never use `SELECT DISTINCT date`, which reads 74M index entries.
2. **It gained rows since the last run.**
   - The query is `SELECT date FROM strike_exposures WHERE id > :high_water_id GROUP BY date`, a range scan on the pkey.
   - For each date it returns that has an object, take the full-day count (one index-only count). The day is due if that count differs from the object's metadata `rows`. A day with no object is due without a count.
3. **`--verify-counts` was passed, there is no stored high-water mark, the mark is above `max(id)`, or more than `DELTA_MAX_IDS` ids have been used since it.** Every day that has a trusted object has its count compared with the object's `rows`. That is about 74M index entries, a few minutes, outside market hours. Phase B runs it once a week. In every case but the first the delta query is skipped and this runs instead: with no mark there is nothing to bound the delta, past `DELTA_MAX_IDS` the delta query would run past the statement timeout (see the thresholds), and a mark above `max(id)` (after a Neon point-in-time restore or a sequence reset) would make the delta find nothing and call every day current. A mark equal to `max(id)` is normal and uses the delta. `--verify-counts` and `status` never run the delta query.
4. **Its object cannot be trusted.** The object's `format` metadata is not `FORMAT_VERSION`, or its `rows` metadata is missing or is not a plain count (ASCII digits only). That is decided from the object, with no count: it was written by something else or by another version of this module.

`plan_days` reports which counting path it took (`delta`, or `every day:` with the reason) in `Plan.scope`, and `export` prints it as a `counting:` line. The label is only a label: a separate boolean decides whether the delta runs. `status` prints its own `counting: every day (status)`, because it never was given `--verify-counts`.

The new `high_water_id` is `SELECT max(id)` read in the planning snapshot (0 for an empty table).

The whole plan is one `_read_snapshot` block. The day counts are one query each: a single `GROUP BY` over every day would run past the 60 s timeout. Before anything else the block counts rows with a NULL `expiry` and raises `BackupError` if there are any, because the keyset paging and the restore's conflict key both assume none (none today).

R2 is read before the snapshot opens: the object list and one `head_object` per day for its metadata, then `_state.json`. A malformed `_state.json` raises `BackupError` rather than being treated as missing.

**The out-of-order commit gap.** A row with a lower id that commits after that snapshot is missed by rule 2. Rule 3 catches it. There are no writers at 07:15 UTC, so in practice the gap only opens if a backfill script runs at the same time as the export.

## Review focus

1. **A cell at the edge of its type survives the round trip.** That covers a NULL greek, a NULL `price`, the 26-digit integer part of a (30,4) value, a negative value, `expiry = '1970-01-01'` (the all-expiry sentinel), and a DST-boundary timestamp. Exporting then reading back must give identical Python values (`Decimal`, aware `datetime`, `date`). Owned by Task 1.
2. **Rows inserted during an export** never produce a file with the wrong count. The snapshot count must equal the rows written, or the export raises. Owned by Task 1.
3. **A truncated or failed upload** (a size mismatch on `head_object`, or a `ClientError`) uploads no state and makes the run exit non-zero. The next run redoes the day. Owned by Task 2.
4. **An interrupted history run** resumes. Re-running skips the days already verified in R2 and does only the rest. Owned by Task 2.
5. **Restore can't clobber.** `restore` without `--apply` writes nothing. With `--apply`, a day already fully in the DB inserts 0 rows. Owned by Task 3.

---

## Phase A

### Task 1: Read a day in one snapshot and write it as exact-typed Parquet

**Files:**
- Create `scripts/strike_exposures_backup.py`, holding `COLUMNS`, `ARROW_SCHEMA`, `DayFile`, `iter_day_pages` and `write_day_parquet`.
- Create `scripts/test_strike_exposures_backup.py`.
- Add this spec file to the same commit.

**Interfaces it produces:**
- `COLUMNS: tuple[str, ...]`: the 24 columns in table order, `id` through `created_at` (db-facts §1).
- `ARROW_SCHEMA: pa.Schema`: the types are under Global constraints.
- `@dataclass(frozen=True) class DayFile: day: date; path: Path; rows: int; min_id: int; max_id: int; size: int; sha256: str`.
- `_read_snapshot(conn) -> Iterator[cursor]`, a private `@contextmanager`: the one way to read in a snapshot. Task 2's planning read and Task 3's `verify_day` reuse it.
  - It raises `BackupError` (fixed message, with the numeric status) unless `conn.info.transaction_status` is `TRANSACTION_STATUS_IDLE`. Status `TRANSACTION_STATUS_UNKNOWN` (4, what psycopg2 reports once a connection is closed) gets its own text, "the connection is closed".
  - It saves `conn.autocommit`, sets it to True, runs `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY` and `SET LOCAL statement_timeout = '60s'`, yields a cursor, then always runs `ROLLBACK` and restores `autocommit`. A ROLLBACK that fails on top of another error keeps that error as `__context__`.
  - If `conn.closed` is set, it skips both the ROLLBACK and the restore: psycopg2 raises `InterfaceError` for each on a dead connection, which would replace the original `OperationalError`.
  - One thread per connection.
- `iter_day_pages(cur, day: date, page_rows: int = PAGE_ROWS) -> Iterator[list[tuple]]`: keyset pages, in key order.
- `write_day_parquet(conn, day: date, out_dir: Path, page_rows: int = PAGE_ROWS) -> DayFile | None`. It reads inside `_read_snapshot`. It counts, streams the pages into a `pq.ParquetWriter` and checks the count. It returns `None` for a 0-row day.
  - On any failure, including a ROLLBACK, digest or stat that fails after the file is complete, it deletes the file. A database error propagates unwrapped, and on a dropped connection nothing more is sent, so that error is the one the caller sees.
  - A page that does not fit the schema raises `BackupError` after the handler, so Arrow's text (which can quote a cell) is not in the exception chain.

**Steps:**
- [ ] **Step 1:** Write the failing tests. Use a fake psycopg2 connection or cursor: a small class that records the SQL and serves canned pages and a count. No real connection is possible under `scripts/conftest.py`.
  - `test_round_trip_exact_values`: a page that holds the review-focus cells, including `Decimal('12345678901234567890123456.1234')`, `Decimal('-0.0001')`, `None` greeks, `expiry=date(1970,1,1)`, and a timestamp of `2026-11-01T06:30:00+00:00`. `pq.read_table(path).to_pylist()` must equal the input rows, value for value and type for type.
  - `test_count_mismatch_raises_and_leaves_no_file`: snapshot count 3, pages yield 2. It raises `BackupError` and no `.parquet` stays in `out_dir`.
  - `test_zero_row_day_returns_none`.
  - `test_keyset_sql`: the first query has no row comparison; later queries carry the last key of the previous page. Every page query has `ORDER BY date, "timestamp", ticker, strike, expiry`, a `LIMIT`, and no `OFFSET`. The transaction starts `REPEATABLE READ` and `READ ONLY` and sets `statement_timeout`.
  - `test_dayfile_fields`: `rows`, `min_id`, `max_id`, `size == path.stat().st_size`, and `sha256` equal to the file's hashlib digest.
  - The review round added these. The fake enforces the transaction rules itself: a BEGIN needs autocommit on and no open transaction, every `%s` needs a parameter, and a test that leaves a transaction open fails at teardown.
    - A database error on the count, on page 1 and on page 2 (`QueryCanceled` and `OperationalError`) propagates as the same object, ends in ROLLBACK, leaves `out_dir` empty and restores `autocommit`.
    - `autocommit` is restored from both starting values, on success and on failure.
    - A connection already in a transaction is refused with no statement issued.
    - A ROLLBACK that fails deletes a complete file, and keeps the original error as `__context__`. A failing digest or stat deletes the file.
    - A connection that dropped on the count, page 1 or page 2 surfaces the `OperationalError` itself: no ROLLBACK is sent and no `InterfaceError` follows.
    - `min_id` and `max_id` are right with ascending and with descending ids across pages.
    - A page that does not fit the schema (a str in an int column, int32 overflow, a NULL in a NOT NULL column, a decimal too wide, a float for NUMERIC) raises `BackupError` with `__context__` None and no cell value in the traceback.
- [ ] **Step 2:** Run `ml/.venv/Scripts/pytest scripts/test_strike_exposures_backup.py -q`. Expected: it FAILS on import.
- [ ] **Step 3:** Implement Task 1's interfaces in `scripts/strike_exposures_backup.py`. `BackupError(Exception)` has fixed messages: no cell values, only a date, counts or a status code.
- [ ] **Step 4:** Run the tests again. Expected: they PASS.
- [ ] **Step 5:** Run `npm run review`, then commit the module, the test and this spec.

### Task 2: Upload with verification, plan the days, and the `export` / `status` CLI

**Files:**
- Modify `scripts/strike_exposures_backup.py`.
- Modify `scripts/test_strike_exposures_backup.py`.

**Interfaces it consumes:** `write_day_parquet`, `DayFile` and `_read_snapshot` from Task 1. `plan_days` reads the DB (the date list, the `max(id)` high-water mark and the per-day counts) only inside `_read_snapshot`, and `main` hands it a connection that is idle.

**Interfaces it produces:**
- `object_key(day: date) -> str`, which returns `f"{PREFIX}{day.isoformat()}.parquet"`.
- `upload_day(s3, bucket: str, f: DayFile) -> None`. It does `upload_file` with the metadata in `ExtraArgs` and `TransferConfig(multipart_threshold=64 MiB, use_threads=False, preferred_transfer_client='classic')`, as `nightly/src/r2_store.py` does, then `head_object`.
  - It raises `BackupError` on a size or `rows` mismatch or a failed `head_object`, and deletes the key first (best effort). If the delete fails the error names the key and says the object may remain and to delete it by hand.
  - An `upload_file` error propagates as boto3 raised it, and the old object, if any, is untouched.
- `exported_days(s3, bucket: str) -> dict[date, dict[str, str]]`. It lists `PREFIX` with a paginator, skips `_state.json`, and returns each day's metadata from `head_object`.
- `plan_days(conn, s3, bucket: str, today_et: date, verify_counts: bool = False) -> Plan`, where `@dataclass(frozen=True) class Plan: due: list[date]; high_water_id: int; missing: list[date]; stale: list[date]; db_days: list[date]; object_days: list[date]; scope: str`. `due` is `missing` plus `stale`, oldest first; `scope` says which counting path ran. It applies the rules under "Deciding which days to export" and only includes dates before `today_et`. `status` prints the other fields.
- `read_state(s3, bucket) -> int | None` and `write_state(s3, bucket, high_water_id: int) -> None`.
- `main(argv: list[str] | None = None) -> int`, with these subcommands:
  - `export [--date D] [--limit-days N] [--verify-counts] [--dry-run]`. `--dry-run` writes the local files, prints each day's rows, bytes and time, deletes the file, and uploads nothing and writes no state. `--date D` exports exactly that day, due or not, and must be before today.
  - `status`, which lists the DB days and object days, and the missing and stale ones. It counts every day, like `--verify-counts`, so it takes minutes on production.
  - Exit codes: 0 when every due day verified; 1 when any day failed or the plan or the connection did; 2 for bad config or arguments, including an R2 client that cannot be built (a malformed `R2_ENDPOINT_URL`: botocore's error text holds the URL, so only its class is logged).
  - A day that fails with a database, R2, I/O or `BackupError` error is logged by date and error class, and the run goes on to the next day. A `BackupError`'s own fixed text is added; no other error's text is printed. The exit code is 1 and the state is not advanced.
  - If a failed day left the connection closed (`conn.closed`), the run stops there with exit 1 and tries no more days; a re-run resumes.
  - The connection is opened fresh and used only inside `_read_snapshot` (`plan_days` and `write_day_parquet`).

**Steps:**
- [ ] **Step 1:** Write the failing tests. The functions take the boto3 client as their `s3` argument, which is the production call shape: `main` builds the client and passes it in. The tests pass a dict-backed fake with `upload_file`, `head_object`, `get_paginator`, `get_object`, `put_object` and `delete_object`, whose signatures were checked against boto3 1.43.121. Tests that run `main` monkeypatch the module's `psycopg2.connect` and `boto3.client` to return the fakes, which is mocking at the module boundary (R3). botocore's real `_make_api_call` is blocked in this suite.
  - `test_upload_verifies_size_and_rows`: the stub's `head_object` reports a `ContentLength` 1 byte short. It raises `BackupError`, and `write_state` is never called.
  - `test_plan_missing_and_gained_days`: the DB has 3 days, R2 has 2 of them, and one of those 2 gained rows past the high-water mark. Plan = the missing day plus the day that gained rows, in date order. Today is excluded.
  - `test_plan_verify_counts_finds_out_of_order_rows`: no id passes the high-water mark, but one day's count differs from its object's `rows`. It is due only with `verify_counts=True`.
  - `test_export_resumes`: day 1 is already in the stub with the matching `rows`, and days 2 and 3 are missing. `main(["export"])` uploads only days 2 and 3. Running it a second time uploads nothing.
  - `test_export_failure_exit_1_no_state`: one day's upload fails. The other day still uploads, the exit code is 1, and the state is not advanced.
  - `test_status_output`: it prints counts and dates only, and never a connection string.
  - Added in the build, all through the same fakes (the DB fake also refuses a statement or a fetch outside the snapshot):
    - `upload_day`: the metadata keys and values, one thread, a size, `rows` or missing-object failure deletes the key, a delete that fails says the object may remain, an `upload_file` error propagates and deletes nothing.
    - `exported_days` reads every page and skips `_state.json` and other keys. `read_state` / `write_state` round-trip; missing is `None`, malformed raises, another `ClientError` propagates.
    - `plan_days`: counts only the delta days that have an object (and every day with `verify_counts`, no state, or a delta wider than `DELTA_MAX_IDS`: at the limit the delta is used, one id over it is not, and only counting every day finds a stale day with no new rows); an object whose `format` is not current or whose `rows` is missing, empty, non-numeric, negative, padded or non-ASCII is stale with no count, also when every day is counted; the counting path is reported, `--verify-counts` never runs the delta even with a stored mark, a mark above `max(id)` counts every day (and one equal to it uses the delta); an empty table; one snapshot; a NULL expiry raises; a database error propagates after the ROLLBACK.
    - Pins for settings that only a real R2 would prove wrong: `preferred_transfer_client == 'classic'`, `multipart_threshold == 64 MiB`, the client's `signature_version == 's3v4'` and `retries == {'mode': 'standard', 'max_attempts': 5}`, Parquet codec ZSTD, and that `2026-11-02.parquet.bak`, `sub/2026-11-02.parquet` and `2026-11-02.parquet/part` are not day files.
    - `main` with `--date` on the only due day still keeps the state; an `OSError` on one day (a `Path.stat` that fails for that day's file) fails that day, exits 1 and the next day still uploads; a malformed endpoint exits 2 with the class only; `export` prints the counting path and `status` prints `every day (status)` and never runs the delta.
    - A closed connection (`closed` set: `cursor()` raises, status 4) is refused by `_read_snapshot` with its own text.
    - `main`: a truncated upload exits 1, deletes the key, and the next run redoes the day; a database error on a live connection fails that day and the run goes on; a dropped connection stops the run and a re-run resumes; each day's file is deleted before the next day; `--dry-run`, `--date` and a short `--limit-days` keep the state; `--verify-counts` reaches the plan; a day with no rows is skipped; `--date` today is refused; a missing variable exits 2 naming only the variable; the clients are built from the environment (`region_name='auto'`, `verify=True`); a failed connect hides the DSN; a failed state write, an R2 listing error and a `plan_days` failure on `status` each exit 1 and name the step and error class; a bad argument (`--limit-days 0`, a non-date `--date`, no or an unknown command) exits 2 before any connection; `status` writes nothing.
- [ ] **Step 2:** Run the tests. Expected: they FAIL.
- [ ] **Step 3:** Implement Task 2's interfaces. `main` loads env through `_cli_paths.load_env_file`, then opens one psycopg2 connection and one boto3 client. It writes the day files to a `tempfile.TemporaryDirectory()` and deletes each one after it verifies.
- [ ] **Step 4:** Run the tests. Expected: they PASS.
- [ ] **Step 5:** Run `npm run review` and commit.

### Task 3: `verify` and `restore`

**Files:**
- Modify `scripts/strike_exposures_backup.py`.
- Modify `scripts/test_strike_exposures_backup.py`.

**Interfaces it produces:**
- `verify_day(conn, s3, bucket: str, day: date) -> VerifyResult`, where `@dataclass(frozen=True) class VerifyResult: day: date; db_rows: int; file_rows: int; only_in_db: int; only_in_file: int; value_diffs: int`.
  - It streams the DB day inside `_read_snapshot` (Task 1) and the downloaded file. Both are in key order, so it merge-compares them on the unique key.
  - `ok` means every count is equal and `only_in_db`, `only_in_file` and `value_diffs` are all 0.
- `restore_day(conn, s3, bucket: str, day: date, apply: bool) -> int`.
  - It returns the number of rows that would be inserted (dry run) or that were inserted (apply).
  - With `apply`, it inserts batches of `RESTORE_BATCH` with the original `id`, all 24 columns, and `ON CONFLICT (date, "timestamp", ticker, strike, expiry) DO NOTHING`. A batch failure, including an `id` already taken by a different row, raises with a fixed message.
  - If rows were inserted, it then runs the `setval` statement under Global constraints (Restore). If none were, it does not.
- The CLI gains `verify --date D [--date D ...]` (exit 0 only if every day is ok) and `restore --date D [--apply]`.

**Steps:**
- [ ] **Step 1:** Write the failing tests.
  - `test_verify_identical_day_ok`.
  - `test_verify_counts_each_difference`: one row missing from the file, one extra in the file, and one changed greek give `only_in_db=1`, `only_in_file=1` and `value_diffs=1`.
  - `test_restore_dry_run_writes_nothing`: the fake connection records no INSERT.
  - `test_restore_apply_batches_on_conflict_do_nothing`: 1,201 rows go in 3 INSERTs. Each one has `ON CONFLICT (date, "timestamp", ticker, strike, expiry) DO NOTHING` and the `id` column, and none of them has `UPDATE` or `DELETE`.
  - `test_restore_apply_already_present_inserts_zero`: the fake reports rowcount 0. The function returns 0 and issues no `LOCK` and no `setval`.
  - `test_restore_apply_locks_then_moves_the_sequence`: after INSERTs that report rows inserted, the statements run in this order, after the last INSERT: `BEGIN`, `LOCK TABLE strike_exposures IN SHARE ROW EXCLUSIVE MODE`, `SELECT pg_get_serial_sequence('strike_exposures', 'id')`, a read of the sequence's `last_value`, a `setval` on that name with `GREATEST(max(id), last_value)`, `COMMIT`. No statement spells out `strike_exposures_id_seq`.
  - `test_restore_apply_fails_when_the_sequence_cannot_be_read`: a NULL sequence name, a NULL `last_value`, and a `last_value` read that raises (no privilege) each raise `BackupError` with a fixed message, roll back, and issue no `setval`. The rows already inserted stay (they are committed).
  - `test_restore_apply_id_collision_raises`: the fake raises `UniqueViolation` on an INSERT. The function raises `BackupError` with a fixed message and issues no `LOCK` and no `setval`.
- [ ] **Step 2:** Run the tests. Expected: they FAIL.
- [ ] **Step 3:** Implement Task 3's interfaces.
- [ ] **Step 4:** Run the tests. Expected: they PASS.
- [ ] **Step 5:** Run `npm run review` and commit.

### Task 4: One-time history export (an operation run by the main session, not an implementer task)

- [ ] **Step 1: dry run.** Outside 13:00 to 23:00 UTC, run `export --dry-run --date 2026-11-10` (a Tuesday) and `export --dry-run --date 2026-11-06` (a Friday). Record each Parquet size and its time.
- [ ] **Step 2: the full export.** Run `export` with no `--date`. It plans every stored day before today: 178 days at the time of writing. Record the elapsed time, the total bytes and the per-day failures. Re-run until the exit code is 0.
- [ ] **Step 3: verify.** Run `verify` on 2026-01-12, 2026-05-15 (the first per-minute day), 2026-11-06 and the newest exported day. Every one must be ok.
- [ ] **Step 4: status.** Run `status`, and record 0 missing and 0 stale.
- [ ] **Step 5: record.** Add a "Run log" section to this file with the numbers above, then commit it. Update the memory file `project_flow_data_live_bugs_2026_11_06.md` and the `r2-storage` skill's key-layout list (local `.claude/`, with the new prefix).

## Phase B (plan in full once `feat/nightly-phase2` is on main)

- **The nightly step.** Add a `strike_exposures_backup` step to the phase 2 step runner, running after the tape each night.
  - It runs `plan_days` and exports the due days within its own deadline (`StepContext.deadline`).
  - Its `StepResult` counts are `days_due`, `days_exported`, `days_failed` and `bytes`.
  - `detail` is a fixed phrase (phase 2 rule).
  - It runs `verify_counts=True` on Saturday's run.
  - A failed day turns the step's status to `partial` or `failed`, which goes through `monitoring.report_step`. Sentry rule 6262727 (nightly, any new issue) emails on it.
- **The module ships in the image.** `strike_exposures_backup.py` imports `scripts/_cli_paths.py` (`format_dates`, `load_env_file`) and `scripts/_pipeline_retry.py` (`connect_with_retry`) at the top, so the image needs those two files as well, or the step moves those imports into `main`. It is added under the six-place rule at the top of `nightly/Dockerfile` on the phase 2 branch:
  - a COPY line;
  - the Railway watch paths;
  - the `.dockerignore` re-admit;
  - `IMAGE_FILES` in `test_image_layout.py`;
  - the CI paths filter;
  - the README watch-path list.
- **Log how long planning took.** The step logs the planning time in seconds with the `counting:` path, so `DELTA_MAX_IDS` can be retuned from real runs. The 5.6 s per 1M ids was measured on a workstation against a warm cache; the 07:15 UTC run may read cold pages and be slower.
- **Exception text.** The step must follow phase 2's scrubbing rule for raw conversion errors (`steps.py` docstring).
- **Push window.** A push that touches `nightly/src` must not land between 07:15 and 12:30 UTC, because it redeploys the service and kills a run in progress.
- **Open item: no lease between a manual run and the nightly run.** Two overlapping exports can step on each other: `upload_day` deletes an object that fails its check, and a second run that re-uploads the same day at that moment can have its verified object deleted, or its head read the other run's object. It repairs itself, because the day is missing or stale on the next run, but nothing prevents it. A lease row (R6) would. Until then, do not run `export` by hand while the nightly step can run (07:15 to 12:30 UTC).

## Open questions

1. **Neon point-in-time restore window.**
   - It covers short-term mistakes, such as a bad migration or a bad delete, faster than this backup does.
   - The window depends on the Neon plan. It was not checked: the Neon tools were not connected on 2026-11-11.
   - Default: the owner checks it in the Neon console. This backup does not depend on it.
2. **Parquet size.** Estimated at under 6 GB in all, from 7.7x to 8.9x gzip on JSONL. Task 4 Step 1 measures it. R2 storage is about $0.015 per GB-month, so the size does not change the design.
3. **Out of scope, recorded so they aren't lost.**
   - Rollup failures on 09-18, 09-25, 10-12, 10-13 and 10-15 to 10-22, which hold REST rows only.
   - The R1 strike-all backfill, which was never run.
   - UW vanna, which appears rescaled by about 5.848 at some point after 03-24 (seen on 2026-03-02's re-fetch).
   - Each one belongs to the live-data-integrity work, not this backup.
