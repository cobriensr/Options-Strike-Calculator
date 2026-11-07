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

### Phase 4: recompute what was saved from the bad bars (one implementer task + run)

| Store | Rows | Action |
|---|---|---|
| `futures_snapshots` (ES, NQ) | about 15.8K per root, 04-06 → 06-16 | Recompute each (symbol, ts) with `computeSnapshot`; UPDATE where it differs |
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
  - the year digit gives the year, resolved to the one year in [ref − 1, ref + 8] that ends in that digit, where ref is the UTC year of the print or bar (at 2026, `H7` → 2027 and `Z5` → 2035);
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
