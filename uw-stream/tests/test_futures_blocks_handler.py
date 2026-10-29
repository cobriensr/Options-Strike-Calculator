"""Unit tests for FuturesBlocksHandler (UW ``futures_blocks`` channel).

Covers:

- ``_transform``: frame → row. Error frames, frames missing an identity
  field, and frames with an unparseable or non-finite number are
  rejected, each with a warning naming the field.
- ``_flush``: the row reaches ``db.bulk_upsert_if_newer`` (real helper,
  mocked pool), so the in-batch collapse and the newest-``reported_at``
  SQL guard are exercised as the handler uses them.
- Channel wiring: registry, Settings validation, sharding.

Frame shapes come from UW's channel docs
(``/docs/websocket/futures-block-trades.md``, fetched 2026-10-28) and
from the REST ``/futures/flow?blocks_only=true`` probe of 2026-10-28
(``docs/tmp/uw-futures-probe/out/p7b_blocks.json``), which sends ISO
timestamps and ``product: null`` where the websocket docs show epoch ms
and ``""``. Both forms are accepted.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg.exceptions
import pytest

from handlers import futures_blocks as fb
from handlers.futures_blocks import _COLUMNS, FuturesBlocksHandler
from state import state

_C = {name: i for i, name in enumerate(_COLUMNS)}

# UW's documented FUT example: executed 2026-09-18T14:31:07Z, reported 45s later.
_EXECUTED_MS = 1789741867000
_REPORTED_MS = 1789741912000
# Pinned wall clock, one day after the fixtures, for the future-skew bound.
_PINNED_NOW_MS = _REPORTED_MS + 86_400_000

_GUARD = (
    "WHERE (EXCLUDED.reported_at >= futures_blocks.reported_at"
    " OR futures_blocks.reported_at IS NULL)"
)


@pytest.fixture(autouse=True)
def _pin_wall_clock(monkeypatch):
    monkeypatch.setattr(fb, "_now_ms", lambda: _PINNED_NOW_MS)


def _ms_to_dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _fut(**overrides) -> dict:
    """UW's documented single-contract frame, with overrides."""
    frame = {
        "sym": "ESZ6",
        "product": "ES",
        "exchange": "XCME",
        "trade_date": "2026-09-18",
        "executed_at": _EXECUTED_MS,
        "reported_at": _REPORTED_MS,
        "price": "6612.25",
        "qty": "250",
        "sec_type": "FUT",
        "action": "new",
        "trade_id": 84213907,
        "strategy_link_id": None,
        "legs": [],
        "quote_bid": "6612.00",
        "quote_ask": "6612.25",
        "quote_ts": 1789741866950,
        "is_block": True,
    }
    frame.update(overrides)
    return frame


def _mleg(**overrides) -> dict:
    """UW's documented multi-leg frame, with overrides."""
    frame = {
        "sym": "SR3:GN",
        "product": "",
        "exchange": "XCME",
        "trade_date": "2026-09-18",
        "executed_at": 1789742100000,
        "reported_at": 1789742160000,
        "price": None,
        "qty": "2500",
        "sec_type": "MLEG",
        "action": "new",
        "trade_id": 22693914,
        "strategy_link_id": 22693914,
        "legs": [
            {
                "sym": "SR3Z6 C9606",
                "price": "0.12",
                "qty": "2500",
                "sec_type": "OOF",
                "leg_side": "BUY",
                "ratio_qty": "1",
            }
        ],
        "quote_bid": None,
        "quote_ask": None,
        "quote_ts": None,
        "is_block": True,
    }
    frame.update(overrides)
    return frame


@pytest.fixture
def handler() -> FuturesBlocksHandler:
    return FuturesBlocksHandler()


def _mock_pool_with_conn(conn: MagicMock) -> MagicMock:
    pool = MagicMock()
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acquire_cm)
    txn_cm = MagicMock()
    txn_cm.__aenter__ = AsyncMock(return_value=None)
    txn_cm.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=txn_cm)
    return pool


async def _flush_through_db(
    handler: FuturesBlocksHandler, frames: list[dict]
) -> tuple[list[str], list[tuple]]:
    """Transform frames, flush through the real upsert helper.

    Returns (every SQL statement executed, every row bound).
    """
    rows = [r for r in (handler._transform(f) for f in frames) if r is not None]
    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=lambda sql, *a: f"INSERT 0 {len(a) // len(_COLUMNS)}")
    with patch("db.get_pool", return_value=_mock_pool_with_conn(conn)):
        await handler._flush(rows)
    sqls = [c.args[0] for c in conn.execute.await_args_list]
    width = len(_COLUMNS)
    sent: list[tuple] = []
    for c in conn.execute.await_args_list:
        flat = c.args[1:]
        sent.extend(tuple(flat[i : i + width]) for i in range(0, len(flat), width))
    return sqls, sent


# ----------------------------------------------------------------------
# 1. _transform: a valid frame becomes a typed row
# ----------------------------------------------------------------------


class TestTransformValid:
    def test_fut_frame_maps_every_column(self, handler):
        frame = _fut()
        row = handler._transform(frame)

        assert row is not None
        assert len(row) == len(_COLUMNS)
        # The whole frame rides along as the last column (README convention).
        assert _COLUMNS[-1] == "raw_payload"
        assert row[_C["raw_payload"]] == frame
        assert row[_C["trade_id"]] == 84213907
        assert row[_C["exchange"]] == "XCME"
        assert row[_C["trade_date"]] == date(2026, 9, 18)
        assert row[_C["sym"]] == "ESZ6"
        assert row[_C["product"]] == "ES"
        assert row[_C["sec_type"]] == "FUT"
        assert row[_C["action"]] == "new"
        assert row[_C["price"]] == Decimal("6612.25")
        assert row[_C["qty"]] == Decimal("250")
        assert row[_C["executed_at"]] == _ms_to_dt(_EXECUTED_MS)
        assert row[_C["reported_at"]] == _ms_to_dt(_REPORTED_MS)
        assert row[_C["strategy_link_id"]] is None
        assert row[_C["legs"]] == []
        assert row[_C["quote_bid"]] == Decimal("6612.00")
        assert row[_C["quote_ask"]] == Decimal("6612.25")
        assert row[_C["quote_ts"]] == _ms_to_dt(1789741866950)

    def test_mleg_frame_keeps_null_price_and_the_legs(self, handler):
        frame = _mleg()
        row = handler._transform(frame)

        assert row is not None
        assert row[_C["sec_type"]] == "MLEG"
        assert row[_C["price"]] is None
        # UW sends "" for an MLEG's product; stored as NULL (unknown).
        assert row[_C["product"]] is None
        assert row[_C["legs"]] == frame["legs"]
        assert row[_C["strategy_link_id"]] == 22693914
        assert row[_C["quote_bid"]] is None
        assert row[_C["quote_ts"]] is None

    def test_strategy_link_id_digit_string_parses_to_int(self, handler):
        row = handler._transform(_mleg(strategy_link_id="22693914"))

        assert row is not None
        assert row[_C["strategy_link_id"]] == 22693914

    def test_qty_keeps_eight_decimal_places(self, handler):
        """UW sends up to 8 decimals; the column is NUMERIC(24,8)."""
        row = handler._transform(_fut(qty="1.12345678"))

        assert row is not None
        assert row[_C["qty"]] == Decimal("1.12345678")

    def test_numbers_are_rounded_to_eight_places_half_away_from_zero(self, handler):
        """Matches how Postgres rounds a NUMERIC(_,8) input."""
        row = handler._transform(_fut(price="6612.123456785", quote_bid="-0.000000005"))

        assert row is not None
        assert row[_C["price"]] == Decimal("6612.12345679")
        assert row[_C["quote_bid"]] == Decimal("-0.00000001")

    def test_rest_shaped_iso_timestamps_and_null_product_parse(self, handler):
        """The REST probe sent ISO strings and product null for the same fields."""
        row = handler._transform(
            _mleg(
                product=None,
                executed_at="2026-09-18T14:35:00Z",
                reported_at="2026-09-18T14:36:00.297Z",
            )
        )

        assert row is not None
        assert row[_C["product"]] is None
        assert row[_C["executed_at"]] == datetime(2026, 9, 18, 14, 35, tzinfo=UTC)
        assert row[_C["reported_at"]] == datetime(2026, 9, 18, 14, 36, 0, 297000, tzinfo=UTC)

    def test_numeric_string_epoch_ms_parses(self, handler):
        row = handler._transform(_fut(reported_at=str(_REPORTED_MS)))

        assert row is not None
        assert row[_C["reported_at"]] == _ms_to_dt(_REPORTED_MS)

    def test_empty_exchange_is_kept_because_it_is_part_of_the_key(self, handler):
        """UW documents ``exchange`` as '' when it has no MIC."""
        row = handler._transform(_fut(exchange=""))

        assert row is not None
        assert row[_C["exchange"]] == ""

    def test_every_product_is_stored_not_only_the_bar_roots(self, handler):
        """Spec D4 default: store all products UW sends."""
        row = handler._transform(_fut(sym="CSXF7", product="CSX", exchange="XNYM"))

        assert row is not None
        assert row[_C["product"]] == "CSX"

    @pytest.mark.parametrize("action", ["new", "update", "delete"])
    def test_each_documented_action_is_kept(self, handler, action):
        row = handler._transform(_fut(action=action))

        assert row is not None
        assert row[_C["action"]] == action

    def test_delete_frame_with_null_quotes_is_a_row(self, handler):
        """UW nulls the quote fields on a delete."""
        row = handler._transform(
            _fut(action="delete", quote_bid=None, quote_ask=None, quote_ts=None)
        )

        assert row is not None
        assert row[_C["action"]] == "delete"
        assert row[_C["quote_bid"]] is None


# ----------------------------------------------------------------------
# 2. _transform: rejections, each surfaced by a named warning
# ----------------------------------------------------------------------


def _rejected_kind(handler: FuturesBlocksHandler, frame: dict) -> str:
    """Assert the frame is rejected and return the warning's kind."""
    with patch.object(fb, "rate_limited_log") as rl, patch.object(fb, "capture_message"):
        assert handler._transform(frame) is None
    rl.warning.assert_called_once()
    kwargs = rl.warning.call_args.kwargs
    assert kwargs["scope"] == "futures_blocks"
    return kwargs["kind"]


class TestTransformRejects:
    @pytest.mark.parametrize("field", ["trade_id", "exchange", "trade_date", "action"])
    def test_missing_identity_field(self, handler, field):
        frame = _fut()
        del frame[field]

        assert _rejected_kind(handler, frame) == f"bad_{field}"

    @pytest.mark.parametrize("field", ["trade_id", "exchange", "trade_date", "action"])
    def test_null_identity_field(self, handler, field):
        assert _rejected_kind(handler, _fut(**{field: None})) == f"bad_{field}"

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("trade_id", "1.5"),
            ("trade_id", True),
            ("trade_id", -1),
            ("trade_id", 2**63),
            ("trade_date", "18/09/2026"),
            ("trade_date", 20260918),
            ("action", "cancel"),
            ("action", "NEW"),
            ("exchange", 7),
        ],
    )
    def test_malformed_identity_field(self, handler, field, value):
        assert _rejected_kind(handler, _fut(**{field: value})) == f"bad_{field}"

    @pytest.mark.parametrize("qty", ["NaN", "sNaN", "Infinity", "-Infinity", "1e400", "abc"])
    def test_non_finite_or_unparseable_qty(self, handler, qty):
        assert _rejected_kind(handler, _fut(qty=qty)) == "bad_qty"

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("price", "NaN"),
            # Past NUMERIC(18,8): would fail the whole batch's INSERT.
            ("price", "1e10"),
            # Under the limit until rounded to 8 places, then exactly 1e10.
            ("price", "9999999999.999999999"),
            # Past NUMERIC(24,8).
            ("qty", "1e16"),
            ("quote_bid", "Infinity"),
            ("quote_ask", "x"),
        ],
    )
    def test_numbers_that_would_poison_the_batch(self, handler, field, value):
        assert _rejected_kind(handler, _fut(**{field: value})) == f"bad_{field}"

    @pytest.mark.parametrize("field", ["executed_at", "reported_at", "quote_ts"])
    def test_epoch_seconds_read_as_ms_is_a_units_flip(self, handler, field):
        """1789741912 s read as ms lands in 1970."""
        assert _rejected_kind(handler, _fut(**{field: 1789741912})) == f"bad_{field}"

    def test_far_future_reported_at_is_rejected(self, handler):
        """A bogus future reported_at would win every later guard
        comparison and freeze the row against real updates."""
        far = _PINNED_NOW_MS + 24 * 3_600_000

        assert _rejected_kind(handler, _fut(reported_at=far)) == "bad_reported_at"

    @pytest.mark.parametrize("value", ["not-a-time", True, [1]])
    def test_unparseable_time(self, handler, value):
        assert _rejected_kind(handler, _fut(executed_at=value)) == "bad_executed_at"

    @pytest.mark.parametrize("legs", ["SR3Z6", {"sym": "SR3Z6"}])
    def test_legs_that_are_not_a_list(self, handler, legs):
        assert _rejected_kind(handler, _mleg(legs=legs)) == "bad_legs"

    @pytest.mark.parametrize("value", [[1], "1.5", True, -1, 2**63, "SR3:GN"])
    def test_strategy_link_id_that_is_not_a_bigint_id(self, handler, value):
        assert _rejected_kind(handler, _mleg(strategy_link_id=value)) == "bad_strategy_link_id"


class TestSchemaDriftAlert:
    """A rejected field is a likely UW wire-format change. The rate-limited
    warning alone never pages, so the first rejection per field per
    handler instance also goes to Sentry."""

    def test_same_field_repeated_captures_once(self, handler):
        with patch.object(fb, "capture_message") as capture, patch.object(fb, "rate_limited_log"):
            handler._transform(_fut(qty="NaN"))
            handler._transform(_fut(qty="abc", trade_id=2))

        capture.assert_called_once()
        kwargs = capture.call_args.kwargs
        assert kwargs["level"] == "warning"
        assert kwargs["tags"] == {"component": "handler", "channel": "futures_blocks"}
        assert kwargs["context"]["field"] == "qty"
        assert kwargs["context"]["raw"] == repr("NaN")

    def test_a_different_field_captures_again(self, handler):
        with patch.object(fb, "capture_message") as capture, patch.object(fb, "rate_limited_log"):
            handler._transform(_fut(qty="NaN"))
            handler._transform(_fut(qty="NaN"))
            handler._transform(_fut(action="cancel"))

        assert capture.call_count == 2
        assert [c.kwargs["context"]["field"] for c in capture.call_args_list] == [
            "qty",
            "action",
        ]

    def test_a_valid_frame_captures_nothing(self, handler):
        with patch.object(fb, "capture_message") as capture:
            assert handler._transform(_fut()) is not None

        capture.assert_not_called()


class TestErrorFrame:
    """Joining without access returns ``{"error": ...}``, and the router
    forwards it to the handler like data (router.py)."""

    def test_error_frame_is_captured_once_per_handler_and_warned_every_time(self, handler):
        frame = {"error": "futures_blocks requires the futures add-on"}

        with (
            patch.object(fb, "capture_message") as capture,
            patch.object(fb, "rate_limited_log") as rl,
        ):
            assert handler._transform(frame) is None
            assert handler._transform(frame) is None

        capture.assert_called_once()
        assert capture.call_args.kwargs["tags"] == {
            "component": "handler",
            "channel": "futures_blocks",
        }
        assert "futures_blocks requires the futures add-on" in str(
            capture.call_args.kwargs["context"]
        )
        assert rl.warning.call_count == 2
        assert {c.kwargs["kind"] for c in rl.warning.call_args_list} == {"error_frame"}

    def test_a_new_handler_instance_reports_again(self):
        frame = {"error": "nope"}

        with patch.object(fb, "capture_message") as capture, patch.object(fb, "rate_limited_log"):
            FuturesBlocksHandler()._transform(frame)
            FuturesBlocksHandler()._transform(frame)

        assert capture.call_count == 2

    @pytest.mark.asyncio
    async def test_error_frame_writes_no_row(self, handler):
        with patch.object(fb, "capture_message"), patch.object(fb, "rate_limited_log"):
            sqls, sent = await _flush_through_db(handler, [{"error": "nope"}])

        assert sqls == []
        assert sent == []


# ----------------------------------------------------------------------
# 3. _flush: upsert semantics as the handler uses them
# ----------------------------------------------------------------------


class TestFlushUpsert:
    @pytest.mark.asyncio
    async def test_flush_upserts_on_the_identity_with_the_reported_at_guard(self, handler):
        sqls, sent = await _flush_through_db(handler, [_fut()])

        assert len(sqls) == 1
        sql = sqls[0]
        assert sql.startswith(f"INSERT INTO futures_blocks ({', '.join(_COLUMNS)}) VALUES")
        assert "ON CONFLICT (trade_id, exchange, trade_date) DO UPDATE SET" in sql
        assert "action = EXCLUDED.action" in sql
        assert "legs = EXCLUDED.legs" in sql
        assert "raw_payload = EXCLUDED.raw_payload" in sql
        assert "updated_at = now()" in sql
        assert sql.endswith(_GUARD)
        # received_at keeps its first-arrival default: never bound, never SET.
        assert "received_at" not in sql
        assert len(sent) == 1

    @pytest.mark.asyncio
    async def test_new_then_update_in_one_batch_writes_one_row_with_the_update(self, handler):
        new = _fut(action="new", qty="250", reported_at=_REPORTED_MS)
        update = _fut(action="update", qty="300", reported_at=_REPORTED_MS + 5_000)

        _sqls, sent = await _flush_through_db(handler, [new, update])

        assert len(sent) == 1
        assert sent[0][_C["action"]] == "update"
        assert sent[0][_C["qty"]] == Decimal("300")
        assert sent[0][_C["raw_payload"]] == update

    @pytest.mark.asyncio
    async def test_new_then_update_across_batches_both_go_through_the_guard(self, handler):
        """Across flushes the row is replaced by Postgres, not here: the
        second statement must carry the guard so the update applies."""
        sqls_1, _ = await _flush_through_db(handler, [_fut(action="new")])
        sqls_2, sent_2 = await _flush_through_db(
            handler, [_fut(action="update", qty="300", reported_at=_REPORTED_MS + 5_000)]
        )

        assert sqls_1[0].endswith(_GUARD)
        assert sqls_2[0].endswith(_GUARD)
        assert sent_2[0][_C["action"]] == "update"

    @pytest.mark.asyncio
    async def test_older_report_after_newer_in_one_batch_does_not_overwrite(self, handler):
        newer = _fut(action="update", qty="300", reported_at=_REPORTED_MS + 5_000)
        older = _fut(action="new", qty="250", reported_at=_REPORTED_MS)

        _sqls, sent = await _flush_through_db(handler, [newer, older])

        assert len(sent) == 1
        assert sent[0][_C["action"]] == "update"
        assert sent[0][_C["reported_at"]] == _ms_to_dt(_REPORTED_MS + 5_000)

    @pytest.mark.asyncio
    async def test_older_report_in_a_later_batch_is_bound_under_the_guard(self, handler):
        """The stored newer row is protected by ``EXCLUDED.reported_at >=
        futures_blocks.reported_at``, which the older value fails."""
        await _flush_through_db(handler, [_fut(reported_at=_REPORTED_MS + 5_000)])
        sqls, sent = await _flush_through_db(handler, [_fut(reported_at=_REPORTED_MS)])

        assert sqls[0].endswith(_GUARD)
        assert sent[0][_C["reported_at"]] == _ms_to_dt(_REPORTED_MS)

    @pytest.mark.asyncio
    async def test_delete_is_stored_as_a_row_state_never_a_delete(self, handler):
        sqls, sent = await _flush_through_db(
            handler,
            [
                _fut(action="new"),
                _fut(
                    action="delete",
                    quote_bid=None,
                    quote_ask=None,
                    quote_ts=None,
                    reported_at=_REPORTED_MS + 60_000,
                ),
            ],
        )

        assert len(sent) == 1
        assert sent[0][_C["action"]] == "delete"
        assert all(s.startswith("INSERT INTO futures_blocks") for s in sqls)
        assert not any("DELETE" in s.upper() for s in sqls)

    @pytest.mark.asyncio
    async def test_duplicate_key_in_one_batch_is_collapsed(self, handler):
        frames = [
            _fut(action="new", reported_at=_REPORTED_MS),
            _fut(action="update", reported_at=_REPORTED_MS + 1_000),
            _fut(action="update", reported_at=_REPORTED_MS + 2_000, qty="999"),
            # Same trade_id, different trade_date: a different block.
            _fut(trade_date="2026-09-19"),
        ]

        _sqls, sent = await _flush_through_db(handler, frames)

        assert len(sent) == 2
        by_date = {r[_C["trade_date"]]: r for r in sent}
        assert by_date[date(2026, 9, 18)][_C["qty"]] == Decimal("999")
        assert by_date[date(2026, 9, 19)][_C["action"]] == "new"

    @pytest.mark.asyncio
    async def test_mleg_legs_are_bound_as_a_list_for_the_jsonb_codec(self, handler):
        frame = _mleg()

        _sqls, sent = await _flush_through_db(handler, [frame])

        assert sent[0][_C["legs"]] == frame["legs"]
        assert sent[0][_C["price"]] is None

    @pytest.mark.asyncio
    async def test_flush_returns_the_rows_postgres_reports(self, handler):
        rows = [handler._transform(_fut())]
        with patch.object(fb.db, "bulk_upsert_if_newer", AsyncMock(return_value=0)) as upsert:
            assert await handler._flush(rows) == 0
        upsert.assert_awaited_once()


class TestFlushFailure:
    @pytest.mark.asyncio
    async def test_db_reject_is_surfaced_by_safe_flush(self, handler):
        rows = [handler._transform(_fut())]
        before = state.handler("futures_blocks").write_count
        err = asyncpg.exceptions.NumericValueOutOfRangeError("numeric field overflow")

        with (
            patch.object(fb.db, "bulk_upsert_if_newer", AsyncMock(side_effect=err)),
            patch("handlers.base.capture_exception") as capture,
            patch("handlers.base.log") as base_log,
        ):
            await handler._safe_flush(rows)

        capture.assert_called_once()
        assert capture.call_args.args[0] is err
        assert capture.call_args.kwargs["tags"] == {
            "component": "handler",
            "channel": "futures_blocks",
            "stage": "flush",
        }
        base_log.error.assert_called_once()
        assert base_log.error.call_args.args[0] == "flush failed"
        assert state.handler("futures_blocks").write_count == before


# ----------------------------------------------------------------------
# 4. Channel wiring
# ----------------------------------------------------------------------


class TestChannelWiring:
    def test_futures_blocks_is_a_known_channel_token(self):
        from channel_registry import is_known_channel_token

        assert is_known_channel_token("futures_blocks")

    def test_futures_blocks_routes_to_the_handler(self):
        from channel_registry import handler_class_for_channel

        assert handler_class_for_channel("futures_blocks") is FuturesBlocksHandler

    def test_registered_as_an_exact_name_not_a_prefix(self):
        """We take the global channel; the per-symbol form is unregistered."""
        from channel_registry import EXACT_CHANNEL_NAMES, is_known_channel_token

        assert "futures_blocks" in EXACT_CHANNEL_NAMES
        assert not is_known_channel_token("futures_blocks:ESZ6")

    def test_every_exact_name_has_a_handler(self):
        """A name in EXACT_CHANNEL_NAMES with no entry in the ``exact``
        dict passes Settings validation and then crashes main at boot."""
        from channel_registry import EXACT_CHANNEL_NAMES, handler_class_for_channel

        for name in EXACT_CHANNEL_NAMES:
            handler_class_for_channel(name)

    def test_main_builds_the_handler(self):
        import main

        handlers = main._build_handlers(["futures_blocks"])

        assert isinstance(handlers["futures_blocks"], FuturesBlocksHandler)

    def test_ws_channels_env_accepts_futures_blocks(self):
        from config import Settings

        settings = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels="futures_trades,futures_blocks",
        )
        assert settings.channels == ["futures_trades", "futures_blocks"]

    def test_futures_blocks_shards_as_a_global_channel(self):
        """No ``:`` in the name, so it folds into a per-ticker shard rather
        than opening its own connection."""
        from config import Settings

        settings = Settings(
            database_url="postgresql://test",
            uw_api_key="test",
            ws_channels="futures_blocks,option_trades:SPY,option_trades:QQQ",
        )
        shards = settings.channel_shards
        assert len(shards) == 1
        assert set(shards[0]) == {"futures_blocks", "option_trades:SPY", "option_trades:QQQ"}
