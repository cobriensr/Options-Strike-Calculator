"""
Unit tests for ml/trace/fetch_prices.py.

Mocks yfinance so tests run offline.
"""

from unittest.mock import MagicMock, patch

import fetch_prices as fp
import pandas as pd
import pytest

# ── helpers ───────────────────────────────────────────────────────────────────


def _make_hist(dates: list[str], closes: list[float]) -> pd.DataFrame:
    """Return a minimal yfinance-style history DataFrame with DatetimeIndex."""
    hist = pd.DataFrame({"Close": closes}, index=pd.to_datetime(dates))
    hist.index.name = "Date"
    return hist


# ── fetch_spx_closes ─────────────────────────────────────────────────────────


def test_fetch_spx_closes_returns_known_dates():
    """Returns actual_close for each date present in yfinance history."""
    dates = ["2026-01-06", "2026-01-07", "2026-01-08"]
    hist = _make_hist(dates, [5800.0, 5820.0, 5810.0])

    mock_ticker = MagicMock()
    mock_ticker.history.return_value = hist

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker):
        result = fp.fetch_spx_closes(dates)

    assert list(result["date"]) == dates
    assert list(result["actual_close"]) == [5800.0, 5820.0, 5810.0]


def test_fetch_spx_closes_none_for_missing_dates():
    """Returns None for dates not in yfinance history (non-trading days)."""
    dates = ["2026-01-05", "2026-01-06"]  # Jan 5 is a Monday but hypothetically missing
    hist = _make_hist(["2026-01-06"], [5800.0])

    mock_ticker = MagicMock()
    mock_ticker.history.return_value = hist

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker):
        result = fp.fetch_spx_closes(dates)

    missing_row = result[result["date"] == "2026-01-05"].iloc[0]
    assert missing_row["actual_close"] is None or pd.isna(missing_row["actual_close"])

    present_row = result[result["date"] == "2026-01-06"].iloc[0]
    assert present_row["actual_close"] == pytest.approx(5800.0)


def test_fetch_spx_closes_exits_on_empty_history():
    """Calls sys.exit when yfinance returns an empty DataFrame."""
    mock_ticker = MagicMock()
    mock_ticker.history.return_value = pd.DataFrame()

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker):
        with pytest.raises(SystemExit):
            fp.fetch_spx_closes(["2026-01-06"])


def test_fetch_spx_closes_date_range_includes_buffer():
    """History fetch includes a 5-day look-back buffer before the earliest date."""
    dates = ["2026-03-10"]

    mock_ticker = MagicMock()
    mock_ticker.history.return_value = _make_hist(["2026-03-10"], [5900.0])

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker):
        fp.fetch_spx_closes(dates)

    call_kwargs = mock_ticker.history.call_args
    start = (
        call_kwargs.kwargs.get("start") or call_kwargs.args[0]
        if call_kwargs.args
        else call_kwargs.kwargs["start"]
    )
    # start should be at least 5 days before 2026-03-10
    import datetime

    start_date = datetime.date.fromisoformat(start)
    assert start_date <= datetime.date(2026, 3, 5)


def test_fetch_spx_closes_rounds_to_two_decimals():
    """actual_close values are rounded to 2 decimal places."""
    dates = ["2026-01-06"]
    hist = _make_hist(["2026-01-06"], [5800.123456])

    mock_ticker = MagicMock()
    mock_ticker.history.return_value = hist

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker):
        result = fp.fetch_spx_closes(dates)

    assert result.iloc[0]["actual_close"] == pytest.approx(5800.12)


def test_fetch_spx_closes_uses_spx_ticker():
    """Ticker is called with '^SPX'."""
    dates = ["2026-01-06"]
    hist = _make_hist(["2026-01-06"], [5800.0])

    mock_ticker = MagicMock()
    mock_ticker.history.return_value = hist

    with patch("fetch_prices.yf.Ticker", return_value=mock_ticker) as mock_yfin:
        fp.fetch_spx_closes(dates)

    mock_yfin.assert_called_once_with("^SPX")


# ── main ──────────────────────────────────────────────────────────────────────


def test_main_exits_if_no_predictions_csv(tmp_path):
    """main() exits when predictions.csv is absent."""
    with patch.object(fp, "RESULTS_DIR", tmp_path):
        with pytest.raises(SystemExit):
            fp.main()


def test_main_writes_actual_prices_csv(tmp_path):
    """main() writes actual_prices.csv with fetched closes."""
    predictions = pd.DataFrame(
        {
            "date": ["2026-01-06", "2026-01-07"],
            "current_price": [5800.0, 5820.0],
            "predicted_close": [5790.0, 5830.0],
        }
    )
    predictions.to_csv(tmp_path / "predictions.csv", index=False)

    hist = _make_hist(["2026-01-06", "2026-01-07"], [5795.0, 5825.0])
    mock_ticker = MagicMock()
    mock_ticker.history.return_value = hist

    with (
        patch.object(fp, "RESULTS_DIR", tmp_path),
        patch("fetch_prices.yf.Ticker", return_value=mock_ticker),
    ):
        fp.main()

    out = pd.read_csv(tmp_path / "actual_prices.csv")
    assert set(out.columns) >= {"date", "actual_close"}
    assert len(out) == 2
