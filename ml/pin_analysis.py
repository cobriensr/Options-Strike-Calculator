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

    # Peak gamma strike (highest absolute gamma exposure)
    peak_idx = df["abs_gamma"].idxmax()
    peak_strike = df.loc[peak_idx, "strike"]
    peak_mag = df.loc[peak_idx, "abs_gamma"]

    # Gamma-weighted centroid
    weights = df["abs_gamma"]
    total_weight = weights.sum()
    centroid = (df["strike"] * weights).sum() / total_weight if total_weight > 0 else 0

    # Gamma above/below current price
    price = df["price"].iloc[0]
    above = df[df["strike"] > price]
    below = df[df["strike"] <= price]

    pos_gamma_above = above.loc[above["net_gamma"] > 0, "net_gamma"].sum()
    pos_gamma_below = below.loc[below["net_gamma"] > 0, "net_gamma"].sum()

    return {
        "peak_gamma_strike": float(peak_strike),
        "peak_gamma_mag": float(peak_mag),
        "gamma_centroid": float(centroid),
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
    section("1. SETTLEMENT vs PEAK GAMMA STRIKE")
    print("  Does settlement land near the strike with the most gamma exposure?\n")

    dates = sorted(df["date"].unique())
    n_days = len(dates)
    print(f"  Analyzing {n_days} trading days with 0DTE strike data + outcomes\n")

    # For each checkpoint, compute peak gamma and distance to settlement
    for cp_name, cp_time in CHECKPOINTS.items():
        subsection(f"{cp_name}")

        distances = []
        centroid_distances = []

        for date in dates:
            day_data = df[df["date"] == date]
            settlement = day_data["settlement"].iloc[0]

            snapshot = find_nearest_snapshot(day_data, cp_time)
            if snapshot is None:
                continue

            profile = compute_gamma_profile(snapshot)
            if not profile:
                continue

            dist = settlement - profile["peak_gamma_strike"]
            distances.append({
                "date": date,
                "settlement": settlement,
                "peak_strike": profile["peak_gamma_strike"],
                "distance": dist,
                "abs_distance": abs(dist),
                "centroid": profile["gamma_centroid"],
                "centroid_dist": abs(settlement - profile["gamma_centroid"]),
                "price_at_snapshot": profile["price"],
            })

        if not distances:
            print("  No data available at this checkpoint")
            continue

        dists = pd.DataFrame(distances)
        n = len(dists)

        # Hit rates at various thresholds
        print(f"  {'Threshold':<15s} {'Hit Rate':>10s} {'Count':>8s}")
        print(f"  {'─' * 15} {'─' * 10} {'─' * 8}")
        for thresh in HIT_THRESHOLDS:
            hits = (dists["abs_distance"] <= thresh).sum()
            rate = hits / n
            print(f"  ±{thresh} pts{'':<9s} {rate:>9.0%} {hits:>5d}/{n}")

        avg_dist = dists["abs_distance"].mean()
        med_dist = dists["abs_distance"].median()
        avg_centroid = dists["centroid_dist"].mean()
        print(f"\n  Avg distance to peak gamma:    {avg_dist:.1f} pts")
        print(f"  Median distance to peak gamma: {med_dist:.1f} pts")
        print(f"  Avg distance to gamma centroid: {avg_centroid:.1f} pts")

        # Which is better — peak gamma or centroid?
        peak_better = (dists["abs_distance"] < dists["centroid_dist"]).sum()
        print(f"  Peak gamma closer than centroid: {peak_better}/{n} days "
              f"({peak_better / n:.0%})")


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


def analyze_per_day_detail(df: pd.DataFrame) -> None:
    """Show per-day detail for the most recent 10 days."""
    section("4. RECENT DAY DETAIL")
    print("  Per-day peak gamma vs settlement for the last 10 trading days\n")

    dates = sorted(df["date"].unique())[-10:]

    print(f"  {'Date':<12s} {'Settle':>8s} {'Peak γ':>8s} {'Dist':>7s} "
          f"{'Centroid':>9s} {'C-Dist':>7s} {'Within':>8s}")
    print(f"  {'─' * 12} {'─' * 8} {'─' * 8} {'─' * 7} "
          f"{'─' * 9} {'─' * 7} {'─' * 8}")

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

        peak = profile["peak_gamma_strike"]
        centroid = profile["gamma_centroid"]
        dist = abs(settlement - peak)
        c_dist = abs(settlement - centroid)
        within = "✓ ±10" if dist <= 10 else ("~ ±20" if dist <= 20 else "✗")

        date_str = pd.Timestamp(date).strftime("%Y-%m-%d")
        print(f"  {date_str:<12s} {settlement:>8.1f} {peak:>8.0f} "
              f"{dist:>6.1f} {centroid:>9.1f} {c_dist:>6.1f} "
              f"{within:>8s}")


def key_findings(df: pd.DataFrame) -> None:
    """Print actionable summary."""
    section("KEY FINDINGS — BWB PLACEMENT")

    dates = sorted(df["date"].unique())

    # Compute final-snapshot stats
    dists = []
    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])
        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            continue
        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue
        dists.append(abs(settlement - profile["peak_gamma_strike"]))

    if not dists:
        print("\n  Insufficient data for conclusions.")
        return

    n = len(dists)
    avg = np.mean(dists)
    within_10 = sum(1 for d in dists if d <= 10) / n
    within_20 = sum(1 for d in dists if d <= 20) / n

    print(f"\n  Dataset: {n} trading days with 0DTE strike + settlement data")
    print(f"  At T-30min (3:30 PM ET):")
    print(f"    Settlement within ±10 pts of peak gamma: {within_10:.0%}")
    print(f"    Settlement within ±20 pts of peak gamma: {within_20:.0%}")
    print(f"    Average distance: {avg:.1f} pts")

    if within_20 >= 0.50:
        print(f"\n  SIGNAL: Peak gamma at 3:30 PM is a useful BWB anchor.")
        print(f"  Place the BWB sweet spot within ±20 pts of the peak gamma "
              f"strike.")
    elif within_20 >= 0.35:
        print(f"\n  MARGINAL: Peak gamma has moderate predictive power.")
        print(f"  Use it as one input alongside max pain and price action.")
    else:
        print(f"\n  WEAK: Peak gamma is NOT a strong settlement predictor.")
        print(f"  Do not rely on it for BWB placement.")


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

    analyze_settlement_gravity(df)
    analyze_time_improvement(df)
    analyze_directional_bias(df)
    analyze_per_day_detail(df)
    key_findings(df)
    print()


if __name__ == "__main__":
    main()
