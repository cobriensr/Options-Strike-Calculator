"""Tests for nightly settings: required vars fail by name, secrets stay out of repr,
and a malformed SENTRY_DSN fails boot without being echoed."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from config import load_sentry_dsn, load_settings

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
