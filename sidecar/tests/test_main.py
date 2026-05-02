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
    monkeypatch.setattr(
        main.theta_launcher, "start", mocks["theta_launcher_start"]
    )
    monkeypatch.setattr(
        main.theta_fetcher,
        "start_scheduler",
        mocks["theta_fetcher_start_scheduler"],
    )
    monkeypatch.setattr(main, "verify_connection", mocks["verify_connection"])
    monkeypatch.setattr(main, "TradeProcessor", mocks["trade_processor_cls"])
    monkeypatch.setattr(main, "QuoteProcessor", mocks["quote_processor_cls"])
    monkeypatch.setattr(main, "DatabentoClient", mocks["databento_client_cls"])
    monkeypatch.setattr(
        main, "start_health_server", mocks["start_health_server"]
    )
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
