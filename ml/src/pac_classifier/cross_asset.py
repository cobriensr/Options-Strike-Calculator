"""Cross-asset bar loader + causal alignment for the PAC classifier.

Phase 1a was NQ-only. Phase 1b enriches every event row with the
state of correlated instruments at the event timestamp:

    SPY (S&P 500 ETF)  : the cash-equity counterpart to ES/NQ flow
    QQQ (Nasdaq-100 ETF): the cash-equity counterpart to NQ flow
    VIX (volatility index): regime / fear context

The classifier hypothesizes that PAC entries pay differently when
SPY is leading vs lagging the futures, when QQQ is up/down on the
day, and when VIX is rising (risk-off) vs flat.

## Causality contract

Every cross-asset feature attached to event row T uses bars with
timestamp `ts <= T` ONLY. Implemented via `pandas.merge_asof` with
`direction="backward"` — for each event we pick the most recent
asset bar that already closed by event time. Forward-fill at the
event grid; never reach forward.

## Schema

`CrossAssetBars` is a thin wrapper around a `{symbol -> DataFrame}`
mapping where each frame has:

    ts_event : datetime64[ns, UTC]   — sorted ascending
    close    : float64               — bar close (or VIX index level)

Other OHLCV columns are accepted but unused — only `close` is
required for return calculations and level snapshots. Empty mapping
or `None` → cross-asset features emit NaN (graceful degrade so the
NQ-only pipeline keeps working).

## Why a separate module

`features.py` already does engine-state snapshotting + NQ-only
rolling derivatives. Cross-asset alignment is its own concern with
its own causality story (merge_asof, not iloc). Splitting it keeps
both files focused and makes the data-acquisition path swappable
(parquet, REST, in-memory test fixture — all behind one type).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

CROSS_ASSET_SYMBOLS: tuple[str, ...] = ("SPY", "QQQ", "VIX")
CROSS_ASSET_RETURN_LOOKBACKS: tuple[int, ...] = (5, 30)


@dataclass
class CrossAssetBars:
    """Holder for cross-asset bar frames keyed by symbol.

    Use the `from_mapping` constructor (or `from_parquet_root`) so
    sort + tz invariants are enforced on insert.
    """

    bars: dict[str, pd.DataFrame] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, mapping: dict[str, pd.DataFrame]) -> CrossAssetBars:
        validated: dict[str, pd.DataFrame] = {}
        for symbol, df in mapping.items():
            validated[symbol] = _validate_asset_frame(df, symbol)
        return cls(bars=validated)

    @classmethod
    def from_parquet_root(
        cls,
        root: Path,
        *,
        symbols: tuple[str, ...] = CROSS_ASSET_SYMBOLS,
        years: tuple[int, ...] | None = None,
    ) -> CrossAssetBars:
        """Load partitioned parquet from `<root>/<symbol>/year=<Y>/part.parquet`.

        Mirrors the futures archive layout — data acquisition writes
        cross-asset bars in the same shape so this loader is the only
        plumbing.
        """
        mapping: dict[str, pd.DataFrame] = {}
        for symbol in symbols:
            sym_root = Path(root) / symbol
            if not sym_root.exists():
                continue
            frames: list[pd.DataFrame] = []
            year_dirs = sorted(sym_root.glob("year=*"))
            for ydir in year_dirs:
                if years is not None:
                    try:
                        y = int(ydir.name.split("=", 1)[1])
                    except (IndexError, ValueError):
                        continue
                    if y not in years:
                        continue
                part = ydir / "part.parquet"
                if part.exists():
                    frames.append(pd.read_parquet(part))
            if frames:
                merged = pd.concat(frames, ignore_index=True)
                mapping[symbol] = merged
        return cls.from_mapping(mapping)

    def __contains__(self, symbol: str) -> bool:
        return symbol in self.bars

    def get(self, symbol: str) -> pd.DataFrame | None:
        return self.bars.get(symbol)


def align_to_events(
    asset_df: pd.DataFrame,
    event_ts: pd.Series,
) -> pd.DataFrame:
    """Causally snap asset bars onto the event timestamp grid.

    For each event timestamp, pick the most recent asset bar whose
    `ts_event <= event_ts`. Returns a frame indexed positionally with
    `event_ts` containing all columns from `asset_df` (the snapped
    asset row at event time). Events earlier than the first asset
    bar emit all-NaN (no peek into the future, no fabrication).

    `asset_df` must be sorted ascending by `ts_event` and tz-aware
    UTC — `_validate_asset_frame` enforces this on construction.
    """
    if len(event_ts) == 0:
        return _empty_aligned_frame(asset_df.columns)
    if len(asset_df) == 0:
        # No asset data — every event gets NaN
        return pd.DataFrame(
            {col: np.full(len(event_ts), np.nan) for col in asset_df.columns},
            index=range(len(event_ts)),
        )

    events = pd.DataFrame({"ts_event": pd.to_datetime(event_ts, utc=True)})
    events_sorted = events.sort_values("ts_event").reset_index()
    aligned = pd.merge_asof(
        events_sorted,
        asset_df,
        on="ts_event",
        direction="backward",
    )
    # Restore the caller's original event order
    aligned = aligned.sort_values("index").reset_index(drop=True)
    aligned = aligned.drop(columns=["index"])
    return aligned


def snapshot_cross_asset_features(
    cross_assets: CrossAssetBars | None,
    event_ts: pd.Series,
    *,
    symbols: tuple[str, ...] = CROSS_ASSET_SYMBOLS,
    return_lookbacks: tuple[int, ...] = CROSS_ASSET_RETURN_LOOKBACKS,
) -> pd.DataFrame:
    """Per-event cross-asset feature snapshot.

    Emits, for each symbol in `symbols`:
        {symbol}_close       : last close at event ts (NaN if no data)
        {symbol}_ret_{N}b    : log return over trailing N asset bars

    For VIX we still emit `VIX_close` (the index level) and
    `VIX_ret_{N}b` (log change in VIX). Sign is preserved — rising
    VIX = positive return value.

    When `cross_assets` is None or empty, every column is NaN. This
    keeps the dataset schema stable across NQ-only and enriched runs
    so model training code doesn't branch on data availability.
    """
    n = len(event_ts)
    cols: dict[str, np.ndarray] = {}
    for symbol in symbols:
        cols[f"{symbol}_close"] = np.full(n, np.nan, dtype=np.float64)
        for nb in return_lookbacks:
            cols[f"{symbol}_ret_{nb}b"] = np.full(n, np.nan, dtype=np.float64)

    if cross_assets is None or n == 0:
        return pd.DataFrame(cols, index=range(n))

    for symbol in symbols:
        asset_df = cross_assets.get(symbol)
        if asset_df is None or len(asset_df) == 0:
            continue
        # Pre-compute trailing log returns over the WHOLE asset frame
        # once, then merge_asof the resulting columns onto events.
        # Cheaper than re-doing the lookup per (event, lookback) tuple.
        log_close = np.log(asset_df["close"].to_numpy(dtype=np.float64))
        ret_cols: dict[str, np.ndarray] = {}
        for nb in return_lookbacks:
            ret = np.full(len(asset_df), np.nan, dtype=np.float64)
            if len(asset_df) > nb:
                ret[nb:] = log_close[nb:] - log_close[:-nb]
            ret_cols[f"{symbol}_ret_{nb}b"] = ret
        enriched_asset = asset_df.copy()
        for k, v in ret_cols.items():
            enriched_asset[k] = v

        snapped = align_to_events(
            enriched_asset[["ts_event", "close", *ret_cols.keys()]],
            event_ts,
        )
        cols[f"{symbol}_close"] = snapped["close"].to_numpy(dtype=np.float64)
        for nb in return_lookbacks:
            cols[f"{symbol}_ret_{nb}b"] = snapped[f"{symbol}_ret_{nb}b"].to_numpy(
                dtype=np.float64
            )

    return pd.DataFrame(cols, index=range(n))


def _validate_asset_frame(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """Enforce schema invariants: ts_event UTC tz-aware, close present,
    sorted ascending. Mutates a copy — caller's frame stays untouched.
    """
    required = {"ts_event", "close"}
    missing = required - set(df.columns)
    if missing:
        raise KeyError(
            f"{symbol}: cross-asset frame missing columns {sorted(missing)}"
        )
    out = df.copy()
    out["ts_event"] = pd.to_datetime(out["ts_event"], utc=True)
    out = out.sort_values("ts_event").reset_index(drop=True)
    return out


def _empty_aligned_frame(cols: pd.Index) -> pd.DataFrame:
    return pd.DataFrame({col: pd.Series([], dtype=np.float64) for col in cols})
