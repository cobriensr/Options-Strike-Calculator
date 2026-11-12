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
  - A missing FRED key returns `complete: false` with the static events, plus the
    earnings when a Finnhub key is set. It does not throw.
  - Finnhub results are clipped to the asked range, inclusive, as FRED's are. A stray
    row outside it would otherwise put a name on the wrong date.
- `getEventsForDate(date): Promise<DayEventsResult>`, where
  `DayEventsResult = { events: EventItem[]; complete: boolean } & { fromCache: boolean }`
  - It's `fetchMarketEvents(date, date)` behind a Redis cache under key `events:day:v1:{date}`.
  - A complete result is cached for the same 7-day TTL as `/api/events`; an incomplete or
    rejected one for 5 minutes (see "Short cache for a failed lookup").
  - `fromCache` is true on a cache hit and false after a fetch.
  - A Redis read or write failure falls through to a fetch, as `/api/events` does today.
- `eventNamesForSnapshot(events): string[]`: the event names in the order the
  sort gives. It stays one function so the save and the backfill can't drift apart.

`api/events.ts` keeps its URL, query parameter, cache key and response shape. It only
calls `fetchMarketEvents`. The `EventItem` interface moves to the lib module, and
`api/events.ts` imports it from there.

### Snapshot save (phase 2)

`api/snapshot.ts` validates the body, then calls `getEventsForDate(date)`. The lookup
runs after the future-date and live-for-other-date skips, so a skipped request makes no
lookup.

- **Lookup complete:** store the server's names. `is_event_day` = names non-empty.
  The client's `isEventDay` / `eventNames` are ignored, and stay in the schema so old
  clients still validate.
- **Lookup incomplete, or it throws:** store the union of the server's partial names
  and the client's names, server order first, then client-only names.
  `is_event_day` = union non-empty.
  - Count `metrics.increment('snapshot.event_lookup_incomplete')` on every such save.
  - Log a warning and send a Sentry warning (`snapshot: event lookup incomplete`, the
    date as an extra) once per fetch, not once per save: when the lookup threw, or the
    result was incomplete and `fromCache` is false. A replay saves about 24 times a
    minute and the failure entry is served for 5 minutes, so warning on every save
    would send about 120 Sentry events per failure window.
  - The save still succeeds. A FRED outage must not lose snapshots, and the union is
    never worse than today's client value.
- One lookup per request. No new env var.
- **Short cache for a failed lookup** (ruling 2026-11-11, from the phase 1 review).
  - Without it, a lookup that keeps failing is repaid on every save: 7 FRED calls
    with 30 s timeouts, plus Finnhub.
  - A replay saves about 24 times a minute, so 7 calls per save is about 170 FRED
    calls a minute, more than FRED's per-key limit allows.
  - The case is plausible: Finnhub may refuse past ranges, which phase 1 counts as
    incomplete.
  - So `getEventsForDate` caches an incomplete result for 5 minutes, under the same
    key, as `{ data, cachedAt, complete: false }`, and a hit returns it with
    `complete: false`.
  - A fetch that rejects caches `{ data: [], complete: false }` for 5 minutes, then
    rethrows.
  - A complete result still caches for 7 days. An entry without a `complete` field
    (written by phase 1) reads as complete.

### History backfill (phase 3)

Add `scripts/backfill-snapshot-event-flags.ts`, a thin CLI, with its logic in
`scripts/_lib/snapshot-event-flag-backfill.ts`.

- It reads every snapshot date (capped at today, ET), then calls
  `fetchMarketEvents` once per calendar month, in turn.
  - That's 7 FRED calls a month, not 7 a date: about 80 for the year, under FRED's
    per-key limit.
  - FRED is called with no throttle, about 7 calls a month. That stays under FRED's 120
    a minute up to about 17 months of history. Past that, pace the months. A 429 shows
    up as an incomplete-month refusal, which is safe.
  - Ruling 2026-11-11: monthly, not one call for the whole range. One Finnhub call
    for a year of every US earnings release risks a truncated answer, and a
    truncated answer would silently drop mega-cap earnings.
- It refuses to run when:
  - any month's result is not `complete`;
  - the snapshot read returns 0 dates;
  - `FRED_API_KEY` or `FINNHUB_API_KEY` is unset. Without Finnhub, the list is
    "complete" with no earnings, and the run would strip every stored earnings name.
- `--keep-earnings` keeps a stored name ending in ` Earnings` that the computed list
  lacks. The owner picks it after the dry run if Finnhub turns out not to return
  past earnings. It's off by default.
- For each row it compares the stored names to the computed names as **sets**, so
  order alone never causes a write. NULL counts as empty.
  - A row is written when the sets differ, or when `is_event_day` differs from
    "computed names non-empty".
  - The write is per row, in `unnest` batches of 500. Each row is guarded on the
    values it was read with (`event_names IS NOT DISTINCT FROM old AND
    is_event_day IS NOT DISTINCT FROM old`), so a save that lands mid-run is never
    overwritten.
- `training_features.is_event_day` follows: computed names non-empty, guarded by
  `IS DISTINCT FROM`. Only snapshot dates are read; a date with no
  `training_features` row is skipped.
- It's a dry run by default. `--apply` writes an undo file under
  `docs/tmp/snapshot-event-flags/` first, then runs one `sql.transaction`.
  - The undo file is `undo-{timestamp}.json`. It holds each planned row's `id` and old
    `is_event_day` / `event_names`, and each planned feature row's `date` and old flag.
    No restore script is built; it is the record to restore from.
  - A guarded row that no longer matches is skipped and listed in the report. A second
    run right after the apply plans 0 writes.
- The dry run prints:
  - the database host;
  - the months fetched;
  - per event name, the number of **days** gaining and losing it (a day counts once,
    however many of its rows change);
  - every date that ends with no event flag having had one, with its old and new names;
  - the dates that gain a flag, as a count and a list;
  - the rows planned in each table, and the total.
- The apply is a production write: the owner runs or approves it after reading the dry run.
- Implementation notes:
  - The keys are checked first, before the database is read.
  - The snapshot read is paged by `id`, 5,000 rows a query. The write is one request
    with a statement per 500 rows.
  - Names travel as one JSON string per row (rows' arrays differ in length, and an SQL
    array of arrays must be rectangular). The guard compares `to_jsonb(event_names)`
    with the JSON read, so order and duplicates count in the guard even though they
    don't in the plan.
  - With `--keep-earnings`, a kept name is added per row, and a date's feature flag
    follows the rows as they will be: set when any of its rows ends with a name.
  - A date "has a flag" when any of its rows has `is_event_day` true or a name.
  - The report prints `WARNING: 0 events` beside a whole calendar month with none: CPI
    and NFP alone make that impossible, so the payload is bad. It warns and does not stop.
  - A failed apply throws an error that names the undo file already written. A skipped
    row prints a warning that says to re-run, dry run first; the exit code stays 0.
- It overlaps the econ label backfill's snapshot steps: 04-29 gains FOMC, and 05-06
  loses it.
  - Both compute from the corrected FOMC schedule.
  - Both guard every write on the values they read, so whichever runs second finds
    nothing to change on those dates. That holds for the FOMC names only: if the econ
    backfill runs first, this one can still add other events' names on 04-29.

## Phases

| #   | Scope                                                                   | Files                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shared event source, `/api/events` refactor (no behavior change)        | `api/_lib/market-events.ts` (new), `api/events.ts`, `api/__tests__/market-events.test.ts` (new), `api/__tests__/events.test.ts`                                           |
| 2   | Snapshot save uses the server's events; short cache for a failed lookup | `api/_lib/market-events.ts`, `api/__tests__/market-events.test.ts`, `api/snapshot.ts`, `api/__tests__/snapshot.test.ts`, `api/_lib/validation/snapshot.ts` (comment only) |
| 3   | History backfill script                                                 | `scripts/backfill-snapshot-event-flags.ts`, `scripts/_lib/snapshot-event-flag-backfill.ts`, its unit + pglite + CLI tests, `tsconfig.scripts.json`, `scripts/README.md`   |

Each phase gets `npm run review`, a code review, then commits of 5 files or fewer.

## Data dependencies

- No migration, table or env var.
- Phase 3 needs `FRED_API_KEY`, plus `FINNHUB_API_KEY` for earnings, in the shell that
  runs it. Neither is in `.env.local` today. The owner supplies them; Claude never
  edits `.env*`.
- Finnhub's own spec (`https://finnhub.io/static/swagger.json`, `/calendar/earnings`
  `freeTier`) says "1 month of historical earnings and new updates". Past earnings
  beyond about a month don't come back on the free key. How history treats earnings
  is an open owner decision (2026-11-12).

## Constants

- Day cache: `events:day:v1:{date}`, TTL 7 days (`CACHE_TTL_SEC`, shared with `/api/events`).
- Failed-lookup cache: the same key, TTL 5 minutes (`INCOMPLETE_CACHE_TTL_SEC`).
- Backfill: 5,000 rows per read page (`READ_PAGE`), 500 per UPDATE (`WRITE_CHUNK`),
  undo files in `docs/tmp/snapshot-event-flags/` (`UNDO_DIR`).
- `complete` (phase 1 ruling) means every FRED release answered with a well-formed
  body, and so did Finnhub if a Finnhub key is set.
- The event-day definition is unchanged: any event on the date.

## Open questions

- The `EventDayWarning` banner on past dates (it reads `liveEvents`, today forward).
  It's not in scope. Offered to the owner as a small follow-up.
- Earnings for past dates in the backfill: see Data dependencies.
