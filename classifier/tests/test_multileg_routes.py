"""Tests for ``classifier.src.multileg_routes.handle_classify_payload``.

Ported from ``sidecar/tests/test_multileg_routes.py`` (8 cases) and
extended with 6 new cases per the 2026-05-28 service-split spec.

The matcher is mocked at the ``_classify_with_polars`` boundary (see
``conftest.mock_classify_trades``). Real polars + matcher invocation is
covered by the sidecar's existing end-to-end tests against ml/src/ —
duplicating it here would only re-test ``classify_trades``, not the
route layer.
"""

from __future__ import annotations

import copy
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import multileg_routes

# ── Happy-path: ports from sidecar ────────────────────────────────────────


def test_happy_path_single_trade_returns_200_with_classifications(
    mock_classify_trades,
    sample_classify_request_body: bytes,
) -> None:
    status, body = multileg_routes.handle_classify_payload(sample_classify_request_body)
    assert status == 200
    assert body == {
        "classifications": [
            {
                "id": "t1",
                "inferred_structure": "isolated_leg",
                "is_isolated_leg": True,
                "match_confidence": 0.42,
                "pattern_group_id": "test-group",
            }
        ]
    }
    assert mock_classify_trades["trade_ids"] == ["t1"]


def test_happy_path_multi_trade_returns_one_classification_per_trade(
    mock_classify_trades,
    make_payload,
    sample_trade: dict[str, Any],
) -> None:
    trades = []
    for i, tid in enumerate(["t1", "t2", "t3"]):
        t = copy.deepcopy(sample_trade)
        t["id"] = tid
        t["strike"] = 190.0 + i  # different strikes so they're plausibly distinct
        trades.append(t)

    status, body = multileg_routes.handle_classify_payload(make_payload(trades=trades))
    assert status == 200
    classifications = body["classifications"]
    assert len(classifications) == 3
    assert [c["id"] for c in classifications] == ["t1", "t2", "t3"]
    assert mock_classify_trades["trade_ids"] == ["t1", "t2", "t3"]


# ── 400 errors: ports from sidecar ────────────────────────────────────────


def test_malformed_json_returns_400(mock_classify_trades) -> None:
    status, body = multileg_routes.handle_classify_payload(b"{not valid json")
    assert status == 400
    assert body == {"error": "body must be valid JSON"}
    # Matcher must NOT be called when the request didn't even parse.
    assert "call_count" not in mock_classify_trades


def test_body_is_json_array_returns_400(mock_classify_trades) -> None:
    status, body = multileg_routes.handle_classify_payload(b"[1, 2, 3]")
    assert status == 400
    assert body == {"error": "body must be a JSON object"}
    assert "call_count" not in mock_classify_trades


def test_missing_trades_key_returns_400(mock_classify_trades) -> None:
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"window_seconds": 90}).encode()
    )
    assert status == 400
    assert body == {"error": "trades is required"}
    assert "call_count" not in mock_classify_trades


def test_empty_trades_list_returns_400(mock_classify_trades) -> None:
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": []}).encode()
    )
    assert status == 400
    assert body == {"error": "trades must be a non-empty list"}
    assert "call_count" not in mock_classify_trades


# ── 422 errors: ports from sidecar ────────────────────────────────────────


def test_missing_required_field_returns_422(
    mock_classify_trades,
    sample_trade: dict[str, Any],
) -> None:
    bad = dict(sample_trade)
    bad.pop("nbbo_bid")
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert "details" in body
    assert any("nbbo_bid" in str(d.get("loc", "")) for d in body["details"])
    assert "call_count" not in mock_classify_trades


# ── 500 errors: ports from sidecar ────────────────────────────────────────


def test_unexpected_matcher_error_returns_500(
    mock_classify_raises,
    sample_classify_request_body: bytes,
) -> None:
    status, body = multileg_routes.handle_classify_payload(sample_classify_request_body)
    assert status == 500
    assert body["error"] == "matcher exploded"


# ── New for service: perf-smoke at 1500 trades ───────────────────────────


def test_realistic_1500_trade_payload_returns_200(
    mock_classify_trades,
    make_payload,
    sample_trade: dict[str, Any],
) -> None:
    """1500 trades is a realistic detect-cron window. Confirms the wire
    layer handles the larger payload and forwards everything to the
    matcher (and the matcher's responsibility is to scale).
    """
    trades = []
    for i in range(1500):
        t = copy.deepcopy(sample_trade)
        t["id"] = f"t{i:04d}"
        # Vary strike slightly so the stub-projected output is unique per id.
        t["strike"] = 190.0 + (i % 20)
        trades.append(t)

    status, body = multileg_routes.handle_classify_payload(make_payload(trades=trades))
    assert status == 200
    classifications = body["classifications"]
    assert len(classifications) == 1500
    # Order preservation matters for the matcher contract — assert it.
    assert classifications[0]["id"] == "t0000"
    assert classifications[-1]["id"] == "t1499"
    # The matcher saw all 1500 trades and the default tolerances.
    assert len(mock_classify_trades["trade_ids"]) == 1500
    assert mock_classify_trades["window_seconds"] == 90
    assert mock_classify_trades["strike_tolerance"] == 0.05
    assert mock_classify_trades["size_tolerance"] == 0.1


# ── New for service: extra-field rejection (model_config extra='forbid') ──


def test_extra_field_on_trade_returns_422(
    mock_classify_trades,
    sample_trade: dict[str, Any],
) -> None:
    bad = dict(sample_trade)
    bad["extra_field"] = "this should be rejected"
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    # Pydantic v2 includes "extra_forbidden" in the error type for forbid mode.
    assert any(
        "extra" in str(d).lower() for d in body["details"]
    ), f"expected extra-field detail, got {body['details']}"
    assert "call_count" not in mock_classify_trades


def test_extra_field_on_request_envelope_returns_422(
    mock_classify_trades,
    sample_trade: dict[str, Any],
) -> None:
    """The MultilegClassifyRequest envelope also has extra='forbid'."""
    payload = {"trades": [sample_trade], "rogue_field": 1}
    status, body = multileg_routes.handle_classify_payload(json.dumps(payload).encode())
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert "call_count" not in mock_classify_trades


# ── New for service: 500 path emits Sentry capture with right tags ───────


def test_500_path_captures_to_sentry_with_classifier_tags(
    mock_classify_raises,
    sample_classify_request_body: bytes,
) -> None:
    """When the matcher raises, ``handle_classify_payload`` must report to
    Sentry tagged ``component=classifier`` + ``route=classify`` so the
    new service's events are filterable from the legacy sidecar ones in
    Sentry's UI.
    """
    capture_mock = MagicMock()
    # capture_exception is imported lazily inside the except block, so
    # we patch on sys.modules — the import will resolve through there.
    import sentry_setup

    with patch.object(sentry_setup, "capture_exception", capture_mock):
        status, body = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )

    assert status == 500
    assert body["error"] == "matcher exploded"
    capture_mock.assert_called_once()
    # The call signature is capture_exception(exc, tags={...}).
    call_args = capture_mock.call_args
    assert call_args.args[0] is mock_classify_raises
    assert call_args.kwargs["tags"] == {
        "component": "classifier",
        "route": "classify",
    }


def test_500_path_does_not_crash_when_sentry_capture_raises(
    mock_classify_raises,
    sample_classify_request_body: bytes,
) -> None:
    """A buggy capture_exception must NOT prevent the 500 response.

    Exercises the bare ``except Exception: pass`` around the lazy import
    + capture call in handle_classify_payload — the route layer is on
    the production path and must always respond.
    """
    import sentry_setup

    with patch.object(
        sentry_setup,
        "capture_exception",
        side_effect=RuntimeError("sentry blew up"),
    ):
        status, body = multileg_routes.handle_classify_payload(
            sample_classify_request_body
        )

    assert status == 500
    assert body["error"] == "matcher exploded"


# ── New for service: option_type case-insensitivity ──────────────────────


@pytest.mark.parametrize(
    "option_type", ["call", "put", "CALL", "PUT", "Call", "Put"]
)
def test_option_type_case_variants_all_accepted(
    mock_classify_trades,
    sample_trade: dict[str, Any],
    option_type: str,
) -> None:
    trade = dict(sample_trade)
    trade["option_type"] = option_type
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [trade]}).encode()
    )
    assert status == 200, f"option_type={option_type!r} should be accepted"
    assert body["classifications"][0]["id"] == "t1"


# ── New for service: trades-not-a-list ───────────────────────────────────


def test_trades_value_not_a_list_returns_400(mock_classify_trades) -> None:
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": "not-a-list"}).encode()
    )
    assert status == 400
    assert body == {"error": "trades must be a non-empty list"}
    assert "call_count" not in mock_classify_trades


# ── New for service: defaults applied ────────────────────────────────────


def test_default_options_applied_when_omitted(
    mock_classify_trades,
    sample_classify_request_body: bytes,
) -> None:
    """No window_seconds / strike_tolerance / size_tolerance in the body →
    Pydantic defaults of (90, 0.05, 0.1) reach the matcher.
    """
    status, _ = multileg_routes.handle_classify_payload(sample_classify_request_body)
    assert status == 200
    assert mock_classify_trades["window_seconds"] == 90
    assert mock_classify_trades["strike_tolerance"] == 0.05
    assert mock_classify_trades["size_tolerance"] == 0.1


def test_custom_options_overridden_when_supplied(
    mock_classify_trades,
    make_payload,
    sample_trade: dict[str, Any],
) -> None:
    """Caller-supplied tolerances reach the matcher (not just defaults)."""
    status, _ = multileg_routes.handle_classify_payload(
        make_payload(
            trades=[sample_trade],
            window_seconds=45,
            strike_tolerance=0.03,
            size_tolerance=0.07,
        )
    )
    assert status == 200
    assert mock_classify_trades["window_seconds"] == 45
    assert mock_classify_trades["strike_tolerance"] == 0.03
    assert mock_classify_trades["size_tolerance"] == 0.07


# ── _classify_with_polars: smoke that the real polars path is wired ──────


def test_classify_with_polars_runs_real_matcher_end_to_end(
    sample_trade: dict[str, Any],
) -> None:
    """One real invocation of ``_classify_with_polars`` to cover the
    polars/matcher glue without a wide e2e surface. A single isolated
    trade should classify as ``isolated_leg`` and the projection should
    produce exactly the 5 response columns.

    This is the only test that actually imports polars + the matcher;
    everything else uses ``mock_classify_trades``. Without it, the
    glue code's body lines would be uncovered (the spec asks for ≥95%
    line coverage on src/).
    """
    request = multileg_routes.MultilegClassifyRequest.model_validate(
        {"trades": [sample_trade]}
    )
    rows = multileg_routes._classify_with_polars(request)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "t1"
    assert row["inferred_structure"] == "isolated_leg"
    assert row["is_isolated_leg"] is True
    assert "match_confidence" in row
    assert "pattern_group_id" in row
