"""HTTP health check server on port 8080 (same as existing sidecar).

Reports status of the Databento connection, data freshness, and DB health.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Callable

from logger_setup import log


class HealthHandler(BaseHTTPRequestHandler):
    """Handle GET /health requests."""

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

    def do_GET(self) -> None:
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
        except Exception:
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
) -> HTTPServer:
    """Start the health check HTTP server in a background thread.

    The three `theta_*` callables are optional — pass them in to expose
    Theta Terminal status in the /health JSON response. When omitted,
    the response body omits the `theta` block entirely so downstream
    monitoring can cleanly detect the "Theta disabled" state.
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

    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("Health server listening on port %d", port)
    return server
