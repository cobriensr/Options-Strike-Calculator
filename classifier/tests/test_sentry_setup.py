"""Tests for ``classifier.src.sentry_setup``.

Covers the no-op-when-DSN-unset path (local dev), the init-when-DSN-set
path, the idempotency guard, and the ``capture_exception`` helper's tag
plumbing. Sentry SDK calls are mocked — these tests must run with no
network and no real DSN.
"""

from __future__ import annotations

import importlib
from unittest.mock import MagicMock, patch

import pytest


# Reimport per test so module-level ``_sentry_enabled`` state is fresh —
# autouse fixture in conftest snapshot/restores it, but importlib.reload
# is a stronger guarantee for tests that touch init().
@pytest.fixture
def fresh_sentry_setup():
    import sentry_setup

    importlib.reload(sentry_setup)
    yield sentry_setup
    # Restore: re-reload to clear any state set during the test.
    importlib.reload(sentry_setup)


class TestInit:
    def test_init_is_noop_when_dsn_unset(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("SENTRY_DSN", raising=False)
        with patch("sentry_sdk.init") as mock_init:
            fresh_sentry_setup.init()
        assert mock_init.call_count == 0
        assert fresh_sentry_setup.is_enabled() is False

    def test_init_is_noop_when_dsn_empty_string(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "")
        with patch("sentry_sdk.init") as mock_init:
            fresh_sentry_setup.init()
        assert mock_init.call_count == 0
        assert fresh_sentry_setup.is_enabled() is False

    def test_init_is_noop_when_dsn_whitespace_only(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ``.strip()`` guard inside init() should reject whitespace-only.
        monkeypatch.setenv("SENTRY_DSN", "   ")
        with patch("sentry_sdk.init") as mock_init:
            fresh_sentry_setup.init()
        assert mock_init.call_count == 0
        assert fresh_sentry_setup.is_enabled() is False

    def test_init_calls_sdk_with_classifier_tags(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        monkeypatch.setenv("RAILWAY_ENVIRONMENT", "test-env")
        monkeypatch.setenv("RAILWAY_DEPLOYMENT_ID", "deploy-abc")

        with (
            patch("sentry_sdk.init") as mock_init,
            patch("sentry_sdk.set_tag") as mock_set_tag,
        ):
            fresh_sentry_setup.init()

        assert mock_init.call_count == 1
        kwargs = mock_init.call_args.kwargs
        assert kwargs["dsn"] == "https://fake@sentry.example.com/1"
        assert kwargs["server_name"] == "classifier"
        assert kwargs["traces_sample_rate"] == 0.0
        assert kwargs["sample_rate"] == 1.0
        assert kwargs["environment"] == "test-env"
        assert kwargs["release"] == "deploy-abc"
        mock_set_tag.assert_called_once_with("service", "classifier")
        assert fresh_sentry_setup.is_enabled() is True

    def test_init_uses_production_default_when_railway_env_unset(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
        monkeypatch.delenv("RAILWAY_DEPLOYMENT_ID", raising=False)

        with (
            patch("sentry_sdk.init") as mock_init,
            patch("sentry_sdk.set_tag"),
        ):
            fresh_sentry_setup.init()

        kwargs = mock_init.call_args.kwargs
        assert kwargs["environment"] == "production"
        assert kwargs["release"] is None

    def test_init_is_idempotent(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with (
            patch("sentry_sdk.init") as mock_init,
            patch("sentry_sdk.set_tag"),
        ):
            fresh_sentry_setup.init()
            fresh_sentry_setup.init()
            fresh_sentry_setup.init()
        # Three calls to init(), but the SDK init should fire exactly once.
        assert mock_init.call_count == 1

    def test_init_swallows_sdk_init_exception(
        self,
        fresh_sentry_setup,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """A crash inside sentry_sdk.init must NOT take down the service."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with patch(
            "sentry_sdk.init", side_effect=RuntimeError("simulated init failure")
        ):
            fresh_sentry_setup.init()  # must not raise
        # Service stays in "Sentry disabled" state when init fails.
        assert fresh_sentry_setup.is_enabled() is False
        out = capsys.readouterr().out
        assert "init failed" in out
        assert "simulated init failure" in out

    def test_init_handles_missing_sentry_sdk_import(
        self,
        fresh_sentry_setup,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """If sentry_sdk somehow isn't importable, print + continue."""
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args, **kwargs):
            if name == "sentry_sdk":
                raise ImportError("sentry_sdk not installed in this image")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        fresh_sentry_setup.init()  # must not raise
        assert fresh_sentry_setup.is_enabled() is False
        out = capsys.readouterr().out
        assert "sentry_sdk not installed" in out


class TestIsEnabled:
    def test_returns_false_before_init(self, fresh_sentry_setup) -> None:
        assert fresh_sentry_setup.is_enabled() is False

    def test_returns_true_after_successful_init(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with patch("sentry_sdk.init"), patch("sentry_sdk.set_tag"):
            fresh_sentry_setup.init()
        assert fresh_sentry_setup.is_enabled() is True


class TestCaptureException:
    def test_capture_is_noop_when_disabled(self, fresh_sentry_setup) -> None:
        with patch("sentry_sdk.capture_exception") as mock_capture:
            fresh_sentry_setup.capture_exception(RuntimeError("nope"))
        assert mock_capture.call_count == 0

    def test_capture_forwards_exception_with_tags(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with patch("sentry_sdk.init"), patch("sentry_sdk.set_tag"):
            fresh_sentry_setup.init()

        # new_scope is a context manager; mock returns a scope mock
        # that records set_tag calls.
        scope_mock = MagicMock()
        scope_cm = MagicMock()
        scope_cm.__enter__ = MagicMock(return_value=scope_mock)
        scope_cm.__exit__ = MagicMock(return_value=False)
        exc = ValueError("classify failed")

        with (
            patch("sentry_sdk.new_scope", return_value=scope_cm) as mock_new_scope,
            patch("sentry_sdk.capture_exception") as mock_capture,
        ):
            fresh_sentry_setup.capture_exception(
                exc, tags={"component": "classifier", "route": "classify"}
            )

        mock_new_scope.assert_called_once_with()
        mock_capture.assert_called_once_with(exc)
        # Tags were applied in iteration order on the scope.
        scope_mock.set_tag.assert_any_call("component", "classifier")
        scope_mock.set_tag.assert_any_call("route", "classify")
        assert scope_mock.set_tag.call_count == 2

    def test_capture_with_no_tags_still_captures(
        self, fresh_sentry_setup, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with patch("sentry_sdk.init"), patch("sentry_sdk.set_tag"):
            fresh_sentry_setup.init()

        scope_mock = MagicMock()
        scope_cm = MagicMock()
        scope_cm.__enter__ = MagicMock(return_value=scope_mock)
        scope_cm.__exit__ = MagicMock(return_value=False)
        exc = ValueError("classify failed")

        with (
            patch("sentry_sdk.new_scope", return_value=scope_cm),
            patch("sentry_sdk.capture_exception") as mock_capture,
        ):
            fresh_sentry_setup.capture_exception(exc)

        # No tags supplied → set_tag never called inside the scope.
        scope_mock.set_tag.assert_not_called()
        mock_capture.assert_called_once_with(exc)

    def test_capture_swallows_internal_exception(
        self,
        fresh_sentry_setup,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """A buggy sentry_sdk.new_scope must NOT take down the route 500 path.

        The whole point of the helper is best-effort: the caller already
        committed to returning 500; capture_exception failing must not
        replace that with a crash.
        """
        monkeypatch.setenv("SENTRY_DSN", "https://fake@sentry.example.com/1")
        with patch("sentry_sdk.init"), patch("sentry_sdk.set_tag"):
            fresh_sentry_setup.init()

        with patch(
            "sentry_sdk.new_scope", side_effect=RuntimeError("scope blew up")
        ):
            fresh_sentry_setup.capture_exception(
                RuntimeError("real error"), tags={"x": "y"}
            )  # must not raise
        out = capsys.readouterr().out
        assert "capture_exception failed" in out
        assert "scope blew up" in out
