# GEXBot EOD capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every trading day, copy GEXBot's end-of-day ZIP for every ticker `/tickers` lists into private R2, byte-for-byte, with one Neon index row per file and an alert when a window closes with a ticker missing.

**Architecture:** A Vercel cron (`archive-gexbot-eod`, four attempts a day) downloads each ticker's report, validates it in memory, uploads it to R2 through a small S3 client module, verifies the upload, and inserts an index row. A second cron (`audit-gexbot-eod`, 19:45 UTC weekdays) checks the latest eligible session has a row for every ticker and raises a Sentry error naming the missing ones. Pure ZIP validation lives in its own module.

**Tech Stack:** TypeScript on Vercel Functions (Node 24), Neon via `getDb()`, `@aws-sdk/client-s3` against R2, `node:zlib` `crc32`, `node:crypto` hashes, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md` (approved 2026-10-28). Read it first; this plan only adds decisions.

## Global Constraints

- Work in a worktree off `origin/main` (local `main` has diverged). Push with `git push origin HEAD:main` after `git fetch origin && git rebase origin/main`.
- **Migration numbering:** another session (GEXBot refresh, P9/P10a/P10b) is adding migrations tonight. Immediately before every push: rebase, run `git show origin/main:api/_lib/db-migrations.ts | grep -oE "^\s+id: [0-9]+" | tail -1`, and make sure this plan's migration id is that max + 1 (renumber and fix `api/__tests__/db.test.ts` if not). Never ship an id that `origin/main` already uses.
- **Shared files** (`vercel.json`, `api/_lib/cron-schedules.ts`, `CLAUDE.md`, `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `api/_lib/gexbot-client.ts`): make additive edits only, resolve rebase conflicts by keeping both sides, and re-run `npm run review` after any rebase that touched them.
- R2 key: `gexbot-eod/{TICKER}/{YYYY-MM-DD}.zip`, bucket from `R2_BUCKET_FULLTAPE`. Object metadata keys exactly: `sha256`, `ticker`, `report-date`, `entry-count`, `source-content-length`, `fetched-at`, `source` (`'cron'`). The 10-28 rescue objects use the same keys with `source: 'rescue-2026-10-28'`.
- GEXBot: `GET https://api.gex.bot/v2/hist/eod/{ticker}` with `buildAuthHeader(GEXBOT_API_KEY)`; `GET /v2/tickers` is public (groups `stocks`, `indexes`, `futures`). `Content-Disposition` carries `eod_report_{TICKER}_{YYYY-MM-DD}.zip`.
- Ticker charset accepted: `/^[A-Z0-9_.]+$/`. Anything else is skipped and reported, never put in a URL or key.
- Expected entries per report: 15 (warn, don't fail, on any other count).
- Data licensing: nothing serves these files; the bucket stays private.
- Axiom: per-run fields go in `CronResult.metadata` only (the wrapper puts them in `meta`). No new top-level keys.
- Done gate per task: `npm run review` green. Tests ship in the same commit (CLAUDE.md).

## Decisions this plan adds (minor calls; recorded in the spec in Task 1)

- **Schedule:** capture `0 2,12,19,23 * * *` (one vercel.json entry, every day; weekend runs skip). That's 23:00 UTC ≥ 22:30, then 02:00, 12:00, and 19:00 ≤ 20:00. Audit: `45 19 * * 1-5`. One crontab each, so both get Sentry heartbeats through `SCHEDULE_MAP`.
- **The audit is its own cron,** so "the last attempt" is simply the 19:00 capture, and a capture run that crashes can't also swallow the alert.
- **Status** uses `deriveCronStatus(failed, attempted)` like the rest of the fleet: some tickers failed → `partial`, all failed → `error`. Leftovers from the wall budget or a 429 → at least `partial`. A lost day is caught by the audit, not by the capture status.
- **Body handling:** buffer each ZIP whole (largest seen 167.6 MB). Download concurrency 3, so peak heap is about 3 × 2 × 170 MB ≈ 1 GB, under the 2 GB function default. Wall budget: start no new download after 600 s; abort in-flight downloads at 740 s; `maxDuration` 800.
- **Served date decides the key.** The `Content-Disposition` date is the report date. If a row already exists for (ticker, served date), cancel the body and count it `notYetPublished` when the served date is older than expected, or `skipped` otherwise. If no row exists, store it under the served date, even if it's older than expected (catch-up).
- **The rescue script stays local** in `docs/tmp/gexbot-eod-rescue/` (gitignored) until the cron is live; it isn't committed.

## Review Focus

1. A `/tickers` symbol outside `[A-Z0-9_.]` (GEXBot adds one): it must be skipped and listed in metadata, never interpolated into a URL or R2 key. Test in Task 5.
2. `Content-Disposition` missing, quoted (`filename="eod_report_SPY_2026-10-28.zip"`), or naming another ticker: the parser accepts quoted and unquoted forms; a mismatch makes the ticker fail with reason `bad_disposition`. Test in Task 5.
3. Calendar edges for `latestEligibleReportDate`: the DST change (2026-11-01/02), Thanksgiving 2026-11-26, the 2026-11-27 half day, and the moment 17:00 ET passes. Table test in Task 5.
4. An R2 object that exists without usable metadata (uploaded by hand): it fails with reason `object_without_metadata`, is never silently counted as stored, and is never re-downloaded over. Test in Task 5.
5. A report with an entry count other than 15: it's stored, and the run metadata lists it under `entryCountWarnings`. Test in Task 6.

---

### Task 1: Worktree, docs and spec alignment

**Files:**
- Copy in: `docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md`, `docs/superpowers/plans/2026-10-28-gexbot-eod-capture.md` (both untracked in the main checkout)
- Modify: `docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md`

- [ ] **Step 1:** `git worktree add .worktrees/gexbot-eod origin/main -b feat/gexbot-eod-capture`, then right away `git worktree lock .worktrees/gexbot-eod --reason "gexbot-eod build in progress"`. The SessionStart prune hook removes merged, clean, unlocked worktrees, and after every push this one is both merged and clean. Then `cd` there and `npm ci`.
- [ ] **Step 2:** Copy the spec and plan in. In the spec, replace the Phase 0 "build's first task commits it under `scripts/`" sentence with the local-only decision above. Replace the "Missed-window check on each weekday's last attempt" and "Several attempts per window" bullets' open choices with this plan's schedule and the separate audit cron. Note the `deriveCronStatus` status rule.
- [ ] **Step 3:** In the nightly-pipeline spec, remove the GEXBot step: the §"lake" bullet "GexBot EOD ZIPs also go to R2…", Phase 1's "GexBot: pull the latest EOD ZIP…" bullet, `GEXBOT_API_KEY` from its env-var list, "GexBot tickers: SPX, SPY, QQQ", and GexBot `/hist/eod/{ticker}` from its external dependencies. Add one line under its Decisions: "GEXBot EOD capture moved to its own spec, `2026-10-28-gexbot-eod-capture-design.md` (owner, 2026-10-28)."
- [ ] **Step 4:** Commit (docs only; no review loop needed): `docs(spec): Plan the GEXBot EOD capture and take it out of the nightly pipeline`. Push per Global Constraints.

### Task 2: Index table migration

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append), `api/__tests__/db.test.ts`

**Interfaces:**
- Produces: table `gexbot_eod_reports (id BIGSERIAL PRIMARY KEY, ticker TEXT NOT NULL, report_date DATE NOT NULL, r2_key TEXT NOT NULL, bytes BIGINT NOT NULL, sha256 TEXT NOT NULL, entry_count INT NOT NULL, source TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (ticker, report_date))`, plus index `(report_date)`.

- [ ] **Step 1:** Update `db.test.ts` first per CLAUDE.md "DB Migrations": add `{ id: N }`, the expected-output entry, and the SQL call count (+1 statement per SQL in the migration, +1 for the `schema_migrations` insert). Run `npx vitest run api/__tests__/db.test.ts` and expect FAIL.
- [ ] **Step 2:** Append migration `N` (= `origin/main` max + 1, checked at this moment) with description `Create gexbot_eod_reports index of GEXBot EOD ZIPs in R2 (spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md)`. Use `CREATE … IF NOT EXISTS`.
- [ ] **Step 3:** Run the test; expect PASS. `npm run review`.
- [ ] **Step 4:** Commit `feat(db): Add the gexbot_eod_reports index table`. Before pushing, re-run the id check from Global Constraints.

### Task 3: R2 client module and env wiring

**Files:**
- Create: `api/_lib/r2.ts`, `api/__tests__/r2.test.ts`
- Modify: `package.json` + lockfile (add `@aws-sdk/client-s3`, latest 3.x), `api/_lib/env.ts`, `.env.example`, `CLAUDE.md` (env table rows for `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`, source "Cloudflare R2 (also local tape scripts)")

This touches 6 hand-edited files because R7 requires the env change in the same commit as the code that reads it.

**Interfaces:**
- Produces:
  - `getR2Bucket(): string`: throws `Error('R2 is not configured: <missing var names>')` when any of the five is unset.
  - `r2PutObject(key: string, body: Uint8Array, opts: { contentType: string; metadata: Record<string, string> }): Promise<void>`
  - `r2HeadObject(key: string): Promise<{ contentLength: number; etag: string; metadata: Record<string, string> } | null>`: `null` on 404/`NotFound`, rethrows anything else. `etag` has its quotes stripped.
- Client: a lazy singleton `S3Client` with `region: 'auto'`, `endpoint: R2_ENDPOINT_URL`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`. One bounded module-level client is fine under R1.

- [ ] **Step 1:** Write `r2.test.ts` with `vi.mock('@aws-sdk/client-s3')` (mock at the module boundary, R3). Tests:
  - put sends `Bucket`, `Key`, `Body`, `ContentType`, `Metadata`;
  - head maps `ContentLength`/`ETag`/`Metadata` and strips quotes;
  - head returns `null` on `{ name: 'NotFound' }` and on `$metadata.httpStatusCode: 404`;
  - head rethrows a 500;
  - `getR2Bucket` throws naming the missing vars;
  - put rejects when the SDK rejects (failure mode, R4).
- [ ] **Step 2:** Run it; expect FAIL. Install the dep (skill `dependency-upgrade`: check audit via node, and whether it needs `allow-scripts`). Implement. Run it; expect PASS.
- [ ] **Step 3:** Add the five names to `env.ts` (optional strings, same style as `GEXBOT_API_KEY`), `.env.example` (empty values) and the CLAUDE.md table. `npm run review`.
- [ ] **Step 4:** Commit `feat(r2): Add an R2 client module for private object storage`. Push per Global Constraints.

### Task 4: EOD ZIP validator (pure)

**Files:**
- Create: `api/_lib/gexbot-eod-zip.ts`, `api/__tests__/gexbot-eod-zip.test.ts`, `api/__tests__/helpers/stored-zip.ts`

**Interfaces:**
- Produces:
  - `class EodZipError extends Error { reason: 'not_zip' | 'zip64_unsupported' | 'bad_crc' | 'bad_entry_name' | 'empty' | 'unsupported_method' }`
  - `validateEodZip(body: Uint8Array, ticker: string, date: string): { entryCount: number; entryNames: string[] }`
- Test helper: `buildStoredZip(entries: { name: string; data: Uint8Array }[], opts?: { corruptCrcOf?: string }): Uint8Array` writes a method-0 ZIP using `zlib.crc32`.

Algorithm: find the end-of-central-directory record (`0x06054b50`) in the last 65,557 bytes. Reject ZIP64 (`0xFFFF` counts, `0xFFFFFFFF` sizes or offsets). Walk the central directory (`0x02014b50`). For each entry, read its local header (`0x04034b50`) to find the data offset. Method 0 means the data is the stored bytes; method 8 means `zlib.inflateRawSync`; any other method is `unsupported_method`. Compare `zlib.crc32(data)` with the directory CRC. Each name must match `^{ticker}/(classic|state|orderflow)/[a-z_]+/{date}_{ticker}_\1_[a-z_]+\.json\.gz$`, with the ticker regex-escaped.

- [ ] **Step 1:** Tests:
  - a valid 15-entry fixture returns `entryCount: 15`;
  - random bytes → `not_zip`;
  - a body cut 100 bytes short → `not_zip` (no EOCD);
  - a corrupted CRC → `bad_crc`;
  - an entry for another ticker → `bad_entry_name`;
  - an entry with another date → `bad_entry_name`;
  - a ticker containing `.` (`BRK.B`) is escaped correctly;
  - a ZIP64 sentinel in the EOCD → `zip64_unsupported`;
  - zero entries → `empty`.
- [ ] **Step 2:** Run; expect FAIL. Implement. Run; expect PASS. `npm run review`.
- [ ] **Step 3:** Commit `feat(gexbot): Validate GEXBot EOD ZIPs before storing them`. Push.

### Task 5: EOD fetch, store and index library

**Files:**
- Create: `api/_lib/gexbot-eod.ts`, `api/__tests__/gexbot-eod.test.ts`
- Modify: `api/_lib/gexbot-client.ts`: add `export` to `GEXBOT_BASE` and `buildAuthHeader` only; no other change (the file is shared with the refresh session)

**Interfaces:**
- Consumes: `r2PutObject`, `r2HeadObject` (Task 3); `validateEodZip` (Task 4); `getDb`, `withDbRetry` from `api/_lib/db.ts`; `isTradingDay`, `priorTradingDay` from `../../src/data/marketHours.js`; `getETDateStr`, `getETTime` from `../../src/utils/timezone.js`.
- Produces:
  - `EOD_PRIORITY: readonly string[]` = `['SPX','ES_SPX','NDX','NQ_NDX','RUT','VIX','SPY','QQQ','IWM','TLT','GLD','USO','TQQQ','UVXY','HYG','SLV']`
  - `fetchEodTickers(): Promise<{ tickers: string[]; rejected: string[] }>`: `stocks`, `indexes` and `futures` from `/tickers`, in `EOD_PRIORITY` order, then alphabetical; anything failing the charset goes to `rejected`.
  - `latestEligibleReportDate(now: Date): string`: the latest trading day `D` with `now` ≥ 17:00 ET on `D`.
  - `parseEodDisposition(header: string | null): { ticker: string; date: string } | null`
  - `eodKey(ticker: string, date: string): string`
  - `requestEodReport(apiKey: string, ticker: string, signal: AbortSignal): Promise<EodResponse>`, where `EodResponse` is one of:
    - `{ kind: 'quota' }`
    - `{ kind: 'http_error'; status: number }`
    - `{ kind: 'bad_response'; reason: 'bad_disposition' | 'bad_content_type' | 'no_length' }`
    - `{ kind: 'ok'; servedDate: string; contentLength: number; readBody(): Promise<Uint8Array>; discard(): Promise<void> }`

    `readBody` throws `Error('truncated: got X of Y bytes')` when the length differs.
  - `storeEodReport(args: { ticker: string; date: string; body: Uint8Array; entryCount: number }): Promise<{ key: string; sha256: string; bytes: number }>`: computes sha256 and md5, puts with the Global Constraints metadata (`source: 'cron'`), HEAD-verifies length, `etag === md5` and `metadata.sha256`, throws `Error('r2_verify_failed: …')` on mismatch, then inserts the row (`ON CONFLICT (ticker, report_date) DO NOTHING`, through `withDbRetry`).
  - `indexExistingObject(ticker: string, date: string): Promise<'indexed' | 'absent'>`: HEAD; if present, inserts the row from metadata; throws `Error('object_without_metadata')` when `sha256` or `entry-count` is missing.
  - `listStoredTickers(date: string): Promise<Set<string>>`

- [ ] **Step 1:** Tests:
  - mock `fetch` (`vi.stubGlobal`), `./r2.js` and `./db.js` at the boundary;
  - `latestEligibleReportDate` table, all as ET wall-clock instants:

    | Now (ET) | Expected |
    |---|---|
    | 2026-10-29 16:59 | 2026-10-28 |
    | 2026-10-29 17:00 | 2026-10-29 |
    | Sat 2026-10-31 12:00 | 2026-10-30 |
    | Mon 2026-11-02 09:00, after DST end | 2026-10-30 |
    | Thanksgiving 2026-11-26 20:00 | 2026-11-25 |
    | 2026-11-27 18:00, half day | 2026-11-27 |

  - `parseEodDisposition` accepts the unquoted, quoted and `filename*=` forms, and returns `null` for a missing header or junk;
  - `fetchEodTickers` ordering, plus `rejected` for `'BAD TICKER'` and `'../x'` (Review Focus 1);
  - `requestEodReport`:
    - 429 → `quota`;
    - 503 → `http_error`;
    - a disposition for another ticker → `bad_response` `bad_disposition` (Review Focus 2);
    - a short body → `readBody` rejects with `truncated`;
  - `storeEodReport`:
    - the put metadata keys equal the Global Constraints list exactly;
    - an etag mismatch throws `r2_verify_failed` and inserts no row;
    - a DB reject propagates;
  - `indexExistingObject`:
    - inserts from metadata;
    - returns `absent` on a `null` head;
    - throws `object_without_metadata` (Review Focus 4).
- [ ] **Step 2:** Run; expect FAIL. Implement. Run; expect PASS. `npm run review`.
- [ ] **Step 3:** Commit `feat(gexbot): Fetch, store and index GEXBot EOD reports`. Push.

### Task 6: Capture cron `archive-gexbot-eod`

**Files:**
- Create: `api/cron/archive-gexbot-eod.ts`, `api/__tests__/archive-gexbot-eod.test.ts`
- Modify: `vercel.json` (add the cron `{ "path": "/api/cron/archive-gexbot-eod", "schedule": "0 2,12,19,23 * * *" }` and `"api/cron/archive-gexbot-eod.ts": { "maxDuration": 800 }`), `api/_lib/cron-schedules.ts` (add `'archive-gexbot-eod': { schedule: '0 2,12,19,23 * * *', checkinMargin: DEFAULT_MARGIN, maxRuntime: LONG_RUNNER_MAX_RUNTIME }`, with a comment naming the spec)

**Interfaces:**
- Consumes: Task 5's functions; `withCronInstrumentation`, `deriveCronStatus` from `api/_lib/cron-instrumentation.ts`, with options `{ marketHours: false, requireApiKey: false }`. Mirror the shape of `api/cron/archive-gexbot.ts`: job name, handler returning `CronResult`, options. `GEXBOT_API_KEY` from env (missing → throw).
- Produces: `CronResult.metadata`: `{ expectedDate, tickers, stored, indexedFromR2, skipped, notYetPublished, failed: { ticker, reason }[], leftover: string[], stopReason: 'quota' | 'budget' | null, bytes, entryCountWarnings: { ticker, entryCount }[], rejectedTickers }`

The flow per run:
1. Get the ticker list.
2. `expected = latestEligibleReportDate(now)`; `todo` = the tickers without a row for `expected`.
3. Process `todo` with concurrency 3, in priority order. For each ticker:
   - `indexExistingObject` (if `indexed`, done);
   - else `requestEodReport`;
     - on `quota`: set the stop flag (no new requests), and the ticker goes to `leftover`;
     - on `ok`: if a row exists for (ticker, servedDate), `discard()` (`notYetPublished` if older than expected, else `skipped`); otherwise `readBody` → `validateEodZip` → `storeEodReport`.
   - After 600 s, start nothing new. At 740 s, abort in-flight downloads (`AbortController`) into `leftover`.
4. Status: `deriveCronStatus(failed.length, attempted)`. If `leftover.length > 0` and the status would be `success`, use `partial`. One Sentry `captureMessage` per run at level `error` when `failed.length > 0`, fingerprint `['gexbot-eod', 'capture-failed']`, extra `{ expectedDate, failed }`.

- [ ] **Step 1:** Tests (cron pattern from CLAUDE.md; mock `../_lib/gexbot-eod.js` and `../_lib/gexbot-eod-zip.js`):
  - 401 without `CRON_SECRET`;
  - happy path, two tickers stored → `success`, `stored: 2`;
  - every ticker already has a row → no `requestEodReport` call;
  - object exists → `indexedFromR2`, no download;
  - served older + row exists → `discard` called, `notYetPublished`;
  - 429 on the 2nd of 4 tickers → no 3rd/4th request, `leftover` has 2, `stopReason: 'quota'`, `partial`;
  - truncated body → `failed` with reason, `partial`;
  - validator throws `bad_crc` → nothing stored;
  - store throws `r2_verify_failed` → `failed`;
  - a DB reject on the row lookup → `error`, not `success` (R4);
  - fake timers past 600 s → no new starts, `stopReason: 'budget'`;
  - `entryCount: 14` → stored and listed in `entryCountWarnings` (Review Focus 5);
  - missing `GEXBOT_API_KEY` → `error`.
- [ ] **Step 2:** Run; expect FAIL. Implement. Add the vercel.json and `SCHEDULE_MAP` entries. Run `npx vitest run api/__tests__/archive-gexbot-eod.test.ts api/__tests__/cron-schedules.test.ts`; expect PASS. `npm run review`.
- [ ] **Step 3:** Commit `feat(gexbot): Archive every GEXBot EOD report to R2 nightly`. Rebase, re-check the shared files, push.

### Task 7: Audit cron `audit-gexbot-eod`

**Files:**
- Create: `api/cron/audit-gexbot-eod.ts`, `api/__tests__/audit-gexbot-eod.test.ts`
- Modify: `vercel.json` (add `{ "path": "/api/cron/audit-gexbot-eod", "schedule": "45 19 * * 1-5" }`), `api/_lib/cron-schedules.ts` (add `'audit-gexbot-eod': { schedule: '45 19 * * 1-5', checkinMargin: DEFAULT_MARGIN, maxRuntime: DEFAULT_MAX_RUNTIME }`)

**Interfaces:**
- Consumes: `fetchEodTickers`, `latestEligibleReportDate`, `listStoredTickers` (Task 5).
- Produces: `CronResult` with `metadata { date, tickers, missing: string[] }`. Status `success` when `missing` is empty. Otherwise `error`, plus `Sentry.captureMessage('GEXBot EOD reports missing for <date>: <n> tickers', 'error')`, fingerprint `['gexbot-eod', 'missed-window']`, extra `{ date, missing }`. The window still has 75 minutes, enough for a manual rescue run.

- [ ] **Step 1:** Tests:
  - auth guard;
  - all present → `success`, no Sentry;
  - two missing → `error`, Sentry called once with both names and the date;
  - `/tickers` failure → `error` (thrown);
  - DB reject → `error`;
  - the date comes from `latestEligibleReportDate` (fixed `now`).
- [ ] **Step 2:** Run; expect FAIL. Implement and wire the entries. Run the test and `cron-schedules.test.ts`; expect PASS. `npm run review`.
- [ ] **Step 3:** Commit `feat(gexbot): Alert when a GEXBot EOD window closes with tickers missing`. Rebase, re-check, push.

### Task 8: Go live and verify on production

- [ ] **Step 1:** Confirm the production deploy for the last push is READY (skill `vercel-deployment`).
- [ ] **Step 2:** Apply the Task 2 migration to prod. This is outward-facing and needs the owner's OK in this session; it's additive. Either use direct SQL against `DATABASE_URL` plus a `schema_migrations` row, or `POST /api/journal/migrate`. First confirm with `SELECT max(id) FROM schema_migrations` that nothing else took the id.
- [ ] **Step 3:** Trigger one capture run with `CRON_SECRET`. Expected for 10-28: `indexedFromR2` = 60 and `stored` = 0, no failures, and `SELECT count(*) FROM gexbot_eod_reports WHERE report_date = '2026-10-28'` returns 60. If it runs after 17:00 ET on 10-29, expect 10-29 to download instead.
- [ ] **Step 4:** Check Axiom (`parse_json(meta)`) and the Sentry monitor check-in for the run. Update the spec status and memory `project_gexbot_eod_capture.md`: the cron is live and nightly rescues stop. After the last push, `git worktree unlock .worktrees/gexbot-eod` and then `git worktree remove .worktrees/gexbot-eod`.
