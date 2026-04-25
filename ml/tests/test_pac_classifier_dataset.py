"""End-to-end tests for `pac_classifier.dataset.build_dataset`.

The pipeline is small but each piece is tested in isolation. These
tests verify the GLUE — that events + labels + features merge
correctly into a single row-per-event DataFrame with the right schema
and the right values for the same bar_idx.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pac_classifier.dataset import build_dataset, write_dataset


def _enriched_with_events(n: int = 100) -> pd.DataFrame:
    """Synthetic enriched frame with a couple of deterministic events."""
    closes = 100.0 + np.arange(n, dtype=float) * 0.01
    # Place events at bar 30 (BOS up) and bar 60 (CHoCH dn)
    bos = [np.nan] * n
    bos[30] = 1.0
    choch = [np.nan] * n
    choch[60] = -1.0
    chplus = [np.nan] * n
    return pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 09:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": closes + 0.5,
            "low": closes - 0.5,
            "close": closes,
            "volume": np.full(n, 1000.0),
            "BOS": bos,
            "CHOCH": choch,
            "CHOCHPlus": chplus,
            "atr_14": np.full(n, 0.5),
            "adx_14": np.full(n, 25.0),
            "di_plus_14": np.full(n, 22.0),
            "di_minus_14": np.full(n, 18.0),
            "z_close_vwap": np.linspace(-1.0, 1.0, n),
            "ob_pct_atr": np.full(n, 30.0),
            "ob_volume_z_50": np.full(n, 1.5),
            "session_bucket": ["any"] * n,
            "minutes_from_rth_open": np.arange(n, dtype=float),
            "minutes_to_rth_close": (n - np.arange(n, dtype=float)),
            "is_fomc": [False] * n,
            "is_opex": [False] * n,
            "is_event_day": [False] * n,
        }
    )


def test_empty_enriched_returns_empty_dataset() -> None:
    enriched = pd.DataFrame(
        {
            "ts_event": pd.Series([], dtype="datetime64[ns, UTC]"),
            "close": [],
            "BOS": [],
            "CHOCH": [],
            "CHOCHPlus": [],
            "atr_14": [],
        }
    )
    out = build_dataset(enriched)
    assert len(out) == 0
    for col in ("bar_idx", "label_a", "realized_R", "ts_event"):
        assert col in out.columns


def test_dataset_merges_events_labels_features() -> None:
    enriched = _enriched_with_events(100)
    out = build_dataset(enriched)
    # 2 events: BOS at bar 30, CHoCH at bar 60
    assert len(out) == 2
    # Label, feature, and event columns all present on each row
    expected_cols = {
        "bar_idx", "signal_type", "signal_direction", "ts_event", "entry_price",
        "label_a", "exit_reason", "bars_to_exit", "realized_R", "forward_return_dollars",
        "atr_14", "adx_14", "ret_5b", "rv_30b", "bos_density_60b", "day_of_week",
    }
    assert expected_cols.issubset(set(out.columns))
    # Verify the two rows correspond to the right events
    types = sorted(out["signal_type"].tolist())
    assert types == ["BOS", "CHOCH"]


def test_dataset_label_a_values_finite_or_nan() -> None:
    """Each label_a must be 0.0, 1.0, or NaN — never some other float."""
    enriched = _enriched_with_events(100)
    out = build_dataset(enriched)
    for v in out["label_a"]:
        assert v == 0.0 or v == 1.0 or np.isnan(v)


def test_dataset_round_trips_through_parquet(tmp_path: Path) -> None:
    enriched = _enriched_with_events(100)
    ds = build_dataset(enriched)
    target = tmp_path / "out.parquet"
    write_dataset(ds, target)
    assert target.exists()
    reloaded = pd.read_parquet(target)
    assert len(reloaded) == len(ds)
    assert sorted(reloaded.columns.tolist()) == sorted(ds.columns.tolist())
    # Spot-check a couple of fields survive the round-trip cleanly
    assert reloaded.iloc[0]["signal_type"] == ds.iloc[0]["signal_type"]
    assert reloaded.iloc[0]["bar_idx"] == ds.iloc[0]["bar_idx"]


def test_dataset_signal_type_uniqueness_per_bar_idx() -> None:
    """Two events at the SAME bar_idx (e.g., BOS+CHoCH on a flip) must
    produce two distinct rows that are correctly disambiguated by
    signal_type — no merge collapse, no column duplication."""
    n = 100
    closes = 100.0 + np.arange(n, dtype=float) * 0.01
    enriched = pd.DataFrame(
        {
            "ts_event": pd.date_range("2024-01-02 09:30", periods=n, freq="5min", tz="UTC"),
            "open": closes,
            "high": closes + 0.5,
            "low": closes - 0.5,
            "close": closes,
            "volume": np.full(n, 1000.0),
            "BOS": [1.0 if i == 50 else np.nan for i in range(n)],
            "CHOCH": [-1.0 if i == 50 else np.nan for i in range(n)],
            "CHOCHPlus": [np.nan] * n,
            "atr_14": np.full(n, 0.5),
            "adx_14": np.full(n, 25.0),
            "di_plus_14": np.full(n, 22.0),
            "di_minus_14": np.full(n, 18.0),
            "z_close_vwap": np.linspace(-1.0, 1.0, n),
            "ob_pct_atr": np.full(n, 30.0),
            "ob_volume_z_50": np.full(n, 1.5),
            "session_bucket": ["any"] * n,
            "minutes_from_rth_open": np.arange(n, dtype=float),
            "minutes_to_rth_close": (n - np.arange(n, dtype=float)),
            "is_fomc": [False] * n,
            "is_opex": [False] * n,
            "is_event_day": [False] * n,
        }
    )
    out = build_dataset(enriched)
    assert len(out) == 2
    rows_at_50 = out[out["bar_idx"] == 50]
    assert len(rows_at_50) == 2
    types = sorted(rows_at_50["signal_type"].tolist())
    assert types == ["BOS", "CHOCH"]
    # Distinct directions
    directions = sorted(rows_at_50["signal_direction"].tolist())
    assert directions == ["dn", "up"]
