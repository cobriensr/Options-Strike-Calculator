# Futures bar backfill from REST prints: the September 2026 gap

## Goal

Fill the hole in `futures_bars` between Databento's end and the switch to UW. Build 1-minute bars, with aggressor order flow, from UW REST trade prints, by the same rules the live websocket handler uses.

Owner approval: 2026-11-06 ("yes please" to the Sept 3–29 backfill). The approach changed from UW candles to REST prints, for the reason given below.

## The gap (prod, checked 2026-11-06)

- **All six roots** (ES, NQ, RTY, CL, GC, ZN) have **no bars at all for UTC days 2026-09-04 through 2026-09-28**.
- 09-03 and 09-29 are complete. The earlier note said only ES/NQ/CL; the query shows all six.
- The nightly `backfill-futures-gaps` cron looks back only 3 days, so it never reached this hole.

## Why REST prints, not candles

- **Candles can't reach September.** `/futures/{contract}/candles` has no date parameter. Its 1m interval returns the newest 5,000 rows, about 3.5 days, whatever the `range`; ESU6 at 1m/3m starts 09-14. The 5m interval reaches further but has the wrong resolution.
- **REST `/futures/{contract}/trades` history is complete from 2026-07-26** (spec `2026-10-28-uw-futures-orderflow-design.md`, Phase 6b results).
- **Bars built from deduped, non-spread, non-block REST prints match the live bars exactly** (probe `docs/tmp/uw-futures-run/rest-bar-probe.mjs`, 2026-11-06). Open, high, low, close, volume, buy and sell all matched:
  - ES RTH 14:30–14:40Z: 10 of 10.
  - CL overnight: 30 of 30.
  - ZN overnight: 29 of 29, after `NUMERIC(12,4)` rounding (1/64ths: 107.203125 is stored as 107.2031).
- **This is the live method**: the websocket handler also builds bars from prints, so the backfilled bars come out the same as every other bar in the table.

## Phase 1: code (one implementer task)

### 1a. OHLC in the shared REST pager: `api/_lib/futures-flow-repair.ts`

- `TradeRow` gains `price`: a decimal string, optional. A missing or invalid price must not change today's flow results.
- `FlowMinute` gains `ohlc: { open: string; high: string; low: string; close: string } | null`. These are the UW decimal strings of the minute's counted prints (non-spread, non-block, deduped):
  - `open` is the earliest print by (executed_at µs, trade_id) and `close` is the latest.
  - `high` and `low` compare numerically.
  - `null` when any counted print in that minute has a missing, non-finite or ≤ 0 price. The live handler drops such a print, so the bar can't be rebuilt exactly. That minute's flow fields are still filled as today.
- The nightly cron's flow pass ignores `ohlc`, so its behavior is unchanged.
- Tests (`api/__tests__/futures-flow-repair.test.ts`):
  - prints arriving out of order within a page and across pages;
  - a tie on executed_at, broken by trade_id;
  - spread and block prints excluded from OHLC;
  - an invalid price makes `ohlc` null while flow stays intact;
  - a print repeated across the +1 µs boundary doesn't move open or close.

### 1b. A shared bar insert: new `api/_lib/futures-bars.ts`

- Move `insertBars` out of `api/cron/backfill-futures-gaps.ts` as `insertFuturesBars(symbol, bars)`.
- A bar row is `{ ts, open, high, low, close, volume }` plus optional `buyVolume`, `sellVolume`, `buyPrints` and `sellPrints`. A missing flow field is written as NULL.
- It stays one `INSERT … SELECT FROM unnest(…) ON CONFLICT (symbol, ts) DO NOTHING RETURNING ts` per 500 rows, under `withDbRetry`.
- Prices are typed `number | string`, because the cron passes numbers and the backfill passes UW strings.
- The cron calls it with no flow fields, so its behavior is unchanged.
- Tests:
  - a PGlite test (`api/__tests__/futures-bars-pglite.test.ts`): inserts with and without flow; a conflicting row is left untouched (DO NOTHING); 4 dp rounding;
  - the existing cron tests still pass.

### 1c. The backfill script: `scripts/backfill-futures-bars.ts` with `scripts/_lib/futures-bar-backfill.ts`

- **Reuse from `scripts/_lib/futures-flow-backfill.ts`**, exported if they aren't already: `planDates`, `contractCandidates`, `UW_TRADES_HISTORY_START`, the date and roots parsing, and the market-hours guard.
- **Requires `--from` and `--to`** (or explicit dates). There is no "all history" default: every root-day in range is paged in full.
- **Per root and UTC day, oldest first, up to `UW_CONCURRENCY_CAP` root-days at once:**
  1. Read the day's existing bar minutes for the root.
  2. Page every candidate contract over the whole UTC day [00:00, 24:00), because the front-month tally runs from 00:00 UTC. Keep `MAX_PAGES_PER_CONTRACT_DAY`.
  3. Run `replayFrontMonth` over the candidates' minutes to pick each minute's leader. Back months are never written.
  4. Build the leader's bar for each minute that has no bar yet and whose `ohlc` is non-null.
  5. Flow follows the live NULL-vs-0 rule: if no print in the minute had a known side (buyPrints + sellPrints = 0), all four flow columns are NULL. Otherwise write the four counts.
  6. `insertFuturesBars`.
- **Modes:**
  - `--dry-run` writes nothing.
  - `--compare` writes nothing either. For minutes that already have a bar, it reports how many REST-built bars match the stored bar exactly, with prices rounded to 4 dp, and prints the first few diffs. That makes it the acceptance check.
- **Limits:**
  - Refuse to start during market hours, and stop between dates if they begin.
  - `--max-pages`, checked between dates.
  - A root-day failure is logged with its pages, the run continues, and the exit code is 1.
  - A per-day log line: missing minutes before, built, inserted, unbuildable (`ohlc` null or leader absent), front contracts, pages.
- **Tests** (`scripts/_lib/futures-bar-backfill.test.ts`), mocking at the module boundary:
  - only missing minutes are inserted;
  - a roll day writes only the leader;
  - an `ohlc`-null minute is skipped and counted;
  - the flow NULL rule;
  - dry run and compare write nothing;
  - compare counts matches and diffs, with 4 dp rounding;
  - a failed root-day → exit 1;
  - the market-hours refusal;
  - argument errors, including a missing range.

### Phase 1 as built (departures from the text above)

- **Flow NULL rule uses `sideSeen`, not `buyPrints + sellPrints = 0`.** The live handler sets `side_seen` on any known side, `none` included, and a bar whose only prints are `none` writes zeros. So `FlowMinute` also gains `sideSeen` (true once a counted print had side buy, sell or none), and the script writes NULL flow only when `sideSeen` is false.
- **The current UTC day is never processed.** A bar built from a minute still in progress would be locked in by DO NOTHING while the live handler is writing it. The plan's range ends 09-28, so nothing changes for the rollout.
- **A root-day with nothing to do makes no UW call**, like the flow backfill: no Globex-open minute without a stored bar (`--compare`: no stored bar at all). A re-run skips what it already filled, but a root-day with any missing Globex-open minute (a sparse overnight tape, a holiday) is paged again on every re-run.
- **An incomplete run exits 1.** A root-day that failed, or a stop before the last date (market hours began, or the page budget was spent), makes the exit code 1. The log ends with the failed root-days and a `Re-run with …` line (the failed dates, roots, `--max-pages` and mode flag; a range is re-given as `--from`/`--to`, explicit dates as dates), then `Incomplete: stopped before D. Resume with …` for the dates never reached. `runPlannedDays` returns `failed` and `stoppedBefore` for this; `runBackfill` ignores them.
- **Prints the live handler drops.** A counted print with a size of 0 or over 2^31 - 1 (`futures_trades.py` drops it before its dedup, tally, OHLC and side) makes its minute's `ohlc` null, like an invalid price. The flow numbers are unchanged, so the nightly flow pass is too.
- **`prints 0`** ends a root-day's line when no candidate contract returned a counted print all day (a hole in UW's history, a holiday, a wrong candidate list).
- **`insertFuturesBars(symbol: string, bars)`** takes any symbol string. A reader, `fetchFuturesBars(symbol, startIso, endIso)`, sits beside it in `api/_lib/futures-bars.ts` for the script's step 1.
- **Shared with the flow backfill, exported from `scripts/_lib/futures-flow-backfill.ts`:** `parseArgs(argv, usage)`, `pageDayContracts`, `runPlannedDays` (the date loop with the market-hours and page-budget stops), `refuseDuringMarketHours`, `RootDayError`, `DAY_MS`, `MINUTE_MS`. `runBackfill` now uses them; its behavior and tests are unchanged.
- **CLI:** `npx tsx scripts/backfill-futures-bars.ts (--from D --to D | D ...) [--roots ES,NQ,...] [--max-pages N] [--dry-run | --compare]`.
- **`--compare` output** per root-day: stored, compared, matched, differ, stored-only (a stored bar no print rebuilds), rest-only (a rebuildable minute with no stored bar), malformed, pages; then the first 3 differing minutes with field, REST value (4 dp) and stored value; then per root `matched M of S stored (P%)  compared C  stored-only O  rest-only R`, where S = C + O. A stored bar no print rebuilds is a leader or roll disagreement, so it counts against the root.
- **Malformed prints** withhold their minute (as in the flow pass), which can leave the leader absent for it; each day's line shows the `malformed` count.

## Phase 2: rollout (main session)

1. Run the gate, review, commit and push. `api/_lib` triggers a Vercel deploy; nothing deploys on Railway.
2. Run `--compare` on 2026-10-30 for all six roots, a day of full live bars. Acceptance: ≥ 99% exact per root, on the per-root line `matched M of S stored`. Any systematic diff (not a µs tie) stops the rollout.
3. Run `--dry-run --from 2026-09-04 --to 2026-09-28 --max-pages 60000`.
4. The real run, in the background: `--from 2026-09-04 --to 2026-09-28 --max-pages 60000`. The default budget of 20,000 pages stops short of the range and exits 1. Estimate: about 20–35k pages, 1–2 h at the 10-29 rate.
5. Verify:
   - each root's bars per day against its neighbours (ES about 1,380 on a full weekday);
   - buy + sell ≤ volume;
   - the ESU6 → ESZ6 roll week (about 09-11 to 09-18) shows no carry-basis jump.
6. Record the results in this doc and the orderflow spec, and update memory.

## Data dependencies

- No migration, no env var, no new table. It reads `DATABASE_URL`, `UW_API_KEY` and `KV_REST_API_*` from `.env.local`, like `backfill-futures-flow.ts`.

## Constants

- Range: UTC days 2026-09-04 → 2026-09-28 inclusive, roots ES, NQ, RTY, CL, GC, ZN.
- REST history usable from 2026-07-26.
- Stored price precision: `NUMERIC(12,4)`.
- `MAX_PAGES_PER_CONTRACT_DAY` 5,000. Concurrency: `UW_CONCURRENCY_CAP` (3).

## Open questions (defaults taken)

- **All six roots, not three:** yes, because all six are missing.
- **A tie on executed_at µs:** order by trade_id. Live timestamps are epoch milliseconds, and among prints sharing a millisecond the first arrival is the open and the last arrival the close. REST is microseconds, ties by trade_id. The two orders can pick different prints, and those prints need not share a price. `--compare` is the arbiter of how often that happens.
