"""Tests for the /theta/index/* GET routes wired into HealthHandler.

Mirrors test_takeit_routes.py's pattern of driving HealthHandler
directly via a fake request socket. The ThetaClient itself is patched
(`theta_client.ThetaClient`) so no Terminal or network is required —
these tests pin the route contract: bearer auth (same secret as the
/takeit routes), root allowlist, interactive client construction
(timeout_s=5, max_retries=1), response shapes, and the 472→502 /
Theta-down→503 error mapping.
"""

from __future__ import annotations

import io
import json
import os
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from health import HealthHandler
from theta_client import (
    IndexOhlcCandle,
    IndexPriceSnapshot,
    ThetaClientError,
    ThetaSubscriptionError,
)

_SECRET = "test-theta-secret"
_AUTH = {"Authorization": f"Bearer {_SECRET}"}


class _FakeGetRequest:
    """Minimal GET request stub with header support."""

    def __init__(self, path: str, headers: dict[str, str] | None = None) -> None:
        self.path = path
        header_lines = "Host: localhost\r\n"
        for k, v in (headers or {}).items():
            header_lines += f"{k}: {v}\r\n"
        self.raw = (f"GET {path} HTTP/1.1\r\n{header_lines}\r\n").encode()

    def makefile(self, mode: str, *_args: object) -> io.BytesIO:
        return io.BytesIO(self.raw) if "r" in mode else io.BytesIO()


def _drive(path: str, headers: dict[str, str] | None = None) -> tuple[int, dict]:
    """Drive HealthHandler for one GET request; return (status, body_obj)."""
    req = _FakeGetRequest(path=path, headers=headers)
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
    status_line, *_ = raw.split("\r\n", 1)
    status = int(status_line.split()[1])
    _, _, body_text = raw.partition("\r\n\r\n")
    try:
        return status, json.loads(body_text) if body_text else {}
    except json.JSONDecodeError:
        return status, {"_raw": body_text}


@pytest.fixture(autouse=True)
def shared_secret_env() -> None:
    """Provide the bearer secret by default; tests that need it unset pop it."""
    os.environ["TAKEIT_SIDECAR_SHARED_SECRET"] = _SECRET
    yield
    os.environ.pop("TAKEIT_SIDECAR_SHARED_SECRET", None)


def _snapshot(
    price: str = "6423.53",
    snapshot_date: date = date(2026, 8, 14),  # a Friday
    ts_ms: int = 1786462200000,
) -> IndexPriceSnapshot:
    return IndexPriceSnapshot(
        root="SPX",
        price=Decimal(price),
        snapshot_date=snapshot_date,
        ts_ms=ts_ms,
    )


def _candle(
    close: str = "6390.00",
    ts_ms: int = 1786455000000,
) -> IndexOhlcCandle:
    return IndexOhlcCandle(
        ts_ms=ts_ms,
        open=Decimal("6388.00"),
        high=Decimal("6391.50"),
        low=Decimal("6387.25"),
        close=Decimal(close),
    )


def _mock_client(
    snapshot: object = None,
    candles: object = (),
) -> MagicMock:
    client = MagicMock()
    if isinstance(snapshot, Exception):
        client.snapshot_index_price.side_effect = snapshot
    else:
        client.snapshot_index_price.return_value = snapshot
    if isinstance(candles, Exception):
        client.hist_index_ohlc.side_effect = candles
    else:
        client.hist_index_ohlc.return_value = list(candles)
    return client


# ── Auth (same bearer pattern as the /takeit routes) ───────────────────


@pytest.mark.parametrize(
    "path",
    [
        "/theta/index/price?root=SPX",
        "/theta/index/history?root=SPX&date=2026-08-14",
    ],
)
def test_503_when_shared_secret_unset(path: str) -> None:
    os.environ.pop("TAKEIT_SIDECAR_SHARED_SECRET", None)
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive(path, headers=_AUTH)
    assert status == 503
    assert "TAKEIT_SIDECAR_SHARED_SECRET" in body["error"]
    mock_cls.assert_not_called()


@pytest.mark.parametrize(
    "path",
    [
        "/theta/index/price?root=SPX",
        "/theta/index/history?root=SPX&date=2026-08-14",
    ],
)
def test_401_on_bearer_mismatch(path: str) -> None:
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive(path, headers={"Authorization": "Bearer wrong"})
    assert status == 401
    assert body["error"] == "unauthorized"
    mock_cls.assert_not_called()


def test_401_when_authorization_header_missing() -> None:
    with patch("theta_client.ThetaClient"):
        status, body = _drive("/theta/index/price?root=SPX")
    assert status == 401
    assert body["error"] == "unauthorized"


# ── Root allowlist ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path",
    [
        "/theta/index/price?root=TICK",
        "/theta/index/price",
        "/theta/index/history?root=ES&date=2026-08-14",
    ],
)
def test_400_on_unknown_root(path: str) -> None:
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive(path, headers=_AUTH)
    assert status == 400
    assert "root" in body["error"]
    mock_cls.assert_not_called()


@pytest.mark.parametrize("root", ["SPX", "VIX", "VIX1D", "VIX9D", "VVIX"])
def test_all_allowlisted_roots_accepted(root: str) -> None:
    client = _mock_client(snapshot=_snapshot(), candles=[_candle()])
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive(f"/theta/index/price?root={root}", headers=_AUTH)
    assert status == 200
    assert body["root"] == root


# ── GET /theta/index/price ─────────────────────────────────────────────


def test_price_happy_path_shape() -> None:
    client = _mock_client(snapshot=_snapshot(), candles=[_candle()])
    with patch("theta_client.ThetaClient", return_value=client) as mock_cls:
        status, body = _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert status == 200
    assert body == {
        "root": "SPX",
        "price": 6423.53,
        "prev_close": 6390.0,
        "ts": 1786462200000,
    }
    # Interactive routes construct a fast-fail client — the fetcher's
    # defaults (15s x 3 retries) would exceed Railway's edge timeout.
    mock_cls.assert_called_once_with(timeout_s=5, max_retries=1)


def test_price_prev_close_uses_previous_weekday() -> None:
    # Snapshot on Friday 2026-08-14 → prev trading day Thursday 08-13.
    client = _mock_client(snapshot=_snapshot(), candles=[_candle()])
    with patch("theta_client.ThetaClient", return_value=client):
        _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert client.hist_index_ohlc.call_args[0][:2] == ("SPX", date(2026, 8, 13))


def test_price_prev_close_skips_weekend() -> None:
    # Snapshot on Monday 2026-08-17 → prev trading day Friday 08-14.
    client = _mock_client(
        snapshot=_snapshot(snapshot_date=date(2026, 8, 17)),
        candles=[_candle()],
    )
    with patch("theta_client.ThetaClient", return_value=client):
        _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert client.hist_index_ohlc.call_args[0][:2] == ("SPX", date(2026, 8, 14))


def test_price_prev_close_takes_last_candle_close() -> None:
    candles = [_candle(close="6390.00"), _candle(close="6402.75")]
    client = _mock_client(snapshot=_snapshot(), candles=candles)
    with patch("theta_client.ThetaClient", return_value=client):
        _status, body = _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert body["prev_close"] == 6402.75


def test_price_prev_close_null_when_hist_empty() -> None:
    # Holiday on the previous weekday → no candles → null, not an error.
    client = _mock_client(snapshot=_snapshot(), candles=[])
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert status == 200
    assert body["prev_close"] is None
    assert body["price"] == 6423.53


def test_price_prev_close_null_when_hist_errors() -> None:
    # prev_close is best-effort: a hist failure must not sink the price.
    client = _mock_client(snapshot=_snapshot(), candles=ThetaClientError("terminal hiccup"))
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert status == 200
    assert body["prev_close"] is None


def test_price_404_when_no_snapshot() -> None:
    client = _mock_client(snapshot=None)
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/price?root=VIX1D", headers=_AUTH)
    assert status == 404
    assert body["error"] == "no_data"


def test_price_502_when_not_entitled() -> None:
    # Theta 472 → structured 502, not a raw traceback.
    client = _mock_client(snapshot=ThetaSubscriptionError("HTTP 472"))
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/price?root=VVIX", headers=_AUTH)
    assert status == 502
    assert body == {"error": "theta_not_entitled", "root": "VVIX"}


def test_price_503_when_theta_down() -> None:
    # Launcher not running → connection refused → ThetaClientError → 503.
    client = _mock_client(snapshot=ThetaClientError("network failure"))
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/price?root=SPX", headers=_AUTH)
    assert status == 503
    assert body["error"] == "theta_unavailable"


# ── GET /theta/index/history ───────────────────────────────────────────


def test_history_happy_path_shape() -> None:
    candles = [
        IndexOhlcCandle(
            ts_ms=1786455000000,
            open=Decimal("6388.00"),
            high=Decimal("6391.50"),
            low=Decimal("6387.25"),
            close=Decimal("6390.00"),
        ),
        IndexOhlcCandle(
            ts_ms=1786455300000,
            open=Decimal("6390.00"),
            high=Decimal("6394.10"),
            low=Decimal("6389.80"),
            close=Decimal("6393.55"),
        ),
    ]
    client = _mock_client(candles=candles)
    with patch("theta_client.ThetaClient", return_value=client) as mock_cls:
        status, body = _drive(
            "/theta/index/history?root=SPX&date=2026-08-14&ivl_ms=300000",
            headers=_AUTH,
        )
    assert status == 200
    assert body == {
        "root": "SPX",
        "date": "2026-08-14",
        "ivl_ms": 300000,
        "candles": [
            {
                "ts_ms": 1786455000000,
                "open": 6388.0,
                "high": 6391.5,
                "low": 6387.25,
                "close": 6390.0,
            },
            {
                "ts_ms": 1786455300000,
                "open": 6390.0,
                "high": 6394.1,
                "low": 6389.8,
                "close": 6393.55,
            },
        ],
    }
    # Candles carry no volume — indices don't trade.
    assert "volume" not in body["candles"][0]
    mock_cls.assert_called_once_with(timeout_s=5, max_retries=1)
    client.hist_index_ohlc.assert_called_once_with("SPX", date(2026, 8, 14), ivl_ms=300000)


def test_history_defaults_to_one_minute_ivl() -> None:
    client = _mock_client(candles=[_candle()])
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/history?root=VIX&date=2026-08-14", headers=_AUTH)
    assert status == 200
    assert body["ivl_ms"] == 60000
    client.hist_index_ohlc.assert_called_once_with("VIX", date(2026, 8, 14), ivl_ms=60000)


def test_history_400_on_malformed_date() -> None:
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive("/theta/index/history?root=SPX&date=20260814", headers=_AUTH)
    assert status == 400
    assert "YYYY-MM-DD" in body["error"]
    mock_cls.assert_not_called()


def test_history_400_on_calendar_invalid_date() -> None:
    # Passes the shape regex but is not a real date.
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive("/theta/index/history?root=SPX&date=2026-13-99", headers=_AUTH)
    assert status == 400
    assert body["error"] == "invalid date"
    mock_cls.assert_not_called()


def test_history_400_on_bad_ivl_ms() -> None:
    with patch("theta_client.ThetaClient") as mock_cls:
        status, body = _drive(
            "/theta/index/history?root=SPX&date=2026-08-14&ivl_ms=abc",
            headers=_AUTH,
        )
    assert status == 400
    assert "ivl_ms" in body["error"]
    mock_cls.assert_not_called()


def test_history_404_when_no_candles() -> None:
    client = _mock_client(candles=[])
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/history?root=VIX9D&date=2026-08-14", headers=_AUTH)
    assert status == 404
    assert body["error"] == "no_data"


def test_history_502_when_not_entitled() -> None:
    client = _mock_client(candles=ThetaSubscriptionError("HTTP 472"))
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/history?root=SPX&date=2026-08-14", headers=_AUTH)
    assert status == 502
    assert body == {"error": "theta_not_entitled", "root": "SPX"}


def test_history_503_when_theta_down() -> None:
    client = _mock_client(candles=ThetaClientError("network failure"))
    with patch("theta_client.ThetaClient", return_value=client):
        status, body = _drive("/theta/index/history?root=SPX&date=2026-08-14", headers=_AUTH)
    assert status == 503
    assert body["error"] == "theta_unavailable"
