# Regime 0DTE panel: stop off-day polling, fix the put-IV scan, soft-fail Neon blips

Date: 2026-11-15. Owner approved the fix in conversation ("yeah let's do that").

## Goal

Stop the 0DTE Gamma Regime panel from querying Neon when there is no session, make
its one slow query use an index, and have a brief Neon outage return the usual 503
"try again" instead of a 500 that pages Sentry.

## Why (evidence, all read-only)

1. **Off-day polling.** `inPollingWindow` in `src/hooks/useRegime0dte.ts` checks only
   the 08:30–15:00 CT clock, never the day. An open tab polls `/api/regime-0dte` every
   45 s (`POLL_INTERVALS.REGIME_0DTE`) on Saturdays, Sundays and holidays. That is the
   weekend daytime Neon load (about 1.25 CU) found during the 11-15 Neon floor review.
2. **The put-IV query is a full table scan.** `getPutIvSeries` filters
   `date(ts AT TIME ZONE 'America/Chicago') = X`, which no index can serve.
   `EXPLAIN ANALYZE` for 2026-11-13: a parallel seq scan of `strike_iv_snapshots`
   (about 92M rows, 1,225,682 blocks ≈ 9.4 GB read), **35.3 s**. The same query with
   the CT day written as a `ts` range (the `gexCtDayFilter` idiom) uses
   `idx_strike_iv_snapshots_ticker_ts`: 3,991 blocks, **0.32 s**, the same 399 rows.
   The two predicates are equivalent: `[X 00:00 CT, X+1 00:00 CT)` converted to
   instants is exactly the set where the CT calendar date is X. The panel runs this
   on every poll, and the nightly `capture-regime-0dte` cron runs it too.
   The other two queries are already fine: `getCandles30` 9 ms, `getGexStrikes`
   (midday anchor, cold) 170 ms.
3. **Neon blips page Sentry.** During the 11-15 19:08 UTC compute swap (about 9 s),
   `/api/regime-0dte` raised 4 Sentry errors. Its catch block always captures and
   returns 500, and its queries retry through `withRetry` (uw-fetch.ts, the UW/HTTP
   classifier) instead of `withDbRetry`. So a transient Neon error never becomes a
   `TransientDbError` and never takes the quiet 503 path.

## Approaches considered

- **Endpoint error handling.** (a) Swap only the catch block for
  `sendDbErrorResponse`. (b) Adopt `withDbReader(..., 'owner-or-guest')`, the
  CLAUDE.md standard for a GET single-JSON reader. **Picked (b):** it brings the
  Sentry scope and `endpoint` tag, the request metric, the 405 gate and the soft
  degrade in one wrapper, and the endpoint already fits its shape.
- **Polling gate.** (a) Add only a weekday check. (b) Use the shared market calendar
  in `src/data/marketHours.ts`: `isTradingDay` for weekends and holidays, and
  `getMarketCloseHourET` so a half-day stops at the 12:00 CT close. **Picked (b):**
  it is the one calendar the app and `api/` already share; (a) still polls on
  Thanksgiving and for three hours after a half-day close.
- **Put-IV query.** (a) A new index. (b) Rewrite the predicate as a sargable `ts`
  range over the existing `(ticker, ts DESC)` index. **Picked (b):** no migration,
  measured 110× faster, and identical rows.

## Phases (one commit each, in this order, one implementer at a time)

### Phase 1: backend (Vercel only)

- `api/_lib/regime-0dte-queries.ts`
  - `getPutIvSeries`: replace the `date(ts AT TIME ZONE …) = X` predicate with
    `ts >= ((X::date)::timestamp AT TIME ZONE 'America/Chicago') AND ts < (((X::date) + 1)::timestamp AT TIME ZONE 'America/Chicago')`.
    Builder's call: inline, or a small shared helper next to `gexCtDayFilter` in
    `api/_lib/gex-strike-day.ts` that `gexCtDayFilter` reuses. Don't copy the bound
    expression into two places.
  - All three helpers: `withRetry` (api-helpers → uw-fetch) → `withDbRetry`
    (`./db.js`), default retries, no per-attempt timeout. Drop the now-unused import.
- `api/regime-0dte.ts`: `export default withDbReader('/api/regime-0dte', 'regime_0dte', 'owner-or-guest', handler, { serverErrorBody: { error: 'Internal server error' } })`.
  The Zod 400 calls `done({ status: 400 })`, and the success path calls `done({ status: 200 })`
  before `res.json`. Remove the hand-rolled guard, the catch block and the imports they leave unused.
  Keep the 30 s edge cache and the response shape exactly as they are.
- Tests: `api/__tests__/regime-0dte-queries.test.ts` and
  `api/__tests__/regime-0dte-endpoint.test.ts` (see Acceptance).

### Phase 2: frontend

- `src/hooks/useRegime0dte.ts`: `inPollingWindow(now)` is true only when
  `isTradingDay(ctDate)` and `08:30 CT ≤ t < close`, where `ctDate = getCTDateStr(now)`
  and the close is `(getMarketCloseHourET(ctDate) − 1) × 60` CT minutes (ET is always
  CT + 1; normal days give 15:00 CT, half-days 12:00 CT). Import from
  `../data/marketHours.js`. Update the header comment.
- Test: `src/__tests__/useRegime0dte.test.ts`.
- The panel copy ("auto-updates between 08:30 and 15:00 CT") stays as it is.

## Acceptance

Phase 1:
- The put-IV SQL no longer contains `date(ts AT TIME ZONE`, and does contain the two
  `ts` bounds.
- A transient DB error (message matching `DB_RETRYABLE_RX`, e.g. `fetch failed`)
  from any helper gets retried, then the endpoint answers 503 with `Retry-After`, and
  `Sentry.captureException` is not called.
- A genuine error (e.g. `column "x" does not exist`) gets 500 with
  `{ error: 'Internal server error' }` and one Sentry capture.
- Non-GET gets 405. A bad `?date=` gets 400. Unauthenticated gets 401. Happy path
  unchanged.

Phase 2, with mocked clock and date:
- Saturday 10:00 CT: no fetch, `isWindowOpen=false`.
- 2026-11-26 (Thanksgiving) 10:00 CT: no fetch.
- 2026-11-27 (half-day, 13:00 ET close): open at 11:59 CT, closed at 12:00 CT.
- A normal weekday: open at 08:30 CT and at 14:59 CT, closed at 15:00 CT (existing
  behavior kept).

Both phases: `npm run review` green, `code-reviewer` pass, commit, fast-forward push
to `main`.

## Data dependencies

None: no migration, no env var, no new table. The index the rewrite relies on,
`idx_strike_iv_snapshots_ticker_ts (ticker, ts DESC)`, exists in production (checked
2026-11-15 via `pg_indexes`).

## Thresholds / constants

None new. Existing: poll 45 s, edge cache 30 s, `DB_RETRY_ATTEMPTS = 2`.

## Open questions

None blocking. Not in scope, noted for later: the unidentified ~5 min 15 s
weekend-night poller from the Neon review.
