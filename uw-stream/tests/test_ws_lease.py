"""Tests for the Upstash-backed WS connection lease.

The lease gates UW websocket ownership across daemon generations so a Railway
redeploy can't briefly run old+new at 16 sockets (UW caps the token at 10) and
silently half-subscribe the new process. These tests pin the wire contract and
the fencing behavior WITHOUT touching the network: a fake aiohttp-session seam
records the JSON command arrays the lease POSTs and replays scripted Upstash
REST responses. The response shapes (``{"result": "OK"}`` on a fresh NX set,
``{"result": null}`` when held, ``{"result": 1|0}`` for the EVAL CAS integer)
match the Upstash REST docs verified via Context7.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from ws_lease import (
    _CAS_DEL_SCRIPT,
    _CAS_RENEW_SCRIPT,
    WsLease,
    WsLeaseError,
    _eval_command,
    _parse_eval_result,
    _parse_set_result,
    _set_nx_px_command,
)

_BASE_URL = "https://fake-upstash.example.com"
_TOKEN = "fake-token"
_KEY = "uw-stream:ws-conn-lease"
_INSTANCE = "instance-abc"


class _FakeResponse:
    """Async-context-manager stand-in for an aiohttp response."""

    def __init__(self, payload: dict[str, Any], status: int = 200) -> None:
        self._payload = payload
        self.status = status

    async def __aenter__(self) -> _FakeResponse:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def json(self) -> dict[str, Any]:
        return self._payload

    async def text(self) -> str:
        return str(self._payload)


class FakeSession:
    """Records every POSTed command array and replays scripted responses.

    ``responses`` is consumed FIFO; each entry is either a payload dict (200) or
    a ``(payload, status)`` tuple for an HTTP-error case. ``sent`` captures the
    JSON body of every call so tests can assert the exact Redis command issued.
    """

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.sent: list[list[Any]] = []
        self.headers_seen: list[dict[str, str]] = []

    def post(self, url: str, *, json: list[Any], headers: dict[str, str]) -> _FakeResponse:
        assert url == _BASE_URL
        self.sent.append(json)
        self.headers_seen.append(headers)
        nxt = self._responses.pop(0)
        if isinstance(nxt, tuple):
            payload, status = nxt
            return _FakeResponse(payload, status=status)
        return _FakeResponse(nxt)


def _make_lease(session: FakeSession, *, renew_ms: int = 9000) -> WsLease:
    return WsLease(
        session=session,
        base_url=_BASE_URL,
        token=_TOKEN,
        key=_KEY,
        instance_id=_INSTANCE,
        ttl_ms=30_000,
        renew_ms=renew_ms,
    )


# ----------------------------------------------------------------------
# Pure helpers — direct input/output assertions, no session.
# ----------------------------------------------------------------------


def test_set_nx_px_command_shape() -> None:
    assert _set_nx_px_command(_KEY, _INSTANCE, 30_000) == [
        "SET",
        _KEY,
        _INSTANCE,
        "NX",
        "PX",
        30_000,
    ]


def test_eval_command_hardcodes_one_key() -> None:
    # numkeys must be 1 (single lease key) and the key precedes the ARGV args.
    assert _eval_command(_CAS_RENEW_SCRIPT, _KEY, _INSTANCE, 30_000) == [
        "EVAL",
        _CAS_RENEW_SCRIPT,
        1,
        _KEY,
        _INSTANCE,
        30_000,
    ]


def test_parse_set_result_ok_vs_null() -> None:
    # Fresh NX set acquires; held key returns null → not acquired.
    assert _parse_set_result({"result": "OK"}) is True
    assert _parse_set_result({"result": None}) is False


def test_parse_eval_result_one_vs_zero() -> None:
    assert _parse_eval_result({"result": 1}) is True
    assert _parse_eval_result({"result": 0}) is False


def test_parse_helpers_raise_on_error_body() -> None:
    # An Upstash error body must raise — NOT be misread as "not acquired" /
    # "lost ownership", which would hang acquire or fake a lost lease.
    with pytest.raises(WsLeaseError, match="WRONGPASS"):
        _parse_set_result({"error": "WRONGPASS invalid password"})
    with pytest.raises(WsLeaseError, match="WRONGPASS"):
        _parse_eval_result({"error": "WRONGPASS invalid password"})


# ----------------------------------------------------------------------
# acquire
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_acquire_succeeds_first_try() -> None:
    session = FakeSession([{"result": "OK"}])
    lease = _make_lease(session)

    assert await lease.acquire(timeout_s=5) is True
    assert lease.owns() is True
    # Exactly one SET, with the NX PX command and a bearer header.
    assert len(session.sent) == 1
    assert session.sent[0] == ["SET", _KEY, _INSTANCE, "NX", "PX", 30_000]
    assert session.headers_seen[0]["Authorization"] == f"Bearer {_TOKEN}"


@pytest.mark.asyncio
async def test_acquire_contended_then_succeeds(monkeypatch) -> None:
    # Held by the old gen for 3 polls, then released → 4th SET acquires.
    session = FakeSession([{"result": None}, {"result": None}, {"result": None}, {"result": "OK"}])
    lease = _make_lease(session)

    # Skip real backoff sleeps so the test doesn't wait on the poll interval.
    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    assert await lease.acquire(timeout_s=60) is True
    assert lease.owns() is True
    assert len(session.sent) == 4
    # Every poll issued the identical NX SET — no force-steal variant.
    for cmd in session.sent:
        assert cmd == ["SET", _KEY, _INSTANCE, "NX", "PX", 30_000]


@pytest.mark.asyncio
async def test_acquire_times_out_returns_false(monkeypatch) -> None:
    # Lease stays held forever; acquire must give up at the deadline and
    # report False (caller exits non-zero — never force-steals).
    session = FakeSession([{"result": None}] * 50)
    lease = _make_lease(session)

    # Drive a monotonic fake clock so the deadline is hit deterministically
    # without real wall-clock waiting. Each loop.time() read advances 0.4s.
    clock = {"t": 0.0}

    class _FakeLoop:
        def time(self) -> float:
            t = clock["t"]
            clock["t"] += 0.4
            return t

    monkeypatch.setattr("ws_lease.asyncio.get_running_loop", lambda: _FakeLoop())

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    assert await lease.acquire(timeout_s=1.0) is False
    assert lease.owns() is False
    # It polled more than once but stopped at the deadline (didn't drain all 50).
    assert 1 < len(session.sent) < 50


# ----------------------------------------------------------------------
# renew
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_renew_when_owned_returns_true_and_issues_pexpire_cas() -> None:
    session = FakeSession([{"result": 1}])
    lease = _make_lease(session)

    assert await lease.renew() is True
    assert lease.owns() is True
    # The renewal is the PEXPIRE CAS EVAL, fenced on our instance id.
    assert session.sent[0] == [
        "EVAL",
        _CAS_RENEW_SCRIPT,
        1,
        _KEY,
        _INSTANCE,
        30_000,
    ]


@pytest.mark.asyncio
async def test_renew_when_not_owned_returns_false() -> None:
    # CAS found someone else's id / vanished key → result 0 → lost ownership.
    session = FakeSession([{"result": 0}])
    lease = _make_lease(session)

    assert await lease.renew() is False
    assert lease.owns() is False


# ----------------------------------------------------------------------
# release
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_release_cas_dels_only_when_owned() -> None:
    session = FakeSession([{"result": "OK"}, {"result": 1}])
    lease = _make_lease(session)

    await lease.acquire(timeout_s=5)
    assert await lease.release() is True
    assert lease.owns() is False
    # Second call is the CAS-DEL EVAL, fenced on our instance id.
    assert session.sent[1] == ["EVAL", _CAS_DEL_SCRIPT, 1, _KEY, _INSTANCE]


@pytest.mark.asyncio
async def test_release_noops_when_not_owned() -> None:
    # Never acquired (or already lost) → release must NOT touch Redis, so it
    # can't delete a lease another generation re-acquired.
    session = FakeSession([])  # any POST would IndexError on pop
    lease = _make_lease(session)

    assert lease.owns() is False
    assert await lease.release() is False
    assert session.sent == []


@pytest.mark.asyncio
async def test_release_tolerates_transport_error_does_not_raise() -> None:
    # Release is best-effort cleanup. If Upstash is unreachable (e.g. releasing
    # right after an unreachable-fence), release must NOT raise out of the
    # shutdown path — the TTL will expire the lease anyway. It clears owns and
    # returns False rather than propagating the WsLeaseError.
    session = FakeSession([{"result": "OK"}, ({"error": "down"}, 503)])
    lease = _make_lease(session)

    await lease.acquire(timeout_s=5)
    assert lease.owns() is True
    assert await lease.release() is False  # did not raise
    assert lease.owns() is False


# ----------------------------------------------------------------------
# run_renewal — fence-on-loss
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_renewal_fires_on_lost_exactly_once_then_stops(
    monkeypatch,
) -> None:
    # Two healthy renewals (result 1), then a lost one (result 0). The loop must
    # invoke on_lost exactly once and return — not keep renewing afterward.
    session = FakeSession([{"result": 1}, {"result": 1}, {"result": 0}])
    lease = _make_lease(session, renew_ms=10)

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    calls = {"n": 0}

    def _on_lost() -> None:
        calls["n"] += 1

    await lease.run_renewal(_on_lost)

    assert calls["n"] == 1
    # Exactly three renewal EVALs were issued (two ok + the lost one), then stop.
    assert len(session.sent) == 3


@pytest.mark.asyncio
async def test_run_renewal_awaits_async_on_lost(monkeypatch) -> None:
    # on_lost may be a coroutine (e.g. wrapping an async shutdown trigger) —
    # the loop must await it, not leave it un-awaited.
    session = FakeSession([{"result": 0}])
    lease = _make_lease(session, renew_ms=10)

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    awaited = {"done": False}

    async def _async_on_lost() -> None:
        awaited["done"] = True

    await lease.run_renewal(_async_on_lost)
    assert awaited["done"] is True


@pytest.mark.asyncio
async def test_run_renewal_tolerates_transient_error_then_fences_on_confirmed_loss(
    monkeypatch,
) -> None:
    # A transient Upstash blip (HTTP 503) mid-loop must NOT fence — the TTL has
    # headroom. The loop logs + continues, and only a CONFIRMED lost result
    # (CAS 0) fires on_lost, exactly once. Sequence: ok, 503, ok, lost.
    session = FakeSession(
        [{"result": 1}, ({"error": "upstream 503"}, 503), {"result": 1}, {"result": 0}]
    )
    lease = _make_lease(session, renew_ms=10)

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    calls = {"n": 0}

    def _on_lost() -> None:
        calls["n"] += 1

    await lease.run_renewal(_on_lost)

    # Fenced exactly once, only on the final confirmed-loss renewal.
    assert calls["n"] == 1
    # All four renewal POSTs were issued (the 503 did not abort the loop).
    assert len(session.sent) == 4


@pytest.mark.asyncio
async def test_run_renewal_fences_after_ttl_worth_of_consecutive_faults(
    monkeypatch,
) -> None:
    # If Upstash is unreachable for a full TTL worth of renewals, the lease has
    # surely lapsed (we couldn't PEXPIRE it) → fence. ttl_ms//renew_ms = 30000//
    # 10000 = 3 consecutive faults trips it. Two faults alone must NOT fence.
    errors = [({"error": "down"}, 503)] * 3
    session = FakeSession(errors)
    lease = _make_lease(session, renew_ms=10_000)  # ttl 30_000 → 3 faults to fence

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    fired = {"n": 0}

    def _on_lost() -> None:
        fired["n"] += 1

    await lease.run_renewal(_on_lost)

    # Fenced exactly once, after the 3rd consecutive fault (not the 1st or 2nd).
    assert fired["n"] == 1
    assert len(session.sent) == 3


@pytest.mark.asyncio
async def test_run_renewal_fault_threshold_clamps_to_one_when_renew_exceeds_ttl(
    monkeypatch,
) -> None:
    # When renew_ms > ttl_ms, ttl_ms // renew_ms == 0; max(1, …) clamps the
    # fault threshold to 1 so a SINGLE transport fault fences (one missed renew
    # already means the lease lapsed). Guards the load-bearing max(1, …) clamp.
    session = FakeSession([({"error": "down"}, 503)])
    lease = _make_lease(session, renew_ms=40_000)  # > ttl_ms (30_000) → max=1

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    fired = {"n": 0}

    def _on_lost() -> None:
        fired["n"] += 1

    await lease.run_renewal(_on_lost)

    assert fired["n"] == 1
    assert len(session.sent) == 1  # fenced on the very first fault


@pytest.mark.asyncio
async def test_run_renewal_successful_renew_resets_fault_accumulation(
    monkeypatch,
) -> None:
    # Faults must be CONSECUTIVE to fence: a successful renew between fault runs
    # resets the counter, so fault,fault,ok,fault,fault never reaches max=3.
    # Only the final confirmed-loss (result 0) fences.
    session = FakeSession(
        [
            ({"error": "down"}, 503),  # fault 1
            ({"error": "down"}, 503),  # fault 2
            {"result": 1},  # ok → reset to 0
            ({"error": "down"}, 503),  # fault 1
            ({"error": "down"}, 503),  # fault 2
            {"result": 0},  # confirmed loss → fence
        ]
    )
    lease = _make_lease(session, renew_ms=10_000)  # max = 30_000 // 10_000 = 3

    async def _no_sleep(_d: float) -> None:
        return None

    monkeypatch.setattr("ws_lease.asyncio.sleep", _no_sleep)

    fired = {"n": 0}

    def _on_lost() -> None:
        fired["n"] += 1

    await lease.run_renewal(_on_lost)

    # Never fenced on faults (max consecutive was 2 < 3); fired once on the loss.
    assert fired["n"] == 1
    assert len(session.sent) == 6


@pytest.mark.asyncio
async def test_run_renewal_cancellation_does_not_fire_on_lost() -> None:
    # Graceful shutdown cancels the renewal task. CancelledError must propagate
    # cleanly WITHOUT firing on_lost — losing the lease and being told to shut
    # down are distinct events.
    session = FakeSession([{"result": 1}] * 100)
    lease = _make_lease(session, renew_ms=10_000)  # long sleep so we cancel mid-wait

    fired = {"n": 0}

    def _on_lost() -> None:
        fired["n"] += 1

    task = asyncio.create_task(lease.run_renewal(_on_lost))
    await asyncio.sleep(0)  # let it reach the first sleep
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert fired["n"] == 0


# ----------------------------------------------------------------------
# transport faults
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_error_status_raises_ws_lease_error() -> None:
    # A 401 (bad token) must raise, not be swallowed as a contended result that
    # would hang acquire until timeout.
    session = FakeSession([({"error": "WRONGPASS"}, 401)])
    lease = _make_lease(session)

    with pytest.raises(WsLeaseError, match="HTTP 401"):
        await lease.acquire(timeout_s=5)
