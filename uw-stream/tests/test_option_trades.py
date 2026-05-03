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
    _normalise_side,
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

    def test_side_passes_through_when_canonical(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["side"]] == "ask"

    def test_canceled_false_when_omitted(self, handler, payload, col_idx):
        # `canceled: false` is in the fixture; verify it lands as bool False,
        # not None (column is NOT NULL DEFAULT FALSE).
        row = handler._transform(payload)
        assert row[col_idx["canceled"]] is False

    def test_canceled_defaults_to_false_when_payload_omits_it(
        self, handler, payload, col_idx,
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
            2026, 5, 1, 19, 25, 0, tzinfo=UTC,
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
        self, handler, payload, col_idx,
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

    def test_unknown_side_returns_none(self, handler, payload):
        # Side CHECK constraint allows only ask/bid/mid/no_side; reject
        # unknown values rather than let the DB do it.
        payload["side"] = "stock_exchange"
        assert handler._transform(payload) is None

    def test_missing_size_returns_none(self, handler, payload):
        del payload["size"]
        assert handler._transform(payload) is None


class TestSideNormalisation:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("ask", "ask"),
            ("ASK", "ask"),
            (" bid ", "bid"),
            ("mid", "mid"),
            ("no_side", "no_side"),
            ("multi", None),
            ("", None),
            (None, None),
            (123, None),
        ],
    )
    def test_normalise(self, raw, expected):
        assert _normalise_side(raw) == expected
