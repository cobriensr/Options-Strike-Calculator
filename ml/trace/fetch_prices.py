"""
Fetch actual SPX closing prices for dates in predictions.csv.

Usage:
    ml/.venv/bin/python ml/trace/fetch_prices.py

Reads:  ml/trace/results/predictions.csv
Writes: ml/trace/results/actual_prices.csv
Also updates actual_close in trace_predictions DB table.
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
    import yfinance as yf
except ImportError:
    print("Error: yfinance not installed. Run: ml/.venv/bin/pip install yfinance")
    sys.exit(1)

RESULTS_DIR = Path(__file__).parent / "results"


def fetch_spx_closes(dates: list[str]) -> pd.DataFrame:
    """Return a DataFrame of (date, actual_close) for each trading date."""
    date_series = pd.to_datetime(dates)
    start = (date_series.min() - pd.Timedelta(days=5)).strftime("%Y-%m-%d")
    end = (date_series.max() + pd.Timedelta(days=2)).strftime("%Y-%m-%d")

    print(f"Fetching ^SPX history from {start} to {end} ...")
    ticker = yf.Ticker("^SPX")
    hist = ticker.history(start=start, end=end)

    if hist.empty:
        print("Error: yfinance returned no data. Check network connection.")
        sys.exit(1)

    hist.index = hist.index.strftime("%Y-%m-%d")

    rows = []
    for date in dates:
        if date in hist.index:
            close = round(float(hist.loc[date, "Close"]), 2)
            rows.append({"date": date, "actual_close": close})
        else:
            print(f"  ✗ No data for {date} (non-trading day or data gap)")
            rows.append({"date": date, "actual_close": None})

    return pd.DataFrame(rows)


def write_actuals_to_db(prices: pd.DataFrame) -> None:
    """Update actual_close in trace_predictions for any dates with a known price."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Skipping DB write-back: DATABASE_URL not set.")
        return

    try:
        import psycopg2
    except ImportError:
        print("Skipping DB write-back: psycopg2 not installed.")
        return

    valid = prices.dropna(subset=["actual_close"])
    if valid.empty:
        print("No valid prices to write back to DB.")
        return

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            updated = 0
            for _, row in valid.iterrows():
                cur.execute(
                    """
                    UPDATE trace_predictions
                    SET actual_close = %s, updated_at = now()
                    WHERE date = %s
                    """,
                    (float(row["actual_close"]), str(row["date"])),
                )
                updated += cur.rowcount
        conn.commit()
        print(f"Updated {updated} actual_close values in DB.")
    finally:
        conn.close()


def main() -> None:
    predictions_path = RESULTS_DIR / "predictions.csv"
    if not predictions_path.exists():
        print(f"Error: {predictions_path} not found.")
        print("Run sync_from_db.py first.")
        sys.exit(1)

    predictions = pd.read_csv(predictions_path)
    dates = predictions["date"].astype(str).tolist()
    print(f"Fetching actual close prices for {len(dates)} dates ...")

    prices = fetch_spx_closes(dates)

    output_path = RESULTS_DIR / "actual_prices.csv"
    prices.to_csv(output_path, index=False)

    valid = prices["actual_close"].notna().sum()
    print(f"Saved {valid}/{len(prices)} prices → {output_path}")
    if valid < len(prices):
        missing = prices[prices["actual_close"].isna()]["date"].tolist()
        print(f"Missing dates (non-trading days?): {missing}")

    write_actuals_to_db(prices)

    # Print predicted vs actual recap
    merged = predictions.drop(columns=["actual_close"], errors="ignore").merge(
        prices, on="date", how="inner"
    ).dropna(subset=["actual_close"])
    if not merged.empty:
        print(f"\n{'date':<12} {'open':>6} {'pred':>6} {'actual':>8} {'error':>7}  direction")
        print("-" * 58)
        for _, row in merged.iterrows():
            error = row["actual_close"] - row["predicted_close"]
            pred_dir = "▲ BULL" if row["predicted_close"] > row["current_price"] else "▼ BEAR"
            actual_dir = "▲" if row["actual_close"] > row["current_price"] else "▼"
            correct = "✓" if (row["predicted_close"] > row["current_price"]) == (row["actual_close"] > row["current_price"]) else "✗"
            print(
                f"{row['date']:<12} {row['current_price']:>6.0f} {row['predicted_close']:>6.0f}"
                f" {row['actual_close']:>8.2f} {error:>+7.1f}  {pred_dir} → {actual_dir} {correct}"
            )


if __name__ == "__main__":
    main()
