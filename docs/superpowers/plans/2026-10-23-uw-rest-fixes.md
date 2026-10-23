# UW REST Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the live UW REST data defects D1–D12, D14 and D18 from the spec: SPX strike truncation, NULL rv_30d, NULL per-expiry gamma, wrong dates/prices/spot, swallowed errors, broken retention.

**Architecture:** These are targeted fixes inside existing Vercel cron handlers and `api/_lib` helpers. There is one new shared helper (`api/_lib/uw-spot.ts`) so spot comes from UW's per-minute exposure endpoint instead of a stale strike row. Backfills rewrite prod rows idempotently.

**Tech Stack:** TypeScript (Node 24, ESM), Vitest, `@neondatabase/serverless`, UW REST via `uwFetch`/`uwFetchPaged`.

**Spec:** `docs/superpowers/specs/uw-api-ws-alignment-2026-10-23.md`

**Requirement-level plan (ruling):** tasks give exact files, behaviours, constants and test cases, not full code. Each fix needs reading the surrounding handler, which the implementer does.

## Global Constraints

- Worktree: `F:\dev\strike-calculator\.worktrees\2026-10-02-uw-rest` (branch `fix/2026-10-02-uw-rest`). Work only there. Never touch the main checkout.
- Every UW call goes through `uwFetch` / `uwFetchPaged` (`api/_lib/uw-fetch.ts`, `api/_lib/uw-fetch-paged.ts`). Never raw `fetch()` against UW.
- Before relying on any UW field or param, fetch the live operation doc. Find the URL in `https://api.unusualwhales.com/docs/llms.txt`, then `curl -sL <url>.md` (the old `/docs/operations/<id>.md` URLs 301-redirect, so always pass `-L`).
- **Live UW probes:**
  - Read the key with `KEY=$(grep -h '^\(export \)\?UW_API_KEY=' .env.local .env 2>/dev/null | head -1 | sed 's/^export //' | cut -d= -f2- | tr -d '"'"'"'\r ')` from the MAIN checkout `F:\dev\strike-calculator`, because the worktree has no `.env.local`.
  - Never print, log or save the key.
  - Send an explicit `User-Agent`.
- **Prod DB:** `F:\dev\strike-calculator\.env.local` `DATABASE_URL` is PRODUCTION. SELECTs are fine. Writes ONLY where a task says so (backfills). Run node DB scripts from the worktree with `node --input-type=module < script.mjs` so `@neondatabase/serverless` resolves.
- **Code style:**
  - `.js` extensions on relative imports.
  - `import type` for type-only imports.
  - `Number.parseFloat`/`Number.parseInt`, `.at(-1)`, no nested template literals.
  - Prettier: 2 spaces, single quotes, trailing commas, 80 cols.
- **Tests** go in `api/__tests__/*.test.ts`.
  - Mock at module boundaries with `vi.mock`; no `deps` params or test-only seams (R3).
  - Every change carries failure-mode tests: upstream error, malformed payload, DB reject. Each asserts how the failure surfaces, by name (R4).
  - A cron whose write fails must not report success.
- **Verification:** `npm run review`, run in the FOREGROUND with a long timeout (≥ 600000 ms), never backgrounded. It must be fully green before you commit.
- **Commits:**
  - One commit per task, conventional style (`fix(scope): Sentence case summary`).
  - Write the message to your own scratch subdir: `C:\Users\Charlie\AppData\Local\Temp\claude\f--dev-strike-calculator\5fdfa02f-666f-452a-8c03-98198eab16bc\scratchpad\<task-id>\commit.txt`. Print it, then `git add <explicit files> && git commit -F <file>` in one call.
  - End messages with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Never `--amend`, `checkout --`, `restore`, `reset`, `stash` or `rm`. Do not push; the controller integrates.
- Do not dispatch subagents.

## Review Focus

1. A UW page with exactly 500 rows triggers the next page; a short page ends the walk without error (R1).
2. When the spot helper returns null, crons fail loudly (Sentry + non-2xx or an explicit `partial`). They never fall back silently to a strike-row price (R1, R4).
3. Backfills are idempotent on re-run, print per-date counts, and stop on the first error (R1, R2).
4. rv_30d never uses a future window: for day D only a window ENDING on D counts (R2).
5. `Retry-After` is capped so a hostile or garbled header cannot stall a cron past its `maxDuration` (R9).

## Execution order

R1 → R11 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10 → R12 → R13 (only after websocket-plan Task W1 is on `origin/main`; rebase first) → R14.

---

### Task R1: Shared UW spot helper + full strike window in strike-all + backfill

**Files:**
- Create: `api/_lib/uw-spot.ts`, `api/__tests__/uw-spot.test.ts`
- Modify: `api/cron/fetch-strike-all.ts` (fetch at :68-73, filter at :89-96, timestamp at :116), `api/__tests__/fetch-strike-all.test.ts`, `scripts/backfill-strike-all.mjs`

**Interfaces:**
- Produces: `export async function fetchUwSpot(apiKey: string, ticker: string, date?: string): Promise<{ price: number; time: string } | null>`.
  - It calls `uwFetch` on `/stock/${ticker}/spot-exposures` (append `?date=${date}` when given).
  - It returns the row with the greatest timestamp, using `start_time ?? time` (the same convention as `fetch-spot-gex.ts:95`), with `price` parsed via `Number.parseFloat`.
  - It returns `null` (after `logger.warn`) when there are no rows or the price is NaN or ≤ 0.
  - It lets `uwFetch` rejections propagate.
  - Used by R4 and R6.

**Requirements:**
- **strike-all:**
  1. Get spot with `fetchUwSpot(apiKey, 'SPX')`. If null, call `Sentry.captureMessage`, return a 500 JSON error, and insert nothing.
  2. Fetch `/stock/SPX/spot-exposures/strike` with `min_strike = spot − ATM_RANGE`, `max_strike = spot + ATM_RANGE` (confirm both params in the live doc), `limit=500`, and 0-based `page`. Walk pages via `uwFetchPaged`, continuing ONLY while a page returns exactly 500 rows, with a page cap of 10.
  3. Keep the ±`ATM_RANGE` filter as a safety net.
  4. Stored `price` = helper spot. Snapshot `timestamp` = max `time` across the returned rows.
- **backfill-strike-all.mjs:**
  - Use the same logic for a given date. Spot comes from `/stock/SPX/spot-exposures?date=D` (newest row); walk pages the same way.
  - Delete the false comment at :37-43 ("exposes no offset/cursor/next-page parameter").
  - Keep the existing ON CONFLICT semantics. Print per-date row counts; stop on the first error.
- **Run the backfill** for every trading day 2026-09-25 → 2026-10-22. First do a 1-date dry run and confirm the strike range now straddles spot. Report per-date counts, plus the min/max strike vs spot for 2 sample dates (query prod after the run). Note in the report that only UW's end-of-day board is recoverable for those dates, not the intraday snapshots.

**Tests (fetch-strike-all.test.ts, uw-spot.test.ts):**
- [ ] **uw-spot:** rows given out of order → returns the newest by `start_time ?? time`; empty → null; NaN price → null; `uwFetch` reject → the helper rejects.
- [ ] **strike-all, two pages:** page 0 returns exactly 500 rows and page 1 returns 38. Both are fetched, and inserted strikes span below AND above spot.
- [ ] **strike-all, short page:** page 0 returns < 500 → no page 1 request.
- [ ] **strike-all, URL params:** the request URL carries `min_strike`/`max_strike` = spot ∓ 200.
- [ ] **strike-all, spot null:** 500 status, `Sentry.captureMessage` called, no `INSERT`.
- [ ] **strike-all, UW reject on page 1:** 500, no partial "success".
- [ ] **strike-all, DB transaction reject:** 500, and the response is not `ok`.
- [ ] `npm run review` green; commit.

### Task R11: Diagnose and fix the ws_option_trades retention sweep

**Files:** `api/cron/cleanup-ws-option-trades.ts`, `api/__tests__/cleanup-ws-option-trades.test.ts`, plus anything the diagnosis implicates (state it in the report).

**Context:**
- Commit 878f2683 (2026-10-02, "Purge expired option trades oldest-first and surface backlog") landed.
- On 2026-10-23 the oldest row is still 2026-06-18 18:39 UTC, with ~67M rows (85 GB heap + 23 GB indexes). The sweep is not deleting.
- Design doc: `docs/superpowers/specs/flow-regime-and-retention-2026-10-02.md`.

**Requirements:**
1. Use the `superpowers:systematic-debugging` skill. Find the root cause with evidence before changing code. Candidates to check:
   - Is the cron scheduled (`vercel.json`, `api/_lib/cron-schedules.ts`)?
   - Does its route still exist?
   - Does the purge SELECT pick a plan that times out? Use `EXPLAIN`, not `ANALYZE`, on prod for the batch query.
   - Statement timeout vs batch size.
   - Wrong cutoff arithmetic.
   - Does the handler throw before the first batch?
   - Sentry/backlog signals the 878f2683 commit added.
2. Fix the root cause with a test that would have failed before the fix.
3. Do NOT run a manual mass DELETE. Once deployed, the scheduled sweep drains the backlog; that is the designed retention, and the authoritative tape archive is local + R2. Report the expected drain time from measured batch timing (one read-only `EXPLAIN` estimate is enough).

**Tests:**
- [ ] A regression test reproducing the root cause.
- [ ] Failure surfacing: DB reject mid-sweep → 500 with `totalDeleted` reported, plus Sentry.
- [ ] `npm run review` green; commit.

### Task R2: Trailing rv_30d in cron and backfill; rewrite history

**Files:** `api/cron/fetch-vol-surface.ts` (`fetchRealizedVol` :59-61, `storeRealizedVol` :123-184), `api/__tests__/fetch-vol-surface.test.ts`, `scripts/backfill-vol-surface.mjs` (:94-100, :137-142, :173-177, :194-195)

**Requirements:**
1. **Fetch the live docs** for `/stock/{ticker}/volatility/realized` and `/stock/{ticker}/volatility/realized/windows`. Probe both for one past date (e.g. 2026-10-01). Choose the source that gives the trailing 21-trading-day RV whose window ENDS on day D AND supports historical dates. The candidates:
   - the `realized` row with `unshifted_rv_date == D`
   - the `windows` row with `days=21` and completion date D

   If they disagree beyond rounding, report it and use the `windows` endpoint. Record the choice and the probe numbers in the report.
2. **`iv_30d`** = `implied_volatility` of the `realized` row whose `date == D`. It must NOT come from the RV row.
3. **Cron:** D = today (it runs after the close). If no RV value exists for D, store `rv_30d = NULL`, call `logger.warn` + `Sentry.captureMessage`, and still store `iv_30d`.
   - `iv_rv_spread` = iv − rv.
   - `iv_overpricing_pct` follows the existing formula.
   - Keep the `iv_rank` COALESCE.
4. **Backfill:** rewrite EVERY date already in `vol_realized`, and fill missing trading days between the first stored date and yesterday where UW has data. That includes the 2026-07-22 → 2026-09-07 gap.
   - Upsert iv_30d, rv_30d, iv_rv_spread and iv_overpricing_pct. Never overwrite an existing `iv_rank` with NULL (match the cron's COALESCE).
   - Idempotent. Per-date log. Stop on the first error.
   - Run `--dry-run` first, which prints planned values for 3 dates. Then the real run.
   - Report before/after: count of non-NULL `rv_30d`, and 3 sample dates showing old vs new values.
5. This is an approved methodology change. Note in the commit body that rv_30d history now uses the trailing window and previously held look-ahead values.

**Tests:**
- [ ] The newest row has `realized_volatility: null` and an older row has `unshifted_rv_date == today` → rv_30d comes from the older row; iv_30d comes from the `date == today` row.
- [ ] No row for D → rv_30d NULL, `logger.warn` and `Sentry.captureMessage` called, iv still stored.
- [ ] Malformed numerics (`"abc"`) → NULL, not NaN.
- [ ] UW reject → 500.
- [ ] DB reject → 500.
- [ ] `npm run review` green; commit.

### Task R3: Per-expiry gamma from `call_gex`/`put_gex`

**Files:** `api/cron/fetch-greek-exposure.ts` (`ExpiryRow` :40-52, insert :128-140), `api/__tests__/fetch-greek-exposure.test.ts` (fixture :81 encodes `call_gamma: null`), `scripts/backfill-greek-exposure.mjs` (:166)

**Requirements:**
- Confirm `call_gex`/`put_gex` in the live doc for `/stock/{ticker}/greek-exposure/expiry` plus one probe.
- Map them into the existing `call_gamma`/`put_gamma` columns. Update `ExpiryRow`.
- The aggregate (`/greek-exposure`) path keeps reading `call_gamma`; it is correct there.
- Do not run the backfill (live consumers only). Just fix its mapping.

**Tests:**
- [ ] A fixture shaped like the live response (`call_gex`, `put_gex`, no `call_gamma`) → the INSERT receives those values.
- [ ] Missing `call_gex` → NULL stored, no crash.
- [ ] `npm run review` green; commit.

### Task R4: Adopt the spot helper in the remaining preflights

**Files:** `api/cron/fetch-gex-0dte.ts` (`fetchSpotPrice` :95-109, call :260, min/max :124-127), `api/cron/fetch-gex-strike-expiry-etfs.ts` (:120-140, :406, :160-163), `api/cron/fetch-strike-exposure.ts` (:128-131, :150-157, :163, :230), and their three test files.

**Interfaces:** Consumes `fetchUwSpot` from R1.

**Requirements:**
- Replace each `?limit=1` strike-row preflight and each `rows[0].price` spot with `fetchUwSpot`.
- `fetch-strike-exposure.ts` currently sends NO `min_strike`/`max_strike`. `fetch-gex-0dte`'s docs say omitting them returns a frozen pre-market cache. Pass both, from spot ± its existing ATM window.
- When spot is null for a ticker: skip that ticker, call Sentry with the ticker name, and mark the run `partial` (or non-2xx when nothing succeeded). Remove the unbounded fallback fetch.
- Snapshot timestamps come from the max `time` across rows, not `rows[0].time`.

**Tests (each cron):**
- [ ] Spot comes from the helper (mocked), and the URL carries min/max from it.
- [ ] Helper null → no fetch for that ticker, Sentry called, `partial`/non-2xx.
- [ ] UW reject → surfaced.
- [ ] `npm run review` green; commit (one commit for the batch).

### Task R5: options-volume selects the matching date

**Files:** `api/_lib/build-features-phase2.ts` (`addOptionsVolumeFeatures` :410-460), `api/__tests__/build-features-phase2.test.ts`

**Requirements:**
- The endpoint has no `date` param (live doc). Request `/stock/SPX/options-volume?limit=40`, which covers the existing 30-trading-day window guard.
- Pick the row whose `date === dateStr`. If there is none, skip the features with `logger.warn` (never use another day's row).

**Tests:**
- [ ] Rows for 3 dates, one matching → features from the matching row.
- [ ] No match → features unset and warn called.
- [ ] The URL has no `date=`.
- [ ] `npm run review` green; commit.

### Task R6: monitor-flow-ratio stores a real SPX price

**Files:** `api/cron/monitor-flow-ratio.ts` (:62, :72-75, :89-97, :174, :279, :314-323, :360, :372), `api/__tests__/monitor-flow-ratio.test.ts`

**Requirements:**
- `spxPrice` = `fetchUwSpot(apiKey, 'SPX')`. It must not come from the index-only tide's `underlying_price`, which is SPY-scale.
- If spot is null, store NULL `spx_price` (check the column is nullable; if it isn't, say so in the report and stop) and still compute and store the ratio. Price is not an input to the ratio.
- Also probe whether `date=${today}` on `/net-flow/expiry` returns null ticks intraday, as `fetch-zero-dte-flow.ts:48-51` says. If it does, drop the param the same way. Report the probe result.

**Tests:**
- [ ] The stored and alerted `spxPrice` equals the helper's price, not the tide's `underlying_price`.
- [ ] Helper null → ratio still stored, `spx_price` NULL, warn.
- [ ] `npm run review` green; commit.

### Task R7: Real previous close in spx-candles

**Files:** `api/_lib/spx-candles.ts` (docs :273-277, DB path :335-340, UW path :418-425), `api/__tests__/spx-candles.test.ts`

**Requirements:**
- `previousClose` must be the prior regular-session SPX close.
- **DB path:** the last `market_time = 'r'` close for symbol `SPX` in `index_candles_1m` on the previous trading date.
- **UW path:** `/stock/SPY/stock-state` `prev_close` (confirm the field in the live doc) × `spyToSpxRatio`.
- Missing → null + warn. Update the doc comment.
- Consumers: `formatSPXCandlesForClaude` gap line, `api/gex-target-history.ts` → GexTarget chart reference line. Their behaviour is unchanged apart from the corrected value.

**Tests:**
- [ ] DB path returns the prior day's last regular close, not a premarket bar.
- [ ] UW path uses `prev_close × ratio`.
- [ ] Missing → null.
- [ ] `npm run review` green; commit.

### Task R8: Index candles via ETF proxy; surface fetch errors

**Files:** `api/_lib/uw-stock-candles.ts` (:29-42, `computeRangePos` :56-86), `api/__tests__/uw-stock-candles.test.ts`, `api/cron/detect-lottery-fires.ts` (:683-697), `api/__tests__/detect-lottery-fires.test.ts`

**Requirements:**
- Add `INDEX_CANDLE_PROXY = { SPX: 'SPY', SPXW: 'SPY', XSP: 'SPY', NDX: 'QQQ', NDXP: 'QQQ', RUT: 'IWM', RUTW: 'IWM' }`.
- `fetchStockCandles1m(apiKey, ticker, date)` fetches the proxy's candles for index tickers, because UW returns 422 for index OHLC.
- On any fetch error: `logger.warn` + `Sentry.captureMessage` with ticker and status, at most once per ticker per invocation, then return `[]`.
- **detect-lottery-fires:** for index underlyings, `spotAtFirst` is often null, because `ws_option_trades.underlying_price` is `""` for index tags. When it is null, use the proxy candle close at or just before the trigger minute. `range_pos` is scale-invariant (`(spot−low)/(high−low)`), so the proxy is valid; say so in a code comment.

**Tests:**
- [ ] SPXW → the request path is `/stock/SPY/ohlc/1m`.
- [ ] A 422 rejection → `[]` and Sentry called once.
- [ ] Index fire with null spot → `range_pos` computed from the proxy close.
- [ ] `npm run review` green; commit.

### Task R9: Honour Retry-After; full-day 1m candle fetch

**Files:** `api/_lib/uw-fetch.ts` (`classifyRetryDelay` :56-88, `withRetry` :90-106, throw at :260), `api/__tests__/api-helpers.test.ts`, `api/cron/fetch-spx-candles-1m.ts` (:208-219), `api/__tests__/fetch-spx-candles-1m.test.ts`

**Requirements:**
- `uwFetch` throws `export class UwHttpError extends Error` with `status: number` and `retryAfterMs: number | null`. `Retry-After` may be seconds or an HTTP-date; unparseable → null.
- The message text stays EXACTLY `UW API ${status}: ${text.slice(0, 200)}`, so `parseUwHttpStatus` and the string classifiers keep working.
- `withRetry`: when the error is a `UwHttpError` with status 503 or 429 and non-null `retryAfterMs`, wait `Math.min(retryAfterMs, 30_000)`. Otherwise use the existing `classifyRetryDelay`.
- **fetch-spx-candles-1m:** remove `&limit=500`. A no-limit request returns the full day (811 rows observed). Confirm the cap in the live doc.

**Tests:**
- [ ] 503 + `Retry-After: 3` → delay 3000 (fake timers).
- [ ] `Retry-After: 99999` → capped at 30000.
- [ ] No header → old delay.
- [ ] Message unchanged and `parseUwHttpStatus` still parses it.
- [ ] Candles URL has no `limit=500`.
- [ ] `npm run review` green; commit.

### Task R10: `expires ?? expiry` defensive read

**Files:** `api/cron/fetch-greek-flow-etf.ts` (:181-182), `api/cron/reconcile-greek-flow-etf.ts` (:80-81), `scripts/backfill-greek-flow-etf-0dte.mjs` (:99), `api/__tests__/fetch-greek-flow-etf.test.ts`

**Requirements:** Live data sends `expires`; UW's doc says `expiry`. Read `row.expires ?? row.expiry` and type both as optional.

**Tests:**
- [ ] A row with only `expires` works.
- [ ] A row with only `expiry` works.
- [ ] `npm run review` green; commit.

### Task R12: Delete dead `fetchAllDarkPoolTrades`; correct a misleading comment

**Files:** `api/_lib/darkpool.ts` (:146-265), `api/__tests__/darkpool.test.ts` (:784-1026 and the import at :29), `api/_lib/uw-fetch-paged.ts` (comment :4), `api/cron/fetch-strike-trade-volume.ts` (comment near :215)

**Requirements:**
- Re-grep the whole repo (api/, src/, scripts/, ml/) to confirm there are no production callers, then delete the function and its tests. Remove imports it orphans.
- Fix the fetch-strike-trade-volume comment: `flow-per-strike-intraday` returns only the top strikes by the `filter` param (~8 for SPX on 2026-10-01), not every strike per minute.

**Tests:**
- [ ] The remaining darkpool tests pass.
- [ ] `npm run review` green; commit.

### Task R13: Flow-alert list fields + greeks into `flow_alerts`

**Prerequisite:** websocket-plan Task W1 (migration adding `iv, delta, gamma, theta, vega, rho, theo` to `flow_alerts`) is on `origin/main` and applied to prod. Rebase this branch onto `origin/main` first.

**Files:** `api/cron/fetch-flow-alerts.ts` (comment :34-35, INSERT :206-227), `api/_lib/flow-alert-derive.ts` (`UwFlowAlert` :12-37), `api/__tests__/fetch-flow-alerts.test.ts`

**Requirements:**
- Probe the list endpoint once to confirm the field names.
- Map `id` → `uw_alert_id`, plus `rule_id`, `bid`, `ask`, `iv_start`, `iv_end`, `start_time`, `end_time`, `iv`, `delta`, `gamma`, `theta`, `vega`, `rho` and `theo` into the existing and new columns (check each column exists).
- Delete the wrong "detail-only" comment.
- The conflict key is unchanged.

**Tests:**
- [ ] A probe-shaped fixture → all mapped values reach the INSERT.
- [ ] Null greeks → NULL.
- [ ] `npm run review` green; commit.

### Task R14: Resync the `unusual-whales-api` skill

**Files:** `.claude/skills/unusual-whales-api/SKILL.md`

**Requirements:** Re-fetch the live docs first; 3 weeks passed since the audit. Then make these changes:
1. Update the sync date.
2. **Doc lookup:** use `curl -sL`, `https://api.unusualwhales.com/docs/llms.txt`, and direct `/docs/api/<tag>/<slug>.md` URLs. Add the `/docs/conventions.md` and `/docs/errors.md` pages.
3. **Errors:**
   - 403 branches on `code` (`missing_access`, `historic_data_access_missing`, `advanced_tier_required`, `futures_access_required`, `politics_scope_required`, `volatility_scope_required`, `admin_required`). `reason: route_not_permitted` appears only under `missing_access`.
   - A non-JSON 403 comes from Cloudflare.
   - 503 + `Retry-After` on the spot-exposures strike endpoints.
   - Index OHLC/quote returns 422 (licensing).
4. **Headers:** remove `x-uw-minute-req-counter`, which is no longer sent.
5. **Pagination:** there are no paging headers; a page with exactly 500 rows means fetch the next. Add per-endpoint notes:
   - `spot-exposures/strike` returns ascending strikes; per-strike `price`/`time` can be hours stale.
   - OHLC is newest first.
   - `volatility/realized` semantics: `date` vs `unshifted_rv_date`.
6. **New endpoints:** `volatility/context`, `/distribution`, `/realized/windows`, `flex-options`.
7. **Blacklist additions:** `volatility/skew`, `volatility/surface`, `term-skew`, and `/api/socket/*` (not REST).
8. Mark `UW-CLIENT-API-ID` as re-verified not enforced, and the deprecations as unchanged (4).
9. Point to `api/_lib/uw-spot.ts` for spot.

Keep the existing structure.

- [ ] Commit (md only; no review subagent needed).
