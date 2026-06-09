"""Turn per-fire exit decisions into cost-netted realized returns and
benchmark/leakage tables. Equal-weight per trade == real P&L at equal sizing."""
from __future__ import annotations

import pandas as pd

from exit_engine.costs import apply_costs


def realized_return_for_exit(fire_rows: pd.DataFrame, exit_idx: int) -> float:
    """Cost-netted % return for exiting a single fire at row exit_idx."""
    fire_rows = fire_rows.reset_index(drop=True)
    entry_price = float(fire_rows["entry_price"].iloc[0])
    exit_mid = float(fire_rows["mid"].iloc[exit_idx])
    gross = (exit_mid - entry_price) / entry_price * 100.0
    entry_spread_pct = float(fire_rows["spread_pct"].iloc[0])
    return apply_costs(gross, entry_price, entry_spread_pct)


def equal_weight_mean(decisions: pd.DataFrame, col: str = "realized_pct") -> float:
    """Mean realized % across fires, equal weight (== P&L at equal dollar sizing)."""
    return float(decisions[col].mean())


def stratify_lift(df: pd.DataFrame, by: str, lift_col: str = "lift") -> dict:
    """Group mean lift by a bucket column; flag the leakage fingerprint
    (near-uniform lift across every bucket)."""
    g = df.groupby(by)[lift_col].mean()
    spread = float(g.max() - g.min())
    return {
        "by_bucket": g.to_dict(),
        "spread": spread,
        # uniform across buckets (spread within 1pp) on a real signal is the
        # leakage fingerprint -- genuine edge concentrates.
        "uniform_flag": bool(spread < 1.0 and len(g) >= 2),
    }


def benchmark_table(fires_meta: pd.DataFrame, decision_pct: pd.Series) -> pd.DataFrame:
    """Assemble equal-weight mean realized % for the engine vs stored policies.

    fires_meta has one row per fire with the stored realized_* + peak columns;
    decision_pct is the engine's realized % indexed by fire_id.
    """
    meta = fires_meta.set_index("fire_id")
    meta = meta.assign(engine_pct=decision_pct)
    cols = {
        "engine": "engine_pct",
        "trail30_10": "realized_trail30_10_pct",
        "hard30m": "realized_hard30m_pct",
        "tier50_holdeod": "realized_tier50_holdeod_pct",
        "flow_inversion": "realized_flow_inversion_pct",
        "eod": "realized_eod_pct",
        "peak_ceiling(unreal)": "peak_ceiling_pct",
    }
    out = []
    for label, col in cols.items():
        if col in meta:
            s = pd.to_numeric(meta[col], errors="coerce").dropna()
            out.append({"policy": label, "n": int(s.size),
                        "mean_pct": float(s.mean()), "median_pct": float(s.median())})
    return pd.DataFrame(out)
