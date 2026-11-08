"""Backpressure drop reporter: sends queue drops and lost rows to Sentry every 60 s.

Every handler queue (``HandlerMetrics.drop_count``) and the shared receive
queue (``state.receive_queue_drops``) count the payloads they evict. Those
counters are cumulative and, before this task, were visible only on
/metrics, so a Neon stall could shed rows for hours without an alert.

Handlers also count ``lost_rows``: the rows of flushes that failed after
the db retries. Each interval this task sends one Sentry warning per handler
with new drops or new lost rows, and one for the receive queue, carrying the
amounts since the previous report (the deltas) plus the running totals. A
quiet interval sends nothing. When shutdown cancels the task it runs one more
pass first, so the last minute's drops, which are the ones a deploy causes, are
not left waiting for a tick that never comes.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from logger_setup import log
from sentry_setup import capture_message
from state import state

# How often to report. Matches the cadence the README has always promised.
_REPORT_INTERVAL_S = 60.0


@dataclass
class _Reported:
    """What earlier passes already sent, so each pass sends only the delta."""

    # (drop_count, lost_rows) totals per handler name. Bounded: handler names are
    # the closed set built at boot.
    handlers: dict[str, tuple[int, int]] = field(default_factory=dict)
    receive: int = 0


def _report_new(reported: _Reported) -> None:
    """Send one warning per queue that dropped or lost rows since the last pass.

    capture_message never raises: sentry_setup catches an SDK failure and logs
    it. So a pass cannot stop the loop, and it always moves the baseline.
    """
    for name, metrics in list(state.handlers.items()):
        drop_total, lost_total = metrics.drop_count, metrics.lost_rows
        prev_drops, prev_lost = reported.handlers.get(name, (0, 0))
        dropped, lost = drop_total - prev_drops, lost_total - prev_lost
        if dropped <= 0 and lost <= 0:
            continue
        capture_message(
            "uw-stream handler dropped or lost rows",
            level="warning",
            tags={"component": "backpressure", "queue": "handler", "handler": name},
            context={
                "dropped": dropped,
                "drop_total": drop_total,
                "lost_rows": lost,
                "lost_rows_total": lost_total,
                "queue_depth": metrics.queue_depth,
                "interval_s": _REPORT_INTERVAL_S,
            },
        )
        reported.handlers[name] = (drop_total, lost_total)

    total = state.receive_queue_drops
    dropped = total - reported.receive
    if dropped > 0:
        capture_message(
            "uw-stream receive queue dropped frames",
            level="warning",
            tags={"component": "backpressure", "queue": "receive"},
            context={
                "dropped": dropped,
                "drop_total": total,
                "queue_depth": state.receive_queue_depth,
                "interval_s": _REPORT_INTERVAL_S,
            },
        )
        reported.receive = total


async def run_drop_reporter() -> None:
    """Report new queue drops and lost flush rows every interval."""
    reported = _Reported()
    try:
        while True:
            await asyncio.sleep(_REPORT_INTERVAL_S)
            _report_new(reported)
    except asyncio.CancelledError:
        # _shutdown cancels this task after the handlers have drained, so a
        # failed final flush has already counted its lost rows. The pass is
        # synchronous: a second cancel cannot interrupt it.
        log.info("drop reporter cancelled; sending the final report")
        _report_new(reported)
        raise
