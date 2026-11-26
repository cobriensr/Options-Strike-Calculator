# SPX/NDX Placeholder Candle Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tools and code fixes that let the SPX and NDX one-minute placeholder bars be replaced safely, the missing days be filled, and every stored value computed from them be rebuilt.

**Architecture:**
- **Repair tool.** One Node CLI fetches UW ETF bars and the Schwab ratio, checks the mapped day, then deletes and inserts in one transaction per date. It writes a JSONL backup and supports undo, and it reuses `scripts/_lib/candles-backfill.mjs`. A second mode corrects stale lottery spots.
- **Tape check.** A Python tool compares repaired minutes with the Full Tape.
- **Refit** (added 2026-11-26). The tape tool exports a minute index price per date: the tape's SPX spot, or same-day NDXP put-call parity. The repair tool fits each date's ratio to it, checks the fit against Schwab's daily high and low, and replaces the rows the date's earlier run inserted.
- **Small code fixes:**
  - a feature overflow guard;
  - a dark-pool-only overwrite on rebuild;
  - a same-day lottery spot bound;
  - script flags so the rebuilds can be scoped.

**Tech Stack:** Node ESM scripts (vitest + pglite), TypeScript `api/` (vitest), Python 3 in `ml/.venv` (DuckDB, psycopg2, pytest).

**Spec:** `docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md`. It holds the findings, the decisions (decision 9, the refit, was added 2026-11-26), owner decisions 1–3, the answered question 4 (same-day bound only, no age cap), and owner decisions 5 and 6 (refit SPX from the tape; refit NDX from parity where the quotes are good), 7 (include the summer backfill) and 8 (fix the gamma fires' day context after each hole in place).

## Global Constraints

- **Method** (spec decision 1). An index bar is the UW ETF final bar × the per-day Schwab daily-close ratio: SPX from SPY, NDX from QQQ. Use `candles-backfill.mjs`'s `fetchUwCandles`, `loadSchwabCloses`, `ratioFor` and `toIndexRows`. Do not reimplement them.
- **Lists** (spec decision 2): exact dates, never ranges that touch other days.
  - `spx-repair`: the 32 trading days 2026-02-25 → 04-10.
  - `ndx-repair`: the trading days 2026-03-23 → 05-01.
  - `ndx-fill`: 2026-02-25 → 03-20, insert only.
  - `gap`: 2026-09-21 → 09-30 and 10-08 → 10-15, both symbols, insert only.
  - `summer`: 2026-07-22 → 09-04, both symbols, `--refit` only (spec decision 9, owner decision 7).
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
- **Refit** (spec decision 9). A refit date's ratio is fitted to a minute price file: SPX from the tape, NDX from same-day NDXP parity. Each date must pass these gates, or it keeps its rows and the reason is printed:
  - SPX at least 99% of `cashSessionMinutes` matched;
  - NDX at least 150 minutes and scatter ≤ 6 pt;
  - `|fitted ÷ close ratio − 1| ≤ 0.0015`;
  - the Schwab daily high/low level check (SPX 2 pt, NDX 6 pt);
  - no minute that a replaced row covers is left without a new row.

  A fitted day keeps only the count check of the in-tool checks: neither close check applies, and it reads no close reference (spec decision 9). A refit replaces only the `insertedIds` of the date's one current manifest, and never refits a date that is already refit: undo first. `--check` verifies every refit date after the write against the measured `priorRatio`, and keeps the repair's guards.
- **Feature guard:** `|round4(v)| ≥ 10000` gives NULL.
- **Dark-pool overwrite:** only when the read succeeded, the date has SPY `dark_pool_prints` in the regular session, and it has the full `cashSessionMinutes` of SPX regular bars and of SPY ETF bars. A failed read sets the status to `partial` and lists the date in `dpReadFailed`; no prints, short bars or no `spx_open` is a data state, recorded in `dpKept`.
- **SQL inside a transaction is tagged templates only.** Bulk writes use `unnest` batches of at most 500 rows.
- No migration, no env var, no new dependency, no new cron. Tests never touch a real DB or network (pglite and `vi.mock` only).
- `scripts/_tape_reader.py` is a nightly watch path; don't edit it.
- One commit per task after a green `npm run review`, at most 5 files per task. The repo is public, so wording stays neutral.

## Review Focus

1. **A partial UW answer** (200 with fewer bars) must skip the date, never delete-then-half-refill (Task 1).
2. **Re-running the repair, or running it after an undo,** must neither delete repaired rows nor lose the placeholders' `created_at` (Task 1).
3. **04-10 at 17:10Z is deleted, at 17:11Z kept.** The real afternoon rows have NULL `spx_schwab_price` too (Task 1).
4. **The dark-pool overwrite** must not blank the 18 legacy dates, or a date with a candle hole (Task 6).
5. **A gamma `--dry-run`** writes nothing, and reads no fires except under `--context-only`. An unknown flag fails instead of silently writing, and `--context-only` never runs table-wide (Task 8).
6. **A refit replaces exactly the rows its manifest inserted.** It never touches a live row on the same date, and never leaves half a day (Task 14).
7. **A failed refit gate leaves the date's rows untouched** and names the gate: no price file, too few minutes, too much scatter, too large a move from the close ratio, or a same-sign high/low miss (Tasks 13–14).
8. **Re-running a partly applied refit list** changes nothing on the dates already refit, and `--check` still passes on them (Task 14).

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
  1. at least one SPY print in the regular session (`09:30 ET ≤ executed_at < close`): a `dark_pool_prints` row with `symbol = 'SPY'` (the levels query filters SPY, `dark-pool-query.ts:183`). The window is the one of condition 3, where the candles are proven complete; a print outside it may have no candle minute to join, so it yields no level;
  2. `cashSessionMinutes(date)` SPX bars with `market_time = 'r'` in `index_candles_1m`;
  3. `cashSessionMinutes(date)` SPY bars in `etf_candles_1m` within the ET regular session. That table has no `date` or `market_time`, so the window is `09:30 ET ≤ timestamp < close`, with the close from `getMarketCloseHourET(date)` (13:00 on a half day). Build both instants with the repo's ET helpers.

  The levels query JOINs both candle tables (`dark-pool-query.ts:146-152`).
- The cron calls it after `engineerPhase2Features`, then passes `{ overwrite: dpReadOk && dpComplete ? DP_COLUMNS : [] }` to `upsertFeatures`.
  - Keep it a separate function, so `build-features-phase2.test.ts`'s positional mocks don't shift. In `build-features.test.ts`, mock it at the module boundary and expect one added call in the sequence.
- **Status.**
  - A dark-pool read failure (`dpReadOk` false) on any date sets the run's status to `partial`, even on a one-date run. Set it explicitly in the cron's result, not through `errors`/`deriveCronStatus`, which would return `error` when 1 of 1 dates "fails" (`cron-instrumentation.ts:556-561`) and would misname a written row as a failed write.
  - No prints, short bars, or no `spx_open` is a data state, not a failure: the status is unchanged, and the date is listed in metadata `dpKept`. This follows the 11-22 no-pick pattern. The spec's 1b text is updated to match.

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
- **`--context-only`** (spec decision 7, owner decision 8) skips detection, insertion and the outcome fill. It needs an explicit `--from` and `--to`, and exits 2 without them or together with `--outcomes-only`. The window is not clamped by the GEXBot cutover.
  - For each ET session date in the window that has fires, it calls `loadDayContext(sql, <12:00 ET on that date>)` and `getConfidenceTier(ctx.dow_label, ctx.pre_day_filter_fires)` from `api/_lib/gamma-detector.ts`.
  - Then one `UPDATE ws_gamma_setup_fires SET prior_5d_ret, prior_iv_rank, pre_day_filter_fires, open_gap_pct, confidence_tier` per date, bounded by that date's ET window (the window rule below). No other column changes. Runbook C runs it over 17 dates.
  - It prints `date  fires  updated` per date.
  - With `--dry-run` it reads each date's fires and prints, per column, the stored values next to the new one, and writes nothing. It is the one dry run that reads `ws_gamma_setup_fires`.
- An unknown flag exits 2.

- [ ] **Step 1: Failing tests** (`vi.mock` the DB module):
  - `rejects an unknown flag` (`--dry-run` typo `--dryrun`);
  - `dry run performs no INSERT or UPDATE and reads no fires` (no query names `ws_gamma_setup_fires`);
  - `outcomes-only runs no detection`;
  - `outcome fill is bounded to an explicit window`;
  - `outcome fill stays table-wide with no window`;
  - `outcomes-only window is not clamped to the cutover`;
  - `a one-day window covers that whole ET day` (assert the bound instants);
  - `a DB reject exits non-zero and never reports success` (R4);
  - `context-only needs an explicit window, and refuses outcomes-only beside it` (exit 2 each);
  - `context-only runs no detection, no insert and no outcome fill`;
  - `context-only updates only the five day-context columns, bounded to each date's ET window` (assert the SET list and the bound instants);
  - `context-only takes the tier from getConfidenceTier` (`vi.mock` the detector: a Monday whose filter fires gives MAXIMUM);
  - `context-only dry run prints stored and new values and writes nothing`;
  - `context-only window is not clamped to the cutover`;
  - `a DB reject during context-only exits non-zero` (R4).
- [ ] **Steps 2–5:** RED, implement, GREEN; gate and commit. `feat(scripts): Scope the gamma fire backfill, give it a dry run, and recompute a window's day context`.

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

### Task 12: Price-file export and the fitted gate (spec 9, phase 2c)

**Files:**
- Modify: `scripts/verify_index_candle_repair.py`
- Test: `scripts/test_verify_index_candle_repair.py`

**Interfaces (produces):**

```python
def parity_levels(quotes: Iterable[tuple[int, float, str, float]], band: float = 0.005, min_strikes: int = 2) -> dict[int, float]  # (minute, strike, side 'c'|'p', mid) -> level per minute
def spots_document(symbol: str, day: date, source: str, minutes: Mapping[int, float]) -> dict  # {"symbol", "date", "source", "minutes": {"<minute>": price}}
def write_spots(out_dir: Path, doc: dict) -> Path  # <out_dir>/<SYMBOL>-<date>-spots.json, exclusive create; FileExistsError if present
def gate(stats: dict, fitted: bool = False) -> tuple[bool, list[str]]  # fitted: p99 > 5 is a note line, not a reason
```

**Rules:**
- `--export-spots <dir>` writes the date's price file and reads no candles.
  - `--symbol SPX` gives source `tape`: the minutes from `TAPE_SQL`, unchanged.
  - `--symbol NDX` gives source `parity`: the minutes from a new `PARITY_SQL` fed through `parity_levels`.
  - It prints the minute count and the path, then exits 0.
  - Zero minutes exits 2 with the reason and writes nothing.
  - An existing file is kept, never rewritten: it prints `kept <path>` and exits 0, so a re-run of the runbook reuses the files it already wrote.
- `--symbol NDX` without `--export-spots` is still refused, with today's message.
- **`PARITY_SQL`.**
  - It takes rows of `option_chain_id LIKE 'NDXP%'` with `expiry = DATE '<date>'`, the `canceled` filter `TAPE_SQL` uses, and `nbbo_bid > 0 AND nbbo_ask > nbbo_bid`.
  - Strike, bid and ask are `CAST(... AS DOUBLE)`. The old tape layout stores them as `DECIMAL(18,4)`, and 47 of the 61 NDX dates use it; a Decimal times a float band raises in Python.
  - Per (minute, strike, side), the mid is that of the last print, ordered by `executed_at, id`. Minute is `floor(epoch(executed_at) / 60)`; side is the lower-cased first letter of `option_type`.
- **`parity_levels`.** Per minute, pair the call and put of each strike: `strike + call mid − put mid`. The minute's rough level is the median of those. Keep the strikes with `|strike − rough| <= band × rough`; the bound is inclusive. With at least `min_strikes` kept, the level is their median.
- **`--fitted`.** p99 > 5 prints as a note, and median ≤ 2 still gates.
- **CI.** Read the workflow job that runs `scripts/test_*.py` and confirm it installs `duckdb` and `pyarrow`. If it doesn't, add them to that job's install step in this task, as a sixth file. Never let the DuckDB test skip silently in CI.

- [ ] **Step 1: Failing tests** (no DB or R2):
  - `parity_levels`:
    - one minute with strikes 24000 (call 105, put 95), 24050 (60, 100) and 24100 (25, 115) gives 24010;
    - a strike beyond 0.5% is left out;
    - a minute with one strike, or with calls only, has no level.
  - `PARITY_SQL` on a local Parquet file written with pyarrow and run in an in-memory DuckDB, parametrized over both tape layouts (`TAPE_LAYOUTS` in the test file):
    - a canceled print, a zero bid, another expiry and an `SPXW` root are left out;
    - the last print of a side wins;
    - the old layout's DECIMAL columns give the same levels as the new layout's.
  - `parity_levels`: a strike exactly on the 0.5% bound is kept.
  - `write_spots`: an existing file raises and is left unchanged; the document has string minute keys.
  - The CLI:
    - NDX without `--export-spots` is refused;
    - zero minutes (with the fetch mocked) exits 2 and writes no file;
    - an existing file prints `kept` and exits 0, with the file unchanged.
  - `gate`:
    - `fitted=True` passes `{median 0.33, p99 18.2}` with a note;
    - `fitted=True` fails `{median 2.5}`;
    - `fitted=False` still fails p99 18.2.
- [ ] **Step 2:** `F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -m pytest scripts/test_verify_index_candle_repair.py -q` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS. Then three read-only exports into a scratch dir. The expected counts are the probe's, in the main checkout's `docs/tmp/spx-candle-repair/tuning/parity-ndx-all.txt`:
  - SPX 2026-03-26: 390 or more minutes;
  - NDX 2026-10-20 (new layout): about 311 minutes, with the parity median within 2 pt of the stored 10-20 NDX closes (the probe measured +1.27);
  - NDX 2026-04-06 (old layout): about 200 minutes.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Export a minute index price from the tape or same-day NDXP parity`.

### Task 13: The fit, its gates and the level check (spec 9, phase 2d)

**Files:**
- Create: `scripts/_lib/index-candle-fit.mjs`
- Test: `scripts/_lib/index-candle-fit.test.mjs`
- Modify: `scripts/_lib/candles-backfill.mjs` and `scripts/_lib/candles-backfill.test.mjs`

**Interfaces (produces):**

```js
export const FIT; // { spxMinShare: 0.99, ndxMinMinutes: 150, ndxMaxScatter: 6, maxDeviation: 0.0015, levelBound: { SPX: 2, NDX: 6 } }
export async function readSpots(dir, symbol, date); // { ok: true, source, minutes: Map<number, number> } | { ok: false, reason }
export function fitRatio({ symbol, date, bars, spots, closeRatio }); // bars as fetchUwCandles returns them; { ok: true, ratio, matched, scatter } | { ok: false, reason }
export function levelCheck({ symbol, rows, high, low }); // rows: mapped index rows; { ok, dh, dl, reason? }
// candles-backfill.mjs
export async function fetchSchwabDailyCandles(accessToken, symbol, from, to); // Map<date, { close, high, low }>: today's fetchSchwabDailyCloses body, keeping the three fields
export async function fetchSchwabDailyCloses(accessToken, symbol, from, to); // unchanged contract, Map<date, close>: now a wrapper over fetchSchwabDailyCandles
export function regularBars(bars, date); // the market_time 'r' part of selectBars(bars, date): the bars toIndexRows maps as regular-session minutes; fitRatio uses it
export function extremesFor(closes, symbol, date); // { high, low } of $SPX / $NDX that day; throws DayFailure like ratioFor
```

**Rules:**
- **`fitRatio`.**
  - Inputs are `regularBars(bars, date)`. A bar is matched to the price file by its start, as a UTC epoch minute; that is the minute whose prints the tape tool groups.
  - `ratio` is the median of `price ÷ ETF close`.
  - SPX needs source `tape` and at least `ceil(0.99 × cashSessionMinutes(date))` matched minutes. NDX needs source `parity`, at least 150 matched minutes, and `scatter ≤ 6`. `scatter` is the median of `|e − median(e)|`, where `e = price − ETF close × ratio`.
  - Both need `|ratio ÷ closeRatio − 1| ≤ 0.0015`.
  - Each failure's reason names the measure, its value and the bound.
- **`levelCheck`.** `dh` is the max high of the regular rows minus `high`, and `dl` the min low minus `low`. The check fails when both share a sign and `min(|dh|, |dl|)` is over `FIT.levelBound[symbol]`.
- **`candles-backfill.mjs`.**
  - `fetchSchwabDailyCandles` is today's `fetchSchwabDailyCloses` body, keeping each candle's close, high and low, with the same validation and errors. `fetchSchwabDailyCloses` maps its answer to closes.
  - `loadSchwabCloses` calls `fetchSchwabDailyCandles` once per symbol and stores `{ closes, extremes }` for it: `closes` is the Map it holds today, and `extremes` is a Map of date → `{ high, low }`.
  - `ratioFor`, `ratioLines` and every existing test behave exactly as before.
  - `regularBars` makes the same `selectBars` call `toIndexRows` makes, with the same well-formed filter, and keeps the `market_time === 'r'` bars, so the two can't drift.
- **`readSpots`.** It reads `<dir>/<SYMBOL>-<date>-spots.json`. A missing file, bad JSON, a symbol or date mismatch, or no minutes each gives `ok: false`.

- [ ] **Step 1: Failing tests.**
  - `fitRatio`:
    - a built day whose prices are exactly ETF × 10.04 gives ratio 10.04 and scatter 0;
    - on a 390-minute day SPX fails at 386 matched minutes and passes at 387;
    - a half day (210 minutes) needs 208;
    - NDX fails at 149 minutes and passes at 150;
    - NDX scatter 6.01 fails;
    - a deviation of 0.00151 fails;
    - a source mismatch fails;
    - pre- and post-market bars do not count toward the fit.
  - `levelCheck`:
    - SPX with `dh` 2.01 and `dl` 2.5 fails;
    - opposite signs pass at any size;
    - NDX passes at exactly 6 and fails at 6.01.
  - `extremesFor` returns the daily candle's high and low, and throws `DayFailure` for a date with none.
  - `fetchSchwabDailyCandles` keeps close, high and low from one response, and `loadSchwabCloses` makes one call per symbol (count the fetches).
  - `regularBars` returns what `toIndexRows` maps as regular: a pre-market and a post-market bar are left out.
  - The existing `fetchSchwabDailyCloses` and `loadSchwabCloses` tests pass unchanged.
  - `readSpots`: one case per failure.
- [ ] **Step 2:** `npx vitest run scripts/_lib/index-candle-fit.test.mjs scripts/_lib/candles-backfill.test.mjs` → FAIL.
- [ ] **Steps 3–4:** Implement, then the same command → PASS.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Fit a day's index ratio to a minute price and check it against Schwab's daily range`.

### Task 14: The refit mode (spec 9, phase 2e)

**Files:**
- Modify: `scripts/_lib/index-candle-repair.mjs`
- Modify: `scripts/repair-index-candle-placeholders.mjs`
- Test: `scripts/_lib/index-candle-repair-pglite.test.mjs`

**Interfaces:**
- Consumes `readSpots`, `fitRatio`, `levelCheck` and `FIT` (Task 13), plus `extremesFor`.
- Produces:

```js
export async function findRefitManifest(sql, { symbol, date, backupDir }); // { ok: true, manifestPath, manifest, ids } | { ok: false, reason }
export async function prepareRefitDay(sql, { symbol, date, closes, uwKey, waitForSlot, spotsDir }); // { ok: true, rows, ratio, closeRatio, source, matched, scatter, dh, dl, etfCloses } | { ok: false, reason }; etfCloses: Map<epoch minute, UW ETF close> of the regular bars
export async function refitDay(sql, { symbol, date, list, prepared, found, backupDir, apply }); // { date, symbol, ratio, closeRatio, priorRatio, replaced, inserted, uncovered, skipped?: reason, manifest? }
export async function checkRefitDay(sql, { symbol, date, closes, backupDir }); // read-only; { ok, dh, dl, regular, scaledShare, reason? }
export async function processRefitDay(sql, { symbol, date, list, closes, uwKey, waitForSlot, spotsDir, backupDir, apply }); // find, then prepare, then refit; { alreadyRefit: true, manifestPath } | refitDay's result; throws DayFailure on any skip
export async function processCheckDay(sql, { symbol, date, closes, backupDir }); // checkRefitDay's result; throws DayFailure when it is not ok
```

**Rules:**
- **`findRefitManifest`.**
  - It reads every `<SYMBOL>-<date>-*.manifest.json` in the backup dir.
  - A candidate is `committed: true`, has no `kind` or `kind: 'refit'`, has matching `symbol` and `date` fields, and has a non-empty `insertedIds`.
  - A candidate qualifies when all its `insertedIds` still exist with that symbol and date, checked in one query.
  - Exactly one must qualify. A lottery manifest is never a candidate.
  - **A `summer` date with no qualifying manifest** selects the 11-06 backfill's rows instead: that symbol and date, `created_at >= '2026-11-06T22:19:00Z' AND created_at < '2026-11-06T22:20:00Z'`, and the symbol's Schwab price column (`spx_schwab_price` or `ndx_schwab_price`) NULL.
    - It returns `{ ok: true, manifestPath: null, manifest: null, ids }`, and an empty selection skips.
    - The refit's manifest then records `refitOf: null` and `selectedBy: 'summer-backfill'`.
    - A later run finds that refit manifest and follows the manifest rule.
- **The `summer` list.** `REPAIR_LISTS.summer` is the trading days 2026-07-22 → 09-04 (33), and `LIST_SYMBOLS.summer` is both symbols. The plain repair refuses `--list summer` and any summer `--date`: the list is refit-only.
- **`prepareRefitDay`.** It follows `prepareDay`'s steps and skips, then adds the fit:
  1. `closeRatio` from `ratioFor`;
  2. `readSpots`, then `fitRatio`;
  3. `toIndexRows(..., fitted ratio)`;
  4. `checkMappedDay` with `fitted: true`, which keeps the count check and skips both close checks (spec decision 9);
  5. `extremesFor` and `levelCheck`.

  Any failure gives `ok: false` with its reason, and nothing is written.
  - **A fitted day reads no close reference at all.** It never calls `readSettlement` and never reads the `$NDX` close for a check, so a date with no `outcomes` row is refit like the rest. 07-22 is the one such date among the 79 SPX days (checked 2026-11-26). Today `checkMappedDay` fails "no outcomes.settlement" before it compares (`index-candle-repair.mjs:184-187`) and `prepareDay` reads the settlement (:265), so `fitted: true` must skip the lookup, not only the comparison.
- **`refitDay`, in both modes, before anything is written.**
  - Select the manifest's rows by id, symbol and date.
  - **Coverage.** Every timestamp among those rows must have a new mapped row, pre- and post-market included. Otherwise it returns `skipped: "would leave N minutes empty"` with `uncovered: N`, and writes nothing. A refit deletes valid rows, unlike a placeholder repair, so a thinner UW answer must not shrink the day.
  - **`priorRatio`** is the ratio the selected rows carry, measured (spec decision 9). It is the median, over the selected rows' regular minutes that have a bar in `prepared.etfCloses`, of the row's close ÷ that ETF close. A date with no such minute skips.
- **`refitDay` with `apply`:**
  1. Back the selected rows up with `writeBackup`, every column.
  2. Write the manifest with `committed: false`. It carries every field `repairDay`'s manifest has (`version`, `symbol`, `date`, `list`, `backup`, `backedUpIds`, `marker`), plus `kind: 'refit'`, `refitOf`, `ratio` (the fitted one), `closeRatio`, `priorRatio` and `source`, so `parseManifest` and `describeUndo` read it as they read the others.
  3. Open one transaction of tagged templates: `DELETE ... WHERE id = ANY(ids) AND symbol AND date`, then the INSERT batches `ON CONFLICT DO NOTHING RETURNING id`.
  4. Rewrite the manifest with `committed: true` and `insertedIds`.

  Without `apply`, it gives the counts only.
- `undoRepair` works unchanged on a refit manifest.
- **`checkRefitDay`** (read-only; `--check`). It finds the date's current manifest by `findRefitManifest`'s rule, and needs one with `kind: 'refit'`.
  - It runs `levelCheck` on the stored regular rows, against `extremesFor`.
  - **Scaled share.** For each stored row it pairs the row with the backed-up row of the same timestamp, from the refit manifest's backup. On at least 99% of the pairs, `stored close ÷ backed-up close` must equal the manifest's `ratio ÷ priorRatio` within 1e-6 relative. Both rows are the same UW bar times a ratio, so this tells a fitted write from a close-ratio one on every date, NDX and gap days included.
  - A failed level check or share gives `ok: false` with the reason.
- **`processRefitDay`** is the per-date worker, as `processRepairDay` is for the repair, so the CLI decides nothing (Task 1's rule).
  - It runs `findRefitManifest`. When the found manifest has `kind: 'refit'`, it returns `{ alreadyRefit: true, manifestPath }` with no UW call and no write; to refit that date again, undo its refit first (spec decision 9).
  - Otherwise it runs `prepareRefitDay`, then `refitDay`.
  - A failed find, a failed prepare or a `skipped` result throws `DayFailure` with the reason.
  - `processCheckDay` throws `DayFailure` when `checkRefitDay` is not ok.
- **The CLI.**
  - `--refit` requires `--spots <dir>`. `--spots` without `--refit` is refused, and so is `--refit` with `--undo`. The guards are the same.
  - `--check` takes `--symbol` and `--list` or `--date`, and keeps the repair's guards. It writes nothing to Neon, but `loadSchwabCloses` can refresh an expired Schwab token and write it to the production store (`scripts/_lib/schwab-local.mjs:10-15, 146-190`). The 13:00–22:59 UTC guard keeps that refresh out of the crons' window.
  - The backup dir is resolved for `--refit` and `--check` in a dry run too. Today it is set only with `--apply` (`repair-index-candle-placeholders.mjs:230`), and without it every date would skip as having no manifest.
  - Per date, `--refit` prints:
    - the close, prior and fitted ratios to 6 decimals;
    - the matched minutes, the scatter, and `dh`/`dl`;
    - the rows replaced and the inserted (or would-insert) count;
    - `uncovered`, or the skip reason;
    - or `already refit` and the manifest's name.
  - Per date, `--check` prints `dh`, `dl` and the scaled share.
  - Either exits 1 when any date skipped or failed. An already-refit date is not a failure.

- [ ] **Step 1: Failing tests** (pglite, the Task 1 migrations; repaired rows made by a real `repairDay` in the test):
  - `refit replaces exactly the manifest's rows`:
    - the old ids are gone and the new rows carry the fitted ratio;
    - a live row on the same date that no manifest lists is kept, and its minute is not inserted twice.
  - `a second refit finds only the refit manifest`, and `processRefitDay` then reports `alreadyRefit` with no UW call and the rows unchanged.
  - `undo, then refit again`: after the undo the prior manifest qualifies again, and the new refit's `--check` passes.
  - `processRefitDay` throws `DayFailure` on a failed find, a failed prepare and a `skipped` refit; `processCheckDay` throws it on a failed check.
  - `skips with no manifest, two qualifying manifests, a manifest id that is gone, or one that now has another symbol or date`; a lottery manifest is ignored.
  - `a refit that would leave a minute empty writes nothing`: the UW answer lacks one pre-market minute the repaired rows cover, so `skipped` names 1 minute and the rows are unchanged.
  - `the summer refit selects only the backfill's rows`:
    - a 07-22 live row written that day is kept;
    - a row written at 2026-11-06T22:20:00Z is not selected, and neither is one with a Schwab price;
    - after the refit, `findRefitManifest` returns the refit manifest;
    - the backfill rows are written at a ratio other than today's close ratio (10.03 against a close ratio of 10.04), and `priorRatio` is 10.03, so `--check` passes.
  - `the plain repair refuses the summer list`.
  - `an unwritable refit backup changes nothing` (R4).
  - `undo of a refit restores the prior rows exactly` (`id`, `created_at`).
  - `a DB reject mid-refit rolls back` (R4).
  - `prepareRefitDay` (`vi.mock` of `./candles-backfill.mjs`):
    - it skips on a fit-gate failure, a level-check failure, a missing price file, a price file for another symbol, and a UW error;
    - a fitted NDX day with a close 20 pt off Schwab's is not refused;
    - a fitted SPX day with a close 4.01 pt off settlement is not refused;
    - a fitted SPX day with no `outcomes` row is refit, and no `outcomes` query runs;
    - a fitted day with 389 regular bars on a 390-minute day is still refused (the count check it keeps).
  - `checkRefitDay`:
    - it passes a refit day;
    - it fails a day whose stored rows were written at the close ratio (scaled share 0), and a day whose stored high and low miss the same way;
    - it fails a date with no refit manifest.
  - `a refit dry run writes nothing`. The CLI's dry-run resolution of the backup dir has no unit test, like the rest of the CLI wiring (Task 1's ruling). Runbook A2's first dry run checks it: every date reporting "no manifest" means it is broken.
- [ ] **Step 2:** `npx vitest run scripts/_lib/index-candle-repair-pglite.test.mjs` → FAIL.
- [ ] **Steps 3–4:** Implement, then the same command → PASS.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Refit repaired index candles to a fitted per-day ratio`.

### Task 15: The summer's lottery spots (spec 8 and 9, phase 2f)

**Files:**
- Modify: `scripts/_lib/lottery-spot-repair.mjs`
- Test: `scripts/_lib/lottery-spot-repair-pglite.test.mjs`

**Interfaces:**
- Consumes `REPAIR_LISTS.summer` (Task 14).
- Produces:

```js
export const LOTTERY_SPOT_SCOPE; // { dates: string[], partials: [{ date, after }] }: the gap days without 09-21 plus the summer days without 07-22; partials 09-21 after '2026-09-21T16:18:00Z' and 07-22 after '2026-07-22T14:51:00Z'
```

**Rules:**
- `partial` becomes `partials`. Each one keeps fires on its date with `fire_time > after`, today's rule for 09-21.
- 07-22's cut, 14:51Z, is its last live bar. Its fires after that read the bar, as 09-21's did.
- The planning query stays one statement of tagged templates; the partials travel as `unnest` arrays.
- Everything else (the backup, the fence, `no_longer_pass`, `stale_bar`, undo) is unchanged.

- [ ] **Step 1: Failing tests:**
  - 07-22 fires at 14:50Z and 14:51:00Z are out of scope, and one at 14:59Z is in;
  - a fire on 08-20 is in;
  - fires on 07-21 and 09-08 are out;
  - 09-21's cut is unchanged;
  - `in_scope` counts both kinds.
- [ ] **Steps 2–4:** RED, implement, GREEN: `npx vitest run scripts/_lib/lottery-spot-repair-pglite.test.mjs`.
- [ ] **Step 5: Gate and commit.** `feat(scripts): Correct the summer's stale lottery spots too`.

## Execution order and the production runbook (controller; owner OK given for each step after its checks)

**Order:**
1. Tasks 1 and 2.
2. Runbook A, outside 08:15–15:30 CT and 13:00–22:59 UTC (done 2026-11-25/26).
3. Task 3. Runbook B now waits for Runbook A2 (owner decision 5).
4. Tasks 4–6.
5. Tasks 12–15, then Runbook A2, then Runbook B.
6. Tasks 7–11.
7. Push (needs the owner's OK; api/ + scripts/).
8. Runbook C, after 15:00 CT.

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

**Runbook A2: the refit** (spec decision 9, owner decisions 5 and 6). It runs after Tasks 12–14, outside 08:15–15:30 CT and 13:00–22:59 UTC.
1. **Price files** go into the main checkout's `docs/tmp/spx-candle-repair/spots/`.
   - `verify_index_candle_repair.py --symbol SPX --date D --export-spots <dir>` for the 46 SPX dates (`spx-repair` and `gap`) and the 33 `summer` dates.
   - `--symbol NDX` for the 61 NDX dates (`ndx-repair`, `ndx-fill` and `gap`) and the 33 `summer` dates.
   - A re-run keeps the files already written (exit 0, `kept`). A date that exits 2 is listed, and its refit skips for want of a file.
2. **Dry runs:** `--refit --spots <dir>` with `--symbol SPX --list spx-repair`, then `--list gap`, then `--list summer`. Then NDX with `--list ndx-repair`, `--list ndx-fill`, `--list gap` and `--list summer`.
   - If every date reports "no manifest", the dry run didn't resolve the backup dir. Stop.
   - Compare the results with the 2026-11-26 tuning, in the main checkout's `docs/tmp/spx-candle-repair/tuning/`:
     - every SPX fitted ratio on the 46 dates is within 1e-5 of `fit-all-46.txt`;
     - on the 33 summer dates, `summer-tuning.txt` records only `k`, the fit relative to the stored rows. The expected fitted ratio is the printed prior ratio × that date's `k`, within 1e-5, because a median scales with its inputs;
     - the exceptions are 04-10, 09-21 and 07-22, whose tuning fit mixed in the day's live rows. Their check is `--check` (step 4);
     - every SPX and NDX date passes, in all lists, except NDX 07-29. It is the expected skip (scatter 6.66), so NDX `--list summer` exits 1 by design;
     - `uncovered` is 0 everywhere.
   - A re-run after a partial apply prints `already refit` for the dates already done. That is expected, not a skip.

     Any skip, or any level-check failure, goes to the owner before an apply.
3. **Apply** each list after its dry run.
4. **Checks**, after each apply:
   - `--check` on the same symbol and list passes on every date: the stored level check, plus the scaled share against the backup. The one expected failure is NDX 07-29: it was not refit, so it has no refit manifest, and NDX `--check --list summer` exits 1 by design;
   - `verify_index_candle_repair.py --symbol SPX --date D --fitted` passes on all 79 SPX days, the 46 and the 33 summer days. 04-10 runs with `--before 17:11Z`, here and below;
   - `--ratio <fitted ratio>` passes the ratio share on the SPX days up to 04-27;
   - the residual SQL still returns 0 rows.
5. Then Runbook B.

**Runbook B** (after Runbook A2 and Task 15, and after 15:00 CT): `--lottery-spots` dry run, then apply. Report `in_scope`, `no_longer_pass`, `no_bar` and `stale_bar`. Expect about 1,998 gap-day fires plus 99 summer fires, and `no_bar` and `stale_bar` both 0.

**Runbook C: the rebuilds,** after the push and after 15:00 CT. Each step comes after a Task 11 backup.
1. **Features.**
   - Read-only pre-check: every one of the 29 dates (03-23 → 04-10, 09-21, the 13 gap days, and 07-22) has `cashSessionMinutes` SPX `r` bars, the same number of SPY ETF bars, SPY prints, and an open (`outcomes.day_open`, when no trusted snapshot row has one). A date that fails goes to the owner before the rebuild. 07-22 has no `outcomes` row; its open comes from its trusted snapshot rows (`spx_open` 7,497.47 on all 25 rows between 09:00 and 11:00 CT, checked 2026-11-26).
   - Back up `training_features` and `day_labels` for the 29 dates.
   - Call `build-features?date=` for each one. Every response must show `status: 'success'` and the date in neither `dpKept` nor `dpReadFailed`. Either list is a stop, and so is a `partial` status: the date's stale `dp_*` values were kept (no prints, short bars or no `spx_open` in `dpKept`; a failed read or completeness check in `dpReadFailed`), so report it.
   - Resolve Sentry `SENTRY-EMERALD-DESERT-MB`.
2. **Gamma fires:**
   1. Run `--dry-run --from 2026-02-26 --to 2026-04-17`.
   2. Show the owner the per-date counts next to the stored ones. A date that loses every fire, or gains more than double, gets checked first (spec decision 8).
   3. Back up `ws_gamma_setup_fires` for the window, run `rebuild-backup.mjs --delete-gamma-fires`, then run the script without `--dry-run`.
   4. For 09-21: back up, `--null-gamma-returns --date 2026-09-21` (expect 12 updated), then `--outcomes-only --from 2026-09-21 --to 2026-09-21`. Expect 12 pending and 12 filled; any other count is a stop.
   5. For 07-22, the same with its one fire: expect 1 updated, 1 pending and 1 filled.
   6. **The day context after each hole** (owner decision 8). Back up `ws_gamma_setup_fires` for 09-08..09-15, 10-01..10-07 and 10-16..10-23. For each window run `--context-only --dry-run --from A --to B`, then `--context-only --from A --to B`.
      - Expect 78, 71 and 113 fires updated (262 in all).
      - `prior_5d_ret` changes on all 17 dates; 09-14 goes from +1.95% to about −1.15%. `open_gap_pct` changes only on 09-08, 10-01 and 10-16; 09-08 goes from +2.81% to about −0.14%.
      - `confidence_tier` and `pre_day_filter_fires` stay as they are, with two allowed exceptions: a date whose new 5-day return is within 0.1 point of −1% (10-23 is at −1.03%), and a date whose `prior_iv_rank` changed. Any other change goes to the owner before the write.
3. **Regime.**
   - Back up `flow_regime_0dte_daily` for 09-21. Run `backfill-regime-0dte.ts --from 2026-09-21 --to 2026-09-21`, compare its printed row with the stored one, then `--apply`.
   - 07-22 has no stored row (spec decision 8). Run `--from 2026-07-22 --to 2026-07-22`. The printed row must have a gate, and its triggers must agree with the day's bars, before `--apply`.
4. **Day embeddings.** Back up `day_embeddings` for 09-21, the gap days and the 33 summer days (07-22 → 09-04; only 07-22 has a row). Call `embed-yesterday?date=` then `fetch-day-ohlc?date=` for each. Expect 32 new summer rows and 07-22's row rebuilt from 390 bars.
5. Record the results in the spec, and update memory `project_spx_candle_placeholder_gaps.md`.
