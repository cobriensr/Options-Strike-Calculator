"""Enrich lottery_finder_fires with realized exit policy outcomes.

Reads ws_option_trades from local Parquet archive, computes the four
exit policies plus peak metrics for each unenriched fire, and updates
the lottery_finder_fires table in Neon.

Usage:
    ml/.venv/bin/python ml/src/enrich_lottery_outcomes.py

Environment:
    DATABASE_URL - Neon Postgres connection string
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

import duckdb
import psycopg2
from psycopg2.extras import RealDictCursor

# Add ml/src to path for imports
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "ml" / "src"))

from lottery_exit_policies import (
    minutes_to_peak,
    peak_ceiling,
    realized_hard_stop_30m,
    realized_tier50_hold_eod,
    realized_trail_act30_trail10,
)


def get_archive_path() -> Path:
    """Return path to ws_option_trades Parquet archive."""
    # Check common locations
    candidates = [
        Path.home() / "Desktop" / "Bot-Eod-parquet",
        Path.home() / ".flow-archive-cache",
        Path("/data/archive"),
        REPO_ROOT / "data" / "archive",
    ]

    for path in candidates:
        if path.exists():
            # Look for parquet files (either ws_option_trades or date-trades pattern)
            import glob

            patterns = [
                str(path / "**" / "ws_option_trades" / "**" / "*.parquet"),
                str(path / "*-trades.parquet"),
                str(path / "*.parquet"),
            ]
            for pattern in patterns:
                if glob.glob(pattern, recursive=True):
                    return path

    raise FileNotFoundError(
        "Could not locate ws_option_trades Parquet archive. "
        f"Checked: {', '.join(str(p) for p in candidates)}"
    )


def load_unenriched_fires(conn, limit: int | None = 1000) -> list[dict]:
    """Load fires that need enrichment from Neon."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        # First get the total count
        cur.execute("""
            SELECT COUNT(*) as total
            FROM lottery_finder_fires
            WHERE enriched_at IS NULL
        """)
        total = cur.fetchone()["total"]

        # Then fetch the batch
        limit_clause = f"LIMIT {limit}" if limit else ""
        cur.execute(f"""
            SELECT
                id,
                option_chain_id,
                entry_time_ct,
                entry_price,
                expiry
            FROM lottery_finder_fires
            WHERE enriched_at IS NULL
            ORDER BY inserted_at ASC
            {limit_clause}
        """)
        fires = cur.fetchall()

        print(f"Total unenriched: {total}, fetching: {len(fires)}")
        return fires


def load_option_trades(
    archive_path: Path,
    option_chain_id: str,
    entry_time_ct: datetime,
) -> list[dict]:
    """Load post-entry trades for an option from Parquet archive."""
    conn = duckdb.connect(":memory:")

    # Set timezone to UTC to match Parquet data
    conn.execute("SET TimeZone='UTC'")

    # Query the Parquet archive - handles both naming patterns
    query = f"""
        SELECT
            executed_at,
            price
        FROM read_parquet('{archive_path}/*.parquet', union_by_name=true)
        WHERE option_chain_id = ?
          AND executed_at >= ?
          AND canceled = FALSE
          AND price > 0
        ORDER BY executed_at ASC
    """

    result = conn.execute(query, [option_chain_id, entry_time_ct]).fetchall()
    conn.close()

    return [{"executed_at": row[0], "price": row[1]} for row in result]


def enrich_fire(conn, fire: dict, archive_path: Path) -> bool:
    """Enrich a single fire with realized outcomes. Returns True if enriched."""
    ticks = load_option_trades(
        archive_path,
        fire["option_chain_id"],
        fire["entry_time_ct"],
    )

    if not ticks:
        return False

    prices = [t["price"] for t in ticks]
    entry_price = float(fire["entry_price"])  # Convert Decimal to float

    # Compute minutes since entry for each tick
    minutes_since_entry = [
        (t["executed_at"] - fire["entry_time_ct"]).total_seconds() / 60 for t in ticks
    ]

    # Compute exit policies
    trail30_10 = realized_trail_act30_trail10(prices, entry_price)
    hard30m = realized_hard_stop_30m(prices, entry_price, minutes_since_entry)
    tier50 = realized_tier50_hold_eod(prices, entry_price)
    eod = ((prices[-1] - entry_price) / entry_price) * 100
    peak = peak_ceiling(prices, entry_price)
    min_to_peak = minutes_to_peak(prices, minutes_since_entry)

    # Update the fire
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE lottery_finder_fires
            SET
                realized_trail30_10_pct = %s,
                realized_hard30m_pct = %s,
                realized_tier50_holdeod_pct = %s,
                realized_eod_pct = %s,
                peak_ceiling_pct = %s,
                minutes_to_peak = %s,
                enriched_at = NOW()
            WHERE id = %s
        """,
            [trail30_10, hard30m, tier50, eod, peak, min_to_peak, fire["id"]],
        )

    conn.commit()
    return True


def main():
    """Main enrichment loop."""
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL environment variable not set")

    # Allow overriding batch size via env var (None = process all)
    batch_size = os.getenv("BATCH_SIZE")
    limit = int(batch_size) if batch_size else 1000

    archive_path = get_archive_path()
    print(f"Using archive at: {archive_path}")

    conn = psycopg2.connect(database_url)

    try:
        fires = load_unenriched_fires(conn, limit)

        if not fires:
            print("No fires to enrich")
            return

        enriched = 0
        skipped = 0

        for i, fire in enumerate(fires, 1):
            print(f"[{i}/{len(fires)}] Processing fire {fire['id']}...", end=" ")

            if enrich_fire(conn, fire, archive_path):
                enriched += 1
                print("✓ enriched")
            else:
                skipped += 1
                print("⊘ skipped (no post-entry ticks)")

        print(f"\nDone: {enriched} enriched, {skipped} skipped")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
