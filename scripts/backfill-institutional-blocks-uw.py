#!/usr/bin/env python3
"""
Backfill institutional_blocks from the Unusual Whales REST API.

Complements scripts/backfill-institutional-blocks.py (which uses local
EOD CSVs for the 8 days already on disk) by pulling historical data
from UW via /api/option-contract/{id}/flow?date=YYYY-MM-DD.

Scope: CEILING track only. The opening_atm track needs expired-
contract enumeration which UW's current /option-contracts endpoint
doesn't provide. Opening_atm backfill would need OCC symbol
reconstruction from historical spot — out of scope for this script.

Approach (30-day default):
  1. Enumerate current SPXW contracts with 150-330 DTE (wide enough to
     cover anything that was 180-300 DTE any time in the last 30 days).
  2. For each contract, for each historical trading day in the window,
     call /api/option-contract/{id}/flow?date=...&min_premium=25000.
  3. Filter to mfsl/cbmo/slft + size>=50, classify via classify_track,
     upsert to Postgres (idempotent via trade_id PK).

Rate limiting: 1 request per second by default. At ~40 contracts × 30
days = ~1200 requests, the run takes ~20 minutes. Safe under any UW
tier's RPM limit. Progress is logged each day.

Usage:
  UW_API_KEY=... DATABASE_URL="postgres://..." \
    ml/.venv/bin/python scripts/backfill-institutional-blocks-uw.py \
    [--days 30] [--dry-run] [--min-dte 150] [--max-dte 330] [--rate 1.0]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode

try:
    import psycopg2
    import requests
    from psycopg2.extras import execute_batch
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run with ml/.venv/bin/python")
    sys.exit(1)

UW_BASE = "https://api.unusualwhales.com/api"
TARGET_CONDITIONS = ("mfsl", "cbmo", "slft")
MIN_SIZE = 50
MIN_PREMIUM = 25_000
BATCH_SIZE = 500

# Classification thresholds — MUST match api/cron/fetch-spxw-blocks.ts
# classifyTrack() + scripts/backfill-institutional-blocks.py classify_track().
CEILING_DTE_MIN = 180
CEILING_DTE_MAX = 300
CEILING_MNY_MIN = 0.05
CEILING_MNY_MAX = 0.25
OPENING_DTE_MAX = 7
OPENING_MNY_MAX = 0.03
# 13:30-14:30 UTC = 08:30-09:30 CT
OPEN_START_UTC_MIN = 13 * 60 + 30
OPEN_END_UTC_MIN = 14 * 60 + 30


def classify_track(dte: int, mny: float, executed_at_iso: str) -> str:
    """Must match the TypeScript classifyTrack() in fetch-spxw-blocks.ts."""
    abs_mny = abs(mny)
    if (
        CEILING_DTE_MIN <= dte <= CEILING_DTE_MAX
        and CEILING_MNY_MIN <= abs_mny <= CEILING_MNY_MAX
    ):
        return "ceiling"
    try:
        hh = int(executed_at_iso[11:13])
        mm = int(executed_at_iso[14:16])
    except (ValueError, IndexError):
        return "other"
    utc_min = hh * 60 + mm
    if (
        0 <= dte <= OPENING_DTE_MAX
        and abs_mny <= OPENING_MNY_MAX
        and OPEN_START_UTC_MIN <= utc_min <= OPEN_END_UTC_MIN
    ):
        return "opening_atm"
    return "other"


def is_weekday(d: date) -> bool:
    return d.weekday() < 5  # Monday=0..Friday=4


def iter_trading_days(days_back: int) -> list[date]:
    """All weekdays in the last N days, newest first."""
    today = date.today()
    out: list[date] = []
    offset = 1
    while len(out) < days_back:
        d = today - timedelta(days=offset)
        if is_weekday(d):
            out.append(d)
        offset += 1
        if offset > days_back * 2:
            break  # safety
    return out


def uw_get(path: str, params: dict | None = None) -> dict:
    api_key = os.environ["UW_API_KEY"]
    url = f"{UW_BASE}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=20,
    )
    if r.status_code == 429:
        # UW returns retry-after on 429; simple linear backoff is fine for
        # a one-shot backfill.
        retry_after = int(r.headers.get("retry-after", "5"))
        print(f"  429 rate limit — sleeping {retry_after}s")
        time.sleep(retry_after)
        return uw_get(path, params)
    r.raise_for_status()
    return r.json()


def parse_occ_symbol(symbol: str) -> tuple[date | None, str | None, float | None]:
    """Parse OCC symbol like 'SPXW261218C08150000' → (expiry, type, strike).

    Format: <root><yymmdd><C|P><strike×1000 padded to 8 digits>
    SPXW has a 4-char root.
    """
    if len(symbol) < 15:
        return None, None, None
    # Find the C/P type code — last 9 chars are yymmddC|P + 8 digits
    try:
        body = symbol[-15:]  # yymmdd + C/P + 8 digits
        yymmdd = body[:6]
        type_char = body[6]
        strike_raw = body[7:]
        exp = datetime.strptime(yymmdd, "%y%m%d").date()
        opt_type = "call" if type_char == "C" else "put" if type_char == "P" else None
        strike = int(strike_raw) / 1000.0
        return exp, opt_type, strike
    except (ValueError, IndexError):
        return None, None, None


def fetch_contracts(min_dte: int, max_dte: int) -> list[dict]:
    """Enumerate current SPXW contracts in the given DTE window.

    The endpoint returns top-500 by volume — 0DTE dominates — so we
    paginate via option_type + exclude_zero_dte to surface long-dated
    contracts. Two calls (calls + puts) gives up to 1000 non-0DTE
    contracts covering the signal band.
    """
    today = date.today()
    filtered: list[dict] = []
    for opt_type in ("call", "put"):
        body = uw_get(
            "/stock/SPXW/option-contracts",
            {
                "limit": 500,
                "exclude_zero_dte": "true",
                "option_type": opt_type,
            },
        )
        data = body.get("data") or []
        for c in data:
            symbol = c.get("option_symbol") or ""
            exp, parsed_type, strike = parse_occ_symbol(symbol)
            if exp is None or strike is None:
                continue
            dte = (exp - today).days
            if min_dte <= dte <= max_dte:
                filtered.append({
                    **c,
                    "dte_today": dte,
                    "expiry_date": exp,
                    "option_type": parsed_type,
                    "strike_parsed": strike,
                })
        time.sleep(0.5)
    return filtered


def fetch_historical_flow(option_symbol: str, d: date) -> list[dict]:
    body = uw_get(
        f"/option-contract/{option_symbol}/flow",
        {
            "date": d.isoformat(),
            "min_premium": MIN_PREMIUM,
            "limit": 50,
        },
    )
    return body.get("data") or []


def upsert_blocks(conn, trades: list[dict]) -> int:
    rows = []
    for t in trades:
        try:
            strike = float(t["strike"])
            spot = float(t["underlying_price"])
            premium = float(t["premium"])
            price = float(t["price"])
            size = int(t["size"])
        except (KeyError, ValueError, TypeError):
            continue

        if size < MIN_SIZE or premium < MIN_PREMIUM:
            continue
        cond_raw = str(t.get("upstream_condition_detail") or "").lower()
        if cond_raw not in TARGET_CONDITIONS:
            continue
        if t.get("canceled"):
            continue

        executed_at = t["executed_at"]
        expiry = t["expiry"]
        dte = (
            datetime.strptime(expiry, "%Y-%m-%d").date()
            - datetime.strptime(executed_at[:10], "%Y-%m-%d").date()
        ).days
        mny = (strike - spot) / spot
        track = classify_track(dte, mny, executed_at)

        tags = t.get("tags") or []
        side = "ask" if "ask_side" in tags else ("bid" if "bid_side" in tags else None)

        # Use the SAME synthetic-id scheme as scripts/backfill-
        # institutional-blocks.py so CSV + UW backfills dedupe against
        # each other on overlap days (ON CONFLICT DO NOTHING).
        synthetic_key = (
            f"{executed_at}|{t['option_chain_id']}|{side or ''}"
            f"|{size}|{price}|{premium}"
        )
        trade_id = "csv-" + hashlib.md5(
            synthetic_key.encode("utf-8")
        ).hexdigest()

        rows.append((
            trade_id,
            executed_at,
            t["option_chain_id"],
            strike,
            t["option_type"],
            expiry,
            dte,
            size,
            price,
            premium,
            side,
            cond_raw,
            t.get("exchange"),
            spot,
            mny,
            t.get("open_interest"),
            float(t["delta"]) if t.get("delta") else None,
            float(t["gamma"]) if t.get("gamma") else None,
            float(t["implied_volatility"]) if t.get("implied_volatility") else None,
            track,
        ))

    if not rows:
        return 0

    sql = """
        INSERT INTO institutional_blocks (
            trade_id, executed_at, option_chain_id, strike, option_type,
            expiry, dte, size, price, premium, side, condition, exchange,
            underlying_price, moneyness_pct, open_interest, delta, gamma,
            iv, program_track
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (trade_id) DO NOTHING
    """
    with conn.cursor() as cur:
        execute_batch(cur, sql, rows, page_size=BATCH_SIZE)
    conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--min-dte", type=int, default=150)
    parser.add_argument("--max-dte", type=int, default=330)
    parser.add_argument(
        "--rate",
        type=float,
        default=1.0,
        help="Seconds to sleep between UW calls (default 1.0)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if "UW_API_KEY" not in os.environ:
        print("ERROR: UW_API_KEY not set")
        return 1
    database_url = os.environ.get("DATABASE_URL")
    if not database_url and not args.dry_run:
        print("ERROR: DATABASE_URL not set (use --dry-run to skip DB)")
        return 1

    trading_days = iter_trading_days(args.days)
    print(f"Targeting {len(trading_days)} trading days: {trading_days[-1]} .. {trading_days[0]}")

    print(f"Enumerating SPXW contracts in DTE window {args.min_dte}-{args.max_dte}...")
    contracts = fetch_contracts(args.min_dte, args.max_dte)
    if not contracts:
        print("No contracts matched the DTE window.")
        return 1
    print(f"  found {len(contracts)} contracts")
    time.sleep(args.rate)

    conn = None
    if not args.dry_run:
        conn = psycopg2.connect(database_url, sslmode="require")

    total_fetched = 0
    total_inserted = 0
    total_calls = 0

    for d in trading_days:
        day_fetched = 0
        day_inserted = 0
        for c in contracts:
            try:
                trades = fetch_historical_flow(c["option_symbol"], d)
            except requests.HTTPError as e:
                print(f"  {d} {c['option_symbol']}: {e.response.status_code} — skipping")
                time.sleep(args.rate)
                total_calls += 1
                continue
            total_calls += 1
            day_fetched += len(trades)

            if trades and not args.dry_run:
                assert conn is not None
                day_inserted += upsert_blocks(conn, trades)

            time.sleep(args.rate)

        total_fetched += day_fetched
        total_inserted += day_inserted
        print(
            f"  {d}: {day_fetched:>4} trades fetched"
            f"{'  (dry-run)' if args.dry_run else f'  {day_inserted:>3} upserted'}"
        )

    if conn:
        conn.close()

    print()
    print(f"Total UW calls:     {total_calls}")
    print(f"Total trades seen:  {total_fetched}")
    print(f"Total rows upserted:{total_inserted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
