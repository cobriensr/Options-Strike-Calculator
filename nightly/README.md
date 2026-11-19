# nightly

Railway cron service (`nightly`) that lands the Unusual Whales options Full Tape
in Cloudflare R2: one Parquet object per trading day. After the tape it fills the
Lottery Finder and Silent Boom outcomes in Neon from that tape, checks that
recent sessions have them, and refits the Lottery Finder score weights from them.
It runs once and exits.

## What it does

Each run:

1. Lists the days already in R2 and plans the newest missing sessions, up to 30
   days of catch-up (`CATCHUP_MAX_DAYS`). The calendar starts at 2026-01-02
   (`TAPE_START`). A planned day starts only inside the window under "How much of
   the run the tape gets". At the measured pace (204 s a day at the median, 324 s
   the slowest) its 11,400 s start about 55 days a night, 35 at the slowest, so
   all 30 fit: a night lands up to 30 days and a longer backlog takes more nights.
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
   - `lottery-refit` moves one candidate version of the Lottery Finder score weights
     one step through its lifecycle, on tonight's outcomes (see "Refit").

   Each step has its own deadline, which leaves every later step its reserve. A
   step never starts work its budget cannot cover, but a unit of work that
   overruns (a day of enrichment, say) cuts into the next step's reserve, and only
   the watchdog bounds the run. A step that starts with less than its own reserve
   left is skipped (`skipped_deadline`) and the later ones still run. A step that
   raises fails that step alone: the tape and the other steps are unaffected. A
   step's module is imported when the step runs, so one that fails to import fails
   only that step.

5. Reports each day and each step to Sentry as soon as it finishes, then exits.

Logs go to stdout: Railway labels every stderr line an error.

### How much of the run the tape gets

The tape and the steps share the 5 h run. The tape stops at the run deadline less
the steps' reserve (`reserve_seconds(STEPS)`, the sum of their `min_seconds`), and
starts a day only with `DAY_BUDGET_SECONDS` of that left. So a day starts only in
the first `RUN_DEADLINE_SECONDS − reserve − DAY_BUDGET_SECONDS` seconds of the run:

| Quantity                                                                                                            | Seconds             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Run deadline (`RUN_DEADLINE_SECONDS`)                                                                               | 18,000 (5 h)        |
| Steps' reserve: `ENRICH_DAY_BUDGET_SECONDS` 900 + `OUTCOME_CHECK_BUDGET_SECONDS` 300 + `REFIT_BUDGET_SECONDS` 1,800 | 3,000               |
| Tape deadline: 18,000 − 3,000                                                                                       | 15,000 (4 h 10 min) |
| Minimum left to start a day (`DAY_BUDGET_SECONDS`)                                                                  | 3,600               |
| Window in which a day may start: 15,000 − 3,600                                                                     | 11,400 (3 h 10 min) |

A night starts about 11,400 divided by the seconds one day takes. On Railway a day
takes 204 s to land at the median (86 days, 2026-10-29 to 11-12; 245 s at the 90th
percentile, 324 s the slowest), and the two 30-day catch-up nights took 5,956 s and
6,110 s. So the window could start about 55 days at the median pace and 35 at the
slowest, and the 30-day cap (`CATCHUP_MAX_DAYS`), not the window, sets how many
land. Every step added to `STEPS` takes its `min_seconds` out of the window. It is
11,400 s with phase 4's refit step in (still above 30 days at the slowest pace). It
would fall to 10,500 s if `ENRICH_DAY_BUDGET_SECONDS` were raised to its 1,800 cap
(the plan's 10,500 to 11,400 s range). The plan puts it at 6,900 s once phase 3's
research and report steps are in too (enrich budget at 900 s; the stage table in D2
of `docs/superpowers/plans/2026-10-29-nightly-pipeline-phase2.md`). At 6,900 s the
slowest pace starts about 21 days, so a full 30-day backlog may then take two
nights.
`test_pipeline_order_and_reserve` (`tests/test_pipeline.py`) pins the step order and
each step's reserve, and `test_deadline_constants_bound_the_run`
(`tests/test_main.py`) fails if the reserve leaves less than two
`DAY_BUDGET_SECONDS` of the run for the tape.

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
  The build context is the repo root because the image copies ten files from
  outside `nightly/`: the enrich scripts, the refit modules and what they import
  (`IMAGE_FILES` in `tests/test_image_layout.py`; build it with
  `docker build -f nightly/Dockerfile .`).
- Watch paths, exactly these fourteen: only the image inputs redeploy, so doc and test
  edits don't.
  - `/nightly/Dockerfile`
  - `/nightly/requirements.txt`
  - `/nightly/src/**`
  - `/.dockerignore`
  - `/scripts/_tape_reader.py`
  - `/scripts/_cli_paths.py`
  - `/scripts/_pipeline_retry.py`
  - `/scripts/backfill_lottery_scores.py`
  - `/scripts/enrich_lottery_outcomes.py`
  - `/scripts/enrich_silent_boom_outcomes.py`
  - `/ml/src/lottery_exit_policies.py`
  - `/ml/src/lottery_refit_gates.py`
  - `/ml/src/lottery_scoring.py`
  - `/ml/src/lottery_weights.py`

A file added to or removed from the image changes six places together, listed at
the top of the `Dockerfile`: its `COPY` lines, these watch paths, the root
`.dockerignore`, `IMAGE_FILES`, the `nightly` filter in `.github/workflows/ci.yml`
and this list. `test_readme_lists_every_watch_path` fails when this list lacks one
of `IMAGE_FILES`.

**Push hazard.** A redeploy during a run (about 07:15 to 12:30 UTC) can stop the
run. A push that touches any watch path redeploys the service, and the list above
includes files that other work edits: the shared scripts under `scripts/`, the ones
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
`silent_boom_alerts`, `outcome-check` reads them, and `lottery-refit` reads
`lottery_finder_fires`, `lottery_ticker_stats` and the weights store
(`lottery_score_versions`, `lottery_score_pointers`) and writes a candidate's row
in `lottery_score_versions`. A promotion, which ships off, also rewrites `score`
and `score_version` in `lottery_finder_fires`, writes `lottery_fire_value_snapshots`
and moves the `active` pointer. The refit reads no other variable. It may be
Neon's pooled URL. The job connects to the direct host instead (`-pooler` removed from the
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
reader, one day on disk at a time, each download held to 600 s by
`FETCH_DEADLINE_SECONDS` in `_tape_reader.py`, a bound checked between reads, so a
stalled read can pass it), runs both scripts on one fresh Neon connection, and
releases the file. It stops for the night, leaving the rest as `days_left`, when less
than `ENRICH_DAY_BUDGET_SECONDS` (900 s) of its time is left, or when failed days,
all-NULL (table, day) pairs and unpriced passes together reach
`ENRICH_MAX_DAY_FAILURES` (3). A day that raises is counted, sent to Sentry once, and
the loop goes on.

A tape layout or chain format the scripts cannot read shows as one of three signals,
each catching what the others miss, and each day it goes unseen would cost a download:

- A day raises: `days_failed`.
- All of a table-day's fires come back without an outcome: `null_days`. That holds only
  for fires with no value from another writer (the history the crons never filled).
  Fires that hold a feed value keep it when the tape cannot price them, so their share
  stays near 100%.
- A pass wrote nothing and tagged at least `ENRICH_UNPRICED_FLOOR` (20) rows:
  `unpriced_passes`. It sees what `null_days` cannot: fires that hold a feed value, and
  the inversion pass, which has no share at all. It counts (pass, day) units, up to
  three on a fresh day (the Lottery Finder outcome pass, its inversion pass and the
  Silent Boom pass) and up to two on a leftover day (below). The outcome passes count
  the fires they kept plus the ones they stamped, the inversion pass the fires it
  tagged undefined. Rows tagged, not rows selected, because tagging marks a fire
  examined and locks it out of the work set. A day whose net flow is missing leaves
  its fires as `inversion_input_missing`, untagged, and is not flagged. A total break
  trips all three passes on one fresh day when that day's silent boom pass tagged at
  least 20 alerts, so the step stops after that day, which limits the stamping to one
  day. On a thinner silent boom day only the two lottery passes trip, which makes 2,
  and the stop comes on the next broken day. On a leftover day a total break trips at
  most the two outcome passes, so the stop comes on the next broken day.

The inversion pass is judged only on a **fresh day**, one where no fire had an
inversion value or tag before the pass ran. Its work set is the fires still blank, so
on a **leftover day** (something priced it earlier, such as the old Vercel cron's
inversions) it holds only that writer's leftovers, which the tape correctly prices
none of. On 2026-11-05 the set was 430 of 14,443 fires, all of them leftovers; it
stamped 430, wrote none, and that alone failed the step. Before the lottery script
runs, the step counts the day's fires outside the work set (`inversions_resolved`:
`NOT (realized_flow_inversion_pct IS NULL AND inversion_source IS NULL)`, on the day's
own connection). When the count is not 0 the day is a leftover day. An inversion
pass that would have been unpriced is then counted in `inversion_leftovers_unpriced`
and logged, and the day stays `ok`. It neither fails the step nor counts toward the
cap. The two outcome passes are judged on every day.

The step's result is `failed` if a day failed, came back all-NULL or had an unpriced
pass, else `partial` if days are left, else `ok`. Its counts are in the log line
`step enrich-outcomes ...` and in the `counts` extra of the step alerts:
`days_processed`, `days_failed`, `days_waiting_tape`, `days_left`,
`tape_markers_reset` (rows whose marker was cleared), `null_days` and `low_days`
(these two count (table, day) pairs), `unpriced_passes` ((pass, day) units),
`inversion_leftovers_unpriced` (inversion passes that wrote nothing and tagged 20
fires or more on a leftover day; outside the cap and never a failure), and per
table `lottery_` / `silent_boom_` plus `outcomes_written`, `stamped_no_outcome`,
`outcomes_replaced` (the tape's value overwrote an earlier outcome) and
`outcomes_kept` (the tape could not price a fire that held a value, which stayed).
The Lottery Finder pass adds `inversion_written`, `inversion_stamped` and
`inversion_input_missing`. The log line for each day names its date, a status
(`failed (<ExceptionClass>)`, else `priced none`, else `no outcomes`, else `ok`) and
its non-zero counts, never an exception's text. A leftover day's inversion pass shows
as `inversion_leftovers_unpriced=1` and leaves the status alone.

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
is never needed, and inversions are not redone this way, except for a day that came
back `priced none` (next paragraph). The day must be landed in R2, or it waits.

**A `priced none` day.** The inversion pass tagged the fires it could not price
`inversion_source = 'fulltape'` and left their value NULL. That tag takes them out of
the inversion work set (`realized_flow_inversion_pct IS NULL AND inversion_source IS
NULL`), and the marker reset above does not touch it. After the cause is fixed, clear
the day's markers as above, then clear those tags. The version goes with the source,
because migration #201's check allows both NULL or both set:

```sql
UPDATE lottery_finder_fires SET inversion_source = NULL, inversion_version = NULL
 WHERE date = '<day>' AND inversion_source = 'fulltape'
   AND realized_flow_inversion_pct IS NULL;
```

No value is lost, because the rows it touches have none. It also reopens the fires the
tape had rightly found undefined; the next pass tags them again. The outcome passes
need nothing more than the marker reset.

Only a fresh day can come back `priced none` from the inversion pass. A leftover day
logs `ok` with `inversion_leftovers_unpriced=1` and needs none of this: the fires the
tape cannot price stay tagged undefined, which is right. On such a day a broken tape
shows through the outcome passes only when the day also has outcome work. A leftover
day listed for inversion work alone (late net flow) has none, and there a broken tape
trips nothing: the inversion pass tags the remaining blank fires undefined and the
step stays `ok`. That is the owner's ruling (2026-11-12), taken to stop false alarms
on the days something else priced first.

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

## Refit

The `lottery-refit` step keeps the Lottery Finder score weights current. The weights
live in Neon (migration #208): `lottery_score_versions` holds one row per version
(`seed-<date>` from the migration, `refit-<trained_through>` from this step), and
`lottery_score_pointers` names the version the live scorer uses (`active`) and the one
Take-It's input score stays on (`takeit`). The step trains a candidate on the outcomes
`enrich-outcomes` just wrote, holds it in shadow while sessions go by, and judges it
against the active version. The step itself writes no pointer: only a promotion's
transaction moves `active`, and nothing moves `takeit`. Promotion ships off
(`PROMOTION_ENABLED`), so a candidate that passes is marked `passed`, the owner is
told, and no live score changes.

**Lifecycle.** One move per run, by whether a shadow exists:

- No shadow: build `refit-<last session>`. Train on the trailing 90 days, match the
  candidate's feed cutoffs to the active version's tier shares over the last 20
  sessions, then run the creation checks (the gate table below). A candidate that
  passes is stored as `shadow`. One that fails is stored as `rejected` and announced;
  it never becomes a shadow.
- A shadow: record each session that has become evaluable and is not yet recorded,
  then ask for a verdict on all of them. It waits until 10 sessions are evaluated,
  rejects as `shadow_starved` once 20 sessions have elapsed with fewer than 10
  evaluated, and otherwise passes or rejects on exactly the first 10 evaluated
  sessions, so a later session changes nothing. A pass promotes only when
  `PROMOTION_ENABLED`; with it off the shadow is marked `passed`. Only a `shadow` is
  promoted: a `passed` version records a verdict reached against the `active` version
  of its day, and the rescore refuses it.
- Evaluation lags one session: session s is judged on the run after session s+1
  lands, so a fire whose net flow arrived late has its tape inversion by then. The
  newest session of the night is left for the next night.
- One candidate at a time. The store allows one `shadow` row (a partial unique index),
  so a second one fails the step instead of queueing. A decided version (`passed`,
  `rejected`, `promoted`) is never re-opened. While promotion is off the cycle still
  runs and `active` never moves.
- Every run, before it builds or judges anything, counts the fires tagged with a version
  other than the active one (`fires_off_version`, below) and sends a notice when there
  are any. That is a repair for the owner, not a refit failure: it never changes the
  step's status or what the night does.

**The same-night guard.** With no shadow, the step builds nothing when either:

- the version already exists (`already_built`): `refit-<last session>` is in the store
  in any status, which also covers a candidate rejected at creation, since that one
  carries no `decided_at`; or
- any version was decided since 00:00 UTC of the run's date (`already_decided`). So a
  decision stamped earlier that UTC date skips that night's build: the night's own
  earlier run having rejected, passed or promoted the shadow, or the owner having
  promoted one by hand. No shadow is left to find then, and a build would be a second
  move in one night.

The checks run in that order, and the next scheduled run falls on the next UTC date
and builds as usual.

**What goes wrong.** These raise, so the step is `failed` through an exception event
and nothing is turned into a rejection or a wait: stored weights that break a rule, a
judged session with no feed rows, a fire with an unknown time of day, a second shadow,
a database error, and a pointer or score that moved under a promotion (`PointerMoved`,
`ConcurrentScoreWriter`). The one exception is matched feed cutoffs the validator
refuses: the creation check reports them as `invalid_weights`, and that candidate is
stored `rejected` and announced. A promotion that starts too late, hits its deadline or
waits out its 60 s lock timeout rolls back whole and is deferred instead (below). A
promotion whose connection drops is judged by the `active` pointer, read on a fresh
connection: if it names the shadow, the commit was applied and only its acknowledgement
was lost, so the step counts and announces it as promoted (the `promoted` notice then
carries `commit_ack = lost` and no row counts, and `rows_rescored` is 0: the snapshot
rows' own count, `total` in step 2 of the undo, is the one to use). If it does not, or it
cannot be read, the original error fails the step.

**Counts.** Every result carries all of these, zero or not, in the `step lottery-refit`
line and in the `counts` extra of the step alerts. The step also logs one line
naming the version and what it did, with no weight or ticker in it.

| Count                 | Meaning                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `candidates_built`    | A shadow was stored tonight.                                                                   |
| `candidates_rejected` | A candidate was stored as `rejected` at creation (a notice went out).                          |
| `already_built`       | No shadow, and tonight's version already existed (or another run stored it first). Built none. |
| `already_decided`     | No shadow, and a version was decided since 00:00 UTC. Built none.                              |
| `sessions_recorded`   | Sessions written to `gate_report.sessions` tonight.                                            |
| `waiting`             | The shadow was left as it is: no session evaluable yet, or fewer than 10 evaluated.            |
| `passed`              | The shadow passed and was marked `passed` (promotion off).                                     |
| `promoted`            | The shadow was promoted.                                                                       |
| `rejected`            | The shadow was rejected.                                                                       |
| `promotion_deferred`  | A promotion was due and did not run or rolled back. The shadow stays; the step is `partial`.   |
| `rows_rescored`       | Fires the promotion's rescore changed; 0 unless `promoted`.                                    |
| `train_rows`          | Rows in tonight's training window; 0 unless a candidate was trained.                           |
| `eval_rows`           | Rows the verdict counted; 0 unless a shadow with an elapsed session was judged.                |
| `fires_off_version`   | Fires whose `score_version` is set and is not the active version's. 0 means all agree.         |

**The gates.** The values are in `ml/src/lottery_refit_gates.py`. Bands include both
ends. A check that fails is listed in the verdict's `reasons`, in the order below, and
a tier share is the share of a session's fires in the feed's tier 1 (or tier 1 and 2)
under that version's own feed cutoffs.

| Stage    | Gate                                                                                                | Value                                   | Fails as                            |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| Creation | Training rows (`MIN_TRAIN_ROWS`)                                                                    | at least 30,000                         | `too_few_train_rows`                |
| Creation | Training sessions (`MIN_TRAIN_SESSIONS`)                                                            | at least 30                             | `too_few_train_sessions`            |
| Creation | The weights, with the matched feed cutoffs (`validate_weights`)                                     | no rule broken                          | `invalid_weights`                   |
| Creation | Candidate's mean daily tier 1 share (`TIER1_SHARE_BAND`)                                            | 1% to 15%                               | `tier1_share_out_of_band`           |
| Shadow   | Rows for a session to count as evaluated (`MIN_EVAL_ROWS_PER_SESSION`)                              | at least 500 scored with an outcome     | the session is not counted          |
| Shadow   | Evaluated sessions judged (`SHADOW_SESSIONS`)                                                       | exactly the first 10                    | waits for 10                        |
| Shadow   | Elapsed sessions at which a shadow with fewer than 10 evaluated is rejected (`SHADOW_MAX_SESSIONS`) | 20, rejected on reaching it             | `shadow_starved`                    |
| Shadow   | Rows over the 10 judged sessions (`MIN_EVAL_ROWS`)                                                  | at least 5,000                          | `too_few_eval_rows`                 |
| Shadow   | Pooled Spearman ρ with the outcome, candidate against active                                        | candidate at least active, both defined | `rho_below_active`, `rho_undefined` |
| Shadow   | Candidate's mean daily tier 1 share (`TIER1_SHARE_BAND`)                                            | 1% to 15%                               | `tier1_share_out_of_band`           |
| Shadow   | Candidate over active, mean daily tier 1 share (`TIER_SHARE_RATIO_BAND`)                            | 0.67 to 1.5                             | `tier1_ratio_out_of_band`           |
| Shadow   | Candidate over active, mean daily tier 1 and 2 share (`TIER_SHARE_RATIO_BAND`)                      | 0.67 to 1.5                             | `tier12_ratio_out_of_band`          |

The training window is 90 days (`TRAIN_WINDOW_DAYS`), the feed cutoffs are matched over
the last 20 sessions (`FEED_CUTOFF_MATCH_SESSIONS`), and the match searches cutoffs up
to 40 (`FEED_CUTOFF_SEARCH_MAX`). Tier 2 is searched from 6 and tier 1 from 7
(`FEED_CUTOFF_FLOOR` is 6). The feed's SQL floor gives a fire with no score a qas of up
to 5: the score counts as 0, the zero floor comes before the inversion bonus, and the
bonus adds up to 5 (`NULL_SCORE_QAS_MAX`). The round-trip deduct was left out of the
feed's qas when the feed fixed its tier at the fire, so it no longer bears on this floor
(`docs/superpowers/specs/2026-11-17-freeze-tier-at-fire-design.md`). A test also pins the
feed's `qasExprText`, so a new term in it fails there first. The fire-count adjustment
used to add up to 2 more, which made the floor 8; it was retired on 2026-11-15
(migration #209). The gate counts such a fire as
tier 3. A feed cutoff of 5 or less could therefore tier a fire the gate did not count,
and the gate would judge a tiering the feed does not show. A candidate that cannot
match the active version's tier shares above that floor gets high cutoffs, which
typically leave its tier 1 share under the band's 1%, so it is rejected at creation for
that.

**Notices.** Six fixed titles, all with the tags `service=nightly`,
`step=lottery-refit`, `refit` (the kind) and `version`. The extras are aggregates only:
counts, ρ values, tier shares and ratios, the feed cutoffs before and after, the number
of ticker weights that changed, the labels of flipped signs (`C/P`, `DTE0`), and
`reasons`. Never a ticker, a weight or a fire. Sentry's new-issue rule mails each new
issue at any level, so the fingerprint decides what mails:

| Sentry title                                    | Level   | When                                               | Mails                                                      |
| ----------------------------------------------- | ------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `nightly refit promoted`                        | warning | A shadow passed and was promoted.                  | Once per version.                                          |
| `nightly refit passed; promotion disabled`      | warning | A shadow passed and promotion is off.              | Once per version.                                          |
| `nightly refit rejected`                        | error   | A shadow failed its gates or starved.              | Once per version.                                          |
| `nightly refit candidate rejected`              | error   | A new candidate failed a creation check.           | Once per new first reason (below).                         |
| `nightly refit fires scored by another version` | warning | `fires_off_version` is above 0 (extra: the count). | Once per active version; resolve the issue after a repair. |
| `nightly refit promotion deferred repeatedly`   | error   | A passing shadow was deferred on its third night.  | Once per version.                                          |

A candidate rejected at creation groups by its first reason, not its version (owner,
2026-11-06). A thin-data streak, the same reason night after night, is one issue and
mails once; a new first reason opens and mails as a new issue. The streak shows in the
issue's event count and the step's logs.

A deferred promotion sends no refit notice on its first two nights: the step ends
`partial` and `nightly step partial` warns, with the detail
`promotion deferred to the next night`. Each deferred night is recorded on the shadow
(`gate_report.deferred_nights`, one entry per UTC date, so a re-run of the same night
adds none). On the third, the `promotion deferred repeatedly` error goes out with the
version in its fingerprint, which says the promotion does not fit its window (the
rescore needs `PROMOTION_MIN_SECONDS` before the step's deadline and
`PROMOTION_CUTOFF_UTC`) and that the next night will defer it again; look at the
window, the rescore's duration and the lock waits. A promotion or a rejection ends the
count (the version is no longer a shadow), and a fourth night sends nothing more.

`nightly refit fires scored by another version` is a repair, not a failure. After a
promotion every fire carries the active tag. A fire that does not was scored by a live
writer that fell back to the seed (the Vercel loader could not read the store for a
cache period), or was left behind by an undo. The step counts those every night, in
the same notice, and the repair is under "Vercel side" below.

**Reading `gate_report`.** Each version's `gate_report` (JSON) holds up to five
top-level keys. The paths below are the keys the code stores:

- `creation`, written when the candidate is built: `creation.verdict.ok`,
  `creation.verdict.reasons`, `creation.verdict.train_rows`,
  `creation.verdict.train_sessions` and `creation.verdict.tier1_share`;
  `creation.train_window.after` and `creation.train_window.through`; and
  `creation.insample_rho`, the correlation on the training rows themselves, which says
  nothing about held-out quality.
- `sessions`, one entry per recorded session, keyed by its ISO date:
  `sessions.<date>.eval_rows`, `.evaluated`, `.rho_candidate`, `.rho_active` and
  `.feed_fires`.
- `verdict`, written with the decision: `verdict.decision`, `verdict.reasons`,
  `verdict.sessions` (the ISO dates judged), `verdict.eval_rows`,
  `verdict.rho_candidate`, `verdict.rho_active`, `verdict.tier1_ratio`,
  `verdict.tier12_ratio` and `verdict.tier1_share`. A number that was not defined is
  null.
- `replaced`, written by a promotion, beside `verdict` and not inside it: the version
  `active` named when the promotion committed, the one the by-hand undo below points
  `active` back to. Every promotion records it, with or without a `verdict`.
- `deferred_nights`, a list of the ISO dates on which this shadow's promotion was
  deferred, oldest first. Absent until the first deferral.

The stored `verdict` is the authoritative record of a decision. The `sessions` entries
are a snapshot, written once when a session became evaluable and never recomputed;
`decide_shadow` re-reads fresh frames every night, so a late enrich pass can make an
entry differ from what the decision then saw. When they disagree, read `verdict`. A
shadow that is still waiting has no `verdict`, and a candidate rejected at creation
has `creation` only. To list the latest versions with their decision:

```sql
SELECT version, status, decided_at,
       gate_report -> 'verdict' ->> 'decision' AS decision,
       gate_report -> 'verdict' -> 'reasons' AS reasons,
       gate_report -> 'verdict' ->> 'rho_candidate' AS rho_candidate,
       gate_report ->> 'replaced' AS replaced,
       gate_report -> 'creation' -> 'verdict' ->> 'ok' AS creation_ok
  FROM lottery_score_versions ORDER BY created_at DESC LIMIT 5;
```

**Undoing a promotion (by hand, owner-approved only).** The step never does this. The
procedure undoes only the latest promotion, the version `active` names now; to go back
further, undo one promotion at a time, newest first. A promotion's rescore keeps the old
score and tag of every fire it changed in `lottery_fire_value_snapshots`, one row per
page of fires, with `reason = 'promotion'`, `column_name = 'score'` and `to_version` the
promoted version. A hand-run `scripts/backfill_lottery_scores.py --version` rescore
writes another reason (`manual` unless given one), so the lookup below leaves its rows
out. Run the procedure outside 13:00 to 24:00 UTC on weekdays and not while a nightly
run is going (07:15 to 12:30 UTC, Tuesday to Saturday), because the restore locks every
fire it rewrites until it commits, and the live crons, `enrich-outcomes` and a promotion
inside the refit step write the same fires. In the statements, `<promoted>` is the
version being undone, `<previous>` the one it replaced and `<ids>` the snapshot ids,
such as `1, 2`.

1. Check what is live. Stop unless it returns `<promoted>`:

   ```sql
   SELECT version FROM lottery_score_pointers WHERE name = 'active';
   ```

2. Find the promotion's snapshot rows. `total` is the snapshot's own fire count,
   `sum(cardinality(fire_ids))`. Step 5 checks the restore against it, never against
   `rows_rescored`, which is 0 after a lost commit acknowledgement:

   ```sql
   SELECT id, cardinality(fire_ids) AS fires, sum(cardinality(fire_ids)) OVER () AS total
     FROM lottery_fire_value_snapshots
    WHERE to_version = '<promoted>' AND reason = 'promotion' AND column_name = 'score'
    ORDER BY id;
   ```

3. Find the version the promotion replaced. The promotion recorded it in the promoted
   version's `gate_report`, in the same transaction that moved `active`:

   ```sql
   SELECT gate_report->>'replaced' FROM lottery_score_versions
    WHERE version = '<promoted>';
   ```

   The value is `<previous>`: the version `active` named when the promotion committed.
   The first promotion off the seed returns `seed-2026-06-17`. If the cell is blank or
   psql prints `(0 rows)` (how it shows NULL, and no row), stop and ask: it would mean a
   promotion made before the record existed, and none exist.

4. Move `active` back and restore the scores, in one transaction. Steps 4 and 5 run in
   one interactive `psql` session: `BEGIN`, the two statements, read the counts, then
   `COMMIT` or `ROLLBACK` in that same session. With `psql -c` or an autocommit client,
   `BEGIN` does not persist, so the UPDATEs would commit before the counts are read and
   the `ROLLBACK` would protect nothing. The pointer goes first, the order `rescore_all`
   locks in (the pointer, then the fires), so a rescore that runs at the same time waits
   on the pointer instead of deadlocking. Do not commit yet:

   ```sql
   BEGIN;
   UPDATE lottery_score_pointers SET version = '<previous>', updated_at = now()
    WHERE name = 'active' AND version = '<promoted>';
   UPDATE lottery_finder_fires f SET score = s.v::int, score_version = s.t
     FROM (SELECT unnest(fire_ids) AS id, unnest(old_values) AS v, unnest(old_tags) AS t
             FROM lottery_fire_value_snapshots
            WHERE id = ANY(ARRAY[<ids>]) AND column_name = 'score') s
    WHERE f.id = s.id AND f.score_version = '<promoted>';
   ```

5. Read each statement's row count. The pointer UPDATE must say `UPDATE 1`. The fires
   UPDATE must match `total` from step 2: the `f.score_version = '<promoted>'` guard
   leaves a fire that a later write re-tagged alone, so a smaller count means one was.
   If both match, run `COMMIT;` in the same session. Otherwise run `ROLLBACK;` and find
   out why.

6. Repair the fires created between the promotion and the undo. They are in no snapshot
   row, so step 4 left them with the promoted version's score and tag. Run the rescore
   with the previous version over exactly those tags (see the window below):

   ```bash
   ml/.venv/Scripts/python scripts/backfill_lottery_scores.py \
     --version <previous> --only-tag <promoted>          # a dry run: read the counts
   ml/.venv/Scripts/python scripts/backfill_lottery_scores.py \
     --version <previous> --only-tag <promoted> --write
   ```

   A pre-open undo usually has none, but run the dry run anyway and expect `scanned 0`
   then. `--only-tag` is required: without it the run would rescore every fire scored
   before the store existed, which carry no tag after step 4 undid the first promotion,
   with `<previous>`'s weights and tag them. Both commands take the same window as the
   undo itself: outside 13:00 to 24:00 UTC on weekdays, and not while a nightly run is
   going (07:15 to 12:30 UTC, Tuesday to Saturday). They connect with `DATABASE_URL`
   from `.env.local` (the production database), so run them deliberately.

This writes nothing to `lottery_score_versions`: the undone version keeps its status
`promoted`, and its `gate_report.verdict` still records the decision. `active` is the
authority on what is live; the status of an undone version does not change, and the refit
ignores it, since it reads only the `shadow` row and the `active` pointer. The `takeit`
pointer is untouched by a promotion, so it needs nothing. A fire created after the
promotion is in no snapshot row and keeps the promoted version's score and tag until
step 6 runs. The next night's `fires_off_version` count says whether any is left.

**One column is not rescored.** `cluster_bonus` is computed when a fire is inserted, from
the inserting version's `t1` cutoff and the scores of that run, and neither a promotion
nor a repair recomputes it: it stays on the version that inserted the fire, so after a
promotion the column mixes versions. Nothing live reads it (only
`scripts/analyze-tag-scorecard-2026-05-29.ts` does), and the undo does not restore it
either.

**Rolling back during trading (by hand, owner-approved only).** The full undo locks
every fire it rewrites, so it cannot run from 13:00 to 24:00 UTC on weekdays. A
promotion that turns out wrong while the market is open is rolled back in two parts:
the pointer at once, at any hour, and the scores after the window closes.

_When to prefer the full undo._ A promotion ends by 12:30 UTC (`PROMOTION_CUTOFF_UTC`)
and sends the `nightly refit promoted` email. From the end of the nightly run until
13:00 UTC the full undo above is allowed and complete: no fire is detected before the
open, so nothing was created between the promotion and the undo, and step 6 finds
nothing to repair. If the email is read in that window, use the full undo and not this.

_The pointer-only move._ Check that `active` names `<promoted>` and take `<previous>`
from `gate_report->>'replaced'`, as in steps 1 and 3 of the undo. Then, in `psql`:

```sql
SET lock_timeout = '5s';
UPDATE lottery_score_pointers SET version = '<previous>', updated_at = now()
 WHERE name = 'active' AND version = '<promoted>';
```

It must say `UPDATE 1`. This is one statement, so autocommit is fine here and no `BEGIN`
is needed (steps 4 and 5 of the undo need one only because they read counts between two
statements). `UPDATE 0` means `active` no longer names `<promoted>`: stop and look at
step 1 again. A lock timeout error means a rescore holds the pointer; nothing was
written, and the rescore has to be found before anything else is done.

It is safe at any hour because it writes one row. The crons and the feed read the pointer
through the loader (`api/_lib/lottery-weights-loader.ts`) with a plain SELECT, which a
row lock never blocks, and only a rescore locks the pointer. None runs during trading:
the promotion ends by 12:30 UTC and the by-hand rescore has the window above. It takes
effect within the loader's cache period, `WEIGHTS_CACHE_TTL_MS` (60 s), on each warm
instance.

_What it fixes, and what it does not._ From then on new fires are scored with
`<previous>`, and every row is tiered with `<previous>`'s cutoffs, because the feed
tiers at read time (`api/lottery-finder.ts`, the `qualityAdjustedScore` call, and the
`feed_cutoffs` that bind the `minTier` floor). It does not touch the fires the promoted
weights scored: all history, which the promotion rescored, and today's fires up to the
move, which carry `<promoted>`'s tag and scores until the evening. Their tiers, read
against `<previous>`'s cutoffs, can be off in either direction until then. `takeit` is
unaffected, as in any promotion.

_The evening completion._ After 24:00 UTC, and not during a nightly run, finish it with
the undo's steps, changed in two places (steps 2, 3 and 6 are as written):

- Step 1 checks the other way: stop unless `active` returns `<previous>`, which the
  pointer-only move already made so. Step 2 (the snapshot rows and their `total`) is
  as written.
- Step 4 replaces the pointer UPDATE with a lock on the pointer row, so the transaction
  keeps the order `rescore_all` locks in (the pointer, then the fires) and step 1's
  check holds until the commit. In the same interactive `psql` session, after `BEGIN`:

  ```sql
  SELECT version FROM lottery_score_pointers WHERE name = 'active' FOR UPDATE;
  ```

  It must return `<previous>`; otherwise run `ROLLBACK;`. Then run the fires UPDATE
  with its `f.score_version = '<promoted>'` guard. In step 5 compare its count with
  `total` before `COMMIT`, or `ROLLBACK` if they differ.

Then step 6 as written, `--version <previous> --only-tag <promoted> --write`: it repairs
the fires inserted under `<promoted>` since the promotion, which are in no snapshot row.
The fires inserted after the pointer moved already carry `<previous>`, and `--only-tag`
leaves them alone. If the completion is put off, the next night's `fires_off_version`
count is above 0 (fires tagged `<promoted>` while `active` names `<previous>`), and the
notice says so. When it is done every fire is tagged `<previous>` or carries no tag, as
before the promotion.

**Turning promotion on.** `PROMOTION_ENABLED` in `src/constants.py` is a reviewed
constant, not an env var: it is read in one place, and flipping it rewrites the live
feed's scores and tiers.

1. It needs the owner's go-ahead: the owner approves the numbers in a
   `nightly refit passed; promotion disabled` notice, and phase 3 of the pipeline is
   complete (Task 23 of `docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md`).
2. A one-line commit sets it to `True`. The tests in `tests/test_refit_step.py` that
   assert the shipped `False` change in the same commit, to patch it where they need it
   off.
3. The flip is a push to a nightly watch path (`/nightly/src/**`), so the push window
   under "Push hazard" applies: after 15:00 CT and outside 07:15 to 12:30 UTC.
4. The next shadow that passes is promoted; a `passed` version already stored is not
   re-opened. A promotion is bounded by `PROMOTION_CUTOFF_UTC` (12:30 UTC, an hour
   before the earliest US open) and `PROMOTION_MIN_SECONDS` (1,200 s): it starts only
   with that long left before both the step's own deadline and the cutoff, and its
   rescore stops at whichever comes first. One that starts too late, hits that deadline
   or waits out the lock timeout rolls back whole. The version stays a shadow, the step
   is `partial` (`promotion_deferred`) and the next night judges it again. The first two
   such nights send no refit notice; the third sends the `promotion deferred repeatedly`
   error. The rescore's transaction also sets a 120 s
   `idle_in_transaction_session_timeout`, so a process lost with its connection still
   open is rolled back by the server two minutes later instead of holding the pointer
   and the fire locks into the market session.
5. On the promotion night check that the promotion's snapshot rows exist, with the fire
   count `total` of step 2 of the undo (the snapshot's own count, never `rows_rescored`,
   which is 0 after a lost commit acknowledgement), that `active` names the new version
   and `takeit` the seed, that the next session's fires carry the new `score_version`,
   and that the `nightly refit promoted` email arrived. To turn it off again, flip the
   constant back the same way.

**Vercel side.** The crons that score fires load the `active` and `takeit` versions
through `api/_lib/lottery-weights-loader.ts`. When the store cannot give a valid pair
they score with the frozen seed and send the Sentry error
`lottery weights fallback to seed` from the Vercel project, not this service.

After a promotion those fires carry the seed's tag and score. The feed tiers them with
the active version's cutoffs, and phase 3's reports read stored scores on the assumption
that all fires share one version, so they need repairing. This service does not repair
them. The next night's refit counts them (`fires_off_version`, and a `nightly refit
fires scored by another version` notice). Repair them by hand with the rescore, pinned
to the active version and limited to the residue's tag. A seed fallback leaves the
seed's, `seed-2026-06-17`; to see which tags there are:

```sql
SELECT score_version, count(*) FROM lottery_finder_fires
 WHERE score_version IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
```

```bash
ml/.venv/Scripts/python scripts/backfill_lottery_scores.py --only-tag <the residue's tag>
ml/.venv/Scripts/python scripts/backfill_lottery_scores.py --only-tag <the residue's tag> --write
```

The first is a dry run. Without `--only-tag` the run would rescore every fire, including
those scored before the store existed, which carry no tag. Run it outside 13:00 to
24:00 UTC on weekdays and not while a nightly run is going (07:15 to 12:30 UTC, Tuesday
to Saturday): it locks every fire it rewrites until it commits, and the live crons and
a promotion write the same fires. It connects with `DATABASE_URL` from `.env.local`,
which is the production database. Resolve the Sentry issue afterwards, so the next
residue mails again.

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

| Sentry title                                    | Level   | Meaning                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nightly tape day failed`                       | error   | A day did not land. `detail` names the kind; `reason` may say more. Retried next night.                                                                                                                                                                                                                                                       |
| `nightly tape day skipped_disk`                 | error   | Free disk too low; the rest of the run was skipped.                                                                                                                                                                                                                                                                                           |
| `nightly tape day skipped_deadline`             | error   | The run ran out of time; the rest was skipped.                                                                                                                                                                                                                                                                                                |
| `nightly tape day not_posted`                   | warning | UW had not posted a recent day. Usually clears itself.                                                                                                                                                                                                                                                                                        |
| `nightly tape day unavailable`                  | warning | A marker was written; one issue per day. Check it was expected.                                                                                                                                                                                                                                                                               |
| `nightly tape day landed with warnings`         | warning | Landed, but a plausibility check flagged it (row ratio or time window) or cleanup failed.                                                                                                                                                                                                                                                     |
| `nightly tape day relanded`                     | warning | A day was re-landed after its UW ETag changed. Sent for every re-land, one issue per day; `warnings` lists any flags.                                                                                                                                                                                                                         |
| `nightly re-land identical content`             | warning | A re-land whose `rows` and `source-bytes` equal the old object's: likely ETag churn, not a rewrite. One issue per day.                                                                                                                                                                                                                        |
| `nightly rewrite check unavailable`             | warning | No probed day could be compared, so a rewrite would go unseen. `days` is how many were left unchecked.                                                                                                                                                                                                                                        |
| `nightly step failed`                           | error   | A step finished `failed` without raising. `enrich-outcomes`: a day failed, came back with no outcomes or priced none. `outcome-check`: a recent session has no outcomes. `lottery-refit` never ends `failed`: it raises (exception row below). Read the alerts below and the run log.                                                         |
| `nightly step partial`                          | warning | A step ran out of time with work left for the next night (`days_left` in `counts`). Expected while the history drains; look only if it persists. `lottery-refit`: a promotion was deferred (`promotion_deferred`); the shadow stays and the next night judges it again (the third night in a row also sends `promotion deferred repeatedly`). |
| `nightly step skipped_deadline`                 | error   | A step started with less than its own reserve left, so it did not run (the later steps still did). The tape or an earlier step overran its share; the next night runs it again.                                                                                                                                                               |
| `nightly outcomes all null`                     | error   | `outcome-check`: a table has fires on one of the last 3 sessions (`OUTCOME_CHECK_SESSIONS`) and none has an outcome. Tags `table`, `day`; extras `rows`, `with_outcome`. One issue per table and day. See below.                                                                                                                              |
| `nightly outcomes mostly null`                  | warning | `outcome-check`: fewer than 95% (`LOW_OUTCOME_SHARE`) of a table-day's fires have an outcome. One warning per run; `days` lists `table:day`. Fires the tape cannot price stay without one (see "Enrichment").                                                                                                                                 |
| `nightly refit promoted`                        | warning | `lottery-refit`: a shadow passed its gates and was promoted: the live scores were rewritten and `active` moved. One issue per version. See "Refit".                                                                                                                                                                                           |
| `nightly refit passed; promotion disabled`      | warning | `lottery-refit`: a shadow passed its gates; promotion is off, so it is marked `passed` and no live score changed. One issue per version. See "Refit".                                                                                                                                                                                         |
| `nightly refit rejected`                        | error   | `lottery-refit`: a shadow failed its gates or starved; `reasons` lists them. One issue per version. See "Refit".                                                                                                                                                                                                                              |
| `nightly refit candidate rejected`              | error   | `lottery-refit`: a new candidate failed a creation check and was stored `rejected`. One issue per first reason, so a thin-data streak mails once. See "Refit".                                                                                                                                                                                |
| `nightly refit fires scored by another version` | warning | `lottery-refit`: `fires_off_version` is above 0 (the count is in the extras): fires carry a `score_version` other than the active version's. A repair for you, not a failure; the step's status is unchanged. One issue per active version. Repair: "Vercel side" in "Refit".                                                                 |
| `nightly refit promotion deferred repeatedly`   | error   | `lottery-refit`: a passing shadow's promotion was deferred on its third night (`deferred_nights` in extras). It does not fit its window; the next night defers it again. One issue per version. See "Refit".                                                                                                                                  |
| exception tagged `step`                         | error   | A step raised (a database error, an import error). The step is `failed` and the log names the exception class; no `nightly step failed` event follows. `lottery-refit` also raises on invalid stored weights, a judged session with no feed rows, a second shadow, or a pointer or score that moved under a promotion.                        |
| exception tagged `step` and `day`               | error   | One day of `enrich-outcomes` raised (its download, its connection, either script's pass). Counted in `days_failed`; the step goes on with the next day and retries this one next night.                                                                                                                                                       |
| `nightly config invalid`                        | error   | Bad config. `fields` names the invalid settings. Sent only if `SENTRY_DSN` is valid.                                                                                                                                                                                                                                                          |
| `NYSE holiday table ends in {year}; ...`        | warning | From Oct 1 of the table's last year. Add the next year to `calendar_nyse.py`, or the job refuses to run.                                                                                                                                                                                                                                      |

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
- `no outcomes`: the day came back with an all-NULL share (`null_days`) and no pass
  tagged 20 fires or more. The tape examined the fires and priced none of them, so a
  retry alone changes nothing. Suspect a changed tape layout or option-chain id format.
  Fix the cause, then clear the day's markers by hand (see "Enrichment").
- `priced none`: a pass wrote nothing and tagged at least 20 fires (`unpriced_passes`
  in the `step enrich-outcomes` line says how many passes). It outranks `no outcomes`,
  so a day whose fires hold no value from another writer, and has 20 or more of them,
  logs `priced none` with `null_days` beside it (for a recent session an `all null`
  alert follows too). The cause is the same: a changed layout or chain id format. Fix
  it, then clear the day's markers and its inversion tags by hand (see "A
  `priced none` day" under "Enrichment"). A total break usually trips three passes on
  its first day, which stops the step there; on a day with fewer than 20 silent boom
  alerts it trips two, and the stop comes on the next broken day. The inversion pass
  counts only on a fresh day: on a leftover day it logs `ok` with
  `inversion_leftovers_unpriced=1` instead, and a total break trips at most two passes.
- No `enrich <day>` line at all. Either the day had no work left, so an earlier
  night already examined it and priced none of it (treat it as `no outcomes`), or
  the step did not reach the day. Look for `nightly step skipped_deadline`, an
  exception tagged `step`, or `days_left` in the `step enrich-outcomes` line.

A `priced none` day need not raise an `all null` alert. When its fires hold a value
from another writer (the feed's), the shares stay near 100%, so `nightly outcomes all
null` stays quiet and the step's own `nightly step failed` event and the `priced none`
log line are the only signs.

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
PYTHONPATH=src:../scripts:../ml/src python -m main
```

The modules import each other flat, so `src/`, the repo's `scripts/` and its `ml/src/`
must be on the path: the Dockerfile sets `PYTHONPATH=/app/src:/app/scripts:/app/ml/src`,
and a local shell run from `nightly/` needs `PYTHONPATH=src:../scripts:../ml/src`.
A local run uses the real R2 bucket, the real UW key and the database `DATABASE_URL`
names, which `enrich-outcomes` updates and `lottery-refit` writes to. It uses `/tmp/nightly` as its work dir, which
is a Unix path.

## Tests

```bash
cd nightly
python -m pytest
```

`conftest.py` and `pyproject.toml` put `src/` on the path, and `conftest.py` appends
the repo's `scripts/` and then its `ml/src/` for the shared modules, the order the
image has. No test may connect to a database or a
non-loopback address: `conftest.py` stubs `psycopg2._connect` and fails the session
if anything tried, and refuses non-loopback sockets (tests use moto for R2). Lint
with `ruff check . && ruff format --check .` (ruff `>=0.17,<0.18`, line length 100).
