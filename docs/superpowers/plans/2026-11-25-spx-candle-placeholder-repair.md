# SPX/NDX Placeholder Candle Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tools and code fixes that let the SPX and NDX one-minute placeholder bars be replaced safely, the missing days be filled, and every stored value computed from them be rebuilt.

**Architecture:**
- **Repair tool.** One Node CLI fetches UW ETF bars and the Schwab ratio, checks the mapped day, then deletes and inserts in one transaction per date. It writes a JSONL backup and supports undo, and it reuses `scripts/_lib/candles-backfill.mjs`. A second mode corrects stale lottery spots.
- **Tape check.** A Python tool compares repaired minutes with the Full Tape.
- **Small code fixes:**
  - a feature overflow guard;
  - a dark-pool-only overwrite on rebuild;
  - a same-day lottery spot bound;
  - script flags so the rebuilds can be scoped.

**Tech Stack:** Node ESM scripts (vitest + pglite), TypeScript `api/` (vitest), Python 3 in `ml/.venv` (DuckDB, psycopg2, pytest).

**Spec:** `docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md`. It holds the findings, the decisions, the owner decisions 1–3 and the answered question 4 (same-day bound only, no age cap).

## Global Constraints

- **Method** (spec decision 1). An index bar is the UW ETF final bar × the per-day Schwab daily-close ratio: SPX from SPY, NDX from QQQ. Use `candles-backfill.mjs`'s `fetchUwCandles`, `loadSchwabCloses`, `ratioFor` and `toIndexRows`. Do not reimplement them.
- **Lists** (spec decision 2): exact dates, never ranges that touch other days.
  - `spx-repair`: the 32 trading days 2026-02-25 → 04-10.
  - `ndx-repair`: the trading days 2026-03-23 → 05-01.
  - `ndx-fill`: 2026-02-25 → 03-20, insert only.
  - `gap`: 2026-09-21 → 09-30 and 10-08 → 10-15, both symbols, insert only.
  - Trading days come from `src/data/marketHours.ts`. Good Friday 2026-04-03 is not one.
- **Delete predicate:**
  - SPX: `created_at < '2026-04-11'`, plus `timestamp < '2026-04-10T17:11:00Z'` on 04-10.
  - NDX: `created_at` within `2026-05-03T23:00:00Z`–`2026-05-03T23:59:59Z`.
  - Only dates in the symbol's repair list.
- **Per-date checks before any write:**
  - the mapped regular-bar count equals `cashSessionMinutes(date)`;
  - SPX: the last regular close is within 4 pt of `outcomes.settlement`;
  - NDX: the last regular close is within 15 pt of the Schwab `$NDX` daily close.
  - On a failure the date is skipped untouched, with the reason.
- **Backups.** JSONL with every column, plus a manifest, in the main checkout's `docs/tmp/spx-candle-repair/`. The main checkout is `git rev-parse --path-format=absolute --git-common-dir`, then its parent. A failed backup write means no delete.
- **Guards.** Keep `marketHoursRefusal` (08:15–15:30 CT) and the Schwab-token window (13:00–22:59 UTC) from the backfill scripts.
- **Tape gates** (spot-check tool, SPX only): median |d| ≤ 2 pt and p99 ≤ 5 pt; the ratio within 1e-6 on ≥ 99% of minutes, only where ETF rows are final (≤ 2026-04-27).
  - NDX has no tape price (UW leaves `underlying_price` NULL on NDX/NDXP prints), so the spec's NDX tape gate is replaced by the repair tool's NDX close and ratio checks.
- **Feature guard:** `|round4(v)| ≥ 10000` gives NULL.
- **Dark-pool overwrite:** only when the read succeeded, the date has `dark_pool_prints` rows, and it has the full `cashSessionMinutes` of SPX regular bars and of SPY ETF bars. A failed read sets the status to `partial`; no prints or short bars is a data state, recorded in `dpKept`.
- **SQL inside a transaction is tagged templates only.** Bulk writes use `unnest` batches of at most 500 rows.
- No migration, no env var, no new dependency, no new cron. Tests never touch a real DB or network (pglite and `vi.mock` only).
- `scripts/_tape_reader.py` is a nightly watch path; don't edit it.
- One commit per task after a green `npm run review`, at most 5 files per task. The repo is public, so wording stays neutral.

## Review Focus

1. **A partial UW answer** (200 with fewer bars) must skip the date, never delete-then-half-refill (Task 1).
2. **Re-running the repair, or running it after an undo,** must neither delete repaired rows nor lose the placeholders' `created_at` (Task 1).
3. **04-10 at 17:10Z is deleted, at 17:11Z kept.** The real afternoon rows have NULL `spx_schwab_price` too (Task 1).
4. **The dark-pool overwrite** must not blank the 18 legacy dates, or a date with a candle hole (Task 6).
5. **A gamma `--dry-run`** writes nothing and reads no fires. An unknown flag fails instead of silently writing (Task 8).

---

### Task 1: The candle repair tool

**Files:**
- Create: `scripts/_lib/index-candle-repair.mjs`
- Create: `scripts/repair-index-candle-placeholders.mjs` (the CLI: arguments, guards, wiring only)
- Test: `scripts/_lib/index-candle-repair-pglite.test.mjs`

**Interfaces (produces):**

```js
export const REPAIR_LISTS; // { 'spx-repair': string[], 'ndx-repair': string[], 'ndx-fill': string[], gap: string[] }
export const LIST_SYMBOLS; // { 'spx-repair': ['SPX'], 'ndx-repair': ['NDX'], 'ndx-fill': ['NDX'], gap: ['SPX','NDX'] }
export function deleteSelection(symbol, date); // { kind: 'repair', ... } | { kind: 'fill' } — the predicate's parameters, used only inside tagged templates
export async function prepareDay(sql, { symbol, date, closes, uwKey, waitForSlot }); // { ok: true, rows, ratio } | { ok: false, reason } — fetch + map + read outcomes.settlement + check, no writes
export function checkMappedDay({ symbol, date, rows, settlement, ndxClose }); // { ok: true } | { ok: false, reason: string }
export async function repairDay(sql, { symbol, date, list, rows, ratio, backupDir, apply }); // { date, symbol, ratio, deleted, inserted, skipped?: reason, manifest?: path }
export async function undoRepair(sql, manifestPath); // { restored, removed }
export function mainCheckoutDir(gitCommonDirOutput); // absolute main-checkout path from `git rev-parse --path-format=absolute --git-common-dir` output
```

**Rules:**
- **The CLI.** Flags: `--symbol SPX|NDX` (required); one of `--list <name>` or `--date D` (`D` must be in a list for that symbol); `--apply`; `--undo <manifest>`. It loads the Schwab closes once for the run, then for each date calls `prepareDay` and then `repairDay`. It decides nothing itself.
- **`prepareDay`** (in the lib, so it is tested):
  - It fetches the ETF bars (`fetchUwCandles`) and takes the ratio (`ratioFor`), then maps them (`toIndexRows`).
  - It reads `outcomes.settlement` for SPX, or the Schwab `$NDX` close, then calls `checkMappedDay`.
  - Each of these returns `ok: false` with a reason, and nothing is written: a UW error (`kind: 'error'`), an empty answer (`kind: 'empty'`), a missing ratio (`ratioFor` throws `DayFailure`), or a failed check.
- **SQL.** Every statement is a **tagged template** (`sql\`...\``), never `sql.query(text, params)`, because only lazy tagged templates run inside `sql.transaction` on both neon and the pglite test client (`api/__tests__/pglite-migrations.ts:48-57`). Inserts use `unnest(...)` arrays in batches of at most 500 rows (R5), all inside the one transaction.
- **`repairDay` with `apply`:**
  1. Select the rows the predicate matches.
  2. Write them to `<backupDir>/<symbol>-<date>-<ts>.jsonl`. Every column is written as text (`id`, `date::text`, `timestamp::text`, the NUMERICs `::text`, `created_at::text`), so restore is exact to the microsecond and independent of time zone.
  3. Write the manifest **before** the transaction, with `committed: false`. It records: symbol, date, the backup path, the backed-up ids, and a run marker `SELECT now()` read from the database.
  4. Open one `sql.transaction([...])`: the DELETE, then the batched INSERT `ON CONFLICT (symbol, date, timestamp) DO NOTHING RETURNING id`.
  5. After commit, rewrite the manifest with the inserted ids and `committed: true`.
  6. When the selection is empty and there is nothing to insert, write no backup and no manifest.
- **`repairDay` without `apply`:** report the counts and the ratio to 6 decimals.
- **`undoRepair`:** one transaction.
  - Delete the inserted ids.
  - If the manifest says `committed: false` (a crash between commit and the second write), fall back to rows of that symbol and date with `created_at >= marker AND id <> ALL(backed-up ids)`.
  - Then re-insert the backup rows with their original `id`, `created_at` and values.

- [ ] **Step 1: Write the failing tests.**
  - Use pglite with the real schema, through `applyMigration(pg, …)` for migrations 52, 54 and 112–114 from `api/__tests__/pglite-migrations.ts`, plus an `outcomes(date, settlement)` stub.
  - `vi.mock('./candles-backfill.mjs')` at the module boundary for the `prepareDay` cases.
  - Tests:
    - `prepareDay skips a UW error, an empty answer and a missing ratio` (R4): each returns `ok:false` with a reason, and nothing is written.
  - `lists hold the exact trading days`: `spx-repair` has 32 entries from `'2026-02-25'` to `'2026-04-10'`, without `'2026-04-03'`. `gap` has 14 entries, and none in 10-01 → 10-07.
  - `selects 04-10 placeholders before 17:11Z only`: rows at `17:10Z` (`created_at` 04-10) are selected; rows at `17:11Z` are kept.
  - `never selects a row written after the cut`: an SPX row with `created_at` 2026-11-25 on 03-26 is kept, and so is an NDX row with `created_at` 2026-05-04.
  - `selects nothing for fill lists`.
  - `skips a short or empty day before any write` (R4): 389 mapped bars, 0 bars, an SPX close 4.01 pt off settlement, no `outcomes` row, and an NDX close 15.01 off. Each returns `ok:false` with a reason; the table is unchanged and no backup file exists.
  - `replaces a placeholder day in one transaction`: 03-26 is backed up, deleted and inserted, the counts match, and the backup has `id` and `created_at`.
  - `a failed backup write deletes nothing` (R4): point `backupDir` at an existing *file* (a chmod trick doesn't block writes on Windows). The table is unchanged.
  - `undo works without the inserted ids`: simulate a crash after commit by dropping them from the manifest. The undo falls back to the run marker and restores the rows exactly.
  - `a DB error mid-transaction rolls back` (R4): force the INSERT to fail (e.g. a CHECK added in the test). The placeholder rows are still present.
  - `a second apply changes nothing`: re-run gives `deleted: 0, inserted: 0`.
  - `undo restores the exact rows`: after the undo, the rows equal the **original** rows as read before the repair (`id`, `created_at` to the microsecond, `date`, prices as text), and a fresh `repairDay` selects them again.
  - `a dry run writes nothing`.
  - `finds the main checkout from a worktree`: `mainCheckoutDir('F:/dev/strike-calculator/.git')` gives `F:/dev/strike-calculator`.
  - `a 1,000-row day inserts in batches of at most 500`.
- [ ] **Step 2:** `npx vitest run scripts/_lib/index-candle-repair-pglite.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement.** Keep the CLI thin: everything it decides lives in the lib.
- [ ] **Step 4:** Run the same file → PASS.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Repair placeholder index candles one day at a time, with backup and undo`.

### Task 2: The tape check tool

**Files:**
- Create: `scripts/verify_index_candle_repair.py`
- Test: `scripts/test_verify_index_candle_repair.py` (CI runs `scripts/test_*.py`)

**Interfaces:**

```python
def minute_stats(candles: dict[int, float], tape: dict[int, float]) -> dict  # keys: minutes, mean, median_abs, p95_abs, p99_abs, max_abs
def gate(stats: dict) -> tuple[bool, list[str]]  # SPX only: median_abs<=2 and p99_abs<=5
def ratio_share(index_closes: dict[int, float], etf_closes: dict[int, float], ratio: float, tol: float = 1e-6) -> float
```

**CLI:** `ml/.venv/Scripts/python.exe -I scripts/verify_index_candle_repair.py --symbol SPX --date 2026-03-26 [--before 17:11Z] [--ratio 10.040707]`.
- It prints the stats, the ratio share (when `--ratio` is given) and `PASS`/`FAIL` with reasons. The exit code is 0 or 1.
- Credentials come from `.env.local`, loaded in process for the four `R2_*` keys and `DATABASE_URL` only. They are never printed.
- The tape goes through `ml/src/utils/r2.py` `fulltape_connection(threads=4, memory_limit="3000MiB")`.
- **SPX only.** UW leaves `underlying_price` NULL on every `NDXP` and `NDX` print: on 2026-11-20, 40,526 and 5,823 prints, 0 with a price; checked 2026-11-25. So NDX can't be tape-checked. NDX is verified by the repair tool's own checks instead: the close against the Schwab `$NDX` daily close, and the ratio. The tool's `--symbol` accepts only `SPX`.
- **Paths.** `.env.local` and `ml/.venv` live only in the main checkout. Run the tool as `F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -I …`. It loads `.env.local` from the main checkout, found by the same `git rev-parse --git-common-dir` rule as the backups.
- The spot is the last `underlying_price` per UTC minute of non-canceled `SPXW` prints.
  - Use `epoch(executed_at)`, so the pre-05-01 naive-UTC layout works.
  - Filter `canceled` with `lower(CAST(canceled AS VARCHAR)) IN ('false','f','0')`, as `scripts/_eod_flow.py:168` does; the column is boolean in one layout and text in the other.
- Postgres is opened read-only.
- Zero matched minutes is a FAIL ("no overlap"), never a pass or a crash.

- [ ] **Step 1: Failing tests.** No DB or R2.
  - `minute_stats` on a hand-built pair gives exact median/p99/max.
  - `gate` passes `{median 0.95, p99 2.3}` and passes `{median 0.67, p99 4.9, max 25.3}`. That second case is 2026-11-20, a live day with one outlier minute; it is why the gate uses p99, not max.
  - `gate` fails `{median 25.1}` with a reason naming the median.
  - `--symbol NDX` is refused with a message saying the tape carries no NDX price.
  - `ratio_share` counts minutes within 1e-6.
  - Unmatched minutes are ignored.
  - Zero overlap fails with "no overlap".
- [ ] **Step 2:** `F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -m pytest scripts/test_verify_index_candle_repair.py -q` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then three read-only real runs:
  - `--symbol SPX --date 2026-08-12` should report median ≈ 0.95 and PASS;
  - 2026-11-20 should PASS, with median ≈ 0.67;
  - 2026-03-26 should FAIL with a median ≈ 25.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Check repaired index candles against the Full Tape spot`.

### Task 3: Correct stale lottery spots on the gap days

**Files:**
- Create: `scripts/_lib/lottery-spot-repair.mjs`
- Modify: `scripts/repair-index-candle-placeholders.mjs` (add `--lottery-spots`)
- Test: `scripts/_lib/lottery-spot-repair-pglite.test.mjs`

**Interfaces:**

```js
export const LOTTERY_SPOT_SCOPE; // { dates: [...13 gap days], partial: { date: '2026-09-21', after: '2026-09-21T16:18:00Z' } }
export async function planLotterySpots(sql); // [{ id, fire_time, fire_type, event_strike, old_spot, new_spot, old_dist, new_dist, still_passes }] plus { no_bar: [...] }
export async function applyLotterySpots(sql, plan, { backupDir }); // { updated, no_longer_pass, no_bar, manifest }
export async function undoLotterySpots(sql, manifestPath);
```

**Rules.** The column names come from migration #172 (`api/_lib/db-migrations.ts:4927-4955`): `fire_time`, `fire_type`, `event_strike`, `trade_strike`, `spot_at_event` (NOT NULL), `strike_dist`.
- **`new_spot`** is the close of the latest SPX `index_candles_1m` bar at or before `fire_time` **on the same ET session date**.
  - A fire with no such bar is left unchanged and listed under `no_bar`, because `spot_at_event` is NOT NULL.
- **`new_dist`** is computed from **`event_strike`**, never `trade_strike`, exactly as the finder does (`periscope-lottery-finder.ts:259,266` for calls, `:350,357` for puts).
- **`still_passes`:** puts need `event_strike < spot` and distance ≥ 10; calls need `event_strike > spot` and ≥ 15.
- **The UPDATE.**
  - It touches only `spot_at_event` and `strike_dist`, after a JSONL backup of `id`, `spot_at_event::text` and `strike_dist::text`.
  - It is one transaction of `unnest`-batched UPDATEs, at most 500 rows each, written as tagged templates.
  - Nothing is deleted (owner decision 2). It reports `no_longer_pass` and `no_bar`.
- `--lottery-spots` takes no `--symbol`. It keeps the 08:15–15:30 CT guard, needs no Schwab call, and runs after 15:00 CT (spec decision 5).

- [ ] **Step 1: Failing tests** (pglite stubs of `periscope_lottery_fires` and `index_candles_1m`):
  - `selects only gap-day fires and 09-21 after 16:18Z`;
  - `uses the same-day bar, never an earlier day`;
  - `computes the distance from event_strike, not trade_strike`;
  - `leaves a fire with no same-day bar unchanged and lists it`;
  - `a DB reject mid-batch rolls back every update` (R4);
  - `leaves outcome columns, trade_strike and entry_px untouched`;
  - `a failed backup changes nothing` (R4);
  - `undo restores spot and distance`;
  - `counts fires that no longer pass`;
  - `dry run writes nothing`.
- [ ] **Step 2–4:** RED, implement, GREEN (`npx vitest run scripts/_lib/lottery-spot-repair-pglite.test.mjs`).
- [ ] **Step 5: Gate and commit.** `feat(scripts): Correct gap-day lottery spots from the repaired candles`.

### Task 4: Overflow guard (spec 1a)

**Files:** Modify `api/_lib/build-features-phase2.ts` (the ratio at ~:375, and `oic_oi_change_pcr` at ~:540); its existing test file (find it with `git grep -l build-features-phase2 api/__tests__`).

**Rules:**
- `dp_support_resistance_ratio` and `oic_oi_change_pcr` become `null` when `Math.abs(Math.round(v * 1e4) / 1e4) >= 10000`.
- A comment says this only prevents the NUMERIC(8,4) overflow; the upsert still keeps an old value for `oic_oi_change_pcr`.

- [ ] **Step 1: Failing tests.** `it.each` over 35853, −35853, 10000, 9999.99996 (→ null) and 9999.9999, 1471, 0.5 (kept), for each field.
- [ ] **Steps 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Gate and commit.** `fix(features): Null a dark-pool or OI ratio too large for its column`.

### Task 5: Upsert overwrite option (spec 1b-i)

**Files:** Modify `api/_lib/build-features-upsert.ts`; test `api/__tests__/build-features.test.ts`, or the upsert's own test if one exists.

**Interfaces:**

```ts
export const DP_COLUMNS: readonly string[]; // the 7 dp_* columns, in table order
export async function upsertFeatures(features: FeatureRow, opts?: { overwrite?: readonly string[] }): Promise<…same as today>;
```

**Rule:**
- For a column in `opts.overwrite`, the conflict SET is `EXCLUDED.<col>`. Every other column keeps `COALESCE(EXCLUDED.<col>, training_features.<col>)`.
- No `opts` (or an empty list) builds the identical template, the same `strings` array as today, so the existing mock assertions stay as they are.
- The overwrite path is tested on the **rendered** query text (strings joined with their values).

- [ ] **Step 1: Failing tests:**
  - `keeps COALESCE for every column by default` (SQL text equal to today's);
  - `writes EXCLUDED for the overwrite columns only`;
  - `writes an explicit NULL for an overwritten column`;
  - `DP_COLUMNS lists the seven dp columns`;
  - `rejects an overwrite column that is not a feature column` (a TypeError).
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(features): Let a rebuild overwrite named columns`.

### Task 6: Dark-pool overwrite signal (spec 1b-ii)

**Files:** Modify `api/_lib/build-features-phase2.ts` and `api/cron/build-features.ts`; their tests.

**Rules:**
- `engineerPhase2Features` returns `{ dpReadOk: boolean }`, true when `getDarkPoolLevels` resolved with no caught error. It is not a `FeatureRow` key, so completeness is unchanged.
- A new exported `dpDayComplete(sql, date): Promise<boolean>`, in `build-features-phase2.ts`, makes one query. It is true when the date has all three:
  1. at least 1 `dark_pool_prints` row with `symbol = 'SPY'` (the levels query filters SPY, `dark-pool-query.ts:183`);
  2. `cashSessionMinutes(date)` SPX bars with `market_time = 'r'` in `index_candles_1m`;
  3. `cashSessionMinutes(date)` SPY bars in `etf_candles_1m` within the ET regular session. That table has no `date` or `market_time`, so the window is `09:30 ET ≤ timestamp < close`, with the close from `getMarketCloseHourET(date)` (13:00 on a half day). Build both instants with the repo's ET helpers.

  The levels query JOINs both candle tables (`dark-pool-query.ts:146-152`).
- The cron calls it after `engineerPhase2Features`, then passes `{ overwrite: dpReadOk && dpComplete ? DP_COLUMNS : [] }` to `upsertFeatures`.
  - Keep it a separate function, so `build-features-phase2.test.ts`'s positional mocks don't shift. In `build-features.test.ts`, mock it at the module boundary and expect one added call in the sequence.
- **Status.**
  - A dark-pool read failure (`dpReadOk` false) on any date sets the run's status to `partial`, even on a one-date run. Set it explicitly in the cron's result, not through `errors`/`deriveCronStatus`, which would return `error` when 1 of 1 dates "fails" (`cron-instrumentation.ts:556-561`) and would misname a written row as a failed write.
  - No prints, or short bars, is a data state, not a failure: the status is unchanged, and the date is listed in metadata `dpKept`. This follows the 11-22 no-pick pattern. The spec's 1b text is updated to match.

- [ ] **Step 1: Failing tests:**
  - `overwrites dp on a full day with prints`;
  - `keeps dp when the date has no prints` (the 18 legacy dates; Review Focus 4);
  - `keeps dp when SPX bars or SPY ETF bars are short`;
  - `keeps dp and reports partial when the dark-pool read rejects, on a one-date run` (R4);
  - `completeness is unchanged by the signal`.
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(features): Rebuild dark-pool features only from a complete day`.

### Task 7: Same-day lottery spot (spec 1c)

**Files:** Modify `api/_lib/periscope-lottery-finder.ts` (the two lookups ~:130-132, ~:508-510); its test.

**Rule:** The spot lookup adds `AND date = <event's ET session date>`. With no same-day bar there is no spot, so no fire, which is the existing no-spot path. There is no age cap (owner decision 4).

- [ ] **Step 1: Failing tests:**
  - `uses the latest bar on the event's own day`;
  - `finds no spot when the day has no bars yet, instead of an earlier day's close`.

  Assert the SQL carries the date bound, and that the no-spot path fires nothing.
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `fix(lottery): Read the SPX spot only from the event's own session`.

### Task 8: Gamma fire script flags (spec 2b-i)

**Files:**
- Create: `scripts/_lib/gamma-fires-backfill.mjs`, or `.ts` to match the script's import style. It takes the logic that `main()` runs at import today.
- Modify: `scripts/backfill-gamma-setup-fires.ts`
- Test: `scripts/_lib/gamma-fires-backfill.test.mjs`

**Rules:**
- `--dry-run` prints `date  fires` per date and writes nothing. It never reads `ws_gamma_setup_fires`: it skips the closing summary `SELECT` (~:743) as well as the inserts and the outcome fill.
- `--outcomes-only` skips detection and insertion, and fills `ret_*` only for fires with `fired_at` in `[--from, --to]`. That window is not clamped by the GEXBot cutover.
- **The window** is inclusive ET session dates: `fired_at >= <from 00:00 ET> AND fired_at < <(to + 1 day) 00:00 ET>`, with the instants built by the repo's ET helpers. `--from 2026-09-21 --to 2026-09-21` must select 09-21's fires.
- **A pure move.** `insertFires` and `backfillOutcomes` keep their per-row loops. Batching them (R5) is out of scope for this task, and the report says so for the reviewer.
- When `--from`/`--to` are passed **explicitly**, the outcome fill is limited to that window. With neither passed, the fill stays table-wide, as today (`:478-484`). So with no flags, behaviour is unchanged.
- An unknown flag exits 2.

- [ ] **Step 1: Failing tests** (`vi.mock` the DB module):
  - `rejects an unknown flag` (`--dry-run` typo `--dryrun`);
  - `dry run performs no INSERT or UPDATE and reads no fires` (no query names `ws_gamma_setup_fires`);
  - `outcomes-only runs no detection`;
  - `outcome fill is bounded to an explicit window`;
  - `outcome fill stays table-wide with no window`;
  - `outcomes-only window is not clamped to the cutover`;
  - `a one-day window covers that whole ET day` (assert the bound instants);
  - `a DB reject exits non-zero and never reports success` (R4).
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(scripts): Scope the gamma fire backfill and give it a dry run`.

### Task 9: Regime script range (spec 2b-ii)

**Files:**
- Create: `scripts/_lib/regime-0dte-backfill.mjs` (or `.ts`)
- Modify: `scripts/backfill-regime-0dte.ts`
- Test: one test file for the lib.

**Rule:** `--from/--to` limits the candidate dates. With no flags, behaviour is unchanged. The dry run prints each row as today.

- [ ] **Step 1: Failing tests:**
  - `limits dates to the range`;
  - `no range keeps every intersection date`;
  - `rejects from > to`;
  - `a DB reject exits non-zero and never reports success` (R4).
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(scripts): Let the 0DTE regime backfill take a date range`.

### Task 10: `fetch-day-ohlc ?date=` (spec 2b-iii)

**Files:**
- Create: `api/_lib/cron-target-date.ts`
- Modify: `api/cron/fetch-day-ohlc.ts`, `api/cron/embed-yesterday.ts`
- Test: `fetch-day-ohlc`'s test

**Rule:**
- Move `embed-yesterday`'s `resolveTargetDate` and `InvalidDateParamError` into a shared `api/_lib/cron-target-date.ts`. Its signature becomes `resolveTargetDate(dateParam, today, fallback: (today) => string)`, so `embed-yesterday` passes `priorWeekday` and `fetch-day-ohlc` passes `priorTradingDay`. `embed-yesterday`'s behaviour and tests are unchanged.
- `fetch-day-ohlc` sets `passReq: true` and reads `?date=`. An invalid or non-past date throws `InvalidDateParamError`, so it answers **500**, the same status `embed-yesterday` gives today (its tests pin 500), with an `errorPayload` naming the error.
- No `?date=` keeps `priorTradingDay(ctx.today)`.
- This is 5 files: the new lib, its table test `api/__tests__/cron-target-date.test.ts`, the two crons, and the `fetch-day-ohlc` test. `embed-yesterday`'s existing tests cover its side.

- [ ] **Step 1: Failing tests.**
  - `cron-target-date` is TDD with an input/output table:
    - a valid past date;
    - today and a future date, both rejected;
    - a malformed date, rejected;
    - no date, which falls to the fallback.
  - The cron: `targets the given date`, `rejects a malformed or future date with 500 and names it`, and `keeps the prior trading day without a date`.
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(cron): Let fetch-day-ohlc rebuild a given date`.

### Task 11: Backup and scoped-delete helper for the rebuilds

**Files:**
- Create: `scripts/_lib/rebuild-backup.mjs`
- Create: `scripts/rebuild-backup.mjs` (the CLI)
- Test: `scripts/_lib/rebuild-backup-pglite.test.mjs`

**Interfaces:**

```js
export const BACKUP_TABLES; // { training_features: 'date', day_labels: 'date', ws_gamma_setup_fires: 'fired_at', flow_regime_0dte_daily: 'date', day_embeddings: 'date' }
export async function backupRows(sql, { table, dates, backupDir }); // JSONL of every column as text, rows whose date column falls on `dates` (ET session date for fired_at); { rows, path }
export async function deleteGammaFires(sql, { from, to, backupPath }); // refuses unless backupPath exists and lists exactly the rows it would delete; { deleted }
export async function nullGammaReturns(sql, { date, backupPath }); // NULLs ret_* on that date's fires, same backup rule; { updated }
export async function restoreRows(sql, { table, backupPath }); // one transaction: delete the rows on the backed-up keys, re-insert the backup (text values cast back to each column's type); { restored }
```

**Rules:**
- Only the allowlisted tables are accepted.
- Every mutation refuses to run without a matching backup file. It is one transaction of tagged templates, and dry run is the default; `--apply` writes.
- `deleteGammaFires` also refuses if any selected fire has `trade_taken = true` or a non-NULL `trade_*` column. Those are manual journal entries (migration ~5079-5083); none exist in 02-26 → 04-17 (193 fires, 0 taken; checked 2026-11-25).
- `restoreRows` is the undo for the rebuild steps that have no dry run. It casts each text value back to its column's type from `information_schema.columns`, including `vector` for `day_embeddings`.
- The CLI flags are:
  - `--backup <table> --dates <list|from..to>`;
  - `--delete-gamma-fires --from --to --backup-file <path>`;
  - `--null-gamma-returns --date --backup-file <path>`;
  - `--restore <table> --backup-file <path>`;
  - `--apply`.

- [ ] **Step 1: Failing tests:**
  - `refuses a table outside the allowlist`;
  - `backs up only the given dates`;
  - `delete refuses without a matching backup` (R4);
  - `delete refuses a fire with a journal entry`;
  - `delete removes exactly the backed-up rows`;
  - `null-returns touches only ret_* on that date`;
  - `restore brings back the exact rows` (pglite, non-vector columns);
  - `restore casts a vector column with ::vector` (assert the built SQL text; pglite has no pgvector);
  - `a DB reject mid-transaction rolls back` (R4);
  - `dry run writes nothing`.
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(scripts): Back up and scope the rows a rebuild will rewrite`.

## Execution order and the production runbook (controller; owner OK given for each step after its checks)

**Order:**
1. Tasks 1 and 2.
2. Runbook A, outside 08:15–15:30 CT and 13:00–22:59 UTC.
3. Task 3, then Runbook B (lottery spots) after 15:00 CT.
4. Tasks 4–11.
5. Push (needs the owner's OK; api/ + scripts/).
6. Runbook C, after 15:00 CT.

**Which steps have no dry run:** `build-features?date=`, `embed-yesterday?date=` and `fetch-day-ohlc?date=`. For those, the Task 11 backup taken just before is the safety net.

**Runbook A: the candles.** Run every command from the worktree, with `--env-file=F:/dev/strike-calculator/.env.local` (the env file lives only in the main checkout).
1. `node --env-file=F:/dev/strike-calculator/.env.local scripts/backfill-etf-candles-1m.mjs --from 2026-02-25 --to 2026-05-01` (fill-only), then the same for each gap day.
2. **Canary:**
   - `repair-index-candle-placeholders.mjs --symbol SPX --date 2026-03-26`, dry run, then `--apply`;
   - `verify_index_candle_repair.py --symbol SPX --date 2026-03-26 --ratio <the ratio the dry run printed>` must PASS;
   - NDX on 03-26 goes through the repair tool only: its close and ratio checks run in-tool, and NDX has no tape check.
3. **The rest:** `--list spx-repair`, `--list ndx-repair`, `--list ndx-fill`, then `--list gap` for both symbols. Each runs as a dry run first.
4. **Spot-checks** with the tape tool: 02-26; 04-10 (`--before 17:11Z`); 10-09 (tape only; its ETF rows are frozen). Pass the ratio from the dry run, printed to 6 decimals. NDX 04-20 is covered by the tool's in-tool checks in its run log.
5. **Residual check** (read-only). It must return 0 rows:

   ```sql
   SELECT symbol, date, count(*) FROM index_candles_1m
   WHERE (symbol = 'SPX' AND created_at < '2026-04-11'
          AND NOT (date = '2026-04-10' AND timestamp >= '2026-04-10T17:11:00Z'))
      OR (symbol = 'NDX' AND created_at BETWEEN '2026-05-03T23:00:00Z' AND '2026-05-03T23:59:59Z')
   GROUP BY 1, 2
   ```

   Any row there is a batch row outside the lists. Rows filed under 02-25 are expected to clear.
6. Any FAIL stops the run and goes to the owner.

**Runbook B** (after 15:00 CT): `--lottery-spots` dry run, then apply. Report `no_longer_pass` and `no_bar`.

**Runbook C: the rebuilds,** after the push and after 15:00 CT. Each step comes after a Task 11 backup.
1. **Features.**
   - Read-only pre-check: every one of the 28 dates (03-23 → 04-10, 09-21, the 13 gap days) has `cashSessionMinutes` SPX `r` bars, the same number of SPY ETF bars, and SPY prints. A date that fails goes to the owner before the rebuild.
   - Back up `training_features` and `day_labels` for the 28 dates.
   - Call `build-features?date=` for each one. Every response must show the date **not** in `dpKept`. A date listed there is a stop: its stale `dp_*` values were kept, so report it.
   - Resolve Sentry `SENTRY-EMERALD-DESERT-MB`.
2. **Gamma fires:**
   1. Run `--dry-run --from 2026-02-26 --to 2026-04-17`.
   2. Show the owner the per-date counts next to the stored ones. A date that loses every fire, or gains more than double, gets checked first (spec decision 8).
   3. Back up `ws_gamma_setup_fires` for the window, run `rebuild-backup.mjs --delete-gamma-fires`, then run the script without `--dry-run`.
   4. For 09-21: back up, `--null-gamma-returns --date 2026-09-21` (expect 12 updated), then `--outcomes-only --from 2026-09-21 --to 2026-09-21`. Expect 12 pending and 12 filled; any other count is a stop.
3. **Regime.** Back up `flow_regime_0dte_daily` for 09-21. Run `backfill-regime-0dte.ts --from 2026-09-21 --to 2026-09-21`, compare its printed row with the stored one, then `--apply`.
4. **Day embeddings.** Back up `day_embeddings` for 09-21 and the gap days. Call `embed-yesterday?date=` then `fetch-day-ohlc?date=` for each.
5. Record the results in the spec, and update memory `project_spx_candle_placeholder_gaps.md`.
