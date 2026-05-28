"""Shared pytest fixtures for the classifier test suite.

Fixtures here:
- ``sample_trade`` — one realistic ``MultilegTradeInput``-shaped dict.
- ``sample_classify_request_body`` — JSON bytes wrapping ``[sample_trade]``
  with no options (defaults applied by Pydantic).
- ``make_payload`` — builder for ad-hoc request bodies.
- ``mock_classify_trades`` — installs a deterministic stub for the polars
  matcher invocation. We monkeypatch at the
  ``multileg_routes._classify_with_polars`` boundary (rather than at
  ``multileg_assembler.classify_trades``) for two reasons:
    1. The matcher import is lazy inside ``_classify_with_polars`` — patching
       the inner symbol only takes effect if the matcher module is already
       imported, which is brittle across test ordering.
    2. The wire-shape we care about is what ``_classify_with_polars``
       returns (the projected list-of-dicts). Mocking at that boundary
       isolates the route layer cleanly from polars + the real matcher.
  The ``handle_classify_payload`` 500-branch still exercises the real call
  path when a test wants to make the matcher raise — see
  ``mock_classify_raises``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest


@pytest.fixture
def sample_trade() -> dict[str, Any]:
    """One trade dict matching ``MultilegTradeInput``.

    Values are realistic SPX-style 0DTE numbers so a Pydantic round-trip
    catches accidental type drifts (str vs float, ISO vs epoch).
    """
    return {
        "id": "t1",
        "underlying_symbol": "AAPL",
        "executed_at": "2026-05-15T15:30:00.000000Z",
        "option_chain_id": "AAPL-2026-05-15-C-190",
        "strike": 190.0,
        "expiry": "2026-05-15",
        "option_type": "call",
        "size": 10.0,
        "price": 1.25,
        "nbbo_bid": 1.20,
        "nbbo_ask": 1.30,
        "premium": 1250.0,
        "delta": 0.40,
    }


@pytest.fixture
def sample_classify_request_body(sample_trade: dict[str, Any]) -> bytes:
    """A valid POST /multileg-classify body wrapping ``[sample_trade]``.

    No options supplied; Pydantic applies the defaults (window=90,
    strike_tol=0.05, size_tol=0.1).
    """
    return json.dumps({"trades": [sample_trade]}).encode()


@pytest.fixture
def make_payload(sample_trade: dict[str, Any]):
    """Factory for assembling POST body bytes with varying trades / opts."""

    def _build(
        trades: list[dict[str, Any]] | None = None,
        **opts: Any,
    ) -> bytes:
        body: dict[str, Any] = {
            "trades": trades if trades is not None else [sample_trade],
        }
        body.update(opts)
        return json.dumps(body).encode()

    return _build


def _stub_classify_result(trade_ids: list[str]) -> list[dict[str, Any]]:
    """Build a deterministic classifier result list for ``trade_ids``."""
    return [
        {
            "id": tid,
            "inferred_structure": "isolated_leg",
            "is_isolated_leg": True,
            "match_confidence": 0.42,
            "pattern_group_id": "test-group",
        }
        for tid in trade_ids
    ]


@pytest.fixture
def mock_classify_trades(monkeypatch: pytest.MonkeyPatch):
    """Replace ``multileg_routes._classify_with_polars`` with a stub.

    The stub returns a deterministic list-of-dicts shaped like the real
    projection output, sized to match the input trade count. Tests can
    inspect ``captured`` to assert what the route layer forwarded.

    Returns the ``captured`` dict so tests can assert the request shape
    after invoking ``handle_classify_payload``.
    """
    captured: dict[str, Any] = {}

    def fake_classify(request) -> list[dict[str, Any]]:
        # Capture the parsed Pydantic request so tests can assert the
        # forwarded tolerance defaults / trade count without re-parsing.
        captured["request"] = request
        captured["window_seconds"] = request.window_seconds
        captured["strike_tolerance"] = request.strike_tolerance
        captured["size_tolerance"] = request.size_tolerance
        captured["trade_ids"] = [t.id for t in request.trades]
        captured["call_count"] = captured.get("call_count", 0) + 1
        return _stub_classify_result([t.id for t in request.trades])

    import multileg_routes

    monkeypatch.setattr(multileg_routes, "_classify_with_polars", fake_classify)
    return captured


@pytest.fixture
def mock_classify_raises(monkeypatch: pytest.MonkeyPatch):
    """Make ``_classify_with_polars`` raise ``RuntimeError('matcher exploded')``.

    Returns the exception instance so tests can identify-compare it.
    """
    exc = RuntimeError("matcher exploded")

    def boom(_request):
        raise exc

    import multileg_routes

    monkeypatch.setattr(multileg_routes, "_classify_with_polars", boom)
    return exc


@pytest.fixture(autouse=True)
def _reset_sentry_module_state(monkeypatch: pytest.MonkeyPatch):
    """Reset sentry_setup's module-level ``_sentry_enabled`` flag.

    Tests that exercise the Sentry branch flip ``_sentry_enabled``; leaving
    it stuck True across tests bleeds state into other modules' tests
    (e.g. ``capture_exception`` assertions in test_multileg_routes.py).
    """
    import sentry_setup

    original = sentry_setup._sentry_enabled
    yield
    sentry_setup._sentry_enabled = original
