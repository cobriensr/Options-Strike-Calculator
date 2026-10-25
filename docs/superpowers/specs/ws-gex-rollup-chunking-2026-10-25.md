# WS GEX rollup: per-ticker chunks under a time budget (2026-10-25)

## Goal

Make the daily `ws_gex_strike_expiry` → `strike_exposures` rollup finish and
report its outcome, by copying one ticker per bounded statement under a time
budget instead of one multi-million-row statement.

## Evidence

WS-rolled rows in `strike_exposures` (rows with NULL delta) per day:

| Date                              | Rows  | Outcome                              |
| --------------------------------- | ----- | ------------------------------------ |
| 10-09                             | 3.12M | Succeeded                            |
| 10-14                             | 681K  | Succeeded (22 tickers)               |
| 10-12, 10-13, 10-20, 10-21        | 0     | `numeric field overflow` (Sentry HT) |
| 10-15, 10-16, 10-19, 10-22, 10-23 | 0     | No rows and no Sentry event          |

- **10-23 source existed.** 3.2M qualifying rows across 85 tickers (largest:
  SPX, 146K), all written by 16:14 ET. The rollup runs at 18:30 ET.
- **10-23 would have overflowed.** 3 of its rows exceed the `NUMERIC(20,4)`
  cap (max charm 1.09e16). The handler catches every error and reports it to
  Sentry, and nothing arrived, so the function was killed before the statement
  reached those rows.
- **Kill mechanism unconfirmed.** Candidates: the 120 s `maxDuration`, memory,
  or an oversized response. Vercel keeps runtime logs for one day on this plan,
  there are no log drains, Observability has no data for the project, and
  `pg_stat_statements` has no entry.

What the current single statement does:

- Filters on `(ts_minute AT TIME ZONE 'America/New_York')::date = $1`, which
  cannot use an index: a parallel seq scan of the 4.8 GB source (12 s for the
  read alone on 10-23, mostly cold).
- `RETURNING id` ships about 3.2M ids (~55 MB of JSON) to the function only to
  count them.
- Writes millions of rows into a 17 GB table carrying 7.5 GB of indexes in one
  transaction, so any failure loses the whole day.

Measured on production (read-only) for 10-23:

- Ticker list via index-only scan on `(ticker, expiry, ts_minute)`: 0.48 s.
- Per-ticker read with a sargable time range, SPX (141K rows): 0.93 s.

## Design (single phase)

1. **Ticker list.** `SELECT DISTINCT ticker FROM ws_gex_strike_expiry WHERE
expiry = $1::date AND ts_minute >= ($1::date::timestamp AT TIME ZONE
'America/New_York') AND ts_minute < (($1::date + 1)::timestamp AT TIME
ZONE 'America/New_York')`. Process SPX first: it feeds the SPXW heatmap.
   The `::timestamp` casts were added during implementation: without them
   `date AT TIME ZONE` resolves through date → timestamptz in the session
   zone, so under Neon's UTC sessions each bound lands 8 h (EDT) or 10 h
   (EST) before ET midnight. The PGlite test caught it and runs under UTC
   and a non-New-York session. `cleanup-ws-gex-strike-expiry` uses the
   uncast form for its cutoff (out of scope here; it only keeps extra rows).
2. **One statement per ticker.** The same column mapping and SPX → SPXW remap
   as today, with the sargable range above plus `ticker = $2`, `ON CONFLICT
(date, timestamp, ticker, strike, expiry) DO NOTHING`, and counting in the
   database: `WITH ins AS (INSERT ... RETURNING 1) SELECT count(*)::int FROM
ins`. No id payload reaches the function. Each ticker is atomic.
3. **Failure isolation.** A ticker's error is captured to Sentry (tagged with
   the ticker) and the loop continues. If any ticker failed, the run does not
   report success (R4).
4. **Time budget.** `maxDuration` 120 → 300 (`vercel.json` and the handler's
   `config`). Stop starting new tickers once 240 s have elapsed. Tickers left
   unstarted are deferred: one `Sentry.captureMessage` warning with a stable
   fingerprint, and listed in the result. Follows `evaluate-round-trip`.
5. **Check-ins.** Wrap the handler in `withCronInstrumentation`
   (`marketHours: false`, `requireApiKey: false`) so a kill shows up as a
   Sentry monitor timeout instead of silence.
6. **Date override.** `?date=YYYY-MM-DD`, strictly validated and not in the
   future, defaulting to today, to re-run a missed day while the source still
   holds it. Follows `archive-gexbot`'s `buildPlan`.

### Files

- `api/_lib/rollup-ws-gex-strike-expiry.ts`
- `api/cron/rollup-ws-gex-strike-expiry.ts`
- `vercel.json` (`maxDuration`)
- `api/__tests__/rollup-ws-gex-strike-expiry.test.ts`
- A PGlite test proving the sargable per-ticker filter selects exactly the rows
  the old filter did, at ET-day boundaries in both DST regimes, and that the
  remap and server-side count hold.

### Recovery of 10-23

`cleanup-ws-gex-strike-expiry` deletes 10-23's source at 12:00 UTC Monday
10-26. Before then, in order: apply migration #191
(`gex-numeric-overflow-2026-10-25.md`), deploy this change, then call
`GET /api/cron/rollup-ws-gex-strike-expiry?date=2026-10-23` with the
`CRON_SECRET` bearer. Without #191, SPX's chunk fails on its 3 over-cap rows
while the other tickers land.

## Out of scope

- A second scheduled run to retry deferred tickers automatically. One run of
  85 tickers fits the budget by a wide margin; a deferral warns.
- Re-copying 10-12 through 10-22: their source is already purged.

## Thresholds

- `maxDuration`: 300 s
- Budget for starting a new ticker: 240 s
- Order: SPX first, then the rest
