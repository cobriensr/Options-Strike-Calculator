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
- **`futures_trades`** — global CME futures trade firehose, aggregated
  into 1-minute OHLCV bars in `futures_bars`. Re-sources the bars the
  Databento-fed `sidecar` used to write; the schema is unchanged, so no
  migration and no reader changes. See "Futures bars" below.

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

The daemon writes to three tables:

- `ws_flow_alerts` — flow-alerts channel (DDL: `sql/001_ws_flow_alerts.sql`).
  Raw fields only; derived values like `dte_at_alert`, `distance_pct`
  live in the `ws_flow_alerts_enriched` view so the math stays
  re-runnable against historic rows.
- `ws_option_trades` — `option_trades:<TICKER>` channels. One row per
  OPRA print with side classification, IV, delta, and OI at trade time.
  Input feed for the Lottery Finder cron's v4 trigger detector. Schema
  lives in `api/_lib/db-migrations.ts` migration #110; the daemon
  assumes the table exists (Vercel `migrate-db` provisions it).
- `futures_bars` — `futures_trades` channel, aggregated to 1-minute
  OHLCV. Pre-existing table from `api/_lib/db-migrations.ts` migration
  #42 (`UNIQUE(symbol, ts)`); the daemon adds **no** migration and
  changes **no** columns.

`ws_flow_alerts` and `ws_option_trades` follow the same shape: typed
columns for everything the daemon explicitly extracts plus a
`raw_payload JSONB` column carrying the full original WS payload for
forward-compat. `futures_bars` is the exception — it is an aggregate,
not a per-message table, so it has no `raw_payload`.

The cron-fed `flow_alerts` table is **not touched**. Both will run in
parallel during the soak window; cutover happens in a later phase per
the migration plan.

### Futures bars

`src/handlers/futures_trades.py` folds the global CME trade firehose
into `futures_bars`, replacing Databento as the source of those bars.

**Six product roots**, matched by **exact equality** on the payload's
`product` field:

| Root  | Contract            |
| ----- | ------------------- |
| `ES`  | E-mini S&P 500      |
| `NQ`  | E-mini Nasdaq-100   |
| `RTY` | E-mini Russell 2000 |
| `CL`  | WTI Crude Oil       |
| `GC`  | Gold                |
| `ZN`  | 10-Year T-Note      |

The micros (`MES`, `MNQ`, `MGC`, `MYM`, `M2K`) are **separate `product`
values** and are excluded. Never loosen the filter to a prefix match —
folding micro prints into their full-size parent corrupts both volume
and range.

**DX and VX are unavailable**, and their absence is not a bug: `DX`
(Dollar Index) is ICE-listed and `VX` (VIX futures) is Cboe CFE. Neither
trades on the CME feed this channel carries, so no subscription or
filter change can produce them. The Databento-era `futures_bars` rows
for those symbols simply stop being extended.

Design notes worth knowing before touching the handler:

- We join the **global `futures_trades`** channel, not six
  `futures:<CONTRACT>` ones (note UW's per-contract form uses a
  different prefix than the channel name). One subscription instead of
  six against the 50-channel-per-connection cap, and contract roll
  (ESU6 → ESZ6) needs no expiry calendar.
- **UW re-delivers every futures print 2–11×.** Naive summing inflated
  volume 1.93×–3.09× over a live probe, so prints are deduped on
  `(sym, trade_id)` within each minute bucket.
- `futures_bars.symbol` holds the **root** (`'ES'`), so the many contract
  months on the wire are collapsed to the one with the greatest
  cumulative session volume — a self-rolling front-month pick.
- Only minutes **strictly older** than the newest minute seen for a
  product are written. That is what makes `ON CONFLICT DO NOTHING`
  correct: a partial bar written early could never be revised. The
  in-progress minute per product is deliberately lost on shutdown.
- A minute in which the front month printed nothing but a back month
  did is written as a **gap**, logged under `kind="front_sym_absent"`.
  Filling it with the back month's price would inject a carry-basis
  spike into the root series that `DO NOTHING` could never revise; a
  missing minute is the safer failure.
- **`/metrics` caveat:** this is the one aggregating handler, so its
  `write_attempted` counts trade prints while `write_count` counts
  bars. The gap between them is the aggregation ratio (~1.2M prints →
  ~8.6k bars/day), **not** a dedup or failure rate. Judge the channel
  by `write_count` and `last_message_ts`.

**Before relying on this as the source of truth**, confirm the
`sidecar/` bar writer (`sidecar/src/bar_writer.py`, wired into
`sidecar/src/main.py`) is inert. Both services target `futures_bars`
keyed on `UNIQUE(symbol, ts)`, and the sidecar upserts with
`ON CONFLICT DO UPDATE` while this handler uses `DO NOTHING` — so a
live sidecar silently wins every contested minute, and this handler
would read healthy on `/metrics` while contributing almost nothing.

## Environment

| Var                      | Required | Notes                                                                                                                                              |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | yes      | Same Neon connection used by `api/`                                                                                                                |
| `UW_API_KEY`             | yes      | Advanced-tier UW key (websocket access required)                                                                                                   |
| `SENTRY_DSN`             | no       | Shared with sidecar. Events have `server_name=uw-stream` (Sentry host display) and tag `service=uw-stream` (filter key). Search/filter by either.  |
| `PORT`                   | no       | Default 8080. Railway provides one.                                                                                                                |
| `LOG_LEVEL`              | no       | Default `INFO`                                                                                                                                     |
| `WS_QUEUE_SIZE`          | no       | Default 50000                                                                                                                                      |
| `WS_BATCH_SIZE`          | no       | Default 500 rows                                                                                                                                   |
| `WS_BATCH_INTERVAL_MS`   | no       | Default 2000ms                                                                                                                                     |
| `WS_BACKPRESSURE_POLICY` | no       | `drop_oldest` (default), `drop_newest`, or `block`                                                                                                 |
| `WS_LOG_SAMPLE_RATE`     | no       | Default 0.001 (1 in 1000 messages logged)                                                                                                          |
| `WS_CHANNELS`            | no       | Comma-separated. Default `flow-alerts`. Shorthand `option_trades_lottery` expands to one `option_trades:<TICKER>` per Lottery Finder ticker (~50). |
| `WS_LEASE_ENABLED`       | no       | Default `true`. WS connection lease (deploy-overlap guard, see below). `false` bypasses it. When `true`, BOTH KV vars below are REQUIRED.           |
| `KV_REST_API_URL`        | cond.    | Upstash REST base URL, same store the main app uses. Required when `WS_LEASE_ENABLED=true`.                                                        |
| `KV_REST_API_TOKEN`      | cond.    | Upstash REST bearer token. Required when `WS_LEASE_ENABLED=true`.                                                                                  |
| `WS_LEASE_TTL_MS`        | no       | Default 30000. Lease TTL; lapses on its own if the holder dies without releasing.                                                                  |
| `WS_LEASE_RENEW_MS`      | no       | Default 10000 (ttl/3). Renew interval; MUST be `< WS_LEASE_TTL_MS` (validated at boot).                                                            |
| `WS_LEASE_ACQUIRE_TIMEOUT_S` | no   | Default 60. Boot poll window before exiting non-zero for Railway to restart + retry (never force-steals).                                          |
| `WS_LEASE_KEY`           | no       | Default `uw-stream:ws-conn-lease`. The Upstash key the lease lives under.                                                                          |

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
- **WS connection lease (deploy-overlap guard).** UW caps the token at 10
  websocket connections; steady-state is ~8 sharded sockets. The exposure
  is the Railway deploy handoff, where the new container boots while the
  old is still draining, so both briefly hold ~8 sockets (16 > 10) and the
  new gen's joins get silently rejected. To prevent this, every boot
  acquires a single Upstash-backed TTL'd lease (`WS_LEASE_KEY`) BEFORE
  opening any socket: a new deploy waits for the old gen to release (or for
  the TTL to lapse) before connecting. On clean shutdown the lease is
  released only AFTER our sockets close, so the next gen never connects
  while ours are open. If acquire times out (a wedged old gen), the daemon
  exits non-zero and lets Railway restart + retry rather than force-stealing
  the lease (stealing would re-introduce the overlap). A confirmed
  mid-life loss of the lease routes into the normal graceful shutdown.
  Implementation in `src/ws_lease.py`; spec in
  `docs/superpowers/specs/uw-stream-ws-connection-lease-2026-06-03.md`.
