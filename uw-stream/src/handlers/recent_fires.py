"""Process-local registry of recent Interval B/A fires.

Used by :class:`IntervalBAHandler` subclasses to detect cross-symbol
confluence: when an alert fires, the handler asks the registry
"which OTHER tickers fired the same direction in the last N seconds?".
The answer is written to the alert row's ``confluence_tickers`` column.

The registry is in-memory only — uw-stream is a single-process Railway
service running one asyncio loop. The confluence spec deliberately
accepts asymmetric tagging on write (earlier rows have empty
``confluence_tickers``; later rows enumerate the partners), and the
registry's only job is to supply the backward-looking half of the
symmetric ±N-second window. Phase 7 backfill closes the asymmetry
retroactively.

Bounded memory: ``deque(maxlen=200)`` per ``(ticker, option_type)``
key. At a peak fire rate of ~10/minute per (ticker, dir) — well above
the 2-3/minute the live signal generates in practice — the deque
retains ~20 minutes of fires, far more than any reasonable confluence
window.

Lock discipline: a :class:`threading.Lock` guards mutations. The
current daemon is single-asyncio-loop (no threads), but a future
move to a thread-per-handler model would otherwise race the deque
append against another handler's lookup iteration. Cheap insurance.

See ``docs/superpowers/specs/interval-ba-confluence-2026-05-13.md``.
"""

from __future__ import annotations

from collections import deque
from datetime import datetime
from threading import Lock

# Per-(ticker, option_type) bounded deque of fire timestamps. The
# maxlen bound is the only eviction mechanism — at the rates we see,
# time-based pruning is unnecessary.
_MAX_LEN = 200

_RegistryKey = tuple[str, str]  # (ticker, option_type)
_fires: dict[_RegistryKey, deque[datetime]] = {}
_lock = Lock()


def record(ticker: str, option_type: str, fired_at: datetime) -> None:
    """Append ``fired_at`` to the registry for this (ticker, direction).

    Call this exactly once per successful Interval B/A fire AFTER
    computing the confluence list — see ``lookup_confluence`` below.
    Calling it before would still be correct (the lookup filters out
    the caller's own ticker) but the post-lookup ordering is the
    intent the spec documents.
    """
    key = (ticker, option_type)
    with _lock:
        dq = _fires.get(key)
        if dq is None:
            dq = deque(maxlen=_MAX_LEN)
            _fires[key] = dq
        dq.append(fired_at)


def lookup_confluence(
    ticker: str,
    option_type: str,
    fired_at: datetime,
    window_sec: int,
) -> list[str]:
    """Return OTHER tickers that fired same-direction within window_sec.

    Backward-looking only — entries with
    ``0 <= (fired_at - entry) <= window_sec`` count as confluence.
    The "look forward" half of the symmetric window is filled in by
    the LATER-firing handler's own lookback (which sees this fire
    once :func:`record` has added it).

    Output is sorted ascending so the resulting ``confluence_tickers``
    column has stable content for the same input, regardless of dict
    iteration order — important for tests and for any downstream
    equality checks.
    """
    out: list[str] = []
    with _lock:
        for (other_ticker, opt), dq in _fires.items():
            if other_ticker == ticker:
                # The caller's own deque — never report self-confluence.
                continue
            if opt != option_type:
                continue
            # Scan from newest to oldest; entries are append-monotonic
            # because ``fired_at`` is wall-clock ``datetime.now()``.
            # Once we cross the backward edge of the window, every
            # remaining entry is even older — break early.
            for ts in reversed(dq):
                delta = (fired_at - ts).total_seconds()
                if delta < 0:
                    # ts is in the future relative to fired_at. Can
                    # only happen if two fires share the same instant
                    # or under clock skew — keep scanning the rest of
                    # the deque rather than breaking.
                    continue
                if delta <= window_sec:
                    out.append(other_ticker)
                    break
                # delta > window_sec — older entries are older still.
                break
    return sorted(out)


def _reset_for_tests() -> None:
    """Clear the module-level registry. TEST-ONLY.

    Called by per-test fixtures so cross-test pollution doesn't make
    fire-X "confluent" with a fire-Y from an earlier test.
    """
    with _lock:
        _fires.clear()
