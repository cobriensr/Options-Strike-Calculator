# Lottery + Silent-Boom feed perf regression fix

**Date:** 2026-05-17
**Status:** In progress

## Problem

Lottery Finder and Silent Boom feeds take ~30s to load any page (initial + pagination).

### Root cause

Commits `26b13630` (lottery) and `426c1e91` (silent-boom) added a `LEFT JOIN LATERAL` to every sort branch (3 in lottery, 4 in silent-boom — 7 total) that runs a per-row 2-table UNION + `DISTINCT ON (ts)` + `SUM(net_call_prem), SUM(net_put_prem)` aggregation over `ws_net_flow_per_ticker UNION net_flow_per_ticker_history`. With `limit=50-100` rows per page, that fans out to 50-100 sub-aggregations per request, each scanning ~8.5h of tick data per ticker. The range bound `ts >= f.date::timestamptz` is also 4-6h wider than necessary (uses UTC midnight instead of `ctSessionBounds(date).min`).

Commit `4fc7ec99` separately changed the lottery score-sort `ORDER BY` from index-served `f.score DESC` to a computed expression `COALESCE(f.score, 0) + COALESCE(f.round_trip_score_deduct, 0)`, losing the `(date, score DESC)` index path on early-LIMIT termination.

## Fix — snapshot-at-detect, mirroring `range_pos_at_trigger`

### Migration #158 — snapshot columns

```sql
ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS cum_ncp_at_fire NUMERIC,
  ADD COLUMN IF NOT EXISTS cum_npp_at_fire NUMERIC;
ALTER TABLE silent_boom_alerts
  ADD COLUMN IF NOT EXISTS cum_ncp_at_fire NUMERIC,
  ADD COLUMN IF NOT EXISTS cum_npp_at_fire NUMERIC;
```

Nullable so legacy rows + WS-daemon-down rows coexist with no constraint failures. The feed already tolerates `tnf.cum_ncp` / `tnf.cum_npp` as nullable.

### Migration #159 — generated `combined_score`

```sql
ALTER TABLE lottery_finder_fires
  ADD COLUMN IF NOT EXISTS combined_score INTEGER
  GENERATED ALWAYS AS (GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)) STORED;
ALTER TABLE silent_boom_alerts
  ADD COLUMN IF NOT EXISTS combined_score INTEGER
  GENERATED ALWAYS AS (GREATEST(0, COALESCE(score, 0) + round_trip_score_deduct)) STORED;

CREATE INDEX IF NOT EXISTS lottery_finder_fires_date_combined_idx
  ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS silent_boom_alerts_date_combined_idx
  ON silent_boom_alerts (date DESC, combined_score DESC NULLS LAST);
```

`GENERATED ALWAYS AS ... STORED` auto-populates existing rows during `ALTER TABLE`. `evaluate-round-trip` UPDATEs `round_trip_score_deduct` 60-75min post-fire — Postgres recomputes the STORED column on UPDATE, so the index stays consistent automatically.

### `api/_lib/ticker-flow-snapshot.ts` (new helper)

Pure function: takes `(db, ticker, date, fireTs)` → `{ cumNcp, cumNpp }`. Uses the same UNION/DISTINCT ON SQL as today's LATERAL but with `ctSessionBounds(date).min` for the lower bound. Called once per detected fire by both detect crons.

### Detect cron changes

`api/cron/detect-lottery-fires.ts` and `api/cron/detect-silent-boom.ts`: call `snapshotTickerFlowAtFire()` after the existing range-pos / tide enrichment, pass `cum_ncp_at_fire` and `cum_npp_at_fire` into the INSERT.

### Feed endpoint changes

Drop the entire `LEFT JOIN LATERAL ... tnf` block from all 3 lottery sort branches and all 4 silent-boom sort branches. Replace `tnf.cum_ncp, tnf.cum_npp` with `f.cum_ncp_at_fire, f.cum_npp_at_fire` (lottery) and `s.cum_ncp_at_fire, s.cum_npp_at_fire` (silent-boom). JS mapping unchanged.

Switch lottery score-sort `ORDER BY` to `f.combined_score DESC NULLS LAST` and drop the COALESCE expression entirely.

### Backfill — `scripts/backfill-ticker-flow-at-fire.mjs`

Mirrors `backfill-range-pos.mjs`:
1. Find distinct `(ticker, date)` pairs with `cum_ncp_at_fire IS NULL`
2. For each pair: pull the full ticker-day net-flow slice ONCE (bounded by `ctSessionBounds(date)`)
3. Walk in-memory cumulatively; binary-search each fire's `fire_ts` to get running totals
4. One batched UPDATE per `(ticker, date)` group via `jsonb_array_elements` pivot (same pattern as `backfill-range-pos.mjs`)
5. Idempotent on re-run (guard `WHERE cum_ncp_at_fire IS NULL`)
6. `--limit N` / `--ticker` / `--date` for surgical reruns

Tickers outside the WS universe (~50 tickers) will stay NULL — same behavior as today.

## Sequencing

One PR, executed in phases:

- **Phase 1:** Migrations #158, #159 + `db.test.ts` updates
- **Phase 2:** `snapshotTickerFlowAtFire` helper + wire into both detect crons
- **Phase 3:** Drop LATERAL from feed endpoints; switch score-sort to `combined_score`
- **Phase 4:** Backfill script

After Phase 1 ships migrations land on next deploy. Phase 2 starts populating new rows. Phase 3 reads the new column (NULL for legacy until backfill runs). Phase 4 backfills history.

## Expected impact

~30s → ~150-400ms (single indexed query against ~10K rows max/day, sorted by indexed column, zero per-row sub-aggregation).

## Separate fix in the same delivery — `evaluate-round-trip` batching

`api/cron/evaluate-round-trip.ts` currently runs **2 queries per row** (per-row aggregation SELECT + per-row UPDATE). Violates `feedback_batched_inserts.md`. Goes from `1 + 2N` to **4 queries flat** using the `unnest(...) + LATERAL` pattern already used in `fetch-net-flow-history.ts:149` and `path-shape.ts:110`.

Phase 5 in the same delivery, ~50 line rewrite.
