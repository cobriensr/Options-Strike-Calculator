"""Assemble the per-event feature+label dataset using Ichimoku-native labels.

Mirrors `pac_classifier.dataset.build_dataset` exactly, except the
labeling step uses `ichimoku_classifier.labels.label_ichimoku_events`
with a strategy spec instead of the fixed-bracket PAC labeler. The
features module is reused unchanged.

Output schema is identical to `pac_classifier.dataset.build_dataset`
so the existing trainer (`ml/scripts/train_pac_classifier.py`) runs
on the resulting parquets without modification.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ichimoku_classifier.labels import StrategySpec, label_ichimoku_events
from pac_classifier.events import extract_events
from pac_classifier.features import build_features


def build_ichimoku_dataset(
    enriched: pd.DataFrame,
    spec: StrategySpec,
    *,
    timeframe: str = "5m",
    tick_value_dollars: float = 5.0,
) -> pd.DataFrame:
    """Run events → ichimoku-labels → features and return the joined dataset.

    `enriched` must be the output of `IchimokuEngine.batch_state` —
    contains the BOS/CHOCH/CHOCHPlus event columns mapped from
    Ichimoku triggers + the kijun/cloud columns the labeler needs.
    """
    events = extract_events(enriched)
    if len(events) == 0:
        return _empty_dataset()

    labels = label_ichimoku_events(
        enriched,
        events,
        spec=spec,
        timeframe=timeframe,
        tick_value_dollars=tick_value_dollars,
    )
    features = build_features(enriched, events)

    if len(labels) != len(events) or len(features) > len(events):
        raise RuntimeError(
            f"label/feature row counts diverged from events: "
            f"events={len(events)}, labels={len(labels)}, features={len(features)}"
        )

    events_keyed = events[
        ["bar_idx", "signal_type", "signal_direction", "ts_event", "entry_price"]
    ]
    out = events_keyed.copy()
    out = out.assign(
        label_a=labels["label_a"].to_numpy(),
        exit_reason=labels["exit_reason"].to_numpy(),
        bars_to_exit=labels["bars_to_exit"].to_numpy(),
        realized_R=labels["realized_R"].to_numpy(),
        forward_return_dollars=labels["forward_return_dollars"].to_numpy(),
    )
    feat_cols = [
        c for c in features.columns
        if c not in {"bar_idx", "signal_type", "signal_direction"}
    ]
    out = out.merge(
        features[["bar_idx", "signal_type", *feat_cols]],
        on=["bar_idx", "signal_type"],
        how="left",
    )
    return out


def write_dataset(dataset: pd.DataFrame, out_path: Path) -> None:
    """Persist a feature+label dataset to parquet via pyarrow."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_parquet(out_path, index=False, engine="pyarrow")


def _empty_dataset() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "bar_idx": pd.Series([], dtype="int64"),
            "signal_type": pd.Series([], dtype=object),
            "signal_direction": pd.Series([], dtype=object),
            "ts_event": pd.Series([], dtype="datetime64[ns, UTC]"),
            "entry_price": pd.Series([], dtype="float64"),
            "label_a": pd.Series([], dtype="float64"),
            "exit_reason": pd.Series([], dtype=object),
            "bars_to_exit": pd.Series([], dtype="int64"),
            "realized_R": pd.Series([], dtype="float64"),
            "forward_return_dollars": pd.Series([], dtype="float64"),
        }
    )
