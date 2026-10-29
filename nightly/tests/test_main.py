"""Tests for the entrypoint: exit codes, cron check-ins, the watchdog and what it logs.

run_tape, capture_checkin and init_sentry are patched at main's module boundary,
each wrapped in create_autospec of the real function. The sentry_sdk capture and
flush calls are patched on the sentry_sdk module, so nothing reaches Sentry.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import Mock, call, create_autospec

import pytest
import sentry_sdk
from sentry_sdk.crons import capture_checkin

import main
import monitoring
import tape_job
from constants import RUN_DEADLINE_SECONDS
from tape_job import DayOutcome

DAY = date(2026, 10, 28)
SIGNED_URL = "https://storage.googleapis.com/b/o.zip?X-Goog-Signature=abc&X-Goog-Credential=def"
CHECK_IN_ID = "4ae9c77bdd354824943c5f9f5cc1def6"
MONITOR_CONFIG = {
    "schedule": {"type": "crontab", "value": "15 7 * * 2-6"},
    "timezone": "UTC",
    "checkin_margin": 30,
    "max_runtime": 330,
}
NIGHTLY_DIR = Path(__file__).resolve().parents[1]


class FakeTimer:
    """Stands in for threading.Timer and records how the watchdog was set up."""

    instances: ClassVar[list[FakeTimer]] = []

    def __init__(self, interval: float, function: Any, args: tuple[Any, ...]) -> None:
        self.interval = interval
        self.function = function
        self.args = args
        self.daemon = False
        self.started = False
        self.cancelled = False
        self.recorder: Mock | None = None
        FakeTimer.instances.append(self)

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True
        if self.recorder is not None:
            self.recorder.watchdog_cancel()


@pytest.fixture
def sentry(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Every Sentry call main can make, recorded in one call order."""
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    recorder = Mock()
    mocks = SimpleNamespace(
        recorder=recorder,
        init=create_autospec(monitoring.init_sentry),
        checkin=create_autospec(capture_checkin, return_value=CHECK_IN_ID),
        capture_exception=create_autospec(sentry_sdk.capture_exception),
        capture_message=create_autospec(sentry_sdk.capture_message),
        flush=create_autospec(sentry_sdk.flush),
    )
    for name in ("init", "checkin", "capture_exception", "capture_message", "flush"):
        recorder.attach_mock(getattr(mocks, name), name)
    monkeypatch.setattr(main, "init_sentry", mocks.init)
    monkeypatch.setattr(main, "capture_checkin", mocks.checkin)
    monkeypatch.setattr(sentry_sdk, "capture_exception", mocks.capture_exception)
    monkeypatch.setattr(sentry_sdk, "capture_message", mocks.capture_message)
    monkeypatch.setattr(sentry_sdk, "flush", mocks.flush)
    FakeTimer.instances = []
    monkeypatch.setattr(threading, "Timer", FakeTimer)
    return mocks


@pytest.fixture(autouse=True)
def _restore_http_loggers() -> Iterator[None]:
    levels = {name: logging.getLogger(name).level for name in ("httpx", "httpcore")}
    yield
    for name, level in levels.items():
        logging.getLogger(name).setLevel(level)


def _run_tape(monkeypatch: pytest.MonkeyPatch, **kwargs: Any) -> Mock:
    mock = create_autospec(tape_job.run_tape, **kwargs)
    monkeypatch.setattr(main, "run_tape", mock)
    return mock


def _final_checkin(sentry: SimpleNamespace) -> Any:
    first, final = sentry.checkin.call_args_list
    assert first == call(
        monitor_slug="nightly-tape", status="in_progress", monitor_config=MONITOR_CONFIG
    )
    assert final.kwargs["monitor_slug"] == "nightly-tape"
    assert final.kwargs["check_in_id"] == CHECK_IN_ID
    assert final.kwargs["duration"] >= 0
    return final.kwargs["status"]


def _assert_flushed_last(sentry: SimpleNamespace) -> None:
    assert sentry.recorder.mock_calls[-1] == call.flush(10)


def _all_output(caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]) -> str:
    captured = capsys.readouterr()
    return caplog.text + captured.out + captured.err


# --- exit codes and check-ins ---------------------------------------------------


@pytest.mark.parametrize(
    "outcomes",
    [
        [DayOutcome(DAY, "landed", rows=10, bytes=100)],
        [
            DayOutcome(DAY, "landed", rows=10, bytes=100),
            DayOutcome(date(2026, 10, 27), "relanded", rows=9, bytes=90),
            DayOutcome(date(2026, 5, 29), "unavailable", "outside_window"),
        ],
        [],
    ],
    ids=["landed", "landed-relanded-unavailable", "nothing-planned"],
)
def test_all_landed_exits_0_and_checks_in_ok(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace, outcomes: list[DayOutcome]
) -> None:
    run_tape = _run_tape(monkeypatch, return_value=outcomes)

    assert main.main() == 0

    (settings, now_utc), _ = run_tape.call_args
    sentry.init.assert_called_once_with(settings.sentry_dsn)
    assert now_utc.tzinfo is not None
    assert _final_checkin(sentry) == "ok"
    _assert_flushed_last(sentry)


def test_failed_day_exits_1_and_checks_in_error(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace
) -> None:
    _run_tape(
        monkeypatch,
        return_value=[
            DayOutcome(DAY, "landed", rows=10, bytes=100),
            DayOutcome(date(2026, 10, 27), "failed", "transient"),
        ],
    )

    assert main.main() == 1

    assert _final_checkin(sentry) == "error"
    sentry.capture_message.assert_called_once()
    assert sentry.capture_message.call_args.kwargs["level"] == "error"
    assert sentry.capture_message.call_args.kwargs["tags"] == {
        "day": "2026-10-27",
        "status": "failed",
    }
    _assert_flushed_last(sentry)


def test_not_posted_exits_1(monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace) -> None:
    _run_tape(monkeypatch, return_value=[DayOutcome(DAY, "not_posted", "not_posted")])

    assert main.main() == 1

    assert _final_checkin(sentry) == "error"
    assert sentry.capture_message.call_args.kwargs["level"] == "warning"
    _assert_flushed_last(sentry)


@pytest.mark.parametrize("status", ["skipped_disk", "skipped_deadline"])
def test_skipped_day_exits_1(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace, status: str
) -> None:
    _run_tape(
        monkeypatch,
        return_value=[
            DayOutcome(DAY, "landed", rows=10, bytes=100),
            DayOutcome(date(2026, 10, 27), status, "run deadline passed"),  # type: ignore[arg-type]
        ],
    )

    assert main.main() == 1

    assert _final_checkin(sentry) == "error"


def test_every_day_is_reported(monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace) -> None:
    _run_tape(
        monkeypatch,
        return_value=[
            DayOutcome(DAY, "landed", rows=10, bytes=100),
            DayOutcome(date(2026, 10, 27), "landed", rows=5, bytes=50, warnings=("rows low",)),
            DayOutcome(date(2026, 10, 26), "failed", "transient"),
            DayOutcome(date(2026, 10, 23), "not_posted", "not_posted"),
        ],
    )

    main.main()

    tagged = [c.kwargs["tags"] for c in sentry.capture_message.call_args_list]
    assert tagged == [
        {"day": "2026-10-27", "status": "landed"},
        {"day": "2026-10-26", "status": "failed"},
        {"day": "2026-10-23", "status": "not_posted"},
    ]


def test_run_tape_raising_exits_1_and_checks_in_error(
    monkeypatch: pytest.MonkeyPatch,
    sentry: SimpleNamespace,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = OSError(f"listing failed SECRET-EXC-TEXT {SIGNED_URL}")
    _run_tape(monkeypatch, side_effect=error)

    with caplog.at_level(logging.INFO):
        assert main.main() == 1

    sentry.capture_exception.assert_called_once_with(error)
    assert _final_checkin(sentry) == "error"
    _assert_flushed_last(sentry)
    output = _all_output(caplog, capsys)
    assert "OSError" in output
    assert "SECRET-EXC-TEXT" not in output
    assert "X-Goog" not in output
    assert FakeTimer.instances[0].cancelled


# --- watchdog --------------------------------------------------------------------


def test_watchdog_is_a_daemon_timer_cancelled_before_the_final_checkin(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace
) -> None:
    started: list[bool] = []

    def run(settings: Any, now_utc: datetime) -> list[DayOutcome]:
        (timer,) = FakeTimer.instances
        timer.recorder = sentry.recorder
        started.append(timer.started)
        return [DayOutcome(DAY, "landed", rows=10, bytes=100)]

    _run_tape(monkeypatch, side_effect=run)

    assert main.main() == 0

    (timer,) = FakeTimer.instances
    assert timer.interval == RUN_DEADLINE_SECONDS + 900
    assert timer.function is os._exit
    assert timer.args == (3,)
    assert timer.daemon is True
    assert started == [True]  # running while the tape job runs
    names = [c[0] for c in sentry.recorder.mock_calls]
    assert names[-3:] == ["watchdog_cancel", "checkin", "flush"]


# --- config ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env", "fields"),
    [
        ({"UW_API_KEY": None, "R2_SECRET_ACCESS_KEY": "FAKE-SECRET-7f3a"}, ["uw_api_key"]),
        (
            {"UW_API_KEY": None, "R2_ENDPOINT_URL": "http://FAKE-SECRET-7f3a.example"},
            ["uw_api_key", "r2_endpoint_url"],
        ),
    ],
    ids=["missing", "missing-and-invalid"],
)
def test_bad_config_exits_2_without_secret(
    monkeypatch: pytest.MonkeyPatch,
    sentry: SimpleNamespace,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    env: dict[str, str | None],
    fields: list[str],
) -> None:
    run_tape = _run_tape(monkeypatch, return_value=[])
    for name, value in env.items():
        if value is None:
            monkeypatch.delenv(name)
        else:
            monkeypatch.setenv(name, value)

    with caplog.at_level(logging.INFO):
        assert main.main() == 2

    output = _all_output(caplog, capsys)
    for field in fields:
        assert field in output
    for secret in ("FAKE-SECRET-7f3a", "test-access-key-id", "test-secret-access-key"):
        assert secret not in output
    assert "input_value" not in output
    run_tape.assert_not_called()
    sentry.init.assert_not_called()
    sentry.checkin.assert_not_called()


def test_module_entrypoint_exits_2_on_bad_config() -> None:
    # The real process: basicConfig's handler, and sys.exit(main()) under `python -m`.
    env = {k: v for k, v in os.environ.items() if k not in ("UW_API_KEY", "SENTRY_DSN")}
    env["R2_ENDPOINT_URL"] = "http://FAKE-SECRET-7f3a.example"
    env["PYTHONPATH"] = str(NIGHTLY_DIR / "src")

    result = subprocess.run(
        [sys.executable, "-m", "main"],
        cwd=NIGHTLY_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 2
    assert "uw_api_key" in result.stderr
    assert "r2_endpoint_url" in result.stderr
    assert "FAKE-SECRET-7f3a" not in result.stdout + result.stderr
    assert "test-secret-access-key" not in result.stdout + result.stderr


# --- logging ---------------------------------------------------------------------


def test_summary_line_counts_bytes_and_duration(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    _run_tape(
        monkeypatch,
        return_value=[
            DayOutcome(DAY, "landed", rows=10, bytes=1000),
            DayOutcome(date(2026, 10, 27), "landed", rows=10, bytes=400),
            DayOutcome(date(2026, 10, 26), "relanded", rows=9, bytes=100),
            DayOutcome(date(2026, 10, 23), "failed", "transient"),
        ],
    )

    with caplog.at_level(logging.INFO, logger="main"):
        main.main()

    (summary,) = [r.getMessage() for r in caplog.records if "summary" in r.getMessage()]
    assert "landed=2 relanded=1 failed=1" in summary
    assert "bytes=1500" in summary
    assert "duration=" in summary


def test_http_request_logs_are_quieted(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace, caplog: pytest.LogCaptureFixture
) -> None:
    def run(settings: Any, now_utc: datetime) -> list[DayOutcome]:
        # What httpx logs for every request and redirect hop, signed URL and all.
        logging.getLogger("httpx").info('HTTP Request: GET %s "HTTP/1.1 200 OK"', SIGNED_URL)
        logging.getLogger("httpcore.http11").info("send_request_headers.started")
        return [DayOutcome(DAY, "landed", rows=10, bytes=100)]

    _run_tape(monkeypatch, side_effect=run)

    with caplog.at_level(logging.INFO):
        assert main.main() == 0

    assert logging.getLogger("httpx").level == logging.WARNING
    assert logging.getLogger("httpcore").level == logging.WARNING
    assert "X-Goog" not in caplog.text
    assert "send_request_headers" not in caplog.text


@pytest.mark.parametrize("raises", [False, True])
def test_table_expiry_warning_is_sent(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace, raises: bool
) -> None:
    text = "NYSE holiday table ends in 2028; add 2029 before the new year."
    expiry = create_autospec(main.table_expiry_warning, return_value=text)
    monkeypatch.setattr(main, "table_expiry_warning", expiry)
    if raises:
        _run_tape(monkeypatch, side_effect=OSError("boom"))
    else:
        _run_tape(monkeypatch, return_value=[DayOutcome(DAY, "landed", rows=10, bytes=100)])

    main.main()

    (today,), _ = expiry.call_args
    assert isinstance(today, date)
    sentry.capture_message.assert_called_once_with(text, level="warning")


def test_no_expiry_warning_before_the_table_ends(
    monkeypatch: pytest.MonkeyPatch, sentry: SimpleNamespace
) -> None:
    expiry = create_autospec(main.table_expiry_warning, return_value=None)
    monkeypatch.setattr(main, "table_expiry_warning", expiry)
    _run_tape(monkeypatch, return_value=[DayOutcome(DAY, "landed", rows=10, bytes=100)])

    assert main.main() == 0

    expiry.assert_called_once()
    sentry.capture_message.assert_not_called()
