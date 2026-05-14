"""Join the imbalance snapshot panel against SPX end-of-day price action.

Produces one row per (date, symbol, auction_type) with the imbalance features
from Phase 2 *plus* the SPX targets Phase 4 will correlate against.

SPX price sources, in priority order:
  1. ml/data/spx_daily.parquet     daily OHLC, full year up to 2026-04-14
  2. index_candles_1m (Neon)        daily aggregation for dates after the
                                    parquet's last date (~20 extra trading
                                    days at time of writing)
  3. index_candles_1m (Neon)        15:50 / 15:59 ET closes for the
                                    high-res 15:50 -> 16:00 ET return target
                                    (only available from 2026-02-25 onward
                                    because the SPX cron started then)

Targets produced per trading day:
  - spx_open, spx_high, spx_low, spx_close          (always populated where
                                                     daily SPX is available)
  - spx_ret_open_to_close_bps                       basis points
  - spx_prev_close, spx_overnight_gap_bps           t-1 vs t open
  - spx_next_open, spx_next_close, spx_next_day_ret_bps
  - spx_price_1550, spx_price_1559,                 from 1-min where available
    spx_ret_1550_1600_bps

Usage:
    python -m src.imbalance.eod_join \\
        --snapshots data/imbalance/snapshots.parquet \\
        --spx-daily data/spx_daily.parquet \\
        --output data/imbalance/eod_panel.parquet
"""

from __future__ import annotations

import argparse
import sys
from datetime import date, time
from pathlib import Path

import pandas as pd

from src.utils import get_connection


def _load_spx_daily_parquet(path: Path) -> pd.DataFrame:
    """Return a DataFrame indexed by `date` (datetime.date) with columns
    spx_open / spx_high / spx_low / spx_close."""
    raw = pd.read_parquet(path)
    raw.index.name = "date"
    raw.index = pd.Index(
        [d.date() if hasattr(d, "date") else d for d in raw.index], name="date"
    )
    return raw[["spx_open", "spx_high", "spx_low", "spx_close"]].astype(float)


def _load_spx_daily_from_db(after: date) -> pd.DataFrame:
    """Aggregate per-day OHLC for SPX from the 1-min table for trading days
    strictly after `after`. Used to fill the tail gap when the local
    spx_daily.parquet is stale."""
    sql = """
        SELECT date,
               (ARRAY_AGG(open  ORDER BY timestamp ASC))[1]  AS spx_open,
               MAX(high)                                     AS spx_high,
               MIN(low)                                      AS spx_low,
               (ARRAY_AGG(close ORDER BY timestamp DESC))[1] AS spx_close
          FROM index_candles_1m
         WHERE symbol = 'SPX'
           AND date > %s
         GROUP BY date
         ORDER BY date
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (after,))
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(
        rows, columns=["date", "spx_open", "spx_high", "spx_low", "spx_close"]
    )
    df["date"] = pd.to_datetime(df["date"]).dt.date
    for c in ("spx_open", "spx_high", "spx_low", "spx_close"):
        df[c] = df[c].astype(float)
    return df.set_index("date")


def _load_spx_close_window(start_date: date, end_date: date) -> pd.DataFrame:
    """Pull SPX closing-window 1-min prices to compute the 15:50 -> 16:00 ET
    high-resolution return target. Returns one row per trading day where the
    window has both endpoints populated."""
    sql = """
        SELECT date,
               timestamp AT TIME ZONE 'America/New_York' AS et,
               close
          FROM index_candles_1m
         WHERE symbol = 'SPX'
           AND date BETWEEN %s AND %s
           AND EXTRACT(HOUR   FROM (timestamp AT TIME ZONE 'America/New_York')) = 15
           AND EXTRACT(MINUTE FROM (timestamp AT TIME ZONE 'America/New_York')) IN (50, 55, 59)
         ORDER BY date, timestamp
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (start_date, end_date))
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=["date", "et", "close"])
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df["et"] = pd.to_datetime(df["et"])
    df["minute"] = df["et"].dt.strftime("%H:%M")
    df["close"] = df["close"].astype(float)

    # Pivot to one row per date with per-minute columns.
    wide = df.pivot_table(
        index="date", columns="minute", values="close", aggfunc="first"
    )
    rename_map = {
        "15:50": "spx_price_1550",
        "15:55": "spx_price_1555",
        "15:59": "spx_price_1559",
    }
    wide = wide.rename(columns=rename_map)
    keep = [c for c in rename_map.values() if c in wide.columns]
    return wide[keep]


def _bps(num: pd.Series, denom: pd.Series) -> pd.Series:
    return (num / denom - 1.0) * 10_000


def _derive_daily_targets(daily: pd.DataFrame) -> pd.DataFrame:
    """Compute open-to-close, overnight gap, next-day return — all per-day
    columns indexed by date."""
    d = daily.sort_index().copy()
    d["spx_ret_open_to_close_bps"] = _bps(d["spx_close"], d["spx_open"])
    d["spx_prev_close"] = d["spx_close"].shift(1)
    d["spx_overnight_gap_bps"] = _bps(d["spx_open"], d["spx_prev_close"])
    d["spx_next_open"] = d["spx_open"].shift(-1)
    d["spx_next_close"] = d["spx_close"].shift(-1)
    d["spx_next_day_ret_bps"] = _bps(d["spx_next_close"], d["spx_next_open"])
    return d


def _derive_high_res_target(window: pd.DataFrame) -> pd.DataFrame:
    """Compute the 15:50 -> 16:00 ET (proxied by 15:50 -> 15:59) basis-point
    return for days where both endpoints exist."""
    if window.empty:
        return window
    out = window.copy()
    if {"spx_price_1550", "spx_price_1559"}.issubset(out.columns):
        out["spx_ret_1550_1600_bps"] = _bps(
            out["spx_price_1559"], out["spx_price_1550"]
        )
    return out


def build_eod_panel(
    snapshots_path: Path,
    spx_daily_path: Path,
) -> pd.DataFrame:
    snap = pd.read_parquet(snapshots_path)
    daily_parquet = _load_spx_daily_parquet(spx_daily_path)
    parquet_max = daily_parquet.index.max()

    # Extend daily coverage past the parquet's last date via Postgres aggregation
    daily_db_tail = _load_spx_daily_from_db(parquet_max)
    daily = pd.concat([daily_parquet, daily_db_tail]).sort_index()
    daily = daily[~daily.index.duplicated(keep="first")]
    daily = _derive_daily_targets(daily)

    snap_min, snap_max = min(snap["date"]), max(snap["date"])
    high_res = _derive_high_res_target(_load_spx_close_window(snap_min, snap_max))

    panel = snap.merge(daily, left_on="date", right_index=True, how="left")
    panel = panel.merge(high_res, left_on="date", right_index=True, how="left")
    return panel


def _print_coverage(panel: pd.DataFrame) -> None:
    print()
    print(f"Total snapshot rows:                   {len(panel):,}")
    print(f"Unique trading days:                   {panel['date'].nunique()}")
    print(
        f"Rows with daily SPX populated:         {panel['spx_close'].notna().sum():,}"
    )
    if "spx_ret_1550_1600_bps" in panel.columns:
        hires = int(panel["spx_ret_1550_1600_bps"].notna().sum())
        print(f"Rows with 15:50/15:59 high-res target: {hires:,}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshots", type=Path, required=True)
    parser.add_argument("--spx-daily", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    snapshots = args.snapshots.expanduser().resolve()
    spx_daily = args.spx_daily.expanduser().resolve()
    output = args.output.expanduser().resolve()

    print(f"Snapshots: {snapshots}")
    print(f"SPX daily: {spx_daily}")
    panel = build_eod_panel(snapshots, spx_daily)
    output.parent.mkdir(parents=True, exist_ok=True)
    panel.to_parquet(output, compression="zstd", index=False)
    print(f"Wrote {len(panel):,} rows to {output}")
    _print_coverage(panel)
    return 0


if __name__ == "__main__":
    sys.exit(main())


# Re-export for tests that need the private window time references.
WINDOW_OPEN_ET = time(15, 50)
WINDOW_CLOSE_ET = time(15, 59)
