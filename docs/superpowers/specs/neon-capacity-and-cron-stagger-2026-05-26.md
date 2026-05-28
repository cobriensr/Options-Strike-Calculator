# Neon capacity audit + cron stagger + ws_option_trades partitioning

**Date:** 2026-05-26
**Trigger:** Neon hit its 2 CU / 8 GB compute ceiling for 20 minutes (10:18–10:38 CT), OOM'd around 10:40, caused cascading failures:

- 308 events of `db attempt timeout` on `/api/greek-heatmap` ([SENTRY-EMERALD-DESERT-7J](https://no-org-jc.sentry.io/issues/SENTRY-EMERALD-DESERT-7J))
- 31 events of asyncpg `bind_execute` TimeoutError on uw-stream ([SENTRY-EMERALD-DESERT-8Y](https://no-org-jc.sentry.io/issues/SENTRY-EMERALD-DESERT-8Y))
- 1 `NeonDbError: out of memory` on `/api/zero-gamma` ([SENTRY-EMERALD-DESERT-CV](https://no-org-jc.sentry.io/issues/SENTRY-EMERALD-DESERT-CV))
- uw-stream stopped writing to `ws_option_trades` for ~1h35m (last write 10:17 CT until manual redeploy at 11:51 CT)

The OOM was a downstream symptom. The root cause is **structural undersizing**: workload outgrew the resources allocated months ago.

## Already done in this audit (2026-05-26 ~11:50 CT)

- Restarted `uw-stream` Railway service → option trades flowing again (most recent `executed_at` was 2s old after restart).
- `ANALYZE` on the 6 biggest tables that had **never** been autovacuumed: `ws_option_trades` (27 GB), `ws_net_flow_per_ticker` (4.9 GB), `strike_iv_snapshots` (4.8 GB), `futures_top_of_book` (3.1 GB), `futures_trade_ticks` (2.9 GB), `lottery_finder_fires` (1.8 GB). Planner now has real row-count estimates instead of `n_live_tup = 0`.
- `CREATE EXTENSION pg_stat_statements` — version 1.11. Going forward, query timing is queryable directly from Postgres.

## Open items (this spec covers)

1. **Neon plan bump** — dashboard action, user-only.
2. **Cron stagger** — vercel.json edit. Halves the every-minute Vercel-to-Neon stampede.
3. **`ws_option_trades` partitioning** — migration. Removes the 27 GB table as a maintenance hazard.
4. **uw-stream retry tuning** — Python code edit. Survives longer Neon hiccups without dropping batches.
5. **Recurring autovacuum policy** — Neon plan setting or migration.

---

## 1. Neon plan bump (user action — do today)

Current: Min 0.25 CU / 1 GB, Max 2 CU / 8 GB, autosuspend 5 min.
Recommended: Min 0.25 CU / 1 GB, **Max 4 CU / 16 GB**, autosuspend 5 min.

Rationale: today's RAM chart showed USED pinned at ~7 GB out of 8 GB allocated for 20 min before the OOM. With 4 CU max, the autoscaler has headroom to absorb the cron stampede + uw-stream writes without hitting the ceiling. Autoscaling means you only pay for what you use — off-hours stays cheap.

Click "Edit endpoint" in the Neon dashboard. No code change required.

## 2. Cron stagger (vercel.json edit — recommend Claude implement after review)

**Today:** 19 crons fire at `* 13-21 * * 1-5` — every minute during RTH. At minute boundary `:XX:00`, Vercel spawns 19 functions, all calling Neon simultaneously.

**Proposal:** Split into two groups firing on alternate minutes. Halves the per-minute stampede; data freshness goes from 1-min to 2-min for half the crons.

### Tier A — must stay every minute (signal timing matters)

- `detect-lottery-fires` — alert engine
- `detect-gamma-setups` — alert engine
- `check-cone-breach` — breach detection
- `monitor-vega-spike` — alert
- `monitor-flow-ratio` — alert
- `fetch-spot-gex` — dealer regime input
- `fetch-spx-candles-1m` — 1m bar data
- `fetch-etf-candles-1m` — 1m bar data
- `fetch-market-internals` — market internals
- `fetch-flow-alerts` — alert source

Keep schedule: `* 13-21 * * 1-5`

### Tier B — tolerable at 2-min cadence (slower-moving aggregates)

- `fetch-greek-flow-etf`
- `fetch-strike-iv`
- `fetch-strike-trade-volume`
- `fetch-gex-strike-expiry-etfs`
- `fetch-nope`
- `fetch-vol-0dte`
- `fetch-gex-0dte`
- `fetch-gexbot-fast` (already rate-limited upstream, 429s in Sentry)
- `fetch-gexbot-strikes` (same)

Change schedule: `1,3,5,7,...,57,59 13-21 * * 1-5` (odd minutes)

### Net effect

- Even minutes (`* 13-21`): 10 crons fire
- Odd minutes (`1,3,5...59 13-21`): 9 crons fire on top of the 10 fixed
- Wait — that's still 19 every odd minute. Need different split.

**Better split (truly alternating):**

- Tier A: `0,2,4,...,58 13-21` (even minutes) — 10 critical crons
- Tier B: `1,3,5,...,59 13-21` (odd minutes) — 9 slower crons

This means **every minute, only ONE tier fires** (10 or 9 crons). Peak concurrency drops from 19 to 10. Tier A still gets 1-min cadence on the even minutes. Tier B drops to 1-per-2-min.

**Tradeoff:** Tier A crons that were firing every minute now only fire every OTHER minute. That's a 50% reduction in frequency for the critical alerts.

That tradeoff might not be acceptable — for detect-lottery-fires especially, 1-min cadence is the design.

### Alternative: keep Tier A every minute, move only Tier B

- Tier A (10 crons): `* 13-21 * * 1-5` (unchanged)
- Tier B (9 crons): `1,3,5,...,59 13-21 * * 1-5` (odd minutes)

Effect:

- Even minutes: 10 crons fire (the Tier A only)
- Odd minutes: 10 + 9 = 19 crons fire (Tier A + Tier B)

That's only a 47% reduction on even minutes; odd minutes still see the full stampede. Less effective.

### Recommended: full alternation, accept 2-min cadence on Tier A

The data this codebase relies on per-minute is the candle data + the alert engines. **For the alert engines (detect-lottery-fires, detect-gamma-setups), a 2-min cadence delays signal detection by up to 60s in the worst case** — but the alert window (`SCAN_WINDOW_MIN = 7`) is wide enough that no signals are missed; they're just detected a minute later.

Open question for user review: is a worst-case 60s extra alert latency acceptable? If yes, full alternation halves the stampede. If no, find a different lever (combine multiple crons into a single handler that fans out internally).

## 3. `ws_option_trades` partitioning (migration — multi-step)

Current state:

- Single table, 27 GB, 3,461,712 rows
- 6 btree indexes totaling 6.3 GB
- Every query that scans `executed_at` traverses the global index
- No retention policy; size grows unbounded

Proposal:

- **Convert to native PostgreSQL declarative partitioning by `executed_at` (daily partitions).**
- Hot window: last 7 days as attached partitions, indexed normally.
- Cold window: partitions older than 7 days detached and stored separately (or dropped if not needed in DB — they're already in the Databento archive via the Railway sidecar).
- `pg_partman` is already in `shared_preload_libraries` on Neon, so partition management can be automated.

### Migration plan (4 phases, all reversible until cutover)

**Phase 1 — Create partitioned table alongside the existing one**

```sql
CREATE TABLE ws_option_trades_partitioned (
  LIKE ws_option_trades INCLUDING ALL
) PARTITION BY RANGE (executed_at);

-- Pre-create partitions for the next 7 days
SELECT partman.create_parent(
  p_parent_table => 'public.ws_option_trades_partitioned',
  p_control => 'executed_at',
  p_type => 'native',
  p_interval => 'daily',
  p_premake => 7
);
```

No effect on production yet — uw-stream still writes to the original table.

**Phase 2 — Backfill historical data**

```sql
INSERT INTO ws_option_trades_partitioned
SELECT * FROM ws_option_trades
WHERE executed_at >= NOW() - INTERVAL '30 days';
```

(May need to chunk by day to avoid one 27 GB transaction.)

**Phase 3 — Cutover**

```sql
BEGIN;
  ALTER TABLE ws_option_trades RENAME TO ws_option_trades_old;
  ALTER TABLE ws_option_trades_partitioned RENAME TO ws_option_trades;
COMMIT;
```

Run during a quiet window — uw-stream's next batch will land in the new partitioned table. uw-stream code doesn't need to change; partitioning is transparent to the application.

**Phase 4 — Cleanup**

After 24h of confirmed healthy operation:

```sql
DROP TABLE ws_option_trades_old;
```

### Risk

- The cutover transaction holds a write lock on the table briefly. uw-stream's next BEGIN would block — same failure mode as today's incident but for a controlled 1-5 second window. Schedule for off-hours (weekend or after 4 PM ET).
- The backfill on 30 days of data could itself OOM the Neon compute. Bump to 4 CU first (item 1) before running.

### Expected gain

- Queries with `executed_at >= NOW() - INTERVAL '7 min'` (detect-lottery-fires, detect-silent-boom, multileg-classify-batch) hit ONE small partition (~1 GB max) instead of scanning 27 GB.
- Drop oldest partition daily → bounded table size, no more autovacuum starvation.

## 4. uw-stream retry tuning

Current: 3 attempts with backoff (0.5, 1.5). Total ~2s of added latency before giving up.

During today's Neon OOM the compute was unresponsive for 3-4 minutes. uw-stream exhausted its retries quickly and **dropped 31 batches** (the 8Y Sentry events). Each dropped batch contained up to 500 rows — that's up to 15,500 option_trades rows lost during the window.

Proposal: bump retry budget to survive longer Neon hiccups.

```python
_DB_RETRY_MAX_ATTEMPTS = 6  # was 3
_DB_RETRY_BACKOFF_S: tuple[float, ...] = (0.5, 1.5, 3.0, 5.0, 10.0)  # was (0.5, 1.5)
```

Total worst-case wait: 20s. That covers the typical Neon scale-up/restart window without dropping batches. The handler's batch buffer accumulates rows during the wait; first successful retry flushes the backlog.

Risk: if the DB is genuinely down for >20s, longer retries mean longer hang time per attempt. With the buffer accumulating, a long outage could OOM the uw-stream process itself. Mitigation: cap the in-memory batch size in `handlers/base.py` — drop oldest if buffer exceeds say 50,000 rows.

## 5. Recurring autovacuum policy

Six of the biggest tables had `last_autovacuum = NULL` — they have never been touched by autovacuum since the database was created. Either:

- Neon's autovacuum is disabled / under-tuned for serverless workload
- Or the tables are insert-only with no DELETE/UPDATE pressure, so autovacuum's dead-tuple-fraction threshold never trips

Both are bad: even insert-only tables need ANALYZE to keep stats fresh, and the planner had been operating with `n_live_tup = 0` estimates.

Proposal: schedule a daily `ANALYZE` on the top 10 hot tables via `pg_cron` (already in `shared_preload_libraries`).

```sql
SELECT cron.schedule(
  'daily-analyze-hot-tables',
  '15 6 * * *',  -- 06:15 UTC = ~2 AM ET, off-hours
  $$
    ANALYZE ws_option_trades;
    ANALYZE ws_net_flow_per_ticker;
    ANALYZE strike_iv_snapshots;
    ANALYZE futures_top_of_book;
    ANALYZE futures_trade_ticks;
    ANALYZE lottery_finder_fires;
    ANALYZE ws_gex_strike_expiry;
    ANALYZE ws_flow_alerts;
    ANALYZE strike_exposures;
    ANALYZE periscope_snapshots;
  $$
);
```

ANALYZE is cheap (samples ~30,000 rows per table by default) and non-blocking. Daily refresh keeps planner stats accurate as data grows.

## Priority order

1. **Today, dashboard:** Bump Neon max compute to 4 CU. Item #1.
2. **Today, code:** Apply cron stagger from item #2 (after user review of the latency tradeoff).
3. **Today, code:** Apply uw-stream retry tuning from item #4 (small, safe).
4. **This week, code:** Set up the pg_cron daily ANALYZE from item #5.
5. **This week, planned:** Phase 1–3 of the partitioning migration from item #3 (off-hours window).

## Verification after each change

- After Neon bump: watch RAM/CPU peak — should stay below 60% of new ceiling during RTH.
- After cron stagger: count Vercel Function invocations per minute via `pg_stat_statements` — `SELECT calls FROM pg_stat_statements ORDER BY calls DESC LIMIT 20` — should show the load spread.
- After retry tuning: next Neon hiccup should show fewer dropped 8Y events.
- After partitioning: detect-lottery-fires query plan should show `Index Scan` on a single partition, not 6 GB index scan across whole table.
