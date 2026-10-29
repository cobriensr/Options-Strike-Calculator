"""Tests for the Sentry layer: init options, event scrubbing and per-day reports.

Exception events come from the installed SDK's own `event_from_exception`, so they
have the shape `before_send` receives. One test runs events through a real
`sentry_sdk.Client` built from `init_sentry`'s options, with an in-memory transport,
so nothing is sent and the wire bytes can be read back.
"""

from __future__ import annotations

import json
import logging
import warnings
from collections.abc import Iterator
from datetime import date
from typing import Any, get_args
from unittest.mock import create_autospec, patch

import polars as pl
import pytest
import sentry_sdk
from sentry_sdk.consts import SPANDATA
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.transport import Transport
from sentry_sdk.utils import event_from_exception, has_data_collection_enabled

from monitoring import init_sentry, report_outcome, scrub_event
from tape_job import DayOutcome, DayStatus

SIGNED_URL = "https://storage.googleapis.com/b/o.zip?X-Goog-Signature=abc&X-Goog-Credential=def"
SIGNED_QUERY = "X-Goog-Signature=abc&X-Goog-Credential=def"
URL_PATH = "https://storage.googleapis.com/b/o.zip"
FAKE_DSN = "https://public@sentry.invalid/1"
REDACTED = "<redacted polars message>"
DAY = date(2026, 10, 28)
# Built at runtime: the SDK sends source lines as frame context, and a literal there
# would look like a leak of the runtime value.
TAPE_VALUE = "-".join(("SECRET", "TAPE", "VALUE"))
RAW_BYTES = "-".join(("RAW", "TAPE", "BYTES")).encode()


def _exception_event(exc: BaseException) -> dict[str, Any]:
    """The event the SDK builds for `exc`, round-tripped through JSON as before_send
    sees it (the SDK serializes the event before calling before_send)."""
    event, _hint = event_from_exception(exc)
    return json.loads(json.dumps(event, default=str))


def _raised(exc: BaseException) -> BaseException:
    try:
        raise exc
    except BaseException as caught:
        return caught


def _polars_error() -> BaseException:
    try:
        pl.Series([TAPE_VALUE]).cast(pl.Int64)
    except pl.exceptions.PolarsError as exc:
        return exc
    raise AssertionError("polars accepted the cast")


def _values(event: dict[str, Any]) -> list[dict[str, Any]]:
    return event["exception"]["values"]


def _http_breadcrumb() -> dict[str, Any]:
    """What sentry_sdk.integrations.httpx records: url without the query, the raw
    query beside it (parse_url(..., sanitize=False))."""
    return {
        "type": "http",
        "category": "httplib",
        "data": {
            SPANDATA.HTTP_METHOD: "GET",
            SPANDATA.HTTP_STATUS_CODE: 200,
            "reason": "OK",
            "url": URL_PATH,
            SPANDATA.HTTP_QUERY: SIGNED_QUERY,
            SPANDATA.HTTP_FRAGMENT: "",
        },
        "timestamp": "2026-10-29T07:20:00.000000Z",
    }


def _log_breadcrumb(message: str) -> dict[str, Any]:
    """What the logging integration's BreadcrumbHandler records for a log line."""
    return {
        "type": "log",
        "category": "httpx",
        "level": "info",
        "message": message,
        "data": {},
        "timestamp": "2026-10-29T07:20:00.000000Z",
    }


# --- init_sentry -----------------------------------------------------------------


def test_init_sentry_options() -> None:
    with (
        patch.object(sentry_sdk, "init", autospec=True) as init,
        patch.object(sentry_sdk, "set_tag", autospec=True) as set_tag,
    ):
        init_sentry(FAKE_DSN)

    kwargs = init.call_args.kwargs
    assert kwargs["dsn"] == FAKE_DSN
    assert kwargs["include_local_variables"] is False
    assert kwargs["send_default_pii"] is False
    assert kwargs["server_name"] == "nightly"
    assert kwargs["before_send"] is scrub_event
    assert kwargs["traces_sample_rate"] == 0
    (logging_integration,) = kwargs["integrations"]
    assert isinstance(logging_integration, LoggingIntegration)
    set_tag.assert_called_once_with("service", "nightly")


@pytest.mark.parametrize("dsn", [None, ""])
def test_init_sentry_without_dsn_does_nothing(dsn: str | None) -> None:
    with (
        patch.object(sentry_sdk, "init", autospec=True) as init,
        patch.object(sentry_sdk, "set_tag", autospec=True) as set_tag,
    ):
        init_sentry(dsn)
    init.assert_not_called()
    set_tag.assert_not_called()


# --- scrub_event -----------------------------------------------------------------


def test_scrub_redacts_polars_message() -> None:
    event = _exception_event(_polars_error())
    (value,) = _values(event)
    assert value["module"] == "polars.exceptions"
    assert TAPE_VALUE in value["value"]  # the leak this guards against

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    (value,) = _values(scrubbed)
    assert value["value"] == REDACTED
    assert value["type"] == "InvalidOperationError"  # the class name still reaches Sentry
    assert TAPE_VALUE not in json.dumps(scrubbed)


def test_scrub_redacts_polars_cause_but_keeps_our_message() -> None:
    try:
        try:
            pl.Series([TAPE_VALUE]).cast(pl.Int64)
        except pl.exceptions.PolarsError as exc:
            raise RuntimeError("convert failed") from exc
    except RuntimeError as outer:
        event = _exception_event(outer)

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    by_type = {v["type"]: v["value"] for v in _values(scrubbed)}
    assert by_type == {"InvalidOperationError": REDACTED, "RuntimeError": "convert failed"}


def test_scrub_redacts_builtin_error_raised_inside_polars() -> None:
    # A builtin exception class raised from a polars frame can quote values too.
    event = {
        "level": "error",
        "exception": {
            "values": [
                {
                    "module": None,
                    "type": "ValueError",
                    "value": f"could not parse {TAPE_VALUE!r}",
                    "mechanism": {"type": "generic", "handled": True},
                    "stacktrace": {
                        "frames": [
                            {"module": "tape_convert", "function": "convert_zip", "lineno": 1},
                            {"module": "polars.io.csv.functions", "function": "scan", "lineno": 2},
                        ]
                    },
                }
            ]
        },
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == REDACTED


def test_scrub_strips_signed_url_query() -> None:
    event = _exception_event(_raised(RuntimeError(f"Client error for url '{SIGNED_URL}'")))
    event["breadcrumbs"] = {
        "values": [
            _log_breadcrumb(f'HTTP Request: GET {SIGNED_URL} "HTTP/1.1 200 OK"'),
            _http_breadcrumb(),
            {"type": "default", "category": "nightly", "data": {"url": SIGNED_URL}},
        ]
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    text = json.dumps(scrubbed)
    assert "X-Goog-Signature" not in text
    assert "X-Goog-Credential" not in text
    log_crumb, http_crumb, url_crumb = scrubbed["breadcrumbs"]["values"]
    assert log_crumb["message"] == f'HTTP Request: GET {URL_PATH} "HTTP/1.1 200 OK"'
    assert http_crumb["data"]["url"] == URL_PATH
    assert SPANDATA.HTTP_QUERY not in http_crumb["data"]
    assert SPANDATA.HTTP_FRAGMENT not in http_crumb["data"]
    assert http_crumb["data"][SPANDATA.HTTP_STATUS_CODE] == 200
    assert url_crumb["data"]["url"] == URL_PATH
    assert _values(scrubbed)[0]["value"] == f"Client error for url '{URL_PATH}'"


def test_scrub_strips_queries_in_messages_and_extra() -> None:
    event = {
        "level": "warning",
        "message": f"fetch {SIGNED_URL} failed",
        "extra": {"where": [SIGNED_URL]},
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert scrubbed["message"] == f"fetch {URL_PATH} failed"
    assert scrubbed["extra"] == {"where": [URL_PATH]}


def test_scrub_keeps_urls_without_a_query() -> None:
    message = "see https://www.nyse.com/markets/hours-calendars before the new year"
    scrubbed = scrub_event({"level": "warning", "message": message}, {})
    assert scrubbed == {"level": "warning", "message": message}


def test_scrub_truncates_long_values() -> None:
    event = _exception_event(_raised(RuntimeError("x" * 1000)))
    event["exception"]["values"].append({"type": "ValueError", "value": "y" * 300})

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    long_value, exact_value = _values(scrubbed)
    assert long_value["value"] == "x" * 300
    assert exact_value["value"] == "y" * 300


def test_scrub_strips_url_before_truncating() -> None:
    # The query must go even when it starts past the cut.
    value = "e" * 290 + " " + SIGNED_URL
    event = _exception_event(_raised(RuntimeError(value)))

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert "X-Goog" not in _values(scrubbed)[0]["value"]
    assert len(_values(scrubbed)[0]["value"]) == 300


def test_scrub_drops_frame_local_variables() -> None:
    # Off in init_sentry already; dropped here too in case the option ever flips.
    def fail() -> None:
        chunk = RAW_BYTES
        raise RuntimeError(f"failed after {len(chunk)} bytes")

    try:
        fail()
    except RuntimeError as exc:
        event = _exception_event(exc)
    frames = _values(event)[0]["stacktrace"]["frames"]
    assert any("vars" in frame for frame in frames)  # the SDK default collects them

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert RAW_BYTES.decode() not in json.dumps(scrubbed)
    assert not any("vars" in frame for frame in _values(scrubbed)[0]["stacktrace"]["frames"])


def test_scrub_drops_vars_from_every_frame_list() -> None:
    secret = RAW_BYTES.decode()
    frame = {"module": "uw_client", "function": "_download_once", "vars": {"chunk": secret}}
    event = {
        "level": "error",
        "threads": {"values": [{"stacktrace": {"frames": [dict(frame)]}, "current": True}]},
        "extra": {"nested": {"stacktrace": {"frames": [dict(frame)]}}},
        "exception": {"values": [{"type": "E", "value": "v", "stacktrace": {"frames": [frame]}}]},
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert secret not in json.dumps(scrubbed)
    (thread,) = scrubbed["threads"]["values"]
    assert thread["stacktrace"]["frames"] == [{"module": "uw_client", "function": "_download_once"}]
    assert thread["current"] is True


def test_scrub_keeps_vars_keys_outside_frames() -> None:
    event = {"level": "warning", "message": "m", "extra": {"vars": "a setting name"}}
    assert scrub_event(event, {}) == event


def test_scrub_passes_check_ins_through() -> None:
    # before_send sees check-ins too; a scrub that broke them would hide every run.
    check_in = {
        "type": "check_in",
        "monitor_slug": "nightly-tape",
        "check_in_id": "4ae9c77bdd354824943c5f9f5cc1def6",
        "status": "ok",
        "duration": 12.5,
        "environment": "production",
        "release": None,
        "contexts": {"trace": {"trace_id": "3cceda4865a14aa5862ef1375706d232"}},
        "timestamp": "2026-10-29T07:20:00.000000Z",
    }
    expected = json.loads(json.dumps(check_in))

    assert scrub_event(check_in, {}) == expected


@pytest.mark.parametrize(
    "exception",
    [
        None,
        "not a dict",
        {"values": "not a list"},
        {"values": ["not a dict", {"type": "E", "value": 7, "stacktrace": "not a dict"}]},
        {"values": [{"type": "E", "value": "v", "stacktrace": {"frames": "not a list"}}]},
    ],
)
def test_scrub_tolerates_unexpected_shapes(exception: object) -> None:
    # A raise in before_send makes the SDK drop the event, so odd shapes pass through.
    event = {"level": "error", "message": f"see {SIGNED_URL}", "exception": exception}

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert scrubbed["message"] == f"see {URL_PATH}"
    assert scrubbed["exception"] == exception


class _MemoryTransport(Transport):
    """Keeps each envelope item's wire bytes instead of sending them."""

    def __init__(self, options: dict[str, Any] | None = None) -> None:
        super().__init__(options)
        self.payloads: list[bytes] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        self.payloads.extend(item.get_bytes() for item in envelope.items)


@pytest.fixture
def sdk_transport(caplog: pytest.LogCaptureFixture) -> Iterator[_MemoryTransport]:
    """A real Client built from init_sentry's own options, bound to an isolation scope.

    `default_integrations=False` keeps the SDK from patching httpx, http.client and
    threading for the rest of the session; init_sentry's LoggingIntegration is kept.
    """
    with (
        patch.object(sentry_sdk, "init", autospec=True) as init,
        patch.object(sentry_sdk, "set_tag", autospec=True),
    ):
        init_sentry(FAKE_DSN)
    options = {**init.call_args.kwargs, "default_integrations": False}
    with warnings.catch_warnings():
        # 2.73 deprecates send_default_pii (still honored); older 2.x in the pin don't.
        warnings.filterwarnings("ignore", "The send_default_pii option", DeprecationWarning)
        client = sentry_sdk.Client(transport=_MemoryTransport, **options)
    transport = client.transport
    assert isinstance(transport, _MemoryTransport)
    caplog.set_level(logging.INFO, logger="httpx")
    with sentry_sdk.isolation_scope() as scope:
        scope.set_client(client)
        yield transport
    client.close()


def test_live_client_collects_no_frame_variables(sdk_transport: _MemoryTransport) -> None:
    # 2.73 reads stack_frame_variables from data_collection when the user set it, and
    # include_local_variables otherwise (utils.serialize_frame). Both must be off.
    options = sentry_sdk.get_client().options
    if has_data_collection_enabled(options):
        assert options["data_collection"]["stack_frame_variables"] is False
    else:
        assert options["include_local_variables"] is False
    resolved = options.get("data_collection")
    if resolved is not None:  # SDKs with data_collection resolve it either way
        assert resolved["stack_frame_variables"] is False
        assert resolved["user_info"] is False


def test_options_alone_keep_locals_off_the_wire(sdk_transport: _MemoryTransport) -> None:
    # Without the scrubber's second layer: init_sentry's options alone send no locals.
    sentry_sdk.get_client().options["before_send"] = None

    def download() -> None:
        chunk = RAW_BYTES
        raise RuntimeError(f"stalled after {len(chunk)} bytes")

    try:
        download()
    except RuntimeError as exc:
        sentry_sdk.capture_exception(exc)
    sentry_sdk.get_client().flush(timeout=5)

    wire = b"".join(sdk_transport.payloads)
    assert b"stalled after" in wire
    assert RAW_BYTES not in wire
    assert b'"vars"' not in wire


def test_scrub_through_the_sdk(sdk_transport: _MemoryTransport) -> None:
    logging.getLogger("httpx").info('HTTP Request: GET %s "HTTP/1.1 200 OK"', SIGNED_URL)
    sentry_sdk.add_breadcrumb(_http_breadcrumb())

    def download() -> None:
        chunk = RAW_BYTES
        url = SIGNED_URL
        raise RuntimeError(f"stalled after {len(chunk)} bytes from {url}")

    try:
        download()
    except RuntimeError as exc:
        sentry_sdk.capture_exception(exc)
    sentry_sdk.capture_exception(_polars_error())
    sentry_sdk.get_client().flush(timeout=5)

    wire = b"".join(sdk_transport.payloads)
    events = [json.loads(p) for p in sdk_transport.payloads if b'"exception"' in p]
    assert len(events) == 2
    assert b"X-Goog-Signature" not in wire
    assert b"X-Goog-Credential" not in wire
    assert RAW_BYTES not in wire
    assert TAPE_VALUE.encode() not in wire
    crumbs = {c["type"]: c for c in events[0]["breadcrumbs"]["values"]}
    assert crumbs["log"]["message"] == f'HTTP Request: GET {URL_PATH} "HTTP/1.1 200 OK"'
    assert crumbs["http"]["data"]["url"] == URL_PATH
    assert events[0]["server_name"] == "nightly"


def test_error_logs_are_breadcrumbs_not_events(sdk_transport: _MemoryTransport) -> None:
    # Every event is an explicit capture; main logs and captures a failed run once each.
    logging.getLogger("main").error("tape run failed before the first day: OSError")
    sentry_sdk.capture_message("explicit capture")
    sentry_sdk.get_client().flush(timeout=5)

    events = [e for e in map(json.loads, sdk_transport.payloads) if "level" in e]
    (event,) = events
    assert event["message"] == "explicit capture"
    (crumb,) = event["breadcrumbs"]["values"]
    assert crumb["category"] == "main"
    assert crumb["level"] == "error"
    assert crumb["message"] == "tape run failed before the first day: OSError"


# --- report_outcome --------------------------------------------------------------


@pytest.fixture
def capture_message(monkeypatch: pytest.MonkeyPatch):
    mock = create_autospec(sentry_sdk.capture_message)
    monkeypatch.setattr(sentry_sdk, "capture_message", mock)
    return mock


@pytest.mark.parametrize("status", ["landed", "relanded"])
def test_landed_day_without_warnings_sends_nothing(capture_message, status: str) -> None:
    report_outcome(DayOutcome(DAY, status, rows=10, bytes=100))  # type: ignore[arg-type]
    capture_message.assert_not_called()


@pytest.mark.parametrize("status", ["landed", "relanded"])
def test_landed_day_with_warnings_sends_one_warning(capture_message, status: str) -> None:
    notes = ("rows 10 below 0.65 x the trailing median 100 of 20 day(s)",)
    report_outcome(DayOutcome(DAY, status, rows=10, bytes=100, warnings=notes))  # type: ignore[arg-type]

    capture_message.assert_called_once()
    (message,) = capture_message.call_args.args
    kwargs = capture_message.call_args.kwargs
    assert kwargs["level"] == "warning"
    assert kwargs["tags"] == {"day": "2026-10-28", "status": status}
    assert kwargs["extras"]["warnings"] == list(notes)
    assert message == f"nightly tape day {status} with warnings"


@pytest.mark.parametrize(
    ("status", "level"),
    [
        ("not_posted", "warning"),
        ("unavailable", "warning"),
        ("failed", "error"),
        ("skipped_disk", "error"),
        ("skipped_deadline", "error"),
    ],
)
def test_unlanded_day_sends_one_message(capture_message, status: str, level: str) -> None:
    outcome = DayOutcome(DAY, status, "transient", warnings=("work dir cleanup failed (OSError)",))  # type: ignore[arg-type]

    report_outcome(outcome)

    capture_message.assert_called_once()
    (message,) = capture_message.call_args.args
    kwargs = capture_message.call_args.kwargs
    assert kwargs["level"] == level
    assert kwargs["tags"] == {"day": "2026-10-28", "status": status}
    assert kwargs["extras"] == {
        "detail": "transient",
        "warnings": ["work dir cleanup failed (OSError)"],
    }
    # One Sentry issue per status and failure kind, not one for every bad night.
    assert kwargs["fingerprint"] == ["nightly-tape-day", status, "transient"]
    assert message == f"nightly tape day {status}"


def test_report_titles_are_a_closed_set(capture_message) -> None:
    # Titles name the status only, never the day, detail or a warning's text.
    for day in (date(2026, 10, 27), date(2026, 10, 28)):
        for status in get_args(DayStatus):
            report_outcome(DayOutcome(day, status, f"detail-{day}", warnings=(f"note-{day}",)))
    titles = {c.args[0] for c in capture_message.call_args_list}
    assert titles == {
        "nightly tape day landed with warnings",
        "nightly tape day relanded with warnings",
        "nightly tape day not_posted",
        "nightly tape day unavailable",
        "nightly tape day failed",
        "nightly tape day skipped_disk",
        "nightly tape day skipped_deadline",
    }
