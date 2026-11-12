"""Tests for the Sentry layer: init options, event scrubbing and the per-day and per-step
reports.

Exception events come from the installed SDK's own `event_from_exception`, so they
have the shape `before_send` receives. Some tests run events through a real
`sentry_sdk.Client` built from `init_sentry`'s options, with an in-memory transport,
so nothing is sent and the wire bytes can be read back.
"""

from __future__ import annotations

import json
import logging
import warnings
from collections.abc import Iterator
from datetime import UTC, date, datetime
from time import monotonic
from typing import Any, get_args
from unittest.mock import create_autospec, patch

import numpy as np
import pandas as pd
import polars as pl
import psycopg2
import psycopg2.errors
import pyarrow as pa
import pytest
import sentry_sdk
from sentry_sdk.consts import SPANDATA
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.transport import Transport
from sentry_sdk.utils import event_from_exception, has_data_collection_enabled

from config import load_settings
from monitoring import init_sentry, report_outcome, report_step, scrub_event
from steps import Step, StepContext, StepOutcome, StepResult, run_steps
from tape_job import RELAND_IDENTICAL, DayOutcome, DayStatus

SIGNED_URL = "https://storage.googleapis.com/b/o.zip?X-Goog-Signature=abc&X-Goog-Credential=def"
SIGNED_QUERY = "X-Goog-Signature=abc&X-Goog-Credential=def"
URL_PATH = "https://storage.googleapis.com/b/o.zip"
FAKE_DSN = "https://public@sentry.invalid/1"
REDACTED = "<redacted data-library message>"
DAY = date(2026, 10, 28)
# What a failed Neon connect puts in the message of psycopg2's OperationalError.
NEON_HOST = "ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech"
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


def _data_library_errors() -> list[Any]:
    """One real exception per data library, each with a message that quotes a value."""
    return [
        pytest.param(_polars_error(), "polars", id="polars"),
        pytest.param(
            pd.errors.ParserError(f"Error tokenizing data: {TAPE_VALUE}"), "pandas", id="pandas"
        ),
        pytest.param(
            pa.ArrowInvalid(f"Could not convert {TAPE_VALUE!r} to int64"), "pyarrow", id="pyarrow"
        ),
        pytest.param(
            np.exceptions.AxisError(f"axis {TAPE_VALUE} is out of bounds"), "numpy", id="numpy"
        ),
        pytest.param(
            psycopg2.errors.NotNullViolation(
                'null value in column "score" violates not-null constraint\n'
                f"DETAIL:  Failing row contains (12, {TAPE_VALUE})."
            ),
            "psycopg2",
            id="psycopg2-errors",
        ),
        pytest.param(
            psycopg2.OperationalError(f'connection to server at "{NEON_HOST}" failed'),
            "psycopg2",
            id="psycopg2-connect",
        ),
    ]


@pytest.mark.parametrize(("exc", "root"), _data_library_errors())
def test_scrub_redacts_data_library_messages(exc: BaseException, root: str) -> None:
    # Each library quotes cell values or the failing row in its error text.
    event = _exception_event(_raised(exc))
    (value,) = _values(event)
    assert value["module"].split(".")[0] == root
    assert TAPE_VALUE in value["value"] or NEON_HOST in value["value"]  # the leak guarded

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    (value,) = _values(scrubbed)
    assert value["value"] == REDACTED
    assert value["type"] == type(exc).__name__  # the class name still reaches Sentry
    assert TAPE_VALUE not in json.dumps(scrubbed)
    assert NEON_HOST not in json.dumps(scrubbed)


@pytest.mark.parametrize(
    "module", ["polars", "polars.exceptions", "_polars_runtime_32", "_polars_runtime_32.errors"]
)
def test_scrub_redacts_every_polars_module_spelling(module: str) -> None:
    event = {
        "level": "error",
        "exception": {"values": [{"module": module, "type": "E", "value": TAPE_VALUE}]},
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == REDACTED


@pytest.mark.parametrize(
    "module",
    [
        "polarsx",
        "xpolars.errors",
        "pandas_ext.errors",
        "numpy_financial",
        "psycopg2_pool",
        "pyarrow_hotfix",
    ],
)
def test_scrub_keeps_messages_from_look_alike_modules(module: str) -> None:
    # Only the root package counts: a name that merely starts with a library's does not.
    event = {
        "level": "error",
        "exception": {"values": [{"module": module, "type": "E", "value": "kept message"}]},
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == "kept message"


@pytest.mark.parametrize(
    "frame_module",
    [
        "polars.io.csv.functions",
        "pandas.core.frame",
        "pyarrow.parquet.core",
        "numpy.lib._function_base_impl",
        "psycopg2.extras",
    ],
)
def test_scrub_redacts_builtin_error_raised_inside_a_data_library(frame_module: str) -> None:
    # A builtin exception class raised from a library's frame can quote values too.
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
                            {"module": frame_module, "function": "scan", "lineno": 2},
                        ]
                    },
                }
            ]
        },
    }

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == REDACTED


def _builtin_error_event(*frame_modules: str) -> dict[str, Any]:
    """A ValueError quoting a cell, raised with frames from the given modules (outermost
    first)."""
    return {
        "level": "error",
        "exception": {
            "values": [
                {
                    "module": None,
                    "type": "ValueError",
                    "value": f"invalid literal for int() with base 10: {TAPE_VALUE!r}",
                    "stacktrace": {
                        "frames": [
                            {"module": module, "function": "f", "lineno": n}
                            for n, module in enumerate(frame_modules, start=1)
                        ]
                    },
                }
            ]
        },
    }


@pytest.mark.parametrize("library_frame", ["pandas.core.apply", "polars.series.series"])
def test_scrub_redacts_a_builtin_error_raised_in_a_callback_a_library_called(
    library_frame: str,
) -> None:
    # `map_elements(lambda x: int(x))` and `DataFrame.apply(..., axis=1)` run our lambda
    # under the library's frames, so the innermost frame is ours and the cell is quoted.
    event = _builtin_error_event("main", "enrich_step", library_frame, "enrich_step")

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == REDACTED
    assert TAPE_VALUE not in json.dumps(scrubbed)


def _polars_callback_error() -> BaseException:
    try:
        with warnings.catch_warnings():
            # polars suggests a native expression for this lambda; the callback is the case.
            warnings.simplefilter("ignore", pl.exceptions.PolarsInefficientMapWarning)
            pl.DataFrame({"a": [TAPE_VALUE]}).select(
                pl.col("a").map_elements(lambda x: int(x), return_dtype=pl.Int64)
            )
    except ValueError as exc:
        return exc
    raise AssertionError("polars accepted the cast")


def _pandas_callback_error() -> BaseException:
    try:
        pd.DataFrame({"a": [TAPE_VALUE]}).apply(lambda row: int(row["a"]), axis=1)
    except ValueError as exc:
        return exc
    raise AssertionError("pandas accepted the cast")


@pytest.mark.parametrize(
    "make_error",
    [
        pytest.param(_polars_callback_error, id="polars-map_elements"),
        pytest.param(_pandas_callback_error, id="pandas-apply"),
    ],
)
def test_scrub_redacts_the_real_callback_errors(make_error) -> None:
    event = _exception_event(make_error())
    (value,) = _values(event)
    assert value["type"] == "ValueError"
    assert value["module"] is None  # a builtin: only the stack says a library was involved
    assert TAPE_VALUE in value["value"]  # the leak this guards against
    modules = [frame["module"] for frame in value["stacktrace"]["frames"]]
    assert modules[-1] == __name__  # innermost: our lambda, not the library
    assert any(m.split(".")[0] in ("polars", "pandas") for m in modules)

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert _values(scrubbed)[0]["value"] == REDACTED
    assert TAPE_VALUE not in json.dumps(scrubbed)


def test_scrub_keeps_a_builtin_error_with_only_first_party_frames() -> None:
    # No library on the stack: nothing marks the text as data, so it is only cut.
    event = _builtin_error_event("main", "steps", "enrich_step")

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert (
        _values(scrubbed)[0]["value"] == f"invalid literal for int() with base 10: {TAPE_VALUE!r}"
    )


def test_scrub_redacts_a_data_library_error_raised_while_handling_another() -> None:
    # The SDK lists a chain oldest first, so the escaping exception is the last entry.
    try:
        try:
            raise OSError("socket closed")
        except OSError:
            raise psycopg2.errors.NotNullViolation(  # noqa: B904 - the implicit chain is the case
                f"DETAIL:  Failing row contains (12, {TAPE_VALUE})."
            )
    except psycopg2.errors.NotNullViolation as outer:
        event = _exception_event(outer)
    assert [v["type"] for v in _values(event)] == ["OSError", "NotNullViolation"]

    scrubbed = scrub_event(event, {})

    assert scrubbed is not None
    assert {v["type"]: v["value"] for v in _values(scrubbed)} == {
        "OSError": "socket closed",
        "NotNullViolation": REDACTED,
    }
    assert TAPE_VALUE not in json.dumps(scrubbed)


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


def test_landed_day_without_warnings_sends_nothing(capture_message) -> None:
    report_outcome(DayOutcome(DAY, "landed", rows=10, bytes=100))
    capture_message.assert_not_called()


def test_landed_day_with_warnings_sends_one_warning(capture_message) -> None:
    notes = ("rows 10 below 0.65 x the baseline median 100 of 20 day(s)",)
    report_outcome(DayOutcome(DAY, "landed", rows=10, bytes=100, warnings=notes))

    capture_message.assert_called_once()
    (message,) = capture_message.call_args.args
    kwargs = capture_message.call_args.kwargs
    assert kwargs["level"] == "warning"
    assert kwargs["tags"] == {"day": "2026-10-28", "status": "landed"}
    assert kwargs["extras"]["warnings"] == list(notes)
    assert message == "nightly tape day landed with warnings"


@pytest.mark.parametrize(
    ("warnings", "title", "kind"),
    [
        pytest.param((), "nightly tape day relanded", "", id="no-warnings"),
        pytest.param(
            ("rows 10 below",), "nightly tape day relanded", "", id="a-plausibility-warning"
        ),
        pytest.param(
            (RELAND_IDENTICAL, "rows 10 below"),
            "nightly re-land identical content",
            "identical content",
            id="identical-content",
        ),
    ],
)
def test_every_relanded_day_sends_one_warning(
    capture_message, warnings: tuple[str, ...], title: str, kind: str
) -> None:
    # The healthy rate is about zero, so each re-land is reported, warnings or not, as
    # its own issue: the fingerprint names the day, so each one alerts.
    report_outcome(DayOutcome(DAY, "relanded", rows=10, bytes=100, warnings=warnings))

    capture_message.assert_called_once()
    (message,) = capture_message.call_args.args
    kwargs = capture_message.call_args.kwargs
    assert message == title
    assert kwargs["level"] == "warning"
    assert kwargs["tags"] == {"day": "2026-10-28", "status": "relanded"}
    assert kwargs["extras"] == {"warnings": list(warnings)}
    assert kwargs["fingerprint"] == ["nightly-tape-day", "relanded", kind, "2026-10-28"]


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
        "reason": None,
        "warnings": ["work dir cleanup failed (OSError)"],
    }
    # One Sentry issue per status and failure kind, not one for every bad night; a
    # marker also names its day.
    marked = ["2026-10-28"] if status == "unavailable" else []
    assert kwargs["fingerprint"] == ["nightly-tape-day", status, "transient", *marked]
    assert message == f"nightly tape day {status}"


def test_a_failure_reason_goes_in_extra_but_not_the_fingerprint(capture_message) -> None:
    for reason in ("row count 9 != 10 csv lines", "missing 1 core column(s): price"):
        report_outcome(DayOutcome(DAY, "failed", "TapeValidationError", reason=reason))

    first, second = capture_message.call_args_list
    assert first.kwargs["extras"]["reason"] == "row count 9 != 10 csv lines"
    assert second.kwargs["extras"]["reason"] == "missing 1 core column(s): price"
    # Grouped by status and class, so a new message text never opens a new issue.
    assert first.kwargs["fingerprint"] == second.kwargs["fingerprint"]
    assert first.kwargs["fingerprint"] == ["nightly-tape-day", "failed", "TapeValidationError"]
    assert first.args == second.args == ("nightly tape day failed",)


def test_only_unavailable_and_relanded_fingerprints_name_the_day(capture_message) -> None:
    # Each marker is permanent and each re-land should be rare, so each opens (and
    # alerts as) its own issue; every other status groups across days.
    for day in (date(2026, 10, 27), date(2026, 10, 28)):
        for status in get_args(DayStatus):
            if status == "relanded":
                report_outcome(DayOutcome(day, status, rows=10, bytes=100))
                report_outcome(
                    DayOutcome(day, status, rows=10, bytes=100, warnings=(RELAND_IDENTICAL,))
                )
            elif status != "landed":
                report_outcome(DayOutcome(day, status, "kind"))

    relands = [
        (c.args[0], c.kwargs["fingerprint"])
        for c in capture_message.call_args_list
        if c.kwargs["tags"]["status"] == "relanded"
    ]
    assert relands == [
        ("nightly tape day relanded", ["nightly-tape-day", "relanded", "", "2026-10-27"]),
        (
            "nightly re-land identical content",
            ["nightly-tape-day", "relanded", "identical content", "2026-10-27"],
        ),
        ("nightly tape day relanded", ["nightly-tape-day", "relanded", "", "2026-10-28"]),
        (
            "nightly re-land identical content",
            ["nightly-tape-day", "relanded", "identical content", "2026-10-28"],
        ),
    ]
    prints = {
        (c.kwargs["tags"]["day"], c.kwargs["tags"]["status"]): c.kwargs["fingerprint"]
        for c in capture_message.call_args_list
        if c.kwargs["tags"]["status"] != "relanded"
    }
    assert prints[("2026-10-27", "unavailable")] == [
        "nightly-tape-day",
        "unavailable",
        "kind",
        "2026-10-27",
    ]
    assert prints[("2026-10-28", "unavailable")] == [
        "nightly-tape-day",
        "unavailable",
        "kind",
        "2026-10-28",
    ]
    for status in ("not_posted", "failed", "skipped_disk", "skipped_deadline"):
        expected = ["nightly-tape-day", status, "kind"]
        assert prints[("2026-10-27", status)] == prints[("2026-10-28", status)] == expected


def test_report_titles_are_a_closed_set(capture_message) -> None:
    # Titles name the status only, never the day, detail, reason or a warning's text.
    for day in (date(2026, 10, 27), date(2026, 10, 28)):
        for status in get_args(DayStatus):
            for notes in ((f"note-{day}",), (RELAND_IDENTICAL,)):
                report_outcome(
                    DayOutcome(day, status, f"detail-{day}", warnings=notes, reason=f"why-{day}")
                )
    titles = {c.args[0] for c in capture_message.call_args_list}
    assert titles == {
        "nightly tape day landed with warnings",
        "nightly tape day relanded",
        "nightly re-land identical content",
        "nightly tape day not_posted",
        "nightly tape day unavailable",
        "nightly tape day failed",
        "nightly tape day skipped_disk",
        "nightly tape day skipped_deadline",
    }


# --- report_step -----------------------------------------------------------------


def _step_outcome(
    status: str,
    *,
    error: str | None = None,
    detail: str = "",
    name: str = "enrich-outcomes",
    counts: dict[str, int] | None = None,
) -> StepOutcome:
    return StepOutcome(
        name,
        status,  # type: ignore[arg-type]
        {"days_left": 3} if counts is None else counts,
        detail,
        1.5,
        error,
    )


@pytest.mark.parametrize(
    ("status", "title", "level"),
    [
        pytest.param("partial", "nightly step partial", "warning", id="partial"),
        pytest.param("failed", "nightly step failed", "error", id="failed-without-an-exception"),
        pytest.param("skipped_deadline", "nightly step skipped_deadline", "error", id="skipped"),
    ],
)
def test_report_step_sends_one_event_for_a_step_that_did_not_finish_clean(
    capture_message, status: str, title: str, level: str
) -> None:
    report_step(_step_outcome(status, detail="work left"))

    capture_message.assert_called_once()
    (message,) = capture_message.call_args.args
    kwargs = capture_message.call_args.kwargs
    assert message == title
    assert kwargs["level"] == level
    assert kwargs["tags"] == {"step": "enrich-outcomes", "status": status}
    assert kwargs["extras"] == {"counts": {"days_left": 3}, "detail": "work left"}
    assert kwargs["fingerprint"] == ["nightly-step", "enrich-outcomes", status, "work left"]


@pytest.mark.parametrize(
    ("status", "error"),
    [
        pytest.param("ok", None, id="ok"),
        # The exception event was already sent by run_steps; a second one would double it.
        pytest.param("failed", "KeyError", id="raised"),
    ],
)
def test_report_step_sends_nothing_for_ok_or_a_step_that_raised(
    capture_message, status: str, error: str | None
) -> None:
    report_step(_step_outcome(status, error=error, detail="whatever"))
    capture_message.assert_not_called()


def test_report_step_groups_one_reason_into_one_issue(capture_message) -> None:
    # Sentry mails on new issues only: the same step, status and reason night after night
    # is one issue (the owner accepted that on 2026-11-06); a new reason opens another.
    report_step(_step_outcome("partial", detail="work left", counts={"days_left": 3}))
    report_step(_step_outcome("partial", detail="work left", counts={"days_left": 9}))
    report_step(_step_outcome("partial", detail="a different reason"))
    report_step(_step_outcome("partial", detail="work left", name="outcome-check"))
    report_step(_step_outcome("failed", detail="work left"))

    prints = [c.kwargs["fingerprint"] for c in capture_message.call_args_list]
    assert prints[0] == prints[1]
    assert len({tuple(p) for p in prints}) == 4
    assert prints[2] == ["nightly-step", "enrich-outcomes", "partial", "a different reason"]


def test_report_step_titles_are_a_closed_set(capture_message) -> None:
    # Titles name the status only, never the step, its detail or its counts.
    for name in ("enrich-outcomes", "outcome-check"):
        for status in ("partial", "failed", "skipped_deadline"):
            report_step(_step_outcome(status, detail=f"detail-{name}", name=name))
    titles = {c.args[0] for c in capture_message.call_args_list}
    assert titles == {
        "nightly step partial",
        "nightly step failed",
        "nightly step skipped_deadline",
    }


def test_report_step_through_the_sdk(sdk_transport: _MemoryTransport) -> None:
    report_step(_step_outcome("partial", detail="work left"))
    sentry_sdk.get_client().flush(timeout=5)

    (event,) = [e for e in map(json.loads, sdk_transport.payloads) if "level" in e]
    assert event["message"] == "nightly step partial"
    assert event["level"] == "warning"
    assert event["tags"]["step"] == "enrich-outcomes"
    assert event["tags"]["status"] == "partial"
    assert event["extra"] == {"counts": {"days_left": 3}, "detail": "work left"}
    assert event["fingerprint"] == ["nightly-step", "enrich-outcomes", "partial", "work left"]
    assert event["server_name"] == "nightly"


def test_a_step_that_raises_sends_a_tagged_event_without_the_database_host(
    sdk_transport: _MemoryTransport,
) -> None:
    # connect_db lets a failed connect's OperationalError propagate, and its message
    # carries the Neon host. run_steps captures it; the scrubber must cut the text, on
    # the exception and on its cause.
    def run(ctx: StepContext) -> StepResult:
        try:
            raise psycopg2.OperationalError(f'connection to server at "{NEON_HOST}" failed')
        except psycopg2.OperationalError as exc:
            raise RuntimeError("could not reach the database") from exc

    run_steps(
        [Step("enrich-outcomes", run, 0)],
        settings=load_settings(),
        now_utc=datetime(2026, 11, 7, 7, 15, tzinfo=UTC),
        last_session=date(2026, 11, 6),
        run_deadline=monotonic() + 100.0,
        tape=(),
        on_outcome=lambda _outcome: None,  # the exception event is under test, not the report
    )
    sentry_sdk.get_client().flush(timeout=5)

    wire = b"".join(sdk_transport.payloads)
    assert NEON_HOST.encode() not in wire
    (event,) = [e for e in map(json.loads, sdk_transport.payloads) if "exception" in e]
    assert event["tags"]["step"] == "enrich-outcomes"
    by_type = {v["type"]: v["value"] for v in _values(event)}
    assert by_type == {"OperationalError": REDACTED, "RuntimeError": "could not reach the database"}
