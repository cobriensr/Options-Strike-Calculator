"""Tests for `pac.causal_smc` — causal reimplementations of smc primitives.

Two layers of coverage:

1. **Parity** — on arbitrary OHLC, `causal_order_blocks` must produce
   output identical to `smc.ob` EXCEPT at bars where the upstream
   retroactive-reset step would have fired. All other columns (OB,
   Top, Bottom, OBVolume, Percentage, MitigatedIndex) must match
   bit-for-bit.

2. **Causality** — output at row T must be a pure function of input
   rows 0..T. This is what the strict parametrized test in
   `test_pac_engine_causality.py` exercises; here we just sanity
   check a single case.

The parity fixture is deterministic so any future divergence from smc
shows up as a concrete test failure, not a probabilistic flake.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd
import pytest

os.environ.setdefault("SMC_CREDIT", "0")
from smartmoneyconcepts import smc  # noqa: E402

from pac.causal_smc import causal_order_blocks  # noqa: E402


def _synthetic_ohlc(n: int = 600, seed: int = 42) -> pd.DataFrame:
    """Deterministic OHLC with enough swings that smc.ob finds and
    potentially resets many OBs — exactly the surface where the two
    implementations should diverge."""
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    close = (
        100.0
        + 0.003 * t
        + 3.0 * np.sin(t * 0.08)
        + 1.5 * np.sin(t * 0.3)
        + rng.normal(0.0, 0.4, n).cumsum() * 0.1
    )
    high = close + rng.uniform(0.1, 0.6, n)
    low = close - rng.uniform(0.1, 0.6, n)
    open_ = close + rng.normal(0.0, 0.15, n)
    ts = pd.date_range("2024-01-02 09:30", periods=n, freq="1min", tz="UTC")
    return pd.DataFrame(
        {
            "ts_event": ts,
            "open": open_.astype(np.float64),
            "high": high.astype(np.float64),
            "low": low.astype(np.float64),
            "close": close.astype(np.float64),
            "volume": rng.integers(800, 1200, n).astype(np.float64),
        }
    )


@pytest.mark.parametrize("swing_length", [3, 5, 8])
@pytest.mark.parametrize("close_mitigation", [False, True])
def test_parity_with_smc_ob_except_reset(
    swing_length: int, close_mitigation: bool
) -> None:
    """Causal output == smc.ob output on every row where smc didn't reset.

    Rows where smc.ob has OB=NaN but causal_order_blocks has OB=±1 are
    the "OBs that smc erased in hindsight" — those are the whole point
    of this module, so we verify they DIVERGE in the expected direction
    (causal keeps, smc erases) and match everywhere else.
    """
    df = _synthetic_ohlc()
    shl = smc.swing_highs_lows(df, swing_length=swing_length)
    smc_out = smc.ob(df, shl, close_mitigation=close_mitigation)
    causal_out = causal_order_blocks(df, shl, close_mitigation=close_mitigation)

    assert len(smc_out) == len(causal_out)
    assert list(smc_out.columns) == list(causal_out.columns)

    smc_ob = smc_out["OB"].to_numpy(dtype=np.float64, na_value=np.nan)
    causal_ob = causal_out["OB"].to_numpy(dtype=np.float64, na_value=np.nan)

    # Rows where smc has NaN but causal has a value → OBs smc erased.
    erased_by_smc = np.isnan(smc_ob) & ~np.isnan(causal_ob)
    # Rows where causal has NaN but smc has a value → should never happen,
    # would indicate detection divergence (not a reset difference).
    erased_by_causal = ~np.isnan(smc_ob) & np.isnan(causal_ob)

    assert not erased_by_causal.any(), (
        f"Detection divergence with swing_length={swing_length}, "
        f"close_mitigation={close_mitigation}: causal erased {erased_by_causal.sum()} "
        f"OBs that smc.ob detected. First mismatch row: "
        f"{int(np.nonzero(erased_by_causal)[0][0])}"
    )

    # Everywhere both see an OB, every column must match exactly.
    both_have = ~np.isnan(smc_ob) & ~np.isnan(causal_ob)
    if both_have.any():
        for col in ("OB", "Top", "Bottom", "OBVolume", "Percentage", "MitigatedIndex"):
            a = smc_out[col].to_numpy(dtype=np.float64, na_value=np.nan)[both_have]
            b = causal_out[col].to_numpy(dtype=np.float64, na_value=np.nan)[both_have]
            np.testing.assert_allclose(
                a, b, rtol=1e-9, atol=1e-9,
                err_msg=(
                    f"Column {col} mismatch with swing_length={swing_length}, "
                    f"close_mitigation={close_mitigation}"
                ),
            )

    # We expect AT LEAST ONE reset-erased OB to exist on this fixture at
    # short swing_length — otherwise we're not actually testing the
    # reset behavior. At swing_length=8 the fixture may not produce any.
    if swing_length <= 5:
        assert erased_by_smc.any(), (
            f"Test fixture failed to exercise the reset code path at "
            f"swing_length={swing_length}. Adjust _synthetic_ohlc or "
            f"the parametrization."
        )


def test_causality_single_truncation() -> None:
    """Sanity-check: causal_order_blocks on df[:K] equals causal_order_blocks
    on df, rows 0..K-1. The strict parametrized test in
    test_pac_engine_causality.py handles the full invariant; this is
    just to catch regressions locally without importing the full engine.
    """
    df = _synthetic_ohlc()
    shl_full = smc.swing_highs_lows(df, swing_length=5)
    full_out = causal_order_blocks(df, shl_full, close_mitigation=False)

    truncate_at = 300
    df_trunc = df.iloc[:truncate_at].copy()
    shl_trunc = smc.swing_highs_lows(df_trunc, swing_length=5)
    trunc_out = causal_order_blocks(df_trunc, shl_trunc, close_mitigation=False)

    # NOTE: shl itself is not causal (its dedup erases swings), so this
    # test's ceiling is "causal_order_blocks given the same shl input
    # produces identical rows in the overlap." The broader causality
    # test in test_pac_engine_causality.py exercises the full pipeline.
    # Here we just check no bar in the overlap was mutated by the
    # extension of input beyond truncate_at.
    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)

    # Only compare rows where shl itself didn't disagree between views.
    shl_hl_full = shl_full["HighLow"].to_numpy(dtype=np.float64, na_value=np.nan)[:truncate_at]
    shl_hl_trunc = shl_trunc["HighLow"].to_numpy(dtype=np.float64, na_value=np.nan)
    shl_agree = (np.isnan(shl_hl_full) & np.isnan(shl_hl_trunc)) | (shl_hl_full == shl_hl_trunc)

    # OB / Top / Bottom / OBVolume / Percentage encode "what was detected."
    # These must match between views — they're set at detection time and
    # never mutated afterward.
    #
    # MitigatedIndex intentionally differs: it stores a future bar index
    # (the bar mitigation was observed). In the truncated view, if
    # mitigation hasn't happened yet it stays 0; in the full view it
    # holds the later bar. Both are correct w.r.t. their data slice and
    # loop.py consumes the column as `mit <= signal_idx` which derives
    # the same active/mitigated state in either case. Excluded from
    # strict comparison — same pattern as FVG_MitigatedIndex in
    # test_pac_engine_causality.py.
    for col in ("OB", "Top", "Bottom", "OBVolume", "Percentage"):
        a = full_window[col].to_numpy(dtype=np.float64, na_value=np.nan)
        b = trunc_out[col].to_numpy(dtype=np.float64, na_value=np.nan)
        diffs_where_shl_agrees = ~(
            (np.isnan(a) & np.isnan(b)) | (a == b)
        ) & shl_agree
        assert not diffs_where_shl_agrees.any(), (
            f"Causal OB column {col} diverges at row "
            f"{int(np.nonzero(diffs_where_shl_agrees)[0][0])} between "
            f"full and truncated runs, on a bar where shl agreed. "
            f"That's a causality bug in causal_order_blocks."
        )
