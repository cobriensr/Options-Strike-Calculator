---
status: Plan
date: 2026-10-02
---

# ws_option_trades retention + flow-regime slot persistence

**Date:** 2026-10-02
**Status:** Plan. Implementation follows on branch `fix/2026-10-02-flowregime`
**Related:** `ws-option-trades-retention-2026-05-16.md`,
`flow-regime-baseline-refresh-2026-06-07.md`, Sentry issue "ES"

## Goal

Make the `ws_option_trades` retention sweep actually keep pace, and make it
loud when it does not. Make the flow-regime baseline accumulate by persisting
each 30-min slot when it closes, instead of running one full-day aggregate
that times out every weekday. The two are linked: the oversized table makes
the full-day aggregate slow, and the failing aggregate means
`flow_regime_slot_daily` has never received a row.

## Measured state (read-only, prod, 2026-10-02 ~04:55 UTC)

### Table

| Measure                        | Value                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Rows (`reltuples`)             | 49,981,072                                                                                                                         |
| Heap                           | 63 GB (67.5e9 bytes) = 1,351 B/row                                                                                                 |
| Average row width (`pg_stats`) | 1,215 B, of which `raw_payload` is 1,103 B (no TOAST)                                                                              |
| Indexes                        | 18.7 GiB: chain_lookup 5.5 GB, chain_executed 5.3 GB, trade_id_uq 3.7 GB, ticker_executed 2.2 GB, executed_idx 1.3 GB, pkey 1.1 GB |
| Lifetime inserts / deletes     | 506.9M / 460.3M (`n_tup_upd` = 0: insert-only)                                                                                     |
| Oldest / newest `executed_at`  | 2026-06-18 18:39 UTC / 2026-10-01 20:59 UTC                                                                                        |
| `executed_at` correlation      | −0.149 (physical order is effectively random)                                                                                      |
| Reloptions                     | vacuum_scale_factor 0.01, analyze_scale_factor 0.005, thresholds 1000                                                              |
| Server                         | PG 17.11, work_mem 4 MB, shared_buffers 231 MB, maintenance_work_mem 64 MB, LFC 4.5 GB                                             |

**Correction to the scoping pass:** the heap is not "mostly reusable
bloat" today. At 1,215 B per row plus a 28 B header and line pointer, 50M
rows fill about 62 GB, so the heap is roughly 92% live tuples. Those tuples
are live but past retention. Bloat appears after the catch-up below: the
heap then holds at most three sessions (~27M rows, ~34 GB), leaving ~29 GB
of free space inside a 63 GB file.

### Intake and backlog

Planner estimates per ET session (`EXPLAIN` on `executed_idx` ranges):
09-29 7.92M, 09-30 8.53M, 10-01 9.17M. That is **~8.5M rows per weekday**,
not the 4–5M assumed earlier (≈ 42.6M per week).

Past the cutoff at measurement time (cutoff 09-30 00:00 ET): **32.1M rows**
(64% of the table). The histogram shows fragments left on 06-18, 06-25/26,
07-09, 09-11, 09-17/18 and 09-23/24. These are the partially pruned days
the unordered physical-order delete leaves behind.

### Delete rate

Vercel runtime logs (via the claude.ai Vercel connector; the `vercel` CLI
token is invalid and was not refreshed; logs older than ~1 day return
`ExceedsBillingLimitError`):

- 2026-10-01 12:05 UTC run: **7,300,000 rows in 146 batches, 296.0 s,
  `stopReason: wall_budget`** → 2.03 s per 50k batch, **24.7k rows/s**.
  This is the old unordered path: its `SELECT id … LIMIT 50000` plans as a
  Seq Scan in physical order.

Ordered path (this plan), measured read-only:

- `SELECT ctid … WHERE executed_at < cutoff ORDER BY executed_at LIMIT 50000`
  → **Index Scan using `ws_option_trades_executed_idx`**, 1.44 s, ~28.6k–33k
  buffers (1.5–1.75 rows per heap page; even a fresh session is scattered,
  because free space from earlier deletes is reused in random order).
- `EXPLAIN` of the full DELETE statement → `InitPlan: Limit → Index Scan
using ws_option_trades_executed_idx` + `Tid Scan` (no pkey probes, no
  HashAggregate).
- Estimated batch: ~1.45 s select + ~1 s delete ≈ **2.5 s per 50k ≈ 20k
  rows/s ≈ 5.9M rows per 295 s run**. This is an estimate: a delete cannot
  be timed read-only. The cron now logs `rowsPerSec` on every run, so the
  first production runs give the real figure.

### Why the old schedule cannot keep up

The cutoff is `(ET today − 2 days) 00:00 ET`. Each session therefore expires
at ET midnight three calendar days later: Mon→Thu, Tue→Fri, Wed→Sat,
Thu→Sun, Fri→Mon. With a Mon–Fri `5 12 * * 1-5` sweep:

- Monday's single run inherits three sessions (Wed + Thu + Fri ≈ 26M rows)
  against a 7.3M-row budget.
- Weekly capacity is 5 × 7.3M = 36.5M rows against ~42.6M of intake, a
  structural deficit of ~6M rows per week.
- A budget stop logs only at info level, so nothing reaches Sentry.
- Without `ORDER BY`, each run deletes in physical order and leaves every
  day it touches partially pruned.

### Flow-regime daily cron (Sentry ES)

- 2026-10-01 21:55:40 UTC: `TransientDbError: db attempt timeout` after
  33.1 s (3 attempts × 10 s).
- `EXPLAIN` of the full-day `buildAggSlotStatement` → **Parallel Seq Scan
  on ws_option_trades** (cost ~9.7M). The non-sargable slot-bound predicates
  push the planner off the index, so it reads the whole 63 GB heap.
- The per-window statement (`buildAggWindowStatement`) for the heaviest slot
  (10-01 15:30–16:00 ET, 670k rows) → **Parallel Index Scan on
  `executed_idx`, 7.70 s cold** (113k buffer reads).
- The live cron's 25-min window on slot 12 (536,629 trades) completed in
  ~6 s of wall time.
- `flow_regime_slot_daily`: **0 rows ever**, `UNIQUE (date, slot)` present
  (migration 187). No new migration is needed; id 192 stays unused.
- `capture-flow-regime-daily` hardcodes `RETENTION_DAYS = 2`. Its lookback
  uses `now − 24h`, so on a Monday it names Sunday.

### Live cron timing and ingest lag

- Vercel invokes these crons **~40–50 s after the scheduled minute** (live
  cron request at 19:25:50 for the 19:25 tick, every tick on 10-01).
- `received_at − executed_at` over two bounded 1-minute windows on 10-01:
  p50 1.1–1.3 s, p99 2.75 s, p99.9 2.9–3.1 s, max 3.4 s. uw-stream then
  batches for up to `ws_batch_interval_ms` = 2,000 ms, so trades are
  committed less than ~6.5 s after execution.

## Phases

### Phase 1: cleanup cron keeps pace and is loud (≈ half a day)

1. **Oldest-first, index-ordered batches.** Each batch deletes
   `ctid = ANY(ARRAY(SELECT ctid … ORDER BY executed_at LIMIT 50000))`.
   - ctid instead of id: the table is insert-only (`n_tup_upd` = 0), and
     ctids are read and deleted in one statement under one snapshot, so a
     selected tuple can neither move nor have its slot reused before the
     DELETE reaches it. This saves 50k pkey probes and a HashAggregate per
     batch.
   - The batch returns `count(*)`, `max(executed_at)` (the deletion
     frontier) and the cutoff, never the 50k ids.
2. **Loop control.**
   - A batch that deletes fewer than 50k rows means the table is drained.
     That saves the extra empty batch the old loop needed.
   - The wall budget is checked before each batch using the slowest batch
     so far, so the final batch cannot run past `maxDuration`.
3. **Backlog signal.** On a budget stop with a full last batch:
   - A `logger.warn` line carries the planner's estimate of expired rows
     remaining (`EXPLAIN (FORMAT JSON)` row count, cheap) and the frontier
     lag behind the cutoff.
   - **A fingerprinted Sentry warning fires when that lag is more than 24 h**
     (fingerprint `['cleanup-ws-option-trades', 'backlog']`), i.e. more than
     one session of expired rows is still outstanding.
   - The first post-midnight run of a normal ~9M-row session stops on the
     budget with a lag of about 10–14 h and is expected to drain on the next
     hourly run. Alerting on that would page every morning. See the open
     questions below.
4. **Cadence.** `5 0-12,22-23 * * *`: hourly at :05 from 22:05 through
   12:05 UTC, every day including weekends, and never in 13–21 UTC, where it
   would contend with uw-stream's market-hours inserts.
5. **Monitoring.** Add a `SCHEDULE_MAP` entry (`maxRuntime` 10,
   `failureIssueThreshold` 2) and wrap the handler in `withCronCheckin`. The
   cron was previously unmonitored.

**Cadence math.**

- Steady state: one session (≤ 9.2M rows) expires each ET midnight, Thu–Mon.
  The 8–9 runs between ET midnight (04:00 UTC EDT / 05:00 UTC EST) and
  12:05 UTC clear it in 2 runs at ~5.9M per run. Capacity is ~15 × 5.9M ≈
  88M rows per day against ≤ 9.2M arriving.
- Catch-up: ~32M expired at measurement time, ~25M after today's last
  old-schedule run, plus 8.5M when 09-30 expires at 10-03 00:00 ET. That is
  5–6 runs, so the first overnight window after deploy clears it.
- At 15k rows/s, the pessimistic case, a run deletes 4.4M rows and the
  catch-up takes 7–8 runs: still the first night.

**Read-horizon impact:** no rule change. The cutoff expression is unchanged
(calendar-day `WS_OPTION_TRADES_RETENTION_DAYS`). Rows are now removed
promptly after they expire instead of lingering until the next weekday
12:05 UTC run. No reader needs more than 2 days. The longest are
enrich-periscope (≈ 48h, already bounded by the same constant) and
evaluate-round-trip (≈ 24h).

One visible difference: `api/lottery-contract-tape.ts` reads a fire's
tape with no retention handling. Wednesday's fires now show an empty tape
from Saturday ~04:00–06:00 UTC, and Thursday's from Sunday. Before, both
lingered until Monday 12:05 UTC. This is the same 2-day rule, enforced on
time, not a bug.

**Each batch starts at the previous batch's frontier** (`executed_at >=
COALESCE($2, '-infinity')`, which EXPLAIN folds into the same
`executed_idx` Index Cond). Without it, batch k re-walks every index entry
the run already deleted, which is the classic delete-from-the-front-of-a-queue
cost.

### Phase 2: flow-regime slot persistence (≈ 1 day)

1. **Shared module** `api/_lib/flow-regime-slot-daily.ts`:
   - Slot window `[slotStart, slotEnd)` as UTC ISO (DST-safe via
     `etWallClockToUtcIso`).
   - `SLOT_SETTLE_MS` settle guard.
   - Retention guard based on the shared `WS_OPTION_TRADES_RETENTION_DAYS`.
   - `previousWeekdayEt`.
   - `readPersistedSlots(date)`.
   - `finalizeSlot(date, slot)`: runs the existing
     `buildAggWindowStatement` over the full slot window, applies the
     `MIN_DAY_SLOT_TRADES` quorum, then upserts with
     `ON CONFLICT (date, slot) DO UPDATE`, a key derived from the source data
     (R6).
2. **Live cron (`capture-flow-regime`).** After its own snapshot upsert, the
   cron finalizes slot − 1 if that slot is settled and not yet persisted.
   - The settle margin is **5 min**, so on the normal path finalize happens on
     the second tick of the next slot (Vercel fires ~45 s after the minute).
     This deviates on purpose from "first tick". `received_at` is the DB's
     insert-time `NOW()`, and its lag behind execution is p99.9 ≈ 3.1 s on a
     quiet day. During a Neon stall, though, uw-stream's flush retries
     (command_timeout 30 s × 3) can commit trades ~90 s late. A finalized
     slot is never re-aggregated, so an early finalize would stay short for
     good. The later finalize costs nothing, because the loader reads only
     dates before today.
   - A thin slot (below quorum) is not persisted, matching the existing #1a
     policy.
   - A failed aggregation or upsert writes nothing, is sent to Sentry, and
     returns `status: 'partial'`, never `success`.
   - The next tick in the slot retries, because the existence check is the
     marker.
3. **Daily cron (`capture-flow-regime-daily`).**
   - For today and the previous weekday, it reads the persisted slots and
     fills only the missing, settled ones, one bounded per-window statement
     at a time (normally only slot 12, which the live cron cannot reach
     because its 16:00 tick is outside RTH).
   - Each slot is written as soon as it is computed, so progress survives a
     later failure.
   - A per-slot failure is logged and the run ends `partial`/`error`, with
     one Sentry event naming the failed slots.
   - It imports `WS_OPTION_TRADES_RETENTION_DAYS` instead of hardcoding 2.
   - Per-attempt timeout is 30 s (≈ 4× the 7.7 s cold measurement), with a
     120 s wall budget checked before each slot.
   - Thin slots are never persisted, so this run re-reads them all. A thin
     slot inside today's regular session is an ingest gap (uw-stream down),
     so it raises one fingerprinted Sentry warning per run. Holiday slots and
     slots after a half-day's 13:00 close stay silent.
4. **Monday lookback.** The prior date is now the previous weekday, so
   Monday names Friday instead of Sunday. Under 2-calendar-day retention
   Friday's tape is purged at Monday 00:00 ET, so the retention guard
   **skips Friday on Monday** rather than aggregating a partially pruned
   window. Tue–Fri lookbacks are inside retention and work. Friday's final
   slot therefore has no second chance (see the open questions).
5. **Loader.** `loadFlowRegimeBaseline` reads `date < ET today`.
   - Intraday finalized slots for today must not enter the distribution that
     today's live slots are scored against.
   - A cold instance would otherwise see a different day set than a warm one.
   - This keeps the prior "yesterday and earlier" semantics exactly.
   - The committed-JSON fallback is unchanged: a slot below 15 days, or an
     empty table, falls back per slot.
6. Remove `buildAggSlotStatement` / `runAggSlot` /
   `aggregateFlowWindowBySlot`, which no production caller uses after step 3.
   The pglite oracle now checks the per-window statement slot by slot, and it
   checks the loader against real persisted rows.

## Files

**Phase 1:**

- `api/cron/cleanup-ws-option-trades.ts`
- `api/__tests__/cleanup-ws-option-trades.test.ts`
- `api/_lib/cron-schedules.ts`
- `vercel.json`

**Phase 2:**

- `api/_lib/flow-regime-slot-daily.ts` (new)
- `api/__tests__/flow-regime-slot-daily.test.ts` (new, unit + pglite)
- `api/cron/capture-flow-regime.ts` + `api/__tests__/capture-flow-regime.test.ts`
- `api/cron/capture-flow-regime-daily.ts` + `api/__tests__/capture-flow-regime-daily.test.ts`
- `api/_lib/flow-regime-baseline-live.ts` + `api/__tests__/flow-regime-baseline-live.test.ts`
- `api/_lib/flow-regime-rows.ts` + `api/__tests__/flow-regime-sql-integration.test.ts`

## Data dependencies

- No new tables, migrations or env vars. Migration id 192 was reserved but is
  not needed: `flow_regime_slot_daily` already has `UNIQUE (date, slot)`
  (verified in prod `pg_constraint`).
- Reads `ws_option_trades` through `executed_idx` only.

## Thresholds and constants

| Constant                         | Value                | Why                                                            |
| -------------------------------- | -------------------- | -------------------------------------------------------------- |
| Cleanup `BATCH_SIZE`             | 50,000               | Unchanged; ~2.5 s per batch                                    |
| Cleanup `WALL_BUDGET_MS`         | 280,000              | Leaves room for the last batch + estimate + check-in in 300 s  |
| Cleanup backlog alert lag        | 24 h                 | > 1 session behind = not keeping pace                          |
| Cleanup schedule                 | `5 0-12,22-23 * * *` | 15 runs per day, off-hours only                                |
| `SLOT_SETTLE_MS`                 | 300,000              | Covers uw-stream's ~90 s retry path; free (loader skips today) |
| Slot aggregation attempt timeout | 30,000 ms            | ~4× the 7.7 s cold heaviest-slot measurement                   |
| Daily fill wall budget           | 120,000 ms           | 120 + 126 (fill) + 33 (read) + 10 (check-in) = 289 s < 300 s   |
| `MIN_DAY_SLOT_TRADES`            | 500                  | Unchanged                                                      |

## Deferred: partitioning `ws_option_trades` by day

Retention would become `DROP`/`DETACH PARTITION`: O(1), no dead tuples, no
vacuum, no bloat. It is deferred because it breaks three things that would
have to change together:

1. **uw-stream's writer.** `INSERT … ON CONFLICT (ws_trade_id)`
   (`uw-stream/src/handlers/option_trades.py`, `_CONFLICT_COLS`) needs a
   unique index on `ws_trade_id` alone. A unique index on a partitioned table
   must include the partition key (`executed_at`), so global dedup on
   `ws_trade_id` would be lost.
2. **The id-only primary key.** It has the same rule: the PK must become
   `(id, executed_at)`.
3. **Per-table reloptions** in `scripts/ops/neon-tune-autovac.py`. A
   partitioned parent cannot carry autovacuum storage parameters; they must
   be set on each partition when it is created.

It would also need a partition-maintenance cron and a one-time migration of
~27M+ rows. Revisit if the hourly sweep plus autovacuum cannot hold the
table near three sessions.

## Owner-side ops decision: reclaim heap bloat

Code cannot do this, and code must not run it.

After Phase 1's catch-up the heap stays at 63 GB with ~29 GB free inside it.
Plain (auto)vacuum makes that space reusable but does not return it to the
filesystem, so Neon storage stays billed for it. Reclaiming it is an
owner-run maintenance-window operation:

- **`pg_repack`**, if the extension is available on this Neon project. It is
  online, takes only a brief exclusive lock at swap, and needs free space
  about equal to the new table plus indexes (~45 GB).
- **`VACUUM FULL ws_option_trades`**. It takes an ACCESS EXCLUSIVE lock for
  its whole duration, which blocks uw-stream inserts, so it must run on a
  weekend.
- Either rebuilds the indexes too. Expect ~82 GB → ~45 GB at peak (three
  sessions).
- Run it only after the backlog has drained. Running it before would copy
  ~25M doomed rows.

During the catch-up night, autovacuum (trigger ≈ 500k dead tuples) will run
almost back to back. Each pass scans all six indexes (18.7 GiB). This is
expected, it happens off-hours, and it needs no action.

## Open questions (defaults chosen)

1. **Backlog alert gate.** The Sentry warning fires on a budget stop only
   when the lag is > 24 h; every budget stop logs at warn.
   _Default:_ gated. Alerting on every budget stop would fire on most
   mornings, because a ~9M-row session needs two runs. If measured
   `rowsPerSec` shows one run clears a session, the gate becomes moot.
2. **Friday's final slot.** If Friday's 21:55 UTC daily run fails, slot 12
   is lost: Monday's lookback is outside retention.
   _Default:_ accept. Options are a Saturday daily run (`55 21 * * 1-6`), or
   a trading-day-aware cleanup cutoff that keeps the previous session on
   Mondays. The cutoff change would also change enrich-periscope's Monday
   horizon.
3. **Thin slots** (below quorum) are not persisted, so they are
   re-aggregated on each remaining tick of the slot and by the daily run.
   _Default:_ keep. These windows are under 500 rows by definition, and
   persisting them would change the #1a policy. The daily run surfaces
   regular-session thin slots as an ingest-gap warning.
4. **Axiom ingest is failing** for these crons ("column limit of 257" on
   `reportCronRun`; seen on every capture-flow-regime tick on 10-01). This is
   pre-existing and out of scope. Sentry and Vercel logs remain the signal.
