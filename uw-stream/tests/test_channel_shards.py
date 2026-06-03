"""Tests for Settings.channel_shards — the per-connection channel split.

UW caps channels at 50 PER CONNECTION, so the universe is sharded across N WS
connections. These pin the invariants the connector + main wiring rely on:
every shard <= PER_CONN_MAX, no channel lost or duplicated, deterministic, and
family-contiguous (a shard holds one per-ticker family so a socket drop degrades
one family slice).
"""

from __future__ import annotations

from config import PER_CONN_MAX, Settings

FULL_LOTTERY = (
    "flow-alerts,off_lit_trades,option_trades_lottery,"
    "net_flow_lottery,gex_strike_expiry_lottery"
)


def _settings(channels_env: str, cap: int | None = None) -> Settings:
    kwargs = {
        "database_url": "postgresql://test",
        "uw_api_key": "test",
        "ws_channels": channels_env,
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
        assert all(
            {c.split(":", 1)[0] for c in s} == {"option_trades"} for s in shards
        )
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
        shards = _settings(FULL_LOTTERY, cap=25).channel_shards
        assert all(len(s) <= 25 for s in shards)
        flat = [c for s in shards for c in s]
        assert sorted(flat) == sorted(_settings(FULL_LOTTERY).channels)
