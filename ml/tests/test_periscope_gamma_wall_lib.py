"""Tests for ml/src/periscope_gamma_wall_lib.py."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from periscope_gamma_wall_lib import (
    CHARM_ZERO_MIN_DISTANCE_PTS,
    DISTANCE_BUCKET_EDGES,
    MAGNET_MIN_DISTANCE_PTS,
    PRIMARY_BUCKETS,
    REVERSAL_THRESHOLD_PTS,
    REVERSAL_WINDOW_MIN,
    TOUCH_TOLERANCE_PTS,
)


def test_constants_match_spec():
    assert TOUCH_TOLERANCE_PTS == 1.0
    assert REVERSAL_THRESHOLD_PTS == 2.0
    assert REVERSAL_WINDOW_MIN == 15
    assert DISTANCE_BUCKET_EDGES == [0.0, 3.0, 7.0, 15.0]
    assert PRIMARY_BUCKETS == {"3-7", "7-15"}
    assert MAGNET_MIN_DISTANCE_PTS == 3.0
    assert CHARM_ZERO_MIN_DISTANCE_PTS == 1.0
