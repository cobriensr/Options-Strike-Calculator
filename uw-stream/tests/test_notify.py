"""Unit tests for notify_alert + build_payload.

The HTTP path is mocked at aiohttp.ClientSession.post so no real
network IO happens.  build_payload is exercised against the alert-row
shape produced by SPXWIntervalBAHandler._build_alert_row.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import notify
from handlers.interval_ba import _ALERT_COLUMNS
from notify import build_payload, close_session, drain_pending, notify_alert


@pytest.fixture(autouse=True)
def _reset_shared_session():
    """Reset the module-level shared ClientSession between tests.

    notify caches one session for the process lifetime; without this the
    mock from one test (or a session bound to a closed event loop) would
    leak into the next.
    """
    notify._session = None
    yield
    notify._session = None

# Mirror the alert tuple shape from SPXWIntervalBAHandler. NOT every
# field is used by the payload formatter — the rest are passed through
# for the DB write — but the test fixture must populate the full tuple
# so build_payload's index lookups all succeed.
_FIXTURE_ROW = (
    "SPXW260512C07360000",            # option_chain
    "SPXW",                           # ticker
    "C",                              # option_type
    Decimal("7360.000"),              # strike
    date(2026, 5, 12),                # expiry
    datetime(2026, 5, 12, 17, 5, tzinfo=UTC),   # bucket_start
    datetime(2026, 5, 12, 17, 10, tzinfo=UTC),  # bucket_end
    datetime(2026, 5, 12, 17, 6, 24, tzinfo=UTC),  # fired_at
    Decimal("71.23"),                 # ratio_pct
    Decimal("950000.00"),             # ask_premium
    Decimal("1330000.00"),            # total_premium
    5,                                # trade_count
    Decimal("408480.00"),             # top_trade_premium
    888,                              # top_trade_size
    datetime(2026, 5, 12, 17, 6, 23, tzinfo=UTC),  # top_trade_executed_at
    True,                             # top_trade_is_sweep
    False,                            # top_trade_is_floor
    Decimal("7355.00"),               # underlying_price
    [],                               # confluence_tickers — solo by default
)


class TestBuildPayload:
    def test_title_format(self):
        payload = build_payload(_FIXTURE_ROW, _ALERT_COLUMNS)
        assert payload["title"] == "SPXW 7360C 71% ASK"

    def test_body_format_with_million_premium(self):
        payload = build_payload(_FIXTURE_ROW, _ALERT_COLUMNS)
        assert payload["body"] == "$1.33M premium / 5 trades — top: $408K sweep"

    def test_body_format_with_sub_million_premium(self):
        # Mutate a copy: total $408K, single ASK trade.
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["total_premium"]] = Decimal("408480.00")
        row[idx["trade_count"]] = 1
        row[idx["top_trade_is_sweep"]] = True
        row[idx["top_trade_is_floor"]] = False
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload["body"] == "$408K premium / 1 trade — top: $408K sweep"

    def test_body_omits_top_trade_clause_when_null(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["top_trade_premium"]] = None
        row[idx["top_trade_size"]] = None
        row[idx["top_trade_is_sweep"]] = None
        row[idx["top_trade_is_floor"]] = None
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert "top:" not in payload["body"]
        assert "$1.33M premium / 5 trades" in payload["body"]

    def test_body_renders_floor_flag(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["top_trade_is_sweep"]] = False
        row[idx["top_trade_is_floor"]] = True
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert "floor" in payload["body"]
        assert "sweep" not in payload["body"]

    def test_tag_includes_option_chain(self):
        payload = build_payload(_FIXTURE_ROW, _ALERT_COLUMNS)
        assert payload["tag"] == "interval-ba-SPXW260512C07360000"

    def test_require_interaction_true_for_extreme(self):
        # $1.33M total → severity 'extreme' → requireInteraction True.
        payload = build_payload(_FIXTURE_ROW, _ALERT_COLUMNS)
        assert payload["requireInteraction"] is True

    def test_require_interaction_false_for_warning(self):
        # Lower total to below $500K → 'warning' tier.
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["total_premium"]] = Decimal("260000.00")
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload["requireInteraction"] is False

    def test_require_interaction_true_for_critical(self):
        # $750K → 'critical' tier → requireInteraction True.
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["total_premium"]] = Decimal("750000.00")
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload["requireInteraction"] is True

    def test_put_option_type_in_title(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["option_type"]] = "P"
        row[idx["strike"]] = Decimal("7350.000")
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload["title"] == "SPXW 7350P 71% ASK"

    def test_fractional_strike_preserved_in_title(self):
        """Half-dollar strikes must show the fraction, not round to the
        nearest dollar (the old ``:.0f`` would render 7360.5 as '7360')."""
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["strike"]] = Decimal("7360.500")
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload["title"] == "SPXW 7360.5C 71% ASK"


class TestConfluenceDecoration:
    """Phase 4: title decorates with +TICKER suffix(es) when the
    confluence_tickers column is populated. confluence_only=True
    skips solo fires entirely (returns None)."""

    def test_solo_alert_title_has_no_partner_suffix(self):
        # Fixture defaults confluence_tickers=[] — pure solo.
        payload = build_payload(_FIXTURE_ROW, _ALERT_COLUMNS)
        assert payload is not None
        assert payload["title"] == "SPXW 7360C 71% ASK"
        assert "+" not in payload["title"]

    def test_one_partner_appends_single_suffix(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["confluence_tickers"]] = ["SPY"]
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload is not None
        assert payload["title"] == "SPXW 7360C 71% ASK +SPY"

    def test_two_partners_append_both_suffixes_sorted(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        # Insertion order reversed to confirm the formatter sorts.
        row[idx["confluence_tickers"]] = ["SPY", "QQQ"]
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload is not None
        # QQQ sorts before SPY alphabetically.
        assert payload["title"] == "SPXW 7360C 71% ASK +QQQ +SPY"

    def test_none_value_treated_as_solo(self):
        """Legacy rows (pre-migration #147) may have NULL → Python None."""
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["confluence_tickers"]] = None
        payload = build_payload(tuple(row), _ALERT_COLUMNS)
        assert payload is not None
        assert payload["title"] == "SPXW 7360C 71% ASK"

    def test_confluence_only_true_returns_none_for_solo(self):
        payload = build_payload(
            _FIXTURE_ROW, _ALERT_COLUMNS, confluence_only=True,
        )
        assert payload is None

    def test_confluence_only_true_returns_payload_for_partnered(self):
        row = list(_FIXTURE_ROW)
        idx = {n: i for i, n in enumerate(_ALERT_COLUMNS)}
        row[idx["confluence_tickers"]] = ["SPY"]
        payload = build_payload(
            tuple(row), _ALERT_COLUMNS, confluence_only=True,
        )
        assert payload is not None
        assert "+SPY" in payload["title"]

    def test_confluence_only_false_returns_payload_for_solo(self):
        """Backward-compat: pre-Phase-4 callers don't pass the kwarg."""
        payload = build_payload(
            _FIXTURE_ROW, _ALERT_COLUMNS, confluence_only=False,
        )
        assert payload is not None
        assert payload["title"] == "SPXW 7360C 71% ASK"


class TestNotifyAlertDormantState:
    """When VERCEL_NOTIFY_URL or INTERNAL_NOTIFY_SECRET is empty, the
    notifier must no-op silently — no HTTP call, no Sentry event."""

    @pytest.mark.asyncio
    async def test_noops_when_url_empty(self, monkeypatch):
        monkeypatch.setattr("notify.settings.vercel_notify_url", "")
        monkeypatch.setattr(
            "notify.settings.internal_notify_secret", "non-empty",
        )
        with patch("aiohttp.ClientSession") as mock_session:
            await notify_alert({"title": "x", "body": "y"})
        mock_session.assert_not_called()

    @pytest.mark.asyncio
    async def test_noops_when_secret_empty(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url",
            "https://example.com/notify",
        )
        monkeypatch.setattr("notify.settings.internal_notify_secret", "")
        with patch("aiohttp.ClientSession") as mock_session:
            await notify_alert({"title": "x", "body": "y"})
        mock_session.assert_not_called()


class TestNotifyAlertHttpPath:
    """When both env vars are set, notifier POSTs the payload."""

    @pytest.mark.asyncio
    async def test_posts_payload_with_secret_header(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url",
            "https://example.com/api/push/notify",
        )
        monkeypatch.setattr(
            "notify.settings.internal_notify_secret", "my-secret",
        )

        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.text = AsyncMock(return_value="")
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("aiohttp.ClientSession", return_value=mock_session):
            await notify_alert(
                {"title": "SPXW 7360C 71% ASK", "body": "$1.33M premium"},
            )

        mock_session.post.assert_called_once()
        call_kwargs = mock_session.post.call_args
        # Endpoint URL.
        assert call_kwargs.args[0] == "https://example.com/api/push/notify"
        # Secret header carried verbatim.
        headers = call_kwargs.kwargs["headers"]
        assert headers["x-internal-notify-secret"] == "my-secret"
        # JSON body.
        assert call_kwargs.kwargs["json"] == {
            "title": "SPXW 7360C 71% ASK",
            "body": "$1.33M premium",
        }

    @pytest.mark.asyncio
    async def test_swallows_4xx_after_logging(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr(
            "notify.settings.internal_notify_secret", "s",
        )

        mock_resp = MagicMock()
        mock_resp.status = 401
        mock_resp.text = AsyncMock(return_value="Unauthorized")
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        # Must not raise — 4xx is logged + Sentry'd but swallowed.
        with patch("aiohttp.ClientSession", return_value=mock_session):
            await notify_alert({"title": "x", "body": "y"})

    @pytest.mark.asyncio
    async def test_swallows_network_exception(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr(
            "notify.settings.internal_notify_secret", "s",
        )

        def raise_on_create(*_args, **_kwargs):
            raise OSError("connection refused")

        with patch("aiohttp.ClientSession", side_effect=raise_on_create):
            # Must not raise even on hard network failure.
            await notify_alert({"title": "x", "body": "y"})


class TestSentryThrottle:
    """Both the 4xx and exception paths must Sentry the first occurrence
    of a given failure mode per process, then suppress duplicates. This
    matches the existing comment intent and prevents a misconfigured
    secret from producing 59+ Sentry events in a day."""

    @pytest.fixture(autouse=True)
    def reset_seen(self):
        from notify import _SENTRY_SEEN
        _SENTRY_SEEN.clear()
        yield
        _SENTRY_SEEN.clear()

    @pytest.mark.asyncio
    async def test_4xx_sentry_throttles_to_one_per_status(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr("notify.settings.internal_notify_secret", "s")

        mock_resp = MagicMock()
        mock_resp.status = 401
        mock_resp.text = AsyncMock(return_value="Unauthorized")
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_resp)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("aiohttp.ClientSession", return_value=mock_session),
            patch("notify.capture_message") as mock_capture,
        ):
            for _ in range(5):
                await notify_alert({"title": "x", "body": "y"})

        assert mock_capture.call_count == 1

    @pytest.mark.asyncio
    async def test_different_status_codes_each_report_once(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr("notify.settings.internal_notify_secret", "s")

        # First two calls return 401, next two return 503 — verify each
        # distinct status gets its own (single) Sentry event.
        statuses = [401, 401, 503, 503]
        responses = []
        for status in statuses:
            r = MagicMock()
            r.status = status
            r.text = AsyncMock(return_value="boom")
            r.__aenter__ = AsyncMock(return_value=r)
            r.__aexit__ = AsyncMock(return_value=False)
            responses.append(r)

        mock_session = MagicMock()
        mock_session.post = MagicMock(side_effect=responses)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("aiohttp.ClientSession", return_value=mock_session),
            patch("notify.capture_message") as mock_capture,
        ):
            for _ in statuses:
                await notify_alert({"title": "x", "body": "y"})

        assert mock_capture.call_count == 2
        statuses_reported = {
            call.kwargs["tags"]["status"]
            for call in mock_capture.call_args_list
        }
        assert statuses_reported == {"401", "503"}

    @pytest.mark.asyncio
    async def test_exception_sentry_throttles_to_one_per_class(
        self, monkeypatch,
    ):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr("notify.settings.internal_notify_secret", "s")

        def raise_oserror(*_args, **_kwargs):
            raise OSError("connection refused")

        with (
            patch("aiohttp.ClientSession", side_effect=raise_oserror),
            patch("notify.capture_exception") as mock_capture,
        ):
            for _ in range(5):
                await notify_alert({"title": "x", "body": "y"})

        assert mock_capture.call_count == 1


class TestSharedSession:
    """The ClientSession is created once and reused, then closed on
    shutdown — instead of a fresh session (connector + DNS) per call."""

    @pytest.mark.asyncio
    async def test_session_created_once_and_reused(self, monkeypatch):
        monkeypatch.setattr(
            "notify.settings.vercel_notify_url", "https://example.com/x",
        )
        monkeypatch.setattr("notify.settings.internal_notify_secret", "s")

        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.text = AsyncMock(return_value="")
        mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
        mock_resp.__aexit__ = AsyncMock(return_value=False)

        mock_session = MagicMock()
        mock_session.closed = False  # a live, reusable session
        mock_session.post = MagicMock(return_value=mock_resp)

        with patch(
            "aiohttp.ClientSession", return_value=mock_session,
        ) as ctor:
            await notify_alert({"title": "x", "body": "y"})
            await notify_alert({"title": "x", "body": "y"})

        # One session constructed, two POSTs through it.
        assert ctor.call_count == 1
        assert mock_session.post.call_count == 2

    @pytest.mark.asyncio
    async def test_close_session_closes_and_clears(self, monkeypatch):
        mock_session = MagicMock()
        mock_session.closed = False
        mock_session.close = AsyncMock()
        monkeypatch.setattr("notify._session", mock_session)

        await close_session()

        mock_session.close.assert_awaited_once()
        assert notify._session is None

    @pytest.mark.asyncio
    async def test_close_session_safe_when_unset(self):
        notify._session = None
        await close_session()  # must not raise
        assert notify._session is None


class TestDrainPending:
    """Fire-and-forget notify tasks are awaited before shutdown so the
    final batch's notifications aren't cancelled mid-flight."""

    @pytest.mark.asyncio
    async def test_drain_awaits_in_flight_tasks(self):
        notify._BACKGROUND_TASKS.clear()
        done: list[bool] = []

        async def _work() -> None:
            await asyncio.sleep(0)
            done.append(True)

        task = asyncio.create_task(_work())
        notify._BACKGROUND_TASKS.add(task)
        task.add_done_callback(notify._BACKGROUND_TASKS.discard)

        await drain_pending(timeout=1.0)

        assert done == [True]
        assert not notify._BACKGROUND_TASKS

    @pytest.mark.asyncio
    async def test_drain_noop_when_no_tasks(self):
        notify._BACKGROUND_TASKS.clear()
        await drain_pending(timeout=0.1)  # returns immediately, no raise

    @pytest.mark.asyncio
    async def test_drain_bounded_by_timeout(self):
        notify._BACKGROUND_TASKS.clear()

        async def _slow() -> None:
            await asyncio.sleep(5)

        task = asyncio.create_task(_slow())
        notify._BACKGROUND_TASKS.add(task)
        task.add_done_callback(notify._BACKGROUND_TASKS.discard)

        # Must return within the deadline rather than blocking on _slow.
        await drain_pending(timeout=0.01)
        task.cancel()
