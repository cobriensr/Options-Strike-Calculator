"""Unit tests for FuturesTradesHandler.

Covers the two halves of the handler:

- ``_transform`` — the stateless per-print normalizer: target-product
  equality filter (micros excluded), Decimal price parsing, epoch-ms
  minute flooring, and defensive rejection of malformed prints.
- ``_flush`` — the stateful bar aggregator: per-print dedup, front-month
  selection by cumulative session volume, OHLCV folding, and the
  completed-minutes-only emit rule that keeps
  ``ON CONFLICT DO NOTHING`` correct.

Payload shape and ``executed_at`` units were captured from the live UW
feed on 2026-09-08 (see the handler module docstring).
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

from handlers import futures_trades as ft
from handlers.futures_trades import (
    _COLUMNS,
    _TARGET_PRODUCTS,
    FuturesTradesHandler,
    _floor_to_minute,
    _to_decimal,
    _to_int,
)
from logger_setup import MALFORMED_PAYLOAD_LOG_INTERVAL_S, JsonFormatter, log
from utils import timestamps

# 2026-09-08T05:56:51.311Z — a real timestamp from the live probe.
_BASE_MS = 1788847011311
# Floor of _BASE_MS to the minute: 05:56:00Z
_BASE_MINUTE = datetime(2026, 9, 8, 5, 56, 0, tzinfo=UTC)

# Pinned wall clock for the whole module. timestamps.parse_timestamp rejects
# timestamps more than MAX_FUTURE_SKEW_MS ahead of now, and several
# fixtures below deliberately span 2-3 UTC days from _BASE_MS; without a
# pinned clock those would start failing the moment real time drifts
# behind the fixture dates. 10 days of headroom covers every fixture.
_PINNED_NOW_MS = _BASE_MS + 10 * 86_400_000

_C = {name: i for i, name in enumerate(_COLUMNS)}


@pytest.fixture(autouse=True)
def _pin_wall_clock(monkeypatch):
    """Pin ``_now_ms`` so the future-timestamp bound is deterministic."""
    monkeypatch.setattr(timestamps, "_now_ms", lambda: _PINNED_NOW_MS)


def _floor_minute_utc(v):
    """Parse + floor, the way ``_transform`` does it.

    Composed from the two production helpers rather than being a helper
    of its own, so these assertions exercise the code the handler
    actually runs.
    """
    parsed = timestamps.parse_timestamp(v)
    return None if parsed is None else _floor_to_minute(parsed)


def _print(
    *,
    product: str = "ES",
    sym: str = "ESU6",
    executed_at: int | str = _BASE_MS,
    price: str = "7706.25",
    size: int | str = 1,
    trade_id: int | str | None = 1,
    side: str = "sell",
    is_spread: bool | None = None,
    is_block: bool = False,
) -> dict:
    """Build a futures_trades payload matching the live wire shape.

    Live websocket frames carry exactly these 11 keys (Phase 0b capture,
    2026-10-28). ``is_spread`` exists only on REST, so it is added only
    when a test passes it.
    """
    payload = {
        "sym": sym,
        "product": product,
        "exchange": "XCME",
        "executed_at": executed_at,
        "price": price,
        "size": size,
        "side": side,
        "nbbo_bid": "7706.00",
        "nbbo_ask": "7706.25",
        "trade_id": trade_id,
        "is_block": is_block,
    }
    if is_spread is not None:
        payload["is_spread"] = is_spread
    return payload


def _without(payload: dict, *keys: str) -> dict:
    """Drop keys from a payload, for frames that omit a field entirely."""
    for key in keys:
        del payload[key]
    return payload


@pytest.fixture
def handler() -> FuturesTradesHandler:
    return FuturesTradesHandler()


async def _flush_capture(handler: FuturesTradesHandler, payloads: list[dict]):
    """Run payloads through _transform then _flush, capturing DB rows."""
    rows = [r for r in (handler._transform(p) for p in payloads) if r is not None]
    captured: list[list[tuple]] = []

    def capture(**kwargs):
        captured.append(list(kwargs["rows"]))
        return len(kwargs["rows"])

    with patch("handlers.futures_trades.db") as mock_db:
        mock_db.bulk_insert_ignore_conflict = AsyncMock(side_effect=capture)
        await handler._flush(rows)

    return captured[0] if captured else []


# ----------------------------------------------------------------------
# 1. OHLCV correctness within one completed minute
# ----------------------------------------------------------------------


class TestOhlcv:
    @pytest.mark.asyncio
    async def test_open_high_low_close_volume(self, handler):
        # Four prints inside minute 05:56, deliberately NOT in price
        # order, plus one print in 05:57 to complete the 05:56 minute.
        payloads = [
            _print(executed_at=_BASE_MS + 0, price="7706.25", size=2, trade_id=1),
            _print(executed_at=_BASE_MS + 100, price="7709.00", size=3, trade_id=2),
            _print(executed_at=_BASE_MS + 200, price="7701.50", size=4, trade_id=3),
            _print(executed_at=_BASE_MS + 300, price="7707.75", size=1, trade_id=4),
            # Next minute — completes 05:56 without being emitted itself.
            _print(executed_at=_BASE_MS + 60_000, price="7800.00", size=9, trade_id=5),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        row = rows[0]
        assert row[_C["symbol"]] == "ES"
        assert row[_C["ts"]] == _BASE_MINUTE
        assert row[_C["open"]] == Decimal("7706.25")  # earliest print
        assert row[_C["close"]] == Decimal("7707.75")  # latest print
        assert row[_C["high"]] == Decimal("7709.00")
        assert row[_C["low"]] == Decimal("7701.50")
        assert row[_C["volume"]] == 10  # 2+3+4+1

    @pytest.mark.asyncio
    async def test_open_close_follow_executed_at_not_arrival_order(self, handler):
        """Out-of-order arrival must not corrupt open/close.

        UW can deliver a print slightly out of sequence; open/close are
        defined by ``executed_at``, not by the order rows reach _flush.
        """
        payloads = [
            _print(executed_at=_BASE_MS + 500, price="7710.00", trade_id=2),
            _print(executed_at=_BASE_MS + 100, price="7700.00", trade_id=1),
            _print(executed_at=_BASE_MS + 60_000, price="7800.00", trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["open"]] == Decimal("7700.00")  # earliest executed_at
        assert rows[0][_C["close"]] == Decimal("7710.00")  # latest executed_at

    @pytest.mark.asyncio
    async def test_row_arity_matches_columns(self, handler):
        payloads = [
            _print(trade_id=1),
            _print(executed_at=_BASE_MS + 60_000, trade_id=2),
        ]
        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 1
        assert len(rows[0]) == len(_COLUMNS)


# ----------------------------------------------------------------------
# 2. Micro exclusion — MES must not contribute to the ES bar
# ----------------------------------------------------------------------


class TestMicroExclusion:
    def test_micro_products_rejected_by_transform(self, handler):
        for micro in ("MES", "MNQ", "MGC", "MYM", "M2K"):
            assert handler._transform(_print(product=micro, sym=f"{micro}U6")) is None

    def test_target_products_are_exactly_the_six(self):
        assert set(_TARGET_PRODUCTS) == {"ES", "NQ", "RTY", "CL", "GC", "ZN"}
        # Micros are separate product values, never a prefix of a target.
        for micro in ("MES", "MNQ", "MGC", "MYM", "M2K"):
            assert micro not in _TARGET_PRODUCTS

    @pytest.mark.asyncio
    async def test_mes_volume_does_not_leak_into_es_bar(self, handler):
        payloads = [
            _print(product="ES", sym="ESU6", price="7706.00", size=2, trade_id=1),
            # Same minute, micro contract, huge size + extreme prices.
            _print(
                product="MES",
                sym="MESU6",
                executed_at=_BASE_MS + 10,
                price="9999.00",
                size=500,
                trade_id=2,
            ),
            _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["symbol"]] == "ES"
        assert rows[0][_C["volume"]] == 2  # MES's 500 excluded
        assert rows[0][_C["high"]] == Decimal("7706.00")  # MES's 9999 excluded


# ----------------------------------------------------------------------
# 3. String price parsing — Decimal, never str
# ----------------------------------------------------------------------

# Decimal parses all of these without complaint, and each one used to
# escape: int(Decimal("Infinity")) raises OverflowError, Decimal("NaN")
# raises InvalidOperation on ``<= 0``, Infinity passes ``> 0``, and
# "1e400" is a finite Decimal that no float, price or size can hold.
_NON_FINITE = ("inf", "-Infinity", "NaN", "nan", "sNaN", "1e400", float("inf"), float("nan"))


class TestPriceParsing:
    def test_price_parsed_to_decimal(self, handler):
        # _Print is a NamedTuple — assert by FIELD NAME, never by index.
        # A positional assert silently passes on the wrong field if a
        # field is ever inserted ahead of it.
        row = handler._transform(_print(price="6612.25"))
        assert row is not None
        assert isinstance(row.price, Decimal)
        assert row.price == Decimal("6612.25")

    def test_full_precision_wire_format_parsed(self, handler):
        """Live feed sends 9 decimal places, e.g. '7706.000000000'."""
        row = handler._transform(_print(price="7706.000000000"))
        assert row is not None
        assert row.price == Decimal("7706")

    @pytest.mark.asyncio
    async def test_high_low_compare_numerically_not_lexicographically(self, handler):
        """String compare would make '999.00' > '1000.00'. Decimal must not."""
        payloads = [
            _print(product="CL", sym="CLV6", price="999.00", trade_id=1),
            _print(
                product="CL",
                sym="CLV6",
                executed_at=_BASE_MS + 10,
                price="1000.00",
                trade_id=2,
            ),
            _print(
                product="CL",
                sym="CLV6",
                executed_at=_BASE_MS + 60_000,
                trade_id=3,
            ),
        ]
        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 1
        assert rows[0][_C["high"]] == Decimal("1000.00")
        assert rows[0][_C["low"]] == Decimal("999.00")

    def test_to_decimal_rejects_garbage(self):
        assert _to_decimal(None) is None
        assert _to_decimal("") is None
        assert _to_decimal("abc") is None
        assert _to_decimal("7706.25") == Decimal("7706.25")

    def test_to_int_rejects_garbage(self):
        assert _to_int(None) is None
        assert _to_int("") is None
        assert _to_int("abc") is None
        assert _to_int("3") == 3
        assert _to_int(3) == 3

    def test_non_positive_price_or_size_rejected(self, handler):
        assert handler._transform(_print(price="0")) is None
        assert handler._transform(_print(price="-1")) is None
        assert handler._transform(_print(size=0)) is None
        assert handler._transform(_print(size=-5)) is None

    @pytest.mark.parametrize("raw", _NON_FINITE, ids=repr)
    def test_to_decimal_rejects_non_finite(self, raw):
        assert _to_decimal(raw) is None

    @pytest.mark.parametrize("raw", _NON_FINITE, ids=repr)
    def test_to_int_rejects_non_finite(self, raw):
        assert _to_int(raw) is None

    @pytest.mark.parametrize("price", ["NaN", "Infinity", "-Infinity", "1e400"])
    def test_non_finite_price_dropped_without_raising(self, handler, price):
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(_print(price=price)) is None
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert kinds == ["invalid_price_or_size"]

    # The last two parse to huge finite ints; summed into BIGINT volume they
    # would overflow the shared INSERT and lose every product's minutes.
    @pytest.mark.parametrize("size", ["inf", "NaN", "1e400", "1e20", "9223372036854775808"])
    def test_non_finite_or_oversized_size_dropped_without_raising(self, handler, size):
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(_print(size=size)) is None
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert kinds == ["invalid_price_or_size"]


# ----------------------------------------------------------------------
# 4. Minute flooring (epoch-ms, UTC)
# ----------------------------------------------------------------------


class TestMinuteFlooring:
    def test_executed_at_is_epoch_ms(self):
        """Verified against the live feed 2026-09-08."""
        assert _floor_minute_utc(1788847011311) == datetime(2026, 9, 8, 5, 56, 0, tzinfo=UTC)

    def test_start_and_end_of_minute_share_a_bucket(self):
        minute_start = 1788847020000  # 05:57:00.000Z exactly
        at_000_1 = minute_start + 100  # :00.1
        at_059_9 = minute_start + 59_900  # :59.9
        expected = datetime(2026, 9, 8, 5, 57, 0, tzinfo=UTC)
        assert _floor_minute_utc(at_000_1) == expected
        assert _floor_minute_utc(at_059_9) == expected

    def test_next_minute_starts_a_new_bucket(self):
        minute_start = 1788847020000  # 05:57:00.000Z
        at_060_0 = minute_start + 60_000  # :60.0 -> next minute
        assert _floor_minute_utc(at_060_0) == datetime(2026, 9, 8, 5, 58, 0, tzinfo=UTC)

    def test_exact_minute_boundary_floors_to_itself(self):
        assert _floor_minute_utc(1788847020000) == datetime(2026, 9, 8, 5, 57, 0, tzinfo=UTC)

    def test_result_is_utc_aware(self):
        ts = _floor_minute_utc(_BASE_MS)
        assert ts is not None
        assert ts.tzinfo is not None
        assert ts.utcoffset().total_seconds() == 0

    def test_iso8601_string_accepted_defensively(self):
        """Live feed sends epoch-ms ints; ISO is a defensive fallback."""
        assert _floor_minute_utc("2026-09-08T05:56:51.311Z") == datetime(
            2026, 9, 8, 5, 56, 0, tzinfo=UTC
        )

    def test_implausible_and_malformed_timestamps_rejected(self):
        assert _floor_minute_utc(None) is None
        assert _floor_minute_utc("") is None
        assert _floor_minute_utc("not-a-timestamp") is None
        # Epoch SECONDS misread as ms would land in 1970 — reject loudly
        # rather than writing garbage bars.
        assert _floor_minute_utc(1788847011) is None
        assert _floor_minute_utc(0) is None

    @pytest.mark.asyncio
    async def test_prints_across_minute_boundary_make_two_bars(self, handler):
        payloads = [
            _print(executed_at=1788847020100, price="7700.00", trade_id=1),  # :57
            _print(executed_at=1788847079900, price="7701.00", trade_id=2),  # :57
            _print(executed_at=1788847080000, price="7702.00", trade_id=3),  # :58
            _print(executed_at=1788847140000, price="7703.00", trade_id=4),  # :59
        ]
        rows = await _flush_capture(handler, payloads)

        # :57 and :58 are complete (:59 is newest, still in progress).
        assert [r[_C["ts"]] for r in rows] == [
            datetime(2026, 9, 8, 5, 57, tzinfo=UTC),
            datetime(2026, 9, 8, 5, 58, tzinfo=UTC),
        ]
        assert rows[0][_C["volume"]] == 2
        assert rows[1][_C["volume"]] == 1


# ----------------------------------------------------------------------
# 5. Front-month selection by cumulative session volume
# ----------------------------------------------------------------------


class TestFrontMonthSelection:
    @pytest.mark.asyncio
    async def test_higher_session_volume_contract_wins(self, handler):
        payloads = [
            # Front month ESU6: 10 lots.
            _print(sym="ESU6", price="7700.00", size=10, trade_id=1),
            # Back month ESZ6: 1 lot, wildly different price.
            _print(
                sym="ESZ6",
                executed_at=_BASE_MS + 10,
                price="7900.00",
                size=1,
                trade_id=2,
            ),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 10  # only ESU6
        assert rows[0][_C["high"]] == Decimal("7700.00")  # ESZ6's 7900 excluded

    @pytest.mark.asyncio
    async def test_roll_follows_liquidity_crossover(self, handler):
        """When the back month overtakes on session volume, it becomes front."""
        payloads = [
            # Minute :56 — ESU6 leads.
            _print(sym="ESU6", price="7700.00", size=5, trade_id=1),
            _print(
                sym="ESZ6",
                executed_at=_BASE_MS + 10,
                price="7900.00",
                size=1,
                trade_id=2,
            ),
            # Minute :57 — ESZ6 takes over on cumulative session volume.
            _print(
                sym="ESZ6",
                executed_at=_BASE_MS + 60_000,
                price="7910.00",
                size=50,
                trade_id=3,
            ),
            _print(
                sym="ESU6",
                executed_at=_BASE_MS + 60_010,
                price="7701.00",
                size=1,
                trade_id=4,
            ),
            # Minute :58 — completes :57.
            _print(sym="ESZ6", executed_at=_BASE_MS + 120_000, trade_id=5),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 2
        # :56 emitted while ESU6 still led (5 vs 1).
        assert rows[0][_C["close"]] == Decimal("7700.00")
        assert rows[0][_C["volume"]] == 5
        # :57 emitted after ESZ6 crossed over (51 vs 6).
        assert rows[1][_C["close"]] == Decimal("7910.00")
        assert rows[1][_C["volume"]] == 50

    @pytest.mark.asyncio
    async def test_front_month_is_per_product_not_global(self, handler):
        payloads = [
            _print(product="ES", sym="ESU6", price="7700.00", size=3, trade_id=1),
            _print(
                product="NQ",
                sym="NQU6",
                executed_at=_BASE_MS + 10,
                price="29000.00",
                size=7,
                trade_id=2,
            ),
            _print(
                product="ES",
                sym="ESU6",
                executed_at=_BASE_MS + 60_000,
                trade_id=3,
            ),
            _print(
                product="NQ",
                sym="NQU6",
                executed_at=_BASE_MS + 60_010,
                trade_id=4,
            ),
        ]
        rows = await _flush_capture(handler, payloads)

        by_symbol = {r[_C["symbol"]]: r for r in rows}
        assert set(by_symbol) == {"ES", "NQ"}
        assert by_symbol["ES"][_C["volume"]] == 3
        assert by_symbol["NQ"][_C["volume"]] == 7

    @pytest.mark.asyncio
    async def test_session_volume_tally_resets_on_new_utc_day(self, handler):
        day1 = _BASE_MS
        day2 = _BASE_MS + 86_400_000  # +24h, next UTC date
        payloads = [
            # Day 1: ESU6 dominates.
            _print(sym="ESU6", price="7700.00", size=100, trade_id=1),
            _print(sym="ESU6", executed_at=day1 + 60_000, trade_id=2),
            # Day 2: only ESZ6 trades. Without a reset, ESU6's stale 101
            # lots would keep it "front month" for the day-2 minute — and
            # since ESU6 has no bar in that minute, _collect_completed
            # would find no bar for the elected sym and emit NOTHING,
            # silently dropping the day-2 bar entirely.
            _print(sym="ESZ6", executed_at=day2, price="7950.00", size=4, trade_id=3),
            _print(sym="ESZ6", executed_at=day2 + 60_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)

        # Three minutes complete: both day-1 minutes (finished the moment
        # the day-2 prints arrived and advanced ES's newest minute) plus
        # day-2 05:56. Only day-2 05:57 is still in progress.
        day2_minute = datetime(2026, 9, 9, 5, 56, tzinfo=UTC)
        assert [r[_C["ts"]] for r in rows] == [
            datetime(2026, 9, 8, 5, 56, tzinfo=UTC),
            datetime(2026, 9, 8, 5, 57, tzinfo=UTC),
            day2_minute,
        ]

        # The assertion that actually pins the reset: the day-2 bar exists
        # and carries ESZ6's price and volume, not ESU6's stale lead.
        day2_bar = {r[_C["ts"]]: r for r in rows}[day2_minute]
        assert day2_bar[_C["close"]] == Decimal("7950.00")
        assert day2_bar[_C["volume"]] == 4
        # Day 1's 101 ESU6 lots are gone from the tally, not merely outvoted.
        assert handler._session_volume == {"ES": {"ESZ6": 5}}

    @pytest.mark.asyncio
    async def test_prior_day_straggler_keeps_its_minutes_front_month(self, handler):
        """23:59 is the held-back minute when the first 00:00 print rolls
        the tally. A 23:59 back-month straggler then lands in the EMPTY
        new-day tally; it must not re-elect itself front for 23:59 (a
        permanent carry-basis spike) or lead the new day (a 00:01 gap)."""
        at_2359_50 = 1788911990000  # 2026-09-08T23:59:50Z
        await _flush_capture(
            handler,
            [_print(sym="ESZ6", executed_at=at_2359_50 - 60_000, price="7700.00", size=500)],
        )
        await _flush_capture(
            handler,
            [_print(sym="ESZ6", executed_at=at_2359_50, price="7700.00", size=50, trade_id=2)],
        )
        rows = await _flush_capture(
            handler,
            [
                # 00:00:05 — first print of the new UTC day; rolls the tally.
                _print(sym="ESZ6", executed_at=at_2359_50 + 15_000, price="7701.00", trade_id=3),
                # 23:59:50.1 — prior-day back-month straggler.
                _print(
                    sym="ESH7", executed_at=at_2359_50 + 100, price="7755.00", size=5, trade_id=4
                ),
                # 00:01:05 — completes 23:59 and 00:00.
                _print(sym="ESZ6", executed_at=at_2359_50 + 75_000, price="7701.00", trade_id=5),
            ],
        )

        by_ts = {r[_C["ts"]]: r for r in rows}
        bar_2359 = by_ts[datetime(2026, 9, 8, 23, 59, tzinfo=UTC)]
        assert bar_2359[_C["close"]] == Decimal("7700.00")  # ESZ6, not ESH7's 7755
        assert bar_2359[_C["volume"]] == 50
        assert "ESH7" not in handler._session_volume["ES"]
        assert handler._front_sym[("ES", datetime(2026, 9, 9, 0, 1, tzinfo=UTC))] == "ESZ6"

    @pytest.mark.asyncio
    async def test_prior_day_straggler_without_a_snapshot_is_a_logged_gap(self, handler):
        """A prior-day minute first seen after the roll has no front-month
        snapshot from its own day, so it becomes the existing logged gap
        rather than being elected from the new day's tally."""
        at_2359_50 = 1788911990000  # 2026-09-08T23:59:50Z
        await _flush_capture(
            handler,
            [_print(sym="ESZ6", executed_at=at_2359_50 - 120_000, price="7700.00", size=500)],
        )
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            rows = await _flush_capture(
                handler,
                [
                    _print(sym="ESZ6", executed_at=at_2359_50 + 15_000, trade_id=2),
                    _print(
                        sym="ESH7",
                        executed_at=at_2359_50 + 100,
                        price="7755.00",
                        size=5,
                        trade_id=3,
                    ),
                    _print(sym="ESZ6", executed_at=at_2359_50 + 75_000, trade_id=4),
                ],
            )

        assert datetime(2026, 9, 8, 23, 59, tzinfo=UTC) not in {r[_C["ts"]] for r in rows}
        assert all(r[_C["close"]] != Decimal("7755.00") for r in rows)
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert "front_sym_absent" in kinds


# ----------------------------------------------------------------------
# 6. Only completed minutes flush
# ----------------------------------------------------------------------


class TestCompletedMinutesOnly:
    @pytest.mark.asyncio
    async def test_single_in_progress_minute_writes_nothing(self, handler):
        # Assert on the CALL, not the captured rows: _flush_capture also
        # returns [] when the mock was never invoked, so `rows == []`
        # alone would pass even if _flush wrongly issued an empty INSERT.
        rows = [
            r
            for r in (
                handler._transform(p)
                for p in [
                    _print(trade_id=1),
                    _print(executed_at=_BASE_MS + 100, trade_id=2),
                ]
            )
            if r is not None
        ]
        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=0)
            assert await handler._flush(rows) == 0
            assert mock_db.bulk_insert_ignore_conflict.called is False

    @pytest.mark.asyncio
    async def test_newest_minute_retained_across_flushes(self, handler):
        """The in-progress minute must survive to be completed later."""
        first = await _flush_capture(
            handler,
            [
                _print(price="7700.00", size=2, trade_id=1),
                _print(executed_at=_BASE_MS + 60_000, price="7800.00", trade_id=2),
            ],
        )
        # :56 completed and written; :57 retained in the accumulator.
        assert len(first) == 1
        assert first[0][_C["ts"]] == _BASE_MINUTE

        second = await _flush_capture(
            handler,
            [
                # More prints for the still-open :57 minute...
                _print(executed_at=_BASE_MS + 60_100, price="7850.00", size=5, trade_id=3),
                # ...then :58 completes it.
                _print(executed_at=_BASE_MS + 120_000, trade_id=4),
            ],
        )
        assert len(second) == 1
        assert second[0][_C["ts"]] == datetime(2026, 9, 8, 5, 57, tzinfo=UTC)
        # Proves the first flush's in-progress state was carried over,
        # not discarded: open comes from the earlier batch's print.
        assert second[0][_C["open"]] == Decimal("7800.00")
        assert second[0][_C["close"]] == Decimal("7850.00")
        assert second[0][_C["volume"]] == 6

    @pytest.mark.asyncio
    async def test_no_partial_bar_is_ever_written_twice(self, handler):
        """A completed minute is emitted exactly once, never re-emitted."""
        await _flush_capture(
            handler,
            [
                _print(trade_id=1),
                _print(executed_at=_BASE_MS + 60_000, trade_id=2),
            ],
        )
        again = await _flush_capture(
            handler,
            [_print(executed_at=_BASE_MS + 120_000, trade_id=3)],
        )
        # Only :57 this time — :56 was already emitted and evicted.
        assert [r[_C["ts"]] for r in again] == [datetime(2026, 9, 8, 5, 57, tzinfo=UTC)]

    @pytest.mark.asyncio
    async def test_empty_batch_writes_nothing(self, handler):
        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=0)
            assert await handler._flush([]) == 0
            # No INSERT at all, not an INSERT with zero rows.
            assert mock_db.bulk_insert_ignore_conflict.called is False

    @pytest.mark.asyncio
    async def test_flush_returns_rows_written(self, handler):
        rows = [
            r
            for r in (
                handler._transform(p)
                for p in [
                    _print(trade_id=1),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=2),
                ]
            )
            if r is not None
        ]
        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=1)
            assert await handler._flush(rows) == 1

    @pytest.mark.asyncio
    async def test_flush_targets_futures_bars_with_symbol_ts_conflict_key(self, handler):
        rows = [
            r
            for r in (
                handler._transform(p)
                for p in [
                    _print(trade_id=1),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=2),
                ]
            )
            if r is not None
        ]
        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=1)
            await handler._flush(rows)
            kwargs = mock_db.bulk_insert_ignore_conflict.call_args.kwargs

        assert kwargs["table"] == "futures_bars"
        assert kwargs["conflict_cols"] == ["symbol", "ts"]
        assert kwargs["columns"] == [
            "symbol",
            "ts",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "buy_volume",
            "sell_volume",
            "buy_prints",
            "sell_prints",
        ]


# ----------------------------------------------------------------------
# 7. Non-target products rejected
# ----------------------------------------------------------------------


class TestNonTargetProducts:
    @pytest.mark.parametrize(
        "product", ["6E", "ZF", "ZS", "ZB", "YM", "SI", "HG", "6J", "PL", "NG"]
    )
    def test_non_target_product_returns_none(self, handler, product):
        assert handler._transform(_print(product=product)) is None

    def test_all_six_target_products_accepted(self, handler):
        for product in ("ES", "NQ", "RTY", "CL", "GC", "ZN"):
            row = handler._transform(_print(product=product, sym=f"{product}U6"))
            assert row is not None, product
            assert row.product == product

    def test_missing_or_malformed_product_returns_none(self, handler):
        assert handler._transform(_print(product=None)) is None
        assert handler._transform({}) is None

    def test_missing_sym_returns_none(self, handler):
        assert handler._transform(_print(sym=None)) is None
        assert handler._transform(_print(sym="")) is None

    @pytest.mark.asyncio
    async def test_enqueue_short_circuits_non_target_products(self, handler):
        """Non-target prints must never take a queue slot."""
        await handler.enqueue(_print(product="ZS", sym="ZSX6"))
        await handler.enqueue(_print(product="MES", sym="MESU6"))
        assert handler.queue.qsize() == 0

        await handler.enqueue(_print(product="ES", sym="ESU6"))
        assert handler.queue.qsize() == 1


# ----------------------------------------------------------------------
# 8. Duplicate re-delivery — UW sends each print 2-11x (live probe
#    2026-09-08). Naive volume summing inflated ES by 3.09x.
# ----------------------------------------------------------------------


class TestDuplicateSuppression:
    @pytest.mark.asyncio
    async def test_repeated_print_counted_once(self, handler):
        dup = _print(price="7706.25", size=3, trade_id=42)
        payloads = [dup, dict(dup), dict(dup), dict(dup)]
        payloads.append(_print(executed_at=_BASE_MS + 60_000, trade_id=43))

        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 3  # not 12

    @pytest.mark.asyncio
    async def test_duplicates_do_not_inflate_front_month_tally(self, handler):
        """Dedup must run before the session-volume tally, or a heavily
        re-delivered back month could win front-month selection."""
        back = _print(sym="ESZ6", price="7900.00", size=2, trade_id=99)
        payloads = [
            _print(sym="ESU6", price="7700.00", size=5, trade_id=1),
            # Back month delivered 5x — 10 lots naive, 2 lots deduped.
            *[dict(back) for _ in range(5)],
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=2),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["close"]] == Decimal("7700.00")  # ESU6 still front
        assert rows[0][_C["volume"]] == 5

    @pytest.mark.asyncio
    async def test_distinct_trade_ids_at_same_instant_both_count(self, handler):
        """Two genuine prints sharing a timestamp must NOT be deduped."""
        payloads = [
            _print(executed_at=_BASE_MS, price="7706.25", size=1, trade_id=1),
            _print(executed_at=_BASE_MS, price="7706.25", size=1, trade_id=2),
            _print(executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 2

    @pytest.mark.asyncio
    async def test_same_trade_id_on_different_contracts_both_count(self, handler):
        """trade_id is only unique within a contract — key on (sym, id)."""
        payloads = [
            _print(product="ES", sym="ESU6", size=4, trade_id=7),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 10, size=6, trade_id=7),
            _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=8),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 60_010, trade_id=9),
        ]
        rows = await _flush_capture(handler, payloads)
        by_symbol = {r[_C["symbol"]]: r for r in rows}
        assert by_symbol["ES"][_C["volume"]] == 4
        assert by_symbol["NQ"][_C["volume"]] == 6

    @pytest.mark.asyncio
    async def test_duplicate_spanning_two_flushes_counted_once(self, handler):
        """Dedup state must survive across _flush calls within a minute."""
        dup = _print(price="7706.25", size=3, trade_id=42)
        await _flush_capture(handler, [dup])
        rows = await _flush_capture(
            handler,
            [dict(dup), _print(executed_at=_BASE_MS + 60_000, trade_id=43)],
        )
        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 3  # not 6

    @pytest.mark.asyncio
    async def test_prints_without_trade_id_are_not_collapsed(self, handler):
        """A missing trade_id must not make every print look like a dup."""
        payloads = [
            _print(price="7700.00", size=2, trade_id=None),
            _print(executed_at=_BASE_MS + 10, price="7701.00", size=2, trade_id=None),
            _print(executed_at=_BASE_MS + 60_000, trade_id=1),
        ]
        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 4


# ----------------------------------------------------------------------
# 9. Memory bounding — accumulators must not grow without limit
# ----------------------------------------------------------------------


class TestMemoryBounding:
    @pytest.mark.asyncio
    async def test_emitted_minutes_are_evicted(self, handler):
        payloads = [_print(executed_at=_BASE_MS + i * 60_000, trade_id=i) for i in range(20)]
        await _flush_capture(handler, payloads)
        # Only the newest (in-progress) minute survives.
        assert len(handler._bars) == 1
        assert len(handler._seen) == 1

    @pytest.mark.asyncio
    async def test_back_month_minute_state_evicted_with_front_month(self, handler):
        """Non-front-month contracts are dropped, not leaked."""
        payloads = [
            _print(sym="ESU6", size=10, trade_id=1),
            _print(sym="ESZ6", executed_at=_BASE_MS + 10, size=1, trade_id=2),
            _print(sym="ESH7", executed_at=_BASE_MS + 20, size=1, trade_id=3),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=4),
        ]
        await _flush_capture(handler, payloads)
        remaining = {key[1] for key in handler._bars}
        assert remaining == {datetime(2026, 9, 8, 5, 57, tzinfo=UTC)}

    @pytest.mark.asyncio
    async def test_session_volume_tally_does_not_grow_across_days(self, handler):
        payloads = []
        for day in range(3):
            base = _BASE_MS + day * 86_400_000
            payloads.append(_print(sym=f"ESX{day}", executed_at=base, trade_id=day * 2))
            payloads.append(
                _print(sym=f"ESX{day}", executed_at=base + 60_000, trade_id=day * 2 + 1)
            )
        await _flush_capture(handler, payloads)
        # Only the final day's contract remains in the tally.
        assert handler._session_volume == {"ES": {"ESX2": 2}}


# ----------------------------------------------------------------------
# 10. Channel wiring — the handler is dead code until the registry knows
#     about it AND the WS_CHANNELS validator accepts the token.
# ----------------------------------------------------------------------


class TestChannelWiring:
    def test_futures_trades_is_a_known_channel_token(self):
        """Settings._validate_channels_known rejects anything the registry
        doesn't know, so this is what lets WS_CHANNELS=futures_trades boot."""
        from channel_registry import is_known_channel_token

        assert is_known_channel_token("futures_trades")

    def test_futures_trades_routes_to_the_handler(self):
        from channel_registry import handler_class_for_channel

        assert handler_class_for_channel("futures_trades") is FuturesTradesHandler

    def test_registered_as_an_exact_name_not_a_prefix(self):
        """We subscribe to the GLOBAL channel. The per-contract form uses a
        different prefix (``futures:ESU6``) and is deliberately unregistered —
        one subscription beats six against the 50-channel-per-connection cap."""
        from channel_registry import EXACT_CHANNEL_NAMES, is_known_channel_token

        assert "futures_trades" in EXACT_CHANNEL_NAMES
        assert not is_known_channel_token("futures:ESU6")
        assert not is_known_channel_token("futures_trades:ESU6")

    def test_ws_channels_env_accepts_futures_trades(self):
        from config import Settings

        settings = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels="flow-alerts,futures_trades",
        )
        assert settings.channels == ["flow-alerts", "futures_trades"]

    def test_futures_trades_shards_as_a_global_channel(self):
        """No ``:`` in the name, so channel_shards treats it as a global and
        folds it into a per-ticker shard rather than opening its own socket."""
        from config import Settings

        settings = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels="futures_trades,option_trades:SPY,option_trades:QQQ",
        )
        shards = settings.channel_shards
        assert len(shards) == 1
        assert set(shards[0]) == {
            "futures_trades",
            "option_trades:SPY",
            "option_trades:QQQ",
        }


# ----------------------------------------------------------------------
# 11. Failure modes that would write permanently WRONG data. These are
#     the paths ON CONFLICT DO NOTHING can never revise, so each one is
#     pinned explicitly rather than left to the happy-path tests.
# ----------------------------------------------------------------------


class TestFutureDatedTimestamps:
    """A single print stamped in the future must not poison the product.

    ``_newest_minute`` only ever moves forward, so a far-future stamp
    would make every subsequent real minute compare as "completed" and
    get written as a one-print PARTIAL bar — locked in forever by
    ON CONFLICT DO NOTHING. It would also freeze ``_session_date``,
    permanently disabling the front-month roll.
    """

    def test_far_future_timestamp_rejected(self):
        # Inside the old static 2100 ceiling, but years past "now".
        assert _floor_minute_utc(_PINNED_NOW_MS + 4 * 365 * 86_400_000) is None

    def test_iso_far_future_timestamp_rejected(self):
        """The ISO fallback path gets the same bound as the numeric one.

        It previously returned early after a bare ``year >= 2000`` check
        and skipped the upper bound entirely.
        """
        assert _floor_minute_utc("2035-01-01T00:00:00+00:00") is None

    def test_small_clock_skew_still_accepted(self):
        """A stamp slightly ahead of us is skew, not corruption."""
        skewed = _PINNED_NOW_MS + timestamps.MAX_FUTURE_SKEW_MS - 60_000
        assert _floor_minute_utc(skewed) is not None

    def test_just_past_the_skew_window_rejected(self):
        past = _PINNED_NOW_MS + timestamps.MAX_FUTURE_SKEW_MS + 60_000
        assert _floor_minute_utc(past) is None

    def test_transform_drops_the_future_print(self, handler):
        assert handler._transform(_print(executed_at=_PINNED_NOW_MS + 10**11)) is None

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_float_executed_at_is_dropped_not_raised(self, handler, value):
        """``int(nan)`` raises ValueError and ``int(inf)`` OverflowError.
        The parser used to let both escape ``_transform``, which the base
        handler then reported to Sentry once per frame."""
        with patch.object(ft, "rate_limited_log") as rl:
            assert handler._transform(_print(executed_at=value)) is None
        assert rl.warning.call_args.kwargs["kind"] == "bad_executed_at"

    @pytest.mark.asyncio
    async def test_future_print_does_not_advance_newest_minute(self, handler):
        """The regression this whole class exists for: a rejected future
        print must leave ``_newest_minute`` untouched, so the in-progress
        minute stays in progress instead of flushing as a partial bar."""
        payloads = [
            _print(price="7700.00", size=2, trade_id=1),
            # Rejected at _transform — never reaches the accumulator.
            _print(executed_at=_PINNED_NOW_MS + 10**11, trade_id=2),
        ]
        rows = await _flush_capture(handler, payloads)

        assert rows == []  # :56 is still the newest minute, still open
        assert handler._newest_minute == {"ES": _BASE_MINUTE}
        assert handler._session_date == _BASE_MINUTE.date()


class TestFrontMonthSilentForAMinute:
    """Front month prints nothing in a minute while a back month does.

    The bar is emitted as a GAP, never as the back month's price: the
    months trade at a carry basis, so substituting one for the other
    would inject a fake spike into the single-root series that
    ON CONFLICT DO NOTHING could never revise. What must NOT happen is
    the gap going unlogged — silent, it is indistinguishable from a
    genuinely untraded minute.
    """

    @pytest.mark.asyncio
    async def test_minute_is_skipped_not_filled_with_back_month_price(self, handler):
        payloads = [
            # :56 — ESU6 takes a commanding session-volume lead.
            _print(sym="ESU6", price="7700.00", size=2000, trade_id=1),
            # :57 — only the back month prints, 200 points away.
            _print(
                sym="ESZ6",
                executed_at=_BASE_MS + 60_000,
                price="7900.00",
                size=1,
                trade_id=2,
            ),
            # :58 — completes :57.
            _print(sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=3),
        ]
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            rows = await _flush_capture(handler, payloads)

        # :56 emitted; :57 skipped rather than filled with ESZ6's 7900.
        assert [r[_C["ts"]] for r in rows] == [_BASE_MINUTE]
        assert all(r[_C["close"]] != Decimal("7900.00") for r in rows)

        # ...and the skip is observable.
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert "front_sym_absent" in kinds

    @pytest.mark.asyncio
    async def test_skipped_minute_state_is_still_evicted(self, handler):
        """A skipped minute must not leak its accumulator entries."""
        payloads = [
            _print(sym="ESU6", price="7700.00", size=2000, trade_id=1),
            _print(sym="ESZ6", executed_at=_BASE_MS + 60_000, size=1, trade_id=2),
            _print(sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=3),
        ]
        await _flush_capture(handler, payloads)

        # Only the in-progress :58 minute survives, for one contract.
        assert {key[1] for key in handler._bars} == {datetime(2026, 9, 8, 5, 58, tzinfo=UTC)}
        assert {key[1] for key in handler._seen} == {datetime(2026, 9, 8, 5, 58, tzinfo=UTC)}
        assert {key[1] for key in handler._front_sym} == {datetime(2026, 9, 8, 5, 58, tzinfo=UTC)}


class TestDedupOutageIsVisible:
    @pytest.mark.asyncio
    async def test_missing_trade_id_is_logged(self, handler):
        """Prints without a usable trade_id bypass dedup. UW re-delivers
        every print 2-11x, so a trade_id format change would silently
        re-inflate volume by that factor — it must be loud."""
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            await _flush_capture(
                handler,
                [
                    _print(price="7700.00", size=2, trade_id=None),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=1),
                ],
            )
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert "missing_trade_id" in kinds

    @pytest.mark.asyncio
    async def test_unparseable_trade_id_is_logged(self, handler):
        """_to_int returns None for a non-numeric id — same blind spot."""
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            await _flush_capture(
                handler,
                [
                    _print(price="7700.00", size=2, trade_id="abc-123"),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=1),
                ],
            )
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert "missing_trade_id" in kinds

    @pytest.mark.asyncio
    async def test_normal_prints_log_nothing(self, handler):
        """The happy path must stay silent, or the warning is noise."""
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            await _flush_capture(
                handler,
                [
                    _print(trade_id=1),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=2),
                ],
            )
        assert mock_log.warning.call_args_list == []


# ----------------------------------------------------------------------
# 12. Aggressor order flow (spec Phase 2). UW's ``side`` is the exchange
#     aggressor flag (99.1% tick-test agreement, REST probe 2026-10-28).
#     NULL flow = unknown (no print in the bar carried a side); 0 = known
#     to be none.
# ----------------------------------------------------------------------

_FLOW = ("buy_volume", "sell_volume", "buy_prints", "sell_prints")


def _flow(row: tuple) -> list:
    return [row[_C[name]] for name in _FLOW]


class TestOrderFlow:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("buy", "buy"),
            ("sell", "sell"),
            ("none", "none"),
            # UW documents the values as case-sensitive: anything else is
            # unknown, never coerced into a side.
            ("BUY", None),
            ("Sell", None),
            (" buy", None),
            ("bid", None),
            ("", None),
            (None, None),
            (1, None),
            (True, None),
        ],
    )
    def test_parse_side(self, raw, expected):
        assert ft._parse_side(raw) == expected

    def test_transform_carries_side(self, handler):
        assert handler._transform(_print(side="buy")).side == "buy"
        assert handler._transform(_without(_print(), "side")).side is None

    @pytest.mark.asyncio
    async def test_buy_sell_split(self, handler):
        payloads = [
            _print(size=2, side="buy", trade_id=1),
            _print(executed_at=_BASE_MS + 100, size=3, side="sell", trade_id=2),
            _print(executed_at=_BASE_MS + 200, size=1, side="none", trade_id=3),
            # Next minute — completes 05:56.
            _print(executed_at=_BASE_MS + 60_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 6  # the "none" lot counts here only
        assert _flow(rows[0]) == [2, 3, 1, 1]

    @pytest.mark.asyncio
    async def test_mixed_known_and_missing_side(self, handler):
        """One print with a side makes the flow known: the side-less lots
        count toward volume only, and the flow is 0, not NULL, for sell."""
        payloads = [
            _print(size=2, side="buy", trade_id=1),
            _without(_print(executed_at=_BASE_MS + 100, size=3, trade_id=2), "side"),
            _print(executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 5
        assert _flow(rows[0]) == [2, 0, 1, 0]

    @pytest.mark.asyncio
    async def test_bar_without_any_side_key_writes_null_flow(self, handler):
        """A frame with no ``side`` key means unknown, so the bar must write
        NULL flow, never 0 — 0 would claim "no aggressor volume"."""
        payloads = [
            _without(_print(price="7706.25", size=2, trade_id=1), "side"),
            _without(
                _print(executed_at=_BASE_MS + 100, price="7708.00", size=3, trade_id=2), "side"
            ),
            _print(executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        row = rows[0]
        assert _flow(row) == [None, None, None, None]
        # OHLCV is unchanged by the missing side.
        assert row[_C["open"]] == Decimal("7706.25")
        assert row[_C["high"]] == Decimal("7708.00")
        assert row[_C["low"]] == Decimal("7706.25")
        assert row[_C["close"]] == Decimal("7708.00")
        assert row[_C["volume"]] == 5

    @pytest.mark.asyncio
    async def test_all_none_side_writes_zero_flow(self, handler):
        """``side="none"`` is a known side, so the flow is 0, not NULL."""
        payloads = [
            _print(size=2, side="none", trade_id=1),
            _print(executed_at=_BASE_MS + 100, size=3, side="none", trade_id=2),
            _print(executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 5
        assert _flow(rows[0]) == [0, 0, 0, 0]

    @pytest.mark.asyncio
    async def test_duplicate_copy_counts_side_once(self, handler):
        """Dedup runs before the flow tally, so the first copy wins even
        when a re-delivered copy disagrees on side."""
        first = _print(size=4, side="buy", trade_id=42)
        payloads = [
            first,
            dict(first, side="sell"),
            _print(executed_at=_BASE_MS + 60_000, trade_id=43),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 4
        assert _flow(rows[0]) == [4, 0, 1, 0]

    @pytest.mark.parametrize(
        ("spread_sym", "is_spread"),
        [
            # REST-style flag on an outright-looking sym.
            pytest.param("ESH7", True, id="is_spread_flag"),
            # The websocket's real case: no is_spread key at all, so only
            # the sym shape marks it as a spread.
            pytest.param("ESZ6-ESH7", None, id="spread_sym_no_flag"),
        ],
    )
    @pytest.mark.asyncio
    async def test_spread_print_never_wins_front_month_flag_or_sym(
        self, handler, spread_sym, is_spread
    ):
        """A calendar spread is its own sym. Counted, its volume would win
        the front-month argmax and write the spread's price as ES."""
        spread = _print(sym=spread_sym, price="45.50", size=1000, trade_id=1, is_spread=is_spread)
        payloads = [
            spread,
            _print(sym="ESZ6", executed_at=_BASE_MS + 10, price="7706.25", size=5, trade_id=2),
            _print(sym="ESZ6", executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(spread) is None
            rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 5
        assert rows[0][_C["low"]] == Decimal("7706.25")  # not the spread's 45.50
        assert spread_sym not in handler._session_volume["ES"]
        # Expected traffic, skipped quietly.
        assert mock_log.warning.call_args_list == []

    @pytest.mark.parametrize(
        ("product", "sym", "expected"),
        [
            ("ES", "ESZ6", True),
            ("NQ", "NQH7", True),
            ("ES", "ESZ26", True),  # two-digit year
            ("RTY", "RTYU6", True),
            ("ES", "ESZ6-ESH7", False),  # calendar spread
            ("ES", "ESZ6:ESH7", False),
            ("ES", "ES Z6", False),
            ("ES", "ES", False),  # bare root
            ("ES", "MESZ6", False),  # micro sym under the ES product
            ("ES", "ESZ", False),  # no year
            ("ES", "ESA6", False),  # A is not a CME month code
            ("ES", "ESZ123", False),
            ("ES", "esz6", False),
            ("ES", "ESZ6\n", False),  # $ would accept this; fullmatch must not
            ("ES", "NQZ6", False),  # another product's outright
            ("ES", "UD:1V: ESZ6", False),
        ],
    )
    def test_outright_sym_matcher(self, product, sym, expected):
        assert ft._is_outright(product, sym) is expected

    def test_unrecognized_alphanumeric_sym_warns(self, handler):
        """A separator-free sym that isn't an outright is most likely a
        feed-wide format change (e.g. a four-digit year). Skipping it quietly
        would black out every bar with no signal, so it warns."""
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(_print(sym="ESZ2026")) is None
        assert mock_log.warning.call_count == 1
        call = mock_log.warning.call_args
        assert call.kwargs["scope"] == "futures_trades"
        assert call.kwargs["kind"] == "unrecognized_sym"
        assert call.kwargs["extra"] == {"product": "ES", "sym": "ESZ2026"}

    @pytest.mark.parametrize("sym", ["ESZ6-ESH7", "ESZ6:ESH7", "UD:1V: ESZ6"])
    def test_separator_spread_sym_skipped_quietly(self, handler, sym):
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(_print(sym=sym)) is None
        assert mock_log.method_calls == []

    def test_block_print_skipped_without_warning(self, handler):
        """Block frames carry ``qty`` and no ``size``/``side``. Phase 4
        stores them from ``futures_blocks``; here they are skipped quietly,
        not logged as ``invalid_price_or_size``."""
        block = _without(_print(is_block=True), "size", "side")
        block["qty"] = 25
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(block) is None
        assert mock_log.warning.call_args_list == []


# ----------------------------------------------------------------------
# 13. Prints for minutes already emitted. Their dedup set was evicted with
#     the minute, so a late re-delivered copy would otherwise bypass dedup,
#     inflate the session tally and build a one-print bar that
#     ON CONFLICT DO NOTHING discards.
# ----------------------------------------------------------------------


def _late_drop_logs(mock_log) -> list[dict]:
    return [
        c.kwargs["extra"]
        for c in mock_log.info.call_args_list
        if c.kwargs.get("extra", {}).get("kind") == "late_print_dropped"
    ]


class TestLatePrints:
    @pytest.mark.asyncio
    async def test_print_for_emitted_minute_is_dropped(self, handler):
        front = _print(sym="ESU6", price="7700.00", size=10, trade_id=1)
        back = _print(sym="ESZ6", executed_at=_BASE_MS + 10, price="7900.00", size=1, trade_id=2)
        first = await _flush_capture(
            handler, [front, back, _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3)]
        )
        assert [r[_C["ts"]] for r in first] == [_BASE_MINUTE]
        assert handler._session_volume == {"ES": {"ESU6": 11, "ESZ6": 1}}

        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            # A back-month copy used to trip a false front_sym_absent; a
            # front-month copy used to re-emit a one-print 05:56 bar.
            late_back = await _flush_capture(handler, [dict(back)])
            late_front = await _flush_capture(handler, [dict(front)])

        assert late_back == []
        assert late_front == []
        assert handler._session_volume == {"ES": {"ESU6": 11, "ESZ6": 1}}
        assert all(key[1] != _BASE_MINUTE for key in handler._bars)
        kinds = [c.kwargs.get("kind") for c in mock_log.warning.call_args_list]
        assert "front_sym_absent" not in kinds

    @pytest.mark.asyncio
    async def test_late_drop_is_logged_at_info_rate_limited(self, handler):
        """Late copies are expected traffic (UW re-delivers each print 2-11
        times, up to ~0.5s apart), so the drop is an info line with a
        running count, throttled per window, and never a warning."""
        early = _print(trade_id=1)
        await _flush_capture(handler, [early, _print(executed_at=_BASE_MS + 60_000, trade_id=2)])

        with (
            patch("handlers.futures_trades.log") as mock_log,
            patch("handlers.futures_trades.rate_limited_log") as mock_rl,
        ):
            # Two drops inside one window: one line.
            await _flush_capture(handler, [dict(early), dict(early)])
            assert [e["dropped_total"] for e in _late_drop_logs(mock_log)] == [1]
            # Expire the window; the next drop logs the running count.
            handler._late_drop_logged_at -= MALFORMED_PAYLOAD_LOG_INTERVAL_S
            await _flush_capture(handler, [dict(early)])

        logs = _late_drop_logs(mock_log)
        assert [e["dropped_total"] for e in logs] == [1, 3]
        assert logs[0]["scope"] == "futures_trades"
        assert logs[0]["product"] == "ES"
        assert logs[0]["minute_ts"] == _BASE_MINUTE.isoformat()
        assert mock_log.warning.call_args_list == []
        assert mock_rl.warning.call_args_list == []


# ----------------------------------------------------------------------
# 14. A rejected futures_bars INSERT (R4). The base handler surfaces it to
#     Sentry and keeps draining; there is no re-queue (spec Phase 2, YAGNI):
#     the loss is visible and the OHLC gap repair refills those minutes.
# ----------------------------------------------------------------------


class TestFlushFailure:
    @pytest.mark.asyncio
    async def test_db_reject_is_surfaced(self, handler):
        from state import state

        metrics = state.handler("futures_trades")
        written_before = metrics.write_count
        rows = [
            handler._transform(_print(trade_id=1)),
            handler._transform(_print(executed_at=_BASE_MS + 60_000, trade_id=2)),
        ]
        with (
            patch("handlers.futures_trades.db") as mock_db,
            patch("handlers.base.capture_exception") as mock_capture,
        ):
            mock_db.bulk_insert_ignore_conflict = AsyncMock(
                side_effect=RuntimeError("simulated Neon reject")
            )
            await handler._safe_flush(rows)  # must not raise

        assert mock_capture.call_count == 1
        assert isinstance(mock_capture.call_args.args[0], RuntimeError)
        tags = mock_capture.call_args.kwargs["tags"]
        assert tags["channel"] == "futures_trades"
        assert tags["stage"] == "flush"
        assert metrics.write_count == written_before

        # The handler keeps draining: the next flush writes the next minute,
        # and the rejected 05:56 bar is not retried.
        survived = await _flush_capture(
            handler, [_print(executed_at=_BASE_MS + 120_000, trade_id=3)]
        )
        assert [r[_C["ts"]] for r in survived] == [datetime(2026, 9, 8, 5, 57, tzinfo=UTC)]


# ----------------------------------------------------------------------
# TEMPORARY (spec Phase 0b): remove after one session
# Sampled raw-frame capture for websocket probes P1 (which keys a frame
# carries) and P2 (how re-delivered copies of one print differ).
# ----------------------------------------------------------------------


@pytest.fixture
def capture_records():
    """Collect every record the service logger emits during a test.

    ``log`` has ``propagate=False`` (logger_setup.get_logger), so pytest's
    ``caplog`` never sees it; attach a list handler to the logger itself.
    """
    records: list[logging.LogRecord] = []

    class _ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    list_handler = _ListHandler()
    log.addHandler(list_handler)
    try:
        yield records
    finally:
        log.removeHandler(list_handler)


def _captures(records: list[logging.LogRecord]) -> list[logging.LogRecord]:
    return [r for r in records if r.getMessage() == "futures_capture"]


class TestFrameCapture:
    @pytest.mark.asyncio
    async def test_every_copy_of_a_sampled_trade_is_logged(self, handler, capture_records):
        """P2 compares re-delivered copies, so sampling is on trade_id and
        every copy of a sampled print must be logged, not just the first."""
        payload = _print(trade_id=1000)
        before_ms = time.time_ns() // 1_000_000
        for _ in range(3):
            await handler.enqueue(dict(payload))
        after_ms = time.time_ns() // 1_000_000

        captures = _captures(capture_records)
        assert len(captures) == 3
        for record in captures:
            assert record.levelno == logging.INFO
            assert isinstance(record.arrival_ms, int)
            assert before_ms <= record.arrival_ms <= after_ms
            assert record.payload == payload
            # The Railway line must carry the full raw payload as JSON.
            line = json.loads(JsonFormatter().format(record))
            assert line["msg"] == "futures_capture"
            assert line["arrival_ms"] == record.arrival_ms
            assert line["payload"] == payload

    @pytest.mark.asyncio
    async def test_unsampled_trade_not_logged(self, handler, capture_records):
        await handler.enqueue(_print(trade_id=1001))
        assert _captures(capture_records) == []

    @pytest.mark.asyncio
    async def test_non_capture_product_not_logged(self, handler, capture_records):
        """CL is a bar product but not a capture product."""
        await handler.enqueue(_print(product="CL", sym="CLZ6", trade_id=1000))
        assert _captures(capture_records) == []

    @pytest.mark.asyncio
    async def test_bad_trade_id_neither_logs_nor_raises(self, handler, capture_records):
        missing = _print()
        del missing["trade_id"]
        # "inf" once made _to_int raise OverflowError, which the helper's
        # swallow absorbed; _to_int now returns None for it. Kept as a case.
        bad = [_print(trade_id="x"), missing, _print(trade_id=None), _print(trade_id="inf")]
        depth = handler.queue.qsize()
        for payload in bad:
            ft._maybe_capture(payload, 0)
            await handler.enqueue(payload)
        assert _captures(capture_records) == []
        # A capture failure must never cost the frame itself.
        assert handler.queue.qsize() == depth + len(bad)

    @pytest.mark.asyncio
    async def test_capture_does_not_change_enqueue(self, handler, capture_records):
        depth = handler.queue.qsize()
        await handler.enqueue(_print(trade_id=1000))
        assert len(_captures(capture_records)) == 1  # it was sampled
        assert handler.queue.qsize() == depth + 1
        assert handler.queue.get_nowait() == _print(trade_id=1000)
