# uw-stream Hardening — 2026-05-09

## Goal

Fix the 13 findings from the 2026-05-09 code review of `uw-stream/` so the daemon is reliable enough to be the sole data source for the Lottery Finder cron and dark-pool aggregation. Source: review verdict was **continue** — architecture sound, specific issues to address before this becomes load-bearing.

## Why now

uw-stream currently runs in parallel with the existing cron-fed `flow_alerts` table during a soak window (per `docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md`). Cutover depends on this daemon being trustworthy. Today it has two correctness bugs (C1, C2) that can deadlock the WS read loop, one performance ceiling (H1) that will throttle under volume, one silent-data-loss bug at every deploy (H4), and several observability gaps (M2, M3, M5).

## Phases

Phases are ordered by **severity × dependency**, NOT by file. Each phase is independently shippable, has its own commit, and can be merged + soaked before the next starts.

---

### Phase 1 — Critical correctness (≈3 files, ≈4h)

Stops the two ways the daemon can silently stall.

**1.1 — C1: Make the `block` backpressure policy safe (or remove it)**

- File: [uw-stream/src/handlers/base.py:74-75](uw-stream/src/handlers/base.py#L74-L75) + [uw-stream/src/config.py:85](uw-stream/src/config.py#L85)
- Change: replace `await self.queue.put(payload)` with `await asyncio.wait_for(self.queue.put(payload), timeout=BLOCK_PUT_TIMEOUT_S)`. On `TimeoutError`, treat as a drop and increment `state.drop_count[channel]`.
- Constant: `BLOCK_PUT_TIMEOUT_S = 0.05` (50ms — must be << WS ping_interval=20s and << ping_timeout=20s).
- Test: `tests/test_handler_backpressure.py::test_block_policy_drops_after_timeout_when_queue_full`. Use `asyncio.Queue(maxsize=1)`, fill it, then enqueue → assert TimeoutError-path increments `drop_count` and doesn't block forever.

**1.2 — C2: Decouple WS receive from router parsing**

- Files: [uw-stream/src/connector.py:105-108](uw-stream/src/connector.py#L105-L108), [uw-stream/src/router.py](uw-stream/src/router.py), [uw-stream/src/main.py](uw-stream/src/main.py)
- Change: introduce a bounded `receive_queue: asyncio.Queue[str]` (default `maxsize=10000`) shared between connector and router. Connector loop becomes `async for raw in ws: receive_queue.put_nowait(raw)` with drop-oldest on full. Router runs as its own asyncio task pulling from `receive_queue`.
- Restores the README architecture: `WS → Connector → Router → per-channel queue`. Currently connector and router run on the same task.
- Constant: `RECEIVE_QUEUE_SIZE = 10000` (env-overridable as `WS_RECEIVE_QUEUE_SIZE`).
- Metric: add `state.receive_queue_depth` and `state.receive_queue_drops` to `state.py` + expose in `/metrics`.
- Test: `tests/test_connector.py::test_receive_queue_drops_oldest_on_overflow`, plus extend an existing router test to confirm router consumes from the new queue.

**1.3 — H4: Drain in-flight batches on SIGTERM**

- Files: [uw-stream/src/main.py:140-147](uw-stream/src/main.py#L140-L147), [uw-stream/src/handlers/base.py](uw-stream/src/handlers/base.py)
- Change: add `async def drain(self, deadline_s: float = 5.0)` to `Handler` base. On shutdown signal, call `drain()` on every handler (concurrent `asyncio.gather`) BEFORE cancelling tasks. Drain pulls remaining items from queue + flushes the in-memory `batch` list, capped by deadline.
- Test: `tests/test_handlers.py::test_drain_flushes_in_memory_batch_and_remaining_queue`. Mock the flush sink, push N rows, signal stop, assert all N were flushed.

**Phase 1 verification:**

- All existing uw-stream tests pass: `cd uw-stream && pytest -q`
- Coverage on the touched files >= prior baseline
- Manual: `python -m main` locally with `WS_BACKPRESSURE_POLICY=block`, `WS_QUEUE_SIZE=1`, observe drop counter increments and the process never hangs

**Phase 1 commit:** `fix(uw-stream): prevent WS-loop deadlock + drain batches on shutdown`

---

### Phase 2 — Bulk-insert performance (≈2 files, ≈3h)

Without this, Phase 1's drop-counter will rise during volume spikes — the daemon falls behind because flushes are slow.

**2.1 — H1: Replace `executemany` with single multi-row INSERT**

- File: [uw-stream/src/db.py:96-152](uw-stream/src/db.py#L96)
- Change: `bulk_insert_ignore_conflict` and `bulk_upsert_replace` build one `INSERT INTO t (cols) VALUES ($1,$2,...), ($N+1,...), ...` statement with all rows' params flattened. Cap at `MAX_INSERT_PARAMS = 30000` (Postgres limit is 32767 params per statement; chunk if larger).
- Helper: extract a `_build_multi_row_insert(table, cols, rows)` that returns `(sql, flat_params)`.
- Test: `tests/test_db_bulk.py` (new file) with these cases:
  - 1 row → SQL has 1 `VALUES (...)` group
  - 500 rows → SQL has 500 `VALUES (...)` groups, exactly `500 * len(cols)` params
  - 30001 rows when params/row=4 → split into 2 statements (since 30001\*4 > 30000)
  - asyncpg mock: confirm `await conn.execute(sql, *params)` is called once per chunk, not N times

**2.2 — H2: Verify the deadlock-prevention sort still works under multi-row INSERT**

- File: [uw-stream/src/handlers/gex_strike_expiry.py:177](uw-stream/src/handlers/gex_strike_expiry.py#L177)
- Change: no code change required (the existing sort still applies — Postgres now acquires locks in tuple-list order deterministically once H1 lands), but add a regression test that documents the contract.
- Test: `tests/test_gex_strike_expiry.py::test_flush_sorts_rows_for_deterministic_lock_order`

**Phase 2 verification:**

- All tests pass
- Manual: load-gen against a local Postgres (or Neon dev branch). Inject 5,000 rows in one batch, assert single round-trip via Postgres `pg_stat_statements` (1 calls, not 5000).
- Coverage on `db.py` reaches >= 90%

**Phase 2 commit:** `perf(uw-stream): single multi-row INSERT replaces N-round-trip executemany`

---

### Phase 3 — Operational reliability (≈4 files, ≈3h)

**3.1 — H3: Extend `/healthz` startup grace before first WS connect**

- File: [uw-stream/src/health.py:25-37](uw-stream/src/health.py#L25-L37)
- Change: when `state.last_message_ts is None` AND `now - state.started_at < HEALTH_STARTUP_GRACE_S`, return 200 `{status: "starting"}` regardless of `state.ws_connected`.
- Constant: `HEALTH_STARTUP_GRACE_S = 300` (matches the existing `HEALTH_STALE_AFTER`).
- Test: `tests/test_health.py::test_healthz_returns_200_during_startup_grace`

**3.2 — M1: Bump pool max_size to match handler concurrency**

- File: [uw-stream/src/db.py:50-58](uw-stream/src/db.py#L50)
- Change: `min_size=2, max_size=10` (was 1/5). Document the math: 5 handlers × 2 = 10, headroom for health check + manual queries.
- Test: `tests/test_db.py::test_pool_size_supports_handler_count`

**3.3 — M2: Honest `write_count` reporting**

- File: [uw-stream/src/db.py:96-152](uw-stream/src/db.py#L96), [uw-stream/src/handlers/base.py:124-125](uw-stream/src/handlers/base.py#L124)
- Change: `bulk_insert_*` returns the actual inserted count (parse asyncpg's `INSERT 0 N` status string from `conn.execute()` return value). Handler's `_safe_flush` increments `write_count += inserted` AND a new `write_attempted += len(rows)` counter. `/metrics` exposes both.
- Test: `tests/test_db_bulk.py::test_returns_inserted_count_from_status_string`

**3.4 — M5: Move `state.ws_connected = True` to AFTER `_subscribe_all` completes**

- File: [uw-stream/src/connector.py:102-103](uw-stream/src/connector.py#L102)
- Change: defer the `True` assignment until after `await self._subscribe_all(ws)` returns successfully. On subscribe error, log + Sentry capture + leave `ws_connected = False` so the next reconnect retries.
- Test: `tests/test_connector.py::test_ws_connected_only_set_after_subscribe_all`

**3.5 — M3: Rate-limit log/Sentry on payload-malformation paths**

- Files: [uw-stream/src/router.py:46-92](uw-stream/src/router.py#L46), all `uw-stream/src/handlers/*.py` `_transform` warning paths, [uw-stream/src/sentry_setup.py](uw-stream/src/sentry_setup.py)
- Change: add `_RateLimitedLogger` helper in `logger_setup.py` keyed by `(channel, error_kind)` with a 60s TTL. First occurrence per minute logs + captures, subsequent occurrences increment a counter. Counter dumps to log+Sentry once per minute as a summary.
- Constant: `MALFORMED_PAYLOAD_LOG_INTERVAL_S = 60`.
- Test: `tests/test_logger_rate_limit.py` (new) — fire 1000 identical errors in 1s, assert exactly 1 log line + 1 Sentry capture, and a counter of 999.

**Phase 3 verification:**

- All tests pass
- Manual smoke: `python -m main` locally → `curl localhost:8080/healthz` returns 200 within first second of startup, `/metrics` shows `write_count` ≤ `write_attempted`

**Phase 3 commit:** `feat(uw-stream): operational reliability fixes (health grace, pool size, write counters, subscribe-gated readiness, rate-limited error logs)`

---

### Phase 4 — Cleanup nits (≈3 files, ≈1h)

Skip if time-constrained, but cheap to ship.

**4.1 — M4: Reconcile `server_name` vs `service` tag**

- File: [uw-stream/src/sentry_setup.py:50,54](uw-stream/src/sentry_setup.py#L50), [uw-stream/README.md](uw-stream/README.md)
- Change: keep both (`server_name="uw-stream"` for Sentry's host display, `set_tag("service", "uw-stream")` for filtering). Update README line 71 to mention both.
- Test: none — docs only.

**4.2 — M6: Validate empty `WS_CHANNELS` at model construction**

- File: [uw-stream/src/config.py:139-140](uw-stream/src/config.py#L139)
- Change: convert the post-construction `ValueError` to a `@model_validator(mode="after")` so the failure surfaces at `Settings()` instantiation with a clearer error path.
- Test: `tests/test_config_aliases.py::test_empty_channels_raises_at_construction`

**4.3 — L3: Single source of truth for channel name → handler key**

- Files: [uw-stream/src/main.py:63-79](uw-stream/src/main.py#L63), [uw-stream/src/config.py](uw-stream/src/config.py)
- Change: extract a `CHANNEL_HANDLER_REGISTRY: dict[str, type[Handler]]` (or callable factory) so the channel-name → handler mapping lives in one place. Add a `field_validator` that asserts every channel in `WS_CHANNELS` exists in the registry.
- Test: `tests/test_config_aliases.py::test_unknown_channel_rejected_at_settings_construction`

**Phase 4 verification:** all tests pass, `pytest -q` clean

**Phase 4 commit:** `chore(uw-stream): docs + validation cleanups from 2026-05-09 audit`

---

## Files to create/modify (consolidated)

**Created:**

- `uw-stream/tests/test_db_bulk.py` (Phase 2 + 3)
- `uw-stream/tests/test_logger_rate_limit.py` (Phase 3)

**Modified:**

- `uw-stream/src/connector.py` (Phases 1, 3)
- `uw-stream/src/router.py` (Phases 1, 3)
- `uw-stream/src/main.py` (Phases 1, 4)
- `uw-stream/src/handlers/base.py` (Phases 1, 3)
- `uw-stream/src/db.py` (Phases 2, 3)
- `uw-stream/src/health.py` (Phase 3)
- `uw-stream/src/state.py` (Phases 1, 3)
- `uw-stream/src/config.py` (Phases 1, 4)
- `uw-stream/src/sentry_setup.py` (Phase 4)
- `uw-stream/src/logger_setup.py` (Phase 3)
- `uw-stream/tests/test_handler_backpressure.py` (Phase 1)
- `uw-stream/tests/test_connector.py` (Phases 1, 3)
- `uw-stream/tests/test_handlers.py` (Phase 1)
- `uw-stream/tests/test_health.py` (Phase 3)
- `uw-stream/tests/test_db.py` (Phase 3)
- `uw-stream/tests/test_gex_strike_expiry.py` (Phase 2)
- `uw-stream/tests/test_config_aliases.py` (Phase 4)
- `uw-stream/README.md` (Phase 4)

## Data dependencies

None — no new tables, no migrations, no env vars beyond:

- `WS_RECEIVE_QUEUE_SIZE` (default 10000) — Phase 1
- All other constants are code-level, not env-overridable.

## Thresholds / constants (centralized)

| Constant                           | Value    | Phase | Why                                       |
| ---------------------------------- | -------- | ----- | ----------------------------------------- |
| `BLOCK_PUT_TIMEOUT_S`              | `0.05`   | 1     | Must be << WS ping_timeout=20s            |
| `RECEIVE_QUEUE_SIZE`               | `10000`  | 1     | ~1s of peak option_trades volume (~10k/s) |
| `MAX_INSERT_PARAMS`                | `30000`  | 2     | Postgres hard limit is 32767              |
| `HEALTH_STARTUP_GRACE_S`           | `300`    | 3     | Matches existing `HEALTH_STALE_AFTER`     |
| `MALFORMED_PAYLOAD_LOG_INTERVAL_S` | `60`     | 3     | Standard rate-limit window                |
| Pool `min_size`/`max_size`         | `2`/`10` | 3     | 5 handlers × 2 + headroom                 |

## Decisions (resolved 2026-05-09)

1. **Multi-row INSERT for both `bulk_insert_*` and `bulk_upsert_*`** — not `copy_records_to_table`. The bottleneck is round-trips, not per-row encoding; keeps the code shape consistent. Revisit only if a single channel pushes past ~5k rows/batch.
2. **Keep `block` in `WS_BACKPRESSURE_POLICY` allowed values** — Phase 1.1 makes it safe via the 50ms put-timeout that converts to a drop. Document the timeout-then-drop semantics in `uw-stream/README.md` as part of Phase 4.
3. **No dependency arrow on the cron retirement spec.** Cutover decision lives with `uw-cron-to-websocket-migration-2026-05-02.md`; this hardening plan stands on its own. Skip the cross-doc update.

## Done When

- [ ] Phase 1 commit landed; `pytest` green; manual smoke confirms WS loop never blocks under `WS_BACKPRESSURE_POLICY=block`
- [ ] Phase 2 commit landed; `pg_stat_statements` shows 1 call per flush, not 500
- [ ] Phase 3 commit landed; `/healthz` returns 200 within 1s of startup; `/metrics` shows `write_count` ≤ `write_attempted`
- [ ] Phase 4 commit landed (optional)
- [ ] No new Sentry issues with `server_name:uw-stream` for 7-day soak window

## Out of scope (deliberately)

- L1 (`orjson.loads` decoder str-vs-bytes) — dormant, no read path today; revisit if a read endpoint is added.
- L2 (`size: int | None` style) — pure cosmetics.
- Switching from `asyncpg` to `psycopg3` async — not on the table.
- Adding new channels (gex, news, etc.) — separate spec.
- Cron retirement / cutover from cron-fed `flow_alerts` to `ws_flow_alerts` — handled by `docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md`.
