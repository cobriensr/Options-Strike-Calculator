# Panels follow the new date at midnight (2026-11-14)

## Goal

When the app is left open across midnight, every panel that keeps its own
date moves to the new trading date, unless the owner picked a different
date. The calculator already does this (`useVixData`, shipped 2026-11-14 in
fc936c94..dd3f6910). Owner decision, 2026-11-14: "yeah lets make those
panels follow the new date too".

## Today's behavior (inventory at origin/main 11923348)

- **Clocks.** `useETToday` is a per-instance `setTimeout` that re-arms at
  ET midnight (capped at 1 h), and only `useVixData` calls it. Each panel
  reads `getETToday()` or a CT `todayCt()` itself, or latches a `today` at
  mount.
- **Memoized panels.** These skip App's midnight re-render, so they only
  notice the new day on their next render of their own: GexLandscape,
  GexTarget, ZeroGamma, GreekFlow, StrikeBattleMap, DealerRegime and
  PinSetupTile.
- **What goes wrong across midnight, per panel:**

| Panel                                                    | Date seed                                                                                       | What happens                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark pool (`useDarkPoolLevels`, in App)                  | `useState(getETToday)`                                                                          | Turns into a BACKTEST of yesterday. LIVE clears the scrub but never returns the date to today.                                                                            |
| GEX target (`useGexTarget`, in App)                      | `useState(initialDate ?? getETToday())`                                                         | Turns into yesterday's history.                                                                                                                                           |
| GEX landscape                                            | `useState(getETToday)`                                                                          | The date never reaches the server; only the local resets (scrub, top strikes) miss the roll.                                                                              |
| Greek heatmap                                            | `useState(getETDateStr(now))`; `today` refreshed only on `visibilitychange`; `max` set at mount | Today's data appears under the old date's heading until the tab is refocused.                                                                                             |
| Greek flow, zero gamma, strike battle map, dealer regime | `useState(today)`, with `today` read on each render                                             | Shows yesterday as "live" until the next render of its own.                                                                                                               |
| Periscope lottery                                        | `today = useMemo(…, [])`                                                                        | Keeps polling yesterday as "live" through the next session; `max` blocks picking the new day.                                                                             |
| Pin setup                                                | `null` means live; display and `max` latched at mount                                           | The data follows, but the label shows the old date and `max` blocks the new day.                                                                                          |
| Opening flow                                             | `''` means live; `today` read on each render                                                    | The data follows. Only the display and `max` need the clock.                                                                                                              |
| Lottery Finder, Silent Boom                              | `useState(todayCt())` plus `manualDatePick` and a 60 s `setInterval` roll                       | Rolls already, but up to 60 s late, and each panel runs its own interval. It flags itself historical in that gap. Lottery Finder keeps a scrubbed minute across the roll. |
| Interval B/A                                             | `useState(todayCt())`                                                                           | Never rolls.                                                                                                                                                              |

## Design

1. **One shared ET clock.** Rewrite `useETToday` onto `useSyncExternalStore`
   over a module-level store:
   - one ref-counted `setTimeout`, armed when the first subscriber arrives
     and cleared when the last one leaves;
   - a cached `today` that moves only when the timer fires;
   - the clock is re-read on `visibilitychange` and `focus`, which covers
     laptop sleep and throttled background timers.

   Every subscriber, memoized or not, re-renders in the same commit. The
   cache starts lazily from `getETToday()` and is re-read on the first
   subscribe, so existing tests that mock `getETToday` keep working.
   `useVixData` keeps calling `useETToday()` with no change. Existing
   `useETToday` and `useVixData` tests must stay green unchanged (the
   1-then-0 timer count, and the window where the wall clock is past
   midnight before the tick).

2. **One "follow today" helper**, `useFollowedDate()`, returning
   `{ date, setDate, today }`:
   - It stores only `pickedDate: string | null`; `date = pickedDate ?? today`.
   - `setDate(d)` stores null when `d` is `''` or equals `getETToday()` read
     at the moment of the pick (an emptied field follows today).
   - Any other date stays put across midnight.
   - Panels judge "live" as `date === today`, not `pickedDate === null`, so a
     picked tomorrow turns live at midnight, as in `useVixData`.
   - **Visible cost of `''` meaning follow** (_my call_). Leaving a panel's
     date field empty snaps it back to today, as PinSetup already does. It
     snaps on blur, not the moment the field empties: the shared
     `DateInput` (`src/components/ui/DateInput.tsx`) keeps an emptied field
     as a local draft, and forwards `''` only when the field is left empty.
     A native date input fires `input` with `''` on the first `0` of a
     zero-padded month or day, so forwarding it at once rewrote the field
     to today and lost the segments typed so far (typing `04092026` over
     `2026-11-15` ended at `2026-11-09`). Found in review of Phase 3, in
     real Chrome. Typing a date key by key is safe. The calculator differs
     on purpose: it has its own date input and keeps `''` while a date is
     being typed.
   - **Rule for every migrated panel.** Replace each wall-clock
     `getETToday()` read in it with the helper's `today`, e.g.
     `useDarkPoolLevels.ts:126` and `useGexTarget.ts:313,617`. Otherwise
     `date === today` and `date === getETToday()` can disagree for up to
     1 s.
3. **Every panel uses the ET clock**, including the CT-keyed ones (_my call_):
   - Lottery Finder and Silent Boom stamp their stored `date` with the ET
     date (`detect-lottery-fires.ts`, `detect-silent-boom.ts`), and their
     servers default to ET. CT is used there only for times of day.
   - Interval B/A is keyed to the CT date (SPXW expiry). Rolling at ET
     midnight differs only from 23:00 to 24:00 CT, when nothing fires or
     polls: it shows an empty new day an hour sooner.
     - Checked against prod, read-only, on 2026-11-14, over 60 days of
       `interval_ba_alerts`: no alert in any ticker at or after 23:00 CT,
       none after 15:15 CT and no SPXW alert before 08:30 CT. SPY and QQQ
       have 3 and 10 before 08:30 CT.
     - SPXW's overnight session doesn't reach this table.
   - **The CT comparators move too.** Each hook that compares a date with
     a CT today moves onto the shared clock in the same phase as its
     panel. On the ET date, it would otherwise call the new day historical
     from 23:00 to 24:00 CT. The hooks:
     - `useLotteryFinder.ts:209,244`;
     - `useNetFlowHistory.ts:58`, `useContractTape.ts:58` and
       `useTickerCandles.ts:54`, the row hooks fed by fire dates, which
       are ET-stamped;
     - `useIntervalBAFeed.ts:230`.
   - Result: one moment, 11 PM CT, for every panel, and no second clock.
4. **Panels that already have a live sentinel** (PinSetup `null`,
   OpeningFlow `''`) keep it. They take only their display date and `max`
   from the clock. Periscope's slot (`null` = live, a `{date, time}` pick)
   and CharmClock have no follow-today date state and are left alone.
5. **The calculator.** `useVixData` keeps its own picked-date logic. It
   treats `''` as a pick while a date is half typed, and useAutoFill
   re-follows from there. Moving it onto the helper is the builder's call,
   allowed only if every `useVixData` and `useAutoFill` test stays green
   unchanged.

## Bugs fixed along the way (found by the inventory)

- **Lottery Finder minute.** A scrubbed `minute` survives a date change from
  the roll, so yesterday's minute is sent with the new date. Reset it on any
  date change, as Silent Boom does.
- **Clearing the date field.**
  - Lottery Finder and Silent Boom: `ctSessionBounds('')` formats an Invalid
    Date inside a memo. This is likely a throw caught by the panel's error
    boundary (found by reading the code).
  - Interval B/A: sends `date=`, and the server answers 400.
  - Fix: the helper maps `''` to follow.
- **Dark pool LIVE** on a past date clears the scrub but stays on the past
  date. It should also return to following today.
- **Union keys in `useStickyUnion`** for other dates are swept only on mount.
  Sweep on a date change too, so yesterday's slot doesn't linger.
- **0DTE regime (`useRegime0dte` / `usePolledWindowSignal`).** A tab open
  overnight shows yesterday's last payload as live when the 08:30 CT window
  opens. It stays until the first poll, a full interval later. Date-check
  `state.data` the way the cache already is, and fetch at once when the
  window opens.
- **Stale comments.** `LotteryFinder/index.tsx:462` says "ET-midnight
  auto-roll" but the code compares the CT date.

## Phases

Each phase is one commit of 5 files or fewer. Each runs `npm run review`,
goes through the code-reviewer and is pushed to main (Vercel-only paths, so
any time). Every panel phase adds a test that crosses midnight with fake
`Date` and timers. The test must go red on the old seed-once code; check by
mutation.

1. **Clock and helper.**
   - Files: `src/hooks/useETToday.ts` (shared store), new
     `src/hooks/useFollowedDate.ts`, `src/__tests__/hooks/useETToday.test.ts`,
     new `src/__tests__/hooks/useFollowedDate.test.ts`.
   - Tests: one timer for N subscribers; all subscribers flip in one
     commit; a visibility re-check after a sleep past midnight; StrictMode
     double subscribe; the helper's pick rules (`''`, today, past, future).
2. **App-level hooks.** `useDarkPoolLevels` (also LIVE returns to today),
   `useGexTarget`, their tests, and `DarkPoolLevels` if the LIVE wiring
   needs it.
   - `useGexTarget`'s `initialDate` is test-only: production passes none,
     per the header at `useGexTarget.ts:26-28`. Delete it.
   - Its four test call sites (`useGexTarget.test.ts:518,547,788,877`)
     pick through the returned setter. A fake clock can't start the hook
     on a past date. Mounting now fetches today first, so those tests
     clear `mockFetch` after the pick or revise their counts. The helper
     gets no initial-pick parameter (R3).
3. **Greek flow and zero gamma**, plus their tests.
4. **Strike battle map and dealer regime**, plus their tests.
5. **Greek heatmap and Periscope lottery**, plus their tests. The heatmap
   drops its own `visibilitychange` today, since the clock covers it.
6. **GEX landscape, pin setup and opening flow** (display date and `max`),
   in two commits:
   - **6a. GEX landscape and pin setup**, plus their tests (4 files).
   - **6b. Opening flow**, plus its test (2 files).
7. **Lottery Finder and Silent Boom.** Neither panel has a rollover test
   today. The CT comparators move with them (design item 3).
   - **7a. Lottery Finder and `useLotteryFinder`**, plus tests.
     - Replace `manualDatePick` and the 60 s interval with the helper.
     - Reset the minute on a date change.
     - Move `useLotteryFinder`'s CT today onto the shared clock.
     - Fix the stale comment.
   - **7b. Silent Boom**, plus tests. Same changes as 7a, without the minute
     fix: Silent Boom already resets on a date change.
   - **7c. The row hooks** `useNetFlowHistory`, `useContractTape` and
     `useTickerCandles`: their today comparisons move onto the shared
     clock.
     - The three edits are the same, so one new shared test file,
       `src/__tests__/hooks/rowHooksRollover.test.ts`, crosses midnight for
       all three: 4 files.
     - Edit the existing test files only if a mock there breaks. If that
       pushes past 5 files, split per hook.
8. **Interval B/A.** `IntervalBAFeed` and `useIntervalBAFeed`: `max` and
   the poll gate go on the shared clock, plus tests.
9. **`useStickyUnion`.** Sweep other-date keys on a date change, plus its
   test.
10. **0DTE regime.** Date-check the live payload and fetch when the window
    opens, in `usePolledWindowSignal` and/or `useRegime0dte`, plus tests.

## Data dependencies

None. There are no migrations, env vars, endpoints or server changes.

## Constants

- Timer cap 1 h (`MAX_WAIT_MS`) and the 1 s slack past midnight
  (`MIDNIGHT_SLACK_MS`) are kept as they are.
- No new constants.

## Open questions

- Every panel rolls at ET midnight (_my call_, item 3 of the design). The
  owner can ask for the CT-keyed panels to roll at CT midnight instead. That
  would add a CT clock built the same way.
- An e2e test for one panel's roll is the builder's call. Unit tests with
  fake timers are required.
