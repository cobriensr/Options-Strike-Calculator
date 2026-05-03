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
    """Per-channel counters surfaced via /metrics."""

    subscribed: bool = False
    last_message_ts: datetime | None = None
    queue_depth: int = 0
    drop_count: int = 0
    write_count: int = 0


@dataclass
class State:
    """Process-wide state for /healthz and /metrics."""

    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ws_connected: bool = False
    last_message_ts: datetime | None = None
    reconnect_times: deque[datetime] = field(default_factory=lambda: deque(maxlen=64))
    channels: dict[str, ChannelMetrics] = field(default_factory=dict)

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
