# Lottery / Silent Boom flow repair and the flow-table indexes (2026-11-15)

Status: Phase A is built on branch `fix/flow-series-ws-first` (A0 to A5) and was revised twice after the 2026-11-15 production dry run (A6, 2026-11-16: the look-ahead category, the planned-writes list, the score-tag rules and the WS-gap report; A7, 2026-11-16: the look-ahead wording and its own WS-gap block, a session-bounded gap probe, and a moved pointer that left nothing unwritten ending as a success). The correction has not been applied to production: the owner runs it, dry run first. Phases B and C are designed here and not built.

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

Scope: A0 to A7, none over five files per commit.

| #   | Commit                                                                                                                                             | Files                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A0  | This spec                                                                                                                                          | `docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md`                                                                                                                                                                                                                                                                                                                                                   |
| A1  | The rule in `fetchTickerFlowSeries`; delete the unused `snapshotTickerFlowAtFire`                                                                  | `api/_lib/ticker-flow-snapshot.ts`, `api/__tests__/ticker-flow-snapshot-pglite.test.ts` (the existing mocked test needed no change)                                                                                                                                                                                                                                                                                      |
| A2  | The rule in the two chart readers                                                                                                                  | `api/net-flow-history.ts`, `api/ticker-net-flow-current.ts`, `api/__tests__/net-flow-series-pglite.test.ts` (the two existing mocked handler tests needed no change)                                                                                                                                                                                                                                                     |
| A3  | The backfill script calls the library                                                                                                              | `scripts/backfill-ticker-flow-at-fire.ts` (replaces the `.mjs`), `scripts/_lib/ticker-flow-backfill.ts`, its pglite and CLI tests, `scripts/_lib/fire-flow-test-helpers.ts` (fixtures shared with A4), `tsconfig.scripts.json`, and the three comment and README mentions of the old name. `tsconfig.scripts.json` is where A3 added the `include` lines for every script of A3, A4 and A5, so A4 and A5 do not touch it |
| A4  | The correction library                                                                                                                             | `scripts/_lib/fire-flow-correction.ts`, its unit and pglite tests, `scripts/_lib/lottery-v2-rescore.ts` (export `loadActive`)                                                                                                                                                                                                                                                                                            |
| A5  | The correction CLI                                                                                                                                 | `scripts/correct-doubled-fire-flow.ts`, its CLI test                                                                                                                                                                                                                                                                                                                                                                     |
| A6  | Fix round on the correction, after the 2026-11-15 production dry run (`docs/tmp/fire-flow-correction/dry-run-reconciliation-2026-11-15.md`, local) | `scripts/_lib/fire-flow-correction.ts` and its three test files, `scripts/correct-doubled-fire-flow.ts` (comment), `api/silent-boom-feed.ts` (a stale comment), this spec                                                                                                                                                                                                                                                |
| A7 | Second fix round on the correction, after its re-review | `scripts/_lib/fire-flow-correction.ts` and its three test files, `scripts/correct-doubled-fire-flow.ts` (comment), this spec |

A6 added, in the correction: the look-ahead category (section 6, "Which rows"); a list of every planned write in the dry run; the score tag the live detector would store for a row that is now against the flow (section 6, "Scores"); a pre-seed rule for that case; the WS-gap report (section 6, "WS gaps"); an exclusion of rows that equal the WS-only reading from "doubled"; an undo file that never overwrites; and the failure-mode tests (a moved pointer, a failed WS read, a short per-fire reading).

A7 changed, in the correction: the look-ahead rule is described as what it matches (the history minutes up to and including the fire's minute, section 6, "Which rows"), and the rule itself is unchanged; look-ahead rows get the WS-gap read too, reported in a block of their own (section 6, "WS gaps"); the gap probe of `ws_net_flow_per_ticker` carries the series' session bounds; a failed gap read has its own failure test; and a pointer that moved while every planned row was still written is a success with a note, not an error (section 6, "Safety").

The correction is NOT run by the build. The owner runs it, dry run first (section 6).

### Phase B: automatic post-close repair (not built)

An extra step in `enrich-lottery-outcomes` (slots 21:40, 22:40, 23:40 UTC) and `enrich-silent-boom-outcomes` (21:45, 23:45 UTC), both post-close, both DB-only, through one shared `api/_lib/fire-flow-repair.ts`. No new cron, no new Sentry monitor, no new Python.

Why this host (findings section 2): the day's NULL-flow gaps are fixed the same evening, 40 to 100 minutes after the close; it adds no market-hours load (a retry inside the detectors would land when the compute is saturated); the TypeScript scorer is reused; and the owner rules favour fewer crons and TypeScript outside `ml/`. A new isolated cron and a step in the Railway `nightly` service were the alternatives; the second needs a Python copy of the series SQL and the scorer.

What the step does:

1. `selectNullFlowGroups`: ticker-days with `cum_ncp_at_fire IS NULL`, bounded by date (the table is 1.8 GB and no index covers the predicate) and by `trigger_time_ct >= the 08:30 CT open` (pre-open fires can never be repaired and must not be re-selected forever). `silent_boom_alerts` uses `bucket_ct`.
2. One `fetchTickerFlowSeries` per group (the Phase A rule), `flowAtFireTime` per fire. A fire before that ticker's first WS tick, on a day with WS rows, gets no value from the series and never will: live stores NULL there, and the correction writes NULL for the ones an earlier backfill had filled with the history minutes up to the fire's minute (section 6, look-ahead). Such a fire stays NULL by design, so the step treats a null `flowAtFireTime` as "nothing to write", not as a failure.
3. A conditional, batched write: `UPDATE ... FROM unnest(ids, ncp, npp) WHERE cum_ncp_at_fire IS NULL`, 500 rows per statement (R5, R6).
4. For lottery rows just repaired, re-score with the active weights: the guard and tag rules of `scripts/_lib/lottery-v2-rescore.ts` (moved into `api/_lib`), stopping with nothing written if the loader returns its seed fallback.
5. Honest status (R4): a failed write makes the run `partial`; a residual after the day's last slot is one error-level Sentry message with a fixed fingerprint. The residual count EXCLUDES fires before the first WS tick of their ticker-day (step 2): they legitimately stay NULL, and counting them would raise the alarm every evening on the opening-second fires (the 10-29 to 11-13 backfill alone filled 72 of them with the history sum up to the fire's minute, which the correction turns back into NULL; all 72 sit in the session's first minute, 08:30:00 to 08:30:58 CT, so each held only that partial first minute). A residual is a fire the series HAS a value for and the write did not land, or a ticker-day whose series could not be read (error or deadline). The step's pglite test includes an opening-second fire and asserts it is not a residual.

Files (about 10, in phases of at most five): `api/_lib/fire-flow-repair.ts`, `api/_lib/lottery-flow-rescore.ts` (moved out of `scripts/_lib/lottery-v2-rescore.ts`), the two crons, their tests, a pglite test, and `scripts/_lib/ticker-flow-backfill.ts` shrinking to a wrapper. Size of the job: about 25 ticker-day groups a day on average, 60 to 70 on the worst day; a cold series read is 5.7 to 7.6 s today, so the step needs the Phase C index on a heavy day or a second slot.

### Phase C: indexes (not built; each needs the owner's OK)

All three are applied by hand with a direct connection outside 13:00 to 22:00 UTC on weekdays, with `CONCURRENTLY`, and then shipped as idempotent `IF NOT EXISTS` / `IF EXISTS` migrations, as #184 and #199 were. Apply by hand first, deploy the migration after: otherwise `migrateDb` would try a blocking `CREATE UNIQUE INDEX` over 96 million rows inside one HTTP transaction. The next free migration id is 210 (the latest on `main` is #209).

- **M1.** Covering unique index on `ws_net_flow_per_ticker (ticker, ts) INCLUDE (net_call_prem, net_put_prem, net_call_vol, net_put_vol)`, replacing `ws_net_flow_per_ticker_uq`, plus `autovacuum_vacuum_insert_scale_factor = 0.001` on the table. uw-stream's `ON CONFLICT (ticker, ts)` infers the new index. Measured planner cost of the index-only plan is 344 against 14,079 today. About +2.5 GB over `uq` while both exist.
- **M1b.** Drop `ws_net_flow_per_ticker_ts_idx` (2.2 GB) a week after M1, only if its `idx_scan` is flat.
- **M2.** `lottery_finder_fires (underlying_symbol, date) INCLUDE (peak_ceiling_pct) WHERE peak_ceiling_pct IS NOT NULL`, about 45 MB, for the Take-It win-rate load (44 to 60 s today).

The exact DDL and its measurements are in the findings, section 6.

## 4. Where the series is built (inventory, by code reading)

| Place                                                                                                      | What it does                                                                    | Doubled after the close?                                             | Phase A change                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `api/_lib/ticker-flow-snapshot.ts` `fetchTickerFlowSeries`                                                 | Series for the detectors, the replays, the backfill                             | Yes (UNION ALL, DISTINCT ON (ts))                                    | WS-first rule, history shifted by 60 s                                                                |
| `api/_lib/ticker-flow-snapshot.ts` `snapshotTickerFlowAtFire`                                              | Same UNION, one fire                                                            | Yes, but unused: no caller in `api/`, `src/`, `scripts/` or any test | Deleted                                                                                               |
| `api/net-flow-history.ts` (the per-fire Net Flow chart, 60 s poll)                                         | UNION ALL + DISTINCT ON (ts) + cumulative                                       | Yes, for any past day: the cumulative line is about 2x               | WS-first rule, history read only when `ts + 60 s <= now`                                              |
| `api/ticker-net-flow-current.ts` (Flow Match / Mismatch badges)                                            | UNION ALL + DISTINCT ON (ticker, ts), latest cumulative per ticker              | Yes, for any past day                                                | WS-first rule per ticker, same 60 s read rule                                                         |
| `scripts/backfill-ticker-flow-at-fire.mjs`                                                                 | Its own copy of the series SQL, hard 15:00 CT end                               | Yes: wrote 2,159 doubled rows on 2026-11-15                          | Replaced by a `.ts` script that calls `fetchTickerFlowSeries`                                         |
| `api/_lib/db-greek-heatmap.ts` `getGreekHeatmapNetFlow`                                                    | Today: WS only. Past dates: history only (`source = 'rest'`). One table per day | No                                                                   | None (it already chooses one table per day)                                                           |
| `api/_lib/periscope-lottery-finder.ts` `fetchQqqNetPremBalance30m`                                         | History only, 30-minute sum                                                     | No                                                                   | None. It does read minute rows up to the fire minute (look-ahead of up to 59 s); flagged, not changed |
| `scripts/enrich_lottery_outcomes.py`, `refine_spy_qqq_and_oos.py`, `ml/experiments/lottery-net-flow-eda/*` | History only, research and the nightly inversion pass                           | No                                                                   | None                                                                                                  |
| `api/cron/detect-lottery-fires.ts`, `detect-silent-boom.ts`                                                | Call `fetchTickerFlowSeries` live                                               | No (history for today is empty until 21:25 UTC)                      | None to the call sites; they get the new series                                                       |
| `scripts/replay-lottery-fires-2026-05-18.ts`, `replay-silent-boom-2026-05-{18,20}.ts`, `-06-10.ts`         | Call `fetchTickerFlowSeries` for one past day                                   | Only if run after that day's history load                            | Get the new series; one-off scripts, not edited                                                       |
| `scripts/analyze-*`, `_probe-*`, other Python research                                                     | Read stored columns                                                             | Inherit stored values                                                | None                                                                                                  |

## 5. What else was filled from the doubled series

Found by grepping every reader of `cum_ncp_at_fire` / `cum_npp_at_fire` and every caller of the series builders.

Written from a post-close series (candidates for doubled values):

1. `scripts/backfill-ticker-flow-at-fire.mjs`: `cum_ncp_at_fire`, `cum_npp_at_fire` on `lottery_finder_fires` and `silent_boom_alerts`. On 2026-11-15 it filled 2,032 lottery and 127 silent-boom rows for 10-29 to 11-13. An earlier run on a WS-era date (2026-05-04 on) would also be doubled; the correction's `--since` reaches back to 2026-05-04 for that reason.
2. The replay scripts above, if one was run after its day's history load. Their INSERTs also wrote `score`, `direction_gated` and the Take-It columns from the same flow value.

Derived from the stored flow columns, so wrong exactly when the alignment (`isAlignedFire`: call fire needs `cum_ncp > cum_npp`, put fire the reverse) differs between the doubled and the true value. Doubling both columns keeps their order, so a flip needs the two cumulative values to be within about one minute of flow of each other. The 15 sampled rows had no flip; the 1,117 repaired rows left unscored were not sampled.

| Derived data                                                                            | Depends on flow through                                                    | Handled in Phase A?                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `lottery_finder_fires.score` and `score_version` (V2)                                   | alignment only                                                             | Yes, by the correction (section 6)                                                                                                        |
| `lottery_finder_fires.combined_score`                                                   | generated from `score`                                                     | Follows `score`                                                                                                                           |
| `lottery_finder_fires.cluster_bonus`                                                    | counts co-firing tier-1 tickers by `score`                                 | No. Flagged: a flip changes a neighbour's count. `scripts/backfill-lottery-cluster-bonus.py` is the owner's decision after the correction |
| `lottery_finder_fires.takeit_prob`, `takeit_top_features`, `takeit_model_version`       | the Take-It input score uses `isAlignedFire` (`takeit-backfill-mapper.ts`) | No. Flagged: only rows whose alignment flips are stale, and the correction lists their ids                                                |
| `silent_boom_alerts` columns                                                            | none: the detector stores the flow for display only                        | Nothing to derive                                                                                                                         |
| Feed and chart display, the `is_aligned` views (#167/#168 era)                          | read the stored columns at query time                                      | Fixed by the corrected columns                                                                                                            |
| ML refits reading `cum_ncp_at_fire` (`ml/src/lottery_scoring.py`, `lottery_weights.py`) | alignment                                                                  | A refit that ran on doubled rows saw the same alignment except on flips; the flip count bounds the effect                                 |

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
- the DOUBLED candidates at each fire, from one aggregated query per ticker-day: the legacy union (WS first, `DISTINCT ON (ts)`, exactly what the old code stored), WS sum plus history sum, and the history sum alone (unshifted, `ts <= fire`, what the old backfill wrote before a ticker's first tick);
- whether the ticker-day has any WS row.

Each row falls in exactly one category:

| Category       | Test                                                                                                                                                                                                                                                                                    | Action                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| correct        | both stored columns equal the fixed value within the tolerance                                                                                                                                                                                                                          | none (this includes every live-written value)                              |
| doubled        | the ticker-day has WS rows, both stored columns equal one doubled candidate within the tolerance, and they equal neither the fixed value nor the WS-only reading (a value equal to the WS-only reading is what a run that saw ticks the fixed read had not holds, so it is not doubled) | correct to the fixed value                                                 |
| look-ahead     | the ticker-day has WS rows, the fixed series has NO value at the fire (the fire is before that ticker's first WS tick), and both stored columns equal the unshifted history sum with `ts <= fire` within the tolerance                                                                  | flow set to NULL (the value live stores there, and the fixed series gives) |
| other mismatch | everything else: a history-only day (look-ahead only), a value that matches neither, a fixed series with no value at the fire and a stored value that is not that history sum                                                                                                           | none; listed with the reason, the stored value and the fixed value         |

Rows with NULL flow are not selected (the backfill's job) and are counted separately; after an apply the look-ahead rows join that count, and a backfill run reads NULL for them again, so they stay NULL. The report counts each category per table and per date.

Look-ahead rows are the 72 `no-fixed-value` rows of the 2026-11-15 production dry run (reconciliation note, local): fires stamped 08:30:00 to 08:30:58 CT, in the session's first minute, before the ticker's first live tick. Live stores NULL there (`flowAtFireTime` on a WS-only series has no point at or before the fire). The old backfill wrote the history sum with `ts <= fire`: the history minutes up to and including the fire's minute, the last of them still open at the fire, so up to 59 s of flow after it. Only a fire in the session's first minute holds nothing but that partial minute (all 72 of the production rows); a later fire before its ticker's first tick would also hold complete minutes, and the rule matches those too, because live stored NULL for them as well. The rule is not narrowed to the opening minute; the WS-gap report below shows whether any such row exists. Those values are not doubled; they are wrong the other way. A stored value there that is not that history sum stays `other` / `no-fixed-value`. A history-only day has no WS rows, so the rule does not apply to it: it stays `other` (section 8, question 4).

### Scores (lottery only)

The V2 score depends on flow only through alignment (`isAlignedFire`: a call fire needs call premium over put premium, a put fire the reverse; no flow at all is not aligned). For a row the correction writes (doubled or look-ahead):

- alignment unchanged: `score` and `score_version` are left alone;
- aligned before, not after (a doubled row that is now against the flow, or any look-ahead row whose old flow was aligned): `score` becomes NULL and `score_version` becomes the ACTIVE version, as the live detector stores such a fire (`detect-lottery-fires.ts` scores a misaligned fire to NULL and always binds `active.version`). Under the active-pointer guard (below), like any write that changes the tag. A row whose score already was NULL changes nothing;
- the same for a fire before 2026-09-08 (`SEED_WEIGHTS_LIVE_FROM`): `score` becomes NULL, because NULL needs no weights, and `score_version` is LEFT as it was, because the fire was scored under older weights;
- not aligned before, aligned after: the score is computed with `scoreLotteryV2` and the active weights from `loadLotteryWeights()`, through `rescoreRow` from `lottery-v2-rescore.ts`, and written with `score_version = active.version`. A fire from before 2026-09-08 that is now with the flow is not re-scored: its flow is corrected, its score left (`left-pre-seed`), and it is counted, because an earlier fire was scored with older weights and re-scoring it would change its meaning;
- the loader returning its seed fallback stops the run before anything is written, as in `lottery-v2-rescore.ts`.

`silent_boom_alerts` carries no flow-derived score: only the two flow columns change.

### WS gaps (visibility only)

A day where the WS stream covers only part of the session is WS-only, so it undercounts the part the stream missed; a live run stored the same (section 2, known limit; section 8, question 2). Whether to fill such gaps from history is an open owner decision, and the correction does NOT change the corrected value for it. Instead the dry run shows how much it would matter. For each doubled lottery or silent-boom row:

- gap minutes: the history minutes with `ts + 60 s <= fire` (complete at the fire, the rule the series uses) whose call or put premium is nonzero and that have no WS tick in `[ts, ts + 60 s)`;
- gap flow: the sum of those minutes' call and put premium.

The report counts the doubled rows with at least one gap minute, the "material" ones (the gap flow exceeds 5% of the corrected flow on the call side or on the put side: `|gap ncp| > 0.05 |ncp|` or `|gap npp| > 0.05 |npp|`) and, for lottery, how many material rows would flip `isAlignedFire` if the gap flow were added. It lists the material rows (bounded by `--list-limit`): id, ticker, date, gap minutes, gap call and put, corrected call and put, and whether the alignment flips. It reads one extra query per ticker-day with a doubled or a look-ahead row (never one per fire). The probe of `ws_net_flow_per_ticker` is a `NOT EXISTS` on its `(ticker, ts)` unique index (`ws_net_flow_per_ticker_uq`; the redundant `ws_net_flow_per_ticker_ticker_ts_idx` was dropped by migration #199), and it carries the series' own `ctSessionBounds` window on `ts` besides the minute's window, so it reads only what the series reads and a tick after the session close hides no gap.

Look-ahead rows get the same reading, in a block of their own: their corrected flow is NULL, so there is nothing to be material against and no alignment to flip. A look-ahead fire is before its ticker's first WS tick, so no WS tick lies in any history minute complete before it, and every nonzero complete minute is flow the NULL leaves out. For each table the report prints the look-ahead rows read and how many of them hold at least one complete (`ts + 60 s <= fire`) nonzero history minute before the fire, always as a number (a zero is printed as 0), and lists those rows (bounded by `--list-limit`): id, ticker, date, fire time (UTC), gap minutes, gap call and put. On the production data the count is expected to be 0: all 72 look-ahead fires are inside 08:30:00 to 08:30:58 CT, before any minute is complete. A non-zero count is a look-ahead fire later in the session; it still goes to NULL, as live stored it, and the list shows what that costs.

### Planned writes (dry run)

The dry run lists every planned write, ordered by date, table and id, up to `--list-limit` (then `... N more not listed (--list-limit)`): table, id, fire date, ticker, fire time (UTC), category (`doubled` or `look-ahead`), old and new call and put premium and, for lottery, old and new score with its `score_version`. The totals stay exact past the cap.

### Safety

- `--dry-run` is the default and writes nothing. `--apply` writes.
- `--since` is required and must be on or after 2026-05-04, the first day `ws_net_flow_per_ticker` has rows; nothing earlier can be doubled.
- Planning reads everything first. With `--apply`, an undo file is written before the first UPDATE: for every changed row, the id, the table, the old and new `cum_ncp_at_fire`, `cum_npp_at_fire` (null in `new` for a look-ahead row), `score` and `score_version`. Directory: `docs/tmp/fire-flow-correction/` (gitignored). It is created with the `wx` flag and flushed, so a file that is already there is never overwritten (it is the only record of its run).
- Writes are batches of 500 rows through `unnest` (R5). Each UPDATE is guarded on the values the plan was read on (flow columns, score, score_version), with `IS NOT DISTINCT FROM`, so a NULL is a value and a flow moving to or from NULL is guarded in both directions. A row any other writer changed in between is skipped, and a rerun finds nothing left (R6). A write that sets a new `score_version` also requires the `active` pointer to still name it.
- If the pointer moved during the run and rows were left unwritten (written < planned), the run ends with an error (exit 1) that names both versions, the undo file and how many planned rows were written under the old one (per table), as `lottery-v2-rescore.ts` does. Rows that need the tag change are the ones not written. If the pointer moved but every planned row was written (the move came after the last statement that needed it, or no row needed it), the run succeeds (exit 0): the report carries a note that names both versions, says all planned rows were written, and that the rows which took a new `score_version` carry the old one, which the pointer no longer names. Nothing is claimed unwritten.
- `--undo-file` restores the old values, guarded on the row still holding the values this run wrote. A file that is not JSON is refused as `<file> is not valid JSON`, with the parse error as the cause.
- The ticker-days are read three at a time, each read bounded by the same `ctSessionBounds` window as the detectors.

### The dry-run SQL

Per date in scope (`candidateDates`, newest first): the day's fires with stored flow (`loadDay`: both tables, `date = $1 AND cum_ncp_at_fire IS NOT NULL`, exact text for the stored values), then for each ticker-day two reads, and a third when it has a doubled or a look-ahead row:

1. `fetchTickerFlowSeries(sql, ticker, date)`: the library series (section 2).
2. `readLegacyAtFires`, one aggregated statement returning one row per fire: `has_ws`, and the cumulative WS-only, history-only and legacy-union flow at that fire, computed over three materialised CTEs (`ws`, `hist` deduped on `ts`, and `legacy` = `DISTINCT ON (ts)` over both with WS first), all bounded by `ctSessionBounds(date)`.
3. Only for a ticker-day with a doubled or a look-ahead row: `readWsGaps`, one statement returning the history minutes that carry flow and have no WS tick in `[ts, ts + 60 s)` (a `NOT EXISTS` probe of `ws_net_flow_per_ticker` on its `(ticker, ts)` unique index, bounded by `ctSessionBounds(date)` like the series). The per-fire gap, for a doubled and for a look-ahead row, is cut from that list in memory.

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
  AND f.cum_ncp_at_fire IS NOT DISTINCT FROM u.from_ncp   -- NULL is a value:
  AND f.cum_npp_at_fire IS NOT DISTINCT FROM u.from_npp   -- look-ahead rows move to and from NULL
  AND f.score IS NOT DISTINCT FROM u.from_score
  AND f.score_version IS NOT DISTINCT FROM u.from_version
  AND (NOT $10::boolean                      -- true on apply, false on undo
       OR u.to_version IS NOT DISTINCT FROM u.from_version
       OR EXISTS (SELECT 1 FROM lottery_score_pointers p
                  WHERE p.name = 'active' AND p.version = u.to_version))
RETURNING f.id
```

### Cost (estimate)

About 100 ticker-days a day with fires, times two reads per ticker-day (a series read, and the aggregated read), each 1 to 7 s cold, plus the gap read for a ticker-day with a doubled or a look-ahead row (a history-table read with a session-bounded index probe of the WS table; not measured on production yet: the first dry run measures it. The 2026-10-29 onward dry run had 2,087 doubled rows). Twelve trading days (10-29 to 11-13) is on the order of 20 to 40 minutes at concurrency 3. Run it after the close and outside 07:15 to 12:30 UTC.

## 7. Data dependencies

- No new table, column or migration in Phase A. No new env var.
- Reads: `ws_net_flow_per_ticker`, `net_flow_per_ticker_history`, `lottery_finder_fires`, `silent_boom_alerts`, `lottery_score_pointers` / `lottery_score_versions` (the weights store, migration #208).
- Writes (the correction and the backfill, run by the owner): `cum_ncp_at_fire`, `cum_npp_at_fire` on both fire tables; `score`, `score_version` on `lottery_finder_fires`.
- Deploy: `api/` changes redeploy Vercel; the chart readers and the detectors pick up the rule on that deploy. `scripts/` changes do not deploy.

## 8. Open questions (defaults in bold)

1. Run the correction from 2026-10-29 only, or from 2026-05-04? **From 2026-10-29 first**; then a dry run from 2026-05-04 to count how many WS-era rows older backfills and replays touched.
2. Fill WS gaps from history? A day where the WS stream covers only part of the session is WS-only today (what a live run stores); the alternative is WS plus history for the gap. **WS-only. Owner decision pending.** A hybrid needs a boundary rule and is a methodology change. The dry run reports how much it would matter: the doubled rows with a gap, the material ones (gap flow over 5% of the corrected flow on either side) and the lottery rows whose alignment the gap flow would flip (section 6, "WS gaps"); the corrected value is not changed.
3. Take-It columns and `cluster_bonus` for rows whose alignment flips. **Report the ids, change nothing**; the owner decides on a Take-It refill and the cluster-bonus backfill after reading the flip count.
4. Rows the correction leaves as "other mismatch": history-only days still hold up to 59 s of look-ahead. **Leave and list.** Correcting them is a second pass with its own undo file.
5. `periscope-lottery-finder.ts` reads history up to the fire minute. **Flagged, not changed** (history-only, not doubled; a separate point-in-time fix).
6. Phase B host: **the two enrich crons** (findings section 2). Say so if the owner prefers an isolated cron.
7. Phase C covering-index width: **all four columns**, so `ts_idx` can go.

## 9. Thresholds and constants

| Constant                                                                    | Value                                 | Where                                                | Why                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| History look-ahead guard                                                    | 60 s                                  | `ticker-flow-snapshot.ts`, the chart readers         | one history row is one whole minute                                                                                                       |
| Flow match tolerance                                                        | 0.005 (USD, half a cent)              | `fire-flow-correction.ts`                            | the premiums are cent-precision NUMERIC sums: the same series reads back exactly, and two different series differ by a whole cent or more |
| Earliest `--since`                                                          | 2026-05-04                            | `fire-flow-correction.ts`                            | first day with WS rows                                                                                                                    |
| Earliest score re-scoring                                                   | 2026-09-08                            | `SEED_WEIGHTS_LIVE_FROM` in `lottery-v2-rescore.ts`  | seed weights live from that day                                                                                                           |
| Rows per UPDATE                                                             | 500                                   | `fire-flow-correction.ts`                            | R5                                                                                                                                        |
| Ticker-day concurrency                                                      | 3                                     | `fire-flow-correction.ts`                            | as many reads as the detectors run at once                                                                                                |
| Material WS gap                                                             | 5% of the corrected flow, either side | `MATERIAL_GAP_FRACTION` in `fire-flow-correction.ts` | a report threshold only: nothing is written from it                                                                                       |
| Rows listed under "planned writes", "material WS gaps" and "other mismatch" | 200 each, `--list-limit`              | `fire-flow-correction.ts`                            | each list stays readable; the counts are always exact                                                                                     |
