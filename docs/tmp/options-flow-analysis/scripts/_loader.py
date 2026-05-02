"""Shared parquet loader.

Handles the per-file schema drift (May 1 stores ints as int32 and bools as
'f'/'t' strings) so downstream scripts get a clean pandas DataFrame.
"""
from __future__ import annotations

import glob

import pandas as pd
import pyarrow.parquet as pq

DATA_DIR = '/Users/charlesobrien/Desktop/Bot-Eod-parquet'


def _files() -> list[str]:
    return sorted(glob.glob(f'{DATA_DIR}/2026-*-trades.parquet'))


def _coerce_canceled(s: pd.Series) -> pd.Series:
    if s.dtype == bool:
        return s
    return s.astype(str).str.lower().isin(['t', 'true', '1'])


def load(
    columns: list[str],
    tickers: list[str] | None = None,
) -> pd.DataFrame:
    """Per-file read with normalization."""
    parts: list[pd.DataFrame] = []
    filt = (
        [('underlying_symbol', 'in', tickers)] if tickers is not None else None
    )
    for f in _files():
        t = pq.read_table(f, columns=columns, filters=filt)
        df = t.to_pandas()
        if 'canceled' in df.columns:
            df['canceled'] = _coerce_canceled(df['canceled'])
        # Normalize string-ish cols
        for c in [
            'underlying_symbol',
            'side',
            'option_type',
            'sector',
            'exchange',
            'report_flags',
            'equity_type',
            'upstream_condition_detail',
            'option_chain_id',
        ]:
            if c in df.columns:
                df[c] = df[c].astype(str)
        parts.append(df)
    return pd.concat(parts, ignore_index=True)


def add_ct_time(df: pd.DataFrame) -> pd.DataFrame:
    """Add America/Chicago timestamp + helpers (assumes 'executed_at' col)."""
    df = df.copy()
    df['executed_at_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
    df['trade_date'] = df['executed_at_ct'].dt.date
    df['hour_ct'] = df['executed_at_ct'].dt.hour
    df['minute_ct'] = df['executed_at_ct'].dt.floor('1min')
    return df


def filter_rth(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only 08:30–15:00 CT prints (regular session)."""
    t = df['executed_at_ct'].dt.time
    return df.loc[
        (t >= pd.Timestamp('08:30').time())
        & (t <= pd.Timestamp('15:00').time())
    ].copy()


def directional_only(df: pd.DataFrame) -> pd.DataFrame:
    """Drop canceled + restrict to ask/bid (drop mid/no_side)."""
    return df.loc[
        (~df['canceled']) & (df['side'].isin(['ask', 'bid']))
    ].copy()


def is_zero_dte(df: pd.DataFrame) -> pd.Series:
    """Boolean mask: expiry == trade date (CT)."""
    return df['expiry'] == df['executed_at_ct'].dt.date
