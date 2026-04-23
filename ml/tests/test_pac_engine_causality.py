"""Causality regression tests for `PACEngine.batch_state`.

These tests catch the A2-sweep Sharpe-inflation bug by checking that
every structure column's value at row T is a pure function of input
rows 0..T. Equivalently: running the engine on a truncated-at-K frame
must give the same rows 0..K as running it on the full frame. Any
lookahead violates this invariant.

## Fixed (this test guards against regression):

- **BOS/CHOCH labeling peek.** smc.bos_choch labels events at the 3rd-most-
  recent swing in a 4-swing pattern, so the label at bar T needs data
  through T + 3*swing_length. Prior shift was 1*swing_length — leaked
  2*swing_length bars. Fixed by shifting BOS/CHOCH/Level_bc/CHOCHPlus
  by 3*swing_length (engine.py).

- **BOS/CHOCH broken-filter peek.** smc.bos_choch removes events whose
  levels were never broken later in the series, so events in the output
  were filtered by future data. Fixed by masking BOS/CHOCH rows to NaN
  when BrokenIndex > current bar (engine.py).

## Known residuals (tracked separately, not asserted here):

- **OB reset.** smc.ob zeroes out an OB when a future high re-crosses
  its top (lines 427-439). Causes *under*-counting rather than
  over-counting (live trader would have seen OBs that the post-hoc
  output erases). Follow-up: causal OB tracker or patched smc
  reimplementation.

- **OB_MitigatedIndex / FVG_MitigatedIndex raw values.** These columns
  store future bar indices. loop.py reads them as `mit <= signal_idx`
  which derives correct "active vs mitigated" state in both
  full-frame and truncated views — the raw column values differ but
  downstream decisions are identical. Excluded from strict column
  comparison; covered by the derived-state test below.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac.engine import PACEngine, PACParams


def _synthetic_ohlc(n_bars: int = 600, seed: int = 42) -> pd.DataFrame:
    """Build deterministic synthetic OHLC with enough swings to fire BOS events."""
    rng = np.random.default_rng(seed)
    t = np.arange(n_bars)
    close = (
        100.0
        + 0.002 * t
        + 3.0 * np.sin(t * 0.08)
        + 1.5 * np.sin(t * 0.3)
        + rng.normal(0.0, 0.4, n_bars).cumsum() * 0.1
    )
    high = close + rng.uniform(0.1, 0.6, n_bars)
    low = close - rng.uniform(0.1, 0.6, n_bars)
    open_ = close + rng.normal(0.0, 0.15, n_bars)

    ts = pd.date_range("2024-01-02 09:30", periods=n_bars, freq="1min", tz="UTC")
    return pd.DataFrame(
        {
            "ts_event": ts,
            "open": open_.astype(np.float64),
            "high": high.astype(np.float64),
            "low": low.astype(np.float64),
            "close": close.astype(np.float64),
            "volume": np.full(n_bars, 1000.0),
            "symbol": "NQ",
        }
    )


# Columns the 2026-04-23 causality pass FULLY fixes — rows 0..T must be
# identical between full-frame and truncated-frame runs. Any divergence
# here is a regression.
STRICT_CAUSAL_COLS = (
    "HighLow",
    "Level_shl",
    "BOS",
    "CHOCH",
    "Level_bc",
    "CHOCHPlus",
    "FVG",
    "FVG_Top",
    "FVG_Bottom",
)

# Columns with known residual differences. See module docstring for why
# each is excluded from strict comparison.
KNOWN_RESIDUAL_COLS = (
    "OB",
    "OB_Top",
    "OB_Bottom",
    "OBVolume",
    "OB_Percentage",
    "OB_MitigatedIndex",
    "FVG_MitigatedIndex",
)


def _first_divergence(a: np.ndarray, b: np.ndarray) -> int | None:
    """Return index of first (a, b) mismatch treating NaN == NaN, else None."""
    mismatch = np.where(
        ~((np.isnan(a) & np.isnan(b)) | (a == b))
    )[0]
    return int(mismatch[0]) if mismatch.size else None


@pytest.mark.parametrize("swing_length", [3, 5, 8])
@pytest.mark.parametrize("truncate_at", [200, 350, 500])
def test_strict_causality_for_fixed_columns(
    swing_length: int, truncate_at: int
) -> None:
    """Columns in STRICT_CAUSAL_COLS must be causal: rows 0..truncate_at-1
    of the full-frame output match the truncated-frame output exactly."""
    df = _synthetic_ohlc()
    params = PACParams(swing_length=swing_length)
    engine = PACEngine(params)

    full_out = engine.batch_state(df).reset_index(drop=True)
    trunc_out = engine.batch_state(df.iloc[:truncate_at].copy()).reset_index(drop=True)
    assert len(trunc_out) == truncate_at

    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)

    divergences: list[str] = []
    for col in STRICT_CAUSAL_COLS:
        if col not in full_window.columns or col not in trunc_out.columns:
            continue
        a = full_window[col].to_numpy(dtype=np.float64, na_value=np.nan)
        b = trunc_out[col].to_numpy(dtype=np.float64, na_value=np.nan)
        first = _first_divergence(a, b)
        if first is not None:
            divergences.append(
                f"{col}: first mismatch at row {first} "
                f"(full={a[first]!r}, truncated={b[first]!r})"
            )

    assert not divergences, (
        f"Causality regression at swing_length={swing_length}, "
        f"truncate_at={truncate_at}. The BOS/CHOCH shift or broken-mask "
        f"fix in engine.py is no longer working:\n  "
        + "\n  ".join(divergences)
    )


@pytest.mark.parametrize("swing_length", [3, 5])
def test_mitigated_index_semantics_match(swing_length: int) -> None:
    """loop.py reads MitigatedIndex as `mit <= signal_idx` which is
    naturally causal — the raw column values can differ between full
    and truncated runs but the derived active/mitigated state must not.

    For every bar T in the truncated window, an OB or FVG at row R is
    considered 'active at T' iff MitigatedIndex[R] is NaN/0 or > T.
    This test confirms that derived state agrees across both runs even
    when the raw MitigatedIndex column doesn't.
    """
    df = _synthetic_ohlc()
    params = PACParams(swing_length=swing_length)
    engine = PACEngine(params)
    truncate_at = 350

    full_out = engine.batch_state(df).reset_index(drop=True)
    trunc_out = engine.batch_state(df.iloc[:truncate_at].copy()).reset_index(drop=True)
    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)

    for col_mit, col_event in (
        ("OB_MitigatedIndex", "OB"),
        ("FVG_MitigatedIndex", "FVG"),
    ):
        if col_mit not in full_window.columns:
            continue
        mit_full = full_window[col_mit].to_numpy(dtype=np.float64, na_value=np.nan)
        mit_trunc = trunc_out[col_mit].to_numpy(dtype=np.float64, na_value=np.nan)
        event_full = full_window[col_event].to_numpy(dtype=np.float64, na_value=np.nan)
        event_trunc = trunc_out[col_event].to_numpy(dtype=np.float64, na_value=np.nan)

        for signal_idx in (100, 180, 250, 340):
            if signal_idx >= truncate_at:
                continue
            # Derived "active at signal_idx" for each row R <= signal_idx.
            for r in range(signal_idx + 1):
                # Skip rows where the event doesn't exist in EITHER view —
                # that's the OB reset / labeling shift residual, not what
                # this test is measuring. We only check rows where both
                # views agree an event is present, and verify the
                # mitigation state derived from MitigatedIndex matches.
                ef, et = event_full[r], event_trunc[r]
                both_present = (
                    not np.isnan(ef) and ef != 0
                    and not np.isnan(et) and et != 0
                )
                if not both_present:
                    continue
                mf, mt = mit_full[r], mit_trunc[r]

                def _active(mit: float, sig: int) -> bool:
                    if np.isnan(mit) or mit == 0:
                        return True
                    return mit > sig

                assert _active(mf, signal_idx) == _active(mt, signal_idx), (
                    f"{col_mit} derived-state mismatch at row {r} "
                    f"(signal_idx={signal_idx}): full mit={mf}, trunc mit={mt} "
                    f"— one view says active, the other says mitigated."
                )


@pytest.mark.xfail(
    reason=(
        "smc.ob reset step (lines 427-439) zeroes OBs when a future high "
        "re-crosses the top. Causes under-counting in full-frame runs "
        "(live trader would have seen OBs the full-frame output erases). "
        "Follow-up: causal OB tracker. Not blocking the A2 Sharpe fix."
    ),
    strict=True,
)
def test_ob_reset_residual_is_known() -> None:
    """Documents the remaining OB causality issue. Flagged xfail(strict=True)
    so if we ever fix it, the test will go green and alert us to update
    the docstring.
    """
    df = _synthetic_ohlc()
    engine = PACEngine(PACParams(swing_length=3))
    truncate_at = 200
    full_out = engine.batch_state(df).reset_index(drop=True)
    trunc_out = engine.batch_state(df.iloc[:truncate_at].copy()).reset_index(drop=True)
    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)
    a = full_window["OB"].to_numpy(dtype=np.float64, na_value=np.nan)
    b = trunc_out["OB"].to_numpy(dtype=np.float64, na_value=np.nan)
    assert _first_divergence(a, b) is None
