"""Process and container memory, and the sizes of the in-memory stores that report one.

uw-stream's memory climbs through the trading day (0.46 GB on 2026-11-09, 0.58 on
11-12, 0.69 on 11-13; the process that ran before reached 1.0 GB). Three numbers
say where it goes, and the per-minute pipeline line and ``/metrics`` print all of
them:

* ``read_rss_bytes``: the process's resident set, from ``/proc/self/statm``. This
  is the process alone.
* ``read_cgroup_bytes``: the container's memory, from the cgroup. This is the
  figure Railway's memory graph plots, and it includes page cache, which the
  process does not own. RSS flat while this climbs is the kernel caching files,
  not uw-stream.
* The gauges: a registry of named size callbacks that the stores which can grow
  register (``option_trades.dedupe_keys``, ``option_trades:SPY.ticks``, ...).
  RSS climbing while one gauge climbs with it names the structure; RSS climbing
  with every gauge flat is something no gauge measures.

Both readers return None when the source cannot be read or does not parse: a
missing file (macOS, Windows, a test run), an unreadable one, or text that is
not the number the kernel writes. They never guess 0, which would print "the
process uses no memory". The paths are module constants, so a test points them
at files under ``tmp_path``.

**Gauges are callbacks, read on a schedule.** ``register_gauge(name, fn)`` stores
``fn``; nothing calls it there. ``read_gauges`` calls each one, and only the
once-a-minute reporter (``pipeline_stats``) and a ``/metrics`` request do, so no
gauge runs on a hot path and the reporter never reaches into a handler's
internals. A gauge that raises is left out of that read and logged as at most
one rate-limited WARNING per gauge per 60 s window (a broken gauge logs every
minute or two, since the reporter's minutes can fall just inside the window);
the rest still report. A log line is
not a Sentry event (``init_sentry`` sets ``event_level=None``), and nothing here
raises an error-level line or captures a message: a memory number that fails to
read must never page.

**The registry is bounded.** Names come from a closed set: the handler that owns
the structure plus a suffix. Registering a name again replaces the callback, so
a handler built twice (a restart in a test) leaves one entry and does not keep
the old handler alive. A name past ``MAX_GAUGES`` is refused with a warning, so
a caller that made names up per call could not grow it.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from logger_setup import rate_limited_log

# The fields of /proc/self/statm are sizes in pages: size, resident, shared, ...
STATM_PATH = Path("/proc/self/statm")
# The container's current memory: cgroup v2, else the v1 name. Railway's graph
# tracks this number.
CGROUP_V2_PATH = Path("/sys/fs/cgroup/memory.current")
CGROUP_V1_PATH = Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")

# Three gauges per Interval B/A handler (three of them) plus the option_trades
# one come to ten today. A bound, not a knob: the registry is keyed by a closed
# set of names, and this is what stops it being anything else.
MAX_GAUGES = 32

# Name -> callback returning a size. Bounded by ``MAX_GAUGES``.
_gauges: dict[str, Callable[[], int]] = {}


def read_rss_bytes() -> int | None:
    """The process's resident set in bytes, or None if ``/proc/self/statm`` can't be read.

    The second field of statm is the resident set in pages; the page size comes
    from ``os.sysconf``. A missing file, a short or non-numeric one, a negative
    count, a page size the OS refuses and an OS with no ``os.sysconf`` (Windows,
    where the statm read fails first) all give None.
    """
    try:
        fields = STATM_PATH.read_bytes().split()
        pages = int(fields[1])
        page_size = os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None
    if pages < 0:
        return None
    return pages * page_size


def _read_single_int(path: Path) -> int | None:
    """The one non-negative integer in ``path``, or None for anything else (absent, ``max``, junk)."""
    try:
        fields = path.read_bytes().split()
    except OSError:
        return None
    if len(fields) != 1:
        return None
    try:
        value = int(fields[0])
    except ValueError:
        return None
    return value if value >= 0 else None


def read_cgroup_bytes() -> int | None:
    """The container's memory in bytes, or None if no cgroup file reads.

    Tries cgroup v2's ``memory.current``, then v1's ``memory.usage_in_bytes``:
    the first that holds a number wins, so a v2 file that is absent or does not
    parse falls through to v1. Page cache is counted, as in Railway's graph.
    """
    for path in (CGROUP_V2_PATH, CGROUP_V1_PATH):
        value = _read_single_int(path)
        if value is not None:
            return value
    return None


def register_gauge(name: str, fn: Callable[[], int]) -> None:
    """Register ``fn`` as the size gauge ``name``, replacing any earlier one of that name.

    ``fn`` is not called here; ``read_gauges`` calls it. A new name past
    ``MAX_GAUGES`` is refused and logged (one rate-limited warning).
    """
    if name not in _gauges and len(_gauges) >= MAX_GAUGES:
        rate_limited_log.warning(
            scope="memory_stats",
            kind="gauge_registry_full",
            message="memory gauge not registered: registry is full",
            extra={"gauge": name, "max_gauges": MAX_GAUGES},
        )
        return
    _gauges[name] = fn


def read_gauges() -> dict[str, int]:
    """Call every registered gauge once; a gauge that raises is left out and logged.

    The failure is a rate-limited WARNING per gauge (at most one a minute), never
    an error-level line. ``except Exception`` leaves a cancel (a BaseException)
    alone. Iterates a copy, so a gauge that registers another cannot break the
    pass.
    """
    values: dict[str, int] = {}
    for name, fn in list(_gauges.items()):
        try:
            values[name] = fn()
        except Exception as exc:
            rate_limited_log.warning(
                scope="memory_stats",
                kind="gauge_failed",
                key=name,
                message="memory gauge failed",
                extra={"gauge": name, "err_type": type(exc).__name__, "err": str(exc)},
            )
    return values


@dataclass(frozen=True, slots=True)
class MemorySnapshot:
    """One reading of all three: what the minute line and ``/metrics`` print."""

    rss_bytes: int | None
    cgroup_bytes: int | None
    gauges: dict[str, int]


def snapshot() -> MemorySnapshot:
    """Read the process, the container and every gauge now."""
    return MemorySnapshot(
        rss_bytes=read_rss_bytes(),
        cgroup_bytes=read_cgroup_bytes(),
        gauges=read_gauges(),
    )
