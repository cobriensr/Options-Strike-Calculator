# Event-flag follow-ups (2026-11-12)

**Goal:** fix the bugs that the dry run of the event-flag history backfill turned up, then repair the stored history once, so the event flags, the closed-day data and the ML feature row are all correct.

Parent spec: `2026-11-11-server-side-event-day-flags.md`. The owner asked for all of it ("lets fix all these bugs and things found", 2026-11-12).

## Findings

Each was verified against production or the live FRED API, read-only.

1. **Wrong FRED release IDs.**
   - "PPI" used release 51, which is U.S. International Trade. PPI is 46.
   - "JOLTS" used release 110, which is Personal Income by State. JOLTS is 192.
   - So `/api/events`, the banner and the stored flag marked trade-balance and state-income days, and missed every real PPI and JOLTS day.
2. **Rows on closed days.** 13 non-trading dates hold 187 `market_snapshots` rows: holidays 01-01, 04-03, 05-25 and 07-03, plus weekends, including Sundays 05-03, 06-07 and 07-19 with 31, 55 and 77 rows. `training_features` has one row on Good Friday 04-03.
   - `POST /api/snapshot` has no trading-day check.
   - `build-features` checks only on its scheduled path.
3. **The feature row is sampled at a different time each day.** `build-features` picks the day's snapshot with a text `ORDER BY entry_time`, so "10:00 AM CT" sorts before "8:30 AM CT". In production it picks 10:00 AM on 83 dates, pre-market on 40, 11:05 AM on 31, and others on the rest.
   - It also copies `is_event_day` from that one row.
4. **Past dates show no events.** The banner, the client signals and the analyze context filter today's forward `/api/events` list, so a backtest or replay date always looks event-free.
5. **`scripts/calendar_context_analysis.py` matches stale UW names.** It misses the renamed rate decision, CPI and NFP, and it swallows DB errors into a stale fallback.

## Decisions

- **Feature sample (owner, 2026-11-12):** every date uses the snapshot nearest 10:00 AM CT (600 CT minutes) that has an SPX open. A tie goes to the earlier row.
- **`is_event_day` in features:** `bool_or` over all of the date's snapshot rows.
- **Closed days:**
  - `/api/snapshot` answers `200 { saved: false, skipped: 'non-trading-day' }`. It logs a warning for both live and backtest saves, and reports to Sentry only for live saves (b84a1d70).
  - `build-features` filters every date list with `isTradingDay`.
- **`/api/events`** takes an optional `from` date, bounded to 2025-01-01 .. today + 90, so past dates fetch their own events. Earnings stay in the banner (parent spec).
  - A `from` lookup that misses the cache is limited to 30 a minute per IP (429); the default request is never limited.
  - The limit was 10 while a miss cost 7 FRED calls. Each FRED release's date list is now cached in Redis for 12 hours (`fred:release-dates:v1:<releaseId>`), so a miss costs one Finnhub call, plus at most 7 FRED calls when a list is cold. Finnhub's free key allows 60 calls a minute, and the default request shares it.
- **Unknown events are not "none" (owner, 2026-11-13):** a date whose events aren't known (its own fetch is waiting or failed, or the forward list never loaded) no longer reads as a quiet day.
  - The banner shows "Events for this date couldn't load." with a Retry button when the fetch failed, and nothing while it loads. There is no automatic retry: `useFetchedData` reports a 429 only as `HTTP 429` and drops `Retry-After`.
  - The analyze context keeps `events: []` and adds `eventsUnknown: true`, only then. The prompt line reads `Scheduled events: UNKNOWN (this date's event list did not load; do not assume there are none)`. A known list, and a cached PWA client that never sends the flag, still print `NONE`.
  - The line is in the per-request context, outside the cached system prompt.
- **The client still sends its event names.** Once past dates fetch their own events, the server's incomplete-lookup fallback works on replays too.
- **The analysis script** takes its FOMC days from the Fed schedule (owner, 2026-11-06), CPI from `event_type = 'CPI'`, and NFP from `JOBS` employment-report rows without ADP. A DB error stops the script.
- **Out of scope:** `analyze-prompts.ts:725` mentions `isEventDay`. The analyze prompt is the owner's to rework; this is flagged only.

## Phases

One implementer at a time, each reviewed, gated and committed.

| Phase | Change | Files |
|---|---|---|
| A | FRED IDs 46/192, cache keys to v3, ID-pinning test | `api/_lib/market-events.ts`, `api/events.ts`, two tests, parent spec |
| B | Snapshot closed-day guard; build-features date filter, `bool_or`, 10:00 AM CT sample | `api/snapshot.ts`, `api/cron/build-features.ts`, two tests, this doc |
| C | `/api/events?from=` with a Zod query schema | `api/events.ts`, a validation schema, tests |
| D | `useEventsForDate`, wired into the banner, signals and analyze context | new hook and its test, `src/App.tsx` |
| E | Calendar script fix and its first tests | `scripts/calendar_context_analysis.py`, new `scripts/test_calendar_context_analysis.py` |

## Data repair

This runs after the close, once build-features has run (~15:45 CT), with phases A–B deployed. Each step writes a JSON backup or undo file under `docs/tmp/` first.

1. Delete the 187 closed-day `market_snapshots` rows (no FK children) and the 04-03 `training_features` row.
2. Event-flag backfill (`scripts/backfill-snapshot-event-flags.ts`): dry run, check it, then `--apply`.
3. Econ FOMC-label backfill (`scripts/backfill-economic-event-labels.ts`): dry run, then `--apply`.
4. Rebuild `training_features` for every date (the build-features backfill), so the 10:00 AM CT sample and `bool_or` reach history.
5. Re-run both dry runs (expect 0 changes) and spot-check a few rebuilt feature rows.

ML results computed before step 4 are stale: the event flag, `is_fomc` and the sampled columns all change.
