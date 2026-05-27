"""One-shot backfill of ws_option_trades for 2026-05-26.

uw-stream was degraded for parts of 2026-05-26 — re-ingest from the
UW Full Tape parquet to close coverage gaps.

Why this script differs from the 2026-05-20 backfill:

  - Source is the UW Full Tape parquet (1.4G zip → 959 MB parquet,
    10.5M rows), not the GEXBot EOD CSV.
  - The Full Tape carries UW's canonical per-print `id` UUID — the
    same value uw-stream writes into ws_option_trades.ws_trade_id.
    Dedup is therefore a plain ON CONFLICT (ws_trade_id) DO NOTHING,
    idempotent against whatever the live daemon did capture.
  - No (hour, ticker) skip-list needed; overlap with live writes is
    handled by the unique constraint.

Field mapping (parquet col → ws_option_trades col):

  id                   → ws_trade_id   (canonical UUID — primary dedupe key)
  underlying_symbol    → ticker
  option_chain_id      → option_chain
  option_type          → option_type   ('call' → 'C', 'put' → 'P')
  strike               → strike
  expiry               → expiry
  executed_at          → executed_at
  price                → price
  size                 → size
  underlying_price     → underlying_price
  tags  → side         (derive from tags array literal exactly like
                        uw-stream/src/handlers/option_trades._derive_side:
                        'ask_side'→'ask', 'bid_side'→'bid',
                        'mid_side'→'mid', else 'no_side')
  implied_volatility   → implied_volatility
  delta                → delta
  open_interest        → open_interest
  canceled             → canceled
  (marker JSON)        → raw_payload

Usage:
    set -a; source .env.local; set +a
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-05-26.py
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-05-26.py --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import polars as pl
import psycopg2
from psycopg2.extras import execute_values

PARQUET_PATH = Path.home() / "Desktop" / "Eod-Full-Tape-parquet" / "2026-05-26-fulltape.parquet"

# Backfill window in UTC. Question/answer scoping (see conversation
# 2026-05-27) chose the full RTH session: 13:00–21:00 UTC. This is a
# superset of the 2026-05-20 window (13:00–20:30) so any post-close
# auction prints land too.
DAY_START_UTC = datetime(2026, 5, 26, 13, 0, 0, tzinfo=timezone.utc)
DAY_END_UTC = datetime(2026, 5, 26, 21, 0, 0, tzinfo=timezone.utc)

# Lottery Finder universe — mirrors uw-stream/src/config.py
# `_LOTTERY_TICKERS` as of 2026-05-15 (88 tickers). Diverging from the
# live subscription set would create rows the daemon never captures,
# which downstream lottery aggregations would treat as anomalous.
LOTTERY_TICKERS = frozenset(
    {
        # V3 (Mode A 0DTE intraday)
        "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC", "SQQQ",
        "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM", "RKLB", "SOFI",
        "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER", "MSTR", "TQQQ", "RIOT",
        "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
        "SPXW",
        "CRWV", "IBIT", "ARM", "OKLO", "APLD", "IONQ",
        "HIMS", "CAR", "IREN", "ASTS", "NBIS", "CRCL", "LITE", "NVTS",
        # EXTENDED (Mode B DTE 1-3 trend)
        "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN",
        "PLTR", "AVGO", "GOOGL", "GOOG", "COIN", "HOOD", "MRVL",
        "ORCL", "AAPL",
        "QCOM", "NFLX", "LLY", "BABA", "NOW", "CRWD",
        "BE", "AAOI", "SHOP", "BA", "APP", "POET",
        "DELL", "CVNA", "RGTI", "IBM", "CSCO",
        "GME", "TLT",
    },
)

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
    {"backfill_source": "fulltape-2026-05-26.parquet"},
)

_TAG_TO_SIDE: dict[str, str] = {
    "ask_side": "ask",
    "bid_side": "bid",
    "mid_side": "mid",
}


def _derive_side(tags: str | None) -> str:
    """Parse a Postgres array literal like '{ask_side,bullish,etf}' and
    return the canonical side. Mirrors
    uw-stream/src/handlers/option_trades._derive_side semantics.
    """
    if not tags:
        return "no_side"
    inner = tags.strip()
    if inner.startswith("{"):
        inner = inner[1:]
    if inner.endswith("}"):
        inner = inner[:-1]
    if not inner:
        return "no_side"
    for tag in inner.split(","):
        t = tag.strip()
        if t in _TAG_TO_SIDE:
            return _TAG_TO_SIDE[t]
    return "no_side"


def _option_type_short(s: str | None) -> str | None:
    if s == "call":
        return "C"
    if s == "put":
        return "P"
    return None


def _to_decimal(v: float | None) -> Decimal | None:
    if v is None:
        return None
    if v != v:  # NaN
        return None
    return Decimal(str(v))


def _fetch_coverage(con) -> dict[int, int]:
    """Return {hour_utc: row_count} for ws_option_trades on the backfill day."""
    cur = con.cursor()
    cur.execute(
        """
        SELECT EXTRACT(HOUR FROM executed_at)::int AS hr, COUNT(*)
        FROM ws_option_trades
        WHERE executed_at >= %s AND executed_at < %s
        GROUP BY hr
        ORDER BY hr
        """,
        (DAY_START_UTC, DAY_END_UTC),
    )
    rows = {int(hr): int(n) for hr, n in cur.fetchall()}
    cur.close()
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, runs in dry-run mode "
             "(reports counts, no DB writes).",
    )
    args = parser.parse_args()

    if not PARQUET_PATH.is_file():
        print(f"ERROR: parquet not found: {PARQUET_PATH}", file=sys.stderr)
        return 2

    db_url = (
        os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    )
    if not db_url:
        print(
            "ERROR: DATABASE_URL or DATABASE_URL_UNPOOLED must be set "
            "(source .env.local first).",
            file=sys.stderr,
        )
        return 2

    print(f"parquet:  {PARQUET_PATH}", flush=True)
    print(f"window:   {DAY_START_UTC} → {DAY_END_UTC}", flush=True)
    print(f"universe: {len(LOTTERY_TICKERS)} tickers", flush=True)
    print(f"mode:     {'APPLY' if args.apply else 'DRY-RUN'}", flush=True)
    print(flush=True)

    con = psycopg2.connect(db_url)
    con.autocommit = False

    coverage_before = _fetch_coverage(con)
    print("ws_option_trades coverage BEFORE (rows per UTC hour):", flush=True)
    for hr in range(DAY_START_UTC.hour, DAY_END_UTC.hour):
        print(f"  {hr:02d}:00  {coverage_before.get(hr, 0):>10,}", flush=True)
    print(
        f"  total: {sum(coverage_before.values()):,}",
        flush=True,
    )
    print(flush=True)

    # Stream the parquet with predicate pushdown so we never materialise
    # the full 10.5M-row frame in memory.
    needed_cols = [
        "id",
        "underlying_symbol",
        "option_chain_id",
        "option_type",
        "strike",
        "expiry",
        "executed_at",
        "price",
        "size",
        "underlying_price",
        "tags",
        "implied_volatility",
        "delta",
        "open_interest",
        "canceled",
    ]
    lf = (
        pl.scan_parquet(PARQUET_PATH)
        .select(needed_cols)
        .filter(
            pl.col("underlying_symbol").is_in(list(LOTTERY_TICKERS))
            & pl.col("executed_at").is_between(
                DAY_START_UTC, DAY_END_UTC, closed="left",
            )
            & pl.col("id").is_not_null()
            & (pl.col("price") > 0)
            & (pl.col("size") > 0)
        )
    )

    t0 = time.monotonic()
    print("→ Collecting filtered rows (streaming)...", flush=True)
    df = lf.collect(engine="streaming")
    print(
        f"  filtered rows: {df.height:,} ({time.monotonic() - t0:.1f}s)",
        flush=True,
    )

    cur = con.cursor()
    batch: list[tuple] = []
    total_kept = 0
    total_inserted = 0
    total_invalid = 0
    kept_by_hour_ticker: dict[tuple[int, str], int] = {}

    def flush() -> None:
        nonlocal batch, total_inserted
        if not batch:
            return
        if args.apply:
            execute_values(cur, INSERT_SQL, batch, page_size=BATCH_SIZE)
            con.commit()
            total_inserted += cur.rowcount
        else:
            total_inserted += len(batch)
        batch = []

    for row in df.iter_rows(named=True):
        opt_type = _option_type_short(row["option_type"])
        if opt_type is None:
            total_invalid += 1
            continue
        executed_at: datetime = row["executed_at"]
        if executed_at.tzinfo is None:
            executed_at = executed_at.replace(tzinfo=timezone.utc)

        batch.append((
            row["id"],
            row["underlying_symbol"],
            row["option_chain_id"],
            opt_type,
            _to_decimal(row["strike"]) or Decimal(0),
            row["expiry"],
            executed_at,
            _to_decimal(row["price"]),
            int(row["size"]),
            _to_decimal(row["underlying_price"]),
            _derive_side(row["tags"]),
            _to_decimal(row["implied_volatility"]),
            _to_decimal(row["delta"]),
            int(row["open_interest"]) if row["open_interest"] is not None else None,
            bool(row["canceled"]) if row["canceled"] is not None else False,
            RAW_PAYLOAD_MARKER,
        ))
        total_kept += 1
        ht_key = (executed_at.hour, row["underlying_symbol"])
        kept_by_hour_ticker[ht_key] = kept_by_hour_ticker.get(ht_key, 0) + 1

        if len(batch) >= BATCH_SIZE:
            flush()

    flush()

    coverage_after = _fetch_coverage(con) if args.apply else coverage_before
    cur.close()
    con.close()

    elapsed = time.monotonic() - t0
    print(flush=True)
    print(f"DONE in {elapsed:.1f}s", flush=True)
    print(f"  rows kept (queued for insert): {total_kept:,}", flush=True)
    print(f"  invalid option_type:           {total_invalid:,}", flush=True)
    print(
        f"  inserted (or would insert):    {total_inserted:,}",
        flush=True,
    )
    print(flush=True)

    if args.apply:
        print("ws_option_trades coverage AFTER (rows per UTC hour):", flush=True)
        for hr in range(DAY_START_UTC.hour, DAY_END_UTC.hour):
            before = coverage_before.get(hr, 0)
            after = coverage_after.get(hr, 0)
            delta = after - before
            print(
                f"  {hr:02d}:00  {after:>10,}  (Δ +{delta:,})",
                flush=True,
            )
        print(
            f"  total: {sum(coverage_after.values()):,} "
            f"(Δ +{sum(coverage_after.values()) - sum(coverage_before.values()):,})",
            flush=True,
        )
        print(flush=True)

    print("kept by hour × ticker (top 30 by row count):", flush=True)
    top = sorted(kept_by_hour_ticker.items(), key=lambda x: -x[1])[:30]
    for (hr, tkr), n in top:
        print(f"  {hr:02d}:00 UTC  {tkr:6s}  {n:>10,}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
