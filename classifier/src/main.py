"""Classifier service entrypoint.

Run as ``python -m main`` (the Dockerfile CMD) from
``classifier/src/`` once ``PYTHONPATH`` points at this directory.
Boots Sentry, builds the HTTP server, and blocks on ``serve_forever``
until Railway sends SIGTERM (graceful shutdown) or the operator hits
Ctrl-C.

Kept deliberately short: no background tasks, just an explicit SIGTERM
handler (Phase 1.5 fix 0.3) and a try/finally that drains the listener.
http.server's ThreadingHTTPServer cleans up its worker threads on
``shutdown()``; the try/finally guarantees the listening socket is
released even when boot fails halfway and that ``sentry_sdk.flush`` runs
before the process exits.
"""

from __future__ import annotations

import contextlib
import os
import signal
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


def _on_sigterm(_signum: int, _frame: object) -> None:
    """Translate SIGTERM into KeyboardInterrupt so ``main``'s finally runs.

    Python's *default* SIGTERM handler is the OS default — immediate
    process termination with no exception raised. That means without
    this explicit override, a Railway redeploy would SIGKILL us
    mid-classify with no ``finally`` block, no ``server.shutdown()``,
    and no ``sentry_sdk.flush()``. Raising KeyboardInterrupt funnels
    SIGTERM through the same exit path as Ctrl-C.
    """
    raise KeyboardInterrupt


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
        # Sentry is up by this point (init ran above). Capture the
        # misconfig BEFORE returning 2 so a bad PORT env doesn't
        # crashloop silently — Phase 1.5 fix 3.3.
        with contextlib.suppress(Exception):
            sentry_setup.capture_exception(exc, tags={"phase": "port_parse"})
        print(f"main: {exc}", flush=True)
        return 2

    httpd = server.build_server(port)

    # Surface the effective polars thread-pool size at boot so a regressed
    # POLARS_MAX_THREADS (or a Railway env that didn't propagate) is visible
    # in the Railway log stream rather than silently re-inflating peak memory.
    try:
        import polars as pl

        print(
            f"classifier: polars thread_pool_size={pl.thread_pool_size()}",
            flush=True,
        )
    except Exception as exc:  # pragma: no cover - observability only
        print(
            f"classifier: could not read polars thread_pool_size: {exc}",
            flush=True,
        )

    print(f"classifier listening on 0.0.0.0:{port}", flush=True)

    # Install the SIGTERM handler BEFORE serve_forever so a Railway
    # redeploy that arrives milliseconds after boot still cleans up.
    # Phase 1.5 fix 0.3 — the original code's comment claimed Python's
    # default handler raised KeyboardInterrupt, which is false.
    signal.signal(signal.SIGTERM, _on_sigterm)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        # SIGINT (Ctrl-C) and our explicit SIGTERM handler both land here.
        pass
    finally:
        # ``shutdown`` is idempotent and ``server_close`` releases the
        # listening socket so a quick restart doesn't hit "address
        # already in use". Suppress broadly: the process is exiting
        # anyway, and a noisy traceback on the cleanup path masks the
        # underlying serve_forever failure that got us here.
        with contextlib.suppress(Exception):
            httpd.shutdown()
        with contextlib.suppress(Exception):
            httpd.server_close()
        # Phase 1.5 fix 0.3: flush queued Sentry events with a short
        # timeout. Suppress because flush() may raise when Sentry is
        # unset (no-op SDK) or already torn down.
        with contextlib.suppress(Exception):
            import sentry_sdk

            sentry_sdk.flush(timeout=2)
        print("classifier stopped", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
