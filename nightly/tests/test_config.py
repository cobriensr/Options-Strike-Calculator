"""Tests for nightly settings: required vars fail by name, secrets stay out of repr."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from config import load_settings

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
