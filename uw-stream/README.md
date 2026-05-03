# uw-stream

Railway-deployed Python service that consumes the UnusualWhales websocket
(`wss://api.unusualwhales.com/socket`) and writes streamed data to Neon
Postgres in batches.

Currently subscribes to:

- **`flow-alerts`** — global UW WS firehose of unusual options flow alerts.
  Writes to `ws_flow_alerts` (DDL: `sql/001_ws_flow_alerts.sql`).
- **`option_trades:<TICKER>`** — per-tick option trade stream for the
  Lottery Finder ticker universe (~50 tickers). Writes to
  `ws_option_trades` (DDL: `sql/002_ws_option_trades.sql`). One shared
  handler instance services every per-ticker subscription.

See `docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md` for the
phased build plan, `docs/superpowers/specs/lottery-finder-2026-05-02.md`
for the option_trades consumer (Phase 1.4 cron), and
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

The daemon writes to two tables:

- `ws_flow_alerts` — flow-alerts channel (DDL: `sql/001_ws_flow_alerts.sql`).
  Raw fields only; derived values like `dte_at_alert`, `distance_pct`
  live in the `ws_flow_alerts_enriched` view so the math stays
  re-runnable against historic rows.
- `ws_option_trades` — `option_trades:<TICKER>` channels. One row per
  OPRA print with side classification, IV, delta, and OI at trade time.
  Input feed for the Lottery Finder cron's v4 trigger detector. Schema
  lives in `api/_lib/db-migrations.ts` migration #110; the daemon
  assumes the table exists (Vercel `migrate-db` provisions it).

Both tables follow the same shape: typed columns for everything the
daemon explicitly extracts plus a `raw_payload JSONB` column carrying
the full original WS payload for forward-compat.

The cron-fed `flow_alerts` table is **not touched**. Both will run in
parallel during the soak window; cutover happens in a later phase per
the migration plan.

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Same Neon connection used by `api/` |
| `UW_API_KEY` | yes | Advanced-tier UW key (websocket access required) |
| `SENTRY_DSN` | no | Shared with sidecar. Events tagged `service=uw-stream` |
| `PORT` | no | Default 8080. Railway provides one. |
| `LOG_LEVEL` | no | Default `INFO` |
| `WS_QUEUE_SIZE` | no | Default 50000 |
| `WS_BATCH_SIZE` | no | Default 500 rows |
| `WS_BATCH_INTERVAL_MS` | no | Default 2000ms |
| `WS_BACKPRESSURE_POLICY` | no | `drop_oldest` (default), `drop_newest`, or `block` |
| `WS_LOG_SAMPLE_RATE` | no | Default 0.001 (1 in 1000 messages logged) |
| `WS_CHANNELS` | no | Comma-separated. Default `flow-alerts`. Shorthand `option_trades_lottery` expands to one `option_trades:<TICKER>` per Lottery Finder ticker (~50). |

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
first deploy.

Schema is owned by `api/_lib/db-migrations.ts` and applied by Vercel's
`migrate-db` on every api/ deploy. Before enabling a new channel on
Railway, ship the corresponding api/ migration first so the table
exists when the daemon starts writing.

(The legacy `sql/001_ws_flow_alerts.sql` file is kept for historical
reference only — the same DDL also lives as migration #108 in the
api/ migration chain. Going forward, all schema changes live there.)

## Operational notes

- **Resubscribe on reconnect.** UW's server forgets joins on disconnect.
  The connector re-sends every join frame after each reconnect.
- **String-encoded numerics.** Every UW WS field that _could_ be a number
  arrives as a JSON string. Handlers cast at the boundary.
- **`flow-alerts` uses a hyphen** even though the docs URL is
  `flow_alerts`. Subscribe with the hyphen.
- **Backpressure.** Bounded `asyncio.Queue` per channel. Drop policy is
  configurable; a non-zero drop counter is reported to Sentry every 60s.
- **Single point of failure.** One process, one connection. If it dies
  during market hours, data goes dark until Railway restarts it.
  Acceptable for a personal trading tool but worth knowing.
