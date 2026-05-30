"""Shared transient-failure retry helpers for the nightly EOD pipeline.

Standalone module (no third-party deps) so any script in scripts/ can
`import _pipeline_retry` — when a script is run as
`ml/.venv/bin/python scripts/foo.py`, its own directory is on sys.path[0],
so this resolves without packaging.

Why this exists: the nightly Makefile chains a dozen scripts that each make a
single attempt at an external call (UW REST, Neon Postgres, Vercel Blob,
Cloudflare R2). A transient blip — a momentary UW edge 403, a Neon multi-hour
serverless hiccup, a CDN 503 — would abort the whole run. These helpers add a
bounded exponential backoff around those calls. A *permanent* failure simply
exhausts the retries and still fails loud, so success/exit semantics are
unchanged; we only paper over the transient case.

The backoff cadence (6 attempts: 1, 2, 4, 8, 16, 32s) mirrors the original
fetch_ticker loop in backfill_net_flow_history.py so behavior stays familiar.
"""

from __future__ import annotations

import sys
import time
from typing import Callable, Iterable, TypeVar

T = TypeVar('T')

# HTTP status codes treated as transient and worth retrying. 403 is included
# deliberately: the 2026-05-29 nightly failure was a uniform UW edge 403 burst
# that cleared on re-probe. A genuine auth/permission 403 will exhaust the
# retries and still surface — we lose ~63s, not correctness.
RETRYABLE_HTTP_STATUS: frozenset[int] = frozenset({403, 429, 500, 502, 503, 504})

DEFAULT_ATTEMPTS = 6
DEFAULT_BASE_DELAY = 1.0
DEFAULT_MAX_DELAY = 60.0


def is_retryable_http_status(code: int) -> bool:
    """True if an HTTP status should be retried with backoff."""
    return code in RETRYABLE_HTTP_STATUS


def is_retryable_db_error(exc: BaseException) -> bool:
    """True for transient psycopg2 errors (Neon blips / dropped connections).

    Imports psycopg2 lazily so this module stays usable in scripts that have
    no DB dependency.
    """
    try:
        import psycopg2
    except ImportError:  # pragma: no cover - psycopg2 always present in pipeline
        return False
    return isinstance(exc, (psycopg2.OperationalError, psycopg2.InterfaceError))


def backoff_delay(
    attempt: int,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
) -> float:
    """Exponential delay for a zero-based attempt index, capped at max_delay."""
    return min(max_delay, base_delay * (2 ** attempt))


def retry_call(
    fn: Callable[[], T],
    *,
    retryable: Callable[[BaseException], bool],
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    label: str = 'call',
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Call fn() with bounded exponential backoff on retryable exceptions.

    fn must raise to signal failure. `retryable(exc)` decides whether an
    exception is transient (retry) or permanent (re-raise immediately). After
    the final attempt the last exception propagates unchanged, so callers keep
    their existing fail-loud behavior.

    `sleep` is injectable so tests don't wait real seconds.
    """
    last_exc: BaseException | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001 - predicate decides retry
            if not retryable(exc) or attempt == attempts - 1:
                raise
            last_exc = exc
            wait = backoff_delay(attempt, base_delay, max_delay)
            print(
                f'[retry] {label} attempt {attempt + 1}/{attempts} failed '
                f'({type(exc).__name__}: {exc}); retrying in {wait:.0f}s',
                file=sys.stderr,
            )
            sleep(wait)
    # Unreachable: the loop either returns or raises. Guards type-checkers.
    assert last_exc is not None
    raise last_exc


def connect_with_retry(
    dsn: str,
    *,
    attempts: int = DEFAULT_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY,
    max_delay: float = DEFAULT_MAX_DELAY,
    sleep: Callable[[float], None] = time.sleep,
    **connect_kwargs,
):
    """psycopg2.connect with backoff on transient Neon connection errors.

    A permanent failure (bad DSN, auth) is not in is_retryable_db_error's set,
    so it raises on the first attempt exactly as a plain connect would.
    """
    import psycopg2

    return retry_call(
        lambda: psycopg2.connect(dsn, **connect_kwargs),
        retryable=is_retryable_db_error,
        attempts=attempts,
        base_delay=base_delay,
        max_delay=max_delay,
        label='psycopg2.connect',
        sleep=sleep,
    )


def status_retryable(status_codes: Iterable[int] = RETRYABLE_HTTP_STATUS):
    """Build a `retryable` predicate for a known set of HTTP status codes.

    Returns a predicate over exceptions that pulls a status code off the
    exception via a `.code` (urllib HTTPError) or `.status_code` attribute,
    falling back to a `_pipeline_status` attribute callers can stamp on a
    custom exception. Exceptions with no discoverable status are treated as
    transport errors and retried.
    """
    codes = frozenset(status_codes)

    def predicate(exc: BaseException) -> bool:
        code = (
            getattr(exc, 'code', None)
            or getattr(exc, 'status_code', None)
            or getattr(exc, '_pipeline_status', None)
        )
        if code is None:
            # No HTTP status => transport-level error (reset/timeout/DNS).
            return True
        return code in codes

    return predicate
