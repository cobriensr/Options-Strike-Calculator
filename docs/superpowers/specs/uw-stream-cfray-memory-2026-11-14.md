# uw-stream: Cloudflare ray and egress logging, and a memory gauge

Status: approved by the owner 2026-11-14 ("lets also look at cf-ray/egress logging, to split the RST half between Railway and Cloudflare as well as A memory gauge on /metrics", then "yeah just dive in"). The controller's calls are marked **(call)**.

## Goal

1. Record, for every websocket session in uw-stream and in the canary, which Cloudflare data centre it landed on and its Cloudflare request ID, plus uw-stream's egress IP, so the RST half of the disconnects can be split between Railway's network and Cloudflare's edge.
2. Report process memory, container memory and the sizes of the two in-memory stores that can grow, once a minute and on `/metrics`, so the daily memory climb (0.46 GB on 11-09, 0.58 on 11-12, 0.69 on 11-13; the old process reached 1.0 GB) can be pinned to a cause.

## Background (verified)

- **The RST half.** 535 of 1,072 drops (10-29 to 11-13) were RSTs. The canary's sockets to a different Cloudflare-fronted host reset at the same rate (12.7 vs 11.8 per socket-day) with the same daily and hourly shape; its sockets to a host without Cloudflare had 3 RSTs in 30 socket-days. 74 of 76 RSTs on 11-12/13 were followed by UW's side still sending to the dead port, so the far end never sent the reset. What can't be told apart yet is Railway's network vs Cloudflare's edge.
- **`cf-ray`.** Every response from `api.unusualwhales.com` carries `CF-RAY: <16 hex>-<COLO>` (for example `a5a99a668950d873-MCI`) and `via: 1.1 google`. The suffix is the Cloudflare data centre's IATA code. The ray ID is what Cloudflare and UW look connections up by.
- **websockets 17.4 / 17.3** (`asyncio/connection.py:85`, `asyncio/client.py:123`): `ClientConnection.response` is the handshake `Response` once connected; `response.headers` is case-insensitive.
- **`/cdn-cgi/trace`** on the same host returns `key=value` lines including `ip=` (the address Cloudflare saw), `colo=` and `loc=` (probed 2026-11-14). It is served by Cloudflare, not UW's API.
- **Sentry.** `sentry_setup.py:183` sets `LoggingIntegration(event_level=None)`: a `log.warning` is never a Sentry event. Events come only from `capture_message` and `rate_limited_log.error`.
- **Memory suspects.** The option_trades dedupe holds two generations of keys (~160k at the open, peaks ~15-35 MB). Interval B/A's `_ticks` (`handlers/interval_ba.py:209`, `dict[str, dict[int, deque]]`) is swept only past `_CHAINS_PRUNE_THRESHOLD = 5_000` chains: the suspected slow grower, inferred from code, not measured.

## Global constraints

- Python 3.12 and uw-stream's existing patterns: `log` and `rate_limited_log` from `logger_setup`, fields in `extra=`; counters in `state`; `/metrics` in `health.py`.
- **Hot paths stay cheap.** No new work per frame in the connector receive loop, the router or `Handler.enqueue`. Everything here runs once per connect or once per minute.
- **No new env vars** (R7) and **no new Sentry events.** A failure in any of this logs (rate-limited) at WARNING or below, never `rate_limited_log.error` or `capture_message`.
- **No new dependencies.** uw-stream already has `aiohttp`; the canary stays on `websockets` alone.
- **Every new dict is keyed by a closed set** (shard names, handler names).
- **Tests never open a network socket or a database** (the uw-stream conftest blocks both; the canary's tests must not connect either). Mock at the module boundary (R3) and cover the failure paths (R4).
- **Gate before every commit:** `ruff check` and `ruff format --check` on `uw-stream/` (and `scripts/ws-canary/` for Task 3, with its `ruff.toml`); the uw-stream pytest suite (venv `F:/dev/strike-calculator/uw-stream/.venv/Scripts/python`, run from `uw-stream/`); the canary's `test_canary.py` with the same venv; `npm run review` from the worktree root.

## Thresholds / constants

| Name          | Value                                 | Where             | Meaning                                                                |
| ------------- | ------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| trace timeout | 5 s total                             | `egress.py`       | one `/cdn-cgi/trace` GET per connected session; past this it gives up  |
| trace URL     | `https://<ws_url host>/cdn-cgi/trace` | `egress.py`       | derived from `settings.ws_url`, so it is the same zone the sockets use |
| User-Agent    | `uw-stream/1.0 (egress-trace)`        | `egress.py`       | UW 403s Python's default UA                                            |
| colo shape    | `^[A-Z]{3}$`                          | connector, canary | anything else is logged as `null` with the full ray kept               |
| memory units  | MB, 1 decimal                         | minute line       | `/metrics` carries bytes                                               |

## Task 1: memory gauge (uw-stream)

**Commit 1a, process memory (≤5 source files plus their tests):** `src/memory_stats.py` (new), `src/pipeline_stats.py`, `src/health.py`, `tests/test_memory_stats.py` (new), `tests/test_pipeline_stats.py`, `tests/test_health.py`.

- `memory_stats.read_rss_bytes()`: resident set size from `/proc/self/statm` (second field × `os.sysconf("SC_PAGE_SIZE")`). `None` when unreadable (Windows dev, tests).
- `memory_stats.read_cgroup_bytes()`: container memory from `/sys/fs/cgroup/memory.current` (cgroup v2), else `/sys/fs/cgroup/memory/memory.usage_in_bytes` (v1). `None` when neither reads. This is the number Railway's memory graph tracks, page cache included; RSS is the process alone.
- **Gauges (call).** `memory_stats` keeps a registry of named size gauges: `register_gauge(name, fn)` where `fn() -> int`. Names come from a closed set (the handler that owns the structure plus a suffix, e.g. `option_trades.dedupe_keys`); registering a name again replaces it. The registry is capped at `MAX_GAUGES = 32` (ten are registered today), which is what enforces the closed set: a new name past the cap is refused with one rate-limited WARNING, and a name already held is still replaced. The reporter calls every gauge once a minute; a gauge that raises is skipped for that minute and logged once a minute (rate-limited WARNING). No gauge is called on a hot path.
- **Minute line:** a top-level `memory` object: `rss_mb`, `cgroup_mb` (null when unreadable) and `gauges: {name: int}`. Present every minute, traffic or not.
- **`/metrics`:** a top-level `memory` object: `rss_bytes`, `cgroup_bytes` and `gauges`, read at request time.
- Tests: both readers from fake files (paths monkeypatched), `None` on a missing or garbled file, the v1 fallback; the registry (replace, a raising gauge skipped and logged, the closed-set bound); the minute line's and `/metrics`' `memory` objects, exact shape.

**Commit 1b, structure gauges (≤5 files):** `src/handlers/option_trades.py`, `src/handlers/interval_ba.py`, `tests/test_option_trades.py` (or wherever the dedupe tests live), `tests/test_interval_ba.py`, `uw-stream/README.md`.

- `OptionTradesHandler` registers `<name>.dedupe_keys` = `len(self._seen) + len(self._seen_prev)`. The Interval B/A subclasses inherit the dedupe, so each registers under its own name.
- The Interval B/A handlers register `<name>.chains` = `len(self._ticks)` and `<name>.ticks` = the total tick entries across chains. The total is O(entries) once a minute; say in a comment what bounds it.
- README, "Pipeline diagnostics": the `memory` object on the minute line and `/metrics`, what each number is, and how to read a climb: `cgroup_mb` rising with `rss_mb` flat is page cache, not us; `rss_mb` rising with a gauge rising names the structure; `rss_mb` rising with every gauge flat is something unmeasured.
- Tests: each gauge's value after known inserts and after a rotation or prune.

## Task 2: Cloudflare ray and egress IP (uw-stream)

**Commit (≤5 files):** `src/connector.py`, `src/egress.py` (new), `tests/test_connector.py`, `tests/test_egress.py` (new), `uw-stream/README.md`.

- **Ray.** Right after the handshake, read the `cf-ray` header of `ws.response.headers` (with `get_all`, since `Headers.get` raises on a repeated header, which then counts as no header) into the session record (`_SessionDiag`) as `cf_ray` (the full value) and `cf_colo` (the suffix after the last `-`, when it matches the colo shape). Both go on the "WS connected, awaiting messages" line and on the disconnect line. A missing or odd header is `null`, never an exception.
- **Egress.** Once each connect's joins are sent, start one background lookup (`egress.lookup`) of the trace URL, as a task beside the reconcile and join-summary tasks, so one cancel-and-gather ends all three. It must not delay the subscribe or the receive loop, and it is cancelled when the session ends or the daemon shuts down. A connect whose subscribe fails starts no lookup. On success it stores `egress_ip`, `trace_colo` and `trace_loc` in the session record and logs one "egress trace" line: `shard`, `egress_ip`, `trace_colo`, `trace_loc`, and the socket's own `cf_colo` (the trace is a separate TCP connection, so its colo can differ from the socket's; the line shows both). The disconnect line carries `egress_ip` when the lookup finished first, else `null`.
- **(call)** One short-lived `aiohttp.ClientSession` per lookup inside `async with`: at 8 lookups per boot and one per reconnect (~50-260 a day) a shared session buys nothing and needs shutdown wiring.
- A lookup that times out, gets a non-200, or can't parse `ip=` stores nothing and logs one rate-limited WARNING with the shard and the error type. No retry: the next session looks again.
- **Sentry (call).** The egress IP is kept out of the context sent with an unexpected disconnect. It reaches Sentry only as a breadcrumb: the logging integration (`level=INFO`) attaches INFO and WARNING lines, with their fields, to the next event, as `local_addr` and `remote_addr` already are. Accepted, with no `before_breadcrumb` hook: it is Railway's shared egress address, not a secret, in an owner-only project.
- README, the disconnect-line field list and a short "Splitting the RST half" note: group RST drops by `cf_colo`; for each RST, look for a canary RST within ±2 s (by the app's `time`, not Railway's timestamp) and compare their colos; note any `egress_ip` change near an RST burst.
- Tests: header parse (present, missing, no suffix, lowercase or odd suffix); both log lines carry the fields; the lookup's success, timeout, non-200 and garbled body (aiohttp mocked at the module boundary, or a loopback test server); the lookup runs off the connect path (the connect line and subscribe don't wait for it); cancellation at session end and at shutdown leaves no pending task or warning.

## Task 3: Cloudflare ray in the canary

**Commit (≤5 files):** `scripts/ws-canary/canary.py`, `scripts/ws-canary/test_canary.py`, `scripts/ws-canary/README.md`, this spec's Deploy section if it needs a line.

- After the handshake, read the `cf-ray` header of `ws.response.headers` into the session as `cf_ray` / `cf_colo`, same parsing as Task 2 (duplicated, not imported: the canary is a separate image with no uw-stream code). Both go on the `connect` event and the `drop` record. On the direct (Fly) arms they are `null`. A connect that fails before the handshake completes has no response, so its drop record says `null` too.
- No egress lookup in the canary **(call)**: it runs in the same Railway project and region as uw-stream, so uw-stream's egress lines cover the egress question, and the canary stays on one dependency.
- Tests: parse cases as in Task 2; the `connect` event and the drop record carry the fields; a direct arm gets `null`.
- Deploy: the push redeploys the canary (watch path `/scripts/ws-canary/**`). Its sockets reconnect once.

## Deploy

- Market closed: no push 8:30-15:00 CT on a trading day. Task 3 is outside every nightly watch path.
- Checks after the push:
  - uw-stream: 8 "WS connected" lines with `cf_ray` and a 3-letter `cf_colo`; 8 "egress trace" lines within ~5 s of boot; the minute line carries `memory` with non-null `rss_mb` and `cgroup_mb` and the gauges listed; `/metrics` has `memory`.
  - canary: `connect` events for the Cloudflare arms carry `cf_colo`; the direct arms carry `null`.

## Not in scope

- Any change to reconnect behaviour, Serverless, or the canary's arms.
- A memory alert (logs and `/metrics` only, until there is a baseline to set one against).
- The Sentry routing for the drop reporter's backpressure warnings (a separate question for the owner).

## Open questions (defaults taken)

- Egress lookup in the canary: no (see Task 3).
- A gauge for the rate limiter's or socket stats' own dicts: no; both are keyed by closed sets and bounded.
