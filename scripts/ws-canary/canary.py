"""Websocket canary: is Railway or Cloudflare resetting uw-stream's long-lived sockets?

Temporary diagnostic. Spec: docs/superpowers/specs/ws-canary-2026-10-28.md.

Holds four websockets from one process to the same Fly-hosted echo server, two
through Cloudflare (ws.ifelse.io) and two direct (echo.websocket.org), one quiet
and one chatty each. Every drop prints one JSON line with the same fields as
uw-stream's disconnect log, so the two logs compare line for line. Reconnects
forever: 1 s after a connected session drops, and with a 1 s to 60 s exponential
backoff after failed connects. Delete with the Railway service once the verdict is in.
"""

import asyncio
import json
import platform
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import websockets
from websockets.frames import Close

CF_URL = "wss://ws.ifelse.io"  # Cloudflare in front of the Fly echo server
DIRECT_URL = "wss://echo.websocket.org"  # the same Fly echo server, no Cloudflare
CONNECTIONS = (
    ("cf-quiet", CF_URL, False),
    ("cf-chatty", CF_URL, True),
    ("direct-quiet", DIRECT_URL, False),
    ("direct-chatty", DIRECT_URL, True),
)
USER_AGENT = "strike-calculator-ws-canary/1.0"
# Same keepalive as uw-stream's connector, so these sockets look like its sockets.
PING_INTERVAL_S = 20
PING_TIMEOUT_S = 20
RECONNECT_DELAY_S = 1
# Cap for failed-connect backoff: a refusing server (HTTP 429, DNS, TLS) gets about
# one attempt a minute, and one drop line a minute, instead of one a second.
MAX_BACKOFF_S = 60
CHATTY_INTERVAL_S = 1
PAYLOAD_BYTES = 200
# Marks our own frames, so the echo count skips the server's greeting.
PAYLOAD_PREFIX = "ws-canary "
HEARTBEAT_INTERVAL_S = 600


@dataclass
class Session:
    """One connection attempt. A fresh one per attempt, so a failed connect never
    reports the previous socket's age, frames or addresses. ``connected_at`` stays
    None until the websocket handshake completes."""

    connected_at: float | None = None
    frames: int = 0
    last_frame_at: float | None = None
    local_addr: str | None = None
    remote_addr: str | None = None
    # Read from the protocol when the receive loop ends. Used when the drop's
    # exception isn't a ConnectionClosed, which carries its own copies.
    close_rcvd: Close | None = None
    close_sent: Close | None = None


@dataclass
class Conn:
    """One named connection and its counts since boot."""

    name: str
    url: str
    chatty: bool
    session: Session = field(default_factory=Session)
    up: bool = False
    drops: int = 0  # sessions that connected and then ended
    failed_connects: int = 0  # attempts that never completed the handshake
    failed_streak: int = 0  # failed connects since the last one that connected
    frames_closed: int = 0  # frames received by sessions that have ended
    sent: int = 0
    echoes: int = 0

    @property
    def retry_delay_s(self) -> float:
        """Wait before the next attempt. 1 s after a session that connected (its
        drop is the measurement); 1, 2, 4 ... up to 60 s across consecutive failed
        connects."""
        if self.failed_streak == 0:
            return RECONNECT_DELAY_S
        return min(RECONNECT_DELAY_S * 2 ** (self.failed_streak - 1), MAX_BACKOFF_S)

    def end_session(self, exc: BaseException | None, now: float) -> dict[str, object]:
        """Count the ended attempt, start a fresh session, return its drop record."""
        record = drop_record(self.name, self.url, exc, self.session, now)
        if self.session.connected_at is None:
            self.failed_connects += 1
            self.failed_streak += 1
        else:
            self.drops += 1
            self.failed_streak = 0
        self.frames_closed += self.session.frames
        self.session = Session()
        self.up = False
        return record


def format_addr(addr: object) -> str | None:
    """``ip:port``, or ``[ip]:port`` for IPv6; None when there is no address.

    Sockets report ``(host, port)`` for IPv4 and ``(host, port, flowinfo,
    scope_id)`` for IPv6.
    """
    if not isinstance(addr, tuple) or len(addr) < 2:
        return None
    host, port = addr[0], addr[1]
    return f"[{host}]:{port}" if ":" in str(host) else f"{host}:{port}"


def _close_info(close: Close | None) -> dict[str, object] | None:
    return None if close is None else {"code": int(close.code), "reason": close.reason}


def drop_record(
    conn: str, url: str, exc: BaseException | None, session: Session, now: float
) -> dict[str, object]:
    """The spec's per-drop fields. ``exc`` is None after a clean close.

    websockets raises ``ConnectionClosedError`` *from* the transport error that
    killed the socket, so a reset shows up in ``__cause__``; it is None after a
    bare TCP EOF. ``__context__`` is the fallback for an error raised inside an
    ``except`` without ``from``, skipped after ``raise ... from None``.
    """
    if isinstance(exc, websockets.ConnectionClosed):
        close_rcvd, close_sent = exc.rcvd, exc.sent
    else:
        close_rcvd, close_sent = session.close_rcvd, session.close_sent
    cause = None
    if exc is not None:
        cause = exc.__cause__
        if cause is None and not exc.__suppress_context__:
            cause = exc.__context__
    connected = session.connected_at is not None
    return {
        "conn": conn,
        "url": url,
        "exc_type": type(exc).__name__ if exc is not None else None,
        "err": str(exc) if exc is not None else None,
        "close_rcvd": _close_info(close_rcvd),
        "close_sent": _close_info(close_sent),
        "cause_type": type(cause).__name__ if cause is not None else None,
        "cause": repr(cause) if cause is not None else None,
        "cause_errno": cause.errno if isinstance(cause, OSError) else None,
        "session_s": round(now - session.connected_at, 3) if connected else None,
        # None, not 0, when the socket never opened: "never connected" stays
        # distinct from "connected, received nothing".
        "frames": session.frames if connected else None,
        "since_last_frame_s": (
            round(now - session.last_frame_at, 3) if session.last_frame_at is not None else None
        ),
        "local_addr": session.local_addr,
        "remote_addr": session.remote_addr,
    }


def heartbeat_record(conns: Iterable[Conn]) -> dict[str, object]:
    out: dict[str, object] = {}
    for c in conns:
        entry: dict[str, object] = {
            "up": c.up,
            "drops": c.drops,
            "failed_connects": c.failed_connects,
            "frames": c.frames_closed + c.session.frames,
            # Reconnect delay in force; None while connected.
            "backoff_s": None if c.up else c.retry_delay_s,
        }
        if c.chatty:
            entry |= {"sent": c.sent, "echoes": c.echoes}
        out[c.name] = entry
    return {"conns": out}


def chatty_payload(name: str, seq: int) -> str:
    return f"{PAYLOAD_PREFIX}{name} seq={seq} ".ljust(PAYLOAD_BYTES, ".")


def is_echo(msg: object) -> bool:
    return isinstance(msg, str) and msg.startswith(PAYLOAD_PREFIX)


def emit(event: str, **fields: object) -> None:
    line = {"ts": datetime.now(UTC).isoformat(timespec="milliseconds"), "event": event}
    print(json.dumps(line | fields), flush=True)


async def _send_loop(ws: websockets.ClientConnection, conn: Conn) -> None:
    while True:
        await asyncio.sleep(CHATTY_INTERVAL_S)
        await ws.send(chatty_payload(conn.name, conn.sent + 1))
        conn.sent += 1


def _report_sender_failure(conn: Conn, task: asyncio.Task[None]) -> None:
    """Print one line the moment the chatty sender dies of anything but a closed
    socket. The connection keeps receiving, so without this the chatty arm would go
    quiet unnoticed. Cancellation at teardown and ConnectionClosed (the drop line's
    job) print nothing."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is None or isinstance(exc, websockets.ConnectionClosed):
        return
    emit("sender_error", conn=conn.name, exc_type=type(exc).__name__, err=str(exc))


async def _hold(conn: Conn) -> None:
    """Connect, then receive until the socket ends. Raises whatever ended it."""
    s = conn.session
    async with websockets.connect(
        conn.url,
        ping_interval=PING_INTERVAL_S,
        ping_timeout=PING_TIMEOUT_S,
        user_agent_header=USER_AGENT,
    ) as ws:
        s.connected_at = time.monotonic()
        s.local_addr = format_addr(ws.local_address)
        s.remote_addr = format_addr(ws.remote_address)
        conn.up = True
        emit(
            "connect",
            conn=conn.name,
            url=conn.url,
            local_addr=s.local_addr,
            remote_addr=s.remote_addr,
        )
        sender = None
        if conn.chatty:
            sender = asyncio.create_task(_send_loop(ws, conn))
            sender.add_done_callback(lambda task: _report_sender_failure(conn, task))
        try:
            async for msg in ws:
                s.frames += 1
                s.last_frame_at = time.monotonic()
                if is_echo(msg):
                    conn.echoes += 1
        finally:
            s.close_rcvd = ws.protocol.close_rcvd
            s.close_sent = ws.protocol.close_sent
            if sender is not None:
                sender.cancel()
                # Collects the sender's ConnectionClosed (or cancellation) so it
                # isn't reported as "Task exception was never retrieved".
                await asyncio.gather(sender, return_exceptions=True)


async def _run(conn: Conn) -> None:
    while True:
        exc: Exception | None = None
        try:
            await _hold(conn)
        except Exception as e:  # never exit: every failure is one drop line, then reconnect
            exc = e
        emit("drop", **conn.end_session(exc, time.monotonic()))
        await asyncio.sleep(conn.retry_delay_s)


async def _heartbeat(conns: list[Conn]) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL_S)
        emit("heartbeat", **heartbeat_record(conns))


async def main() -> None:
    conns = [Conn(name, url, chatty) for name, url, chatty in CONNECTIONS]
    emit(
        "start",
        websockets=websockets.__version__,
        python=platform.python_version(),
        conns={c.name: c.url for c in conns},
    )
    await asyncio.gather(*(_run(c) for c in conns), _heartbeat(conns))


if __name__ == "__main__":
    asyncio.run(main())
