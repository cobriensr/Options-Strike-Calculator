# ML Morning Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 10:00 CT ML models (`phase2_early`, `clustering`) only features known by 10:00 CT. Add 23 morning-safe columns beside the end-of-day ones, add a guard so no model reads a post-cut column again, and repair the new columns' history.

**Architecture:**
- The nightly build (`api/cron/build-features.ts` and the `api/_lib/build-features-*.ts` modules) computes each new column through an exported pure function over its source rows, cut at 10:00 CT or taken from the previous trading day.
- A local repair CLI calls the same functions to fill history, with the options-volume tool's plan, backup and undo safety.
- The ML moves to new constants. A column-level guard test fails on any post-cut input.

**Tech Stack:** TypeScript (Vercel Functions, Neon `@neondatabase/serverless`, vitest, pglite), Python 3 (pandas, pytest, ruff) in `ml/`.

**Spec:** `docs/superpowers/specs/2026-11-26-ml-morning-features-design.md`, which settles every design choice. Read it before any task.

## Global Constraints

- **The cut:** `ctWallClockToUtcIso(date, 600)` from `src/utils/timezone.ts`.
  - Inclusive (`<=`) for `flow_ratio_monitor.timestamp` and `dark_pool_prints.executed_at`.
  - **Exclusive (`<`)** for `strike_exposures.timestamp`, which is floored to 5 minutes.
- **The strike window:** `timestamp >= 08:30 CT` (`ctWallClockToUtcIso(date, 510)`) and `< cut`, `expiry = date`, `ticker = 'SPX'`.
- **The suffix:** `_10ct` for a 10:00 CT cut, and `prev_day_` for the previous trading day (owner, 2026-11-27). Never `_am`, because `nope_am_*` means 8:30-10:30 CT.
- **Previous trading day:** `priorTradingDay(date)` from `src/data/marketHours.ts`, matched on the source row's own date, never by position.
- **`MIN_PCR_ROWS_10CT = 30`**, counting rows with a non-null ratio by the cut.
- **New columns:**
  - nullable, with their twin's type, listed in `NULLABLE_FEATURE_KEYS`, never moving `feature_completeness`;
  - every value set through `setFitted(features, column, value, dateStr)` (Task 2). It calls `fitDecimal` or `fitInteger` with the column's type from `COLUMN_TYPES_10CT`, sets null when the value doesn't fit, and logs `logger.warn({ date, column, value }, 'feature value does not fit its column')` once per date and column;
- **The cut is never null:** `ctWallClockToUtcIso` returns `string | null`. Every caller uses Task 2's `cutAt10ct(dateStr): Date` and `strikeWindowStart(dateStr): Date`, which throw on null. Without that, `new Date(null)` would be the epoch, and every `_10ct` value would quietly become null;
- **A failed new read** never fails the date and never reports success. Each new read (PCR rows, strike stamps and rows, the morning dark-pool levels, the previous-day `vol_realized` row, the previous-day settlements) sits in its own `try/catch`. On a reject, the catch:
  - leaves that group's new columns unset;
  - calls `Sentry.captureException` with tag `feature_group` and fingerprint `['build-features-10ct-read', <group>]`;
  - returns `morningReadOk: false` to the cron, which reports that date `'partial'`.

  End-of-day columns are unaffected;
  - no end-of-day column changes value, except on phase 5's dates.
- **Push gate:** Tasks 3, 4 and 5 are pushed only after #214 is applied in production. Their upsert names the new columns, so pushing first makes every build fail with "column does not exist".
- **Timestamps:** Neon returns timestamptz as `Date`. Compare with `new Date(ts).getTime()`, never `Date.parse(ts)`, which drops milliseconds. `flow_ratio_monitor.timestamp` is the write time, with milliseconds.
- **Shared selection:** every "which rows count" rule is an exported pure function that the daily build and the repair both call, and is tested at its boundary. That covers the time cut, the strike window, `date < D` and the previous trading day. SQL may read a superset, but never decides the boundary.
  - The one exception is dark pool. `getDarkPoolLevels` cuts in SQL (`executed_at <= 'D 10:00'::timestamp AT TIME ZONE 'America/Chicago'`, `api/_lib/dark-pool-query.ts`), and both callers use that function. Task 4 tests that path in pglite on one CST and one CDT date.
- **Greek exposure reads are unchanged** (`MAX(timestamp)`). `agg_net_gamma`, `dte0_net_charm` and `dte0_charm_pct` stay model inputs.
- **Base:** Tasks 2 onward build on main after `fix/spx-candle-placeholders` has landed. Task 2 edits its `roundToNumeric84`. They use its `upsertFeatures(f, { overwrite })`, `DP_COLUMNS`, `darkPoolWrite` / `dpReadOk` and complete-day rule. Task 1 may land now.
- **Process:**
  - One implementer stream at a time. Every commit is gated by `npm run review`.
  - Pushes touching `api/` or `src/` wait until after the close on weekdays (15:00 CT, or 12:00 CT on a half day), or go before the open.
  - Production migration apply and the production repair need the owner's OK. The repair runs one date first.
- **Five files or fewer** per commit.

## Review Focus

1. **DST:** the cut is 16:00Z on a CST date and 15:00Z on a CDT date. Tasks 3, 4 and 5 each test one date of each, for example 2026-03-06 (CST) and 2026-06-15 (CDT).
2. **The previous trading day across a holiday:** 2026-11-27's previous trading day is 2026-11-25 (Thanksgiving is closed), and 2026-11-30's is 11-27. Tested in Task 4 (realized vol, iv_rank) and Task 7 (the repair).
3. **The floored 10:00 strike stamp:** a snapshot stamped exactly 10:00:00 CT must be excluded and the 09:55 one used. Tested in Task 5.
4. **Overflow:** a value past its column becomes null and the date's row is still written. For example `dp_support_resistance_ratio_10ct` = 5e9 / 1e5 = 50,000 into (8,4). Tested in Tasks 2 and 4.
5. **A failed morning read:** when the dark-pool morning read throws and the end-of-day read succeeds, `dpReadOk` is false and stored `dp_*_10ct` are never overwritten with NULL. Tested in Task 4.

---

### Task 1: Migration #214, the 23 columns

**Files:**
- Modify: `api/_lib/db-migrations.ts`, appending `{ id: 214, … }`
- Modify: `api/__tests__/db.test.ts`
- Create: `api/__tests__/training-features-10ct-pglite.test.ts`
- Also commit the spec and this plan (docs-only, in the same branch).

**Interfaces:**
- Produces these columns on `training_features`, all nullable with no default:

| Column | Type |
|---|---|
| `pcr_max_10ct`, `pcr_min_10ct`, `pcr_range_10ct` | DECIMAL(8,4) |
| `pcr_spike_count_10ct` | INTEGER |
| `charm_slope_10ct` | DECIMAL(20,4) |
| `gamma_wall_above_dist_10ct`, `gamma_wall_below_dist_10ct`, `neg_gamma_nearest_dist_10ct`, `charm_max_pos_dist_10ct`, `charm_max_neg_dist_10ct` | DECIMAL(10,2) |
| `gamma_asymmetry_10ct` | DECIMAL(10,4) |
| `charm_pattern_10ct` | TEXT |
| `prev_day_realized_vol_5d`, `prev_day_realized_vol_10d` | DECIMAL(10,6) |
| `rv_iv_ratio_10ct` | DECIMAL(6,4) |
| `dp_total_premium_10ct`, `dp_support_premium_10ct`, `dp_resistance_premium_10ct` | DECIMAL(14,2) |
| `dp_cluster_count_10ct` | INTEGER |
| `dp_top_cluster_dist_10ct` | DECIMAL(10,2) |
| `dp_support_resistance_ratio_10ct`, `dp_concentration_10ct` | DECIMAL(8,4) |
| `prev_day_iv_rank` | DECIMAL(6,2) |

- [ ] **Step 1: Write the failing pglite test.** Follow `api/__tests__/training-features-prev-day-opt-pglite.test.ts`. Build `training_features` from the migrations that touch it up to #61 (#9, 11, 21, 22, 24, 26, 29, 31, 33, 61); of these, #9, #11, #21, #26, #29 and #33 create the twins. Then apply #214 inside `BEGIN`/`COMMIT`. Assert:
  - each new column's type equals its twin's (for example `information_schema` `numeric_precision`/`numeric_scale` of `dp_concentration_10ct` equals that of `dp_concentration`);
  - exactly 23 columns were added;
  - all are nullable with no default;
  - an existing row reads NULL in all 23;
  - a second apply is a no-op;
  - `SHOW lock_timeout` is `5s` inside the transaction.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/training-features-10ct-pglite.test.ts`. Expected: FAIL, "migration 214 not found".
- [ ] **Step 3: Add the migration.** `statements: [SET LOCAL lock_timeout = '5s', ALTER TABLE training_features ADD COLUMN IF NOT EXISTS …×23]`, with a description naming the spec.
- [ ] **Step 4: Update `db.test.ts`** per CLAUDE.md "DB Migrations":
  - `{ id: 214 }`;
  - the `#214: …` line;
  - `mockSql` total 780 → 783;
  - `mockSql.transaction` total 200 → 201;
  - both breakdown comments.
- [ ] **Step 5:** Run both test files. Expected: PASS. Then run `npm run review`. Expected: exit 0.
- [ ] **Step 6: Commit** the spec and plan as `docs(spec): …`, then the migration and tests as `feat(db): Add the 23 morning-safe columns to training_features (migration #214)`.
- [ ] **Step 7:** Push (outside market hours). Re-check production `schema_migrations` (top must be 213, so #214 is the only pending one), then ask the owner's OK and apply with `scripts/run-pending-migrations.mts`.

### Task 2: `fitDecimal`

**Files:**
- Modify: `api/_lib/build-features-types.ts`
- Test: `api/__tests__/build-features-types.test.ts` (create it if it doesn't exist)
- Modify (base branch): `api/_lib/build-features-phase2.ts`, where `roundToNumeric84` becomes `fitDecimal(v, 8, 4)`

**Interfaces:**
- Produces `export function fitDecimal(value: number | null | undefined, precision: number, scale: number): number | null`.
  - It rounds the value's shortest decimal text (`String(value)`) half away from zero to `scale` digits, as Postgres NUMERIC does on the cast.
  - It returns null for non-finite input, or when the rounded absolute value is `>= 10^(precision - scale)`.
  - It never returns `-0`.
  - Use the same digit-string method as `scaledUnits` in `scripts/_lib/options-volume-repair.ts`, not `toFixed`. Exponent-form text (`1e21`, `5e-7`) must be expanded first, because `scaledUnits` returns 0 for it.
- Produces `export function fitInteger(value: number | null | undefined): number | null`. It rounds half away from zero, and is null outside [-2147483648, 2147483647] or when not finite. It's used for `pcr_spike_count_10ct` and `dp_cluster_count_10ct`.
- Produces `export const COLUMN_TYPES_10CT: Readonly<Record<string, readonly [number, number] | 'integer' | 'text'>>`, the 23 columns with the types from Task 1's table.
- Produces `export function setFitted(features: FeatureRow, column: string, value: number | string | null | undefined, dateStr: string): void`.
  - It looks up `COLUMN_TYPES_10CT[column]` and throws on an unknown column. It then sets `features[column]` to the fitted value; text passes through.
  - On a value that doesn't fit, it sets null and logs once per (date, column), through a module `Set` keyed `date|column` and capped at 1,000 entries, cleared when full (R1).
- Produces `export function cutAt10ct(dateStr: string): Date` and `export function strikeWindowStart(dateStr: string): Date`. They wrap `ctWallClockToUtcIso(dateStr, 600)` and `(dateStr, 510)`, and throw `Error('no 10:00 CT instant for <date>')` on null.

- [ ] **Step 1: Write the failing table test** (`it.each`, value → expected):

| Value | Precision, scale | Expected |
|---|---|---|
| `1.23455` | 6,4 | `1.2346` |
| `-1.23455` | 6,4 | `-1.2346` |
| `99.99994` | 6,4 | `99.9999` |
| `99.99995` | 6,4 | `null` |
| `35853` | 8,4 | `null` |
| `9999.9999` | 8,4 | `9999.9999` |
| `-0.00001` | 6,4 | `0` (`Object.is(r, -0) === false`) |
| `NaN`, `Infinity`, `null`, `undefined` | any | `null` |
| `1234.565` | 10,2 | `1234.57` |
| `1e21` | 20,4 | `null` |
| `-1e22` | 20,4 | `null` |
| `5e-7` | 10,6 | `0.000001` |
| `4e-7` | 10,6 | `0` |

  Plus a `fitInteger` table: `2147483647` gives `2147483647`, `2147483648` gives `null`, `-2147483648` gives `-2147483648`, `2.5` gives `3`, `-2.5` gives `-3`, `NaN` gives `null`.

  Plus these:
  - `setFitted` with `dp_support_resistance_ratio_10ct` = 50,000 sets null and logs once. A second call for the same date and column logs nothing more.
  - `setFitted` with an unknown column throws.
  - `cutAt10ct('2026-03-06')` is `2026-03-06T16:00:00.000Z` and `cutAt10ct('2026-06-15')` is `2026-06-15T15:00:00.000Z`.
  - `cutAt10ct('not-a-date')` throws.

- [ ] **Step 2:** Run it and see it fail ("fitDecimal is not exported").
- [ ] **Step 3:** Implement it. Make `roundToNumeric84` call `fitDecimal(value, 8, 4)`, and keep its existing tests passing.
- [ ] **Step 4:** Run the tests and `npm run review`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(features): Add fitDecimal, the column-fit check every new feature passes through`.

### Task 3: PCR at 10:00 CT

**Files:**
- Modify: `api/_lib/build-features-monitor.ts`
- Test: `api/__tests__/build-features-monitor.test.ts`
- Modify: `api/_lib/build-features-upsert.ts` (the 4 columns in INSERT / VALUES / ON CONFLICT and `NULLABLE_FEATURE_KEYS`)
- Modify: `api/__tests__/build-features.test.ts`
- Modify: `api/__tests__/build-features-upsert-pglite.test.ts`.
  - Add `214` to `TRAINING_FEATURES_MIGRATIONS`.
  - The base branch's "DP_COLUMNS against the real table" test (~159-176) expects the `dp\_%` columns outside `DP_COLUMNS` to be exactly the three `dp_buyer_initiated`, `dp_seller_initiated` and `dp_net_bias`. Add the 7 `dp_*_10ct` to that expected set here. Task 4 moves them into `DP_10CT_COLUMNS` and tightens the test.

**Interfaces:**
- Consumes: `fitDecimal` (Task 2).
- Produces `export const MIN_PCR_ROWS_10CT = 30`.
- Produces `export function pcrFeaturesAt10ct(rows: readonly RatioRow[], cutMs: number): { pcr_open: number | null; pcr_max_10ct: number | null; pcr_min_10ct: number | null; pcr_range_10ct: number | null; pcr_spike_count_10ct: number | null }`.
  1. Cut first: keep the rows with `new Date(timestamp).getTime() <= cutMs`, **null ratios included**, in time order.
  2. `pcr_spike_count_10ct` is `countRatioSpikes` on those cut rows, unfiltered. It compares row i with row i-5, so filtering nulls first would shift the window and change today's arithmetic.
  3. `pcr_open`, max, min and range use the cut rows' non-null ratios. `pcr_open` is the first of them.
  4. The four `_10ct` values are null when fewer than 30 cut rows have a non-null ratio.
  5. Values go through `fitDecimal(…, 8, 4)` for the ratios and `fitInteger` for the count.
- **Prerequisite for the push:** #214 applied in production.
  - `engineerMonitorFeatures` sets these five, so `pcr_open` is now bounded, and leaves `pcr_max`/`pcr_min`/`pcr_range`/`pcr_spike_count` as they are.

- [ ] **Step 1: Write the failing tests** in `build-features-monitor.test.ts`:
  - **`it('uses only readings at or before 10:00 CT')`:** 40 rows from 08:30 to 10:00:00 CT on 2026-06-15 (CDT), plus one at 10:00:30 with ratio 9.9. Expect `pcr_max_10ct` to be the max of the 40, not 9.9.
  - **The same on 2026-03-06 (CST).** The cut is 16:00Z.
  - **`it('is null with 29 readings and set with 30')`.**
  - **`it('bounds pcr_open')`:** first row at 10:01 CT. Expect `pcr_open` null.
  - **`it('counts spikes only before the cut')`:** a spike at 10:05 is not counted.
  - **`it('keeps null ratios in the spike window')`:** a series with a null at i-5. The count equals `countRatioSpikes` run on the same unfiltered rows.
  - **`it('sets nothing it cannot fit')`:** a ratio of 12,345 gives `pcr_max_10ct` null, and the row is still written.
  - **`it('leaves the PCR group unset when its read rejects')`:** the `flow_ratio_monitor` query rejects. Then:
    - none of the five PCR keys is set;
    - `captureException` is called with fingerprint `['build-features-10ct-read', 'pcr']`;
    - `engineerMonitorFeatures` returns `morningReadOk: false`;
    - the IV keys from the same call are still set.
  - **In `build-features.test.ts`:** the four columns are bound to their own placeholders, use COALESCE, and are skipped by `computeCompleteness`.
- [ ] **Step 2:** Run the two files and see them fail.
- [ ] **Step 3:** Implement `pcrFeaturesAt10ct`, call it from `engineerMonitorFeatures` with `cutAt10ct(dateStr).getTime()`, and add the upsert lists. `engineerMonitorFeatures` now returns `{ morningReadOk: boolean }`, and the cron turns `false` into a `'partial'` date. That cron change rides in Task 4, which already edits `api/cron/build-features.ts`. Until then, the return value is unused.
- [ ] **Step 4:** Mutants, each restored by hand:
  - `<=` → `<` on the cut;
  - 30 → 29;
  - `pcr_open` unbounded.

  Each must fail a named test. Run `npm run review`.
- [ ] **Step 5: Commit** `feat(features): Add the PCR features as of 10:00 CT, and bound pcr_open`.

### Task 4: Realized vol, dark pool and iv_rank

**Files:**
- Modify: `api/_lib/build-features-phase2.ts`
- Test: `api/__tests__/build-features-phase2.test.ts`
- Modify: `api/_lib/build-features-upsert.ts` (the 11 columns)
- Modify: `api/cron/build-features.ts`:
  - `dpReadOk` becomes the AND of both dark-pool reads;
  - a new exported `DP_10CT_COLUMNS` in `build-features-upsert.ts` (the 7) joins the overwrite set only when `dpReadOk` and the complete-day rule allow, exactly like `DP_COLUMNS`;
  - any `morningReadOk: false` from Tasks 3-5 makes that date `'partial'`.

  Also update the `DP_COLUMNS` getter mock in `api/__tests__/build-features.test.ts` (~49-60), and tighten the pglite "DP_COLUMNS against the real table" test: every `dp\_%` column is in `DP_COLUMNS`, in `DP_10CT_COLUMNS`, or one of the three named ones.
- Modify: `api/__tests__/build-features.test.ts`

**Interfaces:**
- Consumes: `fitDecimal` and `priorTradingDay`.
- Produces `export function realizedVolFromSettlements(settlementsNewestFirst: readonly number[]): { rv5: number | null; rv10: number | null }`. This is the existing formula, extracted.
- Produces `export function settlementsBefore(rows: readonly { date: string; settlement: number }[], dateStr: string): number[]`, newest first, with `date < dateStr` only.
- `addRealizedVolFeatures` reads `outcomes WHERE date <= D AND settlement IS NOT NULL ORDER BY date DESC LIMIT 12`.
  - `realized_vol_5d/10d` use the first 11 rows, as today.
  - `prev_day_realized_vol_5d/10d` use `settlementsBefore(rows, D)`: up to 11 prices, enough for the 10-day value. They go through `fitDecimal(…, 10, 6)`.
- `addRealizedIvRatioFeatures` also sets `rv_iv_ratio_10ct` = `prev_day_realized_vol_5d` over the same VIX term it uses today, through `fitDecimal(…, 6, 4)`.
- Produces `export function darkPoolFeaturesFromLevels(result: DarkPoolLevelsResult, spxOpen: number | null, suffix: '' | '_10ct'): FeatureRow`. `DarkPoolLevelsResult` is the return type of `getDarkPoolLevels` in `api/_lib/dark-pool-query.ts`.
  - It holds today's derived arithmetic, now shared.
  - `addDarkPoolFeatures` runs it twice: once on `getDarkPoolLevels({ date, symbol: 'SPX' })` with `''`, and once on `getDarkPoolLevels({ date, symbol: 'SPX', asOfTimeCT: '10:00' })` with `'_10ct'`.
  - It returns `dpReadOk = eodOk && morningOk`.
  - Every `dp_*_10ct` passes through `fitDecimal` with its type from Task 1.
- `addVolSurfaceFeatures` also sets `prev_day_iv_rank` from the `vol_realized` row dated `priorTradingDay(D)`, through `fitDecimal(…, 6, 2)`, or null if there's no such row.

- [ ] **Step 1: Write the failing tests** in `build-features-phase2.test.ts`:
  - **`prev_day_realized_vol_5d excludes the day's own settlement`:** settlements where D's move is a 5% outlier. The prev-day value equals the value computed from D-1 back.
  - **`prev_day_realized_vol_10d is set when D's settlement exists`:** 12 rows including D. The 10d value is non-null and equals the value from the 11 rows before D.
  - **`settlementsBefore` boundary:** a row dated exactly D is excluded, and one dated D-1 is included.
  - **The previous day across Thanksgiving:** for D = 2026-11-27, `prev_day_iv_rank` reads the 2026-11-25 row, and a decoy row dated 11-26 is ignored.
  - **`rv_iv_ratio_10ct uses the previous day's realized vol`.**
  - **The morning dark-pool read:** asserts `getDarkPoolLevels` was called with `asOfTimeCT: '10:00'`, and that its levels feed only the `_10ct` keys.
  - **Overflow:** support 5,000,000,000 and resistance 100,000 give `dp_support_resistance_ratio_10ct` null, the other `_10ct` set, and the row still written.
  - **`morning read throws, end-of-day read succeeds → dpReadOk false`.**
  - **`the previous-day vol_realized read rejects → prev_day_iv_rank unset, morningReadOk false`.** Its read sits in its own `try/catch`, not the vol-surface catch-all, so the cron reports `'partial'`, not `'success'`.
  - **In pglite (`neonOverPglite`), the as-of dark-pool cut:** prints at 09:59:59 and 10:00:01 CT. On 2026-03-06 (CST) and on 2026-06-15 (CDT), only the 09:59:59 print counts toward `dp_total_premium_10ct`. This one file may be a sixth test file for this task; if so, commit it separately right after.
  - **In `build-features.test.ts`:**
    - with `dpReadOk` false, the cron's overwrite list holds no `dp_*_10ct`;
    - with it true on a complete day, the list holds all 7;
    - the 11 columns are bound, COALESCEd and skipped by completeness.
- [ ] **Step 2:** Run the files and see them fail.
- [ ] **Step 3:** Implement. Push only after #214 is applied. Then the main session times one deployed `?date=` run (from the cron's Axiom `durationMs`) and records it in the spec's build-time limit. A mocked test can't measure it.
- [ ] **Step 4:** Mutants:
  - `date < D` → `date <= D`;
  - `priorTradingDay` → a calendar day;
  - `dpReadOk = eodOk` only;
  - no `asOfTimeCT`.

  Each must fail. Run `npm run review`.
- [ ] **Step 5: Commit** `feat(features): Add the previous-day realized vol and iv_rank, and the dark-pool levels as of 10:00 CT`.

### Task 5: Strike ladder at 10:00 CT

**Files:**
- Modify: `api/_lib/build-features-gex.ts`
- Test: `api/__tests__/build-features-gex.test.ts`
- Modify: `api/_lib/build-features-upsert.ts` (the 8 columns)
- Modify: `api/__tests__/build-features.test.ts`

**Interfaces:**
- Consumes: `fitDecimal`.
- Produces `export function computeStrikeFeatures(...)`, the existing function, exported unchanged.
- Produces `export function strikeSnapshotAt10ct(stamps: readonly Date[], dateStr: string): Date | null`. It returns the latest stamp with `ctWallClockToUtcIso(dateStr, 510) <= stamp < ctWallClockToUtcIso(dateStr, 600)`, else null. This is the one home of the strike window, which the repair calls too.
- Produces `export async function engineerStrikeFeatures10ct(sql, dateStr: string, features: FeatureRow): Promise<void>`.
  - It reads the day's distinct SPX 0DTE snapshot stamps (`SELECT DISTINCT timestamp … WHERE ticker = 'SPX' AND expiry = date AND date = D`, about 80 rows), picks with `strikeSnapshotAt10ct`, then reads that snapshot's rows.
  - **Prerequisite for the push:** #214 applied in production.
  - It runs `computeStrikeFeatures` on them with the snapshot's own spot, as today.
  - It copies only `charm_slope`, `gamma_wall_above_dist`, `gamma_wall_below_dist`, `neg_gamma_nearest_dist`, `gamma_asymmetry`, `charm_max_pos_dist`, `charm_max_neg_dist` and `charm_pattern` to their `_10ct` names, each through `fitDecimal` with its Task 1 type (`charm_pattern_10ct` as-is).
  - It sets nothing when no snapshot is in the window.
  - `engineerGexFeatures` calls it, and its existing end-of-day reads are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - **The window, on the pure function `strikeSnapshotAt10ct`:**
    - stamps 08:25, 08:30, 09:55 and 10:00:00 CT on 2026-06-15 (CDT) return 09:55;
    - 10:00:00 alone returns null;
    - 08:30:00 alone returns 08:30;
    - 08:25 alone returns null;
    - the same set on 2026-03-06 (CST) also returns 09:55.
  - **Through `engineerStrikeFeatures10ct` with the mocked `sql`:** the stamps query returns those four, and the second query is asked for 09:55. A wall distance is computed from the 09:55 rows' spot.
  - **No snapshot between 08:30 and 10:00:** no `_10ct` key set.
  - **The strike-stamps query rejects:** no `_10ct` key set. `captureException` gets fingerprint `['build-features-10ct-read', 'strike']`, and `morningReadOk` is false. The end-of-day strike features and greek features from the same call are still set, so the date isn't failed.
  - **`_mag` not copied:** `gamma_wall_above_mag_10ct` is never a key.
  - **`charm_slope_10ct` of 1e17 is null.** DECIMAL(20,4) holds less than 1e16.
  - **In `build-features.test.ts`:** the 8 columns are bound and COALESCEd, and completeness ignores them.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Mutants:
  - `< cut` → `<= cut`;
  - the 08:30 floor dropped;
  - an extra `_mag` copied.

  Each must fail. Run `npm run review`.
- [ ] **Step 5: Commit** `feat(features): Add the 0DTE strike-ladder features as of 10:00 CT`.

### Task 6: Repair library

**Files:**
- Create: `scripts/_lib/morning-features-repair.ts`
- Test: `scripts/_lib/morning-features-repair.test.ts`
- Modify: `tsconfig.scripts.json`

**Interfaces:**
- Consumes these, imported from `api/_lib` or `src/`, never copied:
  - `pcrFeaturesAt10ct`, `realizedVolFromSettlements`, `settlementsBefore`;
  - `darkPoolFeaturesFromLevels`, `getDarkPoolLevels`;
  - `strikeSnapshotAt10ct`, `computeStrikeFeatures`;
  - `fitDecimal`, `fitInteger`, `priorTradingDay`, `ctWallClockToUtcIso`;
  - the base branch's dark-pool complete-day check.
- Mirrors `scripts/_lib/options-volume-repair.ts` names:
  - `BACKUP_DIR = 'docs/tmp/morning-features-repair'`, `WRITE_CHUNK = 500`;
  - `COLUMNS` (the 23, with types);
  - `planRepair`, `comparePlan`, `runRepair`, `runUndo`, `exitCodeOf`, `exitCodeOfUndo`;
  - `parseArgs` (`--date`, `--since`/`--until`, `--all`, `--apply`, `--plan`, `--undo-file`, `--backup-dir`, `--env-file`), `USAGE`, `formatReport`, `formatApplyReport`, `formatUndoReport`.
- `planRepair(dates, sources)` is pure: per date it gives the 23 new values plus the stored before-values, and a pin. The pin records:
  - the stored `vix` and `spx_open`;
  - the `flow_ratio_monitor` row count and max `timestamp`;
  - the chosen strike snapshot timestamp and row count;
  - the `dark_pool_prints` count and max `executed_at`;
  - an `md5` of the SPX `index_candles_1m` and SPY `etf_candles_1m` rows in the window from `strikeWindowStart(D)` to `cutAt10ct(D)` inclusive: `string_agg(timestamp || ':' || close, ',' ORDER BY timestamp)`.
    - Filter by `timestamp`, since `etf_candles_1m` has no date column.
    - Those are the minutes the morning dark-pool ratio can use.
    - A count and max timestamp can't see the base branch's candle refit, which deletes and re-inserts the same minutes;
  - the `outcomes.settlement` values and `vol_realized.iv_rank` used.
- Writes are exact (not COALESCE), only to the 23 columns, and guarded by `IS NOT DISTINCT FROM` on all 23 before-values. They go 500 dates to an `unnest` UPDATE, all in one `sql.transaction`, with the backup written (`wx`) first.
- **The dark-pool complete-day rule:** the repair writes `dp_*_10ct` on incomplete days too, and lists them. That matches the cron: its 'keep' path still writes non-null values into empty columns through COALESCE.
- **`formatReport`** prints each new column's non-null share over the trainable dates (`feature_completeness >= 0.80`), and flags any under 50%. Task 8 Step 1 reads this.

- [ ] **Step 1: Write the failing unit tests:**
  - a date whose sources give known values plans exactly those, rounded to scale;
  - a date already holding them plans 0;
  - an out-of-range value plans NULL and is listed;
  - `comparePlan` refuses a changed pin (each pin field, one case each). That includes a candle row whose `close` changed under the same count and max timestamp;
  - `formatReport` shows a column at 60/147 as 41% and flags it as under 50%;
  - `parseArgs` refuses `--apply` without `--plan`, and more than one date without `--all`;
  - `exitCodeOf` is 1 on any skipped date.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm run review`.
- [ ] **Step 5: Commit** `feat(scripts): Plan the morning-features history repair (library)`.

### Task 7: Repair CLI

**Files:**
- Create: `scripts/repair-morning-features.ts`
- Test: `scripts/_lib/morning-features-repair-pglite.test.ts`
- Test: `scripts/_lib/morning-features-repair-cli.test.ts`
- Modify: `tsconfig.scripts.json`. Add the new CLI and test files to its explicit `include` list, as commit 1761010b0 did. Task 6 has already added the library.

**Interfaces:**
- Consumes: Task 6's exports and `scripts/_lib/db-host.ts` (`databaseOf`, no-echo rules).

- [ ] **Step 1: Write the failing pglite test.** Build stub source tables plus `training_features` with migrations including #214. Cover:
  - **The core cycle:** dry run → apply → re-apply plans 0 → undo restores the backup exactly.
  - **The stale guard:** a row changed after the plan isn't written, is listed, and gives exit 1.
  - **A source changed after the plan:** a print inserted gives a refusal before any write.
  - **A DB reject mid-batch:** 501 dates, the second statement fails, and 0 rows are written.
  - **The previous day across 2026-11-26:** handled for both `prev_day_realized_vol_5d` and `prev_day_iv_rank`.
  - **The refusals:**
    - a plan for another database;
    - more than one date without `--all`;
    - an existing backup file.
- [ ] **Step 2: Write the CLI test**, with the run functions mocked: argument errors print `USAGE`, and the exit code follows the run's result.
- [ ] **Step 3:** Implement the CLI, with a header naming the run steps as in `scripts/repair-options-volume.ts`.
- [ ] **Step 4:** Mutants:
  - the guard dropped;
  - chunks not in one transaction;
  - `wx` → `w`;
  - one pin field unchecked.

  Each must fail. Run `npm run review`.
- [ ] **Step 5: Commit** `feat(scripts): Add the repair-morning-features CLI with its pglite and CLI tests`.

### Task 8: Production repair run (main session, not an implementer)

**Prerequisites:** Tasks 1-7 on main, #214 applied, and the base branch's SPX candle refit applied.

- [ ] **Step 1:** Dry run of every date: `npx tsx scripts/repair-morning-features.ts --backup-dir docs/tmp/morning-features-repair --env-file .env.local`. Check that each column's non-null share over the 147 trainable dates is close to the spec's coverage table (dark pool 126, strike 117, PCR 141, iv_rank ~135, realized vol 147).
- [ ] **Step 2:** Hand-recompute one date per group from raw source rows by read-only SQL: the PCR rows, the strike ladder, the settlements, the dark-pool prints, and the `vol_realized` row. Each must match the plan to the column's scale.
- [ ] **Step 3:** Get the owner's OK. Then apply one date, read it back, re-plan, and apply `--all` with a backup.
- [ ] **Step 4:** Re-run the dry run. Expected: 0 to write.

### Task 9: ML constants, models and guard

**Files:**
- Modify: `ml/src/utils/__init__.py`
- Modify: `ml/src/phase2_early.py`
- Modify: `ml/src/clustering.py`
- Create: `ml/tests/test_feature_timing.py`
- Modify: `ml/tests/test_phase2.py`:
  - the categorical set at ~158-166 gets `charm_pattern_10ct`;
  - `test_main_with_fully_null_columns` (~1711-1722) uses `prev_day_realized_vol_5d` in place of `realized_vol_5d`, which leaves `ALL_NUMERIC_FEATURES`.

**Interfaces:**
- Produces these constants in utils:
  - `PCR_10CT_FEATURES` = `pcr_open`, `pcr_trend_t1_t2`, `pcr_max_10ct`, `pcr_min_10ct`, `pcr_range_10ct`, `pcr_spike_count_10ct`;
  - `GREEK_10CT_FEATURES` = `agg_net_gamma`, `dte0_net_charm`, `dte0_charm_pct`, `charm_slope_10ct`;
  - `STRIKE_10CT_FEATURES` = the six `*_dist_10ct` / `gamma_asymmetry_10ct`;
  - `DARK_POOL_10CT_FEATURES` = the 7;
  - `REALIZED_VOL_PREV_DAY_FEATURES` = `prev_day_realized_vol_5d`, `prev_day_realized_vol_10d`, `rv_iv_ratio_10ct`;
  - `VOL_SURFACE_PREV_DAY_FEATURES` = `prev_day_iv_rank`.
- Produces `POST_CUT_COLUMNS: frozenset[str]` and `RETIRED_COLUMNS: frozenset[str]`, as the spec lists them.
- Produces `OUTCOME_COLUMNS: frozenset[str]`: every non-feature column the loaders join in. These are the end-of-day results and labels: `settlement`, `day_high`, `day_low`, `day_range_pts`, `close_vs_open`, `vix_close`, `vix1d_close`, `recommended_structure`, `structure_correct`, plus every other outcome or label column `load_phase2_data` (`phase2_early.py:180-193`) and `load_data_clustering` (`clustering.py:162-166`) select. `day_open` is excluded, since it's known at the open. The guard forbids all three sets.
- In `clustering.py`, produces `def dummy_prefix(cat_col: str) -> str`. This is the existing rule (`cat_col.replace("_pattern", "").replace("_zone", "")`) moved into a function that `preprocess` calls, unchanged. So `charm_pattern_10ct` gives dummies `charm_10ct_<value>`, and the PCA loadings keep their naming.
- The existing constants keep their names and members.
- Each model gets `INPUT_COLUMNS: tuple[str, ...]`: every numeric and categorical source column, including `CHARM_PATTERN_COL` in clustering, which becomes `"charm_pattern_10ct"`.
- `phase2_early`'s `PER_STRIKE_FEATURES`, `PHASE2_FEATURES` (the realized-vol names) and `GREEK_FEATURES` switch to the new names.
- Both models drop `IV_PCR_FEATURES`, `DARK_POOL_FEATURES` and `VOL_SURFACE_FEATURES` for the new constants:
  - `PCR_10CT_FEATURES`, `DARK_POOL_10CT_FEATURES` and `VOL_SURFACE_PREV_DAY_FEATURES` in both models;
  - `STRIKE_10CT_FEATURES` and `REALIZED_VOL_PREV_DAY_FEATURES` in phase2 only, where their end-of-day twins are today.
- Clustering gains no group it lacks today. Its `GREEK_FEATURES` becomes `GREEK_10CT_FEATURES + ["charm_oi_t1", "charm_oi_t2"]`, so `charm_slope` becomes `charm_slope_10ct` (`clustering.py:128`).

- [ ] **Step 1: Write the failing guard tests** in `test_feature_timing.py`:
  - **`test_no_model_input_is_post_cut_retired_or_outcome`:** each model's `INPUT_COLUMNS` doesn't meet `POST_CUT_COLUMNS | RETIRED_COLUMNS | OUTCOME_COLUMNS`.
  - **`test_prepare_features_selects_only_input_columns`, and the same for `preprocess`:**
    - Run them on a frame holding every column of the three sets plus every new column.
    - Map each output column back to a source in `INPUT_COLUMNS`. For phase2, dummies go through `<source>_`. For clustering, they go through `dummy_prefix(source) + "_"`.
    - An output column that maps to no input source fails.
  - **`test_post_cut_columns_cover_the_named_families`:**
    - Read `api/_lib/db-migrations.ts` as text, repo-relative from `ml/tests/`, and collect every `\b[a-z0-9_]+_t[34]\b` column name in its `training_features` statements. Each must be in `POST_CUT_COLUMNS`.
    - So must the hard-coded `nope_am_mean`, `nope_am_sign_flips`, `nope_am_cum_delta`, `gex_oi_slope`, `gamma_wall_above_mag`, `gamma_wall_below_mag`, `neg_gamma_nearest_mag` and `gamma_0dte_allexp_agree`.
    - Assert the collected `_t3`/`_t4` list isn't empty, so a broken parse can't pass.
- [ ] **Step 2:** Run `F:\dev\strike-calculator\ml\.venv\Scripts\python -m pytest ml/tests/test_feature_timing.py`. Expected: FAIL.
- [ ] **Step 3:** Implement the constants and the model switches. Update `test_phase2.py`, and `test_clustering.py` if its fixtures name leaving columns. If that is a sixth file, do the clustering name reads (Task 10) as their own commit.
- [ ] **Step 4:** Mutants:
  - `DARK_POOL_FEATURES` put back in phase2;
  - `CHARM_PATTERN_COL` reverted;
  - `"vix_close"` added to phase2's `PHASE2_FEATURES`.

  Each must fail. Run the full `ml/` pytest, `ruff check src/ tests/`, `ruff format --check .`, then `npm run review`.
- [ ] **Step 5: Commit** `feat(ml): Give the models only features known by 10:00 CT, with a column-level guard`.

### Task 10: Clustering name reads

**Files:**
- Modify: `ml/src/clustering.py`
- Modify: `ml/tests/test_feature_timing.py`

- [ ] **Step 1: Write the failing test `test_cluster_reads_touch_no_post_cut_column`.**
  - Pass `characterize_clusters` and `save_plots` a `DataFrame` subclass:
    - It records every key given to `__getitem__`, `.get` and `.loc`, appending to one shared class-level list.
    - It overrides `_constructor` to return the subclass, so the spy survives the `df.copy()` both functions start with. A probe on pandas 3.0.2 confirmed that `copy()`, masks and `groupby(...)[list]` all keep it.
    - A plain subclass loses the spy at `copy()`, and the test would pass on unswitched code.
  - Point `ML_ROOT` at `tmp_path`.
  - Assert that no recorded key is in `POST_CUT_COLUMNS | RETIRED_COLUMNS`.
- [ ] **Step 2:** Run and see it fail.
- [ ] **Step 3:** Switch the `characterize_clusters` reads (~450-475: `dp_total_premium`, `dp_support_resistance_ratio`, `charm_pattern`) and the heatmap reads (~879-889: `charm_slope`, `dp_support_resistance_ratio`) to their `_10ct` twins. Remove the `iv_open` reads.
- [ ] **Step 4:** Mutant: revert one read, which must fail. Run pytest, ruff and `npm run review`.
- [ ] **Step 5: Commit** `feat(ml): Describe clusters with the 10:00 CT features`.

### Task 11: Research labels

**Files:**
- Modify: `ml/src/eda.py`, `ml/src/visualize.py`
- Test: `ml/tests/test_eda.py`, `ml/tests/test_visualize.py`

- [ ] **Step 1: Write the failing tests**, as options-volume phase 3b did:
  - the eda dark-pool, IV, strike and realized-vol sections print "end of day";
  - the retired IV lines print "retired (source stopped 2026-04-30)";
  - visualize's labels for those columns carry "(EOD)". Read them through a spy on `save`, with plots in `tmp_path`.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3:** Implement. No analysis changes its columns.
- [ ] **Step 4:** Run pytest, ruff and `npm run review`.
- [ ] **Step 5: Commit** `feat(ml): Label the end-of-day and retired features in the research output`.

### Task 12: Health and the plot-analysis prompt

**Files:**
- Modify: `ml/src/health.py`
- Test: `ml/tests/test_health.py`
- Modify: `api/_lib/plot-analysis-prompts.ts`
- Test: `api/__tests__/plot-analysis-prompts.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - **Health:**
    - `KEY_FEATURE_COLUMNS` holds `charm_pattern_10ct`, `prev_day_realized_vol_5d`, `dp_total_premium_10ct` and `dp_support_resistance_ratio_10ct`;
    - `iv_open` is gone from both `KEY_FEATURE_COLUMNS` and `check_stationarity`'s `monitor_cols` (~322-330);
    - a null-heavy `dp_total_premium_10ct` warns.
  - **The prompt:**
    - the dark-pool, IV/PCR, greek and vol-surface groups name their `_10ct` / `prev_day_` model columns, and call the old ones end-of-day research;
    - each group's names equal an exact set, as the options-volume prompt tests do;
    - the `correlations` text (24 columns) says which are model features.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3:** Implement. Update the embedded snippets that Tasks 9-11 changed.
- [ ] **Step 4:** Run pytest, vitest on the prompt test, and `npm run review`.
- [ ] **Step 5: Commit** `feat(ml): Watch the 10:00 CT features in health, and describe them in the plot-analysis prompt`.

### Task 13: Docs

**Files:**
- Modify: `ml/README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1:** Describe each group's morning and end-of-day columns and their timing, the guard, and the repair tool. List `api/_lib/analyze-prompts.ts:461` for the owner (it quotes a full-day IV figure).
- [ ] **Step 2:** Run `npm run review`. Commit `docs(ml): Describe the 10:00 CT feature groups`.

### Task 14: Snapshot pick at or before 10:00 CT

**Files:**
- Modify: `api/cron/build-features.ts` (`pickFeatureSnapshot`)
- Test: `api/__tests__/build-features.test.ts`
- Create: `scripts/repair-late-snapshot-picks.ts`
- Test: `scripts/_lib/late-snapshot-picks.test.ts`, with the library in `scripts/_lib/late-snapshot-picks.ts`
- Modify: `tsconfig.scripts.json` (the include list)

**Interfaces:**
- **The pick:** the window is applied where candidates are judged, in `featureSnapshotRejection` (`build-features.ts:251`).
  - A slot after 10:00 CT is rejected with a new reason, `'after-cut'`, so `reportNoPickDates` names why a date has no pick.
  - `pickFeatureSnapshot` then takes the nearest remaining slot, at most 60 min before 10:00. It keeps the tie rule (earlier wins) and the `spx_open` preference.
  - Its other callers, `scripts/_lib/stale-opening-range.ts:735` and `scripts/_lib/snapshot-price-context.ts:596`, keep their tests passing.
- **The dry run** reads only; it doesn't predict a rebuild's values. Per date whose stored pick is after 10:00, it lists:
  - **Which snapshot the stored row came from.** `training_features` doesn't store its pick, so the script finds it by matching. A trusted `market_snapshots` row of that date matches when its `vix`, `vix1d`, `spx_open` and `sigma` equal the stored values exactly, using the trust filter `SNAPSHOT_TRUST_COLUMNS_SQL`.
    - A date whose match is a slot after 10:00 CT is affected.
    - A date with no match, or with matches that disagree, goes to a "check by hand" list and is never written. A read-only mirror on 2026-11-26 matched all 167 picked dates exactly.
  - **The new pick:** the slot the new rule would take, or "no pick" (owner rule A: completeness about 0.08, so the date leaves training). It is computed with the cron's exported rule, never a copy of the old one;
  - the 23 columns to blank: the precedent's 22 plus `rv_iv_ratio_10ct`;
  - the up-to-20 later dates whose `vvix_percentile` will be recomputed.
- **The apply** follows `2026-11-22-feature-snapshot-trust-design.md:440-470`, one date at a time:
  1. Write a **full-row** backup of the date and its 20 `vvix_percentile` dates (`to_jsonb`, `wx`).
  2. Blank the 23 columns, guarded by `md5(to_jsonb(row))` against the dry run's read. A mismatch stops the run.
  3. Rebuild the date through the cron's `?date=`, then **parse the JSON body**. The cron answers HTTP 200 even when the date's build throws (`cron-instrumentation.ts` sends `{ status: result.status }`, and `deriveCronStatus` returns `'error'`).
     - The rebuild counts only when the body has `status === 'success'` and `featuresBuilt === 1`.
     - Anything else is a failure: `'error'`, `'partial'`, a non-200 or a timeout. `'partial'` counts as failure because the rebuilt row may lack a group.
     - A failure stops the run, restores that date from the backup, and exits 1.
  4. Recompute `vvix_percentile`. A failure stops the run, restores, and exits 1.
  5. Print a diff of every column of the rebuilt row against its backup. That shows what the full rebuild moved; it can't be predicted.
- **`--undo-file F --apply`** restores the full rows, guarded so it only writes rows that still hold what the apply wrote.

- [ ] **Step 1: Write the failing tests:**
  - **The pick:**
    - trusted slots 09:45 and 10:05 pick 09:45;
    - only 10:05 picks none, with reason `'after-cut'`;
    - 10:00 and 09:55 pick 10:00.
  - **The planner:** it lists only after-10:00 picks, and its blank set is exactly 23 columns.
  - **The planner's match:**
    - a stored row equal to the 10:05 snapshot is affected;
    - one equal to 09:55 isn't;
    - one equal to none goes to the "check by hand" list.
  - **The apply, with the cron call and SQL mocked:**
    - an md5 mismatch makes 0 writes;
    - a rebuild answering **200 with `{ status: 'error', featuresBuilt: 0 }`** restores that date and gives exit 1. So do 200 with `'partial'`, and a 500;
    - a `vvix` step that throws restores and gives exit 1;
    - an undo after a full apply restores every row;
    - an existing backup file is refused.
- [ ] **Step 2:** Run and see them fail.
- [ ] **Step 3:** Implement. Run the other callers' tests.
- [ ] **Step 4:** Mutant: `<= 600` → `<= 630`, which must fail. Run `npm run review`.
- [ ] **Step 5: Commit** in two commits: the pick (2 files), then the repair (4 files). Push after the close.
- [ ] **Step 6: Production run (main session):** dry run, hand-check one date, the owner's OK, one date, then the rest, then a re-run showing 0.

## What the plan review changed (2026-11-27)

- **The guard:**
  - adds `OUTCOME_COLUMNS` (the joined settlement, VIX-close and label columns);
  - maps clustering's dummies through an extracted `dummy_prefix`;
  - gains a `vix_close` mutant.
- **Shared selection:** every boundary is a pure function both the build and the repair call: `strikeSnapshotAt10ct`, `settlementsBefore`, and `pcrFeaturesAt10ct`'s cut.
- **The push gate:** Tasks 3-5 are pushed only after #214 is applied.
- **Builder details:**
  - PCR spikes are counted on the cut rows, nulls included;
  - realized vol reads 12 rows, so the previous-day 10d value exists;
  - `fitDecimal` handles exponent text;
  - `fitInteger` covers the INTEGER columns;
  - `DarkPoolLevelsResult` is the real type;
  - `new Date(ts).getTime()` replaces `Date.parse`.
- **Repair pins:** an md5 of the candle rows, which the refit's delete and re-insert can't fool. The dark-pool complete-day rule is stated, and the report shows each column's non-null share.
- **Task 14:**
  - the window sits in `featureSnapshotRejection`, with an `'after-cut'` reason;
  - the dry run lists picks and blanks, not predicted values;
  - the apply makes full-row backups, stops and restores on a failed rebuild or vvix step, and diffs each rebuilt row;
  - there are failure tests and an undo.
- **Smaller fixes:** the `tsconfig` include entries, and the build time measured on a deployed run.

**Second review (2026-11-27):**
- **Task 14 (the blocker):** the rebuild check parses the cron's JSON, because the cron answers 200 with `status: 'error'` on a failed date. Only `'success'` with `featuresBuilt === 1` passes; `'partial'` fails. It is tested with 200 plus `'error'`.
- **Task 14:** the dry run finds the stored pick by matching stored values to trusted snapshots, with a "check by hand" list. The spec's phase 5 wording now matches.
- **Global constraints:**
  - `setFitted` owns the once-per-date-and-column overflow log;
  - `cutAt10ct` / `strikeWindowStart` throw on a null instant;
  - every new read has its own `try/catch`, with a Sentry fingerprint and `morningReadOk` making the date `'partial'`. There is a reject test per group.
- **Dark pool:** the pglite "DP_COLUMNS against the real table" test is updated in Task 3 and tightened in Task 4 with `DP_10CT_COLUMNS`. Dark pool is named as the one SQL-side cut, with a pglite test on a CST and a CDT date.
- **ML:**
  - Task 9 says which groups clustering gets, and that its `GREEK_FEATURES` takes `charm_slope_10ct`;
  - the null-column test in `test_phase2.py` switches columns;
  - the `_t3`/`_t4` names come from the migration text;
  - Task 10's spy overrides `_constructor`, so it survives `df.copy()`;
  - health drops `iv_open` from both lists.
- **The candle pin window:** from `strikeWindowStart` to the cut, by timestamp.
