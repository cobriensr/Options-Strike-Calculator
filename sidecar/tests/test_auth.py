"""Tests for auth — the shared-secret comparisons behind the sidecar's routes.

`hmac.compare_digest` raises TypeError for a str with non-ASCII characters,
and `http.server` decodes header bytes as latin-1, so any client can put a
non-ASCII str in front of the comparison. The helpers compare bytes instead.
"""

from __future__ import annotations

import sys
import threading
import time
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import sentry_sdk

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import auth

SECRET = "s3cret-value"


class TestBearerOk:
    def test_accepts_the_exact_bearer(self) -> None:
        assert auth.bearer_ok(f"Bearer {SECRET}", SECRET) is True

    @pytest.mark.parametrize(
        "header",
        [
            None,
            "",
            "Bearer",
            "Bearer ",
            f"Bearer {SECRET}x",
            f"Bearer {SECRET[:-1]}",
            f"bearer {SECRET}",
            f"Bearer  {SECRET}",
            f"Bearer {SECRET} ",
            f"Basic {SECRET}",
            SECRET,
        ],
    )
    def test_rejects_anything_but_the_exact_bearer(self, header: str | None) -> None:
        assert auth.bearer_ok(header, SECRET) is False

    @pytest.mark.parametrize("header", [None, "", "Bearer ", "Bearer", "bearer "])
    def test_empty_secret_never_matches(self, header: str | None) -> None:
        """With no secret configured, `Bearer ` must not authenticate."""
        assert auth.bearer_ok(header, "") is False

    @pytest.mark.parametrize(
        "header",
        [
            "Bearer caf\xe9",  # latin-1 range: what http.server yields for 0xE9
            "Bearer \u0105",  # beyond latin-1: cannot come from the wire
            "Bearer \U0001f600",
            "\u0105",
        ],
    )
    def test_non_ascii_header_is_rejected_not_raised(self, header: str) -> None:
        assert auth.bearer_ok(header, SECRET) is False

    def test_non_ascii_secret_matches_the_bytes_the_client_sent(self) -> None:
        """A client sends the secret as UTF-8; http.server hands the handler
        those bytes decoded as latin-1."""
        secret = "s\xe9cret"
        header = f"Bearer {secret}".encode().decode("latin-1")
        assert auth.bearer_ok(header, secret) is True
        assert auth.bearer_ok(f"Bearer {secret}", secret) is False

    def test_compares_with_compare_digest(self) -> None:
        """A plain `==` leaks the secret through timing."""
        with patch("auth.hmac.compare_digest", return_value=True) as digest:
            assert auth.bearer_ok("Bearer anything", SECRET) is True
        digest.assert_called_once_with(b"Bearer anything", f"Bearer {SECRET}".encode())


class TestTokenOk:
    def test_accepts_the_exact_token(self) -> None:
        assert auth.token_ok(SECRET, SECRET) is True

    @pytest.mark.parametrize("header", [None, "", f"{SECRET}x", SECRET[:-1], "nope"])
    def test_rejects_anything_but_the_exact_token(self, header: str | None) -> None:
        assert auth.token_ok(header, SECRET) is False

    @pytest.mark.parametrize("header", [None, ""])
    def test_empty_secret_never_matches(self, header: str | None) -> None:
        assert auth.token_ok(header, "") is False

    @pytest.mark.parametrize("header", ["caf\xe9", "\u0105", "\U0001f600"])
    def test_non_ascii_header_is_rejected_not_raised(self, header: str) -> None:
        assert auth.token_ok(header, SECRET) is False

    def test_compares_with_compare_digest(self) -> None:
        with patch("auth.hmac.compare_digest", return_value=True) as digest:
            assert auth.token_ok("anything", SECRET) is True
        digest.assert_called_once_with(b"anything", SECRET.encode())


class TestSharedSecret:
    def test_reads_the_takeit_secret_from_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(auth.SHARED_SECRET_ENV, "from-env")
        assert auth.shared_secret() == "from-env"

    def test_empty_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(auth.SHARED_SECRET_ENV, raising=False)
        assert auth.shared_secret() == ""

    def test_env_name_is_the_takeit_shared_secret(self) -> None:
        assert auth.SHARED_SECRET_ENV == "TAKEIT_SIDECAR_SHARED_SECRET"


class TestSeedToken:
    def test_reads_the_seed_token_from_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(auth.SEED_TOKEN_ENV, "from-env")
        assert auth.seed_token() == "from-env"

    def test_empty_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(auth.SEED_TOKEN_ENV, raising=False)
        assert auth.seed_token() == ""

    def test_env_name_is_the_archive_seed_token(self) -> None:
        assert auth.SEED_TOKEN_ENV == "ARCHIVE_SEED_TOKEN"


SHARED = auth.SHARED_SECRET_ENV
SEED = auth.SEED_TOKEN_ENV


class TestWeakSecretNames:
    def test_the_minimum_is_32_characters(self) -> None:
        assert auth.MIN_SECRET_LEN == 32

    @pytest.mark.parametrize(
        ("shared", "seed", "expected"),
        [
            (None, None, []),
            ("", "", []),
            ("a" * 31, None, [SHARED]),
            ("a" * 32, None, []),
            ("a" * 33, None, []),
            (None, "a" * 31, [SEED]),
            (None, "a" * 32, []),
            ("x", "y", [SHARED, SEED]),
            ("a" * 31, "a" * 32, [SHARED]),
            ("a" * 32, "a" * 5, [SEED]),
            ("a" * 64, "a" * 40, []),
        ],
        ids=[
            "both-unset",
            "both-empty",
            "shared-31",
            "shared-32",
            "shared-33",
            "seed-31",
            "seed-32",
            "both-short",
            "only-shared-short",
            "only-seed-short",
            "both-long",
        ],
    )
    def test_names_the_secrets_that_are_set_and_shorter_than_the_minimum(
        self,
        monkeypatch: pytest.MonkeyPatch,
        shared: str | None,
        seed: str | None,
        expected: list[str],
    ) -> None:
        for name, value in ((SHARED, shared), (SEED, seed)):
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)
        assert auth.weak_secret_names() == expected

    def test_returns_names_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The value of a short secret must not travel with its name."""
        monkeypatch.setenv(SHARED, "short-value")
        monkeypatch.delenv(SEED, raising=False)
        assert auth.weak_secret_names() == [SHARED]


# What the module held at import, before any test called report_mismatch.
_INITIAL_THROTTLE = dict(auth._last_error_at)


@pytest.fixture(autouse=True)
def _no_error_logged_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    """The failed-check ERROR is throttled per surface and reason for 10 minutes; start
    every test with none logged, so no test depends on the order they ran in."""
    monkeypatch.setattr(auth, "_last_error_at", dict(_INITIAL_THROTTLE))


class _Clock:
    """The time `auth` sees; a test moves it by hand."""

    def __init__(self, now: float) -> None:
        self.now = now

    def monotonic(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock(1000.0)
    monkeypatch.setattr(auth, "time", types.SimpleNamespace(monotonic=fake.monotonic))
    return fake


def _levels(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.levelname for r in caplog.records if r.name == "sidecar"]


def _errors(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "sidecar" and r.levelname == "ERROR"
    ]


class _SpyLock:
    """The throttle lock, which says when the thread named "second" reaches for it."""

    def __init__(self, inner: threading.Lock, second_waiting: threading.Event) -> None:
        self._inner = inner
        self._second_waiting = second_waiting

    def __enter__(self) -> None:
        if threading.current_thread().name == "second":
            self._second_waiting.set()
        self._inner.acquire()

    def __exit__(self, *exc_info: object) -> None:
        self._inner.release()


class TestMismatchReason:
    @pytest.mark.parametrize(
        ("presented", "reason"),
        [
            (None, "missing"),
            ("", "missing"),
            ("Bearer ", "wrong"),
            ("Bearer wrong", "wrong"),
            ("x", "wrong"),
            ("caf\xe9", "wrong"),
        ],
    )
    def test_nothing_presented_is_missing_and_anything_else_is_wrong(
        self, presented: str | None, reason: str
    ) -> None:
        assert auth.mismatch_reason(presented) == reason


class TestReportMismatch:
    def test_the_surfaces_are_the_three_checks_that_serve_traffic(self) -> None:
        assert auth.SURFACES == ("archive", "takeit-explain", "seed")

    def test_the_reasons_are_the_two_a_check_can_fail_for(self) -> None:
        assert auth.REASONS == ("missing", "wrong")

    def test_no_surface_and_reason_has_logged_an_error_when_the_module_loads(
        self,
    ) -> None:
        """None, not 0: `time.monotonic()` can read under 600 s after boot, and
        a zero would then hide the first ERROR. One entry per surface and
        reason, six in all."""
        assert {
            (surface, reason): None
            for surface in ("archive", "takeit-explain", "seed")
            for reason in ("missing", "wrong")
        } == _INITIAL_THROTTLE

    def test_every_call_logs_one_warning_with_the_surface_reason_and_client(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        for _ in range(3):
            auth.report_mismatch("archive", "203.0.113.7", "wrong")
        warnings = [
            r.getMessage()
            for r in caplog.records
            if r.name == "sidecar" and r.levelname == "WARNING"
        ]
        assert (
            warnings
            == ["archive secret check failed (reason wrong, client 203.0.113.7)"] * 3
        )

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_the_warning_says_why_the_check_failed(
        self, reason: str, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("seed", "203.0.113.7", reason)
        (line,) = [
            r.getMessage()
            for r in caplog.records
            if r.name == "sidecar" and r.levelname == "WARNING"
        ]
        assert f"reason {reason}" in line

    def test_the_first_call_for_a_surface_logs_one_error(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("takeit-explain", "203.0.113.7", "wrong")
        errors = _errors(caplog)
        assert len(errors) == 1
        assert "takeit-explain" in errors[0]
        assert "203.0.113.7" in errors[0]

    def test_the_error_names_its_surface_in_the_template_not_a_parameter(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Sentry groups a logged event by its unformatted message, so a
        surface passed as a %s parameter would put all three in one issue."""
        auth.report_mismatch("seed", "203.0.113.7", "wrong")
        auth.report_mismatch("archive", "203.0.113.7", "wrong")
        templates = [r.msg for r in caplog.records if r.levelname == "ERROR"]
        assert len(set(templates)) == 2

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_a_second_call_for_a_reason_inside_ten_minutes_logs_no_error(
        self, reason: str, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7", reason)
        clock.now += 599.0
        auth.report_mismatch("archive", "203.0.113.8", reason)
        assert _levels(caplog) == ["WARNING", "ERROR", "WARNING"]

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_the_error_returns_when_ten_minutes_have_passed(
        self, reason: str, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7", reason)
        clock.now += 600.0
        auth.report_mismatch("archive", "203.0.113.7", reason)
        assert _levels(caplog) == ["WARNING", "ERROR", "WARNING", "ERROR"]

        # The window restarts from the second error, not the first.
        clock.now += 599.0
        auth.report_mismatch("archive", "203.0.113.7", reason)
        assert _levels(caplog)[-1] == "WARNING"

    @pytest.mark.parametrize(
        ("first", "second"), [("missing", "wrong"), ("wrong", "missing")]
    )
    def test_the_other_reason_inside_ten_minutes_logs_its_own_error(
        self,
        first: str,
        second: str,
        clock: _Clock,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A caller that sends nothing must not use up the window a wrong secret
        needs, nor the other way round: the Sentry alert may later be narrowed
        to `reason:wrong`."""
        auth.report_mismatch("archive", "203.0.113.7", first)
        clock.now += 60.0
        auth.report_mismatch("archive", "203.0.113.8", second)
        assert _levels(caplog) == ["WARNING", "ERROR", "WARNING", "ERROR"]

    def test_a_wrong_ten_minutes_after_the_first_wrong_logs_again_whatever_came_between(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7", "wrong")
        clock.now += 599.0
        auth.report_mismatch("archive", "203.0.113.7", "missing")
        clock.now += 1.0
        auth.report_mismatch("archive", "203.0.113.7", "wrong")
        assert _levels(caplog) == [
            "WARNING",
            "ERROR",
            "WARNING",
            "ERROR",
            "WARNING",
            "ERROR",
        ]

    def test_each_reason_has_its_own_window_on_each_surface(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        for surface in auth.SURFACES:
            for reason in auth.REASONS:
                auth.report_mismatch(surface, "203.0.113.7", reason)
        assert len(_errors(caplog)) == 6

    def test_the_state_never_grows_past_one_entry_per_surface_and_reason(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """However many requests come, and whatever they carry: the keys are
        the six fixed pairs, so nothing taken from a request can grow them."""
        pairs = {(s, r) for s in auth.SURFACES for r in auth.REASONS}
        for i in range(300):
            surface = auth.SURFACES[i % 3]
            reason = auth.REASONS[(i // 3) % 2]
            auth.report_mismatch(surface, f"203.0.113.{i % 250}", reason)
            clock.now += 1.0
        assert set(auth._last_error_at) == pairs
        assert len(auth._last_error_at) == 6
        # 300 s of calls inside the 10 minutes: one ERROR for each of the six.
        assert len(_errors(caplog)) == 6

    def test_each_surface_has_its_own_window(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        for surface in auth.SURFACES:
            auth.report_mismatch(surface, "203.0.113.7", "wrong")
        errors = _errors(caplog)
        assert len(errors) == 3
        for surface in auth.SURFACES:
            assert sum(surface in line for line in errors) == 1

    def test_a_clock_that_starts_low_does_not_hide_the_first_error(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """`time.monotonic()` counts from an arbitrary start, often boot."""
        clock.now = 5.0
        auth.report_mismatch("archive", "203.0.113.7", "wrong")
        assert len(_errors(caplog)) == 1

    def test_the_time_is_recorded_before_the_error_is_logged(
        self,
        clock: _Clock,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A log sink that throws costs one call, not every later one."""
        error = MagicMock(side_effect=RuntimeError("sink down"))
        monkeypatch.setattr(auth.log, "error", error)

        with pytest.raises(RuntimeError, match="sink down"):
            auth.report_mismatch("archive", "203.0.113.7", "wrong")
        auth.report_mismatch("archive", "203.0.113.7", "wrong")

        assert error.call_count == 1

    def test_an_unknown_surface_warns_and_adds_no_throttle_key(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The throttle dict holds only the fixed surface and reason pairs, so
        nothing derived from a request can grow it."""
        keys_before = set(auth._last_error_at)
        auth.report_mismatch("not-a-surface", "203.0.113.7", "wrong")
        auth.report_mismatch("x" * 10_000, "203.0.113.7", "wrong")
        auth.report_mismatch("archive", "203.0.113.7", "not-a-reason")
        assert _levels(caplog) == ["WARNING", "WARNING", "WARNING"]
        assert (
            set(auth._last_error_at)
            == keys_before
            == {(s, r) for s in auth.SURFACES for r in auth.REASONS}
        )

    def test_two_requests_that_both_find_no_error_log_one(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The first request stalls at the clock, holding what it read, until
        the second one has either reached for the lock or finished.

        With the lock the second can only wait for the first, and then finds
        the first's record. Without it the second runs to the end while the
        first is still stalled, and the first goes on to log a second error. The
        first waits on what the second does, not for a set time, so the outcome
        does not depend on how fast the second thread starts.
        """
        first_at_clock = threading.Event()
        second_waiting = threading.Event()
        second_done = threading.Event()

        def stalled_clock() -> float:
            if not first_at_clock.is_set():
                first_at_clock.set()
                deadline = time.monotonic() + 5
                while not (second_waiting.is_set() or second_done.is_set()):
                    if time.monotonic() > deadline:
                        break
                    time.sleep(0.001)
            return 1000.0

        monkeypatch.setattr(
            auth, "time", types.SimpleNamespace(monotonic=stalled_clock)
        )
        monkeypatch.setattr(
            auth, "_throttle_lock", _SpyLock(auth._throttle_lock, second_waiting)
        )

        def second_request() -> None:
            auth.report_mismatch("archive", "203.0.113.8", "wrong")
            second_done.set()

        first = threading.Thread(
            target=auth.report_mismatch, args=("archive", "203.0.113.7", "wrong")
        )
        second = threading.Thread(target=second_request, name="second")
        first.start()
        assert first_at_clock.wait(timeout=5)
        second.start()
        first.join()
        second.join()

        assert len(_errors(caplog)) == 1


_FAILED_CHECK = "Secret check failed on archive (client %s)"


class TestReasonTag:
    """The event a failed check files, read from a real client's wire bytes.

    The ERROR becomes an event through the SDK's logging integration, so these
    go through `init_sentry`'s own options and an in-memory transport rather
    than a mock of the SDK. The reason is a tag, which is the key and the two
    values the other two services use.
    """

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_the_event_carries_the_reason_as_a_tag(
        self, reason: str, sentry_events: Callable[..., Any]
    ) -> None:
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", reason)

        (event,) = transport.events()
        assert event["tags"]["reason"] == reason

    def test_the_message_and_grouping_are_the_ones_the_alert_rule_matches(
        self, sentry_events: Callable[..., Any]
    ) -> None:
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", "wrong")

        (event,) = transport.events()
        assert event["level"] == "error"
        assert event["logentry"]["message"] == _FAILED_CHECK
        assert event["logentry"]["params"] == ["203.0.113.7"]

    def test_the_tag_does_not_outlive_the_report(
        self, sentry_events: Callable[..., Any]
    ) -> None:
        """A later, unrelated event on the same thread must not inherit it."""
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", "wrong")
        sentry_sdk.capture_message("an unrelated event", level="error")

        _reported, unrelated = transport.events()
        assert unrelated["message"] == "an unrelated event"
        assert "reason" not in unrelated.get("tags", {})

    def test_each_report_carries_its_own_reason(
        self, sentry_events: Callable[..., Any]
    ) -> None:
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", "missing")
        auth.report_mismatch("seed", "203.0.113.7", "wrong")

        reasons = {
            e["logentry"]["message"]: e["tags"]["reason"] for e in transport.events()
        }
        assert reasons == {
            "Secret check failed on archive (client %s)": "missing",
            "Secret check failed on seed (client %s)": "wrong",
        }

    @pytest.mark.parametrize("reason", ["missing", "wrong"])
    def test_a_second_report_for_the_same_reason_files_no_event(
        self, reason: str, sentry_events: Callable[..., Any]
    ) -> None:
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", reason)
        auth.report_mismatch("archive", "198.51.100.4", reason)

        (event,) = transport.events()
        assert event["tags"]["reason"] == reason
        assert event["logentry"]["params"] == ["203.0.113.7"]

    @pytest.mark.parametrize(
        ("first", "second"), [("missing", "wrong"), ("wrong", "missing")]
    )
    def test_the_other_reason_files_its_own_event_tagged_in_order(
        self, first: str, second: str, sentry_events: Callable[..., Any]
    ) -> None:
        """A report with nothing sent must not use up the window a wrong
        secret needs."""
        transport = sentry_events()

        auth.report_mismatch("archive", "203.0.113.7", first)
        auth.report_mismatch("archive", "198.51.100.4", second)

        events = transport.events()
        assert [e["tags"]["reason"] for e in events] == [first, second]
        assert {e["logentry"]["message"] for e in events} == {_FAILED_CHECK}

    def test_with_sentry_off_a_report_still_logs_and_raises_nothing(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7", "missing")

        assert _levels(caplog) == ["WARNING", "ERROR"]
