"""Phase 0b — pull NQ minute bars from Neon Postgres for the analysis window.

Sidecar writes futures_bars(symbol, ts, open, high, low, close, volume) in
real time. We pull NQ bars for 2026-04-13 -> 2026-05-01, restrict to RTH
(08:30-15:00 CT, weekdays), and write to
ml/data/nq-flow-leadership/nq_1m_bars.parquet.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

OUTPUT_DIR = Path(__file__).resolve().parents[3] / 'ml' / 'data' / 'nq-flow-leadership'
OUTPUT_PATH = OUTPUT_DIR / 'nq_1m_bars.parquet'

START_DATE = '2026-04-13'
END_DATE = '2026-05-02'  # exclusive


def main() -> int:
    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        print('ERROR: DATABASE_URL not set', file=sys.stderr)
        return 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(db_url)
    df = pd.read_sql(
        """
        SELECT ts, open, high, low, close, volume
        FROM futures_bars
        WHERE symbol = 'NQ'
          AND ts >= %s AND ts < %s
        ORDER BY ts
        """,
        conn,
        params=(START_DATE, END_DATE),
    )
    conn.close()

    print(f'Pulled {len(df):,} raw NQ bars from Postgres')
    if df.empty:
        print('ERROR: no NQ bars returned', file=sys.stderr)
        return 1

    # Numeric -> float64 (psycopg returns Decimal for numeric cols)
    for col in ('open', 'high', 'low', 'close'):
        df[col] = df[col].astype('float64')

    # RTH filter: weekdays, 08:30 <= CT time < 15:00.
    ts_ct = df['ts'].dt.tz_convert('America/Chicago')
    rth_mask = (
        (ts_ct.dt.weekday < 5)
        & (ts_ct.dt.hour * 60 + ts_ct.dt.minute >= 8 * 60 + 30)
        & (ts_ct.dt.hour * 60 + ts_ct.dt.minute < 15 * 60)
    )
    df_rth = df[rth_mask].copy().reset_index(drop=True)

    print(f'After RTH filter: {len(df_rth):,} bars across {df_rth["ts"].dt.date.nunique()} days')
    print(f'  first: {df_rth["ts"].min()}')
    print(f'  last:  {df_rth["ts"].max()}')

    df_rth.to_parquet(OUTPUT_PATH, compression='zstd')
    print(f'Wrote {OUTPUT_PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
