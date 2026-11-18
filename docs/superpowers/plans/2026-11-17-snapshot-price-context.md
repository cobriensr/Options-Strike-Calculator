# Snapshot Price Context (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `market_snapshots` row carries the right SPX open, high,
low, previous close and overnight gap. That covers live rows, which are
NULL today, and backtest rows, whose previous close is a week early today.
The work also backfills history.

**Architecture:**
- `/api/history` reports each symbol's previous close as the previous
  session's last 5-minute close. It already computes that as
  `previousDay.close`, which matched `outcomes.settlement` exactly on 11-05,
  11-09, 09-14 and 10-20. It no longer uses Schwab's range-start
  `previousClose`.
- The page fills live rows from the live SPX quote.
- A new pure `src/utils/snapshot-slot.ts` holds the as-of running OHLC rule
  that phase 2 builds on.
- A TypeScript script backfills existing rows.

**Tech Stack:** TypeScript, React 19 hooks, Vercel Functions, Neon via
`@neondatabase/serverless`, Vitest, pglite, `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md`
(goals G1 and G1b, call 1 as-of rule, phase 1).

## Global Constraints

- **As-of rule** (spec call 1). A row at slot T uses only bars that end at
  or before T:
  - Bars are labelled by their start, so a bar starting at minute s ends at
    s + 5.
  - At 8:30 CT no bar has ended, so open, high and low are all the first
    bar's open.
- **`prev_close` definition** (spec G1b). It is the official close of the
  previous session. Acceptance: it equals that session's
  `outcomes.settlement` within 0.05.
- **Overnight gap:** `(spxOpen − prevClose) / prevClose × 100`, unrounded,
  as `useRangeAnalysis` computes it today.
- **`.js` imports.** `src/utils/snapshot-slot.ts` uses explicit `.js`
  extensions on relative non-type imports, because `api/` will import it in
  phase 4.
- **New scripts files** go in the `tsconfig.scripts.json` `include` list.
- **No test touches a real database or network.** Use pglite or `vi.mock`.
- **Deploys.** Tasks 1–3 touch `api/` or `src/`, which redeploys Vercel. On
  weekdays, push them after 3:00 PM CT.
- **Prod reads.** The task 4 dry run reads every snapshot row plus about 170
  history dates. Run it outside 13:00–23:00 UTC on weekdays.
- **Prod writes.** `--apply` needs the owner's OK, after hand-recomputing at
  least two rows from raw candles: one live row and one backtest row.
- **Batching (R5):** at most 500 rows per UPDATE.
- **Guarded updates (R6):** each UPDATE is conditional on the row still
  holding the values the plan read.

## Review Focus

1. **Before the first SPX print.** At 8:30:00–8:30:07 CT the live quote can
   carry `open = 0`. The row must store NULL open and NULL gap, never 0 or
   −100%. *(Task 2 test.)*
2. **A past date viewed while live quotes are loaded.** Today's quote must
   never fill a past date's row. *(Task 2 test.)*
3. **A cached history entry with no `previousDay`.** A malformed or older
   entry must serve previous close 0, never Schwab's range-start value.
   *(Task 1 test.)*
4. **Label variety in the backfill.**
   - ET labels ("9:30 AM ET") map to the same slot as the CT label.
   - "pre-market" and unparseable labels are left alone.
   - A stored `spx_open` of NaN counts as missing.
   *(Task 4 tests.)*
5. **A short or early-close session in the backfill.** A date whose candles
   fall short of its slot count (`getEarlyCloseHourET` decides early-close
   days) is skipped and reported, never half-filled. *(Task 4 test.)*

---

### Task 1: `/api/history` serves the target session's previous close

**Files:**
- Modify: `api/history.ts`
  - `fetchSymbolHistory` (~:281-378): the return value.
  - A separate `repairCachedPreviousClose`, next to `repairCachedCandles`
    (~:166), repairs the previous close on cache read. `repairCachedCandles`
    stays as it is.
  - The handler's date check: reject an impossible date and any date before
    2000-01-01 with the 400, and compute the target's prior trading day once.
- Test: `api/__tests__/history.test.ts`
- Also commit the spec and this plan
  (`docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md`,
  `docs/superpowers/plans/2026-11-17-snapshot-price-context.md`) as a
  separate `docs(spec):` commit, gated by the same review run.

**Interfaces:**
- Produces: each symbol's `SymbolDayData.previousClose` equals
  `previousDay.close` when `previousDay` is the target's prior trading day
  (`priorTradingDay`), else `0`: no `previousDay`, or an older session
  because Schwab's window lacks the prior one. This holds for all five
  symbols, on fetch and on cache read. Nothing else in the response shape
  changes.

- [ ] **Step 1: Write the failing tests** in `api/__tests__/history.test.ts`:
  - `previousClose is the previous session's last close, not Schwab's range-start value`:
    - Schwab mock: SPX candles for 2026-11-05 (last close 7356.73) and
      2026-11-06, with raw `previousClose: 7720.39`. VIX with raw
      `previousClose: 17.2` and a 11-05 last close of 17.95.
    - Assert `body.spx.previousClose === 7356.73`.
    - Assert `body.vix.previousClose === 17.95`.
  - `previousClose is 0 when the window holds no previous session`: only
    target-date candles, raw `previousClose: 7720.39`. Assert
    `body.spx.previousClose === 0`.
  - `a cached entry holding Schwab's range-start previousClose is served with the previous day's close`:
    - Redis entry with `spx.previousClose: 7720.39` and
      `spx.previousDay.close: 7356.73`.
    - Assert the response is 7356.73 and `X-Cache: HIT`.
    - Assert no Redis write: the stored value is not rewritten, as the
      existing candle repair behaves.
  - `a cached entry with no previousDay serves previousClose 0`.
  - `a cached entry already holding the previous day's close comes back unchanged`:
    no repair log.
  - The failure-mode and edge tests added in review:
    - Fetch hole: the window lacks the prior trading day but holds an
      earlier session. Expect `previousClose` 0 and one warn per symbol with
      `{ symbol, date, previousDayDate, expected }`.
    - Cache hole: a stored `previousDay` that is not the prior trading day
      serves 0 and logs once.
    - Weekend and holiday non-holes: Monday after a weekend, and the day
      after Labor Day, Good Friday, Memorial Day, Juneteenth and Independence
      Day (observed). Expect the last session before the gap, no warn, and
      one cached case that is left unchanged.
    - Missing key: a stored symbol with no `previousClose` key and a valid
      `previousDay` serves `previousDay.close`. With neither key it serves 0.
    - A stored symbol that is a string or an array passes through.
    - The previous session's last candle has a null or missing `close`:
      serves 0. A non-numeric stored `previousDay.close` serves 0.
    - A target with no candles of its own, and a session after the target
      in the window: no change to the previous close.
    - An impossible or pre-2000 date (`2026-02-30`, `2026-13-01`,
      `0000-01-01`, `1999-12-31`) answers 400 without reaching Schwab or
      Sentry.
- [ ] **Step 2: Run them and see them fail.**
  `npx vitest run api/__tests__/history.test.ts`. Expected: the new tests
  FAIL on 7720.39.
- [ ] **Step 3: Implement.**
  - In `fetchSymbolHistory`, return `previousDay.close` when
    `previousDay.date === priorTradingDay(targetDate)` and the close is a
    finite number, else 0, with one warn per symbol on a date mismatch. Stop
    reading Schwab's field. Keep `needPreviousClose` out of the request
    unless something else reads it; grep first.
  - In `repairCachedPreviousClose`, set each non-null object symbol's
    `previousClose` the same way (a missing key included, with the request's
    date as the target), and log it once per repaired entry, like the candle
    repair. It never rewrites the stored entry.
  - In the handler, validate the date with `parseIsoDate` and reject any
    date before 2000-01-01 with the 400, because `priorTradingDay` throws on
    them.
- [ ] **Step 4: Run the file. Expected: PASS.**
- [ ] **Step 5: Run `npm run review`, then make two commits:**
  `docs(spec): ...` for the spec and plan, and
  `fix(history): Serve the target session's previous close, not Schwab's range start`.

### Task 2: Live rows carry the SPX price context

**Files:**
- Modify: `src/hooks/useRangeAnalysis.ts`
  - `RangeAnalysisInputs` (~:95): a new optional input.
  - The price-context block (~:191), including its history branch
    (`result.prevClose = historySnapshot.previousClose ?? null`, ~:196).
- Modify: `src/hooks/useComputedSignals.ts`
  - `HookInputs` (~:150): a new `liveSpx`.
  - The call at ~:243: pass it only when `!isBacktest`.
- Modify: `src/App.tsx` (~:598-622): pass
  `liveSpx: market.data.quotes?.spx ?? undefined`.
- Test: `src/__tests__/hooks/useRangeAnalysis.test.ts`
- Test: `src/__tests__/hooks/liveSessionSave.test.ts`, or the
  `useComputedSignals` test file if one exists.
- Modify: `src/components/BacktestDiag/index.tsx` (~:58, the "Prev Close"
  row).
- Test: `src/__tests__/components/BacktestDiag.test.tsx`.

That is 7 files, so commit it in two (see Step 5): the hooks, `App.tsx` and
their two test files (5 files), then `BacktestDiag` and its test (2 files).

**Interfaces:**
- Produces in `useRangeAnalysis.ts`:
  - The type
    `export type LiveSpxContext = Pick<QuoteSlice, 'open' | 'high' | 'low' | 'prevClose'>`.
  - `RangeAnalysisInputs.liveSpx?: LiveSpxContext`.
  - `HookInputs.liveSpx?: LiveSpxContext` in `useComputedSignals`.
- Rule:
  - When `historySnapshot` is non-null it wins, as today. Its
    `previousClose` becomes `prevClose` only when it is > 0, else null,
    because `/api/history` now sends 0 for an unknown previous session
    (Task 1). Without this the 0 would be saved as `prev_close = 0`, and a
    later re-save would overwrite a good stored value through the
    `ON CONFLICT ... DO UPDATE`.
  - Otherwise each of `spxOpen`, `spxHigh`, `spxLow` and `prevClose` takes
    the matching `liveSpx` field when it is finite and > 0, else null.
  - `overnightGap` uses the existing formula and guard.
- `BacktestDiag` shows "Prev Close" as '—' when `snapshot.previousClose` is
  ≤ 0 (today it shows "0.00"), the way its "Gap" row already does.

- [ ] **Step 1: Write the failing tests:**
  - `fills open, high, low and previous close from the live SPX quote when there is no history snapshot`:
    - Input: `liveSpx = { open: 7487, high: 7501.2, low: 7480.1, prevClose: 7560.87 }`.
    - Expect `spxOpen 7487`, `spxHigh 7501.2`, `spxLow 7480.1` and
      `prevClose 7560.87`.
    - Expect `overnightGap` toBeCloseTo(−0.97700, 4).
  - `prefers the history snapshot over the live quote`: both given; expect
    the snapshot's values.
  - `a zero open before the first print stores null open and null gap`:
    `open: 0`. Expect `spxOpen null`, `overnightGap null`, and `prevClose`
    still 7560.87.
  - `a history snapshot with previousClose 0 gives a null previous close and a null gap`:
    `historySnapshot.previousClose = 0` with a valid open. Expect
    `prevClose null` and `overnightGap null`.
  - `useComputedSignals ignores the live SPX quote on a past date`:
    `isBacktest: true`, no history snapshot, `liveSpx` given. Expect
    `spxOpen null`.
  - `a live save posts the quote's open, high, low and previous close`: in
    the `liveSessionSave` harness, the POST body has `spxOpen`, `spxHigh`,
    `spxLow`, `prevClose` and `overnightGap` from the quote.
  - In `BacktestDiag.test.tsx`, `BacktestDiag shows a dash for an unknown previous close`:
    a snapshot with `previousClose: 0`. Expect the "Prev Close" row to read
    '—', not "0.00". A positive `previousClose` still shows its value.
- [ ] **Step 2: Run them and see them fail.** Expected: FAIL with null
  values, and "0.00" in the diag row.
- [ ] **Step 3: Implement** the rule and the plumbing above, and the
  `BacktestDiag` row.
- [ ] **Step 4: Run the files. Expected: PASS.**
- [ ] **Step 5: Run `npm run review` once, then make two commits:**
  - `fix(snapshots): Save the SPX open, high, low and previous close on live rows`
    for the hook, `App.tsx` and test files (5 files).
  - `fix(snapshots): Show a dash for an unknown previous close in BacktestDiag`
    for `BacktestDiag/index.tsx` and its test.

### Task 3: Shared as-of running OHLC

**Files:**
- Create: `src/utils/snapshot-slot.ts`
- Test: a new test file wherever `src/utils` tests live in this repo,
  following the existing convention.

**Interfaces:**
- Produces:
  ```ts
  export interface SlotCandle { datetime: number; open: number; high: number; low: number; close: number }
  /** Open, high and low known at the slot; null when there are no candles or the slot is before the first bar. */
  export function priceContextAsOf(
    candles: readonly SlotCandle[],   // one session, start-labelled, sorted
    slotMinuteCT: number,             // parseEntryTimeMinutes() output
  ): { open: number; high: number; low: number } | null
  ```
- Bars with an ET start minute + 5 ≤ slot ET minute (slotCT + 60) count;
  use `getETTotalMinutes` from `./timezone.js`.
- When no bar has ended, the result is the first bar's open for all three.

- [ ] **Step 1: Write the failing table test.** Candles:

  | Bar (ET) | o | h | l | c |
  |---|---|---|---|---|
  | 9:30 | 7487 | 7495 | 7480 | 7490 |
  | 9:35 | 7490 | 7502 | 7488 | 7500 |
  | 9:40 | 7500 | 7505 | 7470 | 7475 |

  The bars are labelled in ET but `slotMinuteCT` is CT, one hour behind: the
  9:30 ET bar is the 8:30 AM CT slot, 510 (`parseEntryTimeMinutes`).
  Expected results:

  | slotMinuteCT | Slot (CT) | Result |
  |---|---|---|
  | 510 | 8:30 AM | `{7487, 7487, 7487}` |
  | 515 | 8:35 AM | `{7487, 7495, 7480}` |
  | 520 | 8:40 AM | `{7487, 7502, 7480}` |
  | 525 | 8:45 AM | `{7487, 7505, 7470}` |
  | 505 | 8:25 AM | `null` (before the first bar starts) |
  | 500 | 8:20 AM | `null` |
  | empty candles | any | `null` |

  Plus the property: appending a later bar with high 9999 and low 1 never
  changes the result for slots 510–525.
- [ ] **Step 2: Run it and see it fail** (module not found).
- [ ] **Step 3: Implement `priceContextAsOf`.**
- [ ] **Step 4: Run it. Expected: PASS.**
- [ ] **Step 5: Run `npm run review` and commit**
  `feat(snapshots): Add the as-of running OHLC for a snapshot slot`.

### Task 4: Backfill script

**Files:**
- Create: `scripts/_lib/snapshot-price-context.ts` (pure planning)
- Create: `scripts/backfill-snapshot-price-context.ts` (CLI, I/O)
- Test: `scripts/_lib/snapshot-price-context.test.ts` (pure table)
- Test: `scripts/_lib/snapshot-price-context-pglite.test.ts` (apply and undo
  SQL)
- Modify: `tsconfig.scripts.json` to include all four files.
- Pattern to follow: `scripts/correct-doubled-fire-flow.ts` and
  `scripts/_lib/fire-flow-correction*.ts`. That covers the CLI flags, the
  dry run by default, the undo file under `docs/tmp/`, the pglite tests and
  how `DATABASE_URL` reaches the script.

**Interfaces:**
- Consumes:
  - `priceContextAsOf` (task 3);
  - `parseEntryTimeMinutes` (`src/utils/entry-time.ts`);
  - `getEarlyCloseHourET`;
  - `pickFeatureSnapshot` (`api/cron/build-features.ts`).
- Produces:
  ```ts
  export interface SnapshotRowIn { id: number; date: string; entry_time: string; spx_open: number | null; spx_high: number | null; spx_low: number | null; prev_close: number | null; overnight_gap: number | null }
  export interface DateHistory { candles: readonly SlotCandle[]; previousDayClose: number | null }
  export type PlanResult =
    | { kind: 'update'; id: number; before: Partial<SnapshotRowIn>; after: Partial<SnapshotRowIn> }
    | { kind: 'skip'; id: number; reason: 'no-slot' | 'unchanged' }
  export function planDate(date: string, rows: readonly SnapshotRowIn[], history: DateHistory | null):
    { results: PlanResult[]; skippedDate?: 'no-history' | 'short-candles' | 'no-previous-day' }
  ```
- Rules:
  - A row whose `spx_open` is null or NaN, with a finite slot, gets all five
    fields: open, high and low from `priceContextAsOf`, plus `prev_close` and
    the gap.
  - A row whose `spx_open` is present came from a replay. Through
    2026-11-18 every live row has a NULL open, and the upsert never lets a
    backtest write overwrite a live row. It gets four fields:
    - `spx_high` and `spx_low` from `priceContextAsOf`. This removes the
      5-minute peek: the replay read the bar that starts at the slot.
      Decided by the owner on 2026-11-18.
    - `prev_close` and the gap, the gap from its own `spx_open`.
    It is written only when the values differ at the column's 2 decimals.
    If its stored open differs from the as-of open, it is skipped as
    `open-mismatch` and listed.
  - The script covers dates through 2026-11-18 only. From 2026-11-19, live
    rows carry the quote's real-time open, high and low (Task 2), which must
    not be overwritten. The server builder (phase 5) owns those dates.
  - The stored spot (`spx`) keeps its 5-minute peek until phase 6. Other
    stored values derive from it, such as the opening-range share consumed,
    so rewriting it alone would leave a row inconsistent.
  - A date with fewer candles than its slot count, or with no previous-day
    close, is skipped whole.
- CLI:
  - It fetches `${APP_URL}/api/history?date=D` with the owner cookie, the
    same way `save-history.mjs` does, never printing it. It takes
    `previousDayClose` from `spx.previousDay.close`, so it doesn't depend on
    task 1 being deployed.
  - It pages the DB read by date.
  - `--since` and `--until` limit the dates.
  - **Dry run** (the default) writes
    `docs/tmp/snapshot-price-context/dry-run-<ts>.json` and prints:
    - counts by kind and skip reason;
    - two sample rows per kind, for the hand check;
    - the dates whose `pickFeatureSnapshot` choice changes after the update.
  - `--apply` writes `undo-<ts>.json` first, then runs batched, guarded
    UPDATEs.
  - `--undo-file F --apply` restores.

- [ ] **Step 1: Write the failing pure tests** in
  `snapshot-price-context.test.ts`:
  - `a live row with NULL open gets the as-of open, high, low, previous close and gap`:
    - 8:35 CT row, candles as in task 3, `previousDayClose` 7560.87.
    - Expect `{spx_open 7487, spx_high 7495, spx_low 7480, prev_close 7560.87}`
      and gap ≈ −0.97700.
  - `an ET-labelled row maps to the same slot as its CT label`:
    "9:35 AM ET" gives the same result as "8:35 AM CT".
  - `a NaN spx_open counts as missing`.
  - `pre-market and unparseable labels are skipped as no-slot`.
  - `a backtest row gets only prev_close and gap, from its own spx_open`:
    - Stored `prev_close 7720.39`, `spx_open 7377.65`, gap −4.44.
    - `previousDayClose` 7356.73.
    - Expect `prev_close 7356.73` and gap ≈ 0.28437. High and low are
      untouched.
  - `a row already right is skipped as unchanged`.
  - `a date with fewer candles than its slot count is skipped whole`: 77
    candles on a full day.
  - `an early-close date needs only its own slot count`.
- [ ] **Step 2: Write the failing pglite tests** in
  `snapshot-price-context-pglite.test.ts`:
  - `apply writes the planned values and an undo file`;
  - `apply skips a row changed since planning`: the guard fails, and the
    script reports it;
  - `a second plan after apply yields no updates`;
  - `undo restores the original values, NULL and NaN included`.
- [ ] **Step 3: Run both files and see them fail.**
- [ ] **Step 4: Implement** `planDate`, the SQL helpers and the CLI.
- [ ] **Step 5: Run both files. Expected: PASS.**
- [ ] **Step 6: Run `npm run review` and commit**
  `feat(scripts): Backfill the SPX price context on snapshot rows`.
- [ ] **Step 7, main session, after the deploy and outside 13:00–23:00 UTC:**
  - Run the dry run.
  - Hand-recompute one live and one backtest row from raw candles and
    `outcomes.settlement`.
  - Bring the counts and the feature-pick changes to the owner.
  - `--apply` only on their OK.
  - Then rebuild `training_features` only for the dates the dry run listed
    as changing their pick.
