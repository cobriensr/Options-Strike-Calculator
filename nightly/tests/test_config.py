"""Tests for nightly settings: required vars fail by name, secrets stay out of repr,
and a malformed SENTRY_DSN or DATABASE_URL fails boot without being echoed. The last
section covers resources.py: the direct DSN, the DB connection and the tape reader."""

from __future__ import annotations

import logging
from functools import partial
from pathlib import Path
from unittest.mock import MagicMock

import _pipeline_retry
import psycopg2
import pytest
from pydantic import ValidationError

import resources
from config import _SentryOnly, load_sentry_dsn, load_settings
from constants import DB_CONNECT_TIMEOUT_SECONDS, DB_STATEMENT_TIMEOUT_MS

VALID_DSN = "https://public@o0.ingest.sentry.invalid/1"
MALFORMED_DSNS = [
    "not-a-dsn-7f3a",
    "ftp://public@sentry.invalid/1",
    "https://sentry.invalid/1",
    "https://public@sentry.invalid/project-7f3a",
    "https://public@sentry.invalid:99999/1",
]

REQUIRED = [
    "UW_API_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
    "DATABASE_URL",
]
# The password is the marker a failing test would find echoed.
BAD_SCHEME_DATABASE_URLS = [
    "mysql://user:pw-7f3a@db.invalid/app",
    "https://user:pw-7f3a@db.invalid/app",
    "user:pw-7f3a@db.invalid/app",
    "",
]


def test_loads_with_defaults_and_optional_sentry_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    settings = load_settings()
    assert settings.sentry_dsn is None
    assert settings.r2_bucket_fulltape == "test-bucket"
    assert settings.uw_api_key.get_secret_value() == "test-key"


@pytest.mark.parametrize("name", REQUIRED)
def test_each_missing_required_var_is_named(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.delenv(name)
    with pytest.raises(ValidationError) as exc:
        load_settings()
    assert name.lower() in str(exc.value)


def test_missing_uw_api_key_names_field(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UW_API_KEY")
    with pytest.raises(ValidationError) as exc:
        load_settings()
    assert "uw_api_key" in str(exc.value)


def test_endpoint_must_be_https(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("R2_ENDPOINT_URL", "http://x")
    with pytest.raises(ValidationError) as exc:
        load_settings()
    assert "https://" in str(exc.value)


def test_secrets_not_in_repr() -> None:
    text = repr(load_settings())
    assert "test-key" not in text
    assert "test-access-key-id" not in text
    assert "test-secret-access-key" not in text


def test_missing_database_url_names_field(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL")
    with pytest.raises(ValidationError) as exc:
        load_settings()
    assert "database_url" in str(exc.value)


@pytest.mark.parametrize("scheme", ["postgres", "postgresql"])
def test_database_url_accepts_both_postgres_schemes(
    monkeypatch: pytest.MonkeyPatch, scheme: str
) -> None:
    monkeypatch.setenv("DATABASE_URL", f"{scheme}://u:p@db.invalid/app")
    assert load_settings().database_url.get_secret_value() == f"{scheme}://u:p@db.invalid/app"


@pytest.mark.parametrize("url", BAD_SCHEME_DATABASE_URLS)
def test_database_url_scheme_checked_without_echo(
    monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    monkeypatch.setenv("DATABASE_URL", url)
    with pytest.raises(ValidationError) as exc:
        load_settings()
    (error,) = exc.value.errors(include_input=False, include_context=False)
    assert error["loc"] == ("database_url",)
    assert error["msg"] == "Value error, database_url must start with postgres:// or postgresql://"
    # The text a bare `str(exc)` or `repr(exc)` prints is what could reach a log.
    for text in (str(exc.value), repr(exc.value)):
        assert "pw-7f3a" not in text
        assert "db.invalid" not in text


def test_validation_errors_quote_no_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing field would otherwise quote the other settings, secrets included."""
    monkeypatch.delenv("UW_API_KEY")
    with pytest.raises(ValidationError) as exc:
        load_settings()
    for text in (str(exc.value), repr(exc.value)):
        assert "uw_api_key" in text
        assert "input_value" not in text
        assert "localhost" not in text


def test_sentry_only_errors_quote_no_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", MALFORMED_DSNS[0])
    with pytest.raises(ValidationError) as exc:
        _SentryOnly()
    for text in (str(exc.value), repr(exc.value)):
        assert MALFORMED_DSNS[0] not in text


def test_database_url_not_in_repr() -> None:
    settings = load_settings()
    for text in (repr(settings), str(settings)):
        assert "postgresql://" not in text
        assert "test:test" not in text


def test_valid_sentry_dsn_loads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", VALID_DSN)
    assert load_settings().sentry_dsn == VALID_DSN


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_sentry_dsn_means_unset(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("SENTRY_DSN", value)
    assert load_settings().sentry_dsn is None


@pytest.mark.parametrize("dsn", MALFORMED_DSNS)
def test_malformed_sentry_dsn_fails_without_echoing_it(
    monkeypatch: pytest.MonkeyPatch, dsn: str
) -> None:
    monkeypatch.setenv("SENTRY_DSN", dsn)
    with pytest.raises(ValidationError) as exc:
        load_settings()
    (error,) = exc.value.errors(include_input=False, include_context=False)
    assert error["loc"] == ("sentry_dsn",)
    assert error["msg"] == "Value error, invalid sentry dsn"
    assert dsn not in str(exc.value)


def test_dsn_alone_loads_when_other_settings_are_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("UW_API_KEY")
    monkeypatch.setenv("R2_ENDPOINT_URL", "http://x")
    monkeypatch.setenv("SENTRY_DSN", VALID_DSN)
    assert load_sentry_dsn() == VALID_DSN


@pytest.mark.parametrize("dsn", [None, "", MALFORMED_DSNS[0]])
def test_dsn_alone_is_none_when_unset_or_malformed(
    monkeypatch: pytest.MonkeyPatch, dsn: str | None
) -> None:
    if dsn is None:
        monkeypatch.delenv("SENTRY_DSN", raising=False)
    else:
        monkeypatch.setenv("SENTRY_DSN", dsn)
    assert load_sentry_dsn() is None


# --- resources ------------------------------------------------------------------------

POOLED_HOST = "ep-a-1-pooler.us-east-2.aws.neon.tech"
DIRECT_HOST = "ep-a-1.us-east-2.aws.neon.tech"
NEON_QUERY = "sslmode=require&channel_binding=require"
POOLED_URL = f"postgresql://u:p@{POOLED_HOST}:5432/db?{NEON_QUERY}"
DIRECT_URL = f"postgresql://u:p@{DIRECT_HOST}:5432/db?{NEON_QUERY}"
UNTOUCHED_URLS = [
    DIRECT_URL,
    # "-pooler" in the first label but not at its end
    "postgresql://u:p@ep-pooler-a-1.us-east-2.aws.neon.tech/db",
    # "-pooler" ending a later label
    "postgresql://u:p@ep-a-1.us-east-2-pooler.aws.neon.tech/db",
]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (POOLED_URL, DIRECT_URL),
        *[(url, url) for url in UNTOUCHED_URLS],
        # No port and the postgres:// scheme.
        (f"postgres://u:p@{POOLED_HOST}/db", f"postgres://u:p@{DIRECT_HOST}/db"),
        # A host with no dots: the label ends at the port.
        ("postgresql://u:p@ep-a-1-pooler:5432/db", "postgresql://u:p@ep-a-1:5432/db"),
        # Only the host changes: "-pooler" in user, password, path and query stays.
        (
            f"postgresql://u-pooler:p-pooler@{POOLED_HOST}/db-pooler?application_name=a-pooler",
            f"postgresql://u-pooler:p-pooler@{DIRECT_HOST}/db-pooler?application_name=a-pooler",
        ),
        # A raw "@" inside the password does not move the host boundary.
        (f"postgresql://u:p@ss@{POOLED_HOST}/db", f"postgresql://u:p@ss@{DIRECT_HOST}/db"),
        # The host ends at "/" or "?" as well as at the port colon.
        ("postgresql://u:p@ep-a-1-pooler/db", "postgresql://u:p@ep-a-1/db"),
        (
            "postgresql://u:p@ep-a-1-pooler?sslmode=require",
            "postgresql://u:p@ep-a-1?sslmode=require",
        ),
        # A percent-encoded password is carried through as written.
        (
            "postgresql://u:p%40ss%2Fx@ep-a-1-pooler.x.tech/db",
            "postgresql://u:p%40ss%2Fx@ep-a-1.x.tech/db",
        ),
        # Characters urllib's urlsplit rejects or rewrites: brackets (it raises, with the
        # host in the message), a tab (it drops it) and an empty trailing "?" (it drops it).
        (
            "postgresql://u:pa[s]s@ep-a-1-pooler.x.tech/db",
            "postgresql://u:pa[s]s@ep-a-1.x.tech/db",
        ),
        (
            "postgresql://u:pa\tss@ep-a-1-pooler.x.tech/db",
            "postgresql://u:pa\tss@ep-a-1.x.tech/db",
        ),
        (f"postgresql://u:p@{POOLED_HOST}/db?", f"postgresql://u:p@{DIRECT_HOST}/db?"),
        # Hostnames are case-insensitive.
        ("postgresql://u:p@EP-A-1-POOLER.X.TECH/db", "postgresql://u:p@EP-A-1.X.TECH/db"),
        # A user name ending in "-pooler" is not a host label, even on a direct host.
        (
            "postgresql://svc-pooler:p@ep-a-1.x.tech/db",
            "postgresql://svc-pooler:p@ep-a-1.x.tech/db",
        ),
        # Nothing here is a pooled Neon host, and none of it may raise.
        ("postgresql://u:p@[::1]:5432/db", "postgresql://u:p@[::1]:5432/db"),
        ("postgresql://u:p@[::1/db", "postgresql://u:p@[::1/db"),
        ("not a url", "not a url"),
        ("", ""),
    ],
)
def test_direct_dsn_strips_pooler_label(url: str, expected: str) -> None:
    assert resources.direct_dsn(url) == expected


def test_connect_db_sets_timeouts_and_autocommit_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DATABASE_URL", POOLED_URL)
    conn = MagicMock()
    connect = MagicMock(return_value=conn)
    monkeypatch.setattr(resources, "connect_with_retry", connect)

    with resources.connect_db(load_settings()) as got:
        assert got is conn
        assert conn.autocommit is True
        conn.close.assert_not_called()

    conn.close.assert_called_once_with()
    connect.assert_called_once_with(
        DIRECT_URL,
        error_detail=False,
        connect_timeout=DB_CONNECT_TIMEOUT_SECONDS,
        application_name="nightly",
        options=f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}",
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )


def test_connect_db_closes_when_the_body_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    conn = MagicMock()
    monkeypatch.setattr(resources, "connect_with_retry", MagicMock(return_value=conn))

    with pytest.raises(RuntimeError, match="boom"), resources.connect_db(load_settings()):
        raise RuntimeError("boom")

    conn.close.assert_called_once_with()


def test_connect_db_closes_when_autocommit_cannot_be_set(monkeypatch: pytest.MonkeyPatch) -> None:
    class Refusing:
        def __init__(self) -> None:
            self.close = MagicMock()

        @property
        def autocommit(self) -> bool:
            return False

        @autocommit.setter
        def autocommit(self, value: bool) -> None:
            raise psycopg2.ProgrammingError

    conn = Refusing()
    monkeypatch.setattr(resources, "connect_with_retry", MagicMock(return_value=conn))

    with pytest.raises(psycopg2.ProgrammingError), resources.connect_db(load_settings()):
        pytest.fail("connect_db yielded a connection it could not put in autocommit")

    conn.close.assert_called_once_with()


def test_terminal_connect_failure_leaves_no_host_text_in_any_log(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The real retry helper runs, so its `[retry]` lines are the output under test."""
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("DATABASE_URL", f"postgresql://u:p@{POOLED_HOST}/db")
    failure = psycopg2.OperationalError(f'could not translate host name "{DIRECT_HOST}" to address')
    driver = MagicMock(side_effect=failure)
    monkeypatch.setattr(psycopg2, "connect", driver)
    no_wait = partial(_pipeline_retry.connect_with_retry, sleep=lambda _: None)
    monkeypatch.setattr(resources, "connect_with_retry", no_wait)

    with pytest.raises(psycopg2.OperationalError) as raised, resources.connect_db(load_settings()):
        pytest.fail("connect_db yielded after every attempt failed")

    assert raised.value is failure
    assert driver.call_count == _pipeline_retry.DEFAULT_ATTEMPTS
    seen = capsys.readouterr()
    assert "[retry]" in seen.err
    assert "OperationalError" in seen.err
    everything = seen.out + seen.err + caplog.text
    assert "ep-a-1" not in everything
    assert "neon.tech" not in everything


def test_open_reader_clears_the_cache_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    (cache / "nested").mkdir(parents=True)
    (cache / "2026-11-05-fulltape.parquet").write_bytes(b"day")
    (cache / "2026-11-06-fulltape.parquet.part").write_bytes(b"partial")
    (cache / "nested" / "leftover").write_bytes(b"x")
    seen_at_build: list[list[str]] = []
    reader_cls = MagicMock(side_effect=lambda **_: seen_at_build.append(sorted(cache.iterdir())))
    monkeypatch.setattr(resources, "TapeReader", reader_cls)

    resources.open_reader(load_settings(), cache)

    assert seen_at_build == [[]]
    assert cache.is_dir()


def test_open_reader_creates_a_missing_cache_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cache = tmp_path / "missing" / "cache"
    monkeypatch.setattr(resources, "TapeReader", MagicMock())

    resources.open_reader(load_settings(), cache)

    assert cache.is_dir()
    assert list(cache.iterdir()) == []


def test_open_reader_removes_a_symlink_without_touching_its_target(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.parquet").write_bytes(b"day")
    cache = tmp_path / "cache"
    cache.mkdir()
    try:
        (cache / "link").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("this OS or user cannot create symlinks")
    monkeypatch.setattr(resources, "TapeReader", MagicMock())

    resources.open_reader(load_settings(), cache)

    assert list(cache.iterdir()) == []
    assert (outside / "keep.parquet").read_bytes() == b"day"


def test_open_reader_builds_the_reader_from_the_r2_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    reader_cls = MagicMock()
    monkeypatch.setattr(resources, "TapeReader", reader_cls)

    reader = resources.open_reader(load_settings(), tmp_path)

    assert reader is reader_cls.return_value
    reader_cls.assert_called_once_with(
        endpoint_url="https://example.r2.cloudflarestorage.com",
        access_key_id="test-access-key-id",
        secret_access_key="test-secret-access-key",
        bucket="test-bucket",
        cache_dir=tmp_path,
    )


def test_a_real_psycopg2_connect_is_blocked_in_tests(db_block_attempts: list[str]) -> None:
    before = len(db_block_attempts)
    with pytest.raises(BaseException, match="tests must not connect to a database") as raised:
        psycopg2.connect("postgresql://u:p@localhost/db")
    assert not isinstance(raised.value, Exception)  # an `except Exception` cannot swallow it
    assert db_block_attempts[before:] == ["psycopg2.connect"]
    del db_block_attempts[before:]  # provoked on purpose: the session-end check ignores it
