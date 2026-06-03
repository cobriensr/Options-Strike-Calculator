# uw-stream full WS feature capture for ML (+ connection sharding) — 2026-06-03

## Goal

Record as much UW websocket data as possible for the 86-ticker alert universe
into an append-only **ML feature lake**, while restoring the channels broken by
UW's 50-channel/connection cap. Supersedes the two earlier specs:
`uw-50-channel-budget` (wrong cap model — per-account) and
`uw-stream-connection-sharding` (subsumed here as Phase 1).

## Decisions (locked with owner)
- **Cap is per-connection (50).** Keep all channels by sharding across sockets.
- **Storage — rolling 2-day Neon + parquet history (UPDATED 2026-06-03):**
  EVERY captured channel writes to Neon and stays for the **current trading day
  plus the prior day** (`KEEP_DAYS=2`; today and yesterday). A daily roll-off exports
  partitions older than that to parquet → R2/Blob, then drops them from Neon. So
  Neon = a rolling 2-day live window for ALL channels; R2 = full history. New
  ML channels persist as **raw JSONB + (channel, ticker, ts)** (store-raw,
  parse-later); hot-path families keep their typed columns. uw-stream itself
  only writes Neon (batched COPY, as today) — the cron owns parquet + R2.
- **Skip firehoses** `lit_trades` + `contract_screener` (revisit if a feature needs them).
- **GEX:** capture only `gex_strike_expiry` (finest); derive `gex_strike` /
  aggregate `gex` offline — no feature loss, −2 connections.

## Capture set (350 channels → ~8 connections @ ≤45)

All channels → Neon (rolling 2-day) then roll-off to R2 parquet. "hot" = typed
table already exists + feeds detection/feed; "new" = new raw-JSONB capture table.

| | channels | Neon table |
|---|---|---|
| `option_trades:<T>` ×86 | 86 | `ws_option_trades` (hot, typed, exists) |
| `net_flow:<T>` ×86 | 86 | `ws_net_flow_per_ticker` (hot, exists) |
| `gex_strike_expiry:<T>` ×86 | 86 | `ws_gex_strike_expiry` (hot, exists) |
| `flow-alerts`, `off_lit_trades` | 2 | hot, exist |
| `price:<T>` ×86 | 86 | new raw-JSONB capture table |
| `market_tide`, `news`, `interval_flow`, `trading_halts` | 4 | new raw-JSONB capture table(s) |

Connections = ceil(350 / 45) = **8**, family-contiguous + deterministic (see
sharding mechanism below).

## Architecture

### Sharding (Phase 1 — also the production fix for the current outage)
N `Connector` instances, each owns a ≤45-channel slice + its own socket +
reconnect loop, all producing into the shared router/queue (router dispatches by
channel name → shared handlers, unchanged). `config.channel_shards ->
list[list[str]]`, family-contiguous, ≤`PER_CONN_MAX=45`, globals folded in,
deterministic. Per-connection state/health; one socket dropping reconnects only
its slice. `main.py` runs the N connectors via `asyncio.gather` (250 ms start
stagger).

### ML capture (Phase 2) — Neon write, cron-driven roll-off

- **New-channel handler** (`handlers/raw_capture.py`): batched `asyncpg` COPY of
  `(channel, ticker, ts, raw_payload jsonb)` into the new capture table(s) —
  same batched-write discipline as the existing handlers (per WS skill, no
  per-message inserts). New channels (`price`, `market_tide`, `news`,
  `interval_flow`, `trading_halts`) route here. Hot-path channels keep their
  typed handlers. uw-stream writes ONLY Neon — no parquet/R2 in the stream path.
- **Daily partitioning:** capture tables (and ideally the existing ws_* tables
  — see caveat) are `PARTITION BY RANGE(ts)` with one partition per trading day,
  so roll-off is a cheap `DROP PARTITION`, not a 1.7M-row `DELETE`.
- **Roll-off cron** (`api/cron/archive-ws-capture.ts`, daily post-close): for
  each capture table, for every partition older than `KEEP_DAYS=2`: `COPY`/read
  the partition → write parquet → upload to R2 (`ws_capture/<channel>/<date>.parquet`,
  reuse the `upload-fulltape-to-r2.py` credential/pattern) → verify upload →
  `DROP` the partition. Idempotent (skip dates already in R2); CRON_SECRET-gated.
- Backpressure (ingest): bounded queue; on overflow drop-oldest + Sentry
  counter (never block the receive loop).

## Tasks
- [ ] **Phase 0 / GATING:** verify UW allows ~8 concurrent connections on one
  token. → Verify: open 8 test sockets, all ack joins, none get a connection
  error. **If UW caps concurrent connections below 8, this whole approach is
  capped — fall back to the per-account budget plan.**
- [ ] **Phase 1 (urgent, fixes live outage):** shard the CURRENT 3 families +
  2 globals across connections (≤45 each, ~6 conns); `channel_shards` +
  multi-Connector wiring + per-conn health + shard tests. → Verify:
  `ws_net_flow_per_ticker` + `ws_gex_strike_expiry` resume for all 86 tickers,
  zero "limit of 50 reached".
- [ ] **Phase 2a:** new raw-capture Neon table(s), `PARTITION BY RANGE(ts)`
  daily (migration) + `handlers/raw_capture.py` (batched asyncpg COPY). → Verify:
  rows land in today's partition during market hours.
- [ ] **Phase 2b:** add `price` (per-ticker) + `market_tide`/`news`/
  `interval_flow`/`trading_halts` (global) channels → raw_capture; extend shards
  to ~8 conns. → Verify: each new channel populates.
- [ ] **Phase 2c:** roll-off cron `api/cron/archive-ws-capture.ts` (daily
  post-close, CRON_SECRET): partitions older than `KEEP_DAYS=2` → parquet → R2 →
  verify → `DROP PARTITION`; idempotent. Register in vercel.json. → Verify: a
  D-2 partition lands in R2 and is dropped from Neon; D & D-1 remain.
- [ ] **Phase 3 (optional):** apply the same daily-partition + roll-off to the
  EXISTING ws_* hot tables so they ALSO honor the 2-day window — **only after
  auditing consumers** (see caveat) so we don't prune data a job reads.
- [ ] **Phase Verification (LAST):** one full session captured; spot-check row
  counts per channel vs expected cadence; confirm Neon hot path + detection
  unaffected; confirm D-2 roll-off + drop worked and parquet is readable.

## Files
- New: `uw-stream/src/handlers/raw_capture.py`; `api/cron/archive-ws-capture.ts`
  (roll-off); migration for partitioned capture table(s);
  `uw-stream/tests/test_channel_shards.py`; vercel.json cron entry.
- Modified: `config.py` (shards + new channel set), `main.py` (N connectors),
  `connector.py` (shard id), `state.py`/`health.py` (per-conn), `channel_registry.py`,
  `router.py` (Sentry alert on `limit of 50 reached`).
- Unchanged: existing typed hot-path handlers (until Phase 3).

## Open questions / risks
1. **Concurrent-connection limit (Phase 0)** — THE gating risk; bigger now at 8 sockets.
2. **`KEEP_DAYS=2` interpretation** — read as "today + yesterday in Neon, ≥2
   days old → R2." Confirm if you meant 3 (it's a one-constant change).
3. **Applying 2-day retention to EXISTING ws_* tables (Phase 3)** — they grow
   unbounded today (ws_option_trades ~1.7M/day). Before pruning, **audit what
   reads >2-day-old ws_* data** (research/backfill scripts) so the roll-off
   doesn't break them. The Makefile enrich path uses EOD parquet, not ws_* —
   but verify, don't assume.
4. **R2/parquet writer** — confirm R2 creds + pyarrow available to the roll-off
   cron's runtime (Vercel Fn vs a Railway/script runner).
5. **interval_flow / market_tide / news payload shapes** — probe live before
   parsing (UW live drifts from docs); raw-JSONB capture sidesteps this for now.

## Constants
- `PER_CONN_MAX = 45`; ~8 connections for 350 channels; scales `ceil(N/45)`.
- `KEEP_DAYS = 2` (Neon retention; today + yesterday).
- Capture schema: `(channel TEXT, ticker TEXT, ts TIMESTAMPTZ, raw JSONB)`,
  daily-partitioned by `ts`; rolled-off partitions → parquet on R2.
