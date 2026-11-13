"""Sentry SDK initialization and metrics helpers for uw-stream.

Mirrors the sidecar's pattern (`sidecar/src/sentry_setup.py`) so metric
names and semantics are consistent across services.

The DSN is shared with the sidecar; events are tagged with
`service=uw-stream` so they can be filtered separately in the Sentry UI.

Every helper degrades to a log line when Sentry is disabled so callers
can invoke them unconditionally.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from logger_setup import log, scrub_log_tokens

_sentry_enabled = False


# The UW WS handshake uses ``wss://api.unusualwhales.com/socket?token=<API_KEY>``
# (UW does not accept the API key as an Authorization header for WS). If an
# upstream handshake error includes the URL in its repr, the key would land
# in Sentry verbatim. We reuse the SAME scrubber the plain-log path uses
# (``logger_setup.scrub_log_tokens``) so the two redaction paths can't drift
# — a previous gap (AUD-L12b) was that only the Sentry path scrubbed.


def _scrub_tokens(value: Any) -> Any:
    """Recursively redact ``?token=...`` query parameters in any string
    encountered while walking ``value``. Returns a new structure so the
    caller can drop the original.
    """
    if isinstance(value, str):
        return scrub_log_tokens(value)
    if isinstance(value, dict):
        return {k: _scrub_tokens(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub_tokens(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_scrub_tokens(v) for v in value)
    return value


def _before_send(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any]:
    """Scrub UW tokens, then collapse transient DB errors into one Sentry issue.

    Step 1 — always-on token redaction (runs regardless of exception
    presence so ``capture_message`` is covered too).

    Step 2 — without an explicit fingerprint, asyncpg connection-class
    failures raised from N different handler ``_flush`` call sites produce
    N distinct Sentry issues — a single Neon scale-down event split into
    7+ groups on 2026-05-13. We pin the fingerprint to the exception
    class name so every handler's instance of the same transient failure
    rolls into one issue, while preserving the channel as a tag for triage.

    ``db.is_transient_db_error`` is imported lazily to avoid a Sentry
    init → db module load → settings requirement at import time (tests
    stub settings out via env vars).
    """
    # Step 1 — scrub tokens. Done first so even if the fingerprint
    # branch raises, the event still leaves with the secret redacted.
    try:
        scrubbed = _scrub_tokens(event)
        if isinstance(scrubbed, dict):
            event = scrubbed
    except Exception as inner:
        log.warning("before_send token scrub failed: %s", inner)

    # Step 2 — fingerprint transient DB errors.
    try:
        exc_info = hint.get("exc_info") if hint else None
        if exc_info and len(exc_info) >= 2:
            exc = exc_info[1]
            from db import is_transient_db_error

            if is_transient_db_error(exc):
                event["fingerprint"] = [
                    "uw-stream-transient-db",
                    type(exc).__name__,
                ]
    except Exception as inner:
        # Never let a fingerprint mistake drop the underlying event.
        log.warning("before_send fingerprint hook failed: %s", inner)
    return event


# Libraries whose own ERROR records are the only trace of a failure. Turning the
# logging integration's event level off (below) dropped them with the rest.
# The ERROR sites on the websockets client path, in websockets 17.4:
#   asyncio/connection.py "keepalive ping failed" (the socket stays open with no
#     pings) and "unexpected internal error";
#   protocol.py "parser failed".
# asyncio's come from ``call_exception_handler`` (base_events.py):
#   "Exception in callback" and "Task exception was never retrieved".
# The websockets server-side sites (server.py, asyncio/server.py) never run here.
_LIBRARY_ERROR_LOGGERS = ("websockets", "asyncio")


def _attach_library_error_handlers() -> None:
    """File one Sentry event for each ERROR record of the libraries above.

    One ``EventHandler`` per logger, however many times this runs: a second
    would file every record twice.

    A handler on a logger also ends the stdlib's last-resort stderr line for
    that logger's records. ``websockets`` already has a ``NullHandler``, so its
    records never reached stderr. ``asyncio`` has none and nothing configures
    the root logger, so its warnings and errors were reaching Railway's logs
    that way; keep them there by attaching the last-resort handler to it.
    """
    from sentry_sdk.integrations.logging import EventHandler

    for name in _LIBRARY_ERROR_LOGGERS:
        library_logger = logging.getLogger(name)
        if any(isinstance(h, EventHandler) for h in library_logger.handlers):
            continue
        if not library_logger.hasHandlers() and logging.lastResort is not None:
            library_logger.addHandler(logging.lastResort)
        library_logger.addHandler(EventHandler(level=logging.ERROR))


def init_sentry() -> None:
    """Initialize Sentry if SENTRY_DSN is set.

    Safe to call multiple times; only the first call initializes.
    No-ops in local development where SENTRY_DSN is unset.
    """
    global _sentry_enabled
    if _sentry_enabled:
        return

    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        log.info("SENTRY_DSN not set — Sentry disabled")
        return

    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        log.warning("sentry_sdk not installed — Sentry disabled")
        return

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("RAILWAY_ENVIRONMENT", "production"),
            sample_rate=1.0,
            traces_sample_rate=0.0,
            server_name="uw-stream",
            release=os.environ.get("RAILWAY_DEPLOYMENT_ID"),
            before_send=_before_send,
            # Every service event is an explicit capture. The SDK's default
            # turns each ERROR log record into an event too, and
            # ``capture_exception`` below logs at error and then sends the
            # exception, so one failure filed two issues. INFO and up stay as
            # breadcrumbs. A failure that was only ever logged at error sends
            # its own capture beside the log line (futures_front_month,
            # futures_trades, main's drain, ``RateLimitedLogger.error``). As
            # nightly/src/monitoring.py does. The libraries' own ERROR records
            # are the exception: see ``_attach_library_error_handlers``.
            integrations=[LoggingIntegration(level=logging.INFO, event_level=None)],
        )
        # Tag every event so the shared sidecar DSN can be filtered.
        sentry_sdk.set_tag("service", "uw-stream")
        _sentry_enabled = True
        _attach_library_error_handlers()
        log.info("Sentry initialized for uw-stream")
    except Exception as exc:
        log.error("Failed to initialize Sentry: %s", exc)


def is_enabled() -> bool:
    return _sentry_enabled


def _apply_scope(
    scope: Any,
    tags: dict[str, str] | None,
    context: dict[str, Any] | None,
) -> None:
    """Apply tags + context onto a Sentry scope."""
    if tags:
        for key, value in tags.items():
            scope.set_tag(key, value)
    if context:
        for key, value in context.items():
            scope.set_extra(key, value)


def capture_exception(
    exc: BaseException,
    *,
    context: dict[str, Any] | None = None,
    tags: dict[str, str] | None = None,
) -> None:
    """Report an exception to Sentry and the structured log."""
    if context:
        log.error("%s (context=%s)", exc, context)
    else:
        log.error("%s", exc)

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            _apply_scope(scope, tags, context)
            sentry_sdk.capture_exception(exc)
    except Exception as inner:
        log.error("Failed to forward exception to Sentry: %s", inner)


def capture_message(
    message: str,
    *,
    level: str = "warning",
    context: dict[str, Any] | None = None,
    tags: dict[str, str] | None = None,
) -> None:
    """Report a non-exception event to Sentry and the structured log."""
    if context:
        log.warning("%s (context=%s)", message, context)
    else:
        log.warning("%s", message)

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            _apply_scope(scope, tags, context)
            sentry_sdk.capture_message(message, level=level)
    except Exception as inner:
        log.error("Failed to forward message to Sentry: %s", inner)
