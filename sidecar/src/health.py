"""HTTP server on port 8080 — health check + admin endpoints.

Serves `GET /health` for liveness/readiness monitoring and
`POST /admin/seed-archive` for one-shot seeding of the persistent
volume from Vercel Blob. The admin endpoint is gated on a shared token
and is safe to leave deployed — subsequent calls are cheap (SHA-based
resume) and guarded by a single-flight lock in `archive_seeder`.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable

from archive_seeder import SeedBusyError
from logger_setup import log


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

    def do_POST(self) -> None:  # noqa: N802 — http.server naming convention
        """Dispatch POST requests. Currently only /admin/seed-archive."""
        if self.path != "/admin/seed-archive":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        if self.seed_archive is None:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "seed endpoint not configured"}).encode()
            )
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

    def _send_busy_response(self) -> None:
        self.send_response(423)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({"error": "seed already in progress"}).encode()
        )

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

    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("Health server listening on port %d", port)
    return server
