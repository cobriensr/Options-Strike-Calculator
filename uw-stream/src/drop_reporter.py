"""Backpressure drop reporter: sends queue drops to Sentry every 60 s.

Every handler queue (``HandlerMetrics.drop_count``) and the shared receive
queue (``state.receive_queue_drops``) count the payloads they evict. Those
counters are cumulative and, before this task, were visible only on
/metrics, so a Neon stall could shed rows for hours without an alert.

Each interval this task sends one Sentry warning per handler with new drops
and one for the receive queue, carrying the drops since the previous report
(the delta) plus the running total. A quiet interval sends nothing. If a
report fails, its baseline is left alone, so those drops go out with the
next successful report instead of being lost.
"""

from __future__ import annotations

import asyncio
from typing import Any

from logger_setup import log
from sentry_setup import capture_message
from state import state

# How often to report. Matches the cadence the README has always promised.
_REPORT_INTERVAL_S = 60.0


def _report(message: str, *, tags: dict[str, str], context: dict[str, Any]) -> bool:
    """Send one warning; return False (never raise) if the capture fails."""
    try:
        capture_message(message, level="warning", tags=tags, context=context)
    except Exception as exc:
        log.error("drop report failed", extra={"tags": tags, "err": str(exc)})
        return False
    return True


async def run_drop_reporter() -> None:
    """Report new handler-queue and receive-queue drops every interval."""
    # Drop totals already reported, keyed by handler name. Bounded: handler
    # names are the closed set built at boot.
    reported: dict[str, int] = {}
    reported_receive = 0
    while True:
        await asyncio.sleep(_REPORT_INTERVAL_S)

        for name, metrics in list(state.handlers.items()):
            total = metrics.drop_count
            dropped = total - reported.get(name, 0)
            if dropped <= 0:
                continue
            if _report(
                "uw-stream handler queue dropped payloads",
                tags={"component": "backpressure", "queue": "handler", "handler": name},
                context={
                    "dropped": dropped,
                    "drop_total": total,
                    "queue_depth": metrics.queue_depth,
                    "interval_s": _REPORT_INTERVAL_S,
                },
            ):
                reported[name] = total

        total = state.receive_queue_drops
        dropped = total - reported_receive
        if dropped > 0 and _report(
            "uw-stream receive queue dropped frames",
            tags={"component": "backpressure", "queue": "receive"},
            context={
                "dropped": dropped,
                "drop_total": total,
                "queue_depth": state.receive_queue_depth,
                "interval_s": _REPORT_INTERVAL_S,
            },
        ):
            reported_receive = total
