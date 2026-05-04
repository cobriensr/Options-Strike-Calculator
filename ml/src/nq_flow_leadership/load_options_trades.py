"""Phase 0a — bulk-filter UW options trades parquet to predictor universe.

Reads the 15 daily files in /Users/charlesobrien/Desktop/Bot-Eod-parquet/,
keeps only {QQQ, SPY, SPX, SPXW, NDX, NDXP}, drops UW report_flags that
distort flow analysis (extended hours, contingent, synthetic prices),
restricts to RTH (08:30-15:00 CT), and writes one parquet per day to
ml/data/nq-flow-leadership/options_filtered_YYYY-MM-DD.parquet.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pyarrow.parquet as pq
import pandas as pd

SOURCE_DIR = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
OUTPUT_DIR = Path(__file__).resolve().parents[3] / 'ml' / 'data' / 'nq-flow-leadership'

PREDICTOR_TICKERS = ['QQQ', 'SPY', 'SPX', 'SPXW', 'NDX', 'NDXP']

# Per memory entries (feedback_darkpool_filters, feedback_extended_hours,
# feedback_contingent_trade_filter): drop these flags from any flow analysis.
DROP_FLAGS = {
    'extended_hours_trade',
    'contingent_trade',
    'average_price_trade',
    'derivative_price_trade',
}

# Columns we need downstream. Excludes ones with no analytic use.
NEEDED_COLS = [
    'executed_at',
    'underlying_symbol',
    'option_chain_id',
    'side',
    'strike',
    'option_type',
    'expiry',
    'underlying_price',
    'nbbo_bid',
    'nbbo_ask',
    'price',
    'size',
    'premium',
    'volume',
    'open_interest',
    'implied_volatility',
    'delta',
    'theta',
    'gamma',
    'vega',
    'report_flags',
]


def has_dropped_flag(flags: str | None) -> bool:
    """report_flags is a Postgres-array literal '{a,b}' or empty '{}' / null.

    Returns True if any DROP_FLAGS member appears in the array.
    """
    if not flags or flags == '{}':
        return False
    inner = flags.strip().lstrip('{').rstrip('}')
    parts = {p.strip() for p in inner.split(',') if p.strip()}
    return bool(parts & DROP_FLAGS)


def load_one_day(path: Path) -> pd.DataFrame:
    """Read + filter one day's parquet down to the predictor universe."""
    tbl = pq.read_table(
        str(path),
        columns=NEEDED_COLS,
        filters=[('underlying_symbol', 'in', PREDICTOR_TICKERS)],
    )
    df = tbl.to_pandas()

    # Filter dropped flags. report_flags can be empty string or null.
    flag_mask = df['report_flags'].fillna('').apply(has_dropped_flag)
    df = df[~flag_mask].copy()

    # RTH filter: 08:30-15:00 CT == 13:30-20:00 UTC (CDT) or 14:30-21:00 UTC (CST).
    # Column is timestamp[us, UTC]. Convert to CT for the filter.
    ts_ct = df['executed_at'].dt.tz_convert('America/Chicago')
    df = df[
        (ts_ct.dt.weekday < 5)
        & (ts_ct.dt.hour * 60 + ts_ct.dt.minute >= 8 * 60 + 30)
        & (ts_ct.dt.hour * 60 + ts_ct.dt.minute < 15 * 60)
    ].copy()

    return df


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--limit', type=int, default=None, help='Process only N files (smoke test)')
    args = p.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(SOURCE_DIR.glob('*-trades.parquet'))
    if args.limit:
        files = files[: args.limit]

    if not files:
        print(f'ERROR: no parquet files found in {SOURCE_DIR}', file=sys.stderr)
        return 1

    total_rows_in = 0
    total_rows_out = 0
    t_start = time.time()

    for path in files:
        date_part = path.stem.replace('-trades', '')
        out_path = OUTPUT_DIR / f'options_filtered_{date_part}.parquet'

        t0 = time.time()
        df = load_one_day(path)
        df.to_parquet(out_path, compression='zstd')
        t1 = time.time()

        # Source row count via metadata (no full read).
        src_rows = pq.read_metadata(str(path)).num_rows
        total_rows_in += src_rows
        total_rows_out += len(df)

        ticker_breakdown = ' '.join(
            f'{t}={int((df["underlying_symbol"] == t).sum()):,}'
            for t in PREDICTOR_TICKERS
        )
        print(
            f'{date_part}: src={src_rows:>10,} -> kept={len(df):>8,} '
            f'({t1 - t0:.1f}s) [{ticker_breakdown}]'
        )

    print(
        f'\nTotal: {total_rows_in:,} src -> {total_rows_out:,} kept '
        f'({100 * total_rows_out / max(total_rows_in, 1):.2f}%) in {time.time() - t_start:.1f}s'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
