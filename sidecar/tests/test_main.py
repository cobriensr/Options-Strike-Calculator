"""Tests for sidecar/src/main.py.

Focused on the entry-point's early-exit behavior. The main concern is
that env-var validation runs BEFORE any subsystem launch (Theta
Terminal, Databento), so a misconfigured deployment fails fast instead
of burning ~60s of Railway compute booting Theta only to die at the
first DB call.

Mock strategy:
- conftest.py provides session-wide mocks for `databento`, `psycopg2`,
  `sentry_sdk` that aren't in the test venv.
- `Settings()` runs at config.py import time and requires
  DATABENTO_API_KEY + DATABASE_URL to construct, so we set them BEFORE
  importing `main`. The early-exit code path then deletes one variable
  to exercise the validation branch directly.
- All side-effecting subsystems (theta_launcher, theta_fetcher,
  verify_connection, processors, DatabentoClient, start_health_server,
  init_sentry) are monkeypatched so the test doesn't make any I/O.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

# Required env vars for config.py's pydantic-settings validation,
# which runs at import time. The early-exit tests below mutate
# os.environ AFTER import to drive the missing-env code path.
os.environ.setdefault("DATABENTO_API_KEY", "test-key")
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

import main  # noqa: E402


@pytest.fixture()
def patched_subsystems(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
    """Replace every side-effecting call inside main() with a MagicMock.

    Returned dict lets each test assert which subsystems did or did not
    run. The Theta launcher mock is the load-bearing one for Phase 1a
    correctness: it MUST NOT be called when env validation fails.
    """
    mocks = {
        "init_sentry": MagicMock(),
        "theta_launcher_start": MagicMock(return_value=False),
        "theta_fetcher_start_scheduler": MagicMock(),
        "verify_connection": MagicMock(),
        "trade_processor_cls": MagicMock(),
        "quote_processor_cls": MagicMock(),
        "databento_client_cls": MagicMock(),
        "start_health_server": MagicMock(),
        "connect_with_retry": MagicMock(),
    }

    monkeypatch.setattr(main, "init_sentry", mocks["init_sentry"])
    monkeypatch.setattr(main.theta_launcher, "start", mocks["theta_launcher_start"])
    monkeypatch.setattr(
        main.theta_fetcher,
        "start_scheduler",
        mocks["theta_fetcher_start_scheduler"],
    )
    monkeypatch.setattr(main, "verify_connection", mocks["verify_connection"])
    monkeypatch.setattr(main, "TradeProcessor", mocks["trade_processor_cls"])
    monkeypatch.setattr(main, "QuoteProcessor", mocks["quote_processor_cls"])
    monkeypatch.setattr(main, "DatabentoClient", mocks["databento_client_cls"])
    monkeypatch.setattr(main, "start_health_server", mocks["start_health_server"])
    monkeypatch.setattr(main, "connect_with_retry", mocks["connect_with_retry"])

    return mocks


def test_main_exits_when_database_url_missing(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """Missing DATABASE_URL must SystemExit(1) BEFORE Theta launches.

    Pre-fix this exited only at verify_connection() — after Theta had
    already booted (~60s). Post-fix the exit happens before any
    subsystem call so Railway compute isn't wasted on a doomed run.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")

    with pytest.raises(SystemExit) as exc_info:
        main.main()

    assert exc_info.value.code == 1
    # Sentry init still runs first by design (so we can report later
    # failures), but no other subsystem may have been touched.
    patched_subsystems["init_sentry"].assert_called_once()
    patched_subsystems["theta_launcher_start"].assert_not_called()
    patched_subsystems["theta_fetcher_start_scheduler"].assert_not_called()
    patched_subsystems["verify_connection"].assert_not_called()
    patched_subsystems["trade_processor_cls"].assert_not_called()
    patched_subsystems["quote_processor_cls"].assert_not_called()
    patched_subsystems["databento_client_cls"].assert_not_called()
    patched_subsystems["start_health_server"].assert_not_called()
    patched_subsystems["connect_with_retry"].assert_not_called()


def test_main_exits_when_databento_api_key_missing(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """Missing DATABENTO_API_KEY must also SystemExit(1) before Theta."""
    monkeypatch.delenv("DATABENTO_API_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    with pytest.raises(SystemExit) as exc_info:
        main.main()

    assert exc_info.value.code == 1
    patched_subsystems["theta_launcher_start"].assert_not_called()
    patched_subsystems["verify_connection"].assert_not_called()


def test_main_proceeds_when_required_env_present(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """With both env vars set, validation passes and Theta is launched.

    This is the happy-path complement to the missing-env tests above:
    proves the validation gate doesn't false-positive when env is good.
    """
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    main.main()

    patched_subsystems["init_sentry"].assert_called_once()
    patched_subsystems["theta_launcher_start"].assert_called_once()
    patched_subsystems["verify_connection"].assert_called_once()
    patched_subsystems["connect_with_retry"].assert_called_once()


# ---------------------------------------------------------------------------
# main() — Theta launched branch (lines 104-105)
# ---------------------------------------------------------------------------


def test_main_starts_theta_scheduler_and_backfill_when_launcher_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """When theta_launcher.start() returns True, main() must start the
    nightly scheduler AND spawn a daemon thread for the backfill."""
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    # Flip the launcher mock to True so the inner branch runs.
    patched_subsystems["theta_launcher_start"].return_value = True

    fake_thread_cls = MagicMock()
    monkeypatch.setattr(main.threading, "Thread", fake_thread_cls)

    main.main()

    patched_subsystems["theta_fetcher_start_scheduler"].assert_called_once()
    fake_thread_cls.assert_called_once()
    # Confirm the spawned thread was started as a daemon backfill.
    kwargs = fake_thread_cls.call_args.kwargs
    assert kwargs["daemon"] is True
    assert kwargs["name"] == "theta-backfill"
    fake_thread_cls.return_value.start.assert_called_once()


# ---------------------------------------------------------------------------
# main() — seed_callable branch (lines 134-139)
# ---------------------------------------------------------------------------


def test_main_builds_seed_callable_when_archive_env_present(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """When ARCHIVE_MANIFEST_URL + BLOB_READ_WRITE_TOKEN are set, main()
    must define a seed_callable that delegates to archive_seeder and
    pass it to start_health_server."""
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    monkeypatch.setenv("ARCHIVE_MANIFEST_URL", "https://example.com/m.json")
    monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "blob-token")
    monkeypatch.setenv("ARCHIVE_ROOT", "/tmp/archive-test")

    # Stub archive_seeder.seed_from_manifest so calling the closure is safe.
    fake_result = MagicMock()
    fake_result.as_dict.return_value = {"ok": True, "files": 3}
    fake_seed = MagicMock(return_value=fake_result)
    monkeypatch.setattr(main.archive_seeder, "seed_from_manifest", fake_seed)

    main.main()

    # The callable should have been forwarded to start_health_server
    # under the seed_archive kwarg.
    kwargs = patched_subsystems["start_health_server"].call_args.kwargs
    seed_callable = kwargs["seed_archive"]
    assert seed_callable is not None

    # Invoking it must call archive_seeder with the env-derived args.
    result = seed_callable()
    assert result == {"ok": True, "files": 3}
    fake_seed.assert_called_once_with(
        "https://example.com/m.json", "/tmp/archive-test", "blob-token"
    )


def test_main_disables_seed_callable_when_archive_env_missing(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """Without the archive env vars, seed_archive must be None so the
    health server returns 503 from /admin/seed-archive."""
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    monkeypatch.delenv("ARCHIVE_MANIFEST_URL", raising=False)
    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)

    main.main()

    kwargs = patched_subsystems["start_health_server"].call_args.kwargs
    assert kwargs["seed_archive"] is None


# ---------------------------------------------------------------------------
# shutdown() — graceful signal handler (lines 47-71)
# ---------------------------------------------------------------------------


@pytest.fixture()
def shutdown_fixtures(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
    """Patch every side effect inside shutdown(): theta + drain_pool +
    time.sleep + sys.exit. Also reset the module-level _shutting_down
    flag so each test starts from a clean slate."""
    monkeypatch.setattr(main, "_shutting_down", False)
    monkeypatch.setattr(main, "_client", None)
    monkeypatch.setattr(main, "_trade_processor", None)
    monkeypatch.setattr(main, "_quote_processor", None)

    mocks = {
        "theta_fetcher_stop": MagicMock(),
        "theta_launcher_shutdown": MagicMock(),
        "drain_pool": MagicMock(),
        "time_sleep": MagicMock(),
        "sys_exit": MagicMock(side_effect=SystemExit(0)),
    }

    monkeypatch.setattr(
        main.theta_fetcher, "stop_scheduler", mocks["theta_fetcher_stop"]
    )
    monkeypatch.setattr(
        main.theta_launcher, "shutdown", mocks["theta_launcher_shutdown"]
    )
    monkeypatch.setattr(main, "drain_pool", mocks["drain_pool"])
    monkeypatch.setattr(main.time, "sleep", mocks["time_sleep"])
    monkeypatch.setattr(main.sys, "exit", mocks["sys_exit"])

    return mocks


def test_shutdown_drains_pool_and_exits_when_no_client(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """With no Databento client connected, shutdown still stops the
    Theta scheduler, kills the jar, drains the DB pool, and exits 0."""
    import signal as _signal

    with pytest.raises(SystemExit):
        main.shutdown(_signal.SIGTERM, None)

    shutdown_fixtures["theta_fetcher_stop"].assert_called_once()
    shutdown_fixtures["theta_launcher_shutdown"].assert_called_once()
    shutdown_fixtures["drain_pool"].assert_called_once()
    shutdown_fixtures["sys_exit"].assert_called_once_with(0)
    assert main._shutting_down is True


def test_shutdown_stops_client_when_present(
    monkeypatch: pytest.MonkeyPatch,
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """With a Databento client connected, shutdown must call stop()
    on it before draining."""
    fake_client = MagicMock()
    monkeypatch.setattr(main, "_client", fake_client)

    import signal as _signal

    with pytest.raises(SystemExit):
        main.shutdown(_signal.SIGINT, None)

    fake_client.stop.assert_called_once()
    shutdown_fixtures["drain_pool"].assert_called_once()


def test_shutdown_flushes_processors_before_draining_pool(
    monkeypatch: pytest.MonkeyPatch,
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """shutdown() must stop (final-flush) the trade + quote processors
    BEFORE draining the DB pool, so buffered rows land in Neon before the
    pool closes. Pre-fix the processors were main()-locals and the daemon
    flush thread was killed with rows still buffered."""
    call_order: list[str] = []

    trade_proc = MagicMock()
    trade_proc.stop.side_effect = lambda: call_order.append("trade_stop")
    quote_proc = MagicMock()
    quote_proc.stop.side_effect = lambda: call_order.append("quote_stop")
    shutdown_fixtures["drain_pool"].side_effect = lambda: call_order.append("drain")

    monkeypatch.setattr(main, "_trade_processor", trade_proc)
    monkeypatch.setattr(main, "_quote_processor", quote_proc)

    import signal as _signal

    with pytest.raises(SystemExit):
        main.shutdown(_signal.SIGTERM, None)

    trade_proc.stop.assert_called_once()
    quote_proc.stop.assert_called_once()
    shutdown_fixtures["drain_pool"].assert_called_once()
    # Both processor flushes must precede the pool drain.
    assert call_order.index("trade_stop") < call_order.index("drain")
    assert call_order.index("quote_stop") < call_order.index("drain")


def test_shutdown_handles_missing_processors(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """shutdown() must not crash when the processors were never created
    (signal fired before main() initialized them). The fixture leaves
    _trade_processor / _quote_processor at their module defaults."""
    import signal as _signal

    # Ensure the globals are None (a prior test may have set them).
    main._trade_processor = None
    main._quote_processor = None

    with pytest.raises(SystemExit):
        main.shutdown(_signal.SIGTERM, None)

    shutdown_fixtures["drain_pool"].assert_called_once()


def test_shutdown_is_idempotent(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """A second SIGTERM must early-return without re-running cleanup —
    Railway can fire SIGTERM repeatedly if the container is slow to die."""
    import signal as _signal

    # First call sets _shutting_down=True and exits.
    with pytest.raises(SystemExit):
        main.shutdown(_signal.SIGTERM, None)

    shutdown_fixtures["drain_pool"].reset_mock()
    shutdown_fixtures["sys_exit"].reset_mock()
    shutdown_fixtures["theta_fetcher_stop"].reset_mock()

    # Second call: _shutting_down is already True, so the function
    # must return immediately without re-running any cleanup.
    main.shutdown(_signal.SIGTERM, None)

    shutdown_fixtures["drain_pool"].assert_not_called()
    shutdown_fixtures["sys_exit"].assert_not_called()
    shutdown_fixtures["theta_fetcher_stop"].assert_not_called()


# ---------------------------------------------------------------------------
# connect_with_retry() — exponential backoff loop (lines 169-207)
# ---------------------------------------------------------------------------


def test_connect_with_retry_exits_when_shutting_down_after_clean_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clean block_for_close() during shutdown must break the loop
    immediately without sleeping or retrying."""
    monkeypatch.setattr(main, "_shutting_down", False)
    sleep_mock = MagicMock()
    monkeypatch.setattr(main.time, "sleep", sleep_mock)

    client = MagicMock()

    # Flip _shutting_down=True after block_for_close so the loop sees it
    # on the post-block check at line 184.
    def _block() -> None:
        main._shutting_down = True

    client.block_for_close.side_effect = _block

    main.connect_with_retry(client)

    client.start.assert_called_once()
    client.block_for_close.assert_called_once()
    sleep_mock.assert_not_called()

    # Reset so other tests aren't polluted.
    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_reconnects_after_clean_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When block_for_close returns cleanly with no shutdown signal,
    the loop must call client.stop(), reset backoff, and attempt to
    reconnect after a sleep."""
    monkeypatch.setattr(main, "_shutting_down", False)
    sleep_calls: list[float] = []

    def _fake_sleep(s: float) -> None:
        sleep_calls.append(s)
        # Stop the loop before the second iteration's start() call.
        main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    client = MagicMock()
    client.block_for_close.return_value = None

    main.connect_with_retry(client)

    client.start.assert_called_once()
    client.block_for_close.assert_called_once()
    client.stop.assert_called_once()
    # Backoff reset to 1.0 means first sleep is 1.0s.
    assert sleep_calls == [1.0]

    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_escalates_backoff_on_flapping_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two near-instant clean returns (a flapping session) must NOT reset
    backoff to 1.0 each time — the second reconnect sleep must escalate.

    Pre-fix: backoff was unconditionally reset to 1.0 after every clean
    block_for_close(), so an instant flap reconnected at ~1s forever.
    Post-fix: a session shorter than MIN_HEALTHY_SESSION_S leaves backoff
    escalating via min(backoff*2, max_backoff).
    """
    monkeypatch.setattr(main, "_shutting_down", False)
    # monotonic() is read once before and once after each block_for_close;
    # equal pairs → session_dur == 0 → flap (no reset).
    monkeypatch.setattr(main.time, "monotonic", lambda: 100.0)

    sleep_calls: list[float] = []

    def _fake_sleep(s: float) -> None:
        sleep_calls.append(s)
        if len(sleep_calls) >= 2:
            main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    client = MagicMock()
    client.block_for_close.return_value = None  # always a clean instant return

    main.connect_with_retry(client)

    # First sleep at 1.0 (initial backoff), second escalated to 2.0
    # because the flapping session did not reset it.
    assert sleep_calls == [1.0, 2.0]

    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_resets_backoff_on_healthy_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A session lasting >= MIN_HEALTHY_SESSION_S resets backoff to 1.0."""
    monkeypatch.setattr(main, "_shutting_down", False)

    # First session: long (healthy) → reset. Provide a monotonic sequence
    # where the post-block read is +120s from the pre-block read.
    times = iter([0.0, 120.0, 200.0, 200.0])
    monkeypatch.setattr(main.time, "monotonic", lambda: next(times))

    sleep_calls: list[float] = []

    def _fake_sleep(s: float) -> None:
        sleep_calls.append(s)
        main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    client = MagicMock()
    client.block_for_close.return_value = None

    main.connect_with_retry(client)

    # Healthy session keeps backoff at 1.0 for the (single) reconnect sleep.
    assert sleep_calls == [1.0]

    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_handles_exception_and_backs_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A raised exception must be sentry-captured, the client cleaned
    up, and the loop must sleep and retry."""
    monkeypatch.setattr(main, "_shutting_down", False)
    capture_mock = MagicMock()
    monkeypatch.setattr(main, "capture_exception", capture_mock)
    sleep_calls: list[float] = []

    def _fake_sleep(s: float) -> None:
        sleep_calls.append(s)
        main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    boom = RuntimeError("databento went pop")
    client = MagicMock()
    client.start.side_effect = boom

    main.connect_with_retry(client)

    capture_mock.assert_called_once()
    args, kwargs = capture_mock.call_args
    assert args[0] is boom
    assert kwargs["context"] == {"backoff_s": 1.0}
    client.stop.assert_called_once()
    assert sleep_calls == [1.0]

    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_swallows_stop_failure_after_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If client.stop() itself raises during error cleanup, the loop
    must NOT propagate — it'll just retry on the next iteration."""
    monkeypatch.setattr(main, "_shutting_down", False)
    monkeypatch.setattr(main, "capture_exception", MagicMock())

    def _fake_sleep(_s: float) -> None:
        main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    client = MagicMock()
    client.start.side_effect = RuntimeError("boom")
    client.stop.side_effect = RuntimeError("stop also failed")

    # Must not raise — the bare except inside connect_with_retry
    # swallows stop() failures during the error path.
    main.connect_with_retry(client)

    monkeypatch.setattr(main, "_shutting_down", False)


def test_connect_with_retry_breaks_on_keyboard_interrupt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """KeyboardInterrupt is caught explicitly and breaks the loop
    without invoking capture_exception or sleeping."""
    monkeypatch.setattr(main, "_shutting_down", False)
    capture_mock = MagicMock()
    monkeypatch.setattr(main, "capture_exception", capture_mock)
    sleep_mock = MagicMock()
    monkeypatch.setattr(main.time, "sleep", sleep_mock)

    client = MagicMock()
    client.start.side_effect = KeyboardInterrupt()

    main.connect_with_retry(client)

    capture_mock.assert_not_called()
    sleep_mock.assert_not_called()


def test_connect_with_retry_skips_loop_when_already_shutting_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If _shutting_down is True before the loop even starts,
    connect_with_retry must not call client.start() at all."""
    monkeypatch.setattr(main, "_shutting_down", True)
    sleep_mock = MagicMock()
    monkeypatch.setattr(main.time, "sleep", sleep_mock)

    client = MagicMock()

    main.connect_with_retry(client)

    client.start.assert_not_called()
    sleep_mock.assert_not_called()

    monkeypatch.setattr(main, "_shutting_down", False)


# ---------------------------------------------------------------------------
# Signal handler registration & __main__ guard
# ---------------------------------------------------------------------------


def test_main_registers_signal_handlers(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """main() must register shutdown for SIGTERM AND SIGINT before
    entering the connect loop, so Railway scaledown / Ctrl-C both
    trigger graceful drain."""
    monkeypatch.setenv("DATABENTO_API_KEY", "test-key")
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    signal_mock = MagicMock()
    monkeypatch.setattr(main.signal, "signal", signal_mock)

    main.main()

    import signal as _signal

    registered_signals = {call.args[0] for call in signal_mock.call_args_list}
    assert _signal.SIGTERM in registered_signals
    assert _signal.SIGINT in registered_signals
    # Both handlers must be the same shutdown function.
    for call in signal_mock.call_args_list:
        assert call.args[1] is main.shutdown


def test_module_has_main_guard() -> None:
    """The `if __name__ == '__main__': main()` guard must exist so
    Railway's `python main.py` boot actually starts the relay.

    We can't import-as-main without re-running the whole module
    (including the side-effecting subsystem imports), so we assert on
    the source bytes instead. Cheap, deterministic, and catches the
    one regression we care about: someone deletes the guard.
    """
    import inspect

    source = inspect.getsource(main)
    assert 'if __name__ == "__main__":' in source
    # The guard's body must call main() — not some other entry point.
    assert "main()" in source.split('if __name__ == "__main__":')[1]
