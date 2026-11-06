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
9. **`gamma_setup_fires.is_fomc_day` is always false.**
   - `loadDayContext` takes `opts.isFomcDay`, but neither caller passes it:
     `api/cron/detect-gamma-setups.ts:68` and `api/gamma-setups/active.ts:170`.
   - So the "FOMC DAY" chip in `DayConfidenceBanner.tsx` never shows.
10. **`ml/src/setups_backtest/econ_calendar.csv` lists FOMC on 2025-05-01.** The
    Fed's decision day was 2025-05-07 (verify on the Fed's 2025 calendar
    page).

## Design

### Labels

The first matching rule wins:

| # | Type | Rule (by event name) | Examples from the inventory |
|---|---|---|---|
| 1 | `FOMC` | rate decision, FOMC statement, Fed/FOMC press conference, economic projections | "U.S. interest rate decision", "FOMC interest-rate decision", "Fed Chair Powell press conference", "Fed Chairman Warsh press conference", "Federal Reserve economic projections" |
| 2 | `PMI` | a regional Fed survey or index, or the Empire State survey, or ISM | "Philadelphia Fed manufacturing survey", "Philadelphia Fed Business Outlook Survey", "Kansas City Fed Survey", "Empire State Manufacturing Survey", "ISM manufacturing", "ISM services" |
| 3 | `FED` (see Q1) | any other Fed mention: word `Fed`, `FRB`, `Federal Reserve`, `FOMC`, `Federal Open Market Committee`, `Beige Book` | speeches, testimony, panels, "Minutes of Fed's June FOMC meeting", "Federal Open Market Committee meeting minutes", "Fed Beige Book", "FRB Chicago President … speaks" |
| 4–9 | `CPI`, `PCE`, `JOBS`, `GDP`, `PMI`, `RETAIL` | today's rules, unchanged | |
| 10 | `SENTIMENT` | today's rule, plus "Michigan … Consumer" | "U. Michigan Prelim Consumer Survey" |
| 11 | `OTHER` | everything else | "Monthly U.S. federal budget", PPI, claims |

- `Fed` must match as a whole word, so "federal" never matches it.
- Rules 1 and 2 must run before rule 3.
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

- **`addEventFeatures`** (`build-features-phase2.ts`):
  - `is_fomc = isFomcDecisionDay(dateStr)`.
  - `event_type` is `'FOMC'` on a decision day, even with no rows; otherwise
    it's the first type found in this order: FOMC, CPI, PCE, JOBS, GDP, FED,
    PMI, RETAIL, SENTIMENT, OTHER. It's null when there are no rows.
  - `days_to_next_event` is computed in SQL as `MIN(date) - ${dateStr}::date`,
    an integer number of calendar days.
- **Analyze formatter** (`analyze-context-formatters.ts` `HIGH_SEVERITY_TYPES`):
  see Q1.
- **Gamma detector:**
  - both callers pass `isFomcDay: isFomcDecisionDay(date)`;
  - this turns on the dead "FOMC DAY" chip and starts storing true values.
- **Lottery MACRO badge** (`lottery-finder.ts`, `event_type IN
  ('FOMC','CPI','PCE','JOBS')`):
  - no code change;
  - it will now fire on real decision days only (see Q2).
- **Cron hardening** (`fetch-economic-calendar.ts:84-87`):
  - an event with an unparseable `time` currently throws inside the filter
    and fails the whole day's run;
  - instead, skip that event, log it with its name, and count it in the run
    metadata as `invalidTimeSkipped` (not an Axiom top-level key, so it lands
    in `meta`).

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
3. **Consumers** (~1.5 h)
   - Modify: `api/_lib/build-features-phase2.ts`,
     `api/__tests__/build-features-phase2.test.ts`,
     `api/_lib/analyze-context-formatters.ts`,
     `api/__tests__/analyze-context.test.ts`.
   - Modify `api/__tests__/build-features.test.ts` only if it pins the old
     priority.
4. **Gamma detector wiring** (~45 min)
   - Modify: `api/cron/detect-gamma-setups.ts`, `api/gamma-setups/active.ts`,
     and their tests.
5. **Backfill script** (~1.5 h)
   - Create: `scripts/backfill-economic-event-labels.ts` and its test. Follow
     the pattern of `scripts/backfill-gamma-setup-fires.ts` and how it's run.
   - Dry run by default. Prints each table's before and after counts and every
     changed `economic_events` name.
   - `--apply` runs all writes in one `sql.transaction()`. Each table is one
     batched `unnest` statement (R5).
   - Steps:
     1. `economic_events.event_type`: reclassify every row; update the
        changed ones.
     2. `training_features`: for every row, recompute `is_fomc`,
        `event_type` and `days_to_next_event` from the corrected rows plus the
        schedule.
        - A direct `UPDATE`, not the build-features upsert. The upsert's
          `COALESCE` can't clear stale values.
        - `event_count` doesn't change.
     3. `market_snapshots` and `training_features.is_event_day`. Use
        conditional updates guarded by the current values, so a second run
        changes nothing.
        - 2026-04-29 → `is_event_day = true`, `event_names = {FOMC}`.
        - 2026-05-06 → remove `FOMC` from `event_names`. Then set
          `is_event_day = cardinality(event_names) > 0`.
     4. `gamma_setup_fires.is_fomc_day = true` for fires on decision days.
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
winter), so that day's row is covered.

1. Dry run first; the controller reads the diff.
2. Then `--apply`.
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
  - `gamma_setup_fires.is_fomc_day`.
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
