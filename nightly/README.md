# nightly

Railway cron service (`nightly`) that lands the Unusual Whales options Full Tape
in Cloudflare R2: one Parquet object per trading day. It runs once and exits.

## What it does

Each run:

1. Lists the days already in R2 and plans the newest missing sessions, up to 30
   days of catch-up (`CATCHUP_MAX_DAYS`). The calendar starts at 2026-01-02
   (`TAPE_START`).
2. For each planned day, newest first: downloads the zip from UW, converts it to
   Parquet with polars (zstd level 3), checks it (see "Row and day checks"), and
   uploads it to R2. The upload is checked against the local byte count. A
   failed check deletes the object, so an unverified day never counts as landed.
3. Then probes the newest 5 days of the run's listing (`REWRITE_RECHECK_DAYS`),
   and re-lands each day whose UW ETag changed since it landed. The probes come
   after the planned days, so a slow probe never costs a missing day. A run whose
   planned days were skipped for disk or deadline probes nothing.
4. Reports each day to Sentry as soon as it finishes, then exits.

Logs go to stdout: Railway labels every stderr line an error.

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
- Watch paths `/nightly/Dockerfile`, `/nightly/requirements.txt` and
  `/nightly/src/**`: only the image inputs redeploy, so doc and test edits don't.

**Push hazard.** A redeploy during a run (about 07:15 to 12:30 UTC) can stop the
run. Code pushes to `nightly/src` should avoid that window. A killed run isn't
retried until the next night unless someone runs
`railway cron run --service nightly`.

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
| `SENTRY_DSN`           | no       | Without it Sentry is off; a malformed one fails boot |

The same variable names are in the repo `CLAUDE.md` env table. The bucket also
holds `gexbot-eod/`, written by another job; this service never touches it.

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
probed for a rewrite and adds nothing to the row-count baseline (it still takes
one of the baseline's 20 slots).

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
  5 h run deadline. This day and every later one in the run are skipped.

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
  (`PLAUSIBLE_MIN_ROW_RATIO`) the median `rows` of the 20 landed days nearest
  it, before or after, lands with a warning. It needs at least 10 of those days
  to carry `rows` (`PLAUSIBLE_MIN_TRAILING`). Because the baseline reaches both
  ways, a backfill day has one from the days landed after it.

The 0.65 ratio was tuned on 112 full days, so the half-days 2026-11-27 and
2026-12-24 will trip the row-ratio warning. They stay well above the floor and
land; the warning on those two days is expected.

## Forcing a re-land

Delete the day's object, `fulltape/{d}-fulltape.parquet`. The next run sees the
day as missing and lands it again. A run plans at most the newest 30 missing
days, so a day deleted from further back waits until the days after it have
landed.

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
  returned no ETag or was cut off by the deadline), the run sends one warning,
  `nightly rewrite check unavailable`, with the day count in `days`.

## Alert meanings

All Sentry events carry the tag `service=nightly` (`server_name=nightly`). A day
event also carries tags `day` and `status`. An unlanded day is grouped by status
and `detail`, so a new kind opens a new issue; an `unavailable` day is also
grouped by its date, so each marker opens its own issue. Its extras are
`detail`, `warnings` and `reason`. `reason` says more about a failure, but only
where the text is log-safe by contract: a `TapeValidationError`'s or
`R2VerifyError`'s message (names, counts and keys only), or a botocore
`ClientError`'s error code. Otherwise it is empty. It never changes the grouping.

| Sentry title                             | Level   | Meaning                                                                                                  |
| ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `nightly tape day failed`                | error   | A day did not land. `detail` names the kind; `reason` may say more. Retried next night.                  |
| `nightly tape day skipped_disk`          | error   | Free disk too low; the rest of the run was skipped.                                                      |
| `nightly tape day skipped_deadline`      | error   | The run ran out of time; the rest was skipped.                                                           |
| `nightly tape day not_posted`            | warning | UW had not posted a recent day. Usually clears itself.                                                   |
| `nightly tape day unavailable`           | warning | A marker was written; one issue per day. Check it was expected.                                          |
| `nightly tape day landed with warnings`  | warning | Landed, but a plausibility check flagged it (row ratio or time window) or cleanup failed.                |
| `nightly tape day relanded`              | warning | A day was re-landed after its UW ETag changed. Sent for every re-land; `warnings` lists any flags.       |
| `nightly re-land identical content`      | warning | A re-land whose `rows` and `source-bytes` equal the old object's: likely ETag churn, not a rewrite.      |
| `nightly rewrite check unavailable`      | warning | No probed day could be compared, so a rewrite would go unseen. `days` is how many were left unchecked.   |
| `nightly config invalid`                 | error   | Bad config. `fields` names the invalid settings. Sent only if `SENTRY_DSN` is valid.                     |
| `NYSE holiday table ends in {year}; ...` | warning | From Oct 1 of the table's last year. Add the next year to `calendar_nyse.py`, or the job refuses to run. |

A run that fails before its first day (R2 listing, work dir setup, an exhausted
calendar) sends the exception itself as an error event.

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

- `0`: every planned day landed, re-landed or was correctly marked unavailable.
  Also `0` when there was nothing to do.
- `1`: at least one day `failed`, was `not_posted`, or was skipped for disk or
  deadline; or the run failed before its first day. Read the Sentry events for
  the days.
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
PYTHONPATH=src python -m main
```

The modules import each other flat, so `src/` must be on the path: the
Dockerfile sets `PYTHONPATH=/app/src`, and a local shell needs `PYTHONPATH=src`.
A local run uses the real R2 bucket and the real UW key. It uses
`/tmp/nightly` as its work dir, which is a Unix path.

## Tests

```bash
cd nightly
python -m pytest
```

`conftest.py` and `pyproject.toml` put `src/` on the path. Lint with
`ruff check . && ruff format --check .` (ruff `>=0.17,<0.18`, line length 100).
