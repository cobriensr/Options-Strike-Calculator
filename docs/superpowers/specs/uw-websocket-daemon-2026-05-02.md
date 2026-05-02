# UW WebSocket Daemon — new Railway service

**Date:** 2026-05-02
**Status:** Spec — pending user approval before implementation
**Related:** [uw-cron-to-websocket-migration-2026-05-02.md](./uw-cron-to-websocket-migration-2026-05-02.md)

---

## Goal

A new Railway-deployed Python service that maintains a single multiplexed UnusualWhales websocket connection and writes streamed data into existing Neon Postgres tables — replacing select Vercel cron jobs that currently poll UW REST endpoints.

## Why

- Several UW data updates are sub-minute (alerts, dark pool prints, 0DTE strike GEX). Existing minute-cadence crons miss bursts and add 0–60s lag.
- Vercel Functions cap at 800s — long-running WS consumers cannot live there.
- Railway already hosts `sidecar/` (Databento) and `ml-sweep/`; adding a third Python service is operationally cheap.

## Non-goals

- No new tables / no schema changes. Writes into the same tables the corresponding crons currently populate so cutover requires only `vercel.json` edits, not migrations.
- No new analytics or computation. Raw data only — derived signals stay on existing analyze-time paths.
- No replacement for crons polling pre-aggregated 5-min UW endpoints (no fidelity gain — see migration Tier 3).

---

## Architecture

Single asyncio process, four components:

1. **Connector** — opens `wss://api.unusualwhales.com/socket?token=<UW_API_KEY>`, joins channels, runs reconnect + **resubscribe** loop with exponential backoff (server forgets joins on disconnect).
2. **Router** — receives `[channel, payload]` arrays from the WS, dispatches to per-channel handler queues. Filters out join-ack frames (`{"status":"ok"}` shape).
3. **Per-channel handlers** — bounded `asyncio.Queue` per channel, accumulate batches, transform payloads to match existing DB row shapes, flush on size or time threshold.
4. **Health/metrics server** — small HTTP server (aiohttp) on `$PORT` for Railway healthcheck. Exposes queue depth, drop counters, last-message timestamps per channel.

```text
WS  →  Connector  →  Router  →  per-channel queue  →  handler  →  asyncpg COPY  →  Neon
                          ↘ join-ack filter
                                                        ↑
                                              metrics + Sentry
```

## File layout

```text
uw-stream/                          (sibling to sidecar/, ml-sweep/)
├── pyproject.toml
├── requirements.txt
├── Dockerfile
├── README.md
├── src/
│   ├── main.py                     # asyncio entrypoint, signal handlers
│   ├── connector.py                # WS connect + reconnect/resubscribe
│   ├── router.py                   # message dispatch + ack filter
│   ├── handlers/
│   │   ├── base.py                 # shared batching/flush logic
│   │   ├── flow_alerts.py
│   │   ├── off_lit_trades.py
│   │   ├── gex.py                  # gex, gex_strike, gex_strike_expiry
│   │   ├── option_trades.py        # option_trades:SPXW + size filter
│   │   └── contract_screener.py
│   ├── db.py                       # asyncpg pool + COPY helpers
│   ├── health.py                   # /healthz + /metrics HTTP server
│   ├── sentry_setup.py             # mirrors sidecar/sentry_setup pattern
│   └── config.py                   # env var parsing
└── tests/
    ├── test_router.py
    ├── test_handlers.py
    └── fixtures/                   # captured WS payloads (one per channel)
```

## Channels — Phase 1 (Tier 1 only)

| Channel                 | Subscription     | Target table       | Notes                                       |
| ----------------------- | ---------------- | ------------------ | ------------------------------------------- |
| `flow-alerts`           | global           | `flow_alerts`      | Hyphen, not underscore — common typo        |
| `off_lit_trades`        | global           | `dark_pool_prints` | Session-hours filter per memory feedback    |
| `gex_strike_expiry:SPX` | per-ticker (SPX) | `gex_zero_dte`     | Handler filters to today's expiry only      |

## Channels — Phase 2 (Tier 2, deferred)

| Channel                       | Subscription               | Target table                       |
| ----------------------------- | -------------------------- | ---------------------------------- |
| `gex:SPX`                     | SPX                        | `spot_gex` (or current equivalent) |
| `gex_strike:SPX`              | SPX                        | `strike_exposure`                  |
| `gex_strike_expiry:SPY`/`QQQ` | per-ticker                 | same table, different ticker rows  |
| `option_trades:SPXW`          | SPXW (size filter)         | `spxw_blocks`                      |
| `contract_screener`           | global, filter to SPX 0DTE | `vol_0dte`                         |

Exact target tables to be confirmed during Phase 1 by reading the corresponding cron handler — do not write into a new table; reuse what the cron writes today.

## Configuration (Railway env vars)

| Var                      | Source / default                                                  |
| ------------------------ | ----------------------------------------------------------------- |
| `UW_API_KEY`             | Existing Vercel secret, copy to Railway                           |
| `DATABASE_URL`           | Same Neon connection used by `api/`                               |
| `SENTRY_DSN`             | Shared with sidecar; events tagged `service:uw-stream`            |
| `PORT`                   | Railway-provided                                                  |
| `WS_QUEUE_SIZE`          | Default 50_000                                                    |
| `WS_BATCH_SIZE`          | Default 500 rows                                                  |
| `WS_BATCH_INTERVAL_MS`   | Default 2000ms                                                    |
| `WS_BACKPRESSURE_POLICY` | `drop_oldest` \| `drop_newest` \| `block` (default `drop_oldest`) |
| `WS_LOG_SAMPLE_RATE`     | Default 0.001 (1 in 1000 messages logged)                         |

## Backpressure + drop accounting

- Bounded `asyncio.Queue(maxsize=WS_QUEUE_SIZE)` per channel.
- Drop counter per channel exposed via `/metrics`. Reported to Sentry as periodic event every 60s if any non-zero.
- Without drop counters, "server dropped" vs "I fell behind" is indistinguishable (per UW WS skill).

## Reconnect

- Exponential backoff: 1s → 2 → 4 → 8 → ... capped at 60s.
- Resubscribe **all** channels on each reconnect (UW server forgets joins).
- Reconnect events log: time-since-last-message per channel, current queue depths.
- Sentry breadcrumb on every reconnect; warning event if reconnects > 5 in 1 hour.

## Health endpoints

```text
GET /healthz
  200 if WS connected AND last message < 5min ago
  503 otherwise

GET /metrics
  {
    "uptime_seconds": ...,
    "channels": {
      "flow-alerts": {
        "subscribed": true,
        "last_message_ts": "...",
        "queue_depth": 12,
        "drop_count": 0,
        "write_count": 18342
      },
      ...
    },
    "reconnects_last_hour": 0
  }
```

Railway healthcheck path: `/healthz`. Restart policy: on-failure with 30s grace.

## Database writes

- `asyncpg` connection pool (size 5).
- COPY-based bulk inserts for high-throughput channels (`off_lit_trades`, `option_trades`).
- `ON CONFLICT (...) DO NOTHING` on natural keys for idempotency on reconnect/replay overlap.
- No schema changes — handlers map WS payload fields to existing column names. Field-mapping table maintained per handler in `handlers/<name>.py` module docstring.

## Field-mapping pitfalls (from UW WS doc audit)

- All numeric fields arrive as **JSON strings**. Cast via `Decimal` (or `float` where precision is non-critical) at handler boundary. Never compare or sum the raw string.
- `gex.delta_per_one_percent_move_oi` is sometimes `""` (empty string). Coalesce to `NULL` before insert.
- `flow-alerts` channel uses a **hyphen** even though docs URL is `flow_alerts`. Subscribe with the hyphen.
- `interval_flow` and `contract_screener` are **not** subscribable per ticker — they fan out and we filter client-side.

## Decided

1. **Directory name:** `uw-stream/` (sibling to `sidecar/`, `ml-sweep/`). Existing `daemon/` is the TypeScript capture daemon — distinct concern.
2. **DB driver:** `asyncpg`. Faster COPY throughput, asyncio-native. Sidecar parity is a soft goal, not a hard rule.
3. **Sentry:** share the sidecar DSN. Adds tagging on events (`service:uw-stream`) so alerts can still be scoped.
4. **Whale-alert handling:** no filter. All alerts go to one unified `flow_alerts` table. Whale-alert UI / analyze paths must be updated to query that table with a WHERE clause at read time. **This is a frontend/api change item — see migration plan.**

## Still open

1. **Block-trade threshold for `option_trades:SPXW`** — match the existing `fetch-spxw-blocks.ts` definition. Confirm during Phase 1 by reading that handler.
2. **Soak duration** — 3 trading days (decided 2026-05-02). Shorter than industry default; user accepts the trade-off that a once-a-week regime quirk may not appear in the soak window.

## Phases

### Phase 1 — Scaffold + flow-alerts only

- [ ] Create `uw-stream/` directory with `pyproject.toml`, `Dockerfile`, README
- [ ] Implement `connector.py`, `router.py`, `handlers/base.py`, `handlers/flow_alerts.py`, `db.py`, `health.py`
- [ ] Add unit tests with captured WS payloads as fixtures
- [ ] Deploy to Railway, set env vars, verify `/healthz` returns 200
- [ ] Confirm daemon-written rows land in `flow_alerts` table
- **Verify:** count rows from daemon over 1 trading day; should match or slightly exceed cron count (cron paginates and may dedupe; daemon writes every alert pushed)

### Phase 2 — Add off_lit_trades + gex_strike_expiry:SPX

- [ ] Implement `handlers/off_lit_trades.py`, `handlers/gex.py`
- [ ] Confirm field mapping against existing cron-target tables
- [ ] Deploy and run alongside crons for 24h
- **Verify:** Sentry error rate stable; queue depths < 1k under load; drop_count = 0

### Phase 3 — Add metrics polish + soak

- [ ] Wire Sentry periodic drop-count reporting
- [ ] Add `/metrics` JSON endpoint, document schema
- [ ] Add 3-day soak (covered in migration plan Phase 3)

## Done when

- Service running on Railway for ≥3 trading days with no Sentry incidents.
- `/metrics` shows healthy queue depths and zero drops during peak (open + 30min before close).
- Tier 1 cutover (migration plan Phase 4) complete: 4 crons removed, no rows missing in tables.

## Notes / risks

- **Single point of failure** — one daemon, one WS connection. If it dies during market hours, the data path goes dark until restart. Railway's restart policy + Sentry alerts mitigate, but there is no redundant consumer. Acceptable for personal trading tool; flag if multi-region or HA later required.
- **UW plan gate** — websocket access requires Advanced plan. Confirm `UW_API_KEY` belongs to an Advanced-tier subscription before deploy.
- **Cost** — Railway charges by container-hour. One always-on container is cheap (~$5–10/mo) but not free.
