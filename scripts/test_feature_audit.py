"""Tests for the feed-tier mirror in scripts/feature_audit.py.

The feed tiers a fire on qas = GREATEST(0, score) + inversion bonus and leaves
the round-trip deduct out (docs/superpowers/specs/2026-11-17-freeze-tier-at-fire-design.md).
The audit's "Tier 2+" subset must be the population the feed shows, so these
tests pin the qas formula. `combined_score` is a decoy in every row: it still
carries the deduct and the old gamma +1, so a tier read from it disagrees with
the feed on exactly the rows the cases below build.

The audit tiers through `feature_audit.add_feed_tiers`, which is
`_report_weights.tier_labels` and `lottery_refit_gates.feed_qas` against the
active weights' `feed_cutoffs`. The fixture weights below set those cutoffs to
13/10 explicitly, so each case's tier is the one the cutoffs give and does not
depend on a default. Run:

    ml/.venv/Scripts/pytest scripts/test_feature_audit.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _report_weights import FeedCutoffs  # noqa: E402
from feature_audit import add_feed_tiers  # noqa: E402

# The active weights' feed cutoffs for these cases: tier 1 at qas 13, tier 2 at 10.
WEIGHTS = {'feed_cutoffs': {'tier1_min_score': 13, 'tier2_min_score': 10}}
CUTOFFS = FeedCutoffs.from_weights(WEIGHTS)


def _frame(score, combined_score, quintile, gated):
    return pd.DataFrame(
        {
            'score': [score],
            'combined_score': [combined_score],
            'inversion_quintile': [quintile],
            'direction_gated': [gated],
        }
    )


@pytest.mark.parametrize(
    ('score', 'combined_score', 'quintile', 'gated', 'qas', 'tier', 'eligible'),
    [
        # The bonus lifts a score over the tier 1 cutoff (13): 12 + 3.
        (12, 12, 4, False, 15, 'T1', True),
        # A -3 deduct is in combined_score (10) but not in the feed's qas.
        (13, 10, 3, False, 13, 'T1', True),
        # The gamma +1 is in combined_score (10) but not in the feed's qas.
        (9, 10, 3, False, 9, 'T3', True),
        # Exactly the tier 2 cutoff (10).
        (10, 10, 3, False, 10, 'T2', True),
        # A negative stored score is floored at 0 before the bonus: 0 + 5, not -5 + 5.
        (-5, 0, 5, False, 5, 'T3', True),
        # No score (bonus alone would be 5): the feed shows tier 3. The shared
        # `feed_qas` gives a forced tier 3 fire no qas (NaN), so it is not eligible.
        (None, None, 5, False, None, 'T3', False),
        # Direction-gated rows are forced to tier 3 whatever their qas (20): NaN.
        (20, 20, 3, True, None, 'T3', False),
        # Quintile 1 and 2 are hidden by the feed's default view (20 - 2 = 18): NaN.
        (20, 20, 2, False, None, 'T3', False),
        # A cold-start ticker has no quintile and no bonus; a NULL gate is not gated.
        (13, 13, None, None, 13, 'T1', True),
    ],
    ids=[
        'bonus lifts to tier1',
        'deduct is left out',
        'gamma plus one is left out',
        'tier2 cutoff',
        'negative score floored',
        'null score',
        'direction gated',
        'suppressed quintile',
        'cold start',
    ],
)
def test_add_feed_tiers_mirrors_the_feed(
    score, combined_score, quintile, gated, qas, tier, eligible
):
    got = add_feed_tiers(_frame(score, combined_score, quintile, gated), CUTOFFS)
    if qas is None:
        assert pd.isna(got['qas'].iloc[0])
    else:
        assert got['qas'].iloc[0] == qas
    assert got['tier'].iloc[0] == tier
    assert bool(got['tier_eligible'].iloc[0]) is eligible


def test_add_feed_tiers_does_not_read_combined_score():
    # The audit's SELECT drops combined_score, so the function must not need it.
    df = _frame(13, 0, 3, False).drop(columns=['combined_score'])
    got = add_feed_tiers(df, CUTOFFS)
    assert got['qas'].iloc[0] == 13
    assert got['tier'].iloc[0] == 'T1'
