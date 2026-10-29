"""Temporary guard: block the nightly lottery refits while fires are unclassified.

WHY: commit 671a06a8 (deployed 2026-10-29) stopped the lottery cron from calling
the multileg classifier, so ``lottery_finder_fires.inferred_structure`` is NULL
on every row inserted after that deploy. (2,448 of the 3,106 rows dated
2026-10-29 still carry a label, so the date cutoff below is deliberately
conservative.) Both nightly refits train on ``inferred_structure IS NULL`` as
their "not a spread leg" filter:

  - ml/src/lottery_scoring.py (FETCH_QUERY)
  - scripts/online_ticker_update.py (TODAY_QUERY)

Until now that filter kept ~0.8% of fires (1,436 of 184,720; a 196-row refit
set). From the cutoff on it would admit nearly every fire, spread legs
included, and silently change the V2 weights and tiers
(``lottery-score-weights-v2.ts``). Owner decision (2026-10-29): refuse to train
instead, so the live weights stay exactly as they are.

A third site is guarded too: scripts/backfill_lottery_scores.py. It re-scores
stored fires, and even with unchanged weights its left-closed quintile bounds
(``<``) differ from the right-closed ones the runtime, sync and training use,
so it would rewrite the scores of every fire sitting exactly on a boundary.
(Its ``--dry-run`` writes nothing and is not blocked.)

A skip exits 0 and writes nothing. ``ml/output/lottery_score_weights.json`` is
untouched, so the following ``sync_lottery_score_weights_v2.py`` re-renders the
same TS from the same JSON (idempotent), the backfill is skipped, and
``make update`` carries on.

REMOVAL: delete this module and all three call sites when the classifier
replacement ships and both training queries filter on ``anchor_leg_kind``
(migration #197) instead of ``inferred_structure``. See
docs/superpowers/specs/2026-10-28-classifier-replacement-design.md. Removing
the guard also turns back on two things that need their own fix first, both in
docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md
phase 4: (i) the backfill's ``<`` vs ``<=`` boundary rewrite, and (ii) the
EMA's evening no-op, since ``TODAY_QUERY`` uses ``date = CURRENT_DATE`` in Neon
(session time zone GMT).
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
            f"  Fires dated >= {UNCLASSIFIED_FROM.isoformat()} have "
            "inferred_structure NULL (the classifier is no longer called),",
            "  so the training filter would admit spread legs and shift the "
            "V2 weights and tiers.",
            "  Weights left unchanged. Guard comes off when the queries move "
            "to anchor_leg_kind",
            "  (see ml/src/lottery_refit_guard.py).",
            _BAR,
        ]
    )


def announce_skip(script: str) -> None:
    """Print the skip block to stdout and stderr so it can't be missed."""
    msg = skip_message(script)
    print(msg, flush=True)
    print(msg, file=sys.stderr, flush=True)
