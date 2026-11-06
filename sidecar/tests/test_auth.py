"""Tests for auth — the shared-secret comparisons behind the sidecar's routes.

`hmac.compare_digest` raises TypeError for a str with non-ASCII characters,
and `http.server` decodes header bytes as latin-1, so any client can put a
non-ASCII str in front of the comparison. The helpers compare bytes instead.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

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
