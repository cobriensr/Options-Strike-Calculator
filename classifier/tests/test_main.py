"""Tests for ``classifier.src.main`` — entrypoint + PORT parsing.

``main()`` blocks on ``serve_forever`` in normal operation; tests drive
it with a mocked server whose ``serve_forever`` returns immediately so
the cleanup path is exercised without spinning a real socket.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import main

# ── _parse_port ───────────────────────────────────────────────────────────


class TestParsePort:
    def test_returns_default_when_none(self) -> None:
        assert main._parse_port(None) == main._DEFAULT_PORT

    def test_returns_default_when_empty_string(self) -> None:
        assert main._parse_port("") == main._DEFAULT_PORT

    def test_returns_default_when_whitespace_only(self) -> None:
        assert main._parse_port("   ") == main._DEFAULT_PORT

    def test_parses_valid_integer(self) -> None:
        assert main._parse_port("9090") == 9090

    def test_parses_valid_integer_with_whitespace(self) -> None:
        # int() handles surrounding whitespace.
        assert main._parse_port(" 9090 ") == 9090

    def test_raises_value_error_on_non_integer(self) -> None:
        with pytest.raises(ValueError, match="PORT must be an integer"):
            main._parse_port("not-a-number")

    def test_raises_value_error_on_zero(self) -> None:
        with pytest.raises(ValueError, match=r"PORT must be in 1\.\.65535"):
            main._parse_port("0")

    def test_raises_value_error_on_negative(self) -> None:
        with pytest.raises(ValueError, match=r"PORT must be in 1\.\.65535"):
            main._parse_port("-1")

    def test_raises_value_error_above_65535(self) -> None:
        with pytest.raises(ValueError, match=r"PORT must be in 1\.\.65535"):
            main._parse_port("65536")

    def test_accepts_max_port(self) -> None:
        assert main._parse_port("65535") == 65535

    def test_accepts_min_port(self) -> None:
        assert main._parse_port("1") == 1


# ── main() ────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_httpd() -> MagicMock:
    """A drop-in for ``build_server(port)`` whose ``serve_forever`` exits
    immediately so ``main()`` returns without blocking.
    """
    httpd = MagicMock()
    httpd.serve_forever = MagicMock()  # returns None → main proceeds to finally
    httpd.shutdown = MagicMock()
    httpd.server_close = MagicMock()
    return httpd


def test_main_returns_0_on_clean_shutdown(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PORT", raising=False)
    with (
        patch.object(main.sentry_setup, "init") as mock_init,
        patch.object(main.server, "build_server", return_value=mock_httpd) as mock_build,
    ):
        rc = main.main()

    assert rc == 0
    mock_init.assert_called_once()
    mock_build.assert_called_once_with(main._DEFAULT_PORT)
    mock_httpd.serve_forever.assert_called_once()
    mock_httpd.shutdown.assert_called_once()
    mock_httpd.server_close.assert_called_once()


def test_main_uses_port_env_var(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PORT", "12345")
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd) as mock_build,
    ):
        rc = main.main()

    assert rc == 0
    mock_build.assert_called_once_with(12345)


def test_main_returns_2_on_bad_port_env(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("PORT", "not-a-port")
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server") as mock_build,
    ):
        rc = main.main()

    assert rc == 2
    # build_server must NOT have been called — bad config short-circuits.
    mock_build.assert_not_called()
    out = capsys.readouterr().out
    assert "PORT must be an integer" in out


def test_main_handles_keyboard_interrupt_cleanly(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """KeyboardInterrupt (SIGINT / SIGTERM under PID 1) → clean shutdown."""
    monkeypatch.delenv("PORT", raising=False)
    mock_httpd.serve_forever.side_effect = KeyboardInterrupt()

    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
    ):
        rc = main.main()

    assert rc == 0
    mock_httpd.shutdown.assert_called_once()
    mock_httpd.server_close.assert_called_once()


def test_main_swallows_sentry_init_exception(
    mock_httpd: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A buggy ``sentry_setup.init`` must NOT prevent the service from
    starting — Sentry is best-effort and the classifier is on the
    production scoring path.
    """
    monkeypatch.delenv("PORT", raising=False)
    with (
        patch.object(
            main.sentry_setup, "init", side_effect=RuntimeError("sentry blew up")
        ),
        patch.object(main.server, "build_server", return_value=mock_httpd),
    ):
        rc = main.main()

    assert rc == 0
    out = capsys.readouterr().out
    assert "sentry init raised" in out
    mock_httpd.serve_forever.assert_called_once()


def test_main_cleanup_suppresses_shutdown_errors(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If ``shutdown()`` or ``server_close()`` raise during teardown,
    the suppress() blocks must keep main() from re-raising.
    """
    monkeypatch.delenv("PORT", raising=False)
    mock_httpd.shutdown.side_effect = RuntimeError("shutdown failed")
    mock_httpd.server_close.side_effect = RuntimeError("close failed")

    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
    ):
        rc = main.main()  # must not raise

    assert rc == 0
    mock_httpd.shutdown.assert_called_once()
    mock_httpd.server_close.assert_called_once()
