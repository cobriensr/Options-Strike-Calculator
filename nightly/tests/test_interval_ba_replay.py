"""The Interval B/A tape replay: today's live detector, rebuilt over the UW Full Tape.

Every replay test writes a small tape in tmp_path with DuckDB COPY and runs on both layouts the
tape has had (2026-11-24 tape facts, section 2): `naive` (before 2026-05-04: executed_at a naive
TIMESTAMP holding UTC, prices DECIMAL(18,4), tags and report_flags bare comma lists) and `tz`
(TIMESTAMPTZ, DOUBLE, brace-wrapped lists). A test whose name names a layout runs on that one.

The nightly venv has no pytz, and DuckDB needs it to hand a TIMESTAMPTZ to Python, so a module
that fetched a time column would fail the tz runs here. The insert is tested against psycopg2's
own execute_values with a fake cursor, or with execute_values patched. No test opens a database.
"""

from __future__ import annotations

import ast
import sys
from dataclasses import fields
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

import duckdb
import psycopg2
import psycopg2.extensions
import psycopg2.extras
import pytest

import interval_ba_replay as replay
from interval_ba_replay import (
    ALERT_INSERT_COLUMNS,
    LiveRow,
    Replay,
    TapeAlert,
    insert_alerts,
    replay_day,
    top_trade_flags,
)

DAY = date(2026, 11, 17)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
MODULE = Path(replay.__file__)

Layout = Literal["naive", "tz"]


def _chain(root: str, cp: str, strike: int, day: date = DAY) -> str:
    return f"{root}{day:%y%m%d}{cp}{strike * 1000:08d}"


SPXW_C = _chain("SPXW", "C", 6700)
SPXW_P = _chain("SPXW", "P", 6600)
SPY_C = _chain("SPY", "C", 670)
SPY_P = _chain("SPY", "P", 660)
QQQ_C = _chain("QQQ", "C", 600)
QQQ_P = _chain("QQQ", "P", 590)


def _at(clock: str, day: date = DAY) -> datetime:
    """An aware UTC instant on `day` from 'HH:MM:SS[.ffffff]'."""
    return datetime.fromisoformat(f"{day.isoformat()}T{clock}+00:00")


def _tick(
    at: datetime,
    chain: str,
    price: str,
    size: int,
    *,
    side: str = "ask",
    code: str = "auto",
    flags: tuple[str, ...] = (),
    tags: tuple[str, ...] | None = None,
    spot: str | None = "670.00",
    canceled: bool = False,
    label: str | None = None,
    expiry: date | None = None,
) -> dict[str, object]:
    """One tape row. The label defaults to the OCC root and the expiry to the OCC date."""
    root = chain[:-15]
    occ_date = datetime.strptime(chain[-15:-9], "%y%m%d").date()
    return {
        "executed_at": at,
        "option_chain_id": chain,
        "underlying_symbol": label if label is not None else root,
        "expiry": expiry if expiry is not None else occ_date,
        "price": price,
        "size": size,
        "tags": tags if tags is not None else (f"{side}_side", "bullish", "etf"),
        "report_flags": flags,
        "upstream_condition_detail": code,
        "underlying_price": spot,
        "canceled": canceled,
    }


_TYPES: dict[str, dict[str, str]] = {
    "naive": {"time": "TIMESTAMP", "number": "DECIMAL(18,4)", "size": "BIGINT"},
    "tz": {"time": "TIMESTAMPTZ", "number": "DOUBLE", "size": "INTEGER"},
}


def _token_list(tokens: tuple[str, ...], layout: Layout) -> str:
    body = ",".join(tokens)
    return body if layout == "naive" else "{" + body + "}"


def _write_tape(tmp_path: Path, rows: list[dict[str, object]], *, layout: Layout) -> str:
    """Write rows as a Full Tape parquet in the given layout, in list order, and return its path.

    The time goes in as epoch microseconds, so the stored instant is exact: make_timestamp gives
    the naive UTC wall clock, and timezone('UTC', ...) the same instant as a TIMESTAMPTZ.
    """
    types = _TYPES[layout]
    time_sql = (
        "make_timestamp($us)" if layout == "naive" else "timezone('UTC', make_timestamp($us))"
    )
    path = tmp_path / f"{len(list(tmp_path.glob('*.parquet')))}-{layout}-fulltape.parquet"
    con = duckdb.connect()
    try:
        con.execute(
            f"""
            CREATE TABLE tape (
                n INTEGER,
                executed_at {types["time"]},
                option_chain_id VARCHAR,
                underlying_symbol VARCHAR,
                expiry DATE,
                price {types["number"]},
                size {types["size"]},
                tags VARCHAR,
                report_flags VARCHAR,
                upstream_condition_detail VARCHAR,
                underlying_price {types["number"]},
                canceled BOOLEAN
            )
            """
        )
        for n, row in enumerate(rows):
            at = row["executed_at"]
            assert isinstance(at, datetime)
            con.execute(
                f"""
                INSERT INTO tape VALUES (
                    $n, {time_sql}, $chain, $label, $expiry, CAST($price AS {types["number"]}),
                    $size, $tags, $flags, $code, CAST($spot AS {types["number"]}), $canceled
                )
                """,
                {
                    "n": n,
                    "us": (at - EPOCH) // timedelta(microseconds=1),
                    "chain": row["option_chain_id"],
                    "label": row["underlying_symbol"],
                    "expiry": row["expiry"],
                    "price": row["price"],
                    "size": row["size"],
                    "tags": _token_list(row["tags"], layout),  # type: ignore[arg-type]
                    "flags": _token_list(row["report_flags"], layout),  # type: ignore[arg-type]
                    "code": row["upstream_condition_detail"],
                    "spot": row["underlying_price"],
                    "canceled": row["canceled"],
                },
            )
        target = path.as_posix().replace("'", "''")
        con.execute(
            f"COPY (SELECT * EXCLUDE (n) FROM tape ORDER BY n) TO '{target}' (FORMAT parquet)"
        )
    finally:
        con.close()
    return str(path)


@pytest.fixture(params=["naive", "tz"])
def layout(request: pytest.FixtureRequest) -> Layout:
    return request.param


@pytest.fixture
def con():
    connection = duckdb.connect()
    yield connection
    connection.close()


def _replay(
    tmp_path: Path,
    rows: list[dict[str, object]],
    layout: Layout,
    con: duckdb.DuckDBPyConnection,
    day: date = DAY,
) -> Replay:
    return replay_day(con, _write_tape(tmp_path, rows, layout=layout), day)


def _by_chain(result: Replay) -> dict[str, TapeAlert]:
    alerts = {a.option_chain: a for a in result.alerts}
    assert len(alerts) == len(result.alerts), "a chain fired twice where the test expects once"
    return alerts


def _usd(text: str) -> Decimal:
    return Decimal(text)


# --- The detector rules -------------------------------------------------------------------------


def test_floor_exactly_250k_fires(tmp_path, layout, con):
    result = _replay(tmp_path, [_tick(_at("14:31:00"), SPY_C, "25.00", 100)], layout, con)

    (alert,) = result.alerts
    assert alert.option_chain == SPY_C
    assert alert.total_premium == _usd("250000.00")
    assert alert.ask_premium == _usd("250000.00")
    assert alert.ratio_pct == Decimal("100.00")
    assert alert.trade_count == 1


def test_floor_one_cent_short_does_not(tmp_path, layout, con):
    # $2,499.99 x 100 + $0.99 = $249,999.99 on SPY_C. QQQ_C has the same two prints plus one more
    # cent, which reaches the floor on its third tick.
    rows = [
        _tick(_at("14:31:00"), SPY_C, "24.9999", 100),
        _tick(_at("14:31:01"), SPY_C, "0.0099", 1),
        _tick(_at("14:31:00"), QQQ_C, "24.9999", 100),
        _tick(_at("14:31:01"), QQQ_C, "0.0099", 1),
        _tick(_at("14:31:02"), QQQ_C, "0.0001", 1),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert set(alerts) == {QQQ_C}
    assert alerts[QQQ_C].total_premium == _usd("250000.00")
    assert alerts[QQQ_C].trade_count == 3


def test_ratio_exactly_75_percent_fires(tmp_path, layout, con):
    rows = [
        # $187,500 ask + $62,500 bid: 75% exactly.
        _tick(_at("14:31:00"), SPY_C, "18.75", 100),
        _tick(_at("14:31:01"), SPY_C, "6.25", 100, side="bid"),
        # $187,499 ask + $62,501 bid: 74.9996%.
        _tick(_at("14:31:00"), QQQ_C, "18.7499", 100),
        _tick(_at("14:31:01"), QQQ_C, "6.2501", 100, side="bid"),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert set(alerts) == {SPY_C}
    assert alerts[SPY_C].ratio_pct == Decimal("75.00")
    assert alerts[SPY_C].trade_count == 2


def test_multi_leg_share_exactly_half_does_not_fire(tmp_path, layout, con):
    rows = [
        # $125,000 multi-leg of $250,000: a share of exactly 0.5. The code is upper case: the
        # live gate lower-cases it.
        _tick(_at("14:31:00"), SPY_C, "12.50", 100, code="MLET"),
        _tick(_at("14:31:01"), SPY_C, "12.50", 100),
        # $124,999 of $250,000: just under half.
        _tick(_at("14:31:00"), QQQ_C, "12.4999", 100, code="cbmo"),
        _tick(_at("14:31:01"), QQQ_C, "12.5001", 100),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert set(alerts) == {QQQ_C}


def test_gate_suppressed_bucket_fires_on_a_later_tick(tmp_path, layout, con):
    # The gate does not mark the bucket: a later print that pulls the share under half fires it.
    rows = [
        _tick(_at("14:31:00"), SPY_C, "20.00", 100, code="mlet"),
        _tick(_at("14:31:01"), SPY_C, "5.00", 100),
        _tick(_at("14:31:02"), SPY_C, "20.00", 100),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.trade_count == 3
    assert alert.total_premium == _usd("450000.00")
    assert alert.fired_at == _at("14:31:02")


def test_crossing_tick_can_be_a_bid_and_spot_comes_from_it(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00.100"), SPY_C, "24.00", 100, spot="670.11"),
        _tick(_at("14:31:02.200"), SPY_C, "6.00", 100, side="bid", spot="670.55"),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.fired_at == _at("14:31:02.200")
    assert alert.underlying_price == Decimal("670.55")
    assert alert.ratio_pct == Decimal("80.00")
    assert alert.trade_count == 2
    assert alert.top_trade_premium == _usd("240000.00")
    assert alert.top_trade_size == 100
    assert alert.top_trade_executed_at == _at("14:31:00.100")


def test_top_trade_is_an_ask_print(tmp_path, layout, con):
    # The $100,000 bid is the largest print in the bucket; the top trade is the first $80,000 ask.
    rows = [
        _tick(_at("14:31:00"), SPY_C, "8.00", 100),
        _tick(_at("14:31:01"), SPY_C, "8.00", 100),
        _tick(_at("14:31:02"), SPY_C, "10.00", 100, side="bid"),
        _tick(_at("14:31:03"), SPY_C, "8.00", 100),
        _tick(_at("14:31:04"), SPY_C, "8.00", 100),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.trade_count == 5
    assert alert.ratio_pct == Decimal("76.19")
    assert alert.top_trade_premium == _usd("80000.00")
    assert alert.top_trade_executed_at == _at("14:31:00")


def test_canceled_ticks_count(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00"), SPY_C, "20.00", 100),
        _tick(_at("14:31:01"), SPY_C, "5.00", 100, canceled=True),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.trade_count == 2
    assert alert.total_premium == _usd("250000.00")


def test_zero_price_or_size_rows_are_dropped(tmp_path, layout, con):
    # A kept zero print would add nothing to the premiums but one to trade_count.
    rows = [
        _tick(_at("14:31:00"), SPY_C, "0", 100),
        _tick(_at("14:31:01"), SPY_C, "25.00", 0),
        _tick(_at("14:31:02"), SPY_C, "25.00", 100),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.trade_count == 1


def test_side_is_the_first_side_token(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00"), SPY_C, "30.00", 100, tags=("bullish", "ask_side", "bid_side")),
        _tick(_at("14:31:00"), QQQ_C, "30.00", 100, tags=("bearish", "bid_side", "ask_side")),
        # A tag that merely contains the text is not the token.
        _tick(_at("14:31:00"), SPXW_C, "30.00", 100, tags=("not_ask_side", "index")),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert set(alerts) == {SPY_C}


def test_top_trade_tie_goes_to_earliest(tmp_path, layout, con):
    rows = [
        # Two $130,000 asks: the earlier one is the top trade, not the sweep after it.
        _tick(_at("14:31:00.100"), SPY_C, "13.00", 100),
        _tick(_at("14:31:00.200"), SPY_C, "26.00", 50, flags=("intermarket_sweep",)),
        # Same tie at the same microsecond: file order decides.
        _tick(_at("14:31:00.300"), QQQ_C, "13.00", 100),
        _tick(_at("14:31:00.300"), QQQ_C, "26.00", 50, flags=("intermarket_sweep",)),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert alerts[SPY_C].top_trade_size == 100
    assert alerts[SPY_C].top_trade_executed_at == _at("14:31:00.100")
    assert alerts[SPY_C].top_trade_is_sweep is False
    assert alerts[QQQ_C].top_trade_size == 100
    assert alerts[QQQ_C].top_trade_is_sweep is False


def test_bucket_frozen_after_fire(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00"), SPY_C, "25.00", 100),
        _tick(_at("14:32:00"), SPY_C, "50.00", 100),
        _tick(_at("14:33:00"), SPY_C, "100.00", 100, side="bid"),
        _tick(_at("14:36:00"), SPY_C, "25.00", 100),
    ]

    first, second = _replay(tmp_path, rows, layout, con).alerts

    assert first.bucket_start == _at("14:30:00")
    assert first.total_premium == _usd("250000.00")
    assert first.trade_count == 1
    assert first.top_trade_premium == _usd("250000.00")
    assert second.bucket_start == _at("14:35:00")
    assert second.trade_count == 1


def test_bucket_boundary_14_34_59_999_vs_14_35(tmp_path, layout, con):
    rows = [
        _tick(_at("14:34:59.999"), SPY_C, "20.00", 100),
        _tick(_at("14:35:00.000"), SPY_C, "20.00", 100),
        _tick(_at("14:35:00.001"), SPY_C, "5.00", 100),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.bucket_start == _at("14:35:00")
    assert alert.bucket_end == _at("14:40:00")
    assert alert.total_premium == _usd("250000.00")
    assert alert.trade_count == 2
    assert alert.fired_at == _at("14:35:00.001")


# --- Which rows the scan keeps ------------------------------------------------------------------


def test_spx_root_and_non_0dte_rows_excluded(tmp_path, layout, con):
    next_day = DAY + timedelta(days=1)
    spx = _chain("SPX", "C", 6700)
    spxw_next_day = _chain("SPXW", "C", 6700, next_day)
    late_close = _chain("SPXW", "C", 6800)
    after_ct_midnight = _chain("SPXW", "C", 6900)
    rows = [
        _tick(_at("14:31:00"), spx, "30.00", 100, label="SPX"),
        _tick(_at("14:31:00"), spxw_next_day, "30.00", 100),
        # 23:59:59 CT on the day: still 0DTE, though the UTC date is the next day.
        _tick(_at("05:59:59", next_day), late_close, "30.00", 100),
        # 00:00 CT on the next day: no longer 0DTE for a contract expiring on the day.
        _tick(_at("06:00:00", next_day), after_ct_midnight, "30.00", 100),
        _tick(_at("14:31:00"), SPXW_C, "30.00", 100),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert set(alerts) == {SPXW_C, late_close}
    assert alerts[SPXW_C].ticker == "SPXW"


def test_spxw_rows_labelled_spx_are_kept_and_counted(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00"), SPXW_C, "30.00", 100, label="SPX"),
        _tick(_at("14:31:00"), _chain("SPX", "C", 6700), "30.00", 100, label="SPX"),
        _tick(_at("14:31:00"), SPY_C, "1.00", 1),
    ]

    result = _replay(tmp_path, rows, layout, con)

    (alert,) = result.alerts
    assert alert.option_chain == SPXW_C
    assert alert.ticker == "SPXW"
    assert result.root_label_mismatch == 1


def test_day_with_no_fires_still_counts_label_mismatches(tmp_path, layout, con):
    rows = [_tick(_at("14:31:00"), SPXW_C, "1.00", 1, label="SPX")]

    result = _replay(tmp_path, rows, layout, con)

    assert result == Replay(alerts=(), root_label_mismatch=1)


# --- Dates, money and times ---------------------------------------------------------------------


@pytest.mark.parametrize("session_zone", ["UTC", "America/New_York"])
def test_naive_layout_after_dst_start(tmp_path, con, session_zone):
    # 2026-03-09 is the first EDT session. The CT date must come from the instant, under any
    # session time zone: `executed_at AT TIME ZONE ...` on a naive column misdates rows.
    day = date(2026, 3, 9)
    next_day = date(2026, 3, 10)
    at_open = _chain("SPXW", "C", 6700, day)
    cdt_early = _chain("SPXW", "P", 6600, day)
    evening = _chain("SPXW", "C", 6800, day)
    after_midnight = _chain("SPXW", "C", 6900, day)
    rows = [
        # 08:30 CDT.
        _tick(_at("13:30:00.500", day), at_open, "30.00", 100, spot="6700.00"),
        # 00:30 CDT on 03-09 (it would be 23:30 on 03-08 at CST's offset).
        _tick(_at("05:30:00", day), cdt_early, "30.00", 100),
        # 19:30 CDT on 03-09, though the UTC date is 03-10.
        _tick(_at("00:30:00", next_day), evening, "30.00", 100),
        # 00:00 CDT on 03-10: not 0DTE for a contract expiring 03-09.
        _tick(_at("05:00:00", next_day), after_midnight, "30.00", 100),
    ]
    con.execute(f"SET TimeZone = '{session_zone}'")

    alerts = _by_chain(_replay(tmp_path, rows, "naive", con, day))

    assert set(alerts) == {at_open, cdt_early, evening}
    assert alerts[at_open].bucket_start == _at("13:30:00", day)
    assert alerts[at_open].fired_at == _at("13:30:00.500", day)
    assert alerts[cdt_early].bucket_start == _at("05:30:00", day)
    assert alerts[evening].bucket_start == _at("00:30:00", next_day)
    assert all(a.expiry == day for a in alerts.values())


def test_double_price_noise_is_exact_cents(tmp_path, con):
    # In a DOUBLE, 0.05 is 0.0500000000000000027 and 0.57 is 0.5699999999999999512: 0.57 * 10000
    # is 5699.999999999999, so a truncated or float premium misses the floor and the 75% line.
    floor_chain, ratio_chain = SPY_C, QQQ_C
    rows = [
        # 5,700 x 4,000 + 500 x 4,400 = 25,000,000 cents: the floor exactly.
        _tick(_at("14:31:00"), floor_chain, "0.57", 4000),
        _tick(_at("14:31:01"), floor_chain, "0.05", 4400),
        # 5,700 x 4,000 ask (under the floor alone) against 500 x 15,200 bid: 75% exactly.
        _tick(_at("14:31:00"), ratio_chain, "0.57", 4000),
        _tick(_at("14:31:01"), ratio_chain, "0.05", 15200, side="bid"),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, "tz", con))

    assert set(alerts) == {floor_chain, ratio_chain}
    assert alerts[floor_chain].total_premium == _usd("250000.00")
    assert alerts[floor_chain].ask_premium == _usd("250000.00")
    assert alerts[floor_chain].trade_count == 2
    assert alerts[ratio_chain].ratio_pct == Decimal("75.00")
    assert alerts[ratio_chain].ask_premium == _usd("228000.00")
    assert alerts[ratio_chain].total_premium == _usd("304000.00")
    assert alerts[ratio_chain].top_trade_premium == _usd("228000.00")
    assert alerts[ratio_chain].trade_count == 2


def test_ratio_rounds_half_even_and_spot_half_up(tmp_path, layout, con):
    # $240,400 of $320,000 is 75.125%: half-even gives 75.12 (half-up would give 75.13).
    # Spot 678.125 rounds half-up to 678.13 (half-even would give 678.12).
    rows = [
        _tick(_at("14:31:00"), SPY_C, "24.04", 100, spot="678.00"),
        _tick(_at("14:31:01"), SPY_C, "7.96", 100, side="bid", spot="678.125"),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.ratio_pct == Decimal("75.12")
    assert alert.underlying_price == Decimal("678.13")


def test_times_are_aware_utc_ms(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:07.123456"), SPY_C, "20.00", 100),
        # The crossing tick at .999999 keeps .999: truncated, never rounded up.
        _tick(_at("14:31:08.999999"), SPY_C, "5.00", 100, side="bid"),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    for value in (
        alert.fired_at,
        alert.top_trade_executed_at,
        alert.bucket_start,
        alert.bucket_end,
    ):
        assert type(value) is datetime
        assert value.tzinfo is UTC
    assert alert.fired_at == datetime(2026, 11, 17, 14, 31, 8, 999000, tzinfo=UTC)
    assert alert.top_trade_executed_at == datetime(2026, 11, 17, 14, 31, 7, 123000, tzinfo=UTC)
    assert alert.bucket_start == datetime(2026, 11, 17, 14, 30, tzinfo=UTC)
    assert alert.bucket_end == datetime(2026, 11, 17, 14, 35, tzinfo=UTC)
    assert alert.key == (SPY_C, alert.bucket_start)
    assert alert.expiry == DAY
    assert alert.option_type == "C"
    assert alert.strike == Decimal("670.000")


# --- Flags, spot and confluence -----------------------------------------------------------------


def test_sweep_and_floor_from_two_value_report_flags(tmp_path, layout, con):
    rows = [
        _tick(_at("14:31:00"), SPY_C, "30.00", 100, flags=("intermarket_sweep", "futures_floor")),
        _tick(_at("14:31:00"), QQQ_C, "30.00", 100, flags=("extended_hours", "intermarket_sweep")),
        # The flags are the top trade's, not the crossing tick's.
        _tick(_at("14:31:00"), SPXW_C, "24.00", 100),
        _tick(
            _at("14:31:01"),
            SPXW_C,
            "6.00",
            100,
            side="bid",
            flags=("intermarket_sweep", "futures_floor"),
        ),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    flags = {chain: (a.top_trade_is_sweep, a.top_trade_is_floor) for chain, a in alerts.items()}
    assert flags == {SPY_C: (True, True), QQQ_C: (True, False), SPXW_C: (False, False)}


def test_sweep_tag_alone_is_false(tmp_path, layout, con):
    rows = [
        _tick(
            _at("14:31:00"),
            SPY_C,
            "30.00",
            100,
            tags=("ask_side", "bullish", "sweep", "floor"),
        ),
    ]

    (alert,) = _replay(tmp_path, rows, layout, con).alerts

    assert alert.top_trade_is_sweep is False
    assert alert.top_trade_is_floor is False


def test_spxw_opening_seconds_spot_forward_fills(tmp_path, layout, con):
    spxw_quiet = _chain("SPXW", "C", 6750)
    spxw_later = _chain("SPXW", "P", 6650)
    spxw_before = _chain("SPXW", "P", 6500)
    spy_no_spot = _chain("SPY", "P", 650)
    rows = [
        # An SPXW print with a spot before the crossing tick: a backward fill, never used.
        _tick(_at("14:30:01.900"), spxw_before, "1.00", 1, spot="6698.00"),
        _tick(_at("14:30:02.000"), SPXW_C, "30.00", 100, spot=None),
        # Spots the fill must skip: another root, an SPX-root row and a non-0DTE SPXW row.
        _tick(_at("14:30:02.100"), SPY_C, "1.00", 1, spot="670.00"),
        _tick(
            _at("14:30:02.200"), _chain("SPX", "C", 6700), "1.00", 1, spot="6699.99", label="SPX"
        ),
        _tick(
            _at("14:30:02.300"),
            _chain("SPXW", "C", 6700, DAY + timedelta(days=1)),
            "1.00",
            1,
            spot="6699.98",
        ),
        # A kept SPXW print with no spot either.
        _tick(_at("14:30:02.400"), spxw_quiet, "1.00", 1, side="bid", spot=None),
        # The first kept SPXW print with a spot after the crossing tick (canceled ones count).
        _tick(
            _at("14:30:02.500"), spxw_later, "1.00", 1, side="bid", spot="6700.125", canceled=True
        ),
        _tick(_at("14:30:03.000"), spxw_later, "1.00", 1, side="bid", spot="6701.00"),
        # Only SPXW is filled: an SPY crossing tick with no spot keeps none, though an SPXW print
        # with a spot follows it.
        _tick(_at("14:31:00"), spy_no_spot, "30.00", 100, spot=None),
        _tick(_at("14:31:05"), spxw_later, "1.00", 1, side="bid", spot="6705.00"),
    ]

    alerts = _by_chain(_replay(tmp_path, rows, layout, con))

    assert alerts[SPXW_C].underlying_price == Decimal("6700.13")
    assert alerts[spy_no_spot].underlying_price is None


def test_confluence_backward_asymmetric_90s_in_90_001s_out(tmp_path, layout, con):
    qqq_c2 = _chain("QQQ", "C", 610)
    spy_p2 = _chain("SPY", "P", 655)
    qqq_c3 = _chain("QQQ", "C", 620)
    spy_c3 = _chain("SPY", "C", 680)

    def fire(clock: str, chain: str) -> dict[str, object]:
        return _tick(_at(clock), chain, "30.00", 100)

    rows = [
        # Calls A, B, C within 90 s: A [], B [A], C [A, B].
        fire("14:31:00.000", QQQ_C),
        fire("14:31:30.000", SPXW_C),
        fire("14:32:30.000", SPY_C),  # exactly 90 s after A: in
        # A put between them partners no call.
        fire("14:31:10.000", SPY_P),
        # A second QQQ call: its own ticker never counts.
        fire("14:32:00.000", qqq_c2),
        # Puts: SPXW at exactly 90 s after QQQ is in, SPY at 90.001 s is out for QQQ.
        fire("14:40:00.000", QQQ_P),
        fire("14:41:30.000", SPXW_P),
        fire("14:41:30.001", spy_p2),
        # Two fires in the same millisecond partner each other.
        fire("14:50:00.000", spy_c3),
        fire("14:50:00.000", qqq_c3),
    ]

    result = _replay(tmp_path, rows, layout, con)

    tags = {a.option_chain: a.confluence_tickers for a in result.alerts}
    assert tags == {
        QQQ_C: (),
        SPY_P: (),
        SPXW_C: ("QQQ",),
        qqq_c2: ("SPXW",),
        SPY_C: ("QQQ", "SPXW"),
        QQQ_P: (),
        SPXW_P: ("QQQ",),
        spy_p2: ("SPXW",),
        qqq_c3: ("SPY",),
        spy_c3: ("QQQ",),
    }
    order = [(a.fired_at, a.ticker, a.option_chain) for a in result.alerts]
    assert order == sorted(order)
    assert [a.option_chain for a in result.alerts][-2:] == [qqq_c3, spy_c3]


def _live_row(
    row_id: int,
    chain: str,
    top_at: datetime | None,
    top_size: int | None,
    top_premium: str | None,
) -> LiveRow:
    """A live row as heal_day reads it; only the top-trade fields matter to top_trade_flags."""
    return LiveRow(
        id=row_id,
        option_chain=chain,
        ticker=chain[:-15],
        bucket_start=_at("14:30:00"),
        fired_at=_at("14:31:08"),
        trade_count=1,
        ratio_pct=Decimal("100.00"),
        ask_premium=Decimal("250000.00"),
        total_premium=Decimal("250000.00"),
        top_trade_premium=Decimal(top_premium) if top_premium is not None else None,
        top_trade_size=top_size,
        top_trade_executed_at=top_at,
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=None,
        source="live",
    )


def test_top_trade_flags_match_on_ms_size_premium(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            _tick(_at("14:31:07.123456"), SPY_C, "25.00", 100, flags=("intermarket_sweep",)),
            # Same millisecond, size and premium, but a bid: never a top trade.
            _tick(
                _at("14:31:07.123900"), SPY_C, "25.00", 100, side="bid", flags=("futures_floor",)
            ),
            _tick(_at("14:32:00.000"), QQQ_C, "10.00", 100, flags=("futures_floor",)),
        ],
        layout=layout,
    )
    live_ms = _at("14:31:07.123")
    rows = [
        _live_row(1, SPY_C, live_ms, 100, "250000.00"),
        _live_row(2, SPY_C, live_ms, 99, "250000.00"),
        _live_row(3, SPY_C, live_ms, 100, "250000.01"),
        _live_row(4, SPY_C, _at("14:31:07.124"), 100, "250000.00"),
        _live_row(5, SPY_C, None, None, None),
        _live_row(6, QQQ_C, live_ms, 100, "250000.00"),
        _live_row(7, QQQ_C, _at("14:32:00"), 100, "100000.00"),
    ]

    flags = top_trade_flags(con, tape, DAY, rows)

    assert flags == {
        1: (True, False),
        2: None,
        3: None,
        4: None,
        5: None,
        6: None,
        7: (False, True),
    }
    assert top_trade_flags(con, tape, DAY, []) == {}


def test_top_trade_flags_disagreeing_matches_give_none(tmp_path, layout, con):
    tape = _write_tape(
        tmp_path,
        [
            # Two asks in the same millisecond with the same size and premium: one a sweep.
            _tick(_at("14:31:07.123100"), SPY_C, "25.00", 100, flags=("intermarket_sweep",)),
            _tick(_at("14:31:07.123800"), SPY_C, "25.00", 100),
            # Two that agree give their flags.
            _tick(_at("14:32:00.000100"), QQQ_C, "10.00", 100, flags=("futures_floor",)),
            _tick(_at("14:32:00.000900"), QQQ_C, "10.00", 100, flags=("futures_floor",)),
        ],
        layout=layout,
    )
    rows = [
        _live_row(1, SPY_C, _at("14:31:07.123"), 100, "250000.00"),
        _live_row(2, QQQ_C, _at("14:32:00"), 100, "100000.00"),
    ]

    assert top_trade_flags(con, tape, DAY, rows) == {1: None, 2: (False, True)}


# --- Failures surface ---------------------------------------------------------------------------


def test_replay_day_raises_on_a_missing_tape(tmp_path, con):
    with pytest.raises(duckdb.IOException):
        replay_day(con, str(tmp_path / "absent-fulltape.parquet"), DAY)


def test_replay_day_raises_on_a_tape_without_a_needed_column(tmp_path, con):
    target = (tmp_path / "short-fulltape.parquet").as_posix()
    con.execute(
        f"COPY (SELECT 'SPY261117C00670000' AS option_chain_id, 'SPY' AS underlying_symbol) "
        f"TO '{target}' (FORMAT parquet)"
    )

    with pytest.raises(duckdb.BinderException):
        replay_day(con, target, DAY)


def test_replay_day_raises_when_the_tape_has_no_rows_for_the_day(tmp_path, layout, con):
    # A wrong day, an empty tape or a foreign one must not read as a quiet day: a caller that
    # replaces the day's replay rows with the result would delete them.
    good = _write_tape(tmp_path, [_tick(_at("14:31:00"), SPY_C, "25.00", 100)], layout=layout)
    empty = _write_tape(tmp_path, [], layout=layout)
    foreign = _write_tape(
        tmp_path,
        [
            _tick(_at("14:31:00"), _chain("SPX", "C", 6700), "25.00", 100, label="SPX"),
            _tick(_at("14:31:00"), _chain("SPY", "C", 670, DAY + timedelta(days=1)), "25.00", 100),
        ],
        layout=layout,
    )
    next_day = DAY + timedelta(days=1)

    with pytest.raises(ValueError, match=f"no 0DTE SPXW/SPY/QQQ rows for {next_day}: wrong day"):
        replay_day(con, good, next_day)
    with pytest.raises(ValueError, match=f"no 0DTE SPXW/SPY/QQQ rows for {DAY}: wrong day"):
        replay_day(con, empty, DAY)
    with pytest.raises(ValueError, match="broken tape"):
        replay_day(con, foreign, DAY)
    assert len(replay_day(con, good, DAY).alerts) == 1


# --- The insert ---------------------------------------------------------------------------------


def _alert(n: int, confluence: tuple[str, ...] = ()) -> TapeAlert:
    bucket_start = _at("14:30:00") + timedelta(seconds=300 * (n // 50))
    return TapeAlert(
        option_chain=_chain("SPY", "C", 600 + n % 50),
        ticker="SPY",
        option_type="C",
        strike=Decimal(600 + n % 50).quantize(Decimal("0.001")),
        expiry=DAY,
        bucket_start=bucket_start,
        bucket_end=bucket_start + timedelta(seconds=300),
        fired_at=bucket_start + timedelta(seconds=1),
        ratio_pct=Decimal("100.00"),
        ask_premium=Decimal("250000.00"),
        total_premium=Decimal("250000.00"),
        trade_count=1,
        top_trade_premium=Decimal("250000.00"),
        top_trade_size=100,
        top_trade_executed_at=bucket_start + timedelta(seconds=1),
        top_trade_is_sweep=False,
        top_trade_is_floor=False,
        underlying_price=Decimal("670.00"),
        confluence_tickers=confluence,
    )


def test_alert_insert_columns_are_the_fields_then_source():
    names = tuple(f.name for f in fields(TapeAlert))

    assert names[-1] == "confluence_tickers"
    assert (*names, "source") == ALERT_INSERT_COLUMNS


def test_insert_alerts_uses_fetch_true_and_lists(monkeypatch):
    calls: list[tuple[object, str, list[tuple[object, ...]], dict[str, object]]] = []

    def fake_execute_values(cur, sql, argslist, **kwargs):
        rows = list(argslist)
        calls.append((cur, sql, rows, kwargs))
        return [(i,) for i in range(len(rows))]

    monkeypatch.setattr(psycopg2.extras, "execute_values", fake_execute_values)
    cursor = object()
    alerts = [_alert(0, ("QQQ", "SPXW")), _alert(1)]

    inserted = insert_alerts(cursor, alerts)

    assert inserted == 2
    ((cur, sql, rows, kwargs),) = calls
    assert cur is cursor
    assert kwargs == {"page_size": 500, "fetch": True}
    assert sql.startswith(f"INSERT INTO interval_ba_alerts ({', '.join(ALERT_INSERT_COLUMNS)}) ")
    assert sql.endswith("ON CONFLICT (option_chain, bucket_start) DO NOTHING RETURNING id")
    confluence_at = ALERT_INSERT_COLUMNS.index("confluence_tickers")
    for alert, row in zip(alerts, rows, strict=True):
        assert len(row) == len(ALERT_INSERT_COLUMNS)
        assert row[-1] == "replay"
        assert type(row[confluence_at]) is list
        assert row[confluence_at] == list(alert.confluence_tickers)
        assert row[0] == alert.option_chain
        assert row[ALERT_INSERT_COLUMNS.index("fired_at")] == alert.fired_at
    # Why a list: psycopg2 adapts a list to an array and a tuple to a row constructor.
    assert psycopg2.extensions.adapt(["SPY"]).getquoted().startswith(b"ARRAY[")
    assert psycopg2.extensions.adapt(("SPY",)).getquoted().startswith(b"(")


class _PagingCursor:
    """Just enough of a psycopg2 cursor for the real execute_values with fetch=True.

    Each execute is one page. fetchall returns an id for every row in it except the chains in
    `conflicts`, as ON CONFLICT DO NOTHING RETURNING id does.
    """

    def __init__(self, conflicts: frozenset[str] = frozenset(), fail: Exception | None = None):
        self.connection = SimpleNamespace(encoding="UTF8")
        self.pages: list[int] = []
        self._conflicts = conflicts
        self._fail = fail
        self._pending: list[bool] = []
        self._returned: list[tuple[int]] = []
        self._next_id = 1

    def mogrify(self, template: bytes, args: tuple[object, ...]) -> bytes:
        self._pending.append(args[0] not in self._conflicts)
        return b"(...)"

    def execute(self, sql: bytes) -> None:
        if self._fail is not None:
            raise self._fail
        assert sql.startswith(b"INSERT INTO interval_ba_alerts")
        self.pages.append(len(self._pending))
        kept = sum(self._pending)
        self._returned = [(self._next_id + i,) for i in range(kept)]
        self._next_id += kept
        self._pending = []

    def fetchall(self) -> list[tuple[int]]:
        return self._returned


def test_insert_alerts_counts_rows_across_pages():
    cursor = _PagingCursor()

    inserted = insert_alerts(cursor, [_alert(n) for n in range(501)])

    assert inserted == 501
    assert cursor.pages == [500, 1]


def test_insert_alerts_does_not_count_conflicting_rows():
    alerts = [_alert(n) for n in range(501)]
    cursor = _PagingCursor(conflicts=frozenset({alerts[0].option_chain}))

    inserted = insert_alerts(cursor, alerts)

    # _alert(n) repeats a chain every 50 rows, so 11 rows share alerts[0]'s chain.
    assert inserted == 501 - 11


def test_insert_alerts_propagates_a_database_error():
    cursor = _PagingCursor(fail=psycopg2.OperationalError("server closed the connection"))

    with pytest.raises(psycopg2.OperationalError, match="server closed the connection"):
        insert_alerts(cursor, [_alert(0)])


def test_insert_alerts_with_nothing_to_insert_returns_zero():
    cursor = _PagingCursor()

    assert insert_alerts(cursor, []) == 0
    assert cursor.pages == []


# --- The module's own imports -------------------------------------------------------------------


def test_imports_only_duckdb_psycopg2_and_the_standard_library():
    # scripts/interval_ba_tape.py loads this file by path, with nightly/src off sys.path, so a
    # nightly import (constants, config, resources) would break the tool.
    tree = ast.parse(MODULE.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "a relative import"
            imported.add(node.module or "")

    third_party = {name for name in imported if name.split(".")[0] not in sys.stdlib_module_names}

    assert third_party <= {"duckdb", "psycopg2", "psycopg2.extras"}, third_party
