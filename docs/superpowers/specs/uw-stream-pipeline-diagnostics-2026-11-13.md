---
status: Approved by owner 2026-11-13 ("yeah lets go"); deploy after 15:00 CT
---

# uw-stream: GEX pre-queue filter and pipeline diagnostics

## Goal

Stop the `gex_strike_expiry` queue overflowing on frames it throws away anyway. Also record, per handler, minute and socket, the numbers that explain the 2026-11-13 problems: how long each database write takes, whether the event loop stalled, how busy the DB pool was, and which websocket went quiet.

## Why

The evidence is in the memory note `project_uw_stream_disconnects_2026_10_28`, under "11-13 session result".

1. **GEX queue drops** (Sentry SENTRY-EMERALD-DESERT-M0, since 11-12):
   - `GexStrikeExpiryHandler` queues every expiry UW sends. About 85% of frames aren't today's expiry, and `_transform` rejects them only after they come off the queue (`src/handlers/gex_strike_expiry.py:132`).
   - Bursts of 60–78k frames in 10 s, against flushes that drain about 1.4k/s, overflow the 50k drop-oldest queue.
2. **Trades landing late at five-minute marks:**
   - From 8:49 to about 9:30 CT on 11-13, the slowest `ws_option_trades` rows at every :x0/:x5 minute took 24–44 s to land. On 11-12 the same windows stayed at about 4 s or less.
   - Inserts paused 4–5 s, then caught up in 5,000-row batches.
   - Today the service records none of: flush duration, event-loop lag, DB pool use, queue high-water. So a slow database, a blocked event loop, an exhausted pool and plain volume can't be told apart.
3. **345 trades seen on only one socket** (9:09–9:14 CT, no disconnect). The most likely cause is one socket silently missing 1–2 s of frames. The service doesn't count frames per socket, so it can't say which socket went quiet.

## Global constraints

- Python 3.12 and uw-stream's existing patterns:
  - `log` and `rate_limited_log` from `logger_setup`, with fields in `extra=`;
  - counters in `state`;
  - `/metrics` in `health.py`.
- **Hot paths stay cheap.** This covers the connector receive loop, `Handler.enqueue` and the router loop:
  - no new `await`, and no log call per frame;
  - per-frame work is integer bumps, one compare, and at most one clock read the code already makes.
- **No new env vars** (R7). Thresholds are module constants, with the values below.
- **The new diagnostics are logs and `/metrics` only.** No new Sentry events.
- **Every new dict is keyed by a closed set:** handler names or shard names (R1-style bound).
- **Tests never open a network socket or a database.** The uw-stream conftest blocks both. Mock at the module boundary (R3), and cover failure paths (R4).
- **Gate before every commit:**
  - `ruff check` and `ruff format --check` on `uw-stream/`;
  - the uw-stream pytest suite;
  - `npm run review` from the worktree root (the commit gate seals the staged files).
  - The venv is at `F:/dev/strike-calculator/uw-stream/.venv/Scripts/python`; run pytest from `uw-stream/`.

## Thresholds / constants

| Name | Value | Where | Meaning |
|---|---|---|---|
| today-date cache | refresh at most once per 1 s (monotonic) | `gex_strike_expiry.py` | so the hot path is a string compare |
| `SAMPLE_INTERVAL_S` | 0.25 | `pipeline_stats.py` | loop-lag and pool sampler period |
| `LOOP_LAG_FLAG_S` | 1.0 | `pipeline_stats.py` | a lag sample at or over this counts in `loop_lag_over_1s` |
| report cadence | each UTC minute boundary | `pipeline_stats.py` | one line per wall-clock minute, so lines join Neon's per-minute data |
| `SILENCE_S` | 0.5 | `socket_stats.py` | a gap between trade frames on one socket at or over this counts as a silence |
| `TWIN_MIN_FRAMES` | 10 | `socket_stats.py` | the twin must have received at least this many trade frames inside the gap for a warning |
| bucket width | 0.1 s | `socket_stats.py` | trade-frame count ring resolution |
| ring span | 1,200 buckets (120 s) | `socket_stats.py` | longest gap the twin count covers; longer gaps report `twin_window_clipped: true` |

## Not in scope

- Tagging each frame with its source socket, or splitting the dedupe's `single_copy` by socket.
- Logging the Cloudflare ray/colo or the public egress IP at connect.
- Memory gauges, or the `interval_ba` `_ticks` sweep.
- Changing batch sizes, the DB pool size or queue sizes, or fixing the five-minute stall itself. This change measures it first.
- A Sentry alert for socket silence.
- The TypeScript port (on hold).

## Task 1: GEX filter before the queue

**Files** (5):
- `uw-stream/src/handlers/gex_strike_expiry.py`
- `uw-stream/src/state.py`
- `uw-stream/src/health.py`
- `uw-stream/tests/test_gex_strike_expiry.py`
- `uw-stream/README.md`

**Behavior:**
- Add `GexStrikeExpiryHandler.enqueue(payload)`:
  - Read `raw = payload.get("expiry")`.
  - If `raw` equals today's ET date as an ISO string (`YYYY-MM-DD`), call `await super().enqueue(payload)`.
  - Otherwise parse it with the module's `_to_date`:
    - `None` (missing or unparseable): still `super().enqueue`, so `_transform` logs it exactly as today.
    - A date equal to today (another ISO spelling): `super().enqueue`.
    - Any other date: add 1 to `state.handler(self.name).filtered` and return without queueing.
- **Today's ET date** comes from the existing `_today_et()`. Cache its ISO string and refresh it at most once per second on `time.monotonic()`.
  - The `_transform` check stays as is. It still catches a frame queued just before ET midnight and dequeued just after.
- **`HandlerMetrics.filtered: int = 0`** in `state.py`:
  - It counts payloads a handler discarded before its queue because they can never become rows. Today only `gex_strike_expiry` sets it.
  - It is never part of `drop_count`. Document it in the dataclass docstring next to `dupes_dropped`.
- `/metrics` → `handlers.<name>` gains `filtered`.

**Tests:**
- A non-today expiry is not queued and `filtered` goes up by 1.
- Today's expiry is queued.
- A missing expiry and a garbage expiry are both queued, and `_transform` still rejects them with its existing warning.
- 60,000 non-today frames into a handler whose queue is smaller than that leave `drop_count == 0` and the queue empty.
- `/metrics` shows `filtered`.
- The date cache refreshes after a second: patch the clock, not a test seam.

**README:** add `filtered` to the `/metrics` field list, and one sentence on why GEX frames are filtered before the queue.

## Task 2: flush, batch and queue high-water stats

**Files** (5):
- `uw-stream/src/state.py`
- `uw-stream/src/handlers/base.py`
- `uw-stream/src/router.py`
- `uw-stream/src/health.py`
- `uw-stream/tests/test_flush_stats.py` (new)

**Behavior:**
- **New `HandlerMetrics` fields.**
  - Cumulative:
    - `flushes: int` (calls of `_flush` that returned or raised);
    - `flush_rows: int` (rows passed to them);
    - `flush_seconds: float` (summed wall time inside `await self._flush(rows)`, success or failure, retries and backoff included).
  - Interval (Task 3's reporter reads and resets these):
    - `interval_flush_max_s: float` (longest single flush);
    - `interval_batch_max: int` (largest `len(rows)` passed to one flush);
    - `interval_queue_hwm: int` (highest queue depth seen).
- **`Handler._safe_flush`:** time `await self._flush(rows)` with `time.monotonic()` and record all six on both success and failure.
  - Record nothing when the task is being cancelled (the existing `task.cancelling()` re-raise path). That keeps the current cancel semantics: a cancel isn't a flush.
- **`Handler.enqueue`:** in its existing `finally`, raise `interval_queue_hwm` to the new depth when that depth is higher.
  - Overrides that call `super().enqueue` get this for free: option trades with the dedupe, and GEX after Task 1.
- **`State.receive_queue_hwm: int = 0`**, an interval field. The router raises it where it already sets `receive_queue_depth` (`router.py:57`).
- **`/metrics`:**
  - each handler block gains `flushes`, `flush_rows`, `flush_seconds` (rounded to 3 decimals), and the three interval fields under the same names;
  - the top level gains `receive_queue_hwm`.

**Tests:**
- One success flush and one failing flush each update the counts, the seconds and the max.
  - Patch `time.monotonic` in the base module, or use a `_flush` that awaits a controlled sleep.
- A cancelled flush records nothing.
- `interval_batch_max` follows the largest batch, including a `_take_backlog` batch over `ws_batch_size`.
- The queue high-water follows the peak and not the current depth.
- The router raises `receive_queue_hwm`.
- `/metrics` shows the new fields.

## Task 3: the per-minute pipeline line, loop lag and pool use

**Files** (4):
- `uw-stream/src/pipeline_stats.py` (new)
- `uw-stream/src/main.py`
- `uw-stream/tests/test_pipeline_stats.py` (new)
- `uw-stream/README.md`

**Behavior:**
- **`run_pipeline_stats()`** is a background task. It is started in `main._run` next to `run_drop_reporter` and cancelled with the other background tasks in `_shutdown`. It needs no final pass.
- **Sampler, every `SAMPLE_INTERVAL_S`:**
  - Measure event-loop lag as the elapsed monotonic time minus `SAMPLE_INTERVAL_S`, floored at 0. Keep the interval max and the count of samples at or over `LOOP_LAG_FLAG_S`.
  - When the DB pool is initialized, read `get_size()` and `get_idle_size()`. Keep the interval max of size and the interval max of in-use (size − idle).
  - If the pool isn't initialized, record nothing for it. Never raise.
- **Report, at each UTC minute boundary:** sleep to the next boundary, wall clock. Emit one `log.info("uw-stream pipeline minute", extra={...})` with:
  - `minute_utc`: ISO start of the minute being reported.
  - `loop_lag_max_s`, `loop_lag_over_1s`.
  - `pool_size_max`, `pool_in_use_max`: `None` when never sampled.
  - `receive_queue_hwm`, and `receive_queue_dropped` (the delta of `state.receive_queue_drops` since the last report).
  - `handlers`: one entry per handler that had activity in the minute (any flush, `interval_queue_hwm > 0`, a new drop or a new `filtered`), with:
    - `flushes`, `rows`, `flush_s`: deltas of the cumulative counters;
    - `flush_max_s`, `batch_max`, `queue_hwm`: the interval fields;
    - `dropped`, `filtered`: deltas.
  - All seconds are rounded to 3 decimals.
- Then reset every interval field this line read: the handler interval fields, `receive_queue_hwm`, and the sampler's maxima.
- A minute with no activity still emits the line with an empty `handlers`. It doubles as a heartbeat and shows overnight loop lag.
- **Bounds:** the reporter's baselines are dicts keyed by handler name.

**Tests:**
- Lag computation, max and the over-1 s count.
- Pool sampling, including an uninitialized pool.
- Deltas between two reports, and reset after a report.
- Idle-handler omission.
- The minute alignment arithmetic.
- `main` starts the task and `_shutdown` cancels it: extend the existing `test_main.py` pattern if it already lists background tasks; otherwise test it here.

**README:** a section on the line: what each field means, and how to read it:
`railway logs -s uw-stream --filter "pipeline minute" --json`, using the app's `time` field, not Railway's `timestamp`.

## Task 4: per-socket counters and the twin-silence warning

**Files** (4):
- `uw-stream/src/socket_stats.py` (new)
- `uw-stream/src/connector.py`
- `uw-stream/src/main.py`
- `uw-stream/tests/test_socket_stats.py` (new)

**Behavior:**
- **`twin_map(shards: list[list[str]]) -> dict[str, str]`** (pure). It names shards `conn{i}` and groups them by the frozenset of their `option_trades:` channels, ignoring other channels.
  - Shards with no option-trade channels have no twin.
  - A group of exactly two shards are twins of each other.
  - Today that gives conn0↔conn6 and conn1↔conn7.
  - With `WS_REDUNDANT_OPTION_TRADES=false` the map is empty.
- **`SocketStats`, one per connector name,** registered in a module-level registry keyed by shard name:
  - Cumulative: `frames`, `trade_frames`, `silences`.
  - Interval (Task 5 reads and resets these): `interval_frames`, `interval_trade_frames`, `interval_max_trade_gap_s`, `interval_silences`.
  - A ring of trade-frame counts in 0.1 s buckets spanning 120 s.
  - `last_trade_at` (monotonic, or `None`).
  - `session_start()` sets `last_trade_at = None`, so no gap is measured across a reconnect.
- **`on_frame(raw, now)`**, called by the connector for every frame with the monotonic `now` the loop already reads:
  - Count the frame.
  - A trade frame is a `str` starting with `'["option_trades:'`, or `bytes` starting with `b'["option_trades:'`.
  - For a trade frame:
    - Add it to the current bucket.
    - If `last_trade_at` is set, the gap is `now - last_trade_at`. Raise the interval max gap.
    - If the gap is at least `SILENCE_S`, count a silence. When this socket has a twin, count the twin's trade frames in the buckets **strictly inside** (`last_trade_at`, `now`), leaving out the two edge buckets. If that count is at least `TWIN_MIN_FRAMES`, emit the warning below.
    - Set `last_trade_at = now`.
  - Why the edge buckets are left out: after an event-loop stall both sockets resume together, and the twin's buffered frames land in the resume bucket. Excluding it keeps a loop stall from looking like one socket going quiet. Task 3's loop-lag line covers stalls.
- **The warning:** `rate_limited_log.warning(scope="socket_stats", kind="twin_silence", key=<shard>, message="trade socket went quiet while its twin kept receiving", extra={...})`. The fields are:
  - `shard`, `twin`;
  - `gap_s` (3 dp) and `twin_trade_frames`;
  - `silence_start_utc` and `silence_end_utc`: ISO, with the end being wall-clock now at detection and the start being end minus the gap;
  - `twin_window_clipped`: true when the gap is longer than the ring span.
- **`connector.py`:**
  - get this shard's `SocketStats` once in `__init__`;
  - call `session_start()` when a connection's receive loop starts;
  - call `on_frame(raw, now)` in the receive loop. Reuse the `time.monotonic()` read the loop already makes; don't add a second clock read.
- **`main.py`:** after `shards = settings.channel_shards`, register stats for every `conn{i}` and set the twin map from `twin_map(shards)` before the connectors start.

**Tests:**
- `twin_map` on: today's layout, mirrors off, globals folded into a primary, and an odd shard with no twin.
- Trade-frame detection for `str`, `bytes` and a non-trade frame.
- No gap across `session_start`.
- A 0.6 s gap with 15 twin frames inside it warns. One with 5 doesn't. One with no twin doesn't.
- Twin frames only in the edge buckets don't count.
- A gap past 120 s sets `twin_window_clipped`.
- The ring wraps correctly after more than 120 s of frames.
- The connector calls `on_frame` per frame and `session_start` per connection: extend `test_connector.py`'s existing fake-socket tests.
- A microbenchmark of `on_frame` per trade frame, reported in µs in the task report. The target is under 1 µs median on the dev box.

## Task 5: report and expose the socket numbers

**Files** (4):
- `uw-stream/src/pipeline_stats.py`
- `uw-stream/src/health.py`
- `uw-stream/tests/test_pipeline_stats.py`
- `uw-stream/README.md`

**Behavior:**
- **The per-minute line gains `sockets`:** one entry per registered shard with `frames`, `trade_frames`, `max_trade_gap_s` (3 dp) and `silences` for the minute. Reset after reading.
- **`/metrics` gains `sockets`:** per shard, the cumulative `frames`, `trade_frames`, `silences`, and `twin` (or `null`).

**Tests:** the line's `sockets` section and reset, and the `/metrics` `sockets` block.

**README:**
- the `sockets` fields;
- the twin-silence warning;
- how to read a silence against the dedupe's `single_copy_interval`. A silence with a matching rise in single copies means trades were lost on that socket. A silence with none means the socket was only delayed.

## Data dependencies

None. There are no migrations, tables, env vars or new external APIs. Logs go to Railway; `/metrics` is read with the existing `INTERNAL_METRICS_TOKEN`.

## Open questions (default picks)

- **Twin silence to Sentry?** Default no: log only. The mirror already covers the loss, and this is diagnosis.
- **Emit the minute line when idle?** Default yes. It is a heartbeat and shows overnight loop lag, at 1,440 lines a day.

## Deploy

- Push after 15:00 CT; never during 8:30–15:00 CT. A push to `main` redeploys uw-stream, which drops every socket for a few seconds.
- **After deploy:**
  - boot lines show 8 connections;
  - a "uw-stream pipeline minute" line appears each minute;
  - `/metrics` shows the new fields.
- **At the next open:**
  - GEX `filtered` climbs, and the GEX `drop_count` stays flat;
  - read the minute lines at :x0/:x5 for `flush_max_s`, `loop_lag_max_s` and `pool_in_use_max` on `option_trades` against the Neon landing lag.
