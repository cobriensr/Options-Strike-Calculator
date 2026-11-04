#!/usr/bin/env python
"""Manual check: stored lottery scores equal the component sum.

READS THE PRODUCTION DATABASE. Run it by hand; it is not a test and pytest
does not collect it (the name does not start with ``test_``). It was once
``ml/tests/test_score_components.py::test_live_db_sum_invariant``, deleted on
2026-11-04 because a test must never connect to whatever DATABASE_URL the
shell exports (docs/superpowers/specs/tests-no-db-2026-11-04.md).

It samples 100 random scored rows from ``lottery_finder_fires`` (one
read-only SELECT in a read-only session), recomputes each row's score with
``score_components.compute_components`` using the live
``ml/output/lottery_score_weights.json``, and compares the totals. Up to 5%
of rows may differ: the live cron writes new fires every 5 minutes, so rows
can be scored with weights newer than the JSON snapshot. More than that
means the helper is structurally wrong.

Usage (DATABASE_URL must be exported; the script does not read .env files):

    ml/.venv/Scripts/python scripts/check_lottery_score_sum_invariant.py

Exit code 0 when the mismatch rate is within 5%, 1 when it is not, 2 when
DATABASE_URL or the weights file is missing.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml" / "src"))

from score_components import compute_components  # noqa: E402

WEIGHTS_PATH = ROOT / "ml" / "output" / "lottery_score_weights.json"
SAMPLE_SIZE = 100
MAX_MISMATCH_RATE = 0.05

SAMPLE_QUERY = """
SELECT underlying_symbol, tod, dte, option_type,
       trigger_vol_to_oi_window, gamma_at_trigger, trigger_ask_pct,
       score
FROM lottery_finder_fires
WHERE score IS NOT NULL
ORDER BY random()
LIMIT %s
"""


def _optional_float(value) -> float | None:
    return float(value) if value is not None else None


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not exported.", file=sys.stderr)
        return 2
    if not WEIGHTS_PATH.exists():
        print(f"Weights JSON not found at {WEIGHTS_PATH}", file=sys.stderr)
        return 2

    weights = json.loads(WEIGHTS_PATH.read_text())
    conn = psycopg2.connect(database_url)
    try:
        conn.set_session(readonly=True)
        cur = conn.cursor()
        cur.execute(SAMPLE_QUERY, (SAMPLE_SIZE,))
        rows = cur.fetchall()
    finally:
        conn.close()

    mismatches: list[dict] = []
    for ticker, tod, dte, option_type, vol_oi, gamma, ask_pct, score in rows:
        fire = {
            "ticker": ticker,
            "tod": tod,
            "dte": int(dte),
            "option_type": option_type,
            "vol_oi_window": _optional_float(vol_oi),
            "gamma": _optional_float(gamma),
            "ask_pct": _optional_float(ask_pct),
        }
        components = compute_components(fire, weights)
        if components["total"] != int(score):
            mismatches.append(
                {
                    "expected": int(score),
                    "got": components["total"],
                    "diff": components["total"] - int(score),
                    "fire": {**fire, "components": components},
                }
            )

    rate = len(mismatches) / max(len(rows), 1)
    print(f"{len(mismatches)}/{len(rows)} fires mismatch (rate {rate:.1%}).")
    if rate > MAX_MISMATCH_RATE:
        print(f"First 3 mismatches: {mismatches[:3]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
