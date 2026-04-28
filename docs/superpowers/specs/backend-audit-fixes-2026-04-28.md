# Backend Audit Fixes — 2026-04-28

## Goal

Close the four highest-value findings from the 2026-04-28 backend audit:

1. **Sentry observability gaps** — silent failures in analyze-context-fetchers, schwab.ts token paths, anomaly-context runSafe, and Promise.allSettled cron rejection branches.
2. **Rule 8 weighting conflict** in the analyze prompt — user-turn labels in `analyze-context.ts` contradict the system-prompt thinking guidance in `analyze-prompts.ts`.
3. **Schwab token-refresh observability** — `storeTokens` exhaustion at `schwab.ts:129` and `getAccessToken` refresh-failure at `schwab.ts:392` are silent.
4. **Idempotency** on 5 high-volume tables that have no unique constraints — Vercel retries or `?force=1` re-runs produce duplicates that corrupt downstream detectors.

Source of truth for analyze prompt weightings: **`analyze-prompts.ts`** (Market Tide 30% / QQQ 25% / ETF Tide 20% / SPY 15% / SPX 10%). User-turn labels must be brought into agreement.

Skip / defer: whoami rate limit, callback error-body sanitization, CSP `unsafe-inline` styles, body-scrubbing in beforeSend, per-row INSERT batching, module splits, doc drift.

## Phases

### Phase 1 — Sentry observability (additive only, low risk)

Touch list:

- `api/_lib/analyze-context-fetchers.ts` — add `Sentry.captureException(err)` to all catch blocks. There are ~20 catch sites; every one currently calls `metrics.increment(...)` only. Keep existing log lines and metrics counters; add Sentry capture beneath them.
- `api/_lib/schwab.ts:129` — after the retry loop exits without returning, capture an explicit error so the "all attempts exhausted" branch alerts.
- `api/_lib/schwab.ts:392` — `getAccessToken` catch block currently swallows; add `logger.error` + `Sentry.captureException(err)` before returning the error union.
- `api/_lib/anomaly-context.ts` — `runSafe` helper (lines 171-185 region) must call `Sentry.captureException` in addition to `logger.warn`.
- `api/cron/fetch-flow.ts:106-137` — `Promise.allSettled` rejected branches currently `logger.warn` without Sentry. Add capture for each.
- `api/cron/fetch-greek-exposure.ts:148-158` — same pattern.
- `api/cron/fetch-futures-snapshot.ts:58-65` — same pattern.
- `api/futures/snapshot.ts:258-263` — same pattern.
- `api/cron/warm-tbbo-percentile.ts:36-53` — `allSettled` results checked for status but rejection reason never logged or captured.

Behavior change: **none**. Same return values, same DB writes, same cron success/failure semantics. Only Sentry receives more events.

Tests: existing tests must continue to pass. No new test files required (this is observability plumbing). If any existing test asserts on number-of-times Sentry was called, those assertions need updating; otherwise no test changes.

### Phase 2 — Rule 8 weighting fix (single edit)

Touch list:

- `api/_lib/analyze-context.ts:359-362` — change the user-turn flow-section labels:
  - SPX label: `(Rule 8, 50% weight)` → `(Rule 8, 10% weight)`
  - SPY label: `(Rule 8, 15% weight)` → `(Rule 8, 15% weight)` _(no change — already matches)_
  - QQQ label: `(Rule 8, 10% weight)` → `(Rule 8, 25% weight)`
- Add a Market Tide label note that includes its 30% weight if not already present in the Market Tide section.
- Verify the SPY ETF Tide and QQQ ETF Tide sections also reflect the 20% ETF Tide bucket from Rule 8.

Tests: any snapshot or string-match test on `analyze-context.ts` output needs updating to the new label text.

### Phase 3 — Idempotency on 5 high-volume tables

Touch list:

- `api/_lib/db-migrations.ts` — add migration **id: 98** that creates unique constraints on:
  - `strike_iv_snapshots` — `UNIQUE (ticker, strike, side, expiry, ts)`
  - `gamma_squeeze_events` — `UNIQUE (ticker, strike, side, expiry, ts)`
  - `iv_anomalies` — `UNIQUE (ticker, strike, side, expiry, ts)`
  - `strike_trade_volume` — `UNIQUE (ticker, strike, side, ts)`
  - `zero_gamma_levels` — `UNIQUE (ticker, ts)`

  Use `CREATE UNIQUE INDEX IF NOT EXISTS` (idempotent + non-blocking on small tables; for large ones consider CONCURRENTLY but Neon serverless does not support CONCURRENTLY inside a transaction — `IF NOT EXISTS` is sufficient). Existing duplicates (if any) will block index creation; the migration must include a pre-flight `DELETE` that keeps `MIN(id)` per duplicate group, or the index creation must use a different shape. **First check for duplicates** in a one-off probe before deciding the dedup strategy.

- `api/cron/fetch-strike-iv.ts:470, 794, 884` — add `ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING` to the three inserts (snapshots, squeeze events, anomalies).
- `api/cron/fetch-strike-trade-volume.ts:174` — add `ON CONFLICT (ticker, strike, side, ts) DO NOTHING`.
- `api/cron/compute-zero-gamma.ts:207` — add `ON CONFLICT (ticker, ts) DO NOTHING`.
- `api/__tests__/db.test.ts` — add `{ id: 98 }` to the applied-migrations mock, append migration 98 to the expected output list, and update the SQL call count (1 statement \* 5 unique-index creations = 5 sql calls, plus 1 INSERT into schema_migrations).
- Existing cron handler tests that mock `mockSql` for the affected handlers may need updated call count or args if they assert on the SQL string. Update minimally.

Open questions:

- For each table, are there existing duplicates that would prevent the unique index from being created? Probe before running. If duplicates exist, dedup with a CTE: `DELETE FROM <table> WHERE id NOT IN (SELECT MIN(id) FROM <table> GROUP BY <unique_cols>)` _inside_ the migration, before the index creation.
- For `strike_iv_snapshots` (~145K rows/day, retained for some time), the dedup may take a while on first run. Acceptable since it's a one-time cost.

## Verification

`npm run review` must pass after each phase. Final check at end of Phase 3.

## Skipped (per user direction)

- whoami rate limit
- callback error-body sanitization
- CSP `style-src 'unsafe-inline'`
- `event.request.body` scrub in beforeSend
- Length-pre-check timing oracle in guest-auth
- Per-row INSERT batching in 6 cron handlers
- Module splits (db-migrations, analyze-prompts, uw-deltas, etc.)
- Dead Zod-inferred types
- CLAUDE.md doc drift (cron count, table count, migration count, prompt size)
