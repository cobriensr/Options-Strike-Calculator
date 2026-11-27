# ML morning features: no end-of-day data in the 10:00 CT models

## Goal

`ml/src/phase2_early.py` and `ml/src/clustering.py` decide at 10:00 CT. Their inputs should hold only what was known by then. About 30 of the features they read today are built after the close from the whole day's data. This design:
- adds morning-safe versions, cut at 10:00 CT or taken from the previous trading day;
- keeps the existing columns as an end-of-day record for research;
- adds a guard so no model can read an end-of-day column again;
- repairs the history of the new columns.

## Owner decisions

- **2026-11-27 ~00:35 CT, "yeah thats fine":** the `_10ct` suffix, and the go-ahead on this design.
- **2026-11-26 ~19:45 CT, "yeah go ahead", on the default rule.**
  - Where the data has timestamps, cut it at 10:00 CT.
  - Where it exists only after the close, use the previous trading day's value.
  - Then repair the history.
  - Settle the unclear features with read-only checks before designing. That's done; the results are below.
- **Precedent, 2026-11-25, options volume (A + C).** Morning models read the previous day's totals. The same-day totals stay as an end-of-day record that no model reads. Built as `prev_day_opt_*` with `OPTIONS_VOLUME_EOD_FEATURES` and a leak test, phase 3a (ac755d6ba).

## Facts this design rests on (checked 2026-11-26, origin/main 6001bb2c0)

Audit: `docs/tmp/ml-lookahead-audit-2026-11-26.md` (gitignored scratch). Every count below is from read-only production queries run 2026-11-26.

- **The clock.**
  - The models decide at 10:00 CT (`ml/src/utils/__init__.py:85`).
  - `CHECKPOINTS` are ET minutes (`api/_lib/build-features-types.ts:86-94`): T1 = 9:00 CT, T2 = 9:30 CT.
  - `ctWallClockToUtcIso(date, 600)` (`src/utils/timezone.ts:410`) is the DST-safe 10:00 CT instant, called "the cut" below.
- **The build runs after the close.** The cron fires at 20:45 and 21:45 UTC (`vercel.json:116-118`) and works only 16:30-18:00 ET (`api/cron/build-features.ts:71-87`). Any read with no time bound sees the whole day.
- **The upsert.**
  - On main, every column is `COALESCE(EXCLUDED.x, stored)` (`api/_lib/build-features-upsert.ts:292-299`), so a builder that now yields null keeps the old value.
  - The in-flight branch `fix/spx-candle-placeholders` (21 commits, owner-approved, another session) adds an option that overwrites named columns, a dark-pool "complete day" rule, `DP_COLUMNS`, and `roundToNumeric84`. It edits `build-features-phase2.ts`, `build-features-upsert.ts` and `build-features.ts`. See "Base" below.
- **Training rows.** 147 of the 227 `training_features` dates (2026-01-02..2026-11-25) have `feature_completeness >= 0.80`, the filter both models use. Of those 147, 136 have a `market_snapshots` pick; 11 have none.
- **Readers outside the models.** These measure same-day relationships, so the end-of-day columns keep their meaning:
  - `ml/src/eda.py` (imports `DARK_POOL_FEATURES` and `IV_PCR_FEATURES` at :28-29);
  - `ml/src/pin_analysis.py:1157-1294`;
  - `ml/src/explore.py:133-163`;
  - `ml/src/visualize.py`;
  - the plot-analysis prompt;
  - a quoted figure in `api/_lib/analyze-prompts.ts:461`.

  The day-analogs features backend reads `day_features`, not `training_features`. `api/ml/export.ts:73` exports `f.*`.

### What leaks, and what history exists

"Trainable" means the 147 dates above; "new column coverage" is how many of them a source supports at the cut.

| Group | Columns the models read | Today | History and coverage |
|---|---|---|---|
| IV monitor | `iv_max`, `iv_range`, `iv_spike_count`, `iv_crush_rate` | full day; `iv_crush_rate` is 14:30 ET to the close (`build-features-monitor.ts:117-153`) | `iv_monitor` has had no writer since 2026-04-30 (8adc47447): 19 live dates (Apr 2-29) and 28 backfilled single readings of unknown time |
| IV monitor, morning but dead | `iv_open` (first row), `iv_at_t2` (10:30 ET ±5) | morning values | same dead source |
| PCR monitor | `pcr_max`, `pcr_min`, `pcr_range`, `pcr_spike_count` | full day (`build-features-monitor.ts:157-190`) | `flow_ratio_monitor` from 2026-02-23; 141 of 147 have 30 or more rows by the cut |
| PCR monitor, morning | `pcr_open`, `pcr_trend_t1_t2` | `pcr_open` is the first reading at any time (`:170`), not bounded | |
| Greek exposure | `agg_net_gamma`, `dte0_net_charm`, `dte0_charm_pct` | last snapshot of the day (`build-features-gex.ts:224-266`) | **No leak in practice.** On all 86 multi-snapshot dates (Jun 10 on), the snapshot nearest 10:00 CT equals the day's last, with 0 differences. Values stop changing by 09:15 CT. Through Jun 9 there is one snapshot a day (Jun 9 has no morning one), with the aggregate gamma overwritten through the day until the append model (Jun 8). That is near-close, and harmless given the flatness |
| 0DTE strike ladder | `charm_slope`, `gamma_wall_above_dist`, `gamma_wall_below_dist`, `neg_gamma_nearest_dist`, `gamma_asymmetry`, `charm_max_pos_dist`, `charm_max_neg_dist`, `charm_pattern` | last 0DTE ladder, distances measured from about the closing spot (`build-features-gex.ts:61-178, 269-299`) | 5-minute snapshots from 2026-03-25; 117 of 147 have one stamped 08:30 to before the cut |
| Realized vol | `realized_vol_5d`, `realized_vol_10d`, `rv_iv_ratio` | settlements `date <= D`, so they include the day's own move (`build-features-phase2.ts:145-196`) | 147 of 147 have enough earlier settlements |
| Dark pool | `dp_total_premium`, `dp_cluster_count`, `dp_top_cluster_dist`, `dp_support_premium`, `dp_resistance_premium`, `dp_support_resistance_ratio`, `dp_concentration` | every print of the day (no `asOfTimeCT`, `build-features-phase2.ts:366`) | `dark_pool_prints` (SPY prints scaled to SPX by the minute-candle ratio) from 2026-03-23; 126 of 147 have prints by the cut |
| Vol surface | `iv_ts_slope_0d_30d`, `iv_ts_contango`, `iv_ts_spread` | 30D point fetched at 21:35 UTC; 0DTE end is `iv_monitor`'s first row (`:809-847`) | 0DTE end dead after Apr 29 |
| Vol surface | `uw_rv_30d`, `uw_iv_rv_spread`, `uw_iv_overpricing_pct` | `vol_realized` for D, after the close (`:851-864`) | `rv_30d` is non-null on 9 of 156 rows, and both derived columns are set only when it is (`fetch-vol-surface.ts:136-142`) |
| Vol surface | `iv_rank` | `vol_realized` for D, after the close | the previous trading day's row covers about 135 of 147 |

### The other unclear features, settled

- **The snapshot pick.** The volatility, regime and calculator features take the nearest trusted `market_snapshots` slot to 10:00 CT within ±60 min. On 5 of the 136 picked trainable dates, the slot is 10:05-10:30. Phase 5 fixes it.
- **`max_pain_*`.** Probably safe. 58% of dates equal the previous day's value, and 5 of 5 intraday quotes matched the stored value. UW doesn't document its as-of basis, so this is a known limit.
- **Flow buckets.** Safe for the stored history: first-written values, with 0 differences from first-seen at T1/T2.
- **OI change.** Opening OI, safe.

## Approaches

1. **Redefine the existing columns in place.** It silently changes every research reader above and discards the end-of-day record. Rejected.
2. **Add morning-safe columns beside the end-of-day ones (chosen).** This is the options-volume pattern the owner chose. The models move to the new columns, and research keeps the old ones.
3. **Lag in the ML.** It fits only the previous-day groups, not a 10:00 CT cut, and every consumer must remember to lag. Rejected.

## Design

### Base

- Phase 1 (the migration) can go on main now.
- Phases 2, 3 and 5 build on main **after `fix/spx-candle-placeholders` has landed**. Rebase on it, and use its final forms: its column-overwrite option, its dark-pool complete-day rule, `DP_COLUMNS`, and `roundToNumeric84`.
- The new `dp_*_10ct` columns follow that branch's complete-day rule, and they join its overwrite handling the same way their end-of-day twins do.
- `dp_*_10ct` reads SPX `index_candles_1m` and SPY `etf_candles_1m` for the SPX/SPY ratio, so phase 3's production run waits until that branch's SPX candle refit is applied.
- One implementer stream at a time.

### New columns (23), each nullable, with the same type as its twin

- **PCR (4):** `pcr_max_10ct`, `pcr_min_10ct`, `pcr_range_10ct`, `pcr_spike_count_10ct`.
  - Source: `flow_ratio_monitor` rows on date D with `timestamp <= cut`.
  - Arithmetic: the same as today, including `countRatioSpikes`.
  - Null when fewer than `MIN_PCR_ROWS_10CT` rows with a non-null ratio exist.
  - `flow_ratio_monitor.timestamp` is the row's write time (`api/cron/monitor-flow-ratio.ts:123-132`), so `<= cut` keeps only readings made by 10:00 CT.
- **Strike ladder (8):** `charm_slope_10ct`, `gamma_wall_above_dist_10ct`, `gamma_wall_below_dist_10ct`, `neg_gamma_nearest_dist_10ct`, `gamma_asymmetry_10ct`, `charm_max_pos_dist_10ct`, `charm_max_neg_dist_10ct`, `charm_pattern_10ct`.
  - Source: the latest SPX 0DTE snapshot (`expiry = date`) with `timestamp >= 08:30 CT` and **`timestamp < cut`**. Snapshot stamps are floored to 5 minutes, so the 10:00 stamp holds a ladder fetched 10:00-10:05 (`api/_lib/uw-fetch.ts:441-446`). Stamps before 08:30 are previous-session ladders (live-data-integrity F5).
  - Computation: `computeStrikeFeatures` (`build-features-gex.ts:61`), exported, on that snapshot's rows, with its own spot. The all-expiry aggregate isn't needed.
  - Only the eight named outputs are copied under `_10ct` names. Its `_mag` outputs are not: a key in `features` that isn't in `NULLABLE_FEATURE_KEYS` moves completeness.
- **Realized vol (3):**
  - `prev_day_realized_vol_5d` and `prev_day_realized_vol_10d` use the same formula over settlements dated `< D`.
  - `rv_iv_ratio_10ct` is `prev_day_realized_vol_5d` over the snapshot VIX that `rv_iv_ratio` uses today (`build-features-phase2.ts:188-196`).
- **Dark pool (7):** `dp_*_10ct`, from `getDarkPoolLevels({ date, symbol: 'SPX', asOfTimeCT: '10:00' })` (`api/_lib/dark-pool-query.ts:98-120`), with today's derived arithmetic.
  - On the base branch, the cron overwrites `DP_COLUMNS` when `dpReadOk` is true. For the `_10ct` columns, `dpReadOk` is the AND of the end-of-day read and the morning read. A morning read that throws, a Neon blip for instance, never overwrites the stored `dp_*_10ct` with NULL.
  - That's why `api/cron/build-features.ts` is in phase 2b.
- **Vol surface (1):** `prev_day_iv_rank`, from the `vol_realized` row whose own date is `priorTradingDay(D)` (`src/data/marketHours.ts:230`).

### Every new value fits its column, or is null

- Every new value is checked against its column's limits before it is written. A value that doesn't fit becomes null and is logged once per date and column. Today's `dp_support_resistance_ratio` has no such check: 03-26 computed 35,853 into a DECIMAL(8,4) column, which overflows.
- A morning-only ratio with a tiny resistance makes overflow more likely, so the check is required.
- The check is one general function, `fitDecimal(value, precision, scale): number | null`. It is exported from `api/_lib/build-features-types.ts`, rounds half away from zero as Postgres NUMERIC does, and is null past the limit.
  - It generalizes the base branch's module-private `roundToNumeric84`, which only fits (8,4). That one can then call it.
  - Each new column passes its twin's declared type:

    | Column | Type |
    |---|---|
    | `rv_iv_ratio_10ct` | (6,4) |
    | `gamma_asymmetry_10ct` | (10,4) |
    | the `*_dist_10ct` | (10,2) |
    | the `dp_*_premium_10ct` | (14,2) |
    | the `prev_day_realized_vol_*` | (10,6) |
    | `prev_day_iv_rank` | (6,2) |
    | `charm_slope_10ct` | (20,4) |
    | `dp_support_resistance_ratio_10ct`, `dp_concentration_10ct` | (8,4) |

    The other `dp_*_10ct` and PCR columns take theirs from `api/_lib/db-migrations.ts`.
- The daily build and the repair share this check through the same pure functions, so neither aborts a date on an out-of-range value.

### Read changes in place, with no new columns

- **`pcr_open`:** the first reading with `timestamp <= cut`, else null.
  - Checked 2026-11-26: on all 141 trainable dates with `flow_ratio_monitor` rows, the first row is before the cut. So no stored value changes, and there's no repair.
- **Greek exposure: unchanged.** The read stays `MAX(timestamp)`.
  - The value at 10:00 CT equals the day's last on every multi-snapshot date (Jun 10 on), and values stop moving by 09:15 CT. Before that, there's one snapshot a day: through Jun 9, Jun 9 having no morning one.
  - Bounding the read would change no value going forward. On a rebuild of a pre-Jun-10 date, though, it would yield nothing. Those three columns aren't nullable, so they'd drop out of `computeCompleteness` and move `feature_completeness`. That could take a date out of training, for example 80/100 to 77/97 (`api/_lib/build-features-upsert.ts:145-156`).
  - So the three stay in the models as morning-safe in practice, and the guard allows them by name, with this reason in a comment.

### Columns that leave the models (no morning version)

- **Retired, as morning values whose source is dead:** `iv_open` and `iv_at_t2`.
- **End-of-day, leaking:**
  - `iv_max`, `iv_range`, `iv_spike_count`, `iv_crush_rate`;
  - `pcr_max`, `pcr_min`, `pcr_range`, `pcr_spike_count`;
  - the 8 strike-ladder columns;
  - `realized_vol_5d`, `realized_vol_10d`, `rv_iv_ratio`;
  - the 7 `dp_*`;
  - `iv_ts_slope_0d_30d`, `iv_ts_contango`, `iv_ts_spread`;
  - `uw_rv_30d`, `uw_iv_rv_spread`, `uw_iv_overpricing_pct`;
  - `iv_rank`.

### ML constants and the guard

**Existing constants keep their names and members.**
- `IV_PCR_FEATURES`, `DARK_POOL_FEATURES`, `VOL_SURFACE_FEATURES` and `GREEK_FEATURES_CORE` are unchanged, so `eda.py` and the research readers keep reading the end-of-day columns. `ml/tests/test_utils.py:77-79` still holds.

**New morning constants in `ml/src/utils/__init__.py`:**
- `PCR_10CT_FEATURES` = `pcr_open`, `pcr_trend_t1_t2` and the 4 PCR `_10ct` columns.
- `GREEK_10CT_FEATURES` = `agg_net_gamma`, `dte0_net_charm`, `dte0_charm_pct`, `charm_slope_10ct`.
- `STRIKE_10CT_FEATURES` = the 6 `*_dist_10ct`/`gamma_asymmetry_10ct` columns.
- `DARK_POOL_10CT_FEATURES` = the 7 `dp_*_10ct`.
- `REALIZED_VOL_PREV_DAY_FEATURES` = `prev_day_realized_vol_5d`, `prev_day_realized_vol_10d`, `rv_iv_ratio_10ct`.
- `VOL_SURFACE_PREV_DAY_FEATURES` = `prev_day_iv_rank`.

**Two column sets in utils:**
- `POST_CUT_COLUMNS`: every column that holds data from after 10:00 CT, whether a model reads it today or not. That is:
  - every end-of-day column listed above, plus `OPTIONS_VOLUME_EOD_FEATURES`;
  - the `*_t3` checkpoint columns (10:00 CT with a ±5 min tolerance, so up to 10:05) and `*_t4` (10:30 CT, `build-features-types.ts:89-94`);
  - `nope_am_mean`, `nope_am_sign_flips`, `nope_am_cum_delta` (09:30-11:30 ET, `build-features-nope.ts:24-25`);
  - `gex_oi_slope` (T1 to T4);
  - `gamma_wall_above_mag`, `gamma_wall_below_mag`, `neg_gamma_nearest_mag`, `gamma_0dte_allexp_agree` (the last ladder of the day).

  Neither model reads the non-EOD ones today (checked 2026-11-26). They're listed so a later edit can't add them unseen.
- `RETIRED_COLUMNS`: `iv_open`, `iv_at_t2`.

**The models** (phase 4a):
- `phase2_early.py`: `ALL_NUMERIC_FEATURES` uses the new constants in place of `IV_PCR_FEATURES`, `DARK_POOL_FEATURES` and `VOL_SURFACE_FEATURES`. Its local `PER_STRIKE_FEATURES` switches to the `_10ct` names, its local `PHASE2_FEATURES` to the previous-day realized-vol names, and `GREEK_FEATURES` to `GREEK_10CT_FEATURES`. The categorical `charm_pattern` becomes `charm_pattern_10ct`.
- `clustering.py`: the same for its lists, plus three switches:
  - `CHARM_PATTERN_COL` (`:130`, one-hot at `:193`) becomes `charm_pattern_10ct`;
  - the name reads in `characterize_clusters` (`:450-475`: `dp_total_premium`, `dp_support_resistance_ratio`, `charm_pattern`) and in the heatmap (`:879-889`: `charm_slope`, `dp_support_resistance_ratio`) become their `_10ct` twins;
  - the `iv_open` reads are removed.
- Each model exposes `INPUT_COLUMNS`: every source column it reads, numeric and categorical, including `CHARM_PATTERN_COL`.

**The guard test** (`ml/tests/test_feature_timing.py`, new). It fails when:
- either model's `INPUT_COLUMNS` meets `POST_CUT_COLUMNS ∪ RETIRED_COLUMNS`;
- the real `prepare_features` or `preprocess`, run on a frame holding every column of both sets and every new column, selects or one-hot encodes a source column that isn't in `INPUT_COLUMNS`. It maps dummies back to their source column by prefix;
- `characterize_clusters` or the heatmap in `save_plots` reads a column in either set.
  - It catches this with a **column-access spy**: the frame passed in is a `DataFrame` subclass that records every key given to `__getitem__`, `.get` and `.loc`.
  - A sentinel value can't catch every read. The profile prints `dp_total_premium` divided by 1e6, and the heatmap turns reads into colours and tick labels.

Local groups stay where they are. The guard is per column, not per group.

### Phases (5 files or fewer each)

- **1. Migration #214.**
  - Files: `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts` and a pglite test.
  - It adds the 23 columns. Push it, then apply to production with the owner's OK after re-checking the pending list. migrateDb applies every pending migration.
- **2a-0. The column-fit function.**
  - Files: `api/_lib/build-features-types.ts` (`fitDecimal`) and its test, plus the base branch's `roundToNumeric84` calling it if that stays one file.
- **2a. PCR.**
  - Files: `build-features-monitor.ts` (the four `_10ct` and the bounded `pcr_open`), its test, `build-features-upsert.ts`, `api/__tests__/build-features.test.ts`, and `api/__tests__/build-features-upsert-pglite.test.ts`.
  - The last one: add 214 to its `TRAINING_FEATURES_MIGRATIONS`, or its INSERT fails on the new columns.
  - Pushed after #214 is applied and the base branch has landed.
- **2b. Realized vol, dark pool, vol surface.**
  - Files: `build-features-phase2.ts`, its test, `build-features-upsert.ts`, `api/cron/build-features.ts` (the `dpReadOk` AND), `api/__tests__/build-features.test.ts`.
- **2c. Strike ladder.**
  - Files: `build-features-gex.ts`, its test, `build-features-upsert.ts`, `api/__tests__/build-features.test.ts`.
- **Shared rule for 2a-2c:**
  - each new computation is an exported pure function over its source rows, so the daily build and the repair call the same code;
  - the new columns go into `NULLABLE_FEATURE_KEYS`, so `feature_completeness` doesn't move;
  - tests cover R4 failure modes, both sides of the cut, a holiday previous day, overflow-to-null, and the floored 10:00 strike stamp being excluded.
- **3a. Repair library.**
  - Files: `scripts/_lib/morning-features-repair.ts`, its unit test, `tsconfig.scripts.json`.
- **3b. Repair CLI.**
  - Files: `scripts/repair-morning-features.ts`, a pglite test, a CLI test.
  - **Safety shape:** that of `scripts/repair-options-volume.ts`:
    - a dry run with a plan file;
    - `--apply --plan F` that re-plans and refuses a mismatch;
    - `--all` for more than one date;
    - a backup first;
    - guarded exact `unnest` writes in one transaction;
    - `--undo-file`;
    - the `db-host.ts` no-echo rules.
  - **Inputs:** read from Neon. The plan pins, per date:
    - the stored `vix` and `spx_open` it used (from the `training_features` row, the values the build stored);
    - each source's identity:
      - the row count and max `timestamp` of `flow_ratio_monitor`;
      - the chosen strike snapshot's timestamp and row count;
      - the row count and max `executed_at` of `dark_pool_prints`;
      - the SPX `index_candles_1m` and SPY `etf_candles_1m` rows used (count and max timestamp; `dark-pool-query.ts:147-152`);
      - and, as values, the `outcomes.settlement`s and the `vol_realized.iv_rank` used. Those tables have no row timestamp that moves on an update.

    An apply refuses if any changed.
  - **Writes:** values rounded to column scale; only the 23 new columns; never an end-of-day column or `feature_completeness`.
  - **Production run:**
    1. the dry run;
    2. hand-recompute one date per group from the raw source rows;
    3. one date;
    4. `--all`.
- **4a. Models and guard.**
  - Files: `ml/src/utils/__init__.py`, `ml/src/phase2_early.py`, `ml/src/clustering.py`, `ml/tests/test_feature_timing.py`, `ml/tests/test_phase2.py`. The categorical set at `:158-166` becomes `charm_pattern_10ct`.
  - Extend `ml/tests/test_clustering.py` too if its fixtures name the leaving columns. If that makes six files, move two things together into a 4a-2 commit, so each commit passes its own tests: the clustering name-read switches, and the guard's column-access-spy bullet.
- **4b. Research labels.**
  - Files: `ml/src/eda.py`, `ml/src/visualize.py`, their tests.
  - Label the dark-pool, IV, strike and realized-vol research sections and plots "end of day", and the retired IV ones "retired (source stopped 2026-04-30)", as options-volume phase 3b did.
- **4c. Health and prompt.**
  - Files: `ml/src/health.py` and its test, `api/_lib/plot-analysis-prompts.ts` and its test.
  - In `health.py`:
    - add the twins `charm_pattern_10ct`, `prev_day_realized_vol_5d`, `dp_total_premium_10ct` and `dp_support_resistance_ratio_10ct` beside the end-of-day columns it watches;
    - drop `iv_open`, which has been dead since 2026-04-30 and warns on every run.
- **4d. Docs.**
  - Files: `ml/README.md`, `docs/ARCHITECTURE.md`.
  - `api/_lib/analyze-prompts.ts:461` is the owner's prompt: listed for the owner, not edited.
- **5. Snapshot pick at or before 10:00 CT.**
  - **Files:**
    - `api/cron/build-features.ts` (`pickFeatureSnapshot`) and its test;
    - a repair script under `scripts/`, following the precedent in `docs/superpowers/specs/2026-11-22-feature-snapshot-trust-design.md:417-470`;
    - its test.
  - **The other callers** of `pickFeatureSnapshot`, `scripts/_lib/stale-opening-range.ts:735` and `scripts/_lib/snapshot-price-context.ts:596`, keep passing their tests. If one needs a change, it gets its own commit.
  - **Rule:** take the latest trusted slot within 60 min at or before 10:00 CT, never after, keeping today's tie and `spx_open` rules.
  - **Repair, for the dates whose stored pick is after 10:00 (5 trainable today).** It follows the precedent exactly (`2026-11-22-feature-snapshot-trust-design.md:440-470`):
    1. Blank the precedent's 22 snapshot columns plus `rv_iv_ratio_10ct` with a guarded UPDATE. The guard is an `md5(to_jsonb(row))` check against the dry run's read, with a backup first.
    2. Rebuild the date through the cron's `?date=`. `buildFeaturesForDate` is private, so the cron is the only rebuild path. The blank comes first, so the COALESCE upsert can't keep an old post-10:00 value under a NULL from the new pick.
    3. Recompute `vvix_percentile` for the up-to-20 later dates whose window holds a changed `vvix` (precedent step 6).
  - **What the dry run shows:**
    - A full rebuild recomputes every column of those dates from today's sources, not only the snapshot ones, and its values can't be predicted without running it. `buildFeaturesForDate` is private, and it calls UW inside the 30-day window.
    - So the dry run lists, per date, the stored and the new pick and the 23 columns it will blank. The stored pick is found by matching the stored `vix`, `vix1d`, `spx_open` and `sigma` to a trusted snapshot row.
    - The apply keeps a full-row backup. It checks the cron's JSON `status === 'success'` (the cron answers 200 even on a failed date), and restores and stops on any failure. After each rebuild it prints every column that moved against the backup. The plan's Task 14 has the details.
    - A date with no trusted slot by 10:00 becomes a no-pick date (owner rule A). Its `feature_completeness` falls to about 0.08, so it leaves the 147 trainable dates. The dry run lists these dates by name.

Order: 1 → apply #214 → base branch lands → 2a → 2b → 2c → 3a → 3b → production repair → 4a → 4b → 4c → 4d. 5 can follow 2c at any point.

## Thresholds and constants

- **The cut:** `ctWallClockToUtcIso(date, 600)`.
  - Inclusive (`<=`) for tables stamped at capture time: `flow_ratio_monitor` (write time, with seconds and milliseconds), `dark_pool_prints.executed_at`, greek exposure.
  - Exclusive (`<`) for `strike_exposures`, whose stamps are floored to 5 minutes.
- **The strike window:** from 08:30 CT to before the cut, on the snapshot's own `date`.
- **`MIN_PCR_ROWS_10CT = 30`.** A full morning has about 91 one-minute rows by the cut, and 141 of 147 trainable dates clear 30 (the default pick).
- **The snapshot window:** `[10:00 - 60 min, 10:00]` CT.
- **Column limits:** the declared DECIMAL precision of each twin, read from its migration.

## Non-goals

- Re-enabling the ML pipeline.
- Restoring an `iv_monitor` writer.
- Repairing the near-frozen strike days or the frozen ETF-tide zero grid.
- Changing the end-of-day columns' values. One exception: phase 5 changes the snapshot columns on its few dates.
- Editing the analyze prompt.

## Known limits

- **Thin early history.** New columns are null before their source starts, and over Jul 22 - Sep 4. Coverage over the 147 trainable dates:

  | Group | Dates covered |
  |---|---|
  | Dark pool | 126 |
  | Strike | 117 |
  | PCR | 141 |
  | Previous-day iv_rank | about 135 |
  | Realized vol | 147 |

  All are above clustering's 50% drop line (`clustering.py:199-204`). The dry run reports each column's share. If one falls under 50%, clustering drops it by its own rule, and the report says so.
- **The snapshot save lag.** A live row for a slot at or before 10:00 may have been saved up to 10 minutes later (`SAME_DAY_LATE_MINUTES = 10`, `build-features.ts:123`), with quotes from save time. Phase 5 leaves this as is, because bounding save time would reject the 12 live slot-10:00 picks.
- **`max_pain_*`.** UW's as-of basis is undocumented.
- **Flow-bucket restatements.** If a future repair rewrites old `flow_data` buckets with restated values, stored T1/T2 values stop being first-seen.
- **Late-reported dark-pool prints.** The cut is on `executed_at`. A print reported after 10:00 for a trade made before 10:00 is included, although it wasn't visible at 10:00.
  - `ingested_at` can't be the cut for history: on the backfilled dates (Mar 23 - May 1) it is the backfill time.
  - The size of this is unmeasured. A read-only count of live dates (May 4 on) where `ingested_at > cut >= executed_at` would measure it.
- **`vol_realized`'s date.** The live cron stores UW's newest iv-rank row under today's date (`api/cron/fetch-vol-surface.ts:145-160`). If at 21:35 UTC that row is still D-1's, then `prev_day_iv_rank` is two days old. That's stale, but not a leak, so either way the morning value is safe.
- **Build time.** Each date adds about three reads to the daily build, the dark-pool join being the heaviest. A `?backfill=true` run of every date inside the cron's 300 s cap may then time out. Phase 3's repair runs locally and is unaffected. Phase 2b measures one date's build time in its test notes.

## Open questions (default picks noted)

1. **Drop the IV-monitor, `iv_ts_*` and `uw_*` features from the models** rather than build morning versions. Default: drop. Their sources are dead or nearly empty.
2. **The suffix for a value cut at 10:00 CT: decided `_10ct` (owner, 2026-11-27 ~00:35 CT, "yeah thats fine").** `prev_day_` for a previous-day value is settled by the options-volume precedent.
   - `_tN` already means a point value at an ET checkpoint.
   - `_10ct` would have collided: `nope_am_*` covers 09:30-11:30 ET, which is 8:30-10:30 CT and runs past 10:00.
3. **`MIN_PCR_ROWS_10CT`.** Default 30.

## What the review changed (2026-11-26)

- **Overflow (the blocker):** every new value is checked against its column. The second review generalized this to `fitDecimal`.
- **Base:** phases 2, 3 and 5 build on `fix/spx-candle-placeholders` once it lands, and the production repair waits for its SPX refit.
- **The guard:** it is per column (`POST_CUT_COLUMNS`, called `EOD_COLUMNS` in the first revision, and `RETIRED_COLUMNS`) with `INPUT_COLUMNS` per model, and covers `CHARM_PATTERN_COL` and the clustering name reads. Existing constants keep their names, so eda doesn't change.
- **Name reads:** clustering's dark-pool and charm reads switch to the `_10ct` twins, and the health twins are added.
- **Vol surface:** `prev_day_uw_iv_rv_spread` and `prev_day_uw_iv_overpricing_pct` are dropped (they need the rarely set `rv_30d`), leaving 23 new columns.
- **Phase 5:** the `vvix_percentile` ripple, the overwrite rebuild, the other `pickFeatureSnapshot` callers, and the save lag as a known limit.
- **Repair inputs:** `vix`, `spx_open` and the minute candles are pinned, and all of 2a-2c share pure functions.
- **The cut:** `pcr_open` is bounded, and the cut is exclusive for the floored strike stamps.
- **Greek exposure:** the first revision bounded the read at the cut. The second review reversed that: the read stays unchanged (see "Read changes in place").
- **Retired columns:** `iv_open` and `iv_at_t2` are retired, not end-of-day.
- **Counts:** clarified (147 trainable, 136 with a pick), and coverage added (all above 50%).
- **Phases:** split to stay at 5 files each.

**Second review:**
- **The guard:** it uses a column-access spy instead of a sentinel, which can't see a scaled or plotted read. Its set is now `POST_CUT_COLUMNS`, which adds `*_t3`, `*_t4`, `nope_am_*`, `gex_oi_slope` and the `_mag` columns.
- **Greek exposure:** the read stays unchanged. Bounding it would move `feature_completeness` on rebuilds of pre-Jun-10 dates and add no value.
- **`pcr_open`:** checked, with 0 of 141 dates having a first reading after the cut, so no repair.
- **Dark pool:** `dpReadOk` is the AND of both reads, and the cron file is in 2b.
- **Column fit:** a general `fitDecimal`, with each column's type listed. 2a-0 holds it, and 2a adds the pglite migration list.
- **Phase 5:** follows the precedent's blank-then-rebuild, the dry run shows every column that moves, and no-pick dates are named.
- **3b pins:** `etf_candles_1m` for SPY, and values for `outcomes` and `vol_realized`.
- **The 4a split:** it moves the spy test with the name-read switches.
- **Builder details:** the PCR row rule; no `_mag` copies; health drops `iv_open`.
- **New known limits:** late-reported dark-pool prints, `vol_realized`'s date, build time.
- **The suffix:** its premise is corrected, and it becomes an owner question.
