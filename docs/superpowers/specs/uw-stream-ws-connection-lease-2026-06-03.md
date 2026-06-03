# uw-stream WS connection lease (deploy-overlap guard) — 2026-06-03

## Goal

Prevent uw-stream from exceeding UW's **10-connection-per-token** limit during a
Railway redeploy by gating every WS socket open behind a single Upstash-backed
distributed lease. Only one daemon generation may hold UW connections at a time,
so the new deploy waits for the old to release before connecting — eliminating
the transient `old(8) + new(8) = 16` overlap that silently half-subscribes the
new process (joins rejected, never retried).

## Why a lease, and why Upstash (not a Postgres advisory lock)

UW limits: **50 subscriptions/connection × 10 connections/token = 500 channels**.
ML capture targets ~350 channels → 8 connections steady-state. Steady-state is
safe (8 ≤ 10); the **deploy handoff** is the exposure: Railway boots the new
container and SIGTERMs the old concurrently, so both briefly hold 8 sockets each.

The 10 WS connections are a **shared singleton resource** keyed to the UW token,
so a lease/lock is the right model. Substrate decision:

- **Postgres advisory lock — REJECTED.** `pg_advisory_lock` is session-scoped:
  it releases the instant its connection drops. `uw-stream/src/db.py:55-68`
  documents that Neon routinely tears down connections (scale-down / restart /
  admin-terminate) and retries them. That same churn would **silently release
  the lock** mid-life → a concurrent deploy re-acquires and connects while the
  old daemon's sockets are still open → the 16-connection overlap returns,
  undetected. Wrong tool when the substrate drops connections under you.
- **Upstash REST lease — CHOSEN.** Ownership is a TTL'd key, not a live
  connection, so it survives Neon churn entirely. Implemented over the
  **existing aiohttp session** (uw-stream already uses aiohttp for the health
  server + notify) → **no new Python dependency**, only new env vars.

## Mechanism

Single global lease (the daemon owns all-or-nothing — matches the "all
connections disconnect on redeploy" intent):

- **Key:** `uw-stream:ws-conn-lease`
- **Value:** a per-process instance id (uuid4 stamped at boot) — used for
  fencing so we never delete/renew a lease we no longer own.
- **Acquire (at boot, BEFORE creating any Connector):**
  `SET key <instance-id> NX PX <ttl_ms>`. On failure (held by old gen), poll
  with backoff until acquired or `WS_LEASE_ACQUIRE_TIMEOUT_S` elapses.
- **Renew (background task while alive):** every `renew_ms` (= ttl/3), atomic
  CAS via Lua `EVAL` — `if GET key == instance-id then PEXPIRE key ttl_ms`.
- **Fence on loss:** if a renewal's CAS reports we no longer own the lease
  (someone else's id, or key gone), treat it as FATAL → trigger graceful
  shutdown (closes our sockets) → process exits → Railway restarts it → it
  re-acquires when the slot is free. Guarantees the invariant "only the lease
  holder has sockets open" even through a GC pause that lets the TTL lapse.
- **Release (clean shutdown):** atomic CAS-DEL via Lua —
  `if GET key == instance-id then DEL key`. Never deletes a lease that already
  expired and was grabbed by the new generation.

### Acquire-timeout behavior

If acquire times out (e.g. a wedged old process never releases): **exit
non-zero**, let Railway restart and retry. We do NOT force-steal the lease —
stealing re-introduces the overlap we're preventing. A genuinely wedged old
process is itself surfaced by `/healthz` + the subscription watchdog. Accept
that a wedged old gen can briefly block a deploy (preferable to silent overlap).

## Phases

### Phase 1 — Lease module + tests (no wiring)
- **Create** `uw-stream/src/ws_lease.py`:
  - `class WsLease` with `acquire()`, `renew()`, `release()`, `owns()` over an
    injected aiohttp session + Upstash REST base/token (DI so tests use a fake).
  - `async run_renewal(on_lost: Callable)` loop — calls `renew()` every
    `renew_ms`; invokes `on_lost()` once on a lost-ownership result.
  - Pure command construction (`_set_nx_px_cmd`, `_cas_renew_script`,
    `_cas_del_script`) separated from I/O for unit testing.
- **Create** `uw-stream/tests/test_ws_lease.py`: fake REST client asserting
  acquire NX semantics, contended-acquire retry→timeout, renew CAS owns/!owns,
  fence-on-loss fires `on_lost` exactly once, release CAS-DEL only when owned.

### Phase 2 — Wire into the daemon
- **Modify** `uw-stream/src/main.py`:
  - After `init_pool()`, BEFORE building connectors: construct `WsLease`,
    `await lease.acquire()` (blocks/polls up to timeout; exit non-zero on
    timeout). Skip entirely when `WS_LEASE_ENABLED` is false.
  - Add `run_renewal(on_lost=stop.set)` to `background_tasks` (lost lease →
    sets the same stop Event the signal handlers use → normal graceful
    shutdown path closes sockets).
  - In `_shutdown`, after producers are cancelled (sockets closed), call
    `await lease.release()`.
- No connector/handler/router changes — the lease only gates the boot/teardown
  edges.

### Phase 3 — Config + Railway env
- **Modify** `uw-stream/src/config.py`: add
  `ws_lease_enabled: bool = True`, `kv_rest_api_url: str = ""`,
  `kv_rest_api_token: str = ""`, `ws_lease_ttl_ms: int = 30_000`,
  `ws_lease_renew_ms: int = 10_000`, `ws_lease_acquire_timeout_s: int = 60`.
  Validation: if `ws_lease_enabled` and either KV var is blank → fail fast at
  Settings construction (don't boot a daemon that thinks it's protected but
  isn't).
- **Railway:** add `KV_REST_API_URL` + `KV_REST_API_TOKEN` to the uw-stream
  service (same Upstash store the main app uses). Document in README.

### Phase Verification (LAST)
- Unit suite + ruff green.
- Manual: two local processes against the real Upstash key — second blocks on
  acquire until first releases; kill -9 the first → second acquires within ttl.
- Post-deploy: confirm a Railway redeploy shows new gen logging "waiting for
  lease" then "lease acquired" only after old gen logs "lease released"; UW
  connection count never exceeds 10 (no "limit reached" frames on deploy).

## Data dependencies
- Upstash Redis (existing store) reachable from Railway uw-stream service.
- New Railway env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
- No DB migration, no schema change.

## Thresholds / constants
- `WS_LEASE_TTL_MS = 30_000` — worst-case crash-recovery gap (we tolerate a few
  seconds' WS downtime; gaps backfill via UW full-tape REST).
- `WS_LEASE_RENEW_MS = 10_000` — ttl/3; two missed renewals before expiry.
- `WS_LEASE_ACQUIRE_TIMEOUT_S = 60` — deploy overlap is seconds; 60s covers a
  slow old-gen drain without hanging a deploy forever.
- `WS_LEASE_ENABLED = true` — kill switch for local dev / incident bypass.

## Open questions
1. **Sole WS consumer? — RESOLVED 2026-06-03 (user confirmed): YES.** uw-stream
   is the only process opening UW *websocket* connections on the token (cron/REST
   callers don't count against the WS-connection limit; periscope-scraper is a
   scraper, not UW WS). A single global lease fully protects the 10-connection
   budget; no cross-process coordination needed.
2. **TTL vs drain time.** 30s TTL assumes the old gen closes sockets within ~2s
   of SIGTERM (it does — `_shutdown` cancels producers first). If Railway's
   draining ever runs longer, the new gen just waits longer on acquire; no
   correctness impact. No tuning needed unless deploys feel slow.
3. **Held pending UW cap settling?** This guard is correct regardless of where
   UW lands the 50/connection cap — it protects the 10-*connection* budget,
   which UW has NOT said is changing. Safe to build now even while the
   global-`option_trades` migration stays held.

## Files
- **Create:** `uw-stream/src/ws_lease.py`, `uw-stream/tests/test_ws_lease.py`
- **Modify:** `uw-stream/src/main.py`, `uw-stream/src/config.py`,
  `uw-stream/README.md` (env vars)
- **Railway:** `KV_REST_API_URL`, `KV_REST_API_TOKEN` env vars
