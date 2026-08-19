"""HTTP server on port 8080 — health check + admin endpoints.

Serves `GET /health` for liveness/readiness monitoring and
`POST /admin/seed-archive` for one-shot seeding of the persistent
volume from Vercel Blob. The admin endpoint is gated on a shared token
and is safe to leave deployed — subsequent calls are cheap (SHA-based
resume) and guarded by a single-flight lock in `archive_seeder`.
"""

from __future__ import annotations

import contextlib
import hmac
import json
import math
import os
import re
import threading
import time
from collections.abc import Iterator
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from archive_seeder import SeedBusyError
from logger_setup import log
from sentry_setup import capture_message

# 3-year window cap on /archive/*-batch range queries. A 3-year range
# is ~750 trading dates × ~370k instruments — well within the 8 vCPU
# budget on Railway. Anything larger should paginate client-side.
# Used by 3 batch handlers (day-features-batch, day-summary-batch,
# day-summary-prediction-batch).
_BATCH_RANGE_MAX_DAYS = 366 * 3

# Compiled once — every archive handler reuses this.
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

# Upper bound on POST request bodies (takeit/explain + multileg-classify).
# The server binds 0.0.0.0, so an unbounded `rfile.read(content_length)`
# is a trivial unauthenticated remote-OOM vector. We reject by *declared*
# Content-Length before allocating, which is sufficient to prevent the
# allocation. Configurable via env; default 1 MiB.
MAX_BODY_BYTES = int(os.environ.get("TAKEIT_MAX_BODY_BYTES", str(1 * 1024 * 1024)))

# Roots the /theta/index/* proxy routes will serve. Matches the Index
# Data PRO entitlement: SPX + the CBOE calculated VIX family. Anything
# else is a 400 — the routes exist to feed the Schwab-replacement
# facade's quotes/pricehistory paths, not as a general Theta proxy.
_THETA_INDEX_ROOTS = frozenset({"SPX", "VIX", "VIX1D", "VIX9D", "VVIX"})

# Default candle interval for /theta/index/history: 1 minute in ms.
_THETA_DEFAULT_IVL_MS = 60000


# ---------------------------------------------------------------------------
# Concurrency bound for the /theta/index/* routes (Terminal burst choke)
# ---------------------------------------------------------------------------
#
# Theta Terminal v1.8.6 (the co-resident jar, HTTP on 127.0.0.1:25510)
# answers sequential requests reliably and drops them under a burst.
# Two failures traced to it:
#
#   * `/api/history` on Vercel fans out 5 symbols x up to 6 concurrent
#     days = ~30 simultaneous GET /theta/index/history calls. On
#     2026-08-19 18:31 UTC $VIX1D came back empty while the other four
#     roots succeeded, so the UI showed "n/a (no history)".
#   * On 2026-08-18 /api/chain returned 502 seven times, each preceded
#     by a sidecar `503 theta_unavailable` for $SPX.
#
# So bound how many requests may be inside the Terminal at once. This
# mirrors `archive_query.archive_query_slot()` with ONE deliberate
# difference: the archive slot sheds instantly (each admitted query
# costs ~500 MB of DuckDB memory, so queueing would just OOM later),
# whereas a queued Theta call costs nothing but a parked thread. The
# callers here are Vercel Functions with an 8s client timeout
# (`SIDECAR_TIMEOUT_MS` in api/_lib/market-data-adapters.ts), and they
# would much rather wait a couple of seconds for the Terminal than take
# an instant 503. The health server is a ThreadingHTTPServer (one
# thread per request — see `_QuietThreadingHTTPServer` and `start()`),
# so a blocking acquire parks only that request's own thread.
#
# 2 is deliberate: the Terminal is reliable sequentially, and 2 halves
# queue latency without bursting it. Override via env for ops tuning.
#
# Both knobs are read at import. An exception here would take the whole
# health server down (and Railway would then roll the deploy back in a
# loop), so a bad value must DEGRADE to the documented default rather
# than raise — see `_env_int` / `_env_float`. Concurrency is clamped to
# >= 1 because a cap of 0 would permanently shed every request.
_THETA_INDEX_CONCURRENCY_DEFAULT = 2


def _env_int(name: str, default: int, *, minimum: int) -> int:
    """Parse an integer tuning knob from the environment without raising.

    Unset or blank → `default` silently. Unparseable → `default` with a
    warning. Below `minimum` → `minimum` with a warning. Module-level
    callers run at import time, where raising would be fatal.
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not an integer; using default %d", name, raw, default)
        return default
    if value < minimum:
        log.warning(
            "%s=%d is below the minimum %d; clamping to %d",
            name,
            value,
            minimum,
            minimum,
        )
        return minimum
    return value


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    """Parse a float tuning knob from the environment without raising.

    Same contract as `_env_int`, plus: non-finite values (`nan`, `inf`)
    fall back to `default` — `float()` accepts them but a NaN timeout
    makes the semaphore wait forever and `inf` overflows the lock — and
    values above `maximum` clamp down with a warning.
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        log.warning("%s=%r is not a number; using default %.1f", name, raw, default)
        return default
    if not math.isfinite(value):
        log.warning("%s=%r is not finite; using default %.1f", name, raw, default)
        return default
    if value < minimum:
        log.warning(
            "%s=%r is below the minimum %.1fs; clamping to %.1fs",
            name,
            raw,
            minimum,
            minimum,
        )
        return minimum
    if value > maximum:
        log.warning(
            "%s=%r is above the maximum %.1fs; clamping to %.1fs",
            name,
            raw,
            maximum,
            maximum,
        )
        return maximum
    return value


_THETA_INDEX_CONCURRENCY = _env_int(
    "THETA_INDEX_CONCURRENCY", _THETA_INDEX_CONCURRENCY_DEFAULT, minimum=1
)
_theta_index_semaphore = threading.BoundedSemaphore(_THETA_INDEX_CONCURRENCY)

# How long a request may queue for a slot before it gives up with 503
# `theta_busy`. 5s sits inside the caller's 8s budget and still leaves
# ~3s for the Terminal round-trip the slot then performs (a warm index
# snapshot is well under 1s; the client itself is built with
# timeout_s=5, max_retries=1). Expiring here is strictly better than
# letting the caller time out: it returns a structured, retryable
# answer with Retry-After instead of a dead socket.
#
# Clamped to [0.5s, 60s]: anything shorter is a shed in disguise (a warm
# Terminal round-trip is a few hundred ms), and anything longer cannot
# help a caller whose own budget is 8s — while an astronomically large
# value makes `Semaphore.acquire(timeout=…)` raise OverflowError at
# contention time, a latent 500 on the very path this bound protects.
_THETA_INDEX_WAIT_S_DEFAULT = 5.0
_THETA_INDEX_WAIT_S_MIN = 0.5
_THETA_INDEX_WAIT_S_MAX = 60.0
_THETA_INDEX_WAIT_S = _env_float(
    "THETA_INDEX_WAIT_S",
    _THETA_INDEX_WAIT_S_DEFAULT,
    minimum=_THETA_INDEX_WAIT_S_MIN,
    maximum=_THETA_INDEX_WAIT_S_MAX,
)

# Latch for the "wait expired" warning — see `_warn_theta_wait_expired`.
_theta_index_wait_expired = False
_theta_index_latch_lock = threading.Lock()


class ThetaBusyError(Exception):
    """Raised when a request waited out `_THETA_INDEX_WAIT_S` for a slot.

    The HTTP layer maps this to 503 `theta_busy` + Retry-After. Distinct
    from ThetaClientError (Terminal down → 503 `theta_unavailable`) so a
    caller can tell "too many of us" from "it's broken".
    """


def _warn_theta_wait_expired() -> None:
    """Warn once per process that a request never got a Terminal slot.

    The first expiry is the signal that `THETA_INDEX_CONCURRENCY` (or
    `THETA_INDEX_WAIT_S`) is too low for the offered load. Repeating it
    per shed request during a burst would be pure alert noise, so the
    warning is latched and later expiries drop to debug.

    The sidecar's Sentry has no logging integration, so the log line
    alone is invisible outside the Railway log drain. The first expiry
    therefore ALSO goes out as a `capture_message` (same precedent as
    db.py's slow-getconn and batched_writer's overflow-drop events),
    behind the same latch — one Sentry event per process. The capture
    is guarded: observability must never turn a 503 `theta_busy` into
    an unhandled exception on the request thread.
    """
    global _theta_index_wait_expired
    with _theta_index_latch_lock:
        first = not _theta_index_wait_expired
        _theta_index_wait_expired = True
    if not first:
        log.debug("theta index slot wait expired after %.1fs", _THETA_INDEX_WAIT_S)
        return
    log.warning(
        "theta index slot wait expired after %.1fs at cap %d — raise "
        "THETA_INDEX_CONCURRENCY if this repeats",
        _THETA_INDEX_WAIT_S,
        _THETA_INDEX_CONCURRENCY,
    )
    try:
        capture_message(
            "theta index slot wait expired",
            level="warning",
            context={"cap": _THETA_INDEX_CONCURRENCY, "wait_s": _THETA_INDEX_WAIT_S},
            tags={"component": "health", "route": "theta-index"},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to forward theta busy warning to Sentry: %s", exc)


@contextlib.contextmanager
def theta_index_slot() -> Iterator[None]:
    """Bound concurrent Theta Terminal calls to `_THETA_INDEX_CONCURRENCY`.

    Blocking acquire with a `_THETA_INDEX_WAIT_S` deadline: a burst
    queues (which the Terminal handles fine) instead of stampeding it.
    Only when the deadline passes do we raise `ThetaBusyError` so the
    HTTP layer can answer 503 `theta_busy`. The slot is released on exit
    even if the wrapped call raises.
    """
    if not _theta_index_semaphore.acquire(blocking=False):
        log.debug(
            "theta index slots busy (cap %d); waiting up to %.1fs",
            _THETA_INDEX_CONCURRENCY,
            _THETA_INDEX_WAIT_S,
        )
        started = time.monotonic()
        if not _theta_index_semaphore.acquire(timeout=_THETA_INDEX_WAIT_S):
            _warn_theta_wait_expired()
            raise ThetaBusyError("theta index concurrency limit reached")
        log.debug(
            "theta index slot acquired after waiting %.2fs",
            time.monotonic() - started,
        )
    try:
        yield
    finally:
        _theta_index_semaphore.release()


def _previous_weekday(d: date) -> date:
    """Return the closest weekday strictly before `d` (skips Sat/Sun).

    Approximates "previous trading day" for the prev_close lookup on
    /theta/index/price. Market holidays are NOT modeled — on those days
    the hist fetch simply returns no candles and prev_close degrades to
    null, which the response contract explicitly allows.
    """
    prev = d - timedelta(days=1)
    while prev.weekday() >= 5:  # 5=Sat, 6=Sun
        prev -= timedelta(days=1)
    return prev


def _is_today_or_future_utc(date_str: str) -> bool:
    """Return True when date_str (YYYY-MM-DD) is >= today in UTC.

    SIDE-017: used by /archive/day-summary and /archive/day-features
    to short-circuit queries for dates that cannot possibly be in the
    archive yet. The refresh-current-snapshot Vercel cron polls for
    today's summary+features every 5 min during RTH (``*/5 13-20 * *
    1-5``), but the archive only gets today's partitions after the
    EOD ETL. Before this guard, each doomed call ran a 3–7s DuckDB
    query against 3.9 GB of Parquet just to discover the date had
    no rows — ~96 wasted queries per session, each contributing
    memory pressure on an already-strained Railway tier.
    """
    today_utc = datetime.now(timezone.utc).date().isoformat()
    return date_str >= today_utc


class _BadRequest(Exception):
    """Raised by parse helpers when an input is missing/malformed.

    Internal sentinel — caught by the route dispatch and converted to
    HTTP 400. Never escapes the module.
    """


def _parse_date_param(qs: dict[str, list[str]], name: str) -> str:
    """Return ``qs[name]`` validated as YYYY-MM-DD, or raise _BadRequest.

    Centralizes the regex check that was inlined in 10+ handlers. The
    error message mirrors the one each handler used so test assertions
    that grep for "YYYY-MM-DD" continue to pass.
    """
    raw = (qs.get(name) or [""])[0]
    if not _DATE_RE.fullmatch(raw):
        raise _BadRequest(f"{name} must be YYYY-MM-DD")
    return raw


def _parse_optional_int(
    qs: dict[str, list[str]], name: str, *, lo: int | None = None
) -> int | None:
    """Parse an optional integer query param, or raise _BadRequest.

    Returns None when the param is absent (so the caller can omit the
    kwarg and let the query layer apply its own default). When present
    but unparseable / below ``lo``, raises with the same messages each
    handler used previously.
    """
    raw = (qs.get(name) or [""])[0]
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        raise _BadRequest(f"{name} must be an integer") from None
    if lo is not None and value < lo:
        raise _BadRequest(f"{name} must be >= {lo}")
    return value


def _parse_date_range(
    qs: dict[str, list[str]],
) -> tuple[str, str]:
    """Parse from/to YYYY-MM-DD pair + apply the 3-year cap.

    Returns ``(start, end)`` strings; raises _BadRequest with the
    handler's pre-existing message on any violation. Centralizes the
    block duplicated across 3 batch handlers.
    """
    start = (qs.get("from") or [""])[0]
    end = (qs.get("to") or [""])[0]
    for v in (start, end):
        if not _DATE_RE.fullmatch(v):
            raise _BadRequest("from/to must be YYYY-MM-DD")
    try:
        d0 = date.fromisoformat(start)
        d1 = date.fromisoformat(end)
    except ValueError:
        raise _BadRequest("invalid date") from None
    if d1 < d0:
        raise _BadRequest("to must be >= from")
    if (d1 - d0).days > _BATCH_RANGE_MAX_DAYS:
        raise _BadRequest("range cannot exceed 3 years")
    return start, end


# Lazy-loaded reference to the `archive_query` module. DuckDB import
# cost (~12 MB) is real, so we defer until the first archive request
# rather than paying it at sidecar startup. The holder pattern (vs.
# importing inside each handler) means we pay the import once and the
# module attribute lookup on every call after — same cheap dict probe
# the per-handler `import` already devolves to after Python's import
# cache warms.
#
# Tests that patch `archive_query.X` continue to work: `_aq()` returns
# the same module object the test patches, so the attribute lookup
# resolves to the patched callable.
_archive_query_module: Any = None


def _aq() -> Any:
    """Return the lazy-loaded `archive_query` module."""
    global _archive_query_module
    if _archive_query_module is None:
        import archive_query

        _archive_query_module = archive_query
    return _archive_query_module


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that swallows client-disconnect errors.

    When a client (Vercel Function caller) disconnects mid-response —
    most commonly because Railway's edge proxy hit its upstream-response
    timeout and returned a 502 before our handler finished — the next
    ``wfile.write`` raises ``BrokenPipeError`` / ``ConnectionResetError``
    inside ``socketserver.process_request_thread``. socketserver's
    default ``handle_error`` then dumps a full stack trace to stderr.

    Those tracebacks are alert-grade log noise (one per slow multileg
    classify call against this 3-vCPU box under contention) but carry
    no signal — the caller already knows the request failed (it saw
    the 502), and any real failure modes still surface as Sentry
    ``multileg.classify.sidecar_non_2xx`` from the Vercel side.

    All other exceptions propagate to the default ``handle_error``.
    """

    def handle_error(self, request: Any, client_address: Any) -> None:  # noqa: D401
        import sys  # noqa: PLC0415

        exc_type = sys.exc_info()[0]
        if exc_type is not None and issubclass(
            exc_type, (BrokenPipeError, ConnectionResetError)
        ):
            return
        super().handle_error(request, client_address)


class HealthHandler(BaseHTTPRequestHandler):
    """Handle GET /health + POST /admin/seed-archive requests."""

    # Databento / DB checks — always required.
    is_connected: Callable[[], bool]
    last_bar_at: Callable[[], float]
    is_db_healthy: Callable[[], bool]

    # Theta Data reporters — optional. None when Theta is disabled
    # (credentials missing, jar not present, local dev). When set, the
    # handler emits a `theta` block in the response body but does NOT
    # factor Theta state into the overall healthy/degraded status —
    # Theta is additive, the sidecar's core contract is Databento relay.
    theta_is_running: Callable[[], bool] | None = None
    theta_last_ready_at: Callable[[], float] | None = None
    theta_last_error: Callable[[], str | None] | None = None

    # Archive seeder — optional. When set, enables POST /admin/seed-archive.
    # The callable returns a dict suitable for JSON serialization.
    seed_archive: Callable[[], dict[str, Any]] | None = None
    seed_is_busy: Callable[[], bool] | None = None

    # Archive route prefix → bound, heavy DuckDB handler. Ordered by
    # specificity — longer/more-specific prefixes MUST come before shorter
    # ones or they get swallowed (e.g. `/archive/day-summary-prediction`
    # would match `/archive/day-summary` if that route check ran first).
    # Every entry runs a DuckDB query, so the whole group is gated behind
    # `archive_query_slot()` in do_GET (AUD-M25 concurrency bound).
    _ARCHIVE_ROUTES: tuple[tuple[str, str], ...] = (
        ("/archive/es-range", "_handle_archive_es_range"),
        ("/archive/analog-days", "_handle_archive_analog_days"),
        (
            "/archive/day-summary-prediction-batch",
            "_handle_archive_day_summary_prediction_batch",
        ),
        (
            "/archive/day-summary-prediction",
            "_handle_archive_day_summary_prediction",
        ),
        ("/archive/day-summary-batch", "_handle_archive_day_summary_batch"),
        ("/archive/day-summary", "_handle_archive_day_summary"),
        ("/archive/day-features-batch", "_handle_archive_day_features_batch"),
        ("/archive/day-features", "_handle_archive_day_features"),
        (
            "/archive/tbbo-day-microstructure",
            "_handle_archive_tbbo_day_microstructure",
        ),
        ("/archive/tbbo-ofi-percentile", "_handle_archive_tbbo_ofi_percentile"),
    )

    # Theta index proxy routes. Localhost calls against the Theta
    # Terminal — deliberately NOT gated behind archive_query_slot() (that
    # semaphore bounds DuckDB memory, which these routes never touch);
    # they carry their own `theta_index_slot()` bound instead, applied
    # inside each handler after auth/validation.
    # Both routes require the /takeit bearer: they consume live Terminal
    # quota/bandwidth, so they are not public like /archive/*.
    _THETA_ROUTES: tuple[tuple[str, str], ...] = (
        ("/theta/index/price", "_handle_theta_index_price"),
        ("/theta/index/history", "_handle_theta_index_history"),
    )

    def do_GET(self) -> None:
        # /archive/* routes all run heavy, unbounded-memory DuckDB queries.
        # Bound their concurrency so N unauthenticated requests can't each
        # spawn a 500 MB + ~2 GB-temp DuckDB connection and OOM the box
        # (AUD-M25). When the cap is saturated, return 503 instead of
        # piling on another connection. The slot wraps the FULL handler so
        # the bound also covers the query the handler dispatches; cheap
        # input validation inside the handler runs under the slot too, but
        # that cost is negligible next to the DuckDB scan it protects.
        for prefix, handler_name in self._ARCHIVE_ROUTES:
            if self.path.startswith(prefix):
                self._dispatch_bounded_archive(handler_name)
                return

        for prefix, handler_name in self._THETA_ROUTES:
            if self.path.startswith(prefix):
                getattr(self, handler_name)()
                return

        if self.path == "/takeit/health":
            self._handle_takeit_health()
            return
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        checks = {
            "databento": self.is_connected(),
            "data_fresh": True,
            "db": False,
        }

        # Data freshness: if we expect quotes, check staleness
        if _is_data_expected():
            staleness = _now_ts() - self.last_bar_at()
            checks["data_fresh"] = staleness < 120  # 2 minutes

        try:
            checks["db"] = self.is_db_healthy()
        except Exception as exc:
            # Surface DB-health probe failures so an outage shows up in
            # Sentry before it manifests as a sustained 503 from /health.
            from sentry_setup import capture_exception

            capture_exception(
                exc,
                tags={"component": "health", "check": "db"},
            )
            checks["db"] = False

        theta_block = self._build_theta_block()

        healthy = all(checks.values())
        status = 200 if healthy else 503
        body_obj: dict[str, object] = {
            "status": "ok" if healthy else "degraded",
            "checks": checks,
        }
        if theta_block is not None:
            body_obj["theta"] = theta_block
        body = json.dumps(body_obj)

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self) -> None:  # noqa: N802 — http.server naming convention
        """Dispatch POST requests."""
        if self.path == "/takeit/explain":
            self._handle_takeit_explain()
            return
        if self.path == "/takeit/multileg-classify":
            self._handle_takeit_multileg_classify()
            return
        if self.path != "/admin/seed-archive":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        # Unify all auth-rejection paths to 401 so an external probe can't
        # distinguish "endpoint disabled" from "wrong token" — that
        # distinction is an enumeration oracle for the admin surface.
        # Operators can still tell the two states apart via server logs.
        if self.seed_archive is None:
            log.warning("seed endpoint not configured (seed_archive is None)")
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
            return

        # Auth gate — single-owner token from env. `hmac.compare_digest`
        # prevents timing-based token guessing (constant-time comparison).
        expected = os.environ.get("ARCHIVE_SEED_TOKEN", "")
        got = self.headers.get("X-Admin-Token", "")
        if not expected or not hmac.compare_digest(got, expected):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
            return

        # Busy gate — the `seed_is_busy` probe is advisory (it can race
        # with a concurrent handler); the authoritative single-flight
        # check is the seeder's own lock, surfaced as SeedBusyError.
        if self.seed_is_busy is not None and self.seed_is_busy():
            self._send_busy_response()
            return

        try:
            result = self.seed_archive()
            has_failures = bool(result.get("failed", 0))
            status = 500 if has_failures else 200
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except SeedBusyError:
            # Lost the race against another in-flight seed — return 423.
            self._send_busy_response()
        except Exception as exc:  # noqa: BLE001
            log.error("Seed request failed: %s", exc)
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode())

    def _handle_takeit_health(self) -> None:
        """GET /takeit/health — cheap liveness + readiness probe for the
        take-it SHAP explainer. Wraps takeit_server.handle_health_payload."""
        import takeit_server  # noqa: PLC0415  — heavy imports stay lazy

        body = takeit_server.handle_health_payload()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def _handle_takeit_explain(self) -> None:
        """POST /takeit/explain — Phase 3d SHAP top-K explainer. Wraps
        takeit_server.handle_explain_payload."""
        import takeit_server  # noqa: PLC0415

        if not takeit_server.is_enabled():
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"error": "takeit server disabled or missing ML deps"}
                ).encode()
            )
            return

        content_length = int(self.headers.get("Content-Length", "0") or 0)
        if content_length <= 0:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "empty body"}).encode())
            return
        if content_length > MAX_BODY_BYTES:
            # Reject by declared length before allocating — guards the
            # `rfile.read` OOM vector. Do NOT read the body.
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "payload too large"}).encode())
            return

        body_bytes = self.rfile.read(content_length)
        auth_header = self.headers.get("Authorization", "")
        status, body = takeit_server.handle_explain_payload(body_bytes, auth_header)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def _handle_takeit_multileg_classify(self) -> None:
        """POST /takeit/multileg-classify — wrap ml/src/multileg_assembler.

        Stateless CPU-bound endpoint. Vercel detect-cron POSTs a batch of
        Full Tape trade rows; we run polars-based pattern matching and
        return per-trade classifications in the same order.
        """
        # Auth + size checks BEFORE the heavy `import multileg_routes`
        # (polars/numpy) and before any payload read, so an unauthorized or
        # oversized request never loads the ML deps or allocates a body.
        shared_secret = os.environ.get("TAKEIT_SIDECAR_SHARED_SECRET", "")
        if not shared_secret:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"error": "TAKEIT_SIDECAR_SHARED_SECRET not configured"}
                ).encode()
            )
            return
        auth_header = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth_header, f"Bearer {shared_secret}"):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
            return

        content_length = int(self.headers.get("Content-Length", "0") or 0)
        if content_length <= 0:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "empty body"}).encode())
            return
        if content_length > MAX_BODY_BYTES:
            # Reject by declared length before allocating — guards the
            # `rfile.read` OOM vector. Do NOT read the body.
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "payload too large"}).encode())
            return

        import multileg_routes  # noqa: PLC0415

        body_bytes = self.rfile.read(content_length)
        status, body = multileg_routes.handle_classify_payload(body_bytes)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body, default=str).encode())

    # ------------------------------------------------------------------
    # /theta/index/* — Theta Terminal index proxy (Index Data PRO)
    # ------------------------------------------------------------------

    def _theta_bearer_ok(self) -> bool:
        """Bearer gate for the /theta/index/* routes.

        Same pattern as the /takeit routes: `hmac.compare_digest`
        against `Bearer <TAKEIT_SIDECAR_SHARED_SECRET>` (constant-time),
        503 when the env var is unset, 401 on mismatch. Sends the error
        response itself and returns False so callers can just bail.
        """
        shared_secret = os.environ.get("TAKEIT_SIDECAR_SHARED_SECRET", "")
        if not shared_secret:
            self._send_json(
                503, {"error": "TAKEIT_SIDECAR_SHARED_SECRET not configured"}
            )
            return False
        auth_header = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth_header, f"Bearer {shared_secret}"):
            self._send_json(401, {"error": "unauthorized"})
            return False
        return True

    def _theta_root_or_none(self, qs: dict[str, list[str]]) -> str | None:
        """Validate ?root= against the index allowlist; 400 + None on miss."""
        root = (qs.get("root") or [""])[0].upper()
        if root not in _THETA_INDEX_ROOTS:
            allowed = ", ".join(sorted(_THETA_INDEX_ROOTS))
            self._send_json(400, {"error": f"root must be one of {allowed}"})
            return None
        return root

    @staticmethod
    def _theta_client() -> Any:
        """Build an interactive-latency ThetaClient.

        Fast-fail settings (5s timeout, single attempt) instead of the
        fetcher's nightly-batch defaults (15s x 3 retries with backoff,
        ~45s+ worst case) — these routes sit on Vercel's request path
        behind Railway's edge proxy. Lazy import mirrors _aq(): the
        module object is what tests patch (`theta_client.ThetaClient`).
        """
        import theta_client  # noqa: PLC0415

        return theta_client.ThetaClient(timeout_s=5, max_retries=1)

    def _send_theta_busy(self) -> None:
        """503 + Retry-After for a request that never got a Terminal slot.

        Same wire shape as the archive busy response (`Retry-After: 1`),
        distinct body so the caller can tell a saturated Terminal from a
        broken one (`theta_unavailable`) or a saturated archive.
        """
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Retry-After", "1")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "theta_busy"}).encode())

    def _handle_theta_index_price(self) -> None:
        """GET /theta/index/price?root=SPX → current index value.

        Response: `{root, price, prev_close, ts}` where `prev_close` is
        the previous trading day's last hist-OHLC close (null when that
        day has no data — holiday — or its fetch fails; best-effort by
        contract) and `ts` is the snapshot time in epoch ms.

        The bearer gate and root allowlist run OUTSIDE `theta_index_slot()`
        so 401/400 stay instant and byte-identical however busy the
        Terminal is; only the part that actually talks to the Terminal
        is bounded.
        """
        if not self._theta_bearer_ok():
            return
        qs = parse_qs(urlparse(self.path).query)
        root = self._theta_root_or_none(qs)
        if root is None:
            return
        try:
            with theta_index_slot():
                self._theta_index_price_locked(root)
        except ThetaBusyError:
            self._send_theta_busy()

    def _theta_index_price_locked(self, root: str) -> None:
        """Body of /theta/index/price, run while holding a Terminal slot."""
        import theta_client  # noqa: PLC0415

        client = self._theta_client()
        try:
            snap = client.snapshot_index_price(root)
        except theta_client.ThetaSubscriptionError:
            # 472 Not entitled → structured 502, never a raw traceback.
            self._send_json(502, {"error": "theta_not_entitled", "root": root})
            return
        except theta_client.ThetaClientError as exc:
            # Terminal down (launcher not running → connection refused)
            # or otherwise erroring → 503 service-unavailable.
            log.warning("theta index price failed for %s: %s", root, exc)
            self._send_json(503, {"error": "theta_unavailable"})
            return

        if snap is None:
            self._send_json(404, {"error": "no_data", "root": root})
            return

        prev_close: float | None = None
        try:
            candles = client.hist_index_ohlc(
                root, _previous_weekday(snap.snapshot_date)
            )
            if candles:
                prev_close = float(candles[-1].close)
        except theta_client.ThetaClientError as exc:
            # Includes ThetaSubscriptionError (subclass): prev_close is
            # best-effort — degrade to null rather than sinking the price.
            log.warning("theta prev-close fetch failed for %s: %s", root, exc)

        self._send_json(
            200,
            {
                "root": root,
                "price": float(snap.price),
                "prev_close": prev_close,
                "ts": snap.ts_ms,
            },
        )

    def _handle_theta_index_history(self) -> None:
        """GET /theta/index/history?root=SPX&date=YYYY-MM-DD&ivl_ms=300000

        Response: `{root, date, ivl_ms, candles: [{ts_ms, open, high,
        low, close}]}`. Candles carry NO volume — indices don't trade,
        and fabricating one would let callers depend on a lie.

        As with /theta/index/price, auth + input validation run outside
        `theta_index_slot()`; only the Terminal call is bounded.
        """
        if not self._theta_bearer_ok():
            return
        qs = parse_qs(urlparse(self.path).query)
        root = self._theta_root_or_none(qs)
        if root is None:
            return
        try:
            date_str = _parse_date_param(qs, "date")
            ivl_ms = _parse_optional_int(qs, "ivl_ms", lo=1000)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return
        try:
            day = date.fromisoformat(date_str)
        except ValueError:
            # Shape-valid but calendar-invalid (e.g. 2026-13-99).
            self._send_json(400, {"error": "invalid date"})
            return
        if ivl_ms is None:
            ivl_ms = _THETA_DEFAULT_IVL_MS
        try:
            with theta_index_slot():
                self._theta_index_history_locked(root, date_str, day, ivl_ms)
        except ThetaBusyError:
            self._send_theta_busy()

    def _theta_index_history_locked(
        self, root: str, date_str: str, day: date, ivl_ms: int
    ) -> None:
        """Body of /theta/index/history, run while holding a Terminal slot."""
        import theta_client  # noqa: PLC0415

        client = self._theta_client()
        try:
            candles = client.hist_index_ohlc(root, day, ivl_ms=ivl_ms)
        except theta_client.ThetaSubscriptionError:
            self._send_json(502, {"error": "theta_not_entitled", "root": root})
            return
        except theta_client.ThetaClientError as exc:
            log.warning("theta index history failed for %s %s: %s", root, date_str, exc)
            self._send_json(503, {"error": "theta_unavailable"})
            return

        if not candles:
            self._send_json(404, {"error": "no_data", "root": root, "date": date_str})
            return

        self._send_json(
            200,
            {
                "root": root,
                "date": date_str,
                "ivl_ms": ivl_ms,
                "candles": [
                    {
                        "ts_ms": c.ts_ms,
                        "open": float(c.open),
                        "high": float(c.high),
                        "low": float(c.low),
                        "close": float(c.close),
                    }
                    for c in candles
                ],
            },
        )

    def _dispatch_bounded_archive(self, handler_name: str) -> None:
        """Run an /archive/* handler under the concurrency-bound slot.

        Acquires a slot from `archive_query.archive_query_slot()` (a
        non-blocking semaphore, cap `_ARCHIVE_QUERY_CONCURRENCY`). If the
        cap is saturated, returns 503 with a Retry-After hint instead of
        spawning another heavy DuckDB connection (AUD-M25). The slot is
        held for the whole handler so it covers the DuckDB query the
        handler runs, and released even if the handler raises.
        """
        try:
            with _aq().archive_query_slot():
                getattr(self, handler_name)()
        except _aq().ArchiveBusyError:
            # Cap saturated — shed load. 503 + Retry-After tells the Vercel
            # caller to back off rather than treating it as a hard failure.
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "1")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "archive busy, retry shortly"}).encode()
            )

    def _handle_archive_es_range(self) -> None:
        """GET /archive/es-range?date=YYYY-MM-DD → ES day summary from archive.

        Unauthenticated read endpoint. Data is already public market data
        and the archive itself doesn't contain any secrets. Date is the
        only input and is validated to match YYYY-MM-DD exactly.
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            result = _aq().es_day_summary(d)
            self._send_json(200, result)
        except ValueError as exc:
            # Known "no data for this date" — return 404 with message.
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "es-range", exc, "es-range query failed for %s: %s", d, exc, date=d
            )

    def _handle_archive_analog_days(self) -> None:
        """GET /archive/analog-days?date=YYYY-MM-DD&until_minute=60&k=20"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
            # `until_minute` and `k` have defaults in the query layer —
            # only pass through when supplied so validation errors come
            # from the ONE place that knows the bounds.
            kwargs: dict[str, int] = {}
            for name in ("until_minute", "k"):
                value = _parse_optional_int(qs, name)
                if value is not None:
                    kwargs[name] = value
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            result = _aq().analog_days(d, **kwargs)
            self._send_json(200, result)
        except ValueError as exc:
            # Bounds errors ("k must be...") and no-data errors both
            # surface as ValueError; the message is user-facing either way.
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "analog-days",
                exc,
                "analog-days query failed for %s: %s",
                d,
                exc,
                date=d,
            )

    def _handle_archive_day_summary(self) -> None:
        """GET /archive/day-summary?date=YYYY-MM-DD → deterministic text.

        Output is `{summary: "..."}` — deliberately narrow so the Vercel
        caller can't accidentally depend on OHLCV details outside the
        summary. The summary text is the ONLY input to the embedding
        pipeline; changing its format invalidates stored embeddings.
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        # SIDE-017: short-circuit today/future — archive never has
        # those partitions during RTH. Avoids a 3–7s DuckDB query that
        # is guaranteed to miss and consume memory each time.
        if _is_today_or_future_utc(d):
            self._send_json(404, {"error": "date not yet in archive (today or future)"})
            return

        try:
            text = _aq().day_summary_text(d)
            self._send_json(200, {"date": d, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-summary",
                exc,
                "day-summary query failed for %s: %s",
                d,
                exc,
                date=d,
            )

    def _handle_archive_day_features(self) -> None:
        """GET /archive/day-features?date=YYYY-MM-DD → 60-dim vector.

        Numeric feature vector for the engineered-embedding code path
        (Phase C). Intentionally narrow response — just the vector —
        so the Vercel caller stays decoupled from how the vector is
        computed. Changing the feature set requires a coordinated
        migration + re-backfill and should bump the response shape.
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        # SIDE-017: short-circuit today/future — same rationale as
        # _handle_archive_day_summary. The refresh-current-snapshot
        # cron fires both of these in parallel every 5 min in RTH.
        if _is_today_or_future_utc(d):
            self._send_json(404, {"error": "date not yet in archive (today or future)"})
            return

        try:
            vector = _aq().day_features_vector(d)
            self._send_json(
                200,
                {"date": d, "dim": len(vector), "vector": vector},
            )
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-features",
                exc,
                "day-features query failed for %s: %s",
                d,
                exc,
                date=d,
            )

    def _handle_archive_day_features_batch(self) -> None:
        """GET /archive/day-features-batch?from=YYYY-MM-DD&to=YYYY-MM-DD

        Returns `{from, to, rows: [{date, symbol, vector}]}`. Single
        DuckDB query covering the whole range — 40x cheaper than N
        calls to /archive/day-features for bulk backfills. Capped at
        3 years per request to bound query cost (a 3-year range is
        ~750 dates × ~370k instruments = well within 8 vCPU budget).
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_features_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-features-batch",
                exc,
                "day-features-batch failed for %s..%s: %s",
                start,
                end,
                exc,
                date=f"{start}..{end}",
            )

    def _handle_archive_day_summary_batch(self) -> None:
        """GET /archive/day-summary-batch?from=YYYY-MM-DD&to=YYYY-MM-DD"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_summary_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-summary-batch",
                exc,
                "day-summary-batch failed for %s..%s: %s",
                start,
                end,
                exc,
                date=f"{start}..{end}",
            )

    def _handle_archive_day_summary_prediction(self) -> None:
        """GET /archive/day-summary-prediction?date=YYYY-MM-DD

        Leakage-free text summary for a single date. Same endpoint
        shape as /archive/day-summary but the response text only
        includes fields available by the end of the first trading hour
        (no EOD close, no full-day range, no full-day volume).
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            text = _aq().day_summary_prediction(d)
            self._send_json(200, {"date": d, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-summary-prediction",
                exc,
                "day-summary-prediction failed for %s: %s",
                d,
                exc,
                date=d,
            )

    def _handle_archive_day_summary_prediction_batch(self) -> None:
        """GET /archive/day-summary-prediction-batch?from=Y-M-D&to=Y-M-D"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_summary_prediction_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "day-summary-prediction-batch",
                exc,
                "day-summary-prediction-batch failed %s..%s: %s",
                start,
                end,
                exc,
                date=f"{start}..{end}",
            )

    def _handle_archive_tbbo_day_microstructure(self) -> None:
        """GET /archive/tbbo-day-microstructure?date=YYYY-MM-DD&symbol=ES|NQ

        Returns the per-day microstructure summary (OFI at 5m / 15m / 1h
        plus trade count) for the requested ``(date, symbol)``.

        Unauthenticated — TBBO data is public market data, and the
        sidecar doesn't expose any secrets through this shape.
        """
        qs = parse_qs(urlparse(self.path).query)
        symbol = (qs.get("symbol") or [""])[0].upper()

        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return
        if symbol not in {"ES", "NQ"}:
            self._send_json(400, {"error": "symbol must be 'ES' or 'NQ'"})
            return

        try:
            result = _aq().tbbo_day_microstructure(d, symbol)
            self._send_json(200, result)
        except ValueError as exc:
            # "No TBBO X bars found..." = 404; invalid-input errors were
            # caught by the regex / allowlist above. Any ValueError here
            # is a missing-data case.
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "tbbo-day-microstructure",
                exc,
                "tbbo-day-microstructure failed for %s/%s: %s",
                d,
                symbol,
                exc,
                date=d,
                symbol=symbol,
            )

    def _handle_archive_tbbo_ofi_percentile(self) -> None:
        """GET /archive/tbbo-ofi-percentile?symbol=ES|NQ&value=<float>&window=5m|15m|1h

        Returns ``{symbol, window, current_value, percentile, mean, std, count}``
        describing where ``value`` falls in the last 252 days of historical
        daily-mean OFI at ``window`` for ``symbol`` (front-month only).
        """
        import math

        qs = parse_qs(urlparse(self.path).query)
        symbol = (qs.get("symbol") or [""])[0].upper()
        value_raw = (qs.get("value") or [""])[0]
        window = (qs.get("window") or ["1h"])[0]

        if symbol not in {"ES", "NQ"}:
            self._send_json(400, {"error": "symbol must be 'ES' or 'NQ'"})
            return
        if window not in {"5m", "15m", "1h"}:
            self._send_json(400, {"error": "window must be '5m', '15m', or '1h'"})
            return
        if not value_raw:
            self._send_json(400, {"error": "value is required"})
            return
        try:
            value = float(value_raw)
        except ValueError:
            self._send_json(400, {"error": "value must be a finite number"})
            return
        if not math.isfinite(value):
            self._send_json(400, {"error": "value must be a finite number"})
            return

        kwargs: dict[str, object] = {"window": window}
        try:
            horizon = _parse_optional_int(qs, "horizon_days", lo=1)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return
        if horizon is not None:
            # Public unauthenticated endpoint — cap at ~4 trading
            # years to bound query cost. A caller requesting an
            # absurd horizon would otherwise full-scan the archive.
            if horizon > _aq()._TBBO_OFI_MAX_HORIZON_DAYS:
                self._send_json(
                    400,
                    {
                        "error": (
                            "horizon_days must be <= "
                            f"{_aq()._TBBO_OFI_MAX_HORIZON_DAYS}"
                        )
                    },
                )
                return
            kwargs["horizon_days"] = horizon

        try:
            result = _aq().tbbo_ofi_percentile(symbol, value, **kwargs)
            self._send_json(200, result)
        except ValueError as exc:
            # No-data errors → 404 (empty archive / window never had data);
            # other ValueError messages are input-shape (shouldn't reach
            # the query layer after the validation above).
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._archive_query_error(
                "tbbo-ofi-percentile",
                exc,
                "tbbo-ofi-percentile failed for %s/%s: %s",
                symbol,
                window,
                exc,
                symbol=symbol,
                window=window,
            )

    def _archive_query_error(
        self,
        route: str,
        exc: Exception,
        log_msg: str,
        *log_args: object,
        **tags: object,
    ) -> None:
        """Map a non-ValueError archive query failure to an HTTP response.

        DRY helper for the archive read handlers (the `except Exception`
        arm of each). Two outcomes:

        - `ArchiveUnavailableError` — the dataset is not seeded on this
          sidecar (empty/missing ARCHIVE_ROOT, or ohlcv/tbbo/symbology
          Parquet absent). Unconfigured != broken: answer 503
          `{error: "archive_unavailable", dataset}` with NO Sentry event
          and no error-level log (the query layer already warned once
          per missing path). No Retry-After either — unlike the busy-cap
          503 this is not transient; it clears only after
          POST /admin/seed-archive. Vercel consumers treat it as
          "archive context unavailable, skip" (archive-sidecar.ts →
          null; fetch-day-ohlc → Postgres fallback / skipped).
        - anything else — genuine failure. Mirrors the /health DB-probe
          pattern (capture_exception alongside log.error) so archive
          500s surface in Sentry instead of dying in logs only. The 500
          JSON response shape is unchanged.
        """
        if isinstance(exc, _aq().ArchiveUnavailableError):
            log.debug("%s: archive unavailable (%s)", route, exc)
            message = f"archive dataset {exc.dataset!r} is not seeded on this sidecar"
            self._send_json(
                503,
                {
                    "error": "archive_unavailable",
                    "dataset": exc.dataset,
                    "message": message,
                },
            )
            return

        log.error(log_msg, *log_args)
        from sentry_setup import capture_exception  # noqa: PLC0415

        capture_exception(
            exc,
            tags={"component": "archive", "route": route, **tags},
        )
        self._send_json(500, {"error": "query failed"})

    def _send_json(self, status: int, body: dict[str, object]) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def _send_busy_response(self) -> None:
        self.send_response(423)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "seed already in progress"}).encode())

    def _build_theta_block(self) -> dict[str, object] | None:
        """Render the Theta status block, or None if Theta is disabled."""
        if self.theta_is_running is None:
            return None
        last_ready = 0.0
        if self.theta_last_ready_at is not None:
            try:
                last_ready = self.theta_last_ready_at()
            except Exception:
                last_ready = 0.0
        last_error = None
        if self.theta_last_error is not None:
            try:
                last_error = self.theta_last_error()
            except Exception:
                last_error = None
        return {
            "running": self.theta_is_running(),
            "last_ready_at": last_ready if last_ready > 0 else None,
            "last_error": last_error,
        }

    def log_message(self, format: str, *args: object) -> None:
        """Suppress default stderr logging from BaseHTTPRequestHandler."""
        pass


def _now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()


def _is_data_expected() -> bool:
    """Check if we should expect market data right now.

    Futures trade nearly 24 hours. Globex is closed:
    - Friday 5 PM CT to Sunday 5 PM CT
    - Daily maintenance: 4-5 PM CT (Mon-Thu) / 3:15-3:30 PM CT (brief)

    Simplified: skip weekends and the 5 PM CT hour (maintenance window).
    """
    import zoneinfo

    ct = datetime.now(zoneinfo.ZoneInfo("America/Chicago"))
    weekday = ct.weekday()  # Monday=0, Sunday=6

    # Saturday all day
    if weekday == 5:
        return False
    # Sunday before 5 PM CT
    if weekday == 6 and ct.hour < 17:
        return False
    # Friday after 4 PM CT (Globex closes ~4:15 PM CT Friday)
    if weekday == 4 and ct.hour >= 16:
        return False
    # Daily maintenance window
    if ct.hour == 16:
        return False

    return True


def start_health_server(
    port: int,
    is_connected: Callable[[], bool],
    last_bar_at: Callable[[], float],
    is_db_healthy: Callable[[], bool],
    *,
    theta_is_running: Callable[[], bool] | None = None,
    theta_last_ready_at: Callable[[], float] | None = None,
    theta_last_error: Callable[[], str | None] | None = None,
    seed_archive: Callable[[], dict[str, Any]] | None = None,
    seed_is_busy: Callable[[], bool] | None = None,
) -> HTTPServer:
    """Start the HTTP server in a background thread.

    Optional callables:
      - `theta_*` exposes Theta Terminal status in the /health response.
        Omit to disable the `theta` block.
      - `seed_archive` / `seed_is_busy` enable POST /admin/seed-archive.
        Omit to disable the admin endpoint (returns 503 if hit).

    Class-level state is reset between calls so tests that spin up
    multiple servers in one process don't bleed state across runs.
    """
    HealthHandler.is_connected = staticmethod(is_connected)  # type: ignore[assignment]
    HealthHandler.last_bar_at = staticmethod(last_bar_at)  # type: ignore[assignment]
    HealthHandler.is_db_healthy = staticmethod(is_db_healthy)  # type: ignore[assignment]

    if theta_is_running is not None:
        HealthHandler.theta_is_running = staticmethod(theta_is_running)  # type: ignore[assignment]
        HealthHandler.theta_last_ready_at = (
            staticmethod(theta_last_ready_at) if theta_last_ready_at else None  # type: ignore[assignment]
        )
        HealthHandler.theta_last_error = (
            staticmethod(theta_last_error) if theta_last_error else None  # type: ignore[assignment]
        )
    else:
        # Reset between runs (important for tests that spin up multiple
        # servers in one process).
        HealthHandler.theta_is_running = None
        HealthHandler.theta_last_ready_at = None
        HealthHandler.theta_last_error = None

    HealthHandler.seed_archive = (
        staticmethod(seed_archive) if seed_archive is not None else None  # type: ignore[assignment]
    )
    HealthHandler.seed_is_busy = (
        staticmethod(seed_is_busy) if seed_is_busy is not None else None  # type: ignore[assignment]
    )

    # ThreadingHTTPServer spawns a new thread per request so /archive/*
    # queries don't block the /health probe (and vice versa). Was
    # HTTPServer (single-threaded) previously, which bottlenecked the
    # backfill at 1 req/sec.
    #
    # _QuietThreadingHTTPServer subclass swallows BrokenPipe/
    # ConnectionReset on response write — those happen when Vercel's
    # client (or Railway's edge proxy on its behalf) closes the upstream
    # connection before we finish writing. Vercel already records the
    # real failure (sidecar_non_2xx); the Python traceback is just noise.
    server = _QuietThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("Health server listening on port %d (threaded)", port)
    return server
