"""Forward-from-current-mark labels for the upside-remaining model."""
from __future__ import annotations

import numpy as np
import pandas as pd


def add_labels(path: pd.DataFrame, theta: float) -> pd.DataFrame:
    """Add forward_ratio, y_has_upside (0/1), y_log_upside to a minute path.

    forward_ratio_t = max(mid[t:]) / mid[t]  (>= 1.0, upside measured from here).
    """
    out = path.copy()
    mid = out["mid"].to_numpy(dtype="float64")
    # reverse cumulative max = future max from each index onward
    future_max = np.maximum.accumulate(mid[::-1])[::-1]
    ratio = np.where(mid > 0, future_max / mid, 1.0)
    out["forward_ratio"] = ratio
    out["y_has_upside"] = (ratio - 1.0 >= theta).astype("int8")
    out["y_log_upside"] = np.log1p(np.clip(ratio - 1.0, 0.0, None))
    return out
