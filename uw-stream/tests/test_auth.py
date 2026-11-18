"""Tests for ``auth``: the short-token check at boot and the report of a failed /metrics check.

Neither one may log or send a token, a presented credential or the length of either, and
the short-token check must never stop the service from booting.
"""

from __future__ import annotations

import logging
import types
from unittest.mock import MagicMock

import pytest

import auth
import sentry_setup
from config import Settings, settings

TOKEN_ENV = "INTERNAL_METRICS_TOKEN"
CLIENT = "203.0.113.7"
FAILED_CHECK = "Secret check failed on metrics (client %s)"
SHORT_SECRET = "Configured secret shorter than the minimum: %s"

# What the module held at import, before any test reported a failed check.
_INITIAL_LAST_ERROR_AT = auth._last_error_at


@pytest.fixture(autouse=True)
def _no_error_reported_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ERROR is throttled for 10 minutes; start every test with none reported, so no
    test depends on the order the others ran in."""
    monkeypatch.setattr(auth, "_last_error_at", None)


class _Clock:
    """The time ``auth`` sees; a test moves it by hand."""

    def __init__(self, now: float) -> None:
        self.now = now

    def monotonic(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock(1000.0)
    monkeypatch.setattr(auth, "time", types.SimpleNamespace(monotonic=fake.monotonic))
    return fake


@pytest.fixture
def reports(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """``auth``'s reporting call, replaced: the tests that read what it was asked to file."""
    mock = MagicMock()
    monkeypatch.setattr(auth, "capture_message", mock)
    return mock


@pytest.fixture
def sdk_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real ``capture_message``, writing its log line and sending nothing."""
    monkeypatch.setattr(sentry_setup, "_sentry_enabled", False)


def _lines(records: list[logging.LogRecord], level: int) -> list[str]:
    return [r.getMessage() for r in records if r.levelno == level]


class TestWeakSecretNames:
    def test_the_minimum_is_32_characters(self) -> None:
        assert auth.MIN_SECRET_LEN == 32

    @pytest.mark.parametrize(
        ("token", "expected"),
        [
            ("", []),
            ("a", [TOKEN_ENV]),
            ("a" * 31, [TOKEN_ENV]),
            ("a" * 32, []),
            ("a" * 33, []),
            ("a" * 64, []),
        ],
        ids=["unset", "one-char", "31", "32", "33", "64"],
    )
    def test_names_the_token_only_when_it_is_set_and_shorter_than_the_minimum(
        self, monkeypatch: pytest.MonkeyPatch, token: str, expected: list[str]
    ) -> None:
        """An unset token is not listed: /metrics says so itself (one warning per process)."""
        monkeypatch.setattr(settings, "internal_metrics_token", token)
        assert auth.weak_secret_names() == expected

    def test_returns_the_name_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The value of a short token must not travel with its name."""
        monkeypatch.setattr(settings, "internal_metrics_token", "short-value")
        assert auth.weak_secret_names() == [TOKEN_ENV]

    def test_settings_boot_with_a_short_metrics_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The check is a report, not a validator: a short token must not stop the
        service from booting (the owner rotates it, then enforcement can follow). It also
        shows INTERNAL_METRICS_TOKEN is the name Settings reads the token from."""
        monkeypatch.setenv(TOKEN_ENV, "short")
        built = Settings(
            _env_file=None,  # type: ignore[call-arg]
            database_url="postgresql://test",
            uw_api_key="test",
            kv_rest_api_url="https://test.upstash.io",
            kv_rest_api_token="test-token",
        )
        assert built.internal_metrics_token == "short"


class TestReportWeakSecrets:
    def test_a_short_token_files_one_error_naming_the_variable(
        self, monkeypatch: pytest.MonkeyPatch, reports: MagicMock
    ) -> None:
        monkeypatch.setattr(settings, "internal_metrics_token", "short-value")

        auth.report_weak_secrets()

        reports.assert_called_once()
        args, kwargs = reports.call_args
        assert args == (SHORT_SECRET,)
        assert kwargs["level"] == "error"
        assert kwargs["params"] == (TOKEN_ENV,)

    @pytest.mark.parametrize("token", ["", "a" * 32, "a" * 80], ids=["unset", "32", "80"])
    def test_an_unset_or_long_enough_token_files_nothing(
        self, monkeypatch: pytest.MonkeyPatch, reports: MagicMock, token: str
    ) -> None:
        monkeypatch.setattr(settings, "internal_metrics_token", token)

        auth.report_weak_secrets()

        reports.assert_not_called()

    def test_the_report_carries_no_value_and_no_number(
        self, monkeypatch: pytest.MonkeyPatch, sdk_off: None, service_log_records
    ) -> None:
        """Not the token, not its length, and not the minimum: the line names the variable."""
        token = "weak-metrics-token-value"
        monkeypatch.setattr(settings, "internal_metrics_token", token)

        auth.report_weak_secrets()

        (line,) = _lines(service_log_records, logging.ERROR)
        assert line == "Configured secret shorter than the minimum: INTERNAL_METRICS_TOKEN"
        assert token not in line
        assert not any(ch.isdigit() for ch in line)


class TestReportMismatch:
    def test_nothing_has_been_reported_when_the_module_loads(self) -> None:
        """None, not 0: ``time.monotonic()`` can read under 600 s after boot, and a zero
        would then hide the first ERROR."""
        assert _INITIAL_LAST_ERROR_AT is None

    def test_every_call_logs_one_warning_with_the_reason_and_the_client(
        self, clock: _Clock, reports: MagicMock, service_log_records
    ) -> None:
        for reason in ("missing", "wrong", "wrong"):
            auth.report_mismatch(CLIENT, reason)  # type: ignore[arg-type]

        warnings = _lines(service_log_records, logging.WARNING)
        assert len(warnings) == 3
        assert "missing" in warnings[0]
        assert "wrong" in warnings[1]
        assert all(CLIENT in line and "/metrics" in line for line in warnings)

    def test_the_first_call_files_one_error_with_the_client_as_an_argument(
        self, clock: _Clock, reports: MagicMock
    ) -> None:
        auth.report_mismatch(CLIENT, "wrong")

        reports.assert_called_once()
        args, kwargs = reports.call_args
        assert args == (FAILED_CHECK,)
        assert kwargs["level"] == "error"
        assert kwargs["params"] == (CLIENT,)
        assert kwargs["context"] == {"reason": "wrong"}

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_the_reason_is_a_tag_beside_the_component_and_kind(
        self, clock: _Clock, reports: MagicMock, reason: str
    ) -> None:
        auth.report_mismatch(CLIENT, reason)  # type: ignore[arg-type]

        assert reports.call_args.kwargs["tags"] == {
            "component": "auth",
            "kind": "secret_check_failed",
            "reason": reason,
        }

    def test_request_derived_text_never_enters_the_template(
        self, clock: _Clock, sdk_off: None, service_log_records
    ) -> None:
        """Sentry groups the event by its template, so the client string is an argument.
        A client that sends template syntax gets it logged as it is, not formatted."""
        template_text = "%s %d %(x)s {0}\nERROR second line"
        auth.report_mismatch(template_text, "wrong")

        (line,) = _lines(service_log_records, logging.ERROR)
        assert template_text in line
        assert line.startswith("Secret check failed on metrics (client ")

    def test_a_second_call_inside_ten_minutes_files_no_error(
        self, clock: _Clock, reports: MagicMock, service_log_records
    ) -> None:
        auth.report_mismatch(CLIENT, "wrong")
        clock.now += 599.0
        auth.report_mismatch("203.0.113.8", "wrong")

        assert reports.call_count == 1
        assert len(_lines(service_log_records, logging.WARNING)) == 2

    def test_the_error_returns_when_ten_minutes_have_passed(
        self, clock: _Clock, reports: MagicMock
    ) -> None:
        auth.report_mismatch(CLIENT, "wrong")
        clock.now += 600.0
        auth.report_mismatch(CLIENT, "wrong")
        assert reports.call_count == 2

        # The window restarts from the second error, not the first.
        clock.now += 599.0
        auth.report_mismatch(CLIENT, "wrong")
        assert reports.call_count == 2

    def test_a_clock_that_starts_low_does_not_hide_the_first_error(
        self, clock: _Clock, reports: MagicMock
    ) -> None:
        """``time.monotonic()`` counts from an arbitrary start, often boot."""
        clock.now = 5.0
        auth.report_mismatch(CLIENT, "wrong")
        assert reports.call_count == 1

    def test_the_time_is_recorded_before_the_error_is_filed(
        self, clock: _Clock, reports: MagicMock
    ) -> None:
        """A reporter that throws costs that one call, not every later one in the window."""
        reports.side_effect = RuntimeError("sink down")

        with pytest.raises(RuntimeError, match="sink down"):
            auth.report_mismatch(CLIENT, "wrong")
        auth.report_mismatch(CLIENT, "wrong")

        assert reports.call_count == 1

    def test_the_state_is_one_number_whatever_the_client_sends(
        self, clock: _Clock, reports: MagicMock
    ) -> None:
        """A single value, so nothing taken from a request can grow it."""
        for i in range(50):
            auth.report_mismatch(f"203.0.113.{i}", "wrong")
        assert isinstance(auth._last_error_at, float)

    def test_the_lines_carry_the_client_and_no_other_number(
        self, clock: _Clock, sdk_off: None, service_log_records
    ) -> None:
        """The report is given the client and the reason only, so a credential can't
        reach it, and no length or minimum is written beside the address."""
        client = "198.51.100.4"
        auth.report_mismatch(client, "wrong")

        lines = _lines(service_log_records, logging.WARNING) + _lines(
            service_log_records, logging.ERROR
        )
        assert len(lines) == 2
        for line in lines:
            assert client in line
            assert not any(ch.isdigit() for ch in line.replace(client, ""))
