"""Tests for theta_fetcher — the nightly ingest orchestrator.

We stub ThetaClient and the `db` module so no real network or Postgres
is needed. Each test exercises one decision the orchestrator makes:
date arithmetic, empty-table detection, batching thresholds, and
subscription-denial handling.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from theta_client import EodRow, ThetaSubscriptionError  # noqa: E402


@pytest.fixture
def mock_theta_launcher_running(monkeypatch):
    """Pretend theta_launcher reports the subprocess alive."""
    import theta_launcher

    monkeypatch.setattr(theta_launcher, "is_running", lambda: True)


@pytest.fixture
def mock_theta_launcher_dead(monkeypatch):
    """Pretend theta_launcher reports no subprocess running."""
    import theta_launcher

    monkeypatch.setattr(theta_launcher, "is_running", lambda: False)


# ---------------------------------------------------------------------------
# _prior_trading_day — pure date arithmetic
# ---------------------------------------------------------------------------


def test_prior_trading_day_from_weekday() -> None:
    from theta_fetcher import _prior_trading_day

    # Wed 2024-04-17 -> Tue 2024-04-16
    assert _prior_trading_day(date(2024, 4, 17)) == date(2024, 4, 16)


def test_prior_trading_day_from_monday_returns_friday() -> None:
    from theta_fetcher import _prior_trading_day

    # Mon 2024-04-15 -> Fri 2024-04-12
    assert _prior_trading_day(date(2024, 4, 15)) == date(2024, 4, 12)


def test_prior_trading_day_from_saturday_returns_friday() -> None:
    from theta_fetcher import _prior_trading_day

    # Sat 2024-04-20 -> Fri 2024-04-19
    assert _prior_trading_day(date(2024, 4, 20)) == date(2024, 4, 19)


def test_prior_trading_day_from_sunday_returns_friday() -> None:
    from theta_fetcher import _prior_trading_day

    # Sun 2024-04-21 -> Fri 2024-04-19
    assert _prior_trading_day(date(2024, 4, 21)) == date(2024, 4, 19)


# ---------------------------------------------------------------------------
# _row_to_tuple — column order must match db.upsert_theta_option_eod_batch
# ---------------------------------------------------------------------------


def test_row_to_tuple_preserves_column_order() -> None:
    from theta_fetcher import _row_to_tuple

    row = EodRow(
        symbol="SPXW",
        expiration=date(2024, 4, 19),
        strike=Decimal("5100.00"),
        option_type="C",
        trade_date=date(2024, 4, 18),
        open=Decimal("10.00"),
        high=Decimal("12.50"),
        low=Decimal("9.75"),
        close=Decimal("11.20"),
        volume=1234,
        trade_count=42,
        bid=Decimal("11.10"),
        ask=Decimal("11.30"),
        bid_size=5,
        ask_size=8,
    )
    assert _row_to_tuple(row) == (
        "SPXW",
        date(2024, 4, 19),
        Decimal("5100.00"),
        "C",
        date(2024, 4, 18),
        Decimal("10.00"),
        Decimal("12.50"),
        Decimal("9.75"),
        Decimal("11.20"),
        1234,
        42,
        Decimal("11.10"),
        Decimal("11.30"),
        5,
        8,
    )


# ---------------------------------------------------------------------------
# run_backfill_if_needed — short-circuits when data already exists
# ---------------------------------------------------------------------------


def test_backfill_skips_root_with_existing_data(monkeypatch) -> None:
    import theta_fetcher

    # Pretend both SPXW and VIX already have rows.
    monkeypatch.setattr(
        theta_fetcher.db, "has_theta_option_eod_rows", lambda _root: True
    )
    # Force a small root list for determinism.
    monkeypatch.setattr(
        theta_fetcher.settings, "theta_roots", "SPXW,VIX"
    )

    fake_client = MagicMock()
    # Inject a fake ThetaClient so we can assert the fetch was never made.
    with patch("theta_fetcher.ThetaClient", return_value=fake_client):
        theta_fetcher.run_backfill_if_needed()

    # No list_expirations / list_strikes / fetch_eod should have been called.
    fake_client.list_expirations.assert_not_called()
    fake_client.list_strikes.assert_not_called()
    fake_client.fetch_eod.assert_not_called()


def test_backfill_runs_for_root_with_empty_table(monkeypatch) -> None:
    import theta_fetcher

    monkeypatch.setattr(
        theta_fetcher.db, "has_theta_option_eod_rows", lambda _root: False
    )
    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW")
    monkeypatch.setattr(theta_fetcher.settings, "theta_backfill_days", 5)

    # Use an expiration 30 days from today so it's inside the horizon
    # filter regardless of when the test runs ([today - 7d, today + 180d]).
    future_exp = date.today() + timedelta(days=30)
    prior_day = theta_fetcher._prior_trading_day(date.today())

    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [future_exp]
    fake_client.list_strikes.return_value = [Decimal("5100.00")]
    fake_client.fetch_eod.return_value = [
        EodRow(
            symbol="SPXW",
            expiration=future_exp,
            strike=Decimal("5100.00"),
            option_type="C",
            trade_date=prior_day,
            open=None, high=None, low=None,
            close=Decimal("1.50"),
            volume=None, trade_count=None,
            bid=None, ask=None, bid_size=None, ask_size=None,
        )
    ]

    upsert_calls: list[list[tuple]] = []
    monkeypatch.setattr(
        theta_fetcher.db,
        "upsert_theta_option_eod_batch",
        lambda rows: upsert_calls.append(rows),
    )
    with patch("theta_fetcher.ThetaClient", return_value=fake_client):
        theta_fetcher.run_backfill_if_needed()

    assert fake_client.list_expirations.called
    assert fake_client.list_strikes.called
    # Both rights (C + P) fetched for the one strike.
    assert fake_client.fetch_eod.call_count == 2
    # Both calls produced a row each, flushed in one batch at loop-end.
    assert sum(len(batch) for batch in upsert_calls) == 2


# ---------------------------------------------------------------------------
# _fetch_root_range — filters expirations + handles subscription denials
# ---------------------------------------------------------------------------


def test_fetch_root_range_filters_out_of_horizon_expirations(monkeypatch) -> None:
    import theta_fetcher

    # Anchor to a fixed target day; horizon window becomes
    # [2024-04-11, 2024-10-15] for a start_date=2024-04-18.
    target_day = date(2024, 4, 18)

    fake_client = MagicMock()
    # Three expirations: two out of window, one in the window.
    fake_client.list_expirations.return_value = [
        date(2020, 1, 15),   # too old
        date(2024, 4, 19),   # in window
        date(2030, 1, 15),   # too far forward
    ]
    fake_client.list_strikes.return_value = []  # no strikes -> no fetch_eod

    monkeypatch.setattr(
        theta_fetcher.db, "upsert_theta_option_eod_batch", MagicMock()
    )

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", target_day, target_day
    )

    assert result == 0
    # Only the in-window expiration should have been passed to list_strikes.
    fake_client.list_strikes.assert_called_once_with("SPXW", date(2024, 4, 19))


def test_fetch_root_range_aborts_on_subscription_denial(monkeypatch) -> None:
    import theta_fetcher

    fake_client = MagicMock()
    fake_client.list_expirations.side_effect = ThetaSubscriptionError(
        "Not entitled"
    )
    upsert_mock = MagicMock()
    monkeypatch.setattr(
        theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock
    )

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", date(2024, 4, 18), date(2024, 4, 18)
    )

    assert result == 0
    # Never got past list_expirations.
    fake_client.list_strikes.assert_not_called()
    fake_client.fetch_eod.assert_not_called()
    upsert_mock.assert_not_called()


def test_fetch_root_range_stops_root_on_fetch_eod_denial(monkeypatch) -> None:
    import theta_fetcher

    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [date(2024, 4, 19)]
    fake_client.list_strikes.return_value = [Decimal("5100.00")]
    # First fetch (C) raises — root should be marked denied and P skipped.
    fake_client.fetch_eod.side_effect = ThetaSubscriptionError("Not entitled")

    upsert_mock = MagicMock()
    monkeypatch.setattr(
        theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock
    )

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", date(2024, 4, 18), date(2024, 4, 18)
    )

    assert result == 0
    # Only one fetch attempt — the P side was skipped.
    assert fake_client.fetch_eod.call_count == 1
    upsert_mock.assert_not_called()


# ---------------------------------------------------------------------------
# start_scheduler — respects theta_launcher state
# ---------------------------------------------------------------------------


def test_start_scheduler_no_op_when_theta_dead(mock_theta_launcher_dead) -> None:
    import theta_fetcher

    # Make sure any prior test didn't leave a scheduler around.
    theta_fetcher.stop_scheduler()

    assert theta_fetcher.start_scheduler() is False
    assert theta_fetcher._scheduler is None


def test_start_scheduler_is_idempotent(mock_theta_launcher_running) -> None:
    import theta_fetcher

    # Reset scheduler state between tests.
    theta_fetcher.stop_scheduler()

    try:
        assert theta_fetcher.start_scheduler() is True
        first = theta_fetcher._scheduler
        # Second call must not replace the running scheduler.
        assert theta_fetcher.start_scheduler() is True
        assert theta_fetcher._scheduler is first
    finally:
        theta_fetcher.stop_scheduler()
