"""Extract per-fire net-flow features from Postgres into features.parquet.

For every row in `lottery_finder_fires` joined with the ticker's
`net_flow_per_ticker_history` series, compute a 10-feature vector
describing the matched-side cumulative flow trajectory leading into
`trigger_time_ct`. See README for the feature list.

Run: `ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/extract_features.py`

Requires DATABASE_URL in env (use the same .env.local as the backfill).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from scipy.signal import find_peaks

EXPERIMENT_DIR = Path(__file__).parent
OUT_PARQUET = EXPERIMENT_DIR / "features.parquet"

# Pre-fire window in minutes the slope/variance features look back over.
# 30 min picks up the TSLA-style slow-NCP-grind into a fire; 5/15 capture
# faster regime shifts.
PRE_FIRE_WINDOW_MIN = 30
SLOPE_WINDOWS_MIN = (5, 15, 30)

# scipy.signal.find_peaks prominence ratio — 5% of the day's matched-side
# range. Locks the peak-detection algorithm per spec section "Resolved
# questions" Q4.
PEAK_PROMINENCE_RATIO = 0.05


def load_data(conn) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Pull both tables. Net flow is filtered to tickers we have fires
    for to keep the in-memory join tight."""
    fires = pd.read_sql(
        """
        SELECT
          id, date, trigger_time_ct, underlying_symbol AS ticker,
          option_type, strike, entry_price,
          mode, tod, reload_tagged, cheap_call_pm_tagged, flow_quad,
          realized_trail30_10_pct, realized_hard30m_pct,
          realized_tier50_holdeod_pct, realized_eod_pct,
          peak_ceiling_pct, minutes_to_peak
        FROM lottery_finder_fires
        WHERE realized_trail30_10_pct IS NOT NULL
        ORDER BY trigger_time_ct
        """,
        conn,
    )
    if fires.empty:
        return fires, pd.DataFrame()

    tickers = tuple(sorted(fires["ticker"].unique()))
    flow = pd.read_sql(
        """
        SELECT ticker, ts, net_call_prem, net_put_prem,
               net_call_vol, net_put_vol
        FROM net_flow_per_ticker_history
        WHERE ticker = ANY(%(tickers)s)
        ORDER BY ticker, ts
        """,
        conn,
        params={"tickers": list(tickers)},
    )
    # Coerce numerics — psycopg2 returns NUMERIC as Decimal.
    for col in ("net_call_prem", "net_put_prem"):
        flow[col] = pd.to_numeric(flow[col], errors="coerce").astype("float64")
    for col in ("net_call_vol", "net_put_vol"):
        flow[col] = pd.to_numeric(flow[col], errors="coerce").astype("Int64")
    return fires, flow


def add_session_date(flow: pd.DataFrame) -> pd.DataFrame:
    """Bucket flow rows into trading-day groups in CT."""
    ts_ct = flow["ts"].dt.tz_convert("America/Chicago")
    flow = flow.copy()
    flow["session_date"] = ts_ct.dt.date
    return flow


def features_for_fire(
    fire_row: pd.Series, flow_day: pd.DataFrame
) -> dict[str, float | bool | None]:
    """Compute the 10-feature vector for one fire given its ticker's
    full session-day flow series. flow_day is pre-filtered to the
    fire's (ticker, session_date)."""
    matched_side = "net_call_prem" if fire_row["option_type"] == "C" else "net_put_prem"
    other_side = "net_put_prem" if matched_side == "net_call_prem" else "net_call_prem"

    # Cumulative series for both sides (we report ncp/npp at fire
    # regardless of matched side so the feature names stay legible).
    cum_ncp = flow_day["net_call_prem"].cumsum()
    cum_npp = flow_day["net_put_prem"].cumsum()
    cum_matched = cum_ncp if matched_side == "net_call_prem" else cum_npp

    fire_ts = fire_row["trigger_time_ct"]
    # Index of last flow row at-or-before the fire. flow_day is sorted
    # by ts so searchsorted gives O(log n) lookup.
    pre_fire_mask = flow_day["ts"] <= fire_ts
    if not pre_fire_mask.any():
        return _empty_features()
    last_idx = pre_fire_mask.idxmax() + pre_fire_mask.sum() - 1

    ncp_at_fire = float(cum_ncp.iloc[: pre_fire_mask.sum()].iloc[-1])
    npp_at_fire = float(cum_npp.iloc[: pre_fire_mask.sum()].iloc[-1])
    matched_at_fire = float(cum_matched.iloc[: pre_fire_mask.sum()].iloc[-1])

    # Slopes over each window: (cum[t] - cum[t - window]) / window
    slopes: dict[int, float | None] = {}
    for win in SLOPE_WINDOWS_MIN:
        cutoff_ts = fire_ts - pd.Timedelta(minutes=win)
        prev_idx = (flow_day["ts"] <= cutoff_ts).sum() - 1
        if prev_idx < 0:
            slopes[win] = None
        else:
            prev_val = float(cum_matched.iloc[prev_idx])
            slopes[win] = (matched_at_fire - prev_val) / float(win)

    asymmetry: float | None = None
    if (ncp_at_fire + npp_at_fire) != 0:
        asymmetry = ncp_at_fire / (ncp_at_fire + npp_at_fire)

    direction_match = (
        slopes[5] is not None and slopes[5] > 0
    )  # matched side has positive 5m slope

    # Level vs day-high (matched-side cumulative). Use absolute value
    # so put-side level is comparable to call-side (both should grow
    # in absolute terms when the side is dominant).
    matched_so_far = cum_matched.iloc[: pre_fire_mask.sum()].abs()
    day_high = float(matched_so_far.max())
    level_pct = float(matched_so_far.iloc[-1] / day_high) if day_high > 0 else None

    # Variance of per-minute deltas over prior 30 min.
    pre_window_mask = (flow_day["ts"] >= fire_ts - pd.Timedelta(minutes=PRE_FIRE_WINDOW_MIN)) & (
        flow_day["ts"] <= fire_ts
    )
    pre_window_deltas = flow_day.loc[pre_window_mask, matched_side]
    pre_fire_var = (
        float(pre_window_deltas.std(ddof=0)) if len(pre_window_deltas) >= 2 else None
    )

    # Lead time to last matched-side local peak (scipy.find_peaks).
    matched_arr = matched_so_far.to_numpy(dtype="float64")
    day_range = matched_arr.max() - matched_arr.min()
    lead_time: float | None = None
    if day_range > 0 and len(matched_arr) >= 5:
        peaks, _ = find_peaks(matched_arr, prominence=day_range * PEAK_PROMINENCE_RATIO)
        if len(peaks) > 0:
            # Index of the most recent peak in flow_day rows.
            last_peak_idx = int(peaks[-1])
            peak_ts = flow_day["ts"].iloc[last_peak_idx]
            lead_time = (fire_ts - peak_ts).total_seconds() / 60.0

    return {
        "ncp_at_fire": ncp_at_fire,
        "npp_at_fire": npp_at_fire,
        "matched_at_fire": matched_at_fire,
        "ncp_slope_5m": slopes[5],
        "ncp_slope_15m": slopes[15],
        "ncp_slope_30m": slopes[30],
        "asymmetry": asymmetry,
        "direction_match": direction_match,
        "level_pct_of_day_high": level_pct,
        "pre_fire_variance": pre_fire_var,
        "lead_time_to_peak_min": lead_time,
        "_pre_fire_row_count": int(pre_fire_mask.sum()),
    }


def _empty_features() -> dict[str, float | None]:
    return {
        "ncp_at_fire": None,
        "npp_at_fire": None,
        "matched_at_fire": None,
        "ncp_slope_5m": None,
        "ncp_slope_15m": None,
        "ncp_slope_30m": None,
        "asymmetry": None,
        "direction_match": None,
        "level_pct_of_day_high": None,
        "pre_fire_variance": None,
        "lead_time_to_peak_min": None,
        "_pre_fire_row_count": 0,
    }


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1

    print(f"connecting...")
    with psycopg2.connect(db_url) as conn:
        fires, flow = load_data(conn)

    if fires.empty:
        print("No enriched fires found — nothing to extract.")
        return 0

    flow["ts"] = pd.to_datetime(flow["ts"], utc=True)
    flow = add_session_date(flow)
    fires["trigger_time_ct"] = pd.to_datetime(fires["trigger_time_ct"], utc=True)
    fires["fire_session_date"] = (
        fires["trigger_time_ct"].dt.tz_convert("America/Chicago").dt.date
    )

    print(f"  fires:       {len(fires):>7,}")
    print(f"  flow rows:   {len(flow):>7,}")
    print(f"  unique tickers in fires: {fires['ticker'].nunique()}")

    # Group flow by (ticker, session_date) once — O(N) groupby beats
    # per-fire query each time.
    flow_groups = flow.groupby(["ticker", "session_date"], observed=True)

    rows: list[dict] = []
    missing_pairs = 0
    for fire in fires.itertuples(index=False):
        key = (fire.ticker, fire.fire_session_date)
        if key not in flow_groups.groups:
            missing_pairs += 1
            rows.append(
                {
                    "fire_id": fire.id,
                    **_empty_features(),
                }
            )
            continue
        flow_day = flow_groups.get_group(key)
        feats = features_for_fire(pd.Series(fire._asdict()), flow_day)
        rows.append({"fire_id": fire.id, **feats})

    feat_df = pd.DataFrame(rows)
    print(f"  fires missing matched flow day: {missing_pairs:,}")

    # Re-attach outcome + tag columns from fires.
    out = fires.merge(
        feat_df,
        left_on="id",
        right_on="fire_id",
        how="left",
        validate="1:1",
    ).drop(columns=["fire_id"])

    print(f"\noutput shape: {out.shape}")
    print(f"feature null counts:")
    feat_cols = [
        "ncp_at_fire",
        "ncp_slope_5m",
        "ncp_slope_15m",
        "ncp_slope_30m",
        "asymmetry",
        "direction_match",
        "level_pct_of_day_high",
        "pre_fire_variance",
        "lead_time_to_peak_min",
    ]
    for col in feat_cols:
        n_null = out[col].isna().sum()
        print(f"  {col:<30} {n_null:>5,} null ({n_null / len(out) * 100:.1f}%)")

    out.to_parquet(OUT_PARQUET, index=False)
    print(f"\nwrote {OUT_PARQUET} ({OUT_PARQUET.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
