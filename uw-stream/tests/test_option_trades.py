"""Unit tests for OptionTradesHandler._transform.

DB writes are not exercised here — those are covered by parity-soak
during Phase 2 of the Lottery Finder rollout. These tests only verify
the payload-to-row mapping, type coercion, and rejection logic at the
handler boundary.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from handlers.option_trades import (
    _COLUMNS,
    OptionTradesHandler,
    _derive_side,
    _ms_epoch_to_dt,
    _to_bool,
    _to_decimal,
    _to_int,
    _to_uuid,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "option_trades_sample.json"


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> OptionTradesHandler:
    return OptionTradesHandler()


@pytest.fixture
def col_idx() -> dict[str, int]:
    return {name: i for i, name in enumerate(_COLUMNS)}


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_parsed_occ_fields(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["option_chain"]] == "SNDK260501C01175000"
        assert row[col_idx["option_type"]] == "C"
        assert row[col_idx["strike"]] == Decimal("1175.000")
        assert row[col_idx["expiry"]] == date(2026, 5, 1)
        assert row[col_idx["ticker"]] == "SNDK"

    def test_executed_at_from_ms_epoch(self, handler, payload, col_idx):
        row = handler._transform(payload)
        ts = row[col_idx["executed_at"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        # 1777663500000 ms = 2026-05-01T19:25:00+00:00 (= 14:25 CT)
        assert ts == datetime(2026, 5, 1, 19, 25, 0, tzinfo=UTC)

    def test_string_priced_fields_become_decimal(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["price"]] == Decimal("0.55")
        assert row[col_idx["underlying_price"]] == Decimal("1170.85")
        assert row[col_idx["implied_volatility"]] == Decimal("0.412")
        assert row[col_idx["delta"]] == Decimal("0.182")

    def test_side_derived_from_tags(self, handler, payload, col_idx):
        # Fixture has tags: ['ask_side', 'bullish']
        row = handler._transform(payload)
        assert row[col_idx["side"]] == "ask"

    def test_canceled_false_when_omitted(self, handler, payload, col_idx):
        # `canceled: false` is in the fixture; verify it lands as bool False,
        # not None (column is NOT NULL DEFAULT FALSE).
        row = handler._transform(payload)
        assert row[col_idx["canceled"]] is False

    def test_canceled_defaults_to_false_when_payload_omits_it(
        self,
        handler,
        payload,
        col_idx,
    ):
        del payload["canceled"]
        row = handler._transform(payload)
        assert row[col_idx["canceled"]] is False

    def test_open_interest_typed_to_int(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["open_interest"]] == 1450

    def test_raw_payload_round_trips(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["raw_payload"]] is payload

    def test_ws_trade_id_is_typed_uuid(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert isinstance(row[col_idx["ws_trade_id"]], UUID)


class TestFieldNameAliases:
    """UW historically varies field names for the OCC symbol, tape time,
    and OI. The handler accepts the common spellings so a wire-format
    drift doesn't silently start dropping every payload."""

    def test_accepts_option_chain_id_alias(self, handler, payload, col_idx):
        del payload["option_chain"]
        payload["option_chain_id"] = "SNDK260501C01175000"
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["option_chain"]] == "SNDK260501C01175000"

    def test_accepts_option_symbol_alias(self, handler, payload, col_idx):
        del payload["option_chain"]
        payload["option_symbol"] = "SNDK260501C01175000"
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["option_chain"]] == "SNDK260501C01175000"

    def test_accepts_tape_time_alias(self, handler, payload, col_idx):
        del payload["executed_at"]
        payload["tape_time"] = 1777663500000
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["executed_at"]] == datetime(
            2026,
            5,
            1,
            19,
            25,
            0,
            tzinfo=UTC,
        )

    def test_accepts_iv_alias(self, handler, payload, col_idx):
        del payload["implied_volatility"]
        payload["iv"] = "0.412"
        row = handler._transform(payload)
        assert row[col_idx["implied_volatility"]] == Decimal("0.412")

    def test_accepts_oi_alias(self, handler, payload, col_idx):
        del payload["open_interest"]
        payload["oi"] = 1450
        row = handler._transform(payload)
        assert row[col_idx["open_interest"]] == 1450

    def test_falls_back_to_occ_root_when_underlying_symbol_missing(
        self,
        handler,
        payload,
        col_idx,
    ):
        del payload["underlying_symbol"]
        row = handler._transform(payload)
        assert row[col_idx["ticker"]] == "SNDK"


class TestRejection:
    def test_missing_occ_symbol_returns_none(self, handler, payload):
        del payload["option_chain"]
        assert handler._transform(payload) is None

    def test_malformed_occ_returns_none(self, handler, payload):
        payload["option_chain"] = "NOTANOCC"
        assert handler._transform(payload) is None

    def test_missing_id_returns_none(self, handler, payload):
        # ws_trade_id is the table's NOT NULL UNIQUE key.
        del payload["id"]
        assert handler._transform(payload) is None

    def test_malformed_id_returns_none(self, handler, payload):
        payload["id"] = "not-a-uuid"
        assert handler._transform(payload) is None

    def test_missing_executed_at_returns_none(self, handler, payload):
        del payload["executed_at"]
        assert handler._transform(payload) is None

    def test_zero_price_returns_none(self, handler, payload):
        # NOT NULL price column AND v4 detector filter price > 0 — drop
        # at ingest rather than poison the table.
        payload["price"] = "0"
        assert handler._transform(payload) is None

    def test_negative_price_returns_none(self, handler, payload):
        payload["price"] = "-0.05"
        assert handler._transform(payload) is None

    def test_zero_size_returns_none(self, handler, payload):
        payload["size"] = 0
        assert handler._transform(payload) is None

    def test_missing_size_returns_none(self, handler, payload):
        del payload["size"]
        assert handler._transform(payload) is None


class TestSideDerivation:
    @pytest.mark.parametrize(
        "tags,expected",
        [
            (["ask_side", "bullish"], "ask"),
            (["bid_side", "bearish"], "bid"),
            (["mid_side", "neutral"], "mid"),
            (["bullish"], "no_side"),  # no side tag → no_side fallback
            ([], "no_side"),
            (None, "no_side"),
            ("not_a_list", "no_side"),
            (["ask_side", "bid_side"], "ask"),  # first match wins
        ],
    )
    def test_derive(self, tags, expected):
        assert _derive_side(tags) == expected


class TestToDecimal:
    """Type coercion for the priced columns (price, IV, delta, etc.)."""

    def test_empty_string_returns_none(self):
        # UW occasionally sends "" for absent numeric fields; coalesce to
        # None so the column lands NULL rather than raising.
        assert _to_decimal("") is None

    def test_none_returns_none(self):
        assert _to_decimal(None) is None

    def test_numeric_string_parses(self):
        assert _to_decimal("0.55") == Decimal("0.55")

    def test_garbage_string_returns_none(self):
        # InvalidOperation/ValueError on a non-numeric string is swallowed.
        assert _to_decimal("not-a-number") is None


class TestToInt:
    """Type coercion for integer columns (size, open_interest)."""

    def test_empty_string_returns_none(self):
        assert _to_int("") is None

    def test_none_returns_none(self):
        assert _to_int(None) is None

    def test_numeric_string_parses(self):
        assert _to_int("1450") == 1450

    def test_decimal_string_truncates_via_decimal(self):
        # Goes through Decimal("1450.0") → int, so a float-shaped string parses.
        assert _to_int("1450.0") == 1450

    def test_garbage_string_returns_none(self):
        assert _to_int("not-a-number") is None


class TestToBool:
    """Type coercion for the `canceled` flag — UW has sent bool, str, and
    int spellings historically, so accept all three."""

    @pytest.mark.parametrize(
        "value,expected",
        [
            (None, None),
            (True, True),
            (False, False),
            ("true", True),
            ("T", True),
            ("1", True),
            ("yes", True),
            ("  True  ", True),  # whitespace-stripped, case-folded
            ("false", False),
            ("f", False),
            ("0", False),
            ("no", False),
            ("maybe", None),  # unrecognised string → None
            (1, True),
            (0, False),
            (2.5, True),  # any non-zero numeric is truthy
            ([], None),  # unsupported type → None
        ],
    )
    def test_coerce(self, value, expected):
        assert _to_bool(value) is expected


class TestMsEpochToDt:
    """ms-epoch → tz-aware datetime coercion for executed_at."""

    def test_empty_string_returns_none(self):
        assert _ms_epoch_to_dt("") is None

    def test_none_returns_none(self):
        assert _ms_epoch_to_dt(None) is None

    def test_numeric_string_parses(self):
        assert _ms_epoch_to_dt("1777663500000") == datetime(
            2026,
            5,
            1,
            19,
            25,
            0,
            tzinfo=UTC,
        )

    def test_garbage_string_returns_none(self):
        assert _ms_epoch_to_dt("not-a-number") is None


class TestToUuid:
    """ws_trade_id coercion — the table's NOT NULL UNIQUE dedupe key."""

    def test_none_returns_none(self):
        assert _to_uuid(None) is None

    def test_empty_string_returns_none(self):
        assert _to_uuid("") is None

    def test_passthrough_existing_uuid(self):
        # Already-typed UUID is returned as-is, not re-parsed.
        u = UUID("12345678-1234-5678-1234-567812345678")
        assert _to_uuid(u) is u

    def test_uuid_string_parses(self):
        assert _to_uuid("12345678-1234-5678-1234-567812345678") == UUID(
            "12345678-1234-5678-1234-567812345678",
        )

    def test_garbage_string_returns_none(self):
        assert _to_uuid("not-a-uuid") is None
