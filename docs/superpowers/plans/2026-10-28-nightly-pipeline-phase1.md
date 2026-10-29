# Nightly pipeline, phase 1: tape landing — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Railway cron service lands every trading day's UW Full Tape in private R2 as validated Parquet. It catches up on every missing day, and re-lands days UW rewrites, with no human involved.

**Architecture:**
- **New service:** a Python service `nightly/`, laid out like `uw-stream/`. It runs once a night and exits.
- **Ingest core:** vendored from UW's `uw_options_data_lake.py`: the NYSE calendar, the download and response sniffing, and the streaming CSV→Parquet convert with its timestamp gate. It's stripped to those parts and fixed per the 2026-10-28 code review.
- **Around the core:** an R2 store (boto3), a tape job that plans and lands days one at a time, and an entrypoint with a Sentry cron monitor and honest exit codes.

**Tech Stack:** Python 3.12, polars, httpx, boto3, sentry-sdk, pydantic-settings; tests with pytest, respx and moto; ruff.

**Spec:** `docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md` (phase 1). The code review behind tasks 2–4 is summarized in "Review findings this plan fixes" below. Phases 2–4 get their own plans.

**Left to later phases:**
- `union_by_name` in `ml/src/utils/r2.py` and the other tape readers (phase 2, where they're first used).
- Retiring `scripts/download-fulltape.sh`, `scripts/ingest-fulltape.py` and their Makefile targets (phase 3, with the rest of the Makefile).
- GexBot (a separate job; `2026-10-28-gexbot-eod-capture-design.md`).

## Global Constraints

- **Layout and tooling:**
  - Service dir `nightly/`, Railway service name `nightly`.
  - Python 3.12, image `python:3.12-slim`, ruff `>=0.17,<0.18`, line length 100.
  - pytest config, `conftest.py` and the flat `src/` imports work as in `uw-stream/`.
- **Runtime deps** (`nightly/requirements.txt`): `polars>=2.1,<3`, `httpx>=0.28,<0.29`, `boto3>=1.35,<2`, `sentry-sdk>=2.40,<3`, `pydantic>=2.7,<3`, `pydantic-settings>=2.3,<3`, `tzdata>=2024.1`. tzdata is unconditional: ZoneInfo needs it on the slim image.
- **Dev deps** (`nightly/requirements-dev.txt`): `-r requirements.txt`, `pytest>=8`, `pytest-cov>=6`, `respx>=0.21`, `moto[s3]>=5`, `ruff>=0.17,<0.18`.
- **Env vars:**
  - Required; boot fails naming the missing one: `UW_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`.
  - Optional: `SENTRY_DSN`.
  - Nothing else; no `.env` reading and no `--api-key` flag.
- **Constants,** in `nightly/src/constants.py`, never env (R7):

  | Name | Value |
  |---|---|
  | `TAPE_START` | `date(2026, 1, 2)` |
  | `CATCHUP_MAX_DAYS` | `30` |
  | `RUN_DEADLINE_SECONDS` | `5 * 3600` |
  | `DOWNLOAD_DEADLINE_SECONDS` | `1800` |
  | `DOWNLOAD_MAX_ATTEMPTS` | `4` |
  | `MIN_FREE_DISK_BYTES` | `15 * 2**30` |
  | `WORK_DIR` | `Path("/tmp/nightly")` |
  | `UNAVAILABLE_AGE_TRADING_DAYS` | `5` |
  | `REWRITE_RECHECK_DAYS` | `5` |
  | `PLAUSIBLE_MIN_ROW_RATIO` | `0.65` |
  | `PLAUSIBLE_MIN_TRAILING` | `10` |
  | `ROW_GROUP_SIZE` | `1_048_576` |
  | `SNIFF_MAX_BYTES` | `65_536` |
  | `SCHEMA_VERSION` | `"nightly-1"` |
  | `USER_AGENT` | `"strike-calculator-nightly/1.0"` |

  `PLAUSIBLE_MIN_ROW_RATIO` was tuned on the 112 R2 days (lowest ratio to the trailing-20 median was 0.835 on 2026-02-19). Every day's `executed_at` fell between 09:30:00 and 18:04:15 ET on its own session date.
- **R2 keys,** all under one bucket:
  - Tape: `fulltape/{YYYY-MM-DD}-fulltape.parquet`.
  - Markers: `fulltape/_unavailable/{YYYY-MM-DD}.json`.
  - Copies before a re-land: `fulltape/_superseded/{YYYY-MM-DD}-{source_etag}.parquet`.
  - Listings read only the `fulltape/` prefix and count only keys matching `^fulltape/(\d{4}-\d{2}-\d{2})-fulltape\.parquet$`.
  - Another job writes `gexbot-eod/` in the same bucket; never touch it.
- **Object metadata on new tape objects:** `rows`, `sha256`, `schema-version`, `source-etag`, `source-last-modified`, `source-bytes`, `ingested-at`. An object without metadata is a legacy day and still counts as landed.
- **Parquet layout:**
  - Every tape column, in the tape's own order, then `date` (`pl.Date`) and `ingested_at` (`pl.Datetime("us", "UTC")`).
  - The 40 core columns get exactly the dtypes in `scripts/ingest-fulltape.py:30-71` `FULLTAPE_SCHEMA`, with `canceled` stored as Boolean (`== "t"`, as `transform` at `:168` does).
  - Any other column is `pl.Utf8`, and empty strings stay `""` (`missing_utf8_is_empty_string=True`).
  - Written zstd level 3, `ROW_GROUP_SIZE`, `statistics=True`.
- **Logs and Sentry never contain market data:** no rows, no response bodies, no polars error text that quotes values, no signed URLs. Counts, sizes, dates, durations and keys only.
- **Schedule:** `railway.toml` `[deploy] cronSchedule = "15 7 * * 2-6"`, `restartPolicyType = "NEVER"`, `watchPatterns = ["nightly/**"]`.
- **Sentry monitor:** slug `nightly-tape`, crontab `15 7 * * 2-6`, `checkin_margin` 30, `max_runtime` 330, timezone `UTC`.
- **Exit codes:** `0` when every planned day landed, re-landed or was correctly marked unavailable. `1` when any day failed, was not posted, or was skipped for disk or deadline. `2` on bad config.
- **Python files** carry a module docstring. The vendored module keeps a provenance header (Task 2).
- **Push timing:** commits that touch `nightly/` are pushed after 15:00 CT on weekdays (memory `no-railway-push-market-hours`).

## Review findings this plan fixes

Each is from the 2026-10-28 review of UW's script (line numbers are in `.claude/skills/uw-options-data-lake/scripts/uw_options_data_lake.py`):
- **(b1)** A non-atomic sink leaves a partial file that's then skipped forever (1116–1135).
- **(b2)** No retries, although the constant exists (77).
- **(b3)** The 60 s timeout is per read, so a trickling stream never ends.
- **(b4)** A non-zip 200 is buffered whole, then echoed (932–937).
- **(b5)** A GCS 404 for "not posted" reports success (1246, 1494).
- **(b6)** One `FatalError` aborts the run, and failed days' temp files pile up (1492–1502, 1250).
- **(b7)** `BadZipFile`, httpx errors and OSError escape uncaught.
- **(b8)** Inferred dtypes drift from the R2 schema.
- **(b9)** The row check compares polars against polars, so it doesn't prove UW's file is complete.
- **(b11)** Sentry ships local variables holding raw bytes.
- **(b12)** `.env` and `--api-key` config.
- **(b13)** TOON stdout.
- Low: the holiday table fails with no warning in 2029.

## Review Focus

- **A run killed mid-day** by an OOM or a redeploy must leave that day planned again on the next run. R2 multipart objects appear only on completion, and the local temp files die with the container. Pinned by `test_failed_upload_leaves_day_unlanded` (Task 5) and `test_land_day_cleans_work_dir_on_failure` (Task 6).
- **The previous session still 404 at 03:15 ET** (UW late) is reported as `not_posted`, which means exit 1 and a Sentry warning. It is never marked unavailable, and the next night lands it. Pinned by `test_recent_not_posted_is_not_marked_unavailable` (Task 6).
- **DST:** a 07:15 UTC run resolves the previous ET session on both sides of 2026-11-01. Pinned by `test_last_completed_session_across_dst` (Task 2).
- **A layout change:** a new column lands as Utf8; a missing core column fails that day only. Pinned by `test_extra_column_kept_as_utf8` and `test_missing_core_column_fails` (Task 4), plus `test_one_bad_day_does_not_stop_others` (Task 6).
- **A hung download** trips the per-download deadline, the day fails, the run moves on, and the whole-run deadline stops new days. Pinned by `test_download_deadline_raises_timeout` (Task 3) and `test_run_deadline_skips_remaining_days` (Task 6).

---

### Task 1: Service scaffold, settings, CI job, Vercel ignore

**Files:**
- Create: `nightly/pyproject.toml`, `nightly/conftest.py`, `nightly/requirements.txt`, `nightly/requirements-dev.txt`, `nightly/Dockerfile`, `nightly/railway.toml`, `nightly/src/__init__.py`, `nightly/src/constants.py`, `nightly/src/config.py`, `nightly/tests/__init__.py`, `nightly/tests/test_config.py`.
- Modify: `.github/workflows/ci.yml` (a `nightly` path filter and a "nightly Quality Gate" job, copied from the `uw-stream` job at `:232-269` with `working-directory: nightly`), `vercel.json` (`ignoreCommand` gains `':!nightly'`), `api/__tests__/vercel-ignore-command.test.ts` (expects `nightly`).

**Interfaces:**
- Produces:
  - `constants.py` with every Global Constraints constant.
  - `config.Settings(BaseSettings)` with fields `uw_api_key: SecretStr`, `r2_access_key_id: SecretStr`, `r2_secret_access_key: SecretStr`, `r2_endpoint_url: str`, `r2_bucket_fulltape: str`, `sentry_dsn: str | None = None`. A validator requires `r2_endpoint_url` to start with `https://`.
  - `config.load_settings() -> Settings`.

**Dockerfile:**
- Two-stage, like `uw-stream/Dockerfile`, a non-root user, no HEALTHCHECK, no EXPOSE.
- `ENV POLARS_MAX_THREADS=4 PYTHONUNBUFFERED=1 PYTHONPATH=/app/src`.
- `CMD ["python", "-m", "main"]`.

- [ ] **Step 1:** Write `tests/test_config.py`:
  - `test_missing_uw_api_key_names_field`: with `UW_API_KEY` unset (monkeypatch.delenv), `load_settings()` raises `ValidationError` whose text contains `uw_api_key`.
  - `test_endpoint_must_be_https`: `R2_ENDPOINT_URL=http://x` raises.
  - `test_secrets_not_in_repr`: `"test-key" not in repr(load_settings())`.
  - `conftest.py` sets defaults for all five required vars, like uw-stream's.
- [ ] **Step 2:** Run `cd nightly && python -m pytest tests/test_config.py -v`. Expected: FAIL (no module `config`).
- [ ] **Step 3:** Implement `constants.py`, `config.py` and the scaffold files above.
- [ ] **Step 4:** Run `cd nightly && pip install -r requirements-dev.txt && python -m ruff check src tests conftest.py && python -m ruff format --check src tests conftest.py && python -m pytest`. Expected: all pass.
- [ ] **Step 5:** Run `npm run review` at the repo root. Expected: green, including the updated `vercel-ignore-command.test.ts`.
- [ ] **Step 6:** Commit `feat(nightly): Scaffold the nightly tape service and its CI gate`.

### Task 2: Vendored NYSE calendar

**Files:**
- Create: `nightly/src/calendar_nyse.py`, `nightly/tests/test_calendar_nyse.py`.

**Interfaces:**
- Produces:
  - `class CalendarExhausted(Exception)`.
  - `TABLE_LAST_YEAR: int`.
  - `is_trading_day(d: date) -> bool`.
  - `trading_days(start: date, end: date) -> list[date]` (inclusive, ascending).
  - `previous_trading_day(d: date) -> date`.
  - `last_completed_session(now_utc: datetime) -> date`: the latest trading day whose 20:00 America/New_York has passed.
  - `table_expiry_warning(today: date) -> str | None`: non-None from Oct 1 of `TABLE_LAST_YEAR`.

**Provenance header** (verbatim shape): a module docstring saying the holiday table and trading-day logic are adapted from Unusual Whales' `uw-options-data-lake` skill, `https://unusualwhales.com/skills/uw-options-data-lake-skill.md`, fetched 2026-10-28, sha256 `a99ecce6361a295d7ded72e804e9ec77e4fbec94cdace1c0b24c02551596f8bb`, no license stated, vendored by owner decision 2026-10-28. Copy the holiday table from source lines 464–554 unchanged.

- [ ] **Step 1:** Write tests:
  - `test_2026_holidays`: each of 2026-01-01, 01-19, 02-16, 04-03, 05-25, 06-19, 07-03, 09-07, 11-26, 12-25 is not a trading day; 2026-11-27 and 12-24 are.
  - `test_trading_days_skips_weekends_and_holidays`: `trading_days(date(2026,7,1), date(2026,7,7)) == [07-01, 07-02, 07-06, 07-07]`.
  - `test_last_completed_session_across_dst`:
    - 2026-10-30 07:15 UTC (EDT) → 2026-10-29;
    - 2026-11-03 07:15 UTC (EST) → 2026-11-02;
    - 2026-11-02 07:15 UTC (a Monday) → 2026-10-30;
    - 2026-11-27 07:15 UTC → 2026-11-25.
  - `test_past_table_raises`: `is_trading_day(date(TABLE_LAST_YEAR + 1, 1, 5))` raises `CalendarExhausted`.
  - `test_expiry_warning_window`: None on `date(TABLE_LAST_YEAR, 9, 30)`, a str on `date(TABLE_LAST_YEAR, 10, 1)`.
  - Port the calendar checks from the source selftest (2934–3347, the calendar ones only) as further tests.
- [ ] **Step 2:** Run `python -m pytest tests/test_calendar_nyse.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `calendar_nyse.py` from source 464–554, adding the signatures above.
- [ ] **Step 4:** Run the tests and ruff. Expected: PASS.
- [ ] **Step 5:** Commit `feat(nightly): Vendor UW's NYSE calendar with a DST-safe session date`.

### Task 3: UW tape download client

**Files:**
- Create: `nightly/src/uw_client.py`, `nightly/tests/test_uw_client.py`.

**Interfaces:**
- Consumes: `constants`.
- Produces:
  - `class TapeDownloadError(Exception)` with attributes `kind: Literal["not_posted", "outside_window", "auth", "quota_daily", "transient", "corrupt", "timeout", "unexpected"]`, `day: date`, `detail: str`. `detail` never holds body text.
  - `@dataclass(frozen=True) class SourceInfo: etag: str | None; last_modified: str | None; bytes: int`.
  - `download_tape(day: date, dest: Path, api_key: str) -> SourceInfo`.
  - `probe_source(day: date, api_key: str) -> SourceInfo`: opens the stream, reads headers only, closes.

**Behavior:**
- URL `https://api.unusualwhales.com/api/option-trades/full-tape/{day}`. Headers: `Authorization: Bearer`, `Accept: */*`, `User-Agent: USER_AGENT`, `UW-CLIENT-API-ID: 100003` (kept from source 418), `follow_redirects=True`.
- **Every attempt requests UW again,** so each gets a fresh signed URL.
- **Retries:** up to `DOWNLOAD_MAX_ATTEMPTS` with backoff `min(120, 5 * 2**n) + random.uniform(0, 3)` seconds on:
  - 429 without daily exhaustion (`x-uw-daily-req-count >= x-uw-token-req-limit`); honor `Retry-After` up to 300 s;
  - 5xx;
  - `httpx.TransportError`;
  - a body whose length isn't `Content-Length`.
  - No retry on 401, 403, daily 429 or 404.
- **404** → `not_posted`, with `detail` `gcs-404` when the final host is `storage.googleapis.com`, else `uw-404`.
- **403** with `historic_data_access_missing` → `outside_window` (reuse `classify_403` / `parse_boundary` from source 772–980; drop the egress and cloudflare kinds into `unexpected`).
- **A 200 that isn't a zip** (first 4 bytes ≠ `PK\x03\x04`): read at most `SNIFF_MAX_BYTES` to classify, then `unexpected`.
- **Streaming:** write to `dest.with_name(dest.name + ".part")`, check the byte count, rename to `dest`, and unlink `.part` on any exception.
- **Deadline:** `time.monotonic()` checked each chunk; past `DOWNLOAD_DEADLINE_SECONDS` → `timeout`.

- [ ] **Step 1:** Write respx tests:
  - `test_success_writes_zip_and_returns_source_info`: etag, last-modified and bytes come from the final response.
  - `test_gcs_404_is_not_posted` (302 → GCS 404, detail `gcs-404`).
  - `test_historic_403_is_outside_window`.
  - `test_429_retry_after_then_success`: 2 calls; `time.sleep` patched with the requested seconds.
  - `test_daily_quota_429_is_not_retried`: 1 call, kind `quota_daily`.
  - `test_5xx_exhausts_to_transient`: exactly 4 calls.
  - `test_short_body_is_retried`.
  - `test_non_zip_200_is_unexpected_without_body`: a 2 MB JSON body; `str(err)` contains none of the body, and at most 65,536 bytes were read.
  - `test_download_deadline_raises_timeout`: patch `uw_client.time.monotonic` to jump past the deadline after the first chunk; `.part` is gone.
  - `test_401_is_auth_not_retried`.
  - `test_probe_source_reads_headers_only`.
- [ ] **Step 2:** Run `python -m pytest tests/test_uw_client.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `uw_client.py`.
- [ ] **Step 4:** Run the tests and ruff. Expected: PASS.
- [ ] **Step 5:** Commit `feat(nightly): Download the UW tape with retries, deadlines and honest 404s`.

### Task 4: Converter and validation gate

**Files:**
- Create: `nightly/src/tape_convert.py`, `nightly/tests/test_tape_convert.py`.

**Interfaces:**
- Produces:
  - `CORE_SCHEMA: dict[str, pl.DataType]`: a copy of `FULLTAPE_SCHEMA` (`scripts/ingest-fulltape.py:30-71`), cited in a comment.
  - `class TapeValidationError(Exception)`. Messages name columns and counts only.
  - `@dataclass(frozen=True) class ConvertResult: rows: int; columns: list[str]; sha256: str; bytes: int; min_executed_at: datetime | None; max_executed_at: datetime | None`.
  - `convert_zip(zip_path: Path, out_path: Path, session: date, ingested_at: datetime) -> ConvertResult`.
  - `plausibility_warnings(rows: int, trailing_rows: list[int], min_executed_at: datetime | None, max_executed_at: datetime | None, session: date) -> list[str]`.

**Behavior:**
- **Extract:** pull the zip's single CSV into the zip's folder. `zipfile.BadZipFile`, CRC errors and more than one CSV → `TapeValidationError("corrupt zip")`.
- **Columns:**
  - Read the header; all 40 core columns must be present, otherwise fail naming the missing ones.
  - `pl.scan_csv(csv, infer_schema_length=0, missing_utf8_is_empty_string=True, schema_overrides=…)` with the core dtypes, except `executed_at` and `created_at`, which are read as Utf8 and parsed by the source's string→datetime path and no-new-nulls gate (source 1006–1230; the 0–6-digit fraction handling at 435–437).
  - `canceled` becomes `pl.col("canceled") == "t"`.
  - Keep the tape's column order, then append `date` and `ingested_at`.
- **Write:** `sink_parquet` to `out_path.with_name(out_path.name + ".tmp")`, then rename; unlink the tmp file on any exception.
- **Gate:**
  - The row count equals the CSV's line count minus the header. Count lines with a byte scan, not polars.
  - Core dtypes are exact.
  - Timestamps gain no nulls beyond the empty tokens.
  - Then the output's sha256, and the min/max of `executed_at`.
- **Plausibility** (warnings only, never a failure):
  - `rows < PLAUSIBLE_MIN_ROW_RATIO × median(trailing_rows)`, when there are at least `PLAUSIBLE_MIN_TRAILING` trailing values.
  - Any `executed_at` outside `[session − 1 day 20:00 ET, session 20:00 ET)`.

- [ ] **Step 1:** Write tests, using tiny CSV zips built in fixtures with the 40 core columns:
  - `test_happy_path_layout_and_dtypes`: columns are tape order + `date` + `ingested_at`; `canceled` is Boolean; `expiry` is Date; counts are Int32.
  - `test_extra_column_kept_as_utf8`.
  - `test_missing_core_column_fails`: the message names the column, and nothing sits at `out_path` or `.tmp`.
  - `test_bad_timestamp_fails_and_leaves_no_file`.
  - `test_corrupt_zip_fails`: one byte flipped.
  - `test_fraction_lengths_0_to_6_parse`.
  - `test_row_count_matches_csv_lines`.
  - `test_plausibility_ratio`: 0.64 × median warns, 0.66 doesn't, and fewer than 10 trailing values doesn't.
  - `test_plausibility_time_window`: 20:30 ET on the session date warns.
  - Port the source selftest checks for the no-new-nulls gate and the zip sniff.
- [ ] **Step 2:** Run `python -m pytest tests/test_tape_convert.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `tape_convert.py` from source 1006–1230 with the changes above.
- [ ] **Step 4:** Run the tests and ruff. Expected: PASS. Also run once by hand on a real day: build `2026-06-15` from a fresh UW download in a scratch dir. Its row count must be 11,643,779, and its core dtypes must equal the R2 legacy object's.
- [ ] **Step 5:** Commit `feat(nightly): Convert the tape to R2-schema Parquet behind an atomic, honest gate`.

### Task 5: R2 store

**Files:**
- Create: `nightly/src/r2_store.py`, `nightly/tests/test_r2_store.py`.

**Interfaces:**
- Consumes: `config.Settings`.
- Produces:
  - `class R2VerifyError(Exception)`.
  - `class R2Store` with:
    - `__init__(settings: Settings)`: one boto3 client; `region_name="auto"`, `signature_version="s3v4"`, standard retries with `max_attempts=5`, `verify=True`.
    - `landed() -> dict[date, dict[str, str]]`: day → its metadata, `{}` for legacy objects.
    - `unavailable() -> set[date]`.
    - `put_tape(path: Path, day: date, metadata: dict[str, str]) -> None`.
    - `supersede(day: date, source_etag: str) -> str`: returns the copy's key.
    - `mark_unavailable(day: date, reason: str) -> None`.
  - `tape_key(day: date) -> str`.

**Behavior:**
- `put_tape` uses `upload_file` with a `TransferConfig` of `multipart_threshold=64 MB` and `use_threads=False`. Single-threaded on purpose: a shared client across threads produced unverified TLS connections in the GexBot rescue run (`2026-10-28-gexbot-eod-capture-design.md`, Phase 0).
- After uploading it calls `head_object`; a `ContentLength` that isn't the local size raises `R2VerifyError`.
- Listings paginate.

- [ ] **Step 1:** Write moto (`mock_aws`) tests:
  - `test_landed_reads_only_tape_keys`: a bucket holding a legacy object, a new one with metadata, `gexbot-eod/SPX/2026-10-28.zip`, an `_unavailable` marker, an `_superseded` copy and `fulltape/notes.txt` → exactly the 2 tape days.
  - `test_put_tape_sets_metadata_and_verifies_size`.
  - `test_size_mismatch_raises`: `head_object` patched to report a wrong length.
  - `test_failed_upload_leaves_day_unlanded`: `upload_file` patched to raise after starting, and `landed()` doesn't include the day.
  - `test_supersede_copies_old_object`.
  - `test_unavailable_round_trip`.
- [ ] **Step 2:** Run `python -m pytest tests/test_r2_store.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `r2_store.py`.
- [ ] **Step 4:** Run the tests and ruff. Expected: PASS.
- [ ] **Step 5:** Commit `feat(nightly): Store tape days in R2 with verified uploads and metadata`.

### Task 6: Tape job

**Files:**
- Create: `nightly/src/tape_job.py`, `nightly/tests/test_tape_job.py`.

**Interfaces:**
- Consumes:
  - `calendar_nyse.trading_days` and `last_completed_session`;
  - `uw_client.download_tape`, `probe_source`, `TapeDownloadError`;
  - `tape_convert.convert_zip`, `plausibility_warnings`, `TapeValidationError`;
  - `R2Store`.
- Produces:
  - `DayStatus = Literal["landed", "relanded", "not_posted", "unavailable", "failed", "skipped_disk", "skipped_deadline"]`.
  - `@dataclass(frozen=True) class DayOutcome: day: date; status: DayStatus; detail: str; rows: int | None; warnings: tuple[str, ...]`.
  - `plan_days(landed: set[date], unavailable: set[date], last_session: date, start: date = TAPE_START, cap: int = CATCHUP_MAX_DAYS) -> list[date]`: trading days in `[start, last_session]` that are neither landed nor unavailable, newest first, at most `cap`.
  - `rewritten_days(store: R2Store, api_key: str, last_session: date) -> list[date]`.
  - `land_day(day: date, store: R2Store, api_key: str, trailing_rows: list[int], relanding_etag: str | None = None) -> DayOutcome`.
  - `run_tape(settings: Settings, now_utc: datetime) -> list[DayOutcome]`.

**Behavior:**
- **`rewritten_days`:** for the last `REWRITE_RECHECK_DAYS` landed trading days that carry a `source-etag`, call `probe_source`. Where the ETag differs, those days are re-landed after the plan's days: `supersede` first, then put, status `relanded`.
- **`land_day`:**
  - Works in `WORK_DIR / day.isoformat()`, removed in `finally`.
  - `TapeDownloadError` `not_posted` on a day at least `UNAVAILABLE_AGE_TRADING_DAYS` trading days before the last session, or `outside_window` → `mark_unavailable`, status `unavailable`.
  - A more recent `not_posted` → status `not_posted`.
  - Any other error → `failed`, with `detail` = the error kind or class name.
  - The metadata holds every key in Global Constraints.
- **`run_tape`:** before each day it checks `shutil.disk_usage(WORK_DIR).free >= MIN_FREE_DISK_BYTES` and the run deadline (`time.monotonic`). Failing either marks that day and the rest `skipped_disk` or `skipped_deadline`.
- **`trailing_rows`:** the `rows` metadata of up to 20 landed days before the target day.

- [ ] **Step 1:** Write tests. They patch `tape_job.download_tape`, `tape_job.convert_zip` and friends at the module boundary, with moto for the store.
  - `test_plan_days`, as a table:
    - the backlog from 2026-06-16 to 2026-10-28, with 05-29 missing and the cap applied → the newest 30, descending;
    - unavailable days excluded;
    - days before `TAPE_START` excluded;
    - nothing missing → `[]`.
  - `test_land_day_success_puts_with_metadata`.
  - `test_land_day_cleans_work_dir_on_failure`.
  - `test_old_not_posted_marks_unavailable`: 05-29 with last session 10-28.
  - `test_recent_not_posted_is_not_marked_unavailable`: last session 10-28, day 10-28.
  - `test_one_bad_day_does_not_stop_others`.
  - `test_low_disk_skips_remaining_days`.
  - `test_run_deadline_skips_remaining_days`.
  - `test_rewrite_relands_after_supersede`.
- [ ] **Step 2:** Run `python -m pytest tests/test_tape_job.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `tape_job.py`.
- [ ] **Step 4:** Run the tests and ruff. Expected: PASS.
- [ ] **Step 5:** Commit `feat(nightly): Plan, land and re-land tape days one at a time`.

### Task 7: Entrypoint, Sentry and exit codes

**Files:**
- Create: `nightly/src/main.py`, `nightly/src/monitoring.py`, `nightly/tests/test_main.py`, `nightly/tests/test_monitoring.py`.

**Interfaces:**
- Consumes: `config.load_settings`, `tape_job.run_tape`, `DayOutcome`, `calendar_nyse.table_expiry_warning`.
- Produces:
  - `monitoring.init_sentry(dsn: str | None) -> None`.
  - `monitoring.scrub_event(event: dict, hint: dict) -> dict | None`.
  - `monitoring.report_outcome(outcome: DayOutcome) -> None`.
  - `main.main() -> int`.

**Behavior:**
- **`init_sentry`:** `include_local_variables=False`, `send_default_pii=False`, `server_name="nightly"`, tag `service=nightly`, `before_send=scrub_event`, `traces_sample_rate=0`.
- **`scrub_event`:**
  - Replaces the value of any exception raised by a `polars` module with `"<redacted polars message>"`.
  - Truncates every exception value to 300 characters.
  - Strips the query string from every breadcrumb `data.url` (signed GCS URLs).
- **`report_outcome`:** one Sentry message per day whose status isn't `landed` or `relanded`. Level `warning` for `not_posted` and `unavailable`, `error` for the rest. Tags `day` and `status`; the message has no data.
- **`main`:**
  1. Load the settings. A `ValidationError` logs the missing field names and returns 2.
  2. Init Sentry.
  3. `capture_checkin(monitor_slug="nightly-tape", status="in_progress", monitor_config=…)`.
  4. Start a daemon `threading.Timer(RUN_DEADLINE_SECONDS + 900, os._exit, (3,))` watchdog.
  5. `run_tape`.
  6. Log one summary line: counts per status, bytes, duration.
  7. Send a warning if `table_expiry_warning` returns text.
  8. Final check-in `ok` or `error` per the exit-code rule; `sentry_sdk.flush(10)`; return 0 or 1.

- [ ] **Step 1:** Write tests:
  - `test_all_landed_exits_0_and_checks_in_ok`.
  - `test_failed_day_exits_1_and_checks_in_error`.
  - `test_not_posted_exits_1`.
  - `test_bad_config_exits_2_without_secret`: the output contains `uw_api_key` and doesn't contain the other env values.
  - `test_scrub_redacts_polars_message`.
  - `test_scrub_strips_signed_url_query`.
  - `test_scrub_truncates_long_values`.
  - `sentry_sdk.capture_checkin` and `run_tape` are patched at the module boundary.
- [ ] **Step 2:** Run `python -m pytest tests/test_main.py tests/test_monitoring.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement `main.py` and `monitoring.py`.
- [ ] **Step 4:** Run the full suite: `cd nightly && python -m ruff check src tests conftest.py && python -m ruff format --check src tests conftest.py && python -m pytest --cov=src`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(nightly): Run the tape job with a Sentry cron monitor and honest exit codes`.

### Task 8: Docs and env wiring

**Files:**
- Modify:
  - `CLAUDE.md`: a `nightly/` block in Architecture, after `uw-stream/`.
  - The Environment Variables table: rows for `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE` as "Cloudflare R2 (Railway nightly + local scripts)".
  - The Deployment list of Railway services.
  - `.env.example`: the four R2 names with empty values.
- Create: `nightly/README.md`. It covers:
  - what the job does and its schedule;
  - its env vars;
  - how to run it once locally (`cd nightly && python -m main`, with env vars set);
  - where the days live in R2 and how to browse them in the Cloudflare dashboard;
  - how to force a re-land (delete the day's object);
  - the `_unavailable` and `_superseded` prefixes;
  - and the alert meanings.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run `npm run review`. Expected: green.
- [ ] **Step 3:** Commit `docs(nightly): Document the tape service, its env vars and runbook`.

### Task 9: Deploy and first run (main session, with the owner for secrets)

- [ ] **Step 1:** In the worktree: `git fetch origin && git rebase origin/main`, then `npm run review` and the nightly suite. Push with `git push origin HEAD:main`, after 15:00 CT.
- [ ] **Step 2:** Create the Railway service `nightly` from the GitHub repo (root directory `nightly`, config file `nightly/railway.toml`) in the existing project. Check that the cron schedule shows `15 7 * * 2-6`.
- [ ] **Step 3:** Variables:
  - `UW_API_KEY = ${{uw-stream.UW_API_KEY}}` and `SENTRY_DSN = ${{uw-stream.SENTRY_DSN}}` as Railway references.
  - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL` and `R2_BUCKET_FULLTAPE`: set with the authed Railway CLI (owner, 2026-10-28: "you should be able to handle those values via the railway cli which is authed").
    - A scratch script reads them from `F:/dev/strike-calculator/.env.local` and passes them to `railway variables` for the `nightly` service. It prints names only; the values never appear in a command line, log or chat. Check `railway variables --help` for the set syntax first.
    - Afterwards list the service's variable names (not values) to confirm all four are set.
- [ ] **Step 4:** Add an R2 lifecycle rule that aborts incomplete multipart uploads after 1 day: `put_bucket_lifecycle_configuration` through the S3 API, or the Cloudflare dashboard. Read it back.
- [ ] **Step 5:** Trigger a first run from Railway. Expected:
  - logs show up to 30 days `landed`, newest first, with no `InsecureRequestWarning`;
  - the R2 listing shows the new keys with metadata;
  - one new object's footer has the R2 legacy core dtypes;
  - the Sentry `nightly-tape` check-in is `ok`, or `error` with named days.
- [ ] **Step 6:** Update memory:
  - `project_uw_key_two_places`: UW_API_KEY now lives in three places.
  - `project_nightly_automation_goal`: phase 1 is live.
  - Then report to the owner.
