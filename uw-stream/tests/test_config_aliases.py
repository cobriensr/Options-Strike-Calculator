"""Tests for WS_CHANNELS alias handling.

The `flow-alerts` channel uses a HYPHEN even though the docs URL path
is `flow_alerts`. Almost everyone (Railway dashboard typos, copy-pastes
from REST docs) ends up with `WS_CHANNELS=flow_alerts`, which the
daemon then can't match to its `flow-alerts` handler. We canonicalize
in `Settings.channels` so either form boots.
"""

from __future__ import annotations

import pytest

from config import Settings


def _settings(channels_env: str) -> Settings:
    """Build a Settings instance with the channels env override."""
    return Settings(
        database_url="postgresql://test",
        uw_api_key="test",
        ws_channels=channels_env,
    )


class TestChannelAliases:
    def test_canonical_form_unchanged(self):
        assert _settings("flow-alerts").channels == ["flow-alerts"]

    def test_underscore_aliased_to_hyphen(self):
        # The Railway-dashboard footgun: typed `flow_alerts`, expected
        # to work since that's what the URL path looks like.
        assert _settings("flow_alerts").channels == ["flow-alerts"]

    def test_dedupes_after_aliasing(self):
        # Both forms collapse to one canonical entry.
        assert _settings("flow_alerts,flow-alerts").channels == ["flow-alerts"]

    def test_unknown_channel_name_passes_through(self):
        # Other channels (gex, market_tide, etc.) aren't in the alias
        # map and should pass through unchanged.
        assert _settings("market_tide").channels == ["market_tide"]

    def test_whitespace_trimmed(self):
        assert _settings(" flow_alerts , market_tide ").channels == [
            "flow-alerts",
            "market_tide",
        ]

    def test_empty_channels_raises(self):
        with pytest.raises(ValueError, match="empty list"):
            _ = _settings(",").channels


class TestLotteryShorthand:
    """`option_trades_lottery` expands inline to one option_trades:<TICKER>
    channel per ticker in the Lottery Finder universe."""

    def test_shorthand_expands_to_per_ticker_channels(self):
        channels = _settings("option_trades_lottery").channels
        # Universe is V3 + EXTENDED (set-deduped) — ~50 tickers.
        assert len(channels) >= 40
        assert all(c.startswith("option_trades:") for c in channels)
        # Sorted for stable order — assert SNDK, SPY, META all present.
        tickers = [c.removeprefix("option_trades:") for c in channels]
        assert "SNDK" in tickers
        assert "SPY" in tickers
        assert "META" in tickers

    def test_sorted_for_stable_order(self):
        channels = _settings("option_trades_lottery").channels
        tickers = [c.removeprefix("option_trades:") for c in channels]
        assert tickers == sorted(tickers)

    def test_combines_with_flow_alerts(self):
        channels = _settings("flow-alerts,option_trades_lottery").channels
        assert channels[0] == "flow-alerts"
        assert all(c.startswith("option_trades:") for c in channels[1:])

    def test_explicit_ticker_dedupes_against_shorthand(self):
        # If the user lists option_trades_lottery AND a per-ticker
        # entry, the per-ticker one shouldn't appear twice.
        channels = _settings(
            "option_trades:SNDK,option_trades_lottery",
        ).channels
        sndk_count = sum(1 for c in channels if c == "option_trades:SNDK")
        assert sndk_count == 1
