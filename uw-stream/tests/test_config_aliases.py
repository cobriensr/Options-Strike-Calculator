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

    def test_unknown_channel_rejected_at_settings_construction(self):
        # Typo in WS_CHANNELS (missing 'e' in 'lottery') is not a known
        # alias, exact channel, or prefix — must fail at construction so
        # the operator sees a clear startup error, not an empty handler
        # table at runtime.
        with pytest.raises(ValueError, match="unknown channel"):
            _settings("option_trades_lottry")

    def test_whitespace_trimmed(self):
        # Both tokens are registered channels; whitespace around commas
        # and outside tokens must be stripped before alias resolution
        # and registry lookup.
        assert _settings(" flow_alerts , off_lit_trades ").channels == [
            "flow-alerts",
            "off_lit_trades",
        ]

    def test_empty_channels_raises(self):
        # Empty resolution now fails at Settings() construction, not at
        # .channels property access — see model_validator in config.py.
        with pytest.raises(ValueError, match="empty list"):
            _settings(",")

    def test_empty_channels_raises_at_construction(self):
        # Regression: the empty-list check must fire during Settings()
        # construction (pydantic model_validator), not on first
        # .channels read. Previously the property accessor raised, which
        # fragmented the error path.
        with pytest.raises(ValueError, match="WS_CHANNELS"):
            _settings("")


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


class TestNetFlowLotteryShorthand:
    """`net_flow_lottery` expands the same universe as
    option_trades_lottery but as net_flow:<TICKER> channels."""

    def test_shorthand_expands_to_per_ticker_channels(self):
        channels = _settings("net_flow_lottery").channels
        # Universe is V3 + EXTENDED (set-deduped) — ~50 tickers.
        assert len(channels) >= 40
        assert all(c.startswith("net_flow:") for c in channels)

    def test_combines_with_option_trades_lottery_no_collision(self):
        # Both shorthands target the same ticker set but different
        # channel families, so total = 2x per-ticker count.
        only_options = _settings("option_trades_lottery").channels
        combined = _settings(
            "option_trades_lottery,net_flow_lottery",
        ).channels
        assert len(combined) == 2 * len(only_options)
        assert any(c.startswith("option_trades:") for c in combined)
        assert any(c.startswith("net_flow:") for c in combined)

    def test_explicit_per_ticker_dedupes_against_shorthand(self):
        channels = _settings("net_flow:TSLA,net_flow_lottery").channels
        tsla_count = sum(1 for c in channels if c == "net_flow:TSLA")
        assert tsla_count == 1


class TestGexStrikeExpiryLotteryShorthand:
    """`gex_strike_expiry_lottery` expands the same universe as
    option_trades_lottery + net_flow_lottery but as
    gex_strike_expiry:<TICKER> channels. Feeds the Greek Heatmap
    section — see
    docs/superpowers/specs/per-ticker-greek-heatmap-2026-05-15.md."""

    def test_shorthand_expands_to_per_ticker_channels(self):
        channels = _settings("gex_strike_expiry_lottery").channels
        # Universe is V3 + EXTENDED (set-deduped) — ~50 tickers.
        assert len(channels) >= 40
        assert all(c.startswith("gex_strike_expiry:") for c in channels)
        tickers = [c.removeprefix("gex_strike_expiry:") for c in channels]
        # Spot-check a representative slice of the universe — confirms
        # the same _LOTTERY_TICKERS set is being expanded as for the
        # other two lottery shorthands.
        assert "SPY" in tickers
        assert "TSLA" in tickers
        assert "SPXW" in tickers

    def test_sorted_for_stable_order(self):
        channels = _settings("gex_strike_expiry_lottery").channels
        tickers = [c.removeprefix("gex_strike_expiry:") for c in channels]
        assert tickers == sorted(tickers)

    def test_same_ticker_count_as_other_lottery_shorthands(self):
        # All three lottery shorthands must expand to the SAME ticker
        # set — that's the cross-channel alignment guarantee. If
        # _LOTTERY_TICKERS changes, all three counts move together.
        options = _settings("option_trades_lottery").channels
        netflow = _settings("net_flow_lottery").channels
        gex = _settings("gex_strike_expiry_lottery").channels
        assert len(options) == len(netflow) == len(gex)

    def test_combines_with_other_lottery_shorthands(self):
        # All three shorthands at once = 3x per-ticker count, with each
        # channel family represented.
        only_options = _settings("option_trades_lottery").channels
        combined = _settings(
            "option_trades_lottery,net_flow_lottery,gex_strike_expiry_lottery",
        ).channels
        assert len(combined) == 3 * len(only_options)
        assert any(c.startswith("option_trades:") for c in combined)
        assert any(c.startswith("net_flow:") for c in combined)
        assert any(c.startswith("gex_strike_expiry:") for c in combined)

    def test_explicit_per_ticker_dedupes_against_shorthand(self):
        channels = _settings(
            "gex_strike_expiry:TSLA,gex_strike_expiry_lottery",
        ).channels
        tsla_count = sum(1 for c in channels if c == "gex_strike_expiry:TSLA")
        assert tsla_count == 1
