#!/usr/bin/env python
"""Backfill lottery_finder_fires.score under V2 weights.

After `ml/.venv/bin/python ml/src/lottery_scoring.py` regenerates
`ml/output/lottery_score_weights.json`, historical rows in
lottery_finder_fires still carry scores assigned at insert time under
the old V1 formula. This script recomputes score for every fire using
the V2 JSON weights and bulk-UPDATEs in batches of 1000.

NOTE: `combined_score` is a STORED GENERATED column:
    GREATEST(0, COALESCE(score,0) + COALESCE(round_trip_score_deduct,0)
               + COALESCE(fire_count_score_adjustment,0) + gamma_case)
Updating `score` automatically recomputes `combined_score` — do NOT
attempt to update combined_score directly.

V2 gates (score → NULL):
  - !is_aligned (call: cum_ncp > cum_npp; put: cum_npp > cum_ncp)
  - dte not in {0, 1, 2, 3}

Idempotent: re-running with the same weights file writes identical values.

Usage:
    ml/.venv/bin/python scripts/backfill_lottery_scores.py [--dry-run]

Flags:
    --dry-run   Print distribution comparison without writing to DB.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / 'ml' / 'output' / 'lottery_score_weights.json'
ENV_FILE = ROOT / '.env.local'

VALID_DTES = {'0', '1', '2', '3'}


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


def assign_quintile(value: float, boundaries: list[float]) -> int:
    """Map value to quintile 0-4 using 4-element boundary list.

    Mirrors the TypeScript assignQuintile() and Python pd.cut() logic:
      value < boundaries[0]  → 0
      value < boundaries[1]  → 1
      value < boundaries[2]  → 2
      value < boundaries[3]  → 3
      value >= boundaries[3] → 4
    """
    for i, bound in enumerate(boundaries):
        if value < bound:
            return i
    return 4


def compute_score_v2(
    ticker: str,
    option_type: str,
    tod: str,
    dte: int,
    trigger_vol_to_oi_window: float | None,
    gamma_at_trigger: float | None,
    trigger_ask_pct: float | None,
    cum_ncp_at_fire: float | None,
    cum_npp_at_fire: float | None,
    weights: dict,
) -> int | None:
    """Compute V2 score for a single fire. Returns None for gated rows."""
    # --- Alignment gate ---
    if cum_ncp_at_fire is None or cum_npp_at_fire is None:
        is_aligned = False
    elif option_type == 'C':
        is_aligned = cum_ncp_at_fire > cum_npp_at_fire
    elif option_type == 'P':
        is_aligned = cum_npp_at_fire > cum_ncp_at_fire
    else:
        is_aligned = False

    if not is_aligned:
        return None

    # --- DTE universe gate ---
    dte_key = str(dte)
    if dte_key not in VALID_DTES:
        return None

    features = weights['features']

    score = 0

    # Ticker
    score += features['ticker_weights'].get(ticker, 0)

    # TOD
    score += features['tod_weights'].get(tod, 0)

    # DTE
    score += features['dte_weights'].get(dte_key, 0)

    # Vol/OI quintile
    if trigger_vol_to_oi_window is not None:
        q = assign_quintile(
            trigger_vol_to_oi_window,
            features['vol_oi_quintile_boundaries'],
        )
        score += features['vol_oi_quintile_weights'][q]

    # Gamma quintile
    if gamma_at_trigger is not None:
        q = assign_quintile(
            gamma_at_trigger,
            features['gamma_quintile_boundaries'],
        )
        score += features['gamma_quintile_weights'][q]

    # Ask pct quintile
    if trigger_ask_pct is not None:
        q = assign_quintile(
            trigger_ask_pct,
            features['ask_pct_quintile_boundaries'],
        )
        score += features['ask_pct_quintile_weights'][q]

    # Option type
    score += features['option_type_weights'].get(option_type, 0)

    return score


def print_distribution(
    label: str,
    scores: list[int | None],
    t1: int,
    t2: int,
) -> None:
    """Print tier distribution summary for a score list."""
    non_null = [s for s in scores if s is not None]
    null_count = len(scores) - len(non_null)
    tier1 = sum(1 for s in non_null if s >= t1)
    tier2 = sum(1 for s in non_null if t2 <= s < t1)
    tier3 = sum(1 for s in non_null if s < t2)
    mean_score = sum(non_null) / len(non_null) if non_null else 0.0
    mn = min(non_null) if non_null else None
    mx = max(non_null) if non_null else None
    print(
        f'[{label}] '
        f'T1(>={t1})={tier1:,}  T2([{t2},{t1}))={tier2:,}  T3(<{t2})={tier3:,}  '
        f'NULL={null_count:,}  '
        f'mean={mean_score:.2f}  range={mn}–{mx}'
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Backfill lottery_finder_fires.score under V2 weights.'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print distribution comparison without writing to DB.',
    )
    args = parser.parse_args()
    dry_run: bool = args.dry_run

    load_env()

    if not JSON_PATH.exists():
        sys.exit(f'Missing weights JSON: {JSON_PATH}')
    weights = json.loads(JSON_PATH.read_text())
    print(f'[backfill] Loaded weights: {weights["model_version"]} (trained {weights["trained_at"][:10]})')

    t1: int = weights['cutoffs']['t1']
    t2: int = weights['cutoffs']['t2']
    print(f'[backfill] Tier cutoffs: t1={t1}, t2={t2}')

    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()

        # Fetch all fires with the columns needed for V2 scoring + current score.
        print('[backfill] Fetching fires from DB...')
        cur.execute(
            """
            SELECT
                id,
                underlying_symbol,
                option_type,
                tod,
                dte,
                trigger_vol_to_oi_window,
                gamma_at_trigger,
                trigger_ask_pct,
                cum_ncp_at_fire,
                cum_npp_at_fire,
                score
            FROM lottery_finder_fires
            ORDER BY id
            """
        )
        rows = cur.fetchall()
        print(f'[backfill] Fetched {len(rows):,} fires')

        # --- Compute V2 scores and compare with current ---
        t0 = time.time()
        current_scores: list[int | None] = []
        new_scores: list[int | None] = []
        updates: list[tuple[int, int | None]] = []
        unchanged = 0

        # Sample: first 100 rows for sanity check
        sample_printed = 0

        for (
            fid,
            ticker,
            option_type,
            tod,
            dte,
            vol_oi,
            gamma,
            ask_pct,
            cum_ncp,
            cum_npp,
            cur_score,
        ) in rows:
            new_score = compute_score_v2(
                ticker=ticker,
                option_type=option_type,
                tod=tod,
                dte=int(dte),
                trigger_vol_to_oi_window=float(vol_oi) if vol_oi is not None else None,
                gamma_at_trigger=float(gamma) if gamma is not None else None,
                trigger_ask_pct=float(ask_pct) if ask_pct is not None else None,
                cum_ncp_at_fire=float(cum_ncp) if cum_ncp is not None else None,
                cum_npp_at_fire=float(cum_npp) if cum_npp is not None else None,
                weights=weights,
            )

            current_scores.append(cur_score)
            new_scores.append(new_score)

            if sample_printed < 100:
                if sample_printed == 0:
                    print('\n[backfill] Sample of first 100 fires (id, ticker, opt, tod, dte, old_score → new_score):')
                print(
                    f'  id={fid:>10}  {ticker:6s}  {option_type}  {tod:8s}  dte={dte}  '
                    f'{str(cur_score):>6} → {str(new_score):>6}'
                )
                sample_printed += 1

            if cur_score == new_score:
                unchanged += 1
            else:
                updates.append((fid, new_score))

        elapsed = time.time() - t0
        print(
            f'\n[backfill] Score computation: {elapsed:.1f}s  '
            f'({len(updates):,} would change, {unchanged:,} unchanged)'
        )

        # --- Distribution comparison ---
        print()
        print_distribution('BEFORE (current)', current_scores, t1, t2)
        print_distribution('AFTER  (v2)     ', new_scores, t1, t2)

        # Alignment rate sanity check
        null_count = sum(1 for s in new_scores if s is None)
        null_pct = 100.0 * null_count / len(new_scores) if new_scores else 0.0
        print(f'\n[backfill] NULL/gated rate: {null_pct:.1f}%  ({null_count:,} / {len(new_scores):,})')
        # Expected NULL rate: ~26% missing cum_ncp/npp (pre-enrichment rows) +
        # ~38% misaligned-of-has-cum = ~64% total. A rate >75% would suggest
        # the alignment gate is over-broad; <50% would mean cum enrichment
        # coverage is far better than expected.
        if null_pct > 75:
            print(
                '[backfill] WARNING: >75% NULL rate — alignment gate may be too aggressive. '
                'Investigate cum_ncp/npp population and misalignment ratio.'
            )
        elif null_pct < 50:
            print(
                '[backfill] NOTE: <50% NULL rate — cum enrichment coverage better than '
                'spec baseline (~64%). This is fine.'
            )

        if dry_run:
            print('\n[backfill] DRY RUN — no DB writes performed.')
            return

        # --- Apply updates ---
        if not updates:
            print('[backfill] No rows need updating — already up to date.')
            conn.commit()
            return

        print(f'\n[backfill] Writing {len(updates):,} updates to DB...')
        t0 = time.time()
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
        print(f'[backfill] DB updated: {len(updates):,} rows in {time.time() - t0:.1f}s')

        # --- Post-backfill sanity: query live DB distribution ---
        print('\n[backfill] Post-backfill DB distribution:')
        cur.execute(
            f"""
            SELECT
              COUNT(*) FILTER (WHERE score >= {t1}) AS tier1,
              COUNT(*) FILTER (WHERE score >= {t2} AND score < {t1}) AS tier2,
              COUNT(*) FILTER (WHERE score < {t2} AND score IS NOT NULL) AS tier3,
              COUNT(*) FILTER (WHERE score IS NULL) AS nulls,
              MIN(score), MAX(score),
              ROUND(AVG(score)::numeric, 2) AS avg_score,
              COUNT(*) AS total
            FROM lottery_finder_fires
            """
        )
        row = cur.fetchone()
        if row:
            t1c, t2c, t3c, nullc, mn, mx, avg, total = row
            print(
                f'  Tier1 (>={t1}): {t1c:>8,}\n'
                f'  Tier2 ([{t2},{t1})): {t2c:>8,}\n'
                f'  Tier3 (<{t2}):  {t3c:>8,}\n'
                f'  NULL (gated):  {nullc:>8,}\n'
                f'  Total:         {total:>8,}\n'
                f'  Score range:   {mn} – {mx}  (avg {avg})'
            )

        # Spot-check 2026-05-21: should have at least one tier2+ fire
        print('\n[backfill] Spot-check 2026-05-21 tier2+ fires:')
        cur.execute(
            f"""
            SELECT id, underlying_symbol, option_type, tod, dte, score, combined_score
            FROM lottery_finder_fires
            WHERE date = '2026-05-21'
              AND score >= {t2}
            ORDER BY score DESC
            LIMIT 10
            """
        )
        spot = cur.fetchall()
        if spot:
            print(f'  Found {len(spot)} tier2+ fires (first 10):')
            for r in spot:
                print(f'    id={r[0]}  {r[1]:6s}  {r[2]}  {r[3]:8s}  dte={r[4]}  score={r[5]}  combined_score={r[6]}')
        else:
            print('  WARNING: ZERO tier2+ fires on 2026-05-21 — original failure case still not resolved!')

    finally:
        conn.close()


if __name__ == '__main__':
    main()
