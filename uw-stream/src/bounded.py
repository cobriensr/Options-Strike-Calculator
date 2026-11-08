"""Hard-bounded awaits for the shutdown path.

``asyncio.wait_for`` cannot give a hard bound. At its deadline it cancels the
inner awaitable and then waits for it to finish unwinding, so work that will
not unwind promptly (a flush parked in a DB call, a websocket mid close
handshake) holds the caller past Railway's SIGKILL window.

``run_bounded`` waits on the work with ``asyncio.wait`` instead. At the deadline
it cancels the work and raises ``TimeoutError`` at once, leaving the work to
unwind in the background.
"""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Awaitable

from logger_setup import log

# Work cancelled at its deadline and still unwinding. The event loop holds
# tasks only weakly, so without this a task could be collected mid-unwind.
# Bounded: shutdown runs each bounded step once, and an entry leaves when its
# task finishes.
_unwinding: set[asyncio.Future] = set()


def _reap(name: str, task: asyncio.Future) -> None:
    """Forget a finished abandoned task; log a failure nobody will await."""
    _unwinding.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    # A cancelled asyncio.gather() ends with a CancelledError exception instead
    # of as cancelled. That is the cancel we asked for, not a failure.
    if exc is not None and not isinstance(exc, asyncio.CancelledError):
        log.warning(
            "bounded task failed while unwinding after its deadline",
            extra={"task": name, "err": str(exc)},
        )


def _abandon(name: str, task: asyncio.Future) -> None:
    """Cancel ``task`` and leave it to unwind without anyone awaiting it."""
    task.cancel()
    _unwinding.add(task)
    task.add_done_callback(functools.partial(_reap, name))


async def run_bounded[T](aw: Awaitable[T], timeout_s: float, *, name: str) -> T:
    """Await ``aw`` for at most ``timeout_s`` seconds, whatever it is doing.

    Returns its result, or raises what it raised. At the deadline it cancels
    ``aw`` and raises ``TimeoutError`` without waiting for the cancellation to
    complete. No ``await`` sits between the deadline and the raise, so the
    caller's ``except TimeoutError`` block sees the state the work had when
    the deadline hit. If the caller is cancelled, ``aw`` is cancelled with it.
    """
    task = asyncio.ensure_future(aw)
    try:
        done, _pending = await asyncio.wait({task}, timeout=timeout_s)
    except asyncio.CancelledError:
        _abandon(name, task)
        raise
    if task in done:
        return task.result()
    _abandon(name, task)
    raise TimeoutError(f"{name} exceeded {timeout_s} s")
