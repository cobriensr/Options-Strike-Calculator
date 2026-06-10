"""Upstash-backed distributed lease gating UW websocket connection ownership.

WHY this exists
---------------
UW limits the API token to **10 websocket connections**. ML capture targets
~350 channels → 8 sharded sockets steady-state (safe: 8 ≤ 10). The exposure is
the **deploy handoff**: Railway boots the new container and SIGTERMs the old
concurrently, so for a few seconds BOTH generations hold ~8 sockets → 16 open
→ UW rejects the new gen's joins ("connection limit reached"), which the
connector never retries → the new process runs silently half-subscribed.

A lease makes WS ownership all-or-nothing across daemon generations: a booting
process must acquire the lease BEFORE opening any socket, so the new deploy
waits for the old to release (or for its TTL to lapse) before connecting.

WHY Upstash and not a Postgres advisory lock
---------------------------------------------
`pg_advisory_lock` is *session-scoped* — it releases the instant its backing
connection drops. ``uw-stream/src/db.py`` documents that Neon routinely tears
down connections (scale-down / restart / admin-terminate) and the daemon
retries them. That same churn would **silently release the advisory lock**
mid-life, letting a concurrent deploy re-acquire and connect while the old
daemon's sockets are still open — the 16-connection overlap returns, undetected.
Wrong tool when the substrate drops connections under you.

An Upstash lease is a **TTL'd key**, not a live connection, so it survives Neon
churn entirely. It runs over the aiohttp ``ClientSession`` uw-stream already
uses for the health server + notify path → no new Python dependency.

Upstash REST contract (verified against upstash/docs via Context7, 2026-06-03)
------------------------------------------------------------------------------
- A command is ``POST <base_url>`` with the JSON-array body
  ``["SET", key, val, "NX", "PX", ms]`` (command name first, args follow) and
  an ``Authorization: Bearer <token>`` header.
- Success returns ``{"result": <value>}``; the value may be null / int / str /
  array depending on the command. Failure returns ``{"error": "<msg>"}``.
- ``SET ... NX`` when the key already exists returns Redis nil → the REST API
  surfaces that as ``{"result": null}`` (acquire-not-set). A fresh set returns
  ``{"result": "OK"}``.
- ``EVAL`` returning a Redis integer surfaces as ``{"result": 1}`` / ``{"result": 0}``
  (e.g. our ``PEXPIRE`` / ``DEL`` CAS scripts return 1 when we still own the
  lease, 0 when we don't).

Design notes
------------
- Dependency-injected: the aiohttp session, REST base/token, key, instance id,
  and timings are all constructor args so tests inject a fake REST seam — no
  real network, no module-level global session.
- Pure command/response helpers (``_set_nx_px_command``, ``_parse_*``) are split
  from the thin I/O methods so the wire contract is unit-testable without a
  session.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

from logger_setup import log
from sentry_setup import capture_message

# ----------------------------------------------------------------------
# Lua scripts (module constants — pure, no I/O).
# ----------------------------------------------------------------------

# Compare-and-set renewal: only extend the TTL if we still own the key.
# KEYS[1] = lease key, ARGV[1] = our instance id, ARGV[2] = ttl_ms.
# Returns 1 (PEXPIRE applied — still ours) or 0 (someone else owns it / gone).
_CAS_RENEW_SCRIPT = (
    "if redis.call('GET', KEYS[1]) == ARGV[1] then "
    "return redis.call('PEXPIRE', KEYS[1], ARGV[2]) "
    "else return 0 end"
)

# Compare-and-delete release: only DEL if we still own the key, so we never
# delete a lease that already expired and was re-acquired by the new generation.
# KEYS[1] = lease key, ARGV[1] = our instance id.
# Returns 1 (we owned it, deleted) or 0 (not ours — left untouched).
_CAS_DEL_SCRIPT = (
    "if redis.call('GET', KEYS[1]) == ARGV[1] then "
    "return redis.call('DEL', KEYS[1]) "
    "else return 0 end"
)

# Backoff for the acquire poll loop. The deploy overlap is seconds, so a tight
# poll with a small ceiling keeps a blocked new-gen responsive without hammering
# Upstash. Capped so a long old-gen drain doesn't escalate into minute-long gaps.
_ACQUIRE_POLL_INITIAL_S = 0.5
_ACQUIRE_POLL_MAX_S = 2.0


def _set_nx_px_command(key: str, instance_id: str, ttl_ms: int) -> list[Any]:
    """Build the ``SET key id NX PX ttl`` REST command array (pure).

    NX makes the set conditional on the key being absent (atomic acquire);
    PX stamps the TTL in milliseconds so ownership lapses on its own if the
    holder dies without releasing.
    """
    return ["SET", key, instance_id, "NX", "PX", ttl_ms]


def _eval_command(
    script: str, key: str, *args: str | int
) -> list[Any]:
    """Build an ``EVAL script numkeys key arg...`` REST command array (pure).

    We always use exactly one key (the lease key), so numkeys is hardcoded to 1.
    """
    return ["EVAL", script, 1, key, *args]


def _parse_set_result(payload: dict[str, Any]) -> bool:
    """True if a ``SET ... NX`` acquired the lease, False if it was held.

    Upstash returns ``{"result": "OK"}`` on a fresh set and ``{"result": null}``
    when NX found the key already present. An ``{"error": ...}`` body is NOT a
    "held" signal — it's a config/transport fault — so it raises rather than
    silently reporting not-acquired (which would hang acquire until timeout on
    e.g. a bad token).
    """
    if "error" in payload:
        raise WsLeaseError(str(payload["error"]))
    return payload.get("result") == "OK"


def _parse_eval_result(payload: dict[str, Any]) -> bool:
    """True if an EVAL CAS reported ownership (Redis integer 1), else False.

    Both CAS scripts return 1 when we own the lease and 0 otherwise, so the
    truthiness of the integer result is the ownership verdict. An error body
    raises so a transport/config fault is never mistaken for "lost ownership".
    """
    if "error" in payload:
        raise WsLeaseError(str(payload["error"]))
    return payload.get("result") == 1


class WsLeaseError(RuntimeError):
    """Upstash returned an ``{"error": ...}`` body or a non-2xx HTTP status.

    Distinct from a clean "not acquired / not owned" result so callers can tell
    a transport/config fault (bad token, Upstash 5xx) apart from the normal
    contended outcome.
    """


class WsLease:
    """Single global lease for UW websocket-connection ownership.

    One instance per process. ``acquire`` is called once at boot before any
    Connector is built; ``run_renewal`` runs as a background task for the
    process lifetime; ``release`` is called on graceful shutdown.

    All ownership operations are fenced by ``instance_id`` (a per-process uuid):
    renew and release are compare-and-set so we never extend or delete a lease
    that has already lapsed and been re-acquired by another generation.
    """

    def __init__(
        self,
        *,
        session: Any,
        base_url: str,
        token: str,
        key: str,
        instance_id: str,
        ttl_ms: int,
        renew_ms: int,
    ) -> None:
        """Construct the lease.

        Args:
            session: An aiohttp ``ClientSession`` (DI — tests pass a fake).
            base_url: Upstash REST base URL (``KV_REST_API_URL``); commands
                POST to this root with a JSON-array body.
            token: Upstash REST bearer token (``KV_REST_API_TOKEN``).
            key: The lease key (e.g. ``uw-stream:ws-conn-lease``).
            instance_id: Per-process fencing id (uuid4 stamped at boot).
            ttl_ms: Lease time-to-live in milliseconds.
            renew_ms: Interval between renewals (= ttl/3 by convention).
        """
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._key = key
        self._instance_id = instance_id
        self._ttl_ms = ttl_ms
        self._renew_ms = renew_ms
        self._owns = False

    # ------------------------------------------------------------------
    # Thin I/O — one place that touches the network.
    # ------------------------------------------------------------------

    async def _command(self, command: list[Any]) -> dict[str, Any]:
        """POST a single Upstash REST command array, return the parsed JSON.

        Raises ``WsLeaseError`` on a non-2xx HTTP status so a transport fault
        surfaces instead of being swallowed as a contended/lost result.

        ALSO normalizes connection-level failures: aiohttp wraps OS/DNS/socket
        errors in ``ClientError`` (e.g. ``ClientConnectorError``) and surfaces a
        ``ClientTimeout`` as ``asyncio.TimeoutError``. Neither is a
        ``WsLeaseError``, so without this they would escape ``run_renewal``
        (which only catches ``WsLeaseError``) and silently kill the renewal
        task. Wrapping them as ``WsLeaseError`` lets the loop's consecutive-
        faults tolerance engage on real network blips and recover in-process.
        We deliberately do NOT catch bare ``OSError`` — aiohttp already wraps
        connection/DNS errors in ``ClientError``; catching ``OSError`` risks
        masking unrelated bugs.
        """
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            async with self._session.post(
                self._base_url, json=command, headers=headers
            ) as resp:
                if resp.status >= 400:
                    body = await resp.text()
                    raise WsLeaseError(f"HTTP {resp.status}: {body[:300]}")
                return await resp.json()
        except (TimeoutError, aiohttp.ClientError) as exc:
            raise WsLeaseError(f"transport: {exc!r}") from exc

    # ------------------------------------------------------------------
    # Public API.
    # ------------------------------------------------------------------

    def owns(self) -> bool:
        """True if the last acquire/renew left us holding the lease.

        Best-effort local view (no I/O); ``renew`` updates it as the source of
        truth. Useful for assertions and for ``release`` to short-circuit.
        """
        return self._owns

    async def acquire(self, timeout_s: float) -> bool:
        """Poll ``SET key id NX PX ttl`` with backoff until acquired or timeout.

        Returns True the moment the NX set succeeds (we now hold the lease) and
        sets ``owns()`` True. Returns False if ``timeout_s`` elapses while the
        lease is still held by another generation — the caller should then exit
        non-zero and let Railway restart + retry (we deliberately do NOT
        force-steal: stealing re-introduces the connection overlap we exist to
        prevent).

        Uses a monotonic clock so an NTP correction mid-poll can't extend or
        truncate the deadline.
        """
        deadline = asyncio.get_running_loop().time() + timeout_s
        backoff = _ACQUIRE_POLL_INITIAL_S
        command = _set_nx_px_command(self._key, self._instance_id, self._ttl_ms)

        attempt = 0
        while True:
            attempt += 1
            payload = await self._command(command)
            if _parse_set_result(payload):
                self._owns = True
                log.info(
                    "ws lease acquired",
                    extra={
                        "key": self._key,
                        "instance_id": self._instance_id,
                        "attempts": attempt,
                    },
                )
                return True

            now = asyncio.get_running_loop().time()
            if now >= deadline:
                log.warning(
                    "ws lease acquire timed out",
                    extra={
                        "key": self._key,
                        "timeout_s": timeout_s,
                        "attempts": attempt,
                    },
                )
                return False

            # Don't sleep past the deadline — keeps the timeout tight.
            sleep_for = min(backoff, deadline - now)
            await asyncio.sleep(sleep_for)
            backoff = min(backoff * 2, _ACQUIRE_POLL_MAX_S)

    async def renew(self) -> bool:
        """Atomic CAS renewal: PEXPIRE the lease only if we still own it.

        Returns True if we still hold the lease (TTL extended), False if a CAS
        check found someone else's id or a vanished key (lost ownership).
        Updates ``owns()`` to the verdict so a later ``release`` won't try to
        CAS-DEL a lease we no longer hold.
        """
        command = _eval_command(
            _CAS_RENEW_SCRIPT, self._key, self._instance_id, self._ttl_ms
        )
        payload = await self._command(command)
        still_owned = _parse_eval_result(payload)
        self._owns = still_owned
        return still_owned

    async def release(self) -> bool:
        """Atomic CAS-DEL: delete the lease only if we still own it.

        Called on graceful shutdown so the next generation can acquire
        immediately instead of waiting out the TTL. No-ops (returns False)
        without touching Redis when ``owns()`` is already False — we never
        delete a lease that lapsed and was re-acquired by another process.
        Clears the local ``owns()`` flag regardless.
        """
        if not self._owns:
            return False
        command = _eval_command(_CAS_DEL_SCRIPT, self._key, self._instance_id)
        # Release is best-effort: it lets the next generation acquire without
        # waiting out the TTL, but if Upstash is unreachable (e.g. we're
        # releasing right after an unreachable-fence) we must NOT raise out of
        # the shutdown path — the lease's TTL expires it on its own. The CAS-DEL
        # is instance-fenced regardless, so it can never delete another gen's
        # lease. Clear ``owns`` up front so a partial failure still reflects that
        # we've relinquished it.
        self._owns = False
        try:
            payload = await self._command(command)
            deleted = _parse_eval_result(payload)
        except WsLeaseError as exc:
            log.warning(
                "ws lease release failed (TTL will expire it)",
                extra={"key": self._key, "err": str(exc)},
            )
            return False
        log.info(
            "ws lease released",
            extra={"key": self._key, "deleted": deleted},
        )
        return deleted

    async def run_renewal(
        self, on_lost: Callable[[], Awaitable[None] | None]
    ) -> None:
        """Renew the lease every ``renew_ms`` until ownership is lost.

        Loops: sleep ``renew_ms``, ``renew()``. Fences (invokes ``on_lost``
        exactly once, then returns) only on a CONFIRMED loss of ownership:

        - ``renew()`` returns False — the CAS found another gen's id or a
          vanished key (a GC pause let the TTL lapse, or someone grabbed it).
        - ``renew()`` raises ``WsLeaseError`` (Upstash 5xx / unreachable) on
          enough CONSECUTIVE attempts to span the full TTL — at that point we
          could not have renewed, so the lease has surely lapsed and another
          gen may hold it. A single transient blip is NOT a loss: the TTL gives
          ``ttl_ms // renew_ms`` (~3) attempts of headroom, mirroring
          ``connector.py``'s "log transient transport faults and retry,
          escalate only the unrecoverable" policy. A successful renew resets
          the consecutive-fault counter.

        The wiring layer points ``on_lost`` at the graceful-shutdown trigger so
        the daemon closes its sockets and exits, upholding the invariant "only
        the lease holder has sockets open".

        Cancellation-safe: a ``CancelledError`` (normal graceful shutdown)
        propagates cleanly without firing ``on_lost`` — losing the lease and
        being told to shut down are different events.

        ``on_lost`` may be sync or async; an awaitable return value is awaited.
        """
        renew_s = self._renew_ms / 1000.0
        # Consecutive transport faults that together span the full TTL → the
        # lease has surely lapsed (we couldn't reach Upstash to PEXPIRE it).
        max_consecutive_faults = max(1, self._ttl_ms // self._renew_ms)
        consecutive_faults = 0
        while True:
            await asyncio.sleep(renew_s)
            try:
                still_owned = await self.renew()
            except WsLeaseError as exc:
                consecutive_faults += 1
                log.warning(
                    "ws lease renewal transport error",
                    extra={
                        "key": self._key,
                        "err": str(exc),
                        "consecutive_faults": consecutive_faults,
                        "max_consecutive_faults": max_consecutive_faults,
                    },
                )
                if consecutive_faults < max_consecutive_faults:
                    continue
                # Upstash unreachable across the whole TTL — treat as lost.
                await self._fence(
                    "uw-stream ws lease renewal unreachable",
                    on_lost,
                    reason="upstash_unreachable",
                )
                return
            except Exception as exc:  # defense in depth
                # An UNEXPECTED non-transport error (not WsLeaseError) must
                # never propagate out of the renewal task: main's shutdown
                # gather(return_exceptions=True) would swallow it silently → a
                # clean exit 0 → Railway never restarts (the exact 2026-06-09
                # failure mode, but via a different escape path). Fence it so it
                # is Sentry-captured by ``_fence`` and routes into the same
                # graceful-shutdown-then-restart path, then stop. CancelledError
                # is a BaseException, so a graceful-shutdown cancel is NOT caught
                # here and still propagates cleanly.
                await self._fence(
                    f"uw-stream ws lease renewal error: {exc!r}",
                    on_lost,
                    reason="renewal_error",
                )
                return
            consecutive_faults = 0
            if still_owned:
                continue
            await self._fence(
                "uw-stream ws lease lost", on_lost, reason="ownership_lost"
            )
            return

    async def _fence(
        self,
        message: str,
        on_lost: Callable[[], Awaitable[None] | None],
        *,
        reason: str,
    ) -> None:
        """Log + Sentry-capture a confirmed lease loss and fire ``on_lost`` once.

        ``on_lost`` may be sync or async; an awaitable return value is awaited.
        """
        log.error(
            "ws lease ownership lost — triggering shutdown",
            extra={
                "key": self._key,
                "instance_id": self._instance_id,
                "reason": reason,
            },
        )
        capture_message(
            message,
            level="error",
            tags={"component": "ws_lease"},
            context={
                "key": self._key,
                "instance_id": self._instance_id,
                "reason": reason,
            },
        )
        result = on_lost()
        if asyncio.iscoroutine(result):
            await result
