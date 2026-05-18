"""Tests for the /takeit/multileg-classify route.

Drives the handler function directly (``multileg_routes.handle_classify_payload``)
rather than going through HealthHandler. The HealthHandler dispatch is
covered by test_takeit_routes.py's pattern — repeating it here would
test http.server, not our wire layer.

These tests do exercise the real polars-based matcher end-to-end. The
sidecar venv installs polars via requirements.txt; in CI / local-dev the
import resolves because multileg_routes adds ml/src/ to sys.path on
import.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure sidecar/src/ is importable; conftest does this already, but pytest
# loads test modules before conftest in some configurations.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# Skip the whole file when polars isn't available locally — the route
# still ships, but the in-process tests require the real matcher.
polars = pytest.importorskip("polars")

import multileg_routes  # noqa: E402


# ── Helpers ─────────────────────────────────────────────────────────────


def _trade(
    tid: str,
    *,
    underlying: str = "AAPL",
    executed_at: str = "2026-05-17T15:30:00.000000Z",
    chain: str = "AAPL-2026-05-17-C-190",
    strike: float = 190.0,
    expiry: str = "2026-05-17",
    option_type: str = "call",
    size: float = 10.0,
    price: float = 1.25,
    nbbo_bid: float = 1.20,
    nbbo_ask: float = 1.30,
    premium: float = 1250.0,
    delta: float | None = 0.40,
) -> dict:
    """Build one trade dict matching MultilegTradeInput."""
    trade: dict = {
        "id": tid,
        "underlying_symbol": underlying,
        "executed_at": executed_at,
        "option_chain_id": chain,
        "strike": strike,
        "expiry": expiry,
        "option_type": option_type,
        "size": size,
        "price": price,
        "nbbo_bid": nbbo_bid,
        "nbbo_ask": nbbo_ask,
        "premium": premium,
    }
    if delta is not None:
        trade["delta"] = delta
    return trade


def _post(body: dict) -> tuple[int, dict]:
    """Invoke the handler directly with a JSON-encoded body."""
    return multileg_routes.handle_classify_payload(json.dumps(body).encode())


# ── Happy path: vertical ────────────────────────────────────────────────


def test_two_trade_vertical_returns_vertical_classification() -> None:
    """Two same-type, opposite-side, equal-size trades within the window
    on different strikes should classify as 'vertical' for both legs and
    share a pattern_group_id."""
    # Buy at ask + sell at bid → opposite sides → vertical.
    buy_call_190 = _trade(
        "t1",
        executed_at="2026-05-15T15:30:00.000000Z",
        strike=190.0,
        chain="AAPL-2026-05-15-C-190",
        expiry="2026-05-15",
        price=1.30,  # at ask
        nbbo_bid=1.20,
        nbbo_ask=1.30,
        size=10.0,
    )
    sell_call_195 = _trade(
        "t2",
        executed_at="2026-05-15T15:30:01.000000Z",
        strike=195.0,
        chain="AAPL-2026-05-15-C-195",
        expiry="2026-05-15",
        price=0.50,  # at bid
        nbbo_bid=0.50,
        nbbo_ask=0.60,
        size=10.0,
    )
    status, body = _post({"trades": [buy_call_190, sell_call_195]})

    assert status == 200
    classifications = body["classifications"]
    assert len(classifications) == 2
    # Order preserved: t1 then t2.
    assert [c["id"] for c in classifications] == ["t1", "t2"]
    # Both legs classified as vertical and grouped together.
    assert classifications[0]["inferred_structure"] == "vertical"
    assert classifications[1]["inferred_structure"] == "vertical"
    assert (
        classifications[0]["pattern_group_id"]
        == classifications[1]["pattern_group_id"]
    )
    assert classifications[0]["is_isolated_leg"] is False
    assert classifications[1]["is_isolated_leg"] is False
    assert classifications[0]["match_confidence"] >= 0.5


def test_single_isolated_trade_returns_isolated_leg() -> None:
    """One trade can't form a multileg pattern → isolated_leg."""
    only = _trade("solo-1")
    status, body = _post({"trades": [only]})

    assert status == 200
    classifications = body["classifications"]
    assert len(classifications) == 1
    assert classifications[0]["id"] == "solo-1"
    assert classifications[0]["inferred_structure"] == "isolated_leg"
    assert classifications[0]["is_isolated_leg"] is True
    assert classifications[0]["match_confidence"] == pytest.approx(0.0)
    # Isolated trades get a unique iso- prefixed group id.
    assert classifications[0]["pattern_group_id"].startswith("iso-")


# ── Error paths ─────────────────────────────────────────────────────────


def test_empty_trades_list_returns_400() -> None:
    status, body = _post({"trades": []})
    assert status == 400
    assert "trades" in body["error"]


def test_missing_trades_key_returns_400() -> None:
    status, body = _post({"window_seconds": 90})
    assert status == 400
    assert "trades" in body["error"]


def test_missing_required_field_returns_422() -> None:
    """Drop nbbo_bid (required) → Pydantic schema validation fails."""
    bad = _trade("t1")
    bad.pop("nbbo_bid")
    status, body = _post({"trades": [bad]})
    assert status == 422
    assert "details" in body
    # Pydantic v2 emits a list of {loc, msg, type, ...} dicts. Confirm
    # the missing field is named so a future SDK migration can't silently
    # change the error path without a test failure.
    details = body["details"]
    assert any("nbbo_bid" in str(d.get("loc", "")) for d in details)


def test_invalid_json_returns_400() -> None:
    status, _ = _post_raw(b"{not valid json")
    assert status == 400


def test_non_object_body_returns_400() -> None:
    status, _ = _post_raw(b"[1, 2, 3]")
    assert status == 400


def _post_raw(body_bytes: bytes) -> tuple[int, dict]:
    return multileg_routes.handle_classify_payload(body_bytes)


# ── Tolerances are forwarded ─────────────────────────────────────────────


def test_custom_tolerances_passed_through_to_classify_trades() -> None:
    """When the caller supplies window_seconds / strike_tolerance /
    size_tolerance the handler must forward them to classify_trades."""
    captured: dict = {}

    def fake_classify(df, *, window_seconds, strike_tolerance, size_tolerance):
        captured["window_seconds"] = window_seconds
        captured["strike_tolerance"] = strike_tolerance
        captured["size_tolerance"] = size_tolerance
        # Return the input frame with the 4 required output columns so
        # downstream projection doesn't error.
        return df.with_columns(
            polars.lit("isolated_leg").alias("inferred_structure"),
            polars.lit(0.0).alias("match_confidence"),
            polars.lit(True).alias("is_isolated_leg"),
            polars.lit("iso-fake").alias("pattern_group_id"),
        )

    # multileg_assembler is imported lazily inside _classify_with_polars;
    # patch it on the live module dict if already imported, otherwise
    # the import in _classify_with_polars will pull the real one.
    if "multileg_assembler" not in sys.modules:
        import multileg_assembler  # noqa: F401, PLC0415
    with patch.object(
        sys.modules["multileg_assembler"], "classify_trades", side_effect=fake_classify
    ):
        status, _ = _post(
            {
                "trades": [_trade("t1"), _trade("t2")],
                "window_seconds": 45,
                "strike_tolerance": 0.03,
                "size_tolerance": 0.07,
            }
        )

    assert status == 200
    assert captured == {
        "window_seconds": 45,
        "strike_tolerance": 0.03,
        "size_tolerance": 0.07,
    }


def test_defaults_used_when_tolerances_omitted() -> None:
    """Defaults match classify_trades's defaults (90 / 0.05 / 0.1)."""
    captured: dict = {}

    def fake_classify(df, *, window_seconds, strike_tolerance, size_tolerance):
        captured["window_seconds"] = window_seconds
        captured["strike_tolerance"] = strike_tolerance
        captured["size_tolerance"] = size_tolerance
        return df.with_columns(
            polars.lit("isolated_leg").alias("inferred_structure"),
            polars.lit(0.0).alias("match_confidence"),
            polars.lit(True).alias("is_isolated_leg"),
            polars.lit("iso-fake").alias("pattern_group_id"),
        )

    if "multileg_assembler" not in sys.modules:
        import multileg_assembler  # noqa: F401, PLC0415
    with patch.object(
        sys.modules["multileg_assembler"], "classify_trades", side_effect=fake_classify
    ):
        status, _ = _post({"trades": [_trade("t1")]})
    assert status == 200
    assert captured == {
        "window_seconds": 90,
        "strike_tolerance": 0.05,
        "size_tolerance": 0.1,
    }


# ── 500 path: matcher raises unexpectedly ───────────────────────────────


def test_unexpected_matcher_error_returns_500() -> None:
    """When classify_trades raises, the handler returns 500 with the
    message in the body. Sentry capture is best-effort and should not
    affect the response."""
    if "multileg_assembler" not in sys.modules:
        import multileg_assembler  # noqa: F401, PLC0415

    def boom(*_a, **_kw):
        raise RuntimeError("matcher exploded")

    with patch.object(
        sys.modules["multileg_assembler"], "classify_trades", side_effect=boom
    ):
        status, body = _post({"trades": [_trade("t1")]})
    assert status == 500
    assert "matcher exploded" in body["error"]


# ── Module import guard ────────────────────────────────────────────────


def test_module_adds_ml_src_to_path() -> None:
    """Defensive: importing multileg_routes must place a directory
    containing ``multileg_assembler.py`` on sys.path so the matcher
    import inside the handler resolves regardless of how the sidecar
    was launched.

    Two layouts are accepted (see ``_ensure_ml_src_on_path``):
      1. ``sidecar/_vendored_ml/`` — shipped inside the Railway image
      2. ``ml/src/`` — local checkout fallback
    """
    # Reload to exercise the path-mutation on a fresh import without
    # disturbing the rest of the test session.
    importlib.reload(multileg_routes)
    sidecar_root = Path(__file__).resolve().parents[1]
    repo_root = sidecar_root.parent
    vendored = sidecar_root / "_vendored_ml"
    ml_src = repo_root / "ml" / "src"
    on_path = {str(vendored), str(ml_src)} & set(sys.path)
    assert on_path, (
        "expected _vendored_ml/ or ml/src/ on sys.path after importing "
        "multileg_routes"
    )
