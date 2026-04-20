"""Tests for health — the sidecar's /health HTTP endpoint.

Exercises the HealthHandler class directly rather than spinning up a
real HTTPServer. The handler's GET path writes status + headers + body
via `self.send_response` / `self.end_headers` / `self.wfile.write`,
which we intercept with a tiny fake wfile so we can assert JSON shape.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from health import HealthHandler  # noqa: E402


class _FakeRequest:
    """Minimal request stub BaseHTTPRequestHandler expects."""

    def __init__(self, path: str = "/health") -> None:
        self.path = path
        self.raw = f"GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n".encode()

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        if "r" in mode:
            return io.BytesIO(self.raw)
        return io.BytesIO()


def _run_request(path: str = "/health") -> tuple[int, dict]:
    """Drive HealthHandler for one request; return (status, body_obj)."""
    req = _FakeRequest(path=path)
    # Write buffer lives on the instance as `wfile` once BaseHTTPRequestHandler
    # runs setup(). We capture everything it writes for later parsing.
    output = io.BytesIO()

    class _H(HealthHandler):
        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = req.makefile("rb")
            self_inner.wfile = output

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(req, ("127.0.0.1", 0), None)  # type: ignore[arg-type]
    raw = output.getvalue().decode()
    # First line: HTTP/1.x <status> <reason>
    status_line, *rest = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    # Body is everything after the empty separator line.
    _, _, body_text = raw.partition("\r\n\r\n")
    if not body_text:
        return status, {}
    try:
        return status, json.loads(body_text)
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


@pytest.fixture(autouse=True)
def reset_handler_state() -> None:
    """Clear class-level callables between tests."""
    # Force Theta reporters off by default so tests are deterministic.
    HealthHandler.theta_is_running = None
    HealthHandler.theta_last_ready_at = None
    HealthHandler.theta_last_error = None
    yield


@pytest.fixture
def configure_base_callables() -> None:
    """Install connected/db-healthy/non-stale reporters that return OK."""
    HealthHandler.is_connected = staticmethod(lambda: True)
    HealthHandler.last_bar_at = staticmethod(lambda: 9e18)  # "recent"
    HealthHandler.is_db_healthy = staticmethod(lambda: True)


def test_health_returns_200_when_all_ok(configure_base_callables) -> None:
    # Data-freshness logic only runs when _is_data_expected() is True;
    # force False to avoid weekday/hour dependency in tests.
    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["status"] == "ok"
    assert body["checks"] == {"databento": True, "data_fresh": True, "db": True}
    # No Theta block when reporters aren't configured.
    assert "theta" not in body


def test_health_returns_503_when_db_down(configure_base_callables) -> None:
    HealthHandler.is_db_healthy = staticmethod(lambda: False)
    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 503
    assert body["status"] == "degraded"
    assert body["checks"]["db"] is False


def test_health_returns_404_for_unknown_path(configure_base_callables) -> None:
    status, body = _run_request(path="/foo")
    assert status == 404


def test_health_includes_theta_block_when_configured(
    configure_base_callables,
) -> None:
    HealthHandler.theta_is_running = staticmethod(lambda: True)
    HealthHandler.theta_last_ready_at = staticmethod(lambda: 1776549000.0)
    HealthHandler.theta_last_error = staticmethod(lambda: None)

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert "theta" in body
    assert body["theta"] == {
        "running": True,
        "last_ready_at": 1776549000.0,
        "last_error": None,
    }


def test_health_theta_never_downgrades_overall_status(
    configure_base_callables,
) -> None:
    # Theta is additive — if Theta is dead but Databento + DB are fine,
    # overall status stays 'ok' / 200.
    HealthHandler.theta_is_running = staticmethod(lambda: False)
    HealthHandler.theta_last_ready_at = staticmethod(lambda: 0.0)
    HealthHandler.theta_last_error = staticmethod(
        lambda: "Theta HTTP server failed to come up"
    )

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["status"] == "ok"
    assert body["theta"]["running"] is False
    assert body["theta"]["last_ready_at"] is None  # 0.0 coerced to None
    assert body["theta"]["last_error"] == "Theta HTTP server failed to come up"


def test_health_handles_theta_reporter_exceptions(
    configure_base_callables,
) -> None:
    # If a Theta reporter raises (e.g. race during shutdown), handler
    # must still respond rather than 500. Last-ready → 0.0, last-error → None.
    def boom() -> float:
        raise RuntimeError("boom")

    HealthHandler.theta_is_running = staticmethod(lambda: True)
    HealthHandler.theta_last_ready_at = staticmethod(boom)
    HealthHandler.theta_last_error = staticmethod(boom)  # type: ignore[arg-type]

    with patch("health._is_data_expected", return_value=False):
        status, body = _run_request()

    assert status == 200
    assert body["theta"]["running"] is True
    assert body["theta"]["last_ready_at"] is None
    assert body["theta"]["last_error"] is None


# ---------------------------------------------------------------------------
# TBBO archive endpoints (Phase 4b)
# ---------------------------------------------------------------------------


def test_tbbo_day_microstructure_400_on_malformed_date(
    configure_base_callables,
) -> None:
    status, body = _run_request(
        path="/archive/tbbo-day-microstructure?date=bad&symbol=ES"
    )
    assert status == 400
    assert "YYYY-MM-DD" in body["error"]


def test_tbbo_day_microstructure_400_on_unknown_symbol(
    configure_base_callables,
) -> None:
    status, body = _run_request(
        path="/archive/tbbo-day-microstructure?date=2025-01-15&symbol=CL"
    )
    assert status == 400
    assert "ES" in body["error"]


def test_tbbo_day_microstructure_200_happy_path(
    configure_base_callables,
) -> None:
    sample = {
        "date": "2025-01-15",
        "symbol": "ES",
        "front_month_contract": "ESH5",
        "trade_count": 123,
        "ofi_5m_mean": 0.01,
        "ofi_15m_mean": 0.02,
        "ofi_1h_mean": 0.03,
    }
    with patch("archive_query.tbbo_day_microstructure", return_value=sample):
        status, body = _run_request(
            path="/archive/tbbo-day-microstructure?date=2025-01-15&symbol=ES"
        )
    assert status == 200
    assert body == sample


def test_tbbo_day_microstructure_404_on_missing_data(
    configure_base_callables,
) -> None:
    with patch(
        "archive_query.tbbo_day_microstructure",
        side_effect=ValueError("No TBBO ES bars found for 2099-01-01"),
    ):
        status, body = _run_request(
            path="/archive/tbbo-day-microstructure?date=2099-01-01&symbol=ES"
        )
    assert status == 404
    assert "No TBBO" in body["error"]


def test_tbbo_ofi_percentile_400_on_missing_value(
    configure_base_callables,
) -> None:
    status, _body = _run_request(
        path="/archive/tbbo-ofi-percentile?symbol=ES&window=1h"
    )
    assert status == 400


def test_tbbo_ofi_percentile_400_on_bad_window(
    configure_base_callables,
) -> None:
    status, _body = _run_request(
        path="/archive/tbbo-ofi-percentile?symbol=ES&value=0.1&window=1d"
    )
    assert status == 400


def test_tbbo_ofi_percentile_400_on_non_finite_value(
    configure_base_callables,
) -> None:
    status, _body = _run_request(
        path="/archive/tbbo-ofi-percentile?symbol=ES&value=nan&window=1h"
    )
    assert status == 400


def test_tbbo_ofi_percentile_200_happy_path(
    configure_base_callables,
) -> None:
    sample = {
        "symbol": "NQ",
        "window": "1h",
        "current_value": 0.38,
        "percentile": 92.1,
        "mean": 0.02,
        "std": 0.09,
        "count": 252,
    }
    with patch("archive_query.tbbo_ofi_percentile", return_value=sample):
        status, body = _run_request(
            path="/archive/tbbo-ofi-percentile?symbol=NQ&value=0.38&window=1h"
        )
    assert status == 200
    assert body == sample


def test_tbbo_ofi_percentile_404_on_missing_history(
    configure_base_callables,
) -> None:
    with patch(
        "archive_query.tbbo_ofi_percentile",
        side_effect=ValueError("No TBBO ES OFI history available for window 1h"),
    ):
        status, body = _run_request(
            path="/archive/tbbo-ofi-percentile?symbol=ES&value=0.1&window=1h"
        )
    assert status == 404
    assert "No TBBO" in body["error"]


def test_tbbo_ofi_percentile_400_on_horizon_days_over_cap(
    configure_base_callables,
) -> None:
    """Phase 4b rework: the HTTP handler caps ``horizon_days`` to
    protect the public unauthenticated endpoint from a full-archive
    scan request. Library-layer cap is defense-in-depth; this HTTP
    gate is the first line. Importing `archive_query` for the cap
    value keeps the test coupled to the code, not a magic number."""
    import archive_query

    over_cap = archive_query._TBBO_OFI_MAX_HORIZON_DAYS + 1
    status, body = _run_request(
        path=(
            "/archive/tbbo-ofi-percentile?symbol=ES&value=0.1"
            f"&window=1h&horizon_days={over_cap}"
        )
    )
    assert status == 400
    assert "horizon_days" in body["error"]


# ---------------------------------------------------------------------------
# SIDE-017 — /archive/day-summary and /archive/day-features short-circuit
# today/future dates to avoid memory-expensive DuckDB queries that are
# guaranteed to miss (archive only has past days' partitions)
# ---------------------------------------------------------------------------


class TestArchiveDateGuards:
    def _future_date(self) -> str:
        """Return a date string far in the future — always 'today or future'."""
        from datetime import datetime, timedelta, timezone

        return (datetime.now(timezone.utc).date() + timedelta(days=30)).isoformat()

    def _today_utc(self) -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).date().isoformat()

    def _past_date(self) -> str:
        """Return a date 45 days in the past — always a valid archive target."""
        from datetime import datetime, timedelta, timezone

        return (datetime.now(timezone.utc).date() - timedelta(days=45)).isoformat()

    def test_day_summary_short_circuits_today(self) -> None:
        """Today's date must 404 immediately without invoking DuckDB."""
        import health

        with patch.object(
            health, "_is_today_or_future_utc", wraps=health._is_today_or_future_utc
        ) as guard_spy:
            with patch("archive_query.day_summary_text") as mock_query:
                status, body = _run_request(
                    f"/archive/day-summary?date={self._today_utc()}"
                )

        assert status == 404
        assert body.get("error", "").startswith("date not yet in archive")
        # DuckDB query must not have been called
        mock_query.assert_not_called()
        # Guard must have fired
        guard_spy.assert_called()

    def test_day_summary_short_circuits_future(self) -> None:
        """Future dates must 404 immediately (no DuckDB)."""
        with patch("archive_query.day_summary_text") as mock_query:
            status, body = _run_request(
                f"/archive/day-summary?date={self._future_date()}"
            )
        assert status == 404
        assert body.get("error", "").startswith("date not yet in archive")
        mock_query.assert_not_called()

    def test_day_summary_past_date_hits_duckdb(self) -> None:
        """Past dates must still reach the DuckDB query path (normal flow)."""
        with patch(
            "archive_query.day_summary_text", return_value="sample summary"
        ) as mock_query:
            status, body = _run_request(
                f"/archive/day-summary?date={self._past_date()}"
            )
        assert status == 200
        assert body["summary"] == "sample summary"
        mock_query.assert_called_once()

    def test_day_features_short_circuits_today(self) -> None:
        """Today's date must 404 immediately for /archive/day-features too."""
        with patch("archive_query.day_features_vector") as mock_query:
            status, body = _run_request(
                f"/archive/day-features?date={self._today_utc()}"
            )
        assert status == 404
        assert body.get("error", "").startswith("date not yet in archive")
        mock_query.assert_not_called()

    def test_day_features_past_date_hits_duckdb(self) -> None:
        """Past dates still run the DuckDB feature-vector computation."""
        with patch(
            "archive_query.day_features_vector", return_value=[0.0] * 60
        ) as mock_query:
            status, body = _run_request(
                f"/archive/day-features?date={self._past_date()}"
            )
        assert status == 200
        assert body["dim"] == 60
        mock_query.assert_called_once()

    def test_malformed_date_still_400s_before_date_guard(self) -> None:
        """The malformed-format 400 must fire before the today-guard —
        a caller that sends garbage shouldn't be told 'not yet in archive.'"""
        with patch("archive_query.day_summary_text") as mock_query:
            status, body = _run_request("/archive/day-summary?date=not-a-date")
        assert status == 400
        assert body.get("error", "").startswith("date must be")
        mock_query.assert_not_called()


class TestIsTodayOrFutureUtc:
    """Pure helper — exercised independently from the HTTP layer."""

    def test_today_returns_true(self) -> None:
        from datetime import datetime, timezone
        import health

        today = datetime.now(timezone.utc).date().isoformat()
        assert health._is_today_or_future_utc(today) is True

    def test_future_returns_true(self) -> None:
        import health

        assert health._is_today_or_future_utc("2099-12-31") is True

    def test_past_returns_false(self) -> None:
        import health

        assert health._is_today_or_future_utc("2020-01-01") is False
