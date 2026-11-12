# Server-side event-day flags on snapshots

**Goal:** `/api/snapshot` decides `is_event_day` and `event_names` itself from the
event sources, so a saved snapshot is right no matter which date the app is
showing or when the app's event list loaded. Then backfill history.

Owner decision 2026-11-11: the server decides (option "server" over "app").

Owner decision 2026-11-12: the stored flag is **macro-only**. `is_event_day` and
`event_names` on `market_snapshots`, and `is_event_day` on `training_features`, count
only the tracked FRED releases, FOMC and FOMC + SEP, and half days and closures
(`EARLY CLOSE`, `CLOSED`). Mega-cap earnings no longer count. `/api/events` and the
app's banner keep showing earnings, unchanged. Why: Finnhub's free key serves about one
month of past earnings, so earnings cannot be rebuilt for older dates. A macro-only
flag can be rebuilt exactly for any date, so live saves and the backfill always agree
and the ML feature means the same thing every day.

Correction 2026-11-12: two FRED release IDs in `TRACKED_RELEASES`
(`api/_lib/market-events.ts`) were wrong, each checked against the live FRED API
(`fred/release?release_id=<id>`).

- PPI was release 51, which is "U.S. International Trade in Goods and Services". The
  Producer Price Index is release **46**.
- JOLTS was release 110, which is "Personal Income by State". The Job Openings and Labor
  Turnover Survey is release **192**.
- The other five (10 CPI, 50 NFP, 53 GDP, 54 PCE, 9 Retail Sales) were right.
- Until the fix, `/api/events` and every stored PPI or JOLTS name marked trade-balance
  and state-income days and missed every real PPI and JOLTS day. The history backfill
  reads the corrected map, so its dry run moves those two names to the right days.
- The cache keys moved to `events:day:v3` and `events:v3`, so no entry built from the
  wrong IDs is served.

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
   - The stored PPI and JOLTS names are wrong: they came from the wrong release IDs (see
     the correction above), so they sit on trade-balance and state-income days. The
     other names did not depend on those two IDs.
   - Until now an event day was any event on the date, earnings and early close
     included.
   - Owner decision 2026-11-12: from here the definition is macro-only. Earnings no
     longer count, because Finnhub's free key cannot rebuild them for older dates (see
     the decision above). Early closes and closures still count.

## Design

### Shared event source (phase 1)

Move the event-building code out of `api/events.ts` into `api/_lib/market-events.ts`.
That covers the tracked FRED releases, FOMC and half-day statics, Finnhub earnings,
the sort, and the `complete` flag.

Exports:

- `fetchMacroEvents(startDate, endDate): Promise<{ events: EventItem[]; complete: boolean }>`
  (added 2026-11-12). The FRED releases plus the FOMC and half-day statics, sorted.
  - `complete` is true when a FRED key is set and every FRED release answered with a
    well-formed body.
  - A missing FRED key returns `complete: false` with the statics only. It does not throw.
  - It never calls Finnhub and never reads `FINNHUB_API_KEY`.
- `fetchMarketEvents(startDate, endDate): Promise<{ events: EventItem[]; complete: boolean }>`
  - It's `fetchMacroEvents` plus the Finnhub earnings, merged and sorted. Its output
    is the current `fetchAllEvents`, unchanged; `/api/events` uses it.
  - Finnhub is optional, as today. `complete` is macro complete and the earnings OK.
    With no FRED key it returns the statics plus the earnings (when a Finnhub key is
    set) with `complete: false`. It does not throw.
  - Finnhub results are clipped to the asked range, inclusive, as FRED's are. A stray
    row outside it would otherwise put a name on the wrong date.
- `getEventsForDate(date): Promise<DayEventsResult>`, where
  `DayEventsResult = { events: EventItem[]; complete: boolean } & { fromCache: boolean }`
  - It's `fetchMacroEvents(date, date)` behind a Redis cache under key
    `events:day:v3:{date}`. The key moved from v1 on 2026-11-12 because a v1 entry can
    hold earnings, and from v2 to v3 the same day because a v2 entry can name the wrong
    PPI and JOLTS days (see the correction above).
  - A complete result is cached for the same 7-day TTL as `/api/events`; an incomplete or
    rejected one for 5 minutes (see "Short cache for a failed lookup").
  - `fromCache` is true on a cache hit and false after a fetch.
  - A Redis read or write failure falls through to a fetch, as `/api/events` does today.
- `eventNamesForSnapshot(events): string[]`: the names of the macro events, in the
  order the sort gives, with duplicates kept. It drops events whose source is
  `finnhub`. It stays one function so the save and the backfill can't drift apart.
- `isEarningsEventName(name): boolean`: `/ Earnings$/`, which pairs with the
  `${symbol} Earnings` template that builds the earnings names. The snapshot save uses it
  to drop a client's earnings names, and the backfill report uses it to explain the
  removals.

`api/events.ts` keeps its URL, query parameter and response shape. Its cache key is
`events:v3:{startDate}:{days}` since the 2026-11-12 correction (it was `events:v2`). It only
calls `fetchMarketEvents`. The `EventItem` interface moves to the lib module, and
`api/events.ts` imports it from there.

### Snapshot save (phase 2)

`api/snapshot.ts` validates the body, then calls `getEventsForDate(date)`. The lookup
runs after the future-date and live-for-other-date skips, so a skipped request makes no
lookup.

- **Lookup complete:** store the server's names, which are macro-only.
  `is_event_day` = names non-empty. The client's `isEventDay` / `eventNames` are
  ignored, and stay in the schema so old clients still validate.
- **Lookup incomplete, or it throws:** store the union of the server's partial names
  and the client's names, server order first, then client-only names. A client name
  that `isEarningsEventName` matches is left out, because a live client's list comes
  from `/api/events` and carries earnings. `is_event_day` = union non-empty.
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
    with 30 s timeouts.
  - A replay saves about 24 times a minute, so 7 calls per save is about 170 FRED
    calls a minute, more than FRED's per-key limit allows.
  - The case is plausible: FRED can be down, or answer a malformed body, for a while.
  - So `getEventsForDate` caches an incomplete result for 5 minutes, under the same
    key, as `{ data, cachedAt, complete: false }`, and a hit returns it with
    `complete: false`.
  - A fetch that rejects caches `{ data: [], complete: false }` for 5 minutes, then
    rethrows.
  - A complete result still caches for 7 days. An entry without a `complete` field
    reads as complete.

### History backfill (phase 3)

Add `scripts/backfill-snapshot-event-flags.ts`, a thin CLI, with its logic in
`scripts/_lib/snapshot-event-flag-backfill.ts`.

- It reads every snapshot date (capped at today, ET), then calls
  `fetchMacroEvents` once per calendar month, in turn.
  - That's 7 FRED calls a month, not 7 a date: about 80 for the year, under FRED's
    per-key limit.
  - FRED is called with no throttle, about 7 calls a month. That stays under FRED's 120
    a minute up to about 17 months of history. Past that, pace the months. A 429 shows
    up as an incomplete-month refusal, which is safe.
  - Monthly, not one call for the whole range (ruling 2026-11-11, reason restated
    2026-11-12): the monthly chunks keep each fetch small and feed the whole-month
    0-event check below. They are no longer about Finnhub truncation, because the
    backfill does not call Finnhub.
- It refuses to run when:
  - any month's result is not `complete`;
  - the snapshot read returns 0 dates;
  - `FRED_API_KEY` is unset. That is the only key it needs.
- There is no `--keep-earnings` option. A stored earnings name is simply one the
  computed list lacks, so it is removed, by design. The dry run says so (see below).
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
    however many of its rows change). When an earnings name (`isEarningsEventName`) is
    among the losses, one line follows: `Earnings names are removed by design: the
    stored flag is macro-only (owner decision 2026-11-12).`;
  - every date that ends with no event flag having had one, with its old and new names;
  - the dates that gain a flag, as a count and a list;
  - the rows planned in each table, and the total.
- The apply is a production write: the owner runs or approves it after reading the dry run.
- Implementation notes:
  - The FRED key is checked first, before the database is read.
  - The snapshot read is paged by `id`, 5,000 rows a query. The write is one request
    with a statement per 500 rows.
  - Names travel as one JSON string per row (rows' arrays differ in length, and an SQL
    array of arrays must be rectangular). The guard compares `to_jsonb(event_names)`
    with the JSON read, so order and duplicates count in the guard even though they
    don't in the plan.
  - A date's feature flag follows the rows as they will be: set when any of its rows
    ends with a name.
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
- Phase 3 needs `FRED_API_KEY` in the shell that runs it. It is not in `.env.local`
  today. The owner supplies it; Claude never edits `.env*`.
- Finnhub is not used by the snapshot flag or the backfill. Its own spec
  (`https://finnhub.io/static/swagger.json`, `/calendar/earnings` `freeTier`) says "1
  month of historical earnings and new updates", so past earnings beyond about a month
  don't come back on the free key. That is why the stored flag is macro-only. The
  earnings decision is made (owner decision 2026-11-12). Finnhub still feeds
  `/api/events` and the banner.
- ML: `training_features.is_event_day` changes meaning (earnings no longer count), so
  experiments and plots made before the backfill are stale. PPI and JOLTS days were also
  mis-flagged until the 2026-11-12 ID correction (trade-balance and state-income days
  flagged, real PPI and JOLTS days missed), so the same applies to anything built from
  those flags.

## Constants

- Day cache: `events:day:v3:{date}`, TTL 7 days (`CACHE_TTL_SEC`, shared with `/api/events`).
- `/api/events` cache: `events:v3:{startDate}:{days}`, same TTL.
- FRED release IDs: 10 CPI, 50 NFP, 53 GDP, 54 PCE, 46 PPI, 9 Retail Sales, 192 JOLTS
  (PPI and JOLTS corrected 2026-11-12 from 51 and 110).
- Failed-lookup cache: the same key, TTL 5 minutes (`INCOMPLETE_CACHE_TTL_SEC`).
- Backfill: 5,000 rows per read page (`READ_PAGE`), 500 per UPDATE (`WRITE_CHUNK`),
  undo files in `docs/tmp/snapshot-event-flags/` (`UNDO_DIR`).
- `complete` (phase 1 ruling): for `fetchMacroEvents`, and so the day lookup, every FRED
  release answered with a well-formed body. `fetchMarketEvents` also needs Finnhub OK
  when a Finnhub key is set.
- The event-day definition is macro-only (owner decision 2026-11-12): any FRED release,
  FOMC or FOMC + SEP, early close or closure on the date. Earnings do not count.

## Open questions

- The `EventDayWarning` banner on past dates (it reads `liveEvents`, today forward).
  It's not in scope. Offered to the owner as a small follow-up.
