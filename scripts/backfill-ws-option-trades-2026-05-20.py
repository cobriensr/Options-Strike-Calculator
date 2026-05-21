"""One-shot backfill of ws_option_trades for 2026-05-20.

Today's uw-stream was degraded for several hours due to the GCP outage
recovery affecting Railway. Coverage by hour:

  13:00 UTC (08:30 CT open)  — 0 prints     ← gap
  14:00 UTC (09:00 CT)       — 0 prints     ← gap
  15:00 UTC (10:00 CT)       — 380k / 86 tickers (normal)
  16:00 UTC (11:00 CT)       — 355k / 3 tickers (partial, SPY/QQQ/SPX-ish)
  17:00 UTC (12:00 CT)       — 265k / 3 tickers (partial)
  18:00 UTC (13:00 CT)       — 430k / 86 tickers (normal)
  19:00 UTC (14:00 CT)       — 999k / 86 tickers (normal)
  20:00 UTC (15:00 CT close) — 59k  / 12 tickers (partial, uw-stream dying)

Strategy: read the GEXBot EOD CSV (all prints across all tickers, full
day), filter to the 51-ticker Lottery Finder universe, and skip any
(hour, ticker) pair that was already captured by the live WS daemon.

The UUIDv5 dedup path in scripts/backfill-ws-option-trades-2026-05-04.py
is NOT safe here — uw-stream uses the UW WS payload's `id` field,
which doesn't appear in the GEXBot CSV. Two paths would produce
different ws_trade_id values for the same logical print → duplicates.
The (hour, ticker) skip-list filter is the simpler, idempotent fix.

Side effect: backfilled rows have synthesized ws_trade_id values, not
canonical UW IDs. Downstream consumers (detect-lottery-fires,
detect-silent-boom, replay-lottery-fires-2026-05-20.ts) aggregate by
(ticker, option_chain, executed_at, price, size, side) — ws_trade_id
is only used for dedup. The synthesized IDs are stable across re-runs
of this script.

Usage:
    set -a; source .env.local; set +a
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-05-20.py            # dry-run
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-05-20.py --apply    # writes
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import psycopg2
from psycopg2.extras import execute_values

CSV_PATH = (
    "/Users/charlesobrien/Downloads/EOD-OptionFlow/"
    "bot-eod-report-2026-05-20.csv"
)

# Backfill day in UTC. CSV rows must be inside this window to be kept.
DAY_START_UTC = datetime(2026, 5, 20, 13, 0, 0, tzinfo=timezone.utc)
DAY_END_UTC = datetime(2026, 5, 20, 20, 30, 0, tzinfo=timezone.utc)

# Lottery Finder universe — mirrored from uw-stream/src/config.py
# `_LOTTERY_TICKERS` as of 2026-05-15 (includes 2026-05-07 and
# 2026-05-15 discovery-audit additions). 88 tickers total. Diverges
# from the 2026-05-04 backfill's 51-ticker snapshot.
LOTTERY_TICKERS = frozenset(
    {
        # V3 (Mode A 0DTE intraday) — original
        "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC",
        "SQQQ", "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM",
        "RKLB", "SOFI", "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER",
        "MSTR", "TQQQ", "RIOT", "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
        # SPXW: primary 0DTE traded chain (added 2026-05-07).
        "SPXW",
        # 2026-05-07 V3 additions (AI/speculative/crypto-adjacent).
        "CRWV", "IBIT", "ARM", "OKLO", "APLD", "IONQ",
        "HIMS", "CAR", "IREN", "ASTS", "NBIS", "CRCL", "LITE", "NVTS",
        # EXTENDED (Mode B DTE 1-3 trend) — original
        "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN", "PLTR", "AVGO",
        "GOOGL", "GOOG", "COIN", "HOOD", "MRVL", "ORCL", "AAPL",
        # 2026-05-07 EXTENDED additions (mega-cap peer-class oversights).
        "QCOM", "NFLX", "LLY", "BABA", "NOW", "CRWD",
        # 2026-05-15 V3 additions (>450-qualifying-fire bar).
        "BE", "AAOI", "SHOP", "BA", "APP", "POET",
        "DELL", "CVNA", "RGTI", "IBM", "CSCO",
        # 2026-05-15 EXTENDED additions (multi-day chain concentration).
        "GME", "TLT",
    },
)

# Stable namespace for UUIDv5 derivation — different value than the
# 2026-05-04 backfill so identical rows aren't collided across scripts.
UUID_NAMESPACE = uuid.UUID("9b2c1a3d-4f5e-6789-abcd-1234567890ab")

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
    {"backfill_source": "bot-eod-report-2026-05-20.csv"},
)


def _parse_float(s: str) -> float | None:
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v != v:  # NaN
        return None
    return v


def _parse_int(s: str) -> int | None:
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        v = _parse_float(s)
        return int(v) if v is not None else None


def _parse_decimal(s: str) -> Decimal | None:
    v = _parse_float(s)
    if v is None:
        return None
    return Decimal(str(v))


def _parse_executed_at(s: str) -> datetime:
    # CSV format: "2026-05-20 13:30:00.002272+00"
    # Python's fromisoformat needs a 'T' separator and explicit colon in tz.
    if " " in s:
        s = s.replace(" ", "T", 1)
    if s.endswith("+00"):
        s = s[:-3] + "+00:00"
    return datetime.fromisoformat(s)


def _make_uuid(option_chain: str, executed_at_iso: str, price: str,
               size: str, side: str) -> uuid.UUID:
    key = f"{option_chain}|{executed_at_iso}|{price}|{size}|{side}"
    return uuid.uuid5(UUID_NAMESPACE, key)


def fetch_captured_pairs(con) -> set[tuple[datetime, str]]:
    """Return the set of (hour_utc, ticker) pairs that already have rows
    in ws_option_trades for the backfill day. CSV rows matching any
    captured pair are skipped to prevent duplicate inserts.
    """
    cur = con.cursor()
    cur.execute(
        """
        SELECT DISTINCT
            DATE_TRUNC('hour', executed_at) AS hr,
            ticker
        FROM ws_option_trades
        WHERE executed_at >= %s AND executed_at < %s
        """,
        (DAY_START_UTC, DAY_END_UTC),
    )
    pairs = {(row[0], row[1]) for row in cur.fetchall()}
    cur.close()
    return pairs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, runs in dry-run mode "
             "(reports counts, no DB writes).",
    )
    args = parser.parse_args()

    db_url = (
        os.environ.get("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
    )

    print(f"csv:      {CSV_PATH}", flush=True)
    print(f"window:   {DAY_START_UTC} → {DAY_END_UTC}", flush=True)
    print(f"universe: {len(LOTTERY_TICKERS)} tickers", flush=True)
    print(f"mode:     {'APPLY' if args.apply else 'DRY-RUN'}", flush=True)

    con = psycopg2.connect(db_url)
    con.autocommit = False

    captured = fetch_captured_pairs(con)
    print(f"captured: {len(captured)} (hour, ticker) pairs already in DB",
          flush=True)
    if captured:
        sample = sorted(captured)[:5]
        print(f"  sample: {sample}", flush=True)

    cur = con.cursor()

    total_seen = 0
    total_in_window = 0
    total_in_universe = 0
    total_skipped_captured = 0
    total_invalid = 0
    total_kept = 0
    total_inserted = 0
    skipped_by_pair: dict[tuple[datetime, str], int] = {}
    kept_by_hour_ticker: dict[tuple[int, str], int] = {}
    t0 = time.monotonic()
    batch: list[tuple] = []

    def flush() -> None:
        nonlocal batch, total_inserted
        if not batch:
            return
        if args.apply:
            execute_values(cur, INSERT_SQL, batch, page_size=BATCH_SIZE)
            con.commit()
            total_inserted += cur.rowcount
        else:
            # Dry-run: pretend all batched rows would be inserted.
            total_inserted += len(batch)
        batch = []

    with open(CSV_PATH, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            total_seen += 1
            if total_seen % 500_000 == 0:
                elapsed = time.monotonic() - t0
                print(
                    f"  seen={total_seen:,} in_window={total_in_window:,} "
                    f"in_universe={total_in_universe:,} "
                    f"skipped_captured={total_skipped_captured:,} "
                    f"kept={total_kept:,} elapsed={elapsed:.1f}s",
                    flush=True,
                )

            ticker = row["underlying_symbol"]
            if ticker not in LOTTERY_TICKERS:
                continue
            total_in_universe += 1

            executed_at = _parse_executed_at(row["executed_at"])
            if executed_at < DAY_START_UTC or executed_at >= DAY_END_UTC:
                continue
            total_in_window += 1

            hour_utc = executed_at.replace(
                minute=0, second=0, microsecond=0,
            )
            pair = (hour_utc, ticker)
            if pair in captured:
                total_skipped_captured += 1
                skipped_by_pair[pair] = skipped_by_pair.get(pair, 0) + 1
                continue

            price_str = row["price"]
            size_str = row["size"]
            price = _parse_float(price_str)
            size = _parse_int(size_str)
            if price is None or size is None or price <= 0 or size <= 0:
                total_invalid += 1
                continue

            option_chain = row["option_chain_id"]
            side = row["side"]  # "ask"/"bid"/"mid"/"no_side"

            ws_trade_id = _make_uuid(
                option_chain, executed_at.isoformat(),
                price_str, size_str, side,
            )

            option_type = "C" if row["option_type"] == "call" else "P"
            strike = _parse_decimal(row["strike"]) or Decimal(0)
            expiry_str = row["expiry"]
            expiry = datetime.strptime(expiry_str, "%Y-%m-%d").date()

            batch.append((
                str(ws_trade_id),
                ticker,
                option_chain,
                option_type,
                strike,
                expiry,
                executed_at,
                Decimal(price_str),
                size,
                _parse_decimal(row["underlying_price"]),
                side,
                _parse_decimal(row["implied_volatility"]),
                _parse_decimal(row["delta"]),
                _parse_int(row["open_interest"]),
                row["canceled"] == "t",
                RAW_PAYLOAD_MARKER,
            ))
            total_kept += 1
            ht_key = (hour_utc.hour, ticker)
            kept_by_hour_ticker[ht_key] = (
                kept_by_hour_ticker.get(ht_key, 0) + 1
            )

            if len(batch) >= BATCH_SIZE:
                flush()

    flush()
    cur.close()
    con.close()

    elapsed = time.monotonic() - t0
    print()
    print(f"DONE in {elapsed:.1f}s")
    print(f"  csv rows seen:           {total_seen:,}")
    print(f"  in universe:             {total_in_universe:,}")
    print(f"  in window:               {total_in_window:,}")
    print(f"  skipped (already captured): {total_skipped_captured:,}")
    print(f"  invalid price/size:      {total_invalid:,}")
    print(f"  kept (queued for insert): {total_kept:,}")
    print(f"  inserted (or would insert): {total_inserted:,}")
    print()
    print("kept by hour × ticker (top 30 by row count):")
    top = sorted(
        kept_by_hour_ticker.items(), key=lambda x: -x[1],
    )[:30]
    for (hr, tkr), n in top:
        print(f"  {hr:02d}:00 UTC  {tkr:6s}  {n:>10,}")


if __name__ == "__main__":
    sys.exit(main())
