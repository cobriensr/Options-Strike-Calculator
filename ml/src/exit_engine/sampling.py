"""Stratified fire subsampling for model training (sample-train / full-eval)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def stratified_fire_sample(fire_meta: pd.DataFrame, target: int, seed: int = 13) -> list[int]:
    """Sample ~target fire_ids, proportionally across (date, mode) strata. Returns
    all fire_ids if target >= population."""
    fire_meta = fire_meta.drop_duplicates("fire_id")
    n = len(fire_meta)
    if target >= n:
        return fire_meta["fire_id"].tolist()
    rng = np.random.default_rng(seed)
    frac = target / n
    out: list[int] = []
    for _, grp in fire_meta.groupby(["date", "mode"], observed=True):
        k = int(round(len(grp) * frac))
        k = max(1, min(k, len(grp)))
        out.extend(rng.choice(grp["fire_id"].to_numpy(), size=k, replace=False).tolist())
    return out
