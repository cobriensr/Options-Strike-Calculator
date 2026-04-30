#!/usr/bin/env python3
"""
Backfill whale_anomalies from the EOD parquet archive.

Reads scripts/eod-flow-analysis/output/by-day/*-chains.parquet, mirrors
the checklist logic from api/_lib/whale-detector.ts, detects sequential
vs simultaneous same-strike pairs, and upserts into Neon Postgres
(whale_anomalies table) with source='eod_backfill'.

Usage:
    DATABASE_URL="postgres://..." \\
      ml/.venv/bin/python scripts/backfill-whale-anomalies.py [--dry-run]

Idempotent — uses UNIQUE (option_chain, first_ts) + ON CONFLICT DO NOTHING.

Pre-flight:
    1. Migration #99 must have been applied (whale_anomalies table exists).
       Run POST /api/journal/init or wait for the next deploy that calls
       migrateDb() automatically.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import polars as pl
    import psycopg2
    from psycopg2.extras import execute_batch
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Run with ml/.venv/bin/python", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
PARQUET_DIR = REPO_ROOT / "scripts" / "eod-flow-analysis" / "output" / "by-day"

# Checklist thresholds — MUST match api/_lib/whale-detector.ts
WHALE_TICKERS = {"SPX", "SPXW", "NDX", "NDXP", "QQQ", "SPY", "IWM"}

WHALE_THRESHOLDS = {
    "SPX": 80_772_337,
    "SPXW": 6_844_350,
    "NDX": 26_039_632,
    "NDXP": 2_615_032,
    "QQQ": 5_661_186,
    "SPY": 6_272_830,
    "IWM": 9_328_335,
}

MIN_TRADE_COUNT = 5
MAX_DTE = 14
MAX_MONEYNESS = 0.05
MIN_ONE_SIDED = 0.85
PAIRING_OVERLAP_SEC = 60


def classify_type(side: str, option_type: str, moneyness: float | None) -> int | None:
    """Mirror of classifyType() in whale-detector.ts."""
    if side == "BID" and option_type == "put":
        if moneyness is None or moneyness >= -0.03:
            return 1
        return None
    if side == "BID" and option_type == "call":
        if moneyness is None or moneyness <= 0.03:
            return 2
        return None
    if side == "ASK" and option_type == "put":
        if moneyness is None or moneyness <= 0.03:
            return 3
        return None
    # ASK call
    if moneyness is None or moneyness >= -0.03:
        return 4
    return None


def direction_for_type(t: int) -> str:
    return "bullish" if t in (1, 4) else "bearish"


def classify_whale(row: dict) -> dict | None:
    """Returns classification dict or None."""
    if row["ticker"] not in WHALE_TICKERS:
        return None
    threshold = WHALE_THRESHOLDS[row["ticker"]]
    if row["total_premium"] < threshold:
        return None
    if row["trade_count"] < MIN_TRADE_COUNT:
        return None
    if row["dte"] > MAX_DTE:
        return None

    moneyness = None
    spot = row.get("first_underlying")
    if spot is not None and spot > 0:
        moneyness = row["strike"] / spot - 1
        if abs(moneyness) > MAX_MONEYNESS:
            return None

    ask_size = row.get("ask_size") or 0
    bid_size = row.get("bid_size") or 0
    sided_total = ask_size + bid_size
    if sided_total <= 0:
        return None
    ask_pct = ask_size / sided_total

    if ask_pct >= MIN_ONE_SIDED:
        side = "ASK"
    elif ask_pct <= 1 - MIN_ONE_SIDED:
        side = "BID"
    else:
        return None

    type_ = classify_type(side, row["option_type"], moneyness)
    if type_ is None:
        return None

    return {
        "side": side,
        "ask_pct": ask_pct,
        "moneyness": moneyness,
        "whale_type": type_,
        "direction": direction_for_type(type_),
    }


def detect_pairing(candidate: dict, peers: list[dict]) -> str:
    """Mirror of detectPairing() in whale-detector.ts.

    Returns 'alone' | 'sequential' | 'simultaneous_filtered'.
    """
    opposite = "put" if candidate["option_type"] == "call" else "call"
    matching = [p for p in peers if p["option_type"] == opposite]
    if not matching:
        return "alone"

    cand_first = candidate["first_ts"]
    cand_last = candidate["last_ts"]
    for p in matching:
        overlap_sec = (
            min(cand_last, p["last_ts"]) - max(cand_first, p["first_ts"])
        ).total_seconds()
        if overlap_sec > PAIRING_OVERLAP_SEC:
            return "simultaneous_filtered"
    return "sequential"


def load_archive() -> pl.DataFrame:
    files = sorted(PARQUET_DIR.glob("*-chains.parquet"))
    if not files:
        raise FileNotFoundError(f"No parquet files in {PARQUET_DIR}")
    df = pl.concat([pl.read_parquet(f) for f in files])
    df = df.with_columns(
        ((pl.col("expiry").cast(pl.Datetime).dt.replace_time_zone("UTC") - pl.col("first_ts"))
            .dt.total_days()).alias("dte"),
    )
    return df


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute classifications but do not insert into DB")
    args = parser.parse_args(argv)

    db_url = os.environ.get("DATABASE_URL")
    if not args.dry_run and not db_url:
        print("ERROR: DATABASE_URL not set. Source .env.local first.", file=sys.stderr)
        return 2

    print(f"→ Loading parquet archive from {PARQUET_DIR}")
    df = load_archive()
    print(f"  loaded {df.height:,} chains, {df['ticker'].n_unique()} tickers")

    # Build same-strike-same-expiry-same-day index for pairing detection.
    print("→ Building pairing index")
    pairing_index: dict[tuple, list[dict]] = {}
    for r in df.filter(pl.col("ticker").is_in(list(WHALE_TICKERS))).iter_rows(named=True):
        key = (r["trade_date"], r["ticker"], r["strike"], r["expiry"])
        pairing_index.setdefault(key, []).append({
            "option_type": r["option_type"],
            "first_ts": r["first_ts"],
            "last_ts": r["last_ts"],
        })

    print("→ Classifying and pairing")
    rows_to_insert = []
    sim_filtered = 0
    for r in df.iter_rows(named=True):
        cls = classify_whale(r)
        if cls is None:
            continue
        peers = pairing_index.get(
            (r["trade_date"], r["ticker"], r["strike"], r["expiry"]), []
        )
        # Exclude self from peers.
        peers_without_self = [
            p for p in peers
            if not (p["option_type"] == r["option_type"] and p["first_ts"] == r["first_ts"])
        ]
        pair = detect_pairing(
            {
                "option_type": r["option_type"],
                "first_ts": r["first_ts"],
                "last_ts": r["last_ts"],
            },
            peers_without_self,
        )
        if pair == "simultaneous_filtered":
            sim_filtered += 1
            continue

        rows_to_insert.append({
            "ticker": r["ticker"],
            "option_chain": r["option_chain_id"],
            "strike": float(r["strike"]),
            "option_type": r["option_type"],
            "expiry": r["expiry"],
            "first_ts": r["first_ts"],
            "last_ts": r["last_ts"],
            "side": cls["side"],
            "ask_pct": float(cls["ask_pct"]),
            "total_premium": float(r["total_premium"]),
            "trade_count": int(r["trade_count"]),
            "vol_oi_ratio": (
                float(r["day_volume"] / r["day_oi"]) if r["day_oi"] else None
            ),
            "underlying_price": (
                float(r["first_underlying"]) if r["first_underlying"] is not None else None
            ),
            "moneyness": (
                float(cls["moneyness"]) if cls["moneyness"] is not None else None
            ),
            "dte": int(r["dte"]),
            "whale_type": cls["whale_type"],
            "direction": cls["direction"],
            "pairing_status": pair,  # 'alone' | 'sequential'
        })

    print(f"  Classified: {len(rows_to_insert)} actionable whales")
    print(f"  Filtered as simultaneous synthetics: {sim_filtered}")

    if not rows_to_insert:
        print("Nothing to insert. Exiting.")
        return 0

    # Print per-ticker summary
    by_ticker: dict[str, int] = {}
    for r in rows_to_insert:
        by_ticker[r["ticker"]] = by_ticker.get(r["ticker"], 0) + 1
    print("  Per-ticker breakdown:")
    for t, n in sorted(by_ticker.items(), key=lambda kv: -kv[1]):
        print(f"    {t:6}: {n}")

    if args.dry_run:
        print("\n[dry-run] Skipping DB insert.")
        return 0

    print(f"\n→ Inserting {len(rows_to_insert)} rows into whale_anomalies")
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            insert_sql = """
                INSERT INTO whale_anomalies (
                    source, ticker, option_chain, strike, option_type, expiry,
                    first_ts, last_ts, side, ask_pct, total_premium, trade_count,
                    vol_oi_ratio, underlying_price, moneyness, dte,
                    whale_type, direction, pairing_status
                ) VALUES (
                    'eod_backfill', %(ticker)s, %(option_chain)s, %(strike)s,
                    %(option_type)s, %(expiry)s, %(first_ts)s, %(last_ts)s,
                    %(side)s, %(ask_pct)s, %(total_premium)s, %(trade_count)s,
                    %(vol_oi_ratio)s, %(underlying_price)s, %(moneyness)s, %(dte)s,
                    %(whale_type)s, %(direction)s, %(pairing_status)s
                )
                ON CONFLICT (option_chain, first_ts) DO NOTHING
            """
            execute_batch(cur, insert_sql, rows_to_insert, page_size=100)
        conn.commit()
        # Verify
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM whale_anomalies WHERE source = 'eod_backfill'"
            )
            row = cur.fetchone()
            count = row[0] if row else 0
        print(f"✅ Backfill complete. whale_anomalies (eod_backfill): {count} rows total")
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
