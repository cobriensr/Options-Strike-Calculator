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
# through ``redact_credentials`` (text) and ``_redact_value`` (structures).
#
# Every quantifier below is bounded or linear, so adversarial input cannot
# trigger catastrophic backtracking (see the 100 KB timing test).

# ``scheme://userinfo@``. The userinfo is masked up to the LAST ``@``
# (through up to 8 more ``@``-runs, each segment <= 200 chars), so a
# password holding an unencoded ``@ / # ?`` (an invalid DSN — exactly what
# psycopg2 echoes back) is masked whole. Segments may contain whitespace,
# so a DSN wrapped across lines is still caught. Quotes and ``<>`` end it,
# because messages quote the DSN. Over-redaction (e.g. a normal URL with
# ``@`` later in its path) is the accepted trade-off.
#
# The pattern runs on the REVERSED text. Scanning forward from every
# ``scheme://`` costs a full window scan per candidate (~130 ms on 100 KB of
# ``a://``). Reversed, candidate starts are ``@``-runs only (``(?<!@)@++``),
# and every repetition is bounded and possessive, so the cost stays linear.
_URL_USERINFO_REVERSED_RE = re.compile(
    r"(?<!@)@++(?:[^'\"<>@]{1,200}+@++){0,8}[^'\"<>@]{0,200}//:"
    r"(?P<rscheme>[A-Za-z0-9+.\-]{0,31}[A-Za-z])"
)

# ``key=value`` secrets: libpq conninfo (``password=secret``,
# ``password = 'quoted secret'``, ``sslpassword=...``), URI query params,
# and common token/API-key params. libpq allows whitespace around ``=``,
# so prose like "password= foo" is also masked; over-redaction is the
# safe side. A quote that never closes still has its first token masked.
_KV_SECRET_RE = re.compile(
    r"\b(?P<key>sslpassword|password|access_token|refresh_token|"
    r"api[_-]?key|token)(?P<eq>\s{0,8}=\s{0,8})"
    r"(?:'(?:[^'\\]|\\.){0,256}'|\"(?:[^\"\\]|\\.){0,256}\"|['\"]?[^\s&'\",;)]+)",
    re.IGNORECASE,
)

# ``Authorization: Bearer <token>`` (any case; the value must look like a
# token, 8+ token chars, so prose such as "the bearer of" is left alone)
# and Vercel Blob read-write tokens.
_BEARER_RE = re.compile(
    r"\b(?P<scheme>bearer)\s{1,8}(?=[A-Za-z0-9._~+/=\-]{8})[^\s'\",;]+",
    re.IGNORECASE,
)
_VERCEL_BLOB_TOKEN_RE = re.compile(r"vercel_blob_rw_[A-Za-z0-9_]+")

_REDACTED = "***"

# Token boundary for the fail-closed userinfo pass: whitespace, quotes, <>.
_TOKEN_BOUNDARY_RE = re.compile(r"[\s'\"<>]")

# Dict keys (frame locals, extras, ...) whose value is blanked whatever it
# holds, compared case-insensitively.
_SENSITIVE_KEYS = frozenset(
    {
        "dsn",
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "sslpassword",
        "access_token",
        "refresh_token",
    }
)
_BLANKED = "[redacted]"

_DROPPED_EVENT_MESSAGE = "sidecar event dropped: redaction failed"
# SDK-generated envelope fields that carry no user data. The SDK needs
# ``event_id`` to build the envelope after before_send runs.
_ENVELOPE_KEYS = (
    "event_id",
    "timestamp",
    "level",
    "platform",
    "environment",
    "release",
    "server_name",
)


def redact_credentials(text: str) -> str:
    """Mask credentials in ``text``.

    - URL userinfo: ``postgresql://user:pass@host/db`` →
      ``postgresql://***@host/db``.
    - ``key=value`` secrets (password, sslpassword, token, api_key / api-key
      / apikey, access_token, refresh_token) → ``key=***``.
    - ``Bearer <token>`` → ``Bearer ***``; ``vercel_blob_rw_<id>`` →
      ``vercel_blob_rw_***``.

    Text without credentials is returned unchanged.
    """
    text = _redact_url_userinfo(text)
    text = _KV_SECRET_RE.sub(rf"\g<key>\g<eq>{_REDACTED}", text)
    text = _BEARER_RE.sub(rf"\g<scheme> {_REDACTED}", text)
    return _VERCEL_BLOB_TOKEN_RE.sub(f"vercel_blob_rw_{_REDACTED}", text)


def _redact_url_userinfo(text: str) -> str:
    """Mask ``scheme://userinfo@``.

    Two passes. The regex (``_URL_USERINFO_REVERSED_RE``) handles userinfo
    that spans whitespace, such as a DSN wrapped across lines. Its bounds
    (200-char segments, 8 extra ``@``-runs) would fail OPEN on longer
    passwords, so ``_mask_userinfo_fail_closed`` then masks whatever is
    still unmasked between each ``://`` and the last ``@`` of its token.
    """
    if "@" not in text or "://" not in text:
        return text
    reversed_text = text[::-1]
    masked = _URL_USERINFO_REVERSED_RE.sub(
        rf"@{_REDACTED}//:\g<rscheme>", reversed_text
    )
    return _mask_userinfo_fail_closed(masked[::-1])


def _mask_userinfo_fail_closed(text: str) -> str:
    """Mask everything between ``://`` and the last ``@`` of its token.

    A token runs from ``://`` to the next whitespace, quote or ``<>``, with
    no length cap: a password of any length, or with any number of ``@``s,
    is masked. Linear: each token is scanned once, and the search for the
    next ``://`` resumes at the token end, so a long token holding many
    ``://`` is not rescanned. A span the regex pass already reduced to
    ``***`` is left as-is.
    """
    if "@" not in text or "://" not in text:
        return text
    parts: list[str] = []
    pos = 0
    idx = text.find("://")
    while idx != -1:
        start = idx + 3
        boundary = _TOKEN_BOUNDARY_RE.search(text, start)
        end = boundary.start() if boundary else len(text)
        at = text.rfind("@", start, end)
        already_masked = at - start == len(_REDACTED) and text.startswith(
            _REDACTED, start
        )
        if at != -1 and not already_masked:
            parts.append(text[pos:start])
            parts.append(_REDACTED)
            pos = at
        idx = text.find("://", end)
    parts.append(text[pos:])
    return "".join(parts)


def _is_sensitive_key(key: Any) -> bool:
    return isinstance(key, str) and key.lower() in _SENSITIVE_KEYS


def _redact_value(value: Any) -> Any:
    """Recursively redact credentials in ``value``.

    Strings go through ``redact_credentials``. Bytes are decoded (UTF-8,
    ``errors="replace"``), redacted, and returned as ``str``. Dict values
    whose key is sensitive (``dsn``, ``password``, ``token``, ...) are
    blanked whatever they hold. That covers Sentry frame locals and extras.
    Walks dicts, lists and tuples; other types pass through. Returns a new
    structure rather than mutating the input.
    """
    if isinstance(value, str):
        return redact_credentials(value)
    if isinstance(value, (bytes, bytearray)):
        return redact_credentials(bytes(value).decode("utf-8", errors="replace"))
    if isinstance(value, dict):
        return {
            k: _BLANKED if _is_sensitive_key(k) else _redact_value(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(v) for v in value)
    return value


def _minimal_event(event: Any) -> dict[str, Any]:
    """Build a value-free stand-in for an event that could not be redacted.

    Keeps only the SDK envelope fields, the exception TYPE names, and the
    existing tags (string pairs). No exception values, locals, breadcrumbs,
    extras or message text survive, so nothing unredacted can leak.
    """
    source = event if isinstance(event, dict) else {}
    minimal: dict[str, Any] = {
        key: source[key]
        for key in _ENVELOPE_KEYS
        if isinstance(source.get(key), (str, int, float))
    }
    minimal["message"] = _DROPPED_EVENT_MESSAGE
    minimal.setdefault("level", "error")

    exception = source.get("exception")
    values = exception.get("values") if isinstance(exception, dict) else None
    if isinstance(values, list):
        types = [
            v["type"]
            for v in values
            if isinstance(v, dict) and isinstance(v.get("type"), str)
        ]
        if types:
            minimal["exception"] = {"values": [{"type": t} for t in types]}

    tags = source.get("tags")
    if isinstance(tags, dict):
        minimal["tags"] = {
            k: v for k, v in tags.items() if isinstance(k, str) and isinstance(v, str)
        }
    return minimal


def _before_send(event: Any, hint: Any) -> Any:
    """Sentry ``before_send`` hook: scrub credentials from the whole event.

    Walks every value in the event: exception values, ``message`` and
    ``logentry``, breadcrumbs, extras, and stack-frame locals (where a
    ``dsn`` variable would otherwise carry the password). Never raises. If
    redaction fails, it sends a minimal, value-free event (exception types
    and tags only) rather than the raw one, and logs the failure type.
    """
    try:
        return _redact_value(event)
    except Exception as inner:  # noqa: BLE001 — must never raise into the SDK
        log.warning("before_send credential scrub failed: %s", type(inner).__name__)
        try:
            return _minimal_event(event)
        except Exception:  # noqa: BLE001 — last resort: send nothing
            return None


def _format_for_log(subject: object, context: dict[str, Any] | None) -> str:
    """Render ``subject`` (+ context) for a log line with credentials redacted.

    Context dict values under sensitive keys are blanked before formatting,
    because ``{'password': 'x'}`` has no ``=`` for the text patterns to find.
    """
    text = f"{subject} (context={_redact_value(context)})" if context else str(subject)
    return redact_credentials(text)


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
    log.error("%s", _format_for_log(exc, context))

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
    log.warning("%s", _format_for_log(message, context))

    if not _sentry_enabled:
        return

    try:
        import sentry_sdk

        with sentry_sdk.new_scope() as scope:
            _apply_scope(scope, tags, context)
            sentry_sdk.capture_message(message, level=level)
    except Exception as inner:
        log.error("Failed to forward message to Sentry: %s", inner)
