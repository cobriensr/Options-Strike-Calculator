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
     `reconnects_last_hour`, `receive_queue_depth`, `receive_queue_drops`
     and `receive_queue_hwm`, plus three keyed sections: `channels` (per WS
     channel joined, or echoed by UW, e.g. `net_flow:TSLA`: `subscribed`,
     `last_message_ts`), `handlers` (per handler queue, keyed by
     handler name: `queue_depth`, `drop_count`, `write_attempted`,
     `write_count`, `lost_rows`, `dupes_dropped`, `single_copy`, `filtered`,
     `flushes`, `flush_rows`, `flush_seconds`, `interval_flush_max_s`,
     `interval_batch_max`, `interval_queue_hwm`; zeroed from boot) and
     `sockets` (per shard, `conn0` to `conn7`: `frames`, `trade_frames`,
     `silences` and `twin`). The last six handler fields and
     `receive_queue_hwm` are the flush and high-water numbers, and `sockets`
     the per-socket counters, explained under Pipeline diagnostics below.
     `lost_rows` counts the rows of flushes that failed after the DB
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
     `option_trades redundant-socket dedupe`), and never per frame.
     `filtered` counts payloads a handler discarded before its queue
     because they can never become rows. Only `gex_strike_expiry` sets it,
     for frames whose expiry is not today's (ET): they are about 85% of what
     UW sends on that channel, and queued they filled the 50,000-slot queue
     and evicted today's frames. Like `dupes_dropped` it is not
     backpressure, so it never reaches `drop_count` or the drop reporter.
     The shared handlers are named after their channel family
     (`option_trades`, `net_flow`, `gex_strike_expiry`), so one `handlers`
     row covers that family's per-ticker channels. Exception:
     `option_trades:SPY` / `SPXW` / `QQQ` get dedicated Interval B/A
     handlers with their own `handlers` rows, which the `option_trades` row
     does not include. Requests need an
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
8. **Pipeline stats** (`src/pipeline_stats.py`): samples event-loop lag and
   DB pool use four times a second and logs one line a minute with the
   handlers' flush timing and queue high-waters, and each socket's frame
   counts and silences, which the connectors count (`src/socket_stats.py`).
   See Pipeline diagnostics.
9. **Stuck-socket watchdog** (`src/stuck_sockets.py`): every 5 s, finds a
   connected `option_trades` socket that has received no trade frame for
   60 s while its twin kept receiving, sends a Sentry alert and forces a
   reconnect of it. It also sends a Sentry alert, and forces a reconnect of each
   connected copy, when no trade frame has reached any copy of a trade feed for
   60 s inside the trade window. See Stuck trade sockets.

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

## Pipeline diagnostics

On 2026-11-13 trades landed in Neon 24 to 44 s late at every :x0 and :x5
minute. A slow Neon write, an exhausted connection pool and a blocked event
loop all look the same from outside. These numbers tell them apart. They are
logs and `/metrics` fields only: nothing here sends a Sentry event, except the
stuck-trade-socket alert and the silent-trade-feed alert (see Stuck trade
sockets, below).

### `/metrics` flush and high-water fields

Per `handlers` row:

- `flushes`, `flush_rows`, `flush_seconds`: cumulative. One flush is one
  `_flush` call, retries and backoff included; it counts whether it returned
  or raised, and a flush cut short by a cancel is not counted. `flush_rows`
  is the rows passed to `_flush`. For `futures_trades` that is trade prints
  (the batch passed to the write), not the bars written, like
  `write_attempted`. `flush_seconds` is the time spent inside those calls.
- `interval_flush_max_s`: the longest single flush since the last minute line.
- `interval_batch_max`: the most rows passed to one flush since the last
  minute line. A backlog take can exceed the normal batch size, up to
  `BACKLOG_BATCH_MAX` (5,000).
- `interval_queue_hwm`: the deepest the handler's queue got since the last
  minute line. `queue_depth` cannot show that peak: by the time anyone reads
  it the consumer has usually drained the queue.

At the top level, `receive_queue_hwm` is the deepest receive-queue depth the
router saw since the last minute line. It is not an exact instantaneous peak:
the router reads the depth after each frame it dispatches, and the connector
hot path is not instrumented, so a burst the router worked off between two
reads can have been deeper.

The `interval_*` fields and `receive_queue_hwm` are reset by the minute
line, so `/metrics` shows the values since the last line (at most a minute
and a bit), not since boot. Every other field is cumulative and never resets.

### The minute line

`run_pipeline_stats` (`src/pipeline_stats.py`) logs one line at every UTC
minute boundary, at info level, with the message `uw-stream pipeline minute`.
The line for a quiet minute is still sent, with an empty `handlers`: it is
the heartbeat, and it shows loop lag through the quiet hours. The first line
after a deploy covers only the part of the minute since boot. If the event
loop is blocked past one boundary the line only comes late: the labels still
run 12:34 then 12:35, with none missing. A label goes missing only when the
loop is blocked past two boundaries, and the late line then covers more than
a minute. A stall that straddles a boundary puts its lag on the line for the
minute that just ended: the reporter yields to the sampler once before it
logs.

If the log call or the line's own arithmetic raises, the pass changes
nothing: no baseline moves and no interval field resets. The next line then
carries both minutes (`flushes`, `rows` and `dropped` summed over the two,
the high-waters and maxima the larger of the two), and the first minute's
label is missing from the sequence.

| Field                            | Meaning                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `minute_utc`                     | ISO start of the minute the line reports.                                                                                                                                                                    |
| `loop_lag_max_s`                 | The longest the event loop kept the sampler waiting past its 0.25 s sleep (elapsed minus 0.25 s, never below 0). Near 0 is healthy; seconds mean something blocked the loop.                               |
| `loop_lag_over_1s`               | How many of those samples were 1 s or more.                                                                                                                                                                  |
| `pool_size_max`                  | Most connections open in the DB pool (its max is 10), sampled four times a second. `null` when the pool was never sampled.                                                                                   |
| `pool_size_min`                  | Fewest connections open at any sample in the minute. Below `pool_size_max` in the same minute means the pool changed size inside it: connections closed and reopened (or, just after a deploy, the pool grew). `null` when never sampled. |
| `pool_in_use_max`                | Most connections checked out (size minus idle) at any sample. A hold shorter than 0.25 s can fall between two samples. `null` when never sampled.                                                          |
| `receive_queue_hwm`              | As under `/metrics` above, for the minute.                                                                                                                                                                   |
| `receive_queue_dropped`          | Frames the receive queue dropped in the minute.                                                                                                                                                              |
| `handlers`                       | One entry per handler that had activity in the minute: a flush, a queue depth above 0, a new drop or a new filtered payload. Keyed by handler name.                                                          |
| `flushes`, `rows`, `flush_s`     | In a handler entry: flushes, rows passed to `_flush` and seconds spent in `_flush` during the minute (changes in the cumulative `/metrics` counters). Rows are prints for `futures_trades`.                |
| `flush_max_s`, `batch_max`       | In a handler entry: the longest single flush, and the most rows in one flush.                                                                                                                                |
| `queue_hwm`                      | In a handler entry: the deepest the handler's queue got.                                                                                                                                                     |
| `dropped`, `filtered`            | In a handler entry: payloads its queue dropped (backpressure), and payloads it discarded before the queue because they can never become rows.                                                                |
| `sockets`                        | One entry per registered shard (`conn0` to `conn7`), idle ones too, keyed by shard name. The next two rows are its fields; the section below explains how to read them.                                          |
| `frames`, `trade_frames`         | In a socket entry: frames received on that socket in the minute, and how many of them were option-trade frames (join acks and other channels are not).                                                           |
| `max_trade_gap_s`, `silences`    | In a socket entry: the longest gap between two trade frames on that socket, and how many gaps of 0.5 s or more there were.                                                                                       |

All seconds are rounded to 3 decimals.

How to read a late-data minute:

- A handler's `flush_max_s` is high, `loop_lag_max_s` is near 0 and
  `pool_in_use_max` is below the pool size: the write itself was slow, so
  Neon or the network. Check `pool_size_min` first (next bullet).
- A `pool_size_min` below `pool_size_max` in the same minute, once the pool
  is warm (not in the first minutes after a deploy, while it grows from its
  2 starting connections), is pool churn. asyncpg closes a pool connection
  idle for 300 s (its default `max_inactive_connection_lifetime`, which
  `src/db.py` leaves alone) and hands connections out last in, first out, so
  the ones only a burst uses expire and reconnect on the next burst. That
  fits lag at the `:x0` and `:x5` minutes. asyncpg counts only connected
  holders in both `get_size()` and `get_idle_size()`, so a flush waiting
  while asyncpg opens a new connection shows in neither pool number, and
  `pool_in_use_max` can stay low. The line then reads as "the write itself
  was slow" when the wait was the reconnect. `pool_size_max` alone hides the
  dip; `pool_size_min` shows it. It is a measurement, not a fix: nothing here
  changes a pool setting.
- `pool_in_use_max` equals the pool's maximum (10) in the same minute as a
  high `flush_max_s`: flushes waited for a free connection. The pool was
  exhausted.
- `loop_lag_max_s` of a second or more, with every busy handler showing slow
  flushes and deep queues in that one minute: the event loop was blocked, and
  the flush timing is a symptom of it.
- `queue_hwm` climbing toward the queue size with `batch_max` near 5,000: the
  handler was falling behind and taking a backlog each flush.

Read the lines from Railway with:

```bash
railway logs -s uw-stream --filter '"pipeline minute"' --json
```

Railway reads the phrase only with its double quotes, so they must reach it: the
single quotes are the shell's. Run the command from Git Bash or PowerShell 7.3+.
Windows PowerShell 5.1 strips the inner quotes it passes to a native exe, and the
filter then reaches Railway as two keywords.

Use the app's `time` field in each entry, not Railway's `timestamp`, and
`minute_utc` to join a line to Neon's per-minute data.

### Socket numbers and the twin-silence warning

Each `option_trades:<TICKER>` channel is joined on two sockets (`conn0` and
its mirror `conn6`, `conn1` and `conn7`), and the dedupe drops the second
copy of every trade. That hides a socket that missed trades the other one
delivered. On 2026-11-13, 345 trades reached Neon from only one of the two
sockets with no disconnect on either. These numbers name the socket that
went quiet. The connector counts them for every frame it receives
(`src/socket_stats.py`), with integer additions and one ring-slot update per
trade frame: no await, no log call and no extra clock read.

With `WS_REDUNDANT_OPTION_TRADES=false` there are no mirror sockets, so no
shard has a twin (`twin` is `null` everywhere) and no twin warning is logged;
the counts and silences still run.

- A **trade frame** is a frame for an `option_trades:` channel that is at
  least 100 characters long. Join acks share the prefix but are about 50
  characters, and up to 45 arrive in a burst after each connect, so they
  count in `frames` only.
- A **silence** is a gap of 0.5 s or more between two trade frames on one
  socket. A gap is never measured across a reconnect.
- The minute line's `sockets` entry for a shard has `frames`,
  `trade_frames`, `max_trade_gap_s` and `silences` for that minute. The
  counts reset after each line. A shard with no `option_trades` channels
  (`conn2` to `conn5`) shows zero trade frames and no gaps.
- `/metrics` has a top-level `sockets` block with one row per shard:
  `frames`, `trade_frames` and `silences`, cumulative since boot, and
  `twin`, the shard that joins the same `option_trades` channels (`conn0`
  and `conn6` are twins), or `null` when it has none.

`max_trade_gap_s` is the widest gap between two trade frames on that socket
in the minute, of any length. Only `silences` counts the gaps of 0.5 s or
more, whether or not the twin was streaming. A thin stretch of the market, or
a stall of the whole event loop, raises both on both sockets. Read them next
to the twin-silence warnings below, not alone.

Two cases the gap numbers handle in a fixed way:

- A gap that spans a minute boundary is credited to the minute whose trade
  frame ends it, because the gap is measured when that frame arrives.
- A gap that never ends is never counted: no silence and no warning, since
  both wait for the next trade frame. The sign is `trade_frames: 0` on one
  shard while its twin's is non-zero. `src/subscription_watchdog.py` checks
  only the `subscribed` flag, and `/healthz` uses the global
  `last_message_ts`, which the twin keeps fresh, so neither sees it. The
  stuck-socket watchdog does, after 60 s (see Stuck trade sockets, below).

**The warning.** When a gap of 0.5 s or more ends on a socket and its twin
received at least 10 trade frames inside that gap, the connector logs one
warning, `trade socket went quiet while its twin kept receiving`, on the
first trade frame after the gap. It is a log line only: nothing goes to
Sentry. Its fields are `shard`, `twin`, `gap_s`, `twin_trade_frames`,
`silence_start_utc`, `silence_end_utc`, `twin_window_clipped` and
`twin_also_silent`. The twin's frames are counted in the 0.1 s buckets
strictly inside the gap, leaving out the two buckets at its edges: after an
event-loop stall both sockets resume together and the twin's buffered frames
land in the resume bucket, so counting it would report a stall as one socket
going quiet. That narrows the false reports but does not end them. The two
sockets do not resume in the same bucket: the first socket's task drains its
buffered frames before the other's runs, and a bucket edge inside that drain
puts the first socket's frames strictly inside the second socket's gap. So
the warning also carries `twin_also_silent`. It is `true` when the twin was
itself silent during this gap: its latest silence ended after this gap
began, or its own gap is still open (its last trade frame is 0.5 s or more
before this frame). `true` points to a loop stall seen by both sockets rather
than a quiet socket: check the minute line's `loop_lag_max_s`. `false` is the
one-sided case the warning exists for. The flag is also set when the twin's
silence overlapped only part of this gap: only its start (the twin's latest
silence ended just after this gap began), only its middle, or only its tail
(the twin's last trade frame came 0.5 s or more before this frame, after this
gap began). If `loop_lag_max_s`
is near 0 in that minute's line while `twin_also_silent` is `true`, it was not
a stall: compare `gap_s` with the twin's `max_trade_gap_s` in the same minute.
The twin's counts are kept for 120 s; a longer gap sets `twin_window_clipped` to
`true`, and `twin_trade_frames` then covers only the last 120 s. The warning
is rate limited to one a minute per shard. Twin silences have no counter of
their own: `silences` counts every gap of 0.5 s or more, twin or not. The
rate limiter's `N occurrences suppressed` summary carries the extra
warnings, and only when a later warning lands after the window closes. If the
check itself fails it logs `twin-silence check failed` at error level, which
sends one Sentry event a minute per shard, and the receive loop carries on.

**Lost or only delayed?** The dedupe's own line, `option_trades
redundant-socket dedupe` (every 5 to 6 minutes under traffic), carries
`single_copy_interval`: the trades only one socket delivered since the
previous line. The running total is `single_copy` on `/metrics`. A trade
counts as a single copy once its 2-minute window closes, so a miss shows up
there up to about 2 minutes after the silence. The figure is per handler, not
per socket: the silence names the socket, and `single_copy_interval` says
whether anything was lost.

- A silence with a matching rise in `single_copy_interval` means trades were
  lost on that socket: its twin delivered them and it did not.
- A silence with no rise means the socket was only delayed: its frames came
  late, the dedupe saw both copies of every trade, and nothing was lost.

### Stuck trade sockets

The silence warning above waits for the next trade frame to end a gap, so a
trade socket that stays connected but never delivers another trade frame
raises nothing. The stuck-socket watchdog (`run_stuck_socket_watchdog`,
`src/stuck_sockets.py`) covers that. Every 5 s it asks
`socket_stats.find_stuck` which shards are stuck. A shard is stuck when all
four hold:

- it has a twin;
- it and its twin are both connected (`state.connections` says so). A twin
  that is down is not carrying the trades while this socket reconnects;
- it has had no trade frame for 60 s, counted from its last trade frame or,
  if the connection has had none yet, from the connection's start;
- its twin received at least 100 trade frames in those 60 s.

| Constant                      | Value | Meaning                                                                   |
| ----------------------------- | ----- | ------------------------------------------------------------------------- |
| `STUCK_S`                     | 60 s  | The open gap that makes a shard a candidate.                              |
| `STUCK_TWIN_MIN_FRAMES`       | 100   | Trade frames the twin must have in the last `STUCK_S`.                    |
| `STUCK_CHECK_INTERVAL_S`      | 5 s   | The check period.                                                         |
| `FORCED_RECONNECT_COOLDOWN_S` | 300 s | At most one forced reconnect per shard in this time, across incidents and across both rules (stuck shard and silent feed), and at most one Sentry event per shard or group. |

The first two are in `src/socket_stats.py`, next to the test; the other two
are in `src/stuck_sockets.py`. The quietest minute at lunch on 2026-11-13
carried 3,938 trades for conn0's half of the tickers and 6,407 for conn1's, about
40 times the twin minimum, so a normal lunch lull does not reach it.

For each stuck shard the watchdog keeps one **incident**, from the check that
first finds the shard stuck until a trade frame arrives:

1. **The alert.** One Sentry warning, `uw-stream trade socket stuck`, tagged
   `component=stuck_sockets`. Its extras are `shard`, `twin`, `gap_s` (the
   shard's open gap), `twin_trade_frames` (the twin's frames in the last 60 s),
   `last_trade_utc` (the shard's last trade frame, or `null` if its connection
   has had none) and `forced_reconnects` (forced reconnects so far in this
   incident: `0`, unless the alert floor held this alert back, in which case it
   goes out after the first forced reconnect and reports 1 or more). It means
   the shard has been up and silent for a minute while its twin kept receiving:
   the backup for that half of the tickers is gone, and the dedupe is passing
   the twin's copy alone.
2. **The forced reconnect.** Straight after the alert the watchdog calls
   `Connector.force_reconnect`, which aborts the socket. The connector then
   reconnects and re-joins every channel, as for any drop (about 2 s), and the
   twin, which `find_stuck` checked is connected, carries every trade
   meanwhile, so a false alarm costs nothing. Each one logs `forcing reconnect
   of a stuck trade socket` at warning level. A shard gets at most one per
   300 s, whatever incident it is in and whichever rule asks (the silent-feed rule
   below shares the cooldown): at most 12 an hour per stuck shard. They
   count in `reconnects_last_hour` and towards the reconnect storm alert like
   any other drop. The storm alert fires at 40 an hour with 8 shards, and the
   forced reconnects alone can reach that: 12 an hour for one stuck shard, 24
   with one stuck shard in each pair, and up to 48 if all four trade shards
   (`conn0`, `conn1`, `conn6`, `conn7`) are each stuck for part of the hour, a
   pair's two sockets in turn. The 48 is over the 40, so in that case the storm
   alert is expected, and it is telling the truth.
3. **The escalation.** If the shard is found stuck again at a later check and
   the incident has forced a reconnect, the watchdog sends one more event for
   the incident, an error: `uw-stream trade socket still stuck after a forced
   reconnect`, with the same extras (`forced_reconnects` is then 1 or more). It
   arrives about 5 minutes after the first alert, not about 1: the alert floor,
   below, explains why. It means the reconnect did not help: the new connection
   also went 60 s with no trade frame while its twin received at least 100 (or
   the abort did not end the old connection). A fresh connection that has not
   been quiet for 60 s yet is not escalated. The service keeps forcing a
   reconnect every 300 s but sends no further event for the incident. A redeploy
   is the next move if nothing else explains it. An incident that has not yet
   forced a reconnect (the cooldown from an earlier incident is still running)
   does not escalate.
4. **The end.** When the shard's last trade frame is later than the incident's
   start, the incident ends and the watchdog logs `stuck trade socket
   recovered` with `shard`, `duration_s` (to the check that saw the trade frame,
   so up to 5 s late) and `forced_reconnects` (in this incident). A later stick
   opens a new incident, which sends a new alert unless the alert floor holds it
   back. The incident also ends when the trade window opens, if it is older than
   60 s (see The trade window, below), and not at the close.

**The alert floor.** A shard gets at most one Sentry event, the alert or the
escalation, per 300 s. That bounds Sentry at 12 an hour per shard. Without it,
a socket that delivers one trade frame between 60 s silences would open a new
incident, and send a new warning, about every 65 s: 55 an hour. An event the
floor holds back is logged instead, as `stuck trade socket alert held back`,
with the event it would have been (`event`), the shard's numbers and
`since_last_alert_s`, once per incident and event. A held-back event stays due,
the alert and the escalation alike: it goes out at the first check after the
floor lifts at which the shard is found stuck, if the incident is still open. So
a stick that begins within 300 s of an earlier alert still reaches Sentry, and
one that ended first sends nothing. The alert goes first and the escalation
waits behind it. In the usual run the escalation therefore follows the alert by
about 5 minutes, not about 1: the first 60 s after a forced reconnect are always
inside the floor. The floor does not limit the forced reconnects, which have
their own 300 s cooldown.

**Who gets the email.** Every Sentry event tagged `component=stuck_sockets` (the
stuck-shard alert and escalation, the silent-feed alert and escalation, and the
watchdog's own `check failed` errors) emails the owner through Sentry Alert
6345235, at most once per issue per 5 minutes. The project's high-priority rule
(3176627) cannot do it alone: it emails nobody for a repeat on an issue that is
already open.

The `forced` field on the disconnect line (`WS connection unavailable`, `WS
transport error` and the clean-close line) is the reason the watchdog gave for a
drop it asked for, and `null` for every other drop. It has two values:
`stuck_trade_socket` (the stuck-shard rule above) and `silent_trade_feed` (the
silent-feed rule below). Leave the lines with any non-null `forced` out of any
statistic on genuine drops, such as the RST and FIN counts.

A pass is skipped when its own sleep overran by 1 s or more
(`LOOP_LAG_FLAG_S`). After a loop stall the first socket to resume drains its
backlog before its twin's task runs, so the twin can look stuck for one pass.
The minute line's `loop_lag_max_s` shows the stall.

On shutdown `main._shutdown` cancels the watchdog, and waits for it to stop,
before it cancels the connectors. A cancelled connector leaves its shard marked
connected with its last trade frame frozen, so a watchdog still running would
find a quiet socket stuck while the service is closing it.

Each stuck shard's handling, each trade group's check (below) and each pass is
guarded on its own: a failure logs `stuck-socket check failed` at error level,
one Sentry event a minute per shard or group, and the ones after it and the loop
carry on. A forced reconnect only acts while the connector's receive loop is
running, so a drop the server started is never labelled `forced`. A call that
does nothing for that reason is not counted as a forced reconnect: no log line,
no count and no cooldown, and the next pass that finds the shard stuck tries
again. Read the lines with:

```bash
railway logs -s uw-stream --filter '"trade socket"' --json
railway logs -s uw-stream --filter '"option trades"' --json
railway logs -s uw-stream --filter '"silent trade feed"' --json
railway logs -s uw-stream --filter '"check failed"' --json
```

Railway reads a quoted phrase as a substring and a bare word as a keyword, so the
double quotes must reach it: the single quotes are the shell's. Run the commands
from Git Bash or PowerShell 7.3+. Windows PowerShell 5.1 strips the inner quotes it
passes to a native exe, and each filter then reaches Railway as separate keywords.
Each filter is a substring of the lines it is for. Every Sentry event is also
written to the log as `<event> (context=...)`, at the level the event is filed at
(an error event is an ERROR line), so the event lines are among the matches.

- `"trade socket"` catches every Task 6 line: `uw-stream trade socket stuck`,
  `uw-stream trade socket still stuck after a forced reconnect`, `forcing
  reconnect of a stuck trade socket`, `stuck trade socket recovered`, `stuck
  trade socket alert held back` and `stuck trade socket incident ended by the
  trade window`. It also catches the older twin-silence warning, `trade socket
  went quiet while its twin kept receiving`.
- `"option trades"` catches every Task 7 and Task 8 event and state line: `option
  trades silent on every copy` (and its `uw-stream` Sentry event), `uw-stream
  option trades still silent after a forced reconnect`, `option trades silent
  alert held back`, `option trades resumed` and `option trades silent incident
  ended by the trade window`.
- `"silent trade feed"` catches the one line the others miss, Task 8's `forcing
  reconnect of a silent trade feed`, one per shard per forced reconnect.
- `"check failed"` catches the guard lines neither of the others does:
  `stuck-socket check failed` and `trade-window check failed`, and the older
  `twin-silence check failed`.

#### Every copy of a trade feed silent

The comparison above cannot see both copies of a feed stop at once (each one's
twin then shows no trade frames), nor a deployment with no twins
(`WS_REDUNDANT_OPTION_TRADES=false`). `/healthz` cannot either: it uses the
global last-message time, which the GEX and net-flow sockets keep fresh. So the
same pass also watches each **trade group**: a primary trade shard with its twin
(`conn0` with `conn6`, `conn1` with `conn7`), or, with no twins, each trade
shard alone. A trade shard is a connector with any `option_trades:` channel.

For each group the watchdog keeps the time of the latest trade frame seen on any
of its sockets, starting at the group's first pass. It keeps it itself, not on
the sockets, because a reconnect clears a socket's last trade frame. It reads the
sockets once per check, so the time is exact to within one check (5 s): a trade
that arrives and is then cleared by a reconnect of every socket of the group
before the next check is missed, and the alert can come up to 5 s early. A group is
**silent** when the trade window is open and that time is `GROUP_SILENT_S` (60 s)
or more ago. The lunch lull on 2026-11-13 never came near it: its quietest
minute carried 3,938 trades for conn0's half of the tickers. At the first silent
pass the watchdog opens an incident:

- One warning log line, `option trades silent on every copy`, and one Sentry
  error with the same text, `uw-stream option trades silent on every copy`,
  tagged `component=stuck_sockets`. Its extras are `shards` (the group's
  sockets), `connected` (each one's connected flag, so `false` means a socket
  that is down and reconnecting, `true` on both means UW is sending nothing or
  both lost their joins), `since_last_trade_s` (counted from the watchdog's
  first pass if no trade has arrived since it started), `twins_enabled` and
  `forced_reconnects` (forced reconnects so far in this incident: `0` on an event
  that goes out in the opening pass, since the event goes first). Not every
  silence is a fault: a market-wide circuit-breaker halt stops the trades on every
  copy for real, so check for one before looking at the sockets.
- **The forced reconnect.** At every check while the incident is open, the
  opening pass included, the watchdog calls `Connector.force_reconnect` on each of
  the group's shards that is connected (`connected` is `true`), unless that shard
  was forced within 300 s. That cooldown is per shard and shared with the
  stuck-shard rule above: a shard gets at most one forced reconnect per 300 s
  whichever rule asks. Both copies are forced in the same pass: the feed is silent
  on both, so nothing is lost during the reconnect (about 2 s). The connector
  reconnects and re-joins every channel, as for any drop, and the disconnect line
  carries `forced: "silent_trade_feed"`. Each one logs `forcing reconnect of a
  silent trade feed` at warning level, with `group`, `shard`,
  `since_last_trade_s` and `forced_reconnect_number` (in this incident). A shard
  that is not connected is skipped: its connector is already reconnecting it. A
  call that does nothing (the connector's receive loop is not running) leaves no
  line, no count and no cooldown, and the next pass tries again. A call that raises
  starts the cooldown but is not counted or logged as a forced reconnect: the
  group's guard logs `stuck-socket check failed` (Sentry event, tagged
  `component=stuck_sockets`), and the group's other shard is tried on the next pass.
  With `WS_REDUNDANT_OPTION_TRADES=false` each trade shard is its own group, so a
  silent socket is reconnected too, which the stuck-shard rule never does. The
  incident counts its forced reconnects in `forced_reconnects`.
- **The cadence** is the stuck-shard rule's: once per shard per 300 s while the
  feed stays silent, with no cap, so recovery comes within 5 min of the cause
  clearing. One silent group makes 2 shards x 12 = 24 forced reconnects an hour.
  Both groups silent (a UW-wide trade outage) make 48, over the reconnect storm
  alert's 40 an hour, so the storm alert also fires after about 50 minutes of a
  full outage. There is no env var and no kill switch: `WS_REDUNDANT_OPTION_TRADES=false`
  does not turn this off, and a redeploy of the previous commit does.
- **The escalation.** If the incident is still open at a check 60 s
  (`GROUP_SILENT_S`) or more after its first forced reconnect, the watchdog sends
  one more event for it, an error: `uw-stream option trades still silent after a
  forced reconnect`, tagged `component=stuck_sockets`, with the same extras as the
  first event (`forced_reconnects` is then 1 or more). It means the fresh sessions joined and still delivered no trade
  for 60 s, so the cause is not on our sockets: a UW-side fault, a market-wide
  halt, or a holiday missing from both calendars. A redeploy would do what the
  forced reconnect already did, so it is not the next step: check for a halt and a
  holiday, then UW's side. With no forced reconnect yet (no shard was connected,
  or each call did nothing) it waits. The first event goes first and the
  escalation waits behind it.
- The incident ends when any socket of the group receives a trade frame, or when
  the trade window changes. Forcing stops with it, so nothing is forced outside the
  window. The watchdog logs `option trades resumed` with `group`, `shards`,
  `duration_s` (to the check that saw the trade, so up to 5 s late) and
  `forced_reconnects`.
- The alert floor applies, with its own clock per group: at most one Sentry event
  per group per 300 s, the first event and the escalation alike. A feed that leaks
  one trade frame between 60 s silences would otherwise send one about every 65 s.
  A held-back event is logged once as `option trades silent alert held back`, with
  the event it would have been (`event`), the group's numbers and
  `since_last_alert_s`, and the incident is open all the same. It stays due: it
  goes out at the first check after the floor lifts, if the feed is still silent.
  A silence that ended first sends nothing. With a first force at the opening, the
  escalation is due 60 s later and goes out when the floor lifts, about 5 min after
  the first event, in the same pass as the second forced reconnects.

**The trade window** is `market_calendar.in_trade_window` (`src/market_calendar.py`,
pure): a trading day (Monday to Friday, not a NYSE closure) from 09:31 ET up to,
not including, one minute before the close, which is 16:00 ET or 13:00 ET on an
early-close day. The minute after the open lets trading start. The minute before
the close stays clear of the equity options' 16:00 close, after which conn0's
half has no trades. Outside it nothing alerts and nothing is forced, and the
groups' times keep being tracked, so a feed silent since the evening before
alerts, and its sockets are reconnected, on the first pass after the open.

When the window changes, open incidents end with one log line each. Both kinds
of line carry `shard` (stuck socket) or `group` (silent feed), `window` set to
`opened` or `closed`, `duration_s` (the incident's age at the pass that ended it)
and `forced_reconnects` (the forced reconnects the incident made):

- A silent-feed incident ends on either change: `option trades silent incident
  ended by the trade window`.
- A stuck-socket incident ends only when the window opens, and only if it is
  older than 60 s: `stuck trade socket incident ended by the trade window`. It
  otherwise ends only when a trade frame arrives, so one for a socket that stays
  stuck through the close would carry overnight, and the next session would start
  with no new alert. The open ends it, and the stick alerts afresh. One that began
  in the minute before 09:31 is part of this session and is left alone, so it
  keeps its escalation.
- A stuck-socket incident is left alone at the close because the twin keeps
  streaming for 15 minutes after it (the index options trade to 16:15 ET). Ending
  it there would find the shard stuck again in the same pass and send a second
  pair of events, "stuck" and, 5 minutes later, "still stuck".

The stuck-socket checks themselves do not depend on the window, so a wrong
calendar cannot switch them off. If reading the window fails, the pass logs
`trade-window check failed` at error level (one Sentry event a minute), skips the
silent-feed check and runs the stuck-socket checks as usual; the change is
retried on the next pass.

**The calendar** is a copy. The daemon cannot import TypeScript, so
`src/market_calendar.py` holds `MARKET_CLOSED_DATES` and `EARLY_CLOSE_DATES` as
copied from `src/data/marketHours.ts`, and `tests/test_market_calendar.py` reads
that file and fails when the two differ. It fails, it does not skip, when the file
is missing. The uw-stream CI job checks out the whole repository, so the test can
read it there. Edit both files together when a year's holidays are added. A
comment in `marketHours.ts` says so.

**Not covered:**

- The non-trade sockets (`conn2` to `conn5`): nothing alerts when they go quiet.
  The minute line's per-socket frame counts and the subscription watchdog are
  what there is.
- A feed that stops outside the trade window.
- A holiday that is in neither calendar. The window reads it as a trading day,
  so the alert fires once per trade group (two events with twins), with
  `connected` true on both sockets, and then the escalation, and the trade
  sockets are reconnected every 5 minutes all day: 48 forced reconnects an hour, as
  in a full outage. The calendar runs through 2028. The TypeScript
  file's own test fails once its last listed holiday is under 60 days out, and
  the parity test then carries the update across.

## Operational notes

- **Resubscribe on reconnect.** UW's server forgets joins on disconnect.
  The connector re-sends every join frame after each reconnect.
- **Connect logs.** A connect logs one line per shard, not two per channel.
  Railway drops a replica's log lines past 500 a second, and the
  `sent join frame` and `channel ack received` lines of about 250 channels
  landed inside one second (drops reported 2026-11-11, 11-13 and 11-14). Both
  are debug lines now, which production does not emit (the logger is at
  INFO). Each connector logs `shard joined` (info) with `shard`, `channels`,
  `acked` and `elapsed_s` once all its channels are acked. If some are still
  unacked 30 s after the joins began (the wait before the re-join pass), it
  logs `shard join incomplete` (warning) with the same fields and `unacked`,
  the name of each such channel. That covers a join UW never answers, a lost
  one and one UW refuses with an error frame. The watchdog still alerts on a
  channel that stays unsubscribed. `acked` reads the same per-channel-name
  flag as the re-join pass, so the mirror sockets' limit above applies to it
  too, in both directions. A twin that resets the shared flag after this
  socket's ack can make this shard name a channel in `unacked` that its own
  socket acked. That is harmless: the re-join pass sends it again on this
  socket. Two gaps in what the line reports:
  - Recovery is not logged. After a `shard join incomplete`, the ack of a
    re-sent join is a debug line. To see that the channels came back, read
    `subscribed` on `/metrics`, or note that the next minute's
    `re-sending joins for stuck channels` warning does not come.
  - A session that drops before its last join is acked, and before the 30 s
    run out, logs no join line, neither one. That includes a drop the
    stuck-socket watchdog forces. The only record of how far it got is the
    disconnect line, with `session_s` and `frames`.
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
  session length, frames received, time since the last frame, both
  socket addresses, and `forced` (the reason when the stuck-socket watchdog
  dropped the socket on purpose, `stuck_trade_socket` or `silent_trade_feed`,
  `null` otherwise). The token is scrubbed from
  it. A Sentry error fires
  when reconnects in the last hour, across all shards, reach 5 per shard
  (40 with 8 shards, 30 with the mirror sockets off). It fires once per
  incident: at most one an hour for the whole process
  (the connector reads `RECONNECT_HORIZON` in `src/state.py`, the horizon the
  count covers, so the two cannot differ), and a storm still going when the
  hour ends alerts again. A second incident inside that hour
  is not announced; its drops still log and show in `reconnects_last_hour`. A
  temporary `ws-canary` Railway service (`scripts/ws-canary/`) is measuring
  which network hop resets these connections.
- **What reaches Sentry.** Four sources:
  - the service's explicit captures (`capture_exception`, `capture_message`
    in `src/sentry_setup.py`);
  - ERROR records of the `websockets` and `asyncio` loggers, through an
    `EventHandler` that `init_sentry` attaches to each (a failed keepalive
    ping, `unexpected internal error`, `parser failed`, `Exception in
    callback`, `Task exception was never retrieved`);
  - `AioHttpIntegration`, for an exception the health handlers don't catch;
  - `ExcepthookIntegration`, for an uncaught exception.

  The other default integrations add breadcrumbs, not events (the service
  starts no threads of its own for `ThreadingIntegration` to report). The
  service's own error log lines are not events: the SDK's logging integration
  is set to `event_level=None`, so one is a breadcrumb on the next event. A
  failure that is logged at error level and must reach Sentry sends its own
  capture beside the log line (the throttled `rate_limited_log.error` does it
  for itself, once per window). Before 2026-11-13 each logged-and-captured
  failure filed two issues.
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
