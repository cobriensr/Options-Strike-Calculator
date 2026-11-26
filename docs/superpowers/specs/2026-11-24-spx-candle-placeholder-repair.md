# SPX and NDX 1-minute placeholder candle repair — 2026-11-24

## Goal

Replace the placeholder SPX and NDX one-minute bars in `index_candles_1m` with correctly scaled bars, fill the days that have none, and rebuild the stored values computed from them.

- The owner approved the fix on 2026-11-24 ("yeah lets fix this").
- The owner also approved the 4.1/4.2 code changes, plus each production step after its dry run and checks ("approve and OK").
- This spec takes over items 4.1–4.4 of `docs/superpowers/specs/2026-11-16-handoff-lottery-scoring-and-data-repairs.md`.
- The spec had two spec-reviewer passes (both "revise"). Every finding is settled below except the open questions at the end.

## Findings (verified read-only on production, 2026-11-24)

**SPX placeholder span.**
- 2026-02-25 has 48 post-market rows only.
- 2026-02-26 → 04-09 are whole days (pre, regular, post).
- 2026-04-10 is placeholder through the 13:10 ET bar. Real bars start at 13:11 ET (17:11Z), after the cron fix `e9d12edb8` deployed.
- Writers: the rows came from the old `scripts/backfill-spx-candles-1m.mjs` (`SPY_TO_SPX_RATIO = 10`), run 2026-04-09 05:11–05:25 UTC, and from the live cron until `e9d12edb8`.
- Evidence:
  - Every regular minute that has an SPY bar (03-18 → 04-10) is exactly SPY × 10.0000. The per-day median is 10.000, against 10.03–10.04 on every other date.
  - 75–86% of closes have one decimal.
  - The true close is about placeholder × 1.0013–1.0042 (median 1.0026), which is 8.6–26.8 pt low.
- `spx_schwab_price` is NULL on these rows, but that is not evidence of a placeholder. The column was added by migration #54 on 2026-04-10, after these rows, so the real 04-10 rows from 13:11 ET are NULL too. Only the timestamp clause separates them.

**NDX placeholder span.**
- Every NDX row from 2026-03-23 to 05-01 comes from one batch, written 2026-05-03 23:21–23:36 UTC by the deleted `scripts/backfill-ndx-candles-1m.mjs` (`cc2bdc28e`, ×48).
  - The script was recalibrated to ×41 twelve minutes later (`21ceed76b`). Its re-run used `ON CONFLICT DO NOTHING`, so it replaced nothing.
- Wherever the QQQ row is a final bar, the NDX row is exactly QQQ × 48. On 04-28 → 05-01 the QQQ rows are frozen partial bars, so exact matches drop to about a third, but the per-day median is still 48.000.
- The real NDX/QQQ ratio is 41.06–41.14, so these rows sit about 17% (~4,000 pt) high.
- Live rows with a Schwab ratio start 2026-05-04.

**No placeholders elsewhere.** The check is the per-day median of index ÷ ETF close over regular minutes, 03-18 → 11-24. It is robust to frozen partial ETF bars. Only the two windows above fall outside SPX 10.005–10.06 / NDX 41.0–41.25. Before 03-18 there is no SPY row to compare with.

**Missing index rows** (SPX and NDX).
- 2026-09-22 → 09-30 and 10-08 → 10-15 have no rows (13 days).
- 09-21 has 169 of 390 regular bars; the live feed stopped at 12:18 ET.
- No other date has a regular-bar count other than 390.
- SPY and QQQ rows exist on every one of these days.
- The cron writes nothing without a Schwab quote. A login lapse is the likely cause; it is unverified.

**Sources.**
- **UW `/api/stock/{SPY|QQQ}/ohlc/1m?date=`.** Final bars, reachable back to 02-25 (Phase 0). UW refuses index tickers (422).
- **Schwab daily `pricehistory`** for `$SPX`, `SPY`, `$NDX` and `QQQ`. This is the per-day close ratio the current backfill uses (`scripts/_lib/candles-backfill.mjs`: `fetchSchwabDailyCloses`, `ratioFor`).
- **UW Full Tape in R2** (2026-01-02 → 11-23).
  - Each SPXW print carries `underlying_price`. NDXP and NDX prints carry none. The tape covers regular hours only.
  - It is the independent check for SPX. Up to 2026-05-01 it uses the old layout: naive UTC `executed_at`, DECIMAL numerics.
- **`etf_candles_1m`** SPY/QQQ.
  - 03-18 → 04-27 are final bars from the ETF backfill (`a93ea9cbf` counted "today" in UTC, so it reached 04-27).
  - 04-28 → 10-26 are frozen partial bars from the live cron (D1c, `docs/superpowers/specs/review-remediation-2026-10-26.md`). That covers every gap day.
  - The dark-pool mapping divides an index bar by the same-minute ETF bar (`api/_lib/dark-pool-query.ts:140-190`).
- **`outcomes.settlement`**: the true SPX close for every date here.

**What is stored from these rows** (Phase 0 probe 4, every writer of `index_candles_1m` traced):

| Table | Affected | Rebuildable? |
| --- | --- | --- |
| `training_features` `dp_*` (7 columns, through `getDarkPoolLevels('SPX')`) | 03-23 → 04-10 (14 dates; 03-26 has failed to rebuild since March), 09-21 (partial bars), 13 gap days (dp NULL) | Yes: `build-features?date=` |
| `training_features` `dp_*`, 02-25 → 03-20 | 18 dates hold values copied from the dropped `dark_pool_levels` table (migration #120). `dark_pool_prints` starts 03-23 | No (no prints), see open question 3 |
| `ws_gamma_setup_fires` (the fires themselves, `bar_*`, `spot_at_fire`, `ret_*`) | 159 fires 02-27 → 04-10. Fires 04-13 → 04-17 carry `prior_5d_ret`/`pre_day_filter_fires`/`confidence_tier` from placeholder closes. 12 fires on 09-21 were scored to the 12:18 bar | Yes, with script flags (Phase 2b) |
| `periscope_lottery_fires` `spot_at_event`, `strike_dist` | 1,998 gap-day fires carry a stale spot: the 09-21 12:18 close for 09-22 → 09-30, the 10-07 close for 10-08 → 10-15. The spot lookup has no date bound (`api/_lib/periscope-lottery-finder.ts:130-132, 508-510`) | In place only. The script can't rebuild puts (`ws_option_trades` keeps 2 days) |
| `flow_regime_0dte_daily` | 09-21 (partial bars). The gap days have no IV, so they can't be built | 09-21, with script flags (Phase 2b) |
| `day_embeddings` (v1) | 09-21 row from 169 bars (summary and OHLC/labels); the 13 gap days have no row | Yes: `embed-yesterday?date=` plus `fetch-day-ohlc?date=` (Phase 2b) |
| NDX | Nothing stored; read at request time only | No rebuild needed |
| `periscope_analyses.realized_*`, `periscope_grades` | 0: all 458 analyses are dated 05-06 → 05-26, and grades are keyed to them | — |
| `day_labels`, `outcomes`, `cone_levels`, `interval_ba_alerts`, `lottery_finder_fires`, `silent_boom_alerts` | Not computed from these candles | — |
| `cone_breach_events`, live gamma detection on gap days, `analyses` prose | Live-only or LLM output | No: noted, not repaired |

## Phase 0 results (2026-11-24, read-only)

1. **UW depth is ok.** ETF dry run for 02-25 → 02-26: 1,718 and 1,726 bars, none dropped. Index dry run for 02-25 → 04-10: 32 of 32 days.
2. **Schwab daily closes are ok** for all 32 days, equal to `outcomes.settlement`.
   - SPX/SPY is 10.012–10.028 through 03-19, then 10.032–10.044 from 03-20 (SPY ex-dividend).
   - NDX/QQQ is 41.06–41.14.
3. **NDX and placeholder scans:** see Findings.
4. **Stored derivatives:** see the table above.
5. **Tape vs stored closes** (`candle − tape`, last SPXW print per minute, 390 regular minutes):

   | Date | Bars | Mean | Median \|d\| | p95 | Max |
   | --- | --- | --- | --- | --- | --- |
   | 2026-08-12 | backfilled 11-06 with this method | +0.89 | 0.95 | 1.45 | 2.34 |
   | 2026-04-14 | live, frozen partial | −0.06 | 0.43 | 1.68 | 4.08 |
   | 2026-10-20 | live, frozen partial | −0.00 | 0.32 | 1.60 | 4.90 |
   | 2026-03-26 | placeholder | −25.24 | 25.14 | 26.20 | 27.46 |

   The gate is calibrated on 08-12, the same method. The live rows are a comparison only.
6. **The 11-22 snapshot-trust blanking run** (`docs/superpowers/specs/2026-11-22-feature-snapshot-trust-design.md`) is not built or applied: no script and no run output. Its row-pick fix shipped (`2a7c29faf`).

## Decisions

1. **Method.** UW ETF final bars × the per-day Schwab daily-close ratio: SPX from SPY, NDX from QQQ. This is the owner-approved 2026-11-05 method. The tape is the check, not a source; it has no pre/post-market bars or volume.
2. **One repair tool, atomic per date and symbol.**
   - **Files.** `scripts/repair-index-candle-placeholders.mjs` is the CLI. `scripts/_lib/index-candle-repair.mjs` holds the logic and reuses `candles-backfill.mjs`'s fetch and mapping.
   - **Selection.**
     - `--symbol SPX|NDX` is required.
     - Add `--list spx-repair|ndx-repair|ndx-fill|gap`, or `--date D` (it must belong to a list).
     - The lists, explicit and with no range touching other days:
       - `spx-repair`: the 32 trading days 02-25 → 04-10;
       - `ndx-repair`: 03-23 → 05-01;
       - `ndx-fill`: 02-25 → 03-20, insert only;
       - `gap`: 09-21 → 09-30 and 10-08 → 10-15, both symbols, insert only.
   - **Per date:**
     1. Fetch the UW bars and the Schwab ratio.
     2. Map them, then **verify before writing.** The mapped regular-bar count must equal `cashSessionMinutes(date)`. For SPX, the last regular close must be within 4 pt of `outcomes.settlement`. For NDX, it must be within 15 pt of the Schwab `$NDX` daily close.
     3. A failed or empty fetch, a missing ratio, a guard refusal or a failed check skips the date untouched and reports why.
     4. Only then does one transaction delete that date's placeholder rows for the symbol and insert the mapped rows `ON CONFLICT DO NOTHING`.
   - **Delete predicate.** One exported function:
     - SPX: `date` in the list, `created_at < '2026-04-11'`; on 04-10 also `timestamp < '2026-04-10T17:11:00Z'`.
     - NDX: `date` in the list, `created_at` within 2026-05-03 23:00–23:59 UTC.
     - The `created_at` cuts make re-runs safe: repaired rows are never selected.
   - **Backup.**
     - Before the transaction, write the rows about to be deleted to JSONL with every column (`id` and `created_at` included). Add a manifest with the date, the symbol, the counts and the inserted keys.
     - It goes to the main checkout's `docs/tmp/spx-candle-repair/`, found from a worktree via `git rev-parse --path-format=absolute --git-common-dir`, then its parent. That folder is local and gitignored, and it survives worktree pruning.
     - If the write fails, nothing is deleted.
   - **Undo** (`--undo <manifest>`). One transaction deletes the keys the manifest recorded as inserted, then re-inserts the backup rows with their original `id` and `created_at`, so a later repair still selects them.
   - **Defaults and guards.** Dry run by default: it prints per date the delete and insert counts and the ratio. `--apply` writes. It keeps the backfill guards: 08:15–15:30 CT, and 13:00–22:59 UTC for the Schwab token.
   - **Tests** (pglite, an `index_candles_1m` subset):
     - each predicate clause, including 04-10 at 17:10Z (selected) and 17:11Z (kept);
     - re-run safety;
     - each of these skips the date (R4): a failed, empty or short UW answer; a missing ratio; an SPX close more than 4 pt from `outcomes.settlement`; no `outcomes` row;
     - `--lottery-spots`: only in-scope rows are selected, outcome, `trade_strike` and `entry_px` are untouched, the backup is written before the UPDATE (a failed write changes nothing), the dry run writes nothing, and its undo restores the old spot and distance;
     - an unwritable backup deletes nothing;
     - a DB reject mid-date rolls back;
     - the undo restores the exact rows with their `created_at`;
     - the dry run writes nothing.
3. **ETF bars.**
   - Before the index repair, run the fill-only `scripts/backfill-etf-candles-1m.mjs` on every repaired date. It adds SPY/QQQ for 02-25 → 03-17 and fills any holes.
   - **Accepted, documented here:** on 04-28 → 05-01 and the gap days the ETF rows are frozen partial bars, while the new index bars come from final bars. The dark-pool SPX/SPY per-minute ratio there is therefore not exactly constant until D1c's frozen-bar repair (out of scope).
4. **The tape check tool.**
   - `scripts/verify_index_candle_repair.py` runs in `ml/.venv`. It reads the tape through `ml/src/utils/r2.py` (DuckDB, old and new layout) and Postgres read-only.
   - **Gates** (repaired regular minutes only):
     - SPX `candle − tape` median |d| ≤ 2 pt and p99 ≤ 5 pt;
     - stored index ÷ ETF close equal to the day's Schwab ratio within 1e-6 on ≥ 99% of minutes, only where the ETF rows are final bars (≤ 04-27);
     - **No NDX tape check.** UW leaves `underlying_price` NULL on every NDXP and NDX print: on 2026-11-20, 40,526 and 5,823 prints, none with a price; checked 2026-11-25. NDX is verified by the repair tool's close check (Schwab `$NDX`, 15 pt) and its ratio check.
   - The comparison function has a pytest test, `scripts/test_verify_index_candle_repair.py`, so CI's `scripts/test_*.py` glob runs it.
   - It is not `scripts/_tape_reader.py`, which is a nightly watch path.
5. **Canary.**
   - 2026-03-26: SPX, then NDX, then the tape tool.
   - On a pass, run the rest of `spx-repair`, then `ndx-repair`, `ndx-fill` and `gap`.
   - Spot-check with the tool:
     - 02-26;
     - 04-10 (minutes before 13:11 ET only);
     - 04-20 (NDX);
     - 10-09 (gap; tape gate only, since its ETF rows are frozen).
   - Gamma-script and lottery steps run after 15:00 CT, never during a session.
6. **Code fixes.**
   - **1a (handoff 4.2).** `dp_support_resistance_ratio` and `oic_oi_change_pcr` become NULL, written explicitly, when the value **rounded to 4 places** has |v| ≥ 10,000. Tests use 9,999.99996.
     - The guard only prevents the overflow. `oic_oi_change_pcr` stays under the keep-the-old-value rule (`build-features-upsert.ts:418`), so a guarded NULL keeps any stored value; 03-26 has none because that row never saved.
   - **1b (handoff 4.1, narrowed).** The 7 `dp_*` columns are overwritten on rebuild, NULLs included, only when all three hold (and the date has an `spx_open`, below):
     1. the dark-pool read succeeded (today a failure is caught and logged, `build-features-phase2.ts:387-390`);
     2. the date has at least one `dark_pool_prints` row;
     3. the date has the full `cashSessionMinutes` of SPX regular bars in `index_candles_1m` **and** of SPY bars in `etf_candles_1m`. The levels query joins both.

     Otherwise they keep the old value.
     - A failed read sets the run status to `partial`, even on a one-date run. So does a failed check of the day (`dpDayComplete`, below): it is a read of the dp signal too.
       - The cron sets it by hand in its result, over `success` only. It never lifts an `error`.
       - It is not counted in `errors` or run through `deriveCronStatus`: the row was written, and one date of one would read as `error`, a failed write.
       - A date whose read failed is listed in metadata `dpReadFailed`, which says why a run is `partial` with `errors: 0`.
     - No prints, short bars, or no `spx_open` is a data state, not a failure: the status is unchanged and the date is listed in metadata `dpKept`.
       - The open is a fourth condition the cron checks itself (`features.spx_open != null`, the test the dark-pool step applies). Without it, top-cluster distance, support, resistance and their ratio are left unset, and an overwrite would store NULL over their values though the levels are all there. `spx_open` comes from the trusted snapshot row, else `outcomes.day_open`, so a date has none only when both are missing.
       - Both lists are in the HTTP response as well as the run metadata, so a `?date=` rebuild shows whether its date is kept. In Axiom they sit inside `meta`, never as top-level keys.
     - This keeps the 18 legacy dates (02-25 → 03-20, no prints; owner decision: leave them) safe from every later rebuild path, `?backfill=true` and the 11-22 blanking run included. It also keeps a future candle hole from blanking good values.
     - **Signal path.**
       - `engineerPhase2Features` returns `{ dpReadOk: boolean }`: true when `getDarkPoolLevels` resolved with no caught error (no rows is still true). It is not a `FeatureRow` key, so `computeCompleteness` is unchanged.
       - A separate `dpDayComplete(sql, date)` in `build-features-phase2.ts` makes one query for conditions 2 and 3: a SPY row in `dark_pool_prints`; `cashSessionMinutes(date)` SPX bars with `market_time = 'r'`; and as many SPY bars in `etf_candles_1m` with `09:30 ET ≤ timestamp < close` (`getMarketCloseHourET`, 13:00 on a half day), as that table has no date or `market_time`. A day with no cash session is not complete.
       - The cron calls it after `engineerPhase2Features`, only when the read worked and the date has an `spx_open`, then passes `{ overwrite: dpReadOk && complete ? DP_COLUMNS : [] }` to `upsertFeatures(features, …)`. A check that rejects counts as a failed read. The upsert writes `EXCLUDED.<col>` for those columns and keeps `COALESCE` for the rest.
     - Every other column keeps today's rule, including the snapshot-derived ones the 11-22 blanking run owns, so this repair doesn't settle handoff 4.5. Extending the overwrite to other own-table columns is later work.
     - **Accepted side effect, documented here.** 10 of the 14 rebuilt March–April dates are 11-22 no-pick dates: 03-23, 03-26, 03-27, 03-30, 03-31, 04-01, 04-02, 04-06, 04-07 and 04-10. The shipped pick fix (`2a7c29faf`) makes any rebuild of those dates write `feature_completeness = 0` (`api/cron/build-features.ts:497-498`), which takes them out of training. That is the 11-22 design's intent; Phase 4's backup keeps the old rows. The blanking run, when it is built, must read its rows after Phase 4, or its md5 guard will refuse them.
   - **1c.** The Periscope lottery spot lookup (`periscope-lottery-finder.ts:130-132, 508-510`) is bounded to the event's own session date. A hole on a new day then yields no spot (no fire), not a days-old one. Whether to also cap the spot's age within a day is open question 4.
7. **Script flags (Phase 2b), each with tests.**
   - **`scripts/backfill-gamma-setup-fires.ts`.**
     - `--dry-run` prints per-date fire counts and writes nothing. It reads no `ws_gamma_setup_fires` rows, so it can run before the delete.
     - `--outcomes-only` skips detection and insertion, then recomputes `ret_*` for the fires in `[--from, --to]`. That window is not clamped to the GEXBot cutover, because no detection runs.
     - Every outcome fill is limited to the `--from/--to` window.
     - An unknown flag is an error.
     - Its logic moves into a `scripts/_lib` module so it can be tested; today `main()` runs at import.
   - **`scripts/backfill-regime-0dte.ts`** gets `--from/--to`, with the same move to `scripts/_lib`.
   - **`api/cron/fetch-day-ohlc.ts`** gets `?date=`, with the same validation as `embed-yesterday`.
8. **Rebuilds (Phase 4).** Each runs after its dry run and the read-only backup of every row it will touch (JSONL in `docs/tmp/spx-candle-repair/`).
   - **`training_features`/`day_labels`.** `build-features?date=` for the 28 SPX-changed dates: 03-23 → 04-10, 09-21, and the 13 gap days. Then resolve Sentry `SENTRY-EMERALD-DESERT-MB`.
   - **`ws_gamma_setup_fires`, 02-26 → 04-17** (owner OK: rebuild).
     1. Run `--dry-run` first.
     2. Show the owner its per-date fire counts next to the stored ones, before anything is deleted. Changes are expected, because the bars changed and ES was repaired on 11-12 → 11-16. A date that loses every fire, or gains more than double, gets checked first.
     3. Back up and delete the window's fires.
     4. Re-run.
   - **The 12 fires on 09-21.** Back up, set their `ret_*` to NULL, then run `--outcomes-only --from 2026-09-21 --to 2026-09-21`.
   - **`flow_regime_0dte_daily`.** `backfill-regime-0dte.ts --from 2026-09-21 --to 2026-09-21`. Compare its printed 09-21 row with the stored one before `--apply`.
   - **`day_embeddings`.** `embed-yesterday?date=` then `fetch-day-ohlc?date=` for 09-21 and the gap days.
   - **`periscope_lottery_fires`, `--lottery-spots`.** This is in `scripts/repair-index-candle-placeholders.mjs`, dry run first.
     - Scope: the fires on 09-22 → 09-30 and 10-08 → 10-15, plus 09-21's fires after 16:18Z (12:18 ET), which read the 12:18 close.
     - It runs a backed-up UPDATE of `spot_at_event` and `strike_dist` from the repaired candles. Outcome columns, `trade_strike` and `entry_px` are untouched.
     - It reports how many fires no longer pass their own filter (owner decision: keep them and report the count). Events the stale spot wrongly filtered out can't be added back.

## Phases (each ≤ 5 files)

| Phase | What | Files |
| --- | --- | --- |
| 0 | Probes | done |
| 1a | Overflow guard (4.2) | `api/_lib/build-features-phase2.ts` and its test |
| 1b-i | Upsert `overwrite` option | `api/_lib/build-features-upsert.ts`, `api/__tests__/build-features.test.ts` |
| 1b-ii | Dark-pool overwrite signal, cron wiring | `api/_lib/build-features-phase2.ts`, `api/cron/build-features.ts`, their tests |
| 1c | Same-day bound on the lottery spot | `api/_lib/periscope-lottery-finder.ts` and its test |
| 2 | Repair tool, including `--lottery-spots` | `scripts/repair-index-candle-placeholders.mjs`, `scripts/_lib/index-candle-repair.mjs`, its test |
| 2a | Tape check tool | `scripts/verify_index_candle_repair.py`, `scripts/test_verify_index_candle_repair.py` |
| 2b-i | Gamma script flags | `scripts/backfill-gamma-setup-fires.ts`, a new `scripts/_lib` module, its test |
| 2b-ii | Regime script flags | `scripts/backfill-regime-0dte.ts`, a new `scripts/_lib` module, its test |
| 2b-iii | `fetch-day-ohlc ?date=` | `api/cron/fetch-day-ohlc.ts`, its test |
| 3 | ETF fill, canary, the rest, the gap fill | production writes |
| 4 | Rebuilds | production writes |

Phases 2, 2a and 3 don't depend on Phase 1. Phase 4 depends on 1a, 1b, 1c and 2b. A writing-plans plan turns these phases into tasks. `outcomes.settlement` exists for 09-21 and all 13 gap days (checked 2026-11-24), so the in-tool close check runs on every date.

## Thresholds

| Constant | Value | Why |
| --- | --- | --- |
| In-tool check | regular bars = `cashSessionMinutes`; SPX close within 4 pt of `outcomes.settlement`; NDX close within 15 pt of the Schwab `$NDX` close | 11-06: ≤ 4 pt, median 0.4; 15 pt is the same 0.06% at NDX |
| Tape check (SPX only) | median \|d\| ≤ 2, p99 ≤ 5 | 08-12 (same method): median 0.95, max 2.34. 11-20 (live, after the fix): median 0.67, one outlier minute at 25.3, which is why the gate uses p99. The placeholder's median is 25.1 |
| Ratio check | within 1e-6 on ≥ 99% of minutes, ETF final bars only | the method writes ETF bar × ratio exactly |
| 04-10 cut | `timestamp` < 17:11Z | first real bar |
| `created_at` cuts | SPX < 2026-04-11; NDX within 2026-05-03 23:00–23:59 UTC | the placeholder batches |
| Feature guard | \|round4(v)\| ≥ 10,000 gives NULL | NUMERIC(8,4); the largest real value is 1,471 |

## Out of scope

- The frozen partial bars from before 2026-10-26 (D1b/D1c/D1h).
- Handoff 4.5 (the `market_snapshots` placeholder rows) and the 11-22 blanking run.
- `training_features.spx_open` on 03-06 (snapshot-derived).
- Live-only gap-day losses: cone breaches, gamma detection, the regime rows for the 13 empty days.

## Owner decisions (2026-11-24)

1. **`ws_gamma_setup_fires` 02-26 → 04-17: rebuild,** after the dry-run count comparison.
2. **Gap-day `periscope_lottery_fires`: keep them and report the count.** Update the spot and distance; keep every fire, including those that no longer pass their filter.
3. **The 18 legacy dark-pool dates (02-25 → 03-20): leave them.** Rule 1b keeps them safe from every rebuild path.

4. **No age cap on the lottery spot within a day: the same-day bound only** (owner, 2026-11-25). A hole later in the same day can still yield a spot hours old. A cap would skip live events while the candle feed lags.

## Review history

- Three spec-reviewer passes, each "revise". All author findings are settled in this doc. The last pass's owner-marked items became decisions 1–4.
- The implementation plan is `docs/superpowers/plans/2026-11-25-spx-candle-placeholder-repair.md`.
