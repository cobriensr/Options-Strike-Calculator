"""Tests for ``sentry_setup._before_send`` — collapses N channel stacks
into one Sentry issue when a transient DB error fires across handlers.

Added 2026-05-14 after a Neon scale-down produced 7+ distinct Sentry
groups from a single event. The retry wrapper in ``db._with_db_retry``
absorbs brief outages; ``_before_send`` collapses the rest so triage
shows one issue per exception type, regardless of which handler raised.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import aiohttp
import asyncpg.exceptions
import pytest
import sentry_sdk
from sentry_sdk.envelope import Envelope
from sentry_sdk.integrations.aiohttp import AioHttpIntegration
from sentry_sdk.integrations.excepthook import ExcepthookIntegration
from sentry_sdk.integrations.logging import EventHandler, LoggingIntegration
from sentry_sdk.transport import Transport

import sentry_setup
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
    - asyncio/base_events.py "Exception in callback" and "Task exception was
      never retrieved", both through ``call_exception_handler``.

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

    def test_asyncio_records_still_reach_stderr(self, monkeypatch, capsys):
        """Any handler on a logger stops the stdlib's last-resort stderr line.

        asyncio has none and the root has none in production, so the new
        EventHandler would have hidden "Task exception was never retrieved"
        from the Railway logs. The root logger has no handler there; pytest's
        capture handlers stand in for one, so the lookup says there is none.
        """
        monkeypatch.setenv("SENTRY_DSN", FAKE_DSN)
        monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
        with (
            patch.object(sentry_sdk, "init", autospec=True),
            patch.object(sentry_sdk, "set_tag", autospec=True),
            patch.object(logging.Logger, "hasHandlers", return_value=False),
        ):
            sentry_setup.init_sentry()

        logging.getLogger("asyncio").warning("socket.send() raised exception.")

        assert "socket.send() raised exception." in capsys.readouterr().err


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
