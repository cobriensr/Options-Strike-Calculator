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
  - **`complete`:** true only when the 6 opening-range bars exist and the data proves the 9:55 ET bar has closed: `sessionDate` is before today's ET date, or a bar starting at or after 10:00 ET is present. A clock check alone would trust a 9:55 bar that Schwab may still be revising.
  - **Cache:** on a trading day, use the short cache (the market-open cache) unless `sessionDate` is today and `complete` is true. This also covers today's pre-9:30 indicative bars, which make `sessionDate` today with a null range.
- **`src/types/api.ts`:** add `readonly sessionDate: string | null` to `IntradayResponse`. The client validates no schema for `/api/intraday` (it uses a plain `fetchJson<T>`, `useMarketData.fetchers.ts:59-104`).
- **`api/__tests__/intraday.test.ts`:**
  - a trading-day call after today's bars gives today's date;
  - a pre-open call gives the previous session's date with the short cache;
  - a holiday gives the last session's date;
  - no candles gives `sessionDate: null`;
  - 6 bars and no 10:00 ET bar gives `complete: false`; with a 10:00 ET bar, `complete: true`;
  - today's pre-9:30 bars only: `sessionDate` today, range null, short cache.
- **Fixtures.** No typed test fixture builds an `IntradayResponse`. The bodies that need `sessionDate` are the untyped fetch mocks in `useMarketData.test.ts` (1b) and `MarketRegimeSection.test.tsx` (1c).

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

## Thresholds

- The repair tolerance on high/low is 0.05 (prices are stored to 2 decimals).
- `complete` from 10:00 ET.

## Left to the builder

- The exact short-cache values in 1a; reuse the existing market-open cache helper.
- Where in `useMarketData` the ET date enters the mount effect's dependencies.
