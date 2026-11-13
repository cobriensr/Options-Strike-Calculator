"""Tests for Settings.channel_shards — the per-connection channel split.

UW caps channels at 50 PER CONNECTION, so the universe is sharded across N WS
connections. These pin the invariants the connector + main wiring rely on:
every shard <= PER_CONN_MAX, no channel lost or duplicated, deterministic, and
family-contiguous (a shard holds one per-ticker family so a socket drop degrades
one family slice).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from config import PER_CONN_MAX, UW_MAX_CONNECTIONS, Settings

FULL_LOTTERY = (
    "flow-alerts,off_lit_trades,option_trades_lottery,net_flow_lottery,gex_strike_expiry_lottery"
)

# Production WS_CHANNELS (Railway, checked 2026-10-29; see README "Channels").
PRODUCTION = (
    "flow-alerts,off_lit_trades,option_trades_lottery,gex_strike_expiry:SPY,"
    "gex_strike_expiry:QQQ,gex_strike_expiry:SPX,gex_strike_expiry:NDX,"
    "net_flow_lottery,gex_strike_expiry_lottery,futures_trades"
)


def _settings(channels_env: str, cap: int | None = None, *, mirrors: bool = False) -> Settings:
    """Settings for the shard layout. Mirror shards are off unless asked for, so
    the tests below that predate them keep pinning the base layout."""
    kwargs = {
        "database_url": "postgresql://test",
        "uw_api_key": "test",
        "ws_channels": channels_env,
        "ws_redundant_option_trades": mirrors,
    }
    if cap is not None:
        kwargs["ws_max_channels_per_conn"] = cap
    return Settings(**kwargs)


class TestChannelShards:
    def test_single_channel_is_one_shard(self):
        shards = _settings("flow-alerts").channel_shards
        assert shards == [["flow-alerts"]]

    def test_globals_only_one_shard(self):
        shards = _settings("flow-alerts,off_lit_trades").channel_shards
        assert len(shards) == 1
        assert sorted(shards[0]) == ["flow-alerts", "off_lit_trades"]

    def test_full_universe_respects_per_conn_cap(self):
        shards = _settings(FULL_LOTTERY).channel_shards
        assert shards, "expected at least one shard"
        assert all(len(s) <= PER_CONN_MAX for s in shards)

    def test_no_channel_lost_or_duplicated(self):
        s = _settings(FULL_LOTTERY)
        flat = [c for shard in s.channel_shards for c in shard]
        assert sorted(flat) == sorted(s.channels)
        assert len(flat) == len(s.channels)  # no duplicates

    def test_deterministic(self):
        # Two independent builds (and a fresh Settings) must shard identically
        # so a reconnect re-subscribes the exact same per-connection set.
        first = _settings(FULL_LOTTERY).channel_shards
        second = _settings(FULL_LOTTERY).channel_shards
        assert first == second

    def test_each_shard_is_family_contiguous(self):
        # A shard's per-ticker channels all share one family prefix (globals,
        # which carry no ':', may also ride along on one shard).
        for shard in _settings(FULL_LOTTERY).channel_shards:
            families = {c.split(":", 1)[0] for c in shard if ":" in c}
            assert len(families) <= 1, f"shard mixes families: {families}"

    def test_family_larger_than_cap_chunks_into_multiple_shards(self):
        # option_trades_lottery alone = 86 tickers > PER_CONN_MAX(45), so it
        # must split into ceil(86/45)=2 shards, each <= cap, both same family.
        shards = _settings("option_trades_lottery").channel_shards
        assert len(shards) >= 2
        assert all(len(s) <= PER_CONN_MAX for s in shards)
        assert all({c.split(":", 1)[0] for c in s} == {"option_trades"} for s in shards)
        flat = [c for s in shards for c in s]
        assert len(flat) == len(set(flat))  # no duplicate across chunks

    def test_globals_folded_into_a_shard(self):
        # flow-alerts + off_lit_trades must appear exactly once across shards.
        flat = [c for shard in _settings(FULL_LOTTERY).channel_shards for c in shard]
        assert flat.count("flow-alerts") == 1
        assert flat.count("off_lit_trades") == 1

    def test_configurable_cap_changes_shard_sizes(self):
        # WS_MAX_CHANNELS_PER_CONN lets us retune when UW raises/removes the 50
        # cap. A smaller cap must produce more, smaller shards; a larger one
        # fewer, larger — with no channel lost either way.
        tight = _settings("option_trades_lottery", cap=10).channel_shards
        loose = _settings("option_trades_lottery", cap=200).channel_shards
        assert all(len(s) <= 10 for s in tight)
        assert len(tight) > len(loose)
        # cap=200 > 86 tickers → single shard.
        assert len(loose) == 1
        # No loss under either cap.
        for shards in (tight, loose):
            flat = [c for s in shards for c in s]
            assert len(flat) == len(set(flat)) == 86

    def test_cap_respected_for_full_universe_override(self):
        # 30 keeps the three 86-ticker families at 3 shards each (9 sockets),
        # inside UW's 10-connection cap that Settings() enforces.
        shards = _settings(FULL_LOTTERY, cap=30).channel_shards
        assert all(len(s) <= 30 for s in shards)
        flat = [c for s in shards for c in s]
        assert sorted(flat) == sorted(_settings(FULL_LOTTERY).channels)


def _option_trades_channels(settings: Settings) -> list[str]:
    return [c for c in settings.channels if c.startswith("option_trades:")]


class TestRedundantOptionTradeShards:
    """Mirror shards: every option_trades:<TICKER> channel on a second set of
    sockets, appended after the existing shards (spec
    uw-stream-redundant-trade-sockets-2026-11-13.md)."""

    def test_default_is_on(self):
        s = Settings(database_url="postgresql://test", uw_api_key="test")
        assert s.ws_redundant_option_trades is True

    def test_env_var_is_the_kill_switch(self, monkeypatch):
        monkeypatch.setenv("WS_REDUNDANT_OPTION_TRADES", "false")
        s = Settings(database_url="postgresql://test", uw_api_key="test")
        assert s.ws_redundant_option_trades is False

    def test_off_gives_todays_six_shards_exactly(self):
        shards = _settings(PRODUCTION).channel_shards
        assert [len(s) for s in shards] == [45, 44, 45, 43, 45, 41]
        # conn0-conn5: option_trades 45 + 41 (+ the 3 globals), gex 45 + 43,
        # net_flow 45 + 41 (README, Architecture).
        families = [{c.split(":", 1)[0] for c in s if ":" in c} for s in shards]
        assert families == [
            {"option_trades"},
            {"option_trades"},
            {"gex_strike_expiry"},
            {"gex_strike_expiry"},
            {"net_flow"},
            {"net_flow"},
        ]
        assert {"flow-alerts", "off_lit_trades", "futures_trades"} <= set(shards[1])

    def test_on_appends_two_mirrors_after_the_unchanged_six(self):
        off = _settings(PRODUCTION).channel_shards
        on = _settings(PRODUCTION, mirrors=True).channel_shards

        assert len(on) == 8
        assert on[:6] == off  # conn0-conn5: same channels, same order
        assert [len(s) for s in on[6:]] == [45, 41]  # conn6, conn7

    def test_mirrors_hold_only_per_ticker_option_trades_and_no_globals(self):
        on = _settings(PRODUCTION, mirrors=True)
        mirrors = on.channel_shards[6:]

        assert mirrors
        for shard in mirrors:
            assert all(c.startswith("option_trades:") for c in shard)

    def test_mirrors_cover_every_option_trades_channel_once_in_order(self):
        on = _settings(PRODUCTION, mirrors=True)
        mirrored = [c for shard in on.channel_shards[6:] for c in shard]

        assert mirrored == _option_trades_channels(on)
        assert len(mirrored) == 86

    def test_mirrors_are_chunked_at_the_per_connection_cap(self):
        s = _settings("option_trades_lottery", cap=30, mirrors=True)
        mirrors = s.channel_shards[3:]  # 3 primary shards of 30 + 30 + 26

        assert [len(m) for m in mirrors] == [30, 30, 26]

    def test_mirrors_are_deterministic(self):
        first = _settings(PRODUCTION, mirrors=True).channel_shards
        second = _settings(PRODUCTION, mirrors=True).channel_shards
        assert first == second

    def test_mirror_lists_are_separate_from_the_primary_lists(self):
        on = _settings(PRODUCTION, mirrors=True).channel_shards
        assert all(on[6] is not shard and on[7] is not shard for shard in on[:6])
        on[6].clear()
        assert len(on[0]) == 45

    def test_channels_property_is_unchanged_by_mirrors(self):
        # Handlers, join bookkeeping and the subscription watchdog key off
        # `channels`; a mirror joins the same channel names a second time.
        assert (
            _settings(PRODUCTION, mirrors=True).channels
            == _settings(PRODUCTION, mirrors=False).channels
        )

    @pytest.mark.parametrize(
        "channels_env",
        ["flow-alerts", "net_flow_lottery", "gex_strike_expiry_lottery", "futures_trades"],
    )
    def test_no_option_trades_channels_means_no_mirrors(self, channels_env):
        assert (
            _settings(channels_env, mirrors=True).channel_shards
            == _settings(channels_env).channel_shards
        )

    def test_interval_ba_channels_are_mirrored(self):
        # SPY, SPXW and QQQ feed the Interval B/A handlers, which aggregate in
        # memory; their dedupe is what makes mirroring them safe.
        on = _settings(PRODUCTION, mirrors=True)
        mirrored = {c for shard in on.channel_shards[6:] for c in shard}
        assert {"option_trades:SPY", "option_trades:SPXW", "option_trades:QQQ"} <= mirrored

    def test_production_layout_stays_within_uw_connection_cap(self):
        assert len(_settings(PRODUCTION, mirrors=True).channel_shards) <= UW_MAX_CONNECTIONS

    def test_exactly_the_cap_is_allowed(self):
        # 5 primary + 5 mirror shards of 18, 18, 18, 18, 14.
        s = _settings("option_trades_lottery", cap=18, mirrors=True)
        assert len(s.channel_shards) == UW_MAX_CONNECTIONS

    def test_over_the_cap_fails_at_construction_with_mirrors(self):
        # 6 primary + 6 mirror shards would be 12 sockets against UW's 10.
        with pytest.raises(ValidationError, match=r"12 .*10"):
            _settings("option_trades_lottery", cap=17, mirrors=True)

    def test_mirrors_off_would_have_fit_the_same_config(self):
        assert len(_settings("option_trades_lottery", cap=17).channel_shards) == 6

    def test_cap_error_names_the_ways_out(self):
        with pytest.raises(ValidationError) as excinfo:
            _settings("option_trades_lottery", cap=10, mirrors=True)
        text = str(excinfo.value)
        assert "WS_REDUNDANT_OPTION_TRADES" in text
        assert "WS_MAX_CHANNELS_PER_CONN" in text

    def test_cap_applies_without_mirrors_too(self):
        # 13 shards of 7 channels: over the cap whatever the switch says.
        with pytest.raises(ValidationError, match="10"):
            _settings("option_trades_lottery", cap=7)
