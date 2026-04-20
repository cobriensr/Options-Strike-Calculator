"""Tests for theta_client — the v2 HTTP wrapper.

We mock urlopen at the theta_client module level so no real Theta
Terminal or network is required. Every test exercises the shape of
Theta's responses we verified empirically against the live jar earlier
(list_expirations, list_strikes, hist_option_eod single-contract,
no-data plain-text fallback, subscription denials).
"""

from __future__ import annotations

import io
import json
from datetime import date
from decimal import Decimal
from unittest.mock import patch
from urllib.error import HTTPError

import pytest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from theta_client import (  # noqa: E402
    EodRow,
    ThetaClient,
    ThetaClientError,
    ThetaSubscriptionError,
    _parse_body,
    _strike_dollars_to_wire,
    _strike_wire_to_dollars,
)


def _http_response(body: dict | str | bytes, status: int = 200) -> object:
    """Build a context-managed fake response for urlopen."""

    if isinstance(body, dict):
        payload = json.dumps(body).encode("utf-8")
    elif isinstance(body, str):
        payload = body.encode("utf-8")
    else:
        payload = body

    class _Resp(io.BytesIO):
        status = 200

        def __enter__(self) -> "_Resp":  # noqa: D401
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

    resp = _Resp(payload)
    resp.status = status
    return resp


# ---------------------------------------------------------------------------
# Helper conversions (pure functions — no HTTP)
# ---------------------------------------------------------------------------


def test_strike_wire_to_dollars_round_trip() -> None:
    # Theta wire stores $5100.00 as 5100000 (integer thousandths).
    assert _strike_wire_to_dollars(5100000) == Decimal("5100.00")
    assert _strike_wire_to_dollars(50) == Decimal("0.05")
    # Round-trip preserves value for well-formed strikes.
    assert _strike_dollars_to_wire(Decimal("5100.00")) == 5100000
    assert _strike_dollars_to_wire(Decimal("0.05")) == 50


def test_parse_body_no_data_plain_text() -> None:
    # Theta returns this bare string (no JSON) when a contract had no trades
    # for the requested date range. Client should coerce to empty payload.
    body = _parse_body(b":No data for the specified timeframe & contract.")
    assert body == {"header": {"format": []}, "response": []}


def test_parse_body_empty_body() -> None:
    assert _parse_body(b"") == {"header": {"format": []}, "response": []}


def test_parse_body_malformed_json_raises() -> None:
    with pytest.raises(ThetaClientError):
        _parse_body(b"{not json")


# ---------------------------------------------------------------------------
# list_expirations
# ---------------------------------------------------------------------------


def test_list_expirations_parses_and_sorts() -> None:
    payload = {
        "header": {"format": ["date"]},
        "response": [20260421, 20260422, 20260418],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        out = client.list_expirations("SPXW")
    assert out == [date(2026, 4, 18), date(2026, 4, 21), date(2026, 4, 22)]


def test_list_expirations_empty() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response({"header": {}, "response": []}),
    ):
        client = ThetaClient()
        assert client.list_expirations("DOESNOTEXIST") == []


# ---------------------------------------------------------------------------
# list_strikes
# ---------------------------------------------------------------------------


def test_list_strikes_converts_thousandths_to_dollars() -> None:
    payload = {
        "header": {"format": ["strike"]},
        "response": [5000000, 5100000, 5200000],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        out = client.list_strikes("SPXW", date(2026, 4, 18))
    assert out == [Decimal("5000.00"), Decimal("5100.00"), Decimal("5200.00")]


# ---------------------------------------------------------------------------
# fetch_eod
# ---------------------------------------------------------------------------


_REAL_EOD_PAYLOAD = {
    "header": {
        "latency_ms": 66,
        "next_page": "null",
        "format": [
            "ms_of_day",
            "ms_of_day2",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "count",
            "bid_size",
            "bid_exchange",
            "bid",
            "bid_condition",
            "ask_size",
            "ask_exchange",
            "ask",
            "ask_condition",
            "date",
        ],
    },
    "response": [
        [
            62126312,
            55682078,
            77.80,
            82.30,
            66.00,
            66.00,
            1576,
            30,
            1,
            5,
            69.90,
            50,
            1,
            5,
            79.90,
            50,
            20240313,
        ],
        [
            62352209,
            57455017,
            74.00,
            90.05,
            31.56,
            51.38,
            3655,
            107,
            20,
            5,
            51.20,
            50,
            20,
            5,
            59.60,
            50,
            20240314,
        ],
    ],
}


def test_fetch_eod_parses_rows_into_eod_row_objects() -> None:
    with patch("theta_client.urlopen", return_value=_http_response(_REAL_EOD_PAYLOAD)):
        client = ThetaClient()
        rows = client.fetch_eod(
            root="SPX",
            expiration=date(2024, 3, 15),
            strike=Decimal("5100.00"),
            option_type="C",
            start_date=date(2024, 3, 13),
            end_date=date(2024, 3, 15),
        )

    assert len(rows) == 2
    first = rows[0]
    assert isinstance(first, EodRow)
    assert first.symbol == "SPX"
    assert first.expiration == date(2024, 3, 15)
    assert first.strike == Decimal("5100.00")
    assert first.option_type == "C"
    assert first.trade_date == date(2024, 3, 13)
    assert first.open == Decimal("77.80")
    assert first.close == Decimal("66.00")
    assert first.volume == 1576
    assert first.trade_count == 30
    assert first.bid == Decimal("69.90")
    assert first.ask == Decimal("79.90")
    assert first.bid_size == 1
    assert first.ask_size == 1

    second = rows[1]
    assert second.trade_date == date(2024, 3, 14)
    assert second.close == Decimal("51.38")
    assert second.volume == 3655


def test_fetch_eod_no_data_returns_empty_list() -> None:
    # Plain-text "No data" body — returns [] without raising.
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(":No data for the specified timeframe & contract."),
    ):
        client = ThetaClient()
        out = client.fetch_eod(
            root="SPX",
            expiration=date(2024, 3, 15),
            strike=Decimal("5100.00"),
            option_type="C",
            start_date=date(2024, 3, 15),
            end_date=date(2024, 3, 15),
        )
    assert out == []


def test_fetch_eod_subscription_denial_raises_typed_error() -> None:
    # HTTP 472 = Theta entitlement denial. Distinct exception so the
    # fetcher can skip that root without halting the whole nightly.
    err = HTTPError(
        url="http://127.0.0.1:25503/v2/hist/option/eod",
        code=472,
        msg="Not entitled",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    with patch("theta_client.urlopen", side_effect=err):
        client = ThetaClient(max_retries=1)
        with pytest.raises(ThetaSubscriptionError):
            client.fetch_eod(
                root="SPX",
                expiration=date(2024, 3, 15),
                strike=Decimal("5100.00"),
                option_type="C",
                start_date=date(2024, 3, 15),
                end_date=date(2024, 3, 15),
            )


def test_fetch_eod_5xx_retries_then_fails() -> None:
    err = HTTPError(
        url="http://127.0.0.1:25503/v2/hist/option/eod",
        code=503,
        msg="Service Unavailable",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    with patch("theta_client.urlopen", side_effect=err) as mock_urlopen:
        client = ThetaClient(max_retries=2)
        with pytest.raises(ThetaClientError):
            client.fetch_eod(
                root="SPX",
                expiration=date(2024, 3, 15),
                strike=Decimal("5100.00"),
                option_type="C",
                start_date=date(2024, 3, 15),
                end_date=date(2024, 3, 15),
            )
    # Called max_retries times.
    assert mock_urlopen.call_count == 2


# ---------------------------------------------------------------------------
# Option-type normalization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "option_type,expected",
    [("C", "C"), ("c", "C"), ("CALL", "C"), ("Call", "C"), ("P", "P"), ("put", "P")],
)
def test_option_type_normalization_in_fetch_eod(
    option_type: str, expected: str
) -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response({"header": {}, "response": []}),
    ):
        client = ThetaClient()
        # Empty response — we're only checking that no exception was raised
        # during the normalization path, and that the output shape is clean.
        out = client.fetch_eod(
            root="SPX",
            expiration=date(2024, 3, 15),
            strike=Decimal("5100.00"),
            option_type=option_type,
            start_date=date(2024, 3, 15),
            end_date=date(2024, 3, 15),
        )
    assert out == []
    # Also assert the _normalize_right helper returned what we expected
    # by exercising the row-to-EodRow path with one synthetic row.
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(
            {
                "header": {"format": ["close", "date"]},
                "response": [[1.23, 20240315]],
            }
        ),
    ):
        client = ThetaClient()
        rows = client.fetch_eod(
            root="SPX",
            expiration=date(2024, 3, 15),
            strike=Decimal("5100.00"),
            option_type=option_type,
            start_date=date(2024, 3, 15),
            end_date=date(2024, 3, 15),
        )
    assert len(rows) == 1
    assert rows[0].option_type == expected


def test_option_type_unknown_raises() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response({"header": {}, "response": []}),
    ):
        client = ThetaClient()
        with pytest.raises(ValueError):
            client.fetch_eod(
                root="SPX",
                expiration=date(2024, 3, 15),
                strike=Decimal("5100.00"),
                option_type="XYZ",
                start_date=date(2024, 3, 15),
                end_date=date(2024, 3, 15),
            )
