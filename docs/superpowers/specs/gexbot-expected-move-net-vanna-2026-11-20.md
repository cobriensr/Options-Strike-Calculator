# GEXBot expected move and net −vanna tiles

**Date:** 2026-11-20, refreshed 2026-11-24, reviewed 2026-11-25 ·
**Status:** built and reviewed, not yet run against the vendor's chart. The
patch started as an owner draft written outside the repo's agent loop (first
cut against `3dc04441`, moved onto `d8971cd` on 2026-11-24) and was applied on
`01cf3426d`.

- 2026-11-24 refresh: both tiles gained an `<SrHint>`, which the title-only
  guard added on 2026-11-21 (`no-title-only-generic.test.ts`) requires.
- 2026-11-25 review: a spec-reviewer read of this spec, and a vendor-doc
  verifier that re-read docs.gexbot.com and a live capture against the code.
  The review changed seven things in the code and this spec:
  - **A.** The net −vanna countdown, and CharmClock's, count to the calendar
    close (13:00 ET on `EARLY_CLOSE_DATES`), not a fixed 16:00 ET.
  - **B.** The expected move's SIZE counts to 16:00 ET on every day, half days
    included, as GEXBot documents. The session still ends at the real close:
    from 13:00 ET on a half day a 0DTE read is `expired`. Owner decision.
  - **C.** A closed market reads as a closed session. Net −vanna no longer
    stays coloured "in play" on the clock it stopped reading a minute before
    the close; CharmClock's "By close" and EOD bias clear the same way.
  - **D.** A vendor timestamp from an earlier ET date than the capture is no
    fresh data (the tile's awaiting state), not `expired`. The latest-snapshot
    read behind the net −vanna tile drops such a row too. Fix K below widened
    the expected-move rule.
  - **E.** The net −vanna thresholds are strict ("beyond $800 MM", "above
    $1,000 MM"): exactly 800 is quiet, exactly 1,000 is the last-hour tier.
  - **F.** The expected-move hover text credits GEXBot only with the formula
    and the 50/25/25 smoothing; the ATM pick and the call/put mean are ours.
  - **G.** Two code comments claimed all State categories carry the same IV
    values; the vendor documents only the same row layout.
- 2026-11-25 second round: a spec re-review and a code review of commit
  `a3f1412e5`. It changed five things in the code and this spec, in the commit
  on top of it:
  - **I.** After the close the expected-move tile reads "session closed"
    whatever the last row says. `useGexbotData` stops polling when
    `marketOpen` goes false and the vendor's last stamp of a session is
    15:59:59 ET, never 16:00, so the server's `expired` never reached an open
    tab: the tile froze on its last live move (about ±3–5 pts on a normal
    day, about ±15–20 pts all afternoon on the 2026-11-27 half day).
  - **J.** A test pins the real final tick: stamp 15:59:59 ET, captured
    16:00:44 ET, read as live with about one second left.
  - **K.** A vendor stamp before 09:30 ET on the capture's ET date is no
    fresh data, which also covers the prior-date replay. A same-day stamp from
    the vendor's 08:00–08:30 ET premarket roll used to get through and was
    sized from 08:20 with more time than the session has. The helper is now
    `isPreOpenStamp`. `getLatestSnapshots` keeps its ET-midnight rule.
  - **L.** Two comments: the VIX replay lasts the first few minutes after the
    open, not "a minute", and the 15-minute bound uses
    `gexbot_snapshots_captured_at_idx`.
  - **M.** This spec: the half-day check on Friday needs two readings and a
    ratio table, and the sections on missing moves, facts checked and status
    follow the code.
- 2026-11-25 third round: a code re-review of commit `7c66c395d`. It changed
  four things in the code and this spec, in the commit on top of it:
  - **N.** `useGexbotData` refetches on the market's open edge (`marketOpen`
    false to true) and drops the rows it holds, so no tile shows the last
    session as live. A tab left open overnight kept yesterday's rows, and
    nothing read again until the first 30 s tick: on a gap open the
    expected-move range was centred on yesterday's spot. The hook's read now
    carries a sequence number, so only the newest call applies its answer.
  - **O.** A test comment named the vendor's last stamp 16:00:00 ET, against
    the test above it; it now says what the case pins.
  - **P.** `isPreOpenStamp` returns false for an invalid `capturedAt`, as
    `fractionalDte` and `isSessionOver` do, instead of throwing a `RangeError`
    from `getETDateStr`; its docstring says so.
  - **Q.** A comment in `api/_lib/cron-helpers.ts` gave the frozen
    post-close stamp as 16:00:00; production shows 15:59:59 ET.
- Current state: the full gate (`npm run review`: type-check, lint, Prettier,
  `vite build`, the full test run with coverage) passed and sealed tree
  `992baae5` for commit `a3f1412e5`. The second round ships as its own commit
  on top, and the third on top of that, each with its own gate run. The
  original draft also passed on `d8971cd`: type-check, `vite build`, ESLint and
  Prettier on every changed file, and 14 test files (582 tests).
- Shape of the patch: one phase of 29 files, by the owner's hand-over as one
  patch. That is an explicit exception to the 5-files-per-phase rule. The
  second round touches existing files only. The third round adds one file to
  the patch, `api/_lib/cron-helpers.ts` (a comment), so it is 29 files.
- Still open: the live check against GEXBot's chart on Friday 2026-11-27 (see
  "Half days"), and the owner's call on question 7.

## Goal

Use two GEXBot data points the app already captures and never reads: the
per-strike call and put IV in every State Greek capture, and SPX net −vanna
(`zvanna`). Show GEXBot's ±1σ expected move and a time-aware net −vanna read
as two tiles in the GEXBot Taker Flow section.

Why: a 2026-11-20 review of the capture against docs.gexbot.com found both
stored and unread. `decodeStrikes` skips `mini_contracts[i][1..2]`;
`/api/gexbot?view=snapshots-latest` returns `zvanna` and no panel renders it.

## Parts

One phase: shippable alone, on one branch. The owner handed it over as a
single patch, so the three parts below are a reading order, not separate
deliveries. No migration, no cron, no new GEXBot call.

1. **IV decode.** `decodeStrikeIvs` in `api/_lib/periscope-gexbot.ts` lifts
   call IV (position 1) and put IV (position 2) per strike.
2. **Expected move.** `api/_lib/gexbot-expected-move.ts` (pure) and
   `getExpectedMove` in `api/_lib/gexbot-queries.ts`, served as
   `/api/gexbot?view=expected-move` behind the existing owner-or-guest guard.
3. **Tiles.** `ExpectedMoveTile` and `NetVannaTile`, mounted in a two-column
   row under the summary strip, on the shared session clock.

## Files

Part 1, IV decode:

- `api/_lib/periscope-gexbot.ts`: `decodeStrikeIvs`, `DecodedStrikeIv`
- `api/__tests__/periscope-gexbot.test.ts`

Part 2, expected move:

- Created: `api/_lib/gexbot-expected-move.ts`,
  `api/__tests__/gexbot-expected-move.test.ts`,
  `api/__tests__/gexbot-latest-snapshots-pglite.test.ts`
- `api/_lib/gexbot-queries.ts`: `getExpectedMove`, `ExpectedMoveRow`, and the
  stale-vendor-stamp rule in `getLatestSnapshots`
- `api/_lib/validation/market-data.ts`: `expected-move` in the view enum
- `api/gexbot.ts`: the new view
- `api/__tests__/gexbot-queries.test.ts`, `api/__tests__/gexbot-endpoint.test.ts`
- `api/_lib/cron-helpers.ts`: a comment on `isGexbotLiveCt` only (fix Q)

Part 3, tiles and the shared clock:

- Created: `src/components/Gexbot/ExpectedMoveTile.tsx`,
  `src/components/Gexbot/NetVannaTile.tsx`,
  `src/components/Gexbot/net-vanna.ts`,
  `src/components/Gexbot/session-clock.ts`,
  `src/components/Gexbot/tile-tone.ts`
- `src/hooks/useGexbotData.ts`: the view and its row type
- `src/components/Gexbot/index.tsx`, `types.ts`: mount and re-export
- `src/components/Gexbot/CharmClock.tsx`: `useNow`, `hoursToClose` and
  `formatHoursMinutes` moved to `session-clock.ts`; it now reads the countdown
  through `useHoursToClose(marketOpen)`
- `src/components/Gexbot/DealerStateSummaryStrip.tsx`: `toneClasses` moved to
  `tile-tone.ts`, unchanged
- Tests, created: `src/__tests__/ExpectedMoveTile.test.tsx`,
  `NetVannaTile.test.tsx`, `gexbot-net-vanna.test.ts`,
  `gexbot-session-clock.test.ts`
- Tests, changed: `CharmClock`, `GexbotSection`, `useGexbotData`

## Data dependencies

None new. Reads `gexbot_api_capture` (SPX, `state`, `gamma_zero`, the row the
strikes cron already writes each minute) and `gexbot_snapshots` (`zvanna`
through the existing `snapshots-latest` view, which now also reads
`source_timestamp` to skip a replayed prior-session row). Uses the market
calendar in `src/data/marketHours.ts` for the session close.

## How the expected move is computed

GEXBot's documented formula (slug `/state/optionsprofile`, read 2026-11-25):

- expected move = spot × smoothed ATM IV × √(fractional DTE / 365)
- smoothed ATM IV = 50% ATM + 25% ATM−1 + 25% ATM+1
- fractional DTE = seconds left to 4:00 PM ET / 86,400

What the code does around that:

- **Re-weighting.** A neighbour with no IV, or none at all because the ATM
  strike is the first or last listed, drops out and the rest are divided by
  the weight that remains: ATM 0.11 and one neighbour 0.10 give
  (0.5 × 0.11 + 0.25 × 0.10) / 0.75. If the ATM strike itself has no IV there
  is no move (`no_atm_iv`), even when its neighbours have one.
- **Whole days.** Fractional DTE is the vendor's `min_dte` (whole calendar
  days) plus the fraction of today left to 16:00 ET. Only a same-day expiry
  (`min_dte` 0) can be `expired`.
- **One category.** Only `gamma_zero` is read. There is no fallback to another
  State category: the docs give every category the same row layout but do not
  say the IVs match across them. The tile goes to its awaiting state only if
  that capture is missing for 5 minutes running (`STALENESS_CUTOFF_MS`).
- **As of the vendor's stamp.** The move is computed as of the vendor's
  snapshot `timestamp`, so the IVs and the time left describe the same moment;
  a capture with no usable stamp falls back to `captured_at`.
- **Missing moves.** A capture that cannot produce a move returns one row with
  `expectedMove: null` and a reason (`no_spot`, `no_dte`, `expired`,
  `no_atm_iv`); the tile prints the reason.
- **After the close, the client says "session closed".** The vendor's last
  stamp of a session is 15:59:59 ET, never 16:00 (production, 2026-11-23 and
  11-24, captured about 16:00:44). The server's `expired` therefore covers
  only a stamp at or after the close, which the vendor does not send on a
  normal day: the final captures read as live, with about one second left.
  `useGexbotData` also stops polling when `marketOpen` goes false (16:00 ET,
  13:00 ET on a half day), so an open tab never receives an `expired` row. The
  tile closes itself from that gate (fix I): with `marketOpen` false and a row
  present it shows the `expired` display ("SPX ±1σ · —", "session closed")
  whatever the row says. Loading, error and empty states are unchanged.
- **At the open, the hook reads again and clears stale rows (fix N).** On the
  rising edge of `marketOpen` (false to true), for every GEXBot view except
  `sibling-confirm`, `useGexbotData` drops its state, so the tiles read
  loading, and fetches at once. `usePolling` never calls its function on a
  gate flip and the mount read runs once, so a tab left open overnight would
  otherwise show yesterday's rows as live for up to 30 s, with the range
  centred on yesterday's spot after a gap open. A hook that mounts open has no
  edge and sends no extra read. A flip that lands while the mount read is
  still out (page load, once auth and quotes arrive) joins that request
  through the hook's in-flight dedupe: one request, not two.
  `sibling-confirm` answers for a past fire time and keeps its own retry gate.
- **Closed with no row is not "session closed".** The tile's closed display
  applies only when a row is present. A tab opened after hours or on a
  weekend gets no row (no capture inside the 5-minute freshness cutoff, or a
  pre-open stamp), so it reads "awaiting first GEXBot tick", while a tab left
  open across the close holds its last live row and reads "session closed".
  The tile has only `marketOpen` to go by and cannot tell pre-market from
  after-hours with it, so this is intended.
- **A pre-open stamp is not "closed".** A vendor stamp before 09:30 ET on
  `captured_at`'s ET date (`isPreOpenStamp`, fix K) is no fresh data: the read
  returns no row and the tile shows "awaiting first GEXBot tick". Two cases
  fall under it: a stamp on an earlier ET date (the vendor replaying the last
  session's final snapshot at the open), and a same-day stamp from the
  vendor's 08:00–08:30 ET premarket roll, which would otherwise be sized from
  08:20 with more time than the session has. The ET date is the capture's,
  never the UTC date. The rule is on `getExpectedMove` only:
  `getLatestSnapshots` keeps its ET-midnight rule. `expired` ("session
  closed") is kept for a same-day stamp at or after the close.
- **IV decode.** An IV of 0, negative, non-finite or above 10 is absent. "A
  value above 10 is written as 0" is stated only in the EOD docs; applying it
  to live payloads is our defensive choice.

## Half days

Owner decision, 2026-11-25. The SIZE of the move counts seconds to 16:00 ET
on every day, including half days (2026-11-27 closes 13:00 ET). The session
still ends at the real close: from 13:00 ET the tile reads "session closed".
That reading comes from the client's `marketOpen` gate (fix I), not from the
server: the vendor's last stamp of a session is 15:59:59 ET, and the server's
`expired` covers only a stamp at or after the close (see "Missing moves" under
"How the expected move is computed"). On the half day, without the gate, the
tile would hold about ±15–20 pts all afternoon.

Why 16:00: GEXBot's IV is most likely solved against its own documented
16:00 ET clock. Using that same time keeps σ·√T equal to the move the option
prices; counting to 13:00 would pair an IV solved for one clock with a time
from another.

Check on Friday 2026-11-27: compare the tile with the dashed ±1σ lines on
GEXBot's SPX Options Profile chart, at least twice (for example 10:00 and
12:00 ET), and take ours ÷ theirs each time. If GEXBot's band counts to 13:00
and ours to 16:00 with the same IV, the ratio at time t is
√((16:00 − t) ÷ (13:00 − t)):

| t (ET) | 10:00 | 11:00 | 12:00 | 12:30 |
| ------ | ----- | ----- | ----- | ----- |
| ratio  | 1.41  | 1.58  | 2.00  | 2.65  |

"About double" is true only at 12:00. Read the readings together:

- Ratio about 1 both times: GEXBot draws on the 16:00 clock. Keep ours.
- Ratio near the table and rising through the morning: GEXBot draws on 13:00.
  Flip `fractionalDte` in `api/_lib/gexbot-expected-move.ts` to count to the
  calendar close.
- Ratio flat but away from 1: not a clock. Look at open question 1 or 2 (the
  ATM IV choice).

The check shows the clock GEXBot's band is drawn with. It does not show which
clock GEXBot solves its IV against.

The net −vanna countdown, and CharmClock's, now count to the calendar close
(`hoursToClose` in `session-clock.ts`), because they say when a window opens
or when the session ends, not what the vendor's formula uses. A market holiday
has no close: the countdown is 0. CharmClock's `SESSION_HOURS` (6.5) is still
its scaling denominator on a half day; that scaling is the open owner decision
already noted in the component.

## Open questions (default picks in the code)

The docs give the formula and leave these unstated:

1. **Which IV is "ATM IV"?** Default: the mean of the strike's call and put
   IV, or the one side that is quoted. Alternative: the OTM side only.
2. **Which strike is ATM?** Default: the listed strike nearest spot, lower
   strike on an exact tie; ATM±1 are the listed strikes either side. If the
   ATM strike has no IV there is no move (`no_atm_iv`), even when its
   neighbours have one.
3. **Half days.** Settled 2026-11-25: size on the 16:00 clock, session over at
   the real close (see "Half days").
4. **Scope.** SPX only, like the other per-strike readers. The decoder and
   the math are ticker-agnostic; widening is a query change.
5. **A check against the vendor.** Compare the first live reading with the
   dashed ±1σ lines on GEXBot's Options Profile chart for SPX. A steady gap
   points at question 1 or 2. On a half day, read at least two times and use
   the ratio table in "Half days": a ratio that rises toward 2.00 by 12:00 ET
   is the clock; a flat ratio away from 1 is question 1 or 2.
6. **The session clock on half days.** Settled 2026-11-25: `session-clock.ts`
   counts to the calendar close.
7. **Which `zvanna` do the $800 / $1,000 MM guidance figures describe?** The
   vendor's page says "across all strikes" and does not say whether that
   means the 0DTE reading or all expiries. We use `zvanna`, the nearest-expiry
   figure, which for SPX is the 0DTE one. Owner to confirm, or compare against
   the vendor's own readout.

## Thresholds and constants

- Net −vanna, from GEXBot's SPX guidance (`/orderflow/netvannacharm`, which
  the vendor calls "a matter of some discretion"; amounts in $MM):
  `NET_VANNA_LAST_HOUR_MM = 800` (in play in the last hour) and
  `NET_VANNA_EARLY_MM = 1000` (in play in the last two hours). Both
  comparisons are strict, in the vendor's words: "beyond $800MM" and "above
  $1,000MM". Exactly 800 is quiet; exactly 1,000 is the last-hour tier.
- The tile is coloured only while in play; a large reading outside its window
  stays neutral and counts down. At or below 800 it reads "$800 MM or less ·
  no late-day read". A closed market reads "session closed", neutral.
- IV decode: an IV of 0, negative, non-finite or above 10 is absent.
- Freshness: `STALENESS_CUTOFF_MS` (5 minutes), shared with the other
  per-strike readers. `snapshots-latest` keeps its 15-minute window and skips a
  row whose vendor stamp is before today's ET midnight; a row with no stamp is
  kept.

## Facts checked on 2026-11-25

Vendor pages, read raw from docs.gexbot.com:

- `/state/optionsprofile`: the formula, the 50/25/25 weights, and the clock
  (seconds to 4:00 PM ET over 86,400).
- `/apidocs/state/state-op` and `/apidocs/general/historical-eod`: the
  `mini_contracts` row layout, shared by every category, with IV as a
  fraction. "A value above 10 is written as 0" appears in the EOD docs only.
- `/orderflow/netvannacharm`: thresholds by magnitude, in $MM, "a matter of
  some discretion".

Live capture, the 2026-11-24 13:01 ET SPX `gamma_zero` capture: both IVs on
all 101 strikes, ATM IV about 0.33, strikes 5 points apart near spot.

Production reads, 2026-11-23 to 11-25:

- The vendor's last stamp of a session is 15:59:59 ET, never 16:00 (11-23 and
  11-24, captured about 16:00:44). The server's `expired` therefore does not
  fire on a normal day; the tile's `marketOpen` gate closes it (fix I).
- The VIX replay of the prior close lasts the first few minutes after the
  open: 09:30–09:32 ET on 2026-11-24, 09:30–09:31 on 11-23.
- Only VIX rows carry a prior-session `source_timestamp` in the live table
  (about two sessions of rows, checked 2026-11-25). SPX's orderflow row, the
  source of `zvanna`, has not been seen replayed. The guard added to
  `getLatestSnapshots` stays, in case the vendor starts to.
- The 09:30:11 ET SPX capture on 2026-11-24 carried vendor stamp 09:30:09, so
  the pre-open guard on `getExpectedMove` (fix K) is defensive: no live stamp
  from before the open has been seen there.
- EXPLAIN ANALYZE of the `getLatestSnapshots` read (2026-11-25): an index scan
  on `gexbot_snapshots_captured_at_idx`, 2.3 ms, 1,232 rows.

## Wording

Tile text follows owner decision D1 (2026-10-29): GEXBot values are
taker-side and vendor-defined, so the tiles say "adds passive bids" and "adds
passive offers" and make no dealer claims. The tests assert that with
`dealerClaims`. The check reads a bare "MM" as "market makers", so the net
−vanna test drops the "$… MM" unit before it.

The expected-move hover text names what GEXBot documents (the formula and the
50/25/25 weights) and says the ATM pick and the call/put mean are ours.

## Not in this patch

- An IV-by-strike (skew) view. `decodeStrikeIvs` returns what it would need.
- The other unread fields from the 2026-11-20 review: the Classic major
  levels, the State GEX-profile levels, the call/put DEX split, the DEX
  ladder and the 1DTE ladders.
- Feeding either value to the analyze prompt.
