---
status: Approved by owner 2026-11-13 (build); deploy timing to confirm
---

# uw-stream: subscribe the option trade channels on two sockets

## Goal

Stop losing option trades when a websocket drops. Every `option_trades:<TICKER>` channel is joined on a second set of sockets, and the handler drops the second copy of each trade by its trade id, so a drop on one socket loses nothing while the other is up.

## Why

uw-stream drops about 70–120 times per weekday (1,072 drops from 10-29 to 11-13). The causes are outside our code: resets on the Railway↔Cloudflare path and closes from UW's side. Evidence is in the memory note `project_uw_stream_disconnects_2026_10_28`. Each drop costs about 1.8 s on one socket (11-12: 82 drops, 157 socket-seconds), and UW doesn't replay, so those trades are gone. They also feed fire detection.

How much it saves: from 10-29 to 11-13, 60–65% of drops on the two trade sockets had no other socket dropping within ±2–3 s. A mirror would have covered those gaps completely. The rest are clustered drops that a mirror on the same path may share.

## Design

1. **Mirror shards (`src/config.py`).** A new setting, `ws_redundant_option_trades: bool = True` (env `WS_REDUNDANT_OPTION_TRADES`).
   - It is a deploy-free kill switch. If the doubled trade frames make the daemon fall behind at the open, turning it off restores today's six sockets with no code change.
   - When it's on, `channel_shards` appends mirror shards *after* the existing ones. They hold only the per-ticker `option_trades:` channels, chunked at the per-connection cap, with no globals.
   - Existing shards keep their indexes and channel sets, so `conn0`–`conn5` still mean what the README says, and the mirrors are `conn6` and up.
   - Today that is 8 sockets against UW's cap of 10 per token. Add a test that the shard count stays ≤ 10, and fail at `Settings()` if it doesn't.
2. **Dedupe (`src/handlers/option_trades.py`).** `OptionTradesHandler.enqueue` drops a payload whose key was seen in the last 60–120 s, before it reaches the queue.
   - The key is `(payload["id"], canceled flag)`. Two copies of one trade are identical frames. Keying on the canceled flag too keeps today's behaviour if UW ever sends a cancel under the same id (the DB already ignores it via `ON CONFLICT (ws_trade_id)`; in-memory consumers still see it).
   - Store two generations of `dict[key, count]`, rotated lazily on a 60 s monotonic clock. No timer task. Memory at the open is about 1,300 trades/s × 120 s, around 160k keys.
   - A payload with no `id` passes through unchanged, so `_transform` rejects and logs it as today.
   - The Interval B/A subclasses (SPY, SPXW, QQQ) inherit this. They aggregate in memory, so a duplicate that got through would double-count premium. Test it.
3. **Counters.** Keep the counters per handler and expose them where the handler's drop counters already go (`/metrics` through `state`):
   - `dupes_dropped`;
   - `single_copy`: keys in a rotated-out generation seen once, meaning one socket missed that trade. About half of these are trades the mirror saved.

   Log both every 5 minutes, at info level. No per-frame logging.
4. **Known edge, documented not fixed.** If the handler queue is full and `drop_oldest` evicts the first copy after it was marked seen, the second copy is dropped as a duplicate. That only happens under overload, which the drop counters already report to Sentry.

## Not in scope

- No source-socket attribution and no per-socket silence watchdog. A silently unsubscribed mirror only loses redundancy; follow-up if needed.
- No mirroring of `futures_trades`, `flow-alerts`, `off_lit_trades`, `net_flow`, `gex_strike_expiry`. Futures bars would double-count without their own dedupe.
- No TypeScript port. The owner put it on hold until the drop tests finish.

## Files (one phase, ≤ 5 files)

- `uw-stream/src/config.py`: setting, mirror shards, cap check.
- `uw-stream/src/handlers/option_trades.py`: dedupe and counters (and the `/metrics` hook if it lives here).
- `uw-stream/tests/`: config shard tests, plus dedupe tests including an Interval B/A no-double-count case.
- `uw-stream/README.md`: shard table (8 sockets), the kill switch, the counters.

If `/metrics` exposure needs `src/state.py` or `src/health.py`, that is the 5th file; README can't drop, so fold the tests into one file.

## Acceptance

- Unit tests cover:
  - mirror shards on and off;
  - no globals in mirrors;
  - existing shard sets unchanged;
  - the 10-socket cap;
  - dedupe drop, distinct ids, the same id with a different canceled flag, rotation forgetting old keys, and a missing id passing through;
  - an Interval B/A duplicate frame not changing the aggregate.
- A microbenchmark (a test or a one-off in the report) of the cost per duplicate frame through `enqueue`. Report it in µs.
- `npm run review` green (the commit gate) and the uw-stream pytest suite green.

## Deploy

A push to `main` redeploys uw-stream on Railway, which drops all sockets for a few seconds. Never push during market hours (8:30–15:00 CT). Before the open, the first real load test is the open itself. After the close, it goes live the next session. The owner picks.

After deploy, check:
- `/metrics` and logs show 8 connections;
- the counters are moving;
- the receive and handler queue depths and the drop counters look like yesterday's at the open.
