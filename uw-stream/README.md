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
three global channels. They run on 8 sockets: 6, plus 2 mirror sockets that
join the 86 `option_trades` channels a second time (see Architecture).

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
   sockets, then 2 mirror sockets (below), 8 in all:

   | Socket  | Channels                                                | Count |
   | ------- | ------------------------------------------------------- | ----- |
   | `conn0` | `option_trades:AAOI` … `option_trades:OKLO`             | 45    |
   | `conn1` | `option_trades:ORCL` … `option_trades:XOM`, 3 globals   | 44    |
   | `conn2` | the first 45 `gex_strike_expiry` (SPY, QQQ, SPX, NDX …) | 45    |
   | `conn3` | the other 43 `gex_strike_expiry`                        | 43    |
   | `conn4` | `net_flow:AAOI` … `net_flow:OKLO`                       | 45    |
   | `conn5` | `net_flow:ORCL` … `net_flow:XOM`                        | 41    |
   | `conn6` | mirror of `conn0`'s `option_trades` channels            | 45    |
   | `conn7` | mirror of `conn1`'s 41 `option_trades` channels         | 41    |

   `conn1`'s 3 globals are `flow-alerts`, `off_lit_trades` and
   `futures_trades`. With `WS_REDUNDANT_OPTION_TRADES=false` there is no
   `conn6` or `conn7`: the six above are the whole layout.

   Each connector reconnects with 1–60 s backoff (±20% jitter), resets
   the backoff only after a 60 s healthy session, re-sends every join
   after a reconnect, and re-joins any still-unacked channel every 60 s.

   **Mirror sockets.** UW drops 70–120 of our sockets per weekday and
   replays nothing after a drop, so the trades in each gap were lost. With
   `WS_REDUNDANT_OPTION_TRADES` on (the default), `channel_shards` appends
   mirror shards after the six: every per-ticker `option_trades:` channel
   again, chunked at the same cap, with no globals. The mirrors are the
   highest `conn` numbers, so `conn0`–`conn5` keep their channel sets and
   indexes. A trade then arrives twice, as identical frames, one per socket.
   `OptionTradesHandler.enqueue` drops the second copy by (trade `id`,
   `canceled` flag) before the queue: two generations of keys rotate every
   60 s on a monotonic clock, so a key is remembered for 60–120 s (about
   160k keys at the open). A payload with no usable `id` passes through to
   `_transform` unchanged. The three Interval B/A handlers inherit
   `enqueue`, so a duplicate frame cannot double-count their premium.
   `Settings()` fails at boot when the socket count, mirrors included,
   exceeds UW's 10 connections per token. `WS_REDUNDANT_OPTION_TRADES=false`
   is the kill switch: Railway redeploys with the six sockets and no
   dedupe, with no code change. Turn it off if the doubled `option_trades`
   frames make the receive or handler queues back up at the open.

   Known limits. The `subscribed` flag and the 60 s re-join are per channel
   name, not per socket, so one socket's ack hides the other socket's lost
   join: a mirror (or primary) that silently misses a join only loses its
   redundancy, and nothing alerts on it. If a handler queue is full and
   its backpressure policy evicts the first copy after its key was
   recorded, the second copy is dropped as a duplicate; that needs the
   overload the drop counters already report to Sentry.
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
     `write_count`, `lost_rows`, `dupes_dropped`, `single_copy`; zeroed from
     boot). `lost_rows` counts the rows of flushes that failed after the DB
     retries; ON CONFLICT dedup skips don't count. `dupes_dropped` counts the
     second copies of a trade that the mirror sockets deliver and the
     option-trade handlers drop before their queue. It is not backpressure,
     so it never reaches `drop_count` or the drop reporter. `single_copy`
     counts trades that only one socket delivered, once the trade's 2-minute
     window closes (so it lags by up to ~2 minutes). About half of them
     were missed by the primary, so the mirror saved them. Both stay 0 on
     every other handler, and on these while the kill switch is off. Each
     option-trade handler logs both, plus their change since its previous
     line, at info level about every 5 minutes (message
     `option_trades redundant-socket dedupe`), and never per frame. The
     shared handlers are named after
     their channel family (`option_trades`, `net_flow`,
     `gex_strike_expiry`), so one `handlers` row covers that family's
     per-ticker channels. Exception: `option_trades:SPY` / `SPXW` / `QQQ`
     get dedicated Interval B/A handlers with their own `handlers` rows,
     which the `option_trades` row does not include. Requests need an
     `X-Metrics-Token` header matching `INTERNAL_METRICS_TOKEN`; a missing
     or wrong header gets 401. While `INTERNAL_METRICS_TOKEN` is unset,
     every request gets 401 and the first one logs a warning. `/healthz`
     needs no header.
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
  `(contract, trade_id)` within each minute bucket.
- `futures_bars.symbol` holds the **root** (`'ES'`), so the many contract
  months on the wire are collapsed to **one contract per root per CME
  trade date** (a session runs 17:00 CT to 17:00 CT; the trade date is the
  Chicago date of the instant plus 7 h). It is decided once, from the
  previous session's volume, and stored in `futures_front_month`; the
  rule lives in `src/futures_front_month.py`. Its trade-date and
  decision cases run against the same fixture as the TypeScript twin
  (`api/__tests__/fixtures/futures-roll-cases.json`); the fixture's third
  list, `pickScheduledFront`, is TypeScript-only, because that is the REST
  minute builder and this handler folds both year spellings of a contract
  into one bar. The handler's own deduped tally of outright prints per
  (root, trade date, contract) is saved to `futures_contract_volume`
  (source `live`, only the contracts whose count rose) about once a minute,
  before a new date's decision is asked for, and once more on a clean
  shutdown (a crash loses at most the volume since the last save). A
  restart reloads it, so it never changes a decided session's contract.
  Every bar carries `futures_bars.contract`, the canonical name (`ESZ6`,
  also for `ESZ26`).
- **When the decision can't be had** (Neon unreachable at the 17:00 CT
  open), the session's minutes are gaps, logged as
  `kind="front_month_unknown"` at error level with the cause
  (`cause_kind`, `cause_err_type`). Each front-month database call is
  cut at 8 s, and a call that failed is not repeated for that root and
  date for 30 s, so an outage costs a flush one failed call and not a
  retry per root per flush. A call that times out also pauses every
  root's front-month calls for 30 s (the roots it skips name that timeout
  as the cause of their gaps), and the timed-out call itself waits 60 s,
  and 120 s after a second timeout in a row, so a hang confined to a few
  roots no longer blacks out the others. A tally that could not
  be saved or loaded holds back that root's next decision until it can. A
  failure that is not a Neon blip (a bad row, a rejected statement) is
  logged at error level, one line per root per minute, so it reaches
  Sentry; a blip stays a warning.
  A print for a trade date more than 3 days old never reaches the
  front-month path (`kind="stale_session_dropped"`).
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
| `WS_MAX_CHANNELS_PER_CONN`                     | no             | Default 45. Channels per socket (UW caps at 50). The socket count, mirrors included, must be 10 or fewer (UW's per-token cap) or the boot fails                                                                                                                                                                                                      |
| `WS_REDUNDANT_OPTION_TRADES`                   | no             | Default `true`. Kill switch for the mirror sockets (below). `false` restores the 6 sockets from before them and idles the dedupe, with no code change; a redeploy applies it                                                                                                                                                                         |
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
| `INTERNAL_METRICS_TOKEN`                       | cond.          | Required for `/metrics`: requests must send it in an `X-Metrics-Token` header. Unset, `/metrics` answers 401 to every request; the service still boots                                                                                                                                                                                               |
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
# in another shell, with INTERNAL_METRICS_TOKEN exported to the value in .env:
curl http://localhost:8080/healthz
curl -H "X-Metrics-Token: $INTERNAL_METRICS_TOKEN" http://localhost:8080/metrics | jq
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
  receive queue in front of the router. Drop policy is configurable. When
  a handler's batch fills while more is queued (a backlog, usually after a
  slow flush), it takes up to 5,000 queued rows into that one flush
  (`BACKLOG_BATCH_MAX`) instead of writing 500 per round trip. Every
  60 s the `drop_reporter` task (`src/drop_reporter.py`) sends one Sentry
  warning tagged `component=backpressure` for each queue that dropped
  payloads or lost flush rows since its last report. It gives the new
  amounts (`dropped`, `lost_rows`) and the running totals (`drop_total`,
  `lost_rows_total`). A quiet interval sends nothing. On shutdown the task
  sends one last report for the drops since its previous tick. The
  cumulative counters stay on `/metrics`.
- **Disconnects.** Each dropped socket logs one line with the shard, the
  exception, both close frames, the underlying cause (with errno), the
  session length, frames received, time since the last frame, and both
  socket addresses. The token is scrubbed from it. A Sentry warning fires
  when reconnects in the last hour, across all shards, reach 5 per shard
  (40 with 8 shards, 30 with the mirror sockets off). It fires once per
  incident: at most one an hour for the whole process
  (`_STORM_ALERT_WINDOW_S` in `src/connector.py`, the same hour the count
  covers), and a storm still going when the hour ends alerts again. A
  temporary `ws-canary` Railway service (`scripts/ws-canary/`) is measuring
  which network hop resets these connections.
- **What reaches Sentry.** Only explicit captures (`capture_exception`,
  `capture_message` in `src/sentry_setup.py`). The SDK's logging integration
  is set to `event_level=None`, so an error log line is a breadcrumb on the
  next event and never an event of its own: a failure that is logged at error
  level and must reach Sentry sends its own capture beside the log line (the
  throttled `rate_limited_log.error` does it for itself, once per window).
  Before 2026-11-13 each logged-and-captured failure filed two issues.
- **Shutdown drain.** On SIGTERM the daemon closes its sockets, releases
  the lease, then drains every handler at once. Each drain waits for an
  in-flight flush to finish, then writes what is left in its queue and
  batch in slices of up to 5,000 rows (`BACKLOG_BATCH_MAX`), one DB attempt
  each with no retry, all inside a 30 s deadline (`DRAIN_DEADLINE_S` in
  `src/handlers/base.py`). The deadline is hard: at 30 s the drain is
  cancelled and left to unwind, not waited for. If it hits, the rows not yet
  written are lost and a Sentry warning gives the counts (`lost_rows`); a
  consumer flush still running at that point is cancelled too, so those rows
  are neither written later nor counted again.
  Every other shutdown step has its own bound too
  (`_SHUTDOWN_STEP_TIMEOUTS_S` in `src/main.py`); a step that overruns is
  reported to Sentry (tag `step`) and the next one runs. Before the lease is
  released the daemon aborts any connector socket still open (a hung close
  handshake leaves one) and counts the frames left in the receive queue as
  dropped; the lease renewal stops first, so a drain longer than a renew
  interval is not read as a lost lease. The drop reporter sends a last
  report when it is cancelled, after the drains.
- **Draining time.** Railway SIGKILLs the old deploy `drainingSeconds`
  after SIGTERM (Railway's default is 0). It is 40, set in two places that
  must stay equal: `drainingSeconds` in `railway.toml`, and the
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` service variable on the Railway
  service. Railway marks config as code deprecated: existing
  `railway.toml` files keep working for legacy services until 2026-12-01
  (its docs, checked 2026-11-08), and after that the variable carries the
  setting. The shutdown bounds, a second `release_lease` bound (`_run`'s
  `finally` repeats that step), and Sentry's 2 s exit flush must fit under
  it (39.5 s of 40);
  `tests/test_handlers.py::test_drain_deadline_fits_railway_draining_seconds`
  checks the sum against `railway.toml`.
- **Single process.** One process holds every shard's connection. If one
  socket drops, only that shard's channels go quiet while it reconnects.
  An `option_trades` channel is the exception: its mirror socket keeps
  delivering, so the gap is covered unless both drop together. If the process dies during market hours, all data goes dark until
  Railway restarts it. Acceptable for a personal trading tool, but worth
  knowing.
- **Checking the mirror sockets.** After a deploy that has them on,
  `/metrics` should list `conn0` to `conn7` under `connections`, and the
  `option_trades` `dupes_dropped` should climb at about the rate of that
  handler's trades (the second copy of each) with `single_copy` a small
  fraction of it. At the open, `receive_queue_depth`, each handler's
  `queue_depth` and `drop_count`, and `receive_queue_drops` should look like
  the day before; if they climb, set `WS_REDUNDANT_OPTION_TRADES=false`.
  Like any push to `uw-stream/`, a deploy drops every socket for a few
  seconds, so do not push during market hours (08:30–15:00 CT).
- **WS connection lease (deploy-overlap guard).** UW caps the token at 10
  websocket connections (per `src/ws_lease.py`). Production runs 8 sharded
  sockets with the mirror sockets on (6 with them off); the lease module
  was sized for a planned ~8, and `Settings()` refuses to boot a layout
  over 10. The exposure is the Railway deploy handoff, where the new
  container boots while the old is still draining, so both briefly hold
  their sockets (16 > 10 today) and the new gen's joins get silently
  rejected.
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
