"""Backpressure drop reporter: sends queue drops and lost rows to Sentry every 60 s.

Every handler queue (``HandlerMetrics.drop_count``) and the shared receive
queue (``state.receive_queue_drops``) count the payloads they evict. Those
counters are cumulative and, before this task, were visible only on
/metrics, so a Neon stall could shed rows for hours without an alert.

Handlers also count ``lost_rows``: the rows of flushes that failed after
the db retries. Each interval this task sends one Sentry warning per handler
with new drops or new lost rows, and one for the receive queue, carrying the
amounts since the previous report (the deltas) plus the running totals. A
quiet interval sends nothing. If a report fails, its baseline is left alone,
so those amounts go out with the next successful report instead of vanishing.
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
    """Report new queue drops and lost flush rows every interval."""
    # (drop_count, lost_rows) totals already reported, keyed by handler name.
    # Bounded: handler names are the closed set built at boot.
    reported: dict[str, tuple[int, int]] = {}
    reported_receive = 0
    while True:
        await asyncio.sleep(_REPORT_INTERVAL_S)

        for name, metrics in list(state.handlers.items()):
            drop_total, lost_total = metrics.drop_count, metrics.lost_rows
            prev_drops, prev_lost = reported.get(name, (0, 0))
            dropped, lost = drop_total - prev_drops, lost_total - prev_lost
            if dropped <= 0 and lost <= 0:
                continue
            if _report(
                "uw-stream handler dropped or lost rows",
                tags={"component": "backpressure", "queue": "handler", "handler": name},
                context={
                    "dropped": dropped,
                    "drop_total": drop_total,
                    "lost_rows": lost,
                    "lost_rows_total": lost_total,
                    "queue_depth": metrics.queue_depth,
                    "interval_s": _REPORT_INTERVAL_S,
                },
            ):
                reported[name] = (drop_total, lost_total)

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
