# uw-stream

Railway-deployed Python service that consumes the UnusualWhales websocket
(`wss://api.unusualwhales.com/socket`) and writes streamed data to Neon
Postgres in batches.

## Channels

`WS_CHANNELS` picks the channels. Each token must be one of these, or the
boot fails (`config.py` validates every token against
`src/channel_registry.py`):

| `WS_CHANNELS` token                                            | Handler                                                                                                      | Writes to (api migration)                            | Write mode                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `flow-alerts` (alias `flow_alerts`)                            | `handlers/flow_alerts.py`                                                                                    | `ws_flow_alerts` (#108)                              | `ON CONFLICT (ws_alert_id) DO NOTHING`                                               |
| `option_trades:<TICKER>`, or `option_trades_lottery`           | `handlers/option_trades.py` (one shared instance for every ticker)                                           | `ws_option_trades` (#109)                            | `ON CONFLICT (ws_trade_id) DO NOTHING`                                               |
| `option_trades:SPY`, `option_trades:SPXW`, `option_trades:QQQ` | `handlers/interval_ba.py` (subclasses of the option-trades handler)                                          | `ws_option_trades`, plus `interval_ba_alerts` (#144) | alerts: `ON CONFLICT (option_chain, bucket_start) DO NOTHING`                        |
| `net_flow:<TICKER>`, or `net_flow_lottery`                     | `handlers/net_flow.py`                                                                                       | `ws_net_flow_per_ticker` (#121)                      | `ON CONFLICT (ticker, ts) DO NOTHING`                                                |
| `gex_strike_expiry:<TICKER>`, or `gex_strike_expiry_lottery`   | `handlers/gex_strike_expiry.py`                                                                              | `ws_gex_strike_expiry` (#111)                        | `ON CONFLICT (ticker, expiry, strike, ts_minute) DO UPDATE` (last write wins)        |
| `off_lit_trades`                                               | `handlers/off_lit_trades.py` (keeps SPY and QQQ, 08:30–15:00 CT; drops extended-hours and contingent prints) | `dark_pool_prints` (#116)                            | `ON CONFLICT (symbol, executed_at, price, size) DO NOTHING`                          |
| `futures_trades`                                               | `handlers/futures_trades.py`, aggregated to 1-minute bars                                                    | `futures_bars` (#42)                                 | `ON CONFLICT (symbol, ts) DO NOTHING`                                                |
| `futures_blocks`                                               | `handlers/futures_blocks.py` (every product, plus multi-leg strategies)                                      | `futures_blocks` (#196)                              | `ON CONFLICT (trade_id, exchange, trade_date) DO UPDATE` (newest `reported_at` wins) |

The three `*_lottery` shorthands each expand to one channel per ticker in
the Lottery Finder universe: 86 tickers, `_LOTTERY_TICKERS` in
`src/config.py`, mirrored from `api/_lib/lottery-finder.ts`. The universe
includes SPY, SPXW and QQQ, so `option_trades_lottery` also subscribes the
three Interval B/A channels. Those write alerts only when
`INTERVAL_BA_ENABLED=true` and the ticker is in `INTERVAL_BA_TICKERS_CSV`.
Duplicate channels are dropped, so an explicit `gex_strike_expiry:SPY`
next to `gex_strike_expiry_lottery` is subscribed once.

**Production (Railway, checked 2026-10-29)** sets `WS_CHANNELS` to
`flow-alerts, off_lit_trades, option_trades_lottery, gex_strike_expiry:SPY,
gex_strike_expiry:QQQ, gex_strike_expiry:SPX, gex_strike_expiry:NDX,
net_flow_lottery, gex_strike_expiry_lottery, futures_trades`, with
`INTERVAL_BA_ENABLED=true` and `INTERVAL_BA_TICKERS_CSV=SPY,SPXW,QQQ`. That
expands to 263 channels: 86 `option_trades`, 86 `net_flow`, 88
`gex_strike_expiry` (SPX and NDX are not in the Lottery universe) and the
three global channels. They run on 6 sockets (see Architecture).

`futures_blocks` is registered but **not** in production `WS_CHANNELS`, so
it is inactive until added there, after the handler is deployed (never
before). See "Futures blocks" below.

See `docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md` for the
phased build plan, `docs/superpowers/specs/lottery-finder-2026-05-02.md`
for the option_trades consumer (Phase 1.4 cron), and
`docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md`
for the cron retirement plan that depends on this service.

## Architecture

```text
Upstash lease ─┐
               ▼
UW WS → N sharded Connectors (≤45 channels each) → receive queue → Router → per-handler queue → handler → multi-row INSERT … ON CONFLICT → Neon
                                                                     ↘ join-ack filter
                          health (/healthz, /metrics) · subscription watchdog · Sentry
```

Single asyncio process:

1. **Lease** (`src/ws_lease.py`): acquires one Upstash lease before any
   socket opens (see "WS connection lease" below).
2. **Connectors** (`src/connector.py`): one per shard.
   `Settings.channel_shards` splits the expanded channel list into groups
   of at most `WS_MAX_CHANNELS_PER_CONN` (45, under UW's 50-per-connection
   cap). A shard holds one per-ticker family, and the global channels fold
   into the first shard with room. With the production list that gives 6
   sockets: `option_trades` 45 + 41 (the 3 globals join the 41),
   `gex_strike_expiry` 45 + 43, `net_flow` 45 + 41. Each connector
   reconnects with 1–60 s backoff (±20% jitter), resets the backoff only
   after a 60 s healthy session, re-sends every join after a reconnect,
   and re-joins any still-unacked channel every 60 s.
3. **Router** (`src/router.py`): parses `[channel, payload]` frames from
   the shared receive queue, drops join acks, and dispatches to handler
   queues.
4. **Handlers** (`src/handlers/`): batch, transform, and write with
   chunked multi-row `INSERT … ON CONFLICT` (not `COPY`, not
   `executemany`).
5. **Health** (`src/health.py`): aiohttp on `$PORT`.
   - `/healthz` returns 200 `ok` when data arrived in the last 5 minutes,
     200 `starting` during the first 5 minutes before any message, and
     200 `ok_market_closed` when connected but quiet outside Mon–Fri
     09:30–16:15 ET. It returns 503 `ws_disconnected` when no shard is
     up, and 503 `no_messages` or `stale` when in-hours data is missing
     or older than 5 minutes. It feeds the Docker `HEALTHCHECK` only:
     `railway.toml` leaves `healthcheckPath` unset because the check has
     no holiday calendar.
   - `/metrics` has top-level fields `uptime_seconds`, `ws_connected`
     (all shards up), `connections` (per shard), `last_message_ts`,
     `reconnects_last_hour`, `receive_queue_depth` and
     `receive_queue_drops`, plus two keyed sections: `channels` (per WS
     channel joined, or echoed by UW, e.g. `net_flow:TSLA`: `subscribed`,
     `last_message_ts`) and `handlers` (per handler queue, keyed by
     handler name: `queue_depth`, `drop_count`, `write_attempted`,
     `write_count`; zeroed from boot). The shared handlers are named after
     their channel family (`option_trades`, `net_flow`,
     `gex_strike_expiry`), so one `handlers` row covers that family's
     per-ticker channels. Exception: `option_trades:SPY` / `SPXW` / `QQQ`
     get dedicated Interval B/A handlers with their own `handlers` rows,
     which the `option_trades` row does not include. When
     `INTERNAL_METRICS_TOKEN` is set, requests need a matching
     `X-Metrics-Token` header.
6. **Subscription watchdog** (`src/subscription_watchdog.py`): checks
   every 120 s after a 5-minute grace, and sends a Sentry warning when a
   configured channel stays unsubscribed for two checks in a row.
7. **Notify** (`src/notify.py`): posts Interval B/A alerts to Vercel's
   `/api/push/notify` for Web Push. It does nothing unless both
   `VERCEL_NOTIFY_URL` and `INTERNAL_NOTIFY_SECRET` are set.

## Schema

The daemon writes to up to eight tables, depending on `WS_CHANNELS` (see
the channel table above):

- `ws_flow_alerts`: flow-alerts channel (migration #108; the same DDL is
  in `sql/001_ws_flow_alerts.sql`). Raw fields only; derived values like
  `dte_at_alert`, `distance_pct` live in the `ws_flow_alerts_enriched`
  view so the math stays re-runnable against historic rows.
- `ws_option_trades`: `option_trades:<TICKER>` channels. One row per
  OPRA print with side classification, IV, delta, and OI at trade time.
  Input feed for the Lottery Finder cron's v4 trigger detector. Schema
  lives in `api/_lib/db-migrations.ts` migration #109; the daemon
  assumes the table exists (see Deploy).
- `ws_net_flow_per_ticker`: `net_flow:<TICKER>` channels (migration #121).
- `ws_gex_strike_expiry`: `gex_strike_expiry:<TICKER>` channels
  (migration #111). Upserted, last write wins: a later frame for the
  same ticker, expiry, strike and minute replaces the earlier one.
- `dark_pool_prints`: `off_lit_trades`, SPY and QQQ only (migration
  #116).
- `interval_ba_alerts`: Interval B/A ask-side alerts from the SPY, SPXW
  and QQQ option-trades handlers (migration #144).
- `futures_bars`: `futures_trades` channel, aggregated to 1-minute
  OHLCV. Pre-existing table from `api/_lib/db-migrations.ts` migration
  #42 (`UNIQUE(symbol, ts)`); the daemon adds **no** migration and
  changes **no** columns.
- `futures_blocks`: `futures_blocks` channel, one row per CME block
  trade (migration #196), keyed `(trade_id, exchange, trade_date)`.
  Upserted, but only by a message whose `reported_at` is not older
  than the stored one (see "Futures blocks").

`ws_flow_alerts`, `ws_option_trades`, `ws_net_flow_per_ticker`,
`ws_gex_strike_expiry` and `futures_blocks` carry typed columns for
everything the daemon explicitly extracts plus a `raw_payload JSONB`
copy of the WS message for forward-compat. `futures_bars` (an
aggregate), `dark_pool_prints` and `interval_ba_alerts` have no
`raw_payload`.

The cron-fed `flow_alerts` table (`api/cron/fetch-flow-alerts.ts`) is
**not touched**. Both still run, and `api/_lib/uw-deltas.ts` still reads
`flow_alerts`.

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
  `handlers.futures_trades.write_attempted` counts trade prints while
  `write_count` counts bars. The gap between them is the aggregation
  ratio (~1.2M prints → ~8.6k bars/day), **not** a dedup or failure
  rate. Judge it by `handlers.futures_trades.write_count` and
  `channels.futures_trades.last_message_ts`.

**Sole live writer.** The sidecar's Databento bar writer (which
upserted with `ON CONFLICT DO UPDATE` and would have won every
contested minute) was removed on 2026-09-29, so this handler is the
only live source of `futures_bars`. Holes it leaves (deploys, lease
handoffs, socket drops) are repaired daily by the Vercel cron
`api/cron/backfill-futures-gaps.ts` from UW REST 1-minute candles. That
cron also inserts `ON CONFLICT DO NOTHING`, so it never overwrites a
bar this handler wrote, and it replays the same front-month rule.
`futures_trades` must therefore stay in production `WS_CHANNELS`.

### Futures blocks

`src/handlers/futures_blocks.py` stores the global `futures_blocks`
channel in `futures_blocks`. Per UW's docs, CME reports a block as
`new`, then again as `update` or `delete`, and the newest message for a
block replaces the earlier ones.

- **Key:** `(trade_id, exchange, trade_date)`. CME reuses a `trade_id`
  in later sessions, so `trade_id` alone is not unique.
- **Upsert, newest wins:** `db.bulk_upsert_if_newer` replaces every
  column (including `raw_payload`) only when the incoming `reported_at`
  is at least the stored one, so a late older message never overwrites
  a newer one. A batch is collapsed to one row per key first, because
  Postgres rejects one upsert that touches a key twice.
- **`delete` is a row state** (`action = 'delete'`); rows are never
  removed. UW nulls the `quote_*` fields on a delete.
- **Every product is stored**, not only the six `futures_bars` roots. A
  multi-leg (`MLEG`) block has a NULL `price` and `product`; its legs
  are in `legs`.
- **Join without access:** UW answers with an `{"error": ...}` frame,
  which the router forwards like data. The handler rejects it, warns on
  every one, and sends one Sentry event per process.
- **Rejected frames:** a frame missing `trade_id`, `exchange`,
  `trade_date` or `action`, or with a field that doesn't parse, is
  dropped with a rate-limited `bad_<field>` warning. The first
  rejection of each field per process also goes to Sentry as likely
  schema drift.
- Blocks carry `qty` but no `size`/`side`, so they add nothing to the
  `futures_bars` order-flow columns.

## Environment

Settings live in `src/config.py` (pydantic-settings). A bad value fails
at boot, not at first use.

| Var                                            | Required       | Notes                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | yes            | Same Neon connection used by `api/`                                                                                                                                                                                                                                                                                                                  |
| `UW_API_KEY`                                   | yes            | Advanced-tier UW key (websocket access required)                                                                                                                                                                                                                                                                                                     |
| `SENTRY_DSN`                                   | no             | Empty disables Sentry. Events have `server_name=uw-stream` (Sentry host display) and tag `service=uw-stream` (filter key). Read from the process environment only                                                                                                                                                                                    |
| `PORT`                                         | no             | Default 8080. Railway provides one.                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                                    | ignored        | Parsed by `config.py` but not applied; logs are always INFO                                                                                                                                                                                                                                                                                          |
| `WS_CHANNELS`                                  | no             | Comma-separated; default `flow-alerts`. Tokens: exact channels (`flow-alerts`, `off_lit_trades`, `futures_trades`), per-ticker channels (`option_trades:<T>`, `net_flow:<T>`, `gex_strike_expiry:<T>`), or the shorthands `option_trades_lottery`, `net_flow_lottery`, `gex_strike_expiry_lottery`. An unknown token or an empty list fails the boot |
| `WS_MAX_CHANNELS_PER_CONN`                     | no             | Default 45. Channels per socket (UW caps at 50)                                                                                                                                                                                                                                                                                                      |
| `WS_RECEIVE_QUEUE_SIZE`                        | no             | Default 10000. Buffer between connectors and router. Read from the process environment only                                                                                                                                                                                                                                                          |
| `WS_QUEUE_SIZE`                                | no             | Default 50000 (per handler queue)                                                                                                                                                                                                                                                                                                                    |
| `WS_BATCH_SIZE`                                | no             | Default 500 rows                                                                                                                                                                                                                                                                                                                                     |
| `WS_BATCH_INTERVAL_MS`                         | no             | Default 2000 ms                                                                                                                                                                                                                                                                                                                                      |
| `WS_BACKPRESSURE_POLICY`                       | no             | `drop_oldest` (default), `drop_newest`, or `block`                                                                                                                                                                                                                                                                                                   |
| `WS_LOG_SAMPLE_RATE`                           | no             | Default 0.001 (1 in 1000 messages logged); must be in [0, 1]                                                                                                                                                                                                                                                                                         |
| `INTERVAL_BA_ENABLED`                          | no             | Default `false`. `true` writes Interval B/A alerts to `interval_ba_alerts`                                                                                                                                                                                                                                                                           |
| `INTERVAL_BA_TICKERS_CSV`                      | no             | Default `SPY,SPXW,QQQ`. Which of the three handlers may alert                                                                                                                                                                                                                                                                                        |
| `INTERVAL_BA_RATIO_THRESHOLD`                  | no             | Default 0.75 (ask-side share of a bucket's premium)                                                                                                                                                                                                                                                                                                  |
| `INTERVAL_BA_PREMIUM_FLOOR`                    | no             | Default 250000 ($)                                                                                                                                                                                                                                                                                                                                   |
| `INTERVAL_BA_WINDOW_SEC`                       | no             | Default 300                                                                                                                                                                                                                                                                                                                                          |
| `INTERVAL_BA_MULTI_LEG_SHARE_MAX`              | no             | Default 0.5. Rejects a bucket when at least this share of its premium is multi-leg. The multi-leg `trade_code` list mirrors `api/_lib/multileg-codes.ts`, and a test fails if the two drift                                                                                                                                                          |
| `INTERVAL_BA_PUSH_CONFLUENCE_ONLY`             | no             | Default `true`. Only alerts with a cross-symbol confluence partner send a Web Push                                                                                                                                                                                                                                                                   |
| `VERCEL_NOTIFY_URL`                            | no             | Vercel `/api/push/notify` URL. Push is off unless this and the secret are set                                                                                                                                                                                                                                                                        |
| `INTERNAL_NOTIFY_SECRET`                       | no             | Shared with Vercel's variable of the same name                                                                                                                                                                                                                                                                                                       |
| `INTERNAL_METRICS_TOKEN`                       | no             | When set, `/metrics` requires a matching `X-Metrics-Token` header                                                                                                                                                                                                                                                                                    |
| `WS_LEASE_ENABLED`                             | no             | Default `true`. WS connection lease (deploy-overlap guard, see below). `false` bypasses it. When `true`, both KV vars below are required                                                                                                                                                                                                             |
| `KV_REST_API_URL`                              | cond.          | Upstash REST base URL, same store the main app uses. Required when `WS_LEASE_ENABLED=true`                                                                                                                                                                                                                                                           |
| `KV_REST_API_TOKEN`                            | cond.          | Upstash REST bearer token. Required when `WS_LEASE_ENABLED=true`                                                                                                                                                                                                                                                                                     |
| `WS_LEASE_TTL_MS`                              | no             | Default 30000. Lease TTL; lapses on its own if the holder dies without releasing                                                                                                                                                                                                                                                                     |
| `WS_LEASE_RENEW_MS`                            | no             | Default 10000 (ttl/3). Must be less than `WS_LEASE_TTL_MS` (checked at boot)                                                                                                                                                                                                                                                                         |
| `WS_LEASE_ACQUIRE_TIMEOUT_S`                   | no             | Default 60. Boot poll window before exiting non-zero for Railway to restart and retry (never force-steals)                                                                                                                                                                                                                                           |
| `WS_LEASE_KEY`                                 | no             | Default `uw-stream:ws-conn-lease`. The Upstash key the lease lives under                                                                                                                                                                                                                                                                             |
| `RAILWAY_ENVIRONMENT`, `RAILWAY_DEPLOYMENT_ID` | set by Railway | Sentry `environment` and `release`                                                                                                                                                                                                                                                                                                                   |

`config.py` also reads a local `.env` for its own fields. The vars marked
"process environment only", and the Railway ones, are not read from
`.env`.

## Local development

```bash
cd uw-stream
python -m venv .venv
source .venv/bin/activate            # Windows (Git Bash): source .venv/Scripts/activate
pip install -r requirements-dev.txt  # runtime deps + pytest/ruff; the image installs requirements.txt only
# create .env from the env table above; set WS_LEASE_ENABLED=false unless you
# also set both KV_REST_API_* vars
PYTHONPATH=src python -m main        # same as the image (ENV PYTHONPATH=/app/src); works on Windows too
# in another shell:
curl http://localhost:8080/healthz
curl http://localhost:8080/metrics | jq
```

`requirements.txt` pulls `tzdata` on Windows for the CT and ET time
zones. Use a separate UW token for local runs: UW's websocket docs say a
token connected from more than one machine at a time gets dropped
connections, so the production key here would knock production's sockets
off.

## Tests

```bash
cd uw-stream
pytest -k flow_alerts # one suite

# What CI's uw-stream Quality Gate runs on Python 3.12 (check-only: format drift fails it)
ruff check src/ tests/ conftest.py
ruff format --check src/ tests/ conftest.py
pytest --cov=src --cov-report=term-missing
```

## Deploy

Railway auto-deploys on push when `uw-stream/**` files change (see
`railway.toml`). Set env vars in the Railway dashboard before the first
deploy. `railway.toml` restarts the container only on a non-zero exit
(`ON_FAILURE`, max 10 retries) and leaves `healthcheckPath` unset (see
Health).

Schema is owned by `api/_lib/db-migrations.ts` and applied by
`migrateDb()`, which runs when the owner calls `POST /api/journal/migrate`
(or `POST /api/journal/init`). It does not run automatically on deploy.
Before enabling a new channel on Railway, ship its api/ migration and run
it, so the table exists when the daemon starts writing.

Ship a new channel's handler before adding its token to `WS_CHANNELS`.
The config rejects unknown tokens at boot, so adding the token first
crash-loops the build that is running.

(The legacy `sql/001_ws_flow_alerts.sql` file is kept for historical
reference only. The same DDL also lives as migration #108 in the api/
migration chain, and all schema changes go there.)

## Operational notes

- **Resubscribe on reconnect.** UW's server forgets joins on disconnect.
  The connector re-sends every join frame after each reconnect.
- **String-encoded numerics.** Every UW WS field that _could_ be a number
  arrives as a JSON string. Handlers cast at the boundary.
- **`flow-alerts` uses a hyphen** even though the docs URL is
  `flow_alerts`. Subscribe with the hyphen; `config.py` maps
  `flow_alerts` to it.
- **Backpressure.** Bounded `asyncio.Queue` per handler, plus the shared
  receive queue. The drop policy is configurable. Drops increment
  `handlers.<name>.drop_count` (and, upstream, `receive_queue_drops`) in
  `/metrics`; nothing pushes them to Sentry.
- **Disconnects.** Each dropped socket logs one line with the shard, the
  exception, both close frames, the underlying cause (with errno), the
  session length, frames received, time since the last frame, and both
  socket addresses. The token is scrubbed from it. A Sentry warning fires
  when reconnects in the last hour, across all shards, reach 5 per shard
  (30 with 6 shards). A temporary
  `ws-canary` Railway service (`scripts/ws-canary/`) is measuring which
  network hop resets these connections.
- **Single process.** One process holds every shard's connection. If one
  socket drops, only that shard's channels go quiet while it reconnects.
  If the process dies during market hours, all data goes dark until
  Railway restarts it. Acceptable for a personal trading tool, but worth
  knowing.
- **WS connection lease (deploy-overlap guard).** UW caps the token at 10
  websocket connections (per `src/ws_lease.py`). Production runs 6 sharded
  sockets (as of 2026-10-29); the lease module was sized for a planned ~8.
  The exposure is the Railway deploy handoff, where the new container
  boots while the old is still draining, so both briefly hold their
  sockets (12 > 10 today) and the new gen's joins get silently rejected.
  To prevent this, every boot acquires a single Upstash-backed TTL'd lease
  (`WS_LEASE_KEY`) BEFORE opening any socket: a new deploy waits for the
  old gen to release (or for the TTL to lapse) before connecting. On clean
  shutdown the lease is released only AFTER our sockets close, so the next
  gen never connects while ours are open. If acquire times out (a wedged
  old gen), the daemon exits non-zero and lets Railway restart + retry
  rather than force-stealing the lease (stealing would re-introduce the
  overlap). A confirmed mid-life loss of the lease routes into the normal
  graceful shutdown. Implementation in `src/ws_lease.py`; spec in
  `docs/superpowers/specs/uw-stream-ws-connection-lease-2026-06-03.md`.
