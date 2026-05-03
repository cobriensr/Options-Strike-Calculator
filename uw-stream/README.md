# uw-stream

Railway-deployed Python service that consumes the UnusualWhales websocket
(`wss://api.unusualwhales.com/socket`) and writes streamed data to Neon
Postgres in batches.

Phase 1 ships the `flow-alerts` channel only. See
`docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md` for the full
phased build plan and
`docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md`
for the cron retirement plan that depends on this service.

## Architecture

```text
WS  →  Connector  →  Router  →  per-channel queue  →  handler  →  asyncpg COPY  →  Neon
                          ↘ join-ack filter
                                                        ↑
                                              metrics + Sentry
```

Single asyncio process, four components:

1. **Connector** (`src/connector.py`) — opens the WS, joins channels,
   handles reconnect + resubscribe with exponential backoff.
2. **Router** (`src/router.py`) — parses each `[channel, payload]` array,
   filters out join-ack frames, dispatches to per-channel handler queues.
3. **Handlers** (`src/handlers/`) — per-channel batching, transforming,
   and bulk-inserting via `asyncpg`.
4. **Health** (`src/health.py`) — small aiohttp server on `$PORT` for
   Railway healthchecks. Exposes `/healthz` (200/503) and `/metrics`
   (per-channel queue depth, drop counters, last-message timestamps).

## Schema

Phase 1 writes to a new table `ws_flow_alerts` (DDL in `sql/001_ws_flow_alerts.sql`).
Raw fields only — derived values like `dte_at_alert`, `distance_pct`, etc.
are computed at read time via the `ws_flow_alerts_enriched` view. This
keeps the daemon dumb and the math centralised.

The cron-fed `flow_alerts` table is **not touched**. Both will run in
parallel during the soak window; cutover happens in a later phase per
the migration plan.

## Environment

| Var                      | Required | Notes                                                  |
| ------------------------ | -------- | ------------------------------------------------------ |
| `DATABASE_URL`           | yes      | Same Neon connection used by `api/`                    |
| `UW_API_KEY`             | yes      | Advanced-tier UW key (websocket access required)       |
| `SENTRY_DSN`             | no       | Shared with sidecar. Events tagged `service=uw-stream` |
| `PORT`                   | no       | Default 8080. Railway provides one.                    |
| `LOG_LEVEL`              | no       | Default `INFO`                                         |
| `WS_QUEUE_SIZE`          | no       | Default 50000                                          |
| `WS_BATCH_SIZE`          | no       | Default 500 rows                                       |
| `WS_BATCH_INTERVAL_MS`   | no       | Default 2000ms                                         |
| `WS_BACKPRESSURE_POLICY` | no       | `drop_oldest` (default), `drop_newest`, or `block`     |
| `WS_LOG_SAMPLE_RATE`     | no       | Default 0.001 (1 in 1000 messages logged)              |
| `WS_CHANNELS`            | no       | Comma-separated. Default `flow-alerts`.                |

## Local development

```bash
cd uw-stream
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# create .env from this README's env table, or copy from a teammate
python -m src.main
# in another shell:
curl http://localhost:8080/healthz
curl http://localhost:8080/metrics | jq
```

## Tests

```bash
pytest                # all tests
pytest -k flow_alerts # one suite
ruff check src/ tests/
```

## Deploy

Railway auto-deploys on push when `uw-stream/**` files change
(see `railway.toml`). Set env vars in the Railway dashboard before the
first deploy. Run the SQL DDL once against Neon before deploying:

```bash
psql "$DATABASE_URL" -f sql/001_ws_flow_alerts.sql
```

## Operational notes

- **Resubscribe on reconnect.** UW's server forgets joins on disconnect.
  The connector re-sends every join frame after each reconnect.
- **String-encoded numerics.** Every UW WS field that *could* be a number
  arrives as a JSON string. Handlers cast at the boundary.
- **`flow-alerts` uses a hyphen** even though the docs URL is
  `flow_alerts`. Subscribe with the hyphen.
- **Backpressure.** Bounded `asyncio.Queue` per channel. Drop policy is
  configurable; a non-zero drop counter is reported to Sentry every 60s.
- **Single point of failure.** One process, one connection. If it dies
  during market hours, data goes dark until Railway restarts it.
  Acceptable for a personal trading tool but worth knowing.
