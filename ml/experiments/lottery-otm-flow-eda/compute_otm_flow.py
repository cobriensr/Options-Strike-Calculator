"""Compute per-(ticker, minute) OTM net call/put premium from the
per-trade parquet archive.

For each of the 15 daily parquets at /Users/charlesobrien/Desktop/Bot-Eod-parquet/:
  1. OTM filter: call → strike > underlying_price; put → strike < underlying_price
  2. Side classification:
       side=='ask' → buyer-initiated → +premium
       side=='bid' → seller-initiated → -premium
       side in ('mid', 'no_side') → DROP (no directional signal)
  3. Per-(ticker, minute) aggregate:
       otm_ncp = sum of signed call premiums
       otm_npp = sum of signed put premiums
  4. Restrict to lottery universe + 08:30–15:00 CT session window

Run: ml/.venv/bin/python ml/experiments/lottery-otm-flow-eda/compute_otm_flow.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

PARQUET_DIR = Path("/Users/charlesobrien/Desktop/Bot-Eod-parquet")
EXPERIMENT_DIR = Path(__file__).parent
OUT_PARQUET = EXPERIMENT_DIR / "otm_flow.parquet"

# Snapshot of LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS from
# api/_lib/lottery-finder.ts. KEEP IN SYNC.
LOTTERY_TICKERS = {
    "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC",
    "SQQQ", "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM",
    "RKLB", "SOFI", "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER",
    "MSTR", "TQQQ", "RIOT", "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
    "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN", "PLTR", "AVGO",
    "GOOGL", "GOOG", "COIN", "HOOD", "MRVL", "ORCL", "AAPL",
}


def process_day(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(
        path,
        columns=[
            "executed_at",
            "underlying_symbol",
            "option_type",
            "strike",
            "underlying_price",
            "side",
            "premium",
            "canceled",
        ],
    )
    # canceled encoding varies across days
    df = df[~df["canceled"].isin([True, "t", "true", "True"])]
    # Lottery universe only
    df = df[df["underlying_symbol"].isin(LOTTERY_TICKERS)]
    # Need a non-null underlying_price for OTM classification
    df = df[df["underlying_price"].notna() & (df["underlying_price"] > 0)]
    # Directional sides only — mid/no_side carry no buy-vs-sell signal
    df = df[df["side"].isin(["ask", "bid"])]
    if df.empty:
        return df

    # OTM classification per row
    is_call = df["option_type"].str.startswith("c", na=False)
    is_put = df["option_type"].str.startswith("p", na=False)
    otm_call = is_call & (df["strike"] > df["underlying_price"])
    otm_put = is_put & (df["strike"] < df["underlying_price"])
    df = df[otm_call | otm_put].copy()
    if df.empty:
        return df

    # Signed premium: ask=+ (buyer pays), bid=- (seller receives)
    df["signed_premium"] = df["premium"].where(df["side"] == "ask", -df["premium"])

    # Bucket to minute (UTC)
    df["minute"] = df["executed_at"].dt.floor("min")

    # Tag side-of-flow: call premiums into otm_ncp, put into otm_npp
    df["leg"] = df["option_type"].str[0].str.lower().map(
        {"c": "otm_ncp", "p": "otm_npp"}
    )

    pivot = (
        df.groupby(["underlying_symbol", "minute", "leg"], observed=True)["signed_premium"]
        .sum()
        .unstack("leg", fill_value=0.0)
        .reset_index()
        .rename(columns={"underlying_symbol": "ticker", "minute": "ts"})
    )
    for col in ("otm_ncp", "otm_npp"):
        if col not in pivot.columns:
            pivot[col] = 0.0
    return pivot[["ticker", "ts", "otm_ncp", "otm_npp"]]


def filter_session_ct(df: pd.DataFrame) -> pd.DataFrame:
    """Restrict to 08:30–14:59 CT inclusive of 08:30, exclusive of 15:00."""
    ts_ct = df["ts"].dt.tz_convert("America/Chicago")
    minute_of_day = ts_ct.dt.hour * 60 + ts_ct.dt.minute
    keep = (minute_of_day >= 510) & (minute_of_day < 900)
    out = df[keep].copy()
    out["session_date"] = ts_ct[keep].dt.date
    return out


def main() -> int:
    parquets = sorted(PARQUET_DIR.glob("*-trades.parquet"))
    if not parquets:
        print(f"No parquets at {PARQUET_DIR}", file=sys.stderr)
        return 1
    print(f"processing {len(parquets)} parquets...")
    parts: list[pd.DataFrame] = []
    for p in parquets:
        date_str = p.stem.replace("-trades", "")
        day = process_day(p)
        parts.append(day)
        print(
            f"  {date_str}: {len(day):,} (ticker, minute) rows  "
            f"sum_otm_ncp={day['otm_ncp'].sum():+,.0f}  "
            f"sum_otm_npp={day['otm_npp'].sum():+,.0f}"
        )
    combined = pd.concat(parts, ignore_index=True)
    combined = filter_session_ct(combined)
    combined.to_parquet(OUT_PARQUET, index=False)
    print(f"\nwrote {OUT_PARQUET}")
    print(f"  total rows:    {len(combined):,}")
    print(f"  unique tickers:{combined['ticker'].nunique()}")
    print(f"  date range:    {combined['session_date'].min()} → {combined['session_date'].max()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
