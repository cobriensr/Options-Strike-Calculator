"""Classifier service entrypoint.

Run as ``python -m main`` (the Dockerfile CMD) from
``classifier/src/`` once ``PYTHONPATH`` points at this directory.
Boots Sentry, builds the HTTP server, and blocks on ``serve_forever``
until Railway sends SIGTERM (graceful shutdown) or the operator hits
Ctrl-C.

Kept deliberately short: no background tasks, no signal handlers
beyond what ``serve_forever`` already responds to via KeyboardInterrupt.
http.server's ThreadingHTTPServer cleans up its worker threads on
``shutdown()``; the try/finally guarantees the listening socket is
released even when boot fails halfway.
"""

from __future__ import annotations

import contextlib
import os
import sys

import sentry_setup
import server

_DEFAULT_PORT = 8080


def _parse_port(raw: str | None) -> int:
    """Parse the PORT env var; raise ValueError with a useful message on bad input."""
    if raw is None or raw.strip() == "":
        return _DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError as exc:
        raise ValueError(f"PORT must be an integer, got {raw!r}") from exc
    if port <= 0 or port > 65535:
        raise ValueError(f"PORT must be in 1..65535, got {port}")
    return port


def main() -> int:
    """Entrypoint; returns a process exit code."""
    # Sentry init must never block the service from starting. The
    # helper is already best-effort, but wrap defensively here in case
    # a future change makes it raise.
    try:
        sentry_setup.init()
    except Exception as exc:
        print(f"main: sentry init raised, continuing without Sentry: {exc}", flush=True)

    try:
        port = _parse_port(os.environ.get("PORT"))
    except ValueError as exc:
        print(f"main: {exc}", flush=True)
        return 2

    httpd = server.build_server(port)
    print(f"classifier listening on 0.0.0.0:{port}", flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        # SIGINT in dev / Ctrl-C — fall through to the finally block.
        pass
    finally:
        # Railway sends SIGTERM (which Python translates to
        # KeyboardInterrupt under the default handler when running as
        # PID 1, same code path). ``shutdown`` is idempotent and the
        # ``server_close`` releases the listening socket so a quick
        # restart doesn't hit "address already in use". Suppress broadly:
        # the process is exiting anyway, and a noisy traceback on the
        # cleanup path masks the underlying serve_forever failure that
        # got us here.
        with contextlib.suppress(Exception):
            httpd.shutdown()
        with contextlib.suppress(Exception):
            httpd.server_close()
        print("classifier stopped", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
