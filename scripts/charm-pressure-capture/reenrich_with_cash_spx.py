"""
Re-enrich candidate-days.csv with cash SPX OHLC (^GSPC via yfinance),
replacing the ES-futures prices that the original enricher pulled from
day_embeddings. The ES vs SPX basis (~$50–60) systematically biased every
spx_close, pin_distance, and pin_realized label in the original CSV.

This:
  - Backs up the existing CSV to candidate-days.csv.bak
  - Pulls cash ^GSPC daily OHLC over the full date range
  - Overwrites spx_open / spx_high / spx_low / spx_close / spx_prev_close
  - Recomputes realized_range_dollars and realized_range_pct
  - Writes back in place
  - Mirrors to delta-pressure-capture/candidate-days.csv and
    gamma-capture/candidate-days.csv so all three charts stay in sync

Run with:
    ml/.venv/bin/python scripts/charm-pressure-capture/reenrich_with_cash_spx.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
CHARTS = [
    ROOT / "scripts/charm-pressure-capture/candidate-days.csv",
    ROOT / "scripts/delta-pressure-capture/candidate-days.csv",
    ROOT / "scripts/gamma-capture/candidate-days.csv",
]


def fetch_cash_spx(start: str, end: str) -> pd.DataFrame:
    """yfinance auto_adjust=False keeps raw OHLC. Index is tz-aware NY date."""
    df = yf.Ticker("^GSPC").history(start=start, end=end, auto_adjust=False)
    df = df[["Open", "High", "Low", "Close"]].round(2)
    # Drop tz, keep date as ISO string for clean join.
    df.index = pd.to_datetime(df.index).tz_localize(None).strftime("%Y-%m-%d")
    df.index.name = "date"
    return df


def reenrich(csv_path: Path) -> dict[str, int]:
    df = pd.read_csv(csv_path, dtype=str)
    dates = df["date"].dropna().unique()
    start = pd.to_datetime(dates).min().strftime("%Y-%m-%d")
    # yfinance end is exclusive; pad by 5 days to make sure last date is in.
    end = (pd.to_datetime(dates).max() + pd.Timedelta(days=5)).strftime("%Y-%m-%d")
    cash = fetch_cash_spx(start, end)

    # Row-by-row update — only touch rows where we have a matching cash bar.
    matched = 0
    missing = []
    for idx, row in df.iterrows():
        d = row.get("date", "")
        if d in cash.index:
            bar = cash.loc[d]
            df.at[idx, "spx_open"] = f"{bar['Open']:.2f}"
            df.at[idx, "spx_high"] = f"{bar['High']:.2f}"
            df.at[idx, "spx_low"] = f"{bar['Low']:.2f}"
            df.at[idx, "spx_close"] = f"{bar['Close']:.2f}"
            matched += 1
        else:
            missing.append(d)

    # Compute prev_close as a chronologically-ordered LAG over cash closes.
    cash_closes = cash["Close"].to_dict()
    sorted_cash_dates = sorted(cash_closes.keys())
    prev_lookup: dict[str, float] = {}
    for i, d in enumerate(sorted_cash_dates):
        if i > 0:
            prev_lookup[d] = cash_closes[sorted_cash_dates[i - 1]]

    for idx, row in df.iterrows():
        d = row.get("date", "")
        if d in prev_lookup:
            df.at[idx, "spx_prev_close"] = f"{prev_lookup[d]:.2f}"

    # Recompute range columns using the new prices.
    def to_float(s: str) -> float:
        try:
            return float(s)
        except (TypeError, ValueError):
            return float("nan")

    for idx, row in df.iterrows():
        h = to_float(row.get("spx_high", ""))
        l = to_float(row.get("spx_low", ""))
        pc = to_float(row.get("spx_prev_close", ""))
        if pd.notna(h) and pd.notna(l):
            df.at[idx, "realized_range_dollars"] = f"{h - l:.2f}"
            if pd.notna(pc) and pc > 0:
                df.at[idx, "realized_range_pct"] = f"{(h - l) / pc * 100:.3f}"

    df.to_csv(csv_path, index=False)
    return {"matched": matched, "missing": len(missing), "total": len(df)}


def main() -> None:
    for csv_path in CHARTS:
        if not csv_path.exists():
            print(f"[skip] {csv_path} (not found)")
            continue
        bak = csv_path.with_suffix(".csv.bak")
        if not bak.exists():
            shutil.copy(csv_path, bak)
            print(f"[backup] {csv_path} -> {bak}")
        else:
            print(f"[backup-exists] {bak} (preserved, not overwritten)")

        stats = reenrich(csv_path)
        print(
            f"[done] {csv_path.parent.name}: "
            f"matched={stats['matched']}/{stats['total']}, missing={stats['missing']}"
        )


if __name__ == "__main__":
    main()
