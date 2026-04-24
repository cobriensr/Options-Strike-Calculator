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

- **swing_highs_lows dedup erasure.** smc.swing_highs_lows runs a
  dedup loop (lines 165-193) that removes same-type consecutive
  swings retroactively when a later swing is more extreme. This can
  erase a swing that was visible in the truncated view. Causes
  *under*-counting rather than lookahead — biases backtests toward
  fewer signals, not more.

- **OB reset.** smc.ob zeroes out an OB when a future high re-crosses
  its top (lines 427-439). Same direction as above — under-counts
  rather than inflates.

- **OB_MitigatedIndex / FVG_MitigatedIndex raw values.** These columns
  store future bar indices. loop.py reads them as `mit <= signal_idx`
  which derives correct "active vs mitigated" state in both
  full-frame and truncated views — the raw column values differ but
  downstream decisions are identical. Excluded from strict column
  comparison; covered by the derived-state test below.

**Why all three are acceptable to defer for the A2 fix:** they depress
Sharpe (fewer signals than ideal), they don't inflate it. The
mechanism that produced 1m_2022's Sharpe 9.8 was the BOS/CHOCH
labeling + broken-filter peek — over-counting signals that weren't
yet confirmable. That's what this fix addresses.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pac.engine import PACEngine, PACParams


def _synthetic_ohlc(n_bars: int = 600, seed: int = 42) -> pd.DataFrame:
    """Sine+random-walk fixture. Evenly-spaced swings — useful for smoke
    testing but not representative of real market swing spacing.
    """
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


def _synthetic_ohlc_trending(n_bars: int = 600, seed: int = 7) -> pd.DataFrame:
    """Wide-swing trending fixture — long low-volatility drifts punctuated
    by sharp reversals. This is the shape that makes a uniform-shift
    causality fix fail: swings can be 40-80 bars apart, so any fixed
    lag smaller than the actual swing spacing leaks future data.

    Reviewer concern (2026-04-23): sine-based fixtures hide this class
    of bug because swings are evenly and closely spaced. Real markets
    that inflated the A2 1m_2022 Sharpe were wide-swing trending days.
    """
    rng = np.random.default_rng(seed)
    # Alternating 50-80 bar drift segments. Each segment has a small
    # trend and low noise; transitions are sharp reversal candles.
    segments: list[np.ndarray] = []
    direction = 1.0
    level = 100.0
    while sum(len(s) for s in segments) < n_bars:
        seg_len = int(rng.integers(40, 85))
        slope = direction * float(rng.uniform(0.01, 0.05))
        noise = rng.normal(0.0, 0.15, seg_len)
        seg = level + slope * np.arange(seg_len) + noise.cumsum() * 0.2
        segments.append(seg)
        level = float(seg[-1])
        direction *= -1.0
    close = np.concatenate(segments)[:n_bars]
    high = close + rng.uniform(0.2, 1.0, n_bars)
    low = close - rng.uniform(0.2, 1.0, n_bars)
    open_ = close + rng.normal(0.0, 0.25, n_bars)

    ts = pd.date_range("2024-02-01 09:30", periods=n_bars, freq="1min", tz="UTC")
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


OHLC_FIXTURES = {
    "oscillating": _synthetic_ohlc,
    "trending_wide_swings": _synthetic_ohlc_trending,
}


# Columns the 2026-04 causality passes FULLY fix — rows 0..T must be
# identical between full-frame and truncated-frame runs.
# Regression-guards three landings:
#   * 2026-04-23 BOS/CHOCH pass (labeling peek + broken-filter peek)
#   * 2026-04-24 Phase A (causal_order_blocks replaces smc.ob)
#   * 2026-04-24 Phase B (causal_swing_highs_lows replaces smc.swing_highs_lows)
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
    "OB",
    "OB_Top",
    "OB_Bottom",
    "OBVolume",
    "OB_Percentage",
)

# Columns with known residual non-causality. Only mitigation-index fields
# remain here — they store FUTURE bar indices by design, and the raw
# values legitimately differ between views. loop.py consumes them as
# `mit <= signal_idx` which derives the same active/mitigated state in
# both full-frame and truncated-frame runs (see
# test_mitigated_index_semantics_match).
KNOWN_RESIDUAL_COLS = (
    "OB_MitigatedIndex",
    "FVG_MitigatedIndex",
)


def _first_divergence(a: np.ndarray, b: np.ndarray) -> int | None:
    """Return index of first (a, b) mismatch treating NaN == NaN, else None."""
    mismatch = np.nonzero(
        ~((np.isnan(a) & np.isnan(b)) | (a == b))
    )[0]
    return int(mismatch[0]) if mismatch.size else None


@pytest.mark.parametrize("fixture_name", list(OHLC_FIXTURES.keys()))
@pytest.mark.parametrize("swing_length", [3, 5, 8])
@pytest.mark.parametrize("truncate_at", [200, 350, 500])
def test_strict_causality_for_fixed_columns(
    fixture_name: str, swing_length: int, truncate_at: int
) -> None:
    """Columns in STRICT_CAUSAL_COLS must be causal: rows 0..truncate_at-1
    of the full-frame output match the truncated-frame output exactly.

    Parametrized over two fixtures: an oscillating sine (evenly-spaced
    swings) and a wide-swing trending generator (the shape that breaks
    uniform-shift fixes). Both must pass for the per-event relocation
    to be considered correct.
    """
    df = OHLC_FIXTURES[fixture_name]()
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


def test_ob_reset_no_longer_a_residual() -> None:
    """Regression: the OB reset residual that was xfailed before
    2026-04-24 is now fixed via causal_order_blocks (pac.causal_smc).

    Previously smc.ob's reset step would zero an OB's detection row
    when a future high re-crossed the top. causal_order_blocks keeps
    the detection row intact, so the OB a live trader would have seen
    between detection and mitigation now appears in both full-frame
    and truncated-frame runs.

    Note: MitigatedIndex is still allowed to differ (future bar index;
    functional-equivalent via loop.py's `mit <= signal_idx` check),
    so this test checks OB only.
    """
    df = _synthetic_ohlc()
    engine = PACEngine(PACParams(swing_length=3))
    truncate_at = 200
    full_out = engine.batch_state(df).reset_index(drop=True)
    trunc_out = engine.batch_state(df.iloc[:truncate_at].copy()).reset_index(drop=True)
    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)
    a = full_window["OB"].to_numpy(dtype=np.float64, na_value=np.nan)
    b = trunc_out["OB"].to_numpy(dtype=np.float64, na_value=np.nan)
    assert _first_divergence(a, b) is None, (
        "OB column diverges between full and truncated views — either "
        "causal_order_blocks regressed, or swing_highs_lows differences "
        "are propagating into OB detection. Check which."
    )


def test_swing_dedup_no_longer_a_residual() -> None:
    """Regression: the swing-dedup residual that was xfailed before
    2026-04-24 Phase B is now fixed via causal_swing_highs_lows
    (pac.causal_smc).

    Previously smc.swing_highs_lows' dedup loop (lines 165-193) would
    erase a swing retroactively when a later swing was more extreme,
    plus the endpoint fixup (197-205) would force the first/last
    swings to alternate types. causal_swing_highs_lows does neither —
    every bar that passes the centered-window test keeps its HighLow.

    Covered by the strict parametrized test on both oscillating and
    trending fixtures; this is an explicit single-case regression so
    an inadvertent revert shows up with a clear name.
    """
    df = _synthetic_ohlc_trending()
    engine = PACEngine(PACParams(swing_length=8))
    truncate_at = 350
    full_out = engine.batch_state(df).reset_index(drop=True)
    trunc_out = engine.batch_state(df.iloc[:truncate_at].copy()).reset_index(drop=True)
    full_window = full_out.iloc[:truncate_at].reset_index(drop=True)
    a = full_window["HighLow"].to_numpy(dtype=np.float64, na_value=np.nan)
    b = trunc_out["HighLow"].to_numpy(dtype=np.float64, na_value=np.nan)
    assert _first_divergence(a, b) is None, (
        "HighLow column diverges between full and truncated views — "
        "causal_swing_highs_lows regressed. Check if dedup/endpoint-fixup "
        "leaked back into the pipeline."
    )
