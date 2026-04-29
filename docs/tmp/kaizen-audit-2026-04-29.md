# Kaizen Audit — 2026-04-29

**Scope:** ~50 src components + 21 api/\_lib modules + 48 cron handlers + 412 test files + all infra config.
**Method:** 5 parallel domain agents, each applying the four Kaizen pillars (Continuous Improvement, Poka-Yoke, Standardized Work, Just-In-Time). Load-bearing security claims spot-verified against source.

---

## 1. Highest-Leverage Compounding Wins

Land these 5 once, and dozens of downstream findings dissolve.

| #     | Win                                                                                                                                                                   | Touches                                                                    | Why it compounds                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **`runCron(name, fn)` wrapper** in [api-helpers.ts](../../api/_lib/api-helpers.ts) — owns try/catch + Sentry tagging + `reportCronRun` + mandatory `cronJitter`       | 35+ cron handlers                                                          | Drops ~7 boilerplate lines/file; closes 8 silent-failure modes from missing jitter and 12 from missing `reportCronRun` in one move |
| **B** | **`withSentryHandler('METHOD /path', fn)` wrapper**                                                                                                                   | ~26 endpoints currently skip `Sentry.withIsolationScope`                   | Concurrent invocations stop bleeding tags across each other; new endpoints inherit it for free                                     |
| **C** | **Consolidate env reads through [env.ts](../../api/_lib/env.ts)** — extend schema to cover TWILIO*\*, VAPID*\*, GUEST_ACCESS_KEYS, BLOB_READ_WRITE_TOKEN, SIDECAR_URL | 18+ direct `process.env.X` reads in `_lib/`                                | Missing config fails at startup, not at first cron-fire at 14:31 UTC                                                               |
| **D** | **Land [uw-result.ts](../../api/_lib/uw-result.ts) `Result<T, reason>` type** (file is 566 bytes — abandoned half-build) and migrate `uwFetch`                        | All UW callers across crons + analyze                                      | Today: empty array means "no data" OR "we silently dropped malformed response" — indistinguishable                                 |
| **E** | **`mockInfra()` test helper** in [api/**tests**/helpers.ts](../../api/__tests__/helpers.ts)                                                                           | 100+ test files re-declare `vi.mock('../_lib/sentry.js')` + logger + redis | Standardizes the dominant pattern, makes drift impossible                                                                          |

---

## 2. CRITICAL Findings

Real bugs, security gaps, write-bad-data risks.

### Backend

- **[api/\_lib/lessons.ts:113-131](../../api/_lib/lessons.ts) — SQL injection via `sql.unsafe`.** `getHistoricalWinRate` interpolates `gexRegime`/`structure`/`dayOfWeek` directly into a string then runs through `sql.unsafe(whereClause)`. Inputs are currently server-side, but this is a textbook poka-yoke failure waiting on the first user-driven caller.
  _Fix:_ rebuild as composed ` sql` `` fragments, or hard enum-validate inputs before substring use.

- **[api/analyze.ts:282-285](../../api/analyze.ts) — Zod validation bypass on Claude response.** When schema validation fails, the handler silently falls back to the unvalidated raw object and persists it to `analyses`. The schema exists exactly to keep malformed payloads out of Postgres.
  _Fix:_ either return 502 (parallel to `stream_corruption` path) or persist with a `validation_failed=true` column for triage; never return the raw object to the client.

- **[api/\_lib/schwab.ts:191-204](../../api/_lib/schwab.ts) — `waitForLockRelease` swallows error vs timeout.** Exits silently on Redis errors and on TTL exhaustion without distinguishing them. Caller proceeds to read potentially-stale tokens.
  _Fix:_ return `'released' | 'timeout' | 'redis_error'`; on `timeout`/`redis_error` skip the optimistic stored-token re-read.

### Crons

- **[api/cron/fetch-strike-iv.ts](../../api/cron/fetch-strike-iv.ts) — Largest cron in the codebase has no `withRetry`, no `cronJitter`, no `reportCronRun`.** 37 KB, 13 tickers × per-minute. A single Schwab 503 burst silently drops a minute of IV across all 13 tickers — and the IV-anomaly detector then flags the artificial gap as a flow event.
  _Fix:_ wrap each `schwabFetch` in `withRetry`, add `await cronJitter()` after `cronGuard`, emit `reportCronRun` with `{tickers: ok/total, snapshots, durationMs}`.

- **[api/cron/monitor-regime-events.ts](../../api/cron/monitor-regime-events.ts) — Self-acknowledged race condition can double-fire push notifications.** Per-minute fires with zero retry, zero jitter, zero outcome reporting; the race in lines 17-25 is documented in-code.
  _Fix:_ wrap state read/update in `SELECT … FOR UPDATE` (single singleton row, cost negligible); add `reportCronRun`.

- **[api/\_lib/api-helpers.ts:710-719](../../api/_lib/api-helpers.ts) — `?force=1` time-window bypass relies solely on CRON_SECRET.** Verified: the cron secret check still gates everything, but if the secret ever leaks (Sentry breadcrumb, log line, third-party cron poker), an attacker can hammer any UW cron, draining your rate budget.
  _Fix:_ require `isOwner(req)` in addition to CRON_SECRET when `force=1` is set — defense in depth.

### Frontend

- **[src/hooks/useChainData.ts:40](../../src/hooks/useChainData.ts) — `loading` starts `false` while every sibling fetcher starts `true`.** Verified against `useGreekFlow.ts:110` and `useZeroGamma.ts:54`. Consumers using `loading` for a startup spinner skip it on the chain panel only.
  _Fix:_ one-character change — flip to `useState(true)`.

- **[src/utils/strikes.ts:159](../../src/utils/strikes.ts) — Dead `callSkewOverride` parameter masks a fall-through bug.** `effectiveCallSkew = callSkewOverride ?? skew` — the `??` correctly preserves a literal `0`, but downstream `calcScaledCallSkew(0, z)` short-circuits and falls back to put skew. Currently zero call sites pass it.
  _Fix:_ delete the param entirely from `calcStrikes` and `calcAllDeltas`.

### Tests

- **[api/\_lib/db-greek-flow.ts](../../api/_lib/db-greek-flow.ts) has no companion test file.** Added in commit `a67b0171` (2026-04-28). Violates the "never ship new code without tests" rule.
  _Fix:_ mirror the `db-flow.test.ts` pattern.

- **[src/components/IVAnomalies/tooltips.tsx](../../src/components/IVAnomalies/tooltips.tsx) — no test.** Added in commit `9a1f2a8e` (2026-04-28). Same violation.
  _Fix:_ add `tooltips.test.tsx` covering each tooltip variant + badge-hover wiring.

- **[api/**tests**/db.test.ts:190-241](../../api/**tests**/db.test.ts) — Five `saveSnapshot` variants test the mock, not the SQL.** All assert only `mockSql.toHaveBeenCalledTimes(1)`. The vix-1d ratio branch is money math being saved to a real column — currently unverified.
  _Fix:_ capture `mockSql.mock.calls[0]` and assert the values array contains the expected ratio (or `null`).

- **8 e2e specs use raw `page.waitForTimeout(300|400)` for "debounce".** Hard sleeps fail under CI load. Files: cross-section, extreme-inputs, iv-acceleration, error-recovery, pnl-profile, delta-regime-guide, iron-condor, validation-errors.
  _Fix:_ replace each with `await expect(locator).toBeVisible()` or `waitForFunction` keyed on the actual debounced value.

### Config

- **[.github/workflows/ml-pipeline.yml:11](../../.github/workflows/ml-pipeline.yml) — `contents: write` on a 30-min job that runs untrusted-ish curl + JS.** Job holds `BLOB_READ_WRITE_TOKEN` and `CRON_SECRET` while making external HTTPS calls.
  _Fix:_ split into two jobs — the run/upload job stays `contents: read`; only the small "Commit findings.json" job gets `contents: write` via job-scoped `permissions:`.

- **Missing `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`** in [vercel.json:225-248](../../vercel.json). App handles Schwab tokens client-side; absence enables Spectre-class side channels from any popup.
  _Fix:_ add `COOP: same-origin` and `CORP: same-origin` to the global headers block (one line each).

- **CSP-HASHES.md exists at repo root but is not referenced from CLAUDE.md.** When inline scripts in `index.html` change, CSP will silently rot.
  _Fix:_ add a Vitest snapshot that hashes inline scripts and fails on drift; cross-reference from CLAUDE.md.

---

## 3. IMPORTANT Findings

Consistency, JIT violations, type tightening, coverage.

### Backend Pattern Drift

- **`'error' in row` inlined 12+ times** across `AdvancedSection.tsx`, `DeltaStrikesTable.tsx`, `IronCondorSection`, `BWBSection`, `DeltaRegimeGuide`, `SettlementCheck`, and the export modules. The `isStrikeError` guard exists, just unused. One rename, replace all 12.
- **Three near-identical `JSON.parse` blocks for JSONB columns** in [db-positions.ts:128](../../api/_lib/db-positions.ts), [db-analyses.ts:160](../../api/_lib/db-analyses.ts), [lessons.ts:255](../../api/_lib/lessons.ts). Each silently throws on malformed JSON; none use Zod.
  _Fix:_ extract `parseJsonbColumn<T>(val, schema)` once.
- **5 hardcoded model IDs** scattered across [analyze.ts:201](../../api/analyze.ts), [analyze-precheck.ts:27](../../api/_lib/analyze-precheck.ts), [trace-live-analyze.ts:74](../../api/trace-live-analyze.ts), `db-migrations.ts:945`, and `analyze.test.ts:360`. When you bump to 4.8, you'll grep these.
  _Fix:_ `MODELS = { OPUS, SONNET, PRECHECK }` in `constants.ts`.
- **`api/analyze.ts:382-394` — DB save retry exhausts and the user gets a successful response while the analysis isn't persisted.** Lessons curation later silently misses the trade.
  _Fix:_ set `X-Persistence-Failed: 1` response header so the client can surface a banner.
- **Sentry isolation-scope inconsistency** — Of 35+ data endpoints, only ~9 wrap their handler in `Sentry.withIsolationScope` + `setTransactionName`. Errors land on a shared scope; request-specific tags bleed across concurrent invocations. Closed by Win **B**.
- **18+ direct `process.env.X` reads** bypass the typed `env.ts` layer (api-helpers, alerts, analyze-context-fetchers, web-push-client, embeddings, guest-auth). Closed by Win **C**.
- **Two parallel CRON_SECRET timing-safe-equal implementations** in [api/ml/analyze-plots.ts:260-273](../../api/ml/analyze-plots.ts) and [api/\_lib/api-helpers.ts:680-708](../../api/_lib/api-helpers.ts).
  _Fix:_ factor `verifyCronSecret(req, res): boolean` from `cronGuard` so endpoints that aren't crons-themselves but require CRON_SECRET reuse it.
- **`uwFetch` returns `[]` on three different failure modes** — missing `body.data`, `null`, and `undefined`. Callers can't distinguish "API returned empty" from "we silently dropped malformed response". Closed by Win **D**.

### Cron Observability Gaps

- **8 of 16 per-minute jobs lack `cronJitter`** — UW concurrency cap is 3, so this guarantees recurring 429s `withRetry` masks. Evaporates if `cronJitter` becomes mandatory inside `cronGuard` itself (Win **A**).
- **12 handlers lack `reportCronRun` entirely** — Axiom dashboards are blind for these jobs: `compute-zero-gamma`, `curate-lessons`, `embed-yesterday`, `fetch-flow-alerts`, `fetch-spxw-blocks`, `fetch-strike-iv`, `fetch-strike-trade-volume`, `fetch-whale-alerts`, `monitor-regime-events`, `refresh-current-snapshot`, `resolve-iv-anomalies`, `warm-tbbo-percentile`.
- **Schedule `* 13-21 * * 1-5` fires for hour 21** (5 PM ET, one hour after close) — 720 cold invocations/day burned for 12 jobs. Tighten to `* 13-20`.
- **[api/cron/fetch-greek-exposure.ts:225-227](../../api/cron/fetch-greek-exposure.ts) — Partial-failure path runs the data-quality query against today's table before short-circuiting**, generating a misleading "all-zero rows" Sentry warning that buries the real cause.
- **[api/cron/fetch-market-internals.ts:32-34](../../api/cron/fetch-market-internals.ts) — Returns 200 unconditionally** even when all 4 symbols fail. Vercel cron dashboard stays green while `market_internals` got nothing.
  _Fix:_ when `oks === 0 && failures > 0`, return 502.
- **[api/cron/fetch-darkpool.ts:81-94](../../api/cron/fetch-darkpool.ts) — `'no new trades'` reported as `status: 'skipped'`** indefinitely if UW silently breaks. Escalate to `Sentry.captureMessage` once per session if `>10` consecutive minutes.

### Frontend Type / JIT

- **`marketOpen: boolean` alias still consumed by 12 hooks** while the `MarketSession` discriminated union exists. Pre-market gating is currently impossible without going around the hook signature.
  _Fix:_ migrate one hook per session; delete `marketOpen` once count is zero.
- **[useAppState.ts:88-99](../../src/hooks/useAppState.ts) — Three independent `useState` initializers each call `getInitialCTTime()` separately.** A minute rollover between calls produces inconsistent `{hour, minute, ampm}`.
  _Fix:_ single lazy initializer that returns the full triple.
- **[useVixData.ts:171](../../src/hooks/useVixData.ts) — Silent return on >10 MB upload.** User sees nothing happen and doesn't know why.
  _Fix:_ surface a toast via `useToast` and clear `e.target.value`.
- **`STRESS.BREAKEVEN_TARGET = 1.5` has three sources of truth** — [useAppState.ts:113](../../src/hooks/useAppState.ts), [IronCondorSection/index.tsx:28](../../src/components/IronCondorSection/index.tsx), [constants/index.ts:78](../../src/constants/index.ts).
  _Fix:_ import from `constants`.
- **[useChainData.ts:13-15](../../src/hooks/useChainData.ts) and [useIVAnomalies.ts:130-132](../../src/hooks/useIVAnomalies.ts) — `FetchChainResult.networkError?: string`** is stringly-typed for an outcome that's already a discriminated-union shape.
  _Fix:_ model as `Result<T, string>`.
- **[hedge.ts:344-440](../../src/utils/hedge.ts) — `Math.round(x * 100) / 100` repeated 6×** in the same function.
  _Fix:_ extract `round2`.

### Tests

- **[api/**tests**/analyze-context.test.ts](../../api/**tests**/analyze-context.test.ts) — 10× `expect(textBlock).toBeDefined()`** followed by `textBlock!.text.includes(...)`. The `!` would crash before the assertion runs; `.toBeDefined()` is decorative.
  _Fix:_ `expect(textBlock?.text).toContain(...)`.
- **[api/**tests**/analyze-calibration.test.ts:95,126](../../api/**tests**/analyze-calibration.test.ts) — Two `it.skip()` blocks** because `parseAnalysis` and `fixMojibake` aren't exported. Money-flow parsing edge cases unverified.
  _Fix:_ export and unskip.
- **DB-mock pattern drift** — 109 tests use `vi.mock('../_lib/db.js')`, only 11 use the `vi.mocked(getDb)` pattern CLAUDE.md prescribes. Closed by Win **E**.
- **e2e a11y scan only covers `/`** — the 2026-04-28 panels (ZeroGamma, GreekFlow, IVAnomalies tooltips) are never scrolled into view, so axe never inspects them.
  _Fix:_ three `test()` blocks scoped to each panel locator.
- **e2e brittle CSS selectors** in `accessibility.spec.ts:146`, `advanced-section.spec.ts:83`, `cross-section.spec.ts:13/32/81/157`, `a11y-automated.spec.ts:46`, `a11y-live-data.spec.ts:126` use `page.locator('#results')` style. Bypasses the semantic-selector rule.
- **[api/**tests**/cron-compute-zero-gamma.test.ts:68-75](../../api/**tests**/cron-compute-zero-gamma.test.ts) — Positional `mockSql.mockResolvedValueOnce()` chained per ticker** (4 × 3 = 12 ordered calls). Adding a 4th SQL call shifts every subsequent ticker's mocks silently.
  _Fix:_ `mockSql.mockImplementation` with query routing.

### Config

- **`.env.example` missing 11 documented env vars** (TWILIO*\*, VAPID*\*, SIDECAR_URL, DAY_ANALOG_BACKEND, GUEST_ACCESS_KEYS, BLOB_READ_WRITE_TOKEN, ALERT_PHONE_TO).
- **`actions/upload-artifact@v7`** in [ci.yml:117](../../.github/workflows/ci.yml) — current GA is v4. Either intentional pre-release (document) or will break.
- **`maxDuration` mismatch:** verified `analyze.ts: 780` in vercel.json vs CLAUDE.md "800s". And `backfill-futures-gaps: 800` exceeds the documented ceiling.
- **`neon_workflow.yml`** creates per-PR Neon branches with `expires_at: +14 days` but the migration/diff steps are commented out (lines 60-87). Pure cost surface today.
  _Fix:_ uncomment or delete.
- **ESLint over-specified ignores:** [eslint.config.ts:19](../../eslint.config.ts) ignores `sidecar`, `daemon`, `.clone`, `.claude/worktrees` — all directories with no JS/TS to lint.

---

## 4. NICE-TO-HAVE

Cleanup, doc rot, comment archaeology.

- **CLAUDE.md drift**: says "69 numbered migrations"; actual count is **98** (per `db-migrations.ts`).
- **Sidecar `requirements.txt` uses `>=` lower-bounds only** — Databento `0.46` breaking change ships silently on next Railway rebuild.
  _Fix:_ upper bounds, or pip-compile a lockfile.
- **`scripts/` has 60 files**, many obvious finished one-shots (`convert-vix-csv.mjs`, `upload-archive-to-blob.mjs`, `derive-vega-spike-floors.mjs`, `__pycache__/`).
  _Fix:_ move to `scripts/archive/`.
- **`vercel.json ignoreCommand` lists `pine`** — no `pine/` directory exists.
- **Three large test files >1.6k LOC** — [analyze-context.test.ts](../../api/__tests__/analyze-context.test.ts) (2,212), [build-features-phase2.test.ts](../../api/__tests__/build-features-phase2.test.ts) (1,828), [db-strike-helpers.test.ts](../../api/__tests__/db-strike-helpers.test.ts) (1,682). Slowest to comprehend on failure.
  _Fix:_ split by `describe`.
- **[api/\_lib/db.ts](../../api/_lib/db.ts) — `initDb` vs `migrateDb` split is stale.** Comment says "do not add tables to initDb" but it still creates 3 base tables alongside 98 migrations.
  _Fix:_ fold base tables into migration #0; shrink `initDb` to a no-op.
- **[useAppState.ts:13-22](../../src/hooks/useAppState.ts) — 9-line archaeology comment about a previous version of the hook.** Delete.
- **[utils/iron-condor.ts:212-213](../../src/utils/iron-condor.ts) — `row.basePutSigma ?? row.putSigma`** uses `??` against fields the type declares non-optional. Defensive guard is dead and misleads readers.
- **[PinRiskAnalysis.tsx:28,112](../../src/components/PinRiskAnalysis.tsx) — `Math.abs(s.distFromSpot / spot) < PIN_ZONE_PCT`** computed twice identically.
  _Fix:_ add `isNear: boolean` to the `OIStrike` type at source.
- **[utils/calculator.ts:31](../../src/utils/calculator.ts) — `spxToSpy` re-exported but never imported** by application code; only test references it.
- **`api/_lib/uw-result.ts`** — 566-byte abandoned half-build. Either land it (Win **D**) or delete it.
- **52 Python files in `ml/tests/` but only 51 contain `def test_`** — one dead-test scaffold.
- **[api/cron/warm-tbbo-percentile.ts:65-70](../../api/cron/warm-tbbo-percentile.ts)** always returns 200 by design but never reports to Axiom — sustained sidecar death is invisible.

---

## 5. Suggested Tackle Order

Pure ROI ranking:

1. **Win A** (`runCron` wrapper) — 1 day, fixes 20+ findings.
2. **Quick wins** (`useChainData` loading + `strikes.ts` dead param + CLAUDE.md migration count) — 30 minutes total.
3. **Win C** (env consolidation) — half a day, makes future endpoints safer for free.
4. **Critical: lessons.ts `sql.unsafe` rebuild** — 1-2 hours, closes a real injection vector even if no current caller is unsafe.
5. **Critical: COOP/CORP headers** — 5 minutes for a real security gain.
6. **Test gaps** for `db-greek-flow.ts` and `tooltips.tsx` — same-day, before they accrue.
