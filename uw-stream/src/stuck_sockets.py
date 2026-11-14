"""Alert on, and reconnect, a trade socket that is up but delivers no trades; alert when every copy is silent.

Every ``option_trades:<TICKER>`` channel is joined on two sockets, a twin pair
(``conn0``/``conn6``, ``conn1``/``conn7``), and the dedupe keeps one copy of each
trade. The twin-silence warning (``socket_stats``) is only checked when a trade
frame ends a gap, so a socket that stays connected and never receives another
trade frame raised nothing. The subscription watchdog looks only at the
``subscribed`` flags, and ``/healthz`` uses the global ``last_message_ts``, which
the other sockets keep fresh. The only sign was one shard's ``trade_frames: 0`` in
the minute line next to a non-zero twin, and the backup stayed lost until someone
read it. The owner chose alert and reconnect (2026-11-14). The twin is connected
(``find_stuck`` checks) and carries every trade during the reconnect, about 2 s,
so a false alarm costs nothing.

``run_stuck_socket_watchdog`` wakes every ``STUCK_CHECK_INTERVAL_S`` and asks
``socket_stats.find_stuck`` which shards are stuck: connected with a connected
twin, no trade frame for ``STUCK_S`` (from the session start if the session has had
none) while the twin received ``STUCK_TWIN_MIN_FRAMES`` or more in that time. Per
stuck shard it keeps one *incident*, open from the check that first found the
shard stuck until a trade frame arrives:

* **Open.** One Sentry warning, ``uw-stream trade socket stuck``, with the
  numbers measured.
* **Force.** ``Connector.force_reconnect`` drops the socket, and ``run`` reconnects
  and re-joins every channel. At most one per shard per
  ``FORCED_RECONNECT_COOLDOWN_S`` (300 s), counted across incidents. That is at
  most 12 an hour per stuck shard. The reconnect storm alert fires at 5 per shard
  an hour (40 with 8 shards), and forced reconnects count towards it like any
  other. Two stuck shards make 24 an hour at most, one from each pair. The four
  trade shards (two pairs) can alternate, a different one of each pair stuck from
  hour to hour, and then forced reconnects alone reach 48 an hour, over the 40: the
  storm alert can fire for them, and it is then telling the truth.
* **Escalate, once.** If the shard is found stuck again at a later check while the
  incident has a forced reconnect on record, one Sentry error, ``uw-stream trade
  socket still stuck after a forced reconnect``. The new session counts its gap
  from its own start, so after a reconnect that took this is 60 s or more later.
  A fresh session that is not stuck yet is not escalated, and nor is an incident
  that has not forced yet (the cooldown from an earlier incident is still
  running): the first event already told the owner.
* **Alert floor.** At most one Sentry event per shard per
  ``FORCED_RECONNECT_COOLDOWN_S``, opening or escalation alike. A socket that
  delivers one trade frame between 60 s silences opens a new incident about every
  65 s, and without the floor each would send a warning: 55 an hour. With it, 12 an
  hour at most. An event the floor holds back logs ``stuck trade socket alert held
  back`` instead, once per incident and event. Either kind stays due: it goes out
  at the first check after the floor lifts at which the shard is stuck, if the
  incident is still open (a silence that opens within 300 s of an earlier alert
  still reaches Sentry; one that ended first sends nothing). The opening event goes
  first, and the escalation waits behind it. So in the usual run the escalation
  follows the opening event by about 5 min, not by about 1 min: the 60 s after a
  reconnect is always inside the floor.
* **End.** When the shard's ``last_trade_at`` is later than the incident's start,
  a trade frame arrived. A line logs the duration (to the check that saw it) and
  the forced reconnects. A later stick opens a new incident.

A pass is skipped when its own sleep overran by ``LOOP_LAG_FLAG_S`` or more. After
a loop stall the first socket to resume drains its backlog before its twin's task
runs, so the twin can look stuck for one pass; the minute line's loop lag covers
the stall itself. ``main._shutdown`` cancels and awaits this task before it
cancels the connectors: cancelled connectors leave ``state.connections`` true and
their last trade frame frozen, which a watchdog still running would read as a
stuck socket.

**Every copy silent (pipeline diagnostics, Task 7).** The twin comparison cannot
see both copies of a feed stop at once (each one's twin then shows no trade
frames), nor a deployment with no twins (``WS_REDUNDANT_OPTION_TRADES=false``). The
same pass also watches each *trade group*: a primary trade shard with its twin, or,
with no twins, a trade shard alone (a trade shard is a connector with an
``option_trades:`` channel). Per group it keeps a high-water mark, the latest
``last_trade_at`` seen on any of its sockets. ``session_start`` clears
``last_trade_at`` at every reconnect, so the mark lives here, and starts at the
group's first pass. It is read once per check, so it is exact to within one check
(5 s). A group is silent when ``market_calendar.in_trade_window`` holds and the
mark is ``GROUP_SILENT_S`` or more old. Then, once per incident:

* **Open.** One warning log line and one Sentry error, ``uw-stream option trades
  silent on every copy``, with the group's shards, each one's connected flag, the
  seconds since the last trade and whether the group has a twin. No forced
  reconnect: the owner asked to know, and one can be added later.
* **Alert floor.** The same floor as the shard events, with its own clock per
  group (``_claim_floor``): at most one Sentry event per group per
  ``FORCED_RECONNECT_COOLDOWN_S``. A feed that leaks one trade between 60 s silences
  would otherwise send one about every 65 s. A held-back event logs ``option trades
  silent alert held back`` once, the incident is open all the same, and the event
  stays due: it goes out at the first check after the floor lifts if the feed is
  still silent.
* **End.** When the mark moves past the incident's start: ``option trades resumed``,
  with the duration.

A change of the trade window ends incidents (``_end_for_window``), each with a log
line. A silent-group incident ends on either change. A stuck-shard incident ends
only when the window opens, and only if it is older than ``STUCK_S``. It ends only
when a trade frame arrives otherwise, so one for a socket that stays stuck through
the close would carry overnight and the next session would start with no new alert:
the open ends it, and the stick alerts afresh. The close must leave it alone. The
twin still streams for 15 minutes after it (the index options trade to 16:15 ET),
so ending it there would find the shard stuck again in the same pass and send a
duplicate pair of events. An incident opened in the minute before 09:31 is younger
than ``STUCK_S`` at the open, belongs to the session and keeps its escalation. The
stuck-shard checks do not depend on the window, and a failure reading it (logged,
``kind="window"``) skips only the group check, so a wrong calendar cannot switch
them off.

Not covered: the non-trade sockets (``conn2`` to ``conn5``), a feed that stops
outside the window, and a holiday listed in neither calendar (the window treats it
as a trading day, so the alert fires once per trade group).

Per-shard and per-group state lives in dicts keyed by shard or group name, a
closed set the shard layout fixes at boot. The loop never dies of a failed pass:
``main`` treats the death of any background task as fatal (it restarts the container
and drops every socket), so each pass is guarded, as in ``pipeline_stats``, and only
a cancel ends the loop. Each stuck shard's handling and each group's check is
guarded on its own as well, under its own rate-limit key, so one failure does not
skip the ones after it.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import market_calendar
import socket_stats
from connector import Connector
from logger_setup import log, rate_limited_log
from pipeline_stats import LOOP_LAG_FLAG_S
from sentry_setup import capture_message
from state import state

# Check period. ``STUCK_S`` and ``STUCK_TWIN_MIN_FRAMES`` (what makes a shard
# stuck) live in ``socket_stats`` beside the test that uses them.
STUCK_CHECK_INTERVAL_S = 5.0
# At most one forced reconnect per shard per this long, counted across incidents.
FORCED_RECONNECT_COOLDOWN_S = 300.0
# The ``forced`` value on the disconnect line of a drop this module asked for.
FORCED_REASON = "stuck_trade_socket"
# No trade frame on any copy of a trade feed for this long, inside the trade
# window, opens an incident (see ``_check_group``).
GROUP_SILENT_S = 60.0

_TAGS = {"component": "stuck_sockets"}
_GROUP_EVENT = "uw-stream option trades silent on every copy"


@dataclass
class _Incident:
    """One shard's current stuck spell, from the check that found it."""

    started_at: float
    # Forced reconnects made during this incident.
    forced: int = 0
    # The opening event went out.
    opening_sent: bool = False
    # The alert floor held the opening event back and the line saying so is logged.
    opening_held: bool = False
    # The escalation event went out.
    escalated: bool = False
    # The alert floor held the escalation back and the line saying so is logged.
    escalation_held: bool = False


@dataclass
class _SilentIncident:
    """One group's current silence, from the check that found it."""

    started_at: float
    # The Sentry event went out.
    alerted: bool = False
    # The alert floor held the event back and the line saying so is logged.
    held_logged: bool = False


@dataclass
class _Watch:
    """What the loop remembers between passes, keyed by shard name (or group name, where said)."""

    incidents: dict[str, _Incident] = field(default_factory=dict)
    # Monotonic time of each shard's last forced reconnect; kept across incidents.
    last_forced_at: dict[str, float] = field(default_factory=dict)
    # Monotonic time of each shard's last Sentry event, of either kind; kept
    # across incidents. The alert floor reads it.
    last_alerted_at: dict[str, float] = field(default_factory=dict)
    # Whether the trade window was open at the last pass. A change ends every open
    # incident (``_end_for_window``). False before the first pass.
    in_window: bool = False
    # The group rule, keyed by group name (the primary shard's): the monotonic time
    # of the latest trade frame seen on any of its sockets, seeded at the group's
    # first pass and kept across reconnects, which clear ``last_trade_at``.
    high_water: dict[str, float] = field(default_factory=dict)
    # Each group's open silent incident.
    group_incidents: dict[str, _SilentIncident] = field(default_factory=dict)
    # Monotonic time of each group's last Sentry event; the group's alert floor.
    last_group_alerted_at: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class _Group:
    """The sockets that carry one trade feed: a primary shard and its twin, or a shard alone."""

    # The primary shard's name.
    key: str
    shards: tuple[str, ...]


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


def _claim_floor(last_alerted: dict[str, float], key: str, now: float) -> float | None:
    """Claim the alert floor for ``key``: at most one Sentry event per key per cooldown.

    ``last_alerted`` holds the monotonic time of each key's last event. Returns
    ``None`` when the event may go out, and records ``now`` as its time. Returns the
    seconds since the key's last event when that was within
    ``FORCED_RECONNECT_COOLDOWN_S``: the floor holds this one back and nothing is
    recorded. The floor bounds Sentry at 12 an hour per key however often a degraded
    socket or feed opens a new incident. It is shared by the shard events and the
    group event, each with its own dict.
    """
    last = last_alerted.get(key)
    if last is not None and now - last < FORCED_RECONNECT_COOLDOWN_S:
        return now - last
    last_alerted[key] = now
    return None


def _alert_unless_held(
    watch: _Watch,
    message: str,
    level: str,
    found: socket_stats.StuckSocket,
    incident: _Incident,
    now: float,
    *,
    log_hold: bool,
) -> bool:
    """Send the event unless the shard already had one within ``FORCED_RECONNECT_COOLDOWN_S``.

    The alert floor (``_claim_floor``), per shard, opening or escalation alike. An
    event it holds back logs a warning instead, when ``log_hold`` says so. Returns
    whether the event went out.
    """
    since_last = _claim_floor(watch.last_alerted_at, found.shard, now)
    if since_last is not None:
        if log_hold:
            log.warning(
                "stuck trade socket alert held back",
                extra={
                    "shard": found.shard,
                    "twin": found.twin,
                    "event": message,
                    "gap_s": round(found.gap_s, 3),
                    "twin_trade_frames": found.twin_trade_frames,
                    "forced_reconnects": incident.forced,
                    "since_last_alert_s": round(since_last, 3),
                },
            )
        return False
    _alert(message, level, found, incident, now)
    return True


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


def _handle_stuck(
    watch: _Watch,
    connectors: Mapping[str, Connector],
    found: socket_stats.StuckSocket,
    now: float,
) -> None:
    """Open the shard's incident, send its opening event or escalate it, then force a reconnect if due.

    Both events are due only when ``find_stuck`` found the shard stuck at this check,
    so a fresh session that has not been quiet for ``STUCK_S`` yet is not escalated.
    If the alert floor holds one back it stays due, and goes out at the first later
    check that finds the shard stuck once the floor has lifted (ruling R32 for the
    opening event, R29 for the escalation). The opening event goes first: while it
    is held, the escalation waits behind it.
    """
    incident = watch.incidents.get(found.shard)
    if incident is None:
        incident = watch.incidents[found.shard] = _Incident(started_at=now)
    if not incident.opening_sent:
        if _alert_unless_held(
            watch,
            "uw-stream trade socket stuck",
            "warning",
            found,
            incident,
            now,
            log_hold=not incident.opening_held,
        ):
            incident.opening_sent = True
        else:
            incident.opening_held = True
    elif incident.forced > 0 and not incident.escalated:
        if _alert_unless_held(
            watch,
            "uw-stream trade socket still stuck after a forced reconnect",
            "error",
            found,
            incident,
            now,
            log_hold=not incident.escalation_held,
        ):
            incident.escalated = True
        else:
            incident.escalation_held = True
    _force_if_due(watch, connectors, found, incident, now)


def _end_for_window(watch: _Watch, now: float, in_window: bool) -> None:
    """End the incidents that belong to a trade window that just changed (ruling R31).

    ``in_window`` is the new state. Nothing is alerted or forced here: each incident
    ends with one log line saying which way the window went, and the next pass starts
    afresh, its alerts still limited by the floors.

    * A silent-group incident ends on either change. Group incidents open only inside
      the window, so one open at the close belongs to the session that just ended.
    * A stuck-shard incident ends only when the window opens, and only if it is
      older than ``STUCK_S``. At the close the twin is still streaming (the index
      options trade to 16:15 ET), so the shard would be found stuck again in the
      same pass and a duplicate pair of events sent. At the open, an incident older
      than ``STUCK_S`` is left over from the last session, and would carry on with
      no new alert; a younger one began in the minute before 09:31 and keeps its
      escalation.

    Each incident is dropped after its line is logged, so a failure part way is
    retried by the next pass for the ones left.
    """
    window = "opened" if in_window else "closed"
    if in_window:
        for shard, incident in list(watch.incidents.items()):
            if now - incident.started_at <= socket_stats.STUCK_S:
                continue
            log.info(
                "stuck trade socket incident ended by the trade window",
                extra={
                    "shard": shard,
                    "duration_s": round(now - incident.started_at, 3),
                    "forced_reconnects": incident.forced,
                    "window": window,
                },
            )
            del watch.incidents[shard]
    for key, silent in list(watch.group_incidents.items()):
        log.info(
            "option trades silent incident ended by the trade window",
            extra={"group": key, "duration_s": round(now - silent.started_at, 3), "window": window},
        )
        del watch.group_incidents[key]


def _trade_groups(connectors: Mapping[str, Connector]) -> list[_Group]:
    """The trade feeds: each primary trade shard with its twin, else each trade shard alone.

    A trade shard is a connector with any ``option_trades:`` channel. A shard whose
    twin is a trade shard in ``connectors`` forms a group with it, named after the
    one that comes first; the twin is not a group of its own.
    """
    trade = [
        name
        for name, connector in connectors.items()
        if any(
            channel.startswith(socket_stats.TRADE_CHANNEL_PREFIX) for channel in connector.channels
        )
    ]
    grouped: set[str] = set()
    groups: list[_Group] = []
    for name in trade:
        if name in grouped:
            continue
        twin = socket_stats.twin_of(name)
        shards = (name, twin) if twin is not None and twin in trade else (name,)
        grouped.update(shards)
        groups.append(_Group(key=name, shards=shards))
    return groups


def _alert_silent_group(
    watch: _Watch,
    group: _Group,
    incident: _SilentIncident,
    context: dict[str, object],
    now: float,
) -> None:
    """Send the group's Sentry error unless the floor holds it, in which case log that once.

    The event stays due while the incident is open: ``_check_group`` calls this at
    every check until it has gone out (ruling R32).
    """
    since_last = _claim_floor(watch.last_group_alerted_at, group.key, now)
    if since_last is not None:
        if not incident.held_logged:
            incident.held_logged = True
            log.warning(
                "option trades silent alert held back",
                extra={
                    "group": group.key,
                    "shards": context["shards"],
                    "event": _GROUP_EVENT,
                    "since_last_trade_s": context["since_last_trade_s"],
                    "since_last_alert_s": round(since_last, 3),
                },
            )
        return
    incident.alerted = True
    capture_message(_GROUP_EVENT, level="error", tags=_TAGS, context=context)


def _check_group(watch: _Watch, group: _Group, now: float, in_window: bool) -> None:
    """Move the group's high-water mark, end a resumed incident, open or alert for a silent feed.

    The mark is the latest trade frame seen on any of the group's sockets, and starts
    at ``now`` the first time the group is seen. It lives in ``watch`` because
    ``session_start`` clears ``last_trade_at`` at every reconnect. It is read once per
    check, so it is exact to within one check interval: a trade that arrives and is
    then cleared by a reconnect of every socket of the group before the next check is
    missed, and the alert can come up to that long early.
    """
    high_water = watch.high_water.setdefault(group.key, now)
    for shard in group.shards:
        last = socket_stats.get(shard).last_trade_at
        if last is not None and last > high_water:
            high_water = last
    watch.high_water[group.key] = high_water

    incident = watch.group_incidents.get(group.key)
    if incident is not None and high_water > incident.started_at:
        del watch.group_incidents[group.key]
        log.info(
            "option trades resumed",
            extra={
                "group": group.key,
                "shards": list(group.shards),
                "duration_s": round(now - incident.started_at, 3),
            },
        )
        incident = None
    if not in_window or now - high_water < GROUP_SILENT_S:
        return
    if incident is not None and incident.alerted:
        return
    context: dict[str, object] = {
        "shards": list(group.shards),
        "connected": {shard: bool(state.connections.get(shard)) for shard in group.shards},
        "since_last_trade_s": round(now - high_water, 3),
        "twins_enabled": len(group.shards) > 1,
    }
    if incident is None:
        incident = watch.group_incidents[group.key] = _SilentIncident(started_at=now)
        log.warning("option trades silent on every copy", extra={"group": group.key, **context})
    _alert_silent_group(watch, group, incident, context, now)


def _check_groups(
    watch: _Watch, connectors: Mapping[str, Connector], now: float, in_window: bool
) -> None:
    """Check every trade group, each on its own: one group's failure leaves the rest checked."""
    for group in _trade_groups(connectors):
        try:
            _check_group(watch, group, now, in_window)
        except Exception as exc:
            rate_limited_log.error(
                scope="stuck_sockets",
                kind="check",
                key=f"group:{group.key}",
                message="stuck-socket check failed",
                extra={"group": group.key, "err_type": type(exc).__name__, "err": str(exc)},
            )


def _update_window(watch: _Watch, now: float) -> bool | None:
    """Read the trade window from the wall clock and end the incidents a change ends.

    Returns whether the window is open, or ``None`` if reading it or ending the
    incidents failed. A failure is logged at error level and leaves ``watch.in_window``
    where it was, so the next pass sees the change again. It is guarded on its own so
    that a fault in the window code costs the group rule and nothing else.
    """
    try:
        in_window = market_calendar.in_trade_window(datetime.now(UTC))
        if in_window != watch.in_window:
            _end_for_window(watch, now, in_window)
            watch.in_window = in_window
    except Exception as exc:
        rate_limited_log.error(
            scope="stuck_sockets",
            kind="window",
            message="trade-window check failed",
            extra={"err_type": type(exc).__name__, "err": str(exc)},
        )
        return None
    return in_window


def _check(watch: _Watch, connectors: Mapping[str, Connector], now: float) -> None:
    """One pass at monotonic time ``now``: the trade window, the stuck shards, the silent groups.

    The trade window is read first, and a change ends the incidents it ends. If that
    fails the group check is skipped and the rest goes on. Then recovered shard
    incidents end and each stuck shard is handled, each on its own: a failure for one
    (a connector missing from ``connectors``, a ``force_reconnect`` that raises) is
    logged under its own rate-limit key, and the shards after it are still handled.
    Last, each trade group is checked the same way.
    """
    in_window = _update_window(watch, now)
    _end_recovered(watch, now)
    for found in socket_stats.find_stuck(now):
        try:
            _handle_stuck(watch, connectors, found, now)
        except Exception as exc:
            rate_limited_log.error(
                scope="stuck_sockets",
                kind="check",
                key=found.shard,
                message="stuck-socket check failed",
                extra={"shard": found.shard, "err_type": type(exc).__name__, "err": str(exc)},
            )
    if in_window is not None:
        _check_groups(watch, connectors, now, in_window)


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
