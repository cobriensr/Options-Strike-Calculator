# GexBot archive repair — 2026-10-02

## Goal

Restore the daily GexBot Parquet archive (dead since 2026-09-08), backfill the
19 un-archived sessions, and make the archive/cleanup pair safe against a
missed day, so the live capture table stops growing without bound and no
un-archived session can be deleted.

## Background (from `docs/tmp/gexbot-leverage-audit-2026-10-02.md`)

- `api/cron/archive-gexbot` has returned 500 on every run since 09-08.
  `@dsnp/parquetjs@1.8.8` → `thrift@0.23.0` → `uuid@13.0.2` (ESM-only);
  thrift's `compact_protocol.js` does `require('uuid')` and Vercel's Node
  loader rejects `require()` of an ES module (`ERR_REQUIRE_ESM`). The crash
  is at module load, so Sentry never sees it, and the cron has no heartbeat.
- Lockfile moved to uuid 13 in commit 08e5b59b (2026-09-08). Last successful
  archive_date is 2026-09-04. Live tables hold 19 sessions (09-08 → 10-02);
  `gexbot_api_capture` is 3.24 GB and grows ~170 MB per session.
- `cleanup-gexbot` gates on `MAX(archive_date)`. Once any later day archives,
  it deletes every earlier day, archived or not. `archive-gexbot` only ever
  archives "yesterday" and has no date parameter, so after a fix the next
  cleanup would delete 09-08 → fix-date un-archived. This plan closes both.
- Row-day boundaries: both crons select rows with
  `captured_at >= d::timestamptz AND captured_at < (d::date + 1)::timestamptz`
  where the Neon session timezone is UTC. GexBot sessions run 13:30–20:01 UTC
  and never straddle UTC midnight, so UTC-day == ET session date. The new
  helper uses the identical predicate.

## Global constraints

- Work happens in worktree `F:\dev\strike-calculator-wt-archive`
  (Git Bash path `/f/dev/strike-calculator-wt-archive`), branch
  `fix/gexbot-archive-repair` off `origin/main` b95872fd. Run every command
  from that directory. Do not touch `F:\dev\strike-calculator`.
- Before reporting a task done: `npm run review` in the worktree must pass
  (tsc, eslint, prettier --write, vitest --coverage). File-scoped test runs
  are not sufficient.
- One commit per task, conventional-commit subject, body ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
  Single-quote commit messages (no backticks inside `-m`).
- Code style per CLAUDE.md: `Number.parseInt`/`Number.parseFloat`, `.at(-1)`,
  `import type` for type-only imports, explicit `.js` extensions on relative
  imports under `api/`, no nested template literals.
- Tests mock at the module boundary with `vi.mock` (no `deps` params or test
  seams). Every task's tests cover failure modes by name: DB rejection,
  upstream throw, malformed input. A cron whose write fails must not report
  `success`.
- No new env vars. No `vercel.json` changes (archive already has
  `maxDuration: 300`; both cron paths and schedules stay as they are).
- Neon returns DATE columns as `Date` objects and NUMERIC as strings; prefer
  `to_char(..., 'YYYY-MM-DD')` in SQL so date values arrive as text.

## Task 1: Pin thrift's uuid to a CommonJS release and guard it

**Files:** `package.json`, `package-lock.json` (regenerated),
`api/__tests__/gexbot-parquet-deps.test.ts` (new).

1. In `package.json` → `overrides`, keep the existing
   `"@opentelemetry/instrumentation-http": "0.214.0"` entry and add a nested
   override so only thrift's uuid is pinned:
   ```json
   "overrides": {
     "@opentelemetry/instrumentation-http": "0.214.0",
     "thrift": { "uuid": "^11.1.1" }
   }
   ```
2. Run `npm install` in the worktree (this is also the worktree's first
   install, so it populates `node_modules`). Then confirm:
   - `npm ls uuid` shows exactly one uuid, `uuid@11.1.1` (or a later 11.x)
     under `thrift@0.23.0`, nothing at 12.x or 13.x.
   - `npm ls` reports no `invalid` or `missing` lines for thrift or parquetjs.
3. Add `api/__tests__/gexbot-parquet-deps.test.ts` (`// @vitest-environment node`).
   It resolves uuid **from thrift's own directory**, the way thrift does:
   ```ts
   import { createRequire } from 'node:module';
   const rootRequire = createRequire(import.meta.url);
   const thriftPkgPath = rootRequire.resolve('thrift/package.json');
   const thriftRequire = createRequire(thriftPkgPath);
   const uuidEntry = thriftRequire.resolve('uuid');
   ```
   Walk up from `uuidEntry` with `path.dirname` until a `package.json` whose
   `name === 'uuid'` is found; read its `version`. Assert
   `Number.parseInt(version, 10) <= 11`. Header comment: uuid ≥ 12 ships
   ESM-only; thrift (pulled in by @dsnp/parquetjs for the GexBot archive)
   `require()`s it; Vercel's Node loader does not support `require(esm)`, so
   `archive-gexbot` crashed at module load from 2026-09-08 to 2026-10-02.
   This test fails if a future lockfile sync re-floats uuid past 11.
   Also assert the resolved entry file is not under a `dist/esm` or
   `dist-node` directory — a second, independent CJS signal
   (uuid 11 CJS entry lives at `dist/cjs/index.js`; 13's at `dist-node/index.js`).
4. `npm run review` must pass. Report the `npm ls uuid` output verbatim.

Commit subject: `fix(deps): Pin thrift's uuid to 11.x so the Parquet archive loads on Vercel`

## Task 2: Shared "un-archived session dates" helper

**Files:** `api/_lib/gexbot-archive-dates.ts` (new),
`api/__tests__/gexbot-archive-dates.test.ts` (new).

Export:
```ts
export const GEXBOT_ARCHIVE_TABLES = ['gexbot_snapshots', 'gexbot_api_capture'] as const;
export type GexbotArchiveTable = (typeof GEXBOT_ARCHIVE_TABLES)[number];
export async function listUnarchivedDates(
  sql: Sql,                 // same type the crons get from getDb()
  table: GexbotArchiveTable,
  beforeDate: string,       // 'YYYY-MM-DD'; only days strictly before this
): Promise<string[]>;       // ascending 'YYYY-MM-DD'
```
A date `d` is returned when all three hold: `d < beforeDate`; `table` has
at least one row with `captured_at >= d::timestamptz AND captured_at <
(d + 1)::timestamptz`; and `gexbot_archive_audit` has no row with
`table_name = table AND archive_date = d`.

Use `generate_series` from `MIN(captured_at)::date` so the query probes the
`captured_at` index once per day instead of scanning 1.8M rows for a
`DISTINCT`. Two explicit query branches keyed on `table` (the Neon tagged
template parameterizes values, not identifiers; this mirrors
`archive-gexbot.ts` `streamRows`). Wrap each in
`withDbRetry(() => ..., 2, 10_000)` like the crons do. Shape:
```sql
WITH bounds AS (SELECT MIN(captured_at)::date AS lo FROM gexbot_api_capture),
days AS (
  SELECT generate_series(lo, ${beforeDate}::date - 1, INTERVAL '1 day')::date AS d
  FROM bounds WHERE lo IS NOT NULL
)
SELECT to_char(d, 'YYYY-MM-DD') AS d
FROM days
WHERE EXISTS (
  SELECT 1 FROM gexbot_api_capture t
  WHERE t.captured_at >= d::timestamptz AND t.captured_at < (d + 1)::timestamptz
)
AND NOT EXISTS (
  SELECT 1 FROM gexbot_archive_audit a
  WHERE a.table_name = 'gexbot_api_capture' AND a.archive_date = d
)
ORDER BY d
```
Return `rows.map((r) => String(r.d))`. Doc comment must state the UTC-day
boundary rationale from Background and that archive and cleanup both depend
on this one predicate so they can never disagree about what is "archived".

Tests (mock `../_lib/db.js` exactly as `archive-gexbot.test.ts` does):
- returns `[]` when the query returns no rows;
- returns the dates as strings in query order for `['2026-09-08','2026-09-09']`;
- the SQL text sent for `'gexbot_snapshots'` references `gexbot_snapshots`
  and not `gexbot_api_capture`, and vice versa (inspect
  `mockSql.mock.calls[0][0]` joined);
- the `beforeDate` argument is passed as a query parameter;
- a rejected query propagates (`await expect(...).rejects.toThrow('boom')`).

Commit subject: `feat(gexbot): Add listUnarchivedDates shared by the archive and cleanup crons`

## Task 3: Archive every un-archived session, oldest first, with a manual date override

**Files:** `api/cron/archive-gexbot.ts`, `api/__tests__/archive-gexbot.test.ts`.
Depends on Task 2's `listUnarchivedDates` and `GexbotArchiveTable`.

Behavior:
1. Pass `passReq: true` in the wrapper options so `ctx.req` is populated.
2. Target selection:
   - If `ctx.req?.query.date` is a string: it must match
     `/^\d{4}-\d{2}-\d{2}$/`, otherwise `throw new Error('archive-gexbot: invalid date param')`
     (the wrapper turns a throw into a 500). A valid value is archived for
     **both** tables regardless of audit state (manual re-archive is
     idempotent: Blob `allowOverwrite: true` + audit `ON CONFLICT ... DO UPDATE`).
   - Otherwise build the pending set: for each table in
     `GEXBOT_ARCHIVE_TABLES`, `await listUnarchivedDates(sql, table, ctx.today)`.
     Dates = sorted ascending union. For each date, archive only the tables
     whose pending list contains it (a half-archived day re-archives only
     the missing table).
3. Budget. Constants at module top, each with a one-line comment:
   `const MAX_DURATION_MS = config.maxDuration * 1000;` (single source of
   truth with the exported `config`), `NEXT_DATE_SAFETY_FACTOR = 1.5`,
   `NEXT_DATE_MARGIN_MS = 15_000`, `MAX_DATES_PER_RUN = 5`. The first date
   always runs. After each date finishes, measure its wall time
   `lastDateMs`; start the next pending date only if
   `datesDone < MAX_DATES_PER_RUN` and
   `MAX_DURATION_MS - (Date.now() - ctx.startTimeMs) > NEXT_DATE_SAFETY_FACTOR * lastDateMs + NEXT_DATE_MARGIN_MS`.
   Record `stopReason: 'drained' | 'budget' | 'max_dates'` and
   `remainingDates` (pending dates not started).
4. Failure handling: keep the existing per-table `try/catch` with
   `Sentry.captureException` tagged `gexbot.cron`, `gexbot.table`,
   `gexbot.archive_date`; count failures; a failed table never stops the
   other table or later dates (cleanup's per-date gate makes that safe).
5. Result: `status: failed === 0 ? 'success' : 'partial'`; `rows` = total
   archived rows; `metadata: { dates: [<'YYYY-MM-DD'>...], summaries, failed, remainingDates, stopReason }`.
   When `remainingDates > 0`, `ctx.logger.warn({ remainingDates, stopReason }, 'archive-gexbot backlog remains')`.
6. Delete `getArchiveDate` (now dead). Update the header comment: catch-up
   semantics, `?date=` usage (`GET /api/cron/archive-gexbot?date=2026-09-08`
   with the CRON_SECRET bearer), and the budget rule.
7. Pending dates only include days that have live rows, so holidays no
   longer get an empty audit row from the scheduled path; the `?date=`
   override still archives an empty day and writes a `row_count = 0` audit
   row (keep that path).

Tests. Mock `../_lib/gexbot-archive-dates.js` (`listUnarchivedDates: vi.fn()`,
`GEXBOT_ARCHIVE_TABLES: ['gexbot_snapshots','gexbot_api_capture']`) so the
`mockSql` sequence is just pages + audit inserts. Control time with
`vi.spyOn(Date, 'now')` returning a scripted sequence, or `vi.useFakeTimers()` +
`vi.setSystemTime` advanced inside `mockWriteParquet`. Cover:
- happy path: helper returns `['2026-03-23']` for both tables → both archived,
  two audit inserts, `success`, `remainingDates: 0`, `stopReason: 'drained'`;
- backlog, budget stop: helper returns 3 dates; first date consumes 200 s →
  second not started; `stopReason: 'budget'`, `remainingDates: 2`,
  `status: 'success'`, logger.warn called once;
- backlog, all fast: 3 dates archived, `stopReason: 'drained'`;
- `MAX_DATES_PER_RUN`: 6 fast dates → 5 archived, `stopReason: 'max_dates'`, `remainingDates: 1`;
- half-archived day: snapshots pending `[]`, captures pending `['2026-03-23']`
  → one `writeRowsToParquet` call with the capture schema only;
- `?date=2026-03-20` → both tables archived for that date, helper not called;
- `?date=2026-3-2` (malformed) → 500, no Blob put;
- `listUnarchivedDates` rejects → 500, no Blob put (R4);
- one table throws on a date → `partial`, Sentry tagged with that date, other
  table still archived (adapt the existing test);
- Blob HEAD size mismatch → that table fails → `partial` (adapt);
- 401 without CRON_SECRET and 500 without BLOB token (keep).

Commit subject: `fix(gexbot): Archive every un-archived session oldest-first and accept ?date= for re-runs`

## Task 4: Gate cleanup at the first un-archived session

**Files:** `api/cron/cleanup-gexbot.ts`, `api/__tests__/cleanup-gexbot.test.ts`.
Depends on Task 2.

Replace the `MAX(archive_date)` logic in `cleanupOne`:
1. `const pending = await listUnarchivedDates(sql, table, today);` (ascending).
2. One SQL round-trip for the two dates as text:
   ```sql
   SELECT to_char(${today}::date - 1, 'YYYY-MM-DD') AS yesterday,
          to_char(${pending[0] ?? null}::date - 1, 'YYYY-MM-DD') AS gate
   ```
   (`gate` is NULL when nothing is pending.)
3. `cutoff = gate != null && gate < yesterday ? gate : yesterday`. Delete
   rows with `captured_at < (cutoff::date + 1)::timestamptz` in the existing
   50k batches within the existing wall budget.
4. With no audit rows at all, every live day is pending, the gate is the day
   before the first live day, and the DELETE touches nothing. Drop the
   `'no_archive'` stop reason and the `MAX(archive_date)` query. Drop the
   `Date`-object normalization (dates now arrive as text via `to_char`).
5. `PerTableResult` gains `gate: string | null` (first un-archived date, for
   the log line). `stopReason` becomes `'drained' | 'wall_budget'`.
6. Header comment: cutoff = `LEAST(yesterday_et, first_unarchived_session - 1)`;
   a missed archive day now stalls deletion at that day until it is
   archived, no matter how many later days succeed.

Tests (mock `../_lib/gexbot-archive-dates.js` as in Task 3):
- pending `[]`, yesterday `2026-03-23` → cutoff `2026-03-23` passed to the
  DELETE for each table;
- pending `['2026-09-08']`, yesterday `2026-10-01` → cutoff `2026-09-07`
  (assert the DELETE parameter);
- gate later than yesterday never raises the cutoff (pending `['2026-03-25']`,
  yesterday `2026-03-23` → cutoff `2026-03-23`);
- every live day pending → DELETE returns `[]`, `deleted: 0`, `stopReason: 'drained'`;
- wall_budget and drained paths (adapt existing);
- second table still processed when the first table's helper rejects
  (adapt "processes both tables even when the first table errors"; the
  handler must not report `success` for a table whose gate query failed —
  check how the current code surfaces per-table errors and keep that
  contract, adding a test that a rejected `listUnarchivedDates` is surfaced
  by name in the result or thrown);
- remove the `Date`-typed max_date test and the trailing-zero parse test if
  the code they exercised is gone (orphan cleanup), and say so in the report.

Commit subject: `fix(gexbot): Gate cleanup at the first un-archived session instead of the newest archive`

## Task 5: Sentry heartbeats for the archive and cleanup crons

**Files:** `api/_lib/cron-schedules.ts`.

Add two entries to `SCHEDULE_MAP` in the `withCronInstrumentation` section,
with schedules copied verbatim from `vercel.json` (the drift test
`api/__tests__/cron-schedules.test.ts` compares them character for character):
```ts
'archive-gexbot': {
  // Daily Parquet export; crashed at module load for four weeks in Sep–Oct
  // 2026 with no Sentry event because nothing ran. A missed check-in is
  // the only signal for that failure class. maxDuration is 300 s → long runner.
  schedule: '30 21 * * 2-6',
  checkinMargin: DEFAULT_MARGIN,
  maxRuntime: LONG_RUNNER_MAX_RUNTIME,
},
'cleanup-gexbot': {
  schedule: '15 12 * * 1-5',
  checkinMargin: DEFAULT_MARGIN,
  maxRuntime: LONG_RUNNER_MAX_RUNTIME,
},
```
`withCronInstrumentation` looks the entry up by job name
(`cron-instrumentation.ts` ~line 377), so no handler change is needed.
`npm run review` must pass (the drift test is the verification).

Commit subject: `feat(gexbot): Register Sentry heartbeats for the archive and cleanup crons`

## Task 6: Deploy, backfill, verify (controller-run, no subagent)

1. Cherry-pick the task commits onto `main` (after `git pull --ff-only`),
   push, confirm the production deployment reaches READY.
2. Backfill: call `GET https://<prod-domain>/api/cron/archive-gexbot` with
   `Authorization: Bearer $CRON_SECRET` (from `.env.local`, never echoed) in
   a loop until `metadata.remainingDates === 0`. Each call archives up to 5
   sessions within the 300 s budget.
3. Verify with read-only SQL: every UTC day 2026-09-08 → yesterday has an
   audit row for both tables whose `row_count` equals the live row count for
   that day. Read one archived Parquet back with `ParquetReader` (script in
   `docs/tmp/`) and confirm its row count matches the audit row.
4. Do **not** trigger cleanup manually. The Monday 12:15 UTC run deletes
   archived sessions through the new gate; report that to the owner and
   offer a manual trigger.

## Files summary

| Task | Create | Modify |
|---|---|---|
| 1 | `api/__tests__/gexbot-parquet-deps.test.ts` | `package.json`, `package-lock.json` |
| 2 | `api/_lib/gexbot-archive-dates.ts`, `api/__tests__/gexbot-archive-dates.test.ts` | — |
| 3 | — | `api/cron/archive-gexbot.ts`, `api/__tests__/archive-gexbot.test.ts` |
| 4 | — | `api/cron/cleanup-gexbot.ts`, `api/__tests__/cleanup-gexbot.test.ts` |
| 5 | — | `api/_lib/cron-schedules.ts` |

## Data dependencies

Existing tables only: `gexbot_snapshots`, `gexbot_api_capture`,
`gexbot_archive_audit`. No migration. Existing env: `BLOB_READ_WRITE_TOKEN`,
`CRON_SECRET`, `DATABASE_URL`.

## Thresholds and constants

| Name | Value | Where | Why |
|---|---|---|---|
| uuid override | `^11.1.1` | package.json | last CJS-compatible major |
| `MAX_DURATION_MS` | `config.maxDuration * 1000` (300 s) | archive | one source of truth |
| `NEXT_DATE_SAFETY_FACTOR` | 1.5 | archive | a day's duration varies with row count |
| `NEXT_DATE_MARGIN_MS` | 15 000 | archive | Blob HEAD + audit write after the last page |
| `MAX_DATES_PER_RUN` | 5 | archive | bounds memory/GC per invocation |
| cleanup `BATCH_SIZE` / `WALL_BUDGET_MS` | 50 000 / 295 000 | cleanup | unchanged |

## Open questions (defaults chosen)

- Backlog with zero failures reports `success` plus `remainingDates` in
  metadata and a warn log, not `partial`. Default: keep `partial` for real
  failures only, so the manual backfill does not raise alerts on every run.
- Holidays no longer get a `row_count = 0` audit row from the scheduled
  path. Default: accept; nothing reads those rows.
- Multi-window fetch crons (`fetch-gexbot-fast`, `fetch-gexbot-strikes`,
  `populate-periscope-from-gexbot`) still have no heartbeat because
  `SCHEDULE_MAP` carries one schedule per job. Out of scope here.
