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
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from theta_client import (
    DEFAULT_BASE_URL,
    EodRow,
    IndexOhlcCandle,
    IndexPriceSnapshot,
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

        def __enter__(self) -> _Resp:
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

    resp = _Resp(payload)
    resp.status = status
    return resp


# ---------------------------------------------------------------------------
# Module constants — base URL pin
# ---------------------------------------------------------------------------


def test_default_base_url_points_at_port_25510() -> None:
    """Pin the Terminal HTTP port verified empirically against the live jar.

    Theta Terminal v1.8.6 Rev A (ThetaTerminalv3.jar) binds HTTP on
    :25510 (and WS on :25520); :25503 is NEVER bound (connection
    refused). A base URL on 25503 would make every fetch fail.
    """
    assert DEFAULT_BASE_URL == "http://127.0.0.1:25510"


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


def test_list_expirations_472_no_data_returns_empty_list() -> None:
    # HTTP 472 = NO_DATA per the official Theta error-code docs, NOT an
    # entitlement denial. A 472 on the listing endpoint must read as an
    # empty listing — not kill the root as "not entitled".
    with patch("theta_client.urlopen", side_effect=_http_error(472, "No data")):
        client = ThetaClient(max_retries=3)
        assert client.list_expirations("SPXW") == []


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
    # HTTP 471 = PERMISSION — a real Theta entitlement denial. Distinct
    # exception so the fetcher can skip that root without halting the
    # whole nightly.
    err = HTTPError(
        url="http://127.0.0.1:25510/v2/hist/option/eod",
        code=471,
        msg="Permission denied",
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
        url="http://127.0.0.1:25510/v2/hist/option/eod",
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


def _http_error(code: int, msg: str) -> HTTPError:
    return HTTPError(
        url="http://127.0.0.1:25510/v2/hist/option/eod",
        code=code,
        msg=msg,
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )


def _fetch_eod_single_close(client: ThetaClient) -> list[EodRow]:
    return client.fetch_eod(
        root="SPX",
        expiration=date(2024, 3, 15),
        strike=Decimal("5100.00"),
        option_type="C",
        start_date=date(2024, 3, 15),
        end_date=date(2024, 3, 15),
    )


# ---------------------------------------------------------------------------
# FINDING D — throttle codes 429/476 are retried on the 5xx backoff path
# ---------------------------------------------------------------------------


def test_fetch_eod_476_then_200_succeeds_after_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 476 = Theta MDDS transient disconnect — retry, don't hard-fail.
    monkeypatch.setattr("theta_client.time.sleep", lambda _s: None)
    ok = {
        "header": {"format": ["close", "date"]},
        "response": [[1.23, 20240315]],
    }
    side_effects = [_http_error(476, "MDDS disconnect"), _http_response(ok)]
    with patch("theta_client.urlopen", side_effect=side_effects):
        client = ThetaClient(max_retries=3)
        rows = _fetch_eod_single_close(client)
    assert len(rows) == 1
    assert rows[0].close == Decimal("1.23")


def test_fetch_eod_429_then_200_succeeds_after_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 429 = rate limit — retry, don't hard-fail.
    monkeypatch.setattr("theta_client.time.sleep", lambda _s: None)
    ok = {
        "header": {"format": ["close", "date"]},
        "response": [[4.56, 20240315]],
    }
    side_effects = [_http_error(429, "Too Many Requests"), _http_response(ok)]
    with patch("theta_client.urlopen", side_effect=side_effects):
        client = ThetaClient(max_retries=3)
        rows = _fetch_eod_single_close(client)
    assert len(rows) == 1
    assert rows[0].close == Decimal("4.56")


def test_fetch_eod_persistent_476_fails_after_max_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("theta_client.time.sleep", lambda _s: None)
    with patch(
        "theta_client.urlopen", side_effect=_http_error(476, "MDDS disconnect")
    ) as mock_urlopen:
        client = ThetaClient(max_retries=2)
        with pytest.raises(ThetaClientError):
            _fetch_eod_single_close(client)
    # 476 is retryable -> exhausts all attempts before raising.
    assert mock_urlopen.call_count == 2


def test_fetch_eod_472_no_data_returns_empty_list_immediately() -> None:
    # HTTP 472 = NO_DATA ("no data found for the specified request") —
    # must behave exactly like the plain-text ":No data" body: return []
    # with no exception and no retries. Production repro: SPXW backfill
    # died instantly because 472 was misread as an entitlement denial.
    with patch("theta_client.urlopen", side_effect=_http_error(472, "No data")) as mock_urlopen:
        client = ThetaClient(max_retries=3)
        out = _fetch_eod_single_close(client)
    assert out == []
    # Answered on the first try — no-data is not retryable.
    assert mock_urlopen.call_count == 1


def test_fetch_eod_471_denial_raises_immediately_no_retry() -> None:
    # 471 must NOT be swept into the retry set — it's an immediate denial.
    with patch(
        "theta_client.urlopen", side_effect=_http_error(471, "Permission denied")
    ) as mock_urlopen:
        client = ThetaClient(max_retries=3)
        with pytest.raises(ThetaSubscriptionError):
            _fetch_eod_single_close(client)
    # Raised on the first try — no retries.
    assert mock_urlopen.call_count == 1


# ---------------------------------------------------------------------------
# FINDING C — row/format length mismatch fails loudly (no silent truncation)
# ---------------------------------------------------------------------------


def test_fetch_eod_row_longer_than_format_raises() -> None:
    # Row has an extra trailing column the format doesn't name.
    payload = {
        "header": {"format": ["close", "date"]},
        "response": [[1.23, 20240315, 999]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        with pytest.raises(ThetaClientError, match="length mismatch"):
            _fetch_eod_single_close(client)


def test_fetch_eod_row_shorter_than_format_raises() -> None:
    # Format names a column the row doesn't supply.
    payload = {
        "header": {"format": ["close", "volume", "date"]},
        "response": [[1.23, 20240315]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        with pytest.raises(ThetaClientError, match="length mismatch"):
            _fetch_eod_single_close(client)


# ---------------------------------------------------------------------------
# Option-type normalization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "option_type,expected",
    [("C", "C"), ("c", "C"), ("CALL", "C"), ("Call", "C"), ("P", "P"), ("put", "P")],
)
def test_option_type_normalization_in_fetch_eod(option_type: str, expected: str) -> None:
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


# ---------------------------------------------------------------------------
# snapshot_index_price — GET /v2/snapshot/index/price (Index Data PRO)
# ---------------------------------------------------------------------------


def _et_ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    """Epoch ms of a wall-clock Eastern time — independent derivation so
    the tests don't just mirror the client's date+ms_of_day arithmetic."""
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo

    return int(
        _dt(year, month, day, hour, minute, tzinfo=ZoneInfo("America/New_York")).timestamp() * 1000
    )


_SNAPSHOT_INDEX_PRICE_PAYLOAD = {
    "header": {"format": ["ms_of_day", "price", "date"]},
    # 41400000 ms of day = 11:30:00 ET
    "response": [[41400000, 6423.53, 20260814]],
}


def test_snapshot_index_price_parses_price_and_ts() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(_SNAPSHOT_INDEX_PRICE_PAYLOAD),
    ) as mock_urlopen:
        client = ThetaClient()
        snap = client.snapshot_index_price("SPX")

    assert isinstance(snap, IndexPriceSnapshot)
    assert snap.root == "SPX"
    assert snap.price == Decimal("6423.53")
    assert snap.snapshot_date == date(2026, 8, 14)
    assert snap.ts_ms == _et_ms(2026, 8, 14, 11, 30)
    # Wraps the documented endpoint with root as the only param.
    url = mock_urlopen.call_args[0][0].full_url
    assert "/v2/snapshot/index/price?" in url
    assert "root=SPX" in url


def test_snapshot_index_price_no_data_returns_none() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(":No data for the specified timeframe & contract."),
    ):
        client = ThetaClient()
        assert client.snapshot_index_price("VIX1D") is None


def test_snapshot_index_price_472_no_data_returns_none() -> None:
    # HTTP 472 = NO_DATA — same semantics as the plain-text ":No data"
    # body: None, no exception, no retries.
    with patch("theta_client.urlopen", side_effect=_http_error(472, "No data")) as mock_urlopen:
        client = ThetaClient(max_retries=3)
        assert client.snapshot_index_price("SPX") is None
    # No-data never retries.
    assert mock_urlopen.call_count == 1


def test_snapshot_index_price_471_raises_subscription_error() -> None:
    # HTTP 471 = PERMISSION — the real entitlement denial.
    with patch(
        "theta_client.urlopen", side_effect=_http_error(471, "Permission denied")
    ) as mock_urlopen:
        client = ThetaClient(max_retries=3)
        with pytest.raises(ThetaSubscriptionError):
            client.snapshot_index_price("SPX")
    # Denials never retry.
    assert mock_urlopen.call_count == 1


def test_snapshot_index_price_row_format_mismatch_raises() -> None:
    # Column drift (row longer than format) must fail loudly, not
    # silently misalign — same strict-zip contract as fetch_eod.
    payload = {
        "header": {"format": ["ms_of_day", "price"]},
        "response": [[41400000, 6423.53, 20260814]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        with pytest.raises(ThetaClientError, match="length mismatch"):
            client.snapshot_index_price("SPX")


def test_snapshot_index_price_missing_price_column_raises() -> None:
    payload = {
        "header": {"format": ["ms_of_day", "date"]},
        "response": [[41400000, 20260814]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        with pytest.raises(ThetaClientError, match="price"):
            client.snapshot_index_price("SPX")


# ---------------------------------------------------------------------------
# hist_index_ohlc — GET /v2/hist/index/ohlc (per-date, interval candles)
# ---------------------------------------------------------------------------


_HIST_INDEX_OHLC_PAYLOAD = {
    "header": {
        "format": ["ms_of_day", "open", "high", "low", "close", "date"],
    },
    "response": [
        # 34200000 = 09:30:00 ET, 34260000 = 09:31:00 ET
        [34200000, 6400.10, 6402.50, 6399.00, 6401.25, 20260814],
        [34260000, 6401.25, 6404.00, 6400.75, 6403.80, 20260814],
    ],
}


def test_hist_index_ohlc_parses_candles() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(_HIST_INDEX_OHLC_PAYLOAD),
    ):
        client = ThetaClient()
        candles = client.hist_index_ohlc("SPX", date(2026, 8, 14))

    assert len(candles) == 2
    first = candles[0]
    assert isinstance(first, IndexOhlcCandle)
    assert first.ts_ms == _et_ms(2026, 8, 14, 9, 30)
    assert first.open == Decimal("6400.10")
    assert first.high == Decimal("6402.50")
    assert first.low == Decimal("6399.00")
    assert first.close == Decimal("6401.25")
    second = candles[1]
    assert second.ts_ms == _et_ms(2026, 8, 14, 9, 31)
    assert second.close == Decimal("6403.80")


def test_hist_index_ohlc_has_no_volume_field() -> None:
    # Indices have no volume — the candle shape must not fabricate one.
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(_HIST_INDEX_OHLC_PAYLOAD),
    ):
        client = ThetaClient()
        candles = client.hist_index_ohlc("SPX", date(2026, 8, 14))
    assert not hasattr(candles[0], "volume")


def test_hist_index_ohlc_sends_per_date_params_and_default_ivl() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(_HIST_INDEX_OHLC_PAYLOAD),
    ) as mock_urlopen:
        client = ThetaClient()
        client.hist_index_ohlc("VIX", date(2026, 8, 14))
    url = mock_urlopen.call_args[0][0].full_url
    assert "/v2/hist/index/ohlc?" in url
    assert "root=VIX" in url
    # Per-date wrapper: start_date == end_date == the requested day.
    assert "start_date=20260814" in url
    assert "end_date=20260814" in url
    # Default interval is 1 minute.
    assert "ivl=60000" in url


def test_hist_index_ohlc_forwards_custom_ivl_ms() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(_HIST_INDEX_OHLC_PAYLOAD),
    ) as mock_urlopen:
        client = ThetaClient()
        client.hist_index_ohlc("SPX", date(2026, 8, 14), ivl_ms=300000)
    url = mock_urlopen.call_args[0][0].full_url
    assert "ivl=300000" in url


def test_hist_index_ohlc_no_data_returns_empty_list() -> None:
    with patch(
        "theta_client.urlopen",
        return_value=_http_response(":No data for the specified timeframe & contract."),
    ):
        client = ThetaClient()
        assert client.hist_index_ohlc("VVIX", date(2026, 8, 14)) == []


def test_hist_index_ohlc_row_format_mismatch_raises() -> None:
    payload = {
        "header": {"format": ["ms_of_day", "open", "high", "low", "close", "date"]},
        "response": [[34200000, 6400.10, 6402.50, 6399.00, 6401.25]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        with pytest.raises(ThetaClientError, match="length mismatch"):
            client.hist_index_ohlc("SPX", date(2026, 8, 14))


def test_hist_index_ohlc_tolerates_extra_named_columns() -> None:
    # If Theta adds a column AND names it in the format header, the
    # strict zip still matches (equal lengths) and unknown names are
    # simply ignored — only unnamed drift fails.
    payload = {
        "header": {
            "format": ["ms_of_day", "open", "high", "low", "close", "count", "date"],
        },
        "response": [[34200000, 6400.10, 6402.50, 6399.00, 6401.25, 0, 20260814]],
    }
    with patch("theta_client.urlopen", return_value=_http_response(payload)):
        client = ThetaClient()
        candles = client.hist_index_ohlc("SPX", date(2026, 8, 14))
    assert len(candles) == 1
    assert candles[0].close == Decimal("6401.25")


def test_hist_index_ohlc_472_no_data_returns_empty_list() -> None:
    # HTTP 472 = NO_DATA — same semantics as the plain-text ":No data"
    # body: [], no exception, no retries.
    with patch("theta_client.urlopen", side_effect=_http_error(472, "No data")) as mock_urlopen:
        client = ThetaClient(max_retries=3)
        assert client.hist_index_ohlc("SPX", date(2026, 8, 14)) == []
    # No-data never retries.
    assert mock_urlopen.call_count == 1


def test_hist_index_ohlc_471_raises_subscription_error() -> None:
    # HTTP 471 = PERMISSION — the real entitlement denial.
    with patch("theta_client.urlopen", side_effect=_http_error(471, "Permission denied")):
        client = ThetaClient(max_retries=3)
        with pytest.raises(ThetaSubscriptionError):
            client.hist_index_ohlc("SPX", date(2026, 8, 14))
