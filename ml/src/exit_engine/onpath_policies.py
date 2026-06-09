"""Same-basis (mid) baseline exit policies recomputed on the engine's own paths,
so the benchmark compares like-for-like (the stored realized_* columns are
trade-price basis)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from exit_engine.backtest import realized_return_for_exit
from exit_engine.rule_family import decide_exit_index_vec


def onpath_baselines(rows: pd.DataFrame) -> dict:
    """Cost-netted realized % for trail-30/10, hard-30m, tier-50-hold-EOD, hold-EOD
    on this fire's mid path."""
    rows = rows.reset_index(drop=True)
    ret = rows["ret_from_entry_pct"].to_numpy(dtype="float64")
    mse = rows["minutes_since_entry"].to_numpy(dtype="float64")
    n = len(rows)
    last = n - 1

    trail_idx = decide_exit_index_vec(ret, mse, 30.0, 10.0, 100000)
    in_time = np.nonzero(mse <= 30.0)[0]
    hard_idx = int(in_time[-1]) if in_time.size else 0
    fifty = np.nonzero(ret >= 50.0)[0]
    if fifty.size:
        leg1 = realized_return_for_exit(rows, int(fifty[0]))
        leg2 = realized_return_for_exit(rows, last)
        tier = (leg1 + leg2) / 2.0
    else:
        tier = realized_return_for_exit(rows, last)

    return {
        "trail30_10": realized_return_for_exit(rows, trail_idx),
        "hard30m": realized_return_for_exit(rows, hard_idx),
        "tier50_holdeod": tier,
        "eod": realized_return_for_exit(rows, last),
    }
