"""Message router.

Parses each raw WS frame, filters out join-ack metadata, and dispatches
the payload to the channel's registered handler.

The wire format for every UW WS message is a 2-element JSON array:

    [<channel_name>, <payload_object>]

Join acks share the same envelope but the payload looks like
``{"response": {}, "status": "ok"}`` rather than channel data. We
detect those, flip the channel's `subscribed` flag, and skip dispatch.
"""

from __future__ import annotations

import random
from typing import Protocol

import orjson

from config import settings
from logger_setup import log
from sentry_setup import capture_exception
from state import state


class Handler(Protocol):
    """Minimal interface every channel handler must satisfy."""

    name: str

    async def enqueue(self, payload: dict) -> None: ...


class Router:
    """Owns a `channel → handler` table and dispatches payloads."""

    def __init__(self, handlers: dict[str, Handler]) -> None:
        self.handlers = handlers

    async def dispatch(self, raw: str | bytes) -> None:
        """Parse one WS frame and route to the matching handler."""
        try:
            parsed = orjson.loads(raw)
        except orjson.JSONDecodeError as exc:
            log.warning("malformed WS frame (not JSON)", extra={"err": str(exc)})
            return

        if not isinstance(parsed, list) or len(parsed) != 2:
            log.warning(
                "malformed WS frame (not a 2-element array)",
                extra={"sample": _truncate(parsed)},
            )
            return

        channel, payload = parsed

        if not isinstance(channel, str):
            log.warning("channel is not a string", extra={"sample": _truncate(parsed)})
            return

        # Detect the server's "you joined OK" ack. The server replies
        # with `["channel", {"response": {}, "status": "ok"}]` shortly
        # after a join frame.
        if _is_join_ack(payload):
            state.channel(channel).subscribed = True
            log.info("channel ack received", extra={"channel": channel})
            return

        if not isinstance(payload, dict):
            log.warning(
                "payload is not a dict",
                extra={"channel": channel, "sample": _truncate(payload)},
            )
            return

        state.touch(channel)

        # Optional sampling for verbose debug, off in prod by default.
        if (
            settings.ws_log_sample_rate > 0
            and random.random() < settings.ws_log_sample_rate
        ):
            log.info(
                "sampled message",
                extra={"channel": channel, "sample": _truncate(payload)},
            )

        handler = self.handlers.get(channel)
        if handler is None:
            log.warning("no handler registered", extra={"channel": channel})
            return

        try:
            await handler.enqueue(payload)
        except Exception as exc:
            capture_exception(
                exc,
                tags={"component": "router", "channel": channel},
            )


def _is_join_ack(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("status") == "ok"
        and "response" in payload
    )


def _truncate(obj: object, limit: int = 200) -> str:
    """Stringify an object capped at ``limit`` chars for log lines."""
    s = repr(obj)
    return s if len(s) <= limit else s[:limit] + "…"
