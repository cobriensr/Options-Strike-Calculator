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
import re
import threading
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from archive_seeder import SeedBusyError
from logger_setup import log

# 3-year window cap on /archive/*-batch range queries. A 3-year range
# is ~750 trading dates × ~370k instruments — well within the 8 vCPU
# budget on Railway. Anything larger should paginate client-side.
# Used by 3 batch handlers (day-features-batch, day-summary-batch,
# day-summary-prediction-batch).
_BATCH_RANGE_MAX_DAYS = 366 * 3

# Compiled once — every archive handler reuses this.
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _is_today_or_future_utc(date_str: str) -> bool:
    """Return True when date_str (YYYY-MM-DD) is >= today in UTC.

    SIDE-017: used by /archive/day-summary and /archive/day-features
    to short-circuit queries for dates that cannot possibly be in the
    archive yet. The refresh-current-snapshot Vercel cron polls for
    today's summary+features every 5 min during RTH (``*/5 13-20 * *
    1-5``), but the archive only gets today's partitions after the
    EOD ETL. Before this guard, each doomed call ran a 3–7s DuckDB
    query against 3.9 GB of Parquet just to discover the date had
    no rows — ~96 wasted queries per session, each contributing
    memory pressure on an already-strained Railway tier.
    """
    today_utc = datetime.now(timezone.utc).date().isoformat()
    return date_str >= today_utc


class _BadRequest(Exception):
    """Raised by parse helpers when an input is missing/malformed.

    Internal sentinel — caught by the route dispatch and converted to
    HTTP 400. Never escapes the module.
    """


def _parse_date_param(qs: dict[str, list[str]], name: str) -> str:
    """Return ``qs[name]`` validated as YYYY-MM-DD, or raise _BadRequest.

    Centralizes the regex check that was inlined in 10+ handlers. The
    error message mirrors the one each handler used so test assertions
    that grep for "YYYY-MM-DD" continue to pass.
    """
    raw = (qs.get(name) or [""])[0]
    if not _DATE_RE.fullmatch(raw):
        raise _BadRequest(f"{name} must be YYYY-MM-DD")
    return raw


def _parse_optional_int(
    qs: dict[str, list[str]], name: str, *, lo: int | None = None
) -> int | None:
    """Parse an optional integer query param, or raise _BadRequest.

    Returns None when the param is absent (so the caller can omit the
    kwarg and let the query layer apply its own default). When present
    but unparseable / below ``lo``, raises with the same messages each
    handler used previously.
    """
    raw = (qs.get(name) or [""])[0]
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        raise _BadRequest(f"{name} must be an integer") from None
    if lo is not None and value < lo:
        raise _BadRequest(f"{name} must be >= {lo}")
    return value


def _parse_date_range(
    qs: dict[str, list[str]],
) -> tuple[str, str]:
    """Parse from/to YYYY-MM-DD pair + apply the 3-year cap.

    Returns ``(start, end)`` strings; raises _BadRequest with the
    handler's pre-existing message on any violation. Centralizes the
    block duplicated across 3 batch handlers.
    """
    start = (qs.get("from") or [""])[0]
    end = (qs.get("to") or [""])[0]
    for v in (start, end):
        if not _DATE_RE.fullmatch(v):
            raise _BadRequest("from/to must be YYYY-MM-DD")
    try:
        d0 = date.fromisoformat(start)
        d1 = date.fromisoformat(end)
    except ValueError:
        raise _BadRequest("invalid date") from None
    if d1 < d0:
        raise _BadRequest("to must be >= from")
    if (d1 - d0).days > _BATCH_RANGE_MAX_DAYS:
        raise _BadRequest("range cannot exceed 3 years")
    return start, end


# Lazy-loaded reference to the `archive_query` module. DuckDB import
# cost (~12 MB) is real, so we defer until the first archive request
# rather than paying it at sidecar startup. The holder pattern (vs.
# importing inside each handler) means we pay the import once and the
# module attribute lookup on every call after — same cheap dict probe
# the per-handler `import` already devolves to after Python's import
# cache warms.
#
# Tests that patch `archive_query.X` continue to work: `_aq()` returns
# the same module object the test patches, so the attribute lookup
# resolves to the patched callable.
_archive_query_module: Any = None


def _aq() -> Any:
    """Return the lazy-loaded `archive_query` module."""
    global _archive_query_module
    if _archive_query_module is None:
        import archive_query

        _archive_query_module = archive_query
    return _archive_query_module


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
        # Route dispatch ordered by specificity — longer/more-specific
        # prefixes MUST come before shorter ones or they get swallowed.
        # e.g. `/archive/day-summary-prediction` would match
        # `/archive/day-summary` if that route check ran first.
        if self.path.startswith("/archive/es-range"):
            self._handle_archive_es_range()
            return
        if self.path.startswith("/archive/analog-days"):
            self._handle_archive_analog_days()
            return
        if self.path.startswith("/archive/day-summary-prediction-batch"):
            self._handle_archive_day_summary_prediction_batch()
            return
        if self.path.startswith("/archive/day-summary-prediction"):
            self._handle_archive_day_summary_prediction()
            return
        if self.path.startswith("/archive/day-summary-batch"):
            self._handle_archive_day_summary_batch()
            return
        if self.path.startswith("/archive/day-summary"):
            self._handle_archive_day_summary()
            return
        if self.path.startswith("/archive/day-features-batch"):
            self._handle_archive_day_features_batch()
            return
        if self.path.startswith("/archive/day-features"):
            self._handle_archive_day_features()
            return
        if self.path.startswith("/archive/tbbo-day-microstructure"):
            self._handle_archive_tbbo_day_microstructure()
            return
        if self.path.startswith("/archive/tbbo-ofi-percentile"):
            self._handle_archive_tbbo_ofi_percentile()
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
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            result = _aq().es_day_summary(d)
            self._send_json(200, result)
        except ValueError as exc:
            # Known "no data for this date" — return 404 with message.
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("es-range query failed for %s: %s", d, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_analog_days(self) -> None:
        """GET /archive/analog-days?date=YYYY-MM-DD&until_minute=60&k=20"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
            # `until_minute` and `k` have defaults in the query layer —
            # only pass through when supplied so validation errors come
            # from the ONE place that knows the bounds.
            kwargs: dict[str, int] = {}
            for name in ("until_minute", "k"):
                value = _parse_optional_int(qs, name)
                if value is not None:
                    kwargs[name] = value
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            result = _aq().analog_days(d, **kwargs)
            self._send_json(200, result)
        except ValueError as exc:
            # Bounds errors ("k must be...") and no-data errors both
            # surface as ValueError; the message is user-facing either way.
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("analog-days query failed for %s: %s", d, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary(self) -> None:
        """GET /archive/day-summary?date=YYYY-MM-DD → deterministic text.

        Output is `{summary: "..."}` — deliberately narrow so the Vercel
        caller can't accidentally depend on OHLCV details outside the
        summary. The summary text is the ONLY input to the embedding
        pipeline; changing its format invalidates stored embeddings.
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        # SIDE-017: short-circuit today/future — archive never has
        # those partitions during RTH. Avoids a 3–7s DuckDB query that
        # is guaranteed to miss and consume memory each time.
        if _is_today_or_future_utc(d):
            self._send_json(
                404, {"error": "date not yet in archive (today or future)"}
            )
            return

        try:
            text = _aq().day_summary_text(d)
            self._send_json(200, {"date": d, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-summary query failed for %s: %s", d, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_features(self) -> None:
        """GET /archive/day-features?date=YYYY-MM-DD → 60-dim vector.

        Numeric feature vector for the engineered-embedding code path
        (Phase C). Intentionally narrow response — just the vector —
        so the Vercel caller stays decoupled from how the vector is
        computed. Changing the feature set requires a coordinated
        migration + re-backfill and should bump the response shape.
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        # SIDE-017: short-circuit today/future — same rationale as
        # _handle_archive_day_summary. The refresh-current-snapshot
        # cron fires both of these in parallel every 5 min in RTH.
        if _is_today_or_future_utc(d):
            self._send_json(
                404, {"error": "date not yet in archive (today or future)"}
            )
            return

        try:
            vector = _aq().day_features_vector(d)
            self._send_json(
                200,
                {"date": d, "dim": len(vector), "vector": vector},
            )
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-features query failed for %s: %s", d, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_features_batch(self) -> None:
        """GET /archive/day-features-batch?from=YYYY-MM-DD&to=YYYY-MM-DD

        Returns `{from, to, rows: [{date, symbol, vector}]}`. Single
        DuckDB query covering the whole range — 40x cheaper than N
        calls to /archive/day-features for bulk backfills. Capped at
        3 years per request to bound query cost (a 3-year range is
        ~750 dates × ~370k instruments = well within 8 vCPU budget).
        """
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_features_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            log.error("day-features-batch failed for %s..%s: %s", start, end, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary_batch(self) -> None:
        """GET /archive/day-summary-batch?from=YYYY-MM-DD&to=YYYY-MM-DD"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_summary_batch(start, end)
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
        qs = parse_qs(urlparse(self.path).query)
        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            text = _aq().day_summary_prediction(d)
            self._send_json(200, {"date": d, "summary": text})
        except ValueError as exc:
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("day-summary-prediction failed for %s: %s", d, exc)
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_day_summary_prediction_batch(self) -> None:
        """GET /archive/day-summary-prediction-batch?from=Y-M-D&to=Y-M-D"""
        qs = parse_qs(urlparse(self.path).query)
        try:
            start, end = _parse_date_range(qs)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            rows = _aq().day_summary_prediction_batch(start, end)
            self._send_json(200, {"from": start, "to": end, "rows": rows})
        except Exception as exc:  # noqa: BLE001
            log.error(
                "day-summary-prediction-batch failed %s..%s: %s",
                start,
                end,
                exc,
            )
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_tbbo_day_microstructure(self) -> None:
        """GET /archive/tbbo-day-microstructure?date=YYYY-MM-DD&symbol=ES|NQ

        Returns the per-day microstructure summary (OFI at 5m / 15m / 1h
        plus trade count) for the requested ``(date, symbol)``.

        Unauthenticated — TBBO data is public market data, and the
        sidecar doesn't expose any secrets through this shape.
        """
        qs = parse_qs(urlparse(self.path).query)
        symbol = (qs.get("symbol") or [""])[0].upper()

        try:
            d = _parse_date_param(qs, "date")
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return
        if symbol not in {"ES", "NQ"}:
            self._send_json(400, {"error": "symbol must be 'ES' or 'NQ'"})
            return

        try:
            result = _aq().tbbo_day_microstructure(d, symbol)
            self._send_json(200, result)
        except ValueError as exc:
            # "No TBBO X bars found..." = 404; invalid-input errors were
            # caught by the regex / allowlist above. Any ValueError here
            # is a missing-data case.
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error(
                "tbbo-day-microstructure failed for %s/%s: %s",
                d,
                symbol,
                exc,
            )
            self._send_json(500, {"error": "query failed"})

    def _handle_archive_tbbo_ofi_percentile(self) -> None:
        """GET /archive/tbbo-ofi-percentile?symbol=ES|NQ&value=<float>&window=5m|15m|1h

        Returns ``{symbol, window, current_value, percentile, mean, std, count}``
        describing where ``value`` falls in the last 252 days of historical
        daily-mean OFI at ``window`` for ``symbol`` (front-month only).
        """
        import math

        qs = parse_qs(urlparse(self.path).query)
        symbol = (qs.get("symbol") or [""])[0].upper()
        value_raw = (qs.get("value") or [""])[0]
        window = (qs.get("window") or ["1h"])[0]

        if symbol not in {"ES", "NQ"}:
            self._send_json(400, {"error": "symbol must be 'ES' or 'NQ'"})
            return
        if window not in {"5m", "15m", "1h"}:
            self._send_json(400, {"error": "window must be '5m', '15m', or '1h'"})
            return
        if not value_raw:
            self._send_json(400, {"error": "value is required"})
            return
        try:
            value = float(value_raw)
        except ValueError:
            self._send_json(400, {"error": "value must be a finite number"})
            return
        if not math.isfinite(value):
            self._send_json(400, {"error": "value must be a finite number"})
            return

        kwargs: dict[str, object] = {"window": window}
        try:
            horizon = _parse_optional_int(qs, "horizon_days", lo=1)
        except _BadRequest as exc:
            self._send_json(400, {"error": str(exc)})
            return
        if horizon is not None:
            # Public unauthenticated endpoint — cap at ~4 trading
            # years to bound query cost. A caller requesting an
            # absurd horizon would otherwise full-scan the archive.
            if horizon > _aq()._TBBO_OFI_MAX_HORIZON_DAYS:
                self._send_json(
                    400,
                    {
                        "error": (
                            "horizon_days must be <= "
                            f"{_aq()._TBBO_OFI_MAX_HORIZON_DAYS}"
                        )
                    },
                )
                return
            kwargs["horizon_days"] = horizon

        try:
            result = _aq().tbbo_ofi_percentile(symbol, value, **kwargs)
            self._send_json(200, result)
        except ValueError as exc:
            # No-data errors → 404 (empty archive / window never had data);
            # other ValueError messages are input-shape (shouldn't reach
            # the query layer after the validation above).
            self._send_json(404, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log.error("tbbo-ofi-percentile failed for %s/%s: %s", symbol, window, exc)
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
        self.wfile.write(json.dumps({"error": "seed already in progress"}).encode())

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
