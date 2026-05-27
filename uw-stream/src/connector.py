"""WebSocket connector.

Single coroutine that owns the connection. On disconnect, exponentially
backs off then reconnects and **resubscribes** every channel — the UW
server forgets joins on disconnect (this is the most common operational
footgun, called out in the unusual-whales-websocket skill).

Every successfully parsed frame is forwarded to the router. The router
is the only thing that decides what to do with a payload; the connector
is a pure transport.
"""

from __future__ import annotations

import asyncio

import orjson
import websockets

from config import settings
from logger_setup import log
from sentry_setup import capture_exception, capture_message
from state import state

# Backoff schedule. We start at 1s and double until 60s; reset to 1s on
# any clean connect.
_INITIAL_BACKOFF_S = 1.0
_MAX_BACKOFF_S = 60.0

# Ping cadence so we get prompt failure detection on a hung TCP. UW
# does not document a server-side keepalive; 20s is conservative.
_PING_INTERVAL_S = 20.0
_PING_TIMEOUT_S = 20.0

# Threshold for raising a Sentry warning if reconnects pile up.
_RECONNECT_STORM_THRESHOLD = 5


class Connector:
    """Manages the lifecycle of a single multiplexed UW WS connection."""

    def __init__(
        self,
        channels: list[str],
        receive_queue: asyncio.Queue,
    ) -> None:
        self.channels = channels
        # Bounded queue between the connector (producer) and the router
        # (consumer). Connector only does ``put_nowait`` so the WS
        # receive task can never block on JSON parsing or handler
        # dispatch — those happen on the router task.
        self._receive_queue = receive_queue

    async def run(self) -> None:
        """Run forever, reconnecting as needed."""
        backoff = _INITIAL_BACKOFF_S
        while True:
            try:
                await self._connect_once()
                # _connect_once returns cleanly only on graceful close.
                # That is unusual; treat it like a transient failure so
                # we do reconnect rather than exit the daemon. We mark
                # disconnect + reconnect for symmetry with the exception
                # branches so /metrics' reconnects_last_hour is accurate.
                state.ws_connected = False
                state.record_reconnect()
                log.info("WS closed cleanly, reconnecting after grace")
                backoff = _INITIAL_BACKOFF_S
                await asyncio.sleep(backoff)
            except (
                websockets.ConnectionClosed,
                # Handshake-rejection variants (HTTP 503, 502, 504, etc. on the
                # WS upgrade) inherit from InvalidHandshake. They were
                # previously falling through to the catch-all `except
                # Exception`, which Sentry-captured every retry — a sustained
                # UW outage produced one Sentry event per backoff cycle
                # (~60s). Treat them like a connection drop: warning log +
                # storm alert + backoff, no per-event capture. The storm
                # alert at >=5 reconnects/hour still surfaces the incident.
                websockets.InvalidHandshake,
            ) as exc:
                state.ws_connected = False
                state.record_reconnect()
                log.warning(
                    "WS connection unavailable",
                    extra={"err": str(exc), "backoff": backoff},
                )
                self._maybe_alert_storm()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF_S)
            except (TimeoutError, OSError) as exc:
                state.ws_connected = False
                state.record_reconnect()
                log.warning(
                    "WS transport error",
                    extra={"err": str(exc), "backoff": backoff},
                )
                self._maybe_alert_storm()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF_S)
            except Exception as exc:
                # Anything we didn't anticipate — Sentry it, then keep
                # trying. The daemon must not exit while market hours
                # are live.
                state.ws_connected = False
                state.record_reconnect()
                capture_exception(exc, tags={"component": "connector"})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF_S)

    async def _connect_once(self) -> None:
        """Open one WS, join channels, drain messages until the socket dies.

        ``state.ws_connected`` only flips to ``True`` AFTER
        ``_subscribe_all`` succeeds — flipping it on TCP/TLS handshake
        completion alone (the obvious place) makes ``/healthz`` lie when
        a typo'd channel name or server-side error frame causes the
        join to fail. The socket would stay open with no data flowing
        and the daemon would report green until the next disconnect.
        """
        log.info("connecting to WS", extra={"channels": self.channels})
        async with websockets.connect(
            settings.ws_url,
            ping_interval=_PING_INTERVAL_S,
            ping_timeout=_PING_TIMEOUT_S,
            max_size=2**22,  # 4 MB; option_trades can carry big arrays
        ) as ws:
            try:
                await self._subscribe_all(ws)
            except Exception as exc:
                # Subscribe failed — leave ws_connected False so /healthz
                # reflects reality and the run() loop reconnects with a
                # fresh handshake on the next iteration. Re-raise so the
                # surrounding try/except in run() bumps the reconnect
                # counter and applies the backoff.
                log.warning(
                    "WS subscribe failed; reconnecting",
                    extra={"err": str(exc)},
                )
                capture_exception(
                    exc,
                    tags={"component": "connector", "stage": "subscribe"},
                )
                raise
            state.ws_connected = True
            log.info("WS connected, awaiting messages")
            async for raw in ws:
                # Hand off to the router via a bounded queue. We never
                # ``await`` here — the WS receive task must never block
                # on parsing or dispatch (those run on the router task).
                # On overflow, drop the oldest frame to make room: under
                # sustained overload we'd rather lose stale ticks than
                # back up the OS receive buffer.
                try:
                    self._receive_queue.put_nowait(raw)
                except asyncio.QueueFull:
                    try:
                        self._receive_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    else:
                        # task_done() balances the get_nowait we just did
                        # so receive_queue.join() (if anyone calls it)
                        # stays correct.
                        self._receive_queue.task_done()
                    # Should be impossible — we just made room — but
                    # defensive in case another producer ever exists.
                    # Log if it ever does happen so we don't drop frames
                    # silently in an "impossible" branch.
                    try:
                        self._receive_queue.put_nowait(raw)
                    except asyncio.QueueFull:
                        log.warning(
                            "receive_queue overflow even after eviction "
                            "— dropping new frame",
                        )
                    state.receive_queue_drops += 1

    async def _subscribe_all(self, ws) -> None:
        """Send a join frame for every configured channel."""
        for ch in self.channels:
            # MUST send as a WS TEXT frame (opcode 0x1), not BINARY (0x2):
            # UW's server only reads join control messages from text frames
            # and silently drops binary ones. orjson.dumps() returns bytes
            # which the websockets lib would send as BINARY — decode to str
            # so it goes out as TEXT.
            frame = orjson.dumps({"channel": ch, "msg_type": "join"}).decode()
            await ws.send(frame)
            # Subscription is pending until the server's ok ack arrives;
            # router flips this flag when it sees the ack.
            state.channel(ch).subscribed = False
            log.info("sent join frame", extra={"channel": ch})

    def _maybe_alert_storm(self) -> None:
        """Raise a Sentry warning if reconnects pile up in the last hour."""
        count = state.reconnects_last_hour()
        if count >= _RECONNECT_STORM_THRESHOLD:
            capture_message(
                "uw-stream reconnect storm",
                level="warning",
                tags={"component": "connector"},
                context={"reconnects_last_hour": count},
            )
