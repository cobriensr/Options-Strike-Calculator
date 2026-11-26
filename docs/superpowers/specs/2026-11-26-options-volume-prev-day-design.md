# Options-volume features: previous day for morning models, same day as a record

## Goal

The `opt_*` features in `training_features` hold a day's SPX options volume, premium and open interest. The volume and premium are **full-day** totals, known only after the 16:00 ET close, so a model that decides at 10:00 CT must not read them. This change gives morning models the **previous trading day's** totals, keeps the same-day totals as an end-of-day record, and repairs the stored history.

## Owner decision (2026-11-25, ~22:00 CT)

**A + C.**

- **A:** morning models read the previous trading day's full-day totals.
- **C:** same-day totals stay only as an end-of-day record, which morning models never read.

Rejected: **B**, today's flow up to 10:00 CT. It would need a new intraday collector.

**Open interest.** Same-day open interest turns out not to be look-ahead (see Facts). The owner chose (i) on 2026-11-26: morning models read today's open interest and yesterday's volume and premium (see "Owner question" below).

## Why

- `addOptionsVolumeFeatures` (`api/_lib/build-features-phase2.ts`) writes the same day's values at the 16:45 ET daily build (`vercel.json` `45 20,21 * * 1-5`, gated to 16:30–18:00 ET).
- `ml/src/phase2_early.py:160` and `ml/src/clustering.py:151` put all 15 columns (`OPTIONS_VOLUME_FEATURES`, `ml/src/utils/__init__.py:84-100`) into models whose docstrings say they use "T1–T2 (first hour) features". For volume and premium, that is look-ahead.
- No live or prediction-time reader exists, so nothing live is affected:
  - `src/`, `sidecar/`, `nightly/`, `uw-stream/`, the day-analogs `features` backend and the analyze context read no `opt_*` column;
  - the ML pipeline has been disabled since 2026-04-16.
- The history is also wrong. Until 20b25329d (2026-11-25 15:20 CT, which picks the row by its own date; 1fc6ff57f added the miss report), every build of a past date stored UW's newest row, because the endpoint has no `date` parameter.
  - 112 of 159 days with values hold another day's numbers.
  - The 32 trading days 2026-10-01 to 2026-11-13 all hold 2026-11-13's real totals (253308 calls / 364885 puts). The real 10-01 was 147834 / 281164.

## Facts this design rests on (checked 2026-11-26)

- **The source:** UW `/stock/SPX/options-volume?limit=N` returns the newest N rows, newest first, each with its own `date`.
  - On 2026-11-26, `limit=500` returned 500 rows, 2026-11-25 back to 2024-11-27, with no duplicate dates.
  - There is no 30-trading-day cap on this endpoint. `isWithinUWWindow` (44 calendar days) is our own limit, kept from endpoints that do 403 older dates.
  - The raw reply is saved, with owner OK, at `docs/tmp/opt-volume/spx-options-volume-limit500-2026-11-26T04-01-38-881Z.json` (gitignored).
- **The history to repair:** `training_features` holds 227 dates, 2026-01-02 to 2026-11-25 (production, 2026-11-26).
  - Every one lies inside the reply's span.
  - Every weekday that isn't a holiday from 2025-02-18 on has a reply row.
  - The oldest date's previous day, 2025-12-31, is inside the part of the span where `MARKET_CLOSED_DATES` is complete. It lacks some 2025-01/02 holidays, which only matters for dates before 2025-02-18.
- **What each field means in time** (read from the data, not UW's docs):
  - **Open interest is as of the open.** `call_open_interest` and `put_open_interest` for date D are D's opening open interest. In five monthly expiries the drop lands on the next session's row, not on expiry day:
    - 2026-09-18 → 09-21: 8,536,514 → 6,206,645 calls;
    - also 10-16 → 10-19, 11-20 → 11-23 and 03-20 → 03-23;
    - and a Thursday expiry, 06-18 → 06-22.

    So `opt_call_oi`, `opt_put_oi` and `opt_oi_pcr` are known before the open.
  - **Volume, premium, ask/bid volume** are the full day's, known after the close.
  - **`avg_30_day_*` leaves out the day itself.** It equals the mean of the 30 prior rows exactly (11-25: 277136.4333; also 11-24 and 10-01). The `*_vs_avg30` ratios still leak through their same-day numerator.
- **The upsert:** `build-features-upsert.ts:388-402` writes every `opt_*` as `COALESCE(EXCLUDED.col, training_features.col)`.
  - A rebuild overwrites a column with a new non-null value, but never clears one.
  - The COALESCE assertions are tested in `api/__tests__/build-features.test.ts:1442-1494`. There is no upsert test file of its own.
- **Completeness:** the 15 columns are in `NULLABLE_FEATURE_KEYS` (`build-features-upsert.ts:48-62`), so they never count toward `feature_completeness`.
- **Trading days:** `priorTradingDay(date)` (`src/data/marketHours.ts:230-243`) exists, skips weekends and `MARKET_CLOSED_DATES`, and is used server-side (`api/yesterday.ts`, `api/history.ts`). build-features doesn't import it yet.
- **The column types:** migration #24 created the columns.
  - Integers: `opt_call_volume`, `opt_put_volume`, `opt_call_oi`, `opt_put_oi`, `opt_call_vol_ask`, `opt_put_vol_bid`.
  - DECIMAL(14,2): `opt_call_premium`, `opt_put_premium`, `opt_bullish_premium`, `opt_bearish_premium`.
  - DECIMAL(6,4): `opt_vol_pcr`, `opt_oi_pcr`, `opt_premium_ratio`, `opt_call_vol_vs_avg30`, `opt_put_vol_vs_avg30`.
  - The largest ratio in the reply is 3.03, so DECIMAL(6,4) doesn't overflow.
- **Migrations:** production has applied every migration through #212, so #213 would be the only one pending. Both apply paths (`scripts/migrate-db.ts`, `scripts/run-pending-migrations.mts`, `/api/journal/migrate`) apply *all* pending migrations. Re-check the pending list right before asking the owner.
- **Deploy order:** a deploy doesn't run migrations. If the writer ships before #213 exists, every `upsertFeatures` call throws, `api/cron/build-features.ts:644-666` counts each date as an error, and the day's row isn't written.

## Approaches for A

1. **The server writes previous-day columns (chosen, author's call).** build-features also writes `prev_day_opt_*`, the same 15 features computed from the previous trading day's row in the same UW reply. Morning models read those.
   - It matches how every other prior-day feature works today: `prev_day_range_pts`, `prev_day_direction` and `prev_day_vix_change` are server-written, and the ML only reads them.
   - Every consumer gets a point-in-time value by construction. That includes the ML export endpoint, and any future live model.
   - It costs one migration and no extra UW calls.
2. **The ML lags the same-day columns by trading date.** No migration. But every consumer must remember to lag, and must join on the previous trading date, not on the row above, or a missing day hands a model the wrong one. The export would carry only the leaking columns.
3. **Rename the same-day columns** (`opt_*` to `eod_opt_*`) and add the previous-day ones under the old names. Readers that don't change would silently switch meaning. Rejected.

## Owner question: which open interest do morning models read?

**Decided (owner, 2026-11-26 ~01:00 CT): (i).**

Under A as decided, a morning model reads the previous day's open interest. Because open interest is as of the open, today's value is also safe at 10:00 CT, and it's one session fresher.

- **(i) Today's open interest, yesterday's volume and premium (author's recommendation).** The morning group is:
  - `opt_call_oi`, `opt_put_oi`, `opt_oi_pcr`, all known at the open;
  - the other 12 as `prev_day_opt_*`.
- **(ii) Yesterday's everything.** The morning group is all 15 `prev_day_opt_*`. It's simplest, but uses open interest a day older than it could be.

Either way the server writes all 15 `prev_day_opt_*`. The choice only changes the ML feature list.

## Design

Each phase touches 5 files or fewer.

### Phase 1a: the migration

**Files:** `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `api/__tests__/training-features-prev-day-opt-pglite.test.ts`.

- **Migration #213:** `ALTER TABLE training_features ADD COLUMN IF NOT EXISTS` for the 15 `prev_day_opt_*`, with the same types as #24. Update `db.test.ts` as CLAUDE.md's migration section says.
  - The pglite test applies the real #24 and #213 to a stub table and compares each new column's type with its `opt_*` twin. `db.test.ts` only counts statements, so it can't see a wrong type or a misspelled name.
- **Push, then apply to production with the owner's OK** (per-migration rule), after re-checking that #213 is the only pending migration.
- Nothing writes the columns yet, so pushing 1a is safe whether or not it's applied.

### Phase 1b: write the previous day's values

**Files:** `api/_lib/build-features-phase2.ts`, `api/__tests__/build-features-phase2.test.ts`, `api/_lib/build-features-upsert.ts`, `api/__tests__/build-features.test.ts`.

**Pushed only after #213 is applied in production.**

- **A pure mapper.** Extract the row-to-features code (`build-features-phase2.ts` ~:510-565) into an exported pure function: `optionsVolumeFeaturesFromRow(row, prefix: 'opt_' | 'prev_day_opt_'): FeatureRow`.
  - It keeps today's parsing and today's rules, with one change:
    - a zero becomes `null`;
    - a ratio is set only when both its sides are finite and its denominator is above 0, so a field that doesn't parse no longer makes a NaN ratio, which Postgres NUMERIC would store (0 of 227 production rows hold one). A zero numerator still gives 0.
  - The cron and the phase 2 repair both call it, so the two can't diverge.
- **The previous row.** In the same reply, find the row whose own date is `priorTradingDay(dateStr)`, and set the 15 `prev_day_opt_*` from it.
  - The same-day `opt_*` keep coming from the row dated `dateStr`, as now.
  - Each lookup is independent: a missing same-day row leaves the previous-day values set, and the reverse.
- **The miss report.** The live-date level rule is the same for every report: error for today's date, warning otherwise.
  - When both rows are missing, including an empty, non-array or malformed reply, send one `options-volume-no-row` report that names both dates, not two.
  - A missing same-day row alone is reported as before, under `options-volume-no-row`.
  - A missing previous-day row alone sends the same message shape under its own fingerprint, `options-volume-no-prev-row`.
- **The row count.** The current 45 rows already reach the previous trading day of the oldest date the guard accepts: that row is at most 48 days back, and 49 calendar days hold at most 35 weekdays. So leave the count alone and extend the existing window test to the previous day. In that test, `oldest` equal to 44 pins the guard and `limit >= calendarDates` pins the count; the previous-day walk states the bound and pins the dates, but is looser, so it can't fail first.
- **Upsert and completeness:** add the 15 to the INSERT, VALUES and `ON CONFLICT` lists with the same COALESCE rule, and to `NULLABLE_FEATURE_KEYS`. Extend the COALESCE assertions in `build-features.test.ts`.
- **Tests (R4):**
  - previous-day values come from the previous trading day's row, across a weekend and across a holiday (use a real date in `MARKET_CLOSED_DATES`);
  - each of the two rows missing alone, and both missing, which is one report;
  - a malformed previous row;
  - the extended window test;
  - the mapper's table, which today's parsing tests already cover for the `opt_` prefix and which gets the same for `prev_day_opt_`, with a case for each of the five ratios where a side doesn't parse;
  - upstream failure sets **neither** group. The existing `optKeys` helper (~:2361) filters on `startsWith('opt_')`, so it must also catch `prev_day_opt_`, or the UW-down, non-2xx, bad-JSON and guard-skip tests won't notice;
  - mutants: the previous row taken by position (index 1) instead of by date; a calendar day instead of a trading day.

### Phase 2: repair the history from the saved reply

**Files:**
- `scripts/repair-options-volume.ts`, the CLI;
- `scripts/_lib/options-volume-repair.ts`, with its unit and pglite tests;
- `tsconfig.scripts.json`.

**Runs in production after 1b is pushed and #213 is applied.**

- **Input:** the saved reply file, given as `--source <file>`. It never calls UW. It refuses a file that isn't a UW options-volume reply:
  - `data` must be an array of objects, each with a `date` and the expected keys;
  - no date may appear twice.
- **Scope:** only `training_features` dates inside the source's span, from its oldest row to its newest.
  - Dates outside it are listed and left untouched. Rows written by the fixed daily build after the file was saved are therefore never blanked.
  - For the previous-day columns, the previous trading day must also be inside the span. If it isn't, the previous-day columns are left untouched and the date is listed.
- **What it computes,** for each date in scope, using `optionsVolumeFeaturesFromRow`:
  - the same-day 15 from that date's row;
  - the previous-day 15 from `priorTradingDay(date)`'s row.
- **Writes:** it writes exact values, not COALESCE.
  - Inside the span, a date with no source row has its columns set to NULL, and is listed. That doesn't happen for any current trading day, since every non-holiday weekday has a row.
  - Every value is **rounded to its column's scale** before it is compared, planned or written: integers as integers, premiums to 2 places, ratios to 4. The stored values come back as NUMERIC strings and are compared at the same scale. Without this every ratio looks changed: 360136/282619 = 1.274281… against a stored "1.2743". A second apply would never reach zero.
- **Same safety shape as `scripts/repair-stale-opening-range.ts`:**
  - the dry run writes a plan file under `docs/tmp/options-volume-repair/` and prints counts, a per-date table and every changed value as stored then new;
  - `--apply --plan F` re-plans, refuses unless the plan still matches, and needs `--all` for more than one date;
  - before writing, it saves a backup file and records the database in it;
  - rows are batched with `unnest`, about 500 to a statement, each written only where it still holds the planned before-values;
  - `--undo-file F --apply` restores the backup;
  - the database identity and no-echo rules are those in `scripts/_lib/db-host.ts` and the stale-range tool.
- **Production run (owner gates):** the dry run first. Then hand-recompute two rows from the raw reply, one in the stuck 10-01..11-13 block and one that was right. Then the owner's OK, then one date, then `--all`.

### Phase 3: the ML reads the morning-safe group

Three commits, 5 files or fewer each.

- **3a, groups and models:** `ml/src/utils/__init__.py`, `ml/src/phase2_early.py`, `ml/src/clustering.py` and the matching `ml/tests/`.
  - `OPTIONS_VOLUME_FEATURES` becomes the morning-safe group, as the owner decided (i) on 2026-11-26: today's `opt_call_oi`, `opt_put_oi` and `opt_oi_pcr`, which are known at the open, plus the 12 `prev_day_opt_*` columns that aren't open interest.
  - A new `OPTIONS_VOLUME_EOD_FEATURES` holds the same-day columns that leak: volume, premium, ask/bid, the volume PCR, the premium ratio and the two `vs_avg30` ratios. The same-day open interest isn't in it: under (i) it stays in the morning-safe group.
  - `phase2_early.py` and `clustering.py` models read only the morning-safe group.
  - A test fails if any same-day leaking column reaches either model's feature list.
  - `clustering.py` also reads `opt_vol_pcr` by name to describe clusters (:460 profile, :885 heatmap). Switch those to `prev_day_opt_vol_pcr`, so a morning cluster is described with what was known that morning. Extend the leak test to those name reads.
- **3b, research labels:** `ml/src/eda.py`, `ml/src/visualize.py`, `ml/src/health.py`.
  - After-the-fact research may keep the same-day group, since it compares a day's totals with that day's outcome. That covers `eda.py`'s options-volume analysis and the correlation, heatmap and stationarity plots. Label it end-of-day in plot titles and text.
  - `health.py` keeps monitoring `opt_vol_pcr`, a data-health check, not a model input, and adds `prev_day_opt_vol_pcr`.
- **3c, prompt and docs:** `api/_lib/plot-analysis-prompts.ts` and its test, `ml/README.md`, `docs/ARCHITECTURE.md`.
  - Describe both groups, with their timing.
  - Fix `opt_premium_ratio`: it's `bullish / (bullish + bearish)`, not call/put premium. `opt_vol_pcr` is already described correctly.
  - The prompt's embedded Python snippets (:104, :123, :289, :476) copy `visualize.py` and `clustering.py`. Update the ones 3a and 3b change, and name the drift risk in a comment.
  - This text goes to Claude for plot analysis only, not the analyze endpoint.
  - `ml/README.md` gets the group list and timing; `docs/ARCHITECTURE.md:627` says which group is prior-day.

## Non-goals

- **B**, intraday flow up to 10:00 CT.
- **Re-enabling the ML pipeline.**
- **`api/_lib/analyze-prompts.ts:124`** ("Options volume PCR: contrarian signal…"). It's prose in the analyze prompt, which the owner reworks; it's left alone and listed for the owner.
- **A clear-a-column rebuild mode for build-features** (live-data-integrity F16/P1.2). Phase 2's direct repair covers this column family.
- **Other build-time drift features** (`delta_flow_*`, `days_to_next_event`, max pain): a separate item.

## Known limits

- **Missed days.** A previous-day value for a date the daily build missed exists only after a rebuild, or after phase 2's repair.
- **The timing is read from the data,** not from UW's docs: the expiry drops for open interest, and the exact 30-prior-row mean for `avg_30_day_*`. If UW's definition changes, the expiry check would show it.

## Open questions (defaults picked)

1. **Column prefix:** `prev_day_opt_*`, matching `prev_day_*`. Default: yes.
2. **A date inside the span with no source row:** the repair sets its columns to NULL. Default: NULL, listed in the dry run.
3. **Phase order:**
   - 1a is pushed;
   - #213 is applied with owner OK;
   - 1b is pushed;
   - 2 runs with owner gates;
   - 3 runs in parallel with 2, since it is independent of production.

## What the review changed (2026-11-26)

- **The repair scope:** the repair touches only dates inside the source's span, so it never blanks the fixed build's newer rows.
- **Open interest:** it is as of the open, so it isn't look-ahead. That became an owner question, and the owner decided (i) on 2026-11-26: morning models read today's open interest and yesterday's volume and premium.
- **Rounding:** values are rounded to the column's scale before comparing.
- **The phases:** split to 5 files or fewer each, with the deploy order fixed. 1a migrates, then #213 is applied, then 1b writes.
- **Fixes to stated facts:**
  - the fix commit;
  - only one plot-prompt description is wrong;
  - `avg_30_day_*` leaves out the day;
  - the row count already suffices;
  - there is no upsert test file;
  - the holiday-calendar bound;
  - the duplicate-date check;
  - `clustering.py`'s name reads.
