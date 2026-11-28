# GEXBot level ladder

**Date:** 2026-11-22, re-checked 2026-11-24 · **Status:** plan, not started.
Written outside the repo's agent loop and moved into `docs/superpowers/specs/`
on 2026-11-25. The spec-reviewer read it on 2026-11-25 (verdict revise). The
author-side findings are settled in this text (see "Review, 2026-11-25" at
the end). The owner answered every open question on 2026-11-26 (see "Owner
decisions, 2026-11-26"); that changed phase 4's design. The second and last
review ran on 2026-11-26 and its findings are settled too ("Review,
2026-11-26"). Later that day the owner changed open question 2: a short
strike's odds now come from the price of a narrow vertical spread at the
strike, built from GEXBot's per-strike IVs, with the ATM σ as the fallback.
That added phases 2b and 2c.

**Depends on:** `gexbot-expected-move-net-vanna-2026-11-20.md`, landed
2026-11-25 (`4dd9d5857`..`e10448627`). Phases 2 to 4 read its
`expected-move` view. Phase 1 does not.

**Mockup:** the "GEXBot decision panels" design (claude.ai, private), card
"Where do the short strikes go?". It shows the later state, with turn-back
rates and sample numbers. Where it differs, this spec governs.

## Goal

Add a spot-anchored SPX strike ladder to the GEXBot Taker Flow section that
puts the nine GEXBot levels, the ±1σ expected-move band and the trader's short
strikes on one scale, and states the result: how far each short strike is in
σ, the priced odds of a touch and of finishing beyond it, and a status.

**The trader does no arithmetic.** Every distance, σ, probability and status
is computed by the model and printed. The panel leads with a result line (one
to three short sentences, wording under "Result line") that gives the answer.

Why:

- Six of the nine level columns are written every minute and read by no
  product code: `zero_mcall`, `zero_mput`, `major_pos_vol`, `major_pos_oi`,
  `major_neg_vol`, `major_neg_oi` (2026-11-20 review; re-checked 2026-11-24 by
  grep over `api/` and `src/`).
- A planned level-touch study (`gexbot-level-touch-base-rates-2026-11-21.md`,
  not in the repo as of 2026-11-25) puts a passing level's rate "on the tile
  that shows the level". Six levels have no tile. This ladder is that tile.
  Its level ids are chosen to be the study's tags, so rates can join later
  without a rename. Every rule below is the ladder's own and holds whether or
  not the study exists.
- The expected move is on screen after the expected-move patch, but turning
  it into "how exposed is this strike" is still mental division and a normal
  table.

## What it looks like

Sample values. Before a trade the short strikes are the calculator's 10Δ
candidates:

```text
Level Ladder — SPX 0DTE · spot 7,588.4 · levels 09:45 CT

[CLEAR] Both candidate strikes are clear. Call 7,620 is 1.37σ away with a 17%
        priced chance of a touch. Put 7,555 is 1.45σ away with 15%.

STRIKE  ON THIS STRIKE                       FROM SPOT
 7,620  [CANDIDATE · 10Δ CALL]               [CLEAR] 1.37σ · touch 17% · finish beyond 8%
 7,615
 - - -  +1σ · 7,611.4  - - - - - - - - - - - - - - - - - - - - - - - -
 7,610
 7,605  [Classic major positive · volume]    +16.6 pts · inside +1σ
 7,600  [State major call]                   +11.6 pts · inside +1σ
 7,595  [State long gamma · taker-long]      +6.6 pts · inside +1σ
 7,590
 =====  SPX 7,588.4  =================================================
 -----  Classic zero gamma · 7,586.2  --------------------------------
 7,585
 7,580  [State short gamma · taker-short]    −8.4 pts · inside −1σ
 7,575
 7,570  [State major put]                    −18.4 pts · inside −1σ
 - - -  −1σ · 7,565.4  - - - - - - - - - - - - - - - - - - - - - - - -
 7,565
 7,560  [Classic major negative · volume]    −28.4 pts · 5.4 outside −1σ
 7,555  [CANDIDATE · 10Δ PUT]                [CLEAR] 1.45σ · touch 15% · finish beyond 7%

Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,595 · 7,600 · 7,605.
Put 7,555: 33.4 pts below spot, 10.4 outside −1σ. Levels between: 7,580 · 7,570 · 7,560.
```

With a position open (phase 4), at spot 7,612.6 with ±8.1 left:

```text
[TESTED] Short call 7,620 is tested: 0.91σ away, a 36% priced chance of a
         touch and 18% of finishing beyond. Short put is clear.

 7,620  [OPEN · SHORT CALL]                  [TESTED] 0.91σ · touch 36% · finish beyond 18%
 7,555  [OPEN · SHORT PUT]                   [CLEAR] 7.1σ · touch under 1% · finish beyond under 1%
```

## Phases

Each phase ships alone. No migration, no cron, no new GEXBot call, no new
endpoint or view. Phase 4a adds a read-only mode to the existing
`GET /api/positions`.

| Phase | What                                                               | Scope                                              |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------- |
| 1a    | Six level columns on the existing `snapshots-latest` view (server) | Small: 1 source file, 1 test file                  |
| 1b    | The client's mirrored row type, and the fixtures it types          | Small: 1 source file, 4 test fixtures              |
| 2     | Pure ladder model and odds in `level-ladder/`                      | Medium: 3 source files, 2 test files               |
| 2b    | Per-strike IVs on the existing `expected-move` view (server)       | Small: 1 source file, 1 test file                  |
| 2c    | The client's mirrored row type, and the fixtures it types          | Small: 1 source file, 2 or 3 test fixtures         |
| 3a    | `LevelLadder` component, mounted, with the calculator's candidates | Medium: 1 new component, 2 modified files, 2 tests |
| 3b    | The ladder in the narrow-screen e2e check                          | Small: 1 e2e file                                  |
| 4a    | Read-only `GET /api/positions?readonly=1`, CSV first (server)      | Small: 2 modified files, 3 tests (1 new)           |
| 4b    | `useOpenShortStrikes` hook                                         | Small: 1 new hook, 1 test                          |
| 4c    | Open short strikes on the ladder                                   | Small: 3 modified files, 2 tests                   |

Every phase stays within the 5-file cap. Phase 1 is delivered as 1a then 1b,
two commits on one branch. 1a ships alone: the server sends six more JSON
fields that the client type does not declare yet, which is harmless. 1b
declares them, and every fixture typed `SnapshotsLatestRow` is a full literal,
so all four need the six fields.

Phases 2b and 2c split the expected move's strike IVs the same way. Phase 2
takes the strike IVs as a separate input (`strikeIvs`, null when none), so it
does not wait for them, and it falls back to the ATM σ without them. 2b and 2c
land before phase 3a, which passes the view's `strikeIvs` in.

## Files

Phase 1a:

- Modify `api/_lib/gexbot-queries.ts`: `SnapshotsLatestRow`, `RawSnapshotsRow`
  and the `getLatestSnapshots` SELECT and mapper gain `zeroMcall`, `zeroMput`,
  `majorPosVol`, `majorPosOi`, `majorNegVol`, `majorNegOi`.
- Tests: `api/__tests__/gexbot-queries.test.ts`. The pglite test
  (`gexbot-latest-snapshots-pglite.test.ts`) builds its table from migration
  #156, which already has the columns, and asserts only parts of each row, so
  it needs no change.
- No change to `api/gexbot.ts` or `api/_lib/validation/market-data.ts`.

Phase 1b:

- Modify `src/hooks/useGexbotData.ts`: the mirrored `SnapshotsLatestRow`
  gains the same six fields, typed `number | null` and required, since the
  server always sends them.
- Modify the four fixtures typed `SnapshotsLatestRow`:
  `src/__tests__/CharmClock.test.tsx`, `DealerStateSummaryStrip.test.tsx`,
  `GammaCompass.test.tsx` and `NetVannaTile.test.tsx`.

Phase 2:

- Create `src/components/Gexbot/level-ladder/types.ts`
- Create `src/components/Gexbot/level-ladder/odds.ts`
- Create `src/components/Gexbot/level-ladder/build.ts`
- Create `src/__tests__/level-ladder.odds.test.ts`
- Create `src/__tests__/level-ladder.build.test.ts`

Phase 2b:

- Modify `api/_lib/gexbot-queries.ts`: the server's `ExpectedMoveRow` gains
  `strikeIvs`, the `decodeStrikeIvs(payload)` array `getExpectedMove`
  already builds for `computeExpectedMove`, sent as is. That is every strike
  in the capture: 97 to 101 rows spanning about ±250 pts of spot on
  2026-11-25, about 4.5 KB a poll. Sending the whole chain covers every short
  strike the ladder can list, including those in `above` and `below`.
- Tests: `api/__tests__/gexbot-queries.test.ts`.

Phase 2c:

- Modify `src/hooks/useGexbotData.ts`: the mirrored `ExpectedMoveRow` gains
  `strikeIvs: { strike: number; callIv: number | null; putIv: number | null }[]`,
  required, since the server always sends it.
- Modify the fixtures typed `ExpectedMoveRow`:
  `src/__tests__/ExpectedMoveTile.test.tsx`, and the phase 2 tests that
  build one (`level-ladder.build.test.ts`, and `level-ladder.odds.test.ts`
  if it does).

Phase 3a:

- Create `src/components/Gexbot/LevelLadder.tsx`
- Create `src/__tests__/LevelLadder.test.tsx`
- Modify `src/components/Gexbot/index.tsx`: mount under the two tiles, above
  `StrikeMoverLadder`; new props `allDeltas`, `quotesFetchedAt` and
  `session`.
- Modify `src/App.tsx`: pass `allDeltas`, `market.quotesFetchedAt` and
  `market.session` to `GexbotSection`.
- Modify `src/__tests__/GexbotSection.test.tsx`.

Phase 3b:

- Modify `e2e/narrow-panels.spec.ts`: the ladder at 375 px, with no sideways
  page scroll, in its widest state. The spec today aborts every `/api/**`
  call, and the section mounts only behind `hasMarketContext` (quotes data),
  so without a fixture the check would pass on the skeleton or a closed
  ladder. The fixture:
  - the clock pinned inside market hours with `page.clock.setFixedTime`, as
    `entry-time.spec.ts` does;
  - `route.fulfill` stubs for `/api/quotes` and for both GEXBot views
    (`snapshots-latest` and `expected-move`), registered after the abort-all
    route so they match first, like the existing futures stub;
  - an access mode that mounts the GEXBot section, and calculator inputs that
    produce a 10Δ row, so candidate rows with their odds column render.

  The test asserts that a candidate's odds line is visible before it checks
  the page width.

Phase 4a:

- Modify `api/positions.ts`: the `readonly` query flag (see "Open
  positions").
- Modify `api/_lib/db-positions.ts`: new `getLatestCsvPositions(date)`, and
  the conflict guard in `savePositions` so a Schwab save never overwrites a
  CSV row. `api/_lib/db.ts` re-exports the module with `export *`, so it
  needs no change.
- Tests: `api/__tests__/positions.test.ts`,
  `api/__tests__/db-positions.test.ts`, and a new
  `api/__tests__/positions-upsert-pglite.test.ts` for the conflict guard. The
  `positions` table and its `UNIQUE(date, fetch_time)` come from the first
  migration in `db-migrations.ts`.

Phase 4b:

- Create `src/hooks/useOpenShortStrikes.ts`
- Create `src/__tests__/useOpenShortStrikes.test.tsx`

Phase 4c:

- Modify `src/components/Gexbot/LevelLadder.tsx`, `index.tsx` and
  `src/App.tsx`: new prop `isOwner`, the hook, the refresh button, the
  positions source in the header.
- Modify `src/__tests__/LevelLadder.test.tsx` and
  `src/__tests__/GexbotSection.test.tsx` (the new required prop).

## Data dependencies

None new.

- **Levels:** the SPX row of `/api/gexbot?view=snapshots-latest`
  (`gexbot_snapshots`, 15-minute window in the query).
- **σ:** the SPX row of `/api/gexbot?view=expected-move`: `expectedMove`,
  `dteFraction`, `asOf`, `unavailable` and `spot`. The ladder draws its band at
  its own spot ± E (see "Odds and status"), not at the row's `lower` and
  `upper`, which are centred on GEXBot's spot. One spot then drives the band
  and the odds. `ExpectedMoveTile` keeps GEXBot's centre, so the two ranges
  can differ by the spot lag.
- **Strike IVs (phase 2b):** the same row's `strikeIvs`, the call and put IV
  GEXBot sends for every strike in the capture the move is computed from. The
  odds price each short strike from them (see "Odds and status"). Because the
  band is the ATM move and the odds use each strike's own IVs, a short put
  can read "watch" just outside the −1σ line when the skew prices it that
  way. That is intended: the band is GEXBot's move, the status is the
  strike's own priced chance.
- **Spot:** the existing `spxSpot` prop (Schwab), as `StrikeMoverLadder` uses,
  while it is fresh. The GEXBot snapshot's own spot can lag by a minute.
  While the market is open, a Schwab quote counts only when it is not stale
  by `useQuoteStaleness(quotesFetchedAt, session)`, the hook behind the
  header's quote badge (stale at 90 s, one missed poll past the 60 s
  cadence). `LevelLadder` calls that hook, so the threshold lives in one
  place. A null or stale quote falls back to the expected-move row's `spot`,
  and the header says "GEXBot spot". While the market is open that fallback
  holds only while the row is fresh: a row whose `asOf` is older than
  `LADDER_MAX_LEVEL_AGE_SECONDS` (240 s, the limit the odds use) counts as no
  spot, and the ladder reads "waiting for SPX spot" (owner, 2026-11-27: see
  "Owner decision, 2026-11-27"). Why: on a 401 `useMarketData` keeps the last quote, so a Schwab login
  that lapses mid-session freezes `spxSpot` instead of nulling it. A short
  call at 7,620 would keep reading 7,588.4 as spot while SPX ran to 7,615, and
  read more "clear" each minute as `E` shrinks. With the market closed the
  held value, the quote or else the GEXBot spot, is the close and is used as
  is. The choice is a pure helper, `pickLadderSpot` in `build.ts`. It takes
  `spxSpot`, `spxSpotStale` (the hook's `isStale`), `gexbotSpot`, `gexbotAsOf`
  (the expected-move row's `asOf`, or null with no row), `nowMs` and
  `marketOpen`, and returns the spot and its source.
- **Candidate strikes:** `results.allDeltas` from `useCalculation`. Calculator
  output, not vendor data.
- **Open strikes (phase 4):** `GET /api/positions?readonly=1`. The plain GET
  already reads the day's SPX option legs from Schwab and saves them; the
  read-only mode serves today's newest paperMoney CSV upload when there is
  one, Schwab otherwise, and saves nothing (see "Open positions"). Owner only
  (`guardOwnerEndpoint`). CSV uploads are already stored in `positions` with
  `account_hash = 'paperMoney'`.
- **Normal curve:** `normalCDF` in `src/utils/black-scholes.ts`.
- **Requests:** both GEXBot views are already polled by other components in
  the section. The hook shares an in-flight request for the same URL and the
  endpoint caches for 15 s, so the ladder adds few requests or none.
- **Licensing:** every GEXBot value reaches the panel through the guarded
  `/api/gexbot` endpoint (`guardOwnerOrGuestEndpoint`). Nothing computed from
  GEXBot data is bundled into the client.

## Ladder rules

`buildLevelLadder(input)` is pure: no clock, no fetch. Input: `spot`, the SPX
snapshot row, the SPX expected-move row, its `strikeIvs` (a separate input,
null when none), `levelsFailed` and
`expectedMoveFailed`, the short strikes, `nowMs`, `marketOpen`. Output:
`result` (status and sentence), `rows` (top to bottom, each a strike entry or
a marker entry), `above` and `below` (what fell outside the window), `levels`
(`shown`, `stale`, `not_same_day`, `missing`, `unavailable`), and one
`summary` per side. A null spot returns no rows and status `no_spot`.

**A failed view** means its `useGexbotData` hook has `error` set and holds no
rows. The hook keeps the last good rows when a later read fails and sets
`error` beside them (`useGexbotData.ts`, the error branch of `fetchNow`), so
an error with rows held is not a failure: the held rows are judged by their
age, the levels by `LADDER_MAX_LEVEL_AGE_SECONDS` and the expected-move row
by the same limit on its `asOf`. One Neon blip therefore changes nothing on
screen, and rows held through a long outage age out.

### Levels

Ids are the ladder's own, chosen to match the planned study's tags.

| Id                   | Column          | Row field     | Label                           |
| -------------------- | --------------- | ------------- | ------------------------------- |
| `classic_pos_vol`    | `major_pos_vol` | `majorPosVol` | Classic major positive · volume |
| `classic_neg_vol`    | `major_neg_vol` | `majorNegVol` | Classic major negative · volume |
| `classic_pos_oi`     | `major_pos_oi`  | `majorPosOi`  | Classic major positive · OI     |
| `classic_neg_oi`     | `major_neg_oi`  | `majorNegOi`  | Classic major negative · OI     |
| `state_long_gamma`   | `z_mlgamma`     | `zMlgamma`    | State long gamma · taker-long   |
| `state_short_gamma`  | `z_msgamma`     | `zMsgamma`    | State short gamma · taker-short |
| `state_major_call`   | `zero_mcall`    | `zeroMcall`   | State major call                |
| `state_major_put`    | `zero_mput`     | `zeroMput`    | State major put                 |
| `classic_zero_gamma` | `zero_gamma`    | `zeroGamma`   | Classic zero gamma              |

- A level that is null, non-finite or ≤ 0 is absent. GEXBot sends
  `zero_gamma = 0` before volume prints (`deriveGammaSign` already guards
  it); the same guard covers the other eight.
- A strike level on a listed strike (a multiple of
  `DEFAULTS.STRIKE_INCREMENT`) is a chip on that row. Two levels on one strike
  give two chips, in table order.
- A strike level off the grid is a marker line at its exact value.
  `classic_zero_gamma` is always a marker line: an off-grid level has no
  strike row to sit on, and zero gamma is a crossing, not a strike. Measured
  over 392 SPX minutes on 2026-11-25 (08:30 to 15:15 CT): the two state gamma
  levels are nearly always off the grid (`z_mlgamma` 349 minutes,
  `z_msgamma` 315), so they are usually marker lines. The other six are
  nearly always on it: 58 off-grid readings in 2,352 (2.5%), most of them
  `zero_mcall` (18), `zero_mput` (16) and `major_neg_vol` (18). So both
  paths render every session.
- Levels show only when the snapshot is usable: `capturedAt` within
  `LADDER_MAX_LEVEL_AGE_SECONDS` of now while the market is open, and `minDte`
  0 or null. With the market closed the last levels stay, labelled with their
  time.
- When the snapshot is not usable, strikes, spot, band and short strikes
  still render. Chips and level markers are dropped and one line says why.
  The first that applies wins:
  1. `unavailable`, the view failed: "GEXBot levels unavailable".
  2. `missing`, no SPX row: "No GEXBot levels for SPX in the last 15 min",
     printed only while the market is open. With the market closed (a tab
     opened after about 15:16 CT, pre-open or on a weekend gets an empty view
     from the query's 15-minute window) there is no line at all.
  3. `not_same_day`: "nearest expiry is not same-day". A fresh row for the
     wrong expiry is still wrong, so this beats `stale`.
  4. `stale`: "GEXBot levels are 6 min old".

### Short strikes

- **Candidates (phase 3).** From `allDeltas`: the row with
  `delta === LADDER_SHORT_DELTA`, its `callSnapped` and `putSnapped`. Chips
  read "CANDIDATE · 10Δ CALL" and "CANDIDATE · 10Δ PUT". `App.tsx` passes
  `null` when `backtestMode` is true: the calculator then describes a past
  moment while the levels are live. No such row, or an error row: no chips.
- **Open positions (phase 4).** From `GET /api/positions?readonly=1`: every
  leg in `positions.legs` with `quantity < 0`. Chips read "OPEN · SHORT CALL"
  and "OPEN · SHORT PUT". Each open short leg gets its chip and odds. The
  result line and summary use the nearest one to spot on each side.
- While any open short leg exists the candidates are hidden: the question has
  changed from where to place strikes to how the position stands.

### Odds and status

`odds.ts`, pure. For a short strike `K` and the ladder's spot `S`, with
`distance = K − S` for a call and `S − K` for a put:

- `T_now`, the time left in days, is the expected-move row's `dteFraction`
  carried forward to now: `T_now = T_row − (nowMs − asOf) ÷ 86,400,000`,
  where `T_row` is the row's `dteFraction`. Elapsed time below 0 (a row
  stamped after `nowMs`) counts as 0. `T_now` ≤ 0 means no odds.
- `E`, one ATM standard deviation to expiry in points, is the row's
  `expectedMove` carried forward the same way: `E_row × √(T_now ÷ T_row)`.
  The row is sized at the vendor's stamp, which can be a couple of minutes
  old, and that overstates `E` near the close: a 2-minute-old row with 5
  minutes left is about 18% too wide (√(7 ÷ 5)). `E` draws the band and is
  the fallback below.
- **The priced chance of finishing beyond `K`** (owner, 2026-11-26) is the
  market's own price for "SPX finishes past `K`": what a vertical spread at
  `K` costs divided by its width, taken as the spread narrows to nothing (the
  skew-adjusted digital). With `h = DEFAULTS.STRIKE_INCREMENT` (5), `Φ` =
  `normalCDF` and `φ` = `normalPDF` from `black-scholes.ts`:
  - `IV(k)` is strike `k`'s put IV for a short put and its call IV for a
    short call, from `strikeIvs`, whichever side of spot `K` is on.
  - `m = S × √(T_now ÷ 365)`, and `n = m × IV(K)`, in points.
  - The smile's slope at `K`: `IV′ = (IV(K + h) − IV(K − h)) ÷ 2h`, per point.
  - Short put: `finishBeyond = Φ(d) + φ(d) × m × IV′`, with
    `d = (K − S) ÷ n`. Short call: `finishBeyond = Φ(x) − φ(x) × m × IV′`,
    with `x = (S − K) ÷ n`.
  - This is the strike derivative of normal-model (Bachelier) prices with
    each strike at its own IV: the `Φ` term is the curve at `K`'s own IV, the
    `IV′` term is the smile's slope taking part of it back (for a put the
    slope is usually negative, so it lowers the chance). With a flat smile
    `IV′` is 0 and it is the ATM formula exactly, at every `E`.
  - Why not a 10-wide spread's price divided by 10, the first form of this
    rule: that averages the chance over `K ± h`, and the average reads
    riskier as `E` shrinks. Checked 2026-11-26 on a flat smile: with `E` 10
    pts (about 30 min left) a strike 1.2σ out read 1.15σ, WATCH instead of
    CLEAR, and at `E` 5 pts it read 1.03σ. The code review of phase 2 found
    it.
- Why not put the strike's own IV into the ATM formula: downside IV is
  higher, but it also falls as the strike rises toward spot, and that slope
  takes most of the extra back. Measured over 370 minutes of 2026-11-25
  (08:35 to 14:45 CT, strikes 1.28 ATM σ out), the mean finish beyond, put
  and call: ATM σ 9.3% and 9.3%; the strike's own IV 11.2% and 10.6%; the
  market's priced chance (this rule) 9.0% and 8.7%. The strike's own IV
  read the put "not clear" in 132 of the 370 minutes, the priced chance in
  1 (re-measured with this rule on 2026-11-26; the 10-wide spread had given
  the same means and 2 minutes). One day, the only one still in the raw
  captures.
- **Fallback, the ATM σ:** `finishBeyond = normalCDF(−distance ÷ E)`. Used
  when `strikeIvs` is null or empty; when `K`, `K − h` or `K + h` has no
  usable IV on the needed side (absent, or not above 0); or when the result
  is not finite or not strictly between 0 and 1. Each short strike records
  which was used (`oddsSource: 'priced' | 'atm'`). The panel prints
  nothing about it.
- `sigmaAway = −Φ⁻¹(finishBeyond)`: the σ whose normal tail equals the
  priced chance, so the printed σ and the printed odds always agree. On the
  fallback it equals `distance ÷ E`. `Φ⁻¹` is new in `odds.ts` (the repo has
  none): a rational approximation refined against `normalCDF`, so the round
  trip agrees with the same `Φ` the odds use.
- `touch = min(1, 2 × finishBeyond)`

| Status     | Condition                           | At the boundary       |
| ---------- | ----------------------------------- | --------------------- |
| `clear`    | `sigmaAway` ≥ 1.2                   | touch 23%, finish 12% |
| `watch`    | 1.0 ≤ `sigmaAway` < 1.2             | touch 32%, finish 16% |
| `tested`   | `sigmaAway` < 1, and `distance` > 0 | priced inside ±1σ     |
| `breached` | `distance` ≤ 0                      | spot is at or past it |

- Breached is decided by spot's position, not by σ. A strike spot has not
  reached whose priced chance is 50% or more (`sigmaAway` ≤ 0, possible
  within a point or two of spot under a skew) is `tested` and prints
  "0.00σ".
- These are the odds the options are pricing, from GEXBot's IVs. They are
  not an edge and not a forecast. The panel says "priced" every time it
  prints one.
- With no usable expected move there are no odds and no status. That covers
  `unavailable` set, an empty view (pre-open and the first minutes after the
  open), a failed view (`expectedMoveFailed`), a held row whose `asOf` is
  older than `LADDER_MAX_LEVEL_AGE_SECONDS` while the market is open, a row
  whose `minDte` is neither 0 nor null (it sizes a later expiry's move from
  that expiry's IVs and time, the same test the levels use), a time left
  that is not a number, and `E` ≤ 0. Short-strike rows fall back to
  distance, and the result line says so.
- With the market closed (`marketOpen` false) there is no band, no odds and no
  status either, matching `ExpectedMoveTile`'s "session closed". The last row
  held after the close is sized for the final minute and would print near-zero
  odds for an expiry that has settled.
- A breached strike prints no touch or finish beyond: it has been touched. Its
  row and the result line give how far past it spot is.
- Printing: σ to two decimals below 3 and one from 3 up, choosing the
  precision from the value rounded to hundredths (2.996 prints "3.0σ", not
  "3.00σ"); percentages whole; below 1% prints "under 1%" and above 99%
  prints "over 99%".

### Result line

Built by the model, one to three short sentences, led by a status pill. Labels
are "Call" and "Put" for candidates, "Short call" and "Short put" for open
legs. Numbers follow the printing rules above.

Exactly one case applies. The first that matches wins:

1. Market closed.
2. No short strikes.
3. No usable expected move (short strikes present).
4. The status sentences: both clear, or worst first.

So after the close, when the expected-move row is also `unavailable`, only
"Session closed…" prints, and with no short strikes the nearest-levels
sentence prints alone; it is distance-only already.

- **Pill:** the worst status among the short strikes shown. No pill when there
  is no status (no short strikes, no usable expected move, market closed).
- **Both sides clear:** "Both candidate strikes are clear." (or "Both short
  strikes are clear."), then "Call 7,620 is 1.37σ away with a 17% priced
  chance of a touch. Put 7,555 is 1.45σ away with 15%."
- **Otherwise,** the worst strike first:
  - watch or tested: "Short call 7,620 is tested: 0.91σ away, a 36% priced
    chance of a touch and 18% of finishing beyond." ("is on watch" for watch);
  - clear, with only one side present: "Short call 7,620 is clear: 1.37σ away,
    a 17% priced chance of a touch and 8% of finishing beyond.";
  - breached: "Short call 7,620 is breached: spot is 2.4 pts past it.";
  - then the other side as "Short put is clear." (its status word), or "No
    short put." when that side has none.
- **Ties:** when both sides share the worst status, the one with the smaller
  `sigmaAway` is named first.
- **No short strikes:** "No short strikes to check. Nearest levels: State
  long gamma · taker-long 7,595 (+6.6 pts) above, State short gamma ·
  taker-short 7,580 (−8.4 pts) below." These are strike levels; zero gamma is
  not counted. A side with no shown level reads "none above" or "none below";
  with no levels shown at all, just "No short strikes to check."
- **No usable expected move:** "Expected move unavailable. Distances only."
- **Market closed:** "Session closed. Levels as of 15:01 CT." The time is
  the held snapshot's `capturedAt` in CT, not fixed text: the last capture
  lands about a minute after the close (15:01 CT on 2026-11-25, about 12:01
  CT on a half day). With no snapshot held, just "Session closed."

### Window

- Rows are every multiple of 5 from `top` down to `bottom`.
- Upward reach is the largest of: `LADDER_MIN_HALF_SPAN_PTS`; the +1σ bound
  plus one strike; the nearest short call. It is capped at
  `LADDER_MAX_HALF_SPAN_PTS`, then rounded up to a strike. Downward is the
  mirror.
- No band and no short strikes gives the minimum span.
- A level, bound or short strike outside the window goes to `above` or
  `below`, nearest first, and renders as one line on that side: "Above: Classic
  major positive · OI 7,700". A short strike listed there keeps its odds.

### Markers

- Spot, +1σ, −1σ, zero gamma, and any off-grid strike level.
- A marker sits directly above the first row whose strike is at or below its
  value. `StrikeMoverLadder`'s spot divider uses the same rule. Several
  between the same two rows sort high to low.
- The band is the ladder's spot ± `E`, with `E` carried forward as under
  "Odds and status". With no usable expected move, or the market closed,
  there are no band markers; `ExpectedMoveTile` already prints the reason.

### Second column and summary

- On a short-strike row: the status pill, then σ, touch and finish beyond.
- On any other tagged row: signed distance from spot, then the position
  against the band. "+16.6 pts · inside +1σ". With no band, distance only.
- A row that is both a short strike and a level shows the odds line.
- Untagged rows show the strike alone.
- One summary line per side, under the ladder, for the strike the result
  line names on that side:
  - outside the band, as in the sketch: "Call 7,620: 31.6 pts above spot,
    8.6 outside +1σ. Levels between: 7,595 · 7,600 · 7,605.";
  - inside the band: "Call 7,605: 16.6 pts above spot, 6.4 inside +1σ.
    Levels between: 7,595 · 7,600.";
  - with no band: "Call 7,620: 31.6 pts above spot. Levels between: …";
  - breached: "Call 7,620: spot is 2.4 pts past it." with no "Levels
    between".
- "Levels between" lists the strike levels strictly between spot and the
  short strike, nearest first, on-grid and off-grid alike; with none it reads
  "No levels between." Zero gamma is a crossing, so it is not listed.

### Open positions (phase 4)

Owner decisions 2026-11-26: a read-only mode that saves nothing, polled
every minute; and when a paperMoney CSV was uploaded today, the ladder shows
the CSV's positions, not the live account's.

Why read-only: every plain `GET /api/positions` saves a `positions` row keyed
by (date, CT minute), and the analyze endpoint reads the day's newest row
with spreads. A polling ladder that saved would overwrite a CSV uploaded in
the same minute, and would make analyze read the live account whenever it
holds SPX spreads.

**Server, phase 4a.** `GET /api/positions?readonly=1`:

- `readonly` absent keeps today's behaviour exactly. `1` turns the mode on.
  Any other value is a 400, so a typo can't fall through to a saving read.
  POST does not read the flag: a CSV upload always saves.
- Same owner guard, same 20-a-minute rate limit, same `?date=` check.
- It first reads the day's newest `positions` row with
  `account_hash = 'paperMoney'`, through `getLatestCsvPositions(date)`
  (`ORDER BY created_at DESC LIMIT 1`). When there is one, it answers from
  that row with `source: 'paperMoney'` and the row's `fetch_time` (the CT
  minute of the upload). No Schwab call is made.
- When there is none, it makes the Schwab fetch as the plain GET does and
  answers with `source: 'schwab'`, skipping `persistPositions`, so
  `saved: false`.
- On both paths the legs are only those expiring today (the Schwab path
  already filters; the CSV's open legs are filtered the same way), and the
  body has the plain GET's shape, built with `buildPositionResponse` from
  those legs with no `spx`.
- A failed CSV read is an error (`sendDbErrorResponse`: 503 for a transient
  Neon blip, 500 otherwise), not a fall back to Schwab. Falling back would
  silently switch the source on a database blip.
- A CSV with no open SPX legs still governs: the ladder shows no open short
  strikes for the rest of the day, or until a newer upload.
- A Schwab save never overwrites a CSV row. Today the upsert is keyed on
  (date, fetch_time) and rewrites `account_hash`, so a plain GET in the same
  CT minute as an upload (another tab, or `useChartAnalysis` in a tab that
  did not upload) replaces the CSV row. The ladder would then fall back to an
  older CSV from the same day, showing a spread that the newer CSV had closed,
  or to Schwab. Phase 4a adds a guard to the upsert in `savePositions`:

  ```sql
  ON CONFLICT (date, fetch_time) DO UPDATE SET …
  WHERE positions.account_hash <> 'paperMoney'
     OR EXCLUDED.account_hash = 'paperMoney'
  ```

  A CSV still replaces any row in its minute; a Schwab row never replaces a
  CSV row. When the
  guard skips the write, `RETURNING` yields no row, `savePositions` returns
  null, and `persistPositions` reports `saved: false` (today it reports
  `true` whenever the call does not throw).

**Client, phases 4b and 4c.**

- `useOpenShortStrikes({ enabled })` calls `GET /api/positions?readonly=1`
  with `credentials: 'include'`. Enabled only when `isOwner` and the market is
  open, so a guest never calls an owner-only endpoint. It is not gated on
  `backtestMode`: positions and levels are both live whatever time the
  calculator is set to, and the component has no `backtestMode` to read.
- It sends no `?spx=`. That parameter only fed the saved row's "SPX at fetch
  time" and cushion lines, and the read-only mode saves nothing. A spot tick
  therefore never sends a request.
- It fetches every `LADDER_POSITIONS_POLL_MS` through `usePolling`, when the
  trader presses "Refresh positions" in the panel header, and at once on the
  enable edge (mount while enabled, or `enabled` turning true). On that edge
  it first drops every held strike. `usePolling` never calls its function
  when its gate flips, so without the edge fetch a tab left open overnight
  would show yesterday's legs as open, with live pills and odds, until the
  first poll a minute after 08:30 CT, or all day if that poll got a 401. This
  is the same fix `useGexbotData` got in `107ce34be`.
- It also drops any leg whose `expiration` is not today's ET date, on every
  answer and on every render.
- The header prints the source and its time: "paperMoney CSV · 10:15 CT"
  (the upload's minute) or "Schwab · 10:31 CT" (the last good fetch).
- Requests are numbered, and only the newest applies its answer. A slow poll
  can't bring back a leg the trader closed and then refreshed past. Each new
  request aborts the one before it with an `AbortController` (R6), and
  unmount aborts the one in flight; the numbering still guards an answer
  that lands anyway.
- Cost: one call a minute, against the endpoint's limit of 20 a minute. With
  no CSV each call makes two Schwab Trader requests; with a CSV it makes one
  database read and no Schwab request.
- On an error the ladder keeps the last good answer, including an empty one,
  and prints "Open positions unavailable". Candidates show when that answer
  has no open short legs, or when there has been no good answer since the
  last enable edge.
- The refresh button is a real `<button>`, at least 44 px tall on a phone.
  It renders only while the hook is enabled, so a guest never sees it, and
  neither does anyone with the market closed.

### States and layout

- Loading and error use the `role="status"` boxes `StrikeMoverLadder` uses.
  Which state shows, in order:
  1. No spot (neither `spxSpot` nor a GEXBot spot): "Level Ladder — waiting
     for SPX spot".
  2. Both views still loading, with nothing held: the loading box.
  3. Both views failed: the error box.
  4. Otherwise the ladder renders, and each part degrades on its own.
     `expected-move` failed or empty: no band, no odds, "Expected move
     unavailable. Distances only." `snapshots-latest` failed: no chips or level
     markers, and one line "GEXBot levels unavailable"; band and short strikes
     stay.
- Panel chrome as `StrikeMoverLadder`, with one header line. Classes:
  `rounded-md border border-white/5 bg-white/[0.02]`.
- The result line sits directly under the header, in its own band.
- A `<ul>`. Each row is a flex line: the strike (fixed width, right-aligned,
  mono), then a wrapping body of two equal columns. On a phone the second
  column drops under the chips. No table and no horizontal scroll: in the
  mockup a table needed a scroll box at 390 px and hid the second column.
  At 375 px the page must not scroll sideways, the rule
  `e2e/narrow-panels.spec.ts` holds the tables to.
- Untagged strikes are thin tertiary rows. Tagged rows are full height.
- Colour: spot marker accent; ±1σ caution and dashed; level chips neutral;
  short-strike chips accent outline. Status pills: clear accent, watch
  caution, tested and breached danger. Every pill carries its word, so colour
  is never the only signal.

## Wording

- Owner decision D1 (2026-10-29): GEXBot values are taker-side and
  vendor-defined. Labels are the vendor's field names.
- The panel carries no description tooltips. The labels are the vendor's
  field names, and every number is printed.
- No `title` attributes anywhere in the panel. The source guard added on
  2026-11-21 (`no-title-only-generic.test.ts`) fails a titled plain element
  that has no `<SrHint>`, and nothing here needs a hover explanation: labels
  are the vendor's field names and every number is printed.
- Odds are always called "priced".
- Tests assert `dealerClaims(container.textContent)` is empty.

## Tests (written first)

`api/__tests__/gexbot-queries.test.ts`:

- The six fields map from their columns; null stays null.
- Phase 2b: `getExpectedMove` returns `strikeIvs` as decoded, a strike with
  no IV on one side keeping `null` there; a capture with no `mini_contracts`
  gives `strikeIvs: []`; a capture whose move is `unavailable` still sends
  its `strikeIvs`.

`src/__tests__/level-ladder.odds.test.ts`, as input/output tables:

- Known points on the ATM fallback: 1.0σ gives finish 15.9% and touch
  31.7%; 1.28σ gives 10.0% and 20.1%; 0.5σ gives 30.9% and 61.7%; 2.0σ
  gives 2.3% and 4.6%.
- Priced chance, flat smile: every IV equal to the ATM IV gives the
  fallback's finish (to 1e-9) and the same status at `E` 80, 10 and 5 pts,
  at 1.0σ and at 1.2σ, with `oddsSource: 'priced'`. These are the rows that
  caught the 10-wide spread's late-session drift.
- Priced chance, a real smile (the 2026-11-25 16:00:09Z capture, 10:00 CT:
  spot 7,004.43, 5 h left, so `dteFraction` 0.2083): a short put at 6,905
  with put IVs 0.522 at 6,900, 0.518 at 6,905 and 0.514 at 6,910 gives
  finish beyond 9.80%, where that strike's own put IV in the ATM formula
  would give 12.57%; a short call at 7,100 with call IVs 0.465 at 7,095,
  0.467 at 7,100 and 0.469 at 7,105 gives 9.80%. Checked by two independent
  scripts on 2026-11-26; assert within 0.05 point.
- Fallback: `strikeIvs` null; `K`'s own IV missing on the needed side; a
  missing neighbour IV on the needed side (the other side's IV present); an
  IV of 0; and a result outside (0, 1) from crafted IVs: each uses the ATM
  σ, with `oddsSource: 'atm'`.
- Carry-forward with a NaN `nowMs` gives no odds (no NaN band, no status).
- `Φ⁻¹`: 0.5 gives 0; 0.1 gives −1.2816 to 4 decimals; `normalCDF(Φ⁻¹(p))`
  returns `p` to within 1e-8 from `p` = 1e-6 to 1 − 1e-6.
- `sigmaAway` and the printed odds agree: `normalCDF(−sigmaAway)` equals
  `finishBeyond` on both sources.
- Call and put sides give the same odds at the same distance, on the
  fallback and with a symmetric flat smile.
- Status from `sigmaAway` at 1.2, just under 1.2, 1.0 and just under 1.0;
  `breached` from spot's position: spot at the strike and past it are
  `breached`; a strike spot has not reached with a priced chance over 50% is
  `tested` and prints "0.00σ".
- Touch never exceeds 1.
- A null or non-positive expected move gives no odds and no status.
- Carry-forward: a row stamped with 7 min left, read 2 min later, gives
  `E × √(5 ÷ 7)`; `T_now` ≤ 0 gives no odds.
- A breached strike prints no touch and no finish beyond.
- Printing: "under 1%", "over 99%", two decimals below 3σ, one from 3σ up.

`src/__tests__/level-ladder.build.test.ts`, as input/output tables:

- Window: minimum span; band plus one strike; reach to the short strikes; the
  cap, with the overflow in `above` and `below`.
- Chips: a level on the grid; two levels on one strike in table order; a level
  and a short strike on one strike.
- Markers: an off-grid strike level; zero gamma on a multiple of 5 is still a
  marker; spot exactly on a strike; several between two rows, high to low.
- Absent levels: null, 0, negative, NaN.
- Usability: older than the limit with the market open is `stale` and keeps
  band and short strikes; the same age with the market closed is `shown`;
  `minDte` 1 is `not_same_day`; `minDte` null is `shown`; no SPX row is
  `missing`.
- Band: `unavailable` set gives no band markers, distance-only text and the
  "Distances only" result.
- Short strikes: candidates from `allDeltas`; `allDeltas` null; an error row
  at 10Δ; open legs hide candidates; two open short calls use the nearer one
  in the result.
- Strike IVs: with `strikeIvs` a short strike's odds come from the priced
  chance (`oddsSource: 'priced'`); with `strikeIvs` null from the ATM σ; the
  band is the ATM move either way.
- Result line: both clear; one side on watch; one side tested; breached; a
  tie on the worst status; one side only; no short strikes, with and without
  levels; no usable expected move; market closed. Each asserted as the full
  string.
- Band: centred on the ladder's spot, not the row's `lower` and `upper` (a
  GEXBot spot 7.6 pts off moves the band, not the status); market closed gives
  no band, odds or status.
- Spot (`pickLadderSpot`): a fresh Schwab quote is used; a stale one with
  the market open falls back to the GEXBot spot, source "GEXBot spot"; a
  null `spxSpot` falls back the same way; with the market closed a stale
  quote is used as is. The fallback ages with its row (phase 3a2): open, a
  row 240 s old still gives the GEXBot spot and 241 s, an absent or
  unparseable `asOf` give none, a stamp after `nowMs` is fresh, a fresh quote
  wins whatever the row's age, and with the market closed the held GEXBot
  spot is used as is. The odds and the spot agree at the boundary.
- Degrading: `expected-move` failed and `expected-move` empty each give
  distances only with levels kept; `snapshots-latest` failed gives
  `unavailable` and no chips, with band and short strikes kept. An error with
  rows held is not a failure: fresh held rows still show, and held rows older
  than the limit age out (`stale` levels; no usable expected move). An
  expected-move row with `minDte` 1 gives no usable expected move ("Distances
  only"); `minDte` null is usable.
- Usability precedence: `unavailable`, then `missing`, then `not_same_day`,
  then `stale`; the `missing` text while open and no line with the market
  closed.
- Result-line precedence: closed with the expected move also unavailable
  prints only the closed line; no short strikes with no expected move prints
  only the nearest-levels sentence. The closed line's time comes from
  `capturedAt` (a 21:01:49Z capture reads "15:01 CT"); with no snapshot held,
  just "Session closed."
- Summary: outside the band, inside the band, no band, and breached, each as
  the full string; levels between, nearest first, an off-grid strike level
  included; none.
- Null spot, with no GEXBot spot either.

`src/__tests__/LevelLadder.test.tsx`:

- Header, result band, spot marker, one chip per level.
- No element carries a `title`: `titledGenericsWithoutHint(container)` is
  empty.
- Loading box, error box, the stale line.
- `getByRole('list')` with `listitem` rows.
- No short chips when `allDeltas` is null.
- Phase 4: open chips replace candidates; the refresh button calls the hook;
  the unavailable line; the header's source and time, for a CSV and for
  Schwab; candidates show when the last good answer had no open short legs
  and a later poll failed; no refresh button for a guest or with the market
  closed.
- `dealerClaims` is empty on a fully populated ladder.

`api/__tests__/positions.test.ts` (phase 4a):

- `readonly=1` with a CSV row today: the CSV's legs, `source: 'paperMoney'`,
  the row's `fetchTime`, no Schwab request, no save.
- `readonly=1` with no CSV row: Schwab's legs, `source: 'schwab'`,
  `saved: false`, `savePositions` not called.
- `readonly=1` and the CSV read rejects: 503 for a transient error and 500
  otherwise, with no Schwab request.
- `readonly=1` and Schwab answers 401: that status passes through, no save.
- `readonly=1` and a CSV leg expiring another day: dropped.
- `readonly=yes`: 400.
- Plain GET with no flag: still saves, as before; when the guard skips the
  write (`savePositions` returns null), `saved: false`.

`api/__tests__/db-positions.test.ts` (phase 4a):

- `getLatestCsvPositions` filters on the date and on
  `account_hash = 'paperMoney'`, newest first; no row gives null; legs
  stored as a string are parsed.
- `savePositions` returns null when the upsert returns no row.

`api/__tests__/positions-upsert-pglite.test.ts` (phase 4a, new), against a
real `positions` table built from the migrations, so the guard is tested by
Postgres and not by a mock:

- A CSV row, then a Schwab save in the same minute: the CSV row is kept.
- A Schwab row, then a CSV in the same minute: the CSV replaces it.
- A CSV, then a second CSV in the same minute: the second replaces the first.

`src/__tests__/useOpenShortStrikes.test.tsx`:

- Short legs become call and put strikes; long legs are ignored.
- Not enabled: no request.
- The enable edge drops held strikes and fetches at once, without waiting for
  the first poll; a first answer of 401 after the edge leaves no held legs.
- A held leg whose `expiration` is yesterday is not returned.
- A new request aborts the one in flight, and unmount aborts it too.
- The request carries `readonly=1` and no `spx`.
- `source` and `fetchTime` come through for a CSV and for Schwab.
- A CSV with no open legs gives no open strikes, not an error.
- An error keeps the last good strikes.
- An older response that lands after a newer one is ignored.
- A malformed payload and a 401 (Schwab logged out) each read as unavailable
  and keep the last good strikes.

`src/__tests__/GexbotSection.test.tsx`:

- The section mounts the ladder and renders without `allDeltas`.

## Open questions (default picks)

All nine were settled by the owner on 2026-11-26: question 4 as option A with
the CSV shown, question 2 changed later that day to the spread price, every
other question at its default. They stay here with their reasoning.

1. **Status thresholds.** Default: clear at 1.2σ, tested inside 1σ. These are
   a first guess with nothing measured behind them. A 10Δ strike is 1.28σ out
   by the calculator's own σ, but the ladder measures in GEXBot's ATM σ. The
   calculator prices with its own σ (VIX1D when auto-filled) and skews it,
   narrower on the call side (`strikes.ts`), so a fresh 10Δ call candidate can
   start at "watch" by the ladder's measure. **Owner 2026-11-26: keep the
   guesses for now.** The constants' doc comment says they are unmeasured;
   the panel prints no extra text about it.
2. **Odds model.** Default: one σ for both sides, from GEXBot's smoothed ATM
   IV. It ignores skew. Alternatives: the strike's own IV from the state
   ladder (`decodeStrikeIvs` already decodes it), or the calculator's
   kurtosis factors (`getKurtosisFactor`). **Owner 2026-11-26: the spread
   price, with the ATM σ as its fallback** (see "Odds and status"). The
   owner first chose the strike's own IV; measured on 2026-11-25 it read
   both sides riskier than the market priced them, so the owner took the
   spread price instead.
3. **Candidates while a position is open.** Default: hidden. Alternative:
   shown in a lighter chip for adding a second spread.
4. **Positions polling, and the saved rows.** Owner, from the review. Each
   `GET /api/positions` saves a `positions` row keyed by (date, CT minute),
   and the analyze endpoint reads the newest row with spreads. A polling
   ladder therefore (a) overwrites a paperMoney CSV upload made in the same
   minute, and (b) when the live account holds SPX spreads, makes analyze read
   the live account instead of the CSV. The ladder also never shows CSV
   positions. Options:
   - A: a read-only flag on the endpoint that skips the save, polled every
     minute. Adds `api/positions.ts` and its test, as a phase of their own.
   - B: the draft default, every five minutes plus the button, saving each
     time. Safe only if paperMoney CSVs are not in use.
   - C: no polling; fetch on mount and on the button only.

   Also: which source the ladder shows when a CSV is uploaded, the live
   Schwab account or the CSV.

   **Owner 2026-11-26: A, and the CSV.** Built as phase 4a, a read-only mode
   that answers from today's newest CSV upload first (see "Open positions").

5. **Second column on level rows before rates exist.** Default: distance from
   spot. Alternative: a "Turned back on arrival" column reading "not
   measured", which tells the trader nothing.
6. **Candidate delta.** Default: 10Δ only, the delta `AdvancedSection`'s
   Position Snapshot uses.
7. **Staleness clock.** Default: `capturedAt`, the only stamp the view
   exposes; it differs from the vendor's own stamp by the fetch lag.
   Alternative: add `source_timestamp` to the view.
8. **Is 0 a "hidden" value on the eight strike levels,** as it is on
   `zero_gamma`? Default: treat ≤ 0 as absent. Checked 2026-11-25: none of the
   nine columns was 0 or null in 780 SPX regular-hours rows (11-24 and 11-25;
   older days are archived), so the guard has not fired yet.
9. **Span limits.** 20 and 60 points are a first guess.

## Thresholds and constants

- `LADDER_SHORT_DELTA = 10`
- `LADDER_CLEAR_SIGMA = 1.2`
- `LADDER_TESTED_SIGMA = 1.0`
- `LADDER_MIN_HALF_SPAN_PTS = 20`
- `LADDER_MAX_HALF_SPAN_PTS = 60`
- `LADDER_MAX_LEVEL_AGE_SECONDS = 240`. The client sees a row later than the
  database does: the cron writes about once a minute, the endpoint caches for
  15 s with 60 s of stale-while-revalidate, and the hook polls every 30 s.
  That is about 130 s of age with every run on time and about 190 s after one
  missed run. 240 s keeps the levels through one missed run and drops them
  after two. It is deliberately not `FIRE_TIME_MAX_AGE_SECONDS` (180 s), which
  bounds a direct database read at fire time.
- `LADDER_POSITIONS_POLL_MS = 60_000` (owner, 2026-11-26: every minute,
  read-only)
- Strike step: `DEFAULTS.STRIKE_INCREMENT` (5), existing. The smile's slope
  at a short strike is read over two steps (10 pts), centred on it.
- Staleness re-check: `useNow(30_000)` from `session-clock.ts` while the
  market is open, so a stalled feed ages out without a new poll.
- GEXBot polling: unchanged, the hook's 30 s. Odds recompute on every spot
  tick, against an expected move that refreshes each minute.

## Not in this slice

- **Turn-back rates.** They wait for the level-touch study. When they come:
  an optional rate on each level, keyed by level id and arrival direction (a
  level above spot is reached from below, `up`; one below spot, `down`). They
  are values computed from GEXBot data, so they are served through the guarded
  endpoint, not imported from `ml/findings/` into the bundle.
- The mockup's other cards (next level, wing, entry check, close), its
  "Decision Desk" name and its two extra tiles. Each of those cards leads
  with a result line too; they get their own specs. The section label
  stays "GEXBot Taker Flow".
- Credit, contracts and P&L of the open position.
- 1DTE levels (`o_mlgamma`, `o_msgamma`, `one_mcall`, `one_mput`) and other
  tickers.
- Feeding the ladder to the analyze prompt.
- Changes to `StrikeMoverLadder` or `GammaCompass`.
- Structure-aware status. `positions-spreads.ts` treats every short leg as a
  credit short, so a debit spread's or a BWB's short leg gets the same pill.
  Phase 4 shows the distance from each short strike whatever the structure.

## Review, 2026-11-25

Spec-reviewer (opus), verdict revise. Owner-side: open questions 1 and 4.
Settled here by the author:

- The band is drawn at the ladder's spot ± E, so band, σ and status share one
  spot (it was GEXBot's `lower`/`upper` against Schwab's spot).
- Phases split to stay within the 5-file cap: 1a/1b, 3a/3b, 4a/4b. All four
  fixtures need the six fields, not "whichever type-check names".
- The level-touch study is not in the repo, so every rule that cited it is
  restated as the ladder's own.
- The level age limit is 240 s, budgeting the client's cache and poll lag.
- With the market closed: no band, odds or status.
- The positions hook is gated on `isOwner` and `marketOpen` only, not
  `backtestMode`; spot goes out as `?spx=` from a ref; requests are numbered.
- Each view degrades on its own, in a stated order of states.
- Full result-line wording for every case, including ties, one side only,
  breached (no touch printed) and closed.
- `E` is carried forward from the vendor's stamp to now.
- A GEXBot spot fallback for a lapsed Schwab login.
- Smaller fixes: the phase 4 sketch's put row, `not_same_day` over `stale`,
  the `missing` text, off-grid levels in "Levels between", the narrow-screen
  e2e check (3b), and R4 failure cases for the hook.
- Open question 8 checked against production.

## Owner decisions, 2026-11-26

- Question 4: option A, with the CSV shown when one was uploaded today. That
  adds phase 4a, a read-only mode on `GET /api/positions` that answers from
  the newest CSV row first and saves nothing, and renumbers the hook and the
  wiring as 4b and 4c. The hook no longer sends `?spx=`, which only fed the
  saved row (this replaces the 2026-11-25 "spot from a ref" note). It polls
  every minute.
- Question 1: keep the guessed thresholds for now.
- Questions 3 and 5 to 9: the defaults.
- Question 2, changed later on 2026-11-26: a short strike's priced odds are
  the market's own price for finishing past it, the price of a vertical
  spread at the strike per point of width, from GEXBot's per-strike IVs,
  with the ATM σ as the fallback. The owner first said yes to the strike's
  own IV in the ATM formula, then chose the spread price after the
  2026-11-25 comparison under "Odds and status". That adds phases 2b (the
  view sends `strikeIvs`) and 2c (the client type and fixtures). The phase 2
  code review then showed that a 10-wide spread reads strikes riskier late
  in the session, so the rule takes the spread's narrow limit (the
  skew-adjusted digital); same quantity, without the drift.

## Owner decision, 2026-11-27

Phase 3a2, option A: the GEXBot spot fallback is aged. Example of the gap:
the market is open, the Schwab login lapses at 10:00 CT (the quote reads
stale by 10:02), and GEXBot's feed stalls with its last expected-move capture
at 10:05 CT, spot 7,588. At 10:20 the ladder still measured every distance
from 7,588 and called it "GEXBot spot", while the model had already dropped
the band and odds for that row as past the age limit. Now, while the market
is open, a GEXBot spot whose expected-move row is older than
`LADDER_MAX_LEVEL_AGE_SECONDS` (240 s, inclusive at the limit) counts as no
spot, so the ladder shows "Level Ladder — waiting for SPX spot". An absent or
unparseable `asOf` counts as too old, and a stamp after the clock counts as
age 0. With the market closed the held value is used as is, the rule the
Schwab quote follows. The spot and the odds share one freshness check in
`build.ts`, so they cannot disagree at the boundary.

## Review, 2026-11-26

Second and last spec-reviewer pass (opus), verdict revise, every finding
author-side. Settled here:

- Spot: a Schwab quote older than 90 s while the market is open counts as no
  spot, so a login that lapses mid-session falls back to the GEXBot spot
  instead of freezing the ladder on the last quote (`pickLadderSpot`).
- Positions hook: on the enable edge it drops held strikes and fetches at
  once, and it drops legs not expiring today, so an overnight tab never shows
  yesterday's legs as open. Superseded and unmounted requests are aborted.
- "Failed" defined as an error with nothing held. Held rows are judged by
  age, the expected-move row included; `levels` gains `unavailable`, with a
  stated precedence.
- Result-line precedence (closed, no short strikes, no expected move,
  status), the closed line's time from `capturedAt`, and no `missing` line
  with the market closed.
- The narrow-screen e2e check gets a named fixture (pinned clock, stubbed
  quotes and views, candidates), so it can't pass on a skeleton.
- Candidates show after an error when the last good answer was empty; the
  refresh button is hidden while the hook is disabled.
- A Schwab save never overwrites a CSV row: a conflict guard in
  `savePositions`, with a pglite test (phase 4a).
- Summary wording for inside the band, no band and breached.
- Checked against production while settling: how often each strike level
  sits off the grid (counts under "Levels"; an earlier draft generalised
  from one outlier row and was corrected after the phase 1b code review),
  and the last capture of a session lands at 15:01 CT.

## As built, phase 3a (2026-11-27)

Where the `LevelLadder` component reads this spec in a way the text above
does not say:

- **State 2, loading.** The spec says "both views still loading". The loading
  box holds until both views have answered, that is while either is still on
  its first answer. The model's result line prints "Expected move unavailable.
  Distances only." for a missing expected-move row, and the component cannot
  suppress a model string, so a view that is only slow would read as
  unavailable. A view that has answered with an error or nothing degrades as
  stated under "States and layout".
- **"Priced".** The model's odds strings are unchanged ("1.37σ · touch 17% ·
  finish beyond 8%"). The word is carried by the list's column header line,
  "From spot · priced odds" (a line of its own, not a list item), and, on an
  Above or Below line, by " · priced odds" right after each short strike's
  odds. A breached strike's item prints no probability and gets none, and a
  line with only levels gets none.
- **GEXBot spot fallback.** A missing Schwab quote, or a stale one while the
  market is open, falls back to the expected-move row's spot only, as under
  "Data dependencies". With the market closed a held quote is the close and is
  used as is, however old. The levels row's spot is not a second fallback, so
  a closed-market tab with no quote and an empty expected-move view reads
  "waiting for SPX spot".
