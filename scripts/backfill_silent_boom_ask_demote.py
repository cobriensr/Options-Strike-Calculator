#!/usr/bin/env python
"""Recompute silent_boom_alerts.score + score_tier under the new
saturation rule.

After Phase 2 of docs/superpowers/specs/silent-boom-ask-100-demote-2026-05-12.md,
ask_pct = 1.0 fires get a −30 saturation penalty (vs the old uniform
−1 cap penalty for ≥0.95). That change applies forward via the cron,
but existing rows persist their pre-Phase-2 score and tier; this
script recomputes them in place.

The Python scoring logic mirrors api/_lib/silent-boom-score.ts. It
shares the implementation in scripts/backfill_silent_boom_from_parquet.py
(`compute_silent_boom_score` + `silent_boom_tier`) so there's one
source of truth on the Python side.

Usage:
    ml/.venv/bin/python scripts/backfill_silent_boom_ask_demote.py
    ml/.venv/bin/python scripts/backfill_silent_boom_ask_demote.py --dry-run
    ml/.venv/bin/python scripts/backfill_silent_boom_ask_demote.py --only-saturated
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import psycopg2
from psycopg2.extras import execute_values

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
_CT = ZoneInfo('America/Chicago')

sys.path.insert(0, str(ROOT / 'scripts'))
# Re-use the score logic from the parquet replay script so there's
# exactly one Python implementation of computeSilentBoomScore.
from backfill_silent_boom_from_parquet import (  # noqa: E402
    compute_silent_boom_score,
    silent_boom_tier,
    silent_boom_tod_from_minute_ct,
)


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def ct_minute_of_day(ts: datetime) -> int:
    """Mirrors ctMinuteFromUtcMs in api/cron/detect-silent-boom.ts."""
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    local = ts.astimezone(_CT)
    return local.hour * 60 + local.minute


def fetch_rows(
    conn: psycopg2.extensions.connection,
    only_saturated: bool,
) -> list[tuple]:
    """Pull (id, ...) for every row that needs recomputing."""
    where = 'TRUE'
    if only_saturated:
        # ask_pct=1.0 is the cohort whose tier actually changes under
        # the new rule. Everyone else gets the same score either way.
        where = 'ask_pct = 1.0'
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, dte, baseline_volume, spike_ratio, entry_price,
                   ask_pct, option_type, bucket_ct, score, score_tier
            FROM silent_boom_alerts
            WHERE {where}
            ORDER BY id
            """,
        )
        return cur.fetchall()


def recompute(
    rows: list[tuple],
) -> list[tuple[int, int, str]]:
    """Return [(id, new_score, new_tier)] for rows whose score or tier
    actually changes. Rows where the recompute matches the persisted
    value are omitted (no UPDATE needed)."""
    out: list[tuple[int, int, str]] = []
    for r in rows:
        (
            alert_id, dte, baseline_volume, spike_ratio, entry_price,
            ask_pct, option_type, bucket_ct, prior_score, prior_tier,
        ) = r
        tod = silent_boom_tod_from_minute_ct(ct_minute_of_day(bucket_ct))
        score = compute_silent_boom_score(
            dte=int(dte),
            baseline_volume=float(baseline_volume),
            spike_ratio=float(spike_ratio),
            entry_price=float(entry_price),
            ask_pct=float(ask_pct),
            tod=tod,
            option_type=option_type,
        )
        tier = silent_boom_tier(score)
        if prior_score == score and prior_tier == tier:
            continue
        out.append((alert_id, score, tier))
    return out


def apply_updates(
    conn: psycopg2.extensions.connection,
    rows: list[tuple[int, int, str]],
) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            """
            UPDATE silent_boom_alerts AS s
            SET score = v.score::smallint,
                score_tier = v.tier
            FROM (VALUES %s) AS v(id, score, tier)
            WHERE s.id = v.id
            """,
            rows,
            template='(%s, %s, %s)',
            page_size=500,
        )
        conn.commit()
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print summary; do not UPDATE.',
    )
    parser.add_argument(
        '--only-saturated',
        action='store_true',
        help='Restrict to ask_pct = 1.0 rows (the only cohort whose '
             'tier changes under the new rule).',
    )
    args = parser.parse_args()
    load_env()

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        rows = fetch_rows(conn, args.only_saturated)
        scope = 'ask_pct = 1.0 rows' if args.only_saturated else 'all rows'
        print(f'[backfill-ask-demote] scanning {len(rows):,} {scope}')

        changes = recompute(rows)
        # Build the tier-transition tally by zipping inputs to outputs
        # — the recompute throws away the prior tier so we look it up
        # back on the input row tuple (index 9 = score_tier).
        tier_changes: dict[tuple[str, str], int] = {}
        change_by_id = {r[0]: (r[1], r[2]) for r in changes}
        for r in rows:
            if r[0] not in change_by_id:
                continue
            _, new_tier = change_by_id[r[0]]
            key = (r[9] or 'untiered', new_tier)
            tier_changes[key] = tier_changes.get(key, 0) + 1

        print(f'[backfill-ask-demote] {len(changes):,} rows differ from new score')
        for (old, new), n in sorted(
            tier_changes.items(), key=lambda kv: -kv[1],
        ):
            print(f'  {old:>10} → {new:<10} : {n:>5,}')

        if args.dry_run:
            print('[backfill-ask-demote] dry-run — no UPDATEs issued')
            return 0
        n = apply_updates(conn, changes)
        print(f'[backfill-ask-demote] updated {n:,} rows')

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM silent_boom_alerts
                WHERE ask_pct = 1.0 AND score_tier != 'tier3'
                """,
            )
            (leaks,) = cur.fetchone()
        print(
            f'[backfill-ask-demote] post-check: '
            f'{leaks} ask=1.0 rows still on non-tier3',
        )
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
