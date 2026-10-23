# Axiom field-cap fix — planned 2026-10-04, executed 2026-10-23

## Goal

Stop cron-run events from creating one Axiom dataset column per metadata
key, make ingest rejections visible, and get `archive-gexbot` (and any cron
that adds a field in future) reporting to Axiom again without manual
dataset surgery.

## Background

- Production log, 2026-10-03: `Error: adding 'summaries' and 2 other fields
  to dataset fields would exceed the column limit of 257` from
  `reportCronRun` (api/_lib/axiom.ts). Axiom datasets cap at 257 fields.
- `reportCronRun(job, payload)` does `client.ingest(dataset, { job,
  ...payload })` with no sanitization. The wrapper
  (`api/_lib/cron-instrumentation.ts`, call sites at ~:729, ~:805, ~:846)
  spreads every cron's `result.metadata` into that payload, and 13 cron
  files call `reportCronRun` directly at 18 more sites. Across the repo that
  is ~213 distinct top-level keys before nested flattening, several nested
  objects keyed by ticker or expiry date (open-ended growth), and the same
  key name carrying different types in different crons.
- `@axiomhq/js` 1.6.1 catches HTTP errors inside `ingestRaw`, calls
  `onError` (default `console.error`), and resolves with `{ ingested: 0,
  failed: 0 }`. The `catch` in `reportCronRun` therefore never fires, and
  nothing reaches pino or Sentry. Rejections are silent.
- The HTTP response body built by the wrapper is a separate object and is
  NOT changed by this plan.
- No in-repo consumer queries Axiom fields. Code comments say external
  dashboards key on `error` and `message`; those stay top-level.

## Global constraints

- Work ONLY in worktree `F:\dev\strike-calculator\.worktrees\2026-10-04-axiom`
  (Git Bash `/f/dev/strike-calculator/.worktrees/2026-10-04-axiom`), branch
  `fix/2026-10-04-axiom`, fast-forwarded to `origin/main`. Do not touch the
  main checkout (it holds the owner's uncommitted work).
- `CI=true npm run review` must exit 0 in the worktree before each commit
  (CI=true skips one bundle-dependent parity test; expected).
- Commit subjects ≤ 70 characters, conventional type(scope), imperative;
  body ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
  Single-quote `-m` strings, no backticks.
- Style per CLAUDE.md: Prettier 2-space/single quotes/80 cols; SonarJS
  (`Number.parseInt`, `.at(-1)`, no nested template literals); `import type`;
  explicit `.js` on relative imports under `api/`.
- R1: any module-level state is bounded (cap + evict). R3: mock at the module
  boundary with `vi.mock`; no test-only seams or exports beyond the existing
  `_resetClient`. R4: every failure mode has a test asserting the surfacing by
  name. R7: no new env vars.
- `reportCronRun` must never throw or reject.

## Task 1: Bound Axiom event columns in `reportCronRun`

**Files:** `api/_lib/axiom.ts`, `api/__tests__/axiom.test.ts`.

Design (all inside `axiom.ts`; helper functions stay private):

1. Constants:
   ```ts
   /** Fields that may stay top-level. Every name here has been sent by many
    *  crons for months, so each already exists as a dataset column. The set
    *  is frozen: the dataset has a 257-field cap and hit it in Sep 2026.
    *  Everything else goes into `meta` as one JSON string. */
   const AXIOM_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
     'status', 'rows', 'message', 'error', 'durationMs',
     'stored', 'skipped', 'failed', 'reason', 'date', 'today', 'inserted', 'total',
   ]);
   /** Upper bound on the serialized `meta` string. */
   const MAX_META_CHARS = 16_000;
   /** Jobs whose rejection has already been sent to Sentry on this instance. */
   const SENTRY_DEDUPE_CAP = 200;
   ```
2. Event construction (`buildEvent(job, payload)` → `{ event, overflowKeys }`):
   - `event` starts as `{ job }`. A `job` key inside `payload` is ignored (the
     argument always wins; today a payload key could override it).
   - For each `[key, value]` of `payload`: skip `undefined`; if
     `AXIOM_TOP_LEVEL_KEYS.has(key)` AND the value is primitive (`string`,
     `number`, `boolean`, or `null`) → `event[key] = value`; otherwise →
     `overflow[key] = value` (this includes non-primitive values under an
     allowed name, e.g. `skipped: { a: 1 }`).
   - If `overflow` has any key: `event.meta = serializeMeta(overflow)`:
     `JSON.stringify(overflow)`; if the result is longer than `MAX_META_CHARS`
     → `JSON.stringify({ truncated: true, chars: <length>, keys: Object.keys(overflow) })`;
     if `JSON.stringify` throws (BigInt, circular) →
     `JSON.stringify({ unserializable: true, keys: Object.keys(overflow) })`.
   - No `meta` key when nothing overflowed.
3. Client: `new AxiomWithoutBatching({ token, onError: (err) =>
   logger.warn({ err }, 'axiom: ingest error') })` so the SDK's error text
   reaches pino instead of `console.error`.
4. Send with detection and fallback:
   ```ts
   const first = await client.ingest(dataset, event);
   if (first.ingested > 0) return;
   let retried = false;
   if (hasMeta) {
     const { meta: _dropped, ...envelope } = event;
     const second = await client.ingest(dataset, envelope);
     retried = true;
     logger.warn({ job, overflowKeys, retryIngested: second.ingested },
       'axiom: event rejected; retried without meta');
   } else {
     logger.warn({ job }, 'axiom: event rejected');
   }
   reportRejectionOnce(job, overflowKeys, retried);
   ```
   `reportRejectionOnce`: module-level `const reportedJobs = new Set<string>()`;
   if `reportedJobs.has(job)` return; if `reportedJobs.size >= SENTRY_DEDUPE_CAP`
   → `reportedJobs.clear()`; add; then
   `Sentry.captureMessage('Axiom rejected cron event', { level: 'warning',
   tags: { job, 'axiom.retried': String(retried) }, extra: { overflowKeys },
   fingerprint: ['axiom-ingest-rejected', job] })`. Import `Sentry` from
   `./sentry.js`. Document the cap/evict in a comment (R1).
5. Keep the outer `try/catch` → `logger.warn({ err }, 'axiom: reportCronRun
   failed')` for anything unexpected. Keep the no-op when token or dataset is
   missing. Keep `_resetClient` (also clear `reportedJobs` there so tests are
   isolated).
6. Header doc comment: the 257-field cap, the envelope + `meta` rule, that
   the HTTP response is unaffected, the APL hint
   `| extend m = parse_json(meta) | where m.stored > 0`, and that a rejected
   `meta` means the dataset is exactly at the cap and the owner should vacuum
   unused fields in Axiom.

Tests (`api/__tests__/axiom.test.ts`; `vi.mock('@axiomhq/js')` with a class
whose `ingest` is a `vi.fn()` resolving `{ ingested: 1, failed: 0 }` by
default; `vi.mock('../_lib/logger.js')`; `vi.mock('../_lib/sentry.js')`;
call `_resetClient()` in `beforeEach`; set `AXIOM_API_KEY`/`AXIOM_DATASET` in
`process.env`):

1. No-op without token or dataset (keep).
2. Envelope + allowed scalars stay top-level, everything else goes to
   `meta`: payload `{ status: 'success', rows: 10, failed: 0,
   dates: ['2026-09-08'], summaries: [{ table: 't', rowCount: 1 }],
   remainingDates: 0, stopReason: 'drained', durationMs: 5 }` →
   `ingest(DATASET, { job, status: 'success', rows: 10, failed: 0,
   durationMs: 5, meta: '{"dates":["2026-09-08"],"summaries":[{"table":"t","rowCount":1}],"remainingDates":0,"stopReason":"drained"}' })`
   asserted with `toHaveBeenCalledWith` (exact object; key order inside
   `meta` follows payload insertion order).
3. Non-primitive under an allowed name (`skipped: { a: 1 }`, `date: ['x']`)
   goes to `meta`, not top-level.
4. `undefined` values are dropped; `null` under an allowed name stays
   top-level.
5. A payload `job` key cannot override the `job` argument.
6. `meta` longer than `MAX_META_CHARS` becomes the truncation marker
   (`truncated: true`, `chars`, `keys`); assert the marker and that the
   serialized `meta` is short.
7. An unserializable value (a `BigInt`, or a circular object) becomes the
   `unserializable` marker; no throw.
8. No `meta` key when nothing overflows.
9. Rejection with `meta` (`ingest` resolves `{ ingested: 0, failed: 0 }`
   twice): a second `ingest` call is made with the same object minus
   `meta`; `logger.warn` called with `{ job, overflowKeys, … }` and the
   message `'axiom: event rejected; retried without meta'`;
   `Sentry.captureMessage` called once with `tags.job` and the fingerprint.
10. Second rejection for the same job on the same instance → still retried,
    `logger.warn` again, but `Sentry.captureMessage` NOT called again.
11. Rejection without `meta` → no retry, `logger.warn('axiom: event
    rejected')`, Sentry once.
12. `ingest` rejects (promise rejection) → swallowed, `logger.warn({ err },
    'axiom: reportCronRun failed')`, function resolves.
13. Client constructed with `{ token, onError: expect.any(Function) }`; calling
    the captured `onError(new Error('x'))` logs `logger.warn({ err }, 'axiom:
    ingest error')`.
14. Dedupe set cap: after rejections for `SENTRY_DEDUPE_CAP` distinct jobs, a
    repeat of the first job reports to Sentry again (set was cleared).

Commit subject: `fix(axiom): Bound cron event columns with a single meta field`

## Task 2: Document the rule and the env vars

**Files:** `CLAUDE.md`.

1. Environment Variables table: add two rows after `GUEST_ACCESS_KEYS`:
   `AXIOM_API_KEY` | Axiom (opt.; cron-run events) and
   `AXIOM_DATASET` | Axiom dataset name (opt.). Both are read in
   `api/_lib/env.ts` and listed in `.env.example` already; only the table
   was missing them (R7).
2. Backend Key Patterns: add a bullet after the Sentry bullet:
   "**Axiom cron events** — `reportCronRun` keeps a frozen set of top-level
   fields (`job`, `status`, `rows`, `message`, `error`, `durationMs`,
   `stored`, `skipped`, `failed`, `reason`, `date`, `today`, `inserted`,
   `total`) and JSON-stringifies every other key into one `meta` string. The
   dataset has a 257-column cap and hit it in Sep 2026, so never add
   top-level keys. Query per-cron fields with `parse_json(meta)`. A rejected
   ingest retries without `meta` and raises one Sentry warning per job per
   instance."

Commit subject: `docs(claude): Document Axiom env vars and the meta field rule`

## Task 3: Ship and verify (controller-run)

1. Push the branch as a fast-forward of `origin/main`:
   `git push origin fix/2026-10-04-axiom:main` from the worktree. The local
   `main` checkout holds the owner's uncommitted `package.json`/lockfile edits,
   so it is not pulled or merged.
2. Confirm the production deployment reaches READY and that a cron run after
   the deploy logs no `axiom: event rejected` warning (Vercel runtime logs),
   or logs one that names the job if the dataset is exactly at the cap.
3. Report the dashboard caveat: per-cron scalar columns outside the frozen
   set stop updating; the data is in `meta`.

## Files summary

| Task | Modify |
|---|---|
| 1 | `api/_lib/axiom.ts`, `api/__tests__/axiom.test.ts` |
| 2 | `CLAUDE.md` |

## Data dependencies

None. Existing env: `AXIOM_API_KEY`, `AXIOM_DATASET`.

## Thresholds and constants

| Name | Value | Why |
|---|---|---|
| `AXIOM_TOP_LEVEL_KEYS` | 13 names above | existing columns; frozen |
| `MAX_META_CHARS` | 16 000 | bounds event size; `perTicker` maps can be large |
| `SENTRY_DEDUPE_CAP` | 200 | > number of cron jobs (~74); R1 bound |

## Open questions (defaults chosen)

- Dashboards or monitors keyed on per-cron scalar columns outside the frozen
  set (e.g. `feedStale`, `zgNullAllPct`, `ratio`) will stop updating; the
  values move into `meta`. Default: accept and disclose; the owner can
  rewrite those queries with `parse_json(meta)` or extend the frozen set
  deliberately.
- If the dataset is exactly at 257 fields, even `meta` is rejected; the
  envelope still lands and Sentry warns once per job. The owner then vacuums
  unused fields in Axiom (one action in the dataset settings). The live
  field list could not be read from this session: the API token needs an
  org-id header that is not in `.env.local`.
- `archiveDate` → `dates` (the earlier follow-up) is subsumed: both live in
  `meta` now; saved queries use `parse_json(meta).dates`.
