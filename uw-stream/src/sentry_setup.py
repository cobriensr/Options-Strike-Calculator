"""Sentry SDK initialization and metrics helpers for uw-stream.

Mirrors the sidecar's pattern (`sidecar/src/sentry_setup.py`) so metric
names and semantics are consistent across services.

The DSN is shared with the sidecar; events are tagged with
`service=uw-stream` so they can be filtered separately in the Sentry UI.

Every helper degrades to a log line when Sentry is disabled so callers
can invoke them unconditionally.
"""

from __future__ import annotations

import os
from typing import Any

from logger_setup import log

_sentry_enabled = False


def _before_send(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any]:
    """Collapse transient DB errors into one Sentry issue across all channels.

    Without an explicit fingerprint, asyncpg connection-class failures
    raised from N different handler `_flush` call sites produce N distinct
    Sentry issues — a single Neon scale-down event split into 7+ groups
    on 2026-05-13. We pin the fingerprint to the exception class name so
    every handler's instance of the same transient failure rolls into one
    issue, while preserving the channel as a tag for triage.

    Imported lazily to avoid a Sentry init → db module load → settings
    requirement at import time (tests stub settings out via env vars).
    """
    try:
        exc_info = hint.get("exc_info") if hint else None
        if not exc_info or len(exc_info) < 2:
            return event
        exc = exc_info[1]
        from db import is_transient_db_error

        if is_transient_db_error(exc):
            event["fingerprint"] = [
                "uw-stream-transient-db",
                type(exc).__name__,
            ]
    except Exception as inner:
        # Never let a fingerprint mistake drop the underlying event.
        log.warning("before_send hook failed: %s", inner)
    return event


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
        )
        # Tag every event so the shared sidecar DSN can be filtered.
        sentry_sdk.set_tag("service", "uw-stream")
        _sentry_enabled = True
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
