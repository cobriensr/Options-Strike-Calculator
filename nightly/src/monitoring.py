"""Sentry for the nightly job: init, the event scrubber and per-day reports.

Nothing that leaves through Sentry may carry market data or a credential (review
finding b11). The leak paths, and what closes each:
- Frame locals: uw_client frames hold the signed GCS URL, and tape_convert frames
  hold raw tape bytes. `include_local_variables=False`, and `scrub_event` drops
  `vars` from every frame that still carries them, threads included.
- Signed URLs: httpx logs every request line at INFO, and the SDK's httpx
  integration puts the raw query in a breadcrumb's `http.query`. `scrub_event`
  strips the query from every URL anywhere in the event and drops those keys.
- polars error text quotes cell values, so a polars exception's value is replaced.
- Anything else is cut to MAX_EXCEPTION_VALUE characters.

Every Sentry event is an explicit capture: the logging integration records
breadcrumbs only, never events, so a run that logs and captures a failure sends it once.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import sentry_sdk
from sentry_sdk.integrations.logging import LoggingIntegration

from tape_job import RELAND_IDENTICAL, DayOutcome

log = logging.getLogger(__name__)

POLARS_REDACTED = "<redacted polars message>"
MAX_EXCEPTION_VALUE = 300
# Statuses that are expected now and then (UW posts late; old days age out).
_WARNING_STATUSES = frozenset({"not_posted", "unavailable"})
# A URL up to its query or fragment, which is dropped. The run before `?` is bounded
# and possessive, so each candidate scans at most 2 KiB; a real path is far shorter.
_URL_QUERY = re.compile(r"(https?://[^\s?#'\"<>]{0,2048}+)[?#][^\s'\"<>]*+", re.IGNORECASE)
# Breadcrumb data keys where the SDK's HTTP integrations keep the raw query.
_QUERY_KEYS = frozenset({"http.query", "http.fragment"})
_FRAME_DROP_KEYS = _QUERY_KEYS | {"vars"}


def init_sentry(dsn: str | None) -> None:
    """Start the SDK with the scrubber; without a DSN, Sentry stays off."""
    if not dsn:
        log.info("SENTRY_DSN not set; Sentry disabled")
        return
    # Trap: sentry-sdk 2.73 deprecates send_default_pii in favour of data_collection,
    # and a data_collection dict, once given, overrides both options below. A migration
    # to it must set stack_frame_variables=False and user_info=False, or frame locals
    # (signed URLs, raw tape bytes) start reaching Sentry.
    sentry_sdk.init(
        dsn=dsn,
        server_name="nightly",
        include_local_variables=False,
        send_default_pii=False,
        traces_sample_rate=0,
        before_send=scrub_event,
        integrations=[LoggingIntegration(level=logging.INFO, event_level=None)],
    )
    sentry_sdk.set_tag("service", "nightly")


def scrub_event(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any] | None:
    """`before_send`: the event with polars text, URL queries and frame locals removed
    and exception values cut to MAX_EXCEPTION_VALUE characters.

    The SDK also calls this for cron check-ins, which pass through unchanged. If it
    raised, the SDK would drop the event, so it only reads shapes it checks for.
    """
    scrubbed: dict[str, Any] = _scrubbed_copy(event)
    for value in _values_of(scrubbed.get("exception")):
        text = value.get("value")
        if _from_polars(value):
            value["value"] = POLARS_REDACTED
        elif isinstance(text, str):
            value["value"] = text[:MAX_EXCEPTION_VALUE]
    return scrubbed


def report_outcome(outcome: DayOutcome) -> None:
    """One Sentry message for a day that didn't land, that landed with warnings, or
    that was re-landed.

    The title names the status only, one of a closed set; the day and status are
    tags, and `detail` (a kind, class name or fixed phrase), `reason` (log-safe by
    contract, see DayOutcome) and the warnings (window edges, ratios and fixed
    phrases) go in extra. None of them carries a tape value.
    """
    tags = {"day": outcome.day.isoformat(), "status": outcome.status}
    if outcome.status == "landed":
        if outcome.warnings:
            sentry_sdk.capture_message(
                "nightly tape day landed with warnings",
                level="warning",
                tags=tags,
                extras={"warnings": list(outcome.warnings)},
            )
        return
    if outcome.status == "relanded":
        # Every re-land, warnings or not: the healthy rate is about zero. The same
        # content under a new ETag gets its own title, since it suggests ETag churn.
        identical = RELAND_IDENTICAL in outcome.warnings
        sentry_sdk.capture_message(
            "nightly re-land identical content" if identical else "nightly tape day relanded",
            level="warning",
            tags=tags,
            extras={"warnings": list(outcome.warnings)},
        )
        return
    # One issue per status and failure kind, so a new kind opens a new issue. A marker
    # is permanent, so each one also names its day: it opens, and alerts as, its own.
    fingerprint = ["nightly-tape-day", outcome.status, outcome.detail]
    if outcome.status == "unavailable":
        fingerprint.append(outcome.day.isoformat())
    sentry_sdk.capture_message(
        f"nightly tape day {outcome.status}",
        level="warning" if outcome.status in _WARNING_STATUSES else "error",
        tags=tags,
        extras={
            "detail": outcome.detail,
            "reason": outcome.reason,
            "warnings": list(outcome.warnings),
        },
        fingerprint=fingerprint,
    )


def _values_of(container: object) -> list[dict[str, Any]]:
    """The dict items of `container["values"]`, the SDK's list wrapper."""
    if not isinstance(container, dict):
        return []
    values = container.get("values")
    if not isinstance(values, list):
        return []
    return [v for v in values if isinstance(v, dict)]


def _frames(value: dict[str, Any]) -> list[dict[str, Any]]:
    stacktrace = value.get("stacktrace")
    if not isinstance(stacktrace, dict):
        return []
    frames = stacktrace.get("frames")
    if not isinstance(frames, list):
        return []
    return [f for f in frames if isinstance(f, dict)]


def _from_polars(value: dict[str, Any]) -> bool:
    """A polars exception class, or any exception raised from a polars frame."""
    if _is_polars_module(value.get("module")):
        return True
    frames = _frames(value)
    return bool(frames) and _is_polars_module(frames[-1].get("module"))


def _is_polars_module(module: object) -> bool:
    if not isinstance(module, str):
        return False
    root = module.split(".", 1)[0]
    return root == "polars" or root.startswith("_polars")


def _scrubbed_copy(value: Any, *, frame: bool = False) -> Any:
    """A copy of `value` with every URL's query and fragment removed from its strings,
    the `http.query` / `http.fragment` keys dropped from its dicts, and `vars` dropped
    from every dict in a `frames` list (exception, thread or any other stacktrace)."""
    if isinstance(value, str):
        return _URL_QUERY.sub(r"\1", value)
    if isinstance(value, dict):
        drop = _FRAME_DROP_KEYS if frame else _QUERY_KEYS
        return {
            k: _scrubbed_copy(v, frame=k == "frames") for k, v in value.items() if k not in drop
        }
    if isinstance(value, list):
        return [_scrubbed_copy(v, frame=frame) for v in value]
    return value
