# GEXBot EOD capture to R2 — design

Date: 2026-10-28. Status: **live (2026-10-29)**. Approved by the owner 2026-10-28 22:45 CT, to build now in
parallel with the GEXBot refresh session ("yeah just be mindful of migration numbering and shared file
edits"). See "As built" below; where the text further down still describes the plan, "As built" and the
corrected passages win.

## As built (2026-10-29)

- **Status: live.** The first production run, triggered by hand on 2026-10-29 at about 23:20 UTC, stored all
  60 reports for 2026-10-29: 1.63 GB in 175 s, 0 failed, no entry-count warnings, no rejected tickers. The 60
  reports rescued for 2026-10-28 were indexed from R2 (no re-download). DB and R2 counts and byte totals
  match for both dates (60 rows each; 1.75 GB for 10-28, 1.63 GB for 10-29).
- **Schedules** (`vercel.json`, `api/_lib/cron-schedules.ts`): capture `archive-gexbot-eod` at
  `0 2,12-21,23 * * *` and the loss report `audit-gexbot-eod` at `30 22,23 * * 1-5`, both as set by Amendment 1
  below. The first production run used the original `0 2,12,19,23 * * *` and `45 19 * * 1-5`.
- **Migration 195** creates `gexbot_eod_reports`.
- **Code:** `api/_lib/gexbot-eod.ts`, `api/_lib/gexbot-eod-zip.ts`, `api/_lib/r2.ts`,
  `api/cron/archive-gexbot-eod.ts`, `api/cron/audit-gexbot-eod.ts`.
- **Where the build differs from the plan** is fixed in the sections below (audit, status rules, metadata
  keys, size cap, timeouts, catch-up). The full list of build decisions (Rulings 1 to 20, each with its
  reason, plus every live probe) is in the build ledger
  `.superpowers/sdd/2026-10-28-gexbot-eod-capture/progress.md`. That folder is gitignored, so the ledger
  exists only on the owner's machine.

## Amendment 1 (2026-10-29): automatic retries

Owner request, 2026-10-29 18:40 CT: "can we just have it auto-retry x times or something? I really don't want
manual processes". The first design raised an alarm about 75 minutes before the download window closed, and
that alarm was a call for a manual rescue. This amendment removes the manual step. Missing reports now retry
on their own until the window closes, and the owner hears only about a real loss, for information only,
because nothing manual can do better than the cron.

A report D can be downloaded from 17:00 ET on D until 17:00 ET on the next trading day: 21:00 UTC to 21:00
UTC in EDT, and 22:00 UTC to 22:00 UTC in EST (from 2026-11-02).

- **A. Hourly runs.** The capture runs at `0 2,12-21,23 * * *`: 12 runs a day, hourly from 12:00 to 21:00 UTC
  (7 AM to 4 PM CDT, 6 AM to 3 PM CST), plus 23:00 and 02:00. A run with nothing missing makes no report
  request: one `/tickers` call and one DB query. At 21:00 UTC in EDT the window for D has just closed, so
  the expected date becomes D+1 and the run is simply D+1's first try. `maxRuntime` stays 14 and
  `maxDuration` 800.
- **B. Retries inside a run.** Each ticker gets up to 3 attempts (1 + 2 retries), waiting 15 s before the
  second and 45 s before the third. Retried: network errors, HTTP 5xx and 408, any `bad_response`,
  truncated bodies, ZIP validation errors, R2 verify failures, and R2 or DB errors on store or index. Not
  retried: a 429 (it still stops the run, the ticker goes to `leftover`), other 4xx (recorded as failed at
  once), `object_without_metadata` (permanent until a human looks), and any ticker hit by the run's stop
  flag, the 600 s start cutoff or the 740 s abort. No attempt starts at or after 600 s and no wait runs past
  it; a ticker whose wait would cross 600 s goes to `leftover`, not `failed`. An abort ends a wait at once.
  A ticker still lands in exactly one bucket. Two new metadata keys count retries: `retried` (tickers that
  needed at least one retry) and `recoveredByRetry` (tickers stored or indexed after a retry). Neither is an
  Axiom top-level column. Each retry logs a warning.
- **C. Quota guard.** A run of consecutive `notYetPublished` results (reports GEXBot has not yet published; see the threshold below) stops
  the run with `stopReason` `not_published` and the rest go to `leftover`, so 12 runs a day cannot spend 60
  requests each while GEXBot is late. The threshold is `max(3, ceil(todo / 4))` consecutive results, where
  `todo` is the number of tickers the run has to fetch: a full run of 60 stops after 15 in a row, a run with 8
  left after 3. A fixed 3 would let a few head-of-list tickers that keep serving yesterday's report starve
  the other 57 on every hourly run. Any other outcome resets the count. Status rules are unchanged.
- **Superseded report.** If GEXBot serves a report newer than the expected one (it published the next day's
  early), the expected report can no longer be fetched, because only the latest is served. The ticker is
  recorded as `failed` with reason `superseded` (the body is discarded, nothing is stored, no retry), which
  sends the usual `capture-failed` Sentry message. Once `expected` advances, the next run stores the newer
  report normally. A run also lists, in `leftoverAfterFailure`, each ticker that failed at least once and
  then ended in `leftover`, with its last failure reason.
- **D. Loss report.** The audit now runs at `30 22,23 * * 1-5`, after the window has closed in both EDT
  (21:00 UTC) and EST (22:00 UTC). Both runs check the same date (at 23:30 UTC it is still the same day in
  ET), so the second gives a failed first audit a retry. It takes `today` in ET; on a non-trading day it returns `skipped` and makes no
  call. Otherwise it checks `priorTradingDay(today)`, the report whose window just closed. Missing tickers
  give status `error` and one Sentry error, fingerprint `['gexbot-eod','missed-window']`, worded as a loss:
  "GEXBot EOD reports lost for <date>: <n> tickers (download window closed; automatic retries could not
  capture them)". It is information only; there is nothing to run.

## Goal

Every trading day, save GEXBot's full end-of-day report for every ticker our key can access into the
private R2 bucket, so a complete 2-second history of all GEXBot data builds up for future ML work.

## Why

- The owner pays for GEXBot's Orderflow tier and wants to keep everything it offers: "I want to capture
  everything we can", "retain this data for future ML purposes".
- Today we poll 16 tickers once a minute, and keep only part of what we download (see "What we capture
  today"). GEXBot's EOD report has the whole session at 2-second resolution, every strike, every
  category, from one request per ticker.
- GEXBot serves only the **latest** report. A day that isn't downloaded before 5 PM ET on the next
  trading day is lost for good: our tier has no backfill (the dated `/hist/{ticker}/{package}/{category}/{date}`
  route needs a Quant key).
- This is separate from the nightly UW Full Tape pipeline by owner decision ("that nightly pipeline spec
  was for the UW end of day full tape, this is for gexbot, so I would prefer it to be separate").

## Verified facts (2026-10-28, live calls with our key)

- **Account:** `/whoami` says level `orderflow`, no add-ons, permissions `app_access`, `api_rest_access`,
  `api_websocket_access`.
- **Tickers:** `GET https://api.gex.bot/v2/tickers` returns 60: `stocks` (54), `indexes` (4: NDX RUT SPX
  VIX), `futures` (2: ES_SPX NQ_NDX). We poll 16 of them today (`GEXBOT_TICKERS` in
  `api/_lib/gexbot-client.ts`).
- **Endpoint:** `GET https://api.gex.bot/v2/hist/eod/{ticker}`, same auth as the live calls
  (`Authorization: Bearer gexbot_custom_<key>`, built by `buildAuthHeader` in `gexbot-client.ts`).
  - Answers 200 directly with `application/zip` and a `Content-Length` header. No redirect.
  - `Content-Disposition: attachment; filename=eod_report_{TICKER}_{YYYY-MM-DD}.zip`. The date is the
    session the report covers.
  - Worked for every group tried: SPX, ES_SPX, NQ_NDX, SPY, QQQ, IWM, TLT, VIX, NVDA, SPCX, BOIL.
- **ZIP contents (SPX, 10-28):** 15 entries, one per category, each
  `{TICKER}/{package}/{category}/{date}_{TICKER}_{package}_{category}.json.gz`:
  classic `gex_full|gex_zero|gex_one`; state `gex_full|gex_zero|gex_one`, `delta|gamma|vanna|charm` ×
  `_zero|_one`; orderflow `orderflow`.
  - Each entry is a JSON list of snapshots with the same fields as the live endpoint (chains include
    `strikes`, `max_priors` and the major levels).
  - 13,360 snapshots per category, 13:30 → 20:00 UTC, median step 2 s, max gap 3 s. We poll 392 a day.
  - The entries are already gzip; the ZIP stores them uncompressed (compressed size = file size).
- **That is every REST category.** `/{package}/categories` lists exactly these 15. `volume_zero` and
  `volume_one` (options profile) are excluded from the EOD report and return 400 "Invalid category" on the
  live REST route too, so no REST call can get them.
- **Sizes (10-28, measured for all 60 by the Phase 0 rescue):** 1.74 GB in total. Largest: SNDK
  167.6 MB, then ES_SPX 86.3, SPX 85.2, NQ_NDX 68.9, QQQ 68.1, SPY 65.4. Smallest around 8 MB (VIX, BOIL).
  At that rate about 440 GB a year, about $6.60/month of R2 storage after a year (R2 egress is free).
- **Every one of the 60 reports had all 15 entries.**
- **Speed varies a lot:** the same SPX file (85 MB) took 8.9 s in the 10-28 vendor audit
  (`docs/tmp/gexbot-refresh-2026-10-28/vendor.md`) and 91 s in this design's first probe. The Phase 0 run
  (4 downloads at a time from the dev box) moved all 1.74 GB in 4 min 20 s: download median 2.1 MB/s per
  connection, slowest 0.3 MB/s; R2 upload median 14 MB/s. Throughput from Vercel is unmeasured; measure it
  before fixing concurrency and the wall budget.
- **Quota:** about 75 `/hist/eod` requests on 10-28 (probes plus the 60-ticker rescue) drew no 429.
- **Availability (GEXBot docs, "eod report"):** the report for an Eastern date becomes eligible at 5 PM ET,
  "after the nightly cold-storage export has completed", and stays the one served until 5 PM ET on the
  next trading day.
- **Quota:** undocumented for this endpoint. GEXBot returns 429 when a pool is exhausted and emails the
  account on the first breach per window. Quotas reset at midnight ET.

## What we capture today (for contrast; unchanged by this spec)

- `fetch-gexbot-fast` and `fetch-gexbot-strikes` poll 16 tickers every minute into `gexbot_snapshots` and
  `gexbot_api_capture` (raw JSON). `archive-gexbot` exports both to Parquet in Vercel Blob nightly;
  `cleanup-gexbot` trims archived days from Neon.
- Not captured live: the classic chain's per-strike ladder (fetched for 0DTE, only 10 summary fields
  kept), the classic `gex_one`/`gex_full` chains, and the State GEX profile (`/state/gex_*`, never called).
  The EOD report contains all of them.

## Goals

1. Every trading day, the EOD ZIP for every ticker `/tickers` lists lands in R2, byte-for-byte as delivered.
2. One Neon row per stored report, so we can see at a glance what we have.
3. A missed ticker is retried automatically within the day's window; a window that closes with a ticker
   still missing raises a Sentry error that names it.
4. New tickers GEXBot adds are captured without a code change.

## Non-goals

- Converting the files to Parquet, or any reader, query endpoint or UI. That's for the ML work later
  (DuckDB reads gzip JSON straight from the ZIP entries, or a conversion step gets added then).
- Changing the live minute polling. Adding the missing chains to it was considered and dropped (my call):
  the EOD files hold the same chains every 2 seconds.
- Calling `/majors`: verified identical to the matching chain fields at the same timestamp, for all six
  model × bucket pairs.
- Retiring the live `/maxchange` calls. They are redundant with the chain's `max_priors` (verified
  identical), but existing readers use those rows.
- Backfilling past days (needs Quant). `/futures/conversion`, Research and WebSocket are out of scope;
  the `api_websocket_access` permission is a lead to check another time.

## Anti-goals (would make this a failure even if it runs)

- A file stored under the wrong date, or a truncated or altered file stored as if it were complete.
- Silent loss: a ticker missing for a day with no alert before its window closes.
- Breaking or slowing the existing GEXBot capture, or tripping a GEXBot quota that the live polling shares.
- Any GEXBot data readable without auth (CLAUDE.md data-licensing rule). The bucket stays private and no
  endpoint serves these files.

## Decided

- **Separate job**, not part of the nightly UW pipeline (owner).
- **Destination: the existing private R2 bucket** (`R2_BUCKET_FULLTAPE`, today `theta-options-fulltape`),
  key `gexbot-eod/{TICKER}/{YYYY-MM-DD}.zip` (owner chose the bucket; the key layout is the one the nightly
  pipeline spec picked). Stored exactly as delivered.
- **All tickers** `/tickers` returns, read at run time, from all three groups (owner: "everything we can").
  `/tickers/quant` (WebSocket-only symbols) is excluded.
- **Host: a Vercel cron** (my call). It matches the other GEXBot jobs (CRON_SECRET, Sentry, Axiom,
  `vercel.json`), needs no new Railway service, and Vercel deploys don't have Railway's market-hours hold.
- **Index table in Neon**, written only after the R2 upload succeeds (my call). Suggested shape:
  `gexbot_eod_reports (ticker, report_date DATE, r2_key, bytes, sha256, entry_count, fetched_at,
  UNIQUE (ticker, report_date))`.
- **Validation before storing** (my call). The response must be 200 with a body length equal to
  `Content-Length`. It must parse as a ZIP (end-of-central-directory and every entry header). The
  `Content-Disposition` date, the date in every entry path and the R2 key date must all agree. The
  ticker in the entry paths must match the requested ticker. Record the entry count; warn (don't fail)
  when it isn't 15 (all 60 had 15 on 10-28, so a different count means GEXBot changed the report). As
  built: one Sentry warning per run, fingerprint `['gexbot-eod','entry-count']`, when any report in the run
  has another count.
- **Idempotent.** A ticker whose report date already has a row is skipped. If the R2 object exists but the
  row doesn't (an upload whose DB write failed), write the row from the object instead of re-downloading.
  Same key + same bytes means a re-upload is harmless. As built: a catch-up (a ticker whose report date
  is no longer the one GEXBot serves) indexes from R2 before it tries any download. `indexExistingObject`
  trusts an object only if its size matches, `source` metadata is present (any value), and its `ticker` and
  `report-date` metadata match the key; otherwise it refuses and the ticker is treated as failed.
- **Several attempts per window** (my call; superseded by Amendment 1, which makes the retries hourly), all
  running the same code: the first at least 30 minutes
  after 5 PM ET in both EDT and EST (so no earlier than 22:30 UTC), at least three more spread before the
  next close, and the last at least 1 hour before 5 PM ET in EDT (5 PM EDT is 21:00 UTC, so no later than
  20:00 UTC). Weekend and holiday runs are harmless (the latest
  report is already stored, so everything skips). The schedule is the capture cron `archive-gexbot-eod`
  at `0 2,12,19,23 * * *`: one `vercel.json` entry, every day (23:00 UTC is after 22:30, then 02:00, 12:00,
  and 19:00 is before 20:00).
- **Missed-window check** is a separate audit cron, `audit-gexbot-eod`, which raises the alert. As first
  built it ran at `45 19 * * 1-5`; Amendment 1 makes it a loss report that runs after the window has closed,
  at 22:30 and 23:30 UTC on weekdays (`30 22,23 * * 1-5`). If today in ET is a trading day it checks
  `priorTradingDay(today)`, the report whose window closed at 17:00 ET today; otherwise it skips. A capture
  run that crashes can't also swallow the alert. As built it is one check, and it makes **no
  report request** (a report request spends quota, and GEXBot serves only the latest report). It compares
  `listStoredTickers(thatDate)` against the
  `/tickers` list. Any ticker with no row gets a Sentry error naming the date and the tickers (fingerprint
  `['gexbot-eod','missed-window']`; under Amendment 1 the date is the report whose window closed that day, and
  the message is for information only). This catches a day GEXBot never published and a window our job missed
  entirely. (`src/` files imported by `api/` need `.js` extensions on their relative imports; see
  CLAUDE.md.) The audit also sends a Sentry warning, fingerprint `['gexbot-eod','rejected-tickers']`, when
  the ticker charset rejects any listed ticker; a rejected ticker can never be stored, so it is not counted
  as missing.
- **Cron status is honest** (R4): `success` only when every ticker is stored or skipped. Status follows
  `deriveCronStatus(failed, attempted)` like the rest of the fleet: some tickers failed is `partial`, all
  failed is `error`. Leftovers from the wall budget or a 429 make it at least `partial`. So does
  `notYetPublished` (the expected report wasn't served yet) and `caughtUp` (a catch-up ran, meaning an
  earlier window missed that ticker). A lost day is caught by the audit cron, not by the capture status.
  Report via `reportCronRun` with per-run fields in `meta` (never new top-level Axiom keys). As built, the
  count keys are `storedCount` and `skippedCount` (not `stored` / `skipped`, which are allowlisted
  top-level Axiom columns that another cron fills with booleans), plus a `caughtUp` counter. The Sentry
  cron monitor for the capture cron uses `maxRuntime` 14 minutes, to cover the 800 s function limit.
- **Ticker list guard.** A `/tickers` that answers non-OK, is malformed, is empty or lacks SPX throws
  (`gexbot_tickers_failed`), in both crons, so a broken list can't turn into a quiet "nothing to do".
- **Timeouts.** Each R2 call has a 120 s timeout per attempt and each DB call a 10 s timeout per attempt,
  so a hung dependency can't eat the whole wall budget.
- **New Vercel env vars:** the R2 ones the tape scripts already use (`R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`). As built, `api/` does not require
  `R2_ACCOUNT_ID`: only the local tape scripts read it, so it stays in the CLAUDE.md table and
  `.env.example` marked as local-only. R7: read in code + `api/_lib/env.ts` +
  the CLAUDE.md table + `.env.example`, same commit. (`GEXBOT_API_KEY` is already in all of them on
  `origin/main`.)

## Constraints

- Vercel function limit: up to 800 s (`backfill-futures-gaps` uses 800). At about 2 MB/s per connection
  (dev-box median; 0.3 MB/s at worst),
  all 60 tickers in one run need several downloads in parallel, and a run that runs short of time leaves
  the rest for the next attempt.
- Peak memory: the largest ZIP so far is 167.6 MB (SNDK), and sizes grow with a ticker's activity. As
  built, a report is read into one buffer preallocated to `Content-Length`, and a `Content-Length` above
  `MAX_EOD_REPORT_BYTES` (300 MiB) is refused. Whether
  to buffer or stream was the builder's call, but state the peak (concurrency × largest file, with headroom
  for a file twice that size) and keep it well under the function's memory.
- The live polling crons share the GEXBot account. EOD is its own endpoint, so it likely has its own quota
  pool (GEXBot docs: "quotas track independently per endpoint pool"), but treat any 429 as a stop signal
  for the run, not a reason to retry harder.
- **The EOD allowance is unknown** (my call on handling it): download in a fixed priority order (indexes and
  futures, then the ETFs we poll live, then the rest), start no new download after the first 429, and
  report the tickers left over. A daily allowance under 60 then costs the least important tickers, and the
  missed-window alert names them. Phase 0's 60-ticker pull is the first real test of the limit.
- No R2 client exists on the Node side today and `package.json` has no S3 library.

## Phases

0. **Rescue runs until the job is live (owner approved 2026-10-28: "yes, go ahead and pull it tonight").**
   A local script (scratchpad `gexbot-rescue/rescue.py`) downloads every ticker's report, runs the same
   checks the cron will (status, length, ZIP CRCs, entry names, ticker and date agreement), and uploads to
   the same keys with `sha256`, `ticker`, `report-date`, `entry-count` and `source` in the object
   metadata, verified by a HEAD (length, ETag = MD5, sha256). The cron's "object exists, row missing" path
   writes their index rows on its first run. Repeat it each night until the cron is live.
   - **10-28 done (21:50 CT):** all 60 stored under `gexbot-eod/{TICKER}/2026-10-28.zip`, 1.74 GB, every
     file verified, no 429.
   - **TLS finding:** the first run shared one boto3 client across 4 threads, and urllib3 logged 134
     `InsecureRequestWarning`s for the R2 host: those requests skipped certificate verification. Reproduced
     (shared client: 60 of 120 requests unverified; one client per thread: 0). The script now builds one
     client per thread, and a re-run logged none. The stored data is verified, but the R2 key travelled on
     unverified connections during that run (see "Owner actions").
   - The script and the run manifests are in `docs/tmp/gexbot-eod-rescue/` (gitignored). It was only a
     bridge until the cron went live (2026-10-29). Nothing runs it now: missing reports retry on their own
     (Amendment 1). It isn't committed.
1. **Index table:** migration 195 + `api/__tests__/db.test.ts`. (~30 min)
2. **R2 client:** a small `api/_lib/` module (put / head), the dependency, env wiring (`env.ts`,
   `.env.example`, CLAUDE.md table), tests. (~1–2 h)
3. **The cron:** handler + tests (auth guard, happy path, and each failure: 429, 5xx, timeout, truncated
   body, non-ZIP body, date mismatch, R2 put failure, DB insert failure, wall budget), `vercel.json`
   schedule and `maxDuration`, Sentry monitor. (~half a day)
4. **Housekeeping:** remove the GEXBot step from `2026-10-28-nightly-pipeline-automation-design.md` (its
   §"lake" R2 bullet, Phase 1 GexBot bullet, `GEXBOT_API_KEY` on that service, the GexBot tickers constant
   and the external dependency line) and point it here. (~15 min) The `gexbot-client.ts` `_zero`/`_one`
   comment this design first listed is already fixed on `origin/main`.

Build from `origin/main` in a worktree: on 2026-10-28 the local `main` checkout had diverged (17 behind,
9 ahead). The GEXBot refresh plan (`gexbot-refresh-2026-10-28.md`) has phases queued that also add
migrations and touch `vercel.json`, `api/_lib/cron-schedules.ts` and `CLAUDE.md`; whichever lands second
rebases onto the next free migration id.

## Files

- Phase 1: `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`.
- Phase 2: a new `api/_lib/` R2 module + its test, `package.json` / lockfile, `api/_lib/env.ts`,
  `.env.example`, `CLAUDE.md`.
- Phase 3: a new `api/cron/` handler + its test, `vercel.json` (and `api/_lib/cron-schedules.ts` if the
  schedule table needs the new job).
- Phase 4: the nightly pipeline spec.
- Phase 0: the script stays local in `docs/tmp/gexbot-eod-rescue/` (gitignored); nothing to commit.

## Owner actions

- **Done 2026-10-28 (owner request):** the five R2 variables were copied from `.env.local` into the Vercel
  project `options-strike-calculator` for Production, Preview and Development. `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY` are `sensitive` in Production and Preview; the account ID, endpoint URL and bucket
  name are plain `encrypted`; every Development copy is `encrypted`, so `vercel env pull` now writes them
  back instead of dropping them. `R2_CLOUDFLARE_TOKEN` (in `.env.local`, apparently a general Cloudflare API
  token) was not copied; nothing here uses it. Before this, no Vercel project and no team-shared variable
  held any R2 credential. Phase 2 still adds the names to `env.ts`, `.env.example` and the CLAUDE.md table.
- Optional: rotate that R2 key. It was sent over connections without certificate checks during the first
  10-28 rescue run (Phase 0, TLS finding). On a home network the risk is low; rotating now means updating
  it in both `.env.local` and Vercel. A bucket-scoped token just for Vercel remains an option.

## Left to the builder

The download concurrency and wall budget; the R2 library; buffer or stream; the index table's final name
and columns beyond the ones listed. (The cron names, the
schedule and the audit's "last attempt" are settled above.)

## Thresholds and constants

- Report window: eligible 5 PM ET on the session date, served until 5 PM ET on the next trading day.
- Last attempt: Amendment 1 runs the capture hourly through 21:00 UTC (the close in EDT); the original
  "no later than 20:00 UTC" rule is superseded.
- Retries: 3 attempts per ticker, waits of 15 s and 45 s; no attempt starts at or after 600 s.
- Quota guard: `max(3, ceil(todo / 4))` consecutive `notYetPublished` results stop the run (`stopReason` `not_published`).
- Expected entries per report: 15 (warn on other counts).
- Size cap per report: `MAX_EOD_REPORT_BYTES` = 300 MiB (about 1.8x the largest seen).
- Largest file seen: 167.6 MB (SNDK, 10-28). Daily total seen: 1.74 GB (60 tickers).
