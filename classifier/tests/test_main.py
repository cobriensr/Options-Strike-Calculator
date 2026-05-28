"""Tests for ``classifier.src.main`` — entrypoint + PORT parsing.

``main()`` blocks on ``serve_forever`` in normal operation; tests drive
it with a mocked server whose ``serve_forever`` returns immediately so
the cleanup path is exercised without spinning a real socket.

Phase 1.5 additions: SIGTERM handler installation (fix 0.3),
``sentry_sdk.flush`` in the cleanup path, and Sentry capture on PORT
misconfig (fix 3.3).
"""

from __future__ import annotations

import signal
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


# ── Phase 1.5 fix 0.3: SIGTERM handler ────────────────────────────────────


def test_on_sigterm_raises_keyboard_interrupt() -> None:
    """``_on_sigterm`` must raise KeyboardInterrupt — that's the
    mechanism by which it short-circuits ``serve_forever`` into the
    ``main`` finally block.
    """
    with pytest.raises(KeyboardInterrupt):
        main._on_sigterm(signal.SIGTERM, None)


def test_main_installs_sigterm_handler_before_serve_forever(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``main`` must install the SIGTERM handler via ``signal.signal``
    before blocking on ``serve_forever``. Without this, Python's default
    handler immediately terminates the process on SIGTERM and the
    cleanup path never runs.
    """
    monkeypatch.delenv("PORT", raising=False)

    # Order matters: signal.signal must be called BEFORE serve_forever.
    call_order: list[str] = []

    def record_signal(sig, handler):
        call_order.append(f"signal({sig})")
        return None

    def record_serve():
        call_order.append("serve_forever")

    mock_httpd.serve_forever.side_effect = record_serve

    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
        patch("signal.signal", side_effect=record_signal) as mock_signal,
    ):
        rc = main.main()

    assert rc == 0
    # signal.signal called with SIGTERM and a callable.
    sigterm_calls = [
        call for call in mock_signal.call_args_list if call.args[0] == signal.SIGTERM
    ]
    assert len(sigterm_calls) == 1, f"expected one SIGTERM install, got {sigterm_calls}"
    assert callable(sigterm_calls[0].args[1])
    # SIGTERM install precedes serve_forever in execution order.
    sigterm_idx = next(
        i for i, name in enumerate(call_order) if name == f"signal({signal.SIGTERM})"
    )
    serve_idx = call_order.index("serve_forever")
    assert sigterm_idx < serve_idx, f"SIGTERM install must precede serve_forever; order: {call_order}"


def test_main_handles_sigterm_via_installed_handler(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: simulate the installed handler firing during
    ``serve_forever``. The KeyboardInterrupt path runs the cleanup.
    """
    monkeypatch.delenv("PORT", raising=False)

    # Have serve_forever invoke the captured handler to simulate the OS
    # delivering SIGTERM mid-request.
    captured_handler: list = []

    def grab_handler(sig, handler):
        if sig == signal.SIGTERM:
            captured_handler.append(handler)
        return None

    def fire_sigterm():
        # First assert the captured handler is the canonical _on_sigterm,
        # not some other callable that happens to raise. Catches a
        # regression where `main` installs the wrong handler for SIGTERM
        # (e.g. swapped with a SIGINT handler or a stub).
        assert captured_handler[0] is main._on_sigterm
        # Invoke the captured handler the same way the OS signal
        # delivery does.
        captured_handler[0](signal.SIGTERM, None)

    mock_httpd.serve_forever.side_effect = fire_sigterm

    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
        patch("signal.signal", side_effect=grab_handler),
    ):
        rc = main.main()

    assert rc == 0
    mock_httpd.shutdown.assert_called_once()
    mock_httpd.server_close.assert_called_once()


# ── Phase 1.5 fix 0.3: sentry_sdk.flush in finally ────────────────────────


def test_main_flushes_sentry_on_clean_shutdown(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase 1.5 fix 0.3: ``main`` must call ``sentry_sdk.flush(timeout=2)``
    in the finally block so queued exception events make it to Sentry
    before the process exits.
    """
    monkeypatch.delenv("PORT", raising=False)
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
        patch("sentry_sdk.flush") as mock_flush,
    ):
        rc = main.main()

    assert rc == 0
    mock_flush.assert_called_once_with(timeout=2)


def test_main_swallows_sentry_flush_failure(
    mock_httpd: MagicMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``sentry_sdk.flush`` can raise if the SDK is unset or broken;
    the suppress block must keep main() returning cleanly.
    """
    monkeypatch.delenv("PORT", raising=False)
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.server, "build_server", return_value=mock_httpd),
        patch("sentry_sdk.flush", side_effect=RuntimeError("flush blew up")),
    ):
        rc = main.main()  # must not raise

    assert rc == 0


# ── Phase 1.5 fix 3.3: Sentry capture on PORT misconfig ───────────────────


def test_main_captures_sentry_exception_on_bad_port_env(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Phase 1.5 fix 3.3: when ``_parse_port`` raises, ``main`` must
    call ``sentry_setup.capture_exception`` before returning 2 so the
    misconfig surfaces in Sentry instead of crashlooping silently.
    """
    monkeypatch.setenv("PORT", "not-a-port")
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(main.sentry_setup, "capture_exception") as mock_capture,
        patch.object(main.server, "build_server") as mock_build,
    ):
        rc = main.main()

    assert rc == 2
    mock_build.assert_not_called()
    mock_capture.assert_called_once()
    captured_exc = mock_capture.call_args.args[0]
    assert isinstance(captured_exc, ValueError)
    assert "PORT must be an integer" in str(captured_exc)
    # Tagged so the Sentry issue can be filtered.
    assert mock_capture.call_args.kwargs.get("tags") == {"phase": "port_parse"}


def test_main_swallows_sentry_capture_failure_on_bad_port(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Even if ``capture_exception`` itself raises, ``main`` must still
    return 2 — we don't want a flaky Sentry to mask a config bug.
    """
    monkeypatch.setenv("PORT", "still-bad")
    with (
        patch.object(main.sentry_setup, "init"),
        patch.object(
            main.sentry_setup,
            "capture_exception",
            side_effect=RuntimeError("sentry broken"),
        ),
        patch.object(main.server, "build_server"),
    ):
        rc = main.main()

    assert rc == 2
    out = capsys.readouterr().out
    assert "PORT must be an integer" in out
