"""Extract PAC structure events from a `PACEngine.batch_state` output.

Every row that carries a non-zero BOS, CHoCH, or CHoCH+ becomes one
record with:

- `ts_event`         : the bar timestamp
- `bar_idx`          : positional index into the source DataFrame
- `signal_type`      : "BOS" | "CHOCH" | "CHOCHPLUS"
- `signal_direction` : "up" | "dn"  (i.e., +1 / -1 in the engine column)
- `entry_price`      : the bar's close — what the backtest's loop assumes
- `atr_14`           : passed through for downstream R-based labeling

Disambiguation: a single bar can carry multiple events simultaneously
(e.g., BOS_dn + CHoCH_up at a structure flip). Each event becomes its
own row so the label simulator / feature builder treats them
independently, matching `pac_backtest/loop.py`'s entry semantics.

The +1 in CHOCHPlus is layered on top of CHOCH (CHoCHPlus implies
CHoCH), so when CHOCHPlus is non-zero we emit only the CHOCHPLUS row
to avoid double-counting the same setup. CHoCH events without the
plus designation emit as plain CHOCH.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class PACEvent:
    """One extracted event row, ready for label + feature attachment."""

    ts_event: pd.Timestamp
    bar_idx: int
    signal_type: str  # "BOS" | "CHOCH" | "CHOCHPLUS"
    signal_direction: str  # "up" | "dn"
    entry_price: float
    atr_14: float


def extract_events(enriched: pd.DataFrame) -> pd.DataFrame:
    """Pull every BOS / CHoCH / CHoCH+ event row.

    Expected columns in `enriched` (from `PACEngine.batch_state`):
        ts_event, close, BOS, CHOCH, CHOCHPlus, atr_14

    Returns a DataFrame with one row per detected event and the
    columns from `PACEvent`. Sorted by `bar_idx` ascending.

    Empty input → empty DataFrame with the right schema (no IndexError
    on downstream pipeline steps).
    """
    n = len(enriched)
    if n == 0:
        return _empty_events_frame()

    required = {"ts_event", "close", "BOS", "CHOCH", "CHOCHPlus", "atr_14"}
    missing = required - set(enriched.columns)
    if missing:
        raise KeyError(
            f"extract_events requires {sorted(required)} columns; "
            f"missing {sorted(missing)}"
        )

    bos = enriched["BOS"].to_numpy(dtype=np.float64, na_value=np.nan)
    choch = enriched["CHOCH"].to_numpy(dtype=np.float64, na_value=np.nan)
    chplus = enriched["CHOCHPlus"].to_numpy(dtype=np.float64, na_value=np.nan)
    closes = enriched["close"].to_numpy(dtype=np.float64)
    atrs = enriched["atr_14"].to_numpy(dtype=np.float64, na_value=np.nan)
    ts = enriched["ts_event"].to_numpy()

    rows: list[dict] = []
    for i in range(n):
        bos_i = bos[i]
        choch_i = choch[i]
        chplus_i = chplus[i]

        # CHoCH+ supersedes plain CHoCH at the same bar — same setup,
        # one is the more-confirmed flavor. Emit only the higher tier
        # so the dataset doesn't double-count.
        if not np.isnan(chplus_i) and chplus_i != 0:
            rows.append(_make_row(i, ts[i], "CHOCHPLUS", chplus_i, closes[i], atrs[i]))
        elif not np.isnan(choch_i) and choch_i != 0:
            rows.append(_make_row(i, ts[i], "CHOCH", choch_i, closes[i], atrs[i]))

        # BOS is independent of CHoCH (different setup type, can coexist
        # at the same bar). Emit alongside any CHoCH/+ above.
        if not np.isnan(bos_i) and bos_i != 0:
            rows.append(_make_row(i, ts[i], "BOS", bos_i, closes[i], atrs[i]))

    if not rows:
        return _empty_events_frame()

    return pd.DataFrame(rows).sort_values("bar_idx").reset_index(drop=True)


def _make_row(
    bar_idx: int,
    ts: pd.Timestamp,
    sig_type: str,
    sig_value: float,
    close: float,
    atr: float,
) -> dict:
    direction = "up" if sig_value > 0 else "dn"
    return {
        "ts_event": ts,
        "bar_idx": int(bar_idx),
        "signal_type": sig_type,
        "signal_direction": direction,
        "entry_price": float(close),
        "atr_14": float(atr) if not np.isnan(atr) else np.nan,
    }


def _empty_events_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "ts_event": pd.Series([], dtype="datetime64[ns, UTC]"),
            "bar_idx": pd.Series([], dtype=np.int64),
            "signal_type": pd.Series([], dtype=object),
            "signal_direction": pd.Series([], dtype=object),
            "entry_price": pd.Series([], dtype=np.float64),
            "atr_14": pd.Series([], dtype=np.float64),
        }
    )
