"""Assemble the per-event feature + label dataset for the classifier.

End-to-end pipeline:

    bars (year of NQ 5m)
        │
        ▼
    PACEngine.batch_state  (causally-correct v3)
        │
        ▼
    extract_events  →  label_events  →  build_features
        │              │                     │
        └──────────────┴─────────────────────┘
                       │  joined on bar_idx
                       ▼
        feature+label DataFrame  →  parquet

The output schema is the union of features and labels keyed by
`bar_idx`. Each row = one PAC event with everything the model needs.
Persisted as parquet (columnar, JSON-friendly metadata) — no opaque
binary blob formats.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from pac_classifier.events import extract_events
from pac_classifier.features import build_features
from pac_classifier.labels import (
    DEFAULT_STOP_ATR_MULT,
    DEFAULT_TARGET_R_MULT,
    label_events,
)


def build_dataset(
    enriched: pd.DataFrame,
    *,
    timeframe: str = "5m",
    stop_atr_mult: float = DEFAULT_STOP_ATR_MULT,
    target_r_mult: float = DEFAULT_TARGET_R_MULT,
    tick_value_dollars: float = 5.0,
) -> pd.DataFrame:
    """Run events → labels → features and return the joined dataset.

    `enriched` must be the output of `PACEngine.batch_state` for the
    target window (typically one calendar year on the 5m timeframe).
    """
    events = extract_events(enriched)
    if len(events) == 0:
        return _empty_dataset()

    labels = label_events(
        enriched,
        events,
        timeframe=timeframe,
        stop_atr_mult=stop_atr_mult,
        target_r_mult=target_r_mult,
        tick_value_dollars=tick_value_dollars,
    )
    features = build_features(enriched, events)

    # Join strategy:
    # extract_events returns rows sorted by bar_idx; label_events and
    # build_features both iterate `events` in that same order. Labels
    # are positionally aligned with events. Features may drop rows
    # where bar_idx is out-of-range (defensive), so we merge by
    # (bar_idx, signal_type) which uniquely identifies each event.
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
        features[["bar_idx", "signal_type"] + feat_cols],
        on=["bar_idx", "signal_type"],
        how="left",
    )
    return out


def write_dataset(
    dataset: pd.DataFrame,
    out_path: Path,
) -> None:
    """Persist a feature+label dataset to parquet via pyarrow.

    Schema is preserved verbatim. Both structured and object/string
    columns round-trip cleanly. Columnar format keeps the file
    inspectable with standard tools.
    """
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
