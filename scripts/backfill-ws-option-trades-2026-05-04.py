"""One-shot backfill of ws_option_trades for 2026-05-04.

The uw-stream WS daemon was misconfigured most of the day; only the
last ~20 minutes of prints (from 19:40:16.695 UTC onward) made it into
the table. This script reads the EOD parquet UW publishes, filters to
the 51-ticker Lottery Finder universe, and inserts the 13:30:00 →
19:40:16.694999 UTC window — leaving the live WS data untouched.

Usage:
    set -a; source .env.local; set +a
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-05-04.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import psycopg2
import pyarrow.parquet as pq
from psycopg2.extras import execute_values

PARQUET_PATH = (
    "/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-05-04-trades.parquet"
)

# Cutoff: timestamp of the first live WS print today. Anything before
# this is parquet-only territory; anything at-or-after is live WS data
# we must not duplicate.
CUTOFF_UTC = datetime(2026, 5, 4, 19, 40, 16, 695000, tzinfo=timezone.utc)

# Lottery Finder V3 ∪ EXTENDED — must stay in sync with
# api/_lib/lottery-finder.ts and uw-stream/src/config.py.
LOTTERY_TICKERS = frozenset(
    {
        # V3 (Mode A 0DTE intraday)
        "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC",
        "SQQQ", "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM",
        "RKLB", "SOFI", "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER",
        "MSTR", "TQQQ", "RIOT", "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
        # EXTENDED (Mode B DTE 1-3 trend)
        "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN", "PLTR", "AVGO",
        "GOOGL", "GOOG", "COIN", "HOOD", "MRVL", "ORCL", "AAPL",
    },
)

# Stable namespace for UUIDv5 derivation. Random one-shot value baked
# into the script so re-runs synthesise the same ws_trade_id for the
# same print and the UNIQUE(ws_trade_id) index dedupes naturally.
UUID_NAMESPACE = uuid.UUID("c7e7e6f4-6f6e-4f6e-9f6e-6f6e6f6e6f6e")

BATCH_SIZE = 5000

COLUMNS = (
    "ws_trade_id",
    "ticker",
    "option_chain",
    "option_type",
    "strike",
    "expiry",
    "executed_at",
    "price",
    "size",
    "underlying_price",
    "side",
    "implied_volatility",
    "delta",
    "open_interest",
    "canceled",
    "raw_payload",
)

INSERT_SQL = (
    f"INSERT INTO ws_option_trades ({', '.join(COLUMNS)}) VALUES %s "
    "ON CONFLICT (ws_trade_id) DO NOTHING"
)

RAW_PAYLOAD_MARKER = json.dumps(
    {"backfill_source": "Bot-Eod-parquet/2026-05-04-trades.parquet"},
)


def _none_if_nan(v: float | None) -> float | None:
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN check
        return None
    return v


def _to_decimal(v: float | None) -> Decimal | None:
    v = _none_if_nan(v)
    if v is None:
        return None
    return Decimal(str(v))


def _make_uuid(option_chain: str, executed_at_ns: int, price: float,
               size: int, side: str) -> uuid.UUID:
    key = f"{option_chain}|{executed_at_ns}|{price}|{size}|{side}"
    return uuid.uuid5(UUID_NAMESPACE, key)


def main() -> None:
    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]

    pf = pq.ParquetFile(PARQUET_PATH)
    print(f"parquet: {pf.metadata.num_rows:,} rows, "
          f"{pf.metadata.num_row_groups} row groups", flush=True)
    print(f"cutoff:  {CUTOFF_UTC.isoformat()}", flush=True)
    print(f"universe: {len(LOTTERY_TICKERS)} tickers", flush=True)

    columns_to_read = [
        "executed_at", "underlying_symbol", "option_chain_id", "side",
        "strike", "option_type", "expiry", "underlying_price",
        "price", "size", "open_interest", "implied_volatility",
        "delta", "canceled",
    ]

    con = psycopg2.connect(db_url)
    con.autocommit = False
    cur = con.cursor()

    total_seen = 0
    total_kept = 0
    total_inserted = 0
    t0 = time.monotonic()
    batch: list[tuple] = []

    def flush() -> None:
        nonlocal batch, total_inserted
        if not batch:
            return
        execute_values(cur, INSERT_SQL, batch, page_size=BATCH_SIZE)
        con.commit()
        total_inserted += cur.rowcount  # rows actually inserted (post-conflict)
        batch = []

    for rg_idx in range(pf.metadata.num_row_groups):
        rg = pf.read_row_group(rg_idx, columns=columns_to_read)
        df = rg.to_pandas()
        total_seen += len(df)

        # Filter: lottery universe + before cutoff + valid price/size.
        df = df[df["underlying_symbol"].isin(LOTTERY_TICKERS)]
        df = df[df["executed_at"] < CUTOFF_UTC]
        df = df[(df["price"] > 0) & (df["size"] > 0)]

        kept_in_rg = len(df)
        total_kept += kept_in_rg

        for row in df.itertuples(index=False):
            executed_at: datetime = row.executed_at.to_pydatetime()
            executed_at_ns = int(row.executed_at.value)  # pandas ns since epoch
            option_chain: str = row.option_chain_id
            ticker: str = row.underlying_symbol
            option_type = "C" if row.option_type == "call" else "P"
            strike = Decimal(str(row.strike))
            expiry = row.expiry  # date object
            price = Decimal(str(row.price))
            size_int = int(row.size)
            side: str = row.side
            canceled = row.canceled == "t"

            ws_trade_id = _make_uuid(
                option_chain, executed_at_ns, float(row.price),
                size_int, side,
            )

            batch.append((
                str(ws_trade_id),
                ticker,
                option_chain,
                option_type,
                strike,
                expiry,
                executed_at,
                price,
                size_int,
                _to_decimal(row.underlying_price),
                side,
                _to_decimal(row.implied_volatility),
                _to_decimal(row.delta),
                None if row.open_interest != row.open_interest else int(row.open_interest),  # NaN-safe
                canceled,
                RAW_PAYLOAD_MARKER,
            ))

            if len(batch) >= BATCH_SIZE:
                flush()

        elapsed = time.monotonic() - t0
        print(
            f"  rg {rg_idx + 1}/{pf.metadata.num_row_groups}: "
            f"seen={total_seen:,} kept={total_kept:,} "
            f"inserted={total_inserted:,} elapsed={elapsed:.1f}s",
            flush=True,
        )

    flush()
    cur.close()
    con.close()

    elapsed = time.monotonic() - t0
    print()
    print(f"DONE: seen={total_seen:,} kept={total_kept:,} "
          f"inserted={total_inserted:,} in {elapsed:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
