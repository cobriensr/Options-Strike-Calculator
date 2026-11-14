"""Alert on, and reconnect, a trade socket that is up but delivers no trades.

Every ``option_trades:<TICKER>`` channel is joined on two sockets, a twin pair
(``conn0``/``conn6``, ``conn1``/``conn7``), and the dedupe keeps one copy of each
trade. The twin-silence warning (``socket_stats``) is only checked when a trade
frame ends a gap, so a socket that stays connected and never receives another
trade frame raised nothing. The subscription watchdog looks only at the
``subscribed`` flags, and ``/healthz`` uses the global ``last_message_ts``, which
the other sockets keep fresh. The only sign was one shard's ``trade_frames: 0`` in
the minute line next to a non-zero twin, and the backup stayed lost until someone
read it. The owner chose alert and reconnect (2026-11-14). The twin carries every
trade during the reconnect, about 2 s, so a false alarm costs nothing.

``run_stuck_socket_watchdog`` wakes every ``STUCK_CHECK_INTERVAL_S`` and asks
``socket_stats.find_stuck`` which shards are stuck: connected, with a twin, no
trade frame for ``STUCK_S`` (from the session start if the session has had none)
while the twin received ``STUCK_TWIN_MIN_FRAMES`` or more in that time. Per
stuck shard it keeps one *incident*, open from the check that first found the
shard stuck until a trade frame arrives:

* **Open.** One Sentry warning, ``uw-stream trade socket stuck``, with the
  numbers measured.
* **Force.** ``Connector.force_reconnect`` drops the socket, and ``run`` reconnects
  and re-joins every channel. At most one per shard per
  ``FORCED_RECONNECT_COOLDOWN_S`` (300 s), counted across incidents. That is at
  most 12 an hour per stuck shard. The reconnect storm alert fires at 5 per shard
  an hour (40 with 8 shards), and forced reconnects count towards it like any
  other, so two shards stuck all hour plus the usual drops stay under it.
* **Escalate, once.** If the shard is stuck again at a later check while the
  incident has a forced reconnect on record, one Sentry error, ``uw-stream trade
  socket still stuck after a forced reconnect``. The new session counts its gap
  from its own start, so after a reconnect that took this is 60 s or more later.
  An incident that has not forced yet (the cooldown from an earlier incident is
  still running) does not escalate: the first event already told the owner.
* **End.** When the shard's ``last_trade_at`` is later than the incident's start,
  a trade frame arrived. A line logs the duration (to the check that saw it) and
  the forced reconnects. A later stick opens a new incident.

A pass is skipped when its own sleep overran by ``LOOP_LAG_FLAG_S`` or more. After
a loop stall the first socket to resume drains its backlog before its twin's task
runs, so the twin can look stuck for one pass; the minute line's loop lag covers
the stall itself.

Not covered: both twins stuck at once (each one's twin shows no trade frames, so
there is nothing to compare against), ``WS_REDUNDANT_OPTION_TRADES=false`` (no
twins, so ``find_stuck`` finds nothing) and the non-trade sockets (``conn2`` to
``conn5``).

Per-shard state lives in dicts keyed by shard name, a closed set the shard layout
fixes at boot. The loop never dies of a failed pass: ``main`` treats the death of
any background task as fatal (it restarts the container and drops every socket),
so each pass is guarded, as in ``pipeline_stats``, and only a cancel ends the loop.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import socket_stats
from connector import Connector
from logger_setup import log, rate_limited_log
from pipeline_stats import LOOP_LAG_FLAG_S
from sentry_setup import capture_message

# Check period. ``STUCK_S`` and ``STUCK_TWIN_MIN_FRAMES`` (what makes a shard
# stuck) live in ``socket_stats`` beside the test that uses them.
STUCK_CHECK_INTERVAL_S = 5.0
# At most one forced reconnect per shard per this long, counted across incidents.
FORCED_RECONNECT_COOLDOWN_S = 300.0
# The ``forced`` value on the disconnect line of a drop this module asked for.
FORCED_REASON = "stuck_trade_socket"

_TAGS = {"component": "stuck_sockets"}


@dataclass
class _Incident:
    """One shard's current stuck spell, from the check that found it."""

    started_at: float
    # Forced reconnects made during this incident.
    forced: int = 0
    escalated: bool = False


@dataclass
class _Watch:
    """What the loop remembers between passes, keyed by shard name."""

    incidents: dict[str, _Incident] = field(default_factory=dict)
    # Monotonic time of each shard's last forced reconnect; kept across incidents.
    last_forced_at: dict[str, float] = field(default_factory=dict)


def _alert(
    message: str,
    level: str,
    found: socket_stats.StuckSocket,
    incident: _Incident,
    now: float,
) -> None:
    """Send one Sentry event for ``found``, with what ``find_stuck`` measured."""
    last = socket_stats.get(found.shard).last_trade_at
    last_trade_utc = None
    if last is not None:
        last_trade_utc = (datetime.now(UTC) - timedelta(seconds=now - last)).isoformat()
    capture_message(
        message,
        level=level,
        tags=_TAGS,
        context={
            "shard": found.shard,
            "twin": found.twin,
            "gap_s": round(found.gap_s, 3),
            "twin_trade_frames": found.twin_trade_frames,
            "last_trade_utc": last_trade_utc,
            "forced_reconnects": incident.forced,
        },
    )


def _force_if_due(
    watch: _Watch,
    connectors: Mapping[str, Connector],
    found: socket_stats.StuckSocket,
    incident: _Incident,
    now: float,
) -> None:
    """Force a reconnect of ``found`` unless one was forced within the cooldown.

    The bookkeeping comes before the call, so a call that raises still counts
    against the cooldown rather than being retried every pass.
    """
    last_forced = watch.last_forced_at.get(found.shard)
    if last_forced is not None and now - last_forced < FORCED_RECONNECT_COOLDOWN_S:
        return
    connector = connectors[found.shard]
    watch.last_forced_at[found.shard] = now
    incident.forced += 1
    log.warning(
        "forcing reconnect of a stuck trade socket",
        extra={
            "shard": found.shard,
            "twin": found.twin,
            "gap_s": round(found.gap_s, 3),
            "twin_trade_frames": found.twin_trade_frames,
            "forced_reconnect_number": incident.forced,
        },
    )
    connector.force_reconnect(FORCED_REASON)


def _end_recovered(watch: _Watch, now: float) -> None:
    """End every incident whose shard has received a trade frame since it began."""
    for shard, incident in list(watch.incidents.items()):
        last = socket_stats.get(shard).last_trade_at
        if last is not None and last > incident.started_at:
            del watch.incidents[shard]
            log.info(
                "stuck trade socket recovered",
                extra={
                    "shard": shard,
                    "duration_s": round(now - incident.started_at, 3),
                    "forced_reconnects": incident.forced,
                },
            )


def _check(watch: _Watch, connectors: Mapping[str, Connector], now: float) -> None:
    """One pass at monotonic time ``now``: end recovered incidents, then handle each stuck shard."""
    _end_recovered(watch, now)
    for found in socket_stats.find_stuck(now):
        incident = watch.incidents.get(found.shard)
        if incident is None:
            incident = watch.incidents[found.shard] = _Incident(started_at=now)
            _alert("uw-stream trade socket stuck", "warning", found, incident, now)
        elif incident.forced > 0 and not incident.escalated:
            incident.escalated = True
            _alert(
                "uw-stream trade socket still stuck after a forced reconnect",
                "error",
                found,
                incident,
                now,
            )
        _force_if_due(watch, connectors, found, incident, now)


async def run_stuck_socket_watchdog(connectors: Mapping[str, Connector]) -> None:
    """Check for stuck trade sockets every ``STUCK_CHECK_INTERVAL_S``, forever.

    ``connectors`` are keyed by shard name. A pass that raises is logged, at
    error level and rate limited (one Sentry event a window), and the loop goes
    on. The guard is ``except Exception``, so a cancel (a BaseException) still
    ends the loop; it does not cover the sleep, where a cancel arrives.
    """
    watch = _Watch()
    while True:
        started = time.monotonic()
        await asyncio.sleep(STUCK_CHECK_INTERVAL_S)
        now = time.monotonic()
        if now - started - STUCK_CHECK_INTERVAL_S >= LOOP_LAG_FLAG_S:
            continue
        try:
            _check(watch, connectors, now)
        except Exception as exc:
            rate_limited_log.error(
                scope="stuck_sockets",
                kind="check",
                message="stuck-socket check failed",
                extra={"err_type": type(exc).__name__, "err": str(exc)},
            )
