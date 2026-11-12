# Server-side event-day flags on snapshots

**Goal:** `/api/snapshot` decides `is_event_day` and `event_names` itself from the
event sources, so a saved snapshot is right no matter which date the app is
showing or when the app's event list loaded. Then backfill history.

Owner decision 2026-11-11: the server decides (option "server" over "app").

## Findings

1. **Past dates always save as non-event days.** `useRangeAnalysis.ts:184` takes the
   selected date's events from `liveEvents`. That list comes from
   `/api/events?days=30`, which returns today forward only (`api/events.ts:456-461`).
   - A replay or backtest save of any past date finds nothing and stores
     `is_event_day = false, event_names = []`.
   - 132 of 198 snapshot dates have backtest rows. 164 dates have no flagged row at all.
2. **Live first-save race.** On live days, about one row per date was unflagged even
   before any replay: the day's first save landed before `/api/events` returned.
3. **The client flag has one consumer:** the snapshot save (`useSnapshotSave.ts:390-391`).
   - `EventDayWarning` reads `liveEvents` directly.
   - build-features copies `is_event_day` from the day's first snapshot row
     (`api/cron/build-features.ts:106,137`).
4. **The 11-07/08 replay cleared 20 event days.** 19 were restored 2026-11-11 from the
   replay's backups, outside this spec (script and undo file in
   `docs/tmp/event-flag-restore/`). 05-06 was skipped: its "FOMC" was the mislabel
   the econ label backfill removes.
5. **FRED returns past release dates by default.** `fred/release/dates` defaults
   `realtime_start` to 1776-07-04 and `limit` to 10000 (FRED docs, read 2026-11-11).
   `/api/events` filters to `startDate..endDate` itself, so a past range needs no new
   FRED parameter.
6. **Stored names to date:** GDP, Retail Sales, NFP, PCE, CPI, PPI, FOMC + SEP, JOLTS,
   FOMC, NVDA Earnings, CLOSED.
   - Earnings are part of today's definition: an event day is any event on the date,
     earnings and early close included.
   - This spec keeps that definition unchanged.

## Design

### Shared event source (phase 1)

Move the event-building code out of `api/events.ts` into `api/_lib/market-events.ts`.
That covers the tracked FRED releases, FOMC and half-day statics, Finnhub earnings,
the sort, and the `complete` flag.

Exports:

- `fetchMarketEvents(startDate, endDate): Promise<{ events: EventItem[]; complete: boolean }>`
  - It's the current `fetchAllEvents`, unchanged in behavior.
  - Keys are read from `process.env` inside: FRED required, Finnhub optional, as today.
  - A missing FRED key returns `complete: false` with the static events only. It does not throw.
- `getEventsForDate(date): Promise<{ events: EventItem[]; complete: boolean }>`
  - It's `fetchMarketEvents(date, date)` behind a Redis cache under key `events:day:v1:{date}`.
  - It writes the cache only when `complete`, with the same 7-day TTL as `/api/events`.
  - A Redis read or write failure falls through to a fetch, as `/api/events` does today.
- `eventNamesForSnapshot(events): string[]`: the event names in the order the
  sort gives. It stays one function so the save and the backfill can't drift apart.

`api/events.ts` keeps its URL, query parameter, cache key and response shape. It only
calls `fetchMarketEvents`. The `EventItem` interface moves to the lib module, and
`api/events.ts` imports it from there.

### Snapshot save (phase 2)

`api/snapshot.ts` validates the body, then calls `getEventsForDate(date)`.

- **Lookup complete:** store the server's names. `is_event_day` = names non-empty.
  The client's `isEventDay` / `eventNames` are ignored, and stay in the schema so old
  clients still validate.
- **Lookup incomplete, or it throws:** store the union of the server's partial names
  and the client's names, server order first, then client-only names.
  `is_event_day` = union non-empty.
  - Record `metrics.increment('snapshot.event_lookup_incomplete')` and a Sentry
    warning (`snapshot: event lookup incomplete`), with the date as an extra.
  - The save still succeeds. A FRED outage must not lose snapshots, and the union is
    never worse than today's client value.
- One lookup per request. No new env var.

### History backfill (phase 3)

Add `scripts/backfill-snapshot-event-flags.ts`, a thin CLI, with its logic in
`scripts/_lib/snapshot-event-flag-backfill.ts`.

- It reads every snapshot date, then calls `fetchMarketEvents(min, max)` once. That's
  one FRED call per release, not one per date.
- It refuses to run unless the result is `complete`, and refuses when the snapshot
  read returns 0 dates.
- For each date it compares each row's names to the computed names as **sets**, so
  order alone never causes a write.
  - Where the sets differ, a guarded UPDATE sets the computed names and the flag:
    `WHERE date = $d AND event_names IS DISTINCT FROM $computed`, with `unnest`
    batches if it's per row.
- `training_features.is_event_day` follows: computed names non-empty, guarded by
  `IS DISTINCT FROM`.
- It's a dry run by default. `--apply` writes an undo file under
  `docs/tmp/snapshot-event-flags/` first, then runs one `sql.transaction`.
- The dry run prints:
  - the database host;
  - per-name counts of days gained and lost;
  - every date that loses a flag, with its old and new names;
  - row totals for both tables.
- The apply is a production write: the owner runs or approves it after reading the dry run.

## Phases

| # | Scope | Files |
|---|---|---|
| 1 | Shared event source, `/api/events` refactor (no behavior change) | `api/_lib/market-events.ts` (new), `api/events.ts`, `api/__tests__/market-events.test.ts` (new), `api/__tests__/events.test.ts` |
| 2 | Snapshot save uses the server's events | `api/snapshot.ts`, `api/__tests__/snapshot.test.ts`, `api/_lib/validation/snapshot.ts` (comment only, if needed) |
| 3 | History backfill script | `scripts/backfill-snapshot-event-flags.ts`, `scripts/_lib/snapshot-event-flag-backfill.ts`, its unit + pglite + CLI tests, `tsconfig.scripts.json`, `scripts/README.md` |

Each phase gets `npm run review`, a code review, then commits of 5 files or fewer.

## Data dependencies

- No migration, table or env var.
- Phase 3 needs `FRED_API_KEY`, plus `FINNHUB_API_KEY` for earnings, in the shell that
  runs it. Neither is in `.env.local` today. The owner supplies them; Claude never
  edits `.env*`.
- The Finnhub earnings calendar for past dates is unverified: there's no local key.
  The phase 3 dry run's per-name counts show whether earnings come back. If they
  don't, earnings days stay as stored and the owner decides.

## Constants

- Day cache: `events:day:v1:{date}`, TTL 7 days (`CACHE_TTL_SEC`, shared with `/api/events`).
- The event-day definition is unchanged: any event on the date.

## Open questions

- The `EventDayWarning` banner on past dates (it reads `liveEvents`, today forward).
  It's not in scope. Offered to the owner as a small follow-up.
- Earnings for past dates in the backfill: see Data dependencies.
