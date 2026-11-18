# Server-built market snapshots: design

Date: 2026-11-17. Status: draft for owner approval.

## Intent

`market_snapshots` holds one row per 5-minute slot of a session: 78 slots,
8:30 AM to 2:55 PM CT. Today only the owner's browser writes rows. The page
computes every field and posts it to `/api/snapshot`. A slot is lost
whenever the page can't save it:

- the tab is closed or the PC is asleep;
- the network drops;
- the server refuses a stale quote. Freshness enforcement since 1be18f62 did
  this on 2026-11-17 at the 8:30 CT slot.

Gaps are found only when someone happens to look. They are filled by a
Playwright replay of the page on the owner's PC
(`docs/tmp/snapshot-repair/replay-driver.mjs`), and every run needs the
owner's OK.

Known gaps today:

- 2026-11-16: 12:40, 2:00 and 2:10 PM CT.
- 2026-11-17: 8:30 AM CT.

The goal is for the server to build a row for any slot from Schwab 5-minute
candles, using the same code the page uses. An after-session step then fills
empty slots without anyone asking.

## Owner decisions (2026-11-17)

1. **Server builds the rows.** This is option 3 of three. The two rejected:
   - A nightly detector that leaves filling to a manual replay. Gaps get
     found, but filling still waits for a person.
   - A scheduled replay on the owner's PC. A desktop becomes part of
     production, and the replay fails silently when the PC sleeps.
2. **Fix the two data issues first, then build the fill.** The issues are
   G1 and G2 below. G1b was found later and joins G1.
3. **VIX1D for afternoon slots: option C.** Score rules that don't use the
   close against the genuine live readings, then pick the best. Keep the
   midpoint until that test is done. **Decided 2026-11-18:** the owner chose
   rule 10 with a ramp of +36%, at every slot, morning included. See "The
   VIX1D afternoon rule" below.

## Goals

- **G1. Live rows store the SPX open, high, low, previous close and
  overnight gap.**
  - Today these columns are NULL on every live row (`is_backtest = false`).
  - Cause: `useRangeAnalysis.ts` (~line 191) fills them only from
    `historySnapshot`, and that is null on a live save.
  - Confirmed on prod for live rows since 2026-11-02 (n=272). Backtest rows
    have all five.
- **G1b. `prev_close` and `overnight_gap` hold the right day on backtest
  rows.** Found in the 2026-11-17 review and checked on prod (read-only).
  - `api/history.ts` asks Schwab for 5-minute candles from 7 days before the
    target to 2 days after, with `needPreviousClose=true`. Schwab's
    `previousClose` is the close before the start of that range, so it is a
    week early, not the target's previous session.
  - Examples. The "should be" column is the previous session's
    `outcomes.settlement`:

    | Date | Stored `prev_close` | Should be | Stored gap | True gap |
    |---|---|---|---|---|
    | 11-06 | 7720.39 | 7356.73 | −4.44% | about +0.28% |
    | 11-16 | 7376.86 | 7560.87 | +1.86% | about −0.62% |
    | 09-15 | 7718.60 | 7620.37 | −1.38% | about −0.11% |

  - The page's backtest view shows the same wrong values
    (`BacktestDiag`, `useRangeAnalysis`).
  - The daily features are unaffected: `build-features` doesn't read these
    columns, and its gap feature is `es_overnight_gap` from futures.
  - The Redis history cache (`history:v3:<date>`, 90-day TTL) holds the
    wrong value too, so the fix must repair it on read or change the cache
    key.
  - **Definition:** `prev_close` is the official close of the previous
    session. For live rows it is the quote's `prevClose`. For backtest and
    server rows it comes from a target-relative source. Acceptance: it
    equals that session's `outcomes.settlement` within 0.05. Decision 15
    covers a missing prior session and the VIX family.
- **G2. No look-ahead.** A row labelled with slot T holds only data known at
  T. This covers the page's backtest mode and server-built rows.
- **G3. One implementation of the row math.** The page and the server call
  the same pure functions in `src/`, so the two can't drift apart.
- **G4. Fill empty slots automatically.** A daily step fills every empty slot
  of recent sessions. It only inserts, then rebuilds `training_features` for
  each date it filled.
- **G5. Backfill history.** Under the owner's always-backfill rule:
  - rebuild existing backtest rows under the G2 rule;
  - fill the G1 columns on existing live rows;
  - fill the four known empty slots.

## Why G1 must land before G4

`build-features` (`api/cron/build-features.ts:141`, `pickFeatureSnapshot`)
samples the row nearest 10:00 AM CT, but only among rows with a non-NULL
`spx_open`.

- A day with only live rows has no row with `spx_open`. The picker falls back
  to the nearest-10:00 row overall, so today's features come from the live
  10:00 row.
- Once a filled backtest row lands on a live day, it is the only row with
  `spx_open`, so the picker would take it. Example: 2026-11-16's features
  would come from the filled 12:40 PM row instead of the live 10:00 row.

G1 removes the trap. It also covers its backfill of existing live rows. Until
G1 lands, no fill or feature rebuild may run on a day with live rows.

## Why G2: the look-ahead today

The page's backtest path is `src/hooks/useHistoryData.ts`.

- `findCandleAtTime` (:211) picks the last candle whose start minute is at or
  before the slot. Schwab 5-minute candles are labelled by their start: the
  first one is 9:30 ET. `getStateAtTime` (:391) then takes that candle's
  close, so the 8:30 CT row holds the 8:35 price.
- `computeRunningOHLC` (:250) includes that bar's high and low.
- `getSymbolPriceAtTime` (:236) does the same for VIX, VIX1D, VIX9D and VVIX.
- `computeOpeningRange` (:313) always spans the first 6 candles, whatever the
  slot. Every row before 9:00 CT therefore carries the full 30-minute range.

About 3,800 rows were rebuilt by the PC replay. They, and every backtest row
saved from the page, carry this look-ahead. Live rows don't, because a live
save reads the quote at the time.

## Non-goals

- The server writing every slot during the session, which would replace the
  page's live saves. This design makes it possible but doesn't do it.
- Changing live saves beyond G1. Freshness enforcement stays.
- Changing calculator math, thresholds, strikes, regime rules or the analyze
  prompt.
- Retraining or recomputing any model. The ML pipeline is disabled, and
  Take-It doesn't read snapshots.

## Anti-goals: failure even if it "works"

- A fill that overwrites any existing row, live or backtest. Background: on
  2026-11-14 a stale tab silently overwrote repaired backtest rows, because a
  backtest upsert replaces a backtest row (`api/_lib/db-snapshots.ts:236`).
- A server row that differs from what the page computes from the same inputs.
  That would mean two implementations.
- A fill that silently changes which row feeds `training_features` (see the
  G1 section).

## Approaches considered

How the server gets the row math:

| Approach | Trade-off | Verdict |
|---|---|---|
| A. Port the math into `api/_lib` | Quick, but two copies drift | Rejected (anti-goal 2) |
| B. Move the math out of the hooks into pure `src/utils` functions that the hooks and the server both call | More refactoring, but one copy; the page's tests keep guarding it | **Chosen (my call)** |
| C. Run the page's React code headless on the server (jsdom) | Reuses everything as is, but heavy, slow and fragile in a Vercel Function | Rejected |

## Calls I made (the owner can correct these)

1. **As-of rule (G2).** A row at slot T uses only bars that end at or before
   T.
   - Spot is the close of the bar ending at T, which is the bar starting at
     T−5.
   - At 8:30 CT no bar has ended, so spot is the first bar's open.
   - The running high and low cover the bars ended by T. At 8:30 the open,
     high, low and last are all the first bar's open.
   - VIX, VIX1D, VIX9D and VVIX follow the same rule on their own candles.
   - The opening range covers the bars ended by T: partial before 9:00 CT,
     as live `/api/intraday` reports it. `openingRangeAvailable` keeps its
     current rule.
   - Why: it matches what a live save at T can see.
2. **G1 source for live rows.** The SPX quote's `open`, `high`, `low` and
   `prevClose` (`QuoteSlice`, `src/types/api.ts:6`), each used only when > 0.
   The overnight gap is computed as today.
   - The 8:30 stale-quote case is already refused by freshness enforcement.
3. **Yesterday's OHLC for server rows** comes from the 5-minute-derived
   `previousDay`, as backtest mode does today, not from `/api/yesterday`.
   - The official close and the last 5-minute close can differ slightly, so
     cluster, RV/IV and cluster-tilt values can differ a little from a live
     row at the same slot. This is documented, not fixed.
4. **RV** is the single-day Parkinson estimate, as backtest mode and the page
   use today. The page never passes `livePriorDays`.
5. **Settings** are the page defaults, which a server build must assume.
   Prod shows `skew_pct = 3.00` on every row since October.
   - skew 3%;
   - multiplier 1.15;
   - IV mode DIRECT when VIX1D exists, else VIX × 1.15.
6. **VIX1D.** Use the intraday candle when Schwab has one. That is rare: of
   11-06, 11-09, 11-10 and 11-11, only 11-11 had any. Otherwise use the CBOE
   daily map.
   - From the daily map, every slot uses rule 10 (decided 2026-11-18, below):
     the daily open scaled by the VIX move since the open and a +36% ramp
     over the session. It replaces both the morning open and the afternoon
     open/close midpoint, which used the day's close, not known at T.
   - The daily map (`refresh-vix1d`, 11:00 UTC Mon–Fri) lacks a session until
     the next weekday morning, so **the fill runs the next weekday morning**,
     not the same evening.
7. **Schedule.** One new cron, `fill-snapshot-gaps`, Mon–Fri at about
   11:20 UTC.
   - It runs after `refresh-vix1d` and well before the 13:30 UTC open.
   - Friday's session is filled on Monday morning, the first run that has
     Friday's VIX1D.
   - Why not reuse an existing cron: none runs in that window except
     `refresh-vix1d`, and folding the fill into it would couple two failure
     domains.
8. **Fill window and missing inputs.** The last 5 sessions, so a missed run
   heals itself the next morning.
   - Insert-only makes every written value permanent, so the fill **defers
     rather than falls back**.
   - A date is skipped, and retried by the next run, when any of these is
     missing or short:
     - the SPX or VIX candles (fewer than the session's slot count);
     - VIX1D (no intraday candle and no daily-map entry);
     - the event lookup (it reports itself incomplete).
   - A missing VIX9D or VVIX bar is not a deferral. It is stored the way the
     page stores it today: the last bar at or before T, else NULL.
   - A date that leaves the 5-session window still deferred raises one Sentry
     warning naming the date and the missing input.
9. **Insert-only.**
   - A new DB function inserts a row only when no row exists for that slot.
   - Slots are compared by clock minute via `parseEntryTimeMinutes`
     (`src/utils/entry-time.ts:21`), because "8:30 AM CT" and "9:30 AM ET"
     are the same slot under two labels.
   - It uses `ON CONFLICT (date, entry_time) DO NOTHING` as the last guard.
   - New rows are labelled `h:mm AM/PM CT`, are `is_backtest = true`, and are
     inserted in ascending slot order.
10. **Event flags** come from the server lookup `/api/snapshot` already uses
    (`resolveEventFlags`, `api/snapshot.ts:96`), exported for reuse.
11. **The tonight PC replay of the four empty slots is dropped.** The builder
    fills them under the G2 rule in phase 6. A replay now would write rows
    that carry the look-ahead and would need rebuilding anyway.
12. **Early-close days.** Slots run to the last 5-minute slot before the
    close (`getEarlyCloseHourET`), never to a fixed 2:55 PM.
13. **The server becomes the only writer of backtest rows,** starting with
    phase 5.
    - `/api/snapshot` refuses `isBacktest` saves with a 200
      `{ saved: false, skipped: 'server-owned' }`, and the page stops sending
      them.
    - Why: today any backtest save replaces a backtest row
      (`db-snapshots.ts:236`). A tab still on an old bundle could overwrite
      as-of rows with look-ahead rows, the same class as the 2026-11-14
      incident. A server-side refusal covers stale bundles too, and needs no
      migration.
    - Viewing past dates in the page is unchanged; only the side-effect save
      stops.
    - `analyze.ts:406` links an analysis to the snapshot at its date and time.
      For past sessions within Schwab's depth, the server's rows keep that
      link working.
14. **What the history rebuild touches (phase 6).** Only rows known to come
    from the candle path:
    - every row the PC replay wrote, per the replay logs in
      `docs/tmp/snapshot-repair/` (`replay-log*.jsonl`);
    - backtest rows saved after the flag fix of 2026-10-28.
    - Rows saved before 2026-10-28 that aren't in the replay logs are left
      alone. Their flag is inverted (`docs/superpowers/specs/past-date-replay-integrity-2026-10-27.md:110`),
      and some are genuine live captures with no look-ahead.
    - The roughly 22 unreplayable dates in that spec stay out. The owner's
      decision on them is separate and still open.
    - A date whose Schwab candles are short (fewer than its slot count) is
      skipped and reported, never half-rebuilt.
    - The rebuild uses the page default skew (3%), as the replays did.
15. **`prev_close` source (G1b).**
    - Live rows: the quote's `prevClose`.
    - Backtest and server rows: a target-relative Schwab value.
    - The builder picks the mechanism, for example a request that starts at
      the target session, or the previous session's last 5-minute close
      checked against `outcomes.settlement`. The acceptance rule in G1b holds
      either way.
    - Chosen for phase 1: `/api/history` serves each symbol's `previousClose`
      as the previous session's last 5-minute close (`previousDay.close`).
    - **A hole in the previous session serves 0, not an older close.**
      - Only the target's prior trading day (`priorTradingDay` in
        `src/data/marketHours.ts`) counts as the previous session.
      - If Schwab's window lacks that day but returns an earlier one,
        `previousDay` is the older session, and `previousClose` is 0.
        Without the rule the older close would pass as yesterday's.
      - The endpoint logs one warning per such symbol. The cache-read repair
        applies the same rule, with the request's date as the target.
      - A target with no candles of its own also serves 0.
      - A weekend or holiday between the two is not a hole: Monday's prior
        trading day is the previous Friday, and the Tuesday after a Monday
        holiday looks back to the Friday before it.
    - **VIX family.** The previous close of `$VIX`, `$VIX1D`, `$VIX9D` and
      `$VVIX` is the close of the last regular-hours 5-minute bar (15:55 ET,
      or 12:55 ET on an early-close day).
      The official VIX close prints at 16:15 ET, so don't reconcile a VIX
      previous close against an official VIX settlement. The SPX acceptance
      against `outcomes.settlement` stands.

## Phases

Each phase is independently shippable. Every phase that touches `api/` or
`src/` redeploys Vercel, so on weekdays it is pushed after the 3:00 PM CT
close.

1. **Right price context on every row (G1, G1b).** Small to medium.
   - `src/hooks/useRangeAnalysis.ts` fills `spxOpen`, `spxHigh`, `spxLow`
     and `prevClose` from the live SPX quote when there is no history
     snapshot. The quote must reach the hook; check whether
     `useComputedSignals` already passes it.
   - `api/history.ts` returns the target session's previous close, not
     Schwab's range-start value. Cached responses are repaired on read or the
     cache key changes.
   - Tests come first, including the 11-06 and 11-16 cases from G1b.
   - Backfill under the as-of rule:
     - the NULL columns on existing live rows;
     - `prev_close` and `overnight_gap` on existing backtest rows.
   - The backfill is a script with a dry run, a backup, hand-checked rows and
     an owner OK on `--apply`.
2. **Shared slot state with the as-of rule (G2).** Medium.
   - Move `findCandleAtTime`, `computeRunningOHLC`, `computeOpeningRange`,
     `getSymbolPriceAtTime` and the `getStateAtTime` assembly into a pure
     `src/utils/snapshot-slot.ts` that applies the as-of rule.
   - `useHistoryData` calls it.
   - Table tests at 8:30, 8:35, 8:55, 9:00, 9:05 and 2:55 PM CT, plus an
     early-close day, plus a property test: no candle that ends after T
     affects a field.
   - This changes the page's backtest values, by owner decision.
3. **Pull the rest of the row math out of the hooks (G3).** Medium-large;
   likely 2–3 sub-phases of 5 files or fewer each. Each function moves into
   `src/utils` as pure code, and the hooks become thin wrappers with zero
   behaviour change:
   - `computeMarketTime` and sigma (`useCalculation.ts`);
   - the regime classification body (`useRegimeClassification.ts`);
   - the term-structure classifiers (`useTermStructure.ts`);
   - the range analysis body (`useRangeAnalysis.ts`);
   - the VIX1D daily-map rule (`useVix1dData.ts`);
   - `sigmaSource` (`useComputedSignals.ts`);
   - the strikes flatten and payload assembly (`useSnapshotSave.ts`);
   - the slot label.

   Existing hook tests and the parity harness
   `src/__tests__/hooks/liveSessionSave.test.ts` must stay green. Each moved
   file joins `API_COMPILED_SRC` (`eslint.config.ts`), with `.js` import
   extensions.
4. **Server row builder (G3).** Medium.
   - Extract the Schwab 5-minute fetch from `api/history.ts`
     (`fetchSymbolHistory`, :281) into `api/_lib/schwab-history.ts`.
     `history.ts` calls it, and its cache and dedupe behaviour is unchanged.
   - `api/_lib/snapshot-builder.ts` builds `buildSnapshotRow(date, slot)`
     from the candles using the phase 2–3 functions.
   - **Parity test:** for fixture days, the builder's row equals the page
     path's row field for field, across all 78 slots.
5. **Fill cron (G4).** Medium.
   - `api/cron/fill-snapshot-gaps.ts` covers the last 5 sessions.
   - It only inserts, then rebuilds `training_features` for each date it
     filled.
   - It needs:
     - a `SCHEDULE_MAP` entry and `withCronInstrumentation`;
     - Axiom counts in `meta`;
     - a Sentry warning when Schwab returns fewer candles than the session
       needs;
     - a cron that reports failure when a write fails.
   - It must not run on a date where G1's backfill hasn't run.
6. **History rebuild (G5).** Small code, long run, owner OK on the run.
   - A script uses the builder to rebuild every backtest row under the G2
     rule. It overwrites only `is_backtest = true` rows and keeps their ids.
   - It also fills the four known empty slots, then rebuilds
     `training_features` for the affected dates.
   - Steps: backup, dry-run diff, hand recompute of 1–2 rows, then
     `--apply`.

## Data dependencies

- **No new tables or migrations expected.** The insert-only path is a query,
  not a schema change. If the builder finds a column it needs, that is a
  numbered migration with owner OK.
- **No new env vars.**
- **Schwab `/pricehistory` 5-minute candles.**
  - Symbols: `$SPX`, `$VIX`, `$VIX1D`, `$VIX9D`, `$VVIX`.
  - Depth: back to at least 2026-03-25, checked 2026-11-07.
  - The cron uses the owner's Schwab tokens in Upstash, as `/api/history`
    does.
- **CBOE VIX1D daily map:** Redis `vix1d:daily-map` with an 8-day TTL, plus
  `public/vix1d-daily.json` for older dates.
- **Licensing.** All inputs are Schwab or CBOE, so they are public-OK. No
  Unusual Whales or GEXBot data is used.

## Readers to keep in mind

- **`check-live-snapshots`** counts only `is_backtest = false`. Fills are
  backtest rows and don't mask a live stall.
- **Readers that take the newest row by `created_at` within a date:**
  `api/futures/snapshot.ts:129`, `api/positions.ts:150` and
  `api/pre-market.ts:55,100`. All filter by date. After a fill, the "newest"
  row of a past date is the last filled slot, not 2:55 PM. Today's rows are
  unaffected, because fills only touch past sessions. Acceptable; noted so
  nobody is surprised.
- **Foreign keys to snapshot ids** (`analyses`, `positions`,
  `dark_pool_snapshots`): the history rebuild keeps ids by updating in place.

## Thresholds and constants

- Slots: 78 per full session, 8:30 AM–2:55 PM CT, every 5 minutes.
- Fill cron: about 11:20 UTC, Mon–Fri. Window: the last 5 sessions. Budget
  about 240 s inside a 300 s `maxDuration`.
- Acceptance tolerances, taken from the replay's verify scripts:

| Field | Rule | Tolerance |
|---|---|---|
| spx | whole point | 1 |
| spy | spx / 10 | 0.005 |
| vix | candle close | 0.01 |
| vix1d | intraday candle or daily-map rule | 0.005 |
| sigma | vix1d / 100 | 0.00005 |
| cluster_mult | `getClusterMultiplier` rule | 0.00005 |
| hoursRemaining | from the slot time | 0.001 |

## The VIX1D afternoon rule (decided 2026-11-17: option C)

The test must finish before phase 3 moves the VIX1D rule into shared code,
so that move carries the chosen rule. It uses the `vix1d-rules.mjs` method
from 11-08.

- **The rule today:** after noon ET, a past slot's VIX1D is the midpoint of
  the day's open and close. The owner approved it on 2026-11-08 because it
  scored closest to genuine live readings, using `vix1d-rules.mjs`. But it
  uses the close, which isn't known at T.
- **Morning slots, before the decision:** before noon ET a past slot uses
  the open. The decided rule below changes them too, including the 10:00 CT
  row the daily features read.
- Example, 2026-11-16 at 1:00 PM CT:

  | Rule | VIX1D |
  |---|---|
  | Live reading | 18.85 |
  | Midpoint | about 17.9, known only because the day closed at 19.78 |
  | Open all day | about 16.0 |

- Options:
  - **A.** Keep the midpoint as the one documented exception to G2.
  - **B.** Use the open all day.
  - **C.** Score rules that don't use the close against the live readings,
    as on 11-08, then pick the best. Keep A until then.

### Decision (owner, 2026-11-18): rule 10, ramp +36%, every slot

```
vix1d(slot) = daily_open × (VIX_t / VIX_open)^2 × (1 + 0.36 × min_since_open / 390)
```

- `daily_open` is the CBOE VIX1D open from the daily map. It matched the
  first 5-minute bar's open on all 59 days compared, so it is known at 9:30
  ET.
- `VIX_open` is the open of the 9:30 ET `$VIX` bar. `VIX_t` is the close of
  the last `$VIX` bar that has ended by the slot (start + 5 ≤ slot, the G2
  as-of rule). `min_since_open` is minutes from 9:30 ET to the slot.
- At 8:30 CT (9:30 ET) the rule equals the open.
- No `$VIX` bars for the date: the open, all day.
- An intraday `$VIX1D` candle still wins when Schwab has one (rule 6).
- It applies to every slot, morning included. At 10:00 CT, over 59 days of
  the real VIX1D tape, the average miss is 0.71 against 1.24 for the open.
  At 1:00 PM CT the median miss is 0.69, against 0.80 for the midpoint and
  0.99 for a +25% ramp.
- Why +36% and not +25%: +36% is the fit to the true tape (all-slot MAE
  1.01 vs 1.11). The +25% and +16% fits lean on older live readings, which
  read low against the tape.
- Why not "after noon only": it keeps the weaker estimate in the 10:00 CT
  row, and puts a false step of about 14% into the data at noon ET, where
  one rule hands over to the other.
- Untested, and a default until checked: early-close days keep the
  390-minute denominator, and there is no cap on the VIX ratio (the largest
  seen was 1.47, on 11-05).
- It changes stored rows only where a row is rebuilt (phase 6, with the
  owner's OK on the run). Genuine live readings are never overwritten.
- Evidence: `docs/tmp/vix1d-rules-2026-11-17/report.md` (gitignored, in the
  main checkout), with its tables and the scripts to re-run it.

## Left to the builder

- File and function names inside each phase.
- How the live SPX quote reaches `useRangeAnalysis` (G1).
- Batching inside the history rebuild script: about 500 rows per statement
  (R5).
- The exact Sentry and Axiom field names, within the Axiom allowlist rules.
