"""One-shot CSV → parquet converter for bot-eod-report-YYYY-MM-DD.csv.

Mirrors the dtype layout of the existing ~/Desktop/Bot-Eod-parquet/
*-trades.parquet archive so the downstream detector backfills
(backfill_silent_boom_from_parquet.py, backfill_lottery_fires_for_ticker.py)
treat the converted file identically to a normally-ingested day.

Usage:
    ml/.venv/bin/python scripts/convert-bot-eod-csv-to-parquet.py \\
        --csv ~/Downloads/EOD-OptionFlow/bot-eod-report-2026-05-26.csv \\
        --out ~/Desktop/Bot-Eod-parquet/2026-05-26-trades.parquet
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import pandas as pd


COLUMN_DTYPES = {
    'underlying_symbol': 'string',
    'option_chain_id': 'string',
    'side': 'string',
    'strike': 'float64',
    'option_type': 'string',
    'underlying_price': 'float64',
    'nbbo_bid': 'float64',
    'nbbo_ask': 'float64',
    'ewma_nbbo_bid': 'float64',
    'ewma_nbbo_ask': 'float64',
    'price': 'float64',
    'size': 'int32',
    'premium': 'float64',
    'volume': 'int32',
    'open_interest': 'int32',
    'implied_volatility': 'float64',
    'delta': 'float64',
    'theta': 'float64',
    'gamma': 'float64',
    'vega': 'float64',
    'rho': 'float64',
    'theo': 'float64',
    'sector': 'string',
    'exchange': 'string',
    'report_flags': 'string',
    'canceled': 'string',
    'upstream_condition_detail': 'string',
    'equity_type': 'string',
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv', required=True, help='Source CSV path')
    parser.add_argument('--out', required=True, help='Destination parquet path')
    args = parser.parse_args()

    csv_path = Path(args.csv).expanduser()
    out_path = Path(args.out).expanduser()
    if not csv_path.exists():
        raise SystemExit(f'CSV not found: {csv_path}')
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print(f'[convert] reading {csv_path}')
    df = pd.read_csv(csv_path, dtype=COLUMN_DTYPES)
    print(f'[convert]   rows={len(df):,} read in {time.time() - t0:.1f}s')

    # executed_at — source format `2026-05-26 13:30:00.002347+00` carries
    # a UTC offset. Parse, normalize to UTC, then coerce to
    # datetime64[us, UTC] to match the archive's dtype exactly.
    ts = pd.to_datetime(df['executed_at'], utc=True, format='ISO8601')
    df['executed_at'] = ts.astype('datetime64[us, UTC]')

    # expiry — archive stores as object/date (not datetime). Parse then
    # extract python date objects to match the archive dtype.
    df['expiry'] = pd.to_datetime(df['expiry'], format='%Y-%m-%d').dt.date

    # string -> str dtype to match archive (which is plain str).
    for col, dtype in COLUMN_DTYPES.items():
        if dtype == 'string':
            df[col] = df[col].astype('str')

    print(f'[convert] writing {out_path}')
    df.to_parquet(out_path, index=False)
    print(f'[convert] DONE rows={len(df):,} bytes={out_path.stat().st_size:,} '
          f'in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
