"""
Export trace_predictions from DB to predictions.csv for the Python pipeline.

Replaces extract_predictions.py in the nightly pipeline. Predictions are now
entered manually via the TRACE Pin form in the app.

Usage:
    ml/.venv/bin/python ml/trace/sync_from_db.py

Reads DATABASE_URL from ml/.env or environment.
Writes: ml/trace/results/predictions.csv
        Columns include VIX context (COALESCE of training_features and the earliest
        market_snapshots entry per day — covers dates before the ML pipeline ran).
"""

import os
import sys
from pathlib import Path

import pandas as pd

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

RESULTS_DIR = Path(__file__).parent / "results"


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL not set in environment or ml/.env")
        sys.exit(1)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(db_url)
    try:
        df = pd.read_sql(
            """
            SELECT
                tp.date::text                                          AS date,
                tp.predicted_close,
                tp.current_price,
                tp.actual_close,
                tp.confidence,
                tp.notes,
                COALESCE(tf.vix::float,   ms.vix::float,  o.vix_close::float)  AS vix,
                COALESCE(tf.vix1d::float, ms.vix1d::float, o.vix1d_close::float) AS vix1d,
                COALESCE(tf.vix9d::float, ms.vix9d::float)             AS vix9d,
                COALESCE(tf.vvix::float,  ms.vvix::float)              AS vvix
            FROM trace_predictions tp
            LEFT JOIN training_features tf ON tf.date = tp.date
            LEFT JOIN LATERAL (
                SELECT vix, vix1d, vix9d, vvix
                FROM market_snapshots
                WHERE date = tp.date
                ORDER BY (spx_open IS NULL OR spx_open = 'NaN') ASC,
                         entry_time ASC
                LIMIT 1
            ) ms ON true
            LEFT JOIN outcomes o ON o.date = tp.date
            ORDER BY tp.date
            """,
            conn,
        )
    finally:
        conn.close()

    if df.empty:
        print("No predictions in DB — nothing to export.")
        return

    output_path = RESULTS_DIR / "predictions.csv"
    df.to_csv(output_path, index=False)
    print(f"Exported {len(df)} predictions → {output_path}")


if __name__ == "__main__":
    main()
