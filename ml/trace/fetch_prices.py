"""
Fetch actual SPX closing prices for dates in predictions.csv.

Usage:
    ml/.venv/bin/python ml/trace/fetch_prices.py

Reads:  ml/trace/results/predictions.csv
Writes: ml/trace/results/actual_prices.csv
"""

import sys
from pathlib import Path

import pandas as pd

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


def main() -> None:
    predictions_path = RESULTS_DIR / "predictions.csv"
    if not predictions_path.exists():
        print(f"Error: {predictions_path} not found.")
        print("Run extract_predictions.py first.")
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

    # Print predicted vs actual recap
    merged = predictions.merge(prices, on="date", how="inner").dropna(
        subset=["actual_close"]
    )
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
