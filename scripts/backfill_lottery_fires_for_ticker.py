#!/usr/bin/env python
"""Backfill lottery_finder_fires for a ticker the WS daemon doesn't see.

Runs the parity-tested Python detector port (lottery_detector_py.py)
against the local EOD parquets, enriches fires with macro snapshots
where available, and INSERTs with ON CONFLICT (option_chain_id,
trigger_time_ct) DO NOTHING for idempotency.

Designed for SPXW (where ws_option_trades has zero rows because the
WS daemon isn't subscribed). Reusable for any future ticker.

Usage:
    ml/.venv/bin/python scripts/backfill_lottery_fires_for_ticker.py \
        --ticker SPXW [--from-date 2026-04-13] [--to-date 2026-05-06]

Read+write: reads parquets + flow_data + spot_exposures +
strike_exposures; INSERTs into lottery_finder_fires.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

sys.path.insert(0, str(ROOT / 'scripts'))
from lottery_detector_py import (  # noqa: E402
    OptionTradeTick,
    EnrichMeta,
    detect_chain_fires,
    enrich_fires,
)

TICKERS_WITH_GEX_STRIKE = {'SPX', 'SPXW', 'NDX', 'NDXP', 'SPY', 'QQQ'}


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def list_parquet_dates(from_date: str | None, to_date: str | None) -> list[str]:
    out: list[str] = []
    for p in sorted(PARQUET_DIR.glob('*-trades.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', p.name)
        if not m:
            continue
        d = m.group(1)
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        out.append(d)
    return out


def load_chain_groups(
    parquet_path: Path, ticker: str
) -> dict[str, dict]:
    """Returns {option_chain_id: {ticks: [OptionTradeTick], oi: int,
    expiry: str, strike: float, option_type: 'C'/'P'}}."""
    df = pd.read_parquet(
        parquet_path,
        columns=[
            'executed_at', 'underlying_symbol', 'option_chain_id',
            'option_type', 'strike', 'expiry', 'price', 'size',
            'underlying_price', 'side', 'implied_volatility', 'delta',
            'open_interest', 'canceled',
        ],
        filters=[('underlying_symbol', '=', ticker)],
    )
    if df.empty:
        return {}
    # canceled handling (bool in older parquets, string in newer).
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')

    out: dict[str, dict] = {}
    for chain_id, sub in df.groupby('option_chain_id', sort=False):
        ticks: list[OptionTradeTick] = []
        oi_max = 0
        for r in sub.itertuples(index=False):
            ts = r.executed_at
            if hasattr(ts, 'to_pydatetime'):
                ts = ts.to_pydatetime()
            # Expiry stored as string YYYY-MM-DD or as date object.
            exp_raw = r.expiry
            if hasattr(exp_raw, 'isoformat'):
                exp_str = exp_raw.isoformat()[:10]
            else:
                exp_str = str(exp_raw)[:10]
            expiry_dt = datetime.fromisoformat(f'{exp_str}T00:00:00+00:00')
            opt_type = r.option_type
            # Parquet may store as 'call'/'put' or 'C'/'P' — normalize.
            if opt_type in ('call', 'C'):
                opt_type_norm = 'C'
            elif opt_type in ('put', 'P'):
                opt_type_norm = 'P'
            else:
                continue
            tick = OptionTradeTick(
                executed_at=ts,
                option_chain=r.option_chain_id,
                option_type=opt_type_norm,
                strike=float(r.strike),
                expiry=expiry_dt,
                price=float(r.price),
                size=int(r.size),
                underlying_price=(
                    float(r.underlying_price) if r.underlying_price is not None
                    and not (isinstance(r.underlying_price, float)
                             and np.isnan(r.underlying_price))
                    else None
                ),
                side=r.side if r.side in ('ask', 'bid', 'mid', 'no_side') else 'no_side',
                implied_volatility=(
                    float(r.implied_volatility)
                    if r.implied_volatility is not None and not (
                        isinstance(r.implied_volatility, float)
                        and np.isnan(r.implied_volatility))
                    else None
                ),
                delta=(
                    float(r.delta) if r.delta is not None and not (
                        isinstance(r.delta, float) and np.isnan(r.delta))
                    else None
                ),
                open_interest=(
                    int(r.open_interest) if r.open_interest is not None
                    and not (isinstance(r.open_interest, float)
                             and np.isnan(r.open_interest))
                    else None
                ),
            )
            ticks.append(tick)
            if tick.open_interest is not None and tick.open_interest > oi_max:
                oi_max = tick.open_interest
        if not ticks:
            continue
        out[chain_id] = {
            'ticks': ticks,
            'oi': oi_max,
            'expiry': ticks[0].expiry.date().isoformat(),
            'strike': ticks[0].strike,
            'option_type': ticks[0].option_type,
        }
    return out


def fetch_macro(
    conn, ticker: str, strike: float, asof_utc: datetime
) -> dict:
    """Best-effort macro snapshot — same logic as the cron + replay
    script. NULLs on miss."""
    cur = conn.cursor()
    iso = asof_utc.isoformat()
    cur.execute(
        """
        SELECT source, ncp, npp
        FROM flow_data
        WHERE timestamp <= %s::timestamptz
          AND timestamp >= %s::timestamptz - INTERVAL '30 minutes'
          AND source IN ('market_tide','market_tide_otm','spx_flow',
                         'spy_etf_tide','qqq_etf_tide','zero_dte_greek_flow')
        ORDER BY timestamp DESC
        LIMIT 200
        """,
        (iso, iso),
    )
    flow_rows = cur.fetchall()

    cur.execute(
        """
        SELECT gamma_oi, gamma_vol, charm_oi, vanna_oi
        FROM spot_exposures
        WHERE ticker = 'SPX'
          AND timestamp <= %s::timestamptz
          AND timestamp >= %s::timestamptz - INTERVAL '30 minutes'
        ORDER BY timestamp DESC LIMIT 1
        """,
        (iso, iso),
    )
    spot_row = cur.fetchone()

    strike_row = None
    if ticker in TICKERS_WITH_GEX_STRIKE:
        cur.execute(
            """
            SELECT strike,
                   (call_gamma_oi - put_gamma_oi),
                   (call_gamma_ask - call_gamma_bid),
                   (put_gamma_ask  - put_gamma_bid)
            FROM strike_exposures
            WHERE ticker = %s
              AND timestamp <= %s::timestamptz
              AND timestamp >= %s::timestamptz - INTERVAL '30 minutes'
              AND ABS(strike - %s::numeric) / NULLIF(%s::numeric, 0) <= 0.01
            ORDER BY timestamp DESC, ABS(strike - %s::numeric) ASC
            LIMIT 1
            """,
            (ticker, iso, iso, strike, strike, strike),
        )
        strike_row = cur.fetchone()

    latest_by_source: dict[str, dict] = {}
    for src, ncp, npp in flow_rows:
        if src in latest_by_source:
            continue
        latest_by_source[src] = {
            'ncp': float(ncp) if ncp is not None else 0,
            'npp': float(npp) if npp is not None else 0,
        }

    tide = latest_by_source.get('market_tide')
    otm = latest_by_source.get('market_tide_otm')
    spx_f = latest_by_source.get('spx_flow')
    spy_e = latest_by_source.get('spy_etf_tide')
    qqq_e = latest_by_source.get('qqq_etf_tide')
    zd = latest_by_source.get('zero_dte_greek_flow')

    return {
        'mkt_tide_ncp': tide['ncp'] if tide else None,
        'mkt_tide_npp': tide['npp'] if tide else None,
        'mkt_tide_diff': (tide['ncp'] - tide['npp']) if tide else None,
        # For source='market_tide_otm', OTM data lives in the regular
        # ncp/npp columns — otm_ncp/otm_npp are vestigial NULLs for that
        # source. Mirrors api/cron/detect-lottery-fires.ts.
        'mkt_tide_otm_diff': (otm['ncp'] - otm['npp']) if otm else None,
        'spx_flow_diff': (spx_f['ncp'] - spx_f['npp']) if spx_f else None,
        'spy_etf_diff': (spy_e['ncp'] - spy_e['npp']) if spy_e else None,
        'qqq_etf_diff': (qqq_e['ncp'] - qqq_e['npp']) if qqq_e else None,
        'zero_dte_diff': (zd['ncp'] - zd['npp']) if zd else None,
        'spx_spot_gamma_oi': float(spot_row[0]) if spot_row and spot_row[0] is not None else None,
        'spx_spot_gamma_vol': float(spot_row[1]) if spot_row and spot_row[1] is not None else None,
        'spx_spot_charm_oi': float(spot_row[2]) if spot_row and spot_row[2] is not None else None,
        'spx_spot_vanna_oi': float(spot_row[3]) if spot_row and spot_row[3] is not None else None,
        'gex_strike_call_minus_put': float(strike_row[1]) if strike_row and strike_row[1] is not None else None,
        'gex_strike_call_ask_minus_bid': float(strike_row[2]) if strike_row and strike_row[2] is not None else None,
        'gex_strike_put_ask_minus_bid': float(strike_row[3]) if strike_row and strike_row[3] is not None else None,
        'gex_strike_actual_strike': float(strike_row[0]) if strike_row else None,
    }


EMPTY_MACRO = {k: None for k in [
    'mkt_tide_ncp', 'mkt_tide_npp', 'mkt_tide_diff', 'mkt_tide_otm_diff',
    'spx_flow_diff', 'spy_etf_diff', 'qqq_etf_diff', 'zero_dte_diff',
    'spx_spot_gamma_oi', 'spx_spot_gamma_vol', 'spx_spot_charm_oi',
    'spx_spot_vanna_oi', 'gex_strike_call_minus_put',
    'gex_strike_call_ask_minus_bid', 'gex_strike_put_ask_minus_bid',
    'gex_strike_actual_strike',
]}


def days_between(from_ymd: str, to_ymd: str) -> int:
    a = datetime.fromisoformat(f'{from_ymd}T00:00:00+00:00')
    b = datetime.fromisoformat(f'{to_ymd}T00:00:00+00:00')
    return (b - a).days


def insert_fires(conn, fire_rows: list[tuple]) -> int:
    if not fire_rows:
        return 0
    cur = conn.cursor()
    inserted = execute_values(
        cur,
        """
        INSERT INTO lottery_finder_fires (
          date, trigger_time_ct, entry_time_ct, option_chain_id,
          underlying_symbol, option_type, strike, expiry, dte,
          trigger_vol_to_oi_window, trigger_vol_to_oi_cum,
          trigger_iv, trigger_delta, trigger_ask_pct,
          trigger_window_size, trigger_window_prints,
          entry_price, open_interest, spot_at_first,
          alert_seq, minutes_since_prev_fire,
          flow_quad, tod, mode,
          reload_tagged, cheap_call_pm_tagged,
          burst_ratio_vs_prev, entry_drop_pct_vs_prev,
          mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
          spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
          spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi, spx_spot_vanna_oi,
          gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
          gex_strike_put_ask_minus_bid, gex_strike_actual_strike
        )
        VALUES %s
        ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING
        RETURNING id
        """,
        fire_rows,
        template=(
            '(%s::date, %s::timestamptz, %s::timestamptz, %s, %s, %s, '
            '%s, %s::date, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '
            '%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '
            '%s, %s, %s, %s, %s, %s, %s, %s)'
        ),
        page_size=200,
        fetch=True,
    )
    conn.commit()
    return len(inserted) if inserted else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticker', required=True, help='Underlying symbol, e.g. SPXW')
    parser.add_argument('--from-date', help='YYYY-MM-DD inclusive')
    parser.add_argument('--to-date', help='YYYY-MM-DD inclusive')
    parser.add_argument('--no-macro', action='store_true',
                        help='Skip macro snapshot lookup (much faster)')
    args = parser.parse_args()

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)

    dates = list_parquet_dates(args.from_date, args.to_date)
    print(f'[backfill] ticker={args.ticker} dates={len(dates)} '
          f'(macro={"OFF" if args.no_macro else "ON"})')

    grand_fires = 0
    grand_inserted = 0
    grand_chains = 0
    t0 = time.time()

    for date_str in dates:
        path = PARQUET_DIR / f'{date_str}-trades.parquet'
        td = time.time()
        chain_groups = load_chain_groups(path, args.ticker)
        if not chain_groups:
            print(f'  [{date_str}] no rows for {args.ticker}')
            continue

        fires_today = 0
        rows_to_insert: list[tuple] = []
        for chain_id, group in chain_groups.items():
            if group['oi'] <= 0:
                continue
            ticks = group['ticks']
            if len(ticks) < 5:
                continue
            dte = days_between(date_str, group['expiry'])
            fires = detect_chain_fires(ticks, group['oi'], dte)
            if not fires:
                continue
            records = enrich_fires(fires, EnrichMeta(
                date=date_str,
                option_chain_id=chain_id,
                underlying_symbol=args.ticker,
                option_type=group['option_type'],
                strike=group['strike'],
                expiry=group['expiry'],
                dte=dte,
            ))
            in_universe = [r for r in records if r.mode != 'OUT_OF_UNIVERSE']
            fires_today += len(in_universe)
            for rec in in_universe:
                macro = (
                    EMPTY_MACRO
                    if args.no_macro
                    else fetch_macro(conn, args.ticker, rec.strike, rec.trigger_time_ct)
                )
                rows_to_insert.append((
                    rec.date,
                    rec.trigger_time_ct.isoformat(),
                    rec.entry_time_ct.isoformat(),
                    rec.option_chain_id,
                    rec.underlying_symbol,
                    rec.option_type,
                    float(rec.strike),
                    rec.expiry,
                    rec.dte,
                    float(rec.trigger_vol_to_oi_window),
                    float(rec.trigger_vol_to_oi_cum),
                    float(rec.trigger_iv),
                    float(rec.trigger_delta),
                    float(rec.trigger_ask_pct),
                    int(rec.trigger_window_size),
                    int(rec.trigger_window_prints),
                    float(rec.entry_price),
                    int(rec.open_interest),
                    float(rec.spot_at_first),
                    int(rec.alert_seq),
                    float(rec.minutes_since_prev_fire),
                    rec.flow_quad,
                    rec.tod,
                    rec.mode,
                    rec.reload_tagged,
                    rec.cheap_call_pm_tagged,
                    float(rec.burst_ratio_vs_prev) if rec.burst_ratio_vs_prev is not None else None,
                    float(rec.entry_drop_pct_vs_prev) if rec.entry_drop_pct_vs_prev is not None else None,
                    macro['mkt_tide_ncp'], macro['mkt_tide_npp'],
                    macro['mkt_tide_diff'], macro['mkt_tide_otm_diff'],
                    macro['spx_flow_diff'], macro['spy_etf_diff'],
                    macro['qqq_etf_diff'], macro['zero_dte_diff'],
                    macro['spx_spot_gamma_oi'], macro['spx_spot_gamma_vol'],
                    macro['spx_spot_charm_oi'], macro['spx_spot_vanna_oi'],
                    macro['gex_strike_call_minus_put'],
                    macro['gex_strike_call_ask_minus_bid'],
                    macro['gex_strike_put_ask_minus_bid'],
                    macro['gex_strike_actual_strike'],
                ))
        inserted_today = insert_fires(conn, rows_to_insert)
        grand_chains += len(chain_groups)
        grand_fires += fires_today
        grand_inserted += inserted_today
        print(
            f'  [{date_str}] chains={len(chain_groups):>5,} '
            f'fires={fires_today:>5,} inserted={inserted_today:>5,} '
            f'in {time.time() - td:.1f}s'
        )

    print(
        f'\n[backfill] DONE ticker={args.ticker} '
        f'days={len(dates)} chains={grand_chains:,} '
        f'fires_seen={grand_fires:,} inserted={grand_inserted:,} '
        f'in {time.time() - t0:.1f}s'
    )


if __name__ == '__main__':
    main()
