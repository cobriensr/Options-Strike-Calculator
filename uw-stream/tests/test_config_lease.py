"""Tests for the WS connection lease config validation.

The lease is a safety mechanism (gates UW socket opens behind a single
Upstash-backed TTL'd key so a Railway deploy handoff can't exceed UW's
10-connection cap). A daemon that boots with the lease ENABLED but with
blank Upstash creds would believe it is protected while never actually
acquiring anything — the worst failure mode. So Settings construction
fails fast when WS_LEASE_ENABLED is true and either KV var is blank, and
when the renew interval isn't strictly tighter than the TTL.

See docs/superpowers/specs/uw-stream-ws-connection-lease-2026-06-03.md.
"""

from __future__ import annotations

import pytest

from config import Settings


def _settings(**overrides) -> Settings:
    """Build a Settings instance with sensible required-field defaults.

    KV vars default present so the lease-enabled happy path constructs;
    individual tests override them (e.g. blank) to exercise validation.
    """
    base: dict[str, object] = {
        "database_url": "postgresql://test",
        "uw_api_key": "test",
        "ws_channels": "flow-alerts",
        "kv_rest_api_url": "https://test.upstash.io",
        "kv_rest_api_token": "test-token",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


class TestWsLeaseConfig:
    def test_enabled_with_both_kv_vars_ok(self):
        s = _settings(ws_lease_enabled=True)
        assert s.ws_lease_enabled is True
        assert s.kv_rest_api_url == "https://test.upstash.io"
        assert s.kv_rest_api_token == "test-token"

    def test_defaults(self):
        # Spec-mandated defaults — guard against silent drift.
        s = _settings()
        assert s.ws_lease_enabled is True
        assert s.ws_lease_ttl_ms == 30_000
        assert s.ws_lease_renew_ms == 10_000
        assert s.ws_lease_acquire_timeout_s == 60
        assert s.ws_lease_key == "uw-stream:ws-conn-lease"

    def test_enabled_with_blank_url_raises(self):
        with pytest.raises(ValueError, match="KV_REST_API_URL"):
            _settings(ws_lease_enabled=True, kv_rest_api_url="")

    def test_enabled_with_blank_token_raises(self):
        with pytest.raises(ValueError, match="KV_REST_API_TOKEN"):
            _settings(ws_lease_enabled=True, kv_rest_api_token="")

    def test_enabled_with_whitespace_only_url_raises(self):
        # Blank-via-whitespace is still blank — must not slip past.
        with pytest.raises(ValueError, match="blank"):
            _settings(ws_lease_enabled=True, kv_rest_api_url="   ")

    def test_disabled_with_blank_kv_vars_ok(self):
        # Kill switch off → KV creds are irrelevant, so no raise.
        s = _settings(
            ws_lease_enabled=False,
            kv_rest_api_url="",
            kv_rest_api_token="",
        )
        assert s.ws_lease_enabled is False

    def test_renew_equal_to_ttl_raises(self):
        with pytest.raises(ValueError, match="WS_LEASE_RENEW_MS"):
            _settings(ws_lease_ttl_ms=10_000, ws_lease_renew_ms=10_000)

    def test_renew_greater_than_ttl_raises(self):
        with pytest.raises(ValueError, match="WS_LEASE_RENEW_MS"):
            _settings(ws_lease_ttl_ms=10_000, ws_lease_renew_ms=20_000)

    def test_renew_tighter_than_ttl_ok(self):
        s = _settings(ws_lease_ttl_ms=30_000, ws_lease_renew_ms=10_000)
        assert s.ws_lease_renew_ms < s.ws_lease_ttl_ms

    def test_disabled_skips_renew_ttl_check(self):
        # When disabled, the renew/ttl relationship is irrelevant too —
        # no raise even if renew >= ttl.
        s = _settings(
            ws_lease_enabled=False,
            kv_rest_api_url="",
            kv_rest_api_token="",
            ws_lease_ttl_ms=10_000,
            ws_lease_renew_ms=10_000,
        )
        assert s.ws_lease_enabled is False
