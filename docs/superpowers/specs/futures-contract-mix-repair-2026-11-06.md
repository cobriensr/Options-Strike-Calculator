# Futures bars: repair the April–June contract-month mix, and make the live roll safe

## Goal

Replace the `futures_bars` rows that merged several contract months (2026-04-05 evening to 2026-06-15 09:10 CT) with true front-month bars wherever a source exists. Recompute what was saved from them. Then fix the live writer so the December roll (ESZ6 → ESH7, around 12-10) can't flip the series between months.

Owner go-ahead: 2026-11-06 ("yep go ahead" to the ES contract-month bug; backfill per the standing always-backfill rule).

Investigation reports (gitignored, read-only work): `docs/tmp/es-contract-month-2026-11-06/`
- `a-ingestion.md`: root cause in code and git.
- `b-forensics.md`: measured damage per symbol, with per-day CSVs and flagged-bar lists in `b/`.
- `c-sources-consumers.md`: rebuild sources, a ground-truth test of the tick rule, and every reader of the table.

## What went wrong

- **Cause.** The Databento sidecar (`93899f65`, 2026-04-05) subscribed `ohlcv-1m` with `stype_in="parent"`, which delivers every contract month. `_resolve_symbol` mapped each month to the root and dropped only spreads. The upsert then merged them: `open` = first write, `high` = GREATEST, `low` = LEAST, `close` = last write, `volume` = GREATEST. The code stayed until the Databento removal (`53bc3ea9`, 09-29). The damage stops at 06-15 14:10Z because the live Databento session stopped then; after that the daily `ES.c.0` gap cron, which can't mix months, wrote the rows.
- **Damage (b-forensics.md §4).** All six roots, the same episode. ES has 45 bad trading days and 20,442 flagged bars.
  - In the regular session, ES `open` and `high` are 55–62 pts high on about 45% of minutes. `low` and `close` are right (0.02% off SPX).
  - Overnight, `close` is on the wrong contract in about 7% of bars.
  - Volume is not inflated. Order-flow columns are NULL for the whole window.
- **Clean days inside the window.** 04-13 to 04-17, 06-01 and 06-08 hold no flagged bars for any root.
- **Junk rows.** 234 off-session rows on Saturday 2026-04-11 across all six roots, and spread-priced NQ rows on the evening of 04-05.

## Rebuild sources (c-sources-consumers.md §1)

| Span (UTC) | Roots | Source | Contract known? | Checked against |
|---|---|---|---|---|
| 04-05 22:00 → 04-17 20:59 | ES, NQ | Frozen Databento archive `ohlcv_1m` (local `ml/data/archive/`, the same files the sidecar holds) | Yes: raw symbol per row (ESM6, NQM6) | Rebuilds 04-06..04-10 exactly; 04-12..04-17 already equal it |
| 04-20 01:56 → 06-15 14:11 | ES, NQ | Postgres `futures_trade_ticks` (Databento TBBO trades, root only) | No: contracts split by price cluster | ES rule matched archive ESM6 exactly on 04-08 and 04-09 (one 0.25 miss in 2,760 minutes) |
| whole window | RTY, CL, GC, ZN | **None.** The archive and the ticks hold ES and NQ only; UW REST starts in July (2 probes returned empty). | — | — |

Every flagged ES minute from 04-20 on has tick coverage. Minutes with no ticks are unflagged and stay as they are.

## Phases

### Phase 1: ES and NQ rebuild extract (read-only; one implementer task, ≤5 files)

A Python extract in `ml/` that writes the rebuilt bars to a file. It never writes to a database.

- **Archive span (04-05 22:00Z → 04-17 20:59Z):** the front month's OHLCV from `ohlcv_1m`, by raw symbol: ESM6 and NQM6, the volume leader on every day of the span.
- **Tick span (04-20 01:56Z → 06-15 14:11Z):** for each root-minute, split the prints into price clusters, keep the front month's cluster and build OHLCV from it.
  - **Front month is ESM6 / NQM6 for the whole span, including 06-15.** Ruling: the rows after 06-15 09:11 CT come from `ES.c.0`, which holds ESM6 until it expires on 06-19. Picking ESU6 for that morning would put two carry-sized steps into one day.
  - With positive carry, the front month is the lowest-priced cluster. The rule must be stateless or self-correcting (one wrong minute must not latch), and the gap threshold must be set per root. ES splits at 25 pts. NQ's carry is about 277 pts and its clean 1-minute range p99.99 is 116, so its threshold is derived and then checked against ground truth.
  - A minute with no front-month print gets no rebuilt bar; Phase 2 deletes that row. The live UW handler likewise skips a minute its leader didn't print. Report the count, expected near 0.
- **Ground truth gate:** run the tick rule on archive `tbbo` trades for every day 04-06..04-17, with the contract dropped and all months merged. Compare the result with archive front-month OHLCV.
  - ≥ 99.9% of minutes must match exactly on O/H/L/C, for ES and for NQ.
  - Volume must be within 1%.
  - Below that, stop and report.
- **Output:** one Parquet file with (symbol, ts, open, high, low, close, volume, source ∈ {archive, ticks}), plus a per-day summary CSV.
- Tests (pytest, no DB): cluster split, front pick, a back-month-only minute, a single-contract minute passing through unchanged, and the per-root threshold.

### Phase 2: the apply tool (one implementer task, ≤5 files)

A TypeScript script in `scripts/` that turns the Phase 1 file into writes. It reuses the anchor-backfill apply pattern: guards, dry run, compare.

- **Default mode is a dry run.** It prints per root and day how many rows would change, which fields, and the largest diffs, and deletes nothing.
- **`--apply`:**
  - Writes a JSONL backup of every row it will change or delete first.
  - `UPDATE … FROM unnest(…)` in 500-row batches, only where a value differs. That makes it idempotent: a second run changes 0 rows.
  - Deletes rows that are in the window but not in the rebuild: front-month-absent minutes, the Saturday 04-11 junk (all six roots) and the NQ spread rows on 04-05.
- Refuses to run during market hours. Prints before/after counts.
- Never touches minutes outside the two spans, and never touches order-flow columns.
- Tests: vitest on PGlite. Cover update only on a diff; idempotence; delete with backup; the market-hours refusal; nothing written in the dry run; a DB failure exits non-zero.

### Phase 3: run it (main session)

1. Dry run, then give the owner the per-root summary. **Writing to production waits for the owner's OK.**
2. Apply ES and NQ.
3. Verify:
   - re-run the b-forensics detector: 0 flagged ES/NQ bars in the window;
   - spot-check 3 days against the archive;
   - day bar counts unchanged except for the deletions.

**Done 2026-11-07 (owner OK).** The apply ran 05:53–05:55Z, exit 0.
- **Changed:** 39,061 ES/NQ rows updated (ES 20,179, NQ 18,882) and 236 rows deleted (ES 40, NQ 35, RTY 33, CL 59, GC 57, ZN 12). Both totals equal the approved dry run, per root and field.
- **Backup:** `docs/tmp/futures-contract-repair/backup-2026-11-07T05-53-50-958Z.jsonl` (main checkout). It holds 39,297 full rows with `id`, written before any write.
- **The independent check passed** (`docs/tmp/futures-contract-repair/verify-apply.md`):
  - **Detector:** ES and NQ contaminated days went from 45 to 0 each, with no runs left.
    - 28 single bars are still flagged (ES 12, NQ 16). Each equals the archive or the rebuild exactly. They are news and roll-week minutes, near the detector's own clean-day baseline of about 6 per root.
    - RTY/CL/GC/ZN flags match the pre-repair run, id for id, less the deleted junk.
  - **Archive span**, all 26 root-days: 0 mismatches against the Databento archive at NUMERIC(12,4), and 0 rows on only one side.
  - **Tick span:** ES 06-12 is identical to the rebuild. No price field anywhere is more than CARRY_HALF from the rebuild, and roll-week volumes all match.
  - **Untouched rows** differ in 0 columns. The order-flow columns and `ts` are unchanged.
  - **A second dry run** plans 0 updates and 0 deletes.
- **Left as is by design:** ES 7,281 and NQ 7,320 rows in tick-less windows. They have no rebuild source, and no flag falls in them.

### Phase 4: recompute what was saved from the bad bars (one implementer task + run)

| Store | Rows | Action |
|---|---|---|
| `futures_snapshots` (ES, NQ, RTY, CL, GC, ZN) | about 19.4K per root, 04-06 → 07-05 (the span plus the 20-day volume window) | Recompute each (symbol, ts) with `computeSnapshot`; UPDATE only the fields a repaired bar feeds (below) |
| `market_snapshots.pre_market_data` | 38 auto-filled rows (35 with an inflated Globex range) | Recompute Globex H/L/C/VWAP. Keep the `autoFilled` guard, so hand-saved rows are never touched |
| `ws_gamma_setup_fires.es_basis_change_5m` | 248 rows | Recompute the column. List the fires whose PCS Monday gate result flips; don't delete or add fires (the detector is paused) |
| `periscope_grades.trade_sims` | 77 rows (05-07, 05-08) | Re-run `scripts/grade-periscope-day.mjs` for both dates |
| `analyses.full_response` | 52 rows | Not recomputable (LLM output). Recorded here only |
| `lessons` / similar analyses | 35 lessons trace to window reviews; 6 rest on the bad futures context | **DONE 2026-11-06 18:30Z (owner OK)**, details below |

**Lessons cleanup, done 2026-11-06 18:30Z (owner OK; investigation in `docs/tmp/es-contract-month-2026-11-06/d-lessons.md`):**
- Archived (`status='archived'`, reversible): L229, L235, L236, L239, L243, L249.
- Restored L211, the clean 04-02 predecessor of L229: `active`, `superseded_by`/`superseded_at` cleared.
- Cleared `analysis_embedding` on every window entry analysis that saw bad futures inputs, so similar-analysis retrieval no longer returns them:
  - 217, 224, 232, 244 (18:30Z);
  - 210, 237, 254, 258, 260, 261 (18:45Z, owner OK, second batch).
  - The window's only retrievable entry rows left are 248, 249, 250 and 252 (04-14..04-17, clean inputs).
- Backups, with the vectors included:
  - `docs/tmp/es-contract-month-2026-11-06/e/backup-lessons-analyses-20261106T183009Z.jsonl` (11 rows);
  - `e/backup-analyses-batch2-20261106T184524Z.jsonl` (6 rows).
  - Scripts: `e/retire_lessons.py`, `e/unembed_more.py`.
- **Caveat:** `scripts/backfill-analysis-embeddings.mjs` without `--force` re-embeds any row whose embedding is NULL. Running it would put these 10 back. No cron does this.
- Side finding, not fixed (the owner reworks the lessons code): `getActiveLessons()` orders by `source_date` with no tie-break, so which tied lessons fill the last of the 20 slots can change between runs. No new lessons have been curated since 2026-04-20.

Same pattern as Phase 2: dry run, backup, owner OK, apply, verify.

**Phase 4 as built (rulings 1 to 5, 2026-11-07).** The tool is `scripts/recompute-futures-derived.ts` with `scripts/_lib/futures-derived-recompute.ts` (planning, report, writes) and `scripts/_lib/futures-derived-attribution.ts` (pure rules). The default is a read-only dry run. `--apply` runs after the close, with the totals of the dry run the owner saw (`--expect-snapshots`, `--expect-premarket`, `--expect-fires`), and refuses unless every check below holds.

- **Scope.** `futures_snapshots` covers all six roots. Phase 2 repaired ES and NQ. For RTY, CL, GC and ZN it only deleted the Saturday 04-11 junk bars, so for those four roots only a deleted bar makes a saved field affected. Their contract mix is Phase 5 (D1) and stays as it is.
- **Closed-bar rule.** `computeSnapshot` reads only bars closed by `at` (`ts <= at - 60 s`), the set the live cron could see. Without it the recompute cannot reproduce the rows the cron wrote.
- **Attribution: only repaired inputs are written.** A saved field is written only where one of its input bars was changed or deleted by Phase 2 (read from the Phase 2 backup), and only where the recompute differs. Input bars are found two ways, and a field is affected if either finds a repaired bar:
  - by today's rule, against the current table (the latest closed bar for the price; the hour-ago bar for the 1h change; the day-open bar for the day change; any bar in the 20-day window for the volume ratio; any bar in the overnight window for a pre-market row);
  - by value, in the series as it was before Phase 2 (ruling 3): the newest bar with the stored close within 96 hours, and the bars that reconstruct the stored 1h and day changes. This catches a row priced from an old bar that is older than today's latest one, such as the 04-12 Sunday rows priced from a Saturday junk bar;
  - by merge state, for ES and NQ rows with no value match (ruling 6): the stored price lies in the pre-repair [low, high] of a bar Phase 2 changed within 14 minutes of the latest closed bar, and not in its current range. The Databento-era upsert merged contract months into a bar (high = GREATEST, low = LEAST, close = last write), the cron read it part-merged, and the stored price is a value that existed only before the repair (63 rows on the 2026-11-07 dry run, all with the latest bar repaired in its open or high but not its close). Price, 1h and day are affected. A row that matches an unrepaired bar by value is not touched by this rule.
- **Method control (what makes `--apply` trustworthy).** Every `futures_snapshots` row from 2026-11-02 on (at least 200 rows over 3 days per root) must recompute to what is stored. ES and NQ must match exactly. For RTY, CL, GC and ZN a miss also counts when a late bar explains it, because uw-stream emits a minute's bar only after a print of a later minute arrives, so a quiet root's previous bar can be missing when the cron reads (rulings 4 and 5): `late-bar` (the stored price is the close of a closed bar 1 to 14 minutes older) or `late-volume` (price, 1h and day match, and the stored volume ratio is below the recomputed one, or above it by at most 0.0001, one unit of the column, because a hole filled later on a prior day lowers the 20-day ratio). Any other miss, and a stale or missing row, fails. The rows from 2026-10-02 to 11-01 are classified in the report as information, not gated.
- **Pre-market and fires.** A pre-market row is written only where a repaired bar is in its overnight window. The check on the rows outside the span is a subset check (today's bars may only widen a stored range: stored high <= recomputed, stored low >=). The fire basis control must match 100%.
- **Opt-in delete of the stale junk-priced rows (ruling 4).** A snapshot row whose stored price matches a bar Phase 2 deleted and whose recompute is stale or missing (1,964 on the 2026-11-07 dry run; ES, NQ, ZN, RTY and CL 266 each, GC 634) cannot be recomputed, and `price` is NOT NULL. The dry run always lists them. `--delete-junk-stale` with `--expect-junk-deletes J` deletes them, off by default: the full rows go to the backup first, the DELETE is batched and guarded by the planned price, and a verify checks the rows are gone and nothing else left the scope. **The owner approved the delete on 2026-11-08.**
- **Opt-in rewrite of the stale-at-write rows (rulings 6 and 7).** The writer had no freshness gate until 2026-09-30 (`ecf9c021`, with no backfill): it priced from the last bar it had while minutes were missing, and the minutes have landed since. A snapshot row before 2026-10-01 whose price matches by value a bar older than 15 minutes at the row (the bar today's gate rejects), and whose recompute is fresh and differs, is a stale-at-write row. The step writes every differing field that the normal step does not write on that row, so each field is written once, by one step, and its backup line says `step: stale`. ES and NQ: every such row from the span start. RTY, CL, GC and ZN: only rows from the span end, 2026-06-15T14:11Z (their bars before it are still month-mixed, D1; after it the continuous-front gap cron wrote them), and not on the days the Phase 1 detector confirmed contaminated in their bars after the span end (ruling 7b: the same flagging, thresholds and confirmation as section 3 of `b-forensics.md`, run read-only over 2026-06-15T14:11Z to 2026-10-01 into `docs/tmp/es-contract-month-2026-11-06/b-after-span/`; a contaminated day has at least 10 flagged bars and 1% of the day's bars, in a run of at least 3 days; `--detector-days` takes its `detector_days.json`, and without it those rows are left). That run found no contaminated day in any of the four roots, so nothing is left out; a single flagged bar is the clean-day false-positive rate (RTY 0.014% against 0.011%) and its day is not excluded. The dry run lists the contaminated days with their row counts and the share of the root's after-span stale rows, says to stop when the share is over 10%, and lists the stale rows on the days with a flagged bar as information. A row is also stale when it sits in a frozen run (ruling 8): consecutive rows of the root with one identical stored price, spanning more than the freshness gate (15 minutes) from the first row to the last, with a fresh recompute that differs. It needs no matching bar and no look-back, so it reaches the 2026-09-04 to 09-28 outage rows, whose last good bar is up to 25 days old and whose snapshots hold one price per root; a flat market recomputes equal and is not written. The dry run reports how many rows the clause adds, and how many of them fall in the outage. `--rewrite-stale-at-write` with `--expect-stale-rewrites S` does it, off by default, with the same guarded UPDATE and verify as the snapshot writes. The dry run reports, per root, the planned rows in the span and after it, the 10 largest changes with the matched bar's age and the frozen runs.
- **Dry run of 2026-11-07:** 25,365 snapshot rows, 35 pre-market rows and 0 fire values to write (before ruling 6); every control passes.

### Phase 5: RTY, CL, GC, ZN (needs owner decision D1)

There's no source for these four. See D1.

### Phase 6: a roll-safe live writer before the December roll (owner chose D2 = A, 2026-11-06)

Today's uw-stream `futures_trades` handler never mixes months inside a bar. But it picks each minute's contract by volume since 00:00 UTC, with no memory:
- the series can step back and forth between ESZ6 and ESH7 around the crossover;
- the 00:00Z reset and any restart can flip it back on thin volume.

The gap cron and the history backfills copy the same rule through `replayFrontMonth` (`api/_lib/futures-contracts.ts`). The writers, the migration path and the readers are mapped in `docs/tmp/es-contract-month-2026-11-06/g-roll-writers.md` (main checkout).

**The rule: roll forward only.**
- **A `contract` column on `futures_bars`** (migration #203).
  - It holds the dated outright the bar was built from (ESZ6, CLF7, …).
  - It's nullable. NULL means unknown, as in all history before this phase. Every writer fills it from now on.
  - A `NOT VALID` CHECK allows only the row's own root, one CME month code and a one- or two-digit year. That's exactly the handler's existing sym test, so it can't reject a bar the handler would write.
  - No index. Seed lookups are bounded to 7 days on the existing `(symbol, ts DESC)` index.
- **Expiry order comes from the contract code:**
  - the month letter gives the month;
  - the year digit gives the year, resolved to the one year in [ref − 1, ref + 8] that ends in that digit, where ref is the UTC year of the replay's first minute, or of the print where the handler first sees the contract (at 2026, `H7` → 2027, `Z5` → 2025 and `Z4` → 2034). The window keeps ref − 1 on purpose: a seed tagged late in one year and read early the next (`ESZ6` in January 2027) must still read as 2026. Read as 2036, it would lock the root for good. A contract ten years out that's misread as past is harmless, because an earlier contract never takes over;
  - a two-digit year is read as 20YY.
- **Each root has one current front.**
  - **Challenger:** the later-expiring contract with the largest volume since 00:00 UTC. A tie goes to the nearer expiry.
  - **Lead:** the challenger leads when its volume is strictly greater than the front's.
  - **Takeover:** the challenger takes over once it has led for **N = 120 consecutive wall-clock minute closes**. A lead persists through minutes with no prints. The streak restarts when the challenger changes, when it loses the lead, and at 00:00 UTC. The bar of the minute after the 120th close is the first on the new contract.
  - **Never backward:** an earlier expiry never takes over, so the 00:00Z reset and restarts can't flip back.
  - **An expired front** is covered by the same rule: its volume stops and the next contract's streak starts on its first lead. Up to N minutes of bars after the expiry are then missing, and the gap cron, running the same rule, doesn't fill them. In 128 ES/NQ rolls the front never expired before the takeover: the crossover came 3.6–7.6 days before the old front's last bar.
- **Seed (the front at startup or at a hole).**
  - The `contract` of the root's newest tagged bar in the last 7 days, at or before that point.
  - With none, it's the first contract in the root's listing cycle whose last-trade month isn't before the current UTC month. CL stops trading the month before its contract month, so CL in November seeds CLZ6, not CLX6. The rule above rolls forward from there.
    - Why the cycle and not prices: at a cold start the live handler has no candidate list, and the session's first print can be a back month.
    - The cycle needs no prints, so the TS and Python copies agree exactly.
    - A seed that's too early (even an expired contract) can only make the roll late; a late one could never come back.
  - Restarts lose the in-memory volume tally. The challenger then needs 120 leading closes counted from the restart.
- **Why N = 120** (`docs/tmp/es-contract-month-2026-11-06/h-roll-tuning.md`). The rule was replayed on the archive's per-contract minute volumes: 64 ES and 64 NQ rolls, 2010–2026, plus 278,112 simulated hourly restarts.
  - N = 1 is unsafe. NQ 2015-03-09 stepped 96 market-open hours early on 0.9% of the front's volume.
  - N = 5–30 leak 1–2 early NQ steps after a restart.
  - N = 60 is the smallest N with no early step on ES/NQ, but RTY- and CL-like thinning of the archive let 0–2 through at 5-minute restart offsets.
  - N = 120 lets none through for any of the four thin proxies.
  - Cost against N = 1: a median of +1 h later. The worst lag is +22.7 market-open hours (+40.7 clock hours over a weekend) on ES/NQ, and +32 market-open hours on the CL-like proxy.
  - An early step can't be undone. A late one stays on a still-liquid old front.
  - RTY, CL, GC and ZN have no per-contract history anywhere, so their own roll shapes (CL monthly, GC's off-cycle months) are untested.
- **Same rule in every writer.** The TS copy is in `futures-contracts.ts`, the Python copy in the handler. One shared case fixture is read by both test suites, so the copies can't drift.
  - The uw-stream handler: seeded lazily per root from the DB.
  - `api/cron/backfill-futures-gaps.ts`:
    - one seed per hole, with holes taken in time order, so a hole can seed from bars the run just wrote;
    - the seed contract is fetched even when it's outside the top-2 candidates;
    - the volume tally is replayed from 00:00 UTC of the hole's day.
  - The history backfills (`scripts/_lib/futures-bar-backfill.ts`, `scripts/_lib/futures-flow-backfill.ts`): the bar backfill writes the contract it already knows.
- Tests cover:
  - the roll-day crossover (one step, and no step back after 00:00Z);
  - a transient lead shorter than N;
  - a restart mid-roll;
  - an expiry handover;
  - a decade rollover;
  - the NULL-seed fallback;
  - a stray far-dated contract.

**Tasks, one implementer at a time:**
- **6a.** Migration #203, `db.test.ts`, and the `contract` field in `api/_lib/futures-bars.ts` (insert and fetch), with PGlite tests.
- **6b.** The parser and the forward-only rule in `api/_lib/futures-contracts.ts`, plus the shared case fixture.
- **6c.** The gap cron: per-hole seeds, and it writes `contract`.
- **6d.** The uw-stream handler: Python parser and rule, seed, `contract` column, and tests reading the shared fixture.
- **6e.** The two history scripts. Not needed by 12-09.

**Deploy order: migration, then Vercel, then Railway.**
- The handler swallows flush errors, so a handler that sends `contract` to a DB without the column drops every bar.
- Before applying #203, check for other sessions' pending migrations: `migrateDb` applies all of them.
- Everything is outside market hours and before 2026-12-09, the ESZ6 → ESH7 roll.

## Files

- Phase 1: `ml/src/futures_contract_repair.py` (or a small package), `ml/tests/test_futures_contract_repair.py`, a Makefile/CLI entry.
- Phase 2: `scripts/repair-futures-contract-mix.ts`, `scripts/_lib/futures-contract-repair.ts`, `scripts/_lib/futures-contract-repair.test.ts`.
- Phase 4: `scripts/recompute-futures-derived.ts`, its `_lib` module and its test.
- Phase 6 (by D2):
  - 6a: `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `api/_lib/futures-bars.ts`, `api/__tests__/futures-bars-pglite.test.ts`;
  - 6b: `api/_lib/futures-contracts.ts`, its test, the shared fixture;
  - 6c: `api/cron/backfill-futures-gaps.ts` and its test;
  - 6d: `uw-stream/src/handlers/futures_trades.py` and its tests;
  - 6e: `scripts/_lib/futures-bar-backfill.ts`, `scripts/_lib/futures-flow-backfill.ts` and their tests.
- This spec, updated with results after each phase.

## Data dependencies

- Reads: local archive `ml/data/archive/` (main checkout; pass the path, it isn't in the worktree), Postgres `futures_trade_ticks`, `futures_bars`.
- Writes (Phases 3–5 only, each after an owner-approved dry run): `futures_bars`, `futures_snapshots`, `market_snapshots`, `ws_gamma_setup_fires`, `periscope_grades`.
- No new env var. Phase 6 adds migration #203 (`futures_bars.contract`).

## Thresholds and constants

- Windows (UTC): archive span 2026-04-05 22:00 → 04-17 20:59; tick span 2026-04-20 01:56 → 06-15 14:11. Last bad bar 06-15 14:10 (ZN 14:11).
- Front month: ESM6, NQM6 for the whole window.
- Cluster gap: ES 25 pts; NQ derived (carry ~277, clean p99.99 range 116).
- Ground truth gate: ≥ 99.9% exact minutes, volume within 1%.
- Write batches: 500 rows.
- Phase 6 roll guard:
  - N = 120 consecutive wall-clock minute closes, same for all six roots;
  - the volume tally resets at 00:00 UTC;
  - the seed lookback is 7 days;
  - a one-digit year resolves to [ref − 1, ref + 8].

## Open questions

- **D1, RTY/CL/GC/ZN with no source.** Every minute in the window is suspect, flagged or not. Default: delete those roots' rows inside the window, except the clean days 04-13..04-17, 06-01 and 06-08, after a JSONL backup, so readers see "no data" instead of wrong prices. The alternatives are keeping them with a quality marker, or leaving them and recording the gap.
- **D2, the roll rule: DECIDED 2026-11-06, option A** (roll forward only, with a `contract` column). Design in Phase 6, with the guard N = 120 tuned on history. A fixed roll calendar per root was rejected.
- **Order flow for 04-20..06-15.** The ticks carry an aggressor side, so ES/NQ buy/sell volume could be filled for that span. Default: out of scope. It's Databento's side flag, not UW's, and the flow isn't shown anywhere.
- **Research files built on the bad bars** (NQ flow-leadership 05-02, iv-anomaly leadership 04-25): default is to list them for a re-run after Phase 3 and not re-run them unasked.

## Related, not in this spec

- Bar gaps 2026-08-06/07 and 08-11..08-14 (CL to 08-17) are inside UW's REST history. The September backfill (`2026-11-06-futures-sept-bar-backfill.md`, another session) can fill them with its `--from/--to`.
- `index_candles_1m` SPX steps +23 pts at 2026-04-10 12:11 CT (b-forensics.md §1.4). This belongs to the DB repair list (`db-data-repair-2026-10-27.md`).
