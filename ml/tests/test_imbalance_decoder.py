"""Tests for the DBN imbalance decoder.

These tests decode a single sample day from each ordered Databento folder if
present locally; they are skipped on machines (including CI) that don't have
the raw Downloads folders present.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.imbalance import decoder

DOWNLOADS = Path.home() / "Downloads"
ARCX_FOLDER = DOWNLOADS / "ARCX-20260514-KBSGK7PRBJ"
XNAS_FOLDER = DOWNLOADS / "XNAS-20260514-7SQALEQH9G"


def _sample_file(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    files = sorted(folder.glob("*.imbalance.dbn.zst"))
    return files[0] if files else None


@pytest.mark.skipif(
    _sample_file(ARCX_FOLDER) is None,
    reason="ARCX download folder not present locally",
)
def test_decode_one_file_basic_shape() -> None:
    path = _sample_file(ARCX_FOLDER)
    assert path is not None
    df = decoder._decode_one_file(path, "ARCX.PILLAR")
    assert not df.empty
    assert "signed_imbalance" in df.columns
    assert "dataset" in df.columns
    assert (df["dataset"] == "ARCX.PILLAR").all()
    # All four ETFs should appear in any single day
    assert {"SPY", "IWM", "VOO", "DIA"}.issubset(set(df["symbol"].unique()))


@pytest.mark.skipif(
    _sample_file(ARCX_FOLDER) is None,
    reason="ARCX download folder not present locally",
)
def test_decode_signs_buy_positive_sell_negative() -> None:
    path = _sample_file(ARCX_FOLDER)
    assert path is not None
    df = decoder._decode_one_file(path, "ARCX.PILLAR")

    # On rows where side='B' and total_imbalance_qty>0, signed_imbalance must be > 0
    buy_rows = df[(df["side"] == "B") & (df["total_imbalance_qty"] > 0)]
    if not buy_rows.empty:
        assert (buy_rows["signed_imbalance"] > 0).all()

    sell_rows = df[(df["side"] == "A") & (df["total_imbalance_qty"] > 0)]
    if not sell_rows.empty:
        assert (sell_rows["signed_imbalance"] < 0).all()


@pytest.mark.skipif(
    _sample_file(ARCX_FOLDER) is None,
    reason="ARCX download folder not present locally",
)
def test_uint32_sentinel_replaced_with_nan() -> None:
    path = _sample_file(ARCX_FOLDER)
    assert path is not None
    df = decoder._decode_one_file(path, "ARCX.PILLAR")
    # market_imbalance_qty often has the UINT32 sentinel; ensure it's NaN'd
    assert (df["market_imbalance_qty"] != decoder.NULL_U32).all()
    # Result column dtype must be float-y to permit NaN
    assert df["market_imbalance_qty"].dtype.kind in {"f", "O"}


def test_signed_imbalance_helper() -> None:
    side = pd.Series(["B", "A", "N", "B"])
    qty = pd.Series([100, 200, 300, 0])
    result = decoder._signed_imbalance(side, qty)
    # side='N' zeros out qty regardless of value (matches schema semantics)
    assert result.tolist() == [100, -200, 0, 0]


def test_signed_imbalance_overflow_safe() -> None:
    # qty up to UINT32 max must not overflow into int64
    side = pd.Series(["A"])
    qty = pd.Series([np.iinfo(np.uint32).max - 1], dtype="uint32")
    result = decoder._signed_imbalance(side, qty)
    assert result.iloc[0] == -int(qty.iloc[0])


def test_signed_imbalance_nan_qty_propagates() -> None:
    # Sentinel-replaced NaN qty must stay NaN, not collapse to 0
    side = pd.Series(["B", "A"])
    qty = pd.Series([np.nan, np.nan], dtype="Float64")
    result = decoder._signed_imbalance(side, qty)
    assert result.isna().all()


def test_signed_imbalance_zero_qty_real_zero_kept() -> None:
    # A genuine zero with a real side should be a real 0, not NaN
    side = pd.Series(["B"])
    qty = pd.Series([0], dtype="Int64")
    result = decoder._signed_imbalance(side, qty)
    assert result.iloc[0] == 0
    assert not pd.isna(result.iloc[0])
