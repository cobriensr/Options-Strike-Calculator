"""
Cross-Section EDA: Lottery Fires + Silent Boom Alerts
Finds feature signals correlated with peak_ceiling_pct >= 50% and >= 100%
that are NOT already in the score formula.

Usage:
    set -a && source .env.local && set +a
    ml/.venv/bin/python ml/src/cross_section_eda.py

Saves plots to ml/plots/ and prints structured findings.
"""

import os
import sys
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.gridspec as gridspec
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

warnings.filterwarnings("ignore")

ML_ROOT = Path(__file__).resolve().parent.parent
PLOTS_DIR = ML_ROOT / "plots"
PLOTS_DIR.mkdir(exist_ok=True)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not set. Run: set -a && source .env.local && set +a")
    sys.exit(1)


def get_conn():
    return psycopg2.connect(DATABASE_URL, sslmode="require")


# ── Cohort helpers ────────────────────────────────────────────────────────────

def label_cohort(series: pd.Series) -> pd.Series:
    """Assign cohort labels to a peak_ceiling_pct series."""
    out = pd.Series("non_winner", index=series.index)
    out[series >= 50] = "win50"
    out[series >= 100] = "win100"
    return out


def cohort_stats(df: pd.DataFrame, feature_col: str, bins: list | None = None,
                 labels: list | None = None, verbose: bool = True) -> pd.DataFrame:
    """
    For a feature column, compute win-rate stats per stratum.
    Returns a DataFrame with rows = strata, cols = N, win50_rate, win100_rate, non_winner_rate.
    """
    if bins is not None:
        df = df.copy()
        df["_stratum"] = pd.cut(df[feature_col], bins=bins, labels=labels,
                                 include_lowest=True)
    else:
        df = df.copy()
        df["_stratum"] = df[feature_col]

    df = df.dropna(subset=["_stratum", "peak_ceiling_pct"])
    total_win50_rate = (df["peak_ceiling_pct"] >= 50).mean()
    total_win100_rate = (df["peak_ceiling_pct"] >= 100).mean()

    rows = []
    for stratum, grp in df.groupby("_stratum", observed=True):
        n = len(grp)
        w50 = (grp["peak_ceiling_pct"] >= 50).mean()
        w100 = (grp["peak_ceiling_pct"] >= 100).mean()
        nw = (grp["peak_ceiling_pct"] < 10).mean()
        lift50 = w50 / total_win50_rate if total_win50_rate > 0 else np.nan
        lift100 = w100 / total_win100_rate if total_win100_rate > 0 else np.nan
        rows.append({
            "stratum": stratum,
            "N": n,
            "win50_rate": w50,
            "win100_rate": w100,
            "non_winner_rate": nw,
            "lift50": lift50,
            "lift100": lift100,
            "underpowered": n < 50,
        })
    result = pd.DataFrame(rows)
    if verbose:
        print(f"\n  Baseline: win50={total_win50_rate:.1%}  win100={total_win100_rate:.1%}  N={len(df)}")
    return result


# ── Load base tables ──────────────────────────────────────────────────────────

def load_sb() -> pd.DataFrame:
    print("Loading silent_boom_alerts...")
    q = """
    SELECT id, date, bucket_ct, option_chain_id, underlying_symbol, option_type,
           strike, expiry, dte, spike_ratio, baseline_volume, ask_pct, vol_oi, entry_price,
           open_interest, score, score_tier,
           mkt_tide_diff, mkt_tide_otm_diff, zero_dte_diff, spx_spot_gamma_oi,
           multi_leg_share, underlying_price_at_spike,
           peak_ceiling_pct, minutes_to_peak, realized_eod_pct
    FROM silent_boom_alerts
    WHERE peak_ceiling_pct IS NOT NULL
    ORDER BY date, bucket_ct
    """
    with get_conn() as conn:
        df = pd.read_sql_query(q, conn, parse_dates=["date", "bucket_ct", "expiry"])
    df["option_type"] = df["option_type"].str.strip()
    print(f"  SB rows: {len(df):,}  date range: {df['date'].min().date()} to {df['date'].max().date()}")
    return df


def load_lf() -> pd.DataFrame:
    print("Loading lottery_finder_fires...")
    q = """
    SELECT id, date, trigger_time_ct, entry_time_ct, option_chain_id,
           underlying_symbol, option_type, strike, expiry, dte,
           trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
           trigger_delta, trigger_ask_pct, entry_price, open_interest,
           spot_at_first, alert_seq, minutes_since_prev_fire,
           flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged,
           burst_ratio_vs_prev, entry_drop_pct_vs_prev,
           mkt_tide_ncp, mkt_tide_npp, mkt_tide_diff, mkt_tide_otm_diff,
           spx_flow_diff, spy_etf_diff, qqq_etf_diff, zero_dte_diff,
           spx_spot_gamma_oi, spx_spot_gamma_vol, spx_spot_charm_oi, spx_spot_vanna_oi,
           gex_strike_call_minus_put, gex_strike_call_ask_minus_bid, gex_strike_put_ask_minus_bid,
           gex_strike_actual_strike,
           realized_trail30_10_pct, realized_hard30m_pct, realized_tier50_holdeod_pct,
           realized_eod_pct, peak_ceiling_pct, minutes_to_peak, score, direction_gated
    FROM lottery_finder_fires
    WHERE peak_ceiling_pct IS NOT NULL
    ORDER BY date, trigger_time_ct
    """
    with get_conn() as conn:
        df = pd.read_sql_query(q, conn, parse_dates=["date", "trigger_time_ct", "entry_time_ct", "expiry"])
    df["option_type"] = df["option_type"].str.strip()
    print(f"  LF rows: {len(df):,}  date range: {df['date'].min().date()} to {df['date'].max().date()}")
    return df


# ── Hypothesis 1: Cross-asset ETF flow confirmation ───────────────────────────

def h1_etf_flow_alignment(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    For LF: spy_etf_diff and qqq_etf_diff already in table.
    For SB: mkt_tide_diff is the closest analog; need to load ETF flow at spike time.

    We define "aligned" as:
    - For CALLS: spy_etf_diff > 0 AND qqq_etf_diff > 0
    - For PUTS: spy_etf_diff < 0 AND qqq_etf_diff < 0

    For SB we use mkt_tide_diff (positive = bullish) as alignment proxy.
    """
    print("\n=== H1: ETF Flow Alignment ===")

    # LF already has spy_etf_diff and qqq_etf_diff
    lf_h = lf.dropna(subset=["spy_etf_diff", "qqq_etf_diff"]).copy()
    lf_h["both_positive"] = (lf_h["spy_etf_diff"] > 0) & (lf_h["qqq_etf_diff"] > 0)
    lf_h["both_negative"] = (lf_h["spy_etf_diff"] < 0) & (lf_h["qqq_etf_diff"] < 0)
    lf_h["is_call"] = lf_h["option_type"] == "C"

    lf_h["aligned"] = (
        (lf_h["is_call"] & lf_h["both_positive"]) |
        (~lf_h["is_call"] & lf_h["both_negative"])
    )

    lf_stats = cohort_stats(lf_h, "aligned")
    print("LF H1 - Aligned vs Not:")
    print(lf_stats.to_string(index=False))

    # 2x2: aligned x option_type for LF
    lf_2x2 = []
    for ot in ["C", "P"]:
        for aligned in [True, False]:
            grp = lf_h[(lf_h["option_type"] == ot) & (lf_h["aligned"] == aligned)]
            n = len(grp)
            if n == 0:
                continue
            w50 = (grp["peak_ceiling_pct"] >= 50).mean()
            w100 = (grp["peak_ceiling_pct"] >= 100).mean()
            lf_2x2.append({"option_type": ot, "aligned": aligned, "N": n,
                            "win50": w50, "win100": w100})
    lf_2x2_df = pd.DataFrame(lf_2x2)
    print("\nLF 2x2 (aligned x type):")
    print(lf_2x2_df.to_string(index=False))

    # SB: use mkt_tide_diff as alignment proxy
    # mkt_tide_diff > 0 = bullish, < 0 = bearish
    sb_h = sb.dropna(subset=["mkt_tide_diff"]).copy()
    sb_h["is_call"] = sb_h["option_type"] == "C"
    sb_h["aligned"] = (
        (sb_h["is_call"] & (sb_h["mkt_tide_diff"] > 0)) |
        (~sb_h["is_call"] & (sb_h["mkt_tide_diff"] < 0))
    )
    sb_stats = cohort_stats(sb_h, "aligned")
    print("\nSB H1 - mkt_tide_diff Aligned vs Not:")
    print(sb_stats.to_string(index=False))

    return {"lf": lf_stats, "lf_2x2": lf_2x2_df, "sb": sb_stats}


# ── Hypothesis 2: Strike distance from gamma-flip ────────────────────────────

def h2_strike_distance(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    Gamma-flip = strike where net gamma (call - put) changes sign.
    Use gex_strike_0dte: for each fire's date, find the gamma-flip strike
    using the snapshot closest in time BEFORE the fire.

    We compute abs(fire_strike - gamma_flip) / spot * 100 as % distance.
    """
    print("\n=== H2: Strike Distance from Gamma Flip ===")

    # Load gex daily gamma-flip approximation
    # Find the strike with max |net gamma| near the spot, where call_gamma_oi - put_gamma_oi changes sign
    print("  Loading gex_strike_0dte for gamma-flip computation...")
    # NOTE: query prepared but not yet wired up; underscore-prefixed to
    # satisfy ruff F841 (unused) without discarding the SQL.
    _gex_q = """
    WITH ranked AS (
        SELECT date, timestamp, strike, price,
               call_gamma_oi, put_gamma_oi,
               (call_gamma_oi - put_gamma_oi) AS net_gamma,
               ROW_NUMBER() OVER (PARTITION BY date, timestamp ORDER BY ABS(call_gamma_oi - put_gamma_oi) DESC) AS rn
        FROM gex_strike_0dte
        WHERE call_gamma_oi IS NOT NULL AND put_gamma_oi IS NOT NULL
    )
    SELECT date, timestamp, strike, price, net_gamma
    FROM ranked WHERE rn = 1
    """
    # Actually let's compute gamma flip more carefully: daily gamma-neutral strike
    # = the strike where cumulative net gamma from puts to calls crosses zero
    # Simpler: daily max(call_gamma_oi) strike as a proxy for the gamma wall
    gex_q2 = """
    SELECT date,
           DATE_TRUNC('hour', timestamp) as hour_ts,
           strike,
           (call_gamma_oi - put_gamma_oi) AS net_gamma,
           call_gamma_oi,
           put_gamma_oi,
           price
    FROM gex_strike_0dte
    WHERE call_gamma_oi IS NOT NULL AND put_gamma_oi IS NOT NULL
    ORDER BY date, hour_ts
    """
    with get_conn() as conn:
        gex = pd.read_sql_query(gex_q2, conn, parse_dates=["date", "hour_ts"])

    # For each date+hour, find the strike closest to gamma flip (where net_gamma changes sign)
    # Use the strike with smallest |net_gamma| weighted by position magnitude as gamma-neutral proxy
    def gamma_flip_for_group(grp):
        # Sort by strike, find where net_gamma changes sign
        grp = grp.sort_values("strike")
        # If all same sign, return the strike with min |net_gamma|
        pos = grp[grp["net_gamma"] > 0]
        neg = grp[grp["net_gamma"] < 0]
        if pos.empty or neg.empty:
            return grp.loc[grp["net_gamma"].abs().idxmin(), "strike"]
        # Interpolate between last negative and first positive
        neg_last = neg.iloc[-1]
        pos_first = pos.iloc[0]
        # Linear interpolation
        total = abs(neg_last["net_gamma"]) + pos_first["net_gamma"]
        if total == 0:
            return (neg_last["strike"] + pos_first["strike"]) / 2
        flip = neg_last["strike"] + (pos_first["strike"] - neg_last["strike"]) * abs(neg_last["net_gamma"]) / total
        return flip

    print("  Computing gamma-flip per date/hour...")
    gex_flip = (
        gex.groupby(["date", "hour_ts"])
        .apply(gamma_flip_for_group, include_groups=False)
        .reset_index()
    )
    gex_flip.columns = ["date", "hour_ts", "gamma_flip_strike"]

    # For SB: match on date + bucket_ct hour
    sb_h = sb.dropna(subset=["underlying_price_at_spike", "strike"]).copy()
    sb_h = sb_h[sb_h["underlying_symbol"].isin(["SPX", "SPXW", "SPY"])]
    sb_h["hour_ts"] = sb_h["bucket_ct"].dt.floor("h")
    sb_h = sb_h.merge(gex_flip, on=["date", "hour_ts"], how="left")
    sb_h = sb_h.dropna(subset=["gamma_flip_strike"])
    sb_h["spot"] = sb_h["underlying_price_at_spike"].astype(float)
    sb_h["dist_pct"] = (
        (sb_h["strike"].astype(float) - sb_h["gamma_flip_strike"].astype(float)).abs()
        / sb_h["spot"] * 100
    )
    sb_bins = [0, 0.25, 0.5, 1.0, 2.0, 100]
    sb_labels = ["<=0.25%", "0.25-0.5%", "0.5-1%", "1-2%", "2%+"]
    sb_stats = cohort_stats(sb_h, "dist_pct", bins=sb_bins, labels=sb_labels)
    print(f"\nSB H2 - Strike dist from gamma-flip (N with gex match: {len(sb_h)}):")
    print(sb_stats.to_string(index=False))

    # For LF: use gex_strike_actual_strike as gamma wall proxy
    lf_h = lf.dropna(subset=["gex_strike_actual_strike", "spot_at_first"]).copy()
    lf_h["dist_pct"] = (
        (lf_h["strike"].astype(float) - lf_h["gex_strike_actual_strike"].astype(float)).abs()
        / lf_h["spot_at_first"].astype(float) * 100
    )
    lf_bins = [0, 0.25, 0.5, 1.0, 2.0, 100]
    lf_labels = ["<=0.25%", "0.25-0.5%", "0.5-1%", "1-2%", "2%+"]
    lf_stats = cohort_stats(lf_h, "dist_pct", bins=lf_bins, labels=lf_labels)
    print(f"\nLF H2 - Strike dist from gex_strike_actual (N with match: {len(lf_h)}):")
    print(lf_stats.to_string(index=False))

    return {"sb": sb_stats, "lf": lf_stats}


# ── Hypothesis 3: Session range position ─────────────────────────────────────

def h3_session_range(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    For each fire, compute (spot_at_fire - session_low) / (session_high - session_low)
    using 1-min candles up to fire time.
    """
    print("\n=== H3: Session Range Position ===")

    # Load SPX candles for the relevant date range
    sb_min_date = sb["date"].min()
    lf_min_date = lf["date"].min()
    min_date = min(sb_min_date, lf_min_date)

    print(f"  Loading index_candles_1m from {min_date.date()}...")
    candle_q = """
    SELECT date, timestamp, open, high, low, close
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND market_time = 'r'
      AND timestamp >= %(min_date)s::date
    ORDER BY date, timestamp
    """
    with get_conn() as conn:
        candles = pd.read_sql_query(candle_q, conn,
                                     params={"min_date": str(min_date.date())},
                                     parse_dates=["date", "timestamp"])

    # For each (date, fire_ts), get session range up to fire_ts
    # Pre-compute cumulative session high/low per date
    candles = candles.sort_values(["date", "timestamp"])
    candles["session_high"] = candles.groupby("date")["high"].cummax()
    candles["session_low"] = candles.groupby("date")["low"].cummin()

    # Merge SB
    def compute_range_position(fires_df, time_col, spot_col, label):
        fires = fires_df.dropna(subset=[spot_col]).copy()
        fires["fire_minute"] = fires[time_col].dt.floor("min")
        # Merge on date + minute (join on nearest prior minute)
        merged = pd.merge_asof(
            fires.sort_values("fire_minute"),
            candles[["date", "timestamp", "session_high", "session_low"]].rename(columns={"timestamp": "fire_minute"}),
            on="fire_minute", by="date", direction="backward"
        )
        merged = merged.dropna(subset=["session_high", "session_low"])
        spot = merged[spot_col].astype(float)
        s_high = merged["session_high"].astype(float)
        s_low = merged["session_low"].astype(float)
        rng = s_high - s_low
        merged["range_pos"] = np.where(rng > 0.5, (spot - s_low) / rng, np.nan)
        merged = merged.dropna(subset=["range_pos"])
        bins = [0, 0.1, 0.3, 0.7, 0.9, 1.0001]
        labels_list = ["bottom10%", "low30%", "mid40%", "high70%", "top10%"]
        stats_df = cohort_stats(merged, "range_pos", bins=bins, labels=labels_list)
        print(f"\n{label} H3 - Session range position (N={len(merged)}):")
        print(stats_df.to_string(index=False))
        return stats_df, merged

    sb_stats, sb_merged = compute_range_position(sb, "bucket_ct", "underlying_price_at_spike", "SB")
    lf_stats, lf_merged = compute_range_position(lf, "trigger_time_ct", "spot_at_first", "LF")

    return {"sb": sb_stats, "lf": lf_stats}


# ── Hypothesis 4: Day-stacking / yesterday's winner ──────────────────────────

def h4_day_stacking(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    For each (ticker, date) pair, was that ticker a winner (peak ≥ 50%) yesterday?
    """
    print("\n=== H4: Day Stacking (yesterday's winner) ===")

    def compute_yesterday(df, ticker_col, date_col, time_col):
        # Daily winner flag per ticker
        daily = (
            df.groupby([ticker_col, date_col])["peak_ceiling_pct"]
            .apply(lambda x: (x >= 50).any())
            .reset_index()
        )
        daily.columns = [ticker_col, date_col, "was_winner_today"]
        daily["next_date"] = daily[date_col] + pd.Timedelta(days=1)
        # Handle weekends: next trading day
        # Simple approach: just check any fire within 5 days
        winner_map = daily.set_index([ticker_col, date_col])["was_winner_today"].to_dict()

        def get_yesterday_winner(row):
            # Look back 1-7 days for a prior date
            for d in range(1, 8):
                prev_date = row[date_col] - pd.Timedelta(days=d)
                key = (row[ticker_col], prev_date)
                if key in winner_map:
                    return winner_map[key]
            return np.nan

        df2 = df.copy()
        # Only take first fire per ticker per day to avoid leakage within day
        df2["yesterday_winner"] = df2.apply(get_yesterday_winner, axis=1)
        return cohort_stats(df2.dropna(subset=["yesterday_winner"]), "yesterday_winner")

    # This can be slow — use a vectorized approach instead
    def compute_yesterday_fast(df, ticker_col, date_col):
        # Build daily winner flag
        daily = (
            df.groupby([ticker_col, date_col])["peak_ceiling_pct"]
            .apply(lambda x: (x >= 50).any())
            .reset_index(name="daily_win50")
        )
        # Shift by trading day within each ticker
        daily = daily.sort_values([ticker_col, date_col])
        daily["prev_date"] = daily.groupby(ticker_col)[date_col].shift(1)
        daily["days_gap"] = (daily[date_col] - daily["prev_date"]).dt.days
        # "Yesterday" = gap ≤ 4 (covers Fri→Mon)
        daily["was_winner_yesterday"] = np.where(
            daily["days_gap"].between(1, 4),
            daily.groupby(ticker_col)["daily_win50"].shift(1),
            np.nan
        )
        # Merge back to all fires
        df2 = df.merge(daily[[ticker_col, date_col, "was_winner_yesterday"]],
                        on=[ticker_col, date_col], how="left")
        df2 = df2.dropna(subset=["was_winner_yesterday"])
        df2["was_winner_yesterday"] = df2["was_winner_yesterday"].astype(bool)
        stats_df = cohort_stats(df2, "was_winner_yesterday")
        print(f"  N with yesterday data: {len(df2)}")
        print(stats_df.to_string(index=False))
        return stats_df

    print("SB H4:")
    sb_stats = compute_yesterday_fast(sb, "underlying_symbol", "date")
    print("LF H4:")
    lf_stats = compute_yesterday_fast(lf, "underlying_symbol", "date")

    return {"sb": sb_stats, "lf": lf_stats}


# ── Hypothesis 5: Intra-chain sequence position ───────────────────────────────

def h5_chain_sequence(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    LF: alert_seq (1=first, 2+=later)
    SB: derive sequence by ranking bucket_ct within (date, option_chain_id)
    """
    print("\n=== H5: Intra-chain sequence position ===")

    # LF: use alert_seq directly — compare seq=1 vs seq>=2 vs seq>=5
    lf_h = lf.copy()
    lf_h["seq_bucket"] = pd.cut(lf_h["alert_seq"],
                                  bins=[0, 1, 2, 5, 9999],
                                  labels=["seq=1", "seq=2", "seq=3-5", "seq=6+"],
                                  right=True)
    lf_stats = cohort_stats(lf_h, "seq_bucket")
    print("LF H5 - Chain sequence:")
    print(lf_stats.to_string(index=False))

    # SB: derive sequence within (date, option_chain_id)
    sb_h = sb.sort_values(["date", "option_chain_id", "bucket_ct"]).copy()
    sb_h["chain_seq"] = sb_h.groupby(["date", "option_chain_id"]).cumcount() + 1
    sb_h["seq_bucket"] = pd.cut(sb_h["chain_seq"],
                                  bins=[0, 1, 2, 5, 9999],
                                  labels=["seq=1", "seq=2", "seq=3-5", "seq=6+"],
                                  right=True)
    sb_stats = cohort_stats(sb_h, "seq_bucket")
    print("SB H5 - Chain sequence:")
    print(sb_stats.to_string(index=False))

    return {"lf": lf_stats, "sb": sb_stats}


# ── Hypothesis 6: Time to next macro event ───────────────────────────────────

def h6_macro_proximity(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    Check distance to next major economic event.
    """
    print("\n=== H6: Macro Event Proximity ===")

    macro_q = """
    SELECT date, event_name, event_time, event_type
    FROM economic_events
    WHERE event_type IN ('CPI', 'FOMC', 'JOBS', 'PCE')
    ORDER BY date
    """
    with get_conn() as conn:
        macro = pd.read_sql_query(macro_q, conn, parse_dates=["date", "event_time"])

    if macro.empty:
        print("  No major macro events found — skipping H6")
        return {"sb": None, "lf": None}

    print(f"  Found {len(macro)} major macro events (CPI/FOMC/JOBS/PCE)")

    def compute_macro_dist(df, time_col, label):
        fires = df.copy()
        # NOTE: sorted frame computed but unused below — underscore-prefixed
        # to satisfy ruff F841. Possible latent bug (intended to drive the
        # per-fire loop?); left in place rather than removed.
        _fires_sorted = fires.sort_values(time_col)

        # For each fire, find hours to next macro event
        macro_times = macro.sort_values("date")["date"].values

        def hours_to_next(fire_date):
            future = macro_times[macro_times >= np.datetime64(fire_date)]
            if len(future) == 0:
                return np.nan
            return (pd.Timestamp(future[0]) - pd.Timestamp(fire_date)).total_seconds() / 3600

        fires["hours_to_macro"] = fires["date"].apply(hours_to_next)
        fires = fires.dropna(subset=["hours_to_macro"])

        bins = [0, 24, 72, 168, 10000]
        labels_list = ["<24h", "24-72h", "72h-1w", ">1w"]
        stats_df = cohort_stats(fires, "hours_to_macro", bins=bins, labels=labels_list)
        print(f"\n{label} H6 - Hours to next macro event:")
        print(stats_df.to_string(index=False))
        return stats_df

    sb_stats = compute_macro_dist(sb, "bucket_ct", "SB")
    lf_stats = compute_macro_dist(lf, "trigger_time_ct", "LF")

    return {"sb": sb_stats, "lf": lf_stats}


# ── Hypothesis 7: Intra-hour minute bucket ───────────────────────────────────

def h7_minute_bucket(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    Extract bucket_minute % 60 and check :00/:15/:30/:45 vs other minutes.
    """
    print("\n=== H7: Intra-hour minute bucket ===")

    def compute_minute(df, time_col, label):
        df2 = df.copy()
        df2["minute_of_hour"] = df2[time_col].dt.minute
        # Bucket into :00-:05, :15±2, :30±2, :45±2, other
        def classify_minute(m):
            if m <= 5:
                return ":00-:05"
            elif 13 <= m <= 17:
                return ":15±2"
            elif 28 <= m <= 32:
                return ":30±2"
            elif 43 <= m <= 47:
                return ":45±2"
            else:
                return "other"

        df2["minute_bucket"] = df2["minute_of_hour"].apply(classify_minute)
        stats_df = cohort_stats(df2, "minute_bucket")
        print(f"\n{label} H7 - Minute-of-hour bucket:")
        print(stats_df.to_string(index=False))
        return stats_df

    sb_stats = compute_minute(sb, "bucket_ct", "SB")
    lf_stats = compute_minute(lf, "trigger_time_ct", "LF")

    return {"sb": sb_stats, "lf": lf_stats}


# ── Bonus: Vol/OI ratio for SB, multi_leg_share ──────────────────────────────

def h_bonus_voloi_multileg(sb: pd.DataFrame, lf: pd.DataFrame) -> dict:
    """
    SB: vol_oi ratio (not in score) — might correlate with outcome.
    SB+LF: multi_leg_share (SB has it; LF doesn't directly).
    LF: trigger_vol_to_oi_window — not in score directly.
    """
    print("\n=== BONUS: Vol/OI and Multi-leg share ===")

    # SB vol_oi
    sb_h = sb.copy()
    sb_h_voloi = sb_h.dropna(subset=["vol_oi"])
    sb_bins = [0, 0.5, 1.0, 2.0, 5.0, 9999]
    sb_labels = ["<0.5", "0.5-1", "1-2", "2-5", "5+"]
    sb_stats = cohort_stats(sb_h_voloi, "vol_oi", bins=sb_bins, labels=sb_labels)
    print("SB BONUS - Vol/OI ratio:")
    print(sb_stats.to_string(index=False))

    # SB multi_leg_share (multi-leg as pct of spike volume)
    sb_h_ml = sb_h.dropna(subset=["multi_leg_share"])
    ml_bins = [0, 0.1, 0.3, 0.5, 0.7, 1.0001]
    ml_labels = ["<10%", "10-30%", "30-50%", "50-70%", "70-100%"]
    sb_ml_stats = cohort_stats(sb_h_ml, "multi_leg_share", bins=ml_bins, labels=ml_labels)
    print("\nSB BONUS - Multi-leg share:")
    print(sb_ml_stats.to_string(index=False))

    # LF trigger_vol_to_oi_window
    lf_h = lf.copy()
    lf_bins = [0, 0.5, 1.0, 2.0, 5.0, 9999]
    lf_labels = ["<0.5", "0.5-1", "1-2", "2-5", "5+"]
    lf_stats = cohort_stats(lf_h, "trigger_vol_to_oi_window", bins=lf_bins, labels=lf_labels)
    print("\nLF BONUS - trigger_vol_to_oi_window:")
    print(lf_stats.to_string(index=False))

    # LF burst_ratio_vs_prev (not in score)
    lf_burst = lf.dropna(subset=["burst_ratio_vs_prev"])
    burst_bins = [0, 1.5, 2, 3, 5, 9999]
    burst_labels = ["<1.5x", "1.5-2x", "2-3x", "3-5x", "5x+"]
    lf_burst_stats = cohort_stats(lf_burst, "burst_ratio_vs_prev", bins=burst_bins, labels=burst_labels)
    print("\nLF BONUS - burst_ratio_vs_prev:")
    print(lf_burst_stats.to_string(index=False))

    return {"sb_voloi": sb_stats, "sb_ml": sb_ml_stats, "lf_voloi": lf_stats, "lf_burst": lf_burst_stats}


# ── Plotting ──────────────────────────────────────────────────────────────────

plt.rcParams.update({
    "figure.facecolor": "#1a1a2e",
    "axes.facecolor": "#16213e",
    "axes.edgecolor": "#444466",
    "axes.labelcolor": "#ccccdd",
    "axes.titlecolor": "#e0e0f0",
    "xtick.color": "#aaaacc",
    "ytick.color": "#aaaacc",
    "text.color": "#ccccdd",
    "legend.facecolor": "#1a1a2e",
    "legend.edgecolor": "#444466",
})

COLORS = {"win50": "#22cc88", "win100": "#44aaff", "non_winner": "#ff4466"}


def plot_hypothesis_bars(stats_df: pd.DataFrame, title: str, filename: str) -> None:
    """Bar chart of win50 and win100 rates by stratum."""
    if stats_df is None or len(stats_df) == 0:
        return
    fig, ax = plt.subplots(figsize=(9, 4), facecolor="#1a1a2e")
    ax.set_facecolor("#16213e")

    strata = [str(s) for s in stats_df["stratum"]]
    x = np.arange(len(strata))
    w = 0.35

    bars50 = ax.bar(x - w/2, stats_df["win50_rate"] * 100, w,
                     label="Win ≥50%", color="#22cc88", alpha=0.85)
    ax.bar(x + w/2, stats_df["win100_rate"] * 100, w,
                      label="Win ≥100%", color="#44aaff", alpha=0.85)

    # Add N labels
    for i, (bar, n) in enumerate(zip(bars50, stats_df["N"])):
        flag = " *" if stats_df.iloc[i]["underpowered"] else ""
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.5,
                f"N={n}{flag}", ha="center", va="bottom", fontsize=7, color="#aaaacc")

    ax.set_xticks(x)
    ax.set_xticklabels(strata, rotation=15, ha="right")
    ax.set_ylabel("Win Rate (%)")
    ax.set_title(title, fontsize=11)
    ax.legend(loc="upper right")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"{y:.0f}%"))
    plt.tight_layout()
    out = PLOTS_DIR / filename
    plt.savefig(out, dpi=120, bbox_inches="tight")
    plt.close()
    print(f"  Plot: {out}")


def make_summary_dashboard(results: dict) -> None:
    """Summary figure: top 4 candidate features side by side."""
    fig = plt.figure(figsize=(16, 10), facecolor="#1a1a2e")
    gs = gridspec.GridSpec(2, 2, figure=fig, hspace=0.45, wspace=0.35)

    panel_data = [
        ("H1 ETF Flow Alignment - LF", results.get("h1", {}).get("lf")),
        ("H1 mkt_tide Alignment - SB", results.get("h1", {}).get("sb")),
        ("H5 Chain Sequence - LF", results.get("h5", {}).get("lf")),
        ("H5 Chain Sequence - SB", results.get("h5", {}).get("sb")),
    ]

    for idx, (title, df) in enumerate(panel_data):
        row, col = divmod(idx, 2)
        ax = fig.add_subplot(gs[row, col])
        ax.set_facecolor("#16213e")
        if df is None or len(df) == 0:
            ax.text(0.5, 0.5, "No data", ha="center", va="center", transform=ax.transAxes)
            ax.set_title(title)
            continue
        strata = [str(s) for s in df["stratum"]]
        x = np.arange(len(strata))
        w = 0.35
        ax.bar(x - w/2, df["win50_rate"] * 100, w, label="≥50%", color="#22cc88", alpha=0.85)
        ax.bar(x + w/2, df["win100_rate"] * 100, w, label="≥100%", color="#44aaff", alpha=0.85)
        ax.set_xticks(x)
        ax.set_xticklabels(strata, rotation=15, ha="right", fontsize=8)
        ax.set_title(title, fontsize=9)
        ax.legend(fontsize=7, loc="upper right")
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"{y:.0f}%"))
        ax.set_ylabel("Win Rate (%)", fontsize=8)

    fig.suptitle("Cross-Section EDA: LF + SB Feature Signals", fontsize=13,
                  color="#e0e0f0", fontweight="bold")
    out = PLOTS_DIR / "cross_section_eda_summary_2026-05-15.png"
    plt.savefig(out, dpi=120, bbox_inches="tight")
    plt.close()
    print(f"\n  Summary dashboard: {out}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    sb = load_sb()
    lf = load_lf()

    results = {}
    results["h1"] = h1_etf_flow_alignment(sb, lf)
    results["h2"] = h2_strike_distance(sb, lf)
    results["h3"] = h3_session_range(sb, lf)
    results["h4"] = h4_day_stacking(sb, lf)
    results["h5"] = h5_chain_sequence(sb, lf)
    results["h6"] = h6_macro_proximity(sb, lf)
    results["h7"] = h7_minute_bucket(sb, lf)
    results["bonus"] = h_bonus_voloi_multileg(sb, lf)

    # Individual plots
    if results["h1"]["lf"] is not None:
        plot_hypothesis_bars(results["h1"]["lf"], "H1: ETF Flow Alignment - Lottery Fires",
                              "h1_etf_alignment_lf_2026-05-15.png")
    if results["h1"]["sb"] is not None:
        plot_hypothesis_bars(results["h1"]["sb"], "H1: mkt_tide Alignment - Silent Boom",
                              "h1_etf_alignment_sb_2026-05-15.png")
    if results["h2"]["sb"] is not None:
        plot_hypothesis_bars(results["h2"]["sb"], "H2: Strike vs Gamma-Flip Distance - SB",
                              "h2_gamma_flip_sb_2026-05-15.png")
    if results["h2"]["lf"] is not None:
        plot_hypothesis_bars(results["h2"]["lf"], "H2: Strike vs GEX Wall Distance - LF",
                              "h2_gamma_flip_lf_2026-05-15.png")
    if results["h3"]["sb"] is not None:
        plot_hypothesis_bars(results["h3"]["sb"], "H3: Session Range Position - SB",
                              "h3_range_pos_sb_2026-05-15.png")
    if results["h3"]["lf"] is not None:
        plot_hypothesis_bars(results["h3"]["lf"], "H3: Session Range Position - LF",
                              "h3_range_pos_lf_2026-05-15.png")
    if results["h4"]["sb"] is not None:
        plot_hypothesis_bars(results["h4"]["sb"], "H4: Yesterday's Winner - SB",
                              "h4_day_stack_sb_2026-05-15.png")
    if results["h4"]["lf"] is not None:
        plot_hypothesis_bars(results["h4"]["lf"], "H4: Yesterday's Winner - LF",
                              "h4_day_stack_lf_2026-05-15.png")
    if results["h5"]["lf"] is not None:
        plot_hypothesis_bars(results["h5"]["lf"], "H5: Chain Sequence - Lottery Fires",
                              "h5_chain_seq_lf_2026-05-15.png")
    if results["h5"]["sb"] is not None:
        plot_hypothesis_bars(results["h5"]["sb"], "H5: Chain Sequence - Silent Boom",
                              "h5_chain_seq_sb_2026-05-15.png")
    if results["h7"]["sb"] is not None:
        plot_hypothesis_bars(results["h7"]["sb"], "H7: Minute Bucket - SB",
                              "h7_minute_bucket_sb_2026-05-15.png")
    if results["h7"]["lf"] is not None:
        plot_hypothesis_bars(results["h7"]["lf"], "H7: Minute Bucket - LF",
                              "h7_minute_bucket_lf_2026-05-15.png")
    if results["bonus"]["sb_voloi"] is not None:
        plot_hypothesis_bars(results["bonus"]["sb_voloi"], "BONUS: Vol/OI Ratio - SB",
                              "bonus_voloi_sb_2026-05-15.png")
    if results["bonus"]["lf_burst"] is not None:
        plot_hypothesis_bars(results["bonus"]["lf_burst"], "BONUS: Burst Ratio vs Prev - LF",
                              "bonus_burst_lf_2026-05-15.png")

    make_summary_dashboard(results)
    print("\n=== EDA complete ===")


if __name__ == "__main__":
    main()
