"""Sentry SDK initialization and metrics helpers for the futures sidecar.

Mirrors the pattern established in `api/_lib/sentry.ts` on the Vercel
side so metric names and semantics are consistent across both surfaces.

The SDK is initialized lazily via `init_sentry()` which is called once at
startup from `main.py`. If `SENTRY_DSN` is unset (local development), the
init is a no-op and every metrics helper silently degrades to a log line
— the caller never has to branch on whether Sentry is available.

All errors captured by Sentry are also logged via the sidecar's existing
structured logger so Railway log drains still see them.
"""

from __future__ import annotations

import os
from typing import Any

from logger_setup import log

_sentry_enabled = False


def init_sentry() -> None:
    """Initialize Sentry if SENTRY_DSN is set.

    Safe to call multiple times; only the first call actually initializes.
    No-ops in local development where SENTRY_DSN is unset.

    Env vars:
        SENTRY_DSN — Project DSN from the Vercel Sentry integration.
                     Must be set on Railway for reporting to happen.
        RAILWAY_ENVIRONMENT — Defaults to "production" when DSN is set.
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
            # 1.0 → capture every error. Futures sidecar generates
            # relatively rare errors (reconnects, definition lag, DB
            # hiccups) so we want them all.
            sample_rate=1.0,
            # No tracing — not needed for a pure data relay.
            traces_sample_rate=0.0,
            # Identify which service the events are coming from in the
            # Sentry UI. The Vercel backend is its own service; this is
            # separate so we can filter.
            server_name="futures-sidecar",
            release=os.environ.get("RAILWAY_DEPLOYMENT_ID"),
        )
        _sentry_enabled = True
        log.info("Sentry initialized for futures-sidecar")
    except Exception as exc:
        # Never let a Sentry init failure block sidecar startup.
        log.error("Failed to initialize Sentry: %s", exc)


def is_enabled() -> bool:
    """True if Sentry was successfully initialized."""
    return _sentry_enabled


# ---------------------------------------------------------------------------
# Metrics / capture helpers
# ---------------------------------------------------------------------------
#
# Every helper degrades to a log line when Sentry is disabled so callers
# can invoke them unconditionally without polluting business logic with
# `if sentry_enabled:` branches.


def capture_exception(exc: BaseException, *, context: dict[str, Any] | None = None) -> None:
    """Report an exception to Sentry and the structured log.

    Always logs; only forwards to Sentry when initialized. Use this
    from `except` blocks where you want a crash report plus a log line
    without duplicating the call site.
    """
    if context:
        log.error("%s (context=%s)", exc, context)
    else:
        log.error("%s", exc)

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            if context:
                for key, value in context.items():
                    scope.set_extra(key, value)
            sentry_sdk.capture_exception(exc)
    except Exception as inner:
        log.error("Failed to forward exception to Sentry: %s", inner)


def capture_message(
    message: str,
    *,
    level: str = "warning",
    context: dict[str, Any] | None = None,
) -> None:
    """Report a non-exception event to Sentry and the structured log.

    Used for things like reconnect gaps, definition-lag summaries, and
    pool saturation warnings that aren't exceptions but should still be
    visible in Sentry.
    """
    if context:
        log.warning("%s (context=%s)", message, context)
    else:
        log.warning("%s", message)

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            if context:
                for key, value in context.items():
                    scope.set_extra(key, value)
            sentry_sdk.capture_message(message, level=level)
    except Exception as inner:
        log.error("Failed to forward message to Sentry: %s", inner)
