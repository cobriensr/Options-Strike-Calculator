# Economic events: correct FOMC labels and repair history

**Status:** approved by the owner 2026-11-06 ("yes" to: classify narrowly, take
`is_fomc` from the Fed's schedule, backfill). Open questions below carry
default picks.

## Goal

Make `FOMC` mean the Fed's rate decision day. Today it means "any event that
mentions the Fed", while the real decision is labelled `OTHER`. So the analyze
prompt, the ML features and the Lottery MACRO badge all read the wrong days.
This spec fixes the classifier, takes `is_fomc` from the Fed's published
schedule, and repairs the stored history.

## Findings (read-only checks, 2026-11-06)

Inventory of production `economic_events`: 468 rows over 109 days,
2026-03-25 → 2026-11-06. Live UW probe of `GET /api/market/economic-calendar`
made the same day.

1. **The rate decision itself is labelled OTHER.** In September UW renamed it
   from "FOMC interest-rate decision" to "U.S. interest rate decision". The
   classifier (`api/cron/fetch-economic-calendar.ts:59-70`) has no rule for
   the new name, so the 09-16 and 10-28 decisions were stored as `OTHER`. On
   10-28 the analyze prompt showed the decision as `[MEDIUM]`.
2. **Every Fed mention is labelled FOMC.** `/FOMC|Federal Reserve|Fed/i` runs
   first and matches substrings, so:
   - about 95 speeches, testimony, minutes, Beige Book and panel rows are
     `FOMC`;
   - "Monthly U.S. federal budget" is `FOMC`;
   - the Philadelphia Fed and Kansas City Fed surveys are `FOMC`.
   - "FRB Chicago President … speaks" is `OTHER`, because "FRB" isn't matched.
3. **UW's September renames broke other labels too.**
   - "U. Michigan Prelim/Final Consumer Survey" is `OTHER`. Before the rename,
     "Consumer sentiment (prelim)" was `SENTIMENT`.
   - "ISM manufacturing", "ISM services" and the "Empire State" survey are
     `OTHER`. "ISM Report On Business … PMI" is `PMI`.
4. **UW's own `type` field (`fed-speaker | fomc | report`) is unreliable.**
   "Fed speech: Fed governor Michelle Bowman" comes back typed `report`. The
   classifier must keep classifying by name. The feed also returns every row
   twice (68 rows, 34 unique); `ON CONFLICT DO NOTHING` absorbs the duplicates.
5. **`training_features.is_fomc` is true on 51 days**, out of 214 rows from
   2026-01-02 to 2026-11-05. There are 7 real decision days in that range.
   - True by mistake on 2026-05-06, among many others.
   - False on 01-28 and 03-18, which predate the table; on 07-29, inside the
     gap in item 7; and on 10-28, which is labelled OTHER.
6. **`days_to_next_event` is off by about a day on every row.**
   - `build-features-phase2.ts:266-282` turns a DATE (returned as UTC
     midnight) into a JS `Date` and subtracts noon ET. A next-day event
     therefore gives `round(0.29) = 0`.
   - Live builds always get NULL, because the cron stores only today's events,
     so no later row exists at build time. Backfilled rows are populated:
     a train/serve skew.
7. **`economic_events` has no rows from 2026-07-22 to 2026-09-07.** The cause
   is unknown. UW's feed covers only the current and next week, so this can't
   be refilled from UW.
8. **Stored event flags from the old wrong static date (fixed on main in
   b432b00d):**
   - 2026-04-29: `market_snapshots` 71 rows with `is_event_day = false`,
     `event_names` `{}`/NULL;
   - 2026-05-06: 66 rows with `is_event_day = true`, `event_names = {FOMC}`;
   - `training_features.is_event_day` carries the same error: 04-29 false,
     05-06 true.
9. **`ws_gamma_setup_fires.is_fomc_day` is always false.**
   - `loadDayContext` takes `opts.isFomcDay`, but neither caller passes it:
     `api/cron/detect-gamma-setups.ts:68` and `api/gamma-setups/active.ts:170`.
   - So the "FOMC DAY" chip in `DayConfidenceBanner.tsx` never shows.
10. **`ml/src/setups_backtest/econ_calendar.csv` lists FOMC on 2025-05-01.** The
    Fed's decision day was 2025-05-07 (verify on the Fed's 2025 calendar
    page).

## Design

### Labels

The first matching rule wins:

| #   | Type                                         | Rule (by event name)                                                                                                                                        | Examples from the inventory                                                                                                                                                                                                 |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `FOMC`                                       | any "rate decision" (`\brate decision\b`), FOMC statement, Fed/FOMC press conference, economic projections                                                  | "U.S. interest rate decision", "FOMC interest-rate decision", "Fed rate decision", "FOMC rate decision", "Fed Chair Powell press conference", "Fed Chairman Warsh press conference", "Federal Reserve economic projections" |
| 2   | `PMI`                                        | a district name + "Fed" or "Fed's" + at most four whole words + "survey" or "index", unless the name has a speaker word; or the Empire State survey; or ISM | "Philadelphia Fed manufacturing survey", "Philadelphia Fed Business Outlook Survey", "Kansas City Fed Survey", "Empire State Manufacturing Survey", "ISM manufacturing", "ISM services"                                     |
| 3   | `FED` (see Q1)                               | any other Fed mention: word `Fed`, `FRB`, `Federal Reserve`, `FOMC`, `Federal Open Market Committee`, `Beige Book`                                          | speeches, testimony, panels, "Minutes of Fed's June FOMC meeting", "Federal Open Market Committee meeting minutes", "Fed Beige Book", "FRB Chicago President … speaks"                                                      |
| 4–9 | `CPI`, `PCE`, `JOBS`, `GDP`, `PMI`, `RETAIL` | today's rules, unchanged                                                                                                                                    |                                                                                                                                                                                                                             |
| 10  | `SENTIMENT`                                  | today's rule, plus "Michigan … Consumer"                                                                                                                    | "U. Michigan Prelim Consumer Survey"                                                                                                                                                                                        |
| 11  | `OTHER`                                      | everything else                                                                                                                                             | "Monthly U.S. federal budget", PPI, claims                                                                                                                                                                                  |

- `Fed` must match as a whole word, so "federal" never matches it.
- Rules 1 and 2 must run before rule 3.
- Rule 1 takes any "rate decision", not only "interest rate decision". A
  foreign central bank's decision is excluded from every rule-1 pattern
  (names that mention ECB, BoE, BoJ, Bank of England, Bank of Japan, Bank of
  Canada, RBA, RBNZ, SNB, PBOC, Riksbank or Norges Bank), so "ECB interest
  rate decision" is `OTHER`. Why: `is_fomc` ORs in `FOMC` rows, so a false
  `FOMC` flips the ML feature on a day the Fed is silent.
- Rule 2 bounds the gap by words, not characters, and a name with a speaker
  word (President, Governor, Chair, Chairman, Chairwoman, speaks, speech,
  remarks, testifies, panel) never matches it. "Philadelphia Fed President
  Anna Paulson speaks on Survey of Professional Forecasters" has five words
  between "Fed" and "Survey", and "Philadelphia Fed President Paulson speaks
  on survey" has four, so both stay `FED` (the second only because of the
  speaker word); "Dallas Fed Texas Service Sector Outlook Survey" has four, so
  it is `PMI`, as is "Atlanta Fed's Business Inflation Expectations survey".
- The classifier moves to a pure module, `api/_lib/economic-event-type.ts`
  (`classifyEconomicEvent(name: string): EconomicEventType`). It has two
  consumers: the cron and the backfill script.
- Its test is a table of real inventory names → expected type. It covers every
  example in the table above, plus one unchanged row for each of the other
  types.

### Fed schedule as the source of truth for `is_fomc`

- New module `api/_lib/fomc-schedule.ts`:
  - decision days 2025–2027, moved out of `api/events.ts` with no change in
    value;
  - the SEP set;
  - `isFomcDecisionDay(date: string): boolean`;
  - `isSepMeeting(date: string): boolean`.
    `api/events.ts` imports it.
- **Drift guard.** A test in the module's suite parses `FOMC_DATES` in
  `ml/src/options_features/calendar.py` and the FOMC rows of
  `ml/src/setups_backtest/econ_calendar.csv`.
  - It asserts that the Python dates for 2025–2027 equal the TS set.
  - It asserts that every csv FOMC date is a TS decision day.
  - It fails today on the csv's 2025-05-01, which the same phase fixes.

### Consumers

- **`addEventFeatures`** (`build-features-phase2.ts`; the rule lives in the
  exported `summarizeDayEvents`, which the phase 5 backfill reuses):
  - `is_fomc = isFomcDecisionDay(dateStr) || types.has('FOMC')` (controller's
    call 2026-11-06: OR with FOMC rows, to cover unscheduled decisions).
    - The schedule guarantees every scheduled meeting counts even with no
      rows (before the table existed, or in the 07-22..09-07 gap).
    - With the new classifier, only decision-type releases are typed `FOMC`,
      so a `FOMC` row on a non-decision day is an unscheduled decision.
  - `event_type` is `'FOMC'` when `is_fomc`; otherwise it's the first type
    found in this order: FOMC, CPI, PCE, JOBS, GDP, FED, PMI, RETAIL,
    SENTIMENT, OTHER. It's left unset when there are no rows and the day isn't
    a decision day.
  - `days_to_next_event` is computed in SQL as
    `(MIN(date) - ${dateStr}::date)`, an integer number of calendar days. It's
    left unset when no later row exists.
- **Analyze formatter** (`analyze-context-formatters.ts` `HIGH_SEVERITY_TYPES`):
  see Q1.
- **Gamma detector:**
  - `loadDayContext` sets `is_fomc_day: isFomcDecisionDay(today)` itself (the
    `opts.isFomcDay` parameter had no caller and is gone), so the cron and
    `api/gamma-setups/active.ts` need no change;
  - the backfill script (`scripts/backfill-gamma-setup-fires.ts`) does the same
    from each bar's date;
  - this turns on the dead "FOMC DAY" chip and starts storing true values.
- **Lottery MACRO badge** (`lottery-finder.ts`, `event_type IN
('FOMC','CPI','PCE','JOBS')`):
  - no code change;
  - it will now fire on real decision days only (see Q2).
- **Cron hardening** (`fetch-economic-calendar.ts`):
  - an event with an unparseable `time` currently throws inside the filter
    and fails the whole day's run;
  - instead, skip that event, log it with its name, and count it in the run
    metadata as `invalidTimeSkipped` (not an Axiom top-level key, so it lands
    in `meta`). A `null` time counts as unparseable (`new Date(null)` is the
    epoch, which would otherwise be dropped without a count);
  - the feed lists every row twice, so events are deduped on `(event, time)`
    first, and `invalidTimeSkipped` counts distinct events;
  - once per run, after the loop, when `invalidTimeSkipped > 0`: increment
    `fetch_economic_calendar.invalid_time` and send one Sentry warning,
    `fetch-economic-calendar: events with unparseable time skipped`, with
    `extra.skipped = [{ event, time }, …]` (the pattern in
    `fetch-etf-candles-1m.ts`). The per-event `logger.warn` stays;
  - run status: none skipped is `success`; some skipped is `partial` (the
    wrapper maps it to an ok check-in, so the Sentry warning is what alerts);
    every event skipped (and at least one event) is `error` with the message
    "all N events had unparseable times" (the wrapper maps it to an error
    check-in);
  - a 2xx body with no `data` array, or `data: null`, now fails the run (500
    and `Sentry.captureException`). Before, `uwFetch` turned it into `[]` with
    only a Sentry warning, and the cron reported a clean day with no events.

## Phases

One implementer, one worktree (`.worktrees/econ-fomc-labels`, branch
`fix/econ-fomc-labels`), one commit per phase. Starts after the calendar-2028
work (A) is pushed; rebase onto it first, since both touch `api/events.ts`.

1. **FOMC schedule module** (~1 h)
   - Create: `api/_lib/fomc-schedule.ts`, `api/__tests__/fomc-schedule.test.ts`
     (with the drift guard).
   - Modify: `api/events.ts`, `ml/src/setups_backtest/econ_calendar.csv`.
2. **Classifier** (~1.5 h)
   - Create: `api/_lib/economic-event-type.ts`,
     `api/__tests__/economic-event-type.test.ts`.
   - Modify: `api/cron/fetch-economic-calendar.ts` (use the classifier, plus
     the cron hardening).
   - Modify: `api/__tests__/fetch-economic-calendar.test.ts`. Flip the
     "FOMC Meeting Minutes" case, and add the invalid-time case.
   - The analyze formatter change (`api/_lib/analyze-context-formatters.ts`,
     `api/__tests__/analyze-context.test.ts`) landed here, in phase 2, not in
     phase 3.
3. **Consumers** (~1.5 h)
   - Modify: `api/_lib/build-features-phase2.ts`,
     `api/__tests__/build-features-phase2.test.ts`.
   - Modify `api/__tests__/build-features.test.ts` only if it pins the old
     priority.
4. **Gamma detector wiring** (~45 min)
   - The callers (`api/cron/detect-gamma-setups.ts`,
     `api/gamma-setups/active.ts`): no change needed; `loadDayContext` derives
     the flag.
   - Modify: `api/_lib/gamma-detector.ts`, `api/__tests__/gamma-detector.test.ts`,
     `scripts/backfill-gamma-setup-fires.ts`.
5. **Backfill script** (~1.5 h)
   - Created: `scripts/backfill-economic-event-labels.ts` (the thin CLI),
     `scripts/_lib/econ-label-backfill.ts` (the logic),
     `scripts/_lib/econ-label-backfill.test.ts` (plan and arguments) and
     `scripts/_lib/econ-label-backfill-pglite.test.ts` (real SQL). Follows
     the pattern of `scripts/backfill-anchor-legs.ts` and
     `scripts/_lib/anchor-backfill.ts`.
   - Dry run by default. Prints each table's before and after counts and every
     changed `economic_events` name.
   - `--apply` computes the plan up front and runs all writes in one
     `sql.transaction()`. The `unnest` writes go in chunks of 500 rows (R5).
     Every UPDATE is guarded by the value it changes, so a second `--apply`
     matches zero rows and opens no transaction.
   - Steps:
     1. `economic_events.event_type`: reclassify every row; update the
        changed ones, keyed on the primary key `id` (the unique key
        `(date, event_name, event_time)` can hold a NULL time, which never
        `=` itself).
     2. `training_features`: for every row, recompute `is_fomc`,
        `event_type` and `days_to_next_event` from the corrected rows plus the
        schedule.
        - A direct `UPDATE`, not the build-features upsert. The upsert's
          `COALESCE` can't clear stale values.
        - `event_count` doesn't change.
        - `days_to_next_event` is the gap to the next `economic_events` date
          after the row's own, so a row dated before the first event row
          (2026-03-25) gets the gap to that date. The dry run prints how many
          rows that is.
     3. `market_snapshots` and `training_features.is_event_day`. Use
        conditional updates guarded by the current values, so a second run
        changes nothing.
        - 2026-04-29 → `is_event_day = true`, `event_names = {FOMC}`.
        - 2026-05-06 → remove `FOMC` from `event_names`. Then set
          `is_event_day = cardinality(event_names) > 0`.
     4. `ws_gamma_setup_fires.is_fomc_day = true` for fires on decision days.
6. **Store the whole UW window** (pending the owner; see Q3)
   - Keep the current and next week, not just today.
   - Write with `ON CONFLICT … DO UPDATE` of forecast, previous, type and
     reported period.
   - This fixes the live `days_to_next_event` NULL and lets the MACRO badge see
     future events.
7. **Re-measure the MACRO lift** (pending the owner; see Q2)
   - A read-only study after the backfill.

**Production backfill** runs after the 15:00 CT close. It also runs after that
day's `build-features` post-close run (`45 20,21 * * 1-5` UTC; 15:45 CT in
winter), so that day's row is covered. Deploy first. Do not re-run
build-features with `?backfill=true` or `?date=` before step 1 of the script
has reclassified `economic_events`: rows stored under the old classifier still
carry `FOMC` on speech days, and build-features ORs `FOMC` rows into
`is_fomc`.

1. Dry run first (`npx tsx scripts/backfill-economic-event-labels.ts`); the
   controller reads the diff.
2. Then `--apply`
   (`npx tsx scripts/backfill-economic-event-labels.ts --apply`).
3. Then re-run the read-only inventory and confirm the expected counts:
   - `is_fomc` true on exactly the decision days in range;
   - no `FOMC` row whose name fails rule 1.

## Data dependencies

- No migration and no new env var.
- Tables written by the backfill:
  - `economic_events.event_type`;
  - `training_features`: `is_fomc`, `event_type`, `days_to_next_event` and
    `is_event_day`;
  - `market_snapshots` 2026-04-29 and 2026-05-06: `is_event_day` and
    `event_names`;
  - `ws_gamma_setup_fires.is_fomc_day`.
- External: none new. The Fed's calendar page is the source for the schedule.

## Open questions

**Q1. Fed speeches, minutes and the Beige Book: their own type, or OTHER?**

- The owner first approved OTHER.
- The catch: analyze Rule 12 (`analyze-prompts.ts:726`) hard-exits on "Fed
  speeches after 1:00 PM ET". As OTHER they would drop from `[HIGH]` to
  `[MEDIUM]` in the analyze prompt.
- **Resolved 2026-11-06:** owner chose `FED`, kept in `HIGH_SEVERITY_TYPES`.
  The analyze prompt reads Fed speeches, testimony, minutes and the Beige Book
  exactly as it does today. They leave `is_fomc` and the MACRO badge.

**Q2. The MACRO badge's lift figures were measured on the mislabelled data.**

- The figures: 72–168 h, 1.19× / 1.28×, N=57,533, in
  `LotteryFinderTickerGroup.tsx:34-41`.
- With nearly every day carrying a "FOMC" speech, the hours to the next macro
  event were almost always under 72.
- **Default:** re-run the 2026-05-16 EDA after the backfill (phase 7), then
  update or remove the figures.

**Q3. Store the whole UW window in the cron?**

- **Default:** yes (phase 6), since it fixes a diagnosed train/serve skew.
- It changes what the MACRO badge and live `days_to_next_event` see, so it
  waits for the owner's OK.

**Q4. The 2026-07-22 → 09-07 gap: answered (2026-11-06, read-only).**

- The gap isn't specific to this cron. Between 07-17 and 09-11:
  - `spot_exposures` has rows on 9 days and `dark_pool_prints` on 8;
  - `flow_data` has 32 and `training_features` 40.
- `economic_events` stops after 07-21 and resumes 09-08. That's the day
  88d73b1f removed our own 115/min UW self-throttle ("UW lifted its 120/min
  cap").
- Most likely cause: low-priority UW crons were starved by the throttle. That
  cause is already gone.
- No refill is possible from UW. The schedule-based `is_fomc` covers 07-29
  anyway.

## Constants

- FOMC decision days: `api/_lib/fomc-schedule.ts`. The values are the ones
  already on main in `api/events.ts` (2025–2027), checked against
  federalreserve.gov on 2026-11-06.
- `event_type` priority: FOMC, CPI, PCE, JOBS, GDP, FED, PMI, RETAIL,
  SENTIMENT, OTHER.
- Lottery MACRO types are unchanged: FOMC, CPI, PCE, JOBS.
