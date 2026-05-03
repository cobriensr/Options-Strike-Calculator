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

    def __init__(self, channels: list[str], on_message) -> None:
        self.channels = channels
        # Callback signature: async (raw_msg: str | bytes) -> None
        self._on_message = on_message

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
            except websockets.ConnectionClosed as exc:
                state.ws_connected = False
                state.record_reconnect()
                log.warning(
                    "WS connection closed",
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
        """Open one WS, join channels, drain messages until the socket dies."""
        log.info("connecting to WS", extra={"channels": self.channels})
        async with websockets.connect(
            settings.ws_url,
            ping_interval=_PING_INTERVAL_S,
            ping_timeout=_PING_TIMEOUT_S,
            max_size=2**22,  # 4 MB; option_trades can carry big arrays
        ) as ws:
            state.ws_connected = True
            await self._subscribe_all(ws)
            log.info("WS connected, awaiting messages")
            async for raw in ws:
                # orjson.loads handles both str and bytes; defer parsing
                # to the router so connector stays a pure transport.
                await self._on_message(raw)

    async def _subscribe_all(self, ws) -> None:
        """Send a join frame for every configured channel."""
        for ch in self.channels:
            frame = orjson.dumps({"channel": ch, "msg_type": "join"})
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
