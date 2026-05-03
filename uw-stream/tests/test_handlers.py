"""Unit tests for FlowAlertsHandler._transform.

DB writes are not exercised here — those are covered by the soak
window described in
docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md
where daemon and cron co-write the same data and a parity report is
generated.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from handlers.flow_alerts import (
    _COLUMNS,
    FlowAlertsHandler,
    _ms_epoch_to_dt,
    _to_bool,
    _to_decimal,
    _to_int,
    _to_uuid,
)

_FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "flow_alerts_sample.json"
)


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> FlowAlertsHandler:
    return FlowAlertsHandler()


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_parsed_ticker_and_issue_type(self, handler, payload):
        row = handler._transform(payload)
        # Column index lookups via name.
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["ticker"]] == "DIA"
        assert row[idx["issue_type"]] == "ETF"  # DIA is in the lookup

    def test_parsed_occ_fields(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["expiry"]] == date(2024, 10, 18)
        assert row[idx["strike"]] == Decimal("415.000")
        assert row[idx["option_type"]] == "C"
        # Original symbol preserved verbatim for /option-contract/{symbol}/* lookups.
        assert row[idx["option_chain"]] == "DIA241018C00415000"

    def test_created_at_from_executed_at_ms_epoch(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        # 1726670212748 ms = 2024-09-18T14:36:52.748+00:00
        ts = row[idx["created_at"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        # Sanity check: same to-the-second value the fixture encodes.
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_string_priced_fields_become_decimal(self, handler, payload):
        # `bid` and `ask` arrive as strings on the wire even though the
        # rest of the numerics are JSON numbers.
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["bid"]] == Decimal("7.15")
        assert row[idx["ask"]] == Decimal("7.3")

    def test_raw_payload_round_trips(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        # The raw payload is stored as a dict for asyncpg's JSONB codec.
        assert row[idx["raw_payload"]] is payload


class TestTransformRejection:
    def test_missing_option_chain_returns_none(self, handler, payload):
        del payload["option_chain"]
        assert handler._transform(payload) is None

    def test_malformed_option_chain_returns_none(self, handler, payload):
        payload["option_chain"] = "NOTANOCC"
        assert handler._transform(payload) is None

    def test_missing_executed_at_returns_none(self, handler, payload):
        del payload["executed_at"]
        assert handler._transform(payload) is None

    def test_missing_id_returns_none(self, handler, payload):
        # ws_alert_id is the table's NOT NULL UNIQUE key; missing UUID
        # must reject the row rather than risk a NULL violation later.
        del payload["id"]
        assert handler._transform(payload) is None

    def test_malformed_id_returns_none(self, handler, payload):
        payload["id"] = "not-a-uuid"
        assert handler._transform(payload) is None

    def test_ws_alert_id_is_typed_uuid(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert isinstance(row[idx["ws_alert_id"]], UUID)


class TestTypeCoercion:
    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            ("", None),
            (123, Decimal("123")),
            (1.5, Decimal("1.5")),
            ("1.5", Decimal("1.5")),
            ("not-a-number", None),
        ],
    )
    def test_to_decimal(self, v, expected):
        assert _to_decimal(v) == expected

    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            ("", None),
            (5, 5),
            (5.7, 5),  # truncates via Decimal cast
            ("5", 5),
            ("not", None),
        ],
    )
    def test_to_int(self, v, expected):
        assert _to_int(v) == expected

    @pytest.mark.parametrize(
        "v,expected",
        [
            (None, None),
            (True, True),
            (False, False),
            ("true", True),
            ("FALSE", False),
            ("1", True),
            ("0", False),
            (1, True),
            (0, False),
            ("garbage", None),
        ],
    )
    def test_to_bool(self, v, expected):
        assert _to_bool(v) == expected

    def test_ms_epoch_to_dt(self):
        ts = _ms_epoch_to_dt(1726670212748)
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_ms_epoch_handles_string_input(self):
        ts = _ms_epoch_to_dt("1726670212748")
        assert ts == datetime(2024, 9, 18, 14, 36, 52, 748000, tzinfo=UTC)

    def test_ms_epoch_returns_none_on_garbage(self):
        assert _ms_epoch_to_dt("not-a-number") is None
        assert _ms_epoch_to_dt(None) is None
        assert _ms_epoch_to_dt("") is None

    @pytest.mark.parametrize(
        "v,expected",
        [
            ("29ed5829-e4ce-4934-876b-51985d2f9b70",
             UUID("29ed5829-e4ce-4934-876b-51985d2f9b70")),
            (UUID("29ed5829-e4ce-4934-876b-51985d2f9b70"),
             UUID("29ed5829-e4ce-4934-876b-51985d2f9b70")),
            (None, None),
            ("", None),
            ("not-a-uuid", None),
            (12345, None),
        ],
    )
    def test_to_uuid(self, v, expected):
        assert _to_uuid(v) == expected
