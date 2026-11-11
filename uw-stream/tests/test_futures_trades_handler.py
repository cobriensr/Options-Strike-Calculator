"""Unit tests for FuturesTradesHandler.

Covers the two halves of the handler:

- ``_transform`` — the stateless per-print normalizer: target-product
  equality filter (micros excluded), Decimal price parsing, epoch-ms
  minute flooring, and defensive rejection of malformed prints.
- ``_flush`` — the stateful bar aggregator: per-print dedup, the per-session
  tally, the contract each minute is built from (one per root per CME trade
  date, decided in ``futures_front_month``), OHLCV folding, and the
  completed-minutes-only emit rule that keeps ``ON CONFLICT DO NOTHING``
  correct.

The database layer of the rule (``ensure_front``, ``load_tally``,
``save_tally``) is replaced at the module boundary by ``_FakeFront``, the
``front`` fixture; its own tests are in tests/test_futures_front_month.py.

Payload shape and ``executed_at`` units were captured from the live UW
feed on 2026-09-08 (see the handler module docstring).
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import asyncpg.exceptions
import pytest

import db
import futures_front_month as front_month
from handlers import futures_trades as ft
from handlers.futures_trades import (
    _COLUMNS,
    _TARGET_PRODUCTS,
    FuturesTradesHandler,
    _floor_to_minute,
    _to_decimal,
    _to_int,
)
from logger_setup import MALFORMED_PAYLOAD_LOG_INTERVAL_S
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

# The CME trade date of _BASE_MS: 05:56Z is 00:56 CDT, and 00:56 + 7 h is 09-08.
_D = date(2026, 9, 8)
# The clock of front_month while the handler runs: trade date 09-10, so the
# stale-session floor (3 days back) is 09-07.
_FRONT_NOW = datetime(2026, 9, 10, 5, 56, tzinfo=UTC)
# The 17:00 CDT open of trade date 09-09 is 22:00Z on 09-08.
_OPEN_09_09_MS = 1788904800000  # 2026-09-08T22:00:00Z


@pytest.fixture(autouse=True)
def _pin_wall_clock(monkeypatch):
    """Pin ``_now_ms`` so the future-timestamp bound is deterministic."""
    monkeypatch.setattr(timestamps, "_now_ms", lambda: _PINNED_NOW_MS)


class _FakeFront:
    """The database layer of the front-month rule, replaced at the module
    boundary: ``ensure_front``, ``load_tally`` and ``save_tally``.

    Every root's contract is ``<ROOT>U6`` unless a test sets ``decisions`` (a
    ``None`` there is a failed lookup). ``events`` is the call order across the
    three, for the tests that pin "save the tally before asking".
    """

    def __init__(self) -> None:
        self.decisions: dict[tuple[str, date], str | None] = {}
        self.defaults: dict[str, str] = {"CL": "CLV6"}
        self.stored: dict[tuple[str, date], dict[str, int]] = {}
        self.ensure_calls: list[tuple[str, date]] = []
        self.load_calls: list[tuple[str, date]] = []
        self.saves: list[list[tuple[str, date, str, int]]] = []
        self.save_attempts = 0
        self.events: list[str] = []
        self.fail_load: Exception | None = None
        self.fail_load_for: dict[str, Exception] = {}
        self.fail_save: Exception | None = None
        # Roots whose call never returns, for the time box.
        self.hang_ensure: set[str] = set()
        self.hang_load: set[str] = set()
        self.hang_save = False
        # ``db._single_attempt`` as each save saw it: True only inside the
        # shutdown drain.
        self.single_attempt_during_save: list[bool] = []
        # What ``front_month.last_failure`` says about a root whose ensure_front
        # came back None: (kind, exception class name).
        self.failures: dict[str, tuple[str, str]] = {}

    async def ensure_front(self, product: str, trade_date: date) -> str | None:
        self.events.append("ensure")
        self.ensure_calls.append((product, trade_date))
        if product in self.hang_ensure:
            await asyncio.Event().wait()
        key = (product, trade_date)
        if key in self.decisions:
            return self.decisions[key]
        return self.defaults.get(product, f"{product}U6")

    def last_failure(self, product: str) -> tuple[str, str] | None:
        return self.failures.get(product)

    async def load_tally(self, product: str, trade_date: date) -> dict[str, int]:
        self.events.append("load")
        self.load_calls.append((product, trade_date))
        if product in self.hang_load:
            await asyncio.Event().wait()
        if product in self.fail_load_for:
            raise self.fail_load_for[product]
        if self.fail_load is not None:
            raise self.fail_load
        return dict(self.stored.get((product, trade_date), {}))

    async def save_tally(self, rows) -> None:
        self.events.append("save")
        self.save_attempts += 1
        self.single_attempt_during_save.append(db._single_attempt.get())
        if self.hang_save:
            await asyncio.Event().wait()
        if self.fail_save is not None:
            raise self.fail_save
        self.saves.append(list(rows))

    @property
    def saved_volume(self) -> dict[tuple[str, date, str], int]:
        """The latest volume saved for each (product, trade date, contract)."""
        latest: dict[tuple[str, date, str], int] = {}
        for batch in self.saves:
            for product, day, contract, volume in batch:
                latest[(product, day, contract)] = volume
        return latest


@pytest.fixture(autouse=True)
def front(monkeypatch) -> _FakeFront:
    fake = _FakeFront()
    monkeypatch.setattr(front_month, "ensure_front", fake.ensure_front)
    monkeypatch.setattr(front_month, "load_tally", fake.load_tally)
    monkeypatch.setattr(front_month, "save_tally", fake.save_tally)
    monkeypatch.setattr(front_month, "last_failure", fake.last_failure)
    # The clock the stale-session floor reads: 09-10, two days after the
    # sessions most tests print in.
    monkeypatch.setattr(front_month, "_now", lambda: _FRONT_NOW)
    return fake


def _counts(handler, product: str = "ES", day: date = _D) -> dict[str, int]:
    """The handler's deduped outright volume per contract for one session."""
    return handler._tally[(product, day)].counts


def _blip() -> Exception:
    """A dropped Neon connection: transient (a warning), and not a timeout, so
    it cools its own call only and does not stop the other roots' calls."""
    return asyncpg.exceptions.ConnectionDoesNotExistError("connection was closed")


def _let_the_retry_after_run_out(handler) -> None:
    """Age every failed call, and the pause after a timeout, by the retry-after,
    without sleeping through it."""
    for key in handler._retry_after:
        handler._retry_after[key] -= ft._RETRY_AFTER_S
    if handler._box_until is not None:
        handler._box_until -= ft._RETRY_AFTER_S


def _age_by(handler, seconds: float) -> None:
    """Run the clock on by ``seconds``, a multiple of the retry-after, in the
    retry-after steps of the helper above."""
    for _ in range(round(seconds / ft._RETRY_AFTER_S)):
        _let_the_retry_after_run_out(handler)


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

    Live websocket frames carry exactly these 11 keys (frame capture,
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
# 5. The contract of a minute: one per root per CME trade date, decided in
#    futures_front_month, never by the volume the process has seen
# ----------------------------------------------------------------------


class TestFrontMonthSelection:
    @pytest.mark.asyncio
    async def test_the_decided_contract_is_the_bar_whatever_the_volume(self, handler):
        payloads = [
            # Decided contract ESU6: 10 lots.
            _print(sym="ESU6", price="7700.00", size=10, trade_id=1),
            # Back month ESZ6: 50 lots, wildly different price.
            _print(
                sym="ESZ6",
                executed_at=_BASE_MS + 10,
                price="7900.00",
                size=50,
                trade_id=2,
            ),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 10  # only ESU6
        assert rows[0][_C["high"]] == Decimal("7700.00")  # ESZ6's 7900 excluded
        assert rows[0][_C["contract"]] == "ESU6"

    @pytest.mark.asyncio
    async def test_a_back_month_overtaking_mid_session_does_not_roll_the_session(
        self, handler, front
    ):
        """The old rule rolled at the liquidity crossover. The roll is now the
        next session's decision, so the whole session stays on ESU6."""
        payloads = [
            # Minute :56, ESU6 leads.
            _print(sym="ESU6", price="7700.00", size=5, trade_id=1),
            _print(sym="ESZ6", executed_at=_BASE_MS + 10, price="7900.00", size=1, trade_id=2),
            # Minute :57, ESZ6 takes the lead on volume.
            _print(sym="ESZ6", executed_at=_BASE_MS + 60_000, price="7910.00", size=50, trade_id=3),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_010, price="7701.00", size=1, trade_id=4),
            # Minute :58 completes :57.
            _print(sym="ESZ6", executed_at=_BASE_MS + 120_000, trade_id=5),
        ]
        rows = await _flush_capture(handler, payloads)

        assert [(r[_C["close"]], r[_C["volume"]], r[_C["contract"]]) for r in rows] == [
            (Decimal("7700.00"), 5, "ESU6"),
            (Decimal("7701.00"), 1, "ESU6"),
        ]
        assert front.ensure_calls == [("ES", _D)]
        # The volume is still counted: it is the next session's input.
        assert _counts(handler) == {"ESU6": 6, "ESZ6": 52}

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
        assert by_symbol["ES"][_C["contract"]] == "ESU6"
        assert by_symbol["NQ"][_C["contract"]] == "NQU6"

    @pytest.mark.asyncio
    async def test_one_decision_per_root_and_trade_date_is_asked_once(self, handler, front):
        payloads = [
            _print(product="ES", sym="ESU6", trade_id=1),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 10, trade_id=2),
            _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 60_010, trade_id=4),
        ]
        await _flush_capture(handler, payloads)
        await _flush_capture(
            handler, [_print(product="ES", sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=5)]
        )

        assert sorted(front.ensure_calls) == [("ES", _D), ("NQ", _D)]

    @pytest.mark.asyncio
    async def test_the_16_59_and_17_00_ct_minutes_take_different_contracts(self, handler, front):
        """The session opens at 17:00 CT. After a roll, the minute before the
        open belongs to the old session's contract and the open to the new."""
        front.decisions[("ES", _D)] = "ESU6"
        front.decisions[("ES", date(2026, 9, 9))] = "ESZ6"
        before_open = _OPEN_09_09_MS - 60_000  # 21:59Z = 16:59 CDT, trade date 09-08
        payloads = [
            _print(sym="ESU6", executed_at=before_open, price="7700.00", size=3, trade_id=1),
            _print(sym="ESZ6", executed_at=before_open + 10, price="7900.00", size=9, trade_id=2),
            _print(sym="ESU6", executed_at=_OPEN_09_09_MS, price="7701.00", size=2, trade_id=3),
            _print(
                sym="ESZ6", executed_at=_OPEN_09_09_MS + 10, price="7901.00", size=8, trade_id=4
            ),
            # 17:01 completes the 17:00 minute.
            _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 60_000, trade_id=5),
        ]
        rows = await _flush_capture(handler, payloads)

        by_ts = {r[_C["ts"]]: r for r in rows}
        old_session = by_ts[datetime(2026, 9, 8, 21, 59, tzinfo=UTC)]
        new_session = by_ts[datetime(2026, 9, 8, 22, 0, tzinfo=UTC)]
        assert (old_session[_C["contract"]], old_session[_C["volume"]]) == ("ESU6", 3)
        assert old_session[_C["close"]] == Decimal("7700.00")
        assert (new_session[_C["contract"]], new_session[_C["volume"]]) == ("ESZ6", 8)
        assert new_session[_C["close"]] == Decimal("7901.00")
        assert front.ensure_calls == [("ES", _D), ("ES", date(2026, 9, 9))]

    @pytest.mark.asyncio
    async def test_a_back_month_leading_after_midnight_utc_does_not_change_the_contract(
        self, handler, front
    ):
        """Midnight UTC is 19:00 CDT, inside one session. The old rule reset its
        tally there, and a back month leading the first minutes took the front."""
        front.decisions[("ES", date(2026, 9, 9))] = "ESZ6"
        midnight = 1788912000000  # 2026-09-09T00:00:00Z
        payloads = [
            _print(sym="ESZ6", executed_at=midnight - 30_000, price="7700.00", size=5, trade_id=1),
            _print(
                sym="ESH7", executed_at=midnight + 10_000, price="7755.00", size=500, trade_id=2
            ),
            _print(sym="ESZ6", executed_at=midnight + 15_000, price="7701.00", size=1, trade_id=3),
            # 00:01 completes 23:59 and 00:00.
            _print(sym="ESZ6", executed_at=midnight + 70_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)

        assert [(r[_C["ts"]], r[_C["contract"]], r[_C["volume"]]) for r in rows] == [
            (datetime(2026, 9, 8, 23, 59, tzinfo=UTC), "ESZ6", 5),
            (datetime(2026, 9, 9, 0, 0, tzinfo=UTC), "ESZ6", 1),
        ]
        assert front.ensure_calls == [("ES", date(2026, 9, 9))]
        assert _counts(handler, day=date(2026, 9, 9)) == {"ESZ6": 7, "ESH7": 500}

    @pytest.mark.asyncio
    async def test_a_new_utc_day_in_one_session_keeps_the_tally(self, handler):
        """The tally belongs to the trade date, not the UTC date."""
        await _flush_capture(
            handler,
            [
                _print(sym="ESU6", executed_at=1788911990000, size=5, trade_id=1),  # 23:59:50Z
                _print(sym="ESU6", executed_at=1788912010000, size=7, trade_id=2),  # 00:00:10Z
            ],
        )
        assert _counts(handler, day=date(2026, 9, 9)) == {"ESU6": 12}
        assert (("ES", date(2026, 9, 8))) not in handler._tally

    @pytest.mark.asyncio
    async def test_session_roll_starts_a_new_tally(self, handler):
        day2 = _OPEN_09_09_MS
        await _flush_capture(
            handler,
            [
                _print(sym="ESU6", executed_at=day2 - 60_000, size=100, trade_id=1),
                _print(sym="ESU6", executed_at=day2, size=4, trade_id=2),
                _print(sym="ESZ6", executed_at=day2 + 1_000, size=6, trade_id=3),
            ],
        )
        assert _counts(handler) == {"ESU6": 100}
        assert _counts(handler, day=date(2026, 9, 9)) == {"ESU6": 4, "ESZ6": 6}

    @pytest.mark.asyncio
    async def test_a_late_print_for_the_last_minute_of_the_old_session_keeps_its_contract(
        self, handler, front
    ):
        """The old session's last minute is still open when the first print of
        the new session arrives, and a straggler for it can follow. It builds
        the old session's bar, on the old session's contract, and is counted in
        the old session's tally: never re-elected from the new session."""
        front.decisions[("ES", _D)] = "ESU6"
        front.decisions[("ES", date(2026, 9, 9))] = "ESZ6"
        last_minute = _OPEN_09_09_MS - 10_000  # 21:59:50Z
        rows = await _flush_capture(
            handler,
            [
                _print(sym="ESU6", executed_at=last_minute, price="7700.00", size=4, trade_id=1),
                # 17:00:05 CT, the first print of the new session.
                _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, price="7900.00", trade_id=2),
                # Stragglers for 16:59: a back month and the decided contract.
                _print(
                    sym="ESH7", executed_at=last_minute + 5_000, price="7755.00", size=5, trade_id=3
                ),
                _print(
                    sym="ESU6", executed_at=last_minute + 8_000, price="7702.00", size=1, trade_id=4
                ),
                # 17:01 completes 16:59 and 17:00.
                _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=5),
            ],
        )

        by_ts = {r[_C["ts"]]: r for r in rows}
        old = by_ts[datetime(2026, 9, 8, 21, 59, tzinfo=UTC)]
        assert (old[_C["contract"]], old[_C["volume"]], old[_C["close"]]) == (
            "ESU6",
            5,
            Decimal("7702.00"),
        )
        assert by_ts[datetime(2026, 9, 8, 22, 0, tzinfo=UTC)][_C["contract"]] == "ESZ6"
        assert _counts(handler) == {"ESU6": 5, "ESH7": 5}
        assert _counts(handler, day=date(2026, 9, 9)) == {"ESZ6": 2}
        assert front.ensure_calls == [("ES", _D), ("ES", date(2026, 9, 9))]

    @pytest.mark.asyncio
    async def test_a_straggler_uses_the_stored_decision_of_its_own_session(self, handler, front):
        """A restart can see the old session's straggler first: its decision is
        read from the store, not taken from the session the next print is in."""
        front.decisions[("ES", _D)] = "ESU6"
        front.decisions[("ES", date(2026, 9, 9))] = "ESZ6"
        rows = await _flush_capture(
            handler,
            [
                _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=1),
                _print(sym="ESU6", executed_at=_OPEN_09_09_MS - 5_000, price="7701.00", trade_id=2),
                _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3),
            ],
        )

        by_ts = {r[_C["ts"]]: r for r in rows}
        assert by_ts[datetime(2026, 9, 8, 21, 59, tzinfo=UTC)][_C["contract"]] == "ESU6"
        assert by_ts[datetime(2026, 9, 8, 22, 0, tzinfo=UTC)][_C["contract"]] == "ESZ6"
        assert sorted(front.ensure_calls) == [("ES", _D), ("ES", date(2026, 9, 9))]

    @pytest.mark.asyncio
    async def test_a_restart_inside_a_session_keeps_its_contract_and_carries_the_tally_on(
        self, handler, front
    ):
        """A new process starts counting from zero. The old rule would have
        elected whichever contract printed most since the restart; the stored
        decision and the stored tally make the restart invisible."""
        front.decisions[("ES", _D)] = "ESU6"
        front.stored[("ES", _D)] = {"ESU6": 5000, "ESZ6": 1200}
        payloads = [
            _print(sym="ESU6", price="7700.00", size=5, trade_id=1),
            # Since the restart the back month has printed 20 times as much.
            _print(sym="ESZ6", executed_at=_BASE_MS + 10, price="7900.00", size=100, trade_id=2),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
            _print(sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)

        assert [(r[_C["contract"]], r[_C["volume"]]) for r in rows] == [("ESU6", 5), ("ESU6", 1)]
        assert front.load_calls == [("ES", _D)]
        assert _counts(handler) == {"ESU6": 5007, "ESZ6": 1300}
        assert front.saved_volume == {("ES", _D, "ESU6"): 5007, ("ES", _D, "ESZ6"): 1300}

    @pytest.mark.asyncio
    async def test_the_tally_is_saved_before_a_new_sessions_decision_is_asked_for(
        self, handler, front
    ):
        """The decision for the new session reads the volume of the one that
        just ended, so that volume is in the table first."""
        await _flush_capture(handler, [_print(sym="ESU6", size=4, trade_id=1)])
        assert front.saves == []  # one open minute: nothing emitted, nothing saved
        front.events.clear()

        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )

        assert front.events[:3] == ["load", "save", "ensure"]
        assert front.saves[0] == [("ES", _D, "ESU6", 4)]

    @pytest.mark.asyncio
    async def test_a_lookup_that_fails_at_the_open_is_a_logged_gap_and_is_asked_again_later(
        self, handler, front
    ):
        """Neon unreachable while deciding the new session: the minute is a
        gap with an error log, the failure is not cached, and it is asked
        again after the retry-after."""
        new_day = date(2026, 9, 9)
        front.decisions[("ES", new_day)] = None  # ensure_front found nothing
        first = [
            _print(sym="ESU6", executed_at=_OPEN_09_09_MS - 5_000, trade_id=1),
            _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2),
            # 17:01 completes 16:59 (old session, fine) and 17:00 (unknown).
            _print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3),
        ]
        with patch("handlers.futures_trades.log") as mock_log:
            rows = await _flush_capture(handler, first)

        assert [r[_C["ts"]] for r in rows] == [datetime(2026, 9, 8, 21, 59, tzinfo=UTC)]
        assert mock_log.error.call_count == 1
        extra = mock_log.error.call_args.kwargs["extra"]
        assert extra["kind"] == "front_month_unknown"
        assert extra["scope"] == "futures_trades"
        assert extra["product"] == "ES"
        assert extra["trade_date"] == "2026-09-09"
        assert ("ES", new_day) not in handler._decided

        # Neon is back, and the retry-after has run out. The 17:01 minute
        # completes on the next flush.
        front.decisions[("ES", new_day)] = "ESZ6"
        _let_the_retry_after_run_out(handler)
        rows = await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 125_000, trade_id=4)]
        )

        assert [(r[_C["ts"]], r[_C["contract"]]) for r in rows] == [
            (datetime(2026, 9, 8, 22, 1, tzinfo=UTC), "ESZ6")
        ]
        assert front.ensure_calls.count(("ES", new_day)) == 2
        assert handler._decided[("ES", new_day)] == "ESZ6"

    @pytest.mark.asyncio
    async def test_an_unknown_decision_is_logged_once_per_window_and_product(self, handler, front):
        front.decisions[("ES", _D)] = None
        front.decisions[("NQ", _D)] = None
        minutes = [_BASE_MS + i * 60_000 for i in range(4)]
        payloads = [
            _print(product=p, sym=f"{p}U6", executed_at=ms, trade_id=i * 2 + (p == "NQ"))
            for i, ms in enumerate(minutes)
            for p in ("ES", "NQ")
        ]
        with patch("handlers.futures_trades.log") as mock_log:
            rows = await _flush_capture(handler, payloads)
            assert rows == []
            logged = [(c.kwargs["extra"]["product"]) for c in mock_log.error.call_args_list]
            assert sorted(logged) == ["ES", "NQ"]  # three gaps each, one line each

            # The window expires: the next unknown minute logs again, with the total.
            for product in ("ES", "NQ"):
                handler._unknown_logged_at[product] -= MALFORMED_PAYLOAD_LOG_INTERVAL_S
            await _flush_capture(handler, [_print(executed_at=_BASE_MS + 5 * 60_000, trade_id=99)])
            await _flush_capture(handler, [_print(executed_at=_BASE_MS + 6 * 60_000, trade_id=100)])

        later = [c.kwargs["extra"] for c in mock_log.error.call_args_list][2:]
        assert [e["product"] for e in later] == ["ES"]
        assert later[0]["unknown_total"] == 7

    @pytest.mark.asyncio
    async def test_a_decision_that_is_known_is_not_asked_for_again(self, handler, front):
        await _flush_capture(handler, [_print(trade_id=1)])
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 60_000, trade_id=2)])
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, trade_id=3)])
        assert front.ensure_calls == [("ES", _D)]
        assert front.load_calls == [("ES", _D)]

    @pytest.mark.asyncio
    async def test_every_emitted_bar_carries_its_contract(self, handler):
        payloads = [
            _print(trade_id=1),
            _print(executed_at=_BASE_MS + 60_000, trade_id=2),
            _print(executed_at=_BASE_MS + 120_000, trade_id=3),
            _print(executed_at=_BASE_MS + 180_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)
        assert len(rows) == 3
        assert {r[_C["contract"]] for r in rows} == {"ESU6"}
        assert _COLUMNS[-1] == "contract"

    @pytest.mark.asyncio
    async def test_two_spellings_of_one_contract_are_one_tally_key_and_one_bar(self, handler):
        payloads = [
            _print(sym="ESU6", price="7700.00", size=4, trade_id=1),
            _print(sym="ESU26", executed_at=_BASE_MS + 10, price="7701.00", size=6, trade_id=2),
            _print(sym="ESU6", executed_at=_BASE_MS + 20, price="7702.00", size=1, trade_id=3),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=4),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["volume"]] == 11
        assert rows[0][_C["close"]] == Decimal("7702.00")
        assert rows[0][_C["contract"]] == "ESU6"
        assert _counts(handler) == {"ESU6": 12}
        assert {key[2] for key in handler._bars} == {"ESU6"}

    @pytest.mark.asyncio
    async def test_a_redelivery_under_the_other_spelling_is_still_a_duplicate(self, handler):
        payloads = [
            _print(sym="ESU6", size=3, trade_id=42),
            _print(sym="ESU26", size=3, trade_id=42),
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=43),
        ]
        rows = await _flush_capture(handler, payloads)
        assert rows[0][_C["volume"]] == 3

    def test_the_two_digit_spelling_is_canonical_in_the_normalized_print(self, handler):
        printed = handler._transform(_print(sym="ESU26"))
        assert printed.contract == "ESU6"
        assert printed.trade_date == _D

    def test_a_two_digit_year_outside_the_window_is_dropped_with_a_warning(self, handler):
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            assert handler._transform(_print(sym="ESZ36")) is None
        call = mock_log.warning.call_args
        assert call.kwargs["scope"] == "futures_trades"
        assert call.kwargs["kind"] == "contract_out_of_window"
        assert call.kwargs["extra"] == {"product": "ES", "sym": "ESZ36"}

    @pytest.mark.asyncio
    async def test_a_contract_name_the_column_check_would_refuse_is_written_as_null(self, handler):
        """futures_bars.contract has a CHECK (migration #204). One bad name in
        the multi-row INSERT would fail the whole flush, so the bar is kept
        with a NULL contract and a warning instead."""
        handler._decided[("ES", _D)] = "NQU6"  # another root's contract
        handler._bars[("ES", _BASE_MINUTE, "NQU6")] = ft._Bar(
            open=Decimal("1"),
            high=Decimal("1"),
            low=Decimal("1"),
            close=Decimal("1"),
            volume=3,
            first_at=_BASE_MINUTE,
            last_at=_BASE_MINUTE,
        )
        handler._newest_minute["ES"] = _BASE_MINUTE + timedelta(minutes=1)

        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            rows = handler._collect_completed()

        assert len(rows) == 1
        assert rows[0][_C["contract"]] is None
        assert rows[0][_C["volume"]] == 3
        call = mock_log.warning.call_args
        assert call.kwargs["kind"] == "invalid_contract"
        assert call.kwargs["extra"]["contract"] == "NQU6"


# ----------------------------------------------------------------------
# 5b. The session tally: deduped outright volume per contract, saved to
#     futures_contract_volume (source live) for the next session's decision
# ----------------------------------------------------------------------


class TestSessionTally:
    @pytest.mark.asyncio
    async def test_saved_when_minutes_are_emitted_and_not_before(self, handler, front):
        await _flush_capture(handler, [_print(size=4, trade_id=1)])
        assert front.saves == []  # the only minute is still open

        await _flush_capture(
            handler,
            [
                _print(sym="ESZ6", executed_at=_BASE_MS + 10, size=6, trade_id=2),
                _print(executed_at=_BASE_MS + 60_000, size=1, trade_id=3),
            ],
        )

        assert front.saves == [[("ES", _D, "ESU6", 5), ("ES", _D, "ESZ6", 6)]]
        assert front.saved_volume == {("ES", _D, "ESU6"): 5, ("ES", _D, "ESZ6"): 6}

    @pytest.mark.asyncio
    async def test_the_saved_volume_is_cumulative_and_only_changed_sessions_are_saved(
        self, handler, front
    ):
        await _flush_capture(
            handler,
            [
                _print(product="ES", sym="ESU6", size=3, trade_id=1),
                _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 5, size=2, trade_id=2),
                _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
                _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 60_005, trade_id=4),
            ],
        )
        await _flush_capture(
            handler,
            [_print(product="ES", sym="ESU6", executed_at=_BASE_MS + 120_000, size=9, trade_id=5)],
        )

        # Second save: ES only (NQ saw nothing new), with the running total.
        assert [(p, c, v) for p, _, c, v in front.saves[1]] == [("ES", "ESU6", 3 + 1 + 9)]

    @pytest.mark.asyncio
    async def test_only_deduped_outright_prints_are_counted(self, handler):
        spread = _print(sym="ESZ6-ESH7", size=1000, trade_id=1)
        block = _print(size=500, trade_id=2, is_block=True)
        dup = _print(size=3, trade_id=3)
        await _flush_capture(
            handler,
            [spread, block, dup, dict(dup), dict(dup), _print(trade_id=4, size=2)],
        )
        assert _counts(handler) == {"ESU6": 5}

    @pytest.mark.asyncio
    async def test_a_save_that_fails_keeps_the_bars_and_is_retried_with_the_running_total(
        self, handler, front
    ):
        front.fail_save = RuntimeError("neon down")
        payloads = [
            _print(size=4, trade_id=1),
            _print(executed_at=_BASE_MS + 60_000, size=1, trade_id=2),
        ]
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1  # the bar is written
        assert front.saves == []
        call = mock_log.error.call_args  # not transient: an error, which reaches Sentry
        assert call.kwargs["kind"] == "tally_save_failed"
        assert call.kwargs["key"] == "ES"
        assert call.kwargs["extra"]["err_type"] == "RuntimeError"
        assert mock_log.warning.call_args_list == []
        assert handler._tally[("ES", _D)].dirty is True

        front.fail_save = None
        _let_the_retry_after_run_out(handler)
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, size=2, trade_id=3)])
        assert front.saved_volume == {("ES", _D, "ESU6"): 4 + 1 + 2}
        assert handler._tally[("ES", _D)].dirty is False

    @pytest.mark.asyncio
    async def test_a_tally_that_cannot_be_loaded_counts_on_and_merges_when_it_loads(
        self, handler, front
    ):
        front.fail_load = _blip()
        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            rows = await _flush_capture(
                handler,
                [
                    _print(size=4, trade_id=1),
                    _print(executed_at=_BASE_MS + 60_000, size=1, trade_id=2),
                ],
            )

        assert [r[_C["contract"]] for r in rows] == ["ESU6"]  # the bar does not wait for it
        # A dropped connection is transient: a warning, in the root's own window.
        kinds = [c.kwargs["kind"] for c in mock_log.warning.call_args_list]
        assert kinds == ["tally_load_failed"]
        assert mock_log.warning.call_args.kwargs["key"] == "ES"
        assert (
            mock_log.warning.call_args.kwargs["extra"]["err_type"] == "ConnectionDoesNotExistError"
        )
        assert mock_log.error.call_args_list == []
        assert front.saves == []  # nothing saved over a tally that was never read
        assert handler._tally[("ES", _D)].loaded is False

        front.fail_load = None
        _let_the_retry_after_run_out(handler)
        front.stored[("ES", _D)] = {"ESU6": 100, "ESZ6": 30}
        # A print for ESZ6 only, in the minute that is still open: it loads the
        # tally and emits nothing, so nothing is saved yet.
        await _flush_capture(
            handler,
            [_print(sym="ESZ6", executed_at=_BASE_MS + 60_100, size=1, trade_id=3)],
        )

        tally = handler._tally[("ES", _D)]
        assert tally.loaded is True
        assert front.saves == []
        # The table holds the stored volume. What this process counted while the
        # load was failing (4 + 1 ESU6 lots, and the ESZ6 lot) is still owed to it.
        assert tally.saved == {"ESU6": 100, "ESZ6": 30}
        assert tally.unsaved() == {"ESU6": 105, "ESZ6": 31}

        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, size=2, trade_id=4)])

        assert _counts(handler) == {"ESU6": 100 + 4 + 1 + 2, "ESZ6": 31}
        # Both contracts rose above what the table holds, so both go.
        assert front.saved_volume == {("ES", _D, "ESU6"): 107, ("ES", _D, "ESZ6"): 31}

    @pytest.mark.asyncio
    async def test_a_tally_that_could_not_be_saved_holds_back_the_next_sessions_decision(
        self, handler, front
    ):
        new_day = date(2026, 9, 9)
        front.decisions[("ES", new_day)] = "ESZ6"
        await _flush_capture(handler, [_print(sym="ESU6", executed_at=_OPEN_09_09_MS - 30_000)])
        front.fail_save = RuntimeError("neon down")

        # The first print of the new session: it cannot be decided from a
        # volume that is not in the table yet, so it is not asked for.
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )
        assert front.ensure_calls == [("ES", _D)]
        assert ("ES", new_day) not in handler._decided

        front.fail_save = None
        _let_the_retry_after_run_out(handler)
        rows = await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3)]
        )

        assert ("ES", new_day) in front.ensure_calls
        assert [(r[_C["ts"]], r[_C["contract"]]) for r in rows] == [
            (datetime(2026, 9, 8, 22, 0, tzinfo=UTC), "ESZ6")
        ]

    @pytest.mark.asyncio
    async def test_a_tally_that_could_not_be_loaded_holds_back_the_next_sessions_decision(
        self, handler, front
    ):
        new_day = date(2026, 9, 9)
        front.fail_load = _blip()
        await _flush_capture(handler, [_print(sym="ESU6", executed_at=_OPEN_09_09_MS - 30_000)])
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )
        assert ("ES", new_day) not in front.ensure_calls

    @pytest.mark.asyncio
    async def test_state_is_bounded_to_two_sessions_per_product(self, handler):
        for day in range(5):
            base = _BASE_MS + day * 86_400_000
            await _flush_capture(
                handler,
                [
                    _print(sym="ESU6", executed_at=base, trade_id=day * 2),
                    _print(sym="ESU6", executed_at=base + 60_000, trade_id=day * 2 + 1),
                ],
            )
            assert len(handler._tally) <= 2
            assert len(handler._decided) <= 2

        assert sorted(d for (_, d) in handler._tally) == [date(2026, 9, 11), date(2026, 9, 12)]
        assert set(handler._decided) == set(handler._tally)

    @pytest.mark.asyncio
    async def test_only_the_contracts_that_rose_are_saved(self, handler, front):
        """A cumulative payload is diffed against what the table already has
        (R5): ESZ6 did not move, so it is not rewritten."""
        await _flush_capture(
            handler,
            [
                _print(sym="ESU6", size=4, trade_id=1),
                _print(sym="ESZ6", executed_at=_BASE_MS + 5, size=6, trade_id=2),
                _print(sym="ESU6", executed_at=_BASE_MS + 60_000, size=1, trade_id=3),
            ],
        )
        assert front.saves == [[("ES", _D, "ESU6", 5), ("ES", _D, "ESZ6", 6)]]

        await _flush_capture(
            handler, [_print(sym="ESU6", executed_at=_BASE_MS + 120_000, size=2, trade_id=4)]
        )
        assert front.saves[1] == [("ES", _D, "ESU6", 7)]

    @pytest.mark.asyncio
    async def test_a_failed_save_leaves_the_mark_so_the_next_save_sends_it_again(
        self, handler, front
    ):
        front.fail_save = RuntimeError("neon down")
        await _flush_capture(
            handler,
            [
                _print(sym="ESU6", size=4, trade_id=1),
                _print(sym="ESZ6", executed_at=_BASE_MS + 5, size=6, trade_id=2),
                _print(sym="ESU6", executed_at=_BASE_MS + 60_000, size=1, trade_id=3),
            ],
        )
        assert handler._tally[("ES", _D)].saved == {}

        front.fail_save = None
        _let_the_retry_after_run_out(handler)
        await _flush_capture(
            handler, [_print(sym="ESU6", executed_at=_BASE_MS + 120_000, size=2, trade_id=4)]
        )

        # Nothing was acknowledged, so both contracts go, ESZ6 included.
        assert front.saves == [[("ES", _D, "ESU6", 7), ("ES", _D, "ESZ6", 6)]]
        assert handler._tally[("ES", _D)].saved == {"ESU6": 7, "ESZ6": 6}

    @pytest.mark.asyncio
    async def test_a_loaded_tally_is_not_sent_back_until_it_rises(self, handler, front):
        front.stored[("ES", _D)] = {"ESU6": 100, "ESZ6": 30}
        await _flush_capture(
            handler,
            [
                _print(sym="ESU6", size=4, trade_id=1),
                _print(sym="ESU6", executed_at=_BASE_MS + 60_000, size=1, trade_id=2),
            ],
        )
        assert front.saves == [[("ES", _D, "ESU6", 105)]]  # ESZ6's 30 is already stored


# ----------------------------------------------------------------------
# 5c. The front-month calls are time-boxed and not repeated at once, and a
#     failure that is not a Neon blip reaches Sentry with its cause
# ----------------------------------------------------------------------


class TestFrontMonthCallsAreBounded:
    def test_the_time_box_and_the_retry_after(self):
        # 8 s caps one call so a hung connection can't hold a flush for the
        # ~92 s asyncpg would take; 30 s keeps a failing root from costing a
        # retry's backoff on every flush.
        assert ft._LOOKUP_TIMEOUT_S == 8.0
        assert ft._RETRY_AFTER_S == 30.0

    @pytest.mark.asyncio
    async def test_a_hanging_decision_is_cut_at_the_time_box_and_a_decided_root_keeps_its_bars(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        # NQ is loaded and decided before the hang, so it needs no call.
        await _flush_capture(handler, [_print(product="NQ", sym="NQU6", trade_id=10)])
        front.hang_ensure = {"ES"}
        payloads = [
            _print(product="ES", sym="ESU6", trade_id=1),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 5, trade_id=2),
            _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
            _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 60_005, trade_id=4),
        ]
        with (
            patch("handlers.futures_trades.log") as mock_log,
            patch("handlers.futures_trades.rate_limited_log") as mock_rl,
        ):
            rows = await asyncio.wait_for(_flush_capture(handler, payloads), timeout=5)

        assert [r[_C["symbol"]] for r in rows] == ["NQ"]
        assert ("ES", _D) not in handler._decided
        # The cut is a TimeoutError: transient, so a warning, in ES's window.
        assert mock_rl.error.call_args_list == []
        call = mock_rl.warning.call_args
        assert call.kwargs["kind"] == "lookup_timeout"
        assert call.kwargs["key"] == "ES"
        # ...and the gap it costs is an error that names the cause.
        extra = mock_log.error.call_args.kwargs["extra"]
        assert (extra["kind"], extra["product"]) == ("front_month_unknown", "ES")
        assert (extra["cause_kind"], extra["cause_err_type"]) == ("lookup_timeout", "TimeoutError")

    @pytest.mark.asyncio
    async def test_a_hanging_tally_load_is_cut_at_the_time_box(self, handler, front, monkeypatch):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_load = {"ES"}
        with patch("handlers.futures_trades.log") as mock_log:
            rows = await asyncio.wait_for(
                _flush_capture(
                    handler,
                    [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)],
                ),
                timeout=5,
            )
        assert handler._tally[("ES", _D)].loaded is False
        # A call timed out, so no front-month call is made for 30 s, the
        # root's decision included: its minute is a gap that names the timeout.
        assert rows == []
        assert front.ensure_calls == []
        extra = mock_log.error.call_args.kwargs["extra"]
        assert (extra["cause_kind"], extra["cause_err_type"]) == (
            "tally_load_failed",
            "TimeoutError",
        )

    @pytest.mark.asyncio
    async def test_a_hanging_tally_save_is_cut_at_the_time_box(self, handler, front, monkeypatch):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_save = True
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            rows = await asyncio.wait_for(
                _flush_capture(
                    handler,
                    [_print(size=4, trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)],
                ),
                timeout=5,
            )

        assert [r[_C["contract"]] for r in rows] == ["ESU6"]  # the bar does not wait for it
        tally = handler._tally[("ES", _D)]
        assert tally.saved == {}
        assert tally.dirty is True
        assert ("save", "ES", None) in handler._retry_after
        # The cut is a TimeoutError: transient, so a warning, in ES's window.
        assert mock_rl.error.call_args_list == []
        call = mock_rl.warning.call_args
        assert (call.kwargs["kind"], call.kwargs["key"]) == ("tally_save_failed", "ES")
        assert call.kwargs["extra"]["err_type"] == "TimeoutError"

    @pytest.mark.asyncio
    async def test_a_failed_decision_is_not_asked_again_inside_the_retry_after(
        self, handler, front
    ):
        front.decisions[("ES", _D)] = None
        front.failures["ES"] = ("ensure_front_failed", "UndefinedTableError")
        await _flush_capture(
            handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)]
        )
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, trade_id=3)])
        assert front.ensure_calls == [("ES", _D)]  # once, not once per flush

        _let_the_retry_after_run_out(handler)
        front.decisions[("ES", _D)] = "ESU6"
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 180_000, trade_id=4)])

        assert front.ensure_calls == [("ES", _D), ("ES", _D)]
        assert handler._decided[("ES", _D)] == "ESU6"
        assert ("decide", "ES", _D) not in handler._retry_after  # a success clears it

    @pytest.mark.asyncio
    async def test_a_failed_tally_load_is_not_retried_inside_the_retry_after(self, handler, front):
        front.fail_load = _blip()
        await _flush_capture(
            handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)]
        )
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, trade_id=3)])
        assert front.load_calls == [("ES", _D)]

        _let_the_retry_after_run_out(handler)
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 180_000, trade_id=4)])
        assert front.load_calls == [("ES", _D), ("ES", _D)]

    @pytest.mark.asyncio
    async def test_a_failed_tally_save_is_not_retried_inside_the_retry_after(self, handler, front):
        front.decisions[("ES", date(2026, 9, 9))] = "ESZ6"
        await _flush_capture(handler, [_print(sym="ESU6", executed_at=_OPEN_09_09_MS - 30_000)])
        front.fail_save = RuntimeError("neon down")
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3)]
        )
        # The decision's save, then nothing: not at the next decision, not at
        # the next emitted minute.
        assert front.save_attempts == 1

        _let_the_retry_after_run_out(handler)
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 125_000, trade_id=4)]
        )
        assert front.save_attempts == 2

    @pytest.mark.asyncio
    async def test_one_roots_failure_does_not_delay_another_roots_bars(self, handler, front):
        front.decisions[("ES", _D)] = None
        first = await _flush_capture(
            handler,
            [
                _print(product="ES", sym="ESU6", trade_id=1),
                _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 5, trade_id=2),
                _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=3),
                _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 60_005, trade_id=4),
            ],
        )
        second = await _flush_capture(
            handler,
            [
                _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=5),
                _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 120_005, trade_id=6),
            ],
        )

        assert [r[_C["symbol"]] for r in first] == ["NQ"]
        assert [(r[_C["symbol"]], r[_C["ts"]].minute) for r in second] == [("NQ", 57)]
        # ES was asked once in all that, NQ once.
        assert sorted(front.ensure_calls) == [("ES", _D), ("NQ", _D)]

    @pytest.mark.asyncio
    async def test_retry_afters_go_with_their_sessions(self, handler, front):
        front.decisions[("ES", _D)] = None
        for day in range(4):
            base = _BASE_MS + day * 86_400_000
            await _flush_capture(
                handler,
                [
                    _print(trade_id=day * 2, executed_at=base),
                    _print(trade_id=day * 2 + 1, executed_at=base + 60_000),
                ],
            )
        assert ("decide", "ES", _D) not in handler._retry_after
        assert all(
            day is None or (product, day) in handler._tally
            for (_op, product, day) in handler._retry_after
        )

    @pytest.mark.asyncio
    async def test_a_save_that_works_again_clears_its_retry_after(self, handler, front):
        front.fail_save = RuntimeError("neon down")
        await _flush_capture(
            handler,
            [_print(size=4, trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)],
        )
        assert ("save", "ES", None) in handler._retry_after

        front.fail_save = None
        _let_the_retry_after_run_out(handler)
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 120_000, trade_id=3)])

        assert front.saved_volume == {("ES", _D, "ESU6"): 6}
        assert ("save", "ES", None) not in handler._retry_after


_SIX = ("ES", "NQ", "RTY", "CL", "GC", "ZN")


def _six_roots(minute: int, minutes: int = 1) -> list[dict]:
    """One print per root in each of ``minutes`` consecutive minutes from ``minute``."""
    prints = []
    for i, product in enumerate(_SIX):
        sym = "CLV6" if product == "CL" else f"{product}U6"  # the fake's contracts
        for m in range(minute, minute + minutes):
            prints.append(
                _print(
                    product=product,
                    sym=sym,
                    executed_at=_BASE_MS + m * 60_000 + i,
                    trade_id=i * 1000 + m,
                )
            )
    return prints


def _front_month_calls(front: _FakeFront) -> int:
    return len(front.load_calls) + len(front.ensure_calls) + front.save_attempts


class TestOneBoxPerHang:
    """After a call times out, no root makes a front-month call for the retry-after.

    The box is per hang, not per call: a Neon that hangs would otherwise cost
    every root its own 8 s, 12 calls at the open and again 30 s later.
    """

    @pytest.mark.asyncio
    async def test_six_roots_all_hang_costs_one_timed_call_per_retry_after(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_load = front.hang_ensure = set(_SIX)
        front.hang_save = True

        # The open: every root needs a load, a save and a decision, and two
        # minutes of prints complete one minute each.
        with patch("handlers.futures_trades.log") as mock_log:
            rows = await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        assert rows == []
        assert _front_month_calls(front) == 1

        # Every root's lost minute is logged with the cause: the timeout. The
        # roots whose calls were skipped name it too.
        causes = {
            c.kwargs["extra"]["product"]: (
                c.kwargs["extra"]["cause_kind"],
                c.kwargs["extra"]["cause_err_type"],
            )
            for c in mock_log.error.call_args_list
        }
        assert sorted(causes) == sorted(_SIX)
        assert set(causes.values()) == {("tally_load_failed", "TimeoutError")}

        # Inside the 30 s: not one call, for any root, any kind.
        await asyncio.wait_for(_flush_capture(handler, _six_roots(2)), timeout=5)
        assert _front_month_calls(front) == 1

        # The first flush after it: one call, which times out again.
        _let_the_retry_after_run_out(handler)
        await asyncio.wait_for(_flush_capture(handler, _six_roots(3)), timeout=5)
        assert _front_month_calls(front) == 2

        # Recovered: once the pause and the two timed-out calls' cooling (twice
        # the pause) are over, every root loads, saves and is decided.
        front.hang_load = front.hang_ensure = set()
        front.hang_save = False
        _let_the_retry_after_run_out(handler)
        _let_the_retry_after_run_out(handler)
        rows = await _flush_capture(handler, _six_roots(4))

        assert {p for p, _ in front.load_calls} == set(_SIX)
        assert {p for p, _ in front.ensure_calls} == set(_SIX)
        assert set(handler._decided) == {(p, _D) for p in _SIX}
        assert {p for p, _, _ in front.saved_volume} == set(_SIX)
        assert {r[_C["symbol"]] for r in rows} == set(_SIX)
        assert handler._boxed_out() is False

    @pytest.mark.asyncio
    async def test_the_pause_is_the_retry_after_not_a_flush(self, handler, front, monkeypatch):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_load = {"ES"}
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        deadline = handler._box_until
        assert deadline is not None
        # The pause is the retry-after, 30 s: neither a flush's worth nor a minute.
        remaining = deadline - time.monotonic()
        assert ft._RETRY_AFTER_S - 5 < remaining <= ft._RETRY_AFTER_S
        # Set once, from the call that timed out: later flushes don't push it out.
        await asyncio.wait_for(_flush_capture(handler, _six_roots(2)), timeout=5)
        assert handler._box_until == deadline

    @pytest.mark.asyncio
    async def test_a_skipped_roots_older_cause_is_replaced_by_the_timeout(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        # ES fails for another reason first: its decision comes back None.
        front.decisions[("ES", _D)] = None
        front.failures["ES"] = ("ensure_front_failed", "UndefinedTableError")
        await _flush_capture(handler, [_print(product="ES", sym="ESU6", trade_id=1)])
        assert handler._cause["ES"] == ("ensure_front_failed", "UndefinedTableError")

        # Its cooling is over, and NQ's load hangs and starts the pause. ES's
        # decision is now skipped for the pause, and its gap says so.
        _let_the_retry_after_run_out(handler)
        front.hang_load = {"NQ"}
        with patch("handlers.futures_trades.log") as mock_log:
            await asyncio.wait_for(
                _flush_capture(
                    handler,
                    [
                        _print(product="ES", sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=2),
                        _print(
                            product="ES", sym="ESU6", executed_at=_BASE_MS + 120_000, trade_id=3
                        ),
                        _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 61_000, trade_id=4),
                    ],
                ),
                timeout=5,
            )

        extra = next(
            c.kwargs["extra"]
            for c in mock_log.error.call_args_list
            if c.kwargs["extra"]["product"] == "ES"
        )
        assert (extra["cause_kind"], extra["cause_err_type"]) == (
            "tally_load_failed",
            "TimeoutError",
        )

    @pytest.mark.asyncio
    async def test_a_failure_that_is_not_a_timeout_leaves_the_other_roots_calls_going(
        self, handler, front
    ):
        front.fail_load_for = {"ES": _blip()}
        front.decisions[("NQ", _D)] = None
        rows = await _flush_capture(handler, _six_roots(0, 2))

        # ES's load and NQ's decision failed; every other root loaded and was
        # decided in the same flush, and no pause was started.
        assert {p for p, _ in front.load_calls} == set(_SIX)
        assert {p for p, _ in front.ensure_calls} == set(_SIX)
        assert {r[_C["symbol"]] for r in rows} == set(_SIX) - {"NQ"}
        assert handler._box_until is None

    @pytest.mark.asyncio
    async def test_a_timeout_in_one_kind_of_call_stops_the_others_too(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_save = True
        await asyncio.wait_for(
            _flush_capture(handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000)]),
            timeout=5,
        )
        assert front.save_attempts == 1

        # The save timed out. A new root, inside the pause, loads nothing and
        # asks for no decision.
        loads, ensures = len(front.load_calls), len(front.ensure_calls)
        await _flush_capture(
            handler, [_print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 120_000, trade_id=5)]
        )
        assert (len(front.load_calls), len(front.ensure_calls)) == (loads, ensures)
        assert ("NQ", _D) not in handler._decided

    @pytest.mark.asyncio
    async def test_a_save_that_is_due_waits_out_a_pause_started_by_another_roots_call(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        await _flush_capture(
            handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)]
        )
        assert front.save_attempts == 1  # the first emitted minute

        # NQ's decision hangs and starts the pause. ES has a tally to save and
        # completes a minute, which would save it.
        front.hang_ensure = {"NQ"}
        await asyncio.wait_for(
            _flush_capture(
                handler,
                [
                    _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 120_000, trade_id=7),
                    _print(executed_at=_BASE_MS + 120_000, trade_id=3),
                ],
            ),
            timeout=5,
        )

        assert front.save_attempts == 1
        assert handler._tally[("ES", _D)].dirty is True
        assert handler._boxed_out() is True

        # The pause over, the save goes.
        front.hang_ensure = set()
        _let_the_retry_after_run_out(handler)
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 180_000, trade_id=4)])
        assert front.save_attempts == 2
        assert handler._tally[("ES", _D)].dirty is False


class TestTimedOutCallsCoolLonger:
    """A call that timed out waits twice the pause; one that failed any other way, once.

    The pause is 30 s for everyone. If the call that caused it cooled for the same
    30 s it would be the first call after every pause, and a call that keeps timing
    out would re-arm the pause before any other root got a turn.
    """

    @staticmethod
    def _remaining(handler, key) -> float:
        return handler._retry_after[key] - time.monotonic()

    def test_the_constants(self):
        assert ft._TIMED_OUT_COOLING_S == 2 * ft._RETRY_AFTER_S == 60.0
        assert ft._TIMED_OUT_COOLING_MAX_S == 4 * ft._RETRY_AFTER_S == 120.0

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide"])
    async def test_a_timed_out_call_cools_for_twice_the_retry_after(
        self, handler, front, monkeypatch, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        if call == "load":
            front.hang_load = {"ES"}
        else:
            front.hang_ensure = {"ES"}
        await asyncio.wait_for(
            _flush_capture(handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000)]),
            timeout=5,
        )

        remaining = self._remaining(handler, (call, "ES", _D))
        assert ft._TIMED_OUT_COOLING_S - 5 < remaining <= ft._TIMED_OUT_COOLING_S
        # ...while the pause for the other roots is the plain retry-after.
        assert 0 < handler._box_until - time.monotonic() <= ft._RETRY_AFTER_S

    @pytest.mark.asyncio
    async def test_every_key_of_a_bulk_save_that_timed_out_cools_for_twice(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_save = True
        # Every root is loaded and decided, then one bulk save for all six hangs.
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)

        assert front.save_attempts == 1
        for product in _SIX:
            remaining = self._remaining(handler, ("save", product, None))
            assert ft._TIMED_OUT_COOLING_S - 5 < remaining <= ft._TIMED_OUT_COOLING_S

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide", "save"])
    async def test_a_failure_that_is_not_a_timeout_cools_for_the_retry_after(
        self, handler, front, call
    ):
        if call == "load":
            front.fail_load = _blip()
        elif call == "decide":
            front.decisions[("ES", _D)] = None
        else:
            front.fail_save = RuntimeError("neon down")
        await _flush_capture(
            handler, [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)]
        )

        key = (call, "ES", None if call == "save" else _D)
        remaining = self._remaining(handler, key)
        assert ft._RETRY_AFTER_S - 5 < remaining <= ft._RETRY_AFTER_S


class TestOneRootHang:
    """One root's call hangs on every try; the other five roots are still served.

    Aged by the retry-after (30 s) between flushes, with the pause and the timed-out
    call's cooling (60 s) on one clock.
    """

    @staticmethod
    async def _cycles(handler, cycles: int):
        """The open, then ``cycles`` flushes each 30 s later; the rows and the
        decided roots after the first of them."""
        rows = []
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        decided_after_first = None
        for cycle in range(1, cycles + 1):
            _let_the_retry_after_run_out(handler)
            rows += await asyncio.wait_for(
                _flush_capture(handler, _six_roots(cycle + 1)), timeout=5
            )
            if decided_after_first is None:
                decided_after_first = {p for p, _ in handler._decided}
        return rows, decided_after_first

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide"])
    @pytest.mark.parametrize("victim", _SIX)
    async def test_the_other_roots_are_loaded_decided_and_written_every_cycle(
        self, handler, front, monkeypatch, victim, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        if call == "load":
            front.hang_load = {victim}
            cause = ("tally_load_failed", "TimeoutError")
        else:
            front.hang_ensure = {victim}
            cause = ("lookup_timeout", "TimeoutError")
        others = set(_SIX) - {victim}

        with patch("handlers.futures_trades.log") as mock_log:
            rows, decided_after_first = await self._cycles(handler, 3)

        # The first cycle after the open already serves every other root.
        assert decided_after_first == others
        assert {p for p, _ in handler._decided} == others
        assert {r[_C["symbol"]] for r in rows} == others
        # Each of them was loaded and asked once, never held by the victim.
        assert {p for p, _ in front.load_calls} >= others
        assert {p for p, _ in front.ensure_calls} >= others
        # The victim's minutes are gaps that name its timeout.
        victim_gaps = [
            c.kwargs["extra"]
            for c in mock_log.error.call_args_list
            if c.kwargs["extra"]["product"] == victim
        ]
        assert victim_gaps
        assert {(g["cause_kind"], g["cause_err_type"]) for g in victim_gaps} == {cause}

    @pytest.mark.asyncio
    async def test_the_hung_call_is_asked_again_after_sixty_seconds_and_then_served(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_load = {"ES"}
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        assert front.load_calls.count(("ES", _D)) == 1

        # 30 s on: the pause is over, ES's own call is not.
        _let_the_retry_after_run_out(handler)
        await asyncio.wait_for(_flush_capture(handler, _six_roots(2)), timeout=5)
        assert front.load_calls.count(("ES", _D)) == 1
        assert ("ES", _D) not in handler._decided

        # 60 s on, Neon answers: ES loads, is decided and writes its bars.
        front.hang_load = set()
        _let_the_retry_after_run_out(handler)
        rows = await asyncio.wait_for(_flush_capture(handler, _six_roots(3)), timeout=5)

        assert front.load_calls.count(("ES", _D)) == 2
        assert handler._tally[("ES", _D)].loaded is True
        assert handler._decided[("ES", _D)] == "ESU6"
        assert {r[_C["symbol"]] for r in rows} == set(_SIX)


def _hang(front: _FakeFront, call: str, hung: bool = True) -> None:
    """Make ES's ``call`` hang on every try, or answer again."""
    if call == "load":
        front.hang_load = {"ES"} if hung else set()
    elif call == "decide":
        front.hang_ensure = {"ES"} if hung else set()
    else:
        front.hang_save = hung


def _es_key(call: str) -> tuple[str, str, date | None]:
    """ES's key in ``_retry_after`` for ``call``."""
    return (call, "ES", None if call == "save" else _D)


async def _flush_es(handler, n: int) -> None:
    """Flush ES prints in minutes 2n and 2n + 1: the session is in the batch and a
    minute completes, so a load, a decision and a save are all due."""
    await asyncio.wait_for(
        _flush_capture(
            handler,
            [
                _print(executed_at=_BASE_MS + 2 * n * 60_000, trade_id=2 * n + 1),
                _print(executed_at=_BASE_MS + (2 * n + 1) * 60_000, trade_id=2 * n + 2),
            ],
        ),
        timeout=5,
    )


class TestTimedOutCoolingBacksOff:
    """A call that keeps timing out waits 60 s, then 120 s; any other outcome starts it over.

    One key at a time: ES's load, decision or save hangs, the clock is run on past
    each cooling by hand, and each flush after it is one more try.
    """

    @staticmethod
    def _assert_cooling(handler, key, seconds: float) -> None:
        remaining = handler._retry_after[key] - time.monotonic()
        assert seconds - 5 < remaining <= seconds

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide", "save"])
    async def test_consecutive_timeouts_cool_60_then_120_then_120(
        self, handler, front, monkeypatch, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, call)
        for n, cooling in enumerate((60.0, 120.0, 120.0)):
            await _flush_es(handler, n)
            # Each try is a fresh stamp: with no try the deadline would be in the past.
            self._assert_cooling(handler, _es_key(call), cooling)
            _age_by(handler, cooling)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide", "save"])
    async def test_a_success_clears_the_streak(self, handler, front, monkeypatch, call):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, call)
        for n, cooling in enumerate((60.0, 120.0)):
            await _flush_es(handler, n)
            _age_by(handler, cooling)
        assert _es_key(call) in handler._timeout_backoff

        _hang(front, call, hung=False)
        await _flush_es(handler, 2)

        assert _es_key(call) not in handler._retry_after
        assert _es_key(call) not in handler._timeout_backoff

    @pytest.mark.asyncio
    async def test_a_save_that_works_again_starts_the_streak_over(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, "save")
        for n, cooling in enumerate((60.0, 120.0)):
            await _flush_es(handler, n)
            _age_by(handler, cooling)
        _hang(front, "save", hung=False)
        await _flush_es(handler, 2)  # saved; the streak is over

        _hang(front, "save")
        await _flush_es(handler, 3)

        self._assert_cooling(handler, _es_key("save"), 60.0)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "save"])
    async def test_a_failure_that_is_not_a_timeout_clears_the_streak(
        self, handler, front, monkeypatch, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, call)
        await _flush_es(handler, 0)
        self._assert_cooling(handler, _es_key(call), 60.0)
        _age_by(handler, 60.0)

        # The next try fails without hanging: the plain retry-after, streak gone.
        _hang(front, call, hung=False)
        if call == "load":
            front.fail_load = _blip()
        else:
            front.fail_save = RuntimeError("neon down")
        await _flush_es(handler, 1)
        self._assert_cooling(handler, _es_key(call), 30.0)
        assert _es_key(call) not in handler._timeout_backoff
        _age_by(handler, 30.0)

        # A timeout after it is a first timeout again: 60 s, not 120.
        front.fail_load = front.fail_save = None
        _hang(front, call)
        await _flush_es(handler, 2)
        self._assert_cooling(handler, _es_key(call), 60.0)

    @pytest.mark.asyncio
    async def test_a_none_decision_clears_the_streak(self, handler, front, monkeypatch):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, "decide")
        await _flush_es(handler, 0)
        self._assert_cooling(handler, _es_key("decide"), 60.0)
        _age_by(handler, 60.0)

        _hang(front, "decide", hung=False)
        front.decisions[("ES", _D)] = None
        await _flush_es(handler, 1)
        self._assert_cooling(handler, _es_key("decide"), 30.0)
        assert _es_key("decide") not in handler._timeout_backoff
        _age_by(handler, 30.0)

        del front.decisions[("ES", _D)]
        _hang(front, "decide")
        await _flush_es(handler, 2)
        self._assert_cooling(handler, _es_key("decide"), 60.0)

    @pytest.mark.asyncio
    async def test_a_bulk_save_that_times_out_twice_cools_every_key_120(
        self, handler, front, monkeypatch
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        front.hang_save = True
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        assert front.save_attempts == 1
        for product in _SIX:
            self._assert_cooling(handler, ("save", product, None), 60.0)

        _age_by(handler, 60.0)
        await asyncio.wait_for(_flush_capture(handler, _six_roots(2)), timeout=5)

        assert front.save_attempts == 2
        for product in _SIX:
            self._assert_cooling(handler, ("save", product, None), 120.0)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide"])
    async def test_an_evicted_sessions_streak_goes_with_it(self, handler, front, monkeypatch, call):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, call)
        for day in range(4):
            base = _BASE_MS + day * 86_400_000
            await asyncio.wait_for(
                _flush_capture(
                    handler,
                    [
                        _print(executed_at=base, trade_id=day * 2),
                        _print(executed_at=base + 60_000, trade_id=day * 2 + 1),
                    ],
                ),
                timeout=5,
            )
            if day == 0:
                assert _es_key(call) in handler._timeout_backoff
            _age_by(handler, 60.0)

        assert ("ES", _D) not in handler._tally  # evicted
        assert _es_key(call) not in handler._timeout_backoff
        # What is left is the kept sessions' streaks, each with its cooling.
        assert set(handler._timeout_backoff) <= set(handler._retry_after)
        assert all(
            day is None or (product, day) in handler._tally
            for (_call, product, day) in handler._timeout_backoff
        )


class TestTheLogLineNamesTheWait:
    """The line says how long the key will actually wait: 30 s, or its backed-off cooling."""

    @staticmethod
    def _messages(mock_rl) -> list[str]:
        calls = mock_rl.warning.call_args_list + mock_rl.error.call_args_list
        return [c.kwargs["message"] for c in calls]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide", "save"])
    async def test_a_first_timeout_says_60s_and_a_second_says_120s(
        self, handler, front, monkeypatch, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        _hang(front, call)
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            await _flush_es(handler, 0)
            _age_by(handler, 60.0)
            await _flush_es(handler, 1)

        messages = self._messages(mock_rl)
        assert len(messages) == 2
        assert messages[0].endswith("; asked again after 60s")
        assert messages[1].endswith("; asked again after 120s")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "save"])
    async def test_a_failure_that_is_not_a_timeout_says_30s(self, handler, front, call):
        if call == "load":
            front.fail_load = _blip()
        else:
            front.fail_save = RuntimeError("neon down")
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            await _flush_es(handler, 0)

        messages = self._messages(mock_rl)
        assert len(messages) == 1
        assert messages[0].endswith("; asked again after 30s")


class TestSeveralHungKeys:
    """Several keys time out on every try; the roots whose calls work are still served.

    The clock runs in 30 s steps: the open, then one flush per step. Every timeout
    pauses all front-month calls for one step, and the first call after a pause is
    the next hung key coming due. A key waits 60 s (2 steps) after its first timeout
    and 120 s (4 steps) after each later one. So the pauses follow one another for as
    long as some hung key is due at the end of the last one, and a key that has
    timed out twice is out for 4 steps, longer than the k <= 3 steps the other hung
    keys need to take their turns. The chain therefore ends after at most 2k
    timeouts (the first two of each key): by step 2k at the latest, no hung key is
    due, and that flush loads and decides the healthy roots.
    """

    @staticmethod
    async def _steps(handler, steps: int) -> list[tuple]:
        """The open, then ``steps`` flushes each one step later; the rows written."""
        rows = []
        await asyncio.wait_for(_flush_capture(handler, _six_roots(0, 2)), timeout=5)
        for step in range(1, steps + 1):
            _let_the_retry_after_run_out(handler)
            rows += await asyncio.wait_for(_flush_capture(handler, _six_roots(step + 1)), timeout=5)
        return rows

    @pytest.mark.asyncio
    @pytest.mark.parametrize("call", ["load", "decide"])
    @pytest.mark.parametrize(
        "hung",
        [("ES", "NQ"), ("RTY", "ZN"), ("ES", "NQ", "RTY"), ("CL", "GC", "ZN")],
        ids="-".join,
    )
    async def test_the_healthy_roots_are_loaded_decided_and_written_within_2k_steps(
        self, handler, front, monkeypatch, hung, call
    ):
        monkeypatch.setattr(ft, "_LOOKUP_TIMEOUT_S", 0.05)
        setattr(front, "hang_load" if call == "load" else "hang_ensure", set(hung))
        healthy = set(_SIX) - set(hung)

        rows = await self._steps(handler, 2 * len(hung))

        assert {p for p, _ in handler._decided} == healthy
        assert {r[_C["symbol"]] for r in rows} == healthy
        assert {p for p, _ in front.load_calls} >= healthy
        assert {p for p, _ in front.ensure_calls} >= healthy


class TestFailuresReachSentry:
    @pytest.mark.asyncio
    async def test_a_genuine_load_error_is_an_error_a_blip_is_a_warning(self, handler, front):
        front.fail_load = ValueError("unexpected row")
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            await _flush_capture(handler, [_print(trade_id=1)])
        assert mock_rl.warning.call_args_list == []
        assert mock_rl.error.call_args.kwargs["kind"] == "tally_load_failed"
        assert mock_rl.error.call_args.kwargs["extra"]["err_type"] == "ValueError"

    @pytest.mark.asyncio
    async def test_each_root_is_named_in_its_own_window(self, handler, front):
        front.fail_load_for = {"ES": ValueError("bad"), "NQ": ValueError("bad")}
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            await _flush_capture(
                handler,
                [
                    _print(product="ES", sym="ESU6", trade_id=1),
                    _print(product="NQ", sym="NQU6", executed_at=_BASE_MS + 5, trade_id=2),
                ],
            )
        assert sorted(c.kwargs["key"] for c in mock_rl.error.call_args_list) == ["ES", "NQ"]
        assert sorted(c.kwargs["extra"]["product"] for c in mock_rl.error.call_args_list) == [
            "ES",
            "NQ",
        ]

    @pytest.mark.asyncio
    async def test_a_gap_names_the_cause_of_a_failed_load(self, handler, front):
        new_day = date(2026, 9, 9)
        front.fail_load = _blip()
        await _flush_capture(handler, [_print(sym="ESU6", executed_at=_OPEN_09_09_MS - 30_000)])
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )
        with patch("handlers.futures_trades.log") as mock_log:
            await _flush_capture(
                handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3)]
            )

        assert ("ES", new_day) not in handler._decided
        extra = mock_log.error.call_args.kwargs["extra"]
        assert extra["kind"] == "front_month_unknown"
        assert (extra["cause_kind"], extra["cause_err_type"]) == (
            "tally_load_failed",
            "ConnectionDoesNotExistError",
        )

    @pytest.mark.asyncio
    async def test_a_gap_names_the_cause_of_a_failed_save(self, handler, front):
        new_day = date(2026, 9, 9)
        await _flush_capture(handler, [_print(sym="ESU6", executed_at=_OPEN_09_09_MS - 30_000)])
        front.fail_save = RuntimeError("neon down")
        await _flush_capture(
            handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000, trade_id=2)]
        )
        with patch("handlers.futures_trades.log") as mock_log:
            await _flush_capture(
                handler, [_print(sym="ESZ6", executed_at=_OPEN_09_09_MS + 65_000, trade_id=3)]
            )

        assert ("ES", new_day) not in handler._decided
        extra = mock_log.error.call_args.kwargs["extra"]
        assert (extra["cause_kind"], extra["cause_err_type"]) == (
            "tally_save_failed",
            "RuntimeError",
        )

    @pytest.mark.asyncio
    async def test_a_gap_names_the_cause_ensure_front_recorded(self, handler, front):
        front.decisions[("ES", _D)] = None
        front.failures["ES"] = ("ensure_front_failed", "UndefinedTableError")
        with patch("handlers.futures_trades.log") as mock_log:
            await _flush_capture(
                handler,
                [
                    _print(trade_id=1),
                    _print(executed_at=_BASE_MS + 60_000, trade_id=2),
                    _print(executed_at=_BASE_MS + 120_000, trade_id=3),
                ],
            )
        extra = mock_log.error.call_args.kwargs["extra"]
        assert (extra["cause_kind"], extra["cause_err_type"]) == (
            "ensure_front_failed",
            "UndefinedTableError",
        )

    @pytest.mark.asyncio
    async def test_a_gap_with_no_known_cause_says_so_and_a_success_clears_the_cause(
        self, handler, front
    ):
        front.decisions[("ES", _D)] = None
        front.failures["ES"] = ("front_month_fill_capped", "")
        await _flush_capture(handler, [_print(trade_id=1)])
        assert handler._cause["ES"] == ("front_month_fill_capped", "")

        _let_the_retry_after_run_out(handler)
        front.decisions[("ES", _D)] = "ESU6"
        await _flush_capture(handler, [_print(executed_at=_BASE_MS + 60_000, trade_id=2)])
        assert "ES" not in handler._cause


class TestRootsAreIndependent:
    @pytest.mark.asyncio
    async def test_one_roots_unloaded_tally_does_not_hold_back_another_roots_decision(
        self, handler, front
    ):
        """NQ's tally could not be loaded and now holds volume the table doesn't
        have. That holds back NQ's next decision. ES's volume is in the table,
        and its decision must not wait on NQ."""
        new_day = date(2026, 9, 9)
        front.fail_load_for = {"NQ": _blip()}
        await _flush_capture(
            handler, [_print(product="NQ", sym="NQU6", executed_at=_OPEN_09_09_MS - 30_000)]
        )
        assert handler._tally[("NQ", _D)].dirty is True
        assert handler._tally[("NQ", _D)].loaded is False

        await _flush_capture(
            handler, [_print(product="ES", sym="ESZ6", executed_at=_OPEN_09_09_MS + 5_000)]
        )
        assert ("ES", new_day) in front.ensure_calls

        await _flush_capture(
            handler, [_print(product="NQ", sym="NQZ6", executed_at=_OPEN_09_09_MS + 6_000)]
        )
        assert ("NQ", new_day) not in front.ensure_calls  # its own tally is the one stuck


# ----------------------------------------------------------------------
# 5d. Prints that can't be part of a session
# ----------------------------------------------------------------------


class TestStaleAndLatePrints:
    @pytest.mark.asyncio
    async def test_a_print_older_than_three_trade_dates_never_reaches_the_front_month_path(
        self, handler, front
    ):
        old = _BASE_MS - 3 * 86_400_000  # trade date 09-05; the floor is 09-07
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            rows = await _flush_capture(
                handler,
                [
                    _print(executed_at=old, trade_id=1),
                    _print(executed_at=old + 60_000, trade_id=2),
                    _print(executed_at=old + 120_000, trade_id=3),
                ],
            )

        assert rows == []
        assert front.ensure_calls == []
        assert front.load_calls == []
        assert handler._tally == {}
        assert handler._bars == {}
        assert handler._newest_minute == {}
        # One line for the date, however many prints.
        assert [c.kwargs["kind"] for c in mock_rl.warning.call_args_list] == [
            "stale_session_dropped"
        ]
        extra = mock_rl.warning.call_args.kwargs["extra"]
        assert (extra["product"], extra["trade_date"], extra["floor"]) == (
            "ES",
            "2026-09-05",
            "2026-09-07",
        )

    @pytest.mark.asyncio
    async def test_the_floor_is_inclusive_and_the_next_stale_date_is_logged_again(
        self, handler, front
    ):
        day = 86_400_000
        with patch("handlers.futures_trades.rate_limited_log") as mock_rl:
            await _flush_capture(
                handler,
                [
                    _print(executed_at=_BASE_MS - day, trade_id=1),  # 09-07: the floor, kept
                    _print(executed_at=_BASE_MS - 2 * day, trade_id=2),  # 09-06: dropped
                    _print(executed_at=_BASE_MS - 2 * day + 1, trade_id=3),  # same date
                    _print(executed_at=_BASE_MS - 4 * day, trade_id=4),  # 09-04: another date
                ],
            )

        assert [("ES", date(2026, 9, 7))] == list(handler._tally)
        dates = [c.kwargs["extra"]["trade_date"] for c in mock_rl.warning.call_args_list]
        assert dates == ["2026-09-06", "2026-09-04"]

    @pytest.mark.asyncio
    async def test_a_late_print_is_not_looked_up(self, handler, front):
        """Prints at or before the newest emitted minute are dropped by
        ``_ingest``; they must not cost a tally load and a decision first."""
        await _flush_capture(
            handler,
            [_print(trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)],
        )
        front.ensure_calls.clear()
        front.load_calls.clear()

        # Re-delivered copies for the emitted minute, and a straggler stamped
        # in the previous session (09-07, inside the floor).
        await _flush_capture(
            handler,
            [dict(_print(trade_id=1)), _print(executed_at=_BASE_MS - 86_400_000, trade_id=9)],
        )

        assert front.ensure_calls == []
        assert front.load_calls == []
        assert list(handler._tally) == [("ES", _D)]


class TestShutdown:
    @pytest.mark.asyncio
    async def test_a_clean_shutdown_saves_the_tail_of_the_tally(self, handler, front):
        for payload in [
            _print(size=4, trade_id=1),
            _print(executed_at=_BASE_MS + 5, size=3, trade_id=2),
        ]:
            await handler.enqueue(payload)
        handler._stopped.set()  # no consumer running

        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=0)
            await handler.drain()

        # One open minute: nothing was emitted, so only the drain's own save
        # can have put these 7 lots in the table.
        assert mock_db.bulk_insert_ignore_conflict.called is False
        assert front.saved_volume == {("ES", _D, "ESU6"): 7}

    @pytest.mark.asyncio
    async def test_the_shutdown_save_is_a_single_attempt_and_a_steady_state_save_is_not(
        self, handler, front
    ):
        """Railway SIGKILLs at a fixed deadline, so the drain's save must not
        retry; the save at an emitted minute keeps the retry policy."""
        await _flush_capture(
            handler, [_print(size=4, trade_id=1), _print(executed_at=_BASE_MS + 60_000, trade_id=2)]
        )
        assert front.single_attempt_during_save == [False]

        await handler.enqueue(_print(executed_at=_BASE_MS + 60_100, size=3, trade_id=3))
        handler._stopped.set()
        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=0)
            await handler.drain()

        assert front.single_attempt_during_save == [False, True]

    @pytest.mark.asyncio
    async def test_a_save_that_fails_at_shutdown_does_not_raise(self, handler, front):
        await handler.enqueue(_print(size=4, trade_id=1))
        handler._stopped.set()
        front.fail_save = RuntimeError("neon down")

        with patch("handlers.futures_trades.db") as mock_db:
            mock_db.bulk_insert_ignore_conflict = AsyncMock(return_value=0)
            assert await handler.drain() == 1

        assert front.save_attempts == 1
        assert front.saves == []

    @pytest.mark.asyncio
    async def test_nothing_to_save_at_shutdown_is_no_statement(self, handler, front):
        handler._stopped.set()
        await handler.drain()
        assert front.save_attempts == 0


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
            "contract",
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
    async def test_duplicates_do_not_inflate_the_session_tally(self, handler, front):
        """Dedup must run before the session tally: the tally is what the next
        session's front-month decision is made from and what is saved."""
        back = _print(sym="ESZ6", price="7900.00", size=2, trade_id=99)
        payloads = [
            _print(sym="ESU6", price="7700.00", size=5, trade_id=1),
            # Back month delivered 5x: 10 lots naive, 2 lots deduped.
            *[dict(back) for _ in range(5)],
            _print(sym="ESU6", executed_at=_BASE_MS + 60_000, trade_id=2),
        ]
        rows = await _flush_capture(handler, payloads)

        assert len(rows) == 1
        assert rows[0][_C["close"]] == Decimal("7700.00")
        assert rows[0][_C["volume"]] == 5
        assert _counts(handler) == {"ESU6": 6, "ESZ6": 2}
        assert front.saved_volume[("ES", _D, "ESZ6")] == 2

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
    ON CONFLICT DO NOTHING. It would also put a session in the tally that
    does not exist yet, and ask for its front-month decision.
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
    async def test_future_print_does_not_advance_newest_minute(self, handler, front):
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
        assert list(handler._tally) == [("ES", _D)]
        assert front.ensure_calls == [("ES", _D)]


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
            # :56 — the decided contract, ESU6, prints.
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
    async def test_spread_print_never_enters_the_tally_or_a_bar(
        self, handler, front, spread_sym, is_spread
    ):
        """A calendar spread is its own sym. Counted, its volume would sit in
        the tally the next decision reads and write the spread's price as ES."""
        front.decisions[("ES", _D)] = "ESZ6"
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
        assert _counts(handler) == {"ESZ6": 6}
        assert front.saved_volume == {("ES", _D, "ESZ6"): 6}
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
        assert front_month.is_outright(product, sym) is expected

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
        assert _counts(handler) == {"ESU6": 11, "ESZ6": 1}

        with patch("handlers.futures_trades.rate_limited_log") as mock_log:
            # A back-month copy used to trip a false front_sym_absent; a
            # front-month copy used to re-emit a one-print 05:56 bar.
            late_back = await _flush_capture(handler, [dict(back)])
            late_front = await _flush_capture(handler, [dict(front)])

        assert late_back == []
        assert late_front == []
        assert _counts(handler) == {"ESU6": 11, "ESZ6": 1}
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
