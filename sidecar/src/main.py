"""Futures data sidecar entry point.

Streams multi-symbol futures OHLCV-1m bars + ES options trades via
Databento and writes them to Neon Postgres. Downstream Vercel crons
and the frontend consume the data (futures_bars, futures_options_daily,
futures_options_trades) for overnight calculations, ML features, and
the futures dashboard panel.

The sidecar previously also ran a Twilio-backed alert engine
(es_momentum, vx_backwardation, es_nq_divergence, zn_flight_safety,
cl_spike, es_options_volume). That whole path was removed on
2026-04-08 — see the audit note under SIDE-001. The sidecar is now a
pure data relay; all intelligence lives in Vercel crons and the UI.

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

import theta_fetcher
import theta_launcher
from config import settings
from databento_client import DatabentoClient
from db import drain_pool, is_db_healthy, verify_connection
from health import start_health_server
from logger_setup import log
from sentry_setup import capture_exception, init_sentry
from trade_processor import TradeProcessor

# Global references for shutdown
_client: DatabentoClient | None = None
_shutting_down = False


def shutdown(signum: int, frame: object) -> None:
    """Graceful shutdown handler."""
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    sig_name = signal.Signals(signum).name
    log.info("Shutting down gracefully (signal: %s)", sig_name)

    if _client:
        _client.stop()

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
    """Main entry point: verify env, connect DB, start streaming."""
    global _client

    log.info("Futures relay sidecar starting")

    # Initialize Sentry first so any later failures get reported.
    # No-op locally if SENTRY_DSN is unset. Never raises.
    init_sentry()

    # Launch the co-resident Theta Terminal subprocess. Blocks up to
    # 60s waiting for its HTTP server. No-op when THETA_EMAIL /
    # THETA_PASSWORD are unset (local dev, or deliberate disable).
    # Failures are reported to Sentry but never block Databento startup.
    if theta_launcher.start():
        # Nightly 17:25 ET scheduler + one-time backfill in a daemon thread.
        # Both are safe no-ops when Theta is dead or the table already has data.
        theta_fetcher.start_scheduler()
        threading.Thread(
            target=theta_fetcher.run_backfill_if_needed,
            name="theta-backfill",
            daemon=True,
        ).start()

    # Verify required env vars
    required = ["DATABENTO_API_KEY", "DATABASE_URL"]
    for key in required:
        if not os.environ.get(key):
            log.error("Missing required environment variable: %s", key)
            sys.exit(1)

    # Verify database connection
    verify_connection()

    # Initialize components
    trade_processor = TradeProcessor()

    # Create the Databento client
    _client = DatabentoClient(
        trade_processor=trade_processor,
    )

    # Start health check server. Theta reporters are always passed —
    # when Theta is disabled (no credentials) the callables just return
    # False / 0.0 / None and the /health response honestly reports that.
    start_health_server(
        port=settings.port,
        is_connected=lambda: _client.is_connected if _client else False,
        last_bar_at=lambda: _client.last_bar_ts if _client else 0.0,
        is_db_healthy=is_db_healthy,
        theta_is_running=theta_launcher.is_running,
        theta_last_ready_at=theta_launcher.last_ready_at,
        theta_last_error=theta_launcher.last_error,
    )

    # Register signal handlers
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # Connect with retry loop
    connect_with_retry(_client)


def connect_with_retry(client: DatabentoClient) -> None:
    """Start the Databento client with exponential backoff on failure."""
    backoff = 1.0
    max_backoff = 30.0

    while not _shutting_down:
        try:
            client.start()

            # Block until the connection closes (reconnection is handled
            # internally by the SDK with ReconnectPolicy.RECONNECT)
            client.block_for_close()

            # If we get here, the client exited cleanly or lost connection
            # permanently. The SDK's reconnect policy handles transient failures.
            if _shutting_down:
                break

            log.warning("Databento client exited, will retry")
            # Clean up old client state before restarting
            client.stop()
            backoff = 1.0  # Reset backoff on clean exit

        except KeyboardInterrupt:
            break
        except Exception as exc:
            capture_exception(exc, context={"backoff_s": backoff})
            # Clean up on error too
            try:
                client.stop()
            except Exception:
                pass

        if _shutting_down:
            break

        log.info("Reconnecting after %.1fs backoff", backoff)
        time.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)


if __name__ == "__main__":
    main()
