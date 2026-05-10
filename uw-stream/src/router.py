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

import asyncio
import random
from typing import Protocol

import orjson

from config import settings
from logger_setup import log, rate_limited_log
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

    async def run(self, receive_queue: asyncio.Queue) -> None:
        """Consume raw frames from the connector → router queue forever.

        Decouples the WS receive task (which only does ``put_nowait``)
        from JSON parsing + handler dispatch. ``state.receive_queue_depth``
        is updated each iteration so /metrics shows whether the router
        is keeping up with the receive rate.
        """
        while True:
            raw = await receive_queue.get()
            try:
                await self.dispatch(raw)
            finally:
                receive_queue.task_done()
                state.receive_queue_depth = receive_queue.qsize()

    async def dispatch(self, raw: str | bytes) -> None:
        """Parse one WS frame and route to the matching handler.

        Malformed-payload warnings are routed through
        ``rate_limited_log`` because a UW wire-format change can flip
        thousands of frames per second into one of these branches —
        unbounded ``log.warning`` would saturate the asyncio loop on
        JSON serialization + stdout writes alone.
        """
        try:
            parsed = orjson.loads(raw)
        except orjson.JSONDecodeError as exc:
            rate_limited_log.warning(
                scope="router",
                kind="malformed_json",
                message="malformed WS frame (not JSON)",
                extra={"err": str(exc)},
            )
            return

        if not isinstance(parsed, list) or len(parsed) != 2:
            rate_limited_log.warning(
                scope="router",
                kind="malformed_envelope",
                message="malformed WS frame (not a 2-element array)",
                extra={"sample": _truncate(parsed)},
            )
            return

        channel, payload = parsed

        if not isinstance(channel, str):
            rate_limited_log.warning(
                scope="router",
                kind="non_string_channel",
                message="channel is not a string",
                extra={"sample": _truncate(parsed)},
            )
            return

        # Detect the server's "you joined OK" ack. The server replies
        # with `["channel", {"response": {}, "status": "ok"}]` shortly
        # after a join frame.
        if _is_join_ack(payload):
            state.channel(channel).subscribed = True
            log.info("channel ack received", extra={"channel": channel})
            return

        if not isinstance(payload, dict):
            rate_limited_log.warning(
                scope="router",
                kind="non_dict_payload",
                message="payload is not a dict",
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
            # Same throttle treatment — a config drift could spam this
            # on every payload until the next deploy fixes it.
            rate_limited_log.warning(
                scope="router",
                kind="no_handler_registered",
                message="no handler registered",
                extra={"channel": channel},
            )
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
