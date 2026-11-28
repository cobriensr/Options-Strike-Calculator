# Interval B/A replay, one file per day, kept by the nightly job

Owner-approved design, 2026-11-26 ("yes"). It extends `2026-11-24-interval-ba-rebuild-design.md` (§6.5 export, §6.6 nightly step, §6.8 research script).

## Why

The full-year replay (`research/interval-ba/replay-2026-11-25.parquet`, 18,478 alerts over 227 days, today's rule all year) is what studies should read. The live table has gap days that stay by owner decision, for example 06-03: 15 live rows against 79 on the tape. But the replay is a one-time snapshot. Task 14 makes the outcome and analyze scripts read the newest snapshot by default, so a December study would silently stop at 11-25.

The nightly `interval-ba-tape` step already replays each new session from the tape to heal its live rows, then throws the replayed alerts away. Keeping them costs one small write per night.

## Goals

- Every session from 2026-01-02 has a replay file, one per day, all under one rule. The nightly job adds each new session's file the morning after, and nobody has to run anything.
- By default, the three study scripts read every day file. A study run on day D sees every session through D−1 that has landed.
- A re-landed tape rewrites only its own day's file.

## Non-goals

- Re-replaying old days when the rule changes. That is left for later; see "Rule changes" below.
- Changing the live table, the heal, or the one-time snapshot already in R2. The snapshot stays and `--export-end` still reads it.

## Approaches considered

1. **One file per day, written by the nightly step (picked).** It adds one small object per session, its key comes from the source day, and a re-land rewrites one file. This is the layout `research-derive` already uses (`research/<family>/derived/{day}.parquet`).
2. **Rebuild the whole year nightly.** Today's export took 25 min to re-read 227 tapes, and that time would grow every night. The export also refuses to overwrite, so the objects would pile up.
3. **One rolling file, updated nightly.** Every night rewrites the whole year, and a re-landed old day has to be patched in the middle of the file.

## Design

**Key and contents.**
- **Key:** `research/interval-ba/replay/{day}.parquet`, with `{day}` the ISO session date.
- **Columns:** each file holds that session's replayed alerts in the export's columns and types (`_EXPORT_COLUMNS`, `_EXPORT_NULLABLE`), for all three tickers.
- **What fires:** the code's rule fires (`interval_ba_replay`), not whatever live ran that day. The step's settings checks, which can hold inserts, do not apply to the file.
- **Metadata:** the Parquet schema metadata `interval_ba` records `{"day", "rows", "rule", "created_at"}`.
  - `rule` is the snapshot's rule dict plus `"replay-version"`.
  - That value comes from a new hand-bumped constant, `REPLAY_VERSION = "1"`, in the replay module. It is bumped on any change to what `replay_day` outputs, constants or not, the way `research-derive` bumps `DERIVE_VERSION`.
  - The constants alone would miss a logic fix, such as the spot fill or a tie-break. A code hash would trip on edits to `heal_day` alone.
- **A quiet day:** a day with no alerts still gets a file, with zero rows, so "no alerts" and "not written" stay apart. A zero-row file is a replay or tape-read fault: no session has fired fewer than 19 alerts. It raises the step's `tape fired no alerts` health alert whether or not live has rows (final review M3), and that phrase outranks `inserts_held`. The fix is to rewrite that day with `export --per-day` once the cause is fixed. The nightly job never rewrites a marked day.

**One writer, shared, inside the replay module.**
- **Move.** The export schema, the table builder and the rule dict move out of `scripts/interval_ba_tape.py` into `nightly/src/interval_ba_replay.py` itself, not into a new module.
- **What moves:**
  - `EXPORT_COLUMNS`, `EXPORT_NULLABLE` and `REPLAY_DAYS_PREFIX`;
  - `rule()` and `day_key(day)`;
  - `export_table(alerts, meta)`.
- **Why there:** the tool already loads that module by path, with `nightly/src` kept off `sys.path` (`interval_ba_tape_runs.py:76-97`). The `ml` CI job's paths filter and the built-image import check already list it. A new module would need all three set up again.
- **Imports:** the module's import pin test (`nightly/tests/test_interval_ba_replay.py`) widens from duckdb, psycopg2 and the standard library to also allow pyarrow. pyarrow is in both `ml/.venv` and the nightly image.
- **Consumers:** the tool's snapshot export, the per-day export and the nightly step all build tables with `export_table`.
- **The enrich copy:** `scripts/enrich_interval_ba_outcomes.py` keeps its column-name copy. Its test now holds it to the replay module, not to the tool.

**Nightly write, before the heal commits.**
- In `interval_ba_step._heal`, the step replays the day once, writes and verifies the day file through `ResearchStore.put_file`, and then runs `heal_day` with that replay.
- **`heal_day`'s new parameter:** `heal_day` gains `replay: Replay | None = None` and uses it instead of replaying again. `Replay` gains a `day` field, which `replay_day` sets. `heal_day` raises `ValueError` when `replay.day` is not its day, because a wrong day's replay would insert that day's alerts and remove this day's replay rows.
- **A failed write fails the day.** The file is written before `heal_day` commits the day's `interval_ba_tape_days` marker. A failed write therefore leaves no marker, the existing per-day Sentry exception fires, and the day is retried the next night.
- **The cost, accepted:** a put that fails every night (a key bug, a token without write rights) also holds back that day's Neon heal and its live-health alert. The per-day exception still names the day. One step with one ordering beats a file that can lag its marker.
- A failure in `heal_day` after the write also retries the day, and the retry rewrites the file.
- The step counts `replay_days_written`.
- The local Parquet goes in the step's cache directory and is removed after the put.

**One-time backfill.**
- **The command:** `scripts/interval_ba_tape.py export --per-day --from 2026-01-02 --to <E>`, with `<E>` set by the two orders in Constraints. It runs after the push, from a checkout at `origin/main`, under the deployed-code guard below. It replays each day from the tape and writes its day file with the shared writer.
  - It overwrites, because day files are outputs a rerun rewrites.
  - It skips the snapshot's refuse-overwrite check.
- **Why re-read the tapes:** the backfill is the same code path a rule change will need later. So it re-reads the tapes (about 25 min, once) instead of splitting the snapshot.
- **Time windows:** like `heal --apply`, it checks the refusal windows (07:15–12:30 UTC, and market hours unless allowed) before each day's put, not only at the start. A 25-minute run must not write into the nightly window: the step may rewrite a re-landed day there, and a late backfill put would overwrite it with the old tape.
- **The tool's calendar:** it moves from its 2026-only holiday table to `nightly/src/calendar_nyse.py`, loaded by path (standard library only, 2025–2028). That keeps `export --per-day` and every other mode working after 2026.

**Readers.**
- The default source of all three scripts (`enrich_interval_ba_outcomes.py`, `analyze_interval_ba_cuts.py`, `analyze_confluence_vs_solo.py`) becomes the day files. They read `read_parquet('s3://<bucket>/research/interval-ba/replay/*.parquet')`, and the wildcard makes DuckDB list the prefix.
- `--export-end D` still reads the snapshot `replay-D.parquet`, and `--source table` reads the live table.
- **Checks on the day files:**
  - No day file at all exits with a message naming the prefix.
  - More than one distinct `rule` across the files exits with a message naming the days on each rule.
  - The first day, the last day and the day count are printed and go in the MD header. The count comes from the file listing, not the alert rows, so a zero-row day counts.
- **Missing or stale days, repaired first (owner 11-26: "try to fix itself first, then refuse").** A day file can go missing: its `interval_ba_tape_days` marker can exist with no file, after a hand `heal --apply` or a heal from before 15a shipped. A file can also go stale: a re-landed tape on a night the step does not run keeps its marker, so the step never rewrites the file (the marker limit at `nightly/README.md:656-660`). The step's retry follows the marker, not the file, so the readers check and repair.
  - **The days a run needs:**
    - **Enrich:** the NYSE trading days of its `--from-date`..`--to-date`, by default 2026-01-02 through the newest landed tape (`fulltape/{day}-fulltape.parquet`).
    - **Analyze:** the days its outcomes CSV covers, from the first to the last `fired_at` in the CSV. Analyze reads only those days' files, so alerts the CSV never priced do not drop out unseen. It prints "K of N alerts joined a path" and exits non-zero when K is 0 (Task 14's guard).
    - **Calendar:** `nightly/src/calendar_nyse.py`, loaded by path.
  - **Missing:** a needed day with no file.
  - **Stale:** a needed day whose file's LastModified is older than its tape's. The repair takes both listings from the tool's R2 helpers (`interval_ba_tape_runs`), which carry LastModified.
  - **Not gaps:** a day UW marked as not posted (`fulltape/_unavailable/{day}.json`) is printed and skipped.
  - **The repair.** It calls the tool's per-day writer (a function in `scripts/interval_ba_tape.py`, imported only when a repair is needed). That is the same function `export --per-day` runs, with market hours allowed: the repair writes only research files, never Neon.
    - It replays each missing or stale day and writes its file. The script then reads the files again and goes on.
    - Each repaired day is printed with "the nightly should have written it; check the interval-ba-tape step".
    - The MD header lists the repaired days.
  - **Deployed code only.** Every per-day write, whether the repair or the hand `export --per-day`, runs only when the local `nightly/src/interval_ba_replay.py` has no uncommitted change and its git blob equals `origin/main`'s. That is the code the nightly job runs.
    - Otherwise the write refuses: a work-in-progress logic edit without a `REPLAY_VERSION` bump would pass the rule check and stay in R2 for good.
    - The message says to run from a checkout at `origin/main`.
    - The `rule()` check against the files' rule stays as a second guard.
  - **Refused**, with an exit and a message, and no study:
    - a needed day whose tape is not in R2: wait for the nightly run, or use `--source table`;
    - a repair inside 07:15–12:30 UTC (the nightly window, so it cannot race the step), with the time to retry;
    - more than 10 days to repair. That points to a broken nightly write, and the message prints the one `export --per-day` command that fills them;
    - local replay code that is not `origin/main`'s;
    - `--dry-run` with any day to repair. A dry run never writes to R2; it lists the days and exits non-zero.
  - **Cost:** one list of the day-file prefix and one of the tape prefix per run, plus about 10 s per repaired day.
- **Outcome file names say which source they came from:**
  - the day files: `interval-ba-outcomes-days[-<ticker>]-<stamp>.csv`;
  - the snapshot: `interval-ba-outcomes-export[-<ticker>]-<stamp>.csv`;
  - the table: today's names.
- **Matching runs:** the analyze scripts take the newest CSV of the source they are run with. They never join day-file alerts to a snapshot's paths. The MD header names the source: the prefix, or the snapshot key.

**Rule changes (later).** A change to the replay constants or a bump of `REPLAY_VERSION` makes new day files carry a new `rule`, and the readers then refuse the mixed set. The fix is to re-run `export --per-day` over the old days. That is a hand step for the owner, and the readers' message says so.

## Constraints

- Nightly pushes go after 15:00 CT and outside 07:15–12:30 UTC. `nightly/src/**` is a watch path.
- **15a ships in the same push as Tasks 10–11,** so no session is healed and marked by a step that writes no file. Tasks 10–11 wait for 15a.
- **Two backfill orders:**
  - If Ops C runs before that push's first nightly run, its `--to` is 11-25.
  - If it runs after, its `--to` is the last session before that run. Its count is then 227 plus the nightly's days.
- `nightly/README.md` lists the new key in the research outputs table with **output** as its kind, since the job never reads the files back. Its `interval-ba-tape` section describes the write and its order. A failed day leaves no marker, and may leave a file that the retry rewrites.
  - The section also notes the known gap: a re-landed day on a night the step does not run keeps its marker and its old file. The step never re-heals it; this is the existing marker limit. The readers' stale check rewrites the file on the next study, and the Neon heal still needs the marker deleted by hand, as today.
- **Code paths:**
  - `nightly/src/calendar_nyse.py`, now loaded by path, joins the `ml` CI job's paths filter (`.github/workflows/ci.yml`, next to `interval_ba_replay.py`) and the tool's `TOOL_FILES` hashes.
  - A test pins `(REPLAY_VERSION, the sha256 of a fixture tape's replay output)`. That way a change to the replay output without a version bump fails the test.
- No test touches R2 or Neon: the nightly tests block non-loopback sockets, and the scripts tests use the loopback fake S3 or local files.
- The backfill writes to R2, which is a production store. It runs once by hand, under the owner's approval of this design (11-26), and only after one day has been checked by hand: its new file's rows must equal the snapshot's rows for that day.

## Left to the builder

- How `put_file` failures surface in the step's log line, beyond the day failing.
- Test fixtures and names, past those the plan lists.

## As built (15b)

Where the readers and the tool, as built, differ from the text above, or add to it. The readers' shared code is `scripts/_interval_ba_days.py`; the scripts keep their own snapshot reader.

- **A zero-row day is never read.** Where "Key and contents" and "Readers" say a zero-row day still counts, that held until the review of 15b-2 reversed it. A kept day file whose footer says `rows` is 0 is the third reason for a repair, beside missing and stale: the reader replays it again. The replay either finds the alerts, or the repair's own zero-row refusal meets it on every run. The count in the header is of days read, none of which is empty.
- **A short day is warned about.** A kept or repaired day with fewer than 19 alerts (and more than 0) is printed as a `WARN` line and named in the header. It is read as it is: a warning, never a refusal.
- **An explicit list, not a wildcard.** The readers read the URLs of the needed days, not `read_parquet('.../replay/*.parquet')`, so that an analysis reads only its CSV's days; the check, which lists the prefix, decides them first.
- **The listings' helpers.** The tool's R2 helpers did not carry a LastModified listing. `list_objects` and `nightly_window_end` were added to `scripts/interval_ba_tape_runs.py`.
- **`--dry-run` is a check.** With the day files it never writes, lists the days a repair would write, and exits non-zero when there are any or when something would refuse one, including the writer's deployed-code guard. When nothing needs a repair it says the day files are present and current and stops, with no tape, alert or CSV read. With the snapshot or the table it still runs and writes no file.
- **`--export-end` given alone means the snapshot** (`--source export`). With `--source days` or `table` it is a usage error.
- **The footer is checked against the key.** A footer with no readable `day`, `rows` and `rule`, or one whose `day` is not its key's day, is refused, naming the day.
- **The writer's R2 settings must agree with the reader's.** The reader takes R2_* from the shell, then `.env.local`; the tool's `load_env` takes them from the env file alone. Before a repair, the two sets are compared, and a difference refuses it, naming the variables and never the values.
- **A priced CSV is checked against the day files.** The outcome script writes the newest day-file LastModified it read into its summary. An analysis compares that with its own listing and names, in its report and on stdout, every day whose file is newer (repaired by this run, or rewritten since by the nightly): its paths were priced from the older file.
- **More refusals and messages.** No day file at all, with more than ten days to write, names the prefix and the backfill, not a broken nightly write. A repair refuses when the deployed-code guard would. Days named past twelve show the count, the span and the first twelve. The days UW posted no tape for are named in the header. R2 and DuckDB errors show their class only, since their text can carry the account host.
