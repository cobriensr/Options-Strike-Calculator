#!/usr/bin/env python
"""Local backfill for net_flow_per_ticker_history.

Mirrors api/cron/fetch-net-flow-history.ts: hits UW REST
`/stock/{ticker}/net-prem-ticks?date=YYYY-MM-DD` for the Lottery Finder
universe (V3 ∪ EXTENDED), filters to the 08:30–14:59 CT session window,
INSERTs into `net_flow_per_ticker_history` with ON CONFLICT DO NOTHING.

The Vercel cron runs at 21:25 UTC weekdays. When it doesn't fire (as
happened 2026-05-05), `realized_flow_inversion_pct` can't be computed
because the matched-flow input is missing. This script restores that
input so the local enrichment can run.

Usage:
    ml/.venv/bin/python scripts/backfill_net_flow_history.py
    ml/.venv/bin/python scripts/backfill_net_flow_history.py --date 2026-05-05
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date as DateType, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2.extras import execute_values

from _pipeline_retry import is_retryable_http_status, retry_call

_CT_TZ = ZoneInfo('America/Chicago')

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

# Mirrors LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS in
# api/_lib/lottery-finder.ts (deduped). If that source list grows,
# update here. Set form preserves dedupe (SPY/IWM appear in both).
TICKERS: list[str] = sorted(
    {
        # V3 (Mode A 0DTE intraday) — keep aligned with
        # api/_lib/lottery-finder.ts LOTTERY_V3_TICKERS and
        # uw-stream/src/config.py _LOTTERY_TICKERS. Drift between any
        # two of these three lists silently breaks flow_inversion for
        # the missing tickers.
        'USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM',
        'WDC', 'SQQQ', 'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL',
        'SNOW', 'TEAM', 'RKLB', 'SOFI', 'RUTW', 'SPY', 'IWM',
        'SPXW',
        # V3 additions caught during the 2026-05-07 audit — these had
        # been firing in detect-lottery-fires.ts but their flow data
        # wasn't being fetched, so flow_inversion stayed NULL.
        'TSLA', 'SOXS', 'WULF', 'SLV', 'SMH', 'UBER', 'MSTR', 'TQQQ',
        'RIOT', 'SOXL', 'UNH', 'QQQ', 'RBLX',
        # V3 batch (2026-05-07 audit) — AI / speculative / crypto-adjacent
        # 0DTE candidates from docs/tmp/ticker-discovery-audit-2026-05-06.md.
        'CRWV', 'IBIT', 'ARM', 'OKLO', 'APLD', 'IONQ',
        'HIMS', 'CAR', 'IREN', 'ASTS', 'NBIS', 'CRCL', 'LITE', 'NVTS',
        # EXTENDED (Mode B DTE 1-3) — TSLA + MSTR overlap with V3
        # additions above; set form dedupes.
        'MU', 'META', 'AMD', 'NVDA', 'INTC', 'MSFT', 'AMZN', 'PLTR',
        'AVGO', 'GOOGL', 'GOOG', 'COIN', 'HOOD', 'MRVL',
        'ORCL', 'AAPL',
        # EXTENDED batch (2026-05-07 audit) — mega-cap peer-class
        # oversights.
        'QCOM', 'NFLX', 'LLY', 'BABA', 'NOW', 'CRWD',
    }
)

UW_BASE = 'https://api.unusualwhales.com/api'
SESSION_OPEN_MIN = 8 * 60 + 30   # 08:30 CT
SESSION_CLOSE_MIN = 15 * 60      # 15:00 CT (exclusive)


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


def detect_latest_date() -> str:
    files = sorted(PARQUET_DIR.glob('*-trades.parquet'))
    if not files:
        sys.exit(f'No *-trades.parquet files in {PARQUET_DIR}')
    m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', files[-1].name)
    if not m:
        sys.exit(f'Cannot parse date from {files[-1].name}')
    return m.group(1)


def is_in_session_ct(tape_time_utc: str) -> bool:
    """Match TS isInSessionCT — gate to 08:30–14:59 CT (DST-aware)."""
    try:
        ts = datetime.fromisoformat(tape_time_utc.replace('Z', '+00:00'))
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    ct = ts.astimezone(_CT_TZ)
    mod = ct.hour * 60 + ct.minute
    return SESSION_OPEN_MIN <= mod < SESSION_CLOSE_MIN


# Sentinel returned by fetch_ticker on network/HTTP failure so the caller can
# distinguish "UW had no data for this ticker" from "we never got a response".
# Don't confuse with a list of zero rows — that means UW returned an empty data
# array, which is legitimate for quiet tickers.
class FetchError:
    __slots__ = ('reason',)
    def __init__(self, reason: str) -> None:
        self.reason = reason


def fetch_ticker(
    api_key: str, ticker: str, date: str
) -> list[dict[str, Any]] | FetchError:
    url = f'{UW_BASE}/stock/{ticker}/net-prem-ticks?date={date}'
    req = Request(url, headers={
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
    })

    def _do_fetch() -> list[dict[str, Any]]:
        with urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        return payload.get('data', []) if isinstance(payload, dict) else []

    # Bounded exponential backoff (6 attempts: 1,2,4,8,16,32s ≈ 63s max).
    # Retries transient UW failures — 429 rate-limit bursts (20-40s windows),
    # 5xx, the momentary edge 403 that wiped the whole 2026-05-29 run, and any
    # transport-level URLError (reset/timeout/DNS). A genuine auth 403 just
    # exhausts the retries and still returns FetchError — fail-loud preserved.
    def _is_retryable(exc: BaseException) -> bool:
        if isinstance(exc, HTTPError):
            return is_retryable_http_status(exc.code)
        return isinstance(exc, URLError)  # transport-level

    try:
        return retry_call(
            _do_fetch,
            retryable=_is_retryable,
            label=f'UW net-prem-ticks {ticker}',
        )
    except HTTPError as e:
        reason = f'HTTPError {e.code}: {e.reason}'
        print(f'[backfill-flow] {ticker} {reason}', file=sys.stderr)
        return FetchError(reason)
    except URLError as e:
        reason = f'URLError: {e.reason}'
        print(f'[backfill-flow] {ticker} {reason}', file=sys.stderr)
        return FetchError(reason)


def parse_row(raw: dict[str, Any]) -> tuple:
    def f(v) -> float:
        try:
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0
    def i(v) -> int:
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0
    return (
        raw.get('tape_time'),
        f(raw.get('net_call_premium')),
        i(raw.get('net_call_volume')),
        f(raw.get('net_put_premium')),
        i(raw.get('net_put_volume')),
        i(raw.get('call_volume')),
        i(raw.get('call_volume_ask_side')),
        i(raw.get('call_volume_bid_side')),
        i(raw.get('put_volume')),
        i(raw.get('put_volume_ask_side')),
        i(raw.get('put_volume_bid_side')),
    )


def store_rows(
    conn, ticker: str, rows: list[tuple]
) -> int:
    if not rows:
        return 0
    cur = conn.cursor()
    payload = [(ticker, *r, 'rest') for r in rows]
    inserted = execute_values(
        cur,
        """
        INSERT INTO net_flow_per_ticker_history (
          ticker, ts, net_call_prem, net_call_vol,
          net_put_prem, net_put_vol,
          call_volume, call_volume_ask_side, call_volume_bid_side,
          put_volume, put_volume_ask_side, put_volume_bid_side,
          source
        )
        VALUES %s
        ON CONFLICT (ticker, ts, source) DO NOTHING
        RETURNING id
        """,
        payload,
        template='(%s, %s::timestamptz, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
        page_size=500,
        fetch=True,
    )
    conn.commit()
    return len(inserted) if inserted else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--date',
        help='YYYY-MM-DD; defaults to latest *-trades.parquet date',
    )
    args = parser.parse_args()

    load_env()
    target_date = args.date or detect_latest_date()
    DateType.fromisoformat(target_date)
    print(f'[backfill-flow] target date: {target_date}')

    api_key = os.environ.get('UW_API_KEY')
    if not api_key:
        sys.exit('UW_API_KEY not set in .env.local')

    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    # Concurrency 3 matches the TS cron (UW caps in-flight at 3).
    t0 = time.time()
    print(f'[backfill-flow] fetching {len(TICKERS)} tickers (concurrency=3)…')
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(
            lambda t: (t, fetch_ticker(api_key, t, target_date)),
            TICKERS,
        ))
    fetch_secs = time.time() - t0

    conn = psycopg2.connect(db_url)
    try:
        total_fetched = 0
        total_kept = 0
        total_stored = 0
        empty = 0
        failed: list[tuple[str, str]] = []
        for ticker, raw in results:
            if isinstance(raw, FetchError):
                failed.append((ticker, raw.reason))
                continue
            total_fetched += len(raw)
            kept = [
                parse_row(r) for r in raw
                if r.get('tape_time') and is_in_session_ct(r['tape_time'])
            ]
            total_kept += len(kept)
            stored = store_rows(conn, ticker, kept)
            total_stored += stored
            if len(raw) == 0:
                empty += 1
        print(
            f'[backfill-flow] fetched={total_fetched:,} '
            f'kept_in_session={total_kept:,} '
            f'inserted={total_stored:,} '
            f'empty_tickers={empty} '
            f'failed_tickers={len(failed)} '
            f'in {fetch_secs:.1f}s fetch + {time.time() - t0 - fetch_secs:.1f}s db'
        )
        if failed:
            print(
                f'[backfill-flow] {len(failed)} ticker(s) failed to fetch:',
                file=sys.stderr,
            )
            for t, r in failed:
                print(f'  {t}: {r}', file=sys.stderr)
        # Guard against a fully-failed run that would silently leave downstream
        # flow-inversion enrichment with no source data. If we couldn't store
        # any rows from any ticker, exit non-zero so the Makefile aborts the
        # pipeline rather than chaining into enrich on empty data.
        if total_stored == 0 and total_fetched == 0:
            sys.exit(
                f'[backfill-flow] FAIL: no rows fetched or stored '
                f'(failed_tickers={len(failed)})'
            )
    finally:
        conn.close()


if __name__ == '__main__':
    main()
