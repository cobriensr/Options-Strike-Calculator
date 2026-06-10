# uw-stream lease-renewal resilience + self-heal

**Date:** 2026-06-10
**Trigger:** uw-stream died at 15:36 CT 2026-06-09 and never restarted; both Lottery Finder + Silent Boom were starved (zero rows) for the entire 06-10 morning session until a manual `railway redeploy`.

## Goal

Make a transient Upstash/network blip during lease renewal **non-fatal** (recover in-process), and make any genuine lease loss **self-heal** (exit non-zero → Railway restart → re-acquire) instead of dying silently and permanently.

## Root cause (traced to exact lines)

1. `WsLease._command` ([ws_lease.py](../../../uw-stream/src/ws_lease.py)) only converts **HTTP ≥400** responses to `WsLeaseError`. A connection-level failure (timeout, dropped socket, DNS) raises **aiohttp's own exception** (`asyncio.TimeoutError` / `aiohttp.ClientError`), which is NOT `WsLeaseError`.
2. `run_renewal` only catches `WsLeaseError`. So a transport-level renewal failure (the common real-world blip) **escapes uncaught → the renewal task dies**.
3. `asyncio.wait(FIRST_COMPLETED)` in `main._run` returns the dead renewal task → `shutdown initiated reason="ws_lease_renewal"`.
4. `_shutdown` step 4 `gather(*other_tasks, return_exceptions=True)` **silently swallows** the renewal task's exception → no Sentry, no log.
5. Clean exit 0 → Railway's default restart policy does not relaunch a graceful exit → daemon dead until manual redeploy.

This explains every observed symptom: no "ownership lost" log, no Sentry page, `reason="ws_lease_renewal"`, and no auto-restart.

## Changes

### Phase 1 — code + tests (one cohesive change)

**1. `ws_lease.py::_command` — normalize ALL transport faults to `WsLeaseError`.**
Wrap the `session.post(...)` in `try/except (aiohttp.ClientError, asyncio.TimeoutError)` and re-raise as `WsLeaseError(f"transport: {exc!r}")`. (aiohttp wraps OS/DNS/connection errors in `ClientConnectorError ⊂ ClientError`; `ClientTimeout` surfaces as `asyncio.TimeoutError`.) This makes the **existing** consecutive-faults tolerance in `run_renewal` actually engage on real blips → a transient renewal failure now retries and recovers in-process; only a full-TTL-worth of consecutive faults fences. Import `aiohttp` (already a dep; imported in main.py/notify.py).

**2. `run_renewal` — never die silently (defense in depth).**
Add a final `except Exception as exc` safety net around the renew call so an *unexpected* non-transport error fences via `_fence(reason="renewal_error")` (Sentry-captured) and returns, instead of propagating and being swallowed by the shutdown gather.

**3. `main.py` — lease loss exits NON-ZERO so Railway restarts.**
Introduce `lease_lost = asyncio.Event()`. `on_lost` sets BOTH `lease_lost` and `stop` (graceful drain still runs). After `_shutdown(...)` + the "uw-stream stopped" log: `if lease_lost.is_set(): raise SystemExit(1)`. A normal SIGTERM (deploy) leaves `lease_lost` unset → exit 0 (no restart loop on deploys). Mirrors the existing acquire-timeout `SystemExit(1)` intent.

**4. `railway.toml` — explicit restart policy (safety net).**
Add under `[deploy]`:
```toml
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```
ON_FAILURE restarts on non-zero exit (lease loss, acquire timeout) but NOT on clean SIGTERM exit-0 (deploy supersession). `healthcheckPath` stays UNSET (existing documented reasons — holiday false-restarts).

**Tests (TDD — write first, watch fail, then implement):**
- `_command` raises `WsLeaseError` when the injected session raises `aiohttp.ClientError`.
- `_command` raises `WsLeaseError` when the injected session raises `asyncio.TimeoutError`.
- `run_renewal` tolerates a **connection-level** transport error identically to a 503 (retries, recovers on next ok, no fence) — direct regression for this incident.
- `run_renewal` fences (calls on_lost + Sentry) instead of propagating when `renew()` raises an unexpected `Exception` (e.g. `ValueError`).
- `main`: lease-loss shutdown path raises `SystemExit(1)`; normal SIGTERM path exits 0. (Follow existing `test_main.py` patterns; if the harness can't reach the SystemExit cleanly, assert on the `lease_lost`-set branch instead.)

### Phase 2 — alerting (out-of-band, user action in Sentry UI)

With Phase 1, genuine lease loss now Sentry-captures via `_fence` AND self-heals. Remaining gap is a **liveness alert rule** (UI, not code):
- Alert rule on `ws_lease` component messages ("ws lease ... lost / unreachable").
- Wire the existing detect-cron `empty-window` warning (`detect-lottery-fires: empty trade scan during market hours`, `detect-silent-boom: empty bucket scan during market hours`) to a notification channel — it fires every minute during a feed outage but was not routed anywhere. This is the true freshness signal.

## Deploy note

Committing/pushing auto-deploys uw-stream (watchPatterns `uw-stream/**`) → ~30-60s reconnect gap (lease handoff is designed for it). Confirm timing with owner before pushing during market hours.

## Open questions / defaults

- Catch `OSError` too in `_command`? **Default: no** — aiohttp already wraps connection/DNS errors in `ClientError`; adding `OSError` risks masking unrelated bugs. Revisit if a non-ClientError escapes.
- `restartPolicyMaxRetries` value: **default 10** (Railway's own default). After 10 rapid failures it stops — acceptable; a sustained acquire-timeout means a wedged peer that needs eyes anyway.
