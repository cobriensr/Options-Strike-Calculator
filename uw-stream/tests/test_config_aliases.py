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
