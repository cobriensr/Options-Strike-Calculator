"""Shared mutable runtime state.

Single-process daemon → module-level singleton is fine. Components
update fields directly; the health server reads them.

The state is intentionally simple. If we ever need cross-coroutine
ordering guarantees, we can add asyncio.Lock guards here without
touching call sites.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta


@dataclass
class ChannelMetrics:
    """Per-channel counters surfaced via /metrics.

    ``write_attempted`` counts every row the handler tried to flush
    (i.e. the size of the batch passed into the bulk-insert helper).
    ``write_count`` counts the rows the database actually inserted /
    updated, parsed from asyncpg's ``"INSERT 0 N"`` status string. The
    delta ``write_attempted - write_count`` is the dedup rate — useful
    for spotting upstream replays (e.g. UW reconnect bursts) without
    digging through Postgres logs.
    """

    subscribed: bool = False
    last_message_ts: datetime | None = None
    queue_depth: int = 0
    drop_count: int = 0
    write_attempted: int = 0
    write_count: int = 0


@dataclass
class State:
    """Process-wide state for /healthz and /metrics."""

    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Per-connection (shard) connected flags. With channel sharding there are
    # N WS connections; ``ws_connected`` (below) is True only when ALL of them
    # are up, so /healthz doesn't read green while a shard is mid-reconnect.
    connections: dict[str, bool] = field(default_factory=dict)
    last_message_ts: datetime | None = None
    # Sized for N sharded connections: a multi-shard reconnect burst can
    # produce many events/minute, so 64 (the single-connection era size) would
    # churn through an hour's window in seconds and undercount
    # reconnects_last_hour. 512 comfortably covers an hour across ~6+ shards.
    reconnect_times: deque[datetime] = field(default_factory=lambda: deque(maxlen=512))
    channels: dict[str, ChannelMetrics] = field(default_factory=dict)
    # Bounded queue between connector (producer) and router (consumer).
    # Depth is set by the router on each loop iteration so /metrics can
    # show whether the router is keeping up with the WS receive rate.
    # Drops are incremented by the connector when the queue is full
    # (drop-oldest semantics — the newest frame still gets enqueued).
    receive_queue_depth: int = 0
    receive_queue_drops: int = 0

    @property
    def ws_connected(self) -> bool:
        """True only when every WS shard connection is currently up.

        With sharding the shard names are pre-registered False at startup (see
        main), so this is honest from boot. Used by /metrics as the ideal-state
        signal; /healthz uses ``ws_any_connected`` instead so one shard
        reconnecting doesn't flap the whole daemon red.
        """
        return bool(self.connections) and all(self.connections.values())

    @property
    def ws_any_connected(self) -> bool:
        """True when at least one WS shard connection is up.

        /healthz gates on this, not ``ws_connected``: with N sharded sockets a
        single shard mid-reconnect is routine and must NOT 503 the daemon while
        the others stream. A shard that silently fails to subscribe is caught by
        the subscription watchdog (a targeted alert), not by flapping health.
        """
        return any(self.connections.values())

    @ws_connected.setter
    def ws_connected(self, value: bool) -> None:
        """Force the aggregate connection state to a single boolean.

        Production reports per-shard via ``set_connection``; this setter is a
        convenience for callers that think in one boolean (tests, the
        health-state snapshot/restore fixture). ``True`` → one up connection;
        ``False`` → no up connections (empty), so a later per-shard
        ``set_connection(..., True)`` isn't dragged False by a lingering
        synthetic entry. Either way ``ws_connected`` reads back the same bool.
        """
        self.connections = {"_aggregate": True} if value else {}

    def set_connection(self, name: str, connected: bool) -> None:
        """Record a shard connection's up/down state (keyed by shard name)."""
        self.connections[name] = connected

    def reconnects_last_hour(self) -> int:
        """Count reconnect events that fell within the last hour."""
        cutoff = datetime.now(UTC) - timedelta(hours=1)
        return sum(1 for ts in self.reconnect_times if ts >= cutoff)

    def record_reconnect(self) -> None:
        self.reconnect_times.append(datetime.now(UTC))

    def channel(self, name: str) -> ChannelMetrics:
        """Get or create the metrics record for a channel."""
        if name not in self.channels:
            self.channels[name] = ChannelMetrics()
        return self.channels[name]

    def touch(self, channel: str) -> None:
        """Mark a channel as having just received a message."""
        now = datetime.now(UTC)
        self.last_message_ts = now
        self.channel(channel).last_message_ts = now


state = State()
