---
status: Plan
date: 2026-11-05
---

# Summer gap phase 3: retrofit the REST backfill scripts, then refill 07-22 → 09-04

## Goal

Make every remaining phase-3 backfill script safe to aim at exactly 2026-07-22 → 2026-09-04 (date range, market-hours guard, throttle, honest exit code, batched idempotent writes, the correctness fixes the audit found), land uw-rest-fixes R1 and R2 on the way, and refill the summer tables in dependency order.

Parent spec: `docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md`, phase 3. Detail behind every item below: the 2026-10-29 script audit (local, gitignored: `docs/tmp/summer-gap-2026-10-29/phase3-script-audit.md`), cited by section as "audit §N". R1 and R2: `docs/superpowers/plans/2026-10-23-uw-rest-fixes.md`.

## Owner decisions (2026-11-05)

- SPX and NDX summer candles: UW SPY/QQQ 1-minute bars × a per-day ratio, `SPX close ÷ SPY close` and `NDX close ÷ QQQ close`, both closes from Schwab daily data for that date. Not the constant `SPY_TO_SPX_RATIO = 10`.
- The realized-vol D2 fix (plan R2) is approved and includes the summer gap.
- Ship each phase when its review passes; don't wait for baselines.
- Standing defaults (spec phase 3): 1-minute spot exposures like the live cron; NDX dropped from `strike_exposures` like live; the dark-pool filter rule applied (memory `dark-pool-filter-rules`).

## Shared shape for every retrofitted script

- `--from/--to` (inclusive, ET trading days from `src/data/marketHours.ts`, holidays skipped), `--dry-run`, `--limit`, `--allow-market-hours`. A script that keeps a positional N splits argv first (`parseArgs` rejects unknown positionals).
- `--limit N` on a script that runs the day loop (`runDays`) is the first N trading days of the selected range, ascending. The caller slices the dates before calling `runDays`; `runDays` has no limit of its own. The two existing scripts keep their own meaning (range-pos: N ticker-days, newest first; net-prem: N ticker-days). The shared parser only checks that N is a whole number ≥ 1.
- Refuses 08:15–15:30 CT on weekdays unless `--allow-market-hours` (the existing `isMarketHoursCt` window in `range-pos-backfill.mjs`), checked before the run and again before each day, so a run started before 08:15 stops taking new days.
- UW requests through `fetchUwDayRows` (`scripts/_lib/uw-day-fetch.mjs`, already shared): one throttle at ≤300/min, an explicit per-script User-Agent, one retry after 1 s on a 429, 5xx, network error or timeout, and a 4xx read as an error, never an empty day.
- Per-day try/catch: a UW non-2xx, network error, malformed JSON or DB error is counted against that day and the run continues; the summary prints counts by day and by failure kind; exit 1 if any day failed (3 when the guard stopped the run and no day failed). No warn-and-exit-0 path.
- A day worker returns counts, not rows: `{ fetched, stored }` (whole numbers) plus any extra count fields. `fetched: 0` on a trading day shows up as an empty day in the summary: a hole to look at, not a failure. `runDays` records one failure per day, the first. A worker that fans out over tickers with `runPool` stops starting new tickers after the first rejection, so its summary understates the failed tickers and the rest of that day goes untried. Choose deliberately: either accept that (the day is re-run anyway, the writes being idempotent), or catch per ticker so every ticker is tried, and throw once at the end of the day if any failed, naming how many and the first reasons. Returning the failed-ticker count in the value instead would count the day as done.
- Writes in ≤500-row `unnest` (or multi-row VALUES) chunks with `ON CONFLICT` on the table's real unique key; no per-row `await` over >50 rows.
- Reuse, don't copy: the generic pieces live today in two script modules. From `scripts/_lib/range-pos-backfill.mjs`: `parseArgs`, `isMarketHoursCt`, `chunk`, `runPool`, `retryTransientDb`, `summarizeFailures`, `redact`. From `scripts/_lib/net-prem-ticks-backfill.mjs`: the `--from/--to` pairing rule in its `parseArgs`, `marketHoursRefusal`, `tradingDaysInRange`, `selectDates`, `createRequestThrottle`, `runTickerDays`, `summarizeByDay`. P3.0 moves them into one shared module, which both scripts then import.
- Tests: the shared module gets table tests; each script's row mapping and its correctness fix get a test in `scripts/_lib/*.test.mjs` (failure counting included, R4). Mock the DB and `fetch`; no test reaches a database.

## Phases (each ≤5 files, `npm run review` + code-reviewer, pushed on pass)

**P3.0 Shared backfill CLI module.** New `scripts/_lib/backfill-cli.mjs` + test, holding the pieces listed under "Reuse, don't copy". Two additions the retrofits need:
- a day-run loop that catches each day's rejection and records it as that day's failure with a kind (`uw_http_<n>`, `network`, `timeout`, `malformed`, `db`, `other`), then moves on;
- a summary that counts failures by day and by kind and gives the exit code (1 if any day failed).

`range-pos-backfill.mjs` and `net-prem-ticks-backfill.mjs` import from it and re-export the moved names, so their scripts and their existing tests run unchanged. Both scripts keep their current behaviour, including net-prem's abort on a non-transient DB error. This plan doc lands here.

**P3.1 Candles.** `backfill-etf-candles-1m.mjs` (range + batching), `backfill-spx-candles-1m.mjs` and `backfill-ndx-candles-1m.mjs` (range instead of the hardcoded 30 days; the per-day Schwab close ratio), a `_lib` module for the ratio and bar mapping, and its test.
- Ratio source: probe what Neon already stores (read-only) for Schwab daily closes of $SPX, SPY, $NDX, QQQ. If any of the four is missing for a gap date, fetch Schwab daily price history through the existing Schwab helper. Both closes of a ratio must come from the same source. A date with no ratio is a failed day, never a constant fallback.
- Record the chosen source and three sample ratios in this doc's as-built note.

**P3.2 `flow_data`, part 1.** `backfill-local.mjs` (market_tide + OTM), `backfill-etf-tide.mjs`, `backfill-netflow.mjs`: range, DB errors counted (audit §1a).

**P3.3 `flow_data`, part 2, and NOPE.** Audit §1a and §4:
- `backfill-greek-flow.mjs` writes `otm_ncp`/`otm_npp` like `fetch-greek-flow.ts`;
- `backfill-zero-dte-flow.mjs`: DO UPDATE on ncp/npp/net_volume plus the cron's all-null guard (the intermittent summer rows are re-pulled, owner request);
- `backfill-flow-ratio.mjs`: delete the requested dates' rows first (wall-clock vs tick-time keys never collide), the cron's clamp (NULL below $1K, cap 9999.9999), UW errors counted;
- `backfill-nope.mjs`: range only (a lookback run would DO UPDATE over live days).

**P3.4 Exposure and OI.** `backfill-spot-gex.mjs` (every tick at `start_time ?? time` like the cron, batched; no 5-minute last-tick buckets), `backfill-oi-change.mjs`, `backfill-oi-per-strike.mjs` (batched), `backfill-greek-exposure.mjs` (failures counted; keep its existing-rows skip; ignore the stale header SQL), `backfill-greek-exposure-strike.mjs` (range).

**P3.5 Strike exposures and all-DTE vega flow.** `backfill-greek-flow-etf.mjs` (conflict target `(ticker, timestamp, expiry)` per migration #129), `backfill-strike-exposure.mjs` (drop NDX, max `time` across rows, holiday-aware next trading day, batched), `backfill-strike-exposure-lottery.mjs` (resume probe scoped to the requested range so 07-22 isn't skipped, failures counted, max `time`).

**P3.6 uw-rest-fixes R1.** As specified in that plan: `api/_lib/uw-spot.ts` + test, `api/cron/fetch-strike-all.ts` + test, `scripts/backfill-strike-all.mjs` (paging, helper spot, max `time`). Also retrofit the backfill to the shared shape. Live cron change: deploys to Vercel.

**P3.7 uw-rest-fixes R2.** As specified: `api/cron/fetch-vol-surface.ts` + test, `scripts/backfill-vol-surface.mjs`. Trailing rv_30d (window ending on D), iv_30d from the `date == D` row, COALESCE `iv_rank`. The backfill rewrites every stored date and fills missing days including the gap. Commit body names the methodology change.

**P3.8 Dark pool.** `backfill-dark-pool-prints.mjs`: range, the ET-date stop (`api/_lib/darkpool.ts:229-232`), failures counted, throttle and guard. Filter: first find where the live readers apply the dark-pool rule (`api/_lib/darkpool.ts` and the dark-pool endpoints). Store gap rows the same way live rows are stored, so the readers treat both alike. If neither live storage nor the readers apply the average-price/derivative rule, report it as a live bug rather than fixing it here (the fix is in `uw-stream/`, a Railway push after 15:00 CT).

**P3.9 Probes and new scripts.** Probe first, then write only what pays off: `backfill-strike-trade-volume.mjs` (`/stock/{sym}/flow-per-strike-intraday?date=`; audit §2), `backfill-economic-events.mjs` (only if UW serves past events), one more `flow_alerts` probe with other parameters (accept the loss if still empty, and record it in the parent spec).

## Runs (controller, after each phase is pushed)

Off-hours only, one UW script at a time, a dry run or one-day probe first, then 2026-07-22 → 2026-09-04. Order follows audit §6: ETF candles → SPX/NDX candles → `flow_data` family → flow ratio, spot exposures, NOPE → greek exposure, OI, vol (after P3.7) → all-DTE vega flow → strike exposures → strike-all (also 2026-09-25 → 10-22, per R1) → dark pool → new scripts. After each run, compare per-day row counts against the neighbouring weeks and record them in the parent spec's phase-3 "Done" list.

## Data dependencies

- UW REST: ≈8.9K requests in total (audit §6, §8), ≤300/min.
- Schwab daily price history (P3.1), only for dates Neon doesn't already hold.
- Prod Neon writes only through these scripts. No migrations.

## Open questions (defaults)

1. 07-22 partial day: keep the live morning rows (DO NOTHING) except where a script DO UPDATEs by design (zero-dte-flow, flow-ratio, greek-exposure-strike, nope). Default: as listed.
2. `greek_exposure` D3 (`call_gex`/`put_gex`): stays as live until R3 lands, so backfilled rows match live rows. Default: unchanged.
3. `ws_gamma_setup_fires`, `periscope_lottery_fires`, `gex_target_features`, `flow_regime_0dte_daily`: out of phase 3 (phase 4), and the first two stay paused with GEXBot.

## Thresholds / constants

- Gap: 2026-07-22 → 2026-09-04 (33 trading days).
- UW throttle 300/min; write chunk 500 rows; market-hours refusal 08:15–15:30 CT weekdays.
- Flow-ratio clamp: NULL when |ncp| < $1,000; cap 9999.9999 (`monitor-flow-ratio.ts`).
- strike-all: ±`ATM_RANGE` (200) around helper spot; page size 500, page cap 10.

## As built

### P3.0 Shared backfill CLI module

`scripts/_lib/backfill-cli.mjs` (test: `backfill-cli.test.mjs`). `range-pos-backfill.mjs` and `net-prem-ticks-backfill.mjs` import from it and re-export the moved names, so the two scripts and their old tests are unchanged.

What the retrofits import:

- Flags: `parseArgs` (from/to may come alone, the range-pos form) and `parseRangeArgs` (also requires both or neither and refuses `--to` after today in CT; net-prem's `parseArgs` is this one).
- Guard and dates: `isMarketHoursCt`, `marketHoursRefusal`, `tradingDaysInRange`, `selectDates`.
- Batching and UW pacing: `chunk`, `runPool`, `createRequestThrottle`, `UW_REQUESTS_PER_MINUTE` (300; moved with the throttle).
- Neon: `retryTransientDb`. It gained a tag in P3.0, so the move is not a pure move: it now labels whatever it throws (its 30 s deadline error too) as `db` for `classifyFailure`, by error identity. Two halves for a day worker: the closure passed to it holds the Neon call and nothing else, because anything thrown inside it is labelled `db`; and a Neon call outside it is not recognised as `db` (it lands in `other`), and a caught DB error must be re-thrown as it is, or wrapped with the original as `cause` (the label follows the error and up to five `cause` links, not a re-wrap without `cause`).
- Day loop: `runDays(dates, { allowMarketHours, secrets }, worker)` returns `{ days, stoppedBy, notRun }`, one day at a time, guard checked before each day (a run started before 08:15 stops taking new days at 08:15; the day in flight finishes). A rejected worker, or a worker that returns a `fetchUwDayRows` error outcome, becomes `{ date, ok: false, failure: { kind, detail } }`; the loop moves on. `secrets` is `{ uwKey, databaseUrl }` and the detail is redacted with it. The worker returns counts, `{ fetched, stored }` plus any extra count fields; a return value of any other shape fails the day as `other`. One failure is kept per day (see the fan-out note under "Shared shape").
- Failure kinds (`classifyFailure`): `uw_http_<n>`, `network`, `timeout`, `malformed`, `db`, `other`.
- `summarizeRun(run)`: `attempted`, `succeeded`, `okDays` (each with its counts), `emptyDays` (done days with `fetched: 0`; they never change the exit code), `failedDays` (run order), `byKind` (most days first, ties by name, each with its dates and first example), `stoppedBy`, `notRun`, `exitCode`. `formatRunSummary(summary)` returns the printable lines: per-day counts and totals, failures by kind with dates and the first example, the empty days, the guard stop and the days not run.
- Exit codes, exported as `EXIT_OK` 0, `EXIT_FAILED` 1, `EXIT_BAD_ARGS` 2, `EXIT_GUARD_STOP` 3.
- Older helpers kept as they were: `runTickerDays`, `summarizeByDay`, `summarizeFailures`, `redact`. The `--limit` error text is now generic ("a whole number"); neither existing script's own `--limit` docs changed.

Exit code of `summarizeRun`, by plain precedence: any failed day gives 1 (`EXIT_FAILED`), a guard stop included, so a failure is never reported as a plain stop; else a run the market-hours guard stopped gives 3 (`EXIT_GUARD_STOP`, the same code as the refusal before any work starts, as in `backfill-range-pos.mjs`), since the days in `notRun` are unfilled; else 0. `backfill-net-prem-ticks.mjs` does not use the day loop: it puts its guard stop ahead of failures (3 even when ticker-days failed), keeps that order and its abort on a non-transient DB error, and is left unchanged.
