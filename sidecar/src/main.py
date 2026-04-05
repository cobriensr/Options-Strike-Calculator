"""Futures data sidecar entry point.

Streams multi-symbol futures OHLCV-1m bars + ES options trades via Databento,
writes to Neon Postgres, evaluates alert conditions, sends Twilio SMS.

Runs 24/7 on Railway as a persistent process.
"""

from __future__ import annotations

import signal
import sys
import time

# Ensure src/ is on the Python path for local imports
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from alert_engine import AlertEngine
from config import settings
from databento_client import DatabentoClient
from db import drain_pool, is_db_healthy, verify_connection
from health import start_health_server
from logger_setup import log
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

    # Give pending writes a moment to complete
    time.sleep(1)
    drain_pool()
    log.info("Shutdown complete")
    sys.exit(0)


def main() -> None:
    """Main entry point: verify env, connect DB, start streaming."""
    global _client

    log.info("Futures relay sidecar starting")

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
    alert_engine = AlertEngine(trade_processor=trade_processor)

    # Create the Databento client
    _client = DatabentoClient(
        alert_engine=alert_engine,
        trade_processor=trade_processor,
    )

    # Start health check server
    start_health_server(
        port=settings.port,
        is_connected=lambda: _client.is_connected if _client else False,
        last_bar_at=lambda: _client.last_bar_ts if _client else 0.0,
        is_db_healthy=is_db_healthy,
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
            log.error(
                "Connection attempt failed: %s (backoff: %.1fs)",
                exc,
                backoff,
            )
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
