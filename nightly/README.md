# nightly

Railway cron service (`nightly`) that lands the Unusual Whales options Full Tape
in Cloudflare R2: one Parquet object per trading day. After the tape it fills the
Lottery Finder and Silent Boom outcomes in Neon from that tape, and checks that
recent sessions have them. It runs once and exits.

## What it does

Each run:

1. Lists the days already in R2 and plans the newest missing sessions, up to 30
   days of catch-up (`CATCHUP_MAX_DAYS`). The calendar starts at 2026-01-02
   (`TAPE_START`). A planned day starts only inside the window under "How much of
   the run the tape gets", so a long backlog can take more than one night.
2. For each planned day, newest first: downloads the zip from UW, converts it to
   Parquet with polars (zstd level 3), checks it (see "Row and day checks"), and
   uploads it to R2. The upload is checked against the local byte count. A
   failed check deletes the object, so an unverified day never counts as landed.
3. Then probes the newest 5 days of the run's listing (`REWRITE_RECHECK_DAYS`),
   and re-lands each day whose UW ETag changed since it landed. The probes come
   after the planned days, so a slow probe never costs a missing day. A probe
   starts only with at least 1200 s (`PROBE_BUDGET_SECONDS`) left before the tape
   deadline (below), so a stalled one ends before the watchdog; the rest are
   probed the next night. A run whose planned days were skipped for disk or
   deadline probes nothing.
4. Runs the steps in `STEPS` (`src/pipeline.py`), in order, whatever the tape did,
   including when it raised or every day failed. The one exception: if the last
   session cannot be resolved (the NYSE holiday table does not cover the year,
   `CalendarExhausted`), no step runs.
   - `enrich-outcomes` fills the outcome columns of `lottery_finder_fires` and
     `silent_boom_alerts` from the tape in R2 (see "Enrichment").
   - `outcome-check` alerts when the fires of a recent session have no outcomes
     (see "Alert meanings").

   Each step has its own deadline, which leaves every later step its reserve, so
   an earlier step never starves a later one. A step that starts with less than
   its own reserve left is skipped (`skipped_deadline`) and the later ones still
   run. A step that raises fails that step alone: the tape and the other steps are
   unaffected. A step's module is imported when the step runs, so one that fails
   to import fails only that step.

5. Reports each day and each step to Sentry as soon as it finishes, then exits.

Logs go to stdout: Railway labels every stderr line an error.

### How much of the run the tape gets

The tape and the steps share the 5 h run. The tape stops at the run deadline less
the steps' reserve (`reserve_seconds(STEPS)`, the sum of their `min_seconds`), and
starts a day only with `DAY_BUDGET_SECONDS` of that left. So a day starts only in
the first `RUN_DEADLINE_SECONDS − reserve − DAY_BUDGET_SECONDS` seconds of the run:

| Quantity                                                                             | Seconds             |
| ------------------------------------------------------------------------------------ | ------------------- |
| Run deadline (`RUN_DEADLINE_SECONDS`)                                                | 18,000 (5 h)        |
| Steps' reserve: `ENRICH_DAY_BUDGET_SECONDS` 900 + `OUTCOME_CHECK_BUDGET_SECONDS` 300 | 1,200               |
| Tape deadline: 18,000 − 1,200                                                        | 16,800 (4 h 40 min) |
| Minimum left to start a day (`DAY_BUDGET_SECONDS`)                                   | 3,600               |
| Window in which a day may start: 16,800 − 3,600                                      | 13,200 (3 h 40 min) |

A night starts about 13,200 divided by the seconds one day takes. Every step added
to `STEPS` takes its `min_seconds` out of the window. The plan puts it at 11,400 s
once phase 4's refit step is in, and at 6,900 s once phase 3's research and report
steps are too (enrich budget at 900 s; the stage table in D2 of
`docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md`).
`test_deadline_constants_bound_the_run` (`tests/test_main.py`) fails if the reserve
leaves less than two `DAY_BUDGET_SECONDS` of the run for the tape.

Constants (deadlines, retries, thresholds) live in `src/constants.py`, not in
env vars. Design and decisions:
`docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md`.

## Schedule and Railway settings

The schedule, restart policy and watch paths are set on the Railway `nightly`
service itself, not in the repo. There is no `railway.toml`: Railway refused a
config-file path (config-as-code is deprecated).

- Cron `15 7 * * 2-6` (UTC): Tuesday to Saturday at 07:15 UTC, covering the
  session that closed the day before. The Sentry monitor's crontab
  (`MONITOR_CONFIG` in `src/main.py`) must match it; changing one means changing
  both.
- Restart policy `NEVER`: a failed run alerts and waits for the next night
  instead of looping and re-downloading the tape.
- Root directory `/` (the repo root) and Dockerfile path `/nightly/Dockerfile`.
  The build context is the repo root because the image copies six files from
  outside `nightly/`, the enrich scripts and what they import (`IMAGE_FILES` in
  `tests/test_image_layout.py`; build it with `docker build -f nightly/Dockerfile .`).
- Watch paths, exactly these ten: only the image inputs redeploy, so doc and test
  edits don't.
  - `/nightly/Dockerfile`
  - `/nightly/requirements.txt`
  - `/nightly/src/**`
  - `/.dockerignore`
  - `/scripts/_tape_reader.py`
  - `/scripts/_cli_paths.py`
  - `/scripts/_pipeline_retry.py`
  - `/scripts/enrich_lottery_outcomes.py`
  - `/scripts/enrich_silent_boom_outcomes.py`
  - `/ml/src/lottery_exit_policies.py`

A file added to or removed from the image changes six places together, listed at
the top of the `Dockerfile`: its `COPY` lines, these watch paths, the root
`.dockerignore`, `IMAGE_FILES`, the `nightly` filter in `.github/workflows/ci.yml`
and this list. `test_readme_lists_every_watch_path` fails when this list lacks one
of `IMAGE_FILES`.

**Push hazard.** A redeploy during a run (about 07:15 to 12:30 UTC) can stop the
run. A push that touches any watch path redeploys the service, and the list above
includes files that other work edits: the shared scripts under `scripts/`, the one
under `ml/src/` and the root `.dockerignore`. Push any change to a watch path
after 15:00 CT and outside 07:15 to 12:30 UTC. A killed run isn't retried until
the next night unless someone runs `railway cron run --service nightly`.

## Env vars

Set on the Railway `nightly` service. Boot fails naming the field if a required
one is missing. There is no `.env` reading and no secrets on the command line.

| Variable               | Required | Notes                                                |
| ---------------------- | -------- | ---------------------------------------------------- |
| `UW_API_KEY`           | yes      | Unusual Whales key with Full Tape access             |
| `R2_ACCESS_KEY_ID`     | yes      | Cloudflare R2 access key                             |
| `R2_SECRET_ACCESS_KEY` | yes      | Cloudflare R2 secret                                 |
| `R2_ENDPOINT_URL`      | yes      | R2 S3 endpoint; must start with `https://`           |
| `R2_BUCKET_FULLTAPE`   | yes      | Bucket that holds the `fulltape/` prefix             |
| `DATABASE_URL`         | yes      | Neon URL; scheme `postgres://` or `postgresql://`    |
| `SENTRY_DSN`           | no       | Without it Sentry is off; a malformed one fails boot |

The same variable names are in the repo `CLAUDE.md` env table. The bucket also
holds `gexbot-eod/`, written by another job; this service never touches it.

`DATABASE_URL` is a Railway reference to uw-stream's variable
(`${{uw-stream.DATABASE_URL}}`), so a rotation reaches both services. The steps
use it: `enrich-outcomes` updates rows in `lottery_finder_fires` and
`silent_boom_alerts`, and `outcome-check` reads them. It may be Neon's pooled
URL. The job connects to the direct host instead (`-pooler` removed from the
first host label, same credentials), because the pooler rejects the statement
timeout the job sets at connect (`DB_STATEMENT_TIMEOUT_MS`, 300 s).

## Where the days live in R2

All keys are in the bucket named by `R2_BUCKET_FULLTAPE`:

| Key                                                | Meaning                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| `fulltape/{YYYY-MM-DD}-fulltape.parquet`           | A landed day. Its presence is what "landed" means.                |
| `fulltape/_unavailable/{YYYY-MM-DD}.json`          | Marker: UW will not supply this day. The planner skips it.        |
| `fulltape/_superseded/{YYYY-MM-DD}-{etag}.parquet` | The previous object, copied aside before a re-land overwrites it. |

To browse them, open the Cloudflare dashboard, then R2, then the bucket, then
the `fulltape/` prefix. The `_unavailable/` and `_superseded/` folders sit
inside it. Listings count only keys that match
`fulltape/{YYYY-MM-DD}-fulltape.parquet` exactly, so the two sub-prefixes never
count as landed days.

New objects carry user metadata: `rows`, `sha256`, `schema-version`,
`source-etag`, `source-last-modified`, `source-bytes`, `ingested-at`. An object
with no metadata is a legacy day: it still counts as landed, but it is never
probed for a rewrite and is skipped by the row-count baseline.

`_superseded/` copies are never deleted by the job. Delete old ones by hand once
the re-landed day has been checked.

## Day statuses

Each planned day ends in one of these:

- `landed`: downloaded, converted, uploaded and verified.
- `relanded`: a landed day whose UW ETag changed was replaced. The old object is
  in `_superseded/`.
- `not_posted`: UW has not posted the day yet, and it is fewer than 5 sessions
  old (`UNAVAILABLE_AGE_TRADING_DAYS`). Retried next night.
- `unavailable`: UW will not supply the day; a marker was written. See below.
- `failed`: the day did not land. Retried next night. The detail is one of:
  - a download error kind (`transient`, `auth`, `quota_daily`, `corrupt`,
    `timeout`, `unexpected`), `outside_window`, `outside_window short-window`,
    `not_posted uw` or `not_posted unknown`;
  - an exception class name (`TapeValidationError`, `R2VerifyError`,
    `ClientError` or a botocore subclass such as `NoSuchKey`, ...);
  - `row floor` or `wrong-day tape` (see "Row and day checks");
  - `re-land row drop` (see "Re-lands");
  - `marker cap`: the day would have been marked, but the run had already
    written its 2 markers.
- `skipped_disk`: free disk in the work dir was below 15 GiB, or the disk check
  failed. This day and every later one in the run are skipped.
- `skipped_deadline`: less than 3600 s (`DAY_BUDGET_SECONDS`) was left before the
  tape deadline (the 5 h run deadline less the steps' reserve, see "How much of the
  run the tape gets"). This day and every later one in the run are skipped.

## When a day is marked unavailable, and how to undo it

A marker is permanent, so it is written only on UW's own evidence, and never
while re-landing an already landed day:

- UW answers with a historic-window 403 whose own earliest-date phrase names a
  date after the day, and that date is at least 690 days before the last
  session (`OUTSIDE_WINDOW_MIN_LOOKBACK_DAYS`). The 403 states the boundary for
  this token, and a full plan's window is about 2 years, so a newer boundary
  means the entitlement shrank, not that UW lacks the day: that is `failed`
  with detail `outside_window short-window`. A 403 with no such date, or with an
  old one on or before the day, is `failed` with detail `outside_window`.
- The tape request is redirected to Google Cloud Storage and GCS returns 404, and
  the day is at least 5 trading days old (`UNAVAILABLE_AGE_TRADING_DAYS`). A
  404 from UW's own API is `failed` and retried. A GCS 404 on a younger day is
  `not_posted`.

A run writes at most 2 markers (`MAX_MARKERS_PER_RUN`). A later day that would
be marked is `failed` with detail `marker cap` and retried the next night. Each
marker opens its own Sentry issue, so each one alerts.

To undo a marker, delete `fulltape/_unavailable/{d}.json` in the Cloudflare
dashboard. The next run plans that day again.

## Row and day checks

After the convert, and before anything in R2 changes:

- **Row floor** (hard): a tape with fewer than 1,000,000 rows (`MIN_TAPE_ROWS`)
  is `failed` with detail `row floor`. Nothing is put. Real days run 7.68M to
  14.93M rows, and half-days about 4M to 5M.
- **Wrong-day tape** (hard): a tape whose every trade falls outside the
  session window is `failed` with detail `wrong-day tape`. The window is the
  tape's own daily boundary, from 20:00 ET the day before the session to 20:00 ET
  on the session date. A tape that only partly overlaps it lands, with a
  warning.
- **Row ratio** (warning only): a day with fewer than 0.65 times
  (`PLAUSIBLE_MIN_ROW_RATIO`) the median `rows` of the 20 nearest landed days
  that carry `rows`, before or after it, lands with a warning. Legacy days are
  skipped, not counted as slots. It needs at least 10 such days
  (`PLAUSIBLE_MIN_TRAILING`). Because the baseline reaches both ways, a backfill
  day has one from the days landed after it.

The 0.65 ratio was tuned on 112 full days, so the half-days 2026-11-27 and
2026-12-24 will trip the row-ratio warning. They stay well above the floor and
land; the warning on those two days is expected.

## Forcing a re-land

Delete the day's object, `fulltape/{d}-fulltape.parquet`. The next run sees the
day as missing and lands it again. A run plans at most the newest 30 missing
days, so a day deleted from further back waits until the days after it have
landed. The new object counts as `landed`, not `relanded`. The same night
`enrich-outcomes` clears the outcome markers of every day the tape landed, so the
new tape's outcomes replace the old ones with no step by hand. If that clear does
not run that night, see "A day landed or re-landed tonight" under "Enrichment".

## Re-lands

The automatic path needs no action: a changed UW ETag on any of the newest 5
landed days triggers a re-land on its own.

- The new tape goes through the same checks as any day. On top of them, a new
  tape with fewer than 0.65 times the replaced object's `rows` is `failed` with
  detail `re-land row drop`, and the old object stays.
- The old object is copied to `_superseded/` right before the put, after the
  download, convert and checks. A re-land that fails earlier leaves R2 as it was.
  If the copy fails, the day is `failed` and nothing is put.
- Every re-land is reported to Sentry as a warning: the healthy rate is about
  zero. When the new tape's `rows` and `source-bytes` both equal the replaced
  object's, the title is `nightly re-land identical content` instead, since the
  same content under a new ETag suggests ETag churn rather than a rewrite.
- When there were days to probe but none could be compared (every probe failed,
  returned no ETag or was left for lack of probe budget), the run sends one
  warning, `nightly rewrite check unavailable`, with the day count in `days`.
- The same night, `enrich-outcomes` clears the outcome markers of every day the
  tape landed, re-landed days included, so the new tape's outcomes replace the old
  ones (see "Enrichment").

## Enrichment

The `enrich-outcomes` step fills the outcomes of Lottery Finder fires
(`lottery_finder_fires`) and Silent Boom alerts (`silent_boom_alerts`) in Neon from
the tape in R2. It runs the two owner scripts in place,
`scripts/enrich_lottery_outcomes.py` and `scripts/enrich_silent_boom_outcomes.py`,
with `select="all"` for the Full Tape: the same work as `--r2 --select all` on a
workstation. The tape has the final say over outcomes (owner, 2026-11-06), since
the websocket feed drops prints and cannot replay them.

**What counts as work.** A fire is work until the tape has examined it at the
current version. The scripts use one predicate both to list the work and as the
guard on the tape's writes (`OUTCOME_WORK_ALL['fulltape']`):

```sql
outcome_tape_version IS NULL OR outcome_tape_version < OUTCOME_VERSION
```

`OUTCOME_VERSION` is 1 in both scripts. What another writer left in the row (the
crons' values, `enriched_at`, untagged history) does not matter. Each night the
step lists every day from `TAPE_START` through the last session that has work in
either table and works them newest first. So it backs up a day the closing crons
missed, and it backfills the history: the history drains over the nights until no
day has work left. Bumping `OUTCOME_VERSION` makes all of it work again, over
several nights. Lottery Finder's inversion pass keeps its own work set,
`realized_flow_inversion_pct IS NULL AND inversion_source IS NULL`; a day whose only
work is inversion is listed once the matched side's net flow exists.

**What it writes.** For each fire:

- The tape can price it: the outcome columns are set and replace what another writer
  left, and the row gets `outcome_source = 'fulltape'`, `outcome_version = 1` and
  `outcome_tape_version = 1`.
- The tape cannot price it (no chain, no print at or after entry, an unusable entry
  price or a non-finite outcome): any value another writer left stays ("kept for
  now"), and the row is only marked examined, so it is not picked again until the
  version changes. A fire with no earlier outcome is also tagged
  `outcome_source = 'fulltape'` with its outcomes left NULL. That is "tagged with
  NULL outcomes": the fire was examined and stamped (`stamped_no_outcome`) without
  an outcome. It means tried, not pending.

**Provenance columns** (migrations #201 and #202):

| Column                                  | Values                                 | Meaning                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome_source`                        | `fulltape`, `bot_eod`, `ws_cron`, NULL | Who wrote the outcomes: a script reading the Full Tape from R2 or a local directory (this step, or a local run), the Bot-EOD script (fills only), the two Vercel enrich crons |
| `outcome_version`                       | 1, NULL                                | The computation (`OUTCOME_VERSION`); set exactly when the source is                                                                                                           |
| `outcome_tape_version`                  | 1, NULL                                | The tape pass that examined the row (`OUTCOME_VERSION` when it ran); NULL means the tape has not                                                                              |
| `inversion_source`, `inversion_version` | `fulltape`, `bot_eod`; 1               | The same for `realized_flow_inversion_pct` (`INVERSION_VERSION`), on `lottery_finder_fires` only                                                                              |

A NULL source and version mean no writer has tagged the row: it was written before
the columns existed, or it has no outcome yet. A `ws_cron` source next to a non-NULL
`outcome_tape_version` is a feed value the tape could not price and kept.

**Each night.** A day with work but no landed tape waits (`days_waiting_tape`, no
alert); the step works it once the tape lands. For a landed day the step downloads
its tape to `/tmp/nightly/enrich` (`ENRICH_CACHE_DIR`, emptied when the step opens its
reader, one day on disk at a time, each download bounded at 600 s by
`FETCH_DEADLINE_SECONDS` in `_tape_reader.py`), runs both scripts on one fresh Neon
connection, and releases the file. It stops for the night, leaving the rest as
`days_left`, when less than `ENRICH_DAY_BUDGET_SECONDS` (900 s) of its time is left,
or when failed days plus all-NULL (table, day) pairs reach `ENRICH_MAX_DAY_FAILURES`
(3): a broken tape layout or chain format fails or nulls every day, and each costs a
download. A day that raises is counted, sent to Sentry once, and the loop goes on.

The step's result is `failed` if a day failed or came back all-NULL, else `partial`
if days are left, else `ok`. Its counts are in the log line `step enrich-outcomes ...`
and in the `counts` extra of the step alerts: `days_processed`, `days_failed`,
`days_waiting_tape`, `days_left`, `tape_markers_reset` (rows whose marker was
cleared), `null_days` and `low_days` (these two count (table, day) pairs), and per
table `lottery_` / `silent_boom_` plus `outcomes_written`, `stamped_no_outcome`,
`outcomes_replaced` (the tape's value overwrote an earlier outcome) and
`outcomes_kept` (the tape could not price a fire that held a value, which stayed).
The Lottery Finder pass adds `inversion_written`, `inversion_stamped` and
`inversion_input_missing`. The log line for each day names its date, a status
(`ok`, `no outcomes` or `failed (<ExceptionClass>)`) and its non-zero counts, never
an exception's text.

**A day landed or re-landed tonight.** The rows of a day whose object the tape job
put in R2 tonight (`landed` or `relanded`) may carry the marker of the tape it
replaced, or of a local Full Tape run, so the work set would never look at them
again. That is the case for a re-land the ETag probe found (`relanded`) and for a
day whose object was deleted by hand to force one, which lands as `landed`. Before
it lists the work, the step clears `outcome_tape_version` on those days' fires in
both tables, in one statement so that both clear or neither does
(`tape_markers_reset` counts the rows). A first land has no markers, so for it the
clear changes nothing. Only the marker is cleared: the old outcomes stay until the
new tape replaces them, where it can price a fire. A re-landed day keeps the old
tape's inversions, because their work set needs the value to be NULL and clearing
values is destructive.

The clear is lost when it does not run on the night the day lands: the statement
fails, the step is skipped for its deadline or fails before the statement (an
import error, its Neon connection), or the run is killed after the land. Nothing is
cleared, and the next night the tape job no longer reports the day, so its rows
keep the old tape's outcomes until `OUTCOME_VERSION` is next bumped or someone
clears the markers by hand (below).

**Re-trying a day, by hand only.** To make the step look at a day again, for
example after fixing what made a tape come back with no outcomes, or after the
clear above was lost, clear that day's markers in both tables (the reset the step
runs for a day landed tonight), and run both statements:

```sql
UPDATE lottery_finder_fires SET outcome_tape_version = NULL
 WHERE date = '<day>' AND outcome_tape_version IS NOT NULL;
UPDATE silent_boom_alerts SET outcome_tape_version = NULL
 WHERE date = '<day>' AND outcome_tape_version IS NOT NULL;
```

The next night's step redoes the day: the tape's values replace the old ones where
it can price a fire, and the old ones stay where it cannot. Clearing outcome values
is never needed, and inversions are not redone this way. The day must be landed in
R2, or it waits.

**Dry run on a workstation.** From the repo root, with the four `R2_*` variables and
a database URL in the environment or in `.env.local` (which points at the production
database), `--dry-run` reads Neon and R2 and writes nothing. Every summary line
says "would". The scripts use `DATABASE_URL_UNPOOLED` if it is set and `DATABASE_URL`
otherwise, so check which one your shell exports:

```bash
ml/.venv/Scripts/python scripts/enrich_lottery_outcomes.py --r2 --select all --dry-run --date 2026-10-20
ml/.venv/Scripts/python scripts/enrich_silent_boom_outcomes.py --r2 --select all --dry-run --date 2026-10-20
```

Without `--dry-run` the same command writes to the database. Without `--date` the
newest landed day is used.

## Alert meanings

All Sentry events carry the tag `service=nightly` (`server_name=nightly`). A day
event also carries tags `day` and `status`. An unlanded day is grouped by status
and `detail`, so a new kind opens a new issue; an `unavailable` day is also
grouped by its date, so each marker opens its own issue. A `relanded` day is
grouped by its date (and whether its content was identical), so each re-land
opens its own issue and alerts. An unlanded day's extras are `detail`,
`warnings` and `reason`. `reason` says more about a failure, but only where the
text is log-safe by contract: a `TapeValidationError`'s or `R2VerifyError`'s
message (names, counts and keys only), or a botocore `ClientError`'s error code.
Otherwise it is empty. It never changes the grouping.

| Sentry title                             | Level   | Meaning                                                                                                                                                                                                          |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nightly tape day failed`                | error   | A day did not land. `detail` names the kind; `reason` may say more. Retried next night.                                                                                                                          |
| `nightly tape day skipped_disk`          | error   | Free disk too low; the rest of the run was skipped.                                                                                                                                                              |
| `nightly tape day skipped_deadline`      | error   | The run ran out of time; the rest was skipped.                                                                                                                                                                   |
| `nightly tape day not_posted`            | warning | UW had not posted a recent day. Usually clears itself.                                                                                                                                                           |
| `nightly tape day unavailable`           | warning | A marker was written; one issue per day. Check it was expected.                                                                                                                                                  |
| `nightly tape day landed with warnings`  | warning | Landed, but a plausibility check flagged it (row ratio or time window) or cleanup failed.                                                                                                                        |
| `nightly tape day relanded`              | warning | A day was re-landed after its UW ETag changed. Sent for every re-land, one issue per day; `warnings` lists any flags.                                                                                            |
| `nightly re-land identical content`      | warning | A re-land whose `rows` and `source-bytes` equal the old object's: likely ETag churn, not a rewrite. One issue per day.                                                                                           |
| `nightly rewrite check unavailable`      | warning | No probed day could be compared, so a rewrite would go unseen. `days` is how many were left unchecked.                                                                                                           |
| `nightly step failed`                    | error   | A step finished `failed` without raising. `enrich-outcomes`: a day failed or came back with no outcomes. `outcome-check`: a recent session has no outcomes. Read the alerts below and the run log.               |
| `nightly step partial`                   | warning | A step ran out of time with work left for the next night (`days_left` in `counts`). Expected while the history drains; look only if it persists.                                                                 |
| `nightly step skipped_deadline`          | error   | A step started with less than its own reserve left, so it did not run (the later steps still did). The tape or an earlier step overran its share; the next night runs it again.                                  |
| `nightly outcomes all null`              | error   | `outcome-check`: a table has fires on one of the last 3 sessions (`OUTCOME_CHECK_SESSIONS`) and none has an outcome. Tags `table`, `day`; extras `rows`, `with_outcome`. One issue per table and day. See below. |
| `nightly outcomes mostly null`           | warning | `outcome-check`: fewer than 95% (`LOW_OUTCOME_SHARE`) of a table-day's fires have an outcome. One warning per run; `days` lists `table:day`. Fires the tape cannot price stay without one (see "Enrichment").    |
| exception tagged `step`                  | error   | A step raised (a database error, an import error). The step is `failed` and the log names the exception class; no `nightly step failed` event follows.                                                           |
| exception tagged `step` and `day`        | error   | One day of `enrich-outcomes` raised (its download, its connection, either script's pass). Counted in `days_failed`; the step goes on with the next day and retries this one next night.                          |
| `nightly config invalid`                 | error   | Bad config. `fields` names the invalid settings. Sent only if `SENTRY_DSN` is valid.                                                                                                                             |
| `NYSE holiday table ends in {year}; ...` | warning | From Oct 1 of the table's last year. Add the next year to `calendar_nyse.py`, or the job refuses to run.                                                                                                         |

A run that fails before its first day (R2 listing, work dir setup) sends the
exception itself as an error event, and the steps still run. If the last session
cannot be resolved (an exhausted calendar), the exception is sent and no step runs.

A step alert carries the tags `step` and `status`, and the extras `counts` (names
and integers) and `detail` (a fixed phrase). An `ok` step sends nothing. The
fingerprint is the step, status and `detail`, so the same reason night after night
stays one issue, and Sentry's new-issue rule mails once for it until the issue is
resolved (owner, 2026-11-06). Resolve it after a fix so the next failure mails
again. A new reason opens, and mails as, its own issue. Exception events go through
the scrubber: a data library's message is replaced and any other is cut to 300
characters.

**When `nightly outcomes all null` fires.** The enrich crons (21:40 to 23:45 UTC)
and tonight's `enrich-outcomes` both left that table-day without an outcome. Find
the day's `enrich <day>` line in the run log:

- `waiting for the tape`: the day's tape is not in R2 yet. Check
  `fulltape/{day}-fulltape.parquet`; the step works the day once it lands.
- `failed (<ExceptionClass>)`: the step retries the day next night with no action.
- `no outcomes`: the tape examined the fires and priced none of them, so a retry
  alone changes nothing. Suspect a changed tape layout or option-chain id format,
  which would null every day (the step stops after 3). Fix the cause, then clear the
  day's markers by hand (see "Enrichment").
- No `enrich <day>` line at all. Either the day had no work left, so an earlier
  night already examined it and priced none of it (treat it as `no outcomes`), or
  the step did not reach the day. Look for `nightly step skipped_deadline`, an
  exception tagged `step`, or `days_left` in the `step enrich-outcomes` line.

The Sentry cron monitor `nightly-tape` (crontab `15 7 * * 2-6`, UTC) checks the
run in and out:

- **Missed**: no check-in within 30 minutes (`checkin_margin`) of 07:15 UTC. The
  job did not start. Check that the service is deployed and the cron is enabled.
  With no valid `SENTRY_DSN`, a bad-config run also shows as missed.
- **Timeout**: the run was still going after 330 minutes (`max_runtime`), or the
  container was killed (out of memory, or SIGKILL on a redeploy) before it could
  check out.
- **Error**: the run ended with exit code 1, 2 or 3, or was stopped by SIGTERM.

Exit codes:

- `0`: every planned day landed, re-landed or was correctly marked unavailable,
  and every step finished `ok` or `partial` (work left for the next night, which
  sends a warning only). Also `0` when there was nothing to do.
- `1`: at least one day `failed`, was `not_posted`, or was skipped for disk or
  deadline; a step failed or was skipped for its deadline; or the run failed
  before its first day. Read the Sentry events for the days and the steps.
- `2`: bad config. The log and the `nightly config invalid` event name the
  fields, never their values. Fix the env vars in Railway.
- `3`: the watchdog. The run was still going 900 s past its 5 h deadline
  (`WATCHDOG_GRACE_SECONDS`), usually a hung network read. It sent an error
  check-in and ended the process. Days that finished before the hang are landed.
- `143`: Railway stopped the container (SIGTERM). The day in flight is cleaned up
  and an error check-in is sent.

## Resource sizing

The converter peaked at about 3.66 GB of memory locally with 16 polars threads
on the 2026-06-15 tape (11.6M rows). The image sets `POLARS_MAX_THREADS=4`
(`Dockerfile`), which lowers the peak. Give the Railway service at least 8 GB of
memory. Free disk in the work dir (`/tmp/nightly`) must be at least 15 GiB before
each day starts; the zip and the Parquet for one day are both on disk at once.

## Run it locally once

Set the env vars above in your shell (not a file in the repo), then:

```bash
cd nightly
pip install -r requirements-dev.txt
PYTHONPATH=src:../scripts python -m main
```

The modules import each other flat, so `src/` and the repo's `scripts/` must be on
the path: the Dockerfile sets `PYTHONPATH=/app/src:/app/scripts`, and a local shell
run from `nightly/` needs `PYTHONPATH=src:../scripts`. A local run uses the real R2
bucket, the real UW key and the database `DATABASE_URL` names, which
`enrich-outcomes` updates. It uses `/tmp/nightly` as its work dir, which is a Unix
path.

## Tests

```bash
cd nightly
python -m pytest
```

`conftest.py` and `pyproject.toml` put `src/` on the path, and `conftest.py` appends
the repo's `scripts/` for the shared modules. No test may connect to a database or a
non-loopback address: `conftest.py` stubs `psycopg2._connect` and fails the session
if anything tried, and refuses non-loopback sockets (tests use moto for R2). Lint
with `ruff check . && ruff format --check .` (ruff `>=0.17,<0.18`, line length 100).
