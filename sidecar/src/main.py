"""Railway sidecar entry point.

Starts the HTTP server (port 8080) that serves:

- ``GET /health`` — liveness/readiness (DB reachability).
- ``GET /takeit/health`` + ``POST /takeit/explain`` — take-it SHAP
  explainer used by the ``takeit-fill-shap`` Vercel cron.
- ``POST /takeit/multileg-classify`` — multi-leg classifier fallback.
- ``GET /archive/*`` — read-only DuckDB queries over the frozen
  historical Parquet archive on the ``/data`` volume.
- ``POST /admin/seed-archive`` — one-shot archive seed from Vercel Blob.

Also launches the co-resident Theta Data Terminal (when credentials are
present) and its nightly EOD scheduler.

The sidecar previously streamed futures OHLCV-1m bars, top-of-book,
trade ticks, and ES options trades/statistics from Databento. That
subscription was cancelled and the ingestion path was removed on
2026-09-29; futures data now arrives via the ``uw-stream`` Railway
service. The Twilio-backed alert engine was removed earlier, on
2026-04-08 (SIDE-001).

Runs 24/7 on Railway as a persistent process.
"""

from __future__ import annotations

import signal
import sys
import threading
import time

# Ensure src/ is on the Python path for local imports
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import archive_seeder
import theta_fetcher
import theta_launcher
from config import settings
from db import drain_pool, is_db_healthy, verify_connection
from health import start_health_server
from logger_setup import log
from sentry_setup import init_sentry

_shutting_down = False


def shutdown(signum: int, frame: object) -> None:
    """Graceful shutdown handler."""
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    sig_name = signal.Signals(signum).name
    log.info("Shutting down gracefully (signal: %s)", sig_name)

    # Stop Theta's APScheduler before killing the jar, so no nightly
    # job fires mid-shutdown against a dead HTTP server.
    theta_fetcher.stop_scheduler()

    # Stop the Theta Terminal subprocess. No-op when Theta was never started.
    theta_launcher.shutdown()

    # Give pending writes a moment to complete
    time.sleep(1)
    drain_pool()
    log.info("Shutdown complete")
    sys.exit(0)


def main() -> None:
    """Main entry point: verify env, connect DB, start the HTTP server."""
    log.info("Sidecar starting")

    # Initialize Sentry first so any later failures get reported.
    # No-op locally if SENTRY_DSN is unset. Never raises.
    init_sentry()

    # Verify required env vars BEFORE launching any subsystems. Missing
    # env used to fall through past the Theta launcher (~60s blocking
    # subprocess boot) and only fail at the verify_connection() call —
    # wasted Railway compute and confusing logs. Fail fast instead.
    required = ["DATABASE_URL"]
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        log.error(
            "Missing required environment variable(s): %s",
            ", ".join(missing),
        )
        sys.exit(1)

    # Launch the co-resident Theta Terminal subprocess. Blocks up to
    # 60s waiting for its HTTP server. No-op when THETA_EMAIL /
    # THETA_PASSWORD are unset (local dev, or deliberate disable).
    # Failures are reported to Sentry but never block sidecar startup.
    if theta_launcher.start():
        # Nightly 17:25 ET scheduler + one-time backfill in a daemon thread.
        # Both are safe no-ops when Theta is dead or the table already has data.
        theta_fetcher.start_scheduler()
        threading.Thread(
            target=theta_fetcher.run_backfill_if_needed,
            name="theta-backfill",
            daemon=True,
        ).start()

    # Take-It SHAP routes (Phase 3d, spec
    # docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md)
    # are served by the health server on port 8080 — no separate process
    # needed. Enable per-deployment via TAKEIT_SERVER_ENABLED=1 +
    # TAKEIT_SIDECAR_SHARED_SECRET; sidecar/src/takeit_server.is_enabled()
    # short-circuits /takeit/explain when disabled or when ML deps are
    # missing, leaving the rest of the sidecar unaffected.

    # Verify database connection
    verify_connection()

    # Build the archive seed callable when the required env is present.
    # Absence of either var disables the POST /admin/seed-archive endpoint;
    # the handler returns 401 (see health.do_POST) rather than a confusing 500.
    manifest_url = os.environ.get("ARCHIVE_MANIFEST_URL", "").strip()
    blob_token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
    archive_root = os.environ.get("ARCHIVE_ROOT", "/data/archive").strip()
    seed_callable = None
    if manifest_url and blob_token:

        def seed_callable() -> dict[str, object]:
            return archive_seeder.seed_from_manifest(
                manifest_url, archive_root, blob_token
            ).as_dict()

        log.info("Archive seed endpoint enabled (root=%s)", archive_root)
    else:
        log.info(
            "Archive seed endpoint disabled "
            "(ARCHIVE_MANIFEST_URL or BLOB_READ_WRITE_TOKEN missing)"
        )

    # Start health check server. Theta reporters are always passed —
    # when Theta is disabled (no credentials) the callables just return
    # False / 0.0 / None and the /health response honestly reports that.
    start_health_server(
        port=settings.port,
        is_db_healthy=is_db_healthy,
        theta_is_running=theta_launcher.is_running,
        theta_last_ready_at=theta_launcher.last_ready_at,
        theta_last_error=theta_launcher.last_error,
        seed_archive=seed_callable,
        seed_is_busy=archive_seeder.is_seeding,
    )

    # Register signal handlers
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    wait_for_shutdown()


def wait_for_shutdown() -> None:
    """Park the main thread until a signal handler ends the process.

    The HTTP server runs on a daemon thread, so returning from main()
    would exit the process immediately. ``time.sleep`` is interrupted by
    signals: ``shutdown()`` runs in this thread and its ``sys.exit(0)``
    raises SystemExit out of the sleep. The flag check covers a
    shutdown that has already begun.
    """
    while not _shutting_down:
        time.sleep(1.0)


if __name__ == "__main__":
    main()
