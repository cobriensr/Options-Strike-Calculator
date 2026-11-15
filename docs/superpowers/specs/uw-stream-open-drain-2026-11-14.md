# uw-stream: stop the option-trade queue overflowing at the open

Status: approved by the owner 2026-11-14 ("lets do both b and c": (b) a bigger queue plus two writers for the shared option-trade queue, built here; (c) a higher Neon minimum compute, set by the owner in the console). The controller's calls are marked **(call)**. Must be live before the open on Monday 2026-11-16 (pushes stop at 8:30 CT).

## Goal

Stop the shared option-trade handler from dropping trades at the open by giving its queue room for a slow-Neon morning and by letting it write two batches at once.

## What happened (verified, 2026-11-14)

Data: `docs/tmp/open-drain-2026-11-12/` (main checkout), `docs/tmp/fulltape-check-2026-11-13/report.md`.

- On 2026-11-12 at 8:32-8:35 CT, 24,585 option trades were lost. The drop reporter's total (24,585) equals the Full Tape deficit exactly. The connections delivered every trade.
- One shared `OptionTradesHandler` instance takes every `option_trades:<TICKER>` channel except SPY, QQQ and SPXW (those are Interval B/A subclasses with their own queues). It has one queue (`ws_queue_size` 50,000, `drop_oldest`) and one consumer, and flushes run strictly one at a time (`handlers/base.py` `run` → `_safe_flush`). At the open every flush is the 5,000-row backlog cap (`BACKLOG_BATCH_MAX`), one transaction of three multi-row INSERTs.
- 11-12: 109 consecutive 5,000-row flushes from 8:30:10 to 8:39:27 CT. The gaps were 4.4-5.2 s (~1,000-1,100 rows/s) until 8:31:24, then 6-8 s (~700 rows/s) until 8:38:30. Arrivals were ~1,050/s. The backlog reached 23k right after the opening burst and 50k at ~8:33:15, then `drop_oldest` evicted trades executed ~8:32:25-8:33:10.
- 11-13, same code: the first 5,000-row flushes took 4-5.5 s, falling to 2.6-3.5 s (1,700-1,900 rows/s) within 25 s. The 15.7k backlog was gone by 8:30:50.
- Neon (`ep-fancy-sky-ajficv2h`, us-east-2, autoscaling 0.25-4 CU): on 11-13 it sat at the 4 CU cap from 8:30; on 11-12 it averaged 1.85 CU over the open hour. There were no errors, retries, timeouts or Neon restarts on 11-12, and the small SPY/SPXW/QQQ flushes stayed near normal.
- So the drain ceiling is set by Neon's per-row insert speed on one connection, and at the open it is about equal to arrivals. On a slow-Neon morning, a heavier open overflows.
- Memory is not a constraint: uw-stream peaked at 0.72 GB of 24 GB over 60 hours.

## Global constraints

- Python 3.12 and uw-stream's existing patterns: `log` and `rate_limited_log` from `logger_setup`, fields in `extra=`; counters in `state`; `/metrics` in `health.py`.
- **Hot paths stay cheap:** no new work per frame in `enqueue`, the router or the connector.
- **No new env vars** (R7): the two values are module or class constants, each with its reason. **No new Sentry events.**
- **Writes stay idempotent** (`INSERT ... ON CONFLICT (ws_trade_id) DO NOTHING`), so two batches may commit in either order.
- **Tests never open a network socket or a database.** Mock at the module boundary (R3) and cover the failure paths (R4).
- **Gate before every commit:** `ruff check` and `ruff format --check` on `uw-stream/`; the uw-stream pytest (venv `F:/dev/strike-calculator/uw-stream/.venv/Scripts/python`, run from `uw-stream/`); `npm run review` from the worktree root.

## Thresholds / constants

| Name | Value | Where | Meaning |
|---|---|---|---|
| shared option-trade queue size | 200,000 | `handlers/option_trades.py` | Room for a slow-Neon open. Thursday needed ~75,000 (50,000 queued plus 24,585 evicted). At the 11-12 drain rate (~700/s) 200,000 is ~5 min of backlog. Every other handler, Interval B/A included, keeps `ws_queue_size` (50,000) |
| shared option-trade flush concurrency | 2 | `handlers/option_trades.py` | At most two flushes in flight. Neon used about half its 4 CU on 11-12, so a second connection can use idle capacity. The pool's max is 10, so this adds at most one connection |
| every other handler | 1 | `handlers/base.py` default | Unchanged. Interval B/A's `_flush` aggregates in memory, so it must stay sequential |

## Task 1: a bigger queue and two writers for the shared option-trade handler

**Commit (≤5 source and doc files plus their tests):** `uw-stream/src/handlers/base.py`, `uw-stream/src/handlers/option_trades.py`, `uw-stream/src/handlers/interval_ba.py` (only if needed to keep its queue size and concurrency at the defaults), `uw-stream/README.md`, this spec, and the test files that hold the drain-loop, option-trade and Interval B/A tests.

**Behaviour:**
- **Per-handler settings (call).** `Handler` gains a class-level queue size (default `settings.ws_queue_size`) and a class-level flush concurrency (default 1). The shared `OptionTradesHandler` sets 200,000 and 2. The Interval B/A subclasses inherit from `OptionTradesHandler`, so they set both back to the defaults explicitly. A test pins all four handlers' values.
- **Concurrent flushes.** With concurrency N > 1, the consumer builds batches exactly as today (500 rows or the 2 s timeout, topped up from the backlog to `BACKLOG_BATCH_MAX`).
  - Instead of awaiting each flush, it starts the flush as a task and goes back to building the next batch.
  - With N flushes already in flight, it waits for one to finish before starting another, so there are never more than N at once and never an unbounded pile of tasks.
  - Batches start in the order they were built. They may commit in either order.
  - With N = 1 the behaviour is today's exactly: same awaits, same order. Every existing drain-loop test passes unchanged.
- **Bookkeeping per flush is unchanged:**
  - write counts, `lost_rows`, the flush stats (`flushes`, `flush_rows`, `flush_seconds`, `interval_flush_max_s`, `interval_batch_max`);
  - the retry and backoff inside `db.py`, which now runs inside that flush's task.
  - A failing flush is counted and logged as today and doesn't stop the consumer or the other flush.
  - `flush_s` per minute can now exceed 60 s for this handler. Say so in the README.
- **Shutdown and drain.** `drain` and the shutdown path wait for in-flight flushes inside the existing deadline, then flush what is left as today.
  - The cancel path (`consumer_busy`) cancels every in-flight flush task, just as it cancels the consumer today.
  - Shutdown leaves no pending task, no "Task exception was never retrieved", and no row both counted written and lost.
- **No change to `enqueue`, the dedupe, `drop_oldest` or the drop reporter.**
- **README** ("Pipeline diagnostics", or the handler section that describes queues and flushes): the shared handler's queue size and two writers, with the 11-12 reason in two lines; that every other handler keeps 50,000 and one writer; the payload memory at 200,000 queued, measured (deep size of a typical transformed or queued payload times 200,000), not guessed; and how to read the minute line at the open (`queue_hwm`, `batch_max` at 5,000, `flush_s`, `dropped`).

**Tests:**
- Two flushes overlap: fake `_flush` coroutines block on events, and the test shows both are entered before either returns.
- A third batch waits until one of the two finishes.
- Start order follows build order.
- A flush that raises is counted and logged, and the other flush and the consumer keep going.
- The flush stats add up across overlapping flushes.
- `drain` waits for in-flight flushes, and the deadline path cancels them, leaving no pending tasks.
- N = 1 keeps today's behaviour (the existing tests).
- The queue sizes and concurrencies of the shared handler and the three Interval B/A handlers.
- A full 200,000 queue still drops the oldest and counts it.

## Deploy

- Push before 8:30 CT Monday 2026-11-16, after the review is clean. The market is closed on Sunday.
- Check after the push: uw-stream boots, all 8 shards join, and the minute line runs. The real check is Monday's open:
  - the shared handler's `dropped` stays 0;
  - its `queue_hwm` is well below 200,000;
  - `flush_s` above the minute's length shows both writers in use.

## (c) Neon minimum compute: the owner's change

Neon Console → project `muddy-hall-17114172` → branch `br-still-violet-ajzqi3kn` → Computes → `ep-fancy-sky-ajficv2h` → Edit → Autoscale: min 2 CU, max 8 CU (Neon caps the range at 8 CU). No restart (Neon docs, "Enable Autoscaling in Neon").

## Not in scope

- Cheaper inserts (an `unnest` insert with a cached prepared statement, or an index review on `ws_option_trades`). Decide after Monday's minute lines show per-flush times.
- Concurrency for any other handler.
- The Sentry routing for the drop reporter's `component=backpressure` warnings: a separate question for the owner.
