"""HTTP server for the multileg classifier service.

Small ThreadingHTTPServer that fronts ``multileg_routes.handle_classify_payload``
with route dispatch (``/health`` GET, ``/version`` GET,
``/multileg-classify`` POST), method validation (405 on the wrong verb),
and a request-body size cap (50 MB → 413). Route handler logic stays in
``multileg_routes``; this module is HTTP plumbing only.

Phase 1 of the 2026-05-28 spec — no BoundedSemaphore yet. Phase 2 will
add bounded concurrency in front of ``handle_classify_payload``; the
``_QuietThreadingHTTPServer`` + per-request thread model is already what
the sidecar runs in production today, so we're matching its known-good
shape for the split deploy.

Operational notes:
  - ``Connection: close`` on 4xx/5xx responses so Railway's edge proxy
    doesn't hold a broken upstream socket open between retries.
  - Default ``BaseHTTPRequestHandler.log_message`` is suppressed —
    sidecar and uw-stream do the same; access logging at the app layer
    is more useful than the per-request stderr line http.server emits.
  - 50 MB body cap: a 7500-trade payload runs ~3-4 MB, so 50 MB is
    comfortable headroom AND a DoS-protection floor. Larger payloads
    short-circuit to 413 BEFORE the matcher (which would happily try
    to materialize them and OOM).
  - Per-handler ``timeout = 30`` (Phase 1.5 fix 1.7): defends against
    Slowloris-style attacks where a client trickles bytes to hold a
    worker thread + socket indefinitely. 30s is generous headroom for
    the ~1s our largest legitimate payloads take.
  - ``_QuietThreadingHTTPServer.block_on_close = False`` (Phase 1.5 fix
    2.6): makes ``server_close()`` return immediately during shutdown
    instead of waiting on in-flight worker threads. Railway's grace
    period is the only timeout that should govern teardown.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from typing import Any

import sentry_setup
from multileg_routes import handle_classify_payload

# 50 MB cap on request body. Realistic 7500-trade payloads are ~3-4 MB
# (Phase 2 keeps that bound; see spec). Numbers larger than this are
# unambiguously bad-input or attack traffic and we reject before reading
# any bytes off the wire.
_MAX_BODY_BYTES = 50 * 1024 * 1024

# Canonical pattern list mirroring api/_lib/multileg-client.ts
# MULTILEG_STRUCTURES. Exposed via GET /version so the TS client can
# detect drift between deploys (Phase 1.5 fix 2.2).
_MULTILEG_PATTERNS: tuple[str, ...] = (
    "isolated_leg",
    "vertical",
    "strangle",
    "risk_reversal",
    "butterfly",
)

# Cached sha256 of the vendored matcher. Computed lazily on first
# /version request and frozen for the process lifetime — the file
# never mutates after the image boots.
_matcher_sha_cache: str | None = None


def _compute_matcher_sha() -> str:
    """Hash ``_vendored_ml/multileg_assembler.py`` for drift detection.

    Resolves the file via the already-imported ``multileg_assembler``
    module rather than a hard-coded ``/app/`` path so local dev and
    production both work. Returns ``'unknown'`` on any error so the
    ``/version`` endpoint can never crash on a quirky filesystem.
    """
    try:
        import multileg_assembler

        path = multileg_assembler.__file__
        if path is None:
            return "unknown"
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except Exception:
        return "unknown"


def _get_matcher_sha() -> str:
    """Return the cached matcher sha, computing it on first call."""
    global _matcher_sha_cache
    if _matcher_sha_cache is None:
        _matcher_sha_cache = _compute_matcher_sha()
    return _matcher_sha_cache


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that swallows client-disconnect errors.

    When a client (Vercel Function caller) disconnects mid-response —
    most commonly because Railway's edge proxy hit its upstream-response
    timeout and returned a 502 before our handler finished — the next
    ``wfile.write`` raises ``BrokenPipeError`` / ``ConnectionResetError``
    inside ``socketserver.process_request_thread``. socketserver's
    default ``handle_error`` then dumps a full stack trace to stderr.

    Those tracebacks are alert-grade log noise (one per slow multileg
    classify call against this box under contention) but carry no
    signal — the caller already knows the request failed (it saw the
    502), and any real failure mode still surfaces as Sentry
    ``multileg.classify.sidecar_non_2xx`` (event name kept for
    continuity) from the Vercel side.

    All other exceptions propagate to the default ``handle_error``.

    ``block_on_close = False`` (Phase 1.5 fix 2.6): when ``main`` calls
    ``server_close()`` on shutdown, socketserver would otherwise join
    every in-flight worker thread. Combined with Slowloris-style slow
    clients (now also bounded to 30s by ``ClassifierHandler.timeout``,
    fix 1.7), that could push teardown past Railway's SIGKILL grace
    window. Setting ``block_on_close = False`` makes ``server_close()``
    return immediately; in-flight threads finish on their own or get
    SIGKILLed with the process.
    """

    block_on_close = False

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc_type = sys.exc_info()[0]
        if exc_type is not None and issubclass(
            exc_type, (BrokenPipeError, ConnectionResetError)
        ):
            return
        super().handle_error(request, client_address)


class ClassifierHandler(BaseHTTPRequestHandler):
    """Route dispatcher for ``/health``, ``/version``, and ``/multileg-classify``."""

    # ``StreamRequestHandler.setup`` installs this as the socket timeout
    # on every connection. Phase 1.5 fix 1.7: bound the worst-case time
    # a single connection can hold a thread to defend against Slowloris.
    # 30s is generous headroom for the ~1s our largest legitimate
    # payloads take; anything beyond that is almost certainly an
    # adversarial slow-drip client and we'd rather drop the socket than
    # let it hold a worker indefinitely.
    timeout = 30

    # ---- response helpers ---------------------------------------------------

    def _write_json(
        self,
        status: int,
        body: dict,
        *,
        close_connection: bool = False,
        retry_after_sec: int | None = None,
    ) -> None:
        """Send a JSON response with the right headers.

        ``close_connection=True`` is set on every 4xx/5xx so Railway's
        edge proxy doesn't keep the broken socket pooled. The
        ``default=str`` argument to ``json.dumps`` matches the sidecar
        contract — pydantic validation_error details include datetime
        / Decimal-ish values that need string coercion.

        ``retry_after_sec`` adds an RFC 9110 §10.2.3 ``Retry-After``
        header — used by the 503 queue-timeout path (Phase 1.5 Task 4)
        so the TS client retries with jitter instead of failing the
        cron loop. None (default) omits the header entirely.
        """
        payload = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if close_connection:
            self.send_header("Connection", "close")
        if retry_after_sec is not None:
            self.send_header("Retry-After", str(retry_after_sec))
        self.end_headers()
        self.wfile.write(payload)

    def _send_404(self) -> None:
        self._write_json(404, {"error": "not found"}, close_connection=True)

    def _send_405(self, allowed: str) -> None:
        self.send_response(405)
        self.send_header("Allow", allowed)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        body = json.dumps({"error": "method not allowed"}).encode()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- routing -----------------------------------------------------------

    def do_GET(self) -> None:
        if self.path == "/health":
            # 200 OK with an empty-but-explicit checks object. Future
            # Phase 2 work may add a queue-depth check here; for now the
            # health probe is "process is up and handling requests".
            self._write_json(200, {"status": "ok"})
            return
        if self.path == "/version":
            # Cross-deploy drift detection (Phase 1.5 fix 2.2). The TS
            # client fetches this on cold start and alarms via Sentry if
            # ``patterns`` is not a superset of its MULTILEG_STRUCTURES
            # enum, or if ``matcher_sha`` flips mid-soak.
            self._write_json(
                200,
                {
                    "matcher_sha": _get_matcher_sha(),
                    "release": os.environ.get("RAILWAY_DEPLOYMENT_ID", "local"),
                    "patterns": list(_MULTILEG_PATTERNS),
                },
            )
            return
        if self.path == "/multileg-classify":
            # Wrong verb — tell the caller which method to use rather
            # than fall through to 404, which would mask a TS-client bug.
            self._send_405("POST")
            return
        self._send_404()

    def do_POST(self) -> None:
        if self.path == "/health":
            self._send_405("GET")
            return
        if self.path == "/version":
            # GET-only sibling of /health — mirror the 405 + Allow: GET
            # response so a TS-client author hitting the wrong verb gets
            # the same diagnostic shape on either endpoint.
            self._send_405("GET")
            return
        if self.path != "/multileg-classify":
            self._send_404()
            return

        # Phase 1.5 fix 3.1: reject Transfer-Encoding outright. http.server
        # does NOT auto-decode chunked, so a chunked body would fail closed
        # at the "empty body" 400 below — safe but misleading. 411 Length
        # Required is the RFC 9110 §10.2.1 answer and tells a future
        # streaming TS client exactly what's wrong.
        if self.headers.get("Transfer-Encoding"):
            self._write_json(
                411,
                {
                    "error": (
                        "Transfer-Encoding not supported; use Content-Length"
                    )
                },
                close_connection=True,
            )
            return

        # Phase 1.5 fix 3.2: reject duplicate Content-Length. The classic
        # HTTP request-smuggling pattern is two Content-Length headers (or
        # one CL + one chunked TE) where the edge proxy and the origin
        # disagree on framing. We don't want different framing
        # interpretations between Railway's edge and this Python server,
        # so any ambiguity → 400 + connection close.
        content_length_values = self.headers.get_all("Content-Length") or []
        if len(content_length_values) > 1:
            self._write_json(
                400,
                {"error": "duplicate Content-Length"},
                close_connection=True,
            )
            return

        # Body size cap — applied BEFORE the rfile.read to keep an
        # adversarial caller from filling the matcher's memory before we
        # decide to reject. Content-Length is advisory (clients can lie),
        # but the read cap below enforces it.
        try:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._write_json(
                400, {"error": "Content-Length must be a non-negative integer"},
                close_connection=True,
            )
            return

        if content_length < 0:
            self._write_json(
                400, {"error": "Content-Length must be a non-negative integer"},
                close_connection=True,
            )
            return
        if content_length == 0:
            self._write_json(
                400, {"error": "empty body"}, close_connection=True,
            )
            return
        if content_length > _MAX_BODY_BYTES:
            self._write_json(
                413,
                {
                    "error": "payload too large",
                    "limit_bytes": _MAX_BODY_BYTES,
                    "received_bytes": content_length,
                },
                close_connection=True,
            )
            return

        # Read exactly Content-Length bytes. ``rfile.read(n)`` will block
        # until ``n`` bytes are received or the socket closes — fine for
        # well-behaved clients (the Vercel TS client). If the connection
        # drops mid-read we surface that as a 400 rather than crashing.
        # ``TimeoutError`` (Phase 1.5 fix 1.7) means the per-handler
        # 30s timeout fired during the body read — translate to 408
        # Request Timeout and drop a Sentry breadcrumb so the soak
        # exposes whether 30s is too tight. In Python 3.10+
        # ``socket.timeout`` is a deprecated alias for ``TimeoutError``;
        # we catch the canonical name.
        try:
            body_bytes = self.rfile.read(content_length)
        except (BrokenPipeError, ConnectionResetError):
            # _QuietThreadingHTTPServer swallows these in handle_error,
            # but we still want to avoid invoking the matcher on a
            # truncated body — just exit the request silently.
            return
        except TimeoutError:
            if sentry_setup.is_enabled():
                with contextlib.suppress(Exception):
                    import sentry_sdk

                    sentry_sdk.add_breadcrumb(
                        category="classifier.http",
                        message="rfile.read timed out (Slowloris defense)",
                        level="warning",
                        data={
                            "content_length": content_length,
                            "timeout_seconds": self.timeout,
                        },
                    )
            with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
                self._write_json(
                    408,
                    {"error": "request timeout"},
                    close_connection=True,
                )
            return

        if len(body_bytes) != content_length:
            self._write_json(
                400, {"error": "truncated body"}, close_connection=True,
            )
            return

        status, body = handle_classify_payload(body_bytes)
        # 4xx/5xx get Connection: close so Railway's edge proxy doesn't
        # pool a broken upstream socket. 2xx omits Connection: close so
        # an HTTP/1.1 client that opted into keep-alive can keep the
        # socket pooled — note that BaseHTTPRequestHandler defaults to
        # HTTP/1.0 where keep-alive is off unless the client explicitly
        # requests it, so this is "don't force-close" rather than
        # "actively enable pipelining".
        #
        # 503 queue-timeout responses carry ``retry_after_sec`` in the
        # body (set by ``handle_classify_payload``). Lift it into a
        # ``Retry-After`` HTTP header so RFC-aware clients (and Railway's
        # edge) see it without parsing JSON.
        retry_after = None
        if status == 503 and isinstance(body, dict):
            ra = body.get("retry_after_sec")
            if isinstance(ra, int) and ra > 0:
                retry_after = ra
        self._write_json(
            status,
            body,
            close_connection=status >= 400,
            retry_after_sec=retry_after,
        )

    # ---- access log -------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:
        """Suppress the default per-request stderr access log.

        We keep ``log_error`` (inherited) for real protocol errors and
        rely on the upstream Vercel layer (Sentry breadcrumbs from the
        TS client) for request-level observability. Matches uw-stream
        and sidecar logging conventions.
        """
        return


def build_server(port: int) -> HTTPServer:
    """Construct and return a bound, ready-to-serve classifier server.

    Does NOT call ``serve_forever`` — leave that to ``main.py`` so this
    function is unit-testable without blocking the test thread.

    Bind address is ``0.0.0.0`` so Railway's load balancer can reach it.
    Passing ``port=0`` returns a server bound to an ephemeral port,
    which is the pattern unit tests use.
    """
    return _QuietThreadingHTTPServer(("0.0.0.0", port), ClassifierHandler)
