"""Tests for the canary's log records, socket loop and reconnect timing. No network."""

import asyncio
import contextlib
import errno
import json
import logging
import socket
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK, InvalidHandshake
from websockets.frames import Close

import canary
from canary import (
    CF_URL,
    DIRECT_URL,
    PAYLOAD_BYTES,
    USER_AGENT,
    Conn,
    Session,
    chatty_payload,
    drop_record,
    emit,
    format_addr,
    heartbeat_record,
    is_echo,
)


def _connected(**overrides: object) -> Session:
    fields = {
        "connected_at": 100.0,
        "frames": 42,
        "last_frame_at": 150.25,
        "local_addr": "10.0.0.5:51234",
        "remote_addr": "104.21.3.4:443",
    }
    fields.update(overrides)
    return Session(**fields)


def _record(exc: BaseException | None, session: Session | None = None, now: float = 160.0):
    return drop_record("cf-chatty", CF_URL, exc, session or _connected(), now)


# --- format_addr ---------------------------------------------------------


def test_format_addr_ipv4() -> None:
    assert format_addr(("10.0.0.5", 51234)) == "10.0.0.5:51234"


def test_format_addr_ipv6_brackets_host_and_drops_flow_and_scope() -> None:
    assert format_addr(("2606:4700::6812:1", 443, 0, 0)) == "[2606:4700::6812:1]:443"


def test_format_addr_unavailable() -> None:
    assert format_addr(None) is None
    assert format_addr("/run/sock") is None
    assert format_addr(("10.0.0.5",)) is None


# --- drop_record: exception and cause ------------------------------------


def test_reset_shows_as_cause_with_errno() -> None:
    reset = ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")
    try:
        raise ConnectionClosedError(None, None) from reset
    except ConnectionClosedError as exc:
        rec = _record(exc)
    assert rec["conn"] == "cf-chatty"
    assert rec["url"] == CF_URL
    assert rec["exc_type"] == "ConnectionClosedError"
    assert rec["err"] == "no close frame received or sent"
    assert rec["cause_type"] == "ConnectionResetError"
    assert rec["cause"] == repr(reset)
    assert rec["cause_errno"] == errno.ECONNRESET
    assert rec["close_rcvd"] is None
    assert rec["close_sent"] is None


def test_bare_eof_has_no_cause() -> None:
    rec = _record(ConnectionClosedError(None, None))
    assert rec["cause_type"] is None
    assert rec["cause"] is None
    assert rec["cause_errno"] is None


def test_raise_from_none_hides_the_inner_error() -> None:
    try:
        try:
            {}["upgrade"]
        except KeyError:
            raise InvalidHandshake("missing Upgrade header") from None
    except InvalidHandshake as exc:
        rec = _record(exc)
    assert rec["exc_type"] == "InvalidHandshake"
    assert rec["cause_type"] is None
    assert rec["cause"] is None


def test_implicit_context_is_the_fallback_cause() -> None:
    try:
        try:
            raise TimeoutError(errno.ETIMEDOUT, "timed out")
        except TimeoutError:
            raise RuntimeError("handshake failed")  # noqa: B904 -- implicit context is under test
    except RuntimeError as exc:
        rec = _record(exc)
    assert rec["cause_type"] == "TimeoutError"
    assert rec["cause_errno"] == errno.ETIMEDOUT


def test_explicit_cause_wins_over_context() -> None:
    reset = ConnectionResetError(errno.ECONNRESET, "reset")
    try:
        try:
            raise ValueError("inner")
        except ValueError:
            raise ConnectionClosedError(None, None) from reset
    except ConnectionClosedError as exc:
        rec = _record(exc)
    assert rec["cause_type"] == "ConnectionResetError"


def test_non_oserror_cause_has_no_errno() -> None:
    try:
        raise ConnectionClosedError(None, None) from ValueError("bad frame")
    except ConnectionClosedError as exc:
        rec = _record(exc)
    assert rec["cause_type"] == "ValueError"
    assert rec["cause_errno"] is None


# --- drop_record: close frames -------------------------------------------


def test_connection_closed_carries_its_own_close_codes() -> None:
    exc = ConnectionClosedOK(Close(1000, "bye"), Close(1000, "bye"), True)
    # The session's copies must be ignored when the exception has its own.
    rec = _record(exc, _connected(close_rcvd=Close(1011, "x"), close_sent=None))
    assert rec["close_rcvd"] == {"code": 1000, "reason": "bye"}
    assert rec["close_sent"] == {"code": 1000, "reason": "bye"}


def test_clean_close_reads_close_codes_from_the_session() -> None:
    session = _connected(close_rcvd=Close(1001, "going away"), close_sent=Close(1001, ""))
    rec = _record(None, session)
    assert rec["exc_type"] is None
    assert rec["err"] is None
    assert rec["cause_type"] is None
    assert rec["close_rcvd"] == {"code": 1001, "reason": "going away"}
    assert rec["close_sent"] == {"code": 1001, "reason": ""}


def test_non_connection_closed_error_reads_close_codes_from_the_session() -> None:
    session = _connected(close_rcvd=None, close_sent=Close(1011, "keepalive ping timeout"))
    rec = _record(TimeoutError("timed out"), session)
    assert rec["close_rcvd"] is None
    assert rec["close_sent"] == {"code": 1011, "reason": "keepalive ping timeout"}


# --- drop_record: session fields -----------------------------------------


def test_connected_session_reports_age_frames_and_addresses() -> None:
    rec = _record(ConnectionClosedError(None, None), now=160.0)
    assert rec["session_s"] == 60.0
    assert rec["frames"] == 42
    assert rec["since_last_frame_s"] == 9.75
    assert rec["local_addr"] == "10.0.0.5:51234"
    assert rec["remote_addr"] == "104.21.3.4:443"


def test_session_times_round_to_milliseconds() -> None:
    rec = _record(None, _connected(connected_at=0.0, last_frame_at=0.0), now=1.23456)
    assert rec["session_s"] == 1.235
    assert rec["since_last_frame_s"] == 1.235


def test_connected_without_frames_reports_zero_not_none() -> None:
    rec = _record(None, _connected(frames=0, last_frame_at=None))
    assert rec["frames"] == 0
    assert rec["since_last_frame_s"] is None


def test_never_connected_reports_no_session_fields() -> None:
    exc = socket.gaierror(socket.EAI_NONAME, "Name or service not known")
    rec = _record(exc, Session())
    assert rec["exc_type"] == "gaierror"
    assert rec["session_s"] is None
    assert rec["frames"] is None
    assert rec["since_last_frame_s"] is None
    assert rec["local_addr"] is None
    assert rec["remote_addr"] is None
    assert rec["close_rcvd"] is None
    assert rec["close_sent"] is None


def test_drop_record_has_exactly_the_spec_fields() -> None:
    assert list(_record(None)) == [
        "conn",
        "url",
        "exc_type",
        "err",
        "close_rcvd",
        "close_sent",
        "cause_type",
        "cause",
        "cause_errno",
        "session_s",
        "frames",
        "since_last_frame_s",
        "local_addr",
        "remote_addr",
    ]


# --- Conn bookkeeping and heartbeat --------------------------------------


def test_end_session_counts_drops_and_failed_connects_and_starts_fresh() -> None:
    conn = Conn("cf-chatty", CF_URL, chatty=True)
    conn.up = True
    conn.session = _connected(frames=5)
    rec = conn.end_session(ConnectionClosedError(None, None), now=160.0)
    assert rec["frames"] == 5
    assert conn.up is False
    assert (conn.drops, conn.failed_connects, conn.frames_closed) == (1, 0, 5)
    assert conn.session == Session()

    conn.end_session(OSError("unreachable"), now=170.0)
    assert (conn.drops, conn.failed_connects, conn.frames_closed) == (1, 1, 5)


def test_heartbeat_counts_frames_since_boot_and_chatty_echoes() -> None:
    chatty = Conn("cf-chatty", CF_URL, chatty=True, up=True, drops=2, frames_closed=10)
    chatty.session = _connected(frames=5)
    chatty.sent, chatty.echoes = 30, 29
    quiet = Conn("cf-quiet", CF_URL, chatty=False, failed_connects=3, failed_streak=3)
    assert heartbeat_record([chatty, quiet]) == {
        "conns": {
            "cf-chatty": {
                "up": True,
                "drops": 2,
                "failed_connects": 0,
                "frames": 15,
                "backoff_s": None,
                "sent": 30,
                "echoes": 29,
            },
            "cf-quiet": {
                "up": False,
                "drops": 0,
                "failed_connects": 3,
                "frames": 0,
                "backoff_s": 4,
            },
        }
    }


class _Stop(BaseException):
    """Ends ``_run``'s endless loop from the mocked sleep."""


def test_failed_connects_back_off_to_60s_and_a_connected_session_resets_it(monkeypatch) -> None:
    # One entry per connection attempt: True connects and then drops, False never connects.
    attempts = iter([False] * 8 + [True] + [False] * 2)
    sleeps: list[float] = []

    async def fake_hold(conn: Conn) -> None:
        if next(attempts):
            conn.session.connected_at = time.monotonic()
            raise ConnectionClosedError(None, None)
        raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        if len(sleeps) == 11:
            raise _Stop

    monkeypatch.setattr(canary, "_hold", fake_hold)
    monkeypatch.setattr(canary.asyncio, "sleep", fake_sleep)
    conn = Conn("direct-chatty", DIRECT_URL, chatty=True)
    with pytest.raises(_Stop):
        asyncio.run(canary._run(conn))
    # Failed connects double from 1 s to the 60 s cap; the drop of a session that
    # connected waits 1 s and resets the streak, so the next failure starts at 1 s.
    assert sleeps == [1, 2, 4, 8, 16, 32, 60, 60, 1, 1, 2]
    assert (conn.drops, conn.failed_connects, conn.failed_streak) == (1, 10, 2)


# --- _hold: one socket session against a fake connection ------------------

GREETING = "Request served by fake"


class _FakeWS:
    """Stands in for a websockets ClientConnection. ``receive(ws)`` is an async
    generator scripting the frames ``async for`` sees and how the stream ends."""

    def __init__(self, receive, send_exc: BaseException | None = None) -> None:
        self.local_address = ("10.0.0.5", 51234)
        self.remote_address = ("2606:4700::6812:1", 443, 0, 0)
        self.protocol = SimpleNamespace(close_rcvd=Close(1000, "bye"), close_sent=Close(1001, ""))
        self.sent: list[str] = []
        self.send_failed = asyncio.Event()
        self._receive = receive
        self._send_exc = send_exc

    async def send(self, payload: str) -> None:
        if self._send_exc is not None:
            self.send_failed.set()
            raise self._send_exc
        self.sent.append(payload)

    def __aiter__(self):
        return self._receive(self)


def _patch_connect(monkeypatch, ws: _FakeWS) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []

    @contextlib.asynccontextmanager
    async def fake_connect(url: str, **kwargs):
        calls.append((url, kwargs))
        yield ws

    monkeypatch.setattr(canary.websockets, "connect", fake_connect)
    return calls


def _record_events(monkeypatch) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(canary, "emit", lambda event, **fields: events.append((event, fields)))
    return events


def _run_hold(conn: Conn, caplog, raises: type[BaseException] | None = None) -> list[asyncio.Task]:
    """Run ``_hold`` and return the tasks it left behind (other than its own).

    The 5 s limit turns a sender-cancellation regression into a failure instead
    of a hung suite. Any asyncio ERROR log fails the test: that is how an
    exception inside the sender's done-callback surfaces (e.g. calling
    ``exception()`` on the sender cancelled at teardown).
    """

    async def scenario() -> list[asyncio.Task]:
        if raises is None:
            await asyncio.wait_for(canary._hold(conn), 5)
        else:
            with pytest.raises(raises):
                await asyncio.wait_for(canary._hold(conn), 5)
        return [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    with caplog.at_level(logging.WARNING, logger="asyncio"):
        pending = asyncio.run(scenario())
    asyncio_errors = [
        r.getMessage() for r in caplog.records if r.name == "asyncio" and r.levelno >= logging.ERROR
    ]
    assert asyncio_errors == []
    return pending


def test_hold_records_the_session_and_propagates_the_drop(monkeypatch, caplog) -> None:
    async def receive(ws):
        yield GREETING
        yield chatty_payload("cf-chatty", 1)
        raise ConnectionClosedError(None, None)

    ws = _FakeWS(receive)
    calls = _patch_connect(monkeypatch, ws)
    events = _record_events(monkeypatch)
    conn = Conn("cf-chatty", CF_URL, chatty=True)
    # The chatty sender is mid-sleep at teardown, so this covers its cancellation:
    # it must be collected, and its done-callback must neither log nor print.
    assert _run_hold(conn, caplog, raises=ConnectionClosedError) == []
    [(url, kwargs)] = calls
    assert url == CF_URL
    spec_kwargs = {"user_agent_header": USER_AGENT, "ping_interval": 20, "ping_timeout": 20}
    assert kwargs.items() >= spec_kwargs.items()
    s = conn.session
    assert (s.frames, conn.echoes) == (2, 1)
    assert s.connected_at is not None
    assert s.last_frame_at is not None
    assert s.local_addr == "10.0.0.5:51234"
    assert s.remote_addr == "[2606:4700::6812:1]:443"
    assert s.close_rcvd == Close(1000, "bye")
    assert s.close_sent == Close(1001, "")
    # A cancelled sender reports nothing: the only line is the connect.
    assert events == [
        (
            "connect",
            {
                "conn": "cf-chatty",
                "url": CF_URL,
                "local_addr": "10.0.0.5:51234",
                "remote_addr": "[2606:4700::6812:1]:443",
            },
        )
    ]


def test_hold_returns_on_a_clean_close(monkeypatch, caplog) -> None:
    async def receive(ws):
        yield GREETING

    _patch_connect(monkeypatch, _FakeWS(receive))
    _record_events(monkeypatch)
    conn = Conn("cf-quiet", CF_URL, chatty=False)
    assert _run_hold(conn, caplog) == []
    assert conn.session.frames == 1
    assert conn.echoes == 0


@pytest.mark.parametrize(
    ("send_exc", "reported"),
    [(RuntimeError("boom"), True), (ConnectionClosedError(None, None), False)],
)
def test_sender_failure_is_reported_once_while_receiving_continues(
    monkeypatch, caplog, send_exc: BaseException, reported: bool
) -> None:
    events = _record_events(monkeypatch)
    events_when_resumed: list[str] = []

    async def receive(ws):
        yield GREETING
        await ws.send_failed.wait()
        await asyncio.sleep(0)  # one loop turn: the sender's done-callback runs here
        events_when_resumed.extend(event for event, _ in events)
        yield "still receiving"

    _patch_connect(monkeypatch, _FakeWS(receive, send_exc=send_exc))
    monkeypatch.setattr(canary, "CHATTY_INTERVAL_S", 0)
    conn = Conn("cf-chatty", CF_URL, chatty=True)
    assert _run_hold(conn, caplog) == []
    assert conn.session.frames == 2  # receiving went on after the sender died
    sender_errors = [fields for event, fields in events if event == "sender_error"]
    if reported:
        assert sender_errors == [{"conn": "cf-chatty", "exc_type": "RuntimeError", "err": "boom"}]
        # Printed when the sender failed, not when the socket closed.
        assert "sender_error" in events_when_resumed
    else:
        assert sender_errors == []  # a closed socket is the drop line's job


# --- payload and output --------------------------------------------------


def test_chatty_payload_is_fixed_size_and_numbered() -> None:
    payload = chatty_payload("direct-chatty", 7)
    assert len(payload.encode()) == PAYLOAD_BYTES
    assert "direct-chatty" in payload
    assert "seq=7 " in payload
    assert is_echo(payload)


def test_is_echo_ignores_server_greetings_and_binary() -> None:
    assert not is_echo("Request served by 4d896d95b55478")
    assert not is_echo(chatty_payload("cf-chatty", 1).encode())


def test_emit_prints_one_json_line_with_utc_ts_and_event_first(capsys) -> None:
    emit("drop", conn="cf-quiet", frames=None)
    out = capsys.readouterr().out
    assert out.count("\n") == 1
    line = json.loads(out)
    assert list(line)[:2] == ["ts", "event"]
    assert line["event"] == "drop"
    assert line["conn"] == "cf-quiet"
    assert line["frames"] is None
    assert datetime.fromisoformat(line["ts"]).utcoffset() == timedelta(0)
