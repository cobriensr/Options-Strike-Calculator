# Live data integrity repair (2026-11-06)

## Goal

Stop the live crons from storing wrong values, add checks that catch this class of defect on their own, and repair the history. Three read-only audits found frozen zero or NULL grids, pre-open rows from the previous session, all-zero bars and frozen snapshots that row counts never showed. Some have run for seven months, into fires, features, prompts and a trained model.

## How it was found

A value check on the P3.2 `flow_data` backfill (summer gap plan, `docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md`) compared mapped UW rows with stored live rows. The owner asked for "any potential issues like these" to be caught. Three read-only audits followed: raw UW tables, readers of the bad sources, and derived tables. Their scripts and raw output are local in `docs/tmp/summer-gap-2026-10-29/{runs,audit-raw,audit-impact,audit-derived}/`. The controller re-checked every load-bearing number below against Neon.

## Defect classes

1. **Frozen prefilled grid.** UW answers a no-date intraday call with the whole session's grid, and the minutes that haven't happened yet are null. The writer turns a null into 0, or stores NULL, then `ON CONFLICT DO NOTHING` keeps the first write for good.
2. **Pre-open previous session.** `isMarketHours()` opens at 09:25 ET. Until UW rolls over (between 09:28 and 09:32 ET) it serves the previous session, and the writer stamps it with today's date or keeps its stale timestamp.
3. **Zero or stale values accepted.** A writer stores 0 or a non-moving value as data. There is no zero guard and no staleness guard.
4. **Frozen client state.** The frontend saves snapshots from quote state that has stopped updating.

## Findings (counts re-checked against Neon 2026-11-06)

| # | Table / source | Class | Span | Size | Writer |
|---|---|---|---|---|---|
| F1 | `flow_data` `spy_etf_tide`, `qqq_etf_tide` | 1 (nulls → 0 via `\|\| 0`) | 04-02 → now; only 7 real same-day days since 03-24 | 9,369 zero rows per source | `api/cron/fetch-etf-tide.ts` |
| F2 | same | 2 (09:27 run stores D-1's session under D) | 03-25 → now | 9,365 rows per source; real D-1 values, matching UW `date=` 78/78 | same |
| F3 | `flow_data` `zero_dte_index` | 1 (NULL grid) | 04-02 → now, 1 of 78 slots filled per day | ~10.7K NULL rows | `api/cron/fetch-zero-dte-flow.ts` |
| F4 | `flow_data` `zero_dte_greek_flow` | 2 (09:28 run stores D-1 trades in contracts expiring D, i.e. 1DTE flow, under D) | 03-25 → now | 11,342 rows on 126 dates; not relabelable | `api/cron/fetch-greek-flow.ts` (also swallows write errors, R4) |
| F5 | `strike_exposures` (REST: SPX 0DTE/1DTE/all, SPY, QQQ) | 2 (first poll keeps yesterday's timestamp and ladder) | 03-25 → now | 573 snapshots, 33,764 rows | `fetch-strike-exposure.ts`, `fetch-strike-all.ts` (no stale guard; `fetch-gex-0dte` has one, 099171ab) |
| F6 | same | 3 (UW stale cache: ladder frozen all day) | 33 ticker-days, incl. SPX 11-02, 11-03, 11-04 | 2–7 snapshots instead of ~78 | `fetch-strike-exposure.ts` (no `min_strike`/`max_strike` workaround) |
| F7 | same, plus `gex_strike_0dte` | 3 (all-zero ladder at the open) | 04-07 → 07-17 | 35 + 23 snapshots | `fetch-strike-exposure.ts`, `fetch-gex-0dte.ts` (no zero guard) |
| F8 | `zero_gamma_levels` | 3 (computed from a stale or frozen ladder) | frozen days above, plus every pre-open row | 2,051 frozen rows; ~324 pre-open rows, SPX up to 120 pts off | `compute-zero-gamma.ts` (no source-age check) |
| F9 | `market_internals` `$ADD`, `$VOLD` | 3 (all-zero bars) | 04-16 → now, 100% of bars | ~50K bars each | `fetch-market-internals.ts` |
| F10 | `market_internals` `$TICK` | 3 (O=H=L=C=0 bars) | 04-15 → now, ~30% of bars | 16,842 bars | same |
| F11 | `market_snapshots` | 4 (one spx/vix value all session) | 10-28, 11-02, 11-04, 11-06 (also 04-02 → 04-13) | ~199 live rows | frontend `useSnapshotSave.ts` → `api/snapshot.ts` |
| F12 | `market_snapshots` | label (live rows under another date) | 03 → 07 | 213 rows | same, predates the current guard |
| F13 | `futures_snapshots` | 3 (stale price, 1h change 0) | 04-12 → 09-28, all symbols | ~133K rows, plus 35K DX | `fetch-futures-snapshot.ts` (fixed for UW bars from 09-30; history only) |
| F14 | `spot_exposures` | 3 (all-zero rows at 09:30–09:33) | 02-19 → 07-22, plus 3 pre-market days | 129 rows | `fetch-spot-gex.ts` |
| F15 | `training_features` | fallout | 04-02 → now | 8 ETF columns 0 on 120 days; `zero_dte_*` NULL; `etf_tide_divergence` never true | `build-features*.ts` |
| F16 | `training_features` | own bugs | various | the snapshot picker sorts TEXT `entry_time` (10:05 before 8:30); static features NULL on 34 days; `opt_*` repeated 02-23 → 06-22; upsert `COALESCE` can't clear a bad value | `build-features.ts`, `build-features-*.ts` |
| F17 | `lottery_finder_fires` `spy_etf_diff`, `qqq_etf_diff` | fallout | 04-07 → now, 100% zero | ~607K fires | `detect-lottery-fires.ts`; live Take-It scoring has been fed these zeros on every fire; v2026-05-16's training set holds them only for its 04-07 → 05-16 slice (open question 3) |
| F18 | analyze prompt | fallout | 04-02 → now | "SPY/QQQ ETF Tide: +0M bear", "Mixed signals", `uw-deltas` always MIXED, "$ADD: 0, $VOLD: 0", greek-flow direction measured from yesterday's 1DTE value | readers in `api/_lib/` |
| F19 | `system-status` freshness | fallout | 04-02 → now | the zero grid's max timestamp is 15:55 ET, so a mid-session stall can't show | `api/system-status.ts` |
| F20 | `vol_term_structure`, `vol_realized` | 2/3 (holiday rows copy the prior session; stale `iv_30d`) | 05-25, 06-19, 07-03 (+04-03), 09-16, 10-01 | 59 + 6 rows | `fetch-vol-surface.ts` |
| F21 | `oi_changes` | 3 (one mid-March 50-row set copied to 29 days) | 02-23 → 04-02 | 1,450 rows | `scripts/backfill-oi-change.mjs` |
| F22 | `cone_levels` | 3 (one side's mark bad) | 08-25, 10-19 | 2 rows | `cone` cron, DO NOTHING keeps the first write |
| F23 | `flow_ratio_monitor` | 2 (pre-rollover reading is yesterday's last tick; unverified in the DB) | 03-25 → now, if confirmed | not measured | `api/cron/monitor-flow-ratio.ts:62-72` polls `/net-flow/expiry` with `date=today` every minute from 09:25 ET and takes the last non-null tick, which is yesterday's 15:59 before the rollover. Same class as F2 |

**F11 and F12 repair note (2026-11-07).** The frozen live rows were replaced by replaying their slots through the app:
- 199 frozen live rows deleted, on 10-28, 11-02, 11-04 and 11-06.
- 858 slots replayed through the app on 11 dates (09-09, 09-14, 09-15, 09-16, 10-16, 10-19, 10-27, 10-28, 11-02, 11-04, 11-06). Every row was checked against its posted payload and its candle.
- `training_features` rebuilt for 10 of them.
- 11-06 waits for its VIX1D: the `refresh-vix1d` cron runs weekday mornings.
- The older dates wait on the owner. On the ~22 dates that can't be replayed (2026-03-21 to 09-01, about 890 rows) the frozen rows stay, and they still feed `/api/vix-ohlc` where a date has no candles. See Lead 15 in `past-date-replay-integrity-2026-10-27.md`.

Owned elsewhere. Check with that work before touching any of these:
- **Lottery and Silent Boom outcome labels missing or stamped empty** (252K unenriched fires 06-25 → 10-21; 9K Silent Boom rows): the enrich work, commits 11a02b97 and 54850fdd on 11-06.
- **`is_fomc` labels:** the econ/FOMC label work.
- **`futures_bars` roll-week mix and holes:** `project_futures_contract_mix_repair`.
- **Schwab-dark windows:** `outcomes`, `cone_levels` and `flow_regime_0dte_daily` are missing 09-21 → 09-30 and 10-08 → 10-15. That is the pending owner question on the `outcomes` fill.
- **Summer gap rebuild:** `docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md`.

Clean: market_tide, market_tide_otm, spx/spy/qqq net flow, greek_exposure_strike, oi_per_strike, strike_trade_volume, net_flow_per_ticker_history, vega_flow_etf, futures_session_stats, futures_blocks, gexbot_snapshots, flow_regime_slot_daily, takeit_health_daily.

## Rules every fixed writer follows

- **R-day.** Store only rows whose own timestamp falls on today's ET session day, and only at or after the 09:30 ET open for the session series. A payload whose data is from an earlier day is skipped with a warning and a metric. Port `fetch-gex-0dte.ts`'s stale-cache check, and don't add a new mechanism.
- **R-null.** A missing or unparseable value is never stored as 0. Leave the row out and count it.
- **R-closed.** A writer that stores a 5-minute bucket's final value stores it only once the bucket has closed and settled (bucket end + `FINAL_LAG_MS` ≤ now). A minute that has ended is not necessarily final, so the write is also an upsert on the source key (R6, not a lock) that rewrites a row only when a value differs: a value UW revises later is healed by the next run.
- **R-zero.** A snapshot whose every value column is zero is skipped with a warning (`fetch-strike-all`'s `hasSignal`, e21f0903).
- **R-stale.** A derived writer checks its source's age before computing. `compute-zero-gamma` skips when the newest source snapshot is older than 15 minutes or from an earlier ET day.
- **R-quality.** `checkDataQuality` counts only today's rows (timestamp on today's ET day), so yesterday's rows can't mask a dead day.
- **Label rule (open question 1, default window-end).** A row's timestamp is the time its value is as of. A closed bucket's final value is stored under the bucket's end. Live market tide and net flow rows are captured 20–90 s into their window and labeled with its start, so they already fit within about 1.5 min and are left alone.

## Phases

Tier 0 must be live before **Mon 2026-11-09 09:25 ET**. Each phase is ≤5 files, goes through `npm run review` and a code-reviewer pass, and is pushed when the review passes. Tier 0 has no history writes.

**Tier 0: stop new bad rows**

- **P0.1 ETF tide and zero-DTE index crons (F1, F2, F3).** `api/cron/fetch-etf-tide.ts`, `api/cron/fetch-zero-dte-flow.ts` and their tests. Apply R-day, R-null, R-closed, R-quality and the label rule.
  - Built on a shared `api/_lib/closed-buckets.ts` (the rules) and `api/_lib/flow-bucket-store.ts` (the write and the quality count).
  - **Finality.** A bucket is stored only once `FINAL_LAG_MS` (90 s) has passed since its end. The INSERT is `ON CONFLICT (date, timestamp, source) DO UPDATE SET ncp, npp, net_volume WHERE (old values) IS DISTINCT FROM (new values)`: the spec's R6 (idempotent upsert on the source key), not a lock. Each run re-sends every closed bucket of the day, so a revised value is corrected through the close, `created_at` is never touched, and inserted and updated rows are counted separately.
  - **Window.** Both crons run until 10 minutes after the close, so the last bucket (15:55 to 16:00, settled at 16:01:30) has two attempts (16:02 and 16:07 for ETF tide, 16:04 and 16:09 for zero-DTE). Rows at or after the close (16:00 ET, or 13:00 ET on an early-close day) are left out.
  - **Values.** An absent `net_volume` is stored as NULL, as the backfill does. A present one that is not a safe integer inside INTEGER, or a premium outside DECIMAL(14,2), makes the bucket unusable.
  - **Surfacing.** An unusable bucket is *pending* while it ended under 10 minutes ago (UW is late: no metric) and *stuck* after that (`invalid_candle` plus one Sentry warning per run naming the oldest). A payload with no rows for today at 09:40 ET or later raises a Sentry **error** (stage `feed_stalled`: nobody reads a warning, and the daily P1.1 integrity cron covers `stuck_bucket`). A snapshot whose buckets are all zero, or all stuck, is rejected with a Sentry error. Once the day's last attempt has come (close + 5 min; 16:07 and 16:09 ET for the two crons) every unusable bucket is stuck, so a late final minute is reported, not silently lost. The quality check runs after any write.
  - Tests: replay the 09:27 payload (yesterday's rows) → nothing stored. Replay the 09:32 grid with null future minutes → only closed, non-null buckets stored. Write failure → the run is not `success`.
- **P0.2 Greek flow and the Take-It pin (F4, F17).**
  - `fetch-greek-flow.ts` + test: apply R-day (drops the pre-open 1DTE answer), and surface write failures (R4).
  - `api/_lib/takeit-features.ts` + test: the Take-It lottery input `spy_etf_diff`/`qqq_etf_diff` stays 0 for scoring, where live scores have been since 04-07, until the owner decides (open question 3). A continuity pin, not a restored training distribution. Stored fires get the real values; the `takeit_features` JSONB stores the pinned 0. Name the pin in a comment with this spec's path. Shipped on its own, ahead of the greek flow part of P0.2 (owner priority change, 2026-11-07).
- **P0.3 Strike exposures (F5, F6, F7).** `fetch-strike-exposure.ts`, `fetch-strike-all.ts` and tests.
  - Port the stale-cache guard and the `min_strike`/`max_strike` window from `fetch-gex-0dte.ts`.
  - Add the R-zero guard to `fetch-strike-exposure`.
- **P0.4 Derived and remaining zero guards (F7, F8, F14, F23).**
  - R-stale in `compute-zero-gamma.ts`.
  - R-zero in `fetch-gex-0dte.ts` and `fetch-spot-gex.ts`.
  - R-day in `monitor-flow-ratio.ts` (F23): keep only ticks stamped on today's ET date at or after 09:30 ET, and store no reading when there are none. Check `flow_ratio_monitor` for 09:25 to 09:32 ET rows first, since the finding is unverified.
  - Tests for each. Split if it passes 5 files.
- **P0.5 Market internals (F9, F10).** Find out first why `$ADD`/`$VOLD` read 0 from 04-16 and why `$TICK` bars are O=H=L=C=0.
  - Read `fetch-market-internals.ts` and its 04-15/16 history. Probe Schwab off-hours with the token in Upstash; the guard is 13:00–21:59 UTC weekdays.
  - Fix the cause, reject all-zero bars (R-null), and let the lookback replace a bar it got wrong (DO UPDATE inside the lookback window).
- **P0.6 Frozen market snapshots (F11).** Find out first why the live quote state stops updating on 11-02, 11-04 and 11-06.
  - Read `useSnapshotSave.ts`, the quote hooks and `api/snapshot.ts`.
  - Add a staleness guard. A snapshot whose quote time is more than 10 minutes behind its slot is not saved; the client sends the quote time and the server checks it.

**Tier 1: catch it without being asked**

- **P1.1 Integrity checks.** `api/_lib/data-integrity-checks.ts` holds the audits' checks as bounded SQL with thresholds:
  - wrong-day rows;
  - frozen grids (all-zero or all-NULL slots);
  - an all-zero snapshot, bar or column;
  - a series that doesn't move where it should (per-table expected-movement floor);
  - a constant feature column over N days;
  - a day's row count against the trailing 10-day median;
  - pre-open stale rows.

  It is used by:
  - a post-close cron, `api/cron/audit-data-integrity.ts`. It runs weekdays about 21:40 UTC and sends a Sentry warning per finding plus one Axiom event. It needs a `vercel.json` entry, a `SCHEDULE_MAP` entry and `withCronInstrumentation`.
  - a script, `scripts/check-data-integrity.ts --from --to`. Every backfill runs it before and after its full write.

  Tune the thresholds on the 06-01 → 11-05 history so today's clean tables raise nothing and every finding above raises.
- **P1.2 `training_features` builder (F16).**
  - Pick the snapshot by parsed time, not text, and drop `is_backtest` rows.
  - Fall back to `outcomes` and VIX data for the static features.
  - Check the date of the row `/options-volume` returns.
  - Add a rebuild mode that can clear a column instead of `COALESCE`-keeping it.
- **P1.3 Vol surface (F20).** Pass `date=`, check the row's own date, and skip market holidays.
- **P1.4 Backfill rule.** Add to the summer gap plan and `scripts/README.md` that a backfill's full write waits for `check-data-integrity` on a dry run, plus parity against live days, not only row counts.
  - Don't run the ETF tide or zero_dte_index backfills for any day until `flow-data-backfill.mjs` uses the window-end label. From the deploy of this fix (planned 2026-11-09) the live rows use it, and DO NOTHING would interleave the two conventions.

**Tier 2: repair history (owner approval for every DELETE or UPDATE; the predicates go to the owner first)**

- **P2.1 `flow_data`.**
  - Don't run the ETF tide or zero_dte_index backfills for any day until `flow-data-backfill.mjs` uses the window-end label. From the deploy of this fix (planned 2026-11-09) the live rows use it, and DO NOTHING would interleave the two conventions. The backfill scripts' headers say so.
  - Delete the ETF zero grid: `source IN ('spy_etf_tide','qqq_etf_tide') AND ncp = 0 AND npp = 0 AND net_volume = 0`, 18,738 rows.
  - Delete the greek-flow 1DTE rows: `source = 'zero_dte_greek_flow' AND (timestamp AT TIME ZONE 'America/New_York')::date <> date`, 11,342 rows.
  - Delete the `zero_dte_index` NULL slots from 04-02 on.
  - Then delete the ETF wrong-day rows (refetched next) and refill ETF tide, `zero_dte_index` and greek flow for 03-25 → the last finished day with `date=` backfills under the label rule. The P3.2 `backfill-etf-tide.mjs` exists; greek flow and zero-DTE index need the P3.3 retrofit.
  - Value-check each refill (P1.1) before it is written.
  - Under the window-end label rule, the earlier rows that carry UW's window-start label are shifted to it too, so one source never mixes two rules. That is ETF tide and `zero_dte_index` from 02-11 → 03-24 (`timestamp + 5 min`), with the same approval.
- **P2.2 Strike exposures and zero gamma.**
  - Delete the stale pre-open snapshots (F5) and the all-zero ladders (F7, `gex_strike_0dte` included), and the 42 known `gex_strike_0dte` strays.
  - Delete `zero_gamma_levels` rows computed from a stale or frozen source (F8).
  - Frozen days (F6): record the dates as known-bad in this spec. Default: no refill, because the endpoint serves one snapshot per past date.
- **P2.3 Market internals.** Delete the zero bars, then refill from Schwab price history as far back as it serves. Record the span that can't be refilled.
- **P2.4 Derived rebuilds.**
  - Rebuild `training_features` and `day_labels` from 04-02 (P1.2's rebuild mode).
  - Re-derive `lottery_finder_fires.spy_etf_diff`/`qqq_etf_diff` from the repaired rows with the 30-minute as-of rule, batched per date.
  - `futures_snapshots` 04-12 → 09-28: recompute from `futures_bars` where bars exist, else delete the frozen rows.
  - `market_snapshots`: delete or flag the frozen and wrong-date rows (F11, F12).
  - `oi_changes`: delete the 29 copied days (F21).
  - `vol_*`: delete the holiday rows.
  - `cone_levels`: recompute or delete the 2 bad rows.
- **P2.5 Summer `flow_data`** (P3.2 of the summer plan). Write with the label rule once open question 1 is answered. The value check of all 33 days through the backfill code is done and clean (`runs/p32-uw-summer.log`).

**Tier 3: owner decisions** (open questions below).

## Files

- **Tier 0:**
  - `api/cron/fetch-etf-tide.ts`, `fetch-zero-dte-flow.ts`, `fetch-greek-flow.ts`
  - `api/cron/fetch-strike-exposure.ts`, `fetch-strike-all.ts`, `compute-zero-gamma.ts`, `fetch-gex-0dte.ts`, `fetch-spot-gex.ts`, `fetch-market-internals.ts`
  - `api/_lib/takeit-features.ts`, `api/snapshot.ts`
  - `src/hooks/useSnapshotSave.ts` (and the quote hook it reads)
  - their tests
- **Tier 1:**
  - `api/_lib/data-integrity-checks.ts`, `api/cron/audit-data-integrity.ts`, `scripts/check-data-integrity.ts`
  - `vercel.json`, `api/_lib/cron-schedules.ts`
  - `api/_lib/build-features*.ts`, `api/cron/fetch-vol-surface.ts`
  - tests
- **Tier 2:** backfill scripts under `scripts/` (P3.3 retrofits), plus one-shot repair scripts with dry-run defaults.

## Data dependencies

- No new tables. P1.1 may add an `audit-data-integrity` Sentry monitor by hand (rule 6262822 routing).
- UW REST for refills (~300 ETF requests, ~300 greek flow, ~300 zero-DTE index), off-hours only.
- Schwab price history for `market_internals` and the probe in P0.5, outside 13:00–21:59 UTC on weekdays.

## Open questions (defaults in force until the owner answers)

1. **Label rule.** Should a stored closed-window value carry the window's end time (default), or UW's window start? Window-end gives replays no lookahead and matches live rows to within about 1.5 min. The summer `flow_data` write waits for this answer. The P0.1 live ETF fix uses the default; a later "start" answer means shifting those rows back 5 minutes with one UPDATE.
2. **DELETE approval.** Tier 2 deletes production rows. Each phase's predicates and counts go to the owner before running. Nothing is deleted until then.
3. **Take-It lottery.** Live scoring has been fed `spy_etf_diff = qqq_etf_diff = 0` on every fire since 04-07, but the model was not trained on 0 alone. The training SQL has no date floor; the parity fixture's 50 production rows hold 18 real, 19 null and 13 zero values for each column; the bundle splits 116 times on `spy_etf_diff` and 95 times on `qqq_etf_diff`, at real thresholds (such as -179,339,250). So feeding real values is in-distribution too. Whether the model reads a zero as a post-April flag is unverified. Options:
   - **Default:** P0.2's pin, which keeps feeding 0 (continuity with live scores since 04-07).
   - Retrain on repaired data.
   - Drop both features in the next retrain.

   Until this is decided, do not run `scripts/backfill_takeit.py`. It scores in Python through `build_training_set.load_lottery` with the stored columns, bypasses the pin, and would feed real values (every historical row once P2.4 re-derives them). `scripts/backfill-takeit-scores.mjs` and `scripts/replay-lottery-fires-2026-05-18.ts` score through `scoreLottery` and inherit the pin.
4. **Live in-progress snapshots.** Live market tide and net flow store a snapshot 20–90 s into each window, frozen by DO NOTHING. Default: leave them, since they fit the label rule.
5. **Frozen strike-exposure days (F6).** Default: no refill; mark them known-bad.

## Thresholds / constants

- **Session gate:** 09:30 ET for the session series. UW rolls over 09:28–09:32 ET.
- **Bucket:** 5 minutes. A bucket is closed when `bucket_end + FINAL_LAG_MS ≤ now`.
- **`FINAL_LAG_MS`:** 90 s. An operational margin, not a guarantee: UW fills a minute after it ends, and the upsert heals a later revision.
- **Pending and stuck:** an unusable closed bucket is pending for 10 minutes after its end (no metric, no alert) and stuck from then on (`invalid_candle` and a Sentry warning per run), or from close + 5 min (the day's last attempt) whatever its age.
- **Stalled feed:** no rows for today's session at 09:40 ET or later raises a Sentry error. UW rolls over 09:28 to 09:32 ET, so an empty answer before 09:40 is normal.
- **Tide cron window:** 09:25 ET to 10 minutes after the close, for `fetch-etf-tide` and `fetch-zero-dte-flow` (the default gate is 5 minutes after).
- **Source age for derived writers:** 15 minutes.
- **Snapshot quote staleness:** 10 minutes.
- **All-zero floor:** every value column zero across the snapshot. For `flow_data` days, the P3.2 floor: 10 rows.
- **Integrity-check thresholds:** tuned in P1.1 on 06-01 → 11-05 and recorded here as built.
