"""
Backfill VIX data into training_features for dates where it is missing.

Identifies dates present in trace_predictions but lacking VIX in
training_features, then fetches daily OHLC from Yahoo Finance
(^VIX, ^VIX1D, ^VIX9D, ^VVIX) and upserts the opening price.

The ON CONFLICT clause uses COALESCE, so existing non-NULL values
are never overwritten — safe to re-run at any time.

Usage:
    ml/.venv/bin/python ml/trace/backfill_vix.py
"""

import os
import sys
from datetime import date, timedelta
from pathlib import Path

_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    with _env_path.open() as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                os.environ.setdefault(_key.strip(), _val.strip().strip('"').strip("'"))

try:
    import psycopg2
except ImportError:
    print("Error: psycopg2 not installed. Run: ml/.venv/bin/pip install psycopg2-binary")
    sys.exit(1)

try:
    import yfinance as yf
except ImportError:
    print("Error: yfinance not installed. Run: ml/.venv/bin/pip install yfinance")
    sys.exit(1)


def find_missing_dates(conn) -> list[str]:
    """Return trace_predictions dates that have no VIX in training_features."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT tp.date::text
            FROM trace_predictions tp
            LEFT JOIN training_features tf ON tf.date = tp.date
            WHERE tf.vix IS NULL
            ORDER BY tp.date
        """)
        return [row[0] for row in cur.fetchall()]


def fetch_vix_history(start: str, end: str) -> dict[str, dict[str, float | None]]:
    """
    Download daily opening prices from Yahoo Finance for the VIX family.
    Returns { date_str: { "vix": float|None, "vix1d": ..., "vix9d": ..., "vvix": ... } }
    """
    tickers = {
        "vix":   "^VIX",
        "vix1d": "^VIX1D",
        "vix9d": "^VIX9D",
        "vvix":  "^VVIX",
    }

    # Fetch each ticker individually so a missing/limited series doesn't
    # abort the whole download.
    series: dict[str, dict] = {}  # key -> { date_str: float }
    for field, symbol in tickers.items():
        try:
            hist = yf.Ticker(symbol).history(start=start, end=end, auto_adjust=True)
            if hist.empty:
                print(f"  {symbol}: no data returned")
                series[field] = {}
                continue
            # Normalise index to plain date strings (YYYY-MM-DD)
            hist.index = hist.index.tz_localize(None).normalize()
            series[field] = {
                str(dt.date()): float(row["Open"])
                for dt, row in hist.iterrows()
            }
            print(f"  {symbol}: {len(series[field])} days fetched")
        except Exception as exc:
            print(f"  {symbol}: fetch failed ({exc})")
            series[field] = {}

    # Merge into per-date dicts
    all_dates = set()
    for s in series.values():
        all_dates.update(s.keys())

    result: dict[str, dict[str, float | None]] = {}
    for d in all_dates:
        result[d] = {
            "vix":   series["vix"].get(d),
            "vix1d": series["vix1d"].get(d),
            "vix9d": series["vix9d"].get(d),
            "vvix":  series["vvix"].get(d),
        }
    return result


def upsert_vix(conn, date_str: str, vix: float | None, vix1d: float | None,
               vix9d: float | None, vvix: float | None) -> None:
    """
    Insert a training_features row for date_str with only VIX columns set.
    Uses COALESCE so existing non-NULL values are preserved.
    """
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO training_features (date, vix, vix1d, vix9d, vvix)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (date) DO UPDATE SET
                vix   = COALESCE(EXCLUDED.vix,   training_features.vix),
                vix1d = COALESCE(EXCLUDED.vix1d, training_features.vix1d),
                vix9d = COALESCE(EXCLUDED.vix9d, training_features.vix9d),
                vvix  = COALESCE(EXCLUDED.vvix,  training_features.vvix)
        """, (date_str, vix, vix1d, vix9d, vvix))
    conn.commit()


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL not set in environment or ml/.env")
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    try:
        missing = find_missing_dates(conn)
        if not missing:
            print("No missing VIX dates — nothing to backfill.")
            return

        print(f"Found {len(missing)} date(s) missing VIX: {missing[0]} … {missing[-1]}")

        # Fetch a window that covers all missing dates (plus 1-day buffer each side)
        start = str(date.fromisoformat(missing[0]) - timedelta(days=1))
        end   = str(date.fromisoformat(missing[-1]) + timedelta(days=2))
        print(f"\nFetching Yahoo Finance data ({start} → {end}):")
        history = fetch_vix_history(start, end)

        filled = 0
        skipped = 0
        for d in missing:
            row = history.get(d)
            if row is None or all(v is None for v in row.values()):
                print(f"  {d}: no Yahoo data — skipping")
                skipped += 1
                continue
            upsert_vix(conn, d, row["vix"], row["vix1d"], row["vix9d"], row["vvix"])
            vix_str = f"{row['vix']:.2f}" if row["vix"] else "—"
            print(f"  {d}: VIX={vix_str}")
            filled += 1

        print(f"\nDone — filled {filled} date(s), skipped {skipped}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
