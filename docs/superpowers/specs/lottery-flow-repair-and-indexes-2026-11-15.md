# Lottery / Silent Boom flow repair and the flow-table indexes (2026-11-15)

Status: Phase A in build on branch `fix/flow-series-ws-first`. Phases B and C are designed here and not built.

Source findings (read-only investigation, 2026-11-15, local and gitignored): `docs/tmp/lottery-flow-repair-and-index-findings-2026-11-15.md`, sections 1, 2, 3 and 6. The facts this spec relies on are repeated below, so it reads without that file.

## 1. Goal

Make the per-ticker cumulative net-flow series, and every stored `cum_ncp_at_fire` / `cum_npp_at_fire` built from it, equal what a healthy live run would have stored (the websocket rows, up to the fire time), then correct the rows that were written doubled. Afterwards, keep new gaps from waiting for a human (Phase B) and stop the slow series read at its root (Phase C).

## 2. The defect (verified against production on 2026-11-15)

Two tables hold a ticker's net flow:

- `ws_net_flow_per_ticker`: one row per websocket tick, `ts` with milliseconds (for example `14:30:00.984`). Written live by uw-stream since 2026-05-04.
- `net_flow_per_ticker_history`: one REST row per minute, `ts` minute-aligned, `source = 'rest'`. Loaded once a day at 21:25 UTC by `api/cron/fetch-net-flow-history.ts`, so it is empty for today until then.

After the close both tables hold the same day's flow at different resolutions (QQQ 2026-11-13 14:30 to 15:30 UTC: 3,638 WS rows and 60 history rows, both summing to -7,117,984.00 call premium).

The series was built as `UNION ALL` of the two tables, `DISTINCT ON (ts)` (WS first), then a running `SUM`. WS `ts` carries milliseconds and history `ts` does not, so `DISTINCT ON (ts)` almost never merges a pair, and the sum counts the day twice.

Evidence: META fire 1073415 (2026-10-29, 16:00:57Z) stores `cum_ncp_at_fire` 43,816,346. WS-only is 21,920,705, history-only is 21,895,641, and the sum is 43,816,346 to the unit. Fifteen sampled repaired fires held 1.98x to 2.03x the WS-only call premium.

Two consequences:

1. Any reader that builds the series after 21:25 UTC sees about twice the flow. Live detector runs are not affected (history for today is not loaded yet).
2. A history minute row stamped `hh:mm:00` holds the flow of the whole minute `[hh:mm, hh:mm+1)`. Reading it at a fire time inside that minute carries up to 59 seconds of flow after the fire. This is look-ahead, and it is separate from the doubling.

### The rule (Phase A)

For one ticker-day (the session window from `ctSessionBounds(date)`):

1. If the day has any WS row, the series is the WS rows alone. History is not read.
2. If the day has no WS row (before 2026-05-04, a ticker outside the WS universe, a long uw-stream outage), the series is the history rows.
3. History rows are counted only when their minute is complete. In the point-in-time series (`fetchTickerFlowSeries`) a history row's time is `ts + 60 s`, so `flowAtFireTime(series, fireTs)` reaches it only once `ts + 60 s <= fireTs`, for every fire of the day. In the chart readers (which show a whole past day at once, with the minute-start stamp on the x axis) a history row is read only when `ts + 60 s <= now`.

The decision is per ticker-day, never per minute: mixing the two resolutions inside a day is the defect.

Known limit, same as a live run: a day where the WS stream covers only part of the session is WS-only, so it undercounts the part the stream missed. A healthy live run stored that too. A hybrid (WS where present, history for the gap) would need a rule for the boundary minute and is not built (Open question 2).

## 3. Phases

### Phase A: the series fix and the correction (built now)

Scope: five commits, none over five files.

| # | Commit | Files |
| --- | --- | --- |
| A0 | This spec | `docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md` |
| A1 | The rule in `fetchTickerFlowSeries`; delete the unused `snapshotTickerFlowAtFire` | `api/_lib/ticker-flow-snapshot.ts`, `api/__tests__/ticker-flow-snapshot-pglite.test.ts` (the existing mocked test needed no change) |
| A2 | The rule in the two chart readers | `api/net-flow-history.ts`, `api/ticker-net-flow-current.ts`, `api/__tests__/net-flow-series-pglite.test.ts` (the two existing mocked handler tests needed no change) |
| A3 | The backfill script calls the library | `scripts/backfill-ticker-flow-at-fire.ts` (replaces the `.mjs`), `scripts/_lib/ticker-flow-backfill.ts`, its pglite and CLI tests, `scripts/_lib/fire-flow-test-helpers.ts` (fixtures shared with A4), `tsconfig.scripts.json`, and the three comment and README mentions of the old name |
| A4 | The correction library | `scripts/_lib/fire-flow-correction.ts`, its unit and pglite tests, `scripts/_lib/lottery-v2-rescore.ts` (export `loadActive`), `tsconfig.scripts.json` |
| A5 | The correction CLI | `scripts/correct-doubled-fire-flow.ts`, its CLI test |

The correction is NOT run by the build. The owner runs it, dry run first (section 6).

### Phase B: automatic post-close repair (not built)

An extra step in `enrich-lottery-outcomes` (slots 21:40, 22:40, 23:40 UTC) and `enrich-silent-boom-outcomes` (21:45, 23:45 UTC), both post-close, both DB-only, through one shared `api/_lib/fire-flow-repair.ts`. No new cron, no new Sentry monitor, no new Python.

Why this host (findings section 2): the day's NULL-flow gaps are fixed the same evening, 40 to 100 minutes after the close; it adds no market-hours load (a retry inside the detectors would land when the compute is saturated); the TypeScript scorer is reused; and the owner rules favour fewer crons and TypeScript outside `ml/`. A new isolated cron and a step in the Railway `nightly` service were the alternatives; the second needs a Python copy of the series SQL and the scorer.

What the step does:

1. `selectNullFlowGroups`: ticker-days with `cum_ncp_at_fire IS NULL`, bounded by date (the table is 1.8 GB and no index covers the predicate) and by `trigger_time_ct >= the 08:30 CT open` (pre-open fires can never be repaired and must not be re-selected forever). `silent_boom_alerts` uses `bucket_ct`.
2. One `fetchTickerFlowSeries` per group (the Phase A rule), `flowAtFireTime` per fire.
3. A conditional, batched write: `UPDATE ... FROM unnest(ids, ncp, npp) WHERE cum_ncp_at_fire IS NULL`, 500 rows per statement (R5, R6).
4. For lottery rows just repaired, re-score with the active weights: the guard and tag rules of `scripts/_lib/lottery-v2-rescore.ts` (moved into `api/_lib`), stopping with nothing written if the loader returns its seed fallback.
5. Honest status (R4): a failed write makes the run `partial`; a residual after the day's last slot is one error-level Sentry message with a fixed fingerprint.

Files (about 10, in phases of at most five): `api/_lib/fire-flow-repair.ts`, `api/_lib/lottery-flow-rescore.ts` (moved out of `scripts/_lib/lottery-v2-rescore.ts`), the two crons, their tests, a pglite test, and `scripts/_lib/ticker-flow-backfill.ts` shrinking to a wrapper. Size of the job: about 25 ticker-day groups a day on average, 60 to 70 on the worst day; a cold series read is 5.7 to 7.6 s today, so the step needs the Phase C index on a heavy day or a second slot.

### Phase C: indexes (not built; each needs the owner's OK)

All three are applied by hand with a direct connection outside 13:00 to 22:00 UTC on weekdays, with `CONCURRENTLY`, and then shipped as idempotent `IF NOT EXISTS` / `IF EXISTS` migrations, as #184 and #199 were. Apply by hand first, deploy the migration after: otherwise `migrateDb` would try a blocking `CREATE UNIQUE INDEX` over 96 million rows inside one HTTP transaction. The next free migration id is 210 (the latest on `main` is #209).

- **M1.** Covering unique index on `ws_net_flow_per_ticker (ticker, ts) INCLUDE (net_call_prem, net_put_prem, net_call_vol, net_put_vol)`, replacing `ws_net_flow_per_ticker_uq`, plus `autovacuum_vacuum_insert_scale_factor = 0.001` on the table. uw-stream's `ON CONFLICT (ticker, ts)` infers the new index. Measured planner cost of the index-only plan is 344 against 14,079 today. About +2.5 GB over `uq` while both exist.
- **M1b.** Drop `ws_net_flow_per_ticker_ts_idx` (2.2 GB) a week after M1, only if its `idx_scan` is flat.
- **M2.** `lottery_finder_fires (underlying_symbol, date) INCLUDE (peak_ceiling_pct) WHERE peak_ceiling_pct IS NOT NULL`, about 45 MB, for the Take-It win-rate load (44 to 60 s today).

The exact DDL and its measurements are in the findings, section 6.

## 4. Where the series is built (inventory, by code reading)

| Place | What it does | Doubled after the close? | Phase A change |
| --- | --- | --- | --- |
| `api/_lib/ticker-flow-snapshot.ts` `fetchTickerFlowSeries` | Series for the detectors, the replays, the backfill | Yes (UNION ALL, DISTINCT ON (ts)) | WS-first rule, history shifted by 60 s |
| `api/_lib/ticker-flow-snapshot.ts` `snapshotTickerFlowAtFire` | Same UNION, one fire | Yes, but unused: no caller in `api/`, `src/`, `scripts/` or any test | Deleted |
| `api/net-flow-history.ts` (the per-fire Net Flow chart, 60 s poll) | UNION ALL + DISTINCT ON (ts) + cumulative | Yes, for any past day: the cumulative line is about 2x | WS-first rule, history read only when `ts + 60 s <= now` |
| `api/ticker-net-flow-current.ts` (Flow Match / Mismatch badges) | UNION ALL + DISTINCT ON (ticker, ts), latest cumulative per ticker | Yes, for any past day | WS-first rule per ticker, same 60 s read rule |
| `scripts/backfill-ticker-flow-at-fire.mjs` | Its own copy of the series SQL, hard 15:00 CT end | Yes: wrote 2,159 doubled rows on 2026-11-15 | Replaced by a `.ts` script that calls `fetchTickerFlowSeries` |
| `api/_lib/db-greek-heatmap.ts` `getGreekHeatmapNetFlow` | Today: WS only. Past dates: history only (`source = 'rest'`). One table per day | No | None (it already chooses one table per day) |
| `api/_lib/periscope-lottery-finder.ts` `fetchQqqNetPremBalance30m` | History only, 30-minute sum | No | None. It does read minute rows up to the fire minute (look-ahead of up to 59 s); flagged, not changed |
| `scripts/enrich_lottery_outcomes.py`, `refine_spy_qqq_and_oos.py`, `ml/experiments/lottery-net-flow-eda/*` | History only, research and the nightly inversion pass | No | None |
| `api/cron/detect-lottery-fires.ts`, `detect-silent-boom.ts` | Call `fetchTickerFlowSeries` live | No (history for today is empty until 21:25 UTC) | None to the call sites; they get the new series |
| `scripts/replay-lottery-fires-2026-05-18.ts`, `replay-silent-boom-2026-05-{18,20}.ts`, `-06-10.ts` | Call `fetchTickerFlowSeries` for one past day | Only if run after that day's history load | Get the new series; one-off scripts, not edited |
| `scripts/analyze-*`, `_probe-*`, other Python research | Read stored columns | Inherit stored values | None |

## 5. What else was filled from the doubled series

Found by grepping every reader of `cum_ncp_at_fire` / `cum_npp_at_fire` and every caller of the series builders.

Written from a post-close series (candidates for doubled values):

1. `scripts/backfill-ticker-flow-at-fire.mjs`: `cum_ncp_at_fire`, `cum_npp_at_fire` on `lottery_finder_fires` and `silent_boom_alerts`. On 2026-11-15 it filled 2,032 lottery and 127 silent-boom rows for 10-29 to 11-13. An earlier run on a WS-era date (2026-05-04 on) would also be doubled; the correction's `--since` reaches back to 2026-05-04 for that reason.
2. The replay scripts above, if one was run after its day's history load. Their INSERTs also wrote `score`, `direction_gated` and the Take-It columns from the same flow value.

Derived from the stored flow columns, so wrong exactly when the alignment (`isAlignedFire`: call fire needs `cum_ncp > cum_npp`, put fire the reverse) differs between the doubled and the true value. Doubling both columns keeps their order, so a flip needs the two cumulative values to be within about one minute of flow of each other. The 15 sampled rows had no flip; the 1,117 repaired rows left unscored were not sampled.

| Derived data | Depends on flow through | Handled in Phase A? |
| --- | --- | --- |
| `lottery_finder_fires.score` and `score_version` (V2) | alignment only | Yes, by the correction (section 6) |
| `lottery_finder_fires.combined_score` | generated from `score` | Follows `score` |
| `lottery_finder_fires.cluster_bonus` | counts co-firing tier-1 tickers by `score` | No. Flagged: a flip changes a neighbour's count. `scripts/backfill-lottery-cluster-bonus.py` is the owner's decision after the correction |
| `lottery_finder_fires.takeit_prob`, `takeit_top_features`, `takeit_model_version` | the Take-It input score uses `isAlignedFire` (`takeit-backfill-mapper.ts`) | No. Flagged: only rows whose alignment flips are stale, and the correction lists their ids |
| `silent_boom_alerts` columns | none: the detector stores the flow for display only | Nothing to derive |
| Feed and chart display, the `is_aligned` views (#167/#168 era) | read the stored columns at query time | Fixed by the corrected columns |
| ML refits reading `cum_ncp_at_fire` (`ml/src/lottery_scoring.py`, `lottery_weights.py`) | alignment | A refit that ran on doubled rows saw the same alignment except on flips; the flip count bounds the effect |

Only `cum_ncp_at_fire`, `cum_npp_at_fire` and, through them, the lottery V2 `score` / `score_version` are corrected in Phase A. Everything else above is reported, not changed.

## 6. The correction script (Phase A)

`scripts/correct-doubled-fire-flow.ts`, logic in `scripts/_lib/fire-flow-correction.ts`. Run from the repo root with `npx tsx`. Not run against production by the build.

```
npx tsx scripts/correct-doubled-fire-flow.ts --since 2026-10-29             # dry run (default)
npx tsx scripts/correct-doubled-fire-flow.ts --since 2026-10-29 --apply     # writes
npx tsx scripts/correct-doubled-fire-flow.ts --undo-file <file> [--apply]   # undo a run
```

### Which rows

`lottery_finder_fires` and `silent_boom_alerts`, `date >= --since`, both flow columns set. For each ticker-day the script reads:

- the FIXED value at each fire: `fetchTickerFlowSeries` then `flowAtFireTime` (the library, so the rule has one home);
- the DOUBLED candidates at each fire, from one aggregated query per ticker-day: the legacy union (WS first, `DISTINCT ON (ts)`, exactly what the old code stored) and WS sum plus history sum;
- whether the ticker-day has any WS row.

Each row falls in exactly one category:

| Category | Test | Action |
| --- | --- | --- |
| correct | both stored columns equal the fixed value within the tolerance | none (this includes every live-written value) |
| doubled | the ticker-day has WS rows, both stored columns equal one doubled candidate within the tolerance, and they do not equal the fixed value | correct to the fixed value |
| other mismatch | everything else: a history-only day (look-ahead only), a value that matches neither, a fixed series with no value at the fire | none; listed with the reason, the stored value and the fixed value |

Rows with NULL flow are not selected (the backfill's job) and are counted separately. The report counts each category per table and per date.

### Scores (lottery only)

The V2 score depends on flow only through alignment. For a corrected row:

- alignment unchanged: `score` and `score_version` are left alone;
- aligned before, not after: `score` becomes NULL, as live scoring gives. `score_version` is left as it was (the undo file records it);
- not aligned before, aligned after: the score is computed with `scoreLotteryV2` and the active weights from `loadLotteryWeights()`, through `rescoreRow` from `lottery-v2-rescore.ts`, and written with `score_version = active.version`. A fire from before 2026-09-08 (`SEED_WEIGHTS_LIVE_FROM`) is not re-scored: its flow is corrected, its score left, and it is listed, because an earlier fire was scored with older weights and re-scoring it would change its meaning;
- the loader returning its seed fallback stops the run before anything is written, as in `lottery-v2-rescore.ts`.

### Safety

- `--dry-run` is the default and writes nothing. `--apply` writes.
- `--since` is required and must be on or after 2026-05-04, the first day `ws_net_flow_per_ticker` has rows; nothing earlier can be doubled.
- Planning reads everything first. With `--apply`, an undo file is written before the first UPDATE: for every changed row, the id, the table, the old and new `cum_ncp_at_fire`, `cum_npp_at_fire`, `score` and `score_version`. Directory: `docs/tmp/fire-flow-correction/` (gitignored).
- Writes are batches of 500 rows through `unnest` (R5). Each UPDATE is guarded on the values the plan was read on (flow columns, score, score_version), so a row any other writer changed in between is skipped, and a rerun finds nothing left (R6). A write that sets a new `score_version` also requires the `active` pointer to still name it.
- `--undo-file` restores the old values, guarded on the row still holding the values this run wrote.
- The ticker-days are read three at a time, each read bounded by the same `ctSessionBounds` window as the detectors.

### The dry-run SQL

Per date in scope (`candidateDates`, newest first): the day's fires with stored flow (`loadDay`: both tables, `date = $1 AND cum_ncp_at_fire IS NOT NULL`, exact text for the stored values), then for each ticker-day two reads:

1. `fetchTickerFlowSeries(sql, ticker, date)`: the library series (section 2).
2. `readLegacyAtFires`, one aggregated statement returning one row per fire: `has_ws`, and the cumulative WS-only, history-only and legacy-union flow at that fire, computed over three materialised CTEs (`ws`, `hist` deduped on `ts`, and `legacy` = `DISTINCT ON (ts)` over both with WS first), all bounded by `ctSessionBounds(date)`.

Nothing is written. The report adds a count of the rows with NULL flow in scope (`countNullFlow`).

The apply is one statement per table per 500 rows (`moveRows`), shown here for lottery; silent boom is the same without the score columns:

```sql
UPDATE lottery_finder_fires AS f
SET cum_ncp_at_fire = u.to_ncp, cum_npp_at_fire = u.to_npp,
    score = u.to_score, score_version = u.to_version
FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::int[], $5::text[],
            $6::numeric[], $7::numeric[], $8::int[], $9::text[])
  AS u(id, from_ncp, from_npp, from_score, from_version,
       to_ncp, to_npp, to_score, to_version)
WHERE f.id = u.id
  AND f.cum_ncp_at_fire = u.from_ncp AND f.cum_npp_at_fire = u.from_npp
  AND f.score IS NOT DISTINCT FROM u.from_score
  AND f.score_version IS NOT DISTINCT FROM u.from_version
  AND (NOT $10::boolean                      -- true on apply, false on undo
       OR u.to_version IS NOT DISTINCT FROM u.from_version
       OR EXISTS (SELECT 1 FROM lottery_score_pointers p
                  WHERE p.name = 'active' AND p.version = u.to_version))
RETURNING f.id
```

### Cost (estimate)

About 100 ticker-days a day with fires, times two reads per ticker-day (a series read, and the aggregated read), each 1 to 7 s cold. Twelve trading days (10-29 to 11-13) is on the order of 20 to 40 minutes at concurrency 3. Run it after the close and outside 07:15 to 12:30 UTC.

## 7. Data dependencies

- No new table, column or migration in Phase A. No new env var.
- Reads: `ws_net_flow_per_ticker`, `net_flow_per_ticker_history`, `lottery_finder_fires`, `silent_boom_alerts`, `lottery_score_pointers` / `lottery_score_versions` (the weights store, migration #208).
- Writes (the correction and the backfill, run by the owner): `cum_ncp_at_fire`, `cum_npp_at_fire` on both fire tables; `score`, `score_version` on `lottery_finder_fires`.
- Deploy: `api/` changes redeploy Vercel; the chart readers and the detectors pick up the rule on that deploy. `scripts/` changes do not deploy.

## 8. Open questions (defaults in bold)

1. Run the correction from 2026-10-29 only, or from 2026-05-04? **From 2026-10-29 first**; then a dry run from 2026-05-04 to count how many WS-era rows older backfills and replays touched.
2. A day where the WS stream covers only part of the session: WS-only (what a live run stores), or WS plus history for the gap? **WS-only.** A hybrid needs a boundary rule and is a methodology change.
3. Take-It columns and `cluster_bonus` for rows whose alignment flips. **Report the ids, change nothing**; the owner decides on a Take-It refill and the cluster-bonus backfill after reading the flip count.
4. Rows the correction leaves as "other mismatch": history-only days still hold up to 59 s of look-ahead. **Leave and list.** Correcting them is a second pass with its own undo file.
5. `periscope-lottery-finder.ts` reads history up to the fire minute. **Flagged, not changed** (history-only, not doubled; a separate point-in-time fix).
6. Phase B host: **the two enrich crons** (findings section 2). Say so if the owner prefers an isolated cron.
7. Phase C covering-index width: **all four columns**, so `ts_idx` can go.

## 9. Thresholds and constants

| Constant | Value | Where | Why |
| --- | --- | --- | --- |
| History look-ahead guard | 60 s | `ticker-flow-snapshot.ts`, the chart readers | one history row is one whole minute |
| Flow match tolerance | 0.005 (USD, half a cent) | `fire-flow-correction.ts` | the premiums are cent-precision NUMERIC sums: the same series reads back exactly, and two different series differ by a whole cent or more |
| Earliest `--since` | 2026-05-04 | `fire-flow-correction.ts` | first day with WS rows |
| Earliest score re-scoring | 2026-09-08 | `SEED_WEIGHTS_LIVE_FROM` in `lottery-v2-rescore.ts` | seed weights live from that day |
| Rows per UPDATE | 500 | `fire-flow-correction.ts` | R5 |
| Page size, ticker-day concurrency | 5,000 rows, 3 | `fire-flow-correction.ts` | bounded memory; as many reads as the detectors run at once |
| Rows listed under "other mismatch" | 200, `--list-limit` | `fire-flow-correction.ts` | the full list stays readable; the count is always exact |
