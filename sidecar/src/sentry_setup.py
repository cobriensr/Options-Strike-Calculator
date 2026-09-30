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
import re
from typing import Any

from logger_setup import log

_sentry_enabled = False


# ---------------------------------------------------------------------------
# Credential redaction
# ---------------------------------------------------------------------------
#
# psycopg2/libpq errors can echo the connection string verbatim (e.g.
# ``invalid dsn: missing "=" after "postgresql://user:pass@host/db"``), and
# Sentry's default scrubber keys on field NAMES ("password", "token"), not on
# secrets embedded inside free text or in innocuously named locals such as
# ``dsn``. Both the log line and the outgoing Sentry event are therefore run
# through ``redact_credentials``.

# ``scheme://userinfo@`` — userinfo cannot contain ``/``, ``@`` or
# whitespace, so ``https://example.com/a@b`` (an ``@`` in the path) is not
# touched.
_URL_USERINFO_RE = re.compile(
    r"(?P<scheme>\b[A-Za-z][A-Za-z0-9+.\-]*://)[^\s/@'\"<>]+@"
)

# libpq ``key=value`` secrets (conninfo strings and URI query params):
# ``password=secret``, ``password = 'quoted secret'``, ``sslpassword=...``.
# libpq allows whitespace around ``=``, so prose like "password= foo" is
# also masked — over-redaction is the safe side of that trade.
_KV_SECRET_RE = re.compile(
    r"\b(?P<key>sslpassword|password)(?P<eq>\s*=\s*)"
    r"(?:'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|[^\s&'\",;)]+)",
    re.IGNORECASE,
)

_REDACTED = "***"


def redact_credentials(text: str) -> str:
    """Mask URL userinfo and libpq password params in ``text``.

    ``postgresql://user:pass@host/db`` → ``postgresql://***@host/db``;
    ``password=secret`` / ``sslpassword='x y'`` → ``password=***``.
    Text without credentials is returned unchanged.
    """
    text = _URL_USERINFO_RE.sub(rf"\g<scheme>{_REDACTED}@", text)
    return _KV_SECRET_RE.sub(rf"\g<key>\g<eq>{_REDACTED}", text)


def _redact_value(value: Any) -> Any:
    """Recursively apply ``redact_credentials`` to every string in ``value``.

    Walks dicts, lists and tuples; any other type passes through as-is.
    Returns a new structure rather than mutating the input.
    """
    if isinstance(value, str):
        return redact_credentials(value)
    if isinstance(value, dict):
        return {k: _redact_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(v) for v in value)
    return value


def _before_send(event: Any, hint: Any) -> Any:
    """Sentry ``before_send`` hook: scrub credentials from the whole event.

    Walks every string in the event — exception values, ``message`` /
    ``logentry``, breadcrumbs, extras, and stack-frame locals (where a
    ``dsn`` variable would otherwise ship the password). Never raises: if
    the walk fails the original event is returned so the error still
    reaches Sentry, and the failure is logged.
    """
    try:
        return _redact_value(event)
    except Exception as inner:  # noqa: BLE001 — must never drop the event
        log.warning("before_send credential scrub failed: %s", type(inner).__name__)
        return event


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
            # Scrub credentials (DSNs, libpq password params) from every
            # outgoing event — see redact_credentials.
            before_send=_before_send,
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


def _apply_scope(
    scope: Any,
    tags: dict[str, str] | None,
    context: dict[str, Any] | None,
) -> None:
    """Apply tags + context onto a Sentry scope.

    Centralizes the loop body shared by ``capture_exception`` and
    ``capture_message``. Tags become filterable scope tags in the
    Sentry UI; context becomes full-fidelity extras attached to the
    event payload. Either or both may be ``None`` (the no-op case).
    """
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
    """Report an exception to Sentry and the structured log.

    Always logs; only forwards to Sentry when initialized. Use this
    from `except` blocks where you want a crash report plus a log line
    without duplicating the call site.

    `tags` become Sentry scope tags (filterable in the Sentry UI).
    `context` becomes scope extras (full-fidelity values in events).
    """
    text = f"{exc} (context={context})" if context else str(exc)
    log.error("%s", redact_credentials(text))

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
    """Report a non-exception event to Sentry and the structured log.

    Used for things like reconnect gaps, definition-lag summaries, and
    pool saturation warnings that aren't exceptions but should still be
    visible in Sentry.

    `tags` become Sentry scope tags (filterable in the Sentry UI).
    `context` becomes scope extras.
    """
    text = f"{message} (context={context})" if context else message
    log.warning("%s", redact_credentials(text))

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            _apply_scope(scope, tags, context)
            sentry_sdk.capture_message(message, level=level)
    except Exception as inner:
        log.error("Failed to forward message to Sentry: %s", inner)
