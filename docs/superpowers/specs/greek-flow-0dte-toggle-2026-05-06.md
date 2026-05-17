---
status: Likely Shipped
date: 2026-05-06
---

# Greek Flow — 0DTE/All-DTE Toggle (2026-05-06)

## Goal

Add a 0DTE-only data path to the SPY/QQQ Greek Flow panel alongside the existing all-DTE path, with a toggle to switch between them. 0DTE drives the verdict; all-DTE remains as context. Backfill 0DTE for the existing retention window so historical session reads work immediately.

**Why:** The current panel pulls the all-expiries variant of UW's greek-flow endpoint. For a 0DTE SPX trader using SPY/QQQ as a leading-indicator hunt, all-expiries flow blends LEAPS hedging, monthly OPEX positioning, and weekly rolls into the same cumulative line — diluting today's directional intent. Filtering to today's expiry isolates the speculation signal.

## Phases

### Phase 1 — DB schema + migration (1 file, ~30 LOC)

Extend `vega_flow_etf` with a nullable `expiry` column. Drop the old `(ticker, timestamp)` unique constraint, replace with `(ticker, timestamp, expiry)` using `NULLS NOT DISTINCT` so all-DTE rows (`expiry = NULL`) coexist with per-expiry rows. Add an index on `(ticker, date, expiry)` for the panel's per-scope queries.

Migration id 129.

**Verify:** `npm run lint`, `vitest api/__tests__/db.test.ts`. Both green.

### Phase 2 — Cron + upsert (3 files, ~80 LOC)

**[api/cron/fetch-greek-flow-etf.ts](api/cron/fetch-greek-flow-etf.ts):**

- Always fetch all-expiries for SPY + QQQ (existing behavior — `expiry = NULL` on insert).
- Determine today's 0DTE expiry for each ticker via `/api/stock/{ticker}/expiry-breakdown` (cached for the cron tick — one extra call per ticker on first invocation of the day, served from in-memory cache after).
- If today's date is in that ticker's expiry list, fetch the per-expiry variant and insert with `expiry = today`. If today is not an expiry day for that ticker, skip the per-expiry call (no wasted call).

**[api/\_lib/greek-flow-etf-store.ts](api/_lib/greek-flow-etf-store.ts):**

- Extend `GreekFlowTick` with `expiry?: string` (UW returns it on per-expiry rows; not read by the upsert — caller passes expiry explicitly so the same shape works for both feeds, but typed for caller validation).
- Extend `upsertGreekFlowTicks` to accept an `expiry: string | null` arg and pass through to the INSERT. ON CONFLICT clause adds `expiry` to the key.

**[api/**tests**/fetch-greek-flow-etf.test.ts](api/**tests**/fetch-greek-flow-etf.test.ts):**

- Add a test: cron on an expiry day fires 6 calls (2 expiry-breakdown + 2 all-DTE + 2 per-expiry). Cron on a non-expiry day fires 4 calls (2 expiry-breakdown + 2 all-DTE).
- Existing tests for all-DTE shape continue to pass.

**Verify:** `npm run review`. All green. Manually trigger cron in dev, confirm both scopes land in DB.

### Phase 3 — Read endpoint (2 files, ~40 LOC)

**[api/greek-flow.ts](api/greek-flow.ts):**

- Add `?scope=0dte|all` query param, default `0dte`.
- Pass scope through to `getGreekFlowSession`.
- Cumulative SUM partition becomes `PARTITION BY ticker, expiry` so 0DTE and all-DTE accumulate independently — but the read filters to the requested scope only, so the response shape is unchanged.

**[api/\_lib/db-greek-flow.ts](api/_lib/db-greek-flow.ts):**

- `getGreekFlowSession(date, scope)` — when `scope === '0dte'`, filter `WHERE expiry = date`. When `scope === 'all'`, filter `WHERE expiry IS NULL`.
- `resolveLatestGreekFlowDate` unchanged.

**[api/\_lib/validation.ts](api/_lib/validation.ts):** Extend `greekFlowQuerySchema` with an optional `scope` enum.

**Verify:** `npm run review`. Endpoint test for both scopes returns shape-identical responses with different cumulative values.

### Phase 4 — Backfill script (1 file, ~120 LOC)

**[scripts/backfill-greek-flow-etf-0dte.mjs](scripts/backfill-greek-flow-etf-0dte.mjs):**

- For each trading day in retention window (default: every date present in `vega_flow_etf` table), fetch `/api/stock/{ticker}/expiry-breakdown` to get that ticker's expiry list for that day. If the day appears as an expiry, call `/api/stock/{ticker}/greek-flow/{day}?date={day}` and upsert with `expiry = day`.
- Skip days where rows already exist with non-null expiry for that ticker (idempotent).
- Mirror the existing `scripts/backfill-darkpool.mjs` shape — argv parsing, dotenv, withRetry on UW calls, batch logging.

**Verify:** Run against last 5 trading days first as a smoke test. Spot-check one day's row count matches the all-DTE row count (should be roughly equal — same per-minute cadence). Then run for the full window.

### Phase 5 — Frontend toggle + verdict scoping (3 files, ~60 LOC)

**[src/hooks/useGreekFlow.ts](src/hooks/useGreekFlow.ts):**

- Add `scope: 'all' | '0dte'` arg, default `'0dte'`. Pass to `?scope=` query param.
- Polling logic unchanged.

**[src/components/GreekFlowPanel/index.tsx](src/components/GreekFlowPanel/index.tsx):**

- Pill toggle in `headerRight` next to the date picker: `[ 0DTE ] [ All DTE ]`.
- State held locally, default `'0dte'`. Toggle re-fetches via `useGreekFlow` arg change.
- Verdict (and VerdictTimeline) only renders for `'0dte'` scope. For `'all'` show a small caption "context only — no verdict" above the chart grid.

**[src/**tests**/components/GreekFlowPanel.test.tsx](src/**tests**/components/GreekFlowPanel.test.tsx):**

- Toggle changes the URL query param.
- Verdict tile is hidden when scope is `all`.

**Verify:** `npm run review` + dev server smoke test — toggle, watch the chart redraw, watch verdict appear/disappear.

### Phase 6 — Verification (no new files)

Full `npm run review` run. Manual smoke test against staging Vercel preview. Confirm cron metadata logs include the per-expiry counts. Backfill row counts match expected (~390 minutes/day × N expiry days × 2 tickers).

## Files

**Create:**

- `scripts/backfill-greek-flow-etf-0dte.mjs`

**Modify:**

- `api/_lib/db-migrations.ts` (add migration 129)
- `api/__tests__/db.test.ts` (mock + expected output for migration 129)
- `api/cron/fetch-greek-flow-etf.ts` (per-expiry fetch path)
- `api/_lib/greek-flow-etf-store.ts` (expiry passthrough)
- `api/__tests__/fetch-greek-flow-etf.test.ts` (mock sequence)
- `api/greek-flow.ts` (scope param)
- `api/_lib/db-greek-flow.ts` (scope filter)
- `api/_lib/validation.ts` (scope enum)
- `api/__tests__/endpoint-greek-flow.test.ts` (scope branching)
- `src/hooks/useGreekFlow.ts` (scope arg)
- `src/components/GreekFlowPanel/index.tsx` (toggle UI, verdict gating)
- `src/__tests__/components/GreekFlowPanel.test.tsx` (toggle test)

## Data dependencies

- **UW endpoints used:**
  - `GET /api/stock/{ticker}/greek-flow?date={today}` — existing all-DTE call.
  - `GET /api/stock/{ticker}/greek-flow/{expiry}?date={date}` — new per-expiry call.
  - `GET /api/stock/{ticker}/expiry-breakdown?date={date}` — new, used to determine if today is a valid expiry for SPY/QQQ. Cached per cron-tick to avoid duplicate calls.
- **No new env vars.** Reuses `UW_API_KEY`, `CRON_SECRET`.
- **No new tables.** Extends existing `vega_flow_etf`.

## Open questions

1. **Expiry caching strategy:** Vercel Functions are stateless across invocations, so true in-memory caching is meaningless. Three options: (a) no cache — fire `expiry-breakdown` every minute = ~1.6 sustained calls/min added on top of the existing 4 calls/min, well under UW Advanced's 1500 req/min ceiling; (b) Upstash KV with 24h TTL keyed by date = 1 lookup/day per ticker, adds Redis dependency + test mocking; (c) DB lookup against `vega_flow_etf` per cron tick = trades 1 UW call for 1 SELECT, comparable cost. **Default: option (a)**, given UW Advanced rate-limit headroom and the user's "most accurate route" preference (always-fresh expiry list with no staleness window). KV/DB caching is straightforward to add later if rate limits ever come into play.

2. **Backfill scope:** Backfill all dates currently in `vega_flow_etf`? Or only the last N days? **Default: all dates currently present, since the retention window is implicitly defined by what's there.**

3. **Per-expiry rate limit headroom:** UW Advanced is ~1500 req/min. New steady-state cost: 6 calls/min on expiry days, 4 on non-expiry. Trivial. No throttling needed.

4. **Backwards compat for the chart:** Existing `vega_flow_etf` rows have `expiry IS NULL`. After migration, the read endpoint defaults to scope=0dte, which filters to `expiry = date`. Until backfill completes, 0DTE view will be empty for historical dates. **Mitigation: ship migration + cron + backfill in the same commit. Frontend toggle ships in a follow-up commit once backfill finishes.**

## Thresholds / constants

- **Default scope:** `0dte` (the actionable view).
- **Default verdict scope:** 0DTE only. All-DTE renders as context.
- **Cron schedule:** unchanged — `* 13-21 * * 1-5` (every minute, market hours).
- **Backfill batch size:** 500 row UPSERTs per batch (mirrors existing greek-flow-etf-store).

## Done when

- [ ] Migration 129 applied; `vega_flow_etf` has `expiry` column with composite unique key.
- [ ] Cron logs both scopes' row counts on every invocation; non-expiry days log "skip per-expiry".
- [ ] Backfill script populates 0DTE rows for every existing date with rows in the table.
- [ ] `/api/greek-flow?scope=0dte` and `?scope=all` both return shape-identical responses with different cumulative values.
- [ ] Frontend toggle re-fetches and re-renders without a full page reload. Verdict appears under 0DTE only.
- [ ] `npm run review` green.
- [ ] Live test on next trading day: 0DTE chart shows tighter, more decisive flow than all-DTE; verdict actionable for the same minute.
