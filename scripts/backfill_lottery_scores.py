#!/usr/bin/env python
"""Backfill lottery_finder_fires.score under refreshed weights.

After `make refit` regenerates `ml/data/lottery_score_weights.json`,
historical rows in lottery_finder_fires still carry the score they were
assigned at insert time under the old weights. This script recomputes
score for every fire using the current JSON weights and bulk-UPDATEs
in batches of 1000.

Idempotent: re-running with the same weights writes identical values.

Usage:
    ml/.venv/bin/python scripts/backfill_lottery_scores.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / 'ml' / 'data' / 'lottery_score_weights.json'
ENV_FILE = ROOT / '.env.local'

# DB writes 'A_intraday_0DTE' / 'B_multi_day_DTE1_3' but the JSON keys
# are '0DTE' / 'multi-day' (matching the Python refit script's view).
MODE_DB_TO_JSON = {
    'A_intraday_0DTE': '0DTE',
    'B_multi_day_DTE1_3': 'multi-day',
    'OUT_OF_UNIVERSE': None,
}
OPTION_TYPE_DB_TO_JSON = {'C': 'call', 'P': 'put'}


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


def compute_score(
    ticker: str,
    mode: str,
    entry_price: float,
    tod: str,
    option_type: str,
    weights: dict,
) -> int:
    score = 0
    score += weights['ticker'].get(ticker, 0)
    json_mode = MODE_DB_TO_JSON.get(mode)
    if json_mode is not None:
        score += weights['mode'].get(json_mode, 0)
    for threshold, points in weights['price']['thresholds']:
        if entry_price <= threshold:
            score += points
            break
    score += weights['tod'].get(tod, 0)
    json_otype = OPTION_TYPE_DB_TO_JSON.get(option_type)
    if json_otype is not None:
        score += weights['option_type'].get(json_otype, 0)
    return score


def main() -> None:
    load_env()
    if not JSON_PATH.exists():
        sys.exit(f'Missing weights JSON: {JSON_PATH}')
    weights = json.loads(JSON_PATH.read_text())

    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, underlying_symbol, mode, entry_price, tod, option_type
            FROM lottery_finder_fires
            ORDER BY id
            """
        )
        rows = cur.fetchall()
        print(f'[backfill] fetched {len(rows):,} fires')

        t0 = time.time()
        updates = []
        unchanged = 0
        # Pull current scores in one shot to detect no-ops.
        cur.execute('SELECT id, score FROM lottery_finder_fires')
        current = dict(cur.fetchall())

        for fid, ticker, mode, entry_price, tod, option_type in rows:
            new_score = compute_score(
                ticker, mode, float(entry_price), tod, option_type, weights
            )
            if current.get(fid) == new_score:
                unchanged += 1
                continue
            updates.append((fid, new_score))

        print(
            f'[backfill] computed in {time.time() - t0:.1f}s '
            f'({len(updates):,} changed, {unchanged:,} unchanged)'
        )

        if updates:
            execute_values(
                cur,
                """
                UPDATE lottery_finder_fires AS f
                SET score = v.score
                FROM (VALUES %s) AS v(id, score)
                WHERE f.id = v.id
                """,
                updates,
                template='(%s::bigint, %s::int)',
                page_size=1000,
            )
            conn.commit()
            print(f'[backfill] DB updated: {len(updates):,} rows')

        # Distribution snapshot.
        cur.execute(
            """
            SELECT
              COUNT(*) FILTER (WHERE score >= 18) AS tier1,
              COUNT(*) FILTER (WHERE score >= 12 AND score < 18) AS tier2,
              COUNT(*) FILTER (WHERE score < 12) AS tier3,
              MIN(score), MAX(score), ROUND(AVG(score)::numeric, 1)
            FROM lottery_finder_fires
            """
        )
        t1, t2, t3, mn, mx, avg = cur.fetchone()
        print(
            f'[backfill] tiers: T1={t1:,} T2={t2:,} T3={t3:,} '
            f'(score range {mn}–{mx}, avg {avg})'
        )
    finally:
        conn.close()


if __name__ == '__main__':
    main()
