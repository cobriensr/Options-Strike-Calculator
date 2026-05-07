#!/usr/bin/env python
"""Audit which tickers SHOULD be in the lottery universe but aren't.

For every ticker NOT currently in LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS,
this script:
  1. Sums per-day volume across the parquet window to find candidates
     with non-trivial liquidity (>=50K trades).
  2. Runs the parity-tested Python detector (`lottery_detector_py.py`)
     against each candidate's chains in dry-run mode (no DB writes).
  3. Reports per-ticker would-be fire counts so we can decide which
     tickers to add to the universe based on a real "fires per day"
     measurement, not just volume rank.

Read-only — no DB writes, no parquet writes. Output to docs/tmp/.

Usage:
    ml/.venv/bin/python scripts/ticker_discovery_audit.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

sys.path.insert(0, str(ROOT / 'scripts'))
from lottery_detector_py import (  # noqa: E402
    OptionTradeTick,
    EnrichMeta,
    LOTTERY_V3_TICKERS,
    LOTTERY_EXTENDED_TICKERS,
    detect_chain_fires,
    enrich_fires,
)

# Discovery floor: only consider tickers with at least this many
# total trades across the 18-day window. Below this, statistical noise
# dominates and the per-ticker estimate is meaningless.
MIN_VOLUME_FLOOR = 50_000

# How many top-by-volume new tickers to detector-test. Detector is fast
# so we can be generous; ~50 covers the realistic onboarding pool.
MAX_CANDIDATES = 50


def list_parquet_dates() -> list[str]:
    out = []
    for p in sorted(PARQUET_DIR.glob('*-trades.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', p.name)
        if m:
            out.append(m.group(1))
    return out


def find_top_volume_tickers(dates: list[str]) -> pd.DataFrame:
    """Sum trade counts per ticker across all parquets. Excludes
    existing universe tickers. Returns ranked DataFrame."""
    existing = LOTTERY_V3_TICKERS | LOTTERY_EXTENDED_TICKERS
    print(f'[discovery] existing universe: {len(existing)} tickers')

    counts: dict[str, int] = {}
    for date_str in dates:
        path = PARQUET_DIR / f'{date_str}-trades.parquet'
        if not path.exists():
            continue
        # Just the underlying_symbol column — ~MB of data, very fast.
        df = pd.read_parquet(path, columns=['underlying_symbol'])
        vc = df['underlying_symbol'].value_counts()
        for ticker, n in vc.items():
            if ticker in existing:
                continue
            counts[ticker] = counts.get(ticker, 0) + int(n)

    out = pd.DataFrame(
        [{'ticker': t, 'volume': v} for t, v in counts.items()]
    ).sort_values('volume', ascending=False)
    return out[out['volume'] >= MIN_VOLUME_FLOOR].head(MAX_CANDIDATES)


def days_between(from_ymd: str, to_ymd: str) -> int:
    a = datetime.fromisoformat(f'{from_ymd}T00:00:00+00:00')
    b = datetime.fromisoformat(f'{to_ymd}T00:00:00+00:00')
    return (b - a).days


def _maybe_float(v):
    """None / NaN → None, else float(v). Module-scope so it isn't
    rebuilt per row across millions of rows in the inner detector loop."""
    if v is None:
        return None
    if isinstance(v, float) and np.isnan(v):
        return None
    return float(v)


def _maybe_int(v):
    if v is None:
        return None
    if isinstance(v, float) and np.isnan(v):
        return None
    return int(v)


def run_detector_for_ticker(
    parquet_path: Path, target_date: str, ticker: str
) -> tuple[int, int, int]:
    """Run the detector dry on one ticker for one date. Returns
    (n_chains, n_fires, n_in_universe_fires)."""
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
        return 0, 0, 0
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')

    n_chains = 0
    n_fires = 0
    n_in_universe = 0  # would have classified as Mode A or Mode B

    for chain_id, sub in df.groupby('option_chain_id', sort=False):
        ticks: list[OptionTradeTick] = []
        oi_max = 0
        for r in sub.itertuples(index=False):
            ts = r.executed_at
            if hasattr(ts, 'to_pydatetime'):
                ts = ts.to_pydatetime()
            exp_raw = r.expiry
            if hasattr(exp_raw, 'isoformat'):
                exp_str = exp_raw.isoformat()[:10]
            else:
                exp_str = str(exp_raw)[:10]
            try:
                expiry_dt = datetime.fromisoformat(f'{exp_str}T00:00:00+00:00')
            except ValueError:
                continue
            opt_type = r.option_type
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
                underlying_price=_maybe_float(r.underlying_price),
                side=r.side if r.side in ('ask', 'bid', 'mid', 'no_side') else 'no_side',
                implied_volatility=_maybe_float(r.implied_volatility),
                delta=_maybe_float(r.delta),
                open_interest=_maybe_int(r.open_interest),
            )
            ticks.append(tick)
            if tick.open_interest is not None and tick.open_interest > oi_max:
                oi_max = tick.open_interest
        if not ticks or oi_max <= 0 or len(ticks) < 5:
            continue
        n_chains += 1
        expiry_str = ticks[0].expiry.date().isoformat()
        dte = days_between(target_date, expiry_str)
        fires = detect_chain_fires(ticks, oi_max, dte)
        if not fires:
            continue
        n_fires += len(fires)
        # Run enrichment with TEMPORARY universe expansion: classifyMode
        # would currently return OUT_OF_UNIVERSE for these tickers.
        # Instead, mock it by checking whether the ticker WOULD qualify
        # for either mode if added to the right list. For audit
        # purposes: count any non-OUT_OF_UNIVERSE fire.
        records = enrich_fires(fires, EnrichMeta(
            date=target_date,
            option_chain_id=chain_id,
            underlying_symbol=ticker,  # not in universe → OUT_OF_UNIVERSE
            option_type=ticks[0].option_type,
            strike=ticks[0].strike,
            expiry=expiry_str,
            dte=dte,
        ))
        # All records for unknown tickers will be OUT_OF_UNIVERSE since
        # the detector's classify_mode() doesn't know them. So we count
        # by pre-classification logic: would qualify as Mode A if dte=0,
        # Mode B if dte 1-3 with in-play strike. Use the raw fire as
        # the candidate count.
        spot = fires[0].spot_at_first
        for rec in records:
            # Mode A criteria (mock): dte=0, ask% ≥ 0.52
            if rec.dte == 0 and rec.trigger_ask_pct >= 0.52:
                n_in_universe += 1
            # Mode B criteria (mock): dte 1-3, ask% ≥ 0.52, in-play
            elif (
                0 < rec.dte <= 3
                and rec.trigger_ask_pct >= 0.52
                and spot > 0
                and abs(rec.strike / spot - 1) <= 0.10
            ):
                n_in_universe += 1
    return n_chains, n_fires, n_in_universe


def main() -> None:
    dates = list_parquet_dates()
    print(f'[discovery] scanning {len(dates)} parquet days')

    candidates = find_top_volume_tickers(dates)
    print(f'[discovery] {len(candidates)} candidates above {MIN_VOLUME_FLOOR:,} '
          f'volume threshold')

    rows = []
    t0 = time.time()
    for i, (_, row) in enumerate(candidates.iterrows(), start=1):
        ticker = row['ticker']
        td = time.time()
        total_chains = 0
        total_fires = 0
        total_in_universe = 0
        for date_str in dates:
            path = PARQUET_DIR / f'{date_str}-trades.parquet'
            if not path.exists():
                continue
            chains, fires, in_universe = run_detector_for_ticker(path, date_str, ticker)
            total_chains += chains
            total_fires += fires
            total_in_universe += in_universe
        rows.append({
            'ticker': ticker,
            'volume': int(row['volume']),
            'chains_18d': total_chains,
            'raw_fires_18d': total_fires,
            'qualifying_fires_18d': total_in_universe,
            'fires_per_day': round(total_in_universe / max(len(dates), 1), 1),
        })
        elapsed = time.time() - t0
        rate = i / elapsed if elapsed > 0 else 0
        print(f'  [{i:>3}/{len(candidates)}] {ticker:<7} vol={int(row["volume"]):>10,} '
              f'chains={total_chains:>4,} raw={total_fires:>4,} '
              f'qualifying={total_in_universe:>4,} '
              f'({time.time()-td:.1f}s; ~{rate:.1f}/s)')

    df = pd.DataFrame(rows).sort_values('qualifying_fires_18d', ascending=False)

    out_path = ROOT / 'docs' / 'tmp' / f'ticker-discovery-audit-{dates[-1]}.md'
    lines = ['# Ticker discovery audit\n']
    lines.append(f'Scanned {len(dates)} parquets ({dates[0]} → {dates[-1]}).\n')
    lines.append(f'Excluded: {len(LOTTERY_V3_TICKERS | LOTTERY_EXTENDED_TICKERS)} '
                 f'tickers already in the universe.\n')
    lines.append(f'Volume floor: {MIN_VOLUME_FLOOR:,} prints across the window.\n')
    lines.append(f'\n## Ranked candidates by qualifying-fire count\n')
    lines.append(
        f'    {"ticker":<7} {"volume":>10} {"chains":>7} {"raw_fires":>10} '
        f'{"qualifying":>11} {"per_day":>8}'
    )
    for r in df.itertuples(index=False):
        lines.append(
            f'    {r.ticker:<7} {r.volume:>10,} {r.chains_18d:>7,} '
            f'{r.raw_fires_18d:>10,} {r.qualifying_fires_18d:>11,} '
            f'{r.fires_per_day:>8.1f}'
        )

    # Top-recommendation summary
    top = df[df['qualifying_fires_18d'] >= 50].head(20)
    lines.append('\n## Recommended additions (≥50 qualifying fires across window)\n')
    lines.append(
        '    NOTE: `suggested mode` is a *heuristic* hint based on total volume '
        '(>500K → B, else A). Volume is summed across the whole parquet regardless '
        'of DTE, so a mega-cap whose flow is mostly 0DTE could be tagged B by '
        'mistake. Use this as a starting point, not the final classification.\n'
    )
    if top.empty:
        lines.append('    none meet the bar.')
    else:
        lines.append(
            f'    {"ticker":<7} {"qualifying":>11} {"per_day":>8}  suggested mode'
        )
        for r in top.itertuples(index=False):
            mode = 'B (DTE 1-3 / EXTENDED)' if r.volume > 500_000 else 'A (0DTE / V3)'
            lines.append(
                f'    {r.ticker:<7} {r.qualifying_fires_18d:>11,} '
                f'{r.fires_per_day:>8.1f}  {mode}'
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print('\n'.join(lines[-30:]))
    print(f'\n[discovery] full report → {out_path}')
    print(f'[discovery] runtime: {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
