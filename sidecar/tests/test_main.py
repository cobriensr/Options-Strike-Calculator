"""Tests for sidecar/src/main.py.

Focused on the entry-point's early-exit behavior. The main concern is
that env-var validation runs BEFORE any subsystem launch (Theta
Terminal), so a misconfigured deployment fails fast instead of burning
~60s of Railway compute booting Theta only to die at the first DB call.

Mock strategy:
- conftest.py provides session-wide mocks for `psycopg2` and
  `sentry_sdk` when they aren't in the test venv.
- `Settings()` runs at config.py import time and requires DATABASE_URL
  to construct, so we set it BEFORE importing `main`. The early-exit
  code path then deletes it to exercise the validation branch directly.
- All side-effecting subsystems (theta_launcher, theta_fetcher,
  verify_connection, start_health_server, init_sentry,
  wait_for_shutdown) are monkeypatched so the test doesn't make any I/O
  or block.
"""

from __future__ import annotations

import os
import signal
from unittest.mock import MagicMock

# Required env var for config.py's pydantic-settings validation, which
# runs at import time. The early-exit tests below mutate os.environ
# AFTER import to drive the missing-env code path.
_FAKE_DB_URL = "postgresql://test:" + "fakefixture" + "@localhost/test"
os.environ.setdefault("DATABASE_URL", _FAKE_DB_URL)

import pytest  # noqa: E402

import config  # noqa: E402
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
        "start_health_server": MagicMock(),
        "wait_for_shutdown": MagicMock(),
    }

    monkeypatch.setattr(main, "init_sentry", mocks["init_sentry"])
    monkeypatch.setattr(main.theta_launcher, "start", mocks["theta_launcher_start"])
    monkeypatch.setattr(
        main.theta_fetcher,
        "start_scheduler",
        mocks["theta_fetcher_start_scheduler"],
    )
    monkeypatch.setattr(main, "verify_connection", mocks["verify_connection"])
    monkeypatch.setattr(main, "start_health_server", mocks["start_health_server"])
    monkeypatch.setattr(main, "wait_for_shutdown", mocks["wait_for_shutdown"])
    # Signal registration is process-global; never let a test install
    # the real shutdown handler into the pytest process.
    monkeypatch.setattr(main.signal, "signal", MagicMock())

    return mocks


# ---------------------------------------------------------------------------
# Config — Databento removal
# ---------------------------------------------------------------------------


def test_settings_constructs_without_databento_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Settings() must not require DATABENTO_API_KEY. Databento was
    removed, and a leftover required field would raise a ValidationError
    at config.py import time — taking the whole sidecar (SHAP + archive
    serving) down once the key is deleted from Railway."""
    monkeypatch.delenv("DATABENTO_API_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    settings = config.Settings()

    assert settings.database_url == _FAKE_DB_URL
    assert not hasattr(settings, "databento_api_key")


def test_settings_still_requires_database_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DATABASE_URL remains a hard requirement for Settings()."""
    from pydantic import ValidationError

    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(ValidationError):
        # _env_file=None so a developer's local sidecar/.env can't
        # satisfy the requirement and mask a regression.
        config.Settings(_env_file=None)


# ---------------------------------------------------------------------------
# main() — env validation
# ---------------------------------------------------------------------------


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

    with pytest.raises(SystemExit) as exc_info:
        main.main()

    assert exc_info.value.code == 1
    # Sentry init still runs first by design (so we can report later
    # failures), but no other subsystem may have been touched.
    patched_subsystems["init_sentry"].assert_called_once()
    patched_subsystems["theta_launcher_start"].assert_not_called()
    patched_subsystems["theta_fetcher_start_scheduler"].assert_not_called()
    patched_subsystems["verify_connection"].assert_not_called()
    patched_subsystems["start_health_server"].assert_not_called()
    patched_subsystems["wait_for_shutdown"].assert_not_called()


def test_main_boots_without_databento_api_key(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """DATABENTO_API_KEY is no longer required: with only DATABASE_URL
    set, main() must boot through to the HTTP server rather than
    sys.exit(1) (the pre-removal behavior that would have taken SHAP +
    archive serving down with it)."""
    monkeypatch.delenv("DATABENTO_API_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    main.main()

    patched_subsystems["verify_connection"].assert_called_once()
    patched_subsystems["start_health_server"].assert_called_once()
    patched_subsystems["wait_for_shutdown"].assert_called_once()


def test_main_proceeds_when_required_env_present(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """With DATABASE_URL set, validation passes and Theta is launched.

    This is the happy-path complement to the missing-env test above:
    proves the validation gate doesn't false-positive when env is good.
    """
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    main.main()

    patched_subsystems["init_sentry"].assert_called_once()
    patched_subsystems["theta_launcher_start"].assert_called_once()
    patched_subsystems["verify_connection"].assert_called_once()
    patched_subsystems["start_health_server"].assert_called_once()
    patched_subsystems["wait_for_shutdown"].assert_called_once()


def test_main_propagates_db_verification_failure(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """An unreachable DB at boot must crash main() (so Railway restarts
    the container) instead of starting a server that can't serve."""
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    patched_subsystems["verify_connection"].side_effect = RuntimeError(
        "Database connection verification failed"
    )

    with pytest.raises(RuntimeError, match="verification failed"):
        main.main()

    patched_subsystems["start_health_server"].assert_not_called()
    patched_subsystems["wait_for_shutdown"].assert_not_called()


def test_main_wires_health_server_with_db_and_theta_reporters(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """The health server gets the DB probe + Theta reporters and nothing
    Databento-shaped (no is_connected / last_bar_at)."""
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    main.main()

    kwargs = patched_subsystems["start_health_server"].call_args.kwargs
    assert kwargs["port"] == main.settings.port
    assert kwargs["is_db_healthy"] is main.is_db_healthy
    assert kwargs["theta_is_running"] is main.theta_launcher.is_running
    assert kwargs["theta_last_ready_at"] is main.theta_launcher.last_ready_at
    assert kwargs["theta_last_error"] is main.theta_launcher.last_error
    assert kwargs["seed_is_busy"] is main.archive_seeder.is_seeding
    assert "is_connected" not in kwargs
    assert "last_bar_at" not in kwargs


# ---------------------------------------------------------------------------
# main() — Theta launched branch
# ---------------------------------------------------------------------------


def test_main_starts_theta_scheduler_and_backfill_when_launcher_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """When theta_launcher.start() returns True, main() must start the
    nightly scheduler AND spawn a daemon thread for the backfill."""
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


def test_main_skips_theta_scheduler_when_launcher_fails(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """When Theta doesn't come up (no creds / jar failure), the sidecar
    still boots and serves — only the Theta scheduler is skipped."""
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    patched_subsystems["theta_launcher_start"].return_value = False

    main.main()

    patched_subsystems["theta_fetcher_start_scheduler"].assert_not_called()
    patched_subsystems["start_health_server"].assert_called_once()


# ---------------------------------------------------------------------------
# main() — seed_callable branch
# ---------------------------------------------------------------------------


def test_main_builds_seed_callable_when_archive_env_present(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """When ARCHIVE_MANIFEST_URL + BLOB_READ_WRITE_TOKEN are set, main()
    must define a seed_callable that delegates to archive_seeder and
    pass it to start_health_server."""
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
    health server rejects POST /admin/seed-archive with 401."""
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)
    monkeypatch.delenv("ARCHIVE_MANIFEST_URL", raising=False)
    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)

    main.main()

    kwargs = patched_subsystems["start_health_server"].call_args.kwargs
    assert kwargs["seed_archive"] is None


# ---------------------------------------------------------------------------
# shutdown() — graceful signal handler
# ---------------------------------------------------------------------------


@pytest.fixture()
def shutdown_fixtures(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
    """Patch every side effect inside shutdown(): theta + drain_pool +
    time.sleep + sys.exit. Also reset the module-level _shutting_down
    flag so each test starts from a clean slate."""
    monkeypatch.setattr(main, "_shutting_down", False)

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


def test_shutdown_stops_theta_drains_pool_and_exits(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """shutdown stops the Theta scheduler, kills the jar, drains the DB
    pool, and exits 0."""
    with pytest.raises(SystemExit):
        main.shutdown(signal.SIGTERM, None)

    shutdown_fixtures["theta_fetcher_stop"].assert_called_once()
    shutdown_fixtures["theta_launcher_shutdown"].assert_called_once()
    shutdown_fixtures["drain_pool"].assert_called_once()
    shutdown_fixtures["sys_exit"].assert_called_once_with(0)
    assert main._shutting_down is True


def test_shutdown_stops_theta_before_draining_pool(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """The Theta scheduler + jar must stop BEFORE the pool drains, so a
    nightly job can't borrow a connection from a closed pool."""
    call_order: list[str] = []
    shutdown_fixtures["theta_fetcher_stop"].side_effect = lambda: call_order.append(
        "theta_stop"
    )
    shutdown_fixtures["theta_launcher_shutdown"].side_effect = lambda: (
        call_order.append("theta_shutdown")
    )
    shutdown_fixtures["drain_pool"].side_effect = lambda: call_order.append("drain")

    with pytest.raises(SystemExit):
        main.shutdown(signal.SIGINT, None)

    assert call_order == ["theta_stop", "theta_shutdown", "drain"]


def test_shutdown_is_idempotent(
    shutdown_fixtures: dict[str, MagicMock],
) -> None:
    """A second SIGTERM must early-return without re-running cleanup —
    Railway can fire SIGTERM repeatedly if the container is slow to die."""
    # First call sets _shutting_down=True and exits.
    with pytest.raises(SystemExit):
        main.shutdown(signal.SIGTERM, None)

    shutdown_fixtures["drain_pool"].reset_mock()
    shutdown_fixtures["sys_exit"].reset_mock()
    shutdown_fixtures["theta_fetcher_stop"].reset_mock()

    # Second call: _shutting_down is already True, so the function
    # must return immediately without re-running any cleanup.
    main.shutdown(signal.SIGTERM, None)

    shutdown_fixtures["drain_pool"].assert_not_called()
    shutdown_fixtures["sys_exit"].assert_not_called()
    shutdown_fixtures["theta_fetcher_stop"].assert_not_called()


# ---------------------------------------------------------------------------
# wait_for_shutdown() — keeps the process alive for the daemon HTTP thread
# ---------------------------------------------------------------------------


def test_wait_for_shutdown_returns_immediately_when_already_shutting_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "_shutting_down", True)
    sleep_mock = MagicMock()
    monkeypatch.setattr(main.time, "sleep", sleep_mock)

    main.wait_for_shutdown()

    sleep_mock.assert_not_called()


def test_wait_for_shutdown_blocks_until_flag_flips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The loop keeps sleeping while the process is live and exits once
    shutdown has begun."""
    monkeypatch.setattr(main, "_shutting_down", False)
    sleep_calls: list[float] = []

    def _fake_sleep(s: float) -> None:
        sleep_calls.append(s)
        if len(sleep_calls) >= 3:
            main._shutting_down = True

    monkeypatch.setattr(main.time, "sleep", _fake_sleep)

    main.wait_for_shutdown()

    assert sleep_calls == [1.0, 1.0, 1.0]


def test_wait_for_shutdown_propagates_signal_handler_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """shutdown() ends the process with sys.exit(0) from the signal
    handler, which surfaces as SystemExit out of the sleep. The wait
    must not swallow it."""
    monkeypatch.setattr(main, "_shutting_down", False)
    monkeypatch.setattr(main.time, "sleep", MagicMock(side_effect=SystemExit(0)))

    with pytest.raises(SystemExit) as exc_info:
        main.wait_for_shutdown()

    assert exc_info.value.code == 0


# ---------------------------------------------------------------------------
# Signal handler registration & __main__ guard
# ---------------------------------------------------------------------------


def test_main_registers_signal_handlers_before_waiting(
    monkeypatch: pytest.MonkeyPatch,
    patched_subsystems: dict[str, MagicMock],
) -> None:
    """main() must register shutdown for SIGTERM AND SIGINT before
    parking in wait_for_shutdown, so Railway scaledown / Ctrl-C both
    trigger graceful drain."""
    monkeypatch.setenv("DATABASE_URL", _FAKE_DB_URL)

    call_order: list[str] = []
    signal_mock = MagicMock(side_effect=lambda *_a: call_order.append("signal"))
    monkeypatch.setattr(main.signal, "signal", signal_mock)
    patched_subsystems["wait_for_shutdown"].side_effect = lambda: call_order.append(
        "wait"
    )

    main.main()

    registered_signals = {call.args[0] for call in signal_mock.call_args_list}
    assert signal.SIGTERM in registered_signals
    assert signal.SIGINT in registered_signals
    # Both handlers must be the same shutdown function.
    for call in signal_mock.call_args_list:
        assert call.args[1] is main.shutdown
    assert call_order == ["signal", "signal", "wait"]


def test_module_has_main_guard() -> None:
    """The `if __name__ == '__main__': main()` guard must exist so
    Railway's `python -m src.main` boot actually starts the server.

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
