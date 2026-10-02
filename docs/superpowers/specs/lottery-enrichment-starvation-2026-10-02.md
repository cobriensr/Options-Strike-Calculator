# Lottery / Silent Boom outcome enrichment: starvation fix + shadow ticker-stats refit (2026-10-02)

## Goal

Make the lottery and silent-boom outcome crons enrich every fire they can
still read correctly, never stamp a fire "done" with empty outcomes, and
recompute `lottery_ticker_stats` inversion quality from live enrichment in
**shadow mode** until the owner promotes it.

## Findings (prod, read-only, 2026-10-02)

- `lottery_finder_fires`: 4-6K fires/day (peak 9.8K on 09-08), ~750 chains/day,
  up to 64 fires per chain. 190K+ fires unenriched since 06-24.
- The cron drained `ORDER BY inserted_at ASC LIMIT 300`. That is the oldest
  backlog, whose tape is gone, so every run stamped `enriched_at = NOW()` with all
  outcome columns NULL (21,900 fires from 06-17 to 06-24 are stamped this way).
  Fires since 06-25 were never reached.
- **Id-type bug (both crons, since dd2b68ff on 2026-06-12):** `id` is `bigint`, which
  the Neon driver returns as a string. The batched read unnests `${ids}::int[]`,
  so tick rows carry an `int4` (number) id. `Map.get(fire.id)` therefore always
  missed, so every fire looked tick-less and was stamped NULL.
  `silent_boom_alerts` shows this from 06-12 onward: every alert is stamped
  NULL the same evening even though its tape exists (80-2,945 ticks verified).
- The tape read had only a lower bound (`executed_at >= entry`), so a 1-3 DTE
  fire also read the following days.
- `cleanup-ws-option-trades` deletes in physical order, so old days are
  partially pruned. The oldest retained row is from 2026-06-18, which means an
  old fire can read a fragment of its tape.
- `entry_time_ct` is always itself a print. A complete tape therefore always has
  at least 1 tick, and **zero ticks means missing tape**, not "never traded".
- Tick volume: up to 40K prints per fire (TSLA 0DTE). That rules out pulling
  ticks into JS; the work has to be done by SQL aggregation.
- `option_intraday_nbbo_fetches` stops at 06-11 (no fire has had ticks since).
  Historical UW intraday cost is about 1.2 s per chain sequentially.

## Phase 1: lottery (commit 1)

- Candidates: `enriched_at IS NULL`, `trigger_time_ct >= NOW() - WS_OPTION_TRADES_RETENTION_DAYS`
  (plus a sargable ET `date` bound for `lottery_finder_fires_date_ts_idx`: 4.6 s → 13 ms),
  newest first, LIMIT 20,000.
- Tape window per fire: `[entry_time_ct, close + 15 min]` on the fire's ET
  date (`getMarketCloseHourET`; ETF options print until 16:15 ET).
- Settle gate: `close + 15 min + 5 min` ingest grace must have passed.
- Liveness, both per fire **ticker**:
  - Continuity: every 5-min bucket of the session after the entry must hold
    a print (0 empty in 13,026 probes on 09-29 to 10-01; ~70 ms per run). This
    catches a mid-session uw-stream or shard death that recovers before the
    close.
  - Close tail: a print in `[close - 10 min, close + 15 min]` (all 47 fire
    tickers and 38 silent-boom tickers passed this on 09-29 to 10-01).
  - Either check fails → `tapeGap`: not stamped, Sentry warning, status `error`.
  - Live ticker but no prints on the chain → `noPrints`: not stamped, Sentry
    warning, `partial`.
  - An unparseable or missing aggregate row → `unreadable` (a bug): not
    stamped, Sentry warning, `partial`.
  - Not detected: a gap shorter than 5 min, or a partial loss of a ticker's
    prints.
- One SQL statement per chunk computes every exit policy per fire:
  `api/_lib/option-outcome-aggregate.ts`. A window function handles the
  path-dependent trail. Chunks are **chain-grouped** (all of a chain's fires in
  one statement), so repeat scans hit shared buffers.
- Measured on 10-01 (4,400 fires, 6.17M tick visits): 45 × 100-fire chunks,
  109 s total, worst chunk 11.7 s, 0 errors.
- Flow inversion becomes its own pass: candidates are fires with
  `realized_flow_inversion_pct IS NULL` in a 4-day lookback, settled, newest
  first. Work is grouped by (chain, date) and runs through
  `mapWithConcurrency(3)`. Chains already cached as UW-`empty` are skipped
  after one batched lookup. Results are written every 500. A UW failure is
  rethrown by `fetchAndCacheOptionIntraday` (after its `error` tombstone),
  counted as a chain error and sent to Sentry, and the run returns `partial`.
- Wall budget: the tape pass starts no chunk after 150 s; the inversion pass
  starts no chain after 200 s; `maxDuration` stays at 300 s. A statement that
  exhausts withDbRetry (3 × 30 s) can still overrun, but each write is per
  chunk or per batch, so a kill loses only the in-flight one.
- Schedule `40 21,22,23 * * 1-5`: three post-close runs drain the tape pass
  (110-250 s/day) and the inversion pass (about 300 s/day of UW calls).
- Writes are conditional (`AND enriched_at IS NULL`,
  `AND realized_flow_inversion_pct IS NULL`) with `RETURNING`, so overlapping
  runs are idempotent.
- Pre-window backlog: left alone and not stamped. It is out of reach of
  ws_option_trades. `scripts/enrich_lottery_outcomes.py` (parquet) is the
  recovery path.

## Phase 2: silent boom (commit 2)

The same defects apply: the id-type bug, the missing upper bound, oldest-first
ordering, and stamping no-tick alerts. Apply the same fix using the shared
aggregate (entry = `bucket_ct`; r30/r60/r120 = last print at or before the
horizon, NULL when there is none).

## Phase 3: shadow refit (commit 3)

- `api/cron/refit-lottery-ticker-stats.ts`, `55 23 * * 1-5` (after the last
  enrichment slot). It reads only the DB and ports `refit_ticker_inversion_stats`
  (Wilson 95% LCB, floor N >= 10, blend 0.6 × 21d + 0.4 × 90d, rank quintiles).
- SHADOW: no write to `lottery_ticker_stats`. The output goes to a structured
  log line, a Sentry breadcrumb, and the cron metadata (Axiom), which records
  coverage and the diff against the frozen live stats. There is no migration.
- Promotion is the one-line `PROMOTE_TO_LIVE` constant in the cron. It is not
  an env var (R7).

## Thresholds / constants

| Constant                       | Value                    | Why                                                |
| ------------------------------ | ------------------------ | -------------------------------------------------- |
| Tape tail                      | 10 min before close      | Every fire ticker printed in it on 09-29 to 10-01  |
| Continuity bucket              | 5 min                    | 0 of 13,026 ticker buckets empty, 09-29 to 10-01   |
| Late-print allowance           | close + 15 min           | ETF options print until 16:15 ET                   |
| Settle grace                   | 5 min                    | uw-stream ingest lag                               |
| Read chunk                     | 100 fires, chain-grouped | Worst chunk 11.7 s, under the 30 s attempt timeout |
| Tape budget / inversion budget | 150 s / 200 s            | ~100 s left for in-flight work + prune             |
| Inversion lookback             | 4 days                   | Covers a Friday fire on Monday                     |
| Inversion concurrency          | 3                        | UW in-flight cap                                   |

## Open questions (defaults taken)

- Fires that hit `tapeGap`/`noPrints` stay unenriched and age out. The
  parquet script is the recovery path (default: no auto-stamp).
- Live-vs-parquet parity of `realized_flow_inversion_pct` (UW synthetic mid
  vs parquet NBBO mid) is unverified. That is why Phase 3 stays in shadow.
