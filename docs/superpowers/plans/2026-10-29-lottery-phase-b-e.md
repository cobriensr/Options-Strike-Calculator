---
status: Plan
date: 2026-10-29
---

# Lottery detector phases B and E: cheap runs, then a replay library to recover lost fires

Parent spec: `docs/superpowers/specs/lottery-cron-timeouts-2026-10-28.md` (phases B and E). The replay is also phase 5 of `docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md`. Designed 2026-10-29 from origin/main 55969717. Nothing here has been run against Neon yet.

## Goal

Make `api/cron/detect-lottery-fires.ts` do no per-fire database round trips, then turn its core into a library that both the cron and a tape replay call. The replay recovers the fires lost to timeouts (10-16 → 10-28) and to the summer outage (07-22 → 09-04).

## Findings that shape the design

1. **`fetchTickerFlowSeries` probably repeats the greek-heatmap planner problem.** Its WHERE is `ticker = X AND ts range` on `ws_net_flow_per_ticker`. Phase F found the planner choosing the `(ts)` index for exactly that shape, which reads every ticker's rows for the day (about 670K by mid-afternoon). It runs once per ticker-day per run and returns that ticker's whole day every minute. Check with `EXPLAIN (ANALYZE, BUFFERS)` around 14:00 CT before B2.3; B2.3 forces a per-ticker index scan.
2. **The old strike lookup is not deterministic when two strikes tie, and SPX has three expiries per (timestamp, strike).** SPX `strike_exposures` holds 0DTE and 1DTE rows from `fetch-strike-exposure` plus the `1970-01-01` sentinel from `fetch-strike-all`. The per-fire query has no expiry filter and orders only by `timestamp DESC, ABS(strike - X)`. Live, only SPY and QQQ fires can match during the session (SPXW and NDXP have no intraday rows); those have one expiry, so the only real tie is two strikes equally far away.
3. **Replays of past days see rows the live run never saw.**
   - The rollup (`rollup-ws-gex-strike-expiry`, 22:30 UTC) adds per-minute SPXW, SPY and QQQ rows with `created_at` set to the rollup time.
   - `fetch-net-flow-history` (21:25 UTC) adds REST minute rows to `net_flow_per_ticker_history`. Their timestamps never equal the WS per-tick ones, so `DISTINCT ON (ts)` keeps both, and a past day's cumulative flow roughly doubles.
   - Every source table has an ingest timestamp: `flow_data.created_at`, `spot_exposures.created_at`, `strike_exposures.created_at`, `ws_net_flow_per_ticker.received_at`, `net_flow_per_ticker_history.fetched_at`, `gexbot_snapshots.captured_at` (defaults to now()). The replay needs a "known at" filter (B5, item 2).
4. **Range_pos candle fetches are a serial cost the parent spec doesn't list.** One UW call per ticker-day per run, run one at a time through the shared 3-slot semaphore, each with a 5 s deadline. It's per ticker rather than per fire, but on a busy minute it is the largest serial cost left after B.
5. **Retention.**
   - Kept forever: `flow_data`, `spot_exposures`, `strike_exposures`, `ws_net_flow_per_ticker`, `net_flow_per_ticker_history`. A replay can read these from Neon.
   - `ws_option_trades`: 2 days.
   - `gexbot_snapshots`: about 1 day in Neon; the Blob archive holds `gexbot/gexbot_snapshots/{date}.parquet`. Archive (21:30 UTC) and cleanup (12:15 UTC next day) overlap, so for about 15 h both hold the same day.
6. **The Full Tape `id` is the WS `ws_trade_id` UUID** (see `reload-ws-option-trades-from-fulltape.py`), so recovered rows can fill `anchor_ws_trade_id`.
7. **R3 rules out a data-source interface with one implementation.** It must be born with both implementations, cron and replay, in the same push. That push is B5.
8. **`TakeitContextDeps`** is existing precedent for a production seam the cron implements.
9. **Recovered old-day rows are safe from the outcome enrich**, which reads only the last 2 days.
10. **The 05-20 replay corruption** came from a missing cooldown seed (about 80% drifted duplicates). Those scripts also walked 13:30–20:30 UTC instead of the cron's gate. The new driver builds its minute schedule from `getMarketCloseHourET` (09:25 ET to the close plus 5 min, early closes included). `isMarketHours()` reads the wall clock, so it can't drive simulated time.

## New run shape (end of B3)

```text
[ tick scan (time slices) ∥ Take-It prefetch ∥ cooldown seeds ]   one parallel setup
 → detect + enrich every chain (CPU)
 → [ flow-at-fires ∥ macro window ∥ GEXBot window ∥ (anchor legs, classifier phase 4) ]   one parallel context batch, 5 s deadline, fail-open
 → score, cluster bonus, direction gate, Take-It, build rows (CPU)
 → one unnest INSERT per ≤500 rows, ON CONFLICT DO NOTHING RETURNING id
 → candles per ticker-day → one batched UPDATE of range_pos
 → feed-tier monitor
```

- No per-fire round trips remain.
- "Insert first, then enrich" is resolved this way: the DB lookups run before the insert, bounded and in parallel, because Take-It and `direction_gated` need macro. Only the UW candle step (range_pos, display-only) runs after the insert.
- Rejected: inserting bare rows, then UPDATE-ing every enrichment column. The parent spec already names about 8 updates per insert as this table's bloat source, and `takeit_prob` / `takeit_features` are indexed or in partial-index predicates, so those updates can't be HOT.

## Phases

Order, one implementer stream at a time: B0 → B1 → B2 → B3 → B5 → E0 → E1 → E2 → E3/E4. B4 after B3 has run a week; E5 last. Each implementer loads `backend-development`, `postgres-pro`, `test-master` and `performance-optimizer`, works in a worktree off origin/main, uses TDD, `npm run review` and the code-reviewer loop. Every commit is ≤5 files; B5 and E1 are reviewed as whole phases before their push. Every performance phase reports before-and-after `timingsMs` from Axiom `meta`, measured the same way.

### B0. Measure, and decouple the tests from query order (no behavior change; M)

- **B0.1** (`api/cron/detect-lottery-fires.ts`, its test): add `timingsMs: { tickScan, seeds, takeitPrefetch, pass1Flow, pass2, insert, candles, tierMonitor, total }` to `metadata`, so it lands in Axiom `meta` (no new top-level keys). Collect one full session as the baseline before B1 ships. This takes over the setup-timings item from phase D.
- **B0.2** (new `api/__tests__/helpers/sql-router.ts`, the cron test): route `mockSql` on distinctive SQL text (`FROM ws_option_trades`, `FROM lottery_finder_fires … MAX(trigger_time_ct)`, `FROM flow_data`, `INSERT INTO lottery_finder_fires`, …). Unmatched SQL throws, and the router records which routes ran. Convert all 53 tests (203 ordered `mockResolvedValueOnce` calls); without this every B phase rewrites most tests.
- **Risk:** the router hides an unexpected extra query. Unmatched SQL throws, and tests assert the routes that ran.
- **Verify in prod:** deploy, then read `parse_json(meta).timingsMs` p50/p90 per hour for a session.

### B1. Tick scan in time slices, clock anchored, setup in parallel (M)

- **Files:** new `api/_lib/lottery-tick-scan.ts` (`scanLotteryTicks(db, scanEnd)`, the `TickRow` → `OptionTradeTick` normalisation and chain grouping, moved out of the cron); the cron; new `api/__tests__/lottery-tick-scan.test.ts`; new `api/__tests__/lottery-tick-scan-pglite.test.ts`; the cron test.
- **Clock:** capture `scanEnd = new Date()` once. Every `NOW()` becomes `${scanEnd}`: the tick window, the seed lookback, both Take-It lookbacks. The replay needs this parameter, and the run becomes internally consistent.
- **Slices:** 7 one-minute slices `[scanEnd−7m+i, scanEnd−7m+i+1)`, the last without an upper bound as today. Each slice: `WHERE executed_at >= $a AND executed_at < $b AND canceled = FALSE AND price > 0 ORDER BY executed_at, id`, same columns as today (gamma from `raw_payload`), on `ws_option_trades_executed_idx (executed_at)`. Group in JS, appending slices in time order so each chain's ticks stay sorted; the `id` tie-break makes same-millisecond order deterministic. Each row is read once per run instead of three times.
- **64 MB response cap:** volume at the open isn't uniform. If a slice fails with Neon's response-size error, split it in half and retry, at most 3 levels deep, then error. One-minute slices keep the worst slice at about a quarter of the old 3-way hash split at the open.
- **Seeds, now parallel with the scan:** `SELECT option_chain_id, EXTRACT(EPOCH FROM MAX(trigger_time_ct))*1000 AS last_ms FROM lottery_finder_fires WHERE date >= $today::date - 1 AND trigger_time_ct >= $scanEnd - 10 min GROUP BY 1` on `lottery_finder_fires_date_ts_idx`. Filter to eligible chains in JS, so `priorSeeds` keeps its meaning.
- **Take-It prefetch** starts in parallel with the scan, unchanged apart from the anchored clock.
- **Tests:**
  - Unit: slice bounds, the open last slice, merge order, bisection on a size error, a rejecting slice → run `error` and a Sentry capture (R4).
  - PGlite property test: random rows, including edge rows exactly at slice bounds and at scanStart, canceled rows and price-0 rows. Oracle: the old 3-way hash query with `NOW()` replaced by the anchor. The multisets must be equal.
- **Risk:** slice-edge drops or duplicates (property test); a size spike (bisection).
- **Verify in prod:** `timingsMs.tickScan` against the B0 baseline; the `scanned` distribution per hour against the prior 3 days; fires per hour against prior days; no new `db attempt timeout` events from this cron.

### B2. Batched lookups as modules, proven equal, not yet wired (M–L)

**Shared rules:**

- Compare times in integer microseconds: select `(extract(epoch from ts)*1e6)::bigint AS ts_us`. Epoch microseconds fit exactly in a Number; fire times are milliseconds × 1000.
- Do NUMERIC arithmetic in SQL as the old queries did, then `Number()`.
- Compare strikes in integer thousandths: `100·|a−b| ≤ b`, exact at the ±1% edge.

**B2.1, macro window.** Files: new `api/_lib/lottery-macro-context.ts`, its test, its PGlite test.

- `fetchMacroWindow(db, { from, to, strikeTickers })` runs three queries in parallel over [min trigger − 30 min, max trigger]:
  1. `SELECT source, ts_us, ncp, npp FROM flow_data WHERE timestamp >= $from AND timestamp <= $to AND source IN (6 sources) ORDER BY source, timestamp` on `idx_flow_data_timestamp` (same path as the old query).
  2. `SELECT ts_us, gamma_oi, gamma_vol, charm_oi, vanna_oi FROM spot_exposures WHERE ticker='SPX' AND timestamp BETWEEN …`. Pre-check on prod: `count(*) WHERE date <> (timestamp AT TIME ZONE 'America/New_York')::date`. If 0, add `date = ANY($etDates)` to use `idx_spot_exposures_date_ticker`; otherwise keep the old predicate.
  3. `SELECT ticker, ts_us, strike, expiry, (call_gamma_oi - put_gamma_oi) AS call_minus_put, (call_gamma_ask - call_gamma_bid) …, (put_gamma_ask - put_gamma_bid) … FROM strike_exposures WHERE ticker = ANY($t) AND timestamp BETWEEN …`, with `$t` = fire tickers ∩ `TICKERS_WITH_GEX_STRIKE`, on `idx_strike_exp_timestamp` (or `(date, ticker)` with a date filter after the same pre-check).
- Pure `macroSnapshotAt(window, { ticker, strike, asOf }) → MacroSnapshot`: per source, the latest row in [asOf−30 min, asOf], both ends inclusive. Strike: the latest timestamp within ±1%, then the nearest strike; ties go to the lower strike, then the earlier expiry (the documented tie class). `MacroSnapshot` and `EMPTY_MACRO` move here.
- The old `LIMIT 200` across six sources truncates only if a 30-minute window holds more than 200 rows. B2.4 counts this; never expected at 1-minute cadence.

**B2.2, GEXBot window.** Files: `api/_lib/gexbot-queries.ts`, its test, new `api/__tests__/gexbot-window-pglite.test.ts`.

- `getGexbotSnapshotsInWindow(tickers, from, to)`: `SELECT ticker, ts_us(captured_at), one_cvroflow, net_put_dex, one_dexoflow, one_gexoflow, zcvr, zero_gamma, spot FROM gexbot_snapshots WHERE ticker = ANY($t) AND captured_at >= $from AND captured_at <= $to` over [min trigger − 180 s, max trigger], on `gexbot_snapshots_ticker_time_idx`.
- Pure `gexbotSnapshotAt(rows, ticker, asOf, maxAgeSeconds = 180)`.
- Keep `getLatestGexbotSnapshotAt` until Silent Boom moves over (B4).

**B2.3, flow at fires.** Files: `api/_lib/ticker-flow-snapshot.ts`, its test, new `api/__tests__/ticker-flow-at-fires-pglite.test.ts`.

`fetchFlowAtFires(db, date, reqs: { ticker, fireTs }[]) → Map<ord, TickerFlowSnapshot>`: one query per distinct ET date (normally one), returning one row per fire instead of each ticker's whole day.

```sql
WITH req AS (SELECT r.ticker, r.ord, LEAST(r.fire_ts, $sessMax) AS at_ts
             FROM unnest($tickers::text[], $fireTs::timestamptz[]) WITH ORDINALITY r(ticker, fire_ts, ord)),
unified AS (SELECT DISTINCT ON (ticker, ts) ticker, ts, net_call_prem, net_put_prem FROM (
     SELECT w.ticker, w.ts, w.net_call_prem, w.net_put_prem, 1 AS priority
       FROM unnest($distinct::text[]) t(ticker) CROSS JOIN LATERAL (
            SELECT * FROM ws_net_flow_per_ticker w WHERE w.ticker = t.ticker
               AND w.ts >= $sessMin AND w.ts <= $upper OFFSET 0) w
     UNION ALL
     SELECT … the same LATERAL over net_flow_per_ticker_history, priority 2) c
   ORDER BY ticker, ts, priority),
merged AS (SELECT ticker, ts, 0 AS kind, NULL::bigint AS ord, net_call_prem AS ncp, net_put_prem AS npp FROM unified
           UNION ALL SELECT ticker, at_ts, 1, ord, NULL, NULL FROM req)
SELECT ord, n, cum_ncp, cum_npp FROM (
  SELECT kind, ord, COUNT(*) FILTER (WHERE kind = 0) OVER w AS n,
         SUM(ncp) OVER w AS cum_ncp, SUM(npp) OVER w AS cum_npp
  FROM merged WINDOW w AS (PARTITION BY ticker ORDER BY ts, kind ROWS UNBOUNDED PRECEDING)) z
WHERE kind = 1
```

- `$upper` = LEAST(max fire, session max).
- `n = 0` → `{null, null}`; otherwise `COALESCE(sum, 0)`. That matches `flowAtFireTime`: null before the first tick, else the cumulative at the largest ts ≤ fire. Flow rows at exactly the fire time count, because `kind 0` sorts first.
- Indexes: `ws_net_flow_per_ticker_uq (ticker, ts)` and `net_flow_per_ticker_history_ticker_ts_idx`. The `LATERAL … OFFSET 0` forces one index scan per ticker (the `anchor-legs.ts` technique); this is finding 1. Choose it over the plain `ticker = ANY` form by EXPLAIN at 14:00 CT.

**Property tests for all of B2:** PGlite with tables from the real migrations and a seeded PRNG (no new dependency; fast-check isn't installed). Five seeds × at least 1,000 random fires each, plus adversarial generators: rows exactly at the 30 min / 180 s edges ±1 µs, sub-millisecond `captured_at`, equidistant strikes and multiple expiries, empty sources, long NUMERIC strings, fires after session max and before session min, several history sources at the same ts. Oracle: the old per-fire SQL copied verbatim, with a comment naming the commit it came from. Deep-equal per fire, except documented tie classes, which must land inside the tie set. R4 for each fetch: rejection, empty result, genuine against transient classification.

**B2.4, real-data parity, the gate for B3.** Files: new `scripts/verify-lottery-lookups.ts`, `tsconfig.scripts.json` (precedent `verify-lottery-no-vanish.ts`).

- Read-only, outside 08:15–15:30 CT only, concurrency 4.
- Fire coordinates: the in-universe fires the current detector produces on `docs/tmp/lottery-tapes/tape-2026-10-2{6,7,8}.jsonl.gz` through replay-day.ts's minute loop (about 16K fires).
- Per fire, compare the old per-fire SQL with the new batched lookup for macro and flow-at-fire. `--sample N` stratifies by hour and ticker and always includes every SPY, QQQ, SPXW and NDXP fire.
- GEXBot: Neon holds about a day, so compare GEXBot on the latest session's live fires during the 21:30–12:15 UTC overlap, and diff the Blob archive against Neon row by row for that day.
- Informational only: rows per ticker-day in `ws_net_flow_per_ticker`; whether `LIMIT 200` ever truncated; new lookups against the columns stored on live rows (drift explained by ingest lag).
- Acceptance: 0 mismatches outside the tie classes.
- **Risk (B2):** precision and boundary semantics, covered by microsecond and integer-milli comparisons, the property tests and B2.4.

### B3. Wire it: no per-fire round trips (L)

- **B3.1, Pass 1 restructure** (cron, cron test). Detect and enrich every group first (pure), then one `fetchFlowAtFires` under the 5 s `FLOW_SERIES_DEADLINE_MS`, then score. Failure becomes per run: transient or deadline → every fire this run gets NULL flow and NULL V2 score, status `partial`, one warning; genuine → `error`. `flowSeriesFailures` still counts affected ticker-days (Axiom meaning kept). `flowSeriesSkippedBreaker` stays 0, or is dropped once dashboards are checked.
- **B3.2, context batch** (cron, cron test). `fetchMacroWindow` and `getGexbotSnapshotsInWindow` join the flow query in one `Promise.allSettled` with `settleDegradable`. Delete `fetchMacroSnapshot`. Macro fails open per source, as Silent Boom does: transient → `partial` plus a warning; genuine → `error`. GEXBot failure is captured and makes the run `partial` when it wrote fires (since the 2026-10-29 status fix, GEXBot and macro snapshot throws already do this per fire), with a `gexPrefetchFailures` counter. Update Silent Boom's "do NOT extract a shared util" comment: its stated reason (lottery fails open per fire) no longer holds.
  - **The slot for classifier phase 4:** `lookupAnchorLegs(requests)` joins this batch. Requests are `[trigger−30 s, min(trigger+30 s, scanEnd))`, so only prints received by detect time count, per that spec. Anchor columns go on `LotteryFireRow` and the B3.3 column list. If phase 4 lands first in the old Pass 2, moving its batched call into this batch is mechanical. Tell the owning session.
- **B3.3, store.** Files: new `api/_lib/lottery-fire-store.ts`, its test, its PGlite test, and `api/__tests__/insert-binds.ts` (add `extractUnnestInsertRows`, returning the same per-row `Map<column, value>` shape so the 34 bind assertions change mechanically).
  - `LOTTERY_FIRE_COLUMNS: { name, cast }[]` is the single source of the column list (63 columns).
  - `insertLotteryFires(db, rows)`: `sql.query` text built only from that constant list; `INSERT … SELECT … FROM unnest($1::date[], $2::timestamptz[], …) … ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING RETURNING id, option_chain_id, trigger_time_ct`; chunks of 500, each under `withDbRetry(2, 10_000)`. Not one transaction: rows are independent, so a failed chunk doesn't drop the others.
  - **Precision rule:** cast every array to the column's own type (`::numeric[]`, not `::float8[]`). A float8 → numeric cast keeps 15 significant digits; today's per-value text bind keeps up to 17. The PGlite test inserts the same rows through the old single-row INSERT and through unnest into two tables and asserts `row_to_json` is equal; it also checks types, nulls, jsonb, and that a re-run inserts 0 rows.
- **B3.4, wire the insert** (cron, cron test). A chunk failure → `insertFailures` + `firstInsertError`, `captureException` (fingerprint `lottery-fire-insert`), status `error`; remaining chunks still run. `inserted` = rows returned.
- **B3.5, range_pos after the insert** (`lottery-fire-store.ts` adds `updateRangePos`, its test, cron, cron test). Fetch candles only for inserted ticker-days, serially through the shared semaphore with the existing deadline and breaker. Skip once 40 s have elapsed (`candleFetchSkippedBudget`). `UPDATE lottery_finder_fires f SET range_pos_at_trigger = u.rp FROM unnest($ids::bigint[], $rp::numeric[]) u(id, rp) WHERE f.id = u.id AND f.range_pos_at_trigger IS NULL` (PK index; HOT-eligible, the column isn't indexed). A failed UPDATE → `partial` plus a warning; `backfill-range-pos.mjs` fills anything left NULL.
- **Risk:** a transient failure now degrades every fire in the run instead of some. Acceptable: today's per-fire retries are what made runs slow, and the N4 re-score repairs it. One INSERT can fail a whole run's fires; the retries and the next runs' 7-minute window cover that, as now.
- **Verify in prod:** p90 `durationMs` under 20 s and no killed runs at the open; `timingsMs.pass2` near zero; per-day NULL shares unchanged against the prior week for `mkt_tide_diff`, `cum_ncp_at_fire`, `gex_*` (and gexHits/gexMisses) and `range_pos` (index roots aside); `inserted` ≈ in-universe fires minus conflicts; no duplicate (chain, trigger); `db attempt timeout` events per day.

### B4. Silent Boom adopts the shared lookups (S; after B3 has been stable for a week)

- Files: `api/cron/detect-silent-boom.ts`, its test. Replace the per-fire `getLatestGexbotSnapshotAt` with the window plus `gexbotSnapshotAt`, and the per-ticker `fetchTickerFlowSeries` with `fetchFlowAtFires`. Then delete `getLatestGexbotSnapshotAt` unless another caller remains.
- Share later: the as-of binary search (`lookupAt` against `macroSnapshotAt`), the unnest store (its own module, same pattern), its INSERT.
- Leave for later: its four-series macro prefetch (already batched), its classifier call (classifier phase 4 owns it), its detector core and replay (E5).

### B5. The library: core plus both data sources in one push (L)

Five commits of at most 5 files each, reviewed as one phase, so the interface lands with two production implementations (R3):

1. **Blob reader.** `api/_lib/gexbot-archive-read.ts` + test. `readArchivedGexbotSnapshots(date)`: find the `gexbot_archive_audit` row (table `gexbot_snapshots`, date), download `gexbot/gexbot_snapshots/{date}.parquet` with `@vercel/blob`, verify size and sha256 against the audit row, read the nine columns with `@dsnp/parquetjs` `ParquetReader.openBuffer`, and return rows shaped like `getGexbotSnapshotsInWindow`. Test: a round trip through `writeRowsToParquet`. R4: missing audit row, sha mismatch, Blob 404/5xx and malformed parquet each throw by name.
2. **Known-at.** `lottery-macro-context.ts`, `ticker-flow-snapshot.ts` and their PGlite tests. Add `knownAt: Date | null`: `created_at <= $knownAt` on flow_data, spot and strike; `received_at` and `fetched_at` inside the flow LATERALs. The cron passes null; the replay passes a Date. Test: rollup rows and REST history rows with later ingest times are excluded.
3. **Core and Neon source.** `api/_lib/lottery-detect-core.ts` holds the interface below, `runLotteryDetection`, the pure helpers moved out of the cron (cluster bonus, direction gate, Take-It row builder, `daysBetween`) and `RunDiagnostics`. The core calls neither Sentry nor Axiom. `api/_lib/lottery-source-neon.ts` implements the source. The cron becomes guard → core → store → range_pos → monitor → report, with the diagnostics-to-Sentry/status mapping moved there unchanged. New `api/__tests__/lottery-detect-core.test.ts` (the moved pure helpers). The cron test must pass with nothing but staging edits: it is the behavior oracle.
4. **Replay source and tape reader.** `scripts/_lib/lottery-replay-source.ts` + test, `scripts/_lib/lottery-tape.ts` + test, `tsconfig.scripts.json`. The tape reader streams v1 (the saved 14-field JSONL.gz) and v2 (v1 plus `trade_code` and `trade_id`, cut from the Full Tape) as a 7-minute sliding window, so memory stays bounded; replay-day.ts loads all 7.6M rows at once.
5. Folded into 4 if it stays under 5 files: the archive-against-Neon GEXBot parity mode in `verify-lottery-lookups.ts`.

#### Interface

```ts
// api/_lib/lottery-detect-core.ts
export interface LotteryRunSource {
  /** canceled=false, price>0, executedAt in [from, to]; to=null: open-ended (live). Sorted by executedAt, then trade id. */
  loadTicks(
    from: Date,
    to: Date | null,
  ): Promise<OptionTradeTick[] /* + ticker/chain meta */>;
  /** Latest in-universe trigger per chain with trigger_time >= since (and <= until when given). */
  priorFires(since: Date, until: Date): Promise<Map<string, number>>;
  /** Take-It sequential inputs anchored at asOf (lookbacks 35/10 min) + prior-session win rates for `day`. */
  takeitDeps(asOf: Date, day: string): TakeitContextDeps;
  flowAtFires(
    date: string,
    reqs: FlowAtRequest[],
  ): Promise<Map<number, TickerFlowSnapshot>>;
  macroWindow(w: {
    from: Date;
    to: Date;
    strikeTickers: string[];
  }): Promise<MacroWindow>;
  gexbotWindow(
    tickers: string[],
    from: Date,
    to: Date,
  ): Promise<GexbotWindowRow[]>;
  stockCandles(ticker: string, date: string): Promise<UWStockCandle[]>;
  // added by classifier phase 4, implemented by BOTH sources:
  // anchorLegs(reqs: AnchorRequest[]): Promise<Map<string, AnchorLegs | null>>;
}
export interface LotteryRunResult {
  rows: LotteryFireRow[]; // insert-ready, range_pos null
  rangePosTargets: {
    key: string;
    ticker: string;
    date: string;
    trigger: Date;
    spotAtFirst: number;
  }[];
  counts: {
    scanned;
    chains;
    skippedShort;
    skippedNoOi;
    totalFires;
    priorSeeds;
    gexHits;
    gexMisses;
    gexOutOfUniverse;
  };
  diagnostics: RunDiagnostics; // per-stage failure kind + first error + timings
}
export function runLotteryDetection(
  source: LotteryRunSource,
  opts: { scanEnd: Date; today: string; deadlineAtMs: number },
): Promise<LotteryRunResult>;
```

**Neon source:** the B1–B3 modules, `knownAt` null, candles from UW, `loadTicks` = the sliced scan, Take-It deps = today's SQL anchored at `asOf`. `loadPriorWinRates` is exported once and used by both sources.

**Replay source:** `createReplayLotterySource({ db, apiKey, day, tape, liveLottery, liveSilentBoom, gexbotRows, visibility: 'live' | 'pit' })`. No module state; all per-day state lives on the instance (R1).

| Method                       | Replay source                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadTicks`                  | tape window `[scanEnd−7m, scanEnd]`, inclusive end (later rows exist on a past day)                                                                                                                  |
| `priorFires`                 | L ∪ R (see the next section)                                                                                                                                                                         |
| `takeitDeps`                 | recent same-type = L ∪ R with trigger in [asOf−35 m, asOf]; other-type = live `silent_boom_alerts` (∪ replayed SB once E5 exists) in [asOf−10 m, asOf]; win rates = the shared SQL with `date < day` |
| `flowAtFires`, `macroWindow` | the same functions, `knownAt = scanEnd` in `live` mode, null in `pit`                                                                                                                                |
| `gexbotWindow`               | in-memory filter of that day's archive rows (`captured_at` is the ingest time, so it is already as-known-at)                                                                                         |
| `stockCandles`               | UW once per ticker-day, cached for the day; `computeRangePos` matches live, because live fetches minutes after the trigger, when the trigger bar is complete                                         |
| `anchorLegs` (after phase 4) | `describeAnchor` from `anchor-legs.ts` over tape v2 prints (`trade_code`, `id` as `ws_trade_id`); null on v1 tapes                                                                                   |

Strictness: the replay treats any failure in `diagnostics` as fatal for that minute and retries; after 3 failures it aborts the day. Recovered rows are never written degraded.

## Cooldown seed and the ±5-minute dedupe

Per replay day D:

1. **Preload once:** L = live lottery rows for D with `recovered_at IS NULL` (chain, trigger, ticker, type); live `silent_boom_alerts` for D; the GEXBot archive for D.
2. **R = ∅.** R holds the replay fires that will be inserted.
3. **For each simulated run** (minutes from 09:25 ET to the close plus 5 min, from `getMarketCloseHourET`, with `scanEnd = minute + 17 s`, the observed trigger offset):
   - The seed for chain c is the max trigger in L ∪ R on c with trigger in [scanEnd − 10 min, scanEnd]. This is the live seed query evaluated against the table as it will stand after recovery; leaving it out is what corrupted 05-04 and 05-20. Live rows count by trigger time, regardless of `inserted_at`: deterministic and conservative.
   - Run the core; take its in-universe fires C. For each fire f with key (chain, trigger):
     - key ∈ L → **exact**: skip (L already seeds it);
     - else some l ∈ L on the same chain has |l − trigger| ≤ 5 min → **nearLive**: skip, and don't add to R, so it never seeds;
     - else key ∈ R → **redetected**: skip. The first detection wins, as live ON CONFLICT does, so stored features come from the first run that saw the fire;
     - else add to R → **recovered**.
   - Why a skipped nearLive fire can't leak: if the live fire l is later than f, runs before l becomes visible can re-fire, but every such re-fire lies within [f, l] ⊂ l ± 5 min, so it is skipped too. Once l ≤ scanEnd, its cooldown applies.
4. **After the day, write R** with `insertRecoveredLotteryFires(db, rows, recoveredAt)`: the same column list plus `recovered_at`, and a SQL guard:

```sql
… FROM unnest(…) AS t(…)
WHERE NOT EXISTS (SELECT 1 FROM lottery_finder_fires l
                  WHERE l.option_chain_id = t.option_chain_id
                    AND l.trigger_time_ct BETWEEN t.trigger_time_ct - INTERVAL '5 minutes'
                                              AND t.trigger_time_ct + INTERVAL '5 minutes'
                    AND l.recovered_at IS NULL)
ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
RETURNING id, option_chain_id, trigger_time_ct
```

- Index: `lottery_finder_fires_chain_ts_uq`. The in-memory rule decides seeding; the SQL guard enforces it at write time. Report `|R| − returned` (expected 0). A re-run inserts 0.
- `recovered_at` is constant per invocation, so it doubles as an undo handle: `DELETE … WHERE recovered_at = $runTs`, with the owner's approval.
- **Summer gap:** L is empty except for the 07-22 morning, so the replay is the plain "no timeouts" run. Run days in date order, with outcomes enriched between days (the win rates need them).

## GEXBot context from the Blob archive

- Always read old days from the archive, even if Neon still has them, so there is one code path.
- Path: the audit row → `gexbot/gexbot_snapshots/{YYYY-MM-DD}.parquet`. The UTC day equals the ET session date (documented in `archive-gexbot.ts`).
- Verify sha256 and row count, read the nine columns, then use the same pure `gexbotSnapshotAt` (180 s, inclusive) as live.
- Differences from Neon: DOUBLE in the archive against `Number(NUMERIC)` in Neon (identical expected, checked by the overlap-window diff); `TIMESTAMP_MILLIS` drops microseconds, so a row within 1 ms of the 180 s edge can flip, and `gex_captured_at` loses its microseconds. Documented.
- A day with no audit row or a sha mismatch aborts that day by default. `--allow-missing-gexbot` writes `gex_*` NULL with a counter.
- The replay needs `BLOB_READ_WRITE_TOKEN` (the Take-It bundle comes from Blob too).

## E0. Recovered-row marker (S)

- Files: `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`. Next id was 201 on 10-29; re-check, other sessions add migrations.
- `statements`: `SET LOCAL lock_timeout = '5s'` (the #191 precedent); `ALTER TABLE lottery_finder_fires ADD COLUMN IF NOT EXISTS recovered_at timestamptz NULL`; the same on `silent_boom_alerts`; a `COMMENT ON COLUMN` naming the provenance. Metadata-only (no default, no rewrite), no index.
- `db.test.ts` per CLAUDE.md: the applied mock, the description line, the call count and the transaction count.
- Apply with `scripts/migrate-db.ts` outside market hours (prod was behind on migrations on 10-29).

## Phase E: recover (after B5)

- **E1, writer and driver (M).**
  - Commit 1: `lottery-fire-store.ts` + `insertRecoveredLotteryFires` and its PGlite test (the ±5 guard, the marker, idempotency, live rows only).
  - Commit 2: `scripts/replay-lottery-fires.ts` (CLI); `scripts/_lib/lottery-replay-run.ts` (the day loop above, returning per-day `{ replayFires, exact, nearLive, redetected, recovered, inserted, diagnostics }`); its test; `tsconfig.scripts.json`.
  - Flags: `--from`/`--to`, `--tape-dir`, `--tape v1|v2`; `--visibility live|pit` (required, no default); `--dry-run` (default) or `--write`, plus `--limit`; `--compare-live` (the replay-day.ts diff). Refuses to run 08:15–15:30 CT on weekdays. UW calls are capped at 300/min.
- **E2, validation, no writes (M, mostly wall time).**
  1. **Library against live:** the new library on the saved 10-26/27/28 tapes in `live` mode. Fire keys within the replay-day.ts noise floor (0.5%) of its results. For exact matches, per-column agreement with the stored live columns ≥ 99% on score, `direction_gated`, `cum_ncp/npp`, macro and `gex_*`. Compare `takeit_prob` only where `takeit_model_version` equals the current bundle.
  2. **Full Tape against WS:** cut v2 tapes for 10-26/27/28 from the Full Tape (the reload script's mapping, side from `tags`, canceled and zero-price prints dropped, universe filter). Fire-key Jaccard against the WS-tape replay ≥ 98%. This gates using the Full Tape for 10-16 → 10-23 and the summer.
  3. **Write dry-run on 10-28:** "would insert" ≈ the 525 missing fires minus nearLive.
- **E3, writes (S–M ops).** 10-26 → 10-28 (saved tapes, `live`), then 10-16 → 10-23 (Full Tape v2, `live`), then the summer per summer-gap phase 5, in `pit` mode, after its phases 1–4 refill the inputs. After each day verify: live + recovered counts against the replay; recovered↔live pairs on a chain within 5 min = 0 and recovered↔recovered < 300 s = 0; the feed shows the days; NULL shares like live rows.
- **E4, after-fire passes (M).** Outcomes for recovered rows through the parquet/Full Tape path (past the 2-day retention). Take-It for the ~16K NULL live rows with `backfill-takeit-scores.mjs`, checked against the current bundle first. The N4 re-score: recompute `cum_ncp/npp` and the V2 score with `fetchFlowAtFires` (`knownAt = trigger + 60 s`) for ticker-days the Axiom `meta` flags (`flowSeriesFailures`, `flowSeriesSkippedBreaker`); `cluster_bonus` stays. SHAP: ~160K recovered rows would reach `takeit-fill-shap` at 100 per tick, so run a backfill rather than wait. Leave `ml/src/lottery_refit_guard.py` as is.
- **E5, Silent Boom replay (L; later, before summer-gap phase 5 finishes).** Extract SB's core the same way, with its own source pair. Reuse the tape reader, the Blob reader, the driver loop, the marker and the dedupe rule (key `(option_chain_id, bucket_ct)`, ±5 min). Lottery and SB share a per-minute loop, because each one's Take-It reads the other's recent fires. Delete the nine dated `scripts/replay-*-2026-*.ts` once E2 passes (separate commit).

## Open questions (default picks)

1. Enrichment before or after the insert: DB lookups before (bounded, parallel); UW candles after (batched UPDATE).
2. Known-at modes: `live` for 10-16 → 10-28 (reproduce what the cron saw), `pit` for the summer (inputs refilled later). An explicit flag, never inferred.
3. Seeds and Take-It context = L ∪ R with trigger ≤ scanEnd, ignoring live `inserted_at`.
4. Dedupe: ±5 min inclusive, per `option_chain_id`, against live rows only (`recovered_at IS NULL`).
5. Prior-session win rate: the shared SQL as of replay time (`date < day`), including earlier recovered rows that have outcomes. Consistent with "no timeouts"; negligible for October.
6. Take-It bundle: the current one (summer-gap open question 1; ask the owner before phase E3's summer days).
7. Marker: `recovered_at` only, constant per invocation. The git SHA and arguments go in the run report, not a column.
8. No index on `recovered_at`, and no feed or UI change in E. Adding it to `lottery-export.ts` is the owner's call.
9. Tick-scan expiry filter (dte ≤ 3 in SQL, which never changes in-universe fires): measure the row share first; adopt only if it cuts at least 25% of rows. It changes the `scanned`, `chains` and `totalFires` counters.
10. B0.2 router conversion: yes.
11. GEXBot archive missing for a day: abort the day.
12. Promoting `gamma` to a typed `ws_option_trades` column (no per-row JSONB detoast in the scan): later, uw-stream plus a migration.
13. Cross-run caches (ticks by an id high-water mark, flow series by a `received_at` high-water mark): later. Late-committing rows make them unsafe without an overlap margin.
14. Classifier phase 4 ordering: whichever lands second moves `lookupAnchorLegs` into the B3.2 context batch.

## Thresholds and constants

| Constant                                              | Value                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tick scan                                             | 7 slices of 1 min, the last open-ended; bisect ≤ 3 levels on the size error  |
| Context batch deadline (flow, macro, GEXBot, anchors) | 5 s; flow keeps `FLOW_SERIES_DEADLINE_MS`                                    |
| INSERT                                                | 500-row chunks, `withDbRetry(2, 10_000)`                                     |
| Candle stage                                          | starts only before 40 s elapsed; 5 s per call (existing); breaker unchanged  |
| Macro staleness                                       | 30 min, inclusive                                                            |
| GEXBot staleness                                      | 180 s, inclusive                                                             |
| Strike match                                          | ±1% inclusive, exact decimal                                                 |
| Replay schedule                                       | `scanEnd = minute + 17 s`, 09:25 ET → close + 5 min                          |
| Replay windows                                        | ticks 7 min (inclusive end); seed 10 min; Take-It 35 / 10 min; dedupe ±5 min |
| Live-mode `knownAt`                                   | `scanEnd`                                                                    |
| E2 gates                                              | ≥99% per-column agreement; ≥98% Full Tape Jaccard                            |
| UW throttle (replay)                                  | ≤300/min, never 08:15–15:30 CT                                               |

## Scope

| Phase | Size | Effort                                                                |
| ----- | ---- | --------------------------------------------------------------------- |
| B0    | M    | ~1 session; ~50 prod LOC, ~700 test LOC churn                         |
| B1    | M    | ~1 session                                                            |
| B2    | M–L  | ~2 sessions plus a ~1 h prod parity run                               |
| B3    | L    | 2–3 sessions                                                          |
| B4    | S    | —                                                                     |
| B5    | L    | ~3 sessions                                                           |
| E0    | S    | —                                                                     |
| E1    | M    | —                                                                     |
| E2    | M    | mostly wall time: Full Tape download and cut, ~3–5 min replay per day |
| E3    | S–M  | ops: ~1 h for October; the summer per the summer-gap spec             |
| E4    | M    | —                                                                     |
| E5    | L    | —                                                                     |

## Files most touched

`api/cron/detect-lottery-fires.ts`, `api/__tests__/detect-lottery-fires.test.ts`, `api/_lib/ticker-flow-snapshot.ts`, `api/_lib/gexbot-queries.ts`, `api/_lib/db-migrations.ts`; also `api/_lib/takeit-detect.ts`, `api/_lib/anchor-legs.ts`, `api/cron/detect-silent-boom.ts`, `api/_lib/gexbot-parquet.ts`, `api/__tests__/pglite-migrations.ts`, `api/__tests__/insert-binds.ts`, `docs/tmp/lottery-tapes/replay-day.ts`, `scripts/reload-ws-option-trades-from-fulltape.py`.
