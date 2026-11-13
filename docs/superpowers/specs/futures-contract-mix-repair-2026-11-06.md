# Futures bars: repair the April–June contract-month mix

## Goal

Replace the `futures_bars` rows that merged several contract months (2026-04-05 evening to 2026-06-15 09:10 CT) with true front-month bars wherever a source exists. Recompute what was saved from them. The live roll fix (the December ESZ6 → ESH7 roll) moved to `2026-11-06-futures-session-front-month.md`; see Phase 6.

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
- **Opt-in delete of the frozen-stale ES and NQ rows (owner OK 2026-11-11).** A snapshot row before 2026-10-01 that `computeSnapshot` cannot price (stale or missing: no closed bar within 15 minutes, so today's code would not have written it) and whose stored price is not the close of the latest closed bar at any age is frozen on an older bar, and nothing can be recomputed. A stale row that repeats the last bar's close stays, and so do the thin roots (D1). The 2026-11-11 dry run found ES 504 and NQ 504 (of 3,300 and 3,024 stale rows; the other 2,796 and 2,520 repeat the last close), each with 45 in the 16:15 to 17:00 CT break, 160 on a weekend or holiday and 299 elsewhere. It runs alone: `--stores frozen` plans no other store (SQL finds the candidates and `computeSnapshot` confirms each, about 15 seconds against the hour of the full plan). The apply is `--apply --stores frozen --delete-frozen-stale --expect-frozen-deletes N`, off by default, on the same machinery as the junk delete: `plan.json`, the full rows in the backup first, `frozen.started` and `frozen.applied`, a DELETE batched and guarded by id, symbol and the planned price, a verify that the rows are gone and that nothing else before 2026-10-01 left the table, and a resume.
- **Opt-in rewrite of the stale-at-write rows (rulings 6 and 7).** The writer had no freshness gate until 2026-09-30 (`ecf9c021`, with no backfill): it priced from the last bar it had while minutes were missing, and the minutes have landed since. A snapshot row before 2026-10-01 whose price matches by value a bar older than 15 minutes at the row (the bar today's gate rejects), and whose recompute is fresh and differs, is a stale-at-write row. The step writes every differing field that the normal step does not write on that row, so each field is written once, by one step, and its backup line says `step: stale`. ES and NQ: every such row from the span start. RTY, CL, GC and ZN: only rows from the span end + 20 days, 2026-07-05T14:11Z (ruling 9: their bars before the span end, 2026-06-15T14:11Z, are still month-mixed, D1, and a snapshot in the 20 days after it reads some of them, through its hour-ago bar, its day-open bar and its 20-day volume window; the span end itself is a step, CL 71.87 to 80.15; `scopeRanges().snapshots.toMs`, the reach the normal step already uses, so no new rule; the thin-root frozen rows from 2026-06-15 to 07-05 stay as stored, counted per root in the report), and not on the days the Phase 1 detector confirmed contaminated in their bars after the span end (ruling 7b: the same flagging, thresholds and confirmation as section 3 of `b-forensics.md`, run read-only over 2026-06-15T14:11Z to 2026-10-01 into `docs/tmp/es-contract-month-2026-11-06/b-after-span/`; a contaminated day has at least 10 flagged bars and 1% of the day's bars, in a run of at least 3 days; `--detector-days` takes its `detector_days.json`, and without it those rows are left). That run found no contaminated day in any of the four roots, so nothing is left out; a single flagged bar is the clean-day false-positive rate (RTY 0.014% against 0.011%) and its day is not excluded. The dry run lists the contaminated days with their row counts and the share of the root's after-span stale rows, says to stop when the share is over 10%, and lists the stale rows on the days with a flagged bar as information. A row is also stale when it sits in a frozen run (ruling 8): consecutive rows of the root with one identical stored price, spanning more than the freshness gate (15 minutes) from the first row to the last, with a fresh recompute that differs. It needs no matching bar and no look-back, so it reaches the 2026-09-04 to 09-28 outage rows, whose last good bar is up to 25 days old and whose snapshots hold one price per root; a flat market recomputes equal and is not written. The dry run reports how many rows the clause adds, and how many of them fall in the outage. `--rewrite-stale-at-write` with `--expect-stale-rewrites S` does it, off by default, with the same guarded UPDATE and verify as the snapshot writes. The dry run reports, per root, the planned rows in the span and after it, the 10 largest changes with the matched bar's age and the frozen runs.
- **The report's "not written" lists (fix round 6).** The largest-differences list, the "stored price matches no pre-repair bar" section, the unaffected-field counts and the drift list are what is left after every planned step with the opt-in steps on: a row in the stale plan (for the fields it writes) or the junk plan is in none of them. Reconciliation lines per root and in total give the rows touched by the normal step only, the stale step only, both and the junk delete, and the distinct rows.
- **Apply mechanics (fix round 6).** The apply writes its whole plan before any write: `plan.json` names a `backup-*.jsonl` in the work dir with one line per row and step (`snapshots`, `premarket`, `fires`, `stale`, `junk` or `frozen`), the row as it is and the new values, and it applies from that file. `plan.json` also records each step's row count, the plan file's line count and its sha256; a file that is cut, edited or does not match is refused before a write. Just before a step's first write the apply records `<step>.started`, and `<step>.applied` when the step is done. A run that fails once a step has started or applied is finished by running the same command again: the steps not applied run from the saved plan, with no planning (a fresh plan no longer finds the rows a started step wrote, and planning takes the better part of an hour). Inside a started step a row that already holds the new value is done; before each step every row must still hold its old value or its new one, and any other value stops that step before it writes. A different command (other totals, opt-in flags, `--stores`, `--backup`, `--detector-days` or `--work-dir`) is refused, not planned again: `--force` plans again, or remove `plan.json`. A run that failed before any step started plans again. The "left alone" lines leave out the rows in the junk plan, which the opt-in delete removes. `--rewrite-stale-at-write` is refused when more than 10% of a thin root's after-span stale rows sit on contaminated days (empty for 2026-06-15 to 10-01, so it cannot fire today).
- **The frozen-run span (fix round 6).** `frozenRunsOf` measures a run between cron timestamps, which carry jitter, so a run of four rows at a nominal five minutes is frozen about half the time; it does not split at a time gap, so identical prices on either side of a closure join. Both are harmless in the direction ruling 8 states: a flat run recomputes equal and is not written, and a row whose bar landed late gets today's value.
- **Dry run of 2026-11-07:** 25,365 snapshot rows, 35 pre-market rows and 0 fire values to write (before ruling 6); every control passes.

**Done 2026-11-11 (owner OK "Apply all", 2026-11-10).**
- **Apply**, 2026-11-11 06:34Z, exit 0, one run. Snapshots 25,389, pre-market 35, fires 0, stale-at-write 96,794 changed and verified; junk-stale 1,964 deleted and verified; 116,861 distinct rows. Backup and plan: `docs/tmp/futures-derived-recompute/backup-2026-11-11T06-34-38-759Z.jsonl` and `plan.json` (gitignored), log `apply-run.log`.
- **Independent after-check** (`docs/tmp/futures-derived-recompute/verify-apply.md`, read-only):
  - every touched row (114,897 snapshot ids, 35 pre-market ids) holds the planned value in each written field and its old value elsewhere, and the 1,964 junk ids are gone;
  - row counts equal rows in range minus the deletes, and no live row since 10-01 was touched;
  - a fresh dry run plans 0 for every step except 7 ES stale volume-ratio rows. Those are a second-pass coincidence: the repaired price now matches an older pre-repair bar by value. They are left as stored, like the other unaffected drift;
  - the controls pass (snapshots 12,051 of 12,051, pre-market subset 110 of 110, fires 166 of 166).
- **Left as stored, by design:** rows with no fresh bar within 15 minutes, for which `computeSnapshot` returns stale and nothing can be recomputed. ES 3,300 and NQ 3,024 before 10-01, of which 504 each hold a price frozen on an older bar rather than the last bar's close (for example 10 ES rows in the 04-13 16:15–17:00 CT break at 6784.25, and one row a day just after each September reopen at the outage price). The owner approved deleting those 504 each on 2026-11-11 (the frozen-stale delete above). The thin roots have more such rows (GC most), part of D1.
- **Frozen-stale delete**, 2026-11-11 21:38Z, exit 0: 1,008 rows (ES 504, NQ 504, 2026-04-13 to 09-29) deleted and verified, equal to the dry run. Backup `docs/tmp/futures-derived-recompute/frozen-apply/backup-2026-11-11T21-38-37-908Z.jsonl` (1,008 lines) with its `plan.json`, log `frozen-apply-run.log`. A read-only check found none of the 1,008 ids left. The first try at 21:05Z was refused by the tool's own market-hours guard, which runs to 16:05 ET inclusive, and wrote nothing.
- **Periscope regrade** (owner OK, 2026-11-11): `scripts/grade-periscope-day.mjs` for 05-07 (40 slots) and 05-08 (38), after a backup of the 77 old rows (`docs/tmp/futures-derived-recompute/periscope-grades-backup-2026-05-07-08.jsonl`). Only the ES/NQ trade simulations changed; on 05-08, ES went from 81% wins and +2.60% to 38% and −1.32%, and NQ to 69% and +1.55%. One never-graded 05-07 slot was added.

### Phase 5: RTY, CL, GC, ZN (D1 decided 2026-11-11: delete)

There's no source for these four. The owner chose the default on 2026-11-11 ("Delete them"): their bars in the window go, except the seven clean days, and the snapshots computed from them follow, so readers see no data instead of wrong prices. Each half runs after an owner-approved dry run.

- **5a, the bars.** `scripts/repair-futures-contract-mix.ts --thin-roots` deletes every RTY, CL, GC and ZN bar from 2026-04-05T22:00Z through the root's last bad bar (2026-06-15T14:10Z; ZN 14:11Z), except the bars on CT trading days 04-13 to 04-17, 06-01 and 06-08 (trading day = the CT date of ts + 7 h). The read-only count on 2026-11-11 (through 14:11Z for every root): CL 69,232 in the window and 9,360 on the clean days, GC 54,843 and 174, RTY 68,610 and 9,283, ZN 61,691 and 6,764, so about 228,800 deleted. It uses Phase 2's machinery: a dry run, a full-row backup in Phase 2's format first, one UTC day per transaction with `{day}.applied` markers, `--expect-deletes`, a DELETE guarded by id and symbol, after the close. The dry run also lists the bars Phase 1's strict test flags on the kept days, per root.
- **5b, the snapshots.** `scripts/recompute-futures-derived.ts` with the 5a backup as `--backup` and `--roots RTY CL GC ZN`, after 5a has applied:
  - A field that read a deleted bar is recomputed by today's `computeSnapshot` on the bars that are left. That is mostly `volume_ratio` on the clean days and in the 20 days after the span end, whose 20-day window loses the deleted days, plus 06-15's `change_day_pct`, whose session-open bars are gone.
  - A row priced from a deleted bar is now stale and can't be recomputed, so `--delete-junk-stale` deletes it (the existing junk-stale rule).
  - Ruling 9's guard is lifted once no thin-root bar is left in the span outside the clean days (the tool checks this read-only and prints it). The stale-at-write rewrite then covers the thin roots from the span start, like ES and NQ, and the frozen-stale delete covers them too. Before 5a, both still leave the thin roots as now.

**Phase 5 as built (2026-11-11).** Both halves and the thin-root frozen-stale delete were applied on 2026-11-12, and the thin-root volume-ratio blanking on 2026-11-13, each after an owner-approved dry run (see the Done block below).

- **5a.** `--thin-roots` reads no Phase 1 `--dir` (passing one is refused). `--apply` takes `--expect-deletes N` only: the mode never updates a row, so `--expect-updates` is refused. The default work dir is `docs/tmp/futures-contract-repair/thin-roots`, apart from Phase 2's markers. The scope is one module, `scripts/_lib/futures-thin-roots.ts` (window, each root's last bad bar, the clean days, the CT trading day), which 5b reads too. The delete is guarded by id, symbol and every price and volume, one UTC day per transaction.
  - **One cumulative backup.** The backup is `backup-thin-roots.jsonl` in the work dir, the same file across every run. A run that stops (a failed day, the open) is finished by another, and 5b takes a single `--backup`, so a file per run would split the deleted rows. Each `--apply` adds a line for each pending row whose `id` the file does not hold, before its first write, and refuses (before any write) if an `id` is there with other values, naming the id and the column. After any number of failed and resumed runs the file holds each deleted row once. An `--apply` also leaves the dry run's `report.txt` and `delete-list.csv` alone, since they are what the owner approved, and writes `apply-<time>-report.txt` and `apply-<time>-delete-list.csv` (Phase 2's mode does the same). The file lists a day's rows before that day is deleted, so a stopped or failed run leaves rows in it that are not deleted yet: it is complete only once a run prints `done.` (the stop and failure messages say so), and a run the open refuses before its first day appends nothing.
  - **Dry run on production, 2026-11-11 (read-only, 24 s):** 228,793 deletes: RTY 59,326, CL 59,871, GC 54,669, ZN 54,927. Kept on the clean days: RTY 9,283, CL 9,360, GC 174, ZN 6,764. Against the 2026-11-11 count through 14:11Z for every root, RTY and CL are one bar lower each and GC and ZN are equal, which is what one 14:11Z bar on RTY and one on CL would give (their last bad bar is 14:10Z, so the scope keeps it; not queried).
  - **Phase 1's strict test on the kept days** (b-forensics.md 3.2: RTY 14, CL 1.8, GC 20, ZN 0.125): RTY, GC and ZN 0 flagged; CL 3 (2026-04-12 22:00Z, E 2.415, and 04-14 23:34Z and 23:35Z, E 2.04 and 2.2), the 1 to 2 flagged bars a day on CL 04-13 to 04-15 that b-forensics.md section 4 already names.
  - **Apply:** `npx tsx scripts/repair-futures-contract-mix.ts --thin-roots --apply --expect-deletes 228793 --work-dir F:/dev/strike-calculator/docs/tmp/futures-contract-repair/thin-roots`, after the close.
- **5b.** `--roots r1 r2 ...` limits snapshots, the stale-at-write rewrite, the junk delete and the frozen-stale delete to those roots (default all six); premarket and fires are ES-only, so without ES they plan nothing and their `--expect-*` totals are refused. `plan.json` records `roots`, and a resume with other roots is refused like the other options (a `plan.json` from before `--roots` counts as all six). The attribution rules needed no change: a 5a backup that deletes whole days makes `volume_ratio` affected on the clean days and in the 20 days after the span end, and a row priced from a deleted bar that is now stale goes to the junk plan. Use a work dir of its own: the markers in `docs/tmp/futures-derived-recompute` belong to the earlier apply. Its header says `bar backup <path>: N rows (U updated, D deleted; deleted by root: RTY a, CL b, GC c, ZN d)`, so the 5a total (228,793) and its four root counts can be checked before anything is applied. The lift's count read fails closed: a missing row or a count that is not a whole number stops the run instead of reading as 0. An `--apply` of this tool leaves the dry run's `report.txt` and `merge-state.txt` alone and writes `apply-<time>-report.txt` and `apply-<time>-merge-state.txt`; `plan.json`, the markers, the resume and the backup are unchanged.
  - **The lift of ruling 9, per root.** At plan time the tool counts a thin root's bars from the span start through its last bad bar (what 5a deletes) outside the seven clean days, prints it (`RTY 0 (lifted), CL 1 (kept)`) and reads it per root. A root with 0 is lifted: the stale-at-write rewrite covers its rows from the span start instead of from the span end + 20 days, and `--stores frozen` plans it with ES and NQ. A root with any bar left keeps today's behavior, so a run before 5a changes nothing. Rows after the span end stay under the `--detector-days` rule for a lifted root: without the file they are left (counted as unchecked), including those in the 20 days after the span end that ruling 9 used to leave outright.
  - **The report** gives, per root, `rows planned, RTY: normal step N rows, stale-at-write S rows (L added by the D1 lift), junk delete J rows`, where L counts the planned stale rows before the span end + 20 days that ruling 9 would have left; the frozen section marks a lifted root `(added by the D1 lift)` and names the thin roots that stay out.
  - **Test fixtures:** the Phase 4 pglite fixtures have no thin-root bar in the span outside the clean days, which the lift reads as "5a has applied". The ones that test ruling 9 now seed a month-mixed bar per thin root, as the world was before 5a.
  - **Added 2026-11-13 (final review of Task 5).**
    - For a lifted root, the snapshot step and the stale-at-write rewrite no longer plan `volume_ratio`. 5a emptied most of its 20-day window, so a rerun leaves the column as stored.
    - `--stores volume-null` blanks the values 5b wrote, with the 5b apply backup as its scope (Done block).
    - A run that plans snapshots refuses a lifted root unless `--backup` holds a 5a delete for it outside Phase 2's junk window. `--stores frozen` and `volume-null` take no 5a backup.
    - The 5a backup and its delete guard carry `futures_bars.contract`.
    - A dry run in a work dir an apply has written to writes `dryrun-<time>-` files, so it leaves the approved `report.txt` alone.

**Done 2026-11-12 and 2026-11-13 (owner OK for each step).** Backups, plans and logs are under `docs/tmp/` (gitignored).
- **5a, the bars** ("Delete the 228,793"), 05:52–05:53Z, exit 0: 228,793 deleted and verified (RTY 59,326, CL 59,871, GC 54,669, ZN 54,927), 53 `.applied` day markers. Backup `docs/tmp/futures-contract-repair/thin-roots/backup-thin-roots.jsonl` (228,793 lines), log `thin-roots-apply-run.log`. Independent read-only check: 0 bars left in scope; every other symbol and every bar outside the scope unchanged in count, sum of closes, volumes and open + high + low; the backup's distinct ids and sum of closes per root equal the pre-apply numbers.
- **5b, the snapshots** ("Apply all three"), 21:07–21:29Z, exit 0: 10,106 recomputed, 14,942 stale-at-write rewritten (all added by the lift) and 51,836 junk-stale deleted, each verified and equal to the approved dry run. Junk by root: RTY 12,801, CL 12,696, GC 13,346, ZN 12,993. Work dir `docs/tmp/futures-derived-recompute/thin-roots/` (backup `backup-2026-11-12T21-29-32-944Z.jsonl`, 76,884 lines; the dry run's `report.txt` kept beside `apply-…-report.txt`), log `thin-roots-apply-run.log`. A first try at 14:37Z started late, during market hours, and the tool's guard refused it before any write. Independent read-only check: ES, NQ and DX `futures_snapshots` before 11-11 identical in count and md5 to the pre-apply fingerprint; each thin root down by exactly its junk count; 0 junk ids left; all 16,470 distinct updated rows (8,578 changed by both steps) hold their planned values.
- **Frozen-stale delete on the thin roots** ("Delete all 15,142"), 22:40Z, exit 0: 15,142 deleted and verified (RTY 694, CL 1,095, GC 11,848, ZN 1,505), the ES/NQ rule of 2026-11-11 on the lifted roots. Only 1,726 are in the span; 13,416 are 06-15 to 09-30, of which GC 10,958. Cause: GC's bars before September were almost absent (993 GC bars in July against 29,000–31,000 for each other root; 1,449 from 07-06 to 09-03), so GC snapshots sat for hours on prices about 1.2% off the last bar. The delete removed 68% of GC's 06-15 to 09-03 snapshot rows (10,912 of 15,963): that stretch is now sparse instead of wrong. Work dir `docs/tmp/futures-derived-recompute/thin-roots-frozen/` (backup `backup-2026-11-12T22-40-13-188Z.jsonl`, 15,142 lines), log `thin-roots-frozen-apply-run.log`. Independent read-only check: 0 ids left; ES, NQ and DX unchanged in count and md5; each thin root down by exactly its total; a fresh frozen dry run plans 0.
- **Thin-root `volume_ratio` blanked** ("Blank all 7,146"), 2026-11-13 07:35Z, exit 0: 7,146 set to NULL and verified (RTY 2,348, CL 2,381, GC 530, ZN 1,887).
  - Why: 5b recomputed them from 20-day windows that 5a had mostly emptied, so each rested on a few leftover UTC-day groups.
  - Kept: RTY, CL and ZN on the April clean days 04-13 to 04-17 (2,443 rows, which moved about 3%).
  - By region: June clean days 792; 06-15 14:11Z to 06-16 04:00Z 352; 06-16 04:00Z to 07-05 14:11Z 5,916; GC on the April clean days 86.
  - Each row was changed only if it still held the value 5b wrote.
  - Work dir `docs/tmp/futures-derived-recompute/thin-roots-volume-null/` (backup `backup-2026-11-13T07-35-20-640Z.jsonl`, 7,146 lines; the dry run's `report.txt` kept), log `thin-roots-volume-null-apply-run.log`.
  - Independent read-only check against a pre-apply fingerprint: all 7,146 are NULL. The md5 per symbol of every row without `volume_ratio`, and of every row outside the 7,146, is unchanged, and so is ES, NQ and DX in full.
- **Left as stored, by design:** thin-root rows with no fresh bar whose price equals the last bar's close (RTY 1,526, CL 2,078, GC 3,422, ZN 1,610 before 10-01), as for ES and NQ.

### Phase 6: a roll-safe live writer, moved to the session front-month plan

**Superseded 2026-11-07 (owner, "mix").** The rule is no longer this spec's 120-close roll-forward streak. It is one contract per root and CME trade date, picked at the 17:00 CT open from the prior session's per-contract volume, forward only and stored once. That plan, `docs/superpowers/specs/2026-11-06-futures-session-front-month.md`, owns the rule end to end: the gap cron, the uw-stream handler and the history scripts. Why: on a typical ES roll the streak switches about 10:30 CT, which puts a calendar-spread step of about 55 points inside the session the owner trades.

- It took this spec's 6a and 6b work: the `futures_bars.contract` column (migration #204 there, renumbered from this branch's #203) and the contract-code parser. The six commits stay reachable from `archive/futures-p6-roll-forward`.
- Prod has #204 and #205, applied 2026-11-08. That plan's Phases 1 to 5a are on main as of 2026-11-11. Its uw-stream step lands before the 2026-12-09 ESZ6 → ESH7 roll.
- The repaired April–June ES and NQ bars keep Phase 2's switch points, with `contract` NULL. That is open question 6 in that plan, with the default "leave them".

## Files

- Phase 1: `ml/src/futures_contract_repair.py` (or a small package), `ml/tests/test_futures_contract_repair.py`, a Makefile/CLI entry.
- Phase 2: `scripts/repair-futures-contract-mix.ts`, `scripts/_lib/futures-contract-repair.ts`, `scripts/_lib/futures-contract-repair.test.ts`.
- Phase 4: `scripts/recompute-futures-derived.ts`; `scripts/_lib/futures-derived-recompute.ts`, `futures-derived-attribution.ts` and `futures-derived-batch.ts`, with `futures-derived-recompute.test.ts`, `futures-derived-recompute-pglite.test.ts` and `futures-derived-frozen-pglite.test.ts`; `api/_lib/futures-derive.ts` (closed-bar rule, exported constants) with `api/__tests__/futures-derive-pglite.test.ts` and the updated cron and endpoint tests; `api/cron/auto-prefill-premarket.ts` (exports its window helpers and Globex query).
- Phase 5: `scripts/_lib/futures-thin-roots.ts` with `futures-thin-roots.test.ts`; 5a in `scripts/repair-futures-contract-mix.ts` and `scripts/_lib/futures-contract-repair.ts` (tests in `futures-contract-repair.test.ts` and `futures-contract-repair-pglite.test.ts`); 5b in `scripts/recompute-futures-derived.ts` and `scripts/_lib/futures-derived-recompute.ts`, with `futures-derived-thin-roots-pglite.test.ts` and `--roots` cases in `futures-derived-recompute.test.ts`.
- Phase 6: none here; see the session front-month plan.
- This spec, updated with results after each phase.

## Data dependencies

- Reads: local archive `ml/data/archive/` (main checkout; pass the path, it isn't in the worktree), Postgres `futures_trade_ticks`, `futures_bars`.
- Writes (Phases 3–5 only, each after an owner-approved dry run): `futures_bars`, `futures_snapshots`, `market_snapshots`, `ws_gamma_setup_fires`, `periscope_grades`.
- No new env var and no migration in this spec. The `futures_bars.contract` column is #204 in the session front-month plan.

## Thresholds and constants

- Windows (UTC): archive span 2026-04-05 22:00 → 04-17 20:59; tick span 2026-04-20 01:56 → 06-15 14:11. Last bad bar 06-15 14:10 (ZN 14:11).
- Front month: ESM6, NQM6 for the whole window.
- Cluster gap: ES 25 pts; NQ derived (carry ~277, clean p99.99 range 116).
- Ground truth gate: ≥ 99.9% exact minutes, volume within 1%.
- Write batches: 500 rows.

## Open questions

- **D1, RTY/CL/GC/ZN with no source: DECIDED 2026-11-11 (owner, "Delete them").** Every minute in the window is suspect, flagged or not. Delete those roots' rows inside the window, except the clean days 04-13..04-17, 06-01 and 06-08, after a JSONL backup, so readers see "no data" instead of wrong prices, and the snapshots computed from them with them. See Phase 5; applied 2026-11-12 and 2026-11-13 (its Done block). Rejected: keeping them with a quality marker, or leaving them and recording the gap.
- **D2, the roll rule: DECIDED 2026-11-06 (option A), then superseded 2026-11-07** by the owner's "mix": the `contract` column and the parser stay, and the per-session pick replaces the 120-close streak. See Phase 6.
- **Order flow for 04-20..06-15.** The ticks carry an aggressor side, so ES/NQ buy/sell volume could be filled for that span. Default: out of scope. It's Databento's side flag, not UW's, and the flow isn't shown anywhere.
- **Research files built on the bad bars** (NQ flow-leadership 05-02, iv-anomaly leadership 04-25): default is to list them for a re-run after Phase 3 and not re-run them unasked.

## Related, not in this spec

- Bar gaps 2026-08-06/07 and 08-11..08-14 (CL to 08-17) are inside UW's REST history. The September backfill (`2026-11-06-futures-sept-bar-backfill.md`, another session) can fill them with its `--from/--to`.
- `index_candles_1m` SPX steps +23 pts at 2026-04-10 12:11 CT (b-forensics.md §1.4). This belongs to the DB repair list (`db-data-repair-2026-10-27.md`).
