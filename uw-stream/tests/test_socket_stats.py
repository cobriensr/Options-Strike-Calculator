"""Tests for socket_stats: per-socket frame counters and the twin-silence warning.

Every option_trades:<TICKER> channel is joined on two sockets (conn0 and conn6,
conn1 and conn7), so a socket that goes quiet while its twin keeps receiving has
missed frames the twin did not. These pin the counting, the twin map, and the
ring arithmetic the warning depends on: the strictly-inside window, the
absolute-bucket stamps that stop an old slot from aliasing into a new window,
and the ring wrap.

Times are monotonic-style seconds. ``_B`` is a bucket boundary (0.1 s buckets),
so ``_B + 0.05`` is the middle of a bucket and no test sits on a rounding edge.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

import socket_stats
from config import Settings
from socket_stats import (
    BUCKETS_PER_S,
    RING_BUCKETS,
    SILENCE_S,
    TWIN_MIN_FRAMES,
    SocketStats,
    twin_map,
)

_B = 1000.0

TRADE = '["option_trades:SPY",{"id":"a","price":"1.05"}]'
TRADE_BYTES = TRADE.encode()
OTHER = '["flow-alerts",{"id":"b"}]'

# The production WS_CHANNELS (README "Channels"), so the layout test sees the
# real shards, mirrors included.
PRODUCTION = (
    "flow-alerts,off_lit_trades,option_trades_lottery,gex_strike_expiry:SPY,"
    "gex_strike_expiry:QQQ,gex_strike_expiry:SPX,gex_strike_expiry:NDX,"
    "net_flow_lottery,gex_strike_expiry_lottery,futures_trades"
)


@pytest.fixture(autouse=True)
def _fresh_registry(monkeypatch):
    """Every test starts with an empty registry and no twins."""
    monkeypatch.setattr(socket_stats, "_registry", {})
    monkeypatch.setattr(socket_stats, "_twins", {})


@pytest.fixture
def pair() -> tuple[SocketStats, SocketStats]:
    """conn0 and its twin conn1, registered and linked."""
    socket_stats.set_twins({"conn0": "conn1", "conn1": "conn0"})
    return socket_stats.get("conn0"), socket_stats.get("conn1")


def _feed(stats: SocketStats, times: list[float], raw: str | bytes = TRADE) -> None:
    for t in times:
        stats.on_frame(raw, t)


def _spread(first: float, n: int, buckets: int = 5) -> list[float]:
    """n times spread over ``buckets`` consecutive 0.1 s buckets from ``first``."""
    return [first + 0.1 * (i % buckets) for i in range(n)]


def _warnings(rl: MagicMock) -> list[dict]:
    return [c.kwargs for c in rl.warning.call_args_list if c.kwargs["kind"] == "twin_silence"]


# --- twin_map --------------------------------------------------------------


class TestTwinMap:
    def test_todays_layout_pairs_conn0_with_conn6_and_conn1_with_conn7(self):
        shards = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels=PRODUCTION,
            ws_redundant_option_trades=True,
        ).channel_shards

        assert twin_map(shards) == {
            "conn0": "conn6",
            "conn6": "conn0",
            "conn1": "conn7",
            "conn7": "conn1",
        }

    def test_mirrors_off_leaves_every_shard_without_a_twin(self):
        shards = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels=PRODUCTION,
            ws_redundant_option_trades=False,
        ).channel_shards

        assert twin_map(shards) == {}

    def test_globals_folded_into_a_primary_do_not_break_the_pairing(self):
        shards = [
            ["flow-alerts", "off_lit_trades", "option_trades:SPY", "option_trades:QQQ"],
            ["gex_strike_expiry:SPY"],
            ["option_trades:QQQ", "option_trades:SPY"],
        ]

        assert twin_map(shards) == {"conn0": "conn2", "conn2": "conn0"}

    def test_a_shard_whose_option_trades_have_no_match_has_no_twin(self):
        shards = [
            ["option_trades:SPY", "option_trades:QQQ"],
            ["option_trades:AAPL"],
            ["option_trades:SPY", "option_trades:QQQ"],
        ]

        assert twin_map(shards) == {"conn0": "conn2", "conn2": "conn0"}

    def test_three_shards_with_one_channel_set_are_not_twins(self):
        shards = [["option_trades:SPY"]] * 3

        assert twin_map(shards) == {}

    def test_no_shards_gives_an_empty_map(self):
        assert twin_map([]) == {}


# --- registry ---------------------------------------------------------------


class TestRegistry:
    def test_get_creates_once_and_returns_the_same_object(self):
        first = socket_stats.get("conn3")

        assert socket_stats.get("conn3") is first
        assert first.name == "conn3"

    def test_all_stats_lists_every_registered_shard(self):
        a = socket_stats.get("conn0")
        b = socket_stats.get("conn1")

        assert socket_stats.all_stats() == {"conn0": a, "conn1": b}

    def test_all_stats_is_a_copy(self):
        socket_stats.get("conn0")

        socket_stats.all_stats().clear()

        assert list(socket_stats.all_stats()) == ["conn0"]

    def test_configure_registers_every_shard_and_sets_the_twins(self):
        shards = [["option_trades:SPY"], ["gex_strike_expiry:SPY"], ["option_trades:SPY"]]

        socket_stats.configure(shards)

        assert list(socket_stats.all_stats()) == ["conn0", "conn1", "conn2"]
        assert socket_stats.twin_of("conn0") == "conn2"
        assert socket_stats.twin_of("conn2") == "conn0"
        assert socket_stats.twin_of("conn1") is None

    def test_configure_replaces_the_previous_twins(self):
        socket_stats.set_twins({"conn0": "conn1", "conn1": "conn0"})

        socket_stats.configure([["flow-alerts"]])

        assert socket_stats.twin_of("conn0") is None


# --- frame counting ---------------------------------------------------------


class TestFrameCounting:
    def test_a_str_trade_frame_counts_as_a_trade_frame(self):
        s = SocketStats("conn0")

        s.on_frame(TRADE, _B)

        assert (s.frames, s.trade_frames) == (1, 1)
        assert (s.interval_frames, s.interval_trade_frames) == (1, 1)

    def test_a_bytes_trade_frame_counts_as_a_trade_frame(self):
        s = SocketStats("conn0")

        s.on_frame(TRADE_BYTES, _B)

        assert (s.frames, s.trade_frames) == (1, 1)

    @pytest.mark.parametrize("raw", [OTHER, OTHER.encode()])
    def test_a_non_trade_frame_counts_as_a_frame_only(self, raw):
        s = SocketStats("conn0")

        s.on_frame(raw, _B)

        assert (s.frames, s.trade_frames) == (1, 0)
        assert (s.interval_frames, s.interval_trade_frames) == (1, 0)
        assert s.last_trade_at is None

    def test_a_non_trade_frame_does_not_start_or_end_a_gap(self):
        s = SocketStats("conn0")
        s.on_frame(TRADE, _B + 0.05)

        s.on_frame(OTHER, _B + 0.95)
        s.on_frame(TRADE, _B + 1.05)

        assert s.interval_max_trade_gap_s == pytest.approx(1.0)

    def test_a_trade_frame_sets_last_trade_at(self):
        s = SocketStats("conn0")

        s.on_frame(TRADE, _B + 0.25)

        assert s.last_trade_at == _B + 0.25

    def test_a_new_stats_object_starts_empty(self):
        s = SocketStats("conn0")

        assert (s.frames, s.trade_frames, s.silences) == (0, 0, 0)
        assert (s.interval_frames, s.interval_trade_frames, s.interval_silences) == (0, 0, 0)
        assert s.interval_max_trade_gap_s == 0.0
        assert s.last_trade_at is None


# --- gaps and silences ------------------------------------------------------


class TestGaps:
    def test_the_interval_max_gap_is_the_longest_gap_between_trade_frames(self):
        s = SocketStats("conn0")

        _feed(s, [_B + 0.05, _B + 0.15, _B + 0.45, _B + 0.55])

        assert s.interval_max_trade_gap_s == pytest.approx(0.3)

    def test_no_gap_is_measured_across_session_start(self):
        s = SocketStats("conn0")
        s.on_frame(TRADE, _B + 0.05)

        s.session_start()
        s.on_frame(TRADE, _B + 60.05)

        assert s.interval_max_trade_gap_s == 0.0
        assert s.silences == 0
        assert s.last_trade_at == _B + 60.05

    def test_session_start_clears_last_trade_at(self):
        s = SocketStats("conn0")
        s.on_frame(TRADE, _B)

        s.session_start()

        assert s.last_trade_at is None

    def test_session_start_keeps_the_counters_and_the_ring(self, pair):
        a, b = pair
        _feed(b, _spread(_B + 0.15, 15))

        b.session_start()
        a.on_frame(TRADE, _B + 0.05)
        with patch.object(socket_stats, "rate_limited_log") as rl:
            a.on_frame(TRADE, _B + 0.65)

        assert b.trade_frames == 15
        assert len(_warnings(rl)) == 1

    def test_a_gap_just_under_the_threshold_is_not_a_silence(self):
        s = SocketStats("conn0")

        s.on_frame(TRADE, _B + 0.05)
        s.on_frame(TRADE, _B + 0.05 + SILENCE_S - 0.01)

        assert (s.silences, s.interval_silences) == (0, 0)

    def test_a_gap_at_the_threshold_is_a_silence(self):
        s = SocketStats("conn0")

        # 0.25 and 0.75 are exact in binary, so the gap is exactly SILENCE_S.
        s.on_frame(TRADE, _B + 0.25)
        s.on_frame(TRADE, _B + 0.75)

        assert (s.silences, s.interval_silences) == (1, 1)

    def test_silences_count_with_no_twin_and_log_nothing(self):
        s = socket_stats.get("conn0")

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(s, [_B + 0.05, _B + 5.05])

        assert s.silences == 1
        rl.warning.assert_not_called()


# --- the twin-silence warning ------------------------------------------------


class TestTwinWarning:
    def test_a_silence_with_15_twin_frames_inside_it_warns(self, pair):
        a, b = pair
        _feed(b, _spread(_B + 0.15, 15))
        end = datetime(2026, 11, 13, 15, 0, 0, tzinfo=UTC)

        with (
            patch.object(socket_stats, "rate_limited_log") as rl,
            patch.object(socket_stats, "datetime") as dt,
        ):
            dt.now.return_value = end
            _feed(a, [_B + 0.05, _B + 0.65])

        (kwargs,) = _warnings(rl)
        assert kwargs["scope"] == "socket_stats"
        assert kwargs["key"] == "conn0"
        assert kwargs["message"] == "trade socket went quiet while its twin kept receiving"
        assert kwargs["extra"] == {
            "shard": "conn0",
            "twin": "conn1",
            "gap_s": 0.6,
            "twin_trade_frames": 15,
            "silence_start_utc": "2026-11-13T14:59:59.400000+00:00",
            "silence_end_utc": "2026-11-13T15:00:00+00:00",
            "twin_window_clipped": False,
        }
        dt.now.assert_called_once_with(UTC)

    def test_a_silence_with_5_twin_frames_inside_it_does_not_warn(self, pair):
        a, b = pair
        _feed(b, _spread(_B + 0.15, 5))

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        assert a.silences == 1
        rl.warning.assert_not_called()

    def test_the_thresholds_are_the_agreed_values(self):
        assert SILENCE_S == 0.5
        assert TWIN_MIN_FRAMES == 10
        assert RING_BUCKETS == 1_200
        assert BUCKETS_PER_S == 10

    @pytest.mark.parametrize(
        ("twin_frames", "warns"), [(TWIN_MIN_FRAMES - 1, False), (TWIN_MIN_FRAMES, True)]
    )
    def test_the_twin_frame_threshold_is_at_least_the_minimum(self, pair, twin_frames, warns):
        a, b = pair
        _feed(b, _spread(_B + 0.15, twin_frames))

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        assert len(_warnings(rl)) == (1 if warns else 0)

    def test_a_silence_with_no_twin_does_not_warn(self):
        a = socket_stats.get("conn0")
        b = socket_stats.get("conn1")  # registered, but not linked to conn0
        _feed(b, _spread(_B + 0.15, 15))

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        assert a.silences == 1
        rl.warning.assert_not_called()

    def test_a_twin_that_was_never_registered_does_not_warn_or_raise(self):
        socket_stats.set_twins({"conn0": "conn9"})
        a = socket_stats.get("conn0")

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        rl.warning.assert_not_called()
        assert "conn9" not in socket_stats.all_stats()

    def test_twin_frames_only_in_the_edge_buckets_do_not_count(self, pair):
        a, b = pair
        # 0.05 is the start bucket of the silence and 0.65 the end bucket: the
        # twin's buffered frames land there when both sockets resume after a
        # loop stall, so neither may count.
        _feed(b, [_B + 0.07] * 15)
        _feed(b, [_B + 0.68] * 15)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        rl.warning.assert_not_called()

    def test_a_twin_frame_in_the_first_bucket_after_the_start_edge_counts(self, pair):
        a, b = pair
        _feed(b, [_B + 0.15] * 10)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        assert [w["extra"]["twin_trade_frames"] for w in _warnings(rl)] == [10]

    def test_a_twin_frame_in_the_last_bucket_before_the_end_edge_counts(self, pair):
        a, b = pair
        _feed(b, [_B + 0.55] * 10)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])

        assert [w["extra"]["twin_trade_frames"] for w in _warnings(rl)] == [10]

    def test_twin_frames_one_ring_span_before_the_window_do_not_alias_into_it(self, pair):
        a, b = pair
        # The silence runs from bucket 11200 to 11206; the twin's frames sit in
        # bucket 10003, exactly 1,200 buckets (one ring span) before bucket
        # 11203, so they share its slot. Only the absolute bucket number tells
        # them apart.
        start = _B + 120.05
        _feed(b, [_B + 0.35] * 15)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [start, start + 0.6])

        rl.warning.assert_not_called()

    def test_the_ring_wraps_without_carrying_old_counts_into_a_reused_slot(self, pair):
        a, b = pair
        # 130 s of twin frames, three to a bucket, then a 0.6 s silence whose five
        # inside buckets reuse slots first written 120 s earlier. Their old counts
        # must have been replaced, not added to: 5 buckets x 3 frames.
        for bucket in range(RING_BUCKETS + 100):
            _feed(b, [_B + bucket * 0.1 + 0.05] * 3)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 127.05, _B + 127.65])

        assert [w["extra"]["twin_trade_frames"] for w in _warnings(rl)] == [15]

    def test_a_gap_longer_than_the_ring_is_flagged_clipped_and_counts_the_ring_only(self, pair):
        a, b = pair
        _feed(b, [_B + 10.05] * 20)  # older than the ring at the end of the silence
        _feed(b, [_B + 150.05] * 12)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 200.05])

        (kwargs,) = _warnings(rl)
        assert kwargs["extra"]["twin_window_clipped"] is True
        assert kwargs["extra"]["twin_trade_frames"] == 12
        assert kwargs["extra"]["gap_s"] == 200.0

    def test_a_gap_of_exactly_the_ring_span_is_not_clipped(self, pair):
        a, b = pair
        _feed(b, [_B + 60.05] * 12)

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.25, _B + 120.25])

        (kwargs,) = _warnings(rl)
        assert kwargs["extra"]["twin_window_clipped"] is False
        assert kwargs["extra"]["twin_trade_frames"] == 12

    def test_each_warning_is_keyed_by_the_shard_that_went_quiet(self):
        # Both sockets of a pair can go quiet in turn. The rate limiter keeps a
        # window per key, so keying on the shard stops one hiding the other.
        socket_stats.set_twins({"conn0": "conn1", "conn1": "conn0"})
        a, b = socket_stats.get("conn0"), socket_stats.get("conn1")
        _feed(a, _spread(_B + 0.15, 15))
        _feed(b, _spread(_B + 0.15, 15))

        with patch.object(socket_stats, "rate_limited_log") as rl:
            _feed(a, [_B + 0.05, _B + 0.65])
            _feed(b, [_B + 0.05, _B + 0.65])

        assert [w["key"] for w in _warnings(rl)] == ["conn0", "conn1"]

    def test_a_failing_silence_check_is_logged_and_does_not_reach_the_receive_loop(self, pair):
        a, b = pair
        _feed(b, _spread(_B + 0.15, 15))

        with patch.object(socket_stats, "rate_limited_log") as rl:
            rl.warning.side_effect = [RuntimeError("log sink down"), None]
            _feed(a, [_B + 0.05, _B + 0.65])

        kinds = [c.kwargs["kind"] for c in rl.warning.call_args_list]
        assert kinds == ["twin_silence", "silence_check_failed"]
        failed = rl.warning.call_args_list[1].kwargs
        assert failed["key"] == "conn0"
        assert "log sink down" in failed["extra"]["err"]
        # The socket's own state is intact: the silence is counted, the next gap
        # is measured from this frame.
        assert a.silences == 1
        assert a.last_trade_at == _B + 0.65
