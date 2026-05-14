"""Pure functions for the Periscope gamma-level edge experiment.

Imported by ml/src/periscope_eda/05_gamma_wall_reversal.py (runner)
and ml/tests/test_periscope_gamma_wall_lib.py (unit tests).

No DB I/O. No file I/O. No plotting. Pure data transforms.

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

from datetime import timedelta
from typing import Literal

import pandas as pd

TOUCH_TOLERANCE_PTS = 1.0
REVERSAL_THRESHOLD_PTS = 2.0
REVERSAL_WINDOW_MIN = 15
DISTANCE_BUCKET_EDGES = [0.0, 3.0, 7.0, 15.0]
PRIMARY_BUCKETS = {"3-7", "7-15"}
MAGNET_MIN_DISTANCE_PTS = 3.0
CHARM_ZERO_MIN_DISTANCE_PTS = 1.0

WallType = Literal["ceiling", "floor"]
