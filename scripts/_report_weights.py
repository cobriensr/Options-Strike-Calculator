"""The active lottery weights and the feed's tiers, for the research reports.

The reports that read Neon tier fires the way the feed does (owner ruling,
2026-11-19; phase 3's D8): each fire's quality-adjusted score (qas) against the
feed cutoffs of the ACTIVE weights version, read from the store. This module is
the one place that rule lives:

* `load_active_weights(conn, tag)` reads the active pointer, or ends the run.
  A report that cannot name the weights it describes writes nothing, and never
  falls back to other cutoffs or to the frozen JSON (R4).
* `tier_labels(fires, cutoffs)` is the feed's T1 / T2 / T3, from
  `lottery_refit_gates.feed_qas`, the Python mirror of the feed.
* `tier_header(version, cutoffs)` is the report text that names the weights.

Importing it puts `ml/src` on `sys.path` (so `lottery_weights` and
`lottery_refit_gates` import, whichever folder the script runs from) and
nothing heavier than numpy, pandas and psycopg2 is loaded.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'ml' / 'src'))
from lottery_refit_gates import FeedCutoffs, feed_qas  # noqa: E402
from lottery_weights import WeightsInvalid, load_pointer  # noqa: E402

__all__ = [
    'LOOK_AHEAD_NOTE',
    'FeedCutoffs',
    'load_active_weights',
    'tier_header',
    'tier_labels',
]

LOOK_AHEAD_NOTE = (
    "inversion_quintile is the ticker's current value, not the value when each "
    'fire fired (look-ahead), as on the feed'
)


def load_active_weights(conn: Any, tag: str) -> tuple[str, Mapping[str, Any]]:
    """The active weights' version and their full, validated weights object.

    Any failure to read them ends the run: `sys.exit` with a `[tag]` message
    that names the exception class and, for `WeightsInvalid` (a path and a
    rule) and `LookupError` (no active pointer), its text. The text of a
    database error is never echoed: it can hold the DSN. Nothing else is
    caught, so a bug still shows as a traceback.
    """
    try:
        return load_pointer(conn, 'active')
    except (WeightsInvalid, LookupError, psycopg2.Error) as exc:
        detail = (
            type(exc).__name__
            if isinstance(exc, psycopg2.Error)
            else f'{type(exc).__name__}: {exc}'
        )
        sys.exit(
            f'[{tag}] cannot read the active lottery weights ({detail}); '
            'no report written'
        )


def tier_labels(fires: pd.DataFrame, cutoffs: FeedCutoffs) -> pd.Series:
    """T1 / T2 / T3 as the feed tiers each fire: its qas against the cutoffs.

    `fires` carries the stored `score` and the three columns the feed adds
    (`round_trip_score_deduct`, `direction_gated`, `inversion_quintile`). qas
    is NaN for the fires the feed forces to tier 3 (a NULL score,
    direction_gated, an inversion quintile of 1 or 2), and NaN fails both
    comparisons.
    """
    qas = feed_qas(fires['score'], fires)
    labels = np.where(
        qas >= cutoffs.tier1_min_score,
        'T1',
        np.where(qas >= cutoffs.tier2_min_score, 'T2', 'T3'),
    )
    return pd.Series(labels, index=fires.index, name='tier')


def tier_header(version: str, cutoffs: FeedCutoffs) -> str:
    """The report lines that say which weights the tiers come from."""
    return (
        f'Active lottery weights: {version}\n'
        f'T1 = qas ≥ {cutoffs.tier1_min_score}, T2 = qas ≥ {cutoffs.tier2_min_score} '
        f'(feed cutoffs of version {version})\n'
        "qas is the feed's quality-adjusted score; a fire the feed forces to "
        'tier 3 (NULL score, direction-gated, inversion quintile 1 or 2) is T3.\n'
        f'{LOOK_AHEAD_NOTE}\n'
    )
