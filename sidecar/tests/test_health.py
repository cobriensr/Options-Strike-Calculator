"""Tests for health — the sidecar's /health HTTP endpoint.

Exercises the HealthHandler class directly rather than spinning up a
real HTTPServer. The handler's GET path writes status + headers + body
via `self.send_response` / `self.end_headers` / `self.wfile.write`,
which we intercept with a tiny fake wfile so we can assert JSON shape.
"""

from __future__ import annotations

import io
import json
import os
import sys
import types
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
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


class TestParseHelpers:
    """Phase 5a — parse helpers extracted from the per-handler boilerplate."""

    def test_parse_date_param_accepts_valid(self) -> None:
        import health

        qs = {"date": ["2025-01-15"]}
        assert health._parse_date_param(qs, "date") == "2025-01-15"

    def test_parse_date_param_rejects_garbage(self) -> None:
        import health

        with pytest.raises(health._BadRequest, match="date must be YYYY-MM-DD"):
            health._parse_date_param({"date": ["nope"]}, "date")

    def test_parse_date_param_rejects_missing(self) -> None:
        import health

        with pytest.raises(health._BadRequest, match="date must be YYYY-MM-DD"):
            health._parse_date_param({}, "date")

    def test_parse_optional_int_returns_none_when_absent(self) -> None:
        import health

        assert health._parse_optional_int({}, "k") is None

    def test_parse_optional_int_returns_value_when_present(self) -> None:
        import health

        assert health._parse_optional_int({"k": ["20"]}, "k") == 20

    def test_parse_optional_int_rejects_non_int(self) -> None:
        import health

        with pytest.raises(health._BadRequest, match="k must be an integer"):
            health._parse_optional_int({"k": ["abc"]}, "k")

    def test_parse_optional_int_rejects_below_lo(self) -> None:
        import health

        with pytest.raises(health._BadRequest, match=">= 1"):
            health._parse_optional_int({"horizon_days": ["0"]}, "horizon_days", lo=1)

    def test_parse_date_range_happy(self) -> None:
        import health

        qs = {"from": ["2024-01-01"], "to": ["2024-06-30"]}
        assert health._parse_date_range(qs) == ("2024-01-01", "2024-06-30")

    def test_parse_date_range_rejects_bad_format(self) -> None:
        import health

        qs = {"from": ["bad"], "to": ["2024-06-30"]}
        with pytest.raises(health._BadRequest, match="from/to must be YYYY-MM-DD"):
            health._parse_date_range(qs)

    def test_parse_date_range_rejects_calendar_invalid(self) -> None:
        """Cover lines 113-114 — regex passes but fromisoformat rejects.
        e.g. month 13 / day 45 satisfies \\d{4}-\\d{2}-\\d{2} but is not
        a real calendar date."""
        import health

        qs = {"from": ["2024-13-45"], "to": ["2024-12-31"]}
        with pytest.raises(health._BadRequest, match="invalid date"):
            health._parse_date_range(qs)

    def test_parse_date_range_rejects_inverted(self) -> None:
        import health

        qs = {"from": ["2024-06-30"], "to": ["2024-01-01"]}
        with pytest.raises(health._BadRequest, match="to must be >= from"):
            health._parse_date_range(qs)

    def test_parse_date_range_rejects_over_3_year_cap(self) -> None:
        """Locks the _BATCH_RANGE_MAX_DAYS named constant — anything
        past 3 years × 366 days is rejected."""
        import health

        # Pick a span deliberately past the cap.
        qs = {"from": ["2020-01-01"], "to": ["2024-01-01"]}
        with pytest.raises(health._BadRequest, match="cannot exceed 3 years"):
            health._parse_date_range(qs)

    def test_batch_range_max_days_is_3_years(self) -> None:
        """Lock the named constant against accidental drift."""
        import health

        assert health._BATCH_RANGE_MAX_DAYS == 366 * 3

    def test_aq_returns_archive_query_module(self) -> None:
        """Holder pattern: _aq() lazy-loads archive_query and returns the
        same module object on subsequent calls."""
        import health

        # Reset the module cache so we exercise the lazy path.
        health._archive_query_module = None
        first = health._aq()
        second = health._aq()
        import archive_query

        assert first is archive_query
        assert second is archive_query


# ---------------------------------------------------------------------------
# POST /admin/seed-archive — request driver
# ---------------------------------------------------------------------------


class _FakePostRequest:
    """Minimal POST request stub for /admin/seed-archive tests."""

    def __init__(
        self,
        path: str = "/admin/seed-archive",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.path = path
        header_lines = "Host: localhost\r\n"
        for k, v in (headers or {}).items():
            header_lines += f"{k}: {v}\r\n"
        self.raw = (
            f"POST {path} HTTP/1.1\r\n{header_lines}Content-Length: 0\r\n\r\n"
        ).encode()

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        if "r" in mode:
            return io.BytesIO(self.raw)
        return io.BytesIO()


def _run_post_request(
    path: str = "/admin/seed-archive",
    headers: dict[str, str] | None = None,
) -> tuple[int, dict]:
    """Drive HealthHandler for one POST request; return (status, body_obj)."""
    req = _FakePostRequest(path=path, headers=headers)
    output = io.BytesIO()

    # Match the same _H subclass pattern as _run_request — pylint S5720
    # warns about self_inner but it's the existing convention in this
    # file used to disambiguate from the outer `self` in test methods.
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
    status_line, *_ = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    _, _, body_text = raw.partition("\r\n\r\n")
    if not body_text:
        return status, {}
    try:
        return status, json.loads(body_text)
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


# ---------------------------------------------------------------------------
# POST /admin/seed-archive — full lifecycle
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_seed_handler_state() -> None:
    """Reset seeder callables + env between tests."""
    HealthHandler.seed_archive = None
    HealthHandler.seed_is_busy = None

    os.environ.pop("ARCHIVE_SEED_TOKEN", None)
    yield
    HealthHandler.seed_archive = None
    HealthHandler.seed_is_busy = None
    os.environ.pop("ARCHIVE_SEED_TOKEN", None)


class TestSeedArchivePost:
    def test_post_unknown_path_404(self) -> None:
        status, _body = _run_post_request(path="/some-other")
        assert status == 404

    def test_post_401_when_seed_archive_not_configured(self) -> None:
        """All admin-auth rejection paths return 401 with the same body so
        an external probe can't distinguish 'disabled' from 'wrong token'
        — that distinction was an enumeration oracle for the admin
        surface. Operators can still tell the two states apart via the
        ``seed endpoint not configured`` server-side log line.
        """
        status, body = _run_post_request()
        assert status == 401
        assert body["error"] == "unauthorized"

    def test_post_401_when_token_missing(self) -> None:
        HealthHandler.seed_archive = staticmethod(lambda: {"failed": 0})
        # No ARCHIVE_SEED_TOKEN set.
        status, body = _run_post_request(headers={"X-Admin-Token": "nope"})
        assert status == 401
        assert body["error"] == "unauthorized"

    def test_post_401_when_token_mismatched(self) -> None:

        HealthHandler.seed_archive = staticmethod(lambda: {"failed": 0})
        os.environ["ARCHIVE_SEED_TOKEN"] = "right"
        status, body = _run_post_request(headers={"X-Admin-Token": "wrong"})
        assert status == 401
        assert body["error"] == "unauthorized"

    def test_post_busy_returns_423(self) -> None:

        HealthHandler.seed_archive = staticmethod(lambda: {"failed": 0})
        HealthHandler.seed_is_busy = staticmethod(lambda: True)
        os.environ["ARCHIVE_SEED_TOKEN"] = "tok"
        status, body = _run_post_request(headers={"X-Admin-Token": "tok"})
        assert status == 423
        assert body["error"] == "seed already in progress"

    def test_post_success_returns_200(self) -> None:

        result_payload = {"failed": 0, "synced": 5}
        HealthHandler.seed_archive = staticmethod(lambda: result_payload)
        HealthHandler.seed_is_busy = staticmethod(lambda: False)
        os.environ["ARCHIVE_SEED_TOKEN"] = "tok"
        status, body = _run_post_request(headers={"X-Admin-Token": "tok"})
        assert status == 200
        assert body == result_payload

    def test_post_500_when_result_has_failures(self) -> None:

        HealthHandler.seed_archive = staticmethod(lambda: {"failed": 3, "synced": 1})
        os.environ["ARCHIVE_SEED_TOKEN"] = "tok"
        status, body = _run_post_request(headers={"X-Admin-Token": "tok"})
        assert status == 500
        assert body["failed"] == 3

    def test_post_seed_busy_error_returns_423(self) -> None:

        from archive_seeder import SeedBusyError

        def boom() -> dict:
            raise SeedBusyError("locked")

        HealthHandler.seed_archive = staticmethod(boom)
        os.environ["ARCHIVE_SEED_TOKEN"] = "tok"
        status, body = _run_post_request(headers={"X-Admin-Token": "tok"})
        assert status == 423
        assert body["error"] == "seed already in progress"

    def test_post_unknown_exception_returns_500(self) -> None:

        def boom() -> dict:
            raise RuntimeError("disk full")

        HealthHandler.seed_archive = staticmethod(boom)
        os.environ["ARCHIVE_SEED_TOKEN"] = "tok"
        status, body = _run_post_request(headers={"X-Admin-Token": "tok"})
        assert status == 500
        assert body["error"] == "disk full"


# ---------------------------------------------------------------------------
# /archive/es-range
# ---------------------------------------------------------------------------


class TestArchiveEsRange:
    def test_es_range_400_on_bad_date(self, configure_base_callables) -> None:
        status, body = _run_request("/archive/es-range?date=bad")
        assert status == 400
        assert "YYYY-MM-DD" in body["error"]

    def test_es_range_200_happy(self, configure_base_callables) -> None:
        with patch(
            "archive_query.es_day_summary",
            return_value={"date": "2024-01-15", "high": 4800.0},
        ):
            status, body = _run_request("/archive/es-range?date=2024-01-15")
        assert status == 200
        assert body["high"] == pytest.approx(4800.0)

    def test_es_range_404_on_value_error(self, configure_base_callables) -> None:
        with patch(
            "archive_query.es_day_summary",
            side_effect=ValueError("no data"),
        ):
            status, body = _run_request("/archive/es-range?date=2099-01-01")
        assert status == 404
        assert body["error"] == "no data"

    def test_es_range_500_on_unexpected_exception(
        self, configure_base_callables
    ) -> None:
        with patch(
            "archive_query.es_day_summary",
            side_effect=RuntimeError("duckdb crashed"),
        ):
            status, body = _run_request("/archive/es-range?date=2024-01-15")
        assert status == 500
        assert body["error"] == "query failed"


# ---------------------------------------------------------------------------
# /archive/analog-days
# ---------------------------------------------------------------------------


class TestArchiveAnalogDays:
    def test_analog_days_400_on_bad_date(self, configure_base_callables) -> None:
        status, body = _run_request("/archive/analog-days?date=bad")
        assert status == 400
        assert "YYYY-MM-DD" in body["error"]

    def test_analog_days_400_on_bad_optional_int(
        self, configure_base_callables
    ) -> None:
        status, body = _run_request("/archive/analog-days?date=2024-01-15&k=notanint")
        assert status == 400
        assert "k must be an integer" in body["error"]

    def test_analog_days_200_passes_kwargs(self, configure_base_callables) -> None:
        sample = {"neighbors": [{"date": "2023-05-01", "distance": 0.1}]}
        with patch("archive_query.analog_days", return_value=sample) as mock_q:
            status, body = _run_request(
                "/archive/analog-days?date=2024-01-15&until_minute=60&k=20"
            )
        assert status == 200
        assert body == sample
        mock_q.assert_called_once_with("2024-01-15", until_minute=60, k=20)

    def test_analog_days_400_on_value_error(self, configure_base_callables) -> None:
        with patch(
            "archive_query.analog_days",
            side_effect=ValueError("k must be 1..50"),
        ):
            status, body = _run_request("/archive/analog-days?date=2024-01-15&k=999")
        assert status == 400
        assert "k must be" in body["error"]

    def test_analog_days_500_on_unexpected_exception(
        self, configure_base_callables
    ) -> None:
        with patch("archive_query.analog_days", side_effect=RuntimeError("oops")):
            status, body = _run_request("/archive/analog-days?date=2024-01-15")
        assert status == 500
        assert body["error"] == "query failed"


# ---------------------------------------------------------------------------
# /archive/day-summary — exception path
# ---------------------------------------------------------------------------


class TestArchiveDaySummaryExceptions:
    def _past_date(self) -> str:
        from datetime import datetime, timedelta, timezone

        return (datetime.now(timezone.utc).date() - timedelta(days=45)).isoformat()

    def test_day_summary_404_on_value_error(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_summary_text",
            side_effect=ValueError("no rows for date"),
        ):
            status, body = _run_request(
                f"/archive/day-summary?date={self._past_date()}"
            )
        assert status == 404
        assert body["error"] == "no rows for date"

    def test_day_summary_500_on_unexpected(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_summary_text",
            side_effect=RuntimeError("boom"),
        ):
            status, body = _run_request(
                f"/archive/day-summary?date={self._past_date()}"
            )
        assert status == 500
        assert body["error"] == "query failed"

    def test_day_features_400_on_bad_date(self, configure_base_callables) -> None:
        """Cover the _BadRequest branch (lines 392-394) — bad date 400s
        before the today-or-future guard runs."""
        with patch("archive_query.day_features_vector") as mock_q:
            status, body = _run_request("/archive/day-features?date=nope")
        assert status == 400
        assert "YYYY-MM-DD" in body["error"]
        mock_q.assert_not_called()

    def test_day_features_404_on_value_error(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_features_vector",
            side_effect=ValueError("no rows"),
        ):
            status, body = _run_request(
                f"/archive/day-features?date={self._past_date()}"
            )
        assert status == 404
        assert body["error"] == "no rows"

    def test_day_features_500_on_unexpected(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_features_vector",
            side_effect=RuntimeError("boom"),
        ):
            status, body = _run_request(
                f"/archive/day-features?date={self._past_date()}"
            )
        assert status == 500
        assert body["error"] == "query failed"


# ---------------------------------------------------------------------------
# /archive/day-features-batch + /archive/day-summary-batch +
# /archive/day-summary-prediction-batch
# ---------------------------------------------------------------------------


class TestArchiveBatchHandlers:
    def test_features_batch_400_on_bad_range(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/day-features-batch?from=bad&to=2024-01-02"
        )
        assert status == 400
        assert "YYYY-MM-DD" in body["error"]

    def test_features_batch_200(self, configure_base_callables) -> None:
        rows = [{"date": "2024-01-01", "vector": [0.1] * 60}]
        with patch("archive_query.day_features_batch", return_value=rows) as mock_q:
            status, body = _run_request(
                "/archive/day-features-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 200
        assert body["from"] == "2024-01-01"
        assert body["to"] == "2024-01-02"
        assert body["rows"] == rows
        mock_q.assert_called_once_with("2024-01-01", "2024-01-02")

    def test_features_batch_500_on_exception(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_features_batch",
            side_effect=RuntimeError("boom"),
        ):
            status, body = _run_request(
                "/archive/day-features-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 500
        assert body["error"] == "query failed"

    def test_summary_batch_400_on_bad_range(self, configure_base_callables) -> None:
        status, _body = _run_request(
            "/archive/day-summary-batch?from=bad&to=2024-01-02"
        )
        assert status == 400

    def test_summary_batch_200(self, configure_base_callables) -> None:
        rows = [{"date": "2024-01-01", "summary": "x"}]
        with patch("archive_query.day_summary_batch", return_value=rows) as mock_q:
            status, body = _run_request(
                "/archive/day-summary-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 200
        assert body["rows"] == rows
        mock_q.assert_called_once_with("2024-01-01", "2024-01-02")

    def test_summary_batch_500_on_exception(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_summary_batch",
            side_effect=RuntimeError("boom"),
        ):
            status, _body = _run_request(
                "/archive/day-summary-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 500

    def test_summary_prediction_400_on_bad_date(self, configure_base_callables) -> None:
        status, body = _run_request("/archive/day-summary-prediction?date=nope")
        assert status == 400
        assert "YYYY-MM-DD" in body["error"]

    def test_summary_prediction_200(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_summary_prediction",
            return_value="leakage-free text",
        ):
            status, body = _run_request(
                "/archive/day-summary-prediction?date=2024-01-15"
            )
        assert status == 200
        assert body["date"] == "2024-01-15"
        assert body["summary"] == "leakage-free text"

    def test_summary_prediction_404_on_value_error(
        self, configure_base_callables
    ) -> None:
        with patch(
            "archive_query.day_summary_prediction",
            side_effect=ValueError("missing"),
        ):
            status, body = _run_request(
                "/archive/day-summary-prediction?date=2024-01-15"
            )
        assert status == 404
        assert body["error"] == "missing"

    def test_summary_prediction_500_on_unexpected(
        self, configure_base_callables
    ) -> None:
        with patch(
            "archive_query.day_summary_prediction",
            side_effect=RuntimeError("boom"),
        ):
            status, body = _run_request(
                "/archive/day-summary-prediction?date=2024-01-15"
            )
        assert status == 500
        assert body["error"] == "query failed"

    def test_summary_prediction_batch_400(self, configure_base_callables) -> None:
        status, _body = _run_request(
            "/archive/day-summary-prediction-batch?from=bad&to=2024-01-02"
        )
        assert status == 400

    def test_summary_prediction_batch_200(self, configure_base_callables) -> None:
        rows = [{"date": "2024-01-01", "summary": "x"}]
        with patch(
            "archive_query.day_summary_prediction_batch", return_value=rows
        ) as mock_q:
            status, body = _run_request(
                "/archive/day-summary-prediction-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 200
        assert body["rows"] == rows
        mock_q.assert_called_once_with("2024-01-01", "2024-01-02")

    def test_summary_prediction_batch_500(self, configure_base_callables) -> None:
        with patch(
            "archive_query.day_summary_prediction_batch",
            side_effect=RuntimeError("boom"),
        ):
            status, _body = _run_request(
                "/archive/day-summary-prediction-batch?from=2024-01-01&to=2024-01-02"
            )
        assert status == 500


# ---------------------------------------------------------------------------
# /archive/tbbo-day-microstructure exception path + 500 path
# ---------------------------------------------------------------------------


class TestTbboDayMicrostructureMore:
    def test_500_on_unexpected_exception(self, configure_base_callables) -> None:
        with patch(
            "archive_query.tbbo_day_microstructure",
            side_effect=RuntimeError("disk crashed"),
        ):
            status, body = _run_request(
                "/archive/tbbo-day-microstructure?date=2024-01-15&symbol=ES"
            )
        assert status == 500
        assert body["error"] == "query failed"


# ---------------------------------------------------------------------------
# /archive/tbbo-ofi-percentile — input branch coverage
# ---------------------------------------------------------------------------


class TestTbboOfiPercentileBranches:
    def test_400_on_bad_symbol(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/tbbo-ofi-percentile?symbol=CL&value=0.1&window=1h"
        )
        assert status == 400
        assert "ES" in body["error"]

    def test_400_on_bad_window(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/tbbo-ofi-percentile?symbol=ES&value=0.1&window=999"
        )
        assert status == 400
        assert "window" in body["error"]

    def test_400_on_value_unparseable(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/tbbo-ofi-percentile?symbol=ES&value=abc&window=1h"
        )
        assert status == 400
        assert "finite" in body["error"]

    def test_400_on_value_inf(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/tbbo-ofi-percentile?symbol=ES&value=inf&window=1h"
        )
        assert status == 400
        assert "finite" in body["error"]

    def test_400_on_horizon_below_lo(self, configure_base_callables) -> None:
        status, body = _run_request(
            "/archive/tbbo-ofi-percentile?symbol=ES&value=0.1&window=1h&horizon_days=0"
        )
        assert status == 400
        assert ">= 1" in body["error"]

    def test_500_on_unexpected_exception(self, configure_base_callables) -> None:
        with patch(
            "archive_query.tbbo_ofi_percentile",
            side_effect=RuntimeError("boom"),
        ):
            status, body = _run_request(
                "/archive/tbbo-ofi-percentile?symbol=ES&value=0.1&window=1h"
            )
        assert status == 500
        assert body["error"] == "query failed"

    def test_horizon_kwarg_passed_when_within_cap(
        self, configure_base_callables
    ) -> None:
        sample = {
            "symbol": "ES",
            "window": "1h",
            "current_value": 0.1,
            "percentile": 50.0,
            "mean": 0.0,
            "std": 0.1,
            "count": 100,
        }
        with patch("archive_query.tbbo_ofi_percentile", return_value=sample) as mock_q:
            status, body = _run_request(
                "/archive/tbbo-ofi-percentile?symbol=ES&value=0.1"
                "&window=1h&horizon_days=100"
            )
        assert status == 200
        assert body == sample
        # Confirm the horizon_days kwarg was forwarded.
        kwargs = mock_q.call_args.kwargs
        assert kwargs.get("horizon_days") == 100


# ---------------------------------------------------------------------------
# Health endpoint freshness branch + DB-exception swallow
# ---------------------------------------------------------------------------


class TestHealthFreshness:
    def test_data_fresh_true_when_recent(self, configure_base_callables) -> None:
        # last_bar_at returns "now" — staleness < 120s → fresh.
        import time

        HealthHandler.last_bar_at = staticmethod(lambda: time.time())
        with patch("health._is_data_expected", return_value=True):
            status, body = _run_request()
        assert status == 200
        assert body["checks"]["data_fresh"] is True

    def test_data_fresh_false_when_stale(self, configure_base_callables) -> None:
        # Bar was 5 minutes ago — staleness > 120s → degraded.
        import time

        HealthHandler.last_bar_at = staticmethod(lambda: time.time() - 600)
        with patch("health._is_data_expected", return_value=True):
            status, body = _run_request()
        assert status == 503
        assert body["checks"]["data_fresh"] is False
        assert body["status"] == "degraded"

    def test_db_exception_swallowed_to_false(self, configure_base_callables) -> None:
        def boom() -> bool:
            raise RuntimeError("conn refused")

        HealthHandler.is_db_healthy = staticmethod(boom)
        with patch("health._is_data_expected", return_value=False):
            status, body = _run_request()
        assert status == 503
        assert body["checks"]["db"] is False


# ---------------------------------------------------------------------------
# _build_theta_block — partial-config guards
# ---------------------------------------------------------------------------


class TestBuildThetaBlock:
    def test_returns_none_when_running_callable_unset(
        self, configure_base_callables
    ) -> None:
        # Default reset: theta_is_running is None → block omitted entirely.
        with patch("health._is_data_expected", return_value=False):
            _status, body = _run_request()
        assert "theta" not in body

    def test_handles_missing_optional_callables(self, configure_base_callables) -> None:
        # Only running is set; others remain None — block must still render
        # with last_ready_at=None and last_error=None.
        HealthHandler.theta_is_running = staticmethod(lambda: True)
        HealthHandler.theta_last_ready_at = None
        HealthHandler.theta_last_error = None
        with patch("health._is_data_expected", return_value=False):
            _status, body = _run_request()
        assert body["theta"] == {
            "running": True,
            "last_ready_at": None,
            "last_error": None,
        }


# ---------------------------------------------------------------------------
# Pure helpers — _now_ts, _is_data_expected
# ---------------------------------------------------------------------------


class TestNowTs:
    def test_returns_float(self) -> None:
        import health

        ts = health._now_ts()
        assert isinstance(ts, float)
        assert ts > 0


class TestIsDataExpected:
    """_is_data_expected branches by weekday + hour in CT."""

    def _patched_dt(self, weekday: int, hour: int):
        """Build a context manager that patches datetime.now to a fixed CT time."""
        from datetime import datetime
        from unittest.mock import patch as mpatch

        # Pick a Wednesday base date (2024-01-03 was a Wednesday).
        # Adjust by weekday delta. weekday(): Mon=0..Sun=6
        from datetime import timedelta

        wed = datetime(2024, 1, 3, hour, 0, 0)  # Wed (weekday=2)
        delta = weekday - 2
        target = wed + timedelta(days=delta)

        class _FakeDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                # Return a tz-aware datetime in the requested tz.
                if tz is None:
                    return target
                return target.replace(tzinfo=tz)

        return mpatch("health.datetime", _FakeDateTime)

    def test_saturday_returns_false(self) -> None:
        import health

        with self._patched_dt(weekday=5, hour=10):
            assert health._is_data_expected() is False

    def test_sunday_before_5pm_returns_false(self) -> None:
        import health

        with self._patched_dt(weekday=6, hour=10):
            assert health._is_data_expected() is False

    def test_sunday_after_5pm_returns_true(self) -> None:
        import health

        with self._patched_dt(weekday=6, hour=18):
            assert health._is_data_expected() is True

    def test_friday_after_4pm_returns_false(self) -> None:
        import health

        with self._patched_dt(weekday=4, hour=17):
            assert health._is_data_expected() is False

    def test_friday_morning_returns_true(self) -> None:
        import health

        with self._patched_dt(weekday=4, hour=10):
            assert health._is_data_expected() is True

    def test_maintenance_window_4pm_returns_false(self) -> None:
        import health

        # Tuesday 4 PM CT → maintenance window.
        with self._patched_dt(weekday=1, hour=16):
            assert health._is_data_expected() is False

    def test_normal_weekday_returns_true(self) -> None:
        import health

        with self._patched_dt(weekday=2, hour=10):
            assert health._is_data_expected() is True


# ---------------------------------------------------------------------------
# start_health_server — wiring smoke test
# ---------------------------------------------------------------------------


class TestStartHealthServer:
    def test_wires_class_callables_and_returns_server(self) -> None:
        import health

        connected = lambda: True  # noqa: E731
        last_bar = lambda: 0.0  # noqa: E731
        db_healthy = lambda: True  # noqa: E731

        # Patch ThreadingHTTPServer to avoid actually binding a port.
        from unittest.mock import MagicMock as _MagicMock

        fake_server = _MagicMock()
        with (
            patch("health._QuietThreadingHTTPServer") as fake_srv_cls,
            patch("health.threading.Thread") as fake_thread,
        ):
            fake_srv_cls.return_value = fake_server
            result = health.start_health_server(
                0,
                connected,
                last_bar,
                db_healthy,
            )
        assert result is fake_server
        fake_srv_cls.assert_called_once()
        fake_thread.assert_called_once()
        # Class-level callables must be installed.
        assert health.HealthHandler.is_connected() is True
        assert health.HealthHandler.last_bar_at() == pytest.approx(0.0)
        assert health.HealthHandler.is_db_healthy() is True
        # Theta defaults: server invoked without theta args → cleared.
        assert health.HealthHandler.theta_is_running is None
        assert health.HealthHandler.theta_last_ready_at is None
        assert health.HealthHandler.theta_last_error is None
        # Seed defaults: not configured → None.
        assert health.HealthHandler.seed_archive is None
        assert health.HealthHandler.seed_is_busy is None

    def test_wires_optional_theta_and_seed_callables(self) -> None:
        import health

        with (
            patch("health._QuietThreadingHTTPServer") as fake_srv_cls,
            patch("health.threading.Thread"),
        ):
            from unittest.mock import MagicMock as _MagicMock

            fake_srv_cls.return_value = _MagicMock()
            health.start_health_server(
                0,
                lambda: True,
                lambda: 0.0,
                lambda: True,
                theta_is_running=lambda: True,
                theta_last_ready_at=lambda: 1.0,
                theta_last_error=lambda: "err",
                seed_archive=lambda: {"failed": 0},
                seed_is_busy=lambda: False,
            )
        # All optional callables must be installed.
        assert health.HealthHandler.theta_is_running() is True
        assert health.HealthHandler.theta_last_ready_at() == pytest.approx(1.0)
        assert health.HealthHandler.theta_last_error() == "err"
        assert health.HealthHandler.seed_archive() == {"failed": 0}
        assert health.HealthHandler.seed_is_busy() is False

    def test_wires_theta_running_only_when_others_falsy(self) -> None:
        """When theta_is_running is set but the other reporters aren't,
        the staticmethod-wrap branch evaluates the falsy ternary path."""
        import health

        with (
            patch("health._QuietThreadingHTTPServer") as fake_srv_cls,
            patch("health.threading.Thread"),
        ):
            from unittest.mock import MagicMock as _MagicMock

            fake_srv_cls.return_value = _MagicMock()
            health.start_health_server(
                0,
                lambda: True,
                lambda: 0.0,
                lambda: True,
                theta_is_running=lambda: True,
                theta_last_ready_at=None,
                theta_last_error=None,
            )
        assert health.HealthHandler.theta_is_running() is True
        assert health.HealthHandler.theta_last_ready_at is None
        assert health.HealthHandler.theta_last_error is None


# ---------------------------------------------------------------------------
# _QuietThreadingHTTPServer — client-disconnect noise suppression
# ---------------------------------------------------------------------------


class TestQuietThreadingHTTPServer:
    """The subclass must swallow BrokenPipe / ConnectionReset only — every
    other exception class still goes through the default handle_error
    so real bugs are still loud.
    """

    def _make_server(self) -> Any:
        import health  # noqa: PLC0415

        # Allocate without __init__ — we don't want a real socket.
        return health._QuietThreadingHTTPServer.__new__(
            health._QuietThreadingHTTPServer
        )

    def test_swallows_broken_pipe(self) -> None:
        server = self._make_server()
        with patch.object(ThreadingHTTPServer, "handle_error") as super_handle_error:
            try:
                raise BrokenPipeError(32, "broken pipe")
            except BrokenPipeError:
                server.handle_error(object(), ("127.0.0.1", 0))
        super_handle_error.assert_not_called()

    def test_swallows_connection_reset(self) -> None:
        server = self._make_server()
        with patch.object(ThreadingHTTPServer, "handle_error") as super_handle_error:
            try:
                raise ConnectionResetError(104, "connection reset")
            except ConnectionResetError:
                server.handle_error(object(), ("127.0.0.1", 0))
        super_handle_error.assert_not_called()

    def test_propagates_unrelated_exceptions(self) -> None:
        server = self._make_server()
        with patch.object(ThreadingHTTPServer, "handle_error") as super_handle_error:
            try:
                raise ValueError("bad input")
            except ValueError:
                server.handle_error(object(), ("127.0.0.1", 0))
        super_handle_error.assert_called_once()


# ---------------------------------------------------------------------------
# POST body driver — supports an arbitrary body + Content-Length, and tracks
# whether the handler actually read from rfile (so the 413 over-cap path can
# assert "no body read"). Distinct from _FakePostRequest, which hardwires
# Content-Length: 0 for the seed-archive lifecycle tests.
# ---------------------------------------------------------------------------


class _TrackingRfile(io.BytesIO):
    """BytesIO that records whether read() was called."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_called = False

    def read(self, *args: object, **kwargs: object) -> bytes:
        self.read_called = True
        return super().read(*args, **kwargs)


def _run_post_with_body(
    path: str,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    declared_length: int | None = None,
) -> tuple[int, dict, bool]:
    """Drive HealthHandler for one POST; return (status, body_obj, read_called).

    ``declared_length`` overrides the Content-Length header independent of the
    actual body length — used to exercise the over-cap 413 path without
    allocating a giant body.
    """
    length = declared_length if declared_length is not None else len(body)
    header_lines = "Host: localhost\r\n"
    for k, v in (headers or {}).items():
        header_lines += f"{k}: {v}\r\n"
    request_head = (
        f"POST {path} HTTP/1.1\r\n{header_lines}Content-Length: {length}\r\n\r\n"
    ).encode()

    output = io.BytesIO()
    rfile = _TrackingRfile(body)

    # Parse the request line + headers from a head-only stream, then swap
    # rfile to the tracking body stream so we can assert read-or-not on the
    # body independently of header parsing.
    class _H(HealthHandler):
        def setup(self_inner) -> None:  # noqa: N805
            self_inner.rfile = io.BytesIO(request_head)
            self_inner.wfile = output

        def parse_request(self_inner) -> bool:  # noqa: N805
            ok = super().parse_request()
            self_inner.rfile = rfile
            return ok

        def finish(self_inner) -> None:  # noqa: N805
            pass

        def log_message(self_inner, *_a: object, **_kw: object) -> None:  # noqa: N805
            pass

    _H(object(), ("127.0.0.1", 0), None)  # type: ignore[arg-type]

    raw = output.getvalue().decode()
    status_line, *_ = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    _, _, body_text = raw.partition("\r\n\r\n")
    body_obj: dict
    if not body_text:
        body_obj = {}
    else:
        try:
            body_obj = json.loads(body_text)
        except json.JSONDecodeError:
            body_obj = {"_raw": body_text}
    return status, body_obj, rfile.read_called


# ---------------------------------------------------------------------------
# POST /takeit/multileg-classify — auth + body-size cap (Finding 3, CRITICAL)
# ---------------------------------------------------------------------------


@pytest.fixture
def _clear_takeit_secret() -> Any:
    saved = os.environ.pop("TAKEIT_SIDECAR_SHARED_SECRET", None)
    yield
    if saved is not None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = saved
    else:
        os.environ.pop("TAKEIT_SIDECAR_SHARED_SECRET", None)


class TestMultilegClassifyAuth:
    def test_503_when_secret_unset(self, _clear_takeit_secret) -> None:
        status, body, read_called = _run_post_with_body(
            "/takeit/multileg-classify", body=b'{"rows": []}'
        )
        assert status == 503
        assert body["error"] == "TAKEIT_SIDECAR_SHARED_SECRET not configured"
        assert read_called is False

    def test_401_when_auth_header_missing(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        status, body, read_called = _run_post_with_body(
            "/takeit/multileg-classify", body=b'{"rows": []}'
        )
        assert status == 401
        assert body["error"] == "unauthorized"
        assert read_called is False

    def test_401_when_bearer_wrong(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        status, body, read_called = _run_post_with_body(
            "/takeit/multileg-classify",
            body=b'{"rows": []}',
            headers={"Authorization": "Bearer wrong"},
        )
        assert status == 401
        assert body["error"] == "unauthorized"
        assert read_called is False

    def test_200_with_good_bearer(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        # Inject a fake multileg_routes so the heavy polars import is never
        # triggered; the handler does `import multileg_routes` after auth.
        fake = types.ModuleType("multileg_routes")
        fake.handle_classify_payload = lambda b: (200, {"results": []})  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"multileg_routes": fake}):
            status, body, read_called = _run_post_with_body(
                "/takeit/multileg-classify",
                body=b'{"rows": []}',
                headers={"Authorization": "Bearer s3cret"},
            )
        assert status == 200
        assert body == {"results": []}
        assert read_called is True

    def test_413_over_cap_does_not_read_body(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        # Declare a Content-Length above the 1 MiB default while sending a
        # tiny body — the handler must reject before reading.
        from health import MAX_BODY_BYTES

        status, body, read_called = _run_post_with_body(
            "/takeit/multileg-classify",
            body=b"{}",
            headers={"Authorization": "Bearer s3cret"},
            declared_length=MAX_BODY_BYTES + 1,
        )
        assert status == 413
        assert body["error"] == "payload too large"
        assert read_called is False

    def test_400_on_empty_body(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        status, body, read_called = _run_post_with_body(
            "/takeit/multileg-classify",
            body=b"",
            headers={"Authorization": "Bearer s3cret"},
            declared_length=0,
        )
        assert status == 400
        assert body["error"] == "empty body"
        assert read_called is False


# ---------------------------------------------------------------------------
# POST /takeit/explain — body-size cap (auth lives in takeit_server)
# ---------------------------------------------------------------------------


class TestTakeitExplainBodyCap:
    def test_413_over_cap_does_not_read_body(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        from health import MAX_BODY_BYTES

        # is_enabled() must return True to reach the cap check. Patch the
        # takeit_server module the handler lazily imports.
        fake = types.ModuleType("takeit_server")
        fake.is_enabled = lambda: True  # type: ignore[attr-defined]
        fake.handle_explain_payload = lambda b, a: (200, {"results": []})  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"takeit_server": fake}):
            status, body, read_called = _run_post_with_body(
                "/takeit/explain",
                body=b"{}",
                headers={"Authorization": "Bearer s3cret"},
                declared_length=MAX_BODY_BYTES + 1,
            )
        assert status == 413
        assert body["error"] == "payload too large"
        assert read_called is False

    def test_200_under_cap_reads_body(self, _clear_takeit_secret) -> None:
        os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = "s3cret"
        fake = types.ModuleType("takeit_server")
        fake.is_enabled = lambda: True  # type: ignore[attr-defined]
        fake.handle_explain_payload = lambda b, a: (200, {"results": []})  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"takeit_server": fake}):
            status, _body, read_called = _run_post_with_body(
                "/takeit/explain",
                body=b'{"alert_type": "lottery", "rows": []}',
                headers={"Authorization": "Bearer s3cret"},
            )
        assert status == 200
        assert read_called is True


# ---------------------------------------------------------------------------
# Archive 500s reach Sentry (MEDIUM finding)
# ---------------------------------------------------------------------------


class TestArchive500Sentry:
    def test_es_range_500_captures_to_sentry(self, configure_base_callables) -> None:
        with (
            patch(
                "archive_query.es_day_summary",
                side_effect=RuntimeError("duckdb crashed"),
            ),
            patch("sentry_setup.capture_exception") as cap,
        ):
            status, body = _run_request("/archive/es-range?date=2024-01-15")
        assert status == 500
        assert body["error"] == "query failed"
        cap.assert_called_once()
        # Route tag carries the endpoint name for Sentry filtering.
        _args, kwargs = cap.call_args
        assert kwargs["tags"]["route"] == "es-range"
        assert kwargs["tags"]["component"] == "archive"

    def test_tbbo_microstructure_500_captures_to_sentry(
        self, configure_base_callables
    ) -> None:
        with (
            patch(
                "archive_query.tbbo_day_microstructure",
                side_effect=RuntimeError("boom"),
            ),
            patch("sentry_setup.capture_exception") as cap,
        ):
            status, body = _run_request(
                "/archive/tbbo-day-microstructure?date=2024-01-15&symbol=ES"
            )
        assert status == 500
        assert body["error"] == "query failed"
        cap.assert_called_once()
        _args, kwargs = cap.call_args
        assert kwargs["tags"]["route"] == "tbbo-day-microstructure"
        assert kwargs["tags"]["symbol"] == "ES"
