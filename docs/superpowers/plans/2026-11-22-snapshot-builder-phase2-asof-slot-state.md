# Snapshot builder phase 2: as-of slot state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every value the page's backtest view takes at a slot (spot, running OHLC, opening range, the VIX family) comes from bars that have ended by that slot. That logic lives in one pure module the server builder will reuse.

**Architecture:**
- `src/utils/snapshot-slot.ts` already holds phase 1's `priceContextAsOf`. It gains three pure functions:
  - `symbolPriceAsOf`: one symbol's price at a slot;
  - `spxSlotStateAsOf`: spot, running OHLC, opening range and entry index;
  - `historySnapshotAt`: the whole `HistorySnapshot` assembly, moved out of `useHistoryData.getStateAtTime`.
- `useHistoryData` keeps its fetch and calls `historySnapshotAt`. Its four look-ahead helpers are deleted.
- Some consumers change so they stay correct when, at the open, there is no opening range yet and the entry index is −1:
  - the opening-range card: empty defaults, a key on the slot, and no live range on a past date;
  - the term-structure card's key, on the slot;
  - `useRangeAnalysis`'s opening-range source;
  - the settlement doc.

**Tech Stack:** TypeScript, React 19 hooks, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md`: phase 2, call 1 (the as-of rule), and "Why G2: the look-ahead today".

**Why now:** owner rule, 2026-11-22: "I don't want anything to depend on the app being open or not, everything should be backend". This phase is step 1 of 4 toward a server-written live capture, in which the server builds every 5-minute row from candles, so the 10:00 row exists whether or not the app is open.

## Global Constraints

- **The as-of rule** (spec call 1, verbatim): "A row at slot T uses only bars that end at or before T."
  - "Spot is the close of the bar ending at T, which is the bar starting at T−5."
  - "At 8:30 CT no bar has ended, so spot is the first bar's open."
  - "The running high and low cover the bars ended by T. At 8:30 the open, high, low and last are all the first bar's open."
  - "VIX, VIX1D, VIX9D and VVIX follow the same rule on their own candles."
  - "The opening range covers the bars ended by T: partial before 9:00 CT, as live `/api/intraday` reports it. `openingRangeAvailable` keeps its current rule."
- **Bars.** Candles are 5-minute bars labelled by their start (`datetime`, epoch ms). A bar that starts at ET minute s has ended at slot T when `s + 5 ≤ T`, as in `priceContextAsOf`.
- **Units.** Every new `snapshot-slot.ts` function takes `slotMinuteCT`, minutes since midnight CT, in the units `parseEntryTimeMinutes` returns (8:30 AM CT = 510). `getStateAtTime(hourET, minuteET)` keeps its ET signature and converts with `ET_AHEAD_OF_CT_MIN` (`src/utils/entry-time.ts`).
- **The module stays importable from `api/` and `scripts/`.** Every non-type relative import needs a `.js` extension, and it is already linted as such (`API_COMPILED_SRC` covers `src/utils/**/*.ts`). No React, no I/O, no `Date.now()`.
- **No throws.** `getStateAtTime` runs during App render (`useAutoFill.ts:391`), so every new function returns null on bad input.
- **`priceContextAsOf` keeps its exact behaviour.** Its existing tests in `src/__tests__/utils/snapshot-slot.test.ts` stay green unchanged; the phase-1 backfill relies on it.
- **No new dependencies.** Look-ahead checks are deterministic sweeps, like the existing "look-ahead (spec G2)" block, with one perturbed copy per slot so they stay well under the 15 s test timeout.
- **This phase changes the page's backtest values, by owner decision** (spec phase 2). Live rows are unaffected.
- **Workflow.** One commit per task, through the Get It Right loop. `npm run review` (now behind the machine-wide gate lock) passes before each commit, and the worktree is based on current `origin/main`.
- **Push timing** (spec, Phases): every task touches `src/`, so the push redeploys Vercel. On weekdays, push after the 3:00 PM CT close.
- **One rule for a bar with an invalid `datetime`** (NaN, infinite, or past the Date range): any such bar makes every function in the module return null for that series, at every slot, as `priceContextAsOf` already does ("no telling whether it has ended"). Never skip it, and never pass it to the ET formatter, which throws.

## Review Focus

These are the conditions the spec implies but doesn't spell out, most likely to bite first. Each has its test in the task named.

1. **8:30 CT on a past date.** No opening-range bar has ended. The card must show empty inputs: not a zero-width range (which renders a red "High must be greater than low."), not its hard-coded 5735/5705 defaults (a green "RANGE INTACT" from a made-up range), and not today's live range. (Tasks 1, 2, 4.)
2. **Today's partial session.** The page fetches today's candles once, and the last bar may still be running. A slot inside that bar uses the bar before it; a slot after every bar uses the last one. (Task 1.)
3. **A missing bar mid-session.** The last ended bar is the one before the gap, `entryIndex` is its index in the array, and the opening range still completes at 9:00 CT. (Task 1.)
4. **A sparse, empty or corrupt VIX-family series** (VIX1D is often absent): null before its first bar, null for a series with an invalid `datetime`, never a throw and never another bar's value. (Task 1.)
5. **A user's edit at the open, or at a missing SPX bar.** An edit typed into the opening-range or term-structure card must reset at the next slot. That includes 8:30 to 8:35, where both slots report the same first bar, and the two slots around a missing SPX bar, where the VIX family still moves. So the cards key on the slot itself. (Tasks 2, 3.)

---

### Task 1: As-of slot primitives

**Files:**
- Modify: `src/utils/snapshot-slot.ts`
- Test: `src/__tests__/utils/snapshot-slot.test.ts` (add new `describe` blocks; leave the `priceContextAsOf` blocks untouched)

**Interfaces:**
- Consumes: `SlotCandle` and `priceContextAsOf` (already in the file); `CASH_OPEN_MIN_ET`; `ET_AHEAD_OF_CT_MIN`; `getETTotalMinutes`.
- Produces:

```ts
export interface SpxSlotState {
  readonly spot: number;
  readonly runningOHLC: {
    readonly open: number; readonly high: number;
    readonly low: number; readonly last: number;
  };
  /** Null until the first opening-range bar has ended (8:30 CT). */
  readonly openingRange: {
    readonly high: number; readonly low: number;
    readonly rangePts: number; readonly complete: boolean;
  } | null;
  /** Index in `candles` of the last bar ended by the slot; −1 when none has. */
  readonly entryIndex: number;
}
export function symbolPriceAsOf(candles: readonly SlotCandle[], slotMinuteCT: number): number | null;
export function spxSlotStateAsOf(candles: readonly SlotCandle[], slotMinuteCT: number): SpxSlotState | null;
```

**Rules the code must follow:**
- **`symbolPriceAsOf`** returns the first of these that applies:
  1. the close of the last bar ended by the slot (the highest index whose bar ended);
  2. if no bar has ended, the open of the last bar that has started (`start ≤ slot ET`);
  3. otherwise null.

  More rules:
  - It is null when `slotMinuteCT` isn't finite, when there are no candles, when any bar's `datetime` is invalid (the module-wide rule in Global Constraints), or when the chosen value isn't a finite price above 0.
  - There is no 9:30-first-bar requirement, because VIX-family series can be sparse.
- **`spxSlotStateAsOf`** is null whenever `priceContextAsOf(candles, slotMinuteCT)` is null; that function holds the validation.
  - Otherwise it uses `priceContextAsOf`'s open, high and low for `runningOHLC`.
  - `spot` and `runningOHLC.last` are `candles[entryIndex].close` when `entryIndex ≥ 0`, else `candles[0].open`. A spot that isn't a finite price above 0 makes the result null.
  - **Opening range.** Its bars are those that start before 10:00 ET (ET minute 600) and have ended by the slot.
    - It is null while none of those has ended (8:30–8:34 CT).
    - Otherwise `high` = max of their highs, `low` = min of their lows, `rangePts` rounded to 2 decimals, `complete = slotET ≥ 600`.
    - A named constant for 10:00 ET goes in `snapshot-slot.ts`, unless `marketHours.ts` already has one.
  - **Why the opening range is null, not zero-width, at the open.** `OpeningRangeCheck` flags high ≤ low as "High must be greater than low." (`OpeningRangeCheck/index.tsx:67, 243-246`). `useRangeAnalysis` would turn it into a GREEN signal with 0% consumed.

**Fixture (`asOfDay(n)`, new name: `session` is already a module-level helper in this file).**
- Bar i starts at 9:30 ET + 5i on 2026-07-15 (CDT, so 9:30 ET = 13:30 UTC), as `Date.UTC` constants, the way the existing tests build times (`snapshot-slot.test.ts:6-9`).
- Prices: `open 6000+i`, `high 6003+i`, `low 5998+i`, `close 6001+i`.
- 78 bars is a full day; 42 is a half day, whose last bar starts at 12:55 ET.

- [ ] **Step 1: Write the failing tests**

```ts
describe('spxSlotStateAsOf: the as-of table (78 bars)', () => {
  const day = asOfDay(78);
  it.each([
    // [label, slotMinuteCT, spot, high, low, openingRange, entryIndex]
    ['8:30', 510, 6000, 6000, 6000, null, -1],
    ['8:35', 515, 6001, 6003, 5998, { high: 6003, low: 5998, rangePts: 5, complete: false }, 0],
    ['8:55', 535, 6005, 6007, 5998, { high: 6007, low: 5998, rangePts: 9, complete: false }, 4],
    ['9:00', 540, 6006, 6008, 5998, { high: 6008, low: 5998, rangePts: 10, complete: true }, 5],
    ['9:05', 545, 6007, 6009, 5998, { high: 6008, low: 5998, rangePts: 10, complete: true }, 6],
    ['2:55 PM', 895, 6077, 6079, 5998, { high: 6008, low: 5998, rangePts: 10, complete: true }, 76],
    ['3:00 PM', 900, 6078, 6080, 5998, { high: 6008, low: 5998, rangePts: 10, complete: true }, 77],
  ])('%s CT', (_l, slot, spot, high, low, openingRange, idx) => {
    expect(spxSlotStateAsOf(day, slot)).toEqual({
      spot,
      runningOHLC: { open: 6000, high, low, last: spot },
      openingRange,
      entryIndex: idx,
    });
  });
});
```

Also add:
- **`a half day (42 bars)`.** At 11:55 CT (715): spot 6041, entryIndex 40. At 12:00 CT (720): spot 6042, entryIndex 41. At 12:30 CT (750): the same as 12:00.
- **`today's partial session`** (`asOfDay(10)`, last bar starting 10:15 ET):
  - 9:17 CT (557): spot 6009, entryIndex 8;
  - 9:20 CT (560): spot 6010, entryIndex 9;
  - 10:00 CT (600): spot 6010, entryIndex 9.
- **`a slot between 5-minute marks`.** This is defensive: the time picker and the live sync both snap to 5 minutes (`DateTimeSection.tsx:137`, `useAutoFill.ts:232`), but the server builder takes any minute. At 8:37 CT (517): spot 6001, entryIndex 0. At 8:34 CT (514): spot 6000, entryIndex −1, openingRange null.
- **`a gap mid-session`.** Drop bar 3 (the 9:45 ET bar) from `asOfDay(78)`:
  - at 8:55 CT (535): spot 6005 and entryIndex 3, because the 9:50 bar sits at index 3 now;
  - at 9:00 CT the opening range is `{ high: 6008, low: 5998, rangePts: 10, complete: true }`.
- **`before the open and bad input`:**
  - 8:29 CT (509) is null;
  - NaN is null;
  - `[]` is null;
  - a session whose first bar starts 9:35 ET is null;
  - a last ended bar with close NaN is null.
- **`look-ahead sweep (G2)`.** Two perturbed copies per slot, for every slot minute from 505 to 905: one with 9999 and one with NaN, so the sweep also catches code that validates a bar that hasn't ended. In each copy:
  - every bar that hasn't started by the slot has all four prices replaced;
  - every bar that has started but not ended has its high, low and close replaced.

  `spxSlotStateAsOf(copy, slot)` deep-equals `spxSlotStateAsOf(asOfDay(78), slot)`. Do the same for `symbolPriceAsOf`.
- **`symbolPriceAsOf`:**
  - Its own table on `asOfDay(78)`: 510 gives 6000, 515 gives 6001, 540 gives 6006, 895 gives 6077.
  - A sparse series with one bar starting 11:00 ET, open 15.1 and close 15.3: 595 gives null, 600 gives 15.1, 604 gives 15.1, 605 gives 15.3, 900 gives 15.3.
  - `[]` and NaN give null.
  - **An invalid `datetime`.** A series whose bar 2 has `datetime: NaN` returns null at 515, 545 and 895, the same rule as `priceContextAsOf`, and doesn't throw. The same holds for `Infinity`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/__tests__/utils/snapshot-slot.test.ts`
Expected: FAIL. `symbolPriceAsOf` and `spxSlotStateAsOf` are not exported. The existing `priceContextAsOf` tests pass.

- [ ] **Step 3: Implement both functions in `src/utils/snapshot-slot.ts`** under the rules above. Add a docblock on each that quotes the as-of rule.

- [ ] **Step 4: Run the file**

Run: `npx vitest run src/__tests__/utils/snapshot-slot.test.ts`
Expected: PASS, and the file finishes in a few seconds.

- [ ] **Step 5: Gate and commit**

Run `npm run review`. Then:
`git add -- src/utils/snapshot-slot.ts src/__tests__/utils/snapshot-slot.test.ts && git commit -F <msg>`, with the message `feat(snapshots): Add as-of spot, running range, opening range and symbol price for a slot`.

---

### Task 2: The opening-range card: empty when there is no range, a key on the slot, and no live range on a past date

**Files:**
- Modify: `src/components/OpeningRangeCheck/index.tsx:45-46` (the hard-coded defaults)
- Modify: `src/components/MarketRegimeSection.tsx:155-168` (the `OpeningRangeCheck` key and `initialRange`)
- Test: `src/__tests__/components/OpeningRangeCheck.test.tsx`, `src/__tests__/components/MarketRegimeSection.test.tsx`

**Interfaces:**
- Consumes: `HistorySnapshot.openingRange` (unchanged in shape; from Task 5 on it is null at the open) and the `entryTimeLabel` prop `MarketRegimeSection` already receives (`MarketRegimeSection.tsx:47`).
- Produces: nothing new.

**Why:**
- **Defaults.** `OpeningRangeCheck` starts at `useState('5735')` / `useState('5705')`, and its sync effect (`:50-55`) writes only when `initialRange` is set. So a remount with no range shows a made-up 30-point range, with a green "RANGE INTACT".
  - `VIXTermStructure/index.tsx:43-46` already documents the rule this follows: "a made-up default would read as that date's data". The defaults become `''`.
  - Side effect: the live view with no intraday range yet (before today's first bar) shows empty inputs instead of 5735/5705. That is the honest state.
- **The key.** The card re-syncs `initialRange` unless the user has edited it, so the key exists only to drop an edit when the slot changes.
  - `candle.datetime` doesn't move between 8:30 and 8:35 CT under the as-of rule.
  - (candle, index) doesn't move around a missing SPX bar, even though other values do.
  - The slot label does both exactly: key `hist-or-${entryTimeLabel ?? `${historySnapshot.candle.datetime}:${historySnapshot.candleIndex}`}`.
- **No live fallback on a past date.** Today `initialRange` is `historySnapshot?.openingRange ?? market.data.intraday?.openingRange`. With a null history range (8:30 CT), that would show today's live range on a past date.

- [ ] **Step 1: Write the failing tests**
  - **`OpeningRangeCheck`, with no `initialRange`:** both inputs are empty, and no analysis banner is shown. Rewrite the tests that pin 5735/5705 (`OpeningRangeCheck.test.tsx:41` "Defaults (5735/5705) produce an analysis immediately", and `:270-271`) to type a range first. Don't delete them.
  - **`MarketRegimeSection`, the edit resets at the next slot:**
    - Render with a history snapshot (`openingRange: null`) and `entryTimeLabel: '8:30 AM CT'`, then type a high and a low.
    - Rerender with `entryTimeLabel: '8:35 AM CT'` and `openingRange: { high: 6003, low: 5998, rangePts: 5, complete: false }`.
    - The card shows 6003/5998, not the typed values. Follow the pattern at `IVInputSection.test.tsx:395-417`.
  - **`MarketRegimeSection`, no live range on a history snapshot:** a history snapshot with `openingRange: null`, and `market.data.intraday.openingRange` = `{ high: 7000, low: 6900, ... }`. The card shows empty inputs and no red message, not 7000/6900.
- [ ] **Step 2: Run both files and see the new tests fail.**
- [ ] **Step 3: Implement.**
  - Set the defaults to `''`.
  - Change the key as above.
  - `initialRange`: with a history snapshot, `historySnapshot.openingRange ?? undefined`; without one, `market.data.intraday?.openingRange ?? undefined`.
- [ ] **Step 4: Run** `npx vitest run src/__tests__/components/OpeningRangeCheck.test.tsx src/__tests__/components/MarketRegimeSection.test.tsx`. Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then commit with the message `fix(backtest): Show no opening range until one exists, key the card on the slot, and keep today's range off past dates`.

---

### Task 3: The term-structure card's key, on the slot

**Files:**
- Modify: `src/App.tsx`. Pass the same `entryTimeLabel` that App gives `MarketRegimeSection` to `IVInputSection`.
- Modify: `src/components/IVInputSection/index.tsx:106-110`. Add an optional `entryTimeLabel?: string` prop. `termStructureKey` with a history snapshot becomes `hist-${entryTimeLabel ?? `${historySnapshot.candle.datetime}:${historySnapshot.candleIndex}`}`.
- Test: `src/__tests__/components/IVInputSection.test.tsx`

**Interfaces:**
- Consumes: App's existing `entryTimeLabel` value.
- Produces: the `IVInputSection` prop `entryTimeLabel?: string`.

- [ ] **Step 1: Write the failing test.** With a history snapshot whose `candle` stays the same, type into the term-structure card at `entryTimeLabel: '8:30 AM CT'`. Rerender at `'8:35 AM CT'`: the edit is gone. This uses the pattern at `IVInputSection.test.tsx:395-417`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/components/IVInputSection.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the prop, the key and the App wiring.
- [ ] **Step 4: Run** the IVInputSection test and `npx vitest run src/__tests__/App` (the App test files touched by the prop). Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then commit with the message `fix(backtest): Key the term-structure card on the slot`.

---

### Task 4: Range analysis and settlement for the open

**Files:**
- Modify: `src/hooks/useRangeAnalysis.ts:241` (the opening-range source)
- Modify: `src/utils/settlement.ts:5-31` (doc)
- Test: `src/__tests__/hooks/useRangeAnalysis.test.ts`, and the existing settlement test file (`grep -rln computeSettlement src/__tests__`; create `src/__tests__/utils/settlement.test.ts` only if none exists)

**Interfaces:**
- Consumes: `historySnapshot.openingRange`, now nullable in practice, and `candleIndex`, −1 at the open. Both come from Task 5's `historySnapshotAt`; the field types are unchanged.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**
  - **`useRangeAnalysis`:** a history snapshot with `openingRange: null` and a `liveOpeningRange` of `{ high: 7000, low: 6900 }` gives a null opening-range signal, not one computed from the live range.
  - **Settlement:** candles where bar 0's high is 6050 and every later high is at most 6010, with call 6040 and put 5900. `computeSettlement(candles, -1, 6040, 5900, 10)?.survived` is `false`; with `entryIndex 0` it is `true`. This may pass already; it pins the behaviour.
- [ ] **Step 2: Run both files and see the range-analysis test fail.**
- [ ] **Step 3: Implement.**
  - `orData`: with a history snapshot, use `historySnapshot.openingRange`; without one, use `liveOpeningRange`.
  - Rewrite the `settlement.ts` entry-convention doc so it names the new source (`historySnapshotAt` / `spxSlotStateAsOf`: the entry is the close of the last bar ended by the slot). Say that −1 means no bar has ended, the entry is the first bar's open, and the scan starts at bar 0. Drop the references to `useHistoryData.getStateAtTime` and `computeRunningOHLC`.
- [ ] **Step 4: Run** both test files. Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then commit with the message `fix(backtest): Take no live opening range on a past date, and document the entry at the open`.

---

### Task 5: `historySnapshotAt`, and `useHistoryData` on top of it

**Files:**
- Modify: `src/utils/snapshot-slot.ts`. Move the `HistorySnapshot` interface here and update its field docs (below). Add `historySnapshotAt`.
- Modify: `src/hooks/useHistoryData.ts`. Re-export the type with `export type { HistorySnapshot } from '../utils/snapshot-slot';`. `getStateAtTime` calls `historySnapshotAt`. Delete `findCandleAtTime`, `getSymbolPriceAtTime`, `computeRunningOHLC` and `computeOpeningRange`.
- Test: `src/__tests__/utils/snapshot-slot.test.ts`, `src/__tests__/hooks/useHistoryData.test.ts`, `src/__tests__/hooks/liveSessionSave.test.ts`

**Interfaces:**
- Consumes: `spxSlotStateAsOf` and `symbolPriceAsOf` (Task 1); `HistoryResponse` (`src/types/api.ts`, type-only import).
- Produces:

```ts
export function historySnapshotAt(
  history: HistoryResponse,
  slotMinuteCT: number,
): HistorySnapshot | null;
```

**Field by field:**
- `historySnapshotAt` returns null when `history.spx.candles` is empty or `spxSlotStateAsOf` is null.
- From the SPX state:
  - `spot`, `runningOHLC` and `openingRange`;
  - `candleIndex` = `entryIndex`;
  - `candle` = `candles[max(entryIndex, 0)]`;
  - `totalCandles` = `candles.length`.
- `spy` = `Math.round((spot / 10) * 100) / 100`.
- `vix`, `vix1d`, `vix9d` and `vvix` = `symbolPriceAsOf` on each symbol's candles.
- `yesterday`, `previousClose` and `vixPrevClose` are exactly as today: `history.spx.previousDay`, `history.spx.previousClose`, and `history.vix.previousClose || null`.
- `getStateAtTime(hourET, minuteET)` returns `history ? historySnapshotAt(history, hourET * 60 + minuteET - ET_AHEAD_OF_CT_MIN) : null`, keeping its `useCallback([history])`.

**`HistorySnapshot` field docs to rewrite:**
- `spot`: "the close of the last bar ended by the slot; the first bar's open at the open".
- `runningOHLC`: "over bars ended by the slot".
- `openingRange`: "the 9:30–10:00 ET bars ended by the slot; null until the first has; complete from 10:00 ET".
- `candle`: "identifies the as-of position, for React keys and labels. It is the last bar ended by the slot, or the first bar at the open. At the open its high, low and close are not yet known, so never read its prices: use `spot`, `runningOHLC` and `openingRange`".
- `candleIndex`: "index of the last bar ended by the slot; −1 at the open".

**Not touched:** `BacktestDiag` will show "candle 0/78" at the open. For a diagnostic that reads correctly as "no bar ended yet", so it is left as is.

- [ ] **Step 1: Write the failing tests.**
  - **In `snapshot-slot.test.ts`, `historySnapshotAt`:**
    - Build a `HistoryResponse` from `asOfDay(78)` for SPX, the same bars ÷ 300 for VIX, `[]` for VIX1D, and `asOfDay(78)` ÷ 400 for VIX9D and VVIX.
    - At 510: `spot 6000`, `spy 600`, `candleIndex -1`, `candle` is bar 0, `openingRange null`, `vix` is bar 0's open ÷ 300, `vix1d null`.
    - At 540: `spot 6006`, `candleIndex 5`, `openingRange.complete true`, `vix` is bar 5's close ÷ 300.
    - `previousClose`, `yesterday` and `vixPrevClose` pass through unchanged. A `vix.previousClose` of 0 becomes `null`.
    - An empty SPX array returns null.
    - **The look-ahead sweep, across all five symbols.** Apply Task 1's two per-slot perturbations (9999 and NaN) to all five symbols at once, for every slot from 505 to 905. The result deep-equals the unperturbed result on every field except `candle`, the documented identity field.
  - **In `useHistoryData.test.ts`, rewrite the tests that pin the old look-ahead** under their existing names where the meaning holds, and rename them where it doesn't:
    - "returns snapshot at exact candle time": at a 5-minute mark T, spot is the close of the bar that started at T−5.
    - "returns previous candle for non-boundary time": becomes "returns the last bar ended by a time between marks".
    - "returns first candle for pre-market time": becomes "returns null before the open". This is a deliberate change, because a pre-open time has no as-of data.
    - "computes running OHLC correctly" and "stops the running high and low at the requested time": counted over ended bars only.
    - "computes opening range from first 6 candles": becomes "the opening range is null at 9:30 ET, partial before 10:00 ET and complete from 10:00 ET".
    - "opening range is incomplete with fewer than 6 candles": keep the name; it now asserts `complete: false` at a slot before 10:00 ET.
    - The VIX-value tests read the bar ended by the slot.
    - Add **"a date whose first bar is not 9:30 ET has history but no state"**: `hasHistory` is true and `getStateAtTime(10, 0)` is null. That keeps the module's "null over a guessed value" rule.
      - **Known limit, accepted.** On such a date `useAutoFill` stops at `if (!snapshot) return;` (`:301-302`), so the no-history branch never runs. Some cards then fall back to today's live VIX family, intraday range and quotes (`useComputedSignals.ts:234-240`, `MarketRegimeSection`).
      - The same null now happens at a pre-open time on a past date, where the calculator shows no results anyway (`useCalculation.ts:68-72`).
      - The 2026-11-21 price-context dry run found 0 such dates in Schwab's whole depth (`bad-candles: 0`). The page's backtest view is replaced by server rows from phase 4 on, so this is not fixed here.
    - Keep every fetch, abort, schema, public-visitor and `historyVixOHLC` test unchanged.
  - **In `liveSessionSave.test.ts`,** `expectPastVixInput` (`:1041`) at 9:40 CT now expects bar 13's close (18.26), not bar 14's (18.28).
    - Add a new constant for it (for example `AS_OF_940_VIX`).
    - Keep `LAST_CANDLE_VIX` for `:551` and `:567`. Those are today's live checks, where the last bar's VIX is the right value.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/utils/snapshot-slot.test.ts src/__tests__/hooks/useHistoryData.test.ts src/__tests__/hooks/liveSessionSave.test.ts`. Expected: the new and rewritten tests FAIL, the rest PASS.
- [ ] **Step 3: Implement.**
  - Add `historySnapshotAt`, and move `HistorySnapshot` into `snapshot-slot.ts` with the new docs.
  - Rewire `getStateAtTime`, add the type re-export and delete the four helpers.
  - Run `grep -rn "HistorySnapshot" src` and confirm every importer still resolves through the re-export. Change none of them.
- [ ] **Step 4: Run** the three files, plus `npx vitest run src/__tests__/hooks/useAutoFill.test.ts src/__tests__/hooks/useRangeAnalysis.test.ts src/__tests__/components/BacktestDiag.test.tsx src/__tests__/components/SettlementCheck.test.tsx`. Expected: PASS. If a consumer test pinned a look-ahead value, update it to the as-of value and give the reason in the commit body.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then commit with the message `fix(backtest): Read every backtest value as of its slot, through the shared slot module`. The body names the spec's G2 and the rewritten tests.

---

## Not in this phase

- **The VIX1D daily-map rule (rule 10) and the rest of the row math** (`useCalculation`, regime, term structure, range analysis, `sigmaSource`, payload assembly) belong to phase 3.
- **Stored rows are not rebuilt.** Rebuilding them under the as-of rule is phase 6.
- **Already linted.** `API_COMPILED_SRC` covers `src/utils/**/*.ts`, so phase 4 needs no lint change for `snapshot-slot.ts`.
- **Page backtest saves.** Until the server refuses them (spec call 13, phase 5), browsing a past date keeps overwriting that date's stored backtest rows (`db-snapshots.ts:236-238`).
  - After Task 5 those writes carry as-of SPX, opening range and VIX, but still the VIX1D midpoint, which phase 3 fixes.
  - A tab on an old bundle still writes look-ahead rows.
  - Phase 6 rebuilds every backtest row, so the mix is temporary. Whether to bring call 13 forward is an owner question (2026-11-22).
