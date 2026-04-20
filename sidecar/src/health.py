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
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
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
        if self.path.startswith("/archive/es-range"):
            self._handle_archive_es_range()
            return
        if self.path.startswith("/archive/analog-days"):
            self._handle_archive_analog_days()
            return
        if self.path.startswith("/archive/day-summary"):
            self._handle_archive_day_summary()
            return
        if self.path.startswith("/archive/day-features-batch"):
            self._handle_archive_day_features_batch()
            return
        if self.path.startswith("/archive/day-summary-batch"):
            self._handle_archive_day_summary_batch()
            return
        if self.path.startswith("/archive/day-summary-prediction-batch"):
            self._handle_archive_day_summary_prediction_batch()
            return
        if self.path.startswith("/archive/day-summary-prediction"):
            self._handle_archive_day_summary_prediction()
            return
        if self.path.startswith("/archive/day-features"):
            self._handle_archive_day_features()
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

    def _handle_archive_es_range(self) -> None:
        """GET /archive/es-range?date=YYYY-MM-DD → ES day summary from archive.

        Unauthenticated read endpoint. Data is already public market data
        and the archive itself doesn't contain any secrets. Date is the
        only input and is validated to match YYYY-MM-DD exactly.
        """
        from urllib.parse import parse_qs, urlparse
        import re

        qs = parse_qs(urlparse(self.path).query)
        date = (qs.get("date") or [""])[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {"error": "date must be YYYY-MM-DD"}
                ).encode()
            )
            return

        try:
            # Local import keeps sidecar startup fast when nothing in
            # the current deploy path touches the archive; duckdb adds
            # ~12 MB of import cost we can defer to first query.
            import archive_query

            result = archive_query.es_day_summary(date)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except ValueError as exc:
            # Known "no data for this date" — return 404 with message.
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode())
        except Exception as exc:  # noqa: BLE001
            log.error("es-range query failed for %s: %s", date, exc)
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "query failed"}).encode()
            )

    def _handle_archive_analog_days(self) -> None:
        """GET /archive/analog-days?date=YYYY-MM-DD&until_minute=60&k=20"""
        from urllib.parse import parse_qs, urlparse
        import re

        qs = parse_qs(urlparse(self.path).query)
        date = (qs.get("date") or [""])[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self._send_json(400, {"error": "date must be YYYY-MM-DD"})
            return

        # `until_minute` and `k` have defaults in the query layer — only
        # pass through when supplied so validation errors come from the
        # ONE place that knows the bounds.
        kwargs: dict[str, int] = {}
        for name in ("until_minute", "k"):
            raw = (qs.get(name) or [""])[0]
            if raw:
                try:
                    kwargs[name] = int(raw)
                except ValueError:
                    self._send_json(400, {"error": f"{name} must be an integer"})
                    return

        try:
            import archive_query

            result = archive_query.analog_days(date, **kwargs)
            self._send_json(200, result)
        except ValueError as exc:
            # Bounds errors ("k must be...") and no-data errors both
            # surface as ValueError; the message is user-facing either way.
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("analog-days query failed for %s: %s", date, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary(self) -> None:
        """GET /archive/day-summary?date=YYYY-MM-DD → deterministic text.

        Output is `{summary: "..."}` — deliberately narrow so the Vercel
        caller can't accidentally depend on OHLCV details outside the
        summary. The summary text is the ONLY input to the embedding
        pipeline; changing its format invalidates stored embeddings.
        """
        from urllib.parse import parse_qs, urlparse
        import re

        qs = parse_qs(urlparse(self.path).query)
        date = (qs.get("date") or [""])[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self._send_json(400, {"error": "date must be YYYY-MM-DD"})
            return

        try:
            import archive_query

            text = archive_query.day_summary_text(date)
            self._send_json(200, {"date": date, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-summary query failed for %s: %s", date, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_features(self) -> None:
        """GET /archive/day-features?date=YYYY-MM-DD → 60-dim vector.

        Numeric feature vector for the engineered-embedding code path
        (Phase C). Intentionally narrow response — just the vector —
        so the Vercel caller stays decoupled from how the vector is
        computed. Changing the feature set requires a coordinated
        migration + re-backfill and should bump the response shape.
        """
        from urllib.parse import parse_qs, urlparse
        import re

        qs = parse_qs(urlparse(self.path).query)
        date = (qs.get("date") or [""])[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self._send_json(400, {"error": "date must be YYYY-MM-DD"})
            return

        try:
            import archive_query

            vector = archive_query.day_features_vector(date)
            self._send_json(
                200,
                {"date": date, "dim": len(vector), "vector": vector},
            )
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-features query failed for %s: %s", date, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_features_batch(self) -> None:
        """GET /archive/day-features-batch?from=YYYY-MM-DD&to=YYYY-MM-DD

        Returns `{from, to, rows: [{date, symbol, vector}]}`. Single
        DuckDB query covering the whole range — 40x cheaper than N
        calls to /archive/day-features for bulk backfills. Capped at
        3 years per request to bound query cost (a 3-year range is
        ~750 dates × ~370k instruments = well within 8 vCPU budget).
        """
        from urllib.parse import parse_qs, urlparse
        import re
        from datetime import date

        qs = parse_qs(urlparse(self.path).query)
        start = (qs.get("from") or [""])[0]
        end = (qs.get("to") or [""])[0]
        for v in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                self._send_json(400, {"error": "from/to must be YYYY-MM-DD"})
                return
        try:
            d0 = date.fromisoformat(start)
            d1 = date.fromisoformat(end)
        except ValueError:
            self._send_json(400, {"error": "invalid date"})
            return
        if d1 < d0:
            self._send_json(400, {"error": "to must be >= from"})
            return
        # 3-year window cap — longer ranges should paginate client-side.
        if (d1 - d0).days > 366 * 3:
            self._send_json(400, {"error": "range cannot exceed 3 years"})
            return

        try:
            import archive_query

            rows = archive_query.day_features_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            log.error("day-features-batch failed for %s..%s: %s", start, end, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary_batch(self) -> None:
        """GET /archive/day-summary-batch?from=YYYY-MM-DD&to=YYYY-MM-DD"""
        from urllib.parse import parse_qs, urlparse
        import re
        from datetime import date

        qs = parse_qs(urlparse(self.path).query)
        start = (qs.get("from") or [""])[0]
        end = (qs.get("to") or [""])[0]
        for v in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                self._send_json(400, {"error": "from/to must be YYYY-MM-DD"})
                return
        try:
            d0 = date.fromisoformat(start)
            d1 = date.fromisoformat(end)
        except ValueError:
            self._send_json(400, {"error": "invalid date"})
            return
        if d1 < d0:
            self._send_json(400, {"error": "to must be >= from"})
            return
        if (d1 - d0).days > 366 * 3:
            self._send_json(400, {"error": "range cannot exceed 3 years"})
            return

        try:
            import archive_query

            rows = archive_query.day_summary_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            log.error("day-summary-batch failed for %s..%s: %s", start, end, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary_prediction(self) -> None:
        """GET /archive/day-summary-prediction?date=YYYY-MM-DD

        Leakage-free text summary for a single date. Same endpoint
        shape as /archive/day-summary but the response text only
        includes fields available by the end of the first trading hour
        (no EOD close, no full-day range, no full-day volume).
        """
        from urllib.parse import parse_qs, urlparse
        import re

        qs = parse_qs(urlparse(self.path).query)
        date = (qs.get("date") or [""])[0]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            self._send_json(400, {"error": "date must be YYYY-MM-DD"})
            return
        try:
            import archive_query

            text = archive_query.day_summary_prediction(date)
            self._send_json(200, {"date": date, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-summary-prediction failed for %s: %s", date, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary_prediction_batch(self) -> None:
        """GET /archive/day-summary-prediction-batch?from=Y-M-D&to=Y-M-D"""
        from urllib.parse import parse_qs, urlparse
        import re
        from datetime import date

        qs = parse_qs(urlparse(self.path).query)
        start = (qs.get("from") or [""])[0]
        end = (qs.get("to") or [""])[0]
        for v in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                self._send_json(400, {"error": "from/to must be YYYY-MM-DD"})
                return
        try:
            d0 = date.fromisoformat(start)
            d1 = date.fromisoformat(end)
        except ValueError:
            self._send_json(400, {"error": "invalid date"})
            return
        if d1 < d0:
            self._send_json(400, {"error": "to must be >= from"})
            return
        if (d1 - d0).days > 366 * 3:
            self._send_json(400, {"error": "range cannot exceed 3 years"})
            return
        try:
            import archive_query

            rows = archive_query.day_summary_prediction_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            log.error(
                "day-summary-prediction-batch failed %s..%s: %s",
                start, end, exc,
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

    # ThreadingHTTPServer spawns a new thread per request so /archive/*
    # queries don't block the /health probe (and vice versa). Was
    # HTTPServer (single-threaded) previously, which bottlenecked the
    # backfill at 1 req/sec.
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log.info("Health server listening on port %d (threaded)", port)
    return server
