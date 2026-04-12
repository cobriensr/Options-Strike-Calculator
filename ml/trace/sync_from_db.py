"""
Export trace_predictions from DB to predictions.csv for the Python pipeline.

Replaces extract_predictions.py in the nightly pipeline. Predictions are now
entered manually via the TRACE Pin form in the app.

Usage:
    ml/.venv/bin/python ml/trace/sync_from_db.py

Reads DATABASE_URL from ml/.env or environment.
Writes: ml/trace/results/predictions.csv
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
                date::text        AS date,
                predicted_close,
                current_price,
                actual_close,
                confidence,
                notes
            FROM trace_predictions
            ORDER BY date
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
