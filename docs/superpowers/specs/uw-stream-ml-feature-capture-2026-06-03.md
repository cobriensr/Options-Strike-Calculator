# uw-stream full WS feature capture for ML (+ connection sharding) — 2026-06-03

## Goal

Record as much UW websocket data as possible for the 86-ticker alert universe
into an append-only **ML feature lake**, while restoring the channels broken by
UW's 50-channel/connection cap. Supersedes the two earlier specs:
`uw-50-channel-budget` (wrong cap model — per-account) and
`uw-stream-connection-sharding` (subsumed here as Phase 1).

## Decisions (locked with owner)
- **Cap is per-connection (50).** Keep all channels by sharding across sockets.
- **Storage:** parquet archive → R2/Blob (matches the Databento archive
  pattern). Hot-path families stay in Neon for detection/feed. ML-capture =
  raw JSONB + (channel, ticker, ts), **store-raw-parse-later** for max feature
  optionality.
- **Skip firehoses** `lit_trades` + `contract_screener` (revisit if a feature needs them).
- **GEX:** capture only `gex_strike_expiry` (finest); derive `gex_strike` /
  aggregate `gex` offline — no feature loss, −2 connections.

## Capture set (350 channels → ~8 connections @ ≤45)

| | channels | storage |
|---|---|---|
| `option_trades:<T>` ×86 | 86 | Neon `ws_option_trades` (hot, exists) + archive |
| `net_flow:<T>` ×86 | 86 | Neon `ws_net_flow_per_ticker` (hot, exists) + archive |
| `gex_strike_expiry:<T>` ×86 | 86 | Neon `ws_gex_strike_expiry` (hot, exists) + archive |
| `price:<T>` ×86 | 86 | archive only (new) |
| `flow-alerts`, `off_lit_trades` | 2 | Neon (hot, exist) + archive |
| `market_tide`, `news`, `interval_flow`, `trading_halts` | 4 | archive only (new) |

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

### ML capture (Phase 2)
- **Generic raw-capture handler** (`handlers/archive_capture.py`): for the
  archive channels, buffer `(channel, ticker, ts, raw_payload_json)`; flush by
  size OR time (both) to a parquet file via pyarrow; upload to R2 partitioned
  `ws_capture/<channel>/<YYYY-MM-DD>/<batch>.parquet`. Reuse the
  `upload-fulltape-to-r2.py` credential/pattern. Batched writes only (per WS
  skill — one-insert-per-message can't keep up).
- New channels (`price`, `market_tide`, `news`, `interval_flow`,
  `trading_halts`) route to this handler. Hot-path channels keep their typed
  Neon handlers; optionally tee their raw to the archive too (store-raw).
- Backpressure: bounded buffer; on overflow drop-oldest + increment a Sentry
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
- [ ] **Phase 2a:** parquet→R2 archive writer + generic `archive_capture`
  handler (batched, backpressure-safe). → Verify: a parquet lands in R2 with
  the expected (channel,ticker,ts,raw) schema.
- [ ] **Phase 2b:** add `price` (per-ticker) + `market_tide`/`news`/
  `interval_flow`/`trading_halts` (global) channels → archive handler; extend
  shards to ~8 conns. → Verify: each new channel's parquet partition populates
  during market hours.
- [ ] **Phase 3 (optional):** tee hot-path channels' raw payloads to the
  archive so the ML lake is complete (not just the new channels).
- [ ] **Phase Verification (LAST):** one full session captured; spot-check row
  counts per channel vs expected cadence; confirm Neon hot path unaffected.

## Files
- New: `uw-stream/src/handlers/archive_capture.py`, parquet/R2 writer util,
  new channel handlers (or route all-new through archive_capture),
  `uw-stream/tests/test_channel_shards.py`.
- Modified: `config.py` (shards + new channel set), `main.py` (N connectors),
  `connector.py` (shard id), `state.py`/`health.py` (per-conn), `channel_registry.py`,
  `router.py` (Sentry alert on `limit of 50 reached`).
- Unchanged: existing typed hot-path handlers + Neon schema.

## Open questions / risks
1. **Concurrent-connection limit (Phase 0)** — THE gating risk; bigger now at 8 sockets.
2. **R2/parquet from uw-stream** — confirm Railway env has R2 creds + pyarrow;
   decide volume-buffer vs direct-upload.
3. **interval_flow / market_tide / news payload shapes** — probe live before
   parsing (UW live drifts from docs); raw-capture sidesteps this for now.
4. **Retention** — archive is append-only; set an R2 lifecycle/retention policy.

## Constants
- `PER_CONN_MAX = 45`; ~8 connections for 350 channels; scales `ceil(N/45)`.
- Capture schema: `(channel TEXT, ticker TEXT, ts TIMESTAMPTZ, raw JSONB)` → parquet.
