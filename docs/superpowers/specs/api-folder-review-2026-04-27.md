# `api/` Folder Review — 2026-04-27

## Goal

Document the findings from a four-reviewer audit of `api/` (TypeScript +
Node best practices + cron handler patterns + handler quality + refactor
opportunities), and translate the findings into a phased, independently
shippable execution plan. Outcome: one durable scope reference for the
HIGH-severity bugs, the auth/cookie redesign, the helper-adoption sweep,
and the file-split work — none of which should be done in a single sitting.

## Background

Audit run on 2026-04-27 dispatched four parallel reviewers across:

1. `api/_lib/` — 80+ shared modules (TS + Node best practices)
2. `api/cron/` — ~50 scheduled jobs (CRON_SECRET, idempotency, silent
   failure, market-hours gating)
3. Top-level `api/*.ts` handlers + `api/auth/`, `api/journal/`, `api/ml/`
   (auth gaps, validation, response shape, bot protection)
4. Cross-cutting refactor opportunities (duplication, dead code,
   abstraction)

Independent reviewers converged on the same root causes — that
convergence is the signal. Four cross-cutting themes:

- **Untyped network JSON.** `uwFetch<T>()`, `schwabFetch`, FRED,
  Anthropic, sidecar — all `await res.json()` and cast directly into
  typed interfaces with no Zod parse. UW silently renames a field →
  NULL columns land in Postgres → no alert.
- **Silent partial-failure → green dashboard.** Recurring shape:
  `try/catch` returns `{ stored: 0, skipped: N }`, caller writes
  `status: 'ok'` to Axiom, returns 200. Real Postgres / API outages
  land silently. Hits `backup-tables`, `enrich-vega-spike-returns`,
  `fetch-net-flow`, `fetch-vol-0dte`, `fetch-strike-exposure`,
  `fetch-strike-all`, `fetch-spx-candles-1m`.
- **Helpers exist, adoption is ~30 %.** `guardOwnerOrGuestEndpoint`
  used in 9, inlined in 41. `respondIfInvalid` used in 6, inlined in
  ~15. `uwFetch` bypassed in 5+ direct fetches. `getETDateStr` used in
  27, inlined in ~17.
- **Auth design carries one real risk + several leaks.**
  `OWNER_SECRET` is the cookie value — same on every device, no
  per-session token, no revocation. Six production endpoints skip
  `checkBot(req)` (including `alerts-ack` which mutates state).

---

## HIGH severity findings (real bugs / security)

| #   | File:line                                                                                                                                                           | Issue                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `api/auth/callback.ts:88`                                                                                                                                           | `OWNER_SECRET` set verbatim as `sc-owner` cookie. No per-session token, no server-side revocation.                                                                                                                                                                |
| H2  | `api/_lib/lessons.ts:131`                                                                                                                                           | `sql.unsafe(whereClause)` interpolates `regimeZone`/`structure`/`dayOfWeek` from a request body whose schema is `z.record(z.string(), z.unknown())`. Only hand-rolled SQL path in the module.                                                                     |
| H3  | `api/_lib/api-helpers.ts:370-383`                                                                                                                                   | `schwabApiFetch` retry loop uses `res!.ok`/`res!.text()` after the loop; `AbortSignal.timeout` throws inside `fetch` and `res` stays `undefined` → `TypeError` instead of intended 502.                                                                           |
| H4  | `alerts.ts:30`, `alerts-ack.ts`, `darkpool-levels.ts`, `gex-per-strike.ts`, `vega-spikes.ts`, `vix-snapshots-recent.ts`                                             | Missing `checkBot(req)`. `alerts-ack` is the worst — it mutates state.                                                                                                                                                                                            |
| H5  | `institutional-program.ts:228`, `institutional-program/strike-heatmap.ts:94`, `options-flow/top-strikes.ts:357`, `journal/init.ts:53`, `journal/migrate.ts:48`      | Stack traces / Postgres error messages leaked to clients. Outliers — every other handler returns generic message + Sentry.                                                                                                                                        |
| H6  | `cron/backup-tables.ts:26-43`                                                                                                                                       | Hardcoded 16-table backup list; codebase has 40+ tables. Newer tables (`greek_exposure_strike`, `dark_pool_levels`, `vega_spike_events`, `iv_anomalies`, `strike_iv_snapshots`, `day_embeddings`, `zero_gamma_levels`, `futures_bars`) silently aren't backed up. |
| H7  | `cron/backup-tables.ts:157-166`, `enrich-vega-spike-returns.ts:210-217`, `auto-prefill-premarket.ts:136-145`                                                        | `reportCronRun({ status: 'ok' })` hardcoded regardless of `errors.length`.                                                                                                                                                                                        |
| H8  | `cron/fetch-net-flow.ts:175-184`, `fetch-vol-0dte.ts:182-185`, `fetch-strike-exposure.ts:153-157`, `fetch-strike-all.ts:134-138`, `fetch-spx-candles-1m.ts:210-214` | Per-source failure swallowed → returns 200 with `success: true`.                                                                                                                                                                                                  |
| H9  | `cron/fetch-greek-exposure.ts:87-92`                                                                                                                                | UPSERT only refreshes `call_gamma`/`put_gamma`; charm/delta/vanna columns never refresh after first run of the day.                                                                                                                                               |
| H10 | `cron/fetch-strike-trade-volume.ts:160-183`, `fetch-strike-iv.ts:449-465`                                                                                           | INSERT without `ON CONFLICT` — duplicate rows on retry, or throws on unique constraint. Idempotency story missing.                                                                                                                                                |
| H11 | `cron/fetch-day-ohlc.ts:80`, `cron/refresh-vix1d.ts:112`                                                                                                            | Bare `fetch(url)` with no `AbortSignal.timeout` — a hung upstream blocks the cron until Vercel's hard kill.                                                                                                                                                       |

## MED severity findings (selective)

### Type safety / validation

- `validation.ts:443,447` — `AnalyzeBody.context` is `z.record(z.string(), z.unknown())`; loose schema feeds into log lines, prompt-injection, and (via H2) SQL.
- `analyze.ts:267-285` — when `analysisResponseSchema.safeParse` fails, code casts unvalidated `parsed` as `AnalysisResponse` instead of returning 502. **Note 2026-04-27:** attempted in Tier-2 sweep, reverted — `SAMPLE_ANALYSIS` test fixture is significantly out of date vs the current schema (missing `chartConfidence`, `strikeGuidance`, `managementRules`, `entryPlan`; uses an old `mode` enum). Fix requires refreshing 14 test cases with schema-conformant fixtures — own phase.
- `journal.ts:57`, `ml/export.ts:60-62`, `events.ts:475` — `Number(req.query.X) || default` accepts NaN silently. Migrate holdouts to Zod.
- 8 sites use `x!` non-null assertions on values from `String.split` / regex match (`csv-parser.ts:107-191`, `api-helpers.ts:370-383`, `analyze-context-helpers.ts:44-48`).

### Performance

- `cron/fetch-flow-alerts.ts:141-169`, `fetch-whale-alerts.ts`, `fetch-greek-flow-etf.ts:67-95`, `fetch-etf-candles-1m.ts:61-84` — sequential per-row `await sql\`INSERT…\``over up to 1000 rows. Wrap in`sql.transaction(rows.map(...))`.
- `cron/build-features.ts:913-937` — sequential per-date loop with 120 s statement timeout; one bad date can starve the run.
- `iv-anomalies.ts:316`, `system-status.ts:101-109` — N parallel queries per request (system-status polls every 15 s).

### Schwab / auth

- `_lib/schwab.ts:178` — `acquireLock` returns `true` (fail-open) after Redis errors; two parallel refresh paths consume single-use refresh token simultaneously.
- `_lib/schwab.ts:114-130` — `storeTokens` swallows persistent Redis failure; new token in-memory only, lost on cold start.
- `api-helpers.ts:639` (`cronGuard`) and `ml/analyze-plots.ts:265-272` — `timingSafeEqual` short-circuits on length mismatch, leaking expected-secret length via timing.

### Other

- `journal/status.ts:42-46` — exposes whole schema to guest cookies via `pg_stat_user_tables`.
- `journal/backfill-features.ts:52-60` — fakes a sub-request via spread-cast that inherits POST `req.body` and forwards `Authorization` to telemetry.
- `ml/trigger-analyze.ts:41` — fire-and-forget self-fetch; user gets 202 but background may fail silently.

## Oversized files worth splitting

| File                               | LOC                                        | Why split now                                                                                                           |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `_lib/analyze-prompts.ts`          | 1,563 / 174 KB                             | 3× over project's 500 LOC bar. Split into `system`/`rules`/`charts`. Cache_control still works on concatenated prefix.  |
| `_lib/db-migrations.ts`            | 2,600                                      | Adding migration #95 means scrolling 2,600 lines. Split into `001-030`/`031-060`/`061-094`, re-export.                  |
| `_lib/analyze-calibration.ts`      | 1,029 / 79 KB                              | Most is JSON-as-`String.raw`. Move to `.json` files + `import('./calib.json', { with: { type: 'json' } })`.             |
| `api/positions.ts`                 | 605                                        | Mixes Schwab DTOs, `groupIntoSpreads`, `buildSummary`, dual GET/POST. Split spread logic to `_lib/positions-spread.ts`. |
| `api/gex-target-history.ts`        | 690                                        | Row mapping interleaved with handler. Extract to `_lib/gex-target-history-rows.ts`.                                     |
| `api/iv-anomalies-cross-asset.ts`  | 508                                        | Same — extract row mapping + helpers.                                                                                   |
| `_lib/analyze-context-fetchers.ts` | 1,029 (16 catch-and-return-empty handlers) | Split per data domain (gex/flow/iv/cross-asset).                                                                        |
| `_lib/csv-parser.ts`               | 1,002                                      | Mixes lexing / sections / spreads / dates — five responsibilities.                                                      |

## Refactor opportunities (highest ROI first)

1. **Adopt `guardOwnerOrGuestEndpoint` in 41 handlers** — already shipped in `_lib/`, only 9 use it. Removes ~500 LOC of duplicated `checkBot → 403 / rejectIfNotOwner → 401` chains, ends drift in 401 response shape.
2. **Add Zod schemas to `uwFetch<T>(apiKey, path, schema?)`** — fixes the untyped-JSON theme, blocks silent UW schema drift. Adopt per-endpoint over time.
3. **Add `runCron(jobName, body)` wrapper** — collapses the 35-cron `catch { Sentry.setTag + captureException + logger.error + 500 }` tail; folds in `metrics.request` so cron latency joins the same Sentry dashboard as handlers.
4. **Replace inline 400 boilerplate with `respondIfInvalid`** — 15 handlers, three different error shapes; helper is canonical. Frontend currently has to handle three formats.
5. **Convert 5 direct UW `fetch()` sites to `uwFetch()`** — `spx-candles.ts`, `iv-term-structure.ts`, `_lib/max-pain.ts`, `darkpool.ts` (2), `build-features-phase2.ts`. Real observability gap: those sites bypass UW 429 metric.

---

## Phases

Each phase is independently shippable, ≤5 files (or one mechanical
sweep), with explicit verification. Ordered by risk × user-impact / cost:
real bugs first, then helper adoption, then schema validation, then file
splits. Auth-cookie redesign (H1) is its own phase because it has
non-trivial blast radius.

### Phase 1 — Bug-only sweep, no architecture changes

Scope: HIGH findings H2, H3, H6, H7, H8, H9, H10, H11. Each is small
and isolated.

- `api/_lib/lessons.ts` — replace `sql.unsafe(whereClause)` with a
  fixed parameterized query (COALESCE/IS NULL on each filter, or
  whitelist values against an enum).
- `api/_lib/api-helpers.ts` — wrap `schwabApiFetch` `await fetch(...)`
  in try/catch; on timeout/abort throw or return synthesized 502
  result instead of relying on `res!`.
- `api/cron/backup-tables.ts` — derive `TABLES` list from
  `information_schema.tables` (or `schema_migrations`); set
  `status: errors.length > 0 ? 'partial' : 'ok'`.
- `api/cron/enrich-vega-spike-returns.ts`,
  `api/cron/auto-prefill-premarket.ts` — derive cron status from
  `errors.length`.
- `api/cron/fetch-net-flow.ts`, `fetch-vol-0dte.ts`,
  `fetch-strike-exposure.ts`, `fetch-strike-all.ts`,
  `fetch-spx-candles-1m.ts` — surface per-source failure as
  `partial: true`, return 500 if all sources fail.
- `api/cron/fetch-greek-exposure.ts` — widen `DO UPDATE SET` to all
  eight Greek columns (or change to `DO NOTHING` + comment why).
- `api/cron/fetch-strike-trade-volume.ts`, `fetch-strike-iv.ts` — add
  `ON CONFLICT (...) DO NOTHING` (or document the intended behavior).
- `api/cron/fetch-day-ohlc.ts`, `cron/refresh-vix1d.ts` — wrap
  `fetch()` in `AbortSignal.timeout(15_000)`; treat abort as a clean
  skip.

**Verify:** `npm run review` green. Run each touched cron locally
against staging Postgres (not prod) to confirm the partial-failure
path emits `status: 'partial'`.

### Phase 2 — Bot protection + leaked-error sweep

Scope: H4 + H5.

- Add `checkBot(req)` to `alerts.ts`, `alerts-ack.ts`,
  `darkpool-levels.ts`, `gex-per-strike.ts`, `vega-spikes.ts`,
  `vix-snapshots-recent.ts`. Confirm each path is in the
  `protect` array in `src/main.tsx`.
- Replace `error: String(err)` / `message: err.message` patterns in
  `institutional-program.ts:228`, `institutional-program/strike-heatmap.ts:94`,
  `options-flow/top-strikes.ts:357`, `journal/init.ts:53`,
  `journal/migrate.ts:48` with `'Internal error'` + `Sentry.captureException(err)`.

**Verify:** `npm run review` green. Hit each previously-uncovered
endpoint with no auth from a non-residential IP — expect BotID 403.

### Phase 3 — Adopt `guardOwnerOrGuestEndpoint` in 41 handlers

Scope: refactor #1. Mechanical, high ROI. Single helper swap per file.

- For each handler in the duplicated-pattern list, replace the
  `checkBot → 403 / rejectIfNotOwnerOrGuest → 401` chain with
  `if (await guardOwnerOrGuestEndpoint(req, res, done)) return;`.
- Leaves `auth/guest-key.ts` and `auth/guest-logout.ts` alone — they
  need `buildGuestSetCookies` etc. that aren't re-exported.
- Migrate handlers to import from `api-helpers.js` rather than
  `guest-auth.js` directly (refactor item #9 in the audit).

Files: ~41 handlers. Cap each PR at ~10 files for review-ability.

**Verify:** `npm run review` green. Sample 3 endpoints (one
owner-only, one owner-or-guest, one POST-mutating) and confirm 401 /
403 / 200 paths still match the existing `auth.test.ts` fixtures.

### Phase 4 — Adopt `respondIfInvalid` in inline 400 sites

Scope: refactor #4. ~15 handlers. Standardizes 400 response shape to
`{ error: firstError.message }`.

Files: `strike-trade-volume.ts`, `zero-gamma.ts`, `alerts-ack.ts`,
`market-internals/history.ts`, `push/subscribe.ts`,
`push/recent-events.ts`, `spot-gex-history.ts`, `movers.ts`,
`iv-anomalies.ts`, `iv-anomalies-cross-asset.ts`,
`max-pain-current.ts`, `futures/snapshot.ts`, plus ~3 more.

**Verify:** `npm run review` green. Frontend touch — confirm any
component that reads 400 responses (analyze flow, positions upload)
handles the canonical `{error}` shape; inventory of three-shape
handling can be deleted.

### Phase 5 — `uwFetch` schema adoption (gradual)

Scope: refactor #2. One UW endpoint at a time, lowest-risk first.

- Extend `uwFetch` signature: `uwFetch<T>(apiKey, path, opts?: { schema?: ZodType<T[]>, extract?: (body) => T[] })`.
- Define schemas in `api/_lib/uw-schemas.ts` (new file) — one per
  endpoint family: `flow-alerts`, `whale-alerts`, `greek-exposure`,
  `dark-pool`, `oi-change`, `vol-surface`, etc.
- For each cron / handler that uses `uwFetch`, add the schema arg.
  On parse failure, log a structured warning + Sentry metric and
  return empty (graceful degradation), or throw if the data is
  load-bearing (cron decides per-endpoint).
- Convert the 5 direct `fetch()` sites (refactor #5) to `uwFetch`
  in this phase: `spx-candles.ts`, `iv-term-structure.ts`,
  `_lib/max-pain.ts`, `darkpool.ts` (2 sites),
  `build-features-phase2.ts`.

**Verify:** `npm run review` green. After deploying a schema-adopted
endpoint, check Sentry for the new `uw.schema.parse_failure` metric
— should be zero in steady state. A non-zero count is the canary
for UW silently changing a field.

### Phase 6 — `runCron` wrapper + cron-status helper

Scope: refactor #3 + theme-#2 status helper.

- Add `runCron(jobName, body)` to `api/_lib/api-helpers.ts`. Folds
  in `cronGuard`, top-level try/catch, `Sentry.setTag('cron.job', jobName)`,
  `metrics.request('/api/cron/<jobName>')`, structured 500 response.
- Add `reportCronStatus({ ok, errors, partial })` helper in
  `_lib/axiom.ts` that derives `status: 'ok' | 'partial' | 'error'`
  from the failure count; replace 35 hand-rolled `reportCronRun`
  calls.
- Migrate cron handlers one-by-one (or in a sweep). Each handler's
  catch-tail collapses from ~15 LOC to a one-liner export.

**Verify:** `npm run review` green. After deploying, cron latency
distribution shows up in the Sentry transactions dashboard
(previously empty for cron paths).

### Phase 7 — File splits

Scope: oversized files. Each is its own commit; do them when the
file is otherwise quiet (no concurrent work).

- `_lib/analyze-prompts.ts` → `analyze-prompt-system.ts` +
  `analyze-prompt-rules.ts` + `analyze-prompt-charts.ts`. Re-export
  joined string from `analyze-prompts.ts` so cache_control prefix
  stays identical.
- `_lib/db-migrations.ts` → `db-migrations-001-030.ts` +
  `db-migrations-031-060.ts` + `db-migrations-061-094.ts`,
  re-exported from `db-migrations.ts` (preserves the
  `migrateDb()` contract).
- `_lib/analyze-calibration.ts` — move `*_RAW` constants to
  `analyze-calibration/*.json` and import with
  `{ with: { type: 'json' } }`.
- `api/positions.ts` — extract `groupIntoSpreads`, `buildSummary`,
  `Spread`, `isExpiringToday` to `_lib/positions-spread.ts`.
  Move Schwab DTOs to `_lib/schwab-types.ts`.
- `api/gex-target-history.ts` — extract row mapping +
  interfaces to `_lib/gex-target-history-rows.ts`.
- `api/iv-anomalies-cross-asset.ts` — extract row mapping +
  helpers to `_lib/anomaly-cross-asset-rows.ts`.
- `_lib/analyze-context-fetchers.ts` — split per data domain
  (`fetchers-gex.ts`, `fetchers-flow.ts`, `fetchers-iv.ts`,
  `fetchers-cross-asset.ts`).
- `_lib/csv-parser.ts` — split into `csv-parser/lexer.ts`,
  `csv-parser/sections.ts`, `csv-parser/spreads.ts`,
  `csv-parser/dates.ts`.

**Verify per file:** `npm run review` green. Diff the public
re-export surface — no consumer should need to update imports.

### Phase 8 — Auth cookie redesign (H1) — separate effort

Scope: replace static `OWNER_SECRET`-as-cookie with random per-session
token stored in Redis. Closes H1 + several lower-severity findings
(callback HTML escaping, leaked 401 `code` discriminator).

This phase is intentionally last and intentionally scoped to itself —
it changes auth semantics for every existing browser session and
warrants a deliberate design pass before code.

Pre-work for this phase:

- Decide token TTL (current cookie is `OWNER_COOKIE_MAX_AGE`).
- Decide revocation UX (admin-only DELETE endpoint? or just bump a
  rotation counter?).
- Decide migration: brief overlap window where both cookies are
  accepted, or hard cutover at deploy?
- Audit the OAuth `state` binding side (`api/auth/init.ts:34`) — H1
  deferred this; address as part of the redesign.

Files (provisional):

- `api/_lib/owner-session.ts` — new module: `createSession()`,
  `verifySession()`, `revokeSession()`, Redis-backed.
- `api/auth/callback.ts` — issue session token instead of
  `OWNER_SECRET`; verify state was issued for the exact redirect.
- `api/_lib/api-helpers.ts` — `rejectIfNotOwner` and
  `rejectIfNotOwnerOrGuest` validate against new session table.
- `src/utils/auth.ts` — frontend cookie inspection updated for
  new format (if any).

**Verify:** `npm run review` green. Manual test: log in fresh, hit
owner-only endpoint, log out, confirm token is invalid in Redis,
confirm guest keys still work independently.

---

## Files to create / modify (by phase)

### Phase 1

- Modify: `api/_lib/lessons.ts`, `api/_lib/api-helpers.ts`,
  `api/cron/backup-tables.ts`, `api/cron/enrich-vega-spike-returns.ts`,
  `api/cron/auto-prefill-premarket.ts`, `api/cron/fetch-net-flow.ts`,
  `api/cron/fetch-vol-0dte.ts`, `api/cron/fetch-strike-exposure.ts`,
  `api/cron/fetch-strike-all.ts`, `api/cron/fetch-spx-candles-1m.ts`,
  `api/cron/fetch-greek-exposure.ts`, `api/cron/fetch-strike-trade-volume.ts`,
  `api/cron/fetch-strike-iv.ts`, `api/cron/fetch-day-ohlc.ts`,
  `api/cron/refresh-vix1d.ts`.

### Phase 2

- Modify: `api/alerts.ts`, `api/alerts-ack.ts`, `api/darkpool-levels.ts`,
  `api/gex-per-strike.ts`, `api/vega-spikes.ts`,
  `api/vix-snapshots-recent.ts`, `src/main.tsx` (botid `protect` array),
  `api/institutional-program.ts`, `api/institutional-program/strike-heatmap.ts`,
  `api/options-flow/top-strikes.ts`, `api/journal/init.ts`,
  `api/journal/migrate.ts`.

### Phase 3

- Modify: ~41 handlers (full list in audit themes section). Cap each
  PR at ~10 files.

### Phase 4

- Modify: ~15 handlers (`strike-trade-volume.ts`, `zero-gamma.ts`,
  `alerts-ack.ts`, `market-internals/history.ts`, `push/subscribe.ts`,
  `push/recent-events.ts`, `spot-gex-history.ts`, `movers.ts`,
  `iv-anomalies.ts`, `iv-anomalies-cross-asset.ts`,
  `max-pain-current.ts`, `futures/snapshot.ts`, plus ~3 more).

### Phase 5

- Create: `api/_lib/uw-schemas.ts`.
- Modify: `api/_lib/api-helpers.ts` (extend `uwFetch` signature),
  every cron / handler that calls `uwFetch` (gradual), the 5
  direct-`fetch` sites listed in refactor #5.

### Phase 6

- Modify: `api/_lib/api-helpers.ts` (add `runCron`),
  `api/_lib/axiom.ts` (add `reportCronStatus`), 35 cron handlers
  (gradual migration).

### Phase 7

- File splits as listed above.

### Phase 8

- Create: `api/_lib/owner-session.ts`.
- Modify: `api/auth/callback.ts`, `api/auth/init.ts`,
  `api/_lib/api-helpers.ts`, `api/_lib/guest-auth.ts`,
  `src/utils/auth.ts`.
- DB migration: new `owner_sessions` table (or Redis key prefix —
  decide in phase pre-work).

---

## Data dependencies

- No new env vars required for Phases 1–7.
- Phase 5 (Zod schemas) doesn't touch DB.
- Phase 8 (auth redesign) needs either a new Redis key prefix
  (`owner:session:<token>`) or a new `owner_sessions` Postgres
  table — decide as part of phase pre-work.
- Phase 6 expects `metrics.request()` to already exist — confirmed
  in `api/_lib/sentry.ts`.

## Open questions

- **OWNER_SECRET cookie migration (Phase 8):** hard cutover or
  overlap window? Default pick: 7-day overlap where both formats
  validate, then drop the static-secret path.
- **`uwFetch` schema-failure policy (Phase 5):** parse failure ⇒
  empty array (graceful) or throw (loud)? Default pick: graceful
  for analyze-context fetchers (LLM prompt degradation is fine),
  throw for crons that write to DB.
- **`runCron` wrapper signature (Phase 6):** does it own the
  Express-style `(req, res)` or take the inner thunk? Default
  pick: take the thunk, return a handler. Lets cron handlers
  expose a pure async function for tests.
- **Backup-tables list source (Phase 1, H6):** derive at runtime
  from `information_schema` (always current, but adds a query) or
  from `schema_migrations` (cached, but you have to maintain a
  migration → table-name mapping)? Default pick: `information_schema`
  filtered to the public schema; the cost is one extra query per
  daily backup run.

## Thresholds / constants

- Phase 1 fetch timeouts: **15 s** for sidecar / CBOE direct
  fetches (matches existing `TIMEOUTS.UW_API` order of magnitude).
- Phase 5 UW schema parse failure metric: `uw.schema.parse_failure`
  — tagged with `endpoint: <path>`, `field: <missing>` when known.
- Phase 6 `reportCronStatus` partial threshold: `'partial'` if
  `errors.length > 0 && successes > 0`; `'error'` if all sources
  failed; `'ok'` if no errors.
- Phase 8 session token: 32-byte random base64url, Redis TTL =
  current `OWNER_COOKIE_MAX_AGE`.

---

## Suggested sequencing

- **Now:** Phase 1 (bug sweep) + Phase 2 (bot protection / leaked
  errors). Each is small and shippable in one session.
- **Next 1–2 weeks:** Phase 3 (helper adoption) + Phase 4 (validation
  helper). Mechanical, removes ~600 LOC.
- **Following 2–4 weeks:** Phase 5 (uwFetch schemas) and Phase 6
  (runCron wrapper). These are gradual — adopt per-endpoint /
  per-cron at whatever pace.
- **When the file is quiet:** Phase 7 file splits. One file per
  commit.
- **Deliberate / scheduled:** Phase 8 auth redesign. Don't squeeze
  this into a sweep.

Phases 1, 2, 4, 7 are bounded — they finish. Phases 3, 5, 6 are
gradual — they're done when every eligible handler is migrated, and
that's measured in months, not days.
