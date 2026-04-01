"""
Settlement Pin Risk Analysis

Correlates per-strike gamma exposure profiles with actual settlement
to measure how strongly settlement gravitates toward gamma concentration.
Directly informs BWB sweet-spot placement near close.

Questions this script answers:
1. How often does settlement land within N pts of the peak gamma strike?
2. Does the gamma magnet become more predictive in the last hour?
3. Is the gamma-weighted centroid a better predictor than peak gamma?
4. How does gamma asymmetry (above vs below ATM) predict settlement direction?

Usage:
    python3 ml/pin_analysis.py

Requires: pip install psycopg2-binary pandas sqlalchemy numpy
"""

import sys

try:
    import numpy as np
    import pandas as pd
    from sqlalchemy import create_engine, text
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas sqlalchemy numpy")
    sys.exit(1)

from utils import load_env, section, subsection, takeaway


# ── Time checkpoints (UTC) for analysis ──────────────────────
# Market hours: 13:30-20:00 UTC (9:30 AM - 4:00 PM ET)
# We analyze gamma profiles at several horizons before close.

CHECKPOINTS = {
    "T-4hr (12:00 ET)": "16:00",
    "T-2hr (2:00 PM ET)": "18:00",
    "T-1hr (3:00 PM ET)": "19:00",
    "T-30min (3:30 PM ET)": "19:30",
    "Final snapshot": "20:00",
}

HIT_THRESHOLDS = [5, 10, 15, 20, 30]


# ── Data Loading ─────────────────────────────────────────────

def load_strike_data() -> pd.DataFrame:
    """Load all 0DTE strike exposures with settlement outcomes."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    engine = create_engine(database_url)
    try:
        df = pd.read_sql_query(text("""
            SELECT
                se.date, se.timestamp, se.strike, se.price,
                se.call_gamma_oi, se.put_gamma_oi,
                se.call_delta_oi, se.put_delta_oi,
                o.settlement, o.day_open
            FROM strike_exposures se
            JOIN outcomes o ON o.date = se.date
            WHERE se.expiry = se.date
            ORDER BY se.date, se.timestamp, se.strike
        """), engine)
    finally:
        engine.dispose()

    df["date"] = pd.to_datetime(df["date"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


# ── Gamma Profile Analysis ───────────────────────────────────

def compute_gamma_profile(snapshot: pd.DataFrame) -> dict:
    """
    From a single timestamp's strike data, compute gamma metrics.

    Returns dict with:
      peak_gamma_strike: strike with highest total gamma exposure
      peak_gamma_mag: magnitude at that strike
      gamma_centroid: gamma-weighted average strike
      positive_gamma_above: total positive gamma above ATM
      positive_gamma_below: total positive gamma below ATM
    """
    if len(snapshot) == 0:
        return {}

    df = snapshot.copy()
    df["call_gamma_oi"] = pd.to_numeric(df["call_gamma_oi"], errors="coerce")
    df["put_gamma_oi"] = pd.to_numeric(df["put_gamma_oi"], errors="coerce")
    df["net_gamma"] = df["call_gamma_oi"].fillna(0) + df["put_gamma_oi"].fillna(0)
    df["abs_gamma"] = df["net_gamma"].abs()

    if df["abs_gamma"].sum() == 0:
        return {}

    # Peak absolute gamma (could be positive or negative)
    peak_idx = df["abs_gamma"].idxmax()
    peak_strike = df.loc[peak_idx, "strike"]
    peak_mag = df.loc[peak_idx, "abs_gamma"]

    # Peak POSITIVE gamma — the pinning force (MM mean-reversion hedging)
    pos_gamma = df[df["net_gamma"] > 0]
    if len(pos_gamma) > 0:
        pos_peak_idx = pos_gamma["net_gamma"].idxmax()
        pos_peak_strike = pos_gamma.loc[pos_peak_idx, "strike"]
        pos_peak_mag = pos_gamma.loc[pos_peak_idx, "net_gamma"]
    else:
        pos_peak_strike = peak_strike
        pos_peak_mag = 0.0

    # Peak NEGATIVE gamma — the repelling force (MM acceleration hedging)
    neg_gamma = df[df["net_gamma"] < 0]
    if len(neg_gamma) > 0:
        neg_peak_idx = neg_gamma["net_gamma"].abs().idxmax()
        neg_peak_strike = neg_gamma.loc[neg_peak_idx, "strike"]
        neg_peak_mag = neg_gamma.loc[neg_peak_idx, "net_gamma"]
    else:
        neg_peak_strike = peak_strike
        neg_peak_mag = 0.0

    # Gamma-weighted centroid (absolute weights)
    weights = df["abs_gamma"]
    total_weight = weights.sum()
    centroid = (df["strike"] * weights).sum() / total_weight if total_weight > 0 else 0

    # Positive-gamma-only centroid (pinning centroid)
    if len(pos_gamma) > 0:
        pos_weights = pos_gamma["net_gamma"]
        pos_centroid = (
            (pos_gamma["strike"] * pos_weights).sum() / pos_weights.sum()
        )
    else:
        pos_centroid = centroid

    # Gamma above/below current price
    price = df["price"].iloc[0]
    above = df[df["strike"] > price]
    below = df[df["strike"] <= price]

    pos_gamma_above = above.loc[above["net_gamma"] > 0, "net_gamma"].sum()
    pos_gamma_below = below.loc[below["net_gamma"] > 0, "net_gamma"].sum()

    return {
        "peak_gamma_strike": float(peak_strike),
        "peak_gamma_mag": float(peak_mag),
        "pos_peak_strike": float(pos_peak_strike),
        "pos_peak_mag": float(pos_peak_mag),
        "neg_peak_strike": float(neg_peak_strike),
        "neg_peak_mag": float(neg_peak_mag),
        "gamma_centroid": float(centroid),
        "pos_centroid": float(pos_centroid),
        "pos_gamma_above": float(pos_gamma_above),
        "pos_gamma_below": float(pos_gamma_below),
        "price": float(price),
    }


def find_nearest_snapshot(
    day_data: pd.DataFrame,
    target_time: str,
) -> pd.DataFrame | None:
    """Find the snapshot closest to target_time (HH:MM UTC) for a given day."""
    if len(day_data) == 0:
        return None

    # Build target datetime for this day
    date = day_data["date"].iloc[0]
    target_h, target_m = (int(x) for x in target_time.split(":"))

    timestamps = day_data["timestamp"].unique()
    # Find closest timestamp to target
    best_ts = None
    best_diff = float("inf")
    for ts in timestamps:
        ts_dt = pd.Timestamp(ts)
        diff = abs(ts_dt.hour * 60 + ts_dt.minute - (target_h * 60 + target_m))
        if diff < best_diff:
            best_diff = diff
            best_ts = ts

    if best_ts is None or best_diff > 15:  # within 15 min tolerance
        return None

    return day_data[day_data["timestamp"] == best_ts]


# ── Main Analysis ────────────────────────────────────────────

def analyze_settlement_gravity(df: pd.DataFrame) -> None:
    """Core analysis: does settlement gravitate toward gamma concentration?"""
    section("1. SETTLEMENT vs GAMMA PREDICTORS")
    print("  Comparing positive gamma peak, negative gamma peak, and centroids\n")
    print("  Positive gamma = MM pinning force (mean-reversion hedging)")
    print("  Negative gamma = MM acceleration force (pushes price away)\n")

    dates = sorted(df["date"].unique())
    n_days = len(dates)
    print(f"  Analyzing {n_days} trading days with 0DTE strike data + outcomes\n")

    for cp_name, cp_time in CHECKPOINTS.items():
        subsection(f"{cp_name}")

        rows = []
        for date in dates:
            day_data = df[df["date"] == date]
            settlement = float(day_data["settlement"].iloc[0])

            snapshot = find_nearest_snapshot(day_data, cp_time)
            if snapshot is None:
                continue

            profile = compute_gamma_profile(snapshot)
            if not profile:
                continue

            rows.append({
                "date": date,
                "settlement": settlement,
                "pos_peak_dist": abs(settlement - profile["pos_peak_strike"]),
                "neg_peak_dist": abs(settlement - profile["neg_peak_strike"]),
                "abs_peak_dist": abs(settlement - profile["peak_gamma_strike"]),
                "centroid_dist": abs(settlement - profile["gamma_centroid"]),
                "pos_centroid_dist": abs(settlement - profile["pos_centroid"]),
            })

        if not rows:
            print("  No data available at this checkpoint")
            continue

        dists = pd.DataFrame(rows)
        n = len(dists)

        predictors = [
            ("Pos γ peak (pin)", "pos_peak_dist"),
            ("Neg γ peak (repel)", "neg_peak_dist"),
            ("Abs γ peak", "abs_peak_dist"),
            ("All-γ centroid", "centroid_dist"),
            ("Pos-γ centroid", "pos_centroid_dist"),
        ]

        print(f"  {'Predictor':<22s} {'Avg':>7s} {'Med':>7s} "
              f"{'±10':>5s} {'±20':>5s} {'±30':>5s}")
        print(f"  {'─' * 22} {'─' * 7} {'─' * 7} "
              f"{'─' * 5} {'─' * 5} {'─' * 5}")

        best_name = ""
        best_avg = float("inf")

        for name, col in predictors:
            vals = dists[col]
            avg = vals.mean()
            med = vals.median()
            w10 = (vals <= 10).mean()
            w20 = (vals <= 20).mean()
            w30 = (vals <= 30).mean()
            marker = ""
            if avg < best_avg:
                best_avg = avg
                best_name = name
            print(f"  {name:<22s} {avg:>6.1f} {med:>6.1f} "
                  f"{w10:>4.0%} {w20:>4.0%} {w30:>4.0%}")

        print(f"\n  Best: {best_name} ({best_avg:.1f} pts avg)")


def analyze_time_improvement(df: pd.DataFrame) -> None:
    """Does the gamma magnet become more predictive closer to expiration?"""
    section("2. TIME HORIZON: DOES ACCURACY IMPROVE NEAR CLOSE?")
    print("  Comparing gamma-to-settlement distance across time horizons\n")

    dates = sorted(df["date"].unique())

    results = {}
    for cp_name, cp_time in CHECKPOINTS.items():
        dists = []
        for date in dates:
            day_data = df[df["date"] == date]
            settlement = day_data["settlement"].iloc[0]
            snapshot = find_nearest_snapshot(day_data, cp_time)
            if snapshot is None:
                continue
            profile = compute_gamma_profile(snapshot)
            if not profile:
                continue
            dists.append(abs(settlement - profile["peak_gamma_strike"]))

        if dists:
            results[cp_name] = {
                "avg": np.mean(dists),
                "median": np.median(dists),
                "within_10": sum(1 for d in dists if d <= 10) / len(dists),
                "within_20": sum(1 for d in dists if d <= 20) / len(dists),
                "n": len(dists),
            }

    if not results:
        print("  No data available")
        return

    print(f"  {'Checkpoint':<25s} {'Avg Dist':>9s} {'Med Dist':>9s} "
          f"{'±10 pts':>8s} {'±20 pts':>8s} {'n':>4s}")
    print(f"  {'─' * 25} {'─' * 9} {'─' * 9} {'─' * 8} {'─' * 8} {'─' * 4}")

    for cp_name, r in results.items():
        print(f"  {cp_name:<25s} {r['avg']:>8.1f} {r['median']:>8.1f} "
              f"{r['within_10']:>7.0%} {r['within_20']:>7.0%} {r['n']:>4d}")

    # Check if accuracy improves over time
    checkpoints = list(results.keys())
    if len(checkpoints) >= 2:
        first = results[checkpoints[0]]
        last = results[checkpoints[-1]]
        if last["avg"] < first["avg"]:
            improvement = first["avg"] - last["avg"]
            takeaway(
                f"Gamma magnet improves by {improvement:.1f} pts from "
                f"{checkpoints[0]} to {checkpoints[-1]}.\n"
                "            The closer to expiration, the more predictive "
                "peak gamma is for settlement."
            )
        else:
            takeaway(
                "Gamma magnet does NOT improve closer to expiration.\n"
                "            Peak gamma may not be a reliable settlement "
                "predictor in this dataset."
            )


def analyze_directional_bias(df: pd.DataFrame) -> None:
    """Does gamma asymmetry predict whether settlement is above/below open?"""
    section("3. GAMMA ASYMMETRY vs SETTLEMENT DIRECTION")
    print("  Does more positive gamma above ATM predict upward settlement?\n")

    dates = sorted(df["date"].unique())
    rows = []

    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])
        day_open = float(day_data["day_open"].iloc[0])

        # Use T-2hr snapshot (18:00 UTC / 2 PM ET) — before close but
        # after enough intraday data accumulates
        snapshot = find_nearest_snapshot(day_data, "18:00")
        if snapshot is None:
            continue
        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue

        settled_up = settlement > day_open
        more_gamma_above = profile["pos_gamma_above"] > profile["pos_gamma_below"]

        rows.append({
            "date": date,
            "settled_up": settled_up,
            "more_gamma_above": more_gamma_above,
            "gamma_above": profile["pos_gamma_above"],
            "gamma_below": profile["pos_gamma_below"],
            "settlement_vs_open": settlement - day_open,
        })

    if not rows:
        print("  No data available")
        return

    results = pd.DataFrame(rows)
    n = len(results)

    # Does gamma asymmetry predict direction?
    correct = (results["more_gamma_above"] == results["settled_up"]).sum()
    print(f"  Gamma asymmetry predicts settlement direction: "
          f"{correct}/{n} ({correct / n:.0%})")

    # Break down
    above_heavy = results[results["more_gamma_above"]]
    below_heavy = results[~results["more_gamma_above"]]

    if len(above_heavy) > 0:
        up_pct = above_heavy["settled_up"].mean()
        print(f"  When more gamma ABOVE ATM (n={len(above_heavy)}): "
              f"settled UP {up_pct:.0%}")
    if len(below_heavy) > 0:
        up_pct = below_heavy["settled_up"].mean()
        print(f"  When more gamma BELOW ATM (n={len(below_heavy)}): "
              f"settled UP {up_pct:.0%}")

    if correct / n > 0.55:
        takeaway(
            "Gamma asymmetry has directional predictive power.\n"
            "            Place BWB sweet spot biased toward the side "
            "with MORE positive gamma."
        )
    elif correct / n < 0.45:
        takeaway(
            "Gamma asymmetry is an ANTI-SIGNAL for direction.\n"
            "            Settlement tends to move AWAY from the gamma-heavy "
            "side — possibly because MM hedging creates resistance."
        )
    else:
        takeaway(
            "Gamma asymmetry is not directionally predictive.\n"
            "            Use peak gamma strike for BWB center placement,\n"
            "            not for directional bias."
        )


def load_max_pain() -> pd.DataFrame:
    """Load max pain values from training_features."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        return pd.DataFrame()

    engine = create_engine(database_url)
    try:
        df = pd.read_sql_query(text("""
            SELECT date, max_pain_0dte, max_pain_dist, spx_open
            FROM training_features
            WHERE max_pain_0dte IS NOT NULL
            ORDER BY date
        """), engine)
    except Exception:
        return pd.DataFrame()
    finally:
        engine.dispose()

    if len(df) == 0:
        return df

    df["date"] = pd.to_datetime(df["date"])
    return df


def analyze_max_pain_comparison(
    df: pd.DataFrame,
    max_pain_df: pd.DataFrame,
) -> None:
    """Compare max pain vs peak gamma vs centroid as settlement predictors."""
    section("4. MAX PAIN vs PEAK GAMMA vs CENTROID")
    print("  Which settlement attractor is most accurate?\n")

    if len(max_pain_df) == 0:
        print("  No max pain data in training_features yet.")
        print("  Run build-features?backfill=true after deploy to populate.")
        return

    dates = sorted(df["date"].unique())
    mp_dates = set(max_pain_df["date"].values)
    rows = []

    for date in dates:
        if date not in mp_dates:
            continue

        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])

        mp_row = max_pain_df[max_pain_df["date"] == date].iloc[0]
        max_pain = float(mp_row["max_pain_0dte"])

        # Use T-30min snapshot for peak gamma (actionable BWB window)
        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            snapshot = find_nearest_snapshot(day_data, "19:00")
        if snapshot is None:
            continue

        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue

        rows.append({
            "date": date,
            "settlement": settlement,
            "max_pain": max_pain,
            "mp_dist": abs(settlement - max_pain),
            "pos_peak": profile["pos_peak_strike"],
            "pp_dist": abs(settlement - profile["pos_peak_strike"]),
            "neg_peak": profile["neg_peak_strike"],
            "np_dist": abs(settlement - profile["neg_peak_strike"]),
            "peak_gamma": profile["peak_gamma_strike"],
            "pg_dist": abs(settlement - profile["peak_gamma_strike"]),
            "centroid": profile["gamma_centroid"],
            "gc_dist": abs(settlement - profile["gamma_centroid"]),
            "pos_centroid": profile["pos_centroid"],
            "pc_dist": abs(settlement - profile["pos_centroid"]),
        })

    if not rows:
        print("  No overlapping days with max pain + strike data at T-30min.")
        return

    results = pd.DataFrame(rows)
    n = len(results)

    # Head-to-head comparison
    predictors = {
        "Max Pain": ("mp_dist", results["mp_dist"]),
        "Pos γ Peak (pin)": ("pp_dist", results["pp_dist"]),
        "Neg γ Peak (repel)": ("np_dist", results["np_dist"]),
        "Abs γ Peak": ("pg_dist", results["pg_dist"]),
        "Pos-γ Centroid": ("pc_dist", results["pc_dist"]),
        "All-γ Centroid": ("gc_dist", results["gc_dist"]),
    }

    print(f"  {'Predictor':<18s} {'Avg Dist':>9s} {'Med Dist':>9s} "
          f"{'±10 pts':>8s} {'±20 pts':>8s} {'±30 pts':>8s} {'n':>4s}")
    print(f"  {'─' * 18} {'─' * 9} {'─' * 9} "
          f"{'─' * 8} {'─' * 8} {'─' * 8} {'─' * 4}")

    best_name = ""
    best_avg = float("inf")

    for name, (_, dists) in predictors.items():
        avg = dists.mean()
        med = dists.median()
        w10 = (dists <= 10).mean()
        w20 = (dists <= 20).mean()
        w30 = (dists <= 30).mean()
        marker = ""
        if avg < best_avg:
            best_avg = avg
            best_name = name
        print(f"  {name:<18s} {avg:>8.1f} {med:>8.1f} "
              f"{w10:>7.0%} {w20:>7.0%} {w30:>7.0%} {n:>4d}")

    # Mark best after printing (re-print with marker)
    print(f"\n  Best predictor by avg distance: {best_name} ({best_avg:.1f} pts)")

    # Pairwise wins
    subsection("Head-to-Head: Which predictor was closest on each day?")
    pp_vs_mp = (results["pp_dist"] < results["mp_dist"]).sum()
    pp_vs_np = (results["pp_dist"] < results["np_dist"]).sum()
    print(f"  Pos γ peak closer than Max Pain:    {pp_vs_mp}/{n} days ({pp_vs_mp / n:.0%})")
    print(f"  Pos γ peak closer than Neg γ peak:  {pp_vs_np}/{n} days ({pp_vs_np / n:.0%})")

    pc_vs_gc = (results["pc_dist"] < results["gc_dist"]).sum()
    print(f"  Pos-γ centroid closer than All-γ:   {pc_vs_gc}/{n} days ({pc_vs_gc / n:.0%})")

    # Composite: average of pos peak and pos centroid
    results["composite"] = (results["pos_peak"] + results["pos_centroid"]) / 2
    results["comp_dist"] = (results["settlement"] - results["composite"]).abs()
    comp_avg = results["comp_dist"].mean()
    comp_w20 = (results["comp_dist"] <= 20).mean()
    print(f"\n  Composite (avg of pos γ peak + pos γ centroid):")
    print(f"    Avg distance: {comp_avg:.1f} pts, ±20 pts: {comp_w20:.0%}")

    if comp_avg < best_avg:
        takeaway(
            "COMPOSITE wins — averaging max pain and peak gamma\n"
            "            is a better BWB anchor than either alone.\n"
            f"            Composite avg distance: {comp_avg:.1f} pts "
            f"vs best single: {best_avg:.1f} pts."
        )
    else:
        takeaway(
            f"{best_name} is the best single predictor "
            f"({best_avg:.1f} pts avg).\n"
            "            Use it as the primary BWB sweet-spot anchor."
        )


def analyze_per_day_detail(df: pd.DataFrame, max_pain_df: pd.DataFrame) -> None:
    """Show per-day detail for the most recent 10 days."""
    section("5. RECENT DAY DETAIL")
    print("  Per-day settlement attractors for the last 10 trading days\n")

    dates = sorted(df["date"].unique())[-10:]
    mp_dates = set(max_pain_df["date"].values) if len(max_pain_df) > 0 else set()

    print(f"  {'Date':<12s} {'Settle':>8s} {'+γ Peak':>8s} {'Dist':>6s} "
          f"{'-γ Peak':>8s} {'Dist':>6s} {'MaxPain':>8s} {'Dist':>6s}")
    print(f"  {'─' * 12} {'─' * 8} {'─' * 8} {'─' * 6} "
          f"{'─' * 8} {'─' * 6} {'─' * 8} {'─' * 6}")

    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])

        # Use final snapshot
        snapshot = find_nearest_snapshot(day_data, "20:00")
        if snapshot is None:
            snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            continue

        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue

        pos_peak = profile["pos_peak_strike"]
        neg_peak = profile["neg_peak_strike"]
        pp_dist = abs(settlement - pos_peak)
        np_dist = abs(settlement - neg_peak)

        # Max pain if available
        mp_str = "—"
        mp_dist_str = "—"
        if date in mp_dates:
            mp_row = max_pain_df[max_pain_df["date"] == date].iloc[0]
            mp_val = float(mp_row["max_pain_0dte"])
            mp_str = f"{mp_val:>.0f}"
            mp_dist_str = f"{abs(settlement - mp_val):>.1f}"

        date_str = pd.Timestamp(date).strftime("%Y-%m-%d")
        print(f"  {date_str:<12s} {settlement:>8.1f} {pos_peak:>8.0f} "
              f"{pp_dist:>5.1f} {neg_peak:>8.0f} {np_dist:>5.1f} "
              f"{mp_str:>8s} {mp_dist_str:>6s}")


def key_findings(df: pd.DataFrame, max_pain_df: pd.DataFrame) -> None:
    """Print actionable summary."""
    section("KEY FINDINGS — BWB PLACEMENT")

    dates = sorted(df["date"].unique())

    # Compute T-30min stats for positive gamma peak
    pg_dists = []
    pos_peak_dists = []
    pos_centroid_dists = []
    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])
        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            continue
        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue
        pg_dists.append(abs(settlement - profile["peak_gamma_strike"]))
        pos_peak_dists.append(abs(settlement - profile["pos_peak_strike"]))
        pos_centroid_dists.append(abs(settlement - profile["pos_centroid"]))

    # Compute max pain stats
    mp_dates = set(max_pain_df["date"].values) if len(max_pain_df) > 0 else set()
    mp_dists = []
    for date in dates:
        if date not in mp_dates:
            continue
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])
        mp_row = max_pain_df[max_pain_df["date"] == date].iloc[0]
        mp_dists.append(abs(settlement - float(mp_row["max_pain_0dte"])))

    print(f"\n  POS GAMMA PEAK — the pin (at T-30min, n={len(pos_peak_dists)}):")
    if pos_peak_dists:
        avg = np.mean(pos_peak_dists)
        w10 = sum(1 for d in pos_peak_dists if d <= 10) / len(pos_peak_dists)
        w20 = sum(1 for d in pos_peak_dists if d <= 20) / len(pos_peak_dists)
        print(f"    Within ±10 pts: {w10:.0%}")
        print(f"    Within ±20 pts: {w20:.0%}")
        print(f"    Avg distance:   {avg:.1f} pts")
    else:
        print("    No data at T-30min checkpoint")

    print(f"\n  POS-GAMMA CENTROID (at T-30min, n={len(pos_centroid_dists)}):")
    if pos_centroid_dists:
        avg_pc = np.mean(pos_centroid_dists)
        w10_pc = sum(1 for d in pos_centroid_dists if d <= 10) / len(pos_centroid_dists)
        w20_pc = sum(1 for d in pos_centroid_dists if d <= 20) / len(pos_centroid_dists)
        print(f"    Within ±10 pts: {w10_pc:.0%}")
        print(f"    Within ±20 pts: {w20_pc:.0%}")
        print(f"    Avg distance:   {avg_pc:.1f} pts")

    print(f"\n  MAX PAIN (n={len(mp_dists)}):")
    if mp_dists:
        mp_avg = np.mean(mp_dists)
        mp_w10 = sum(1 for d in mp_dists if d <= 10) / len(mp_dists)
        mp_w20 = sum(1 for d in mp_dists if d <= 20) / len(mp_dists)
        print(f"    Within ±10 pts: {mp_w10:.0%}")
        print(f"    Within ±20 pts: {mp_w20:.0%}")
        print(f"    Avg distance:   {mp_avg:.1f} pts")
    else:
        print("    No max pain data yet — run build-features?backfill=true")

    # Recommendation
    print("\n  RECOMMENDATION:")
    if pos_peak_dists:
        pp_avg = np.mean(pos_peak_dists)
        pc_avg = np.mean(pos_centroid_dists) if pos_centroid_dists else float("inf")
        mp_avg = np.mean(mp_dists) if mp_dists else float("inf")

        # Find best
        candidates = [
            ("Pos gamma peak", pp_avg),
            ("Pos-gamma centroid", pc_avg),
        ]
        if mp_dists:
            candidates.append(("Max pain", mp_avg))

        best_name, best_val = min(candidates, key=lambda x: x[1])
        print(f"  Best BWB anchor: {best_name} ({best_val:.1f} pts avg)")

        if best_name.startswith("Pos"):
            print(f"  Use the largest positive gamma strike (or centroid of "
                  f"positive gamma) at 3:30 PM ET as your BWB sweet spot.")
        else:
            print(f"  Use max pain as the primary anchor, with positive "
                  f"gamma as confirmation.")

        if mp_dists:
            print(f"\n  Max pain ({mp_avg:.1f} pts) vs Pos γ peak "
                  f"({pp_avg:.1f} pts) — "
                  f"{'gamma wins' if pp_avg < mp_avg else 'max pain wins'}.")
    else:
        print("  Insufficient data. Accumulate more trading days with "
              "dense intraday strike coverage.")


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    print("Loading strike exposure + settlement data ...")
    df = load_strike_data()

    n_days = df["date"].nunique()
    date_range = f"{df['date'].min():%Y-%m-%d} to {df['date'].max():%Y-%m-%d}"
    n_rows = len(df)
    print(f"  {n_rows:,} strike exposure rows across {n_days} days ({date_range})")

    if n_days < 3:
        print("Error: Need at least 3 days with strike + settlement data.")
        sys.exit(1)

    print("Loading max pain data from training_features ...")
    max_pain_df = load_max_pain()
    mp_count = len(max_pain_df)
    if mp_count > 0:
        print(f"  {mp_count} days with max pain data")
    else:
        print("  No max pain data yet (run build-features?backfill=true "
              "after deploy)")

    analyze_settlement_gravity(df)
    analyze_time_improvement(df)
    analyze_directional_bias(df)
    analyze_max_pain_comparison(df, max_pain_df)
    analyze_per_day_detail(df, max_pain_df)
    key_findings(df, max_pain_df)
    print()


if __name__ == "__main__":
    main()
