"""Tests for ``sentry_setup._before_send`` — collapses N channel stacks
into one Sentry issue when a transient DB error fires across handlers.

Added 2026-05-14 after a Neon scale-down produced 7+ distinct Sentry
groups from a single event. The retry wrapper in ``db._with_db_retry``
absorbs brief outages; ``_before_send`` collapses the rest so triage
shows one issue per exception type, regardless of which handler raised.
"""

from __future__ import annotations

import asyncpg.exceptions

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
            _hint_with(
                asyncpg.exceptions.ConnectionDoesNotExistError("57P01")
            ),
        )
        assert out["fingerprint"] == [
            "uw-stream-transient-db",
            "ConnectionDoesNotExistError",
        ]

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
        event = {
            "message": (
                "url=wss://api.unusualwhales.com/socket?token=ABCDEFG&trace=1"
            )
        }
        out = _before_send(event, {})
        assert "ABCDEFG" not in out["message"]
        assert "token=REDACTED&trace=1" in out["message"]

    def test_scrubs_token_in_nested_breadcrumb_dict(self):
        event = {
            "breadcrumbs": {
                "values": [
                    {
                        "category": "websocket",
                        "data": {
                            "url": (
                                "wss://api.unusualwhales.com/socket"
                                "?token=NESTED_KEY"
                            )
                        },
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
        event = {
            "exception": {
                "values": [
                    {"value": "url=wss://x/y?token=COMBO_KEY (transient)"}
                ]
            }
        }
        out = _before_send(event, _hint_with(TimeoutError("flush")))
        assert "COMBO_KEY" not in out["exception"]["values"][0]["value"]
        assert out["fingerprint"] == ["uw-stream-transient-db", "TimeoutError"]
