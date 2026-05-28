"""HTTP server for the multileg classifier service.

Small ThreadingHTTPServer that fronts ``multileg_routes.handle_classify_payload``
with route dispatch (``/health`` GET, ``/multileg-classify`` POST), method
validation (405 on the wrong verb), and a request-body size cap (50 MB →
413). Route handler logic stays in ``multileg_routes``; this module is
HTTP plumbing only.

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
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from typing import Any

from multileg_routes import handle_classify_payload

# 50 MB cap on request body. Realistic 7500-trade payloads are ~3-4 MB
# (Phase 2 keeps that bound; see spec). Numbers larger than this are
# unambiguously bad-input or attack traffic and we reject before reading
# any bytes off the wire.
_MAX_BODY_BYTES = 50 * 1024 * 1024


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
    """

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc_type = sys.exc_info()[0]
        if exc_type is not None and issubclass(
            exc_type, (BrokenPipeError, ConnectionResetError)
        ):
            return
        super().handle_error(request, client_address)


class ClassifierHandler(BaseHTTPRequestHandler):
    """Route dispatcher for ``/health`` and ``/multileg-classify``."""

    # ---- response helpers ---------------------------------------------------

    def _write_json(
        self,
        status: int,
        body: dict,
        *,
        close_connection: bool = False,
    ) -> None:
        """Send a JSON response with the right headers.

        ``close_connection=True`` is set on every 4xx/5xx so Railway's
        edge proxy doesn't keep the broken socket pooled. The
        ``default=str`` argument to ``json.dumps`` matches the sidecar
        contract — pydantic validation_error details include datetime
        / Decimal-ish values that need string coercion.
        """
        payload = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if close_connection:
            self.send_header("Connection", "close")
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
        if self.path != "/multileg-classify":
            self._send_404()
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
        try:
            body_bytes = self.rfile.read(content_length)
        except (BrokenPipeError, ConnectionResetError):
            # _QuietThreadingHTTPServer swallows these in handle_error,
            # but we still want to avoid invoking the matcher on a
            # truncated body — just exit the request silently.
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
        self._write_json(status, body, close_connection=status >= 400)

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
