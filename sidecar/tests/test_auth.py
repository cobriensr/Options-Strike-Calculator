"""Tests for auth — the shared-secret comparisons behind the sidecar's routes.

`hmac.compare_digest` raises TypeError for a str with non-ASCII characters,
and `http.server` decodes header bytes as latin-1, so any client can put a
non-ASCII str in front of the comparison. The helpers compare bytes instead.
"""

from __future__ import annotations

import sys
import threading
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

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
    """The failed-check ERROR is throttled per surface for 10 minutes; start
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


class TestReportMismatch:
    def test_the_surfaces_are_the_three_checks_that_serve_traffic(self) -> None:
        assert auth.SURFACES == ("archive", "takeit-explain", "seed")

    def test_no_surface_has_logged_an_error_when_the_module_loads(self) -> None:
        """None, not 0: `time.monotonic()` can read under 600 s after boot, and
        a zero would then hide the first ERROR."""
        assert _INITIAL_THROTTLE == {
            "archive": None,
            "takeit-explain": None,
            "seed": None,
        }

    def test_every_call_logs_a_warning_with_the_surface_and_the_client(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        for _ in range(3):
            auth.report_mismatch("archive", "203.0.113.7")
        warnings = [
            r.getMessage()
            for r in caplog.records
            if r.name == "sidecar" and r.levelname == "WARNING"
        ]
        assert len(warnings) == 3
        for line in warnings:
            assert "archive" in line
            assert "203.0.113.7" in line

    def test_the_first_call_for_a_surface_logs_one_error(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("takeit-explain", "203.0.113.7")
        errors = _errors(caplog)
        assert len(errors) == 1
        assert "takeit-explain" in errors[0]
        assert "203.0.113.7" in errors[0]

    def test_the_error_names_its_surface_in_the_template_not_a_parameter(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Sentry groups a logged event by its unformatted message, so a
        surface passed as a %s parameter would put all three in one issue."""
        auth.report_mismatch("seed", "203.0.113.7")
        auth.report_mismatch("archive", "203.0.113.7")
        templates = [r.msg for r in caplog.records if r.levelname == "ERROR"]
        assert len(set(templates)) == 2

    def test_a_second_call_inside_ten_minutes_logs_no_error(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7")
        clock.now += 599.0
        auth.report_mismatch("archive", "203.0.113.8")
        assert _levels(caplog) == ["WARNING", "ERROR", "WARNING"]

    def test_the_error_returns_when_ten_minutes_have_passed(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        auth.report_mismatch("archive", "203.0.113.7")
        clock.now += 600.0
        auth.report_mismatch("archive", "203.0.113.7")
        assert _levels(caplog) == ["WARNING", "ERROR", "WARNING", "ERROR"]

        # The window restarts from the second error, not the first.
        clock.now += 599.0
        auth.report_mismatch("archive", "203.0.113.7")
        assert _levels(caplog)[-1] == "WARNING"

    def test_each_surface_has_its_own_window(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        for surface in auth.SURFACES:
            auth.report_mismatch(surface, "203.0.113.7")
        errors = _errors(caplog)
        assert len(errors) == 3
        for surface in auth.SURFACES:
            assert sum(surface in line for line in errors) == 1

    def test_a_clock_that_starts_low_does_not_hide_the_first_error(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """`time.monotonic()` counts from an arbitrary start, often boot."""
        clock.now = 5.0
        auth.report_mismatch("archive", "203.0.113.7")
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
            auth.report_mismatch("archive", "203.0.113.7")
        auth.report_mismatch("archive", "203.0.113.7")

        assert error.call_count == 1

    def test_an_unknown_surface_warns_and_adds_no_throttle_key(
        self, clock: _Clock, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The throttle dict holds only the fixed surfaces, so nothing derived
        from a request can grow it."""
        keys_before = set(auth._last_error_at)
        auth.report_mismatch("not-a-surface", "203.0.113.7")
        auth.report_mismatch("x" * 10_000, "203.0.113.7")
        assert _levels(caplog) == ["WARNING", "WARNING"]
        assert set(auth._last_error_at) == keys_before == set(auth.SURFACES)

    def test_two_requests_that_both_find_no_error_log_one(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The first request stalls at the clock, holding what it read. The
        second starts then, and finishes unless the lock holds it back."""
        first_at_clock = threading.Event()
        second_done = threading.Event()

        def stalled_clock() -> float:
            if not first_at_clock.is_set():
                first_at_clock.set()
                second_done.wait(timeout=0.3)
            return 1000.0

        monkeypatch.setattr(
            auth, "time", types.SimpleNamespace(monotonic=stalled_clock)
        )

        def second_request() -> None:
            auth.report_mismatch("archive", "203.0.113.8")
            second_done.set()

        first = threading.Thread(
            target=auth.report_mismatch, args=("archive", "203.0.113.7")
        )
        second = threading.Thread(target=second_request)
        first.start()
        assert first_at_clock.wait(timeout=5)
        second.start()
        first.join()
        second.join()

        assert len(_errors(caplog)) == 1
