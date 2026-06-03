"""Subscription watchdog — detects SILENT per-channel subscription failures.

The 2026-06-02 outage was a silent failure: UW rejected joins (50-channel/
connection cap) and nothing noticed for ~20h because the socket stayed open and
``ws_connected`` read green. Channel sharding shrinks the blast radius but adds
no detection — a single shard whose joins are rejected still goes unnoticed.

This watchdog closes that gap: it periodically checks which channels are still
unsubscribed and raises a Sentry warning when any stay unsubscribed across
consecutive checks (past the startup grace), independent of WHY (no ack, or an
error/NACK ack the router discards). A future silent upstream change then
surfaces in minutes, not hours.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from logger_setup import log
from sentry_setup import capture_message
from state import state

# How often to evaluate subscription state.
_CHECK_INTERVAL_S = 120.0
# Consecutive failed checks before alerting. >=2 tolerates a transient reconnect
# (a shard re-subscribes within seconds — well under one interval — so its
# channels are subscribed again by the next check and never accumulate strikes).
_STRIKES_TO_ALERT = 2
# Don't evaluate until the daemon has had time to connect + subscribe.
_STARTUP_GRACE_S = 300.0
# Cap how many channel names we attach to the alert payload.
_SAMPLE = 20


def _evaluate(
    subscribed: dict[str, bool],
    strikes: dict[str, int],
    alerted: set[str],
) -> list[str]:
    """Update strike counts; return channels NEWLY crossing the alert threshold.

    Pure logic (no I/O) so it's unit-testable. Mutates ``strikes`` (per-channel
    consecutive-unsubscribed count) and ``alerted`` (channels already alerted,
    so we don't re-spam). A channel that re-subscribes resets its strikes and
    clears its alerted flag (so a later re-failure alerts again).
    """
    newly: list[str] = []
    for ch, is_sub in subscribed.items():
        if is_sub:
            strikes[ch] = 0
            alerted.discard(ch)
            continue
        strikes[ch] = strikes.get(ch, 0) + 1
        if strikes[ch] >= _STRIKES_TO_ALERT and ch not in alerted:
            alerted.add(ch)
            newly.append(ch)
    return newly


async def run_subscription_watchdog() -> None:
    """Periodically alert on channels stuck unsubscribed (silent-failure guard)."""
    strikes: dict[str, int] = {}
    alerted: set[str] = set()
    while True:
        await asyncio.sleep(_CHECK_INTERVAL_S)
        uptime = (datetime.now(UTC) - state.started_at).total_seconds()
        # Skip during startup (joins still settling) and total disconnects
        # (the connector's reconnect path + health already cover those).
        if uptime < _STARTUP_GRACE_S or not state.ws_any_connected:
            continue
        subscribed = {name: ch.subscribed for name, ch in state.channels.items()}
        newly = _evaluate(subscribed, strikes, alerted)
        if newly:
            stuck_total = sum(1 for is_sub in subscribed.values() if not is_sub)
            log.warning(
                "channels stuck unsubscribed",
                extra={"newly": newly[:_SAMPLE], "stuck_total": stuck_total},
            )
            capture_message(
                "uw-stream channels stuck unsubscribed",
                level="warning",
                tags={"component": "subscription_watchdog"},
                context={
                    "newly_count": len(newly),
                    "stuck_total": stuck_total,
                    "sample": newly[:_SAMPLE],
                },
            )
