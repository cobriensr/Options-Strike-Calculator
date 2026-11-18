"""Tests for ``sentry_setup._before_send`` — collapses N channel stacks
into one Sentry issue when a transient DB error fires across handlers.

Added 2026-05-14 after a Neon scale-down produced 7+ distinct Sentry
groups from a single event. The retry wrapper in ``db._with_db_retry``
absorbs brief outages; ``_before_send`` collapses the rest so triage
shows one issue per exception type, regardless of which handler raised.
"""

from __future__ import annotations

import io
import json
import logging
import secrets
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import aiohttp
import asyncpg.exceptions
import pytest
import sentry_sdk
from aiohttp.test_utils import TestClient, TestServer
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.aiohttp import AioHttpIntegration
from sentry_sdk.integrations.excepthook import ExcepthookIntegration
from sentry_sdk.integrations.logging import EventHandler, LoggingIntegration
from sentry_sdk.transport import Transport

import auth
import health
import memory_stats
import sentry_setup
from config import settings
from logger_setup import log
from sentry_setup import _before_send


def _hint_with(exc: BaseException) -> dict:
    """Sentry passes ``hint["exc_info"]`` as a (type, value, tb) tuple —
    only [1] (the exception instance) is read by the hook.
    """
    return {"exc_info": (type(exc), exc, None)}


class TestBeforeSendFingerprinting:
    def test_stdlib_timeout_gets_transient_fingerprint(self):
        event = {}
        out = _before_send(event, _hint_with(TimeoutError("query timeout")))
        assert out["fingerprint"] == ["uw-stream-transient-db", "TimeoutError"]

    def test_asyncpg_interface_error_gets_transient_fingerprint(self):
        event = {}
        out = _before_send(
            event,
            _hint_with(asyncpg.exceptions.InterfaceError("connection closed")),
        )
        assert out["fingerprint"] == [
            "uw-stream-transient-db",
            "InterfaceError",
        ]

    def test_connection_does_not_exist_gets_transient_fingerprint(self):
        event = {}
        out = _before_send(
            event,
            _hint_with(asyncpg.exceptions.ConnectionDoesNotExistError("57P01")),
        )
        assert out["fingerprint"] == [
            "uw-stream-transient-db",
            "ConnectionDoesNotExistError",
        ]

    def test_admin_shutdown_gets_transient_fingerprint(self):
        """A Neon restart sends 57P01. Every handler's flush raises it, so the
        fingerprint is what keeps one restart to one Sentry issue.
        """
        event = {}
        out = _before_send(
            event,
            _hint_with(asyncpg.exceptions.AdminShutdownError("terminating connection")),
        )
        assert out["fingerprint"] == [
            "uw-stream-transient-db",
            "AdminShutdownError",
        ]

    def test_aiohttp_connection_reset_keeps_default_fingerprint(self):
        """The notify push (aiohttp) can capture a ClientConnectionResetError,
        which is also a stdlib ConnectionResetError. It is not a database
        failure, so it must not be filed under the transient-DB group.
        """
        event = {}
        out = _before_send(
            event,
            _hint_with(aiohttp.ClientConnectionResetError("Cannot write to closing transport")),
        )
        assert "fingerprint" not in out

    def test_value_error_keeps_default_fingerprint(self):
        """Non-transient errors must NOT be re-fingerprinted — Sentry's
        default stack-based grouping is appropriate for real bugs.
        """
        event = {}
        out = _before_send(event, _hint_with(ValueError("bad row")))
        assert "fingerprint" not in out

    def test_runtime_error_keeps_default_fingerprint(self):
        event = {}
        out = _before_send(event, _hint_with(RuntimeError("logic bug")))
        assert "fingerprint" not in out

    def test_no_hint_returns_event_unchanged(self):
        event = {"message": "ad-hoc message capture, no exc_info"}
        out = _before_send(event, {})
        assert out == event
        assert "fingerprint" not in out

    def test_empty_exc_info_returns_event_unchanged(self):
        event = {"message": "ad-hoc"}
        out = _before_send(event, {"exc_info": None})
        assert out == event

    def test_seven_different_handler_stacks_collapse_to_one_fingerprint(self):
        """The whole point: 7 handlers raising the same transient class
        must produce one fingerprint, not 7. Simulate by passing the same
        exception class from 7 separate constructions.
        """
        fingerprints = set()
        for i in range(7):
            event = {}
            exc = TimeoutError(f"handler-{i} batch flush")
            out = _before_send(event, _hint_with(exc))
            fingerprints.add(tuple(out["fingerprint"]))
        assert fingerprints == {("uw-stream-transient-db", "TimeoutError")}

    def test_hook_swallows_internal_errors(self):
        """A buggy hint must NOT drop the underlying event."""
        event = {"message": "preserved"}
        # Pass a hint shape that would trip the hook internally
        out = _before_send(event, {"exc_info": (None,)})
        assert out == event


class TestTokenScrubbing:
    """UW API key in WS URL must be redacted before any event leaves the process."""

    def test_scrubs_token_in_exception_value(self):
        event = {
            "exception": {
                "values": [
                    {
                        "value": (
                            "handshake failed for "
                            "wss://api.unusualwhales.com/socket?token=SECRET123"
                        )
                    }
                ]
            }
        }
        out = _before_send(event, {})
        rendered = out["exception"]["values"][0]["value"]
        assert "SECRET123" not in rendered
        assert "token=REDACTED" in rendered

    def test_scrubs_token_when_followed_by_extra_params(self):
        event = {"message": ("url=wss://api.unusualwhales.com/socket?token=ABCDEFG&trace=1")}
        out = _before_send(event, {})
        assert "ABCDEFG" not in out["message"]
        assert "token=REDACTED&trace=1" in out["message"]

    def test_scrubs_token_in_nested_breadcrumb_dict(self):
        event = {
            "breadcrumbs": {
                "values": [
                    {
                        "category": "websocket",
                        "data": {"url": ("wss://api.unusualwhales.com/socket?token=NESTED_KEY")},
                    }
                ]
            }
        }
        out = _before_send(event, {})
        url_out = out["breadcrumbs"]["values"][0]["data"]["url"]
        assert "NESTED_KEY" not in url_out
        assert "token=REDACTED" in url_out

    def test_scrub_preserves_non_token_strings(self):
        event = {"message": "ordinary log line, no secret"}
        out = _before_send(event, {})
        assert out["message"] == "ordinary log line, no secret"

    def test_scrub_runs_even_when_fingerprint_branch_fires(self):
        event = {"exception": {"values": [{"value": "url=wss://x/y?token=COMBO_KEY (transient)"}]}}
        out = _before_send(event, _hint_with(TimeoutError("flush")))
        assert "COMBO_KEY" not in out["exception"]["values"][0]["value"]
        assert out["fingerprint"] == ["uw-stream-transient-db", "TimeoutError"]


class TestSecretHeaderBlanking:
    """A request header named like a secret never leaves the process.

    The SDK's aiohttp integration attaches the request's headers to every event captured
    while a request is handled, and its own redaction list (Authorization, Cookie, X-API-Key,
    X-Forwarded-For, X-Real-IP) does not name ``X-Metrics-Token``. ``_before_send`` blanks any
    header whose name holds ``token`` or ``secret``, for every event.
    """

    @pytest.mark.parametrize(
        "name",
        [
            "X-Metrics-Token",
            "x-metrics-token",
            "X-METRICS-TOKEN",
            "X-Auth-Token",
            "Token",
            "X-Internal-Secret",
            "x-notify-SECRET",
            "My-Secret-Thing",
        ],
    )
    def test_a_header_named_like_a_secret_is_blanked(self, name):
        event = {"request": {"headers": {name: "the-secret-value", "User-Agent": "curl/8"}}}

        out = _before_send(event, {})

        assert out["request"]["headers"][name] == "[Filtered]"
        assert "the-secret-value" not in json.dumps(out)

    def test_other_headers_and_the_rest_of_the_event_are_left_alone(self):
        headers = {"User-Agent": "curl/8", "Accept": "*/*", "Content-Type": "application/json"}
        event = {
            "message": "kept",
            "request": {"url": "http://x/metrics", "headers": {**headers, "X-Metrics-Token": "v"}},
        }

        out = _before_send(event, {})

        assert out["message"] == "kept"
        assert out["request"]["url"] == "http://x/metrics"
        assert {k: v for k, v in out["request"]["headers"].items() if k in headers} == headers

    @pytest.mark.parametrize(
        "event",
        [
            {},
            {"request": None},
            {"request": {}},
            {"request": {"headers": None}},
            {"request": {"headers": ["X-Metrics-Token"]}},
            {"request": {"headers": {1: "x"}}},
        ],
        ids=["empty", "request-none", "no-headers", "headers-none", "headers-list", "int-name"],
    )
    def test_an_event_without_headers_in_the_expected_shape_passes_through(self, event):
        assert _before_send(event, {}) == event

    def test_the_blanking_does_not_stop_the_fingerprint_or_the_scrub(self):
        event = {
            "exception": {"values": [{"value": "url=wss://x/y?token=COMBO_KEY"}]},
            "request": {"headers": {"X-Metrics-Token": "the-secret-value"}},
        }

        out = _before_send(event, _hint_with(TimeoutError("flush")))

        assert out["request"]["headers"]["X-Metrics-Token"] == "[Filtered]"
        assert "COMBO_KEY" not in out["exception"]["values"][0]["value"]
        assert out["fingerprint"] == ["uw-stream-transient-db", "TimeoutError"]


FAKE_DSN = "https://public@sentry.invalid/1"


class _MemoryTransport(Transport):
    """Keeps each envelope item's wire bytes instead of sending them."""

    def __init__(self, options: dict[str, Any] | None = None) -> None:
        super().__init__(options)
        self.payloads: list[bytes] = []

    def capture_envelope(self, envelope: Envelope) -> None:
        self.payloads.extend(item.get_bytes() for item in envelope.items)

    def events(self) -> list[dict[str, Any]]:
        """Every event the client sent (check-ins and sessions carry no level)."""
        sentry_sdk.get_client().flush(timeout=5)
        return [e for e in map(json.loads, self.payloads) if "level" in e]


LIBRARY_LOGGERS = ("websockets", "asyncio")


@pytest.fixture(autouse=True)
def _restore_library_logger_handlers() -> Iterator[None]:
    """``init_sentry`` attaches handlers to the process-wide library loggers.

    Every test that calls it, with the SDK's init patched or not, would leave
    them for the tests after it, so each test gets its own pair back as it
    found it.
    """
    saved = {name: list(logging.getLogger(name).handlers) for name in LIBRARY_LOGGERS}
    yield
    for name, handlers in saved.items():
        logging.getLogger(name).handlers[:] = handlers


def _event_handlers(name: str) -> list[logging.Handler]:
    return [h for h in logging.getLogger(name).handlers if isinstance(h, EventHandler)]


@pytest.fixture
def sdk_transport(monkeypatch, caplog) -> Iterator[_MemoryTransport]:
    """A real Client built from init_sentry's own options, bound to an isolation scope.

    ``default_integrations=False`` keeps the SDK from patching aiohttp, asyncpg
    and the rest for the whole test session; the LoggingIntegration that
    init_sentry passes explicitly is kept, which is the one under test. The
    default integrations are on in ``production_client`` below.
    """
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
    with (
        patch.object(sentry_sdk, "init", autospec=True) as init,
        patch.object(sentry_sdk, "set_tag", autospec=True),
    ):
        sentry_setup.init_sentry()
    options = {**init.call_args.kwargs, "default_integrations": False}
    client = sentry_sdk.Client(transport=_MemoryTransport, **options)
    transport = client.transport
    assert isinstance(transport, _MemoryTransport)
    caplog.set_level(logging.INFO, logger=log.name)
    with sentry_sdk.isolation_scope() as scope:
        scope.set_client(client)
        yield transport
    client.close()


class TestLoggingIntegration:
    """``init_sentry`` sets ``LoggingIntegration(event_level=None)``.

    The SDK's default turns every ERROR log record into an event. The helpers
    below log at error and then send the exception themselves, so each failure
    filed two issues (KP/HF and 8Y/2C in the 2026-11-13 Sentry week). Every
    event is now an explicit capture.
    """

    def test_init_passes_exactly_one_logging_integration(self, monkeypatch):
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        with (
            patch.object(sentry_sdk, "init", autospec=True) as init,
            patch.object(sentry_sdk, "set_tag", autospec=True),
        ):
            sentry_setup.init_sentry()

        found = [
            i for i in init.call_args.kwargs["integrations"] if isinstance(i, LoggingIntegration)
        ]
        assert len(found) == 1

    def test_a_logged_error_is_a_breadcrumb_not_an_event(self, sdk_transport):
        log.info("sent join frame")
        log.error("flush failed")
        sentry_sdk.capture_message("explicit capture")

        (event,) = sdk_transport.events()
        assert event["message"] == "explicit capture"
        crumbs = [(c["level"], c["message"]) for c in event["breadcrumbs"]["values"]]
        # INFO and up stay as breadcrumbs, as they were.
        assert crumbs == [("info", "sent join frame"), ("error", "flush failed")]

    def test_capture_exception_files_the_exception_once(self, sdk_transport):
        sentry_setup.capture_exception(
            ValueError("boom"),
            tags={"component": "handler"},
            context={"batch_size": 3},
        )

        (event,) = sdk_transport.events()
        assert event["exception"]["values"][0]["type"] == "ValueError"
        assert event["tags"]["component"] == "handler"
        assert event["extra"]["batch_size"] == 3
        # The helper's own error log line is the breadcrumb on the one event.
        assert [(c["level"], c["message"]) for c in event["breadcrumbs"]["values"]] == [
            ("error", "boom (context={'batch_size': 3})")
        ]

    def test_capture_message_files_one_event_at_the_level_asked_for(self, sdk_transport):
        sentry_setup.capture_message(
            "uw-stream reconnect storm", level="warning", tags={"component": "connector"}
        )

        (event,) = sdk_transport.events()
        assert event["message"] == "uw-stream reconnect storm"
        assert event["level"] == "warning"

    def test_an_error_capture_message_files_one_event_not_two(self, sdk_transport):
        """The storm alert is level ``error``. Its own log line is then an ERROR record,
        and the SDK's default would turn that record into a second event beside the capture.
        ``event_level=None`` keeps it a breadcrumb, so a storm files one issue event."""
        sentry_setup.capture_message(
            "uw-stream reconnect storm",
            level="error",
            tags={"component": "connector"},
            context={"reconnects_last_hour": 41, "threshold": 40},
        )

        (event,) = sdk_transport.events()
        assert event["message"] == "uw-stream reconnect storm"
        assert event["level"] == "error"
        assert [(c["level"], c["message"]) for c in event["breadcrumbs"]["values"]] == [
            (
                "error",
                "uw-stream reconnect storm (context={'reconnects_last_hour': 41, 'threshold': 40})",
            )
        ]


class TestCaptureMessageParams:
    """``capture_message(template, params=...)`` files the template and its arguments apart.

    That is the shape the SDK's logging integration files for ``log.error(template, *args)``
    (its ``logentry``), and Sentry groups such an event by the template. The same text as one
    pre-formatted string is a different message for every argument, so one failing check seen
    from many client addresses would open one issue per address.
    """

    TEMPLATE = "Secret check failed on metrics (client %s)"

    def test_the_event_carries_the_template_and_the_arguments_apart(self, sdk_transport):
        sentry_setup.capture_message(
            self.TEMPLATE, level="error", params=("203.0.113.7",), tags={"component": "auth"}
        )

        (event,) = sdk_transport.events()
        assert event["level"] == "error"
        assert event["logentry"] == {
            "message": self.TEMPLATE,
            "formatted": "Secret check failed on metrics (client 203.0.113.7)",
            "params": ["203.0.113.7"],
        }
        assert event["tags"]["component"] == "auth"

    def test_two_arguments_share_one_template(self, sdk_transport):
        """What Sentry groups on is the template, and it does not vary with the argument."""
        for client in ("203.0.113.7", "198.51.100.4"):
            sentry_setup.capture_message(self.TEMPLATE, level="error", params=(client,))

        first, second = sdk_transport.events()
        assert first["logentry"]["message"] == second["logentry"]["message"] == self.TEMPLATE
        assert first["logentry"]["params"] != second["logentry"]["params"]

    def test_a_message_formatted_in_advance_is_a_different_message_per_argument(
        self, sdk_transport
    ):
        """The case the params keyword exists to avoid: no params, one message per client."""
        for client in ("203.0.113.7", "198.51.100.4"):
            sentry_setup.capture_message(self.TEMPLATE % client, level="error")

        first, second = sdk_transport.events()
        assert first["message"] != second["message"]
        assert "logentry" not in first

    def test_the_log_line_is_the_formatted_text_with_the_context(self, service_log_records):
        sentry_setup.capture_message(
            self.TEMPLATE, level="error", params=("203.0.113.7",), context={"reason": "wrong"}
        )

        (record,) = service_log_records
        assert record.levelno == logging.ERROR
        assert record.getMessage() == (
            "Secret check failed on metrics (client 203.0.113.7) (context={'reason': 'wrong'})"
        )

    def test_a_percent_sign_inside_an_argument_is_not_formatted_again(self, service_log_records):
        template_text = "%s %d %(x)s {0} 100%"
        sentry_setup.capture_message(self.TEMPLATE, level="error", params=(template_text,))

        (record,) = service_log_records
        assert record.getMessage() == f"Secret check failed on metrics (client {template_text})"

    def test_a_template_and_arguments_that_disagree_do_not_raise(
        self, sdk_transport, service_log_records
    ):
        """A reporting helper must not fail the caller that is reporting: the line and
        the event keep the template and show the arguments beside it."""
        sentry_setup.capture_message("no placeholder here", level="error", params=("a", "b"))

        (record,) = service_log_records
        assert record.getMessage() == "no placeholder here ('a', 'b')"
        (event,) = sdk_transport.events()
        assert event["logentry"]["message"] == "no placeholder here"
        assert event["logentry"]["params"] == ["a", "b"]

    def test_a_send_that_fails_does_not_raise_and_the_line_is_still_written(
        self, monkeypatch, service_log_records
    ):
        """The Sentry leg is best effort: a transport that throws must not fail the caller,
        and the ERROR line the report exists to write is already out by then."""
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", True)
        monkeypatch.setattr(
            sentry_sdk, "capture_event", MagicMock(side_effect=RuntimeError("down"))
        )

        sentry_setup.capture_message(self.TEMPLATE, level="error", params=("203.0.113.7",))

        assert [(r.levelno, r.getMessage()) for r in service_log_records] == [
            (logging.ERROR, "Secret check failed on metrics (client 203.0.113.7)"),
            (logging.ERROR, "Failed to forward message to Sentry: down"),
        ]


class TestCaptureMessageLogLine:
    """``capture_message`` logs one line, at the level the capture is filed at.

    It always logged at WARNING, so an ``error`` event showed in Railway as a warning.
    A level it does not know logs at WARNING, the level it always had, and never raises:
    a monitoring helper must not take down the caller that is reporting a problem.

    The records come from the shared ``service_log_records`` fixture (conftest.py).
    """

    @pytest.fixture(autouse=True)
    def _sdk_off(self, monkeypatch) -> None:
        """These tests are about the helper's own log line, not what it sends."""
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)

    @pytest.mark.parametrize(
        ("level", "expected"),
        [
            ("debug", logging.DEBUG),
            ("info", logging.INFO),
            ("warning", logging.WARNING),
            ("error", logging.ERROR),
            ("critical", logging.CRITICAL),
            ("fatal", logging.CRITICAL),
            ("shouting", logging.WARNING),
        ],
    )
    @pytest.mark.parametrize("context", [None, {"threshold": 40}])
    def test_the_line_is_logged_at_the_level_asked_for(
        self, service_log_records, level, expected, context
    ):
        sentry_setup.capture_message("uw-stream reconnect storm", level=level, context=context)

        (record,) = service_log_records
        assert record.levelno == expected
        shown = "uw-stream reconnect storm"
        assert record.getMessage() == (f"{shown} (context={context})" if context else shown)

    def test_the_default_level_still_logs_at_warning(self, service_log_records):
        sentry_setup.capture_message("uw-stream channels stuck unsubscribed")

        (record,) = service_log_records
        assert record.levelno == logging.WARNING


def _log_error_from(logger_name: str, message: str) -> None:
    """Log at ERROR with the active exception, as the library call sites do."""
    try:
        raise RuntimeError("ping lost")
    except RuntimeError:
        logging.getLogger(logger_name).error(message, exc_info=True)


class TestLibraryErrorHandlers:
    """``event_level=None`` also silenced the libraries' own ERROR records.

    The service's captures are all explicit now, but websockets and asyncio log
    their failures at ERROR and send nothing else:

    - websockets/asyncio/connection.py "keepalive ping failed" (the socket stays
      open with no pings) and "unexpected internal error";
    - websockets/protocol.py "parser failed";
    - asyncio's "Exception in callback" (built in events.py ``Handle._run``) and
      "Task exception was never retrieved" (futures.py ``Future.__del__``, and
      the C accelerator's twin; the class name supplies "Task", the source has
      only ``f'{self.__class__.__name__} exception was never retrieved'``).
      Both go through ``call_exception_handler``, whose default handler
      (base_events.py) logs them at ERROR.

    ``init_sentry`` puts an ``EventHandler`` at ERROR on the ``websockets`` and
    ``asyncio`` loggers so those still file one event each.
    """

    def test_a_websockets_client_error_files_exactly_one_event(self, sdk_transport):
        _log_error_from("websockets.client", "keepalive ping failed")

        (event,) = sdk_transport.events()
        assert event["level"] == "error"
        assert event["logger"] == "websockets.client"
        assert event["logentry"]["formatted"] == "keepalive ping failed"
        assert event["exception"]["values"][0]["type"] == "RuntimeError"

    def test_an_asyncio_error_files_exactly_one_event(self, sdk_transport):
        logging.getLogger("asyncio").error("Task exception was never retrieved")

        (event,) = sdk_transport.events()
        assert event["level"] == "error"
        assert event["logger"] == "asyncio"
        assert event["logentry"]["formatted"] == "Task exception was never retrieved"

    def test_a_websockets_warning_files_no_event(self, sdk_transport):
        logging.getLogger("websockets.client").warning("connection closed")

        assert sdk_transport.events() == []

    def test_the_service_logger_at_error_still_files_no_event(self, sdk_transport):
        log.error("flush failed")

        assert sdk_transport.events() == []

    def test_a_second_init_does_not_double_the_events(self, sdk_transport, monkeypatch):
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        with (
            patch.object(sentry_sdk, "init", autospec=True),
            patch.object(sentry_sdk, "set_tag", autospec=True),
        ):
            sentry_setup.init_sentry()

        logging.getLogger("websockets.client").error("keepalive ping failed")
        logging.getLogger("asyncio").error("Task exception was never retrieved")

        assert len(sdk_transport.events()) == 2
        assert [len(_event_handlers(name)) for name in LIBRARY_LOGGERS] == [1, 1]

    def test_nothing_is_attached_without_a_dsn(self, monkeypatch):
        monkeypatch.delenv("SENTRY_DSN", raising=False)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)

        sentry_setup.init_sentry()

        assert [_event_handlers(name) for name in LIBRARY_LOGGERS] == [[], []]

    def test_nothing_is_attached_when_the_sdk_fails_to_start(self, monkeypatch):
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)

        with patch.object(sentry_sdk, "init", side_effect=RuntimeError("bad dsn")):
            sentry_setup.init_sentry()

        assert sentry_setup.is_enabled() is False
        assert [_event_handlers(name) for name in LIBRARY_LOGGERS] == [[], []]

    @pytest.mark.parametrize(
        ("logger_name", "message"),
        [
            ("asyncio", "socket.send() raised exception."),
            ("websockets.client", "connection closed"),
        ],
    )
    def test_library_records_still_reach_stderr(self, monkeypatch, capsys, logger_name, message):
        """Any handler on a logger stops the stdlib's last-resort stderr line.

        Neither library logger has a handler of its own (websockets 17.4 adds
        no ``NullHandler``) and the root has none in production, so before the
        EventHandler their WARNING and ERROR records reached Railway's logs
        through the last-resort handler. The new handler would have hidden them
        from both. The root logger has no handler there; pytest's capture
        handlers stand in for one, so the lookup is patched to say there is
        none. The websockets case logs through a child, as the library does.
        """
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        with (
            patch.object(sentry_sdk, "init", autospec=True),
            patch.object(sentry_sdk, "set_tag", autospec=True),
            patch.object(logging.Logger, "hasHandlers", return_value=False),
        ):
            sentry_setup.init_sentry()

        logging.getLogger(logger_name).warning(message)

        assert message in capsys.readouterr().err

    def test_a_missing_last_resort_handler_is_not_attached(self, monkeypatch):
        """``logging.lastResort`` is None when an app turns it off; attaching it
        would put None in the handler list and every later record would raise."""
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        monkeypatch.setattr(logging, "lastResort", None)
        with (
            patch.object(sentry_sdk, "init", autospec=True),
            patch.object(sentry_sdk, "set_tag", autospec=True),
            patch.object(logging.Logger, "hasHandlers", return_value=False),
        ):
            sentry_setup.init_sentry()

        for name in LIBRARY_LOGGERS:
            handlers = logging.getLogger(name).handlers
            assert [isinstance(h, EventHandler) for h in handlers] == [True]

    def test_a_root_handler_set_before_init_means_no_last_resort(self, monkeypatch, capsys):
        """Root logging configured BEFORE ``init_sentry`` (``basicConfig``, a root
        handler) leaves ``hasHandlers()`` true, so the ``lastResort`` branch is
        skipped. Attached anyway, it would print every WARNING and ERROR record of
        these loggers a second time on stderr, beside the root handler's copy.

        ``hasHandlers`` is not patched: pytest's own root capture handlers already
        make it true, and the root handler added here says so explicitly.
        """
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        root_output = io.StringIO()
        root_handler = logging.StreamHandler(root_output)
        root = logging.getLogger()
        root.addHandler(root_handler)
        try:
            with (
                patch.object(sentry_sdk, "init", autospec=True),
                patch.object(sentry_sdk, "set_tag", autospec=True),
            ):
                sentry_setup.init_sentry()

            for name in LIBRARY_LOGGERS:
                assert logging.lastResort not in logging.getLogger(name).handlers

            logging.getLogger("asyncio").warning("socket.send() raised exception.")
            logging.getLogger("websockets.client").warning("connection closed")
        finally:
            root.removeHandler(root_handler)

        assert root_output.getvalue().splitlines() == [
            "socket.send() raised exception.",
            "connection closed",
        ]
        assert capsys.readouterr().err == ""


@pytest.fixture
def production_client(monkeypatch) -> Iterator[SimpleNamespace]:
    """The client ``sentry_sdk.init`` builds from init_sentry's own options.

    Unlike ``sdk_transport`` the default integrations stay on, as in production.
    Only the transport is swapped, so nothing leaves the process. The SDK keeps
    its patches of aiohttp and asyncpg after the test (they do nothing without
    an active client); the client, the global scope's reference to it and the
    isolation scope's tag are put back.
    """
    monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
    passed: dict[str, Any] = {}
    real_init = sentry_sdk.init

    def init_with_memory_transport(**options: Any) -> None:
        passed.update(options)
        real_init(transport=_MemoryTransport, **options)

    monkeypatch.setattr(sentry_sdk, "init", init_with_memory_transport)
    with sentry_sdk.isolation_scope():
        sentry_setup.init_sentry()
        client = sentry_sdk.get_client()
        transport = client.transport
        assert isinstance(transport, _MemoryTransport)
        try:
            yield SimpleNamespace(client=client, transport=transport, passed=passed)
        finally:
            client.close()
            sentry_sdk.get_global_scope().set_client(None)


class TestProductionConfiguration:
    """``init_sentry`` as production runs it, default integrations included."""

    def test_the_client_uses_the_logging_integration_init_sentry_passed(self, production_client):
        passed = [
            i for i in production_client.passed["integrations"] if isinstance(i, LoggingIntegration)
        ]
        assert len(passed) == 1
        # The SDK's own default would turn every ERROR record into an event.
        assert production_client.client.get_integration(LoggingIntegration) is passed[0]

    def test_the_integrations_the_readme_names_are_active(self, production_client):
        assert production_client.client.get_integration(AioHttpIntegration) is not None
        assert production_client.client.get_integration(ExcepthookIntegration) is not None

    def test_a_service_logger_error_files_no_event(self, production_client):
        log.error("flush failed")

        assert production_client.transport.events() == []

    def test_a_library_error_files_one_event_not_two(self, production_client):
        _log_error_from("websockets.client", "keepalive ping failed")
        logging.getLogger("asyncio").error("Task exception was never retrieved")

        events = production_client.transport.events()
        assert [(e["logger"], e["level"]) for e in events] == [
            ("websockets.client", "error"),
            ("asyncio", "error"),
        ]


def _failing_frame() -> tuple[BaseException, str]:
    """An exception raised under a frame that holds a local nothing scrubs.

    The local's name is not one ``_scrub_tokens`` blanks, and its value is built at
    run time, so the source lines the SDK sends beside a frame don't hold it.
    """
    expected = f"plainvalue-{secrets.token_hex(8)}"
    try:
        raise RuntimeError("query failed")
    except RuntimeError as exc:
        return exc, expected


class TestFrameLocals:
    """Frame locals stay out of the events the client built from ``init_sentry`` sends.

    The check is on the bytes the in-memory transport kept. The scrubs on key names
    stay as a second layer, but a value under a name nothing scrubs would pass them.
    """

    def test_a_local_variable_value_is_not_in_the_payload(self, production_client):
        exc, expected = _failing_frame()

        sentry_sdk.capture_exception(exc)

        (event,) = production_client.transport.events()
        frames = event["exception"]["values"][0]["stacktrace"]["frames"]
        # Without a frame holding the local the check below would prove nothing.
        assert "_failing_frame" in [frame["function"] for frame in frames]
        assert expected.encode() not in b"".join(production_client.transport.payloads)

    def test_the_sdk_default_would_send_the_same_local(self, production_client):
        """The control: with the option left out, the same exception carries the
        local, so the test above is able to fail."""
        options = {
            k: v for k, v in production_client.passed.items() if k != "include_local_variables"
        }
        client = sentry_sdk.Client(transport=_MemoryTransport, **options)
        try:
            with sentry_sdk.isolation_scope() as scope:
                scope.set_client(client)
                exc, expected = _failing_frame()
                sentry_sdk.capture_exception(exc)
                transport = client.transport
                assert isinstance(transport, _MemoryTransport)
                assert len(transport.events()) == 1
                assert expected.encode() in b"".join(transport.payloads)
        finally:
            client.close()

    def test_init_passes_the_option_off(self, production_client):
        assert production_client.passed["include_local_variables"] is False


_FAILED_CHECK = "Secret check failed on metrics (client %s)"
_SHORT_SECRET = "Configured secret shorter than the minimum: %s"
_WEAK_TOKEN = "weak-metrics-token-value"


class TestAuthReports:
    """What the real SDK files for the two reports in ``auth``, through a capturing transport.

    ``init_sentry`` turns the logging integration's events off, so a bare ``log.error``
    files nothing (``test_a_service_logger_error_files_no_event``). Both reports go
    through ``capture_message`` instead, and these tests read what the client sent.
    ``test_health.py`` pins the other half: ``health.metrics`` calls ``report_mismatch``
    with the client and the reason.
    """

    @pytest.fixture(autouse=True)
    def _state(self, monkeypatch):
        monkeypatch.setattr(auth, "_last_error_at", None)
        monkeypatch.setattr(settings, "internal_metrics_token", _WEAK_TOKEN)

    def test_a_refused_request_files_one_error_event_grouped_on_its_template(self, sdk_transport):
        auth.report_mismatch("203.0.113.7", "wrong")

        (event,) = sdk_transport.events()
        assert event["level"] == "error"
        assert event["logentry"]["message"] == _FAILED_CHECK
        assert event["logentry"]["params"] == ["203.0.113.7"]
        assert event["tags"]["component"] == "auth"
        assert event["tags"]["reason"] == "wrong"
        assert event["extra"]["reason"] == "wrong"

    def test_a_missing_header_files_the_same_template(self, sdk_transport):
        auth.report_mismatch("203.0.113.7", "missing")

        (event,) = sdk_transport.events()
        assert event["logentry"]["message"] == _FAILED_CHECK
        assert event["tags"]["reason"] == "missing"
        assert event["extra"]["reason"] == "missing"

    def test_further_refusals_inside_the_window_file_no_more_events(self, sdk_transport):
        for client in ("203.0.113.7", "198.51.100.4", "192.0.2.1"):
            auth.report_mismatch(client, "wrong")

        (event,) = sdk_transport.events()
        assert event["logentry"]["params"] == ["203.0.113.7"]

    def test_the_event_survives_the_before_send_of_the_production_configuration(
        self, production_client
    ):
        auth.report_mismatch("203.0.113.7", "wrong")

        (event,) = production_client.transport.events()
        assert event["level"] == "error"
        assert event["server_name"] == "uw-stream"
        assert event["logentry"]["message"] == _FAILED_CHECK
        assert event["logentry"]["params"] == ["203.0.113.7"]

    def test_a_short_token_files_one_boot_event_naming_the_variable(self, sdk_transport):
        auth.report_weak_secrets()

        (event,) = sdk_transport.events()
        assert event["level"] == "error"
        assert event["logentry"]["message"] == _SHORT_SECRET
        assert event["logentry"]["params"] == ["INTERNAL_METRICS_TOKEN"]

    def test_a_long_enough_token_files_no_boot_event(self, sdk_transport, monkeypatch):
        monkeypatch.setattr(settings, "internal_metrics_token", "t" * 32)

        auth.report_weak_secrets()

        assert sdk_transport.events() == []

    def test_the_boot_event_holds_neither_the_token_nor_a_number(self, sdk_transport):
        auth.report_weak_secrets()

        (event,) = sdk_transport.events()
        assert _WEAK_TOKEN.encode() not in b"".join(sdk_transport.payloads)
        # The text the report fills: the message, its context and tags, and the breadcrumb
        # that is its own log line. An event id or a timestamp may hold any digits, so
        # numbers are looked for in these only.
        reported = json.dumps(
            {
                **{k: event.get(k) for k in ("logentry", "extra", "tags")},
                "breadcrumbs": [c["message"] for c in event["breadcrumbs"]["values"]],
            }
        )
        assert not any(ch.isdigit() for ch in reported)

    def test_the_refusal_event_holds_no_number_beside_the_client(self, sdk_transport):
        auth.report_mismatch("198.51.100.4", "wrong")

        (event,) = sdk_transport.events()
        reported = json.dumps(
            {
                **{k: event.get(k) for k in ("logentry", "extra", "tags")},
                "breadcrumbs": [c["message"] for c in event["breadcrumbs"]["values"]],
            }
        ).replace("198.51.100.4", "")
        assert not any(ch.isdigit() for ch in reported)


_CONFIGURED_TOKEN = "configured-token-" + "c" * 24
_PRESENTED_TOKEN = "presented-credential-" + "p" * 16


class TestMetricsRequestEvents:
    """Events filed from inside a real aiohttp request, with ``init_sentry``'s own options.

    The aiohttp integration attaches the request's headers to any event captured while the
    request is handled. ``TestAuthReports`` calls ``auth.report_*`` outside a request, so the
    integration never runs there; these go through ``health.build_app()`` on a loopback server.
    Each asserts the headers did reach the event (so the check below it is not vacuous).
    """

    @pytest.fixture(autouse=True)
    def _state(self, monkeypatch):
        monkeypatch.setattr(auth, "_last_error_at", None)
        monkeypatch.setattr(settings, "internal_metrics_token", _CONFIGURED_TOKEN)

    @staticmethod
    def _request_headers(event: dict[str, Any]) -> dict[str, str]:
        return {k.lower(): v for k, v in event["request"]["headers"].items()}

    async def test_a_refused_request_files_one_event_and_no_token_leaves_the_process(
        self, production_client
    ):
        async with TestClient(TestServer(health.build_app())) as client:
            response = await client.get(
                "/metrics",
                headers={"X-Metrics-Token": _PRESENTED_TOKEN, "X-Real-IP": "203.0.113.7"},
            )

        assert response.status == 401
        (event,) = production_client.transport.events()
        assert event["logentry"]["message"] == _FAILED_CHECK
        assert event["logentry"]["params"] == ["203.0.113.7"]
        headers = self._request_headers(event)
        assert "user-agent" in headers
        assert headers["x-metrics-token"] == "[Filtered]"
        sent = b"".join(production_client.transport.payloads)
        assert _PRESENTED_TOKEN.encode() not in sent
        assert _CONFIGURED_TOKEN.encode() not in sent

    async def test_an_unhandled_error_after_the_gate_leaves_no_token_in_its_event(
        self, production_client, monkeypatch
    ):
        def failing_snapshot() -> None:
            raise RuntimeError("memory read failed")

        monkeypatch.setattr(memory_stats, "snapshot", failing_snapshot)

        async with TestClient(TestServer(health.build_app())) as client:
            response = await client.get("/metrics", headers={"X-Metrics-Token": _CONFIGURED_TOKEN})

        assert response.status == 500
        (event,) = production_client.transport.events()
        assert event["exception"]["values"][0]["type"] == "RuntimeError"
        assert self._request_headers(event)["x-metrics-token"] == "[Filtered]"
        assert _CONFIGURED_TOKEN.encode() not in b"".join(production_client.transport.payloads)
