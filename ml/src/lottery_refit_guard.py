"""Temporary guard: block the nightly lottery refits while fires are unclassified.

WHY: the multileg classifier is retired, so ``lottery_finder_fires.
inferred_structure`` is NULL on every fire inserted after commit 671a06a8
(deployed 2026-10-29). Both nightly refits now train on
``anchor_leg_kind = 'single'`` (``SINGLE_LEG_FILTER`` in lottery_scoring.py) as
their "not a spread leg" filter:

  - ml/src/lottery_scoring.py (FETCH_QUERY)
  - scripts/online_ticker_update.py (TODAY_QUERY)

``anchor_leg_kind`` (migration #197) exists only on fires inserted after the
2026-10-29 18:22 CT deploy. Older fires are NULL, which the filter excludes, so
a refit now would train on a few days of rows and silently change the V2
weights and tiers (``lottery-score-weights-v2.ts``). Owner decision
(2026-10-29): refuse to train instead, so the live weights stay exactly as they
are.

A third site is guarded too: scripts/backfill_lottery_scores.py. It re-scores
stored fires, and even with unchanged weights its left-closed quintile bounds
(``<``) differ from the right-closed ones the runtime, sync and training use,
so it would rewrite the scores of every fire sitting exactly on a boundary.
(Its ``--dry-run`` writes nothing and is not blocked.)

A skip exits 0 and writes nothing. ``ml/output/lottery_score_weights.json`` is
untouched, so the following ``sync_lottery_score_weights_v2.py`` re-renders the
same TS from the same JSON (idempotent), the backfill is skipped, and
``make update`` carries on.

REMOVAL: delete this module and all three call sites when all of these hold:
(a) ``anchor_leg_kind`` is backfilled from the full tape for the 90-day
training window; (b) the outcome backfill has landed and the old bug signature
(flow_inv > peak * 1.05) has been measured, per the "Refit" section of
docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md; (c) the
two phase-4 fixes in that spec are in: the backfill's ``<`` vs ``<=`` boundary
rewrite, and the EMA's evening no-op, since ``TODAY_QUERY`` uses
``date = CURRENT_DATE`` in Neon (session time zone GMT). See also
docs/superpowers/specs/2026-10-28-classifier-replacement-design.md.
"""

from __future__ import annotations

import sys
from datetime import date

# First trade date whose fires may carry no classifier label.
UNCLASSIFIED_FROM = date(2026, 10, 29)

_BAR = "═" * 64


def refit_blocked(window_end: date) -> bool:
    """True when a training window ending at ``window_end`` can include
    post-cutoff (unclassified) rows. Both queries are open-ended up to today,
    so ``window_end`` is today's local date.

    Local ``date.today()`` is never earlier than the date of any existing fire:
    fires dated D (``CURRENT_DATE`` in Neon, GMT) exist only after about
    13:30 UTC on D, when every time zone at or east of UTC-12 is already on D.
    """
    return window_end >= UNCLASSIFIED_FROM


def skip_message(script: str) -> str:
    """The loud, framed block a guarded script prints before skipping."""
    return "\n".join(
        [
            _BAR,
            f"REFIT BLOCKED: {script} did NOT run.",
            f"  Fires dated >= {UNCLASSIFIED_FROM.isoformat()} have no "
            "classifier label, and the",
            "  anchor_leg_kind training filter has no history yet, so a refit "
            "would shift the V2 weights.",
            "  Weights left unchanged. Guard comes off when anchor_leg_kind "
            "is backfilled for the",
            "  training window (see ml/src/lottery_refit_guard.py).",
            _BAR,
        ]
    )


def announce_skip(script: str) -> None:
    """Print the skip block to stdout and stderr so it can't be missed."""
    msg = skip_message(script)
    print(msg, flush=True)
    print(msg, file=sys.stderr, flush=True)
