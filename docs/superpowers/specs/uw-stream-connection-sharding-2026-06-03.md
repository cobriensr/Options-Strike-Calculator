# uw-stream connection sharding (50-channel/connection cap) — 2026-06-03

## Goal

Keep all 260 channels by spreading them across **multiple WS connections**,
each subscribed to ≤ ~45 channels (margin under UW's 50/connection cap), instead
of one socket trying to join 260. Supersedes `uw-50-channel-budget-2026-06-03.md`
(that was the per-ACCOUNT contingency; this is the per-CONNECTION reality).

## Gating prerequisite (confirm before building)

UW caps **channels per connection** at 50 — confirmed. **Open: does UW also cap
concurrent connections per account/token?** Sharding needs ~6 simultaneous
sockets on one `UW_API_KEY`. If there's a low concurrent-connection limit, this
breaks. → Verify by opening 2–3 test connections on the token, or ask UW. This
is the one thing that can sink the approach.

## Shard math

260 channels = 2 globals (`flow-alerts`, `off_lit_trades`) + 86 tickers ×
{`option_trades:`, `net_flow:`, `gex_strike_expiry:`}. At ≤45/connection:
**ceil(260 / 45) = 6 connections.**

Partition **family-contiguous** (a connection holds one family's tickers) so a
socket failure degrades one family on a ticker-slice, not "whichever sorts
first." Each 86-ticker family → 2 shards (~43 each); the 2 globals fold into the
shard with room. Assignment is **deterministic** (sorted tickers, stable
chunking) so a reconnect re-subscribes the exact same set and ops can map
"connection 3 = net_flow A–M."

```
conn 0: flow-alerts, off_lit_trades, option_trades:<tickers[0:43]>
conn 1: option_trades:<tickers[43:86]>
conn 2: net_flow:<tickers[0:43]>
conn 3: net_flow:<tickers[43:86]>
conn 4: gex_strike_expiry:<tickers[0:43]>
conn 5: gex_strike_expiry:<tickers[43:86]>
```

## Architecture

Today: one `Connector` → one socket → shared receive queue → router → handlers
(handlers keyed by channel). The shard change is **additive** — handlers, router,
and DB writes are unchanged because the router dispatches by channel name
regardless of which socket delivered the frame.

- N `Connector` instances, each owns its channel subset + its own socket +
  reconnect loop, all **producing into the one shared queue**. The single
  router/processor drains it as today.
- Per-connection isolation: one socket dropping reconnects only its ~43
  channels; the other 5 keep flowing (strictly better than today's all-or-nothing).

## Tasks

- [ ] **Prereq:** confirm UW allows ≥6 concurrent connections on one token →
  Verify: open 3 test sockets, all ack joins. (Blocks everything.)
- [ ] **Task 1:** `config.py` — add `channel_shards -> list[list[str]]`
  (family-contiguous, ≤ `PER_CONN_MAX=45`, globals folded in, deterministic).
  Keep `channels` (flattened) for metrics. → Verify: unit test asserts every
  shard ≤45, union == all 260, stable across calls, families not mixed.
- [ ] **Task 2:** `connector.py` — add a `shard_id`/`name` for log+metric
  tagging; otherwise unchanged (it already takes a `channels` list, paces joins,
  resubscribes on reconnect). → Verify: two Connectors log distinct shard ids.
- [ ] **Task 3:** `main.py` — build shards, instantiate one `Connector` per
  shard sharing the router + queue, run via `asyncio.gather`. → Verify: startup
  log shows 6 "connecting to WS" with disjoint channel lists.
- [ ] **Task 4:** `state.py` / `health.py` — track per-connection
  connected/subscribed state + per-connection reconnect counts; `/health`
  green only when ALL shards are connected; reconnect-storm alert per shard.
  → Verify: kill one socket in a test, /health degrades, others stay up.
- [ ] **Task 5:** queue sizing — total throughput is unchanged (same channels,
  more sockets), but confirm the shared queue maxsize still covers the
  aggregate burst. → Verify: queue-depth metric stays bounded under load.
- [ ] **Task 6:** keep the Sentry alert on the router's `malformed_envelope`
  `limit of 50 reached` sample (added context: it hid for ~20h —
  [[project_uw_50_channel_cap]]) so an over-cap shard is caught immediately.
- [ ] **Phase Verification (LAST):** deploy to Railway; confirm
  `ws_net_flow_per_ticker` + `ws_gex_strike_expiry` resume for **all 86**
  tickers and zero "limit of 50 reached" in logs.

## Files
- `uw-stream/src/config.py` (shard builder)
- `uw-stream/src/main.py` (N connectors)
- `uw-stream/src/connector.py` (shard id/logging)
- `uw-stream/src/state.py`, `health.py` (per-connection state)
- `uw-stream/tests/` (shard-function tests)
- Unchanged: `router.py`, all `handlers/*`, DB schema.

## Open questions
1. Concurrent-connection limit per account (the gating prereq).
2. `PER_CONN_MAX` value — 45 leaves margin for the 2 globals + future ticker
   additions; could go to 48. Default 45.
3. Stagger connection startup? 6 simultaneous join bursts (each ≤45, paced) are
   fine per-socket, but a small inter-connection stagger avoids a thundering
   herd on Railway boot. Default: 250ms between connector starts.

## Constants
- `PER_CONN_MAX = 45` (< 50 cap, margin).
- ~6 connections for the current 260-channel / 86-ticker footprint; scales as
  `ceil(total_channels / 45)`.
