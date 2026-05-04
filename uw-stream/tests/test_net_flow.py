"""Unit tests for NetFlowHandler._transform.

DB writes are not exercised here — those are covered by parity-soak
during the Net Flow rollout. These tests only verify the
payload-to-row mapping, type coercion, and rejection logic at the
handler boundary.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

from handlers.net_flow import _COLUMNS, NetFlowHandler

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "net_flow_sample.json"


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> NetFlowHandler:
    return NetFlowHandler()


@pytest.fixture
def col_idx() -> dict[str, int]:
    return {name: i for i, name in enumerate(_COLUMNS)}


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_preserves_ticker(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["ticker"]] == "TSLA"

    def test_time_ms_epoch_to_dt(self, handler, payload, col_idx):
        row = handler._transform(payload)
        ts = row[col_idx["ts"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        # 1777662000000 ms = 2026-05-01T19:00:00Z = 14:00 CDT
        assert ts == datetime(2026, 5, 1, 19, 0, 0, tzinfo=UTC)

    def test_string_priced_fields_become_decimal(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["net_call_prem"]] == Decimal("1716.00")
        assert row[col_idx["net_put_prem"]] == Decimal("1990.00")

    def test_int_volume_fields(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["net_call_vol"]] == 6
        assert row[col_idx["net_put_vol"]] == 17

    def test_raw_payload_round_trips(self, handler, payload, col_idx):
        row = handler._transform(payload)
        assert row[col_idx["raw_payload"]] is payload

    def test_negative_deltas_preserved(self, handler, payload, col_idx):
        # UW emits negative ncp/ncv when puts dominate the prior tick.
        # NUMERIC + INTEGER columns accept negatives; the schema is fine.
        payload["net_call_prem"] = "-12500.50"
        payload["net_call_vol"] = -42
        row = handler._transform(payload)
        assert row[col_idx["net_call_prem"]] == Decimal("-12500.50")
        assert row[col_idx["net_call_vol"]] == -42


class TestFieldNameAliases:
    """UW historically varies the timestamp key — defensive aliases."""

    def test_accepts_tape_time_alias(self, handler, payload, col_idx):
        del payload["time"]
        payload["tape_time"] = 1777662000000
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["ts"]] == datetime(2026, 5, 1, 19, 0, 0, tzinfo=UTC)

    def test_accepts_timestamp_alias(self, handler, payload, col_idx):
        del payload["time"]
        payload["timestamp"] = 1777662000000
        row = handler._transform(payload)
        assert row is not None
        assert row[col_idx["ts"]] == datetime(2026, 5, 1, 19, 0, 0, tzinfo=UTC)


class TestRejection:
    def test_missing_ticker_returns_none(self, handler, payload):
        del payload["ticker"]
        assert handler._transform(payload) is None

    def test_empty_ticker_returns_none(self, handler, payload):
        payload["ticker"] = ""
        assert handler._transform(payload) is None

    def test_non_string_ticker_returns_none(self, handler, payload):
        payload["ticker"] = 123
        assert handler._transform(payload) is None

    def test_missing_time_returns_none(self, handler, payload):
        del payload["time"]
        assert handler._transform(payload) is None

    def test_unparseable_time_returns_none(self, handler, payload):
        payload["time"] = "not-a-number"
        assert handler._transform(payload) is None

    def test_missing_net_call_prem_returns_none(self, handler, payload):
        # All four numeric fields are NOT NULL in the schema; any
        # missing one rejects the row.
        del payload["net_call_prem"]
        assert handler._transform(payload) is None

    def test_missing_net_put_prem_returns_none(self, handler, payload):
        del payload["net_put_prem"]
        assert handler._transform(payload) is None

    def test_missing_net_call_vol_returns_none(self, handler, payload):
        del payload["net_call_vol"]
        assert handler._transform(payload) is None

    def test_missing_net_put_vol_returns_none(self, handler, payload):
        del payload["net_put_vol"]
        assert handler._transform(payload) is None

    def test_unparseable_numeric_returns_none(self, handler, payload):
        payload["net_call_prem"] = "garbage"
        assert handler._transform(payload) is None
