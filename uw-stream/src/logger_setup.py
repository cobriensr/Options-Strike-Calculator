"""Structured JSON logging for uw-stream.

Format mirrors the sidecar so Railway log drains can parse both
services with the same pipeline.

Also exposes ``RateLimitedLogger``: a per-(scope, kind) throttle for
warning paths that can fire at the WS message rate (e.g. malformed
envelope on every frame after a UW wire-format change). Without this,
``log.warning(...)`` on a thousands-per-second hot path would burn the
asyncio loop on JSON serialization and stdout writes alone, on top of
the Sentry quota burn from one event per call.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime

# The UW WS handshake URL carries the API key as a query param
# (``wss://api.unusualwhales.com/socket?token=<API_KEY>`` — UW does not
# accept it as an Authorization header). If that URL ever reaches a log
# call — directly, in an ``extra`` field, or inside a formatted exception
# repr — the secret would be written to stdout / the Railway log drain in
# plaintext. Sentry already scrubs this in ``sentry_setup._before_send``;
# this is the parallel guard for the plain-log path so the two can't drift.
# Pattern matches ``token=`` (UW today) plus the two most common aliases a
# provider might switch to. Kept here (the lowest-level module, no internal
# deps) so ``sentry_setup`` can import it rather than maintaining a second copy.
_LOG_TOKEN_PATTERN = re.compile(r"([?&])(token|api_key|key)=[^&\s\"']+")


def scrub_log_tokens(text: str) -> str:
    """Redact ``?token=<secret>`` query params in a log string.

    Preserves the param shape (``token=REDACTED``) so triage can still see a
    token was attached. A no-op on strings without a matching param.
    """
    return _LOG_TOKEN_PATTERN.sub(r"\1\2=REDACTED", text)

# Fields that handlers may attach via `extra={}` in log calls. New
# fields are forwarded into the JSON line so we don't have to extend
# this list every time a caller wants to add structured context.
_RESERVED_LOGRECORD_ATTRS = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "asctime",
        "taskName",
    }
)


class JsonFormatter(logging.Formatter):
    """One JSON object per log line, compatible with Railway log drains."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "level": record.levelname.lower(),
            "time": datetime.now(UTC).isoformat(),
            "service": "uw-stream",
            # Scrub any ``?token=<key>`` that leaked into the message (e.g. a
            # handshake error repr carrying the WS URL) before it hits stdout.
            "msg": scrub_log_tokens(record.getMessage()),
        }
        # Forward any structured `extra` fields, scrubbing tokens out of
        # string values (a caller could attach the WS URL as context).
        for key, value in record.__dict__.items():
            if key not in _RESERVED_LOGRECORD_ATTRS and not key.startswith("_"):
                entry[key] = scrub_log_tokens(value) if isinstance(value, str) else value
        if record.exc_info:
            entry["exc"] = scrub_log_tokens(self.formatException(record.exc_info))
        # Final belt-and-braces: a non-string extra (dict/list) could still
        # carry the URL. Scrub the serialized line as a whole so no path
        # leaks the secret, then re-parse is unnecessary — the regex only
        # touches ``token=``-style params, never structural JSON.
        return scrub_log_tokens(json.dumps(entry, default=str))


def get_logger(name: str = "uw-stream") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


log = get_logger()


# ----------------------------------------------------------------------
# Rate-limited warning helper for hot paths.
# ----------------------------------------------------------------------

# Window over which a (scope, kind) tuple emits at most one warning. A
# UW wire-format change can flip thousands of payloads per second into
# a warning branch — without this throttle, log.warning() alone would
# saturate the asyncio loop on JSON serialization + stdout writes.
MALFORMED_PAYLOAD_LOG_INTERVAL_S = 60


@dataclass
class _Bucket:
    """Per-(scope, kind) throttle state.

    Named fields beat indexed-list access (``bucket[0]/[1]/[2]``) for
    readability and let mypy/ruff catch typos at static-analysis time.
    """

    first_logged_at: float
    suppressed_count: int
    head_message: str


class RateLimitedLogger:
    """Per-(scope, kind) log throttle with periodic summary flushes.

    Usage::

        rate_limited_log = RateLimitedLogger()
        rate_limited_log.warning(
            scope="router",
            kind="malformed_envelope",
            message="malformed WS frame (not a 2-element array)",
            extra={"sample": "..."},
        )

    First call per (scope, kind) within the window logs at warning level
    immediately. Subsequent calls in the same window only increment a
    suppressed counter. When the next call lands AFTER the window
    expires, it emits a summary line ``"<msg>: N suppressed in last
    Ns"`` and resets the window.

    A monotonic clock (``time.monotonic``) drives the windows so wall-
    clock jumps (NTP corrections, container migrations) don't reset
    the throttle prematurely.
    """

    def __init__(
        self,
        interval_s: float = MALFORMED_PAYLOAD_LOG_INTERVAL_S,
        *,
        clock=time.monotonic,
    ) -> None:
        self._interval_s = interval_s
        self._clock = clock
        self._state: dict[tuple[str, str], _Bucket] = {}

    def warning(
        self,
        *,
        scope: str,
        kind: str,
        message: str,
        extra: dict | None = None,
    ) -> None:
        """Log a warning, throttled per (scope, kind).

        ``extra`` is forwarded to the underlying logger only on the
        first call per window — the summary line carries just the
        suppressed count so we never dump an unbounded ``extra`` payload
        thousands of times.
        """
        key = (scope, kind)
        now = self._clock()
        bucket = self._state.get(key)

        if bucket is None or (now - bucket.first_logged_at) >= self._interval_s:
            # New window — flush any prior bucket's summary, then log
            # this call as the head of the new window.
            if bucket is not None and bucket.suppressed_count > 0:
                log.warning(
                    "%s: %d occurrences suppressed in last %.0fs",
                    bucket.head_message,
                    bucket.suppressed_count,
                    self._interval_s,
                    extra={
                        "scope": scope,
                        "kind": kind,
                        "suppressed_count": bucket.suppressed_count,
                        "interval_s": self._interval_s,
                    },
                )
            log.warning(
                message,
                extra={"scope": scope, "kind": kind, **(extra or {})},
            )
            # head_message is the truthful summary subject — never
            # overwritten on suppressed paths so the eventual summary
            # quotes the message that ACTUALLY logged at window start.
            self._state[key] = _Bucket(
                first_logged_at=now,
                suppressed_count=0,
                head_message=message,
            )
            return

        # Inside the active window — bump the counter only. Do NOT
        # overwrite head_message: the summary should quote what we
        # actually logged at the window head, not the latest variation.
        bucket.suppressed_count += 1


# Module-level singleton — callers import this rather than constructing
# their own so the suppression buckets are shared across the whole
# process.
rate_limited_log = RateLimitedLogger()
