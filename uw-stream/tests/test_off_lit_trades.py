"""Unit tests for OffLitTradesHandler._transform.

Covers the filtering pyramid (symbol → session window → ext-hours →
contingent → numeric validity), the field-by-field tuple shape against
the dark_pool_prints schema, and the timezone-aware session check.

DB writes are not exercised here — those land via the soak window
described in
docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from handlers.off_lit_trades import (
    _COLUMNS,
    OffLitTradesHandler,
    _in_ct_session,
    _parse_date,
    _parse_iso,
    _to_decimal,
    _to_int,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "off_lit_trades_sample.json"

_CT = ZoneInfo("America/Chicago")


@pytest.fixture
def payload() -> dict:
    with open(_FIXTURE_PATH) as f:
        return json.load(f)


@pytest.fixture
def handler() -> OffLitTradesHandler:
    return OffLitTradesHandler()


# ------------------------------------------------------------------
# Happy path — SPY print inside the session window
# ------------------------------------------------------------------


class TestTransform:
    def test_returns_tuple_with_correct_arity(self, handler, payload):
        row = handler._transform(payload)
        assert row is not None
        assert len(row) == len(_COLUMNS)

    def test_column_index_lookup(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["symbol"]] == "SPY"
        # 14:35 UTC = 09:35 CT on 2026-04-22 (still on CDT, UTC-5)
        assert row[idx["date"]] == date(2026, 4, 22)

    def test_executed_at_parsed_to_utc_aware_datetime(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        ts = row[idx["executed_at"]]
        assert isinstance(ts, datetime)
        assert ts.tzinfo is not None
        assert ts == datetime(2026, 4, 22, 14, 35, 0, tzinfo=UTC)

    def test_string_priced_fields_become_decimal(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["price"]] == Decimal("585.42")
        assert row[idx["nbbo_bid"]] == Decimal("585.40")
        assert row[idx["nbbo_ask"]] == Decimal("585.43")
        assert row[idx["avg30_volume"]] == Decimal("75000000.0")

    def test_premium_computed_at_ingest(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        # 585.42 * 1500 = 878130.00
        assert row[idx["premium"]] == Decimal("878130.00")

    def test_int_fields_parsed(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["size"]] == 1500
        assert row[idx["volume"]] == 45200000
        assert row[idx["nbbo_bid_quantity"]] == 800
        assert row[idx["nbbo_ask_quantity"]] == 1200

    def test_metadata_passthrough(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["sector"]] == "ETF"
        assert row[idx["issue_type"]] == "ETF"
        assert row[idx["type"]] == "off_lit"
        assert row[idx["trade_settlement"]] == "regular"

    def test_null_fields_preserved_as_none(self, handler, payload):
        row = handler._transform(payload)
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["trade_code"]] is None
        assert row[idx["ext_hour_sold_codes"]] is None
        assert row[idx["sale_cond_codes"]] is None
        assert row[idx["next_earnings_date"]] is None
        assert row[idx["marketcap"]] is None


# ------------------------------------------------------------------
# Filter drops — every reason a payload should NOT become a row
# ------------------------------------------------------------------


class TestFilterDrops:
    def test_drops_off_symbol(self, handler, payload):
        payload["symbol"] = "AAPL"
        assert handler._transform(payload) is None

    def test_drops_unknown_symbol(self, handler, payload):
        payload["symbol"] = None
        assert handler._transform(payload) is None

    def test_keeps_qqq(self, handler, payload):
        payload["symbol"] = "QQQ"
        row = handler._transform(payload)
        assert row is not None
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["symbol"]] == "QQQ"

    def test_drops_premarket_print_outside_session(self, handler, payload):
        # 12:00 UTC = 07:00 CT on 2026-04-22 — before 08:30
        payload["executed_at"] = "2026-04-22T12:00:00Z"
        assert handler._transform(payload) is None

    def test_drops_postmarket_print_outside_session(self, handler, payload):
        # 21:00 UTC = 16:00 CT on 2026-04-22 — after 15:00
        payload["executed_at"] = "2026-04-22T21:00:00Z"
        assert handler._transform(payload) is None

    def test_keeps_print_at_session_open(self, handler, payload):
        # 13:30 UTC = 08:30 CT on 2026-04-22 — exactly at open (inclusive)
        payload["executed_at"] = "2026-04-22T13:30:00Z"
        assert handler._transform(payload) is not None

    def test_drops_print_at_session_close(self, handler, payload):
        # 20:00 UTC = 15:00 CT on 2026-04-22 — exactly at close (exclusive)
        payload["executed_at"] = "2026-04-22T20:00:00Z"
        assert handler._transform(payload) is None

    def test_drops_extended_hours_coded_print(self, handler, payload):
        payload["ext_hour_sold_codes"] = "extended_hours_trade"
        assert handler._transform(payload) is None

    def test_keeps_other_ext_hour_codes(self, handler, payload):
        # Non-canonical ext-hour codes are stored — only the exact
        # 'extended_hours_trade' value triggers the drop per memory rule.
        payload["ext_hour_sold_codes"] = "some_other_code"
        row = handler._transform(payload)
        assert row is not None
        idx = {name: i for i, name in enumerate(_COLUMNS)}
        assert row[idx["ext_hour_sold_codes"]] == "some_other_code"

    def test_drops_contingent_trade(self, handler, payload):
        payload["sale_cond_codes"] = "contingent_trade"
        assert handler._transform(payload) is None

    def test_drops_contingent_trade_within_compound_codes(self, handler, payload):
        # UW sometimes emits multi-code strings; the marker can appear
        # alongside other condition codes
        payload["sale_cond_codes"] = "regular,contingent_trade"
        assert handler._transform(payload) is None

    def test_drops_missing_executed_at(self, handler, payload):
        payload["executed_at"] = None
        assert handler._transform(payload) is None

    def test_drops_malformed_executed_at(self, handler, payload):
        payload["executed_at"] = "not-an-iso-string"
        assert handler._transform(payload) is None

    def test_drops_zero_price(self, handler, payload):
        payload["price"] = "0"
        assert handler._transform(payload) is None

    def test_drops_zero_size(self, handler, payload):
        payload["size"] = 0
        assert handler._transform(payload) is None

    def test_drops_missing_price(self, handler, payload):
        payload["price"] = None
        assert handler._transform(payload) is None


# ------------------------------------------------------------------
# Helpers — exercise the coercion / parse functions directly
# ------------------------------------------------------------------


class TestHelpers:
    def test_to_decimal_handles_string(self):
        assert _to_decimal("150.25") == Decimal("150.25")

    def test_to_decimal_handles_number(self):
        assert _to_decimal(150.25) == Decimal("150.25")

    def test_to_decimal_returns_none_for_empty(self):
        assert _to_decimal(None) is None
        assert _to_decimal("") is None

    def test_to_decimal_returns_none_for_garbage(self):
        assert _to_decimal("abc") is None

    def test_to_int_rounds_floats(self):
        assert _to_int(1500.0) == 1500
        assert _to_int("1500") == 1500

    def test_to_int_returns_none_for_empty(self):
        assert _to_int(None) is None
        assert _to_int("") is None

    def test_parse_iso_accepts_z_suffix(self):
        ts = _parse_iso("2026-04-22T14:35:00Z")
        assert ts == datetime(2026, 4, 22, 14, 35, 0, tzinfo=UTC)

    def test_parse_iso_accepts_offset_suffix(self):
        ts = _parse_iso("2026-04-22T14:35:00+00:00")
        assert ts == datetime(2026, 4, 22, 14, 35, 0, tzinfo=UTC)

    def test_parse_iso_rejects_naive_string(self):
        # No tzinfo means we can't safely localize; drop rather than guess
        assert _parse_iso("2026-04-22T14:35:00") is None

    def test_parse_iso_rejects_garbage(self):
        assert _parse_iso("not-a-date") is None
        assert _parse_iso(None) is None
        assert _parse_iso("") is None

    def test_parse_date_accepts_iso_date(self):
        assert _parse_date("2024-10-25") == date(2024, 10, 25)

    def test_parse_date_returns_none_for_empty(self):
        assert _parse_date(None) is None
        assert _parse_date("") is None

    def test_parse_date_returns_none_for_garbage(self):
        assert _parse_date("not-a-date") is None

    def test_in_ct_session_accepts_open_inclusive(self):
        # 08:30:00 CT exactly
        dt = datetime(2026, 4, 22, 8, 30, 0, tzinfo=_CT).astimezone(UTC)
        assert _in_ct_session(dt) is True

    def test_in_ct_session_rejects_close_exclusive(self):
        # 15:00:00 CT exactly — exclusive
        dt = datetime(2026, 4, 22, 15, 0, 0, tzinfo=_CT).astimezone(UTC)
        assert _in_ct_session(dt) is False

    def test_in_ct_session_accepts_just_before_close(self):
        dt = datetime(2026, 4, 22, 14, 59, 59, tzinfo=_CT).astimezone(UTC)
        assert _in_ct_session(dt) is True

    def test_in_ct_session_rejects_just_before_open(self):
        dt = datetime(2026, 4, 22, 8, 29, 59, tzinfo=_CT).astimezone(UTC)
        assert _in_ct_session(dt) is False


# ------------------------------------------------------------------
# enqueue short-circuit — non-target symbols never hit the queue
# ------------------------------------------------------------------


class TestEnqueueShortCircuit:
    @pytest.mark.asyncio
    async def test_off_symbol_payload_does_not_enqueue(self, handler):
        await handler.enqueue({"symbol": "AAPL"})
        assert handler.queue.qsize() == 0

    @pytest.mark.asyncio
    async def test_off_symbol_does_not_increment_drop_count(self, handler):
        from state import state

        before = state.channel("off_lit_trades").drop_count
        await handler.enqueue({"symbol": "AAPL"})
        after = state.channel("off_lit_trades").drop_count
        # Non-target payloads are not "drops" — they were never wanted
        assert after == before

    @pytest.mark.asyncio
    async def test_spy_payload_enqueues(self, handler, payload):
        await handler.enqueue(payload)
        assert handler.queue.qsize() == 1
        # Drain so the next test starts clean
        handler.queue.get_nowait()
        handler.queue.task_done()

    @pytest.mark.asyncio
    async def test_qqq_payload_enqueues(self, handler, payload):
        payload["symbol"] = "QQQ"
        await handler.enqueue(payload)
        assert handler.queue.qsize() == 1
        handler.queue.get_nowait()
        handler.queue.task_done()

    @pytest.mark.asyncio
    async def test_missing_symbol_does_not_enqueue(self, handler):
        await handler.enqueue({})
        assert handler.queue.qsize() == 0
