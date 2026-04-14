"""
MOC Imbalance — Phase 1: Feature Construction & Target Labels

Joins the QQQ closing-auction imbalance stream with QQQ minute bars to produce
a per-day dataset suitable for ML:

    ONE ROW PER TRADING DAY, fields:
      - Snapshot features at 15:50 ET (the "first imbalance print" moment,
        which is 2:50 CT — the exact moment a pin breaks).
      - Snapshot features at 15:55 ET (5 minutes later — shows how the
        imbalance is evolving, which is often more predictive than the
        absolute level).
      - Target: realized MAE (max adverse excursion) in basis points from
        the 15:50 spot, measured across 15:50 -> 16:00 ET minute bars.
      - Target: realized MFE (max favorable excursion).
      - Target: realized return from 15:50 close -> 16:00 close.

Why MAE as the primary target:
    A pin that breaks 15 bps and recovers still kills an iron fly because
    you can't get out mid-move. The headline "return to close" metric
    understates the real P&L damage. MAE is the distribution we care about.

Why two timestamps:
    NASDAQ publishes NOII every 1 second from 15:50 onward. The FIRST print
    is often noisy — a desk that hasn't finalized its close-out order book
    yet. The 15:55 print is much more stable. If imbalance *grew* from
    15:50 to 15:55, that's a very different signal than "big at 15:50,
    faded by 15:55".

Input:
    - ml/data/moc_imbalance_raw.parquet  (from moc_inspect.py)
    - QQQ ohlcv-1m DBN file (path via --bars-input)

Output:
    - ml/data/moc_features_qqq.parquet (one row per trading day)

Usage:
    ml/.venv/bin/python ml/src/moc_features.py \\
        --bars-input ~/Downloads/XNAS-20260414-PSQVX5VACS/xnas-itch-20180501-20260413.ohlcv-1m.dbn.zst

Requires: databento, pandas, numpy
"""

import argparse
import sys
from pathlib import Path

try:
    import databento as db
    import numpy as np
    import pandas as pd
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install databento pandas numpy")
    sys.exit(1)

from utils import ML_ROOT, section, subsection, takeaway


# ── Constants ────────────────────────────────────────────────

ET = "US/Eastern"
# Snapshot timestamps — we record imbalance state at each of these.
SNAPSHOT_TIMES = {
    "T50": (15, 50),  # First imbalance print; 2:50 CT
    "T55": (15, 55),  # Five minutes later; shows growth/fade
}
# Target window — we measure MAE/MFE across this interval.
TARGET_START = (15, 50)
TARGET_END = (16, 0)

SYMBOL = "QQQ"


# ── Args ─────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--imbalance-parquet",
        type=Path,
        default=ML_ROOT / "data" / "moc_imbalance_raw.parquet",
        help="Cached parquet from moc_inspect.py",
    )
    parser.add_argument(
        "--bars-input",
        type=Path,
        required=True,
        help="Path to the ohlcv-1m .dbn.zst file",
    )
    parser.add_argument(
        "--bars-parquet",
        type=Path,
        default=ML_ROOT / "data" / "qqq_bars_1m.parquet",
        help="Where to cache decoded bars (for faster re-runs)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ML_ROOT / "data" / "moc_features_qqq.parquet",
        help="Per-day feature table output",
    )
    return parser.parse_args()


# ── Loaders ──────────────────────────────────────────────────


def load_imbalance(parquet_path: Path) -> pd.DataFrame:
    """Load the cached imbalance data and filter to QQQ closing auctions."""
    if not parquet_path.exists():
        print(f"ERROR: {parquet_path} not found. Run moc_inspect.py first.")
        sys.exit(1)

    print(f"  Loading imbalance cache: {parquet_path.name}")
    frame = pd.read_parquet(parquet_path)
    # Filter: QQQ + closing auction only.
    frame = frame[(frame["symbol"] == SYMBOL) & (frame["auction_type"] == "C")]
    print(f"  {len(frame):,} QQQ closing-auction messages")
    return frame


def load_bars(dbn_path: Path, parquet_cache: Path) -> pd.DataFrame:
    """
    Decode the 1-minute OHLCV DBN and cache to parquet. Subsequent runs
    read straight from parquet (fast).
    """
    if parquet_cache.exists():
        print(f"  Loading bars cache: {parquet_cache.name}")
        return pd.read_parquet(parquet_cache)

    if not dbn_path.exists():
        print(f"ERROR: bars file not found: {dbn_path}")
        sys.exit(1)

    print(f"  Decoding bars from {dbn_path.name} ({dbn_path.stat().st_size / 1e6:.1f} MB)")
    store = db.DBNStore.from_file(str(dbn_path))
    frame = store.to_df(map_symbols=True)
    frame = frame[frame["symbol"] == SYMBOL]
    print(f"  {len(frame):,} QQQ 1-minute bars")

    parquet_cache.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(parquet_cache)
    print(f"  Cached to {parquet_cache.name} for fast re-runs")
    return frame


# ── Snapshot extraction ──────────────────────────────────────


def first_message_at_or_after(
    day_messages: pd.DataFrame, hour: int, minute: int
) -> pd.Series | None:
    """
    Return the first imbalance message on this day at or after the given
    ET wall-clock time. Returns None if no such message exists (half-day
    or data gap).
    """
    ts_et = day_messages.index.tz_convert(ET)
    target_minutes = hour * 60 + minute
    day_minutes = ts_et.hour * 60 + ts_et.minute
    mask = day_minutes >= target_minutes
    if not mask.any():
        return None
    return day_messages.loc[mask].iloc[0]


def _drift_bps(clear_price: float, ref_price: float) -> float:
    """
    Implied drift = how far the auction's hypothetical clearing price has
    moved from the reference price, in bps. Returns NaN if either input
    is missing, zero, or NaN. (NASDAQ publishes 0.0 as a "not yet computed"
    sentinel for the clearing prices during early parts of the window.)
    """
    if (
        clear_price is None
        or ref_price is None
        or np.isnan(clear_price)
        or np.isnan(ref_price)
        or not clear_price
        or not ref_price
    ):
        return np.nan
    return (clear_price - ref_price) / ref_price * 10_000


def extract_snapshot(message: pd.Series, label: str) -> dict:
    """Turn one imbalance message into a flat feature dict prefixed by label."""
    side_char = message["side"]
    # Signed imbalance: +qty if bid-side, -qty if ask-side, 0 if neutral.
    sign = 1 if side_char == "B" else (-1 if side_char == "A" else 0)
    total_qty = int(message["total_imbalance_qty"])
    paired_qty = int(message["paired_qty"])
    market_qty = int(message["market_imbalance_qty"])

    # Ratios guard against div-by-zero when total is 0 (happens on quiet days).
    paired_ratio = paired_qty / total_qty if total_qty > 0 else np.nan
    market_share = market_qty / total_qty if total_qty > 0 else np.nan

    # NASDAQ venue notes:
    #   ind_match_price is NOT published for ETFs — always 0.0 for SPY/QQQ.
    #   cont_book_clr_price = blended cross+continuous book (92% populated).
    #   auct_interest_clr_price = cross-only book (82% populated). Cross-only
    #     is closer to "pure MOC flow" signal; the blended version mixes in
    #     continuous-book liquidity too.
    # We compute both drifts; they're cheap and may differ predictively.
    ref_price = message["ref_price"]
    cont_clear = message["cont_book_clr_price"]
    cross_clear = message["auct_interest_clr_price"]

    return {
        f"{label}_signed_imbalance": sign * total_qty,
        f"{label}_total_qty": total_qty,
        f"{label}_paired_ratio": paired_ratio,
        f"{label}_market_share": market_share,
        f"{label}_side": side_char,
        f"{label}_ref_price": ref_price,
        f"{label}_cont_clear_price": cont_clear,
        f"{label}_cross_clear_price": cross_clear,
        f"{label}_cont_drift_bps": _drift_bps(cont_clear, ref_price),
        f"{label}_cross_drift_bps": _drift_bps(cross_clear, ref_price),
    }


# ── Target construction ──────────────────────────────────────


def compute_targets(day_bars: pd.DataFrame) -> dict | None:
    """
    From 1-minute bars on one day, compute MAE, MFE, and realized return
    across the 15:50 -> 16:00 ET window. Returns None if we don't have
    enough bars (half-day, data gap).
    """
    ts_et = day_bars.index.tz_convert(ET)
    h, m = TARGET_START
    start_minutes = h * 60 + m
    eh, em = TARGET_END
    end_minutes = eh * 60 + em
    day_minutes = ts_et.hour * 60 + ts_et.minute
    window = day_bars.loc[(day_minutes >= start_minutes) & (day_minutes < end_minutes)]

    if len(window) < 5:  # need most of the 10-bar window
        return None

    spot_bar = window.iloc[0]  # 15:50 bar — close = entry reference
    spot = spot_bar["close"]
    if spot <= 0 or np.isnan(spot):
        return None

    window_high = window["high"].max()
    window_low = window["low"].min()
    close_price = window.iloc[-1]["close"]

    return {
        "spot_at_T50": spot,
        "close_at_T60": close_price,
        # Return from 15:50 close to 16:00 close
        "realized_return_bps": (close_price - spot) / spot * 10_000,
        # Favorable excursion (upside vs spot)
        "realized_mfe_bps": (window_high - spot) / spot * 10_000,
        # Adverse excursion (downside vs spot) — reported as positive bps
        "realized_mae_down_bps": (spot - window_low) / spot * 10_000,
        # Total excursion — the "range broken" metric
        "realized_range_bps": (window_high - window_low) / spot * 10_000,
        "bars_in_window": len(window),
    }


# ── Per-day assembly ─────────────────────────────────────────


def build_per_day_rows(
    imbalance: pd.DataFrame, bars: pd.DataFrame
) -> pd.DataFrame:
    """
    Walk every trading day that exists in BOTH datasets and emit one row.
    """
    # Group by ET-local date. We use tz_convert to avoid the UTC/ET boundary
    # issue where a 20:05 UTC message falls on the "wrong" calendar day.
    imbalance_by_day = imbalance.groupby(imbalance.index.tz_convert(ET).date)
    bars_by_day = bars.groupby(bars.index.tz_convert(ET).date)

    rows: list[dict] = []
    for trade_date, day_imbalance in imbalance_by_day:
        if trade_date not in bars_by_day.groups:
            continue  # no price data this day — skip

        day_bars = bars_by_day.get_group(trade_date)
        targets = compute_targets(day_bars)
        if targets is None:
            continue  # incomplete price data

        row: dict = {"trade_date": pd.Timestamp(trade_date)}
        row.update(targets)

        # Snapshot at each target timestamp.
        for label, (h, m) in SNAPSHOT_TIMES.items():
            msg = first_message_at_or_after(day_imbalance, h, m)
            if msg is None:
                # Mark this row as incomplete rather than dropping it —
                # we want to know which days failed and why.
                row[f"{label}_signed_imbalance"] = np.nan
                continue
            row.update(extract_snapshot(msg, label))

        rows.append(row)

    return pd.DataFrame(rows).set_index("trade_date").sort_index()


def derive_cross_snapshot_features(frame: pd.DataFrame) -> pd.DataFrame:
    """
    Features that compare the two snapshots — these are often more
    predictive than either snapshot alone.
    """
    out = frame.copy()
    # How much did signed imbalance change between 15:50 and 15:55?
    # Positive = growing, negative = fading.
    out["imbalance_delta_50_to_55"] = (
        out["T55_signed_imbalance"] - out["T50_signed_imbalance"]
    )
    # Did the side flip between snapshots? (side change = unstable book)
    out["side_flipped"] = (
        (out["T50_side"] != out["T55_side"])
        & out["T50_side"].notna()
        & out["T55_side"].notna()
    )
    return out


# ── Inspect the result ───────────────────────────────────────


def inspect_output(frame: pd.DataFrame) -> None:
    subsection("Dataset shape")
    print(f"  {len(frame):,} trading days, {frame.shape[1]} columns")
    print(f"  Date range: {frame.index.min().date()} -> {frame.index.max().date()}")

    subsection("Completeness (non-null fraction)")
    completeness = frame.notna().mean().sort_values()
    print(completeness.head(10).to_string())

    subsection("Target variable distributions (bps)")
    targets = [
        "realized_return_bps",
        "realized_mfe_bps",
        "realized_mae_down_bps",
        "realized_range_bps",
    ]
    print(frame[targets].describe().to_string())

    subsection("Signed imbalance at 15:50 (QQQ)")
    print(frame["T50_signed_imbalance"].describe().to_string())

    subsection("Sample (first 3 and last 3 rows)")
    show_cols = [
        "T50_signed_imbalance",
        "T55_signed_imbalance",
        "imbalance_delta_50_to_55",
        "realized_return_bps",
        "realized_mae_down_bps",
        "realized_range_bps",
    ]
    print(pd.concat([frame[show_cols].head(3), frame[show_cols].tail(3)]).to_string())


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    args = parse_args()
    section("MOC Imbalance — Phase 1: Feature Construction")

    imbalance = load_imbalance(args.imbalance_parquet)
    bars = load_bars(args.bars_input, args.bars_parquet)

    subsection("Building per-day rows")
    frame = build_per_day_rows(imbalance, bars)
    frame = derive_cross_snapshot_features(frame)

    inspect_output(frame)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(args.output)
    takeaway(
        f"Wrote {len(frame):,} days -> {args.output.relative_to(ML_ROOT)}. "
        "Next phase: EDA — scatter signed imbalance vs MAE, "
        "correlations across snapshots, and regime splits by VIX."
    )


if __name__ == "__main__":
    main()
