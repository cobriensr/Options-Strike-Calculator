"""A small UW Full Tape, written in tmp_path, for the Interval B/A replay and heal tests.

The tape has had two layouts (2026-11-24 tape facts, section 2): `naive` (before 2026-05-04:
executed_at a naive TIMESTAMP holding UTC, prices DECIMAL(18,4), tags and report_flags bare
comma lists) and `tz` (TIMESTAMPTZ, DOUBLE, brace-wrapped lists). `_write_tape` writes either.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Literal

import duckdb

DAY = date(2026, 11, 17)
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

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
