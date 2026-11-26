# Stale opening range (and yesterday): the live page keeps a previous session's data

## Goal

The live page must only ever use today's opening range and the right "yesterday".

- **The bug.** A page loaded before today's first SPX bar, or a tab left open overnight or over a weekend, keeps the previous session's opening range all day: in the Opening Range card, in the range signal, and in the snapshot rows it saves, which feed `training_features`.
- **`/api/yesterday` has the same flaw.** It is fetched once, on mount.
- **This spec** fixes the cause, keeps stale data out of every consumer, and repairs the stored rows.

## Owner

- 2026-11-22: "we need to fix this".
- Standing rules that apply:
  - nothing may depend on the app being open (feedback memory backend-not-app-open);
  - data bugs are backfilled (always-backfill);
  - adjacent bugs are fixed now (fix-now-never-defer).

## The bug (verified by reading the code, 2026-11-22)

1. **`api/intraday.ts` returns the previous session's range.**
   - It requests the last 5 days of 5-minute `$SPX` bars (:131-134), takes the latest ET date in them (:161-165), and builds the range from that date's bars from 9:30 ET (:171-178).
   - Before today's first bar, that date is the previous session, so `complete` is `true` (`candles.length >= 6`, :74).
   - The response has no date field (:188-195; `IntradayResponse`, `src/types/api.ts:34-52`).
   - Falling back to the previous session on a weekend or holiday is deliberate (`fd731fc3e`, `api/__tests__/intraday.test.ts:222`).
2. **The client stops asking.**
   - `useMarketData.ts:396` computes `openingRangeComplete` from that stale `complete: true`.
   - The poll fetches `/api/intraday` only while `session === 'regular' && !openingRangeComplete` (:426).
   - The mount fetch, which also brings `/api/yesterday` and the other one-shot endpoints, reruns only on an auth change (:369).
   - So both stay stale until a reload.
3. **Consumers read them with no date check:**
   - the opening range at `App.tsx:638` (`liveOpeningRange`) → `useComputedSignals` → `useRangeAnalysis.ts:241-259`;
   - the card's `initialRange` in `MarketRegimeSection`;
   - yesterday through `resolveYesterday` (`src/utils/yesterday.ts:14-21`) → cluster, `median_hl_pct`, ceilings, RV/IV; and directly through `market.data.yesterday` in `PreTradeSignals` (`MarketRegimeSection`).
   - **`/api/yesterday` is edge-cached for 24 h plus 1 h of stale-while-revalidate** (`api/yesterday.ts:155-156`). A refetch at ET midnight, or a fresh load about a day after the last one, can get the previous day's body, so a refetch alone doesn't fix yesterday.
4. **A nearer miss.** `complete` turns true at 6 bars, which can include a 9:55 ET bar still running. Polling then stops on a range missing the last minutes.
5. **The edge cache.** Before the open, `isMarketOpen()` is false (`cron-helpers.ts:193`), so the response is cached `s-maxage=600, stale-while-revalidate=120` (`intraday.ts:182`). A 9:29 ET body can be served until about 9:41.

## Stored damage (read-only scan, 2026-11-22: `docs/tmp/stale-opening-range/scan.out`)

The scan finds rows whose `opening_range_high/low` equals the previous session's most common range.
- **Whole day stale (a tab left open): 05-22, 11-12 and 11-16.** All of 11-16, a Monday, carries 11-13's range (Friday's). The scan prints the date's row total; about 172 of those dates' 229 rows match, and the rest hold some other range.
- **Morning stale until a reload:** 05-01, 05-07, 05-08, 05-21, 08-03 and 03-27 (the 8:45 CT row, a same-day save).
- **Backtest replay rows on Feb dates** (mostly the 2:55 PM CT slot, plus 02-20 at 11:05). These hold a previous date's range, so a previous date's history leaked into a save during a date switch.
  - They sit outside the feature pick window, so training is unaffected.
  - They are repaired here too (always-backfill), because snapshot-builder phase 6 does not reach them (its call 14 limits it to replay-log rows and backtest rows saved after 10-28).
- **The scan has blind spots:** a stale day whose previous session has the same most common range, and a range held from a session with no rows. **So the repair does not trust this list.** It checks every row against its own date's bars.
- **Not measured yet:** stale `yesterday` values on the same days. The repair's dry run reports them (Phase 3).

## Approaches

- **A. Date the data, refetch on a new ET day (chosen).**
  - `/api/intraday` returns the session date its range is from.
  - The client treats a range as current only under the rule below, keeps polling until it has today's, and refetches every one-shot endpoint when the ET date changes.
- **B. Reset `openingRangeComplete` on a day rollover in the client (rejected).** It still trusts an undated range, and misses a mount fetch that lands before today's first bar.
- **C. Have the server refuse to return a previous session's range on a trading day (rejected).** It breaks the deliberate weekend and holiday display.

## The rule: which range is current

`currentOpeningRange(intraday, etToday)` is a pure function, so the hook's return type doesn't change:
- if `intraday?.sessionDate === etToday`, the range is current;
- if `etToday` is not a trading day, and `sessionDate` is the last trading day before `etToday`, it is current. This keeps the weekend and holiday display; it uses `priorTradingDay` and `isTradingDay` from `src/data/marketHours.ts`;
- otherwise it is null. On a trading day before today's first bar, a held Friday range is null on Monday.

`etToday` comes from the app's shared clock (`useETToday`, as App's `vix.etToday`), which changes at ET midnight. A memo keyed only on `data.intraday` would keep Friday's range until the first poll reply.

## Phase 1: the live fix, tonight, before Monday 2026-11-23 8:30 CT

There are four steps (1a–1c for the opening range, 1d for yesterday), each through the Get It Right loop. They build on snapshot-builder phase 2 Tasks 2–3 and the Task 3 fix round, which touch `App.tsx` and `MarketRegimeSection.tsx`: Task 2 gives the card its empty defaults, and Task 3 gives `MarketRegimeSection` its `etToday` prop. They are pushed after the 3:00 PM CT close on a weekday, together with those tasks. **Until they ship:** reload any tab after about 9:45 ET (8:45 CT).

### 1a: `/api/intraday` dates its range (3 files)

- **`api/intraday.ts`:**
  - **`sessionDate`:** add `sessionDate: string | null`, which is `latestETDate`, or `null` when Schwab returns no candles.
  - **`complete`:** true when at least one opening-range bar exists (a bar starting before 10:00 ET) and the window is closed: `sessionDate` is before today's ET date, or a bar starting at or after 10:00 ET is present. A clock check alone would trust a 9:55 bar that Schwab may still be revising, and a count of 6 bars can include the 9:55 bar while it runs. All six are not required: a later bar proves no opening-range bar can still change, and a permanently missing 9:45 bar would otherwise keep the client polling every 60 s all day, with a short cache after the close. `minutes` still reports the real bar count (25 on a gapped day). With no bar before 10:00 ET the range is null.
  - **Cache:** on a trading day, use the short cache (the market-open cache) unless `sessionDate` is today and `complete` is true. This also covers today's pre-9:30 indicative bars, which make `sessionDate` today with a null range.
- **`src/types/api.ts`:** add `readonly sessionDate: string | null` to `IntradayResponse`. The client validates no schema for `/api/intraday` (it uses a plain `fetchJson<T>`, `useMarketData.fetchers.ts:59-104`).
- **`api/__tests__/intraday.test.ts`:**
  - a trading-day call after today's bars gives today's date;
  - a pre-open call gives the previous session's date with the short cache;
  - a holiday gives the last session's date;
  - no candles gives `sessionDate: null`;
  - 6 bars and no 10:00 ET bar gives `complete: false`; with a 10:00 ET bar, `complete: true`;
  - a missing 9:45 bar with a 10:00 ET bar gives `complete: true` and `minutes: 25`;
  - today's pre-9:30 bars only: `sessionDate` today, range null, short cache.
- **Fixtures.** One typed fixture builds an `IntradayResponse`: the `intraday` body of the market state in `MarketRegimeSection.test.tsx`, which gets `sessionDate` in 1a (`e13e29f16`). The other bodies that need it are the untyped ones: the fetch mocks in `useMarketData.test.ts` (`mockIntraday` and its held bodies, 1b) and the held-body variants in `MarketRegimeSection.test.tsx` (1c).

### 1b: the client keeps asking, and refetches on a new day (4 files)

- **`src/utils/current-opening-range.ts`**: the pure rule above, with a table test (`src/__tests__/utils/current-opening-range.test.ts`):
  - today's range on a trading day: current;
  - Friday's range on Saturday: current;
  - Friday's range on Monday: null;
  - Thursday's range on Saturday (one session too old): null;
  - a holiday Monday with Friday's range: current;
  - Saturday 2026-04-04 (the day after Good Friday) with Thursday 04-02's range: current. This tells `priorTradingDay` apart from "previous weekday";
  - `sessionDate` null: null;
  - `intraday` null: null.
- **`src/hooks/useMarketData.ts`:**
  - **The poll condition** is evaluated at tick time: `session === 'regular' && !(intraday.sessionDate === getETToday() && intraday.openingRange?.complete === true)`.
  - **The mount effect** also depends on the ET date (`useETToday`), so a new ET day refetches every one-shot endpoint. For `/api/yesterday` that alone isn't enough (the edge cache, above); 1d finishes it.
- **`src/__tests__/hooks/useMarketData.test.ts`:**
  - Mount pre-open with a previous-session `complete: true` range, advance into regular hours past a poll interval: `/api/intraday` is fetched again.
  - With today's `complete: true` range, it is not.
  - A tab held from Friday into Monday at 9:30 ET re-polls.
  - Crossing ET midnight refetches the one-shot endpoints.

### 1c: consumers use only the current range (about 4 files)

- **`App.tsx`:** `liveOpeningRange` = `currentOpeningRange(market.data.intraday, vix.etToday)`.
- **`MarketRegimeSection.tsx`:**
  - The live `initialRange` uses the same function, through its `etToday` prop from Task 3.
  - The live card's key includes `etToday` (`live-or-<etToday>`), so a held tab that crosses into a new ET day remounts to empty inputs rather than keeping Friday's values. `OpeningRangeCheck` syncs only when `initialRange` is set; today's range arriving later the same day fills it through that sync.
- **Tests:**
  - **`MarketRegimeSection.test.tsx`:** Friday's range with `etToday` Monday shows empty inputs; with Saturday it shows Friday's range; **a rerender from Saturday to Monday** (the same Friday intraday body) shows empty inputs; a typed edit drops at the rollover.
  - **`App.date-clock-wiring.test.ts`:** `liveOpeningRange` is built with `currentOpeningRange(…, vix.etToday)`.

### 1d: yesterday is the right session (about 5 files)

- **`src/utils/current-yesterday.ts`** (+ table test): `currentYesterday(yesterday, etToday)` returns `yesterday` when `yesterday.date === priorTradingDay(etToday)`, else null. That holds on trading days, weekends and holidays alike, because the endpoint drops today's candle.
- **Request.** `useMarketData.fetchers.ts` requests `/api/yesterday?d=<etToday>`. A per-ET-day URL means the edge cache can't serve another day's body. The endpoint ignores the parameter.
- **Re-request.** In `useMarketData.ts`, the poll re-requests `/api/yesterday` while the held value fails `currentYesterday`. A failed midnight refetch then heals on the next poll instead of holding all day.
- **Consumers.** App's `resolveYesterday` input and `MarketRegimeSection`'s `PreTradeSignals` both take `currentYesterday(market.data.yesterday, etToday)`.
- **Tests:**
  - the table: Monday → Friday; Tuesday after a holiday Monday → Friday; Saturday → Friday; a stale Thursday on Tuesday → null;
  - a held stale yesterday re-polls;
  - `e2e/pre-trade-signals.spec.ts` builds its fixture dates relative to the test's clock instead of the fixed `2026-03-27`.

## Phase 2: pure opening-range math (before the repair; 3 files)

- **Extract the inline formula** in `useRangeAnalysis.ts:245-258` into `openingRangeSignal(high, low, spot, medianHlPct)` in `src/utils/`. It returns `{ consumed, signal }` and uses `classifyOpeningRange` with the label map.
- `useRangeAnalysis` calls it. This is a strict refactor: its tests stay green unchanged.
- The new function gets its own table test: consumed and signal at each `classifyOpeningRange` boundary, a zero range, and `medianHlPct` 0.
- The repair script imports the same function and never copies the formula.

**As built (2026-11-25).**
- **The function.** `src/utils/opening-range-signal.ts` exports `openingRangeSignal(high, low, spot, medianHlPct): OpeningRangeReading | null`, where `OpeningRangeReading` is `{ consumed, signal }` and `signal` is the legacy label `'GREEN' | 'MODERATE' | 'RED'` (`OpeningRangeLabel`). It has no React in it and its only imports are `classifyOpeningRange` and a type.
  - **Phase 3 calls it as** `openingRangeSignal(asOf.high, asOf.low, row.spx, row.median_hl_pct)` with each stored NUMERIC read as a number. A `null` result means there is nothing to grade: write NULL for both columns, as at 8:30 CT.
  - **`consumed` is the unrounded float**, as the live card has always stored it. A null or undefined median is read as 1, and a median of 0 or less gives 0. Phase 3 decides for itself whether a stored `median_hl_pct` of NULL is to be graded at all: the function would read it as 1, which is the live hook's fallback.
  - **Null for inputs that are not a price:** a `high` or `low` not above 0 (including NaN), or a `spot` that is 0 or NaN. The hook never reached the formula with those, so the live behaviour is the same.
- **`useRangeAnalysis` calls it** and has no formula of its own. Its tests are unchanged and pass.
- **Zero behaviour change, checked two ways.** The existing hook, signals and classifier tests pass untouched. And a one-off differential run compared the old inline block (behind its two guards) with the function over 14,400 combinations of high, low, spot and median, including 0, negatives, NaN, Infinity and null medians: no difference in `consumed` (compared with `Object.is`), in the label or in which inputs are skipped.
- **A reversed range** (high under low) reads negative `consumed` and GREEN, and a zero-width range reads 0 and GREEN. That is the live behaviour and the table test pins it. `OpeningRangeCheck` flags such an input as an error on screen; the signal never did.

## Phase 3: repair the stored rows (script, owner OK on the run)

**Files** follow the existing pattern (`scripts/backfill-snapshot-price-context.ts` with `scripts/_lib/snapshot-price-context.ts`): a CLI plus a pure library, with unit, pglite and CLI tests. Schwab candles come through `scripts/_lib/schwab-local.mjs`.

**Every** `market_snapshots` row within Schwab's 5-minute depth (back to about 03-05) is checked, not only the scan's list.
- **The as-of range at the row's slot** is `spxSlotStateAsOf(candles, slotMinuteCT).openingRange` (`src/utils/snapshot-slot.ts`, already on main). It is null at 8:30 CT and partial until 9:00 CT; this is the owner's as-of rule (snapshot-builder spec call 1).
- **Which rows are repaired.** A live save before 10:00 ET legitimately holds a partial range that includes the bar still running at its save, which is more than the ended-bars as-of range. So the test is not "differs from the as-of range".
  - A row is **stale** when its stored high is outside [as-of high, high including the bar running at the slot], or its low is outside the mirror interval. Each is checked with a 0.05 tolerance. A previous session's range always fails this.
  - Only stale rows are repaired.
  - Rows that differ only by the running bar are counted as "as-of rebase" in the dry run and left alone. They are a methodology question for the owner, not this bug.
- **For each stale row, all four columns are recomputed:**
  - `opening_range_high` and `opening_range_low` from the as-of range;
  - `opening_range_pct_consumed` and `opening_range_signal` from `openingRangeSignal(high, low, row.spx, row.median_hl_pct)`.
  - Rows before 10:00 ET store a signal too (`useRangeAnalysis` computes it whenever a range exists), so they are recomputed like any other.
  - At 8:30 CT all four become NULL.
- **Dates before Schwab's depth** (the Feb backtest rows) take the date's own range from its other rows (the scan's "day's own range"). That is valid for slots at or after 10:00 ET only; earlier rows on those dates are reported, not repaired.
- **Known limit.** `median_hl_pct` is taken as stored. On a held-tab day it may itself rest on a stale yesterday (cluster multiplier). The dry run also reports each row whose stored previous-session values don't match the row date's real previous session. Those columns are repaired when the server row builder (snapshot-builder phase 4) can rebuild the row. They are listed for snapshot-builder phase 6's scope.
- **The run:** backup, dry run (a count per date and per column), a hand recompute of 2 rows, owner OK, then apply one date first (11-16).
- **`training_features`:** for each repaired date whose feature pick row was repaired, a targeted UPDATE copies `opening_range_signal` and `opening_range_pct_consumed` from the repaired row. That follows the trust spec's repair, which avoids the column drift of a full rebuild. Guarded on the values read.

**As built (2026-11-25).** Built and tested, not run against production: the owner's go-ahead is for the run.
- **Files.** `scripts/repair-stale-opening-range.ts` (CLI) and `scripts/_lib/stale-opening-range.ts` (the plan, the reads and writes, the report, the arguments), with a unit test, a pglite test and a CLI test beside it. `scripts/_lib/snapshot-price-context.ts` exports `historyAccess`, `fetchHistory`, `previousCloseOf` and the 3.00 tolerance, so the fetch and the previous-close rule exist once.
- **Candles come from the app, not `schwab-local.mjs`** (decided after review, 2026-11-25). The script calls the owner's `/api/history?date=D`, as the price-context backfill does, with `APP_URL` and the cookie `OWNER_SECRET` as well as `DATABASE_URL` (none printed as it is; the origin is, and the database, as `host/name`, once a query on it has succeeded). Why: those bars are what the page computed its range from; `schwab-local.mjs` reads the production Redis token record and may refresh it, which can race the crons and would make even a dry run write to production Redis; and the run takes no token callback, which only a test would have wanted. `APP_URL` and `OWNER_SECRET` are read only when a date from 2026-03-05 on is planned, and the history origin goes to stderr just before the first call. If Schwab's window does not reach an early-March date, its history comes back empty and that date is skipped as `history-failed`, named, with exit code 1: it is not repaired from its own range.
- **A NULL `median_hl_pct` is not graded** (the owner's call, 2026-11-25). A stale row with one is listed on its own and nothing is written to it, also at 8:30 CT, where the repair would only write NULLs. A median that is not a number above 0 is `unreadable-median` and handled the same way. The same holds, each listed with its reason, for a stale row with no usable spot, a consumed value that would not fit `DECIMAL(6,4)`, and a slot the candles give no as-of state for (that includes a bad price on a bar that has ended, and one on the bar still running at the slot, whose band is then unknown).
- **What a row is.** In this order, each row is one of: `ok` (the as-of range, within 0.05), `look-ahead`, `rebase`, `lag`, `incomplete-range`, or a stale repair.
  - **`look-ahead`**: a replayed (`is_backtest`) row before 10:00 ET that holds the date's complete range, a replay from before the as-of fix (commit 69accde10). Counted and listed, never written; snapshot-builder phase 6 owns them. If the complete range cannot be read (a bad price on a bar that has ended by 9:00 CT), a replayed row before 10:00 ET that is not the as-of range is `no-as-of-state`, not judged: it could be a look-ahead, and a repair would overwrite it.
  - **`rebase`**: inside [as-of, with the running bar] and not the as-of range. Counted, never written.
  - **`lag`**: a live row inside [the as-of range a bar earlier, widened by the open of the bar that ended at the slot; the as-of range], a page that answered a bar behind. Counted and listed, never written. Before 10:00 ET on any date, and at 9:00 CT (where the range completes) from 2026-11-23 on, the live fix; there is none at 8:30 CT. Before the fix the 9:00 CT slot belongs to `incomplete-range` below, so the two kinds meet with no gap: a 9:00 CT row a bar behind is a lag on 11-23 or later and an incomplete-range before. Past 9:00 CT a lag window is only the complete range, which `ok` has already taken.
  - **`incomplete-range`**: a live row from 10:00 ET on, saved before 2026-11-23, whose range is narrower than the complete one only by the last seconds of the 9:55 bar (inside [the range through the 9:50 bar widened by the 9:55 bar's open; the complete range]). **The owner decided on 2026-11-25 at 10:51 CT to repair these.** There is no flag: a normal apply writes them, with the same transaction and features guard as any repair. They are their own kind, counted and listed by id per date in the dry run, so the owner sees how many before applying.
  - **stale repair**: anything else outside the band; a previous session's range always lands here. At 8:30 CT, with no bar ended, the lower bound is the first bar's open and the upper bound that bar's range, and a repair writes NULL in all four columns.
  - **A carried-over range wins over `rebase`, `lag` and `incomplete-range`** (re-review, 2026-11-25). A stale row can land by chance inside one of those windows. When its range equals, within 0.05, the previous trading date's own range (the range the most of that date's rows from 10:00 ET on hold, at least two of them, with no other range holding as many), it was carried over and is stale: it is repaired. The previous date's rows are read for every planned date, with candles or without. It never turns an `ok` row or a `look-ahead` into a repair.
- **Dates before the candles** take the date's own range: the range at least two of its rows at or after 9:00 CT (10:00 ET) hold, with no other range holding as many. A stale row at or after 9:00 CT is repaired to it only with positive evidence, that it holds the previous trading date's own range within 0.05, which is what a carried-over range looks like. Any other row that differs, every row before 9:00 CT that differs, and every row of a date with no such range, is listed and left alone. The first candle date is 2026-03-05.
- **The previous session is reported, never repaired.** The dry run lists, by date, the rows whose stored `prev_close` is further than 3.00 from the previous close `/api/history` reports (the price-context backfill's G1b rule: the 5-minute and the official close differ by up to about 2.55, a wrong-week close by tens to hundreds), and the dates whose previous session it did not report. Only `prev_close` is checked. The cluster multiplier and RV rest on the same session and are the server row builder's to rebuild.
- **The run.** A dry run is the default. It writes a plan file (`docs/tmp/stale-opening-range/dry-run-<scope>-<time>.json`, with the scope, the database as `host/name`, each written row's stored and new values, and every features copy) and nothing to the database. A dry run refuses before `getDb()` when `DATABASE_URL` names no usable database, without printing it. It prints a `Database: host/name` line, then the counts, one line a date (rows, repairs, lag, look-ahead, incomplete, rebase, stale skips, rows the candles could not judge, features status), for every written row the stored and the new values, the spot and median it graded with, the as-of range, the band, and every 5-minute bar from 9:30 ET that had started by the slot (the running one marked), so a row can be recomputed by hand, and the lists by id: incomplete-range, lag, look-ahead, the NULL-median rows and every other row left alone with its reason.
  - **`--apply --plan F`** is the only way to write: it plans afresh with F's scope and refuses unless every row, the stored values each repair replaces, and its new values are F's, so what is applied is what was reviewed. A row that changed to another stale value since the dry run is refused, not overwritten; the same holds for the features row a copy would overwrite. A listed row that already holds its new values is fine: a second apply writes nothing. `--plan F` without `--apply` only checks. F records the database as `host/name`, and a mismatch refuses: a Neon project can hold several databases on one host, so the host alone does not tell them apart. `databaseOf` reads `host/name` off a parse of `DATABASE_URL`, and a parse is not proof: a URL with an `@`, or a `/`, `?` or `#`, in the wrong place can put the user or part of the password in the host or the path (`postgres://owner:12/34@host/db` gives the host `owner`; `postgres://owner:p@ss/34@host/db` gives `ss/34@host/db`). A guard turns the form it recognises into a fixed sentinel, as a missing or unparseable URL is, but the rule does not lean on it: **a value derived from the current `DATABASE_URL` is printed or written only after a query on that URL has succeeded** (a URL the driver connects with is not one of these). So the refusal before any connection, on apply and on undo, prints only the name the file recorded and says `DATABASE_URL` names a different database or is not a usable URL; the `Database:` line, the plan's and the backup's `database` come after the run's reads; and an undo names the one its backup recorded. The sentinel never matches: a file that records it, and a dry run whose `DATABASE_URL` yields it, are refused before any connection. The plan's `note` is text for the owner and nothing checks it; it says what an apply checks and that a plan for more than one date needs `--all`.
  - **One date first, then all** (the owner's rule, re-review 2026-11-25). A no-argument dry run is an all-dates plan, and applying it would write every date. So `--apply --plan F` refuses when F's scope covers more than one date (no `--date`, or a `--since` and `--until` that are not the same day) unless `--all` is also given; the refusal names the scope and says to apply one date first. A `--date` plan applies without it. `--all` is valid only with `--apply --plan`; checking a plan never needs it.
  - It then writes `docs/tmp/stale-opening-range/backup-<scope>-<time>.json` with `wx` (an existing file stops the run before any write; the backup records the database as `host/name` and, for each features copy, its pick row). Then, one date at a time, a date's rows (500 to a statement) and its features row go in one `sql.transaction`, each row only where all four columns still hold the values read, and the features row only where it still holds the old two values and the pick row holds the new ones. A row that changed since the read is listed and left alone and the run exits 1. A failure rolls back the date it was in, leaves the dates before it written, and says how many rows were written, which dates' features are not copied, the backup and the undo command.
  - **The features copy** is for a date whose pick row is written (repair or incomplete-range) and whose features row still holds that row's old two values. A date whose pick row needs no repair but whose features row differs from it is listed as out of sync, and so is one whose features row holds other values than the pick row's old ones.
  - **`--undo-file F --apply`** restores a backup under the reverse guard, a date at a time, and a features row only together with its pick row; it refuses a backup written for another database. Rows a failed apply never wrote are listed as not restored, because they never held the repaired values; a features row left behind counts in the exit code.
- **Not built:** nothing the phase lists. A `--date` run applies one date, as the plan asks (11-16 first).

## Thresholds

- The repair tolerance on high/low is 0.05 (prices are stored to 2 decimals).
- `complete` from 10:00 ET.

## Left to the builder

- The exact short-cache values in 1a; reuse the existing market-open cache helper.
- Where in `useMarketData` the ET date enters the mount effect's dependencies.
