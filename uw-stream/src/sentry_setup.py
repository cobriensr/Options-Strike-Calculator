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
from collections.abc import Sequence
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


# What the SDK writes in place of a value it filters.
_FILTERED = "[Filtered]"


def _blank_secret_headers(event: dict[str, Any]) -> None:
    """Replace, in place, the value of every request header named like a secret.

    The SDK's aiohttp integration attaches the request's headers to every event
    captured while a request is handled (an unhandled error in a route, or a
    report made from one). Its own redaction list covers Authorization, Cookie,
    X-API-Key, X-Forwarded-For and X-Real-IP, not ``X-Metrics-Token``, so the
    token a caller sent, right or wrong, would travel with the event. Any header
    whose lowercased name contains ``token`` or ``secret`` is blanked, which keeps
    a future header of that kind out too. The event and the other headers stay.
    """
    request = event.get("request")
    if not isinstance(request, dict):
        return
    headers = request.get("headers")
    if not isinstance(headers, dict):
        return
    for name in headers:
        if isinstance(name, str) and ("token" in name.lower() or "secret" in name.lower()):
            headers[name] = _FILTERED


def _before_send(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any]:
    """Blank secret headers, scrub UW tokens, then collapse transient DB errors
    into one Sentry issue.

    Step 0 — blank request headers named like a secret (``_blank_secret_headers``).
    It can't raise on any event shape, and it runs first and outside the guarded
    steps below: if it ever did, the SDK would drop the event, which is the safe
    way to fail for a header that may hold a credential.

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
    # Step 0 — blank secret headers (see the docstring for why it is unguarded).
    _blank_secret_headers(event)

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
# asyncio's go through ``call_exception_handler``, whose default handler
# (base_events.py) logs them at ERROR. The messages are built elsewhere, in
# CPython 3.12:
#   "Exception in callback" in events.py (``Handle._run``);
#   "Task exception was never retrieved" in futures.py (``Future.__del__``). The
#     literal is not in the source: it is
#     ``f'{self.__class__.__name__} exception was never retrieved'``, and the
#     class name supplies "Task". The C accelerator ``_asyncio`` builds the same
#     text.
# The websockets server-side sites (server.py, asyncio/server.py) never run here.
_LIBRARY_ERROR_LOGGERS = ("websockets", "asyncio")


def _attach_library_error_handlers() -> None:
    """File one Sentry event for each ERROR record of the libraries above.

    One ``EventHandler`` per logger, however many times this runs: a second
    would file every record twice.

    A handler on a logger also ends the stdlib's last-resort stderr line for
    that logger's records. Neither logger has a handler of its own (websockets
    17.4 adds no ``NullHandler``) and nothing configures the root logger, so
    before this change both loggers' WARNING and ERROR records reached stderr,
    and so Railway's logs, through ``logging.lastResort``. Keep them there by
    attaching the last-resort handler to each.

    That choice is a snapshot taken once, at init. Root logging configured
    BEFORE ``init_sentry`` (``basicConfig``, a root handler) is already handled:
    ``hasHandlers()`` is then true, the ``lastResort`` branch is skipped, and
    the root handler prints each line once. Root logging configured AFTER
    ``init_sentry`` is not: ``lastResort`` is already attached, so these
    loggers would print every WARNING and ERROR line twice, once through it and
    once through the root handler. Then drop the ``lastResort`` branch.
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
            # Send no frame local variables. The SDK's default records every
            # local of every frame an error passes through, and a secret held
            # in a local (a token being compared, a setting) would travel with
            # it. The key-name scrubs in ``_before_send`` and the compare in
            # ``health._check_token`` stay as a second layer. As
            # nightly/src/monitoring.py does.
            include_local_variables=False,
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


# The stdlib level of ``capture_message``'s own log line, by the Sentry level the
# event is filed at.
_MESSAGE_LOG_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
    "fatal": logging.CRITICAL,
}


def _format_message(template: str, params: Sequence[object]) -> str:
    """``template % params``, or the template with the arguments beside it when they disagree."""
    try:
        return template % tuple(params)
    except (TypeError, ValueError):
        return f"{template} {tuple(params)!r}"


def capture_message(
    message: str,
    *,
    level: str = "warning",
    context: dict[str, Any] | None = None,
    tags: dict[str, str] | None = None,
    params: Sequence[object] = (),
) -> None:
    """Report a non-exception event to Sentry and the structured log.

    The log line is at the level the event is filed at, so an ``error`` capture
    is an ERROR line in Railway's logs. Before 2026-11-14 it was always a WARNING.
    An ERROR line files no second event: ``init_sentry`` sets
    ``event_level=None``, so the line is a breadcrumb on the capture. A ``level``
    outside ``_MESSAGE_LOG_LEVELS`` logs at WARNING, as the line always did, and
    does not raise: a reporting helper must not fail the caller that is reporting.

    With ``params``, ``message`` is a ``%``-style template. The log line carries the
    formatted text; the event carries the template and the arguments apart, as the
    SDK's logging integration files a record logged as ``log.error(template, *args)``.
    Sentry groups that event by the template, so a message that names a varying value
    (a client address) is one issue, not one per value. Put request-derived text in
    ``params``, never in ``message``. Without ``params`` the text is sent as it is,
    which is what every existing caller wants.
    """
    log_level = _MESSAGE_LOG_LEVELS.get(level, logging.WARNING)
    text = _format_message(message, params) if params else message
    if context:
        log.log(log_level, "%s (context=%s)", text, context)
    else:
        log.log(log_level, "%s", text)

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            _apply_scope(scope, tags, context)
            if params:
                sentry_sdk.capture_event(
                    {
                        "logentry": {
                            "message": message,
                            "formatted": text,
                            "params": list(params),
                        },
                        "level": level,
                    }
                )
            else:
                sentry_sdk.capture_message(message, level=level)
    except Exception as inner:
        log.error("Failed to forward message to Sentry: %s", inner)
