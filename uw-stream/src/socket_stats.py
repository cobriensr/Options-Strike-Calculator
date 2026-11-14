"""Per-socket frame counters and the twin-silence warning.

Every ``option_trades:<TICKER>`` channel is joined on two sockets (conn0 and
conn6, conn1 and conn7), and ``OptionTradesHandler.enqueue`` drops the second
copy of each trade. On 2026-11-13, 345 trades reached Neon from only one of the
two sockets with no disconnect on either, most likely because one socket missed
1 to 2 s of frames. The dedupe hides that. This module names the socket that
went quiet.

The connector calls ``SocketStats.on_frame(raw, now)`` for every frame, with the
monotonic ``now`` its receive loop already reads, and ``session_start()`` once
per connection. Per frame that is integer bumps, one prefix test and, for a
trade frame, a length check and one slot update in a ring of 0.1 s buckets.
Nothing awaits, nothing logs and nothing reads the clock. A trade frame is a
frame for an ``option_trades:`` channel that is long enough to carry a print: the
join acks have the same prefix and do not count (see ``TRADE_FRAME_MIN_LEN``).

A *silence* is a gap of at least ``SILENCE_S`` between two trade frames on one
socket. When the socket has a twin that received ``TWIN_MIN_FRAMES`` or more
trade frames inside that gap, the twin kept receiving while this socket did not,
and ``on_frame`` logs one rate-limited ``twin_silence`` warning that names the
shard and the UTC window.

Two details keep the count honest:

* The twin's frames are counted in the buckets strictly inside the gap, not the
  two edge buckets. After an event-loop stall both sockets resume together and
  the twin's buffered frames land in the resume bucket; counting that bucket
  would report a loop stall as one socket going quiet. The per-minute loop-lag
  line covers stalls.
* A ring slot is ``bucket number % 1200``, so a twin that was quiet for a while
  still holds old counts in slots that alias into the current window. Each slot
  stores the absolute bucket number it was last written for, and only slots
  whose number lies inside the window count.

The interval fields (``interval_*``) are read and reset by the per-minute
pipeline line. The cumulative fields are never reset.

State is module-level and keyed by shard name (``conn0`` .. ``connN``), a closed
set the shard layout fixes at boot.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logger_setup import rate_limited_log

# A gap between trade frames on one socket at or over this is a silence.
SILENCE_S = 0.5
# The twin must have received at least this many trade frames inside the gap.
TWIN_MIN_FRAMES = 10
# Ring resolution: 0.1 s buckets, 1,200 of them (120 s). A longer gap is
# reported with ``twin_window_clipped``.
BUCKETS_PER_S = 10
RING_BUCKETS = 1_200
RING_SPAN_S = RING_BUCKETS / BUCKETS_PER_S

_CHANNEL_PREFIX = "option_trades:"
# UW sends text frames, so ``raw`` is normally a str. A trade frame is the
# 2-element envelope ``["option_trades:SPY", {...}]``.
_TRADE_PREFIX = '["' + _CHANNEL_PREFIX
_TRADE_PREFIX_BYTES = _TRADE_PREFIX.encode()
# The server's join ack for an option_trades channel,
# ``["option_trades:SPXW",{"response":{},"status":"ok"}]``, has the same prefix
# but is about 50 to 60 characters. A real trade frame carries the whole print
# (id, chain, price, size, greeks, tags) and is about 300 or more. Acks arrive in
# a burst of up to 45 right after every connect, so counting them as trades would
# start a gap there and read the quiet before the first real trade as a silence.
# Checking the length is O(1); a frame must reach this many characters to count.
TRADE_FRAME_MIN_LEN = 100


class SocketStats:
    """Frame counters, trade-gap tracking and a trade-frame ring for one socket."""

    __slots__ = (
        "_counts",
        "_stamps",
        "frames",
        "interval_frames",
        "interval_max_trade_gap_s",
        "interval_silences",
        "interval_trade_frames",
        "last_trade_at",
        "name",
        "silences",
        "trade_frames",
    )

    def __init__(self, name: str) -> None:
        self.name = name
        # Cumulative since boot.
        self.frames = 0
        self.trade_frames = 0
        self.silences = 0
        # Since the last per-minute line, which reads and resets them.
        self.interval_frames = 0
        self.interval_trade_frames = 0
        self.interval_max_trade_gap_s = 0.0
        self.interval_silences = 0
        # Monotonic time of the last trade frame on this connection; None until
        # one arrives, and again after ``session_start``.
        self.last_trade_at: float | None = None
        # Trade-frame count per bucket, and the absolute bucket number each slot
        # was last written for (-1: never). See the module docstring.
        self._counts = [0] * RING_BUCKETS
        self._stamps = [-1] * RING_BUCKETS

    def session_start(self) -> None:
        """A new connection began: measure no gap across the reconnect."""
        self.last_trade_at = None

    def on_frame(self, raw: str | bytes, now: float) -> None:
        """Count one frame received at monotonic time ``now``. Hot path: no await, no log."""
        self.frames += 1
        self.interval_frames += 1
        if isinstance(raw, str):
            if not raw.startswith(_TRADE_PREFIX) or len(raw) < TRADE_FRAME_MIN_LEN:
                return
        elif not raw.startswith(_TRADE_PREFIX_BYTES) or len(raw) < TRADE_FRAME_MIN_LEN:
            return
        self.trade_frames += 1
        self.interval_trade_frames += 1

        bucket = int(now * BUCKETS_PER_S)
        slot = bucket % RING_BUCKETS
        if self._stamps[slot] == bucket:
            self._counts[slot] += 1
        else:
            self._stamps[slot] = bucket
            self._counts[slot] = 1

        last = self.last_trade_at
        self.last_trade_at = now
        if last is None:
            return
        gap = now - last
        if gap > self.interval_max_trade_gap_s:
            self.interval_max_trade_gap_s = gap
        if gap >= SILENCE_S:
            self._on_silence(last, now, gap)

    def trade_frames_between(self, start: float, end: float) -> int:
        """Trade frames in the buckets strictly inside (``start``, ``end``).

        The buckets holding ``start`` and ``end`` are left out. Only the last
        ``RING_BUCKETS - 1`` buckets before ``end`` can still be in the ring, so
        a longer window is cut to those.
        """
        last = int(end * BUCKETS_PER_S) - 1
        first = max(int(start * BUCKETS_PER_S) + 1, last - RING_BUCKETS + 2)
        counts, stamps = self._counts, self._stamps
        total = 0
        for bucket in range(first, last + 1):
            slot = bucket % RING_BUCKETS
            if stamps[slot] == bucket:
                total += counts[slot]
        return total

    def _on_silence(self, start: float, end: float, gap: float) -> None:
        """Count a silence and, if the twin kept receiving through it, warn.

        Cold path: it runs only when a gap reaches ``SILENCE_S``. Diagnostics must
        not end the receive loop, so a failure here is logged and swallowed.
        """
        self.silences += 1
        self.interval_silences += 1
        twin_name = _twins.get(self.name)
        twin = _registry.get(twin_name) if twin_name is not None else None
        if twin is None:
            return
        try:
            twin_frames = twin.trade_frames_between(start, end)
            if twin_frames < TWIN_MIN_FRAMES:
                return
            silence_end = datetime.now(UTC)
            gap_s = round(gap, 3)
            rate_limited_log.warning(
                scope="socket_stats",
                kind="twin_silence",
                key=self.name,
                message="trade socket went quiet while its twin kept receiving",
                extra={
                    "shard": self.name,
                    "twin": twin.name,
                    "gap_s": gap_s,
                    "twin_trade_frames": twin_frames,
                    "silence_start_utc": (silence_end - timedelta(seconds=gap_s)).isoformat(),
                    "silence_end_utc": silence_end.isoformat(),
                    "twin_window_clipped": gap > RING_SPAN_S,
                },
            )
        except Exception as exc:
            rate_limited_log.warning(
                scope="socket_stats",
                kind="silence_check_failed",
                key=self.name,
                message="twin-silence check failed",
                extra={"shard": self.name, "err": repr(exc)},
            )


# Shard name -> stats, and shard name -> its twin's name. Both are keyed by the
# shard names ``configure`` fixes at boot, so neither grows.
_registry: dict[str, SocketStats] = {}
_twins: dict[str, str] = {}


def shard_name(index: int) -> str:
    """The connector name for shard ``index``."""
    return f"conn{index}"


def get(name: str) -> SocketStats:
    """The stats for shard ``name``, created on first use."""
    stats = _registry.get(name)
    if stats is None:
        stats = _registry[name] = SocketStats(name)
    return stats


def all_stats() -> dict[str, SocketStats]:
    """Every registered shard's stats, by name. A copy: the caller may iterate it freely."""
    return dict(_registry)


def twin_of(name: str) -> str | None:
    """The shard that joins the same ``option_trades:`` channels as ``name``, if any."""
    return _twins.get(name)


def set_twins(twins: dict[str, str]) -> None:
    """Replace the twin map."""
    _twins.clear()
    _twins.update(twins)


def twin_map(shards: list[list[str]]) -> dict[str, str]:
    """Pair the shards that join the same ``option_trades:`` channels.

    Shards are named ``conn{i}`` and grouped by the set of their
    ``option_trades:`` channels; other channels (``flow-alerts`` folded into a
    primary) are ignored. A shard with no option-trade channels has no twin, and
    only a group of exactly two shards pairs up. With the mirror shards off
    (``WS_REDUNDANT_OPTION_TRADES=false``) no group has two, and the map is empty.
    """
    groups: dict[frozenset[str], list[str]] = {}
    for index, shard in enumerate(shards):
        channels = frozenset(c for c in shard if c.startswith(_CHANNEL_PREFIX))
        if channels:
            groups.setdefault(channels, []).append(shard_name(index))
    twins: dict[str, str] = {}
    for names in groups.values():
        if len(names) == 2:
            first, second = names
            twins[first] = second
            twins[second] = first
    return twins


def configure(shards: list[list[str]]) -> None:
    """Register every shard's stats and set the twin map. ``main`` calls it at boot."""
    set_twins(twin_map(shards))
    for index in range(len(shards)):
        get(shard_name(index))
