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

from theta_client import EodRow, ThetaSubscriptionError


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
    monkeypatch.setattr(theta_fetcher.db, "has_theta_option_eod_rows", lambda _root: True)
    # Force a small root list for determinism.
    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW,VIX")

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

    monkeypatch.setattr(theta_fetcher.db, "has_theta_option_eod_rows", lambda _root: False)
    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW")
    monkeypatch.setattr(theta_fetcher.settings, "theta_backfill_days", 5)

    # Use an expiration 30 days from today so it's inside the horizon
    # filter regardless of when the test runs ([today - 7d, today + 180d]).
    future_exp = date.today() + timedelta(days=30)  # noqa: DTZ011 — mirrors run_backfill_if_needed
    prior_day = theta_fetcher._prior_trading_day(date.today())  # noqa: DTZ011 — mirrors the source

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
            open=None,
            high=None,
            low=None,
            close=Decimal("1.50"),
            volume=None,
            trade_count=None,
            bid=None,
            ask=None,
            bid_size=None,
            ask_size=None,
        )
    ]

    upsert_calls: list[list[tuple]] = []
    monkeypatch.setattr(
        theta_fetcher.db,
        "upsert_theta_option_eod_batch",
        upsert_calls.append,
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
    # [2024-04-18, 2024-10-15] for a start_date=2024-04-18 — expirations
    # before start_date are skipped entirely (post-expiry EOD requests
    # are guaranteed NO_DATA).
    target_day = date(2024, 4, 18)

    fake_client = MagicMock()
    # Three expirations: two out of window, one in the window.
    fake_client.list_expirations.return_value = [
        date(2020, 1, 15),  # too old
        date(2024, 4, 19),  # in window
        date(2030, 1, 15),  # too far forward
    ]
    fake_client.list_strikes.return_value = []  # no strikes -> no fetch_eod

    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", MagicMock())

    result = theta_fetcher._fetch_root_range(fake_client, "SPXW", target_day, target_day)

    assert result == 0
    # Only the in-window expiration should have been passed to list_strikes.
    fake_client.list_strikes.assert_called_once_with("SPXW", date(2024, 4, 19))


def test_fetch_root_range_aborts_on_subscription_denial(monkeypatch) -> None:
    import theta_fetcher

    fake_client = MagicMock()
    fake_client.list_expirations.side_effect = ThetaSubscriptionError("Not entitled")
    upsert_mock = MagicMock()
    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock)

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
    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock)

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", date(2024, 4, 18), date(2024, 4, 18)
    )

    assert result == 0
    # Only one fetch attempt — the P side was skipped.
    assert fake_client.fetch_eod.call_count == 1
    upsert_mock.assert_not_called()


# ---------------------------------------------------------------------------
# _fetch_root_range — expired-expiration skip + per-expiration range clamp
# ---------------------------------------------------------------------------


def test_fetch_root_range_skips_expirations_before_window_start(monkeypatch) -> None:
    """An expiration that expired before start_date has no data inside
    the window — post-expiry EOD requests are guaranteed NO_DATA (472).
    Production repro: the SPXW backfill window [2026-05-16, 2026-08-14]
    must never probe the 2026-05-11 expiration at all."""
    import theta_fetcher

    start, end = date(2026, 5, 16), date(2026, 8, 14)
    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [
        date(2026, 5, 11),  # expired before window start — skip entirely
        date(2026, 6, 19),  # in window
    ]
    fake_client.list_strikes.return_value = []  # no strikes -> no fetch_eod

    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", MagicMock())

    result = theta_fetcher._fetch_root_range(fake_client, "SPXW", start, end)

    assert result == 0
    # Only the in-window expiration was probed.
    fake_client.list_strikes.assert_called_once_with("SPXW", date(2026, 6, 19))


def test_fetch_root_range_clamps_fetch_end_to_expiration(monkeypatch) -> None:
    """An in-window expiration earlier than end_date must have its fetch
    range clamped to [start_date, exp] — trade dates after expiry are
    guaranteed NO_DATA."""
    import theta_fetcher

    start, end = date(2026, 5, 16), date(2026, 8, 14)
    exp = date(2026, 6, 19)
    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [exp]
    fake_client.list_strikes.return_value = [Decimal("5100.00")]
    fake_client.fetch_eod.return_value = []

    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", MagicMock())

    theta_fetcher._fetch_root_range(fake_client, "SPXW", start, end)

    # Both rights fetched, each with the clamped range.
    assert fake_client.fetch_eod.call_count == 2
    for call in fake_client.fetch_eod.call_args_list:
        assert call.args[4] == start
        assert call.args[5] == exp  # min(end_date, exp)


def test_fetch_root_range_keeps_full_range_for_future_expiration(monkeypatch) -> None:
    """An expiration beyond end_date (still inside the future horizon)
    keeps the full [start_date, end_date] fetch range — no clamping."""
    import theta_fetcher

    start, end = date(2026, 5, 16), date(2026, 8, 14)
    exp = date(2026, 9, 18)  # after end_date, within the future horizon
    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [exp]
    fake_client.list_strikes.return_value = [Decimal("5100.00")]
    fake_client.fetch_eod.return_value = []

    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", MagicMock())

    theta_fetcher._fetch_root_range(fake_client, "SPXW", start, end)

    assert fake_client.fetch_eod.call_count == 2
    for call in fake_client.fetch_eod.call_args_list:
        assert call.args[4] == start
        assert call.args[5] == end


def test_fetch_root_range_no_data_strike_continues_loop(monkeypatch) -> None:
    """Empty fetch_eod results (Theta NO_DATA, HTTP 472) must not trip
    the denied flag — later strikes still get fetched. Production repro:
    VIX died on one illiquid strike after 140 good rows."""
    import theta_fetcher

    exp = date(2024, 4, 19)
    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [exp]
    fake_client.list_strikes.return_value = [
        Decimal("5000.00"),  # illiquid — no data on either side
        Decimal("5100.00"),  # has data
    ]
    # Strike 1: C and P both empty. Strike 2: one row per side.
    fake_client.fetch_eod.side_effect = [
        [],
        [],
        [_make_eod_row("C")],
        [_make_eod_row("P")],
    ]

    flushed: list[list[tuple]] = []
    monkeypatch.setattr(
        theta_fetcher.db,
        "upsert_theta_option_eod_batch",
        flushed.append,
    )

    result = theta_fetcher._fetch_root_range(
        fake_client, "VIX", date(2024, 4, 18), date(2024, 4, 18)
    )

    # All four fetches attempted — no-data never stops the root.
    assert fake_client.fetch_eod.call_count == 4
    assert result == 2
    assert sum(len(batch) for batch in flushed) == 2


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


def test_start_scheduler_trigger_is_anchored_to_new_york(
    mock_theta_launcher_running,
) -> None:
    """The nightly trigger itself must carry America/New_York.

    PRODUCTION BUG (2026-08-17): `BackgroundScheduler(timezone="America/
    New_York")` only applies its default to triggers the scheduler builds
    from kwargs. A PRE-BUILT `CronTrigger(hour=17, minute=25)` freezes its
    timezone at construction — falling back to the container's local zone,
    UTC on Railway — and `add_job` never retrofits the scheduler default
    (verified on apscheduler 3.11.3). The "nightly" EOD job therefore fired
    at 17:25 UTC = 1:25 PM ET, mid-session, for a 2.1-hour pull against a
    live Terminal. The boot log claiming "17:25 America/New_York" described
    a default that never applied. Assert on the JOB's trigger, not the
    scheduler, so this exact regression cannot ship again.
    """
    import theta_fetcher

    theta_fetcher.stop_scheduler()
    try:
        assert theta_fetcher.start_scheduler() is True
        job = theta_fetcher._scheduler.get_job("theta_nightly_eod")
        assert job is not None
        assert str(job.trigger.timezone) == "America/New_York"
    finally:
        theta_fetcher.stop_scheduler()


# ---------------------------------------------------------------------------
# _fetch_strike_pair — Phase 5b extraction. Per-strike call+put helper.
# ---------------------------------------------------------------------------


def _make_eod_row(opt_type: str) -> EodRow:
    """Minimal EodRow fixture for strike-pair tests."""
    return EodRow(
        symbol="SPXW",
        expiration=date(2024, 4, 19),
        strike=Decimal("5100.00"),
        option_type=opt_type,
        trade_date=date(2024, 4, 18),
        open=None,
        high=None,
        low=None,
        close=Decimal("1.50"),
        volume=None,
        trade_count=None,
        bid=None,
        ask=None,
        bid_size=None,
        ask_size=None,
    )


def test_fetch_strike_pair_returns_both_sides() -> None:
    from theta_fetcher import _fetch_strike_pair

    fake_client = MagicMock()
    fake_client.fetch_eod.side_effect = [
        [_make_eod_row("C")],
        [_make_eod_row("P")],
    ]

    rows, denied = _fetch_strike_pair(
        fake_client,
        "SPXW",
        date(2024, 4, 19),
        Decimal("5100.00"),
        date(2024, 4, 18),
        date(2024, 4, 18),
    )

    assert denied is False
    assert len(rows) == 2
    assert {r.option_type for r in rows} == {"C", "P"}
    # Both rights fetched.
    assert fake_client.fetch_eod.call_count == 2


def test_fetch_strike_pair_subscription_denial_short_circuits_p_side() -> None:
    """If C-side fetch raises ThetaSubscriptionError, the helper must
    return (rows_so_far, True) without calling fetch_eod for P."""
    from theta_fetcher import _fetch_strike_pair

    fake_client = MagicMock()
    fake_client.fetch_eod.side_effect = ThetaSubscriptionError("Not entitled")

    rows, denied = _fetch_strike_pair(
        fake_client,
        "SPXW",
        date(2024, 4, 19),
        Decimal("5100.00"),
        date(2024, 4, 18),
        date(2024, 4, 18),
    )

    assert denied is True
    assert rows == []
    assert fake_client.fetch_eod.call_count == 1


def test_fetch_strike_pair_per_side_exception_continues_to_other_side() -> None:
    """Non-subscription exception on C must NOT abort — P should still fire,
    matching the prior inline behavior. The C-side rows are dropped."""
    from theta_fetcher import _fetch_strike_pair

    fake_client = MagicMock()
    fake_client.fetch_eod.side_effect = [
        RuntimeError("transient"),
        [_make_eod_row("P")],
    ]

    rows, denied = _fetch_strike_pair(
        fake_client,
        "SPXW",
        date(2024, 4, 19),
        Decimal("5100.00"),
        date(2024, 4, 18),
        date(2024, 4, 18),
    )

    assert denied is False
    assert len(rows) == 1
    assert rows[0].option_type == "P"
    # Both attempted — C raised, P succeeded.
    assert fake_client.fetch_eod.call_count == 2


def test_fetch_strike_pair_no_data_returns_empty_not_denied() -> None:
    """Theta NO_DATA (HTTP 472 → [] at the client) must yield
    ([], denied=False) so the caller keeps iterating strikes instead of
    killing the root. Only ThetaSubscriptionError (HTTP 471) may trip
    the denied flag."""
    from theta_fetcher import _fetch_strike_pair

    fake_client = MagicMock()
    fake_client.fetch_eod.return_value = []

    rows, denied = _fetch_strike_pair(
        fake_client,
        "VIX",
        date(2024, 4, 19),
        Decimal("5100.00"),
        date(2024, 4, 18),
        date(2024, 4, 18),
    )

    assert denied is False
    assert rows == []
    # Both sides still attempted.
    assert fake_client.fetch_eod.call_count == 2


def test_fetch_strike_pair_p_side_denial_keeps_c_rows() -> None:
    """If C succeeds and P denies, return (C rows, denied=True)."""
    from theta_fetcher import _fetch_strike_pair

    fake_client = MagicMock()
    fake_client.fetch_eod.side_effect = [
        [_make_eod_row("C")],
        ThetaSubscriptionError("Not entitled"),
    ]

    rows, denied = _fetch_strike_pair(
        fake_client,
        "SPXW",
        date(2024, 4, 19),
        Decimal("5100.00"),
        date(2024, 4, 18),
        date(2024, 4, 18),
    )

    assert denied is True
    assert len(rows) == 1
    assert rows[0].option_type == "C"
    assert fake_client.fetch_eod.call_count == 2


# ---------------------------------------------------------------------------
# _flush_batch — empty-batch short-circuit + non-empty upsert
# ---------------------------------------------------------------------------


def test_flush_batch_empty_returns_zero_without_upsert(monkeypatch) -> None:
    """An empty batch must not touch the db and must return 0."""
    import theta_fetcher

    upsert_mock = MagicMock()
    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock)

    assert theta_fetcher._flush_batch([]) == 0
    upsert_mock.assert_not_called()


def test_flush_batch_upserts_and_returns_count(monkeypatch) -> None:
    """A non-empty batch upserts tuples in column order and returns len."""
    import theta_fetcher

    upsert_calls: list[list[tuple]] = []
    monkeypatch.setattr(
        theta_fetcher.db,
        "upsert_theta_option_eod_batch",
        upsert_calls.append,
    )

    batch = [_make_eod_row("C"), _make_eod_row("P")]
    assert theta_fetcher._flush_batch(batch) == 2
    # One upsert call carrying both rows as tuples.
    assert len(upsert_calls) == 1
    assert len(upsert_calls[0]) == 2
    # Tuples, not EodRow objects, and in the documented column order.
    assert upsert_calls[0][0][0] == "SPXW"
    assert upsert_calls[0][0][3] == "C"


# ---------------------------------------------------------------------------
# _fetch_root_range — list_strikes failure + mid-loop batch flush
# ---------------------------------------------------------------------------


def test_fetch_root_range_list_strikes_exception_skips_expiration(monkeypatch) -> None:
    """A non-subscription error from list_strikes is captured to Sentry and
    that expiration is skipped — the loop continues without raising."""
    import theta_fetcher

    in_window = date(2024, 4, 19)
    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [in_window]
    fake_client.list_strikes.side_effect = RuntimeError("theta http 500")

    capture_calls: list[Exception] = []
    monkeypatch.setattr(
        theta_fetcher,
        "capture_exception",
        lambda exc, **_kw: capture_calls.append(exc),
    )
    upsert_mock = MagicMock()
    monkeypatch.setattr(theta_fetcher.db, "upsert_theta_option_eod_batch", upsert_mock)

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", date(2024, 4, 18), date(2024, 4, 18)
    )

    assert result == 0
    # The expiration's strike fetch was skipped — fetch_eod never reached.
    fake_client.fetch_eod.assert_not_called()
    upsert_mock.assert_not_called()
    # The error was reported to Sentry exactly once.
    assert len(capture_calls) == 1
    assert isinstance(capture_calls[0], RuntimeError)


def test_fetch_root_range_flushes_batch_when_threshold_reached(monkeypatch) -> None:
    """When the rolling batch reaches BATCH_FLUSH_SIZE, _fetch_root_range
    flushes mid-loop rather than only at expiration end."""
    import theta_fetcher

    in_window = date(2024, 4, 19)
    # Enough strikes that the C+P pairs cross the flush threshold mid-loop.
    flush_size = theta_fetcher.BATCH_FLUSH_SIZE
    n_strikes = flush_size + 5
    strikes = [Decimal(str(5000 + i)) for i in range(n_strikes)]

    fake_client = MagicMock()
    fake_client.list_expirations.return_value = [in_window]
    fake_client.list_strikes.return_value = strikes
    # Each fetch_eod (called once per side) returns one row.
    fake_client.fetch_eod.side_effect = lambda *a, **k: [_make_eod_row(a[3])]

    flush_sizes: list[int] = []
    monkeypatch.setattr(
        theta_fetcher.db,
        "upsert_theta_option_eod_batch",
        lambda rows: flush_sizes.append(len(rows)),
    )

    result = theta_fetcher._fetch_root_range(
        fake_client, "SPXW", date(2024, 4, 18), date(2024, 4, 18)
    )

    # Two rows per strike (C + P).
    expected_rows = n_strikes * 2
    assert result == expected_rows
    assert sum(flush_sizes) == expected_rows
    # At least one mid-loop flush happened (more than a single end-of-loop one).
    assert len(flush_sizes) >= 2
    # The first flush fired at the threshold boundary (>= BATCH_FLUSH_SIZE).
    assert flush_sizes[0] >= flush_size


# ---------------------------------------------------------------------------
# stop_scheduler — swallows shutdown errors
# ---------------------------------------------------------------------------


def test_stop_scheduler_swallows_shutdown_exception(monkeypatch) -> None:
    """A scheduler whose shutdown() raises must not propagate; the handle
    is still cleared to None so a later start_scheduler can re-create it."""
    import theta_fetcher

    failing_scheduler = MagicMock()
    failing_scheduler.shutdown.side_effect = RuntimeError("already dead")
    monkeypatch.setattr(theta_fetcher, "_scheduler", failing_scheduler)

    # Must not raise.
    theta_fetcher.stop_scheduler()

    failing_scheduler.shutdown.assert_called_once_with(wait=False)
    assert theta_fetcher._scheduler is None


# ---------------------------------------------------------------------------
# run_nightly — happy path, exception re-raise, and over-duration warning
# ---------------------------------------------------------------------------


def test_run_nightly_happy_path_logs_total(monkeypatch) -> None:
    """run_nightly fetches each configured root for the prior trading day
    and completes without warning when under the duration cap."""
    import theta_fetcher

    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW,VIX")

    fetched_roots: list[str] = []

    def fake_fetch(_client, root, start_date, end_date) -> int:
        fetched_roots.append(root)
        assert start_date == end_date  # nightly fetches a single day
        return 3

    monkeypatch.setattr(theta_fetcher, "_fetch_root_range", fake_fetch)
    msg_mock = MagicMock()
    monkeypatch.setattr(theta_fetcher, "capture_message", msg_mock)

    with patch("theta_fetcher.ThetaClient", return_value=MagicMock()):
        theta_fetcher.run_nightly()

    assert fetched_roots == ["SPXW", "VIX"]
    # Under the duration cap -> no warning fired.
    msg_mock.assert_not_called()


def test_run_nightly_captures_and_reraises_on_failure(monkeypatch) -> None:
    """An unexpected error mid-fetch is reported to Sentry with the
    nightly phase context, then re-raised for APScheduler to log."""
    import theta_fetcher

    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW")

    boom = RuntimeError("theta terminal vanished")
    monkeypatch.setattr(
        theta_fetcher,
        "_fetch_root_range",
        MagicMock(side_effect=boom),
    )

    capture_calls: list[tuple] = []
    monkeypatch.setattr(
        theta_fetcher,
        "capture_exception",
        lambda exc, **kw: capture_calls.append((exc, kw)),
    )

    with (
        patch("theta_fetcher.ThetaClient", return_value=MagicMock()),
        pytest.raises(RuntimeError, match="theta terminal vanished"),
    ):
        theta_fetcher.run_nightly()

    assert len(capture_calls) == 1
    exc, kw = capture_calls[0]
    assert exc is boom
    assert kw["context"]["phase"] == "theta_nightly"


def test_run_nightly_warns_when_over_max_duration(monkeypatch) -> None:
    """When elapsed exceeds MAX_JOB_DURATION_S, a warning Sentry message
    is emitted with the elapsed time and row count."""
    import theta_fetcher

    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW")
    monkeypatch.setattr(theta_fetcher, "_fetch_root_range", lambda *a, **k: 7)

    # Force a large elapsed: first time.time() call is the start anchor,
    # every subsequent call returns a moment well past the duration cap.
    clock = {"calls": 0}

    def fake_time() -> float:
        clock["calls"] += 1
        if clock["calls"] == 1:
            return 1000.0
        return 1000.0 + theta_fetcher.MAX_JOB_DURATION_S + 1

    monkeypatch.setattr(theta_fetcher.time, "time", fake_time)

    msg_calls: list[tuple] = []
    monkeypatch.setattr(
        theta_fetcher,
        "capture_message",
        lambda msg, **kw: msg_calls.append((msg, kw)),
    )

    with patch("theta_fetcher.ThetaClient", return_value=MagicMock()):
        theta_fetcher.run_nightly()

    assert len(msg_calls) == 1
    msg, kw = msg_calls[0]
    assert "exceeded max duration" in msg
    assert kw["level"] == "warning"
    assert kw["context"]["rows_written"] == 7


# ---------------------------------------------------------------------------
# run_backfill_if_needed — per-root failure is isolated, loop continues
# ---------------------------------------------------------------------------


def test_backfill_per_root_exception_is_captured_and_loop_continues(
    monkeypatch,
) -> None:
    """A failure on one root is captured to Sentry but must not stop the
    backfill from proceeding to the next root."""
    import theta_fetcher

    monkeypatch.setattr(theta_fetcher.settings, "theta_roots", "SPXW,VIX")
    monkeypatch.setattr(theta_fetcher.settings, "theta_backfill_days", 5)
    monkeypatch.setattr(theta_fetcher.db, "has_theta_option_eod_rows", lambda _root: False)

    processed: list[str] = []

    def fake_fetch(_client, root, _start, _end) -> int:
        processed.append(root)
        if root == "SPXW":
            raise RuntimeError("SPXW blew up")
        return 4

    monkeypatch.setattr(theta_fetcher, "_fetch_root_range", fake_fetch)

    capture_calls: list[tuple] = []
    monkeypatch.setattr(
        theta_fetcher,
        "capture_exception",
        lambda exc, **kw: capture_calls.append((exc, kw)),
    )

    with patch("theta_fetcher.ThetaClient", return_value=MagicMock()):
        theta_fetcher.run_backfill_if_needed()

    # Both roots attempted despite SPXW raising.
    assert processed == ["SPXW", "VIX"]
    # Exactly one capture, tagged with the backfill phase and the bad root.
    assert len(capture_calls) == 1
    _exc, kw = capture_calls[0]
    assert kw["context"]["phase"] == "theta_backfill"
    assert kw["context"]["root"] == "SPXW"


# ---------------------------------------------------------------------------
# Nightly observability constants — duration cap + declared Sentry monitor
# ---------------------------------------------------------------------------


def test_max_job_duration_is_three_hours() -> None:
    """The 2026-08-18 nightly took ~99 min (SPXW 55 min + VIX/VIXW + NDXP
    25 min) against the old 30 min cap, so every run fired the
    "exceeded max duration" warning. The cap is now 3h — comfortably above
    the observed steady-state so the warning means something again."""
    import theta_fetcher

    assert theta_fetcher.MAX_JOB_DURATION_S == 3 * 60 * 60
    assert theta_fetcher.MAX_JOB_DURATION_S == 10800


def test_nightly_monitor_config_declares_schedule_in_code() -> None:
    """The Sentry cron monitor is declared in code (monitor_config on the
    decorator) so the schedule/timezone/thresholds ship with the sidecar
    instead of living only in the Sentry UI. The crontab is the SAME 17:25
    the APScheduler trigger fires at, in the SAME zone — Sentry pages on a
    missed check-in relative to this schedule, so drift between the two
    would either page spuriously or never page."""
    import theta_fetcher

    cfg = theta_fetcher._NIGHTLY_MONITOR_CONFIG
    assert cfg["schedule"] == {"type": "crontab", "value": "25 17 * * *"}
    assert cfg["timezone"] == "America/New_York"
    assert cfg["checkin_margin"] == 10
    assert cfg["max_runtime"] == 180
    assert cfg["max_runtime"] >= 120
    assert cfg["failure_issue_threshold"] == 1
    assert cfg["recovery_threshold"] == 1


def test_nightly_monitor_max_runtime_covers_local_duration_cap() -> None:
    """Sentry's max_runtime (minutes) must be at least the local
    MAX_JOB_DURATION_S cap, otherwise Sentry marks the check-in timed-out
    (a failure) before our own "exceeded max duration" warning would fire,
    and the two signals disagree about what "too slow" means."""
    import theta_fetcher

    max_runtime_s = theta_fetcher._NIGHTLY_MONITOR_CONFIG["max_runtime"] * 60
    assert max_runtime_s >= theta_fetcher.MAX_JOB_DURATION_S


def test_run_nightly_is_decorated_with_slug_and_monitor_config() -> None:
    """run_nightly must be wrapped by ``sentry_sdk.monitor`` carrying BOTH
    the slug and the declared monitor_config — the constants alone prove
    nothing if the decorator call doesn't pass them.

    conftest.py installs an identity ``sentry_sdk.monitor`` (the SDK is a
    session-wide mock), so the decoration is only observable at module
    import. Swap in a recording decorator, reload the module to re-run
    the decoration, assert, then restore the identity decorator and
    reload again so sibling tests see the same module shape as before.
    """
    import importlib

    import theta_fetcher

    # A live scheduler would be orphaned by the reload's `_scheduler = None`.
    theta_fetcher.stop_scheduler()

    sentry_mod = sys.modules["sentry_sdk"]
    original_monitor = sentry_mod.monitor
    calls: list[dict] = []

    def recording_monitor(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return lambda fn: fn

    sentry_mod.monitor = recording_monitor
    try:
        importlib.reload(theta_fetcher)
        declared_cfg = theta_fetcher._NIGHTLY_MONITOR_CONFIG
        declared_slug = theta_fetcher._NIGHTLY_MONITOR_SLUG
    finally:
        sentry_mod.monitor = original_monitor
        importlib.reload(theta_fetcher)

    nightly_calls = [c for c in calls if c["kwargs"].get("monitor_slug") == declared_slug]
    assert len(nightly_calls) == 1
    kwargs = nightly_calls[0]["kwargs"]
    assert kwargs["monitor_slug"] == "theta-nightly-eod"
    assert kwargs["monitor_config"] is declared_cfg
    assert kwargs["monitor_config"]["schedule"]["value"] == "25 17 * * *"
    assert kwargs["monitor_config"]["timezone"] == "America/New_York"
