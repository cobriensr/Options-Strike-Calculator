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


# ── Finding 1.2: bareword NaN/Infinity + allow_inf_nan=False ─────────────


def test_bareword_nan_in_body_returns_400(mock_classify_trades) -> None:
    """``{"strike": NaN}`` is bareword non-standard JSON. CPython would
    accept it without ``parse_constant``; the route rejects it at parse
    time so the silent ``isolated_leg`` floor never gets reached.
    """
    body = b'{"trades": [{"id": "t1", "strike": NaN}]}'
    status, body_out = multileg_routes.handle_classify_payload(body)
    assert status == 400
    assert body_out == {"error": "body must be valid JSON"}
    assert "call_count" not in mock_classify_trades


def test_bareword_infinity_in_body_returns_400(mock_classify_trades) -> None:
    body = b'{"trades": [{"id": "t1", "nbbo_bid": Infinity}]}'
    status, body_out = multileg_routes.handle_classify_payload(body)
    assert status == 400
    assert body_out == {"error": "body must be valid JSON"}
    assert "call_count" not in mock_classify_trades


def test_bareword_negative_infinity_in_body_returns_400(mock_classify_trades) -> None:
    body = b'{"trades": [{"id": "t1", "premium": -Infinity}]}'
    status, body_out = multileg_routes.handle_classify_payload(body)
    assert status == 400
    assert body_out == {"error": "body must be valid JSON"}
    assert "call_count" not in mock_classify_trades


def test_string_nan_in_float_field_returns_422(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """A *string* ``"NaN"`` passes JSON parse but Pydantic strict mode
    rejects string→float coercion AND ``allow_inf_nan=False`` would
    reject the NaN even in lax mode. Either gate must fire.
    """
    bad = dict(sample_trade)
    bad["strike"] = "NaN"
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert "call_count" not in mock_classify_trades


def test_match_confidence_boundary_allow_inf_nan(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """A finite ``match_confidence`` round-trips through the response
    model; ``MultilegClassification`` uses ``allow_inf_nan=False`` too,
    so direct model construction with NaN raises.
    """
    from pydantic import ValidationError

    # Finite value: accepted.
    ok = multileg_routes.MultilegClassification.model_validate(
        {
            "id": "t1",
            "inferred_structure": "isolated_leg",
            "is_isolated_leg": True,
            "match_confidence": 0.42,
            "pattern_group_id": "g1",
        }
    )
    assert ok.match_confidence == 0.42

    # NaN: rejected.
    with pytest.raises(ValidationError):
        multileg_routes.MultilegClassification.model_validate(
            {
                "id": "t1",
                "inferred_structure": "isolated_leg",
                "is_isolated_leg": True,
                "match_confidence": float("nan"),
                "pattern_group_id": "g1",
            }
        )


# ── Finding 1.3: naive datetime rejection on executed_at ─────────────────


def test_naive_executed_at_returns_422(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """The polars cast at ``_classify_with_polars`` *relabels* a naive
    datetime as UTC without converting it. A trade stamped ``10:30:00``
    intended as ET (14:30 UTC) would silently bucket at 10:30 UTC. The
    field validator must reject any naive value.
    """
    bad = dict(sample_trade)
    bad["executed_at"] = "2026-05-15T10:30:00"  # naive — no tz
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert any("executed_at" in str(d.get("loc", "")) for d in body["details"])
    assert "call_count" not in mock_classify_trades


@pytest.mark.parametrize(
    "tz_form",
    [
        "2026-05-15T15:30:00Z",
        "2026-05-15T15:30:00+00:00",
        "2026-05-15T10:30:00-05:00",
        "2026-05-15T15:30:00.123456+00:00",
    ],
)
def test_tz_aware_executed_at_accepted(
    mock_classify_trades,
    sample_trade: dict[str, Any],
    tz_form: str,
) -> None:
    """All standard tz-aware ISO 8601 forms continue to validate."""
    trade = dict(sample_trade)
    trade["executed_at"] = tz_form
    status, _ = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [trade]}).encode()
    )
    assert status == 200, f"tz_form={tz_form!r} should be accepted"


# ── Finding 1.8: upper-bound caps on tolerances ──────────────────────────


def test_window_seconds_at_upper_cap_accepted(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    status, _ = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], window_seconds=600)
    )
    assert status == 200
    assert mock_classify_trades["window_seconds"] == 600


def test_window_seconds_above_cap_returns_422(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    """86400 (one day) used to be accepted; the matcher's cross-join is
    ~quadratic in bucket size → trillions of intermediate rows → OOM.
    """
    status, body = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], window_seconds=601)
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert any(
        "window_seconds" in str(d.get("loc", "")) for d in body["details"]
    )
    assert "call_count" not in mock_classify_trades


def test_strike_tolerance_at_upper_cap_accepted(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    status, _ = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], strike_tolerance=0.5)
    )
    assert status == 200
    assert mock_classify_trades["strike_tolerance"] == 0.5


def test_strike_tolerance_above_cap_returns_422(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    status, body = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], strike_tolerance=0.501)
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert any(
        "strike_tolerance" in str(d.get("loc", "")) for d in body["details"]
    )
    assert "call_count" not in mock_classify_trades


def test_size_tolerance_at_upper_cap_accepted(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    status, _ = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], size_tolerance=1.0)
    )
    assert status == 200
    assert mock_classify_trades["size_tolerance"] == 1.0


def test_size_tolerance_above_cap_returns_422(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    status, body = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], size_tolerance=1.001)
    )
    assert status == 422
    assert body["error"] == "schema validation failed"
    assert any(
        "size_tolerance" in str(d.get("loc", "")) for d in body["details"]
    )
    assert "call_count" not in mock_classify_trades


def test_inf_in_tolerance_returns_422(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    """``strike_tolerance`` has ``allow_inf_nan=False`` too — a finite
    value above the cap returns 422 via ``le=``; an infinite value goes
    via the ``allow_inf_nan`` gate. Both should land at 422. The 400
    parse-time gate also picks up bareword Infinity.
    """
    body = (
        b'{"trades": [{"id":"t1","underlying_symbol":"AAPL",'
        b'"executed_at":"2026-05-15T15:30:00Z",'
        b'"option_chain_id":"AAPL-2026-05-15-C-190",'
        b'"strike":190.0,"expiry":"2026-05-15","option_type":"call",'
        b'"size":10.0,"price":1.25,"nbbo_bid":1.2,"nbbo_ask":1.3,'
        b'"premium":1250.0,"delta":0.4}],"strike_tolerance":Infinity}'
    )
    status, _ = multileg_routes.handle_classify_payload(body)
    # Parse-time gate fires first → 400.
    assert status == 400
    assert "call_count" not in mock_classify_trades


# ── Finding 3.5: strict mode rejects coerce-from-wrong-type ──────────────


def test_bool_strike_rejected_under_strict(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """Pydantic v2 default lax mode coerces ``True``/``False`` to
    1.0/0.0 — a payload with ``"strike": true`` would store as 1.0,
    silently garbage. ``strict=True`` blocks the coercion.
    """
    bad = dict(sample_trade)
    bad["strike"] = True
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert any("strike" in str(d.get("loc", "")) for d in body["details"])
    assert "call_count" not in mock_classify_trades


def test_bool_size_rejected_under_strict(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    bad = dict(sample_trade)
    bad["size"] = False
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert any("size" in str(d.get("loc", "")) for d in body["details"])
    assert "call_count" not in mock_classify_trades


def test_string_strike_rejected_under_strict(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """``"450"`` → 450.0 used to be accepted. Strict mode rejects it."""
    bad = dict(sample_trade)
    bad["strike"] = "450"
    status, body = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [bad]}).encode()
    )
    assert status == 422
    assert any("strike" in str(d.get("loc", "")) for d in body["details"])
    assert "call_count" not in mock_classify_trades


def test_int_to_float_still_accepted_under_strict(
    mock_classify_trades, sample_trade: dict[str, Any]
) -> None:
    """Integer literals for float fields are still accepted — Pydantic
    strict mode treats int→float as an exact numeric widening, not a
    coercion.
    """
    trade = dict(sample_trade)
    trade["strike"] = 450  # bare int, no decimal
    status, _ = multileg_routes.handle_classify_payload(
        json.dumps({"trades": [trade]}).encode()
    )
    assert status == 200, "int → float widening should still be accepted"


def test_string_int_for_window_seconds_rejected_under_strict(
    mock_classify_trades, make_payload, sample_trade: dict[str, Any]
) -> None:
    """``"90"`` for ``window_seconds`` used to silently coerce; strict
    mode rejects.
    """
    status, body = multileg_routes.handle_classify_payload(
        make_payload(trades=[sample_trade], window_seconds="90")
    )
    assert status == 422
    assert any(
        "window_seconds" in str(d.get("loc", "")) for d in body["details"]
    )
    assert "call_count" not in mock_classify_trades


# ── Finding 1.1 (server side): Optional response fields ──────────────────


def test_classification_accepts_all_nulls_for_skipped_ticker(
    sample_trade: dict[str, Any],
) -> None:
    """When the matcher's ``_MAX_CELL_ROWS_PER_CLASSIFY`` overload-skip
    path fires, classification columns come back as nulls. The Pydantic
    response model must accept that contract end-to-end so the (future)
    TS Zod client doesn't reject it as ``schema_mismatch``.
    """
    skipped = multileg_routes.MultilegClassification.model_validate(
        {
            "id": "t1",
            "inferred_structure": None,
            "is_isolated_leg": None,
            "match_confidence": None,
            "pattern_group_id": None,
        }
    )
    assert skipped.id == "t1"
    assert skipped.inferred_structure is None
    assert skipped.is_isolated_leg is None
    assert skipped.match_confidence is None
    assert skipped.pattern_group_id is None


def test_handle_payload_passes_null_classification_through(
    monkeypatch, sample_classify_request_body: bytes
) -> None:
    """A matcher that emits null structure columns for one row (the
    overload-skip contract) round-trips through ``handle_classify_payload``
    without being transformed or stripped.
    """

    def fake(_request):
        return [
            {
                "id": "t1",
                "inferred_structure": None,
                "is_isolated_leg": None,
                "match_confidence": None,
                "pattern_group_id": None,
            }
        ]

    monkeypatch.setattr(multileg_routes, "_classify_with_polars", fake)
    status, body = multileg_routes.handle_classify_payload(
        sample_classify_request_body
    )
    assert status == 200
    assert body == {
        "classifications": [
            {
                "id": "t1",
                "inferred_structure": None,
                "is_isolated_leg": None,
                "match_confidence": None,
                "pattern_group_id": None,
            }
        ]
    }


def test_classification_rejects_extra_field(
    sample_trade: dict[str, Any],
) -> None:
    """``MultilegClassification`` keeps ``extra='forbid'`` under strict
    mode. An unexpected response column raises rather than silently
    propagating.
    """
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        multileg_routes.MultilegClassification.model_validate(
            {
                "id": "t1",
                "inferred_structure": "isolated_leg",
                "is_isolated_leg": True,
                "match_confidence": 0.42,
                "pattern_group_id": "g1",
                "rogue_field": "nope",
            }
        )
