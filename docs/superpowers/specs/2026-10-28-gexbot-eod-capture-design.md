# GEXBot EOD capture to R2 — design

Date: 2026-10-28. Status: **approved by the owner 2026-10-28 22:45 CT**, to build now in parallel with the
GEXBot refresh session ("yeah just be mindful of migration numbering and shared file edits").

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
  when it isn't 15 (all 60 had 15 on 10-28, so a different count means GEXBot changed the report).
- **Idempotent.** A ticker whose report date already has a row is skipped. If the R2 object exists but the
  row doesn't (an upload whose DB write failed), write the row from the object instead of re-downloading.
  Same key + same bytes means a re-upload is harmless.
- **Several attempts per window** (my call), all running the same code: the first at least 30 minutes
  after 5 PM ET in both EDT and EST (so no earlier than 22:30 UTC), at least three more spread before the
  next close, and the last at least 1 hour before 5 PM ET in EDT (5 PM EDT is 21:00 UTC, so no later than
  20:00 UTC). Weekend and holiday runs are harmless (the latest
  report is already stored, so everything skips). The schedule is the capture cron `archive-gexbot-eod`
  at `0 2,12,19,23 * * *`: one `vercel.json` entry, every day (23:00 UTC is after 22:30, then 02:00, 12:00,
  and 19:00 is before 20:00).
- **Missed-window check** is a separate audit cron, `audit-gexbot-eod`, at `45 19 * * 1-5`, which raises the
  alert. Its "last attempt" is simply the 19:00 UTC capture, so a capture run that crashes can't also
  swallow the alert. It has two parts (my call, after the builder check):
  - Any ticker from `/tickers` with no row for the report date GEXBot is currently serving (from
    `Content-Disposition`) gets a Sentry error naming the tickers.
  - The most recent completed NYSE session, per the trading calendar in `src/data/marketHours.ts`, must
    have rows for every ticker. This catches a day GEXBot never published and a window our job missed
    entirely; the error names the date and the tickers. (`src/` files imported by `api/` need `.js`
    extensions on their relative imports; see CLAUDE.md.)
- **Cron status is honest** (R4): `success` only when every ticker is stored or skipped. Status follows
  `deriveCronStatus(failed, attempted)` like the rest of the fleet: some tickers failed is `partial`, all
  failed is `error`. Leftovers from the wall budget or a 429 make it at least `partial`. A lost day is
  caught by the audit cron, not by the capture status. Report via `reportCronRun` with
  per-run fields in `meta` (never new top-level Axiom keys). Add a Sentry cron monitor.
- **New Vercel env vars:** the R2 ones the tape scripts already use (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`). R7: read in code + `api/_lib/env.ts` +
  the CLAUDE.md table + `.env.example`, same commit. (`GEXBOT_API_KEY` is already in all of them on
  `origin/main`.)

## Constraints

- Vercel function limit: up to 800 s (`backfill-futures-gaps` uses 800). At about 2 MB/s per connection
  (dev-box median; 0.3 MB/s at worst),
  all 60 tickers in one run need several downloads in parallel, and a run that runs short of time leaves
  the rest for the next attempt.
- Peak memory: the largest ZIP so far is 167.6 MB (SNDK), and sizes grow with a ticker's activity. Whether
  to buffer or stream is the builder's call, but state the peak (concurrency × largest file, with headroom
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
   - The script and the run manifests are in `docs/tmp/gexbot-eod-rescue/` (gitignored). Nightly re-run,
     from that folder: `python -I rescue.py YYYY-MM-DD` with the session date, after 5 PM ET and before
     5 PM ET on the next trading day. Then check its log for `FAIL` and `InsecureRequestWarning`. It
     stays local in `docs/tmp/gexbot-eod-rescue/` (gitignored) until the cron is live; it isn't committed.
1. **Index table:** migration + `api/__tests__/db.test.ts`. (~30 min)
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
and columns beyond the ones listed; retry and backoff numbers for 5xx and timeouts. (The cron names, the
schedule and the audit's "last attempt" are settled above.)

## Thresholds and constants

- Report window: eligible 5 PM ET on the session date, served until 5 PM ET on the next trading day.
- Last attempt: at least 1 hour before 5 PM ET in EDT, i.e. no later than 20:00 UTC.
- Expected entries per report: 15 (warn on other counts).
- Largest file seen: 167.6 MB (SNDK, 10-28). Daily total seen: 1.74 GB (60 tickers).
