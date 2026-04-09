"""Tests for sidecar/src/sentry_setup.py.

Covers: init_sentry() is safe to call with or without SENTRY_DSN,
capture_exception and capture_message always log and only forward to
Sentry when initialized.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

# Mock logger_setup before importing sentry_setup — otherwise importing
# logger_setup tries to construct the real JSON handler, which is fine
# but we want to spy on log calls in some tests.
mock_logger_module = MagicMock()
mock_log = MagicMock()
mock_logger_module.log = mock_log
sys.modules["logger_setup"] = mock_logger_module

import pytest  # noqa: E402
import sentry_setup  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with Sentry uninitialized and the mock log reset."""
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)
    mock_log.reset_mock()
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

    def test_no_op_when_dsn_empty_string(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "")
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False

    def test_no_op_when_dsn_whitespace(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "   ")
        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is False

    def test_idempotent_second_call(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
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

    def test_init_swallows_sdk_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
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


class TestCaptureExceptionEnabled:
    def test_forwards_to_sentry_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Set up Sentry as enabled with a mock sentry_sdk
        monkeypatch.setenv("SENTRY_DSN", "https://fake@example.ingest.sentry.io/1")
        mock_sentry_sdk = MagicMock()
        # push_scope needs to return a context manager that yields a scope
        mock_scope = MagicMock()
        mock_sentry_sdk.push_scope.return_value.__enter__.return_value = mock_scope
        mock_sentry_sdk.push_scope.return_value.__exit__.return_value = None
        monkeypatch.setitem(sys.modules, "sentry_sdk", mock_sentry_sdk)

        sentry_setup.init_sentry()
        assert sentry_setup.is_enabled() is True

        exc = ValueError("forwarded")
        sentry_setup.capture_exception(exc, context={"symbol": "ES"})

        mock_sentry_sdk.capture_exception.assert_called_once_with(exc)
        mock_scope.set_extra.assert_called_once_with("symbol", "ES")
