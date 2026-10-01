"""Tests for sidecar/src/sentry_setup.py.

Covers: init_sentry() is safe to call with or without SENTRY_DSN,
capture_exception and capture_message always log and only forward to
Sentry when initialized.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest
import sentry_setup


# Shared mock_log that tests inspect. Installed per-test via the
# _reset_state fixture by monkeypatching sentry_setup.log directly —
# NOT by clobbering sys.modules["logger_setup"], which would break
# sibling test files that depend on the real logger_setup module.
mock_log = MagicMock()


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with Sentry uninitialized and the mock log reset."""
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
    # Monkeypatch sentry_setup.log (the module-level `log` symbol
    # that capture_exception and capture_message call) with our
    # MagicMock. monkeypatch auto-restores after each test, so no
    # cross-file pollution.
    mock_log.reset_mock()
    monkeypatch.setattr(sentry_setup, "log", mock_log)
    # Ensure env vars don't leak across tests
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_DEPLOYMENT_ID", raising=False)


class TestInitSentry:
    def test_no_op_when_dsn_missing(self) -> None:
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False
        # Should log a single info line explaining it's disabled
        mock_log.info.assert_any_call("SENTRY_DSN not set — Sentry disabled")

    def test_no_op_when_dsn_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SENTRY_DSN", "")
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False

    def test_no_op_when_dsn_whitespace(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SENTRY_DSN", "   ")
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False

    def test_idempotent_second_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Once initialized, calling init again is a no-op.

        (With DSN unset, both calls take the same 'disabled' branch, so
        idempotency there is not meaningful — only the 'enabled' path has
        the _sentry_enabled guard.)
        """
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")
        mock_sentry_sdk = MagicMock()
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()
        assert mock_sentry_sdk.init.call_count == 1
        assert sentry_setup.is_enabled() is True

        # Second call should NOT re-invoke sentry_sdk.init
        sentry_setup.init_sentry()
        assert mock_sentry_sdk.init.call_count == 1

    def test_init_initializes_when_dsn_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With a valid DSN, Sentry init is invoked and is_enabled() returns True."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")
        monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")

        mock_sentry_sdk = MagicMock()
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()

        assert sentry_setup.is_enabled() is True
        mock_sentry_sdk.init.assert_called_once()
        init_kwargs = mock_sentry_sdk.init.call_args.kwargs
        assert init_kwargs["dsn"] == "https://fake@example.ingest.sentry.io/1"
        assert init_kwargs["environment"] == "production"
        assert init_kwargs["sample_rate"] == pytest.approx(1.0)
        assert init_kwargs["traces_sample_rate"] == pytest.approx(0.0)
        assert init_kwargs["server_name"] == "futures-sidecar"

    def test_init_swallows_sdk_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A Sentry init exception must not block sidecar startup."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")

        mock_sentry_sdk = MagicMock()
        mock_sentry_sdk.init.side_effect = RuntimeError("simulated init failure")
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        # Must not raise
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False
        # And the failure should be logged
        assert any(
            "Failed to initialize Sentry" in str(call)
            for call in mock_log.error.call_args_list
        )

    def test_init_environment_defaults_to_production(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """With DSN set but no RAILWAY_ENVIRONMENT, environment defaults to production."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")

        mock_sentry_sdk = MagicMock()
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()

        init_kwargs = mock_sentry_sdk.init.call_args.kwargs
        assert init_kwargs["environment"] == "production"


class TestCaptureExceptionDisabled:
    def test_logs_without_forwarding_when_disabled(self) -> None:
        exc = ValueError("test error")
        sentry_setup.capture_exception(exc)
        mock_log.error.assert_called_once()

    def test_logs_context_when_disabled(self) -> None:
        exc = ValueError("test error")
        sentry_setup.capture_exception(exc, context={"symbol": "ES"})
        # Should still log, with context somewhere in the message
        args, _ = mock_log.error.call_args
        assert any("context" in str(a) for a in args) or any(
            "ES" in str(a) for a in args
        )


class TestCaptureMessageDisabled:
    def test_logs_without_forwarding_when_disabled(self) -> None:
        sentry_setup.capture_message("warn event", level="warning")
        mock_log.warning.assert_called_once()

    def test_logs_with_context_when_disabled(self) -> None:
        sentry_setup.capture_message(
            "reconnect gap", level="warning", context={"gap_s": 75}
        )
        mock_log.warning.assert_called_once()


class TestApplyScope:
    """Phase 5d — _apply_scope helper extracted from capture_* fns."""

    def test_apply_tags_only(self) -> None:
        scope = MagicMock()
        sentry_setup._apply_scope(scope, {"component": "theta"}, None)
        scope.set_tag.assert_called_once_with("component", "theta")
        scope.set_extra.assert_not_called()

    def test_apply_context_only(self) -> None:
        scope = MagicMock()
        sentry_setup._apply_scope(scope, None, {"symbol": "ES"})
        scope.set_tag.assert_not_called()
        scope.set_extra.assert_called_once_with("symbol", "ES")

    def test_apply_both(self) -> None:
        scope = MagicMock()
        sentry_setup._apply_scope(
            scope,
            {"component": "theta"},
            {"symbol": "ES", "horizon_days": 30},
        )
        scope.set_tag.assert_called_once_with("component", "theta")
        # Both context kv pairs land as extras.
        assert scope.set_extra.call_count == 2

    def test_apply_neither_is_noop(self) -> None:
        scope = MagicMock()
        sentry_setup._apply_scope(scope, None, None)
        scope.set_tag.assert_not_called()
        scope.set_extra.assert_not_called()


class TestCaptureExceptionEnabled:
    def test_forwards_to_sentry_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Set up Sentry as enabled with a mock sentry_sdk
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")
        mock_sentry_sdk = MagicMock()
        # new_scope needs to return a context manager that yields a scope
        mock_scope = MagicMock()
        mock_sentry_sdk.new_scope.return_value.__enter__.return_value = mock_scope
        mock_sentry_sdk.new_scope.return_value.__exit__.return_value = None
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is True

        exc = ValueError("forwarded")
        sentry_setup.capture_exception(exc, context={"symbol": "ES"})

        mock_sentry_sdk.capture_exception.assert_called_once_with(exc)
        mock_scope.set_extra.assert_called_once_with("symbol", "ES")

    def test_init_registers_before_send_scrubber(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every outgoing event goes through the credential scrubber;
        send_default_pii is left at the SDK default (not passed)."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")
        mock_sentry_sdk = MagicMock()
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()

        init_kwargs = mock_sentry_sdk.init.call_args.kwargs
        assert init_kwargs["before_send"] is sentry_setup._before_send
        assert "send_default_pii" not in init_kwargs


# ---------------------------------------------------------------------------
# Credential redaction — log lines + Sentry before_send
# ---------------------------------------------------------------------------

SECRET = "s3cr3t-pw"
# psycopg2 echoes the offending conninfo for a malformed DSN.
PG_DSN_ERROR = (
    f'invalid dsn: missing "=" after "postgresql://neon_user:{SECRET}'
    '@ep-x.us-east-2.aws.neon.tech/neondb" in connection info string'
)
PG_KV_ERROR = (
    "connection to server failed: host=ep-x.neon.tech user=neon_user "
    f"password={SECRET} dbname=neondb sslmode=require"
)


def _logged_text(log_method: MagicMock) -> str:
    """Render every call on a mocked log method the way logging would."""
    return "\n".join(
        c.args[0] % c.args[1:] if len(c.args) > 1 else str(c.args[0])
        for c in log_method.call_args_list
    )


class TestRedactCredentials:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (
                f"postgresql://u:{SECRET}@h:5432/db?sslmode=require",
                "postgresql://***@h:5432/db?sslmode=require",
            ),
            (f"postgres://u:{SECRET}@h/db", "postgres://***@h/db"),
            (f"redis://default:{SECRET}@cache:6379", "redis://***@cache:6379"),
            (f"https://u:{SECRET}@api.example.com/x", "https://***@api.example.com/x"),
            (f"password={SECRET} dbname=db", "password=*** dbname=db"),
            (f"password = '{SECRET} with space'", "password = ***"),
            (f"sslpassword={SECRET}", "sslpassword=***"),
            (f"PASSWORD={SECRET}", "PASSWORD=***"),
            (
                f"postgresql://h/db?user=u&password={SECRET}",
                "postgresql://h/db?user=u&password=***",
            ),
        ],
    )
    def test_masks_credentials(self, raw: str, expected: str) -> None:
        assert sentry_setup.redact_credentials(raw) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "db pool saturated: could not borrow a connection within 10.0s",
            'password authentication failed for user "neon_user"',
            "https://example.com/path/index.html?q=1",
            "contact ops@example.com about the outage",
            "csrf_token is missing; tokens rotate hourly",
            "the bearer of bad news",
            "password reset required for user neon_user",
            "",
        ],
    )
    def test_normal_text_passes_through(self, text: str) -> None:
        assert sentry_setup.redact_credentials(text) == text


class TestRedactionHardening:
    """Review follow-ups to the first redaction pass (items 1-6)."""

    # Item 1 — unencoded ``@ / # ?`` in the password: mask up to the LAST @.
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (
                "postgresql://user:p@ss:w/rd#x?y@host/db",
                "postgresql://***@host/db",
            ),
            (
                (
                    'invalid dsn: missing "=" after '
                    '"postgresql://u:p@ss/w#x@ep.neon.tech/neondb" in connection'
                ),
                (
                    'invalid dsn: missing "=" after '
                    '"postgresql://***@ep.neon.tech/neondb" in connection'
                ),
            ),
            ("postgresql://u:p@@ss@host", "postgresql://***@host"),
            # Glued prefix longer than a scheme still gets its userinfo masked.
            ("x" * 40 + "postgresql://u:pw@h", "x" * 40 + "postgresql://***@h"),
        ],
    )
    def test_password_with_unencoded_delimiters_is_masked_whole(
        self, raw: str, expected: str
    ) -> None:
        assert sentry_setup.redact_credentials(raw) == expected

    def test_url_with_at_in_path_is_accepted_over_redaction(self) -> None:
        # Greedy-to-last-@ cannot tell a path @ from a password @; masking
        # more than needed is the accepted trade-off.
        out = sentry_setup.redact_credentials("https://example.com/path/a@b?q=1")
        assert out == "https://***@b?q=1"

    # Item 2 — bytes.
    def test_bytes_are_decoded_redacted_and_returned_as_str(self) -> None:
        raw = f"postgresql://u:{SECRET}@h/db".encode() + b"\xff"
        out = sentry_setup._redact_value(raw)
        assert isinstance(out, str)
        assert SECRET not in out
        assert out.startswith("postgresql://***@h/db")
        assert sentry_setup._redact_value(bytearray(b"token=abc")) == "token=***"

    # Item 3 — DSN wrapped across a newline.
    def test_dsn_split_across_newline_is_masked(self) -> None:
        raw = f"postgresql://neon_user:{SECRET[:3]}\n{SECRET[3:]}@host/db"
        out = sentry_setup.redact_credentials(raw)
        assert out == "postgresql://***@host/db"

    def test_userinfo_window_is_bounded(self) -> None:
        """A scheme more than ~200 chars from the next @ is not joined to it,
        so one stray @ can't swallow a whole paragraph."""
        raw = "see https://example.com/" + "x" * 300 + " mail ops@example.com"
        assert sentry_setup.redact_credentials(raw) == raw

    # Item 5 — token / API-key / bearer / Vercel Blob patterns.
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("token=abc123&x=1", "token=***&x=1"),
            ("TOKEN=abc123", "TOKEN=***"),
            ("api_key=k1", "api_key=***"),
            ("API-KEY=k1", "API-KEY=***"),
            ("apikey=k1", "apikey=***"),
            (
                "access_token=t1 refresh_token=t2",
                "access_token=*** refresh_token=***",
            ),
            ("wss://api.x.com/socket?token=abc", "wss://api.x.com/socket?token=***"),
            ("Authorization: Bearer abc.def-ghi", "Authorization: Bearer ***"),
            (
                'headers={"Authorization": "bearer xyz12345abc"}',
                'headers={"Authorization": "bearer ***"}',
            ),
            (
                "put failed for vercel_blob_rw_AbC123_xyz9",
                "put failed for vercel_blob_rw_***",
            ),
            ("password='unclosed quote", "password=*** quote"),
        ],
    )
    def test_token_patterns_are_masked(self, raw: str, expected: str) -> None:
        assert sentry_setup.redact_credentials(raw) == expected

    # Item 6 — sensitive-named frame vars and extras are blanked.
    def test_sensitive_named_keys_are_blanked_whatever_the_value(self) -> None:
        event = {
            "exception": {
                "values": [
                    {
                        "stacktrace": {
                            "frames": [
                                {
                                    "vars": {
                                        "dsn": "'opaque-no-pattern'",
                                        "Password": "hunter2",
                                        "PASSWD": "x",
                                        "secret": ["a", "b"],
                                        "Token": 12345,
                                        "api_key": {"nested": "k"},
                                        "APIKEY": None,
                                        "timeout_s": 10.0,
                                    }
                                }
                            ]
                        }
                    }
                ]
            },
            "extra": {"dsn": "raw", "symbol": "ES"},
        }
        out = sentry_setup._before_send(event, {})
        frame_vars = out["exception"]["values"][0]["stacktrace"]["frames"][0]["vars"]
        for key in (
            "dsn",
            "Password",
            "PASSWD",
            "secret",
            "Token",
            "api_key",
            "APIKEY",
        ):
            assert frame_vars[key] == "[redacted]"
        assert frame_vars["timeout_s"] == 10.0
        assert out["extra"] == {"dsn": "[redacted]", "symbol": "ES"}

    def test_log_line_blanks_sensitive_context_keys(self) -> None:
        sentry_setup.capture_exception(
            ValueError("boom"), context={"password": "hunter2", "phase": "boot"}
        )
        logged = _logged_text(mock_log.error)
        assert "hunter2" not in logged
        assert "[redacted]" in logged
        assert "boot" in logged

    # Adversarial performance: every pattern is bounded/linear.
    @pytest.mark.parametrize(
        "payload",
        [
            "a://" * 25_000 + "@",
            "x@" * 50_000 + " a://",
            ("x" * 199 + "@") * 500 + " a://",
            "@a:/" * 25_000 + " a://",
            "a." * 50_000,
            "password='" * 10_000,
            "password=" + "\\x" * 50_000,
            "password" + " " * 100_000,
            "Bearer " * 14_000,
            "token=" * 16_000,
            "postgresql://" * 7_700 + "@",
        ],
        ids=lambda p: repr(p[:12]),
    )
    def test_adversarial_100kb_input_redacts_fast(self, payload: str) -> None:
        import timeit

        assert len(payload) >= 96_000
        # Best of 3 to keep a loaded CI box from flaking the bound; the
        # worst case measured locally is ~25 ms.
        elapsed = min(
            timeit.repeat(
                lambda: sentry_setup.redact_credentials(payload), number=1, repeat=3
            )
        )
        assert elapsed < 0.1, f"redaction took {elapsed * 1000:.1f} ms"


class TestCaptureRedactsLogLines:
    def test_capture_exception_redacts_dsn_in_message(self) -> None:
        sentry_setup.capture_exception(RuntimeError(PG_DSN_ERROR))
        logged = _logged_text(mock_log.error)
        assert SECRET not in logged
        assert "postgresql://***@ep-x.us-east-2.aws.neon.tech/neondb" in logged

    def test_capture_exception_redacts_libpq_password(self) -> None:
        sentry_setup.capture_exception(RuntimeError(PG_KV_ERROR))
        logged = _logged_text(mock_log.error)
        assert SECRET not in logged
        assert "password=***" in logged

    def test_capture_exception_redacts_context(self) -> None:
        sentry_setup.capture_exception(
            ValueError("boom"),
            context={"dsn": f"postgresql://u:{SECRET}@h/db"},
        )
        logged = _logged_text(mock_log.error)
        assert SECRET not in logged
        assert "boom" in logged

    def test_capture_exception_normal_message_unchanged(self) -> None:
        sentry_setup.capture_exception(ValueError("plain failure"))
        assert _logged_text(mock_log.error) == "plain failure"

    def test_capture_message_redacts(self) -> None:
        sentry_setup.capture_message(f"retrying {PG_KV_ERROR}")
        logged = _logged_text(mock_log.warning)
        assert SECRET not in logged


def _event_with_secrets() -> dict:
    """A Sentry-event-shaped dict with the secret in every text surface."""
    return {
        "level": "error",
        "message": f"db down: {PG_KV_ERROR}",
        "logentry": {"message": PG_DSN_ERROR, "formatted": PG_DSN_ERROR},
        "exception": {
            "values": [
                {
                    "type": "OperationalError",
                    "value": PG_DSN_ERROR,
                    "stacktrace": {
                        "frames": [
                            {
                                "function": "get_pool",
                                "lineno": 74,
                                "vars": {
                                    "dsn": f"'postgresql://u:{SECRET}@h/db'",
                                    "timeout_s": 10.0,
                                },
                            }
                        ]
                    },
                }
            ]
        },
        "breadcrumbs": {
            "values": [{"category": "log", "message": PG_KV_ERROR, "level": "warning"}]
        },
        "extra": {"context": (f"password={SECRET}", 3)},
        "tags": {"component": "db"},
    }


class TestBeforeSend:
    def test_scrubs_every_text_surface(self) -> None:
        import json

        result = sentry_setup._before_send(_event_with_secrets(), {})

        assert SECRET not in json.dumps(result)
        exc_value = result["exception"]["values"][0]
        assert exc_value["value"].startswith("invalid dsn: missing")
        assert "password=***" in result["breadcrumbs"]["values"][0]["message"]
        assert "password=***" in result["message"]
        # Non-string leaves and structure are preserved.
        assert exc_value["stacktrace"]["frames"][0]["vars"]["timeout_s"] == 10.0
        assert result["extra"]["context"][1] == 3
        assert result["tags"] == {"component": "db"}

    def test_normal_event_passes_through_unchanged(self) -> None:
        event = {
            "level": "warning",
            "message": "db health probe: pool saturated (healthy but busy)",
            "exception": {"values": [{"type": "ValueError", "value": "boom"}]},
            "breadcrumbs": {"values": [{"message": "GET /health 200"}]},
        }
        assert sentry_setup._before_send(event, {}) == event

    @pytest.mark.parametrize(
        "event",
        [
            {},
            {"exception": None, "breadcrumbs": "not-a-dict", "extra": 42},
            {"exception": {"values": [None, 7, object()]}},
            {"message": None, "logentry": {"params": [b"bytes", 1.5, None]}},
        ],
    )
    def test_never_raises_on_odd_event_shapes(self, event: dict) -> None:
        result = sentry_setup._before_send(event, None)
        assert isinstance(result, dict)
        assert result.keys() == event.keys()

    def test_scrub_failure_sends_minimal_value_free_event(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A redactor bug must not ship the raw event: only envelope fields,
        exception TYPES and tags survive, plus a fixed message."""

        def _boom(_value: object) -> object:
            raise RecursionError("too deep")

        monkeypatch.setattr(sentry_setup, "_redact_value", _boom)
        event = _event_with_secrets()
        event["event_id"] = "abc123"
        event["timestamp"] = "2026-10-01T00:00:00Z"

        out = sentry_setup._before_send(event, {})

        assert out == {
            "event_id": "abc123",
            "timestamp": "2026-10-01T00:00:00Z",
            "level": "error",
            "message": "sidecar event dropped: redaction failed",
            "exception": {"values": [{"type": "OperationalError"}]},
            "tags": {"component": "db"},
        }
        mock_log.warning.assert_called_once()
        assert "RecursionError" in _logged_text(mock_log.warning)

    def test_scrub_failure_on_non_dict_event_still_returns_minimal(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom(_value: object) -> object:
            raise ValueError("bad")

        monkeypatch.setattr(sentry_setup, "_redact_value", _boom)

        out = sentry_setup._before_send(["not", "a", "dict"], None)

        assert out == {
            "message": "sidecar event dropped: redaction failed",
            "level": "error",
        }
