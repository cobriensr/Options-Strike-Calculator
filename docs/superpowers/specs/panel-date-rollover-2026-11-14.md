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
  Sweep on a date change too, so yesterday's slot doesn't linger. Fixed in
  Phase 9, relative to the live day and not to the key (see "Found while
  building Phase 9").
- **0DTE regime (`useRegime0dte` / `usePolledWindowSignal`).** A tab open
  overnight shows yesterday's last payload as live when the 08:30 CT window
  opens. It stays until the first poll, a full interval later. Date-check
  `state.data` the way the cache already is, and fetch at once when the
  window opens. Traced, and fixed in Phase 10:
  - `displayData` was `state.data ?? (cache dated today ? cache : null)`: the
    date guard covered only the cache, so a fetched payload from the Friday a
    tab was opened on went straight through.
  - The fetch effect ran once, at mount. The once-a-minute watcher only set
    `isWindowOpen`, never fetched. So after Monday's 08:30 CT open the flag
    flipped on the watcher's next tick (0 to 60 s later), the panel drew
    Friday's payload as live at once, and the first fetch was the 45 s poll
    that starts when the flag flips: 45 to 105 s after the open. With every
    fetch after the open failing, Friday's payload stayed up indefinitely
    (a failed fetch keeps `state.data`).
  - The panel's `useRegime0dte` took "today" from the CT wall clock in render,
    and nothing re-rendered it at midnight. The header badge came from
    `displayData` with no window gate, so over a weekend or a Monday holiday it
    kept showing Friday's gate.
- **Stale comments.** `LotteryFinder/index.tsx:462` says "ET-midnight
  auto-roll" but the code compares the CT date.

### Found while building Phases 4 and 5

- **The scrubbed minute travels with its date.** An effect that clears the
  minute on a date change runs one commit late. The commit that carries the
  new date (the roll, or a date picked while scrubbed) still holds the old
  minute, so the panel asks for the new date at the old minute before the
  clean request. Store the minute as `{date, minute}` (a scope string, or a
  `{scope, at}` pair), read it only while that date is selected, and drop it
  during render when it no longer matches. Dropping it also stops it coming
  back if the date returns. Done for strike battle map, dealer regime, dark
  pool (`useTimeGridScrubber(scope)`) and the heatmap. **Every remaining
  phase that has a scrubbed time follows this rule**, and its tests assert
  over every hook or fetch call, not the last one.
- **`useGexStrikeExpiry`.** It now drops superseded responses: a new key
  `(expiry, at)` aborts the round in flight and the older answer is ignored.
  A poll tick or a refresh with the same key lets the round in flight finish.
  The request timeout equals the poll interval, so aborting on every poll made
  a hung endpoint never count as a miss.
- **Raw `type="date"` inputs.** A native date input fires `input` with `''`
  on the first `0` of a zero-padded month or day, and with garbage years like
  `0002-04-09` while the year is typed. A raw input that maps `''` to today
  loses the typing. Each raw input moves to the shared `DateInput`, which
  holds those values as a draft until the date is complete or the field is
  left. This was done for the heatmap, the Periscope lottery, pin setup (6a)
  and Lottery Finder (7a). Still to move: Silent Boom (7b).

### Found while building Phase 7a

- **The "clearing the date field" bug was real.** On the old Lottery Finder, an
  emptied date field threw `RangeError: Invalid time value` from
  `ctSessionBounds('')` (the new tests failed with it on the old code). The
  shared `DateInput` plus `useFollowedDate` (`''` follows today) removes it.
- **The page number needs the same rule as the minute.** The effect that resets
  `page` to 0 on a date change runs one commit late too, so a pick (or the
  roll) while on page 2 asked for the new date at offset 100 before the clean
  request. Lottery Finder stores the page with its date, minute and every
  filter and drops it during render, like the minute (the filter version is
  the 7a follow-up, below). Silent Boom uses the filter version (7b).
- **Test fixtures dated with the CT date.** `LotteryFinderSection.test.tsx`
  dated its fires with the CT date, which differs from the ET date from 23:00
  to 24:00 CT, so the suite would fail then. The fixture uses `getETToday()`.
- **Lottery Finder's page was keyed on the date only.** The reset effect also
  listed 18 filters, so a filter flip on page 2 still asked for offset 100
  for one commit. The page is now stored with a scope string of the date, the
  minute and every filter, and the effect is gone.

### Found while building Phase 7b

- **Silent Boom takes its bucket client-side.** `useSilentBoomFeed` never
  receives the scrubbed bucket, so the one-commit-late reset did not send a
  request: the commit that carried the new date filtered its rows by
  yesterday's bucket ("No alerts in this 5-min bucket", with the "(5-min)"
  marker). A pick reset the bucket in its handler; only the roll relied on the
  effect. The bucket is stored with its date and dropped during render, as in
  7a. The tests read every commit, not every hook call.
- **A roll never carries a page here.** The pager shows only on a past day
  with no bucket, and a bucket resets the page, so a live day is never paged.
  The page is stored with a scope string of the date, the bucket and the 17
  filters that effect listed (the DTE bucket is a constant), and that effect
  is gone.
- **The second `setInterval` only ticks a time of day.** It floors
  `Date.now()` to the 5-minute bucket for the scrubber's upper bound and
  compares no date. It stays.
- **`useStickyUnion` lags the roll by one commit.** The panel re-keys the
  union in the same commit as the date (the storage key carries the date),
  but the hook resets and rehydrates in an effect on a key change, so the
  commit that carries the new key still returns the old key's snapshot:
  yesterday's union rows show under the new date for one commit, then go
  (checked with a profiler probe, not kept). Lottery Finder uses the same
  hook and has the same single commit. Fixed in Phase 9, in the hook (see
  "Found while building Phase 9", below).
- **Test fixtures** dated their alerts with the CT date. They use
  `getETToday()`.

### Found while building Phase 8

- **The feed's alerts were not stored with the date they belong to.**
  `useIntervalBAFeed` kept `alerts` and a `loading` flag that each fetch set
  true and false, and the feed handed every row the date it asked for. From
  the commit that changed the date until its response landed, the rows
  rendered yesterday's alerts under the new date, and a row opened in that
  window asked for the new date with yesterday's contract (a tape request that
  pairs the two). Before the debounce the window was one fetch; the 250 ms
  settle (`useDebounced`) widens it to a quarter second plus the fetch. The
  fix is the Phase 7 rule again, in the hook: `loading` is derived from keys
  (`requestKey` from every raw param, `responseKey` the params a fetch
  settled for, set on success and on failure and never on our own abort), so
  the feed is loading from the roll until the new date has answered and draws
  no row meanwhile.
- **Every poll flipped `loading`.** The fetch effect set `loading` true at the
  start of each run, so each 10 s poll swapped the rows for the loading text
  and back: an expanded row collapsed itself, and the expanded state was lost
  on every poll. With the key comparison, a poll or a refresh of the same
  params leaves `loading` false and the rows mounted. (An instant mock fetch
  can hide this in the feed test: the two state updates batch into one render.
  10 ms of latency on the mock makes the feed test deterministic; the hook's
  own poll test, which renders under `act`, catches it with an instant mock.)
- **The poll gate reads the settled date.** The hook polls when `marketOpen` is
  true and `settled.date === today`, with `today` from the shared ET clock. A
  following feed's settled date lags the roll by the debounce, so the gate
  closes at the roll, nothing is polled while the date is held, and the feed
  asks once for the new date and then polls it.
- **A failed fetch kept the older key's alerts.** The failure path set
  `responseKey` but left `alerts` and `summary` from the key before it, and
  the next run cleared the error at its start. After the roll's fetch failed, a
  refresh (or a poll) left `loading` false and `error` null while the retry was
  in flight, so the night's rows showed under the new date, and an outage
  flickered between the error banner and the old rows. The hook now never
  returns data for a key it has not answered: a failure drops the alerts and
  the summary, and the error is cleared only by a success, not by the start of
  a retry.
- **The summary banner sat outside the loading branch.** The totals of the
  held alerts ("extreme 7, $9M") showed beside "Loading…" from the roll until
  the new date answered. The banner is drawn only when the feed is not loading.
- **Aborting the predecessor hides a hung upstream.** Each 10 s poll aborts the
  request before it, so a hung upstream never reaches the 15 s timeout and
  raises no error, and the last rows sat under a frozen "updated" stamp. That
  is the cost of abort-on-supersede: a slow request is replaced, not waited
  for, so a request that never answers is never reported. The hook surfaces it
  by count: `stale` is true while the feed polls and a fourth poll is in flight
  after three that went unanswered (each aborted by the next), and the feed
  labels the "updated" stamp "stale" in amber. The count is `pollTick` minus the
  `pollTick` the newest answered fetch started at (a success or an error, never
  our own abort), so it reads no clock in render and keeps no mirrored state.
  Only polls count: a refresh click re-runs the fetch through its own
  `refreshTick`, and four quick clicks on a healthy feed are not four
  unanswered polls. A feed that does not poll is never stale, and an error
  counts as an answer (the error banner is already on screen).
- **Known limit: a feed that has never been answered is never stale.** A hung
  first fetch while polling is aborted by the next poll before its 15 s
  timeout, so no answer ever exists to be stale and no error is raised. The
  hook returns `stale: false`, `loading: true`, `error: null`; the feed shows
  "Loading" with the refresh button disabled, and the polls keep retrying. The
  spinner is the cue, and a test pins the state.
- **The first `stale` compared times, and two flaws followed.** It compared the
  newest response's age with `3 * POLL_INTERVALS.ALERTS`, at the last poll
  tick. After an idle gap (the market closed for five minutes, a throttled tab,
  a laptop waking) the first poll after the gap set it, because the last
  response was old, though one poll had gone unanswered. After a backward step
  of the system clock the difference went negative and ten unanswered polls
  never set it. An outage whose fetches all failed also set it, though each
  failure was answered. The count has none of these: idle gaps add no polls,
  and a clock step changes nothing. A first count-based version let a refresh
  click add a tick as well; the review found four quick clicks flashed the
  label, so the polls have their own counter.

### Found while building Phase 9

- **The rehydrate is now in the commit that carries the key.** The hook held
  its returned rows in one `useState` and reset and rehydrated them in an
  effect on `storageKey`, so a key change committed once with the old key's
  rows. The ingested rows are now state tagged with their slot (the Interval
  B/A `responseKey` pattern), and the hook returns them only while the tag is
  the current `storageKey`; otherwise it returns what the current slot holds,
  read in render by a pure, memoized read (`readRetainedRows`, keyed on the
  key). The read writes no storage and touches no ref, so a Strict Mode double
  render or a discarded render changes nothing. The effect still flushes the
  old slot's pending write, builds the working union, reseeds the seen
  counters, applies `retain` with its healing write, and runs before the ingest
  effect. It also drops state held for a slot we left, so coming back to a slot
  returns what it holds now, not what it held when it was left. The test
  records the value every committed render returns; it is red on the effect-only
  version. Two side effects: the first render of a mount already returns the
  stored rows (it returned `[]`, then the rows), and a key change that follows
  an ingest commits a second time with the same output (the state drop).
- **The sweep is relative to the live day, not to the key.** The panels build
  `feed-union:<feed>:${date}:${sig}` from the date being viewed. The old sweep
  ran once, on mount, relative to the mount key's date, which was wrong two
  ways: a union from yesterday lingered after the midnight roll until the next
  reload, and a panel mounted on a past date deleted today's slots. A sweep
  relative to the key on every key change would be worse: a detour to
  yesterday would delete today's union, which the panels promise survives a
  detour. The hook now sweeps the same feed's slots whose date is not the live
  day, on mount and whenever the live day changes. The live day is `useETToday()`,
  the clock the panels' `date` follows (`useFollowedDate` wraps it), so the key
  and the sweep turn over in the same commit. A key change inside the live day
  (a filter, a detour) does not sweep. Other feeds, malformed keys, unrelated
  keys and every same-day signature sibling survive. The sweep effect is
  declared after the hydrate effect, whose flush of the old slot's pending
  write must come first: at the roll, a sweep that ran before it would be
  undone by the write recreating yesterday's slot.
- **A side effect on the tests.** The hook now subscribes to the ET clock, whose
  timer re-arms itself, so a test with fake timers cannot call `runAllTimers`
  (it never ends); the one that did advances one debounce window instead.

### Found while building Phase 10

- **The payload is date-checked like the cache.** `displayData` is a payload
  only when its `date` is today, fetched or cached. A fetched payload from a
  prior day stays in `state` (it is not cleared), but is not shown.
- **The window opening fetches.** The fetch effect is keyed on `isWindowOpen`
  (the flag the watcher publishes), not on mount: it fetches when the flag is
  true, so a mount inside the window is still one fetch, and a flip to open
  fetches at once. The first read of a session day lands within a minute of the
  open (the watcher's tick) instead of 45 to 105 s after it. There is no
  boundary-aligned timer.
- **One clock.** `useRegime0dte` takes "today" from `useETToday()`, per rule 3,
  so the date gate and the header badge turn over at ET midnight, in the same
  commit as every other panel. The server stamps the payload with the CT date
  (`api/regime-0dte.ts`). The two dates agree for all of 08:30 to 15:00 CT, the
  only hours the hook fetches (the server answers at any hour, but the window
  is closed outside them), and differ only from 23:00 to 24:00 CT, when the
  window is closed; the day's last read clears an hour before CT midnight.
- **The badge is not window-gated (decision).** With the date check and the ET
  clock, the badge shows the day's last gate after the close and clears at ET
  midnight, so a weekend or a holiday Monday shows none.
- **A wrong-dated 2xx is an error, not silence (decision).** A 2xx whose payload
  is not dated today is hidden by the display check. If the fetch set
  `error: null`, the panel would say "loading" for as long as the dates
  disagree (a client clock that lags after sleep, a server on another day). It
  now sets `error` to `Payload is dated <date>, but today is <today>` (or
  "undated"), which the panel's alert shows above "No regime read for today
  yet. It retries automatically.", and it clears on the first poll where the
  dates agree. Tests assert `error` by value for that case, a network failure
  and a body that is not JSON. `data` and `fetchedAt` stay the raw last fetch;
  only `displayData` is date-checked, and the result type says so.
- **The returned `error` is derived, and ends with the read it describes
  (round 2).** The fetch stores `error` and a `dateMismatch` flag (state, set
  only where the wrong-date error is set; a failed fetch resets it). The hook
  returns `error` as null when the window is closed (nothing fetches, so a
  left-over error would sit over "waiting for the open" all weekend), and when
  `dateMismatch` is set and the stored payload is dated today (the shared ET
  clock can lag the server by a tick: the fetch lands on Monday's payload while
  the store still says Friday, then catches up, and the alert goes in that
  render, not at the next poll). A fetch start sets only `loading`, so an error
  that persists does not blink to "loading" on every poll. A `null` 2xx body
  reads "Payload is undated, but today is …" instead of throwing, and does not
  overwrite the last-good payload in storage or in the display fallback. Known
  edge: after a close, the stored error is still in state, so the first fetch
  of the next window shows it until that fetch answers.
- **The closed panel says why (round 2).** `placeholderCopy` tells three
  closed cases apart: a public visitor ("The regime read needs owner or guest
  access.": the hook holds the window closed for them, so no clock time opens
  it), after the close on a trading day ("Closed for the day. The next read
  starts at the 08:30 CT open."), and before the open or on a weekend or
  holiday ("Waiting for the open…"). The window arithmetic is shared:
  `regime0dteSessionPhase` (`src/utils/regime-0dte-window.ts`) returns
  `no-session`, `before-open`, `open` or `after-close`, and the hook polls only
  in `open`. The panel reads the clock when it renders, which it does at the
  window flip and at ET midnight; "closed for the day" can outlast CT midnight
  until the next render, and is still true then.
- **The tests move the clock while mounted.** The old `useRegime0dte` tests
  mocked `getCTTime` and `getCTDateStr`, which cannot cross a day. They now pin
  the real clock and move it (the window and the ET date both read `Date`).
  Each step is its own `act`: a single `act` around a weekend defers the
  `isWindowOpen=false` commit and batches it with the open, so the flag never
  flips and the test proves nothing. A recorder logs the payload date shown by
  every committed render, with the clock when it committed. "Nothing stale
  after ET midnight" is asserted over every commit at or after the instant,
  the roll's own included: taking an index after the act that crosses the roll
  skipped that commit, so a stale render at the roll, healed by the next,
  passed. A mutant stale only at the first roll passed the old assertion and
  fails the new one.

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
     Pin setup's raw date input moves to the shared `DateInput`. If either
     panel has a scrubbed time, store it with its date.
   - **6b. Opening flow**, plus its test (2 files).
7. **Lottery Finder and Silent Boom.** Neither panel has a rollover test
   today. The CT comparators move with them (design item 3).
   - **7a. Lottery Finder and `useLotteryFinder`**, plus tests.
     - Replace `manualDatePick` and the 60 s interval with the helper.
     - Reset the minute on a date change: store it with its date.
     - Move `useLotteryFinder`'s CT today onto the shared clock.
     - Move the raw date input (`LotteryFinder/index.tsx:1639`) to the shared
       `DateInput`.
     - Fix the stale comment.
   - **7b. Silent Boom**, plus tests. Same changes as 7a, including the raw
     date input (`SilentBoom/index.tsx:1560`), and storing any scrubbed minute
     with its date. Silent Boom already resets on a date change, but by an
     effect, which runs one commit late.
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
9. **`useStickyUnion`.** Rehydrate in the commit that carries the key, and
   sweep other-day keys relative to the live day on mount and at the roll, plus
   its tests.
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
