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
    python3 ml/pin_analysis.py            # Analysis only
    python3 ml/pin_analysis.py --plot     # Analysis + save plots to ml/plots/

Requires: pip install psycopg2-binary pandas sqlalchemy numpy scikit-learn matplotlib seaborn
"""

import argparse
import sys

try:
    import numpy as np
    import pandas as pd
    from sklearn.impute import SimpleImputer
    from sklearn.model_selection import TimeSeriesSplit, cross_val_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import LabelEncoder, StandardScaler
    from sklearn.tree import DecisionTreeClassifier
    from sqlalchemy import create_engine, text
except ImportError:
    print("Missing dependencies. Run:")
    print(
        "  ml/.venv/bin/pip install psycopg2-binary pandas sqlalchemy numpy scikit-learn"
    )
    sys.exit(1)

from utils import (
    ML_ROOT,
    load_env,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

PLOT_DIR = ML_ROOT / "plots"


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


def load_strike_data(dte_filter: str = "0dte") -> pd.DataFrame:
    """Load strike exposures with settlement outcomes.

    Args:
        dte_filter: '0dte' (expiry == date), '1dte' (next trading day),
                    or 'combined' (both 0 DTE and 1 DTE rows merged).
    """
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    expiry_clauses = {
        "0dte": "se.expiry = se.date",
        "1dte": ("se.expiry > se.date AND se.expiry <= se.date + INTERVAL '3 days'"),
        "combined": (
            "se.expiry >= se.date AND se.expiry <= se.date + INTERVAL '3 days'"
        ),
    }
    where = expiry_clauses.get(dte_filter)
    if where is None:
        raise ValueError(
            f"Invalid dte_filter: {dte_filter!r}. "
            "Expected '0dte', '1dte', or 'combined'."
        )

    engine = create_engine(database_url)
    try:
        df = pd.read_sql_query(
            text(f"""
            SELECT
                se.date, se.timestamp, se.strike, se.price,
                se.call_gamma_oi, se.put_gamma_oi,
                se.call_delta_oi, se.put_delta_oi,
                o.settlement, o.day_open
            FROM strike_exposures se
            JOIN outcomes o ON o.date = se.date
            WHERE {where}
            ORDER BY se.date, se.timestamp, se.strike
        """),
            engine,
        )
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
        pos_centroid = (pos_gamma["strike"] * pos_weights).sum() / pos_weights.sum()
    else:
        pos_centroid = centroid

    # Proximity-weighted gamma centroid: gamma / distance^2 from price
    # Closer walls have exponentially more influence on settlement
    price = float(df["price"].iloc[0])
    df["dist_from_price"] = (df["strike"].astype(float) - price).abs().clip(lower=1)
    df["prox_weight"] = df["abs_gamma"] / (df["dist_from_price"] ** 2)
    prox_total = df["prox_weight"].sum()
    prox_centroid = (
        (df["strike"].astype(float) * df["prox_weight"]).sum() / prox_total
        if prox_total > 0
        else centroid
    )

    # Gamma above/below current price
    above = df[df["strike"].astype(float) > price]
    below = df[df["strike"].astype(float) <= price]

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
        "prox_centroid": float(prox_centroid),
        "pos_gamma_above": float(pos_gamma_above),
        "pos_gamma_below": float(pos_gamma_below),
        "price": price,
    }


def find_nearest_snapshot(
    day_data: pd.DataFrame,
    target_time: str,
) -> pd.DataFrame | None:
    """Find the snapshot closest to target_time (HH:MM UTC) for a given day."""
    if len(day_data) == 0:
        return None

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

            rows.append(
                {
                    "date": date,
                    "settlement": settlement,
                    "pos_peak_dist": abs(settlement - profile["pos_peak_strike"]),
                    "neg_peak_dist": abs(settlement - profile["neg_peak_strike"]),
                    "abs_peak_dist": abs(settlement - profile["peak_gamma_strike"]),
                    "centroid_dist": abs(settlement - profile["gamma_centroid"]),
                    "pos_centroid_dist": abs(settlement - profile["pos_centroid"]),
                    "prox_centroid_dist": abs(settlement - profile["prox_centroid"]),
                }
            )

        if not rows:
            print("  No data available at this checkpoint")
            continue

        dists = pd.DataFrame(rows)

        predictors = [
            ("Pos γ peak (pin)", "pos_peak_dist"),
            ("Neg γ peak (repel)", "neg_peak_dist"),
            ("Abs γ peak", "abs_peak_dist"),
            ("All-γ centroid", "centroid_dist"),
            ("Pos-γ centroid", "pos_centroid_dist"),
            ("Prox-wt centroid", "prox_centroid_dist"),
        ]

        print(
            f"  {'Predictor':<22s} {'Avg':>7s} {'Med':>7s} "
            f"{'±10':>5s} {'±20':>5s} {'±30':>5s}"
        )
        print(f"  {'─' * 22} {'─' * 7} {'─' * 7} {'─' * 5} {'─' * 5} {'─' * 5}")

        best_name = ""
        best_avg = float("inf")

        for name, col in predictors:
            vals = dists[col]
            avg = vals.mean()
            med = vals.median()
            w10 = (vals <= 10).mean()
            w20 = (vals <= 20).mean()
            w30 = (vals <= 30).mean()
            if avg < best_avg:
                best_avg = avg
                best_name = name
            print(
                f"  {name:<22s} {avg:>6.1f} {med:>6.1f} "
                f"{w10:>4.0%} {w20:>4.0%} {w30:>4.0%}"
            )

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

    print(
        f"  {'Checkpoint':<25s} {'Avg Dist':>9s} {'Med Dist':>9s} "
        f"{'±10 pts':>8s} {'±20 pts':>8s} {'n':>4s}"
    )
    print(f"  {'─' * 25} {'─' * 9} {'─' * 9} {'─' * 8} {'─' * 8} {'─' * 4}")

    for cp_name, r in results.items():
        print(
            f"  {cp_name:<25s} {r['avg']:>8.1f} {r['median']:>8.1f} "
            f"{r['within_10']:>7.0%} {r['within_20']:>7.0%} {r['n']:>4d}"
        )

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

        rows.append(
            {
                "date": date,
                "settled_up": settled_up,
                "more_gamma_above": more_gamma_above,
                "gamma_above": profile["pos_gamma_above"],
                "gamma_below": profile["pos_gamma_below"],
                "settlement_vs_open": settlement - day_open,
            }
        )

    if not rows:
        print("  No data available")
        return

    results = pd.DataFrame(rows)
    n = len(results)

    # Does gamma asymmetry predict direction?
    correct = (results["more_gamma_above"] == results["settled_up"]).sum()
    print(
        f"  Gamma asymmetry predicts settlement direction: "
        f"{correct}/{n} ({correct / n:.0%})"
    )

    # Break down
    above_heavy = results[results["more_gamma_above"]]
    below_heavy = results[~results["more_gamma_above"]]

    if len(above_heavy) > 0:
        up_pct = above_heavy["settled_up"].mean()
        print(
            f"  When more gamma ABOVE ATM (n={len(above_heavy)}): "
            f"settled UP {up_pct:.0%}"
        )
    if len(below_heavy) > 0:
        up_pct = below_heavy["settled_up"].mean()
        print(
            f"  When more gamma BELOW ATM (n={len(below_heavy)}): "
            f"settled UP {up_pct:.0%}"
        )

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


def load_oi_per_strike() -> pd.DataFrame:
    """Load per-strike OI data from oi_per_strike table."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        return pd.DataFrame()

    engine = create_engine(database_url)
    try:
        # Check if table exists first
        check = pd.read_sql_query(
            text(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                "WHERE table_name = 'oi_per_strike')"
            ),
            engine,
        )
        if not check.iloc[0, 0]:
            return pd.DataFrame()

        df = pd.read_sql_query(
            text("""
            SELECT date, strike, call_oi, put_oi,
                   COALESCE(call_oi, 0) + COALESCE(put_oi, 0) AS total_oi
            FROM oi_per_strike
            ORDER BY date, strike
        """),
            engine,
        )
    except Exception:
        return pd.DataFrame()
    finally:
        engine.dispose()

    if len(df) == 0:
        return df

    df["date"] = pd.to_datetime(df["date"])
    return df


def compute_oi_pin(oi_day: pd.DataFrame) -> dict:
    """
    From a single day's OI data, compute the OI-based pin strike.

    Returns dict with:
      oi_pin_strike: strike with highest total OI (traditional pin)
      oi_pin_total: total OI at that strike
      oi_centroid: OI-weighted average strike
      oi_put_call_ratio: total put OI / total call OI
      oi_concentration: fraction of total OI in top 3 strikes
    """
    if len(oi_day) == 0:
        return {}

    df = oi_day.copy()
    df["total_oi"] = df["call_oi"].fillna(0) + df["put_oi"].fillna(0)

    if df["total_oi"].sum() == 0:
        return {}

    # Peak OI strike (traditional pin)
    peak_idx = df["total_oi"].idxmax()
    pin_strike = float(df.loc[peak_idx, "strike"])
    pin_total = int(df.loc[peak_idx, "total_oi"])

    # OI-weighted centroid
    weights = df["total_oi"]
    total_weight = weights.sum()
    centroid = float((df["strike"].astype(float) * weights).sum() / total_weight)

    # Put/call ratio
    total_calls = df["call_oi"].fillna(0).sum()
    total_puts = df["put_oi"].fillna(0).sum()
    pcr = float(total_puts / total_calls) if total_calls > 0 else 0.0

    # OI concentration (top 3 strikes as fraction of total)
    top3 = df.nlargest(3, "total_oi")["total_oi"].sum()
    concentration = float(top3 / total_weight) if total_weight > 0 else 0.0

    return {
        "oi_pin_strike": pin_strike,
        "oi_pin_total": pin_total,
        "oi_centroid": centroid,
        "oi_put_call_ratio": pcr,
        "oi_concentration": concentration,
    }


def load_max_pain() -> pd.DataFrame:
    """Load max pain values from training_features."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        return pd.DataFrame()

    engine = create_engine(database_url)
    try:
        df = pd.read_sql_query(
            text("""
            SELECT date, max_pain_0dte, max_pain_dist, spx_open
            FROM training_features
            WHERE max_pain_0dte IS NOT NULL
            ORDER BY date
        """),
            engine,
        )
    except Exception:
        return pd.DataFrame()
    finally:
        engine.dispose()

    if len(df) == 0:
        return df

    df["date"] = pd.to_datetime(df["date"])
    return df


def analyze_all_predictors(
    df: pd.DataFrame,
    max_pain_df: pd.DataFrame,
    oi_df: pd.DataFrame,
) -> None:
    """Compare ALL settlement predictors: gamma, OI, max pain."""
    section("4. ALL PREDICTORS HEAD-TO-HEAD")
    print("  Gamma (5 variants) vs OI Pin vs Max Pain at T-30min\n")

    dates = sorted(df["date"].unique())
    mp_dates = set(max_pain_df["date"].values) if len(max_pain_df) > 0 else set()
    oi_dates = set(oi_df["date"].values) if len(oi_df) > 0 else set()
    rows = []

    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])

        # T-30min gamma snapshot
        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            snapshot = find_nearest_snapshot(day_data, "19:00")
        if snapshot is None:
            continue

        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue

        row = {
            "date": date,
            "settlement": settlement,
            "pp_dist": abs(settlement - profile["pos_peak_strike"]),
            "np_dist": abs(settlement - profile["neg_peak_strike"]),
            "pg_dist": abs(settlement - profile["peak_gamma_strike"]),
            "gc_dist": abs(settlement - profile["gamma_centroid"]),
            "pc_dist": abs(settlement - profile["pos_centroid"]),
            "prox_dist": abs(settlement - profile["prox_centroid"]),
        }

        # Max pain
        if date in mp_dates:
            mp_row = max_pain_df[max_pain_df["date"] == date].iloc[0]
            row["mp_dist"] = abs(settlement - float(mp_row["max_pain_0dte"]))
        else:
            row["mp_dist"] = np.nan

        # OI pin
        if date in oi_dates:
            oi_day = oi_df[oi_df["date"] == date]
            oi_pin = compute_oi_pin(oi_day)
            if oi_pin:
                row["oi_pin_dist"] = abs(settlement - oi_pin["oi_pin_strike"])
                row["oi_centroid_dist"] = abs(settlement - oi_pin["oi_centroid"])
            else:
                row["oi_pin_dist"] = np.nan
                row["oi_centroid_dist"] = np.nan
        else:
            row["oi_pin_dist"] = np.nan
            row["oi_centroid_dist"] = np.nan

        rows.append(row)

    if not rows:
        print("  No days with strike data at T-30min.")
        return

    results = pd.DataFrame(rows)
    n = len(results)

    # Head-to-head comparison
    all_predictors = [
        ("Pos γ Peak (pin)", "pp_dist"),
        ("Neg γ Peak (repel)", "np_dist"),
        ("Abs γ Peak", "pg_dist"),
        ("All-γ Centroid", "gc_dist"),
        ("Pos-γ Centroid", "pc_dist"),
        ("Prox-wt Centroid", "prox_dist"),
        ("OI Pin Strike", "oi_pin_dist"),
        ("OI Centroid", "oi_centroid_dist"),
        ("Max Pain", "mp_dist"),
    ]
    # Filter to predictors that have data
    predictors = {
        name: (col, results[col])
        for name, col in all_predictors
        if col in results.columns and results[col].notna().sum() > 0
    }

    if not predictors:
        print("  No predictor data available.")
        return

    print(
        f"  {'Predictor':<22s} {'Avg':>7s} {'Med':>7s} "
        f"{'±10':>5s} {'±20':>5s} {'±30':>5s} {'n':>4s}"
    )
    print(f"  {'─' * 22} {'─' * 7} {'─' * 7} {'─' * 5} {'─' * 5} {'─' * 5} {'─' * 4}")

    best_name = ""
    best_avg = float("inf")

    for name, (_col, dists) in predictors.items():
        valid = dists.dropna()
        if len(valid) == 0:
            continue
        avg = valid.mean()
        med = valid.median()
        w10 = (valid <= 10).mean()
        w20 = (valid <= 20).mean()
        w30 = (valid <= 30).mean()
        if avg < best_avg:
            best_avg = avg
            best_name = name
        print(
            f"  {name:<22s} {avg:>6.1f} {med:>6.1f} "
            f"{w10:>4.0%} {w20:>4.0%} {w30:>4.0%} {len(valid):>4d}"
        )

    print(f"\n  Best: {best_name} ({best_avg:.1f} pts avg)")

    # Per-day winner count
    subsection("Which predictor won each day?")
    winner_counts = dict.fromkeys(predictors.keys(), 0)
    for _, row in results.iterrows():
        best_col = None
        best_val = float("inf")
        for name, (col, _) in predictors.items():
            val = row.get(col)
            if pd.notna(val) and val < best_val:
                best_val = val
                best_col = name
        if best_col:
            winner_counts[best_col] += 1

    for name, count in sorted(winner_counts.items(), key=lambda x: -x[1]):
        if count > 0:
            print(f"  {name:<22s}  won {count}/{n} days ({count / n:.0%})")

    takeaway(
        f"{best_name} is the best predictor by avg distance "
        f"({best_avg:.1f} pts).\n"
        "            Use it as the primary BWB sweet-spot anchor."
    )


def analyze_per_day_detail(df: pd.DataFrame, max_pain_df: pd.DataFrame) -> None:
    """Show per-day detail for the most recent 10 days."""
    section("5. RECENT DAY DETAIL")
    print("  Per-day settlement attractors for the last 10 trading days\n")

    dates = sorted(df["date"].unique())[-10:]
    mp_dates = set(max_pain_df["date"].values) if len(max_pain_df) > 0 else set()

    print(
        f"  {'Date':<12s} {'Settle':>8s} {'+γ Peak':>8s} {'Dist':>6s} "
        f"{'-γ Peak':>8s} {'Dist':>6s} {'MaxPain':>8s} {'Dist':>6s}"
    )
    print(
        f"  {'─' * 12} {'─' * 8} {'─' * 8} {'─' * 6} "
        f"{'─' * 8} {'─' * 6} {'─' * 8} {'─' * 6}"
    )

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
        print(
            f"  {date_str:<12s} {settlement:>8.1f} {pos_peak:>8.0f} "
            f"{pp_dist:>5.1f} {neg_peak:>8.0f} {np_dist:>5.1f} "
            f"{mp_str:>8s} {mp_dist_str:>6s}"
        )


def key_findings(df: pd.DataFrame, max_pain_df: pd.DataFrame) -> None:
    """Print actionable summary."""
    section("KEY FINDINGS — BWB PLACEMENT")

    dates = sorted(df["date"].unique())

    # Compute T-30min stats for all gamma predictors
    pg_dists = []
    pos_peak_dists = []
    pos_centroid_dists = []
    prox_dists = []
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
        prox_dists.append(abs(settlement - profile["prox_centroid"]))

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

    print(f"\n  PROX-WEIGHTED CENTROID (at T-30min, n={len(prox_dists)}):")
    if prox_dists:
        avg_prox = np.mean(prox_dists)
        w10_prox = sum(1 for d in prox_dists if d <= 10) / len(prox_dists)
        w20_prox = sum(1 for d in prox_dists if d <= 20) / len(prox_dists)
        print(f"    Within ±10 pts: {w10_prox:.0%}")
        print(f"    Within ±20 pts: {w20_prox:.0%}")
        print(f"    Avg distance:   {avg_prox:.1f} pts")
    else:
        print("    No data at T-30min checkpoint")

    print(f"\n  ALL-GAMMA CENTROID (at T-30min, n={len(pg_dists)}):")
    if pg_dists:
        avg_gc = np.mean(pg_dists)
        w10_gc = sum(1 for d in pg_dists if d <= 10) / len(pg_dists)
        w20_gc = sum(1 for d in pg_dists if d <= 20) / len(pg_dists)
        print(f"    Within ±10 pts: {w10_gc:.0%}")
        print(f"    Within ±20 pts: {w20_gc:.0%}")
        print(f"    Avg distance:   {avg_gc:.1f} pts")

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
    if prox_dists:
        prox_avg = np.mean(prox_dists)
        gc_avg = np.mean(pg_dists) if pg_dists else float("inf")
        mp_avg = np.mean(mp_dists) if mp_dists else float("inf")

        candidates = [
            ("Prox-weighted centroid", prox_avg),
            ("All-gamma centroid", gc_avg),
        ]
        if mp_dists:
            candidates.append(("Max pain", mp_avg))

        best_name, best_val = min(candidates, key=lambda x: x[1])
        print(f"  Best BWB anchor: {best_name} ({best_val:.1f} pts avg)")
        print("  Compute the proximity-weighted gamma centroid at 3:30 PM ET:")
        print("    weight = |gamma| / distance_from_price²")
        print("    centroid = sum(strike * weight) / sum(weight)")
    else:
        print(
            "  Insufficient data. Accumulate more trading days with "
            "dense intraday strike coverage."
        )


def analyze_dte_comparison() -> None:
    """Compare 0 DTE, 1 DTE, and combined gamma as settlement predictors."""
    section("6. 0 DTE vs 1 DTE vs COMBINED GAMMA")
    print("  Does 1 DTE gamma predict settlement better than 0 DTE?\n")

    # Load all three datasets
    datasets: dict[str, pd.DataFrame] = {}
    for mode in ("0dte", "1dte", "combined"):
        print(f"  Loading {mode} strike data ...")
        d = load_strike_data(mode)
        n = d["date"].nunique() if len(d) > 0 else 0
        print(f"    {len(d):,} rows across {n} days")
        datasets[mode] = d

    # Check 1 DTE data availability
    if len(datasets["1dte"]) == 0:
        print("\n  No 1 DTE data yet — skipping comparison.")
        print("  Once strike_exposures has rows with expiry > date,")
        print("  re-run this script to see the comparison.")
        return

    n_1dte = datasets["1dte"]["date"].nunique()
    if n_1dte < 3:
        print(f"\n  Only {n_1dte} days with 1 DTE data — need at least 3.")
        print("  Accumulate more data, then re-run.")
        return

    # Find common dates across all three datasets
    date_sets = {mode: set(d["date"].unique()) for mode, d in datasets.items()}
    common_dates = sorted(date_sets["0dte"] & date_sets["1dte"] & date_sets["combined"])

    if len(common_dates) < 3:
        print(f"\n  Only {len(common_dates)} common dates across all 3 modes")
        print("  — need at least 3. Accumulate more data, then re-run.")
        return

    print(f"\n  {len(common_dates)} common dates for comparison\n")

    # Checkpoints to try, in preference order.
    # Backfill data only has ~20:10 UTC, so we cascade through checkpoints.
    COMPARE_CHECKPOINTS = ["19:30", "19:00", "20:00", "20:15"]

    predictor_defs = [
        ("Prox-wt centroid", "prox_centroid"),
        ("All-gamma centroid", "gamma_centroid"),
        ("Pos-gamma peak", "pos_peak_strike"),
    ]

    # Collect distances: {mode: {predictor_name: [dists]}}
    mode_results: dict[str, dict[str, list[float]]] = {
        mode: {name: [] for name, _ in predictor_defs}
        for mode in ("0dte", "1dte", "combined")
    }
    # Per-day winner tracking
    day_winners: list[dict] = []

    for date in common_dates:
        # Get settlement from 0dte data (same outcome for all modes)
        day_0dte = datasets["0dte"][datasets["0dte"]["date"] == date]
        settlement = float(day_0dte["settlement"].iloc[0])

        day_best_mode = None
        day_best_dist = float("inf")

        for mode in ("0dte", "1dte", "combined"):
            day_data = datasets[mode][datasets[mode]["date"] == date]
            snapshot = None
            for cp in COMPARE_CHECKPOINTS:
                snapshot = find_nearest_snapshot(day_data, cp)
                if snapshot is not None:
                    break
            if snapshot is None:
                continue

            profile = compute_gamma_profile(snapshot)
            if not profile:
                continue

            for name, key in predictor_defs:
                dist = abs(settlement - profile[key])
                mode_results[mode][name].append(dist)

            # Track per-day winner using prox-centroid
            prox_dist = abs(settlement - profile["prox_centroid"])
            if prox_dist < day_best_dist:
                day_best_dist = prox_dist
                day_best_mode = mode

        if day_best_mode:
            day_winners.append(
                {
                    "date": date,
                    "winner": day_best_mode,
                    "dist": day_best_dist,
                }
            )

    # ── Comparison table ──
    subsection("Comparison: Avg distance to settlement (T-30min)")

    header_modes = ["0 DTE", "1 DTE", "Combined"]
    mode_keys = ["0dte", "1dte", "combined"]

    for pred_name, _ in predictor_defs:
        print(f"\n  {pred_name}:")
        print(
            f"  {'DTE Mode':<12s} {'Avg':>7s} {'Med':>7s} "
            f"{'+-10':>5s} {'+-20':>5s} {'n':>4s}"
        )
        print(
            f"  {'---' * 4:<12s} {'---':>7s} {'---':>7s} "
            f"{'---':>5s} {'---':>5s} {'---':>4s}"
        )

        best_mode_name = ""
        best_avg = float("inf")

        for mode_key, mode_label in zip(mode_keys, header_modes):
            dists = mode_results[mode_key][pred_name]
            if not dists:
                print(f"  {mode_label:<12s}   (no data)")
                continue
            vals = np.array(dists)
            avg = vals.mean()
            med = float(np.median(vals))
            w10 = (vals <= 10).mean()
            w20 = (vals <= 20).mean()
            n = len(vals)
            if avg < best_avg:
                best_avg = avg
                best_mode_name = mode_label
            print(
                f"  {mode_label:<12s} {avg:>6.1f} {med:>6.1f} "
                f"{w10:>4.0%} {w20:>4.0%} {n:>4d}"
            )

        if best_mode_name:
            print(f"  Best: {best_mode_name} ({best_avg:.1f} pts avg)")

    # ── Per-day winner breakdown ──
    subsection("Per-day winner (prox-weighted centroid)")

    winner_counts = {"0dte": 0, "1dte": 0, "combined": 0}
    for w in day_winners:
        winner_counts[w["winner"]] += 1

    total = len(day_winners)
    for mode_key, mode_label in zip(mode_keys, header_modes):
        count = winner_counts[mode_key]
        pct = count / total if total > 0 else 0
        print(f"  {mode_label:<12s}  won {count}/{total} days ({pct:.0%})")

    # ── Takeaway ──
    # Determine overall best mode by prox-centroid avg
    mode_avgs = {}
    for mode_key, mode_label in zip(mode_keys, header_modes):
        dists = mode_results[mode_key]["Prox-wt centroid"]
        if dists:
            mode_avgs[mode_label] = np.mean(dists)

    if mode_avgs:
        best_label = min(mode_avgs, key=mode_avgs.get)
        best_val = mode_avgs[best_label]
        runner_up = sorted(mode_avgs.items(), key=lambda x: x[1])
        if len(runner_up) >= 2:
            gap = runner_up[1][1] - runner_up[0][1]
            takeaway(
                f"{best_label} gamma is the best settlement predictor "
                f"by prox-centroid ({best_val:.1f} pts avg, "
                f"{gap:.1f} pts better than {runner_up[1][0]}).\n"
                "            If 1 DTE wins, consider using tomorrow's "
                "gamma profile for BWB placement."
            )
        else:
            takeaway(
                f"{best_label} gamma is the best settlement predictor "
                f"({best_val:.1f} pts avg)."
            )


def analyze_dte_regime() -> None:
    """What distinguishes days when 1 DTE gamma wins from 0 DTE wins?"""
    section("7. REGIME ANALYSIS: WHEN DOES 1 DTE WIN?")
    print("  Identifying features that predict which gamma profile to trust\n")

    # Load both datasets
    df_0dte = load_strike_data("0dte")
    df_1dte = load_strike_data("1dte")

    if len(df_1dte) == 0 or df_1dte["date"].nunique() < 3:
        print("  Insufficient 1 DTE data — skipping regime analysis.")
        return

    # Snapshot cascade (backfill has 20:10 UTC, cron has 19:30)
    SNAP_CASCADE = ["19:30", "19:00", "20:00", "20:15"]

    # Load training_features for VIX and regime context
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    engine = create_engine(database_url)
    try:
        tf = pd.read_sql_query(
            text("""
            SELECT date, vix, vix1d, agg_net_gamma, gamma_asymmetry,
                   dte0_net_charm, regime_zone, is_friday, is_opex,
                   gex_oi_t1, gex_oi_t2
            FROM training_features
            WHERE vix IS NOT NULL
            ORDER BY date
        """),
            engine,
        )
    finally:
        engine.dispose()
    tf["date"] = pd.to_datetime(tf["date"])
    tf_dates = set(tf["date"].values)

    # Find common dates
    dates_0 = set(df_0dte["date"].unique())
    dates_1 = set(df_1dte["date"].unique())
    common_dates = sorted(dates_0 & dates_1)

    if len(common_dates) < 5:
        print(f"  Only {len(common_dates)} common dates — need at least 5.")
        return

    # Label each day and compute features
    rows = []
    for date in common_dates:
        day_0 = df_0dte[df_0dte["date"] == date]
        day_1 = df_1dte[df_1dte["date"] == date]
        settlement = float(day_0["settlement"].iloc[0])

        # Find best available snapshot for each
        snap_0, snap_1 = None, None
        for cp in SNAP_CASCADE:
            if snap_0 is None:
                snap_0 = find_nearest_snapshot(day_0, cp)
            if snap_1 is None:
                snap_1 = find_nearest_snapshot(day_1, cp)
        if snap_0 is None or snap_1 is None:
            continue

        prof_0 = compute_gamma_profile(snap_0)
        prof_1 = compute_gamma_profile(snap_1)
        if not prof_0 or not prof_1:
            continue

        # Settlement distances
        dist_0 = abs(settlement - prof_0["prox_centroid"])
        dist_1 = abs(settlement - prof_1["prox_centroid"])
        winner = "1dte" if dist_1 < dist_0 else "0dte"

        # ── Feature extraction ──

        # 1. Gamma concentration: what fraction of total |gamma| is in top 3
        def gamma_concentration(snap: pd.DataFrame) -> float:
            s = snap.copy()
            s["call_gamma_oi"] = pd.to_numeric(s["call_gamma_oi"], errors="coerce")
            s["put_gamma_oi"] = pd.to_numeric(s["put_gamma_oi"], errors="coerce")
            s["abs_g"] = (
                s["call_gamma_oi"].fillna(0) + s["put_gamma_oi"].fillna(0)
            ).abs()
            total = s["abs_g"].sum()
            if total == 0:
                return 0.0
            top3 = s.nlargest(3, "abs_g")["abs_g"].sum()
            return float(top3 / total)

        # 2. Gamma spread: std dev of net gamma across strikes
        def gamma_spread(snap: pd.DataFrame) -> float:
            s = snap.copy()
            s["call_gamma_oi"] = pd.to_numeric(s["call_gamma_oi"], errors="coerce")
            s["put_gamma_oi"] = pd.to_numeric(s["put_gamma_oi"], errors="coerce")
            s["net_g"] = s["call_gamma_oi"].fillna(0) + s["put_gamma_oi"].fillna(0)
            return float(s["net_g"].std()) if len(s) > 1 else 0.0

        conc_0 = gamma_concentration(snap_0)
        conc_1 = gamma_concentration(snap_1)
        spread_0 = gamma_spread(snap_0)
        spread_1 = gamma_spread(snap_1)

        # 3. Peak magnitude ratio (1 DTE / 0 DTE)
        mag_0 = prof_0["peak_gamma_mag"]
        mag_1 = prof_1["peak_gamma_mag"]
        mag_ratio = mag_1 / mag_0 if mag_0 > 0 else 0.0

        # 4. Peak agreement: distance between 0 DTE and 1 DTE prox centroids
        peak_disagreement = abs(prof_0["prox_centroid"] - prof_1["prox_centroid"])

        # 5. Net gamma sign for 0 DTE (positive = pinning, negative = accel)
        net_g_0 = float(
            snap_0["call_gamma_oi"].astype(float).sum()
            + snap_0["put_gamma_oi"].astype(float).sum()
        )
        net_g_sign_0 = "positive" if net_g_0 > 0 else "negative"

        row = {
            "date": date,
            "winner": winner,
            "dist_0dte": dist_0,
            "dist_1dte": dist_1,
            "margin": abs(dist_0 - dist_1),
            "conc_0dte": conc_0,
            "conc_1dte": conc_1,
            "spread_0dte": spread_0,
            "spread_1dte": spread_1,
            "mag_ratio": mag_ratio,
            "peak_disagree": peak_disagreement,
            "net_gamma_sign": net_g_sign_0,
        }

        # Add training_features if available
        if date in tf_dates:
            tf_row = tf[tf["date"] == date].iloc[0]
            row["vix"] = float(tf_row["vix"]) if pd.notna(tf_row["vix"]) else np.nan
            row["agg_net_gamma"] = (
                float(tf_row["agg_net_gamma"])
                if pd.notna(tf_row["agg_net_gamma"])
                else np.nan
            )
            row["gamma_asymmetry"] = (
                float(tf_row["gamma_asymmetry"])
                if pd.notna(tf_row["gamma_asymmetry"])
                else np.nan
            )
            row["regime_zone"] = (
                str(tf_row["regime_zone"])
                if pd.notna(tf_row["regime_zone"])
                else "unknown"
            )
            row["is_friday"] = (
                bool(tf_row["is_friday"]) if pd.notna(tf_row["is_friday"]) else False
            )
            row["is_opex"] = (
                bool(tf_row["is_opex"]) if pd.notna(tf_row["is_opex"]) else False
            )
        else:
            row["vix"] = np.nan
            row["agg_net_gamma"] = np.nan
            row["gamma_asymmetry"] = np.nan
            row["regime_zone"] = "unknown"
            row["is_friday"] = False
            row["is_opex"] = False

        rows.append(row)

    if len(rows) < 5:
        print(f"  Only {len(rows)} days with both snapshots — need 5+.")
        return

    results = pd.DataFrame(rows)
    wins_0 = results[results["winner"] == "0dte"]
    wins_1 = results[results["winner"] == "1dte"]
    n = len(results)

    print(
        f"  {len(wins_0)} days 0 DTE won, {len(wins_1)} days 1 DTE won (out of {n})\n"
    )

    if len(wins_1) == 0:
        print("  1 DTE never won — no regime to analyze yet.")
        return

    # ── Feature comparison ──
    subsection("Feature comparison: 0 DTE wins vs 1 DTE wins")

    numeric_features = [
        ("0 DTE γ concentration", "conc_0dte", "Top-3 strike share of total |gamma|"),
        ("1 DTE γ concentration", "conc_1dte", "Top-3 strike share of total |gamma|"),
        ("0 DTE γ spread (std)", "spread_0dte", "Dispersion of gamma across strikes"),
        ("1 DTE / 0 DTE peak ratio", "mag_ratio", "Relative strength of 1 DTE peak"),
        (
            "Peak disagreement (pts)",
            "peak_disagree",
            "Distance between 0 DTE and 1 DTE centroids",
        ),
        ("VIX", "vix", "Implied volatility level"),
        ("Agg net gamma", "agg_net_gamma", "Market-wide net gamma (Rule 16)"),
        ("Gamma asymmetry", "gamma_asymmetry", "Above-vs-below ATM gamma skew"),
    ]

    print(f"  {'Feature':<28s} {'0DTE wins':>11s} {'1DTE wins':>11s} {'Signal?':>8s}")
    print(f"  {'─' * 28} {'─' * 11} {'─' * 11} {'─' * 8}")

    signals = []
    for label, col, desc in numeric_features:
        if col not in results.columns:
            continue
        v0 = wins_0[col].dropna()
        v1 = wins_1[col].dropna()
        if len(v0) < 2 or len(v1) < 2:
            print(f"  {label:<28s}  insufficient data")
            continue

        m0 = v0.median()
        m1 = v1.median()

        # Effect size: difference of medians / pooled std
        pooled = pd.concat([v0, v1])
        pooled_std = pooled.std()
        if pooled_std > 0:
            effect = abs(m1 - m0) / pooled_std
        else:
            effect = 0.0

        sig = ""
        if effect > 0.8:
            sig = "STRONG"
        elif effect > 0.5:
            sig = "moderate"
        elif effect > 0.3:
            sig = "weak"

        fmt_0 = f"{m0:.4g}" if abs(m0) < 1e6 else f"{m0:.2e}"
        fmt_1 = f"{m1:.4g}" if abs(m1) < 1e6 else f"{m1:.2e}"
        print(f"  {label:<28s} {fmt_0:>11s} {fmt_1:>11s} {sig:>8s}")

        if sig:
            direction = "higher" if m1 > m0 else "lower"
            signals.append((label, direction, sig, desc))

    # ── Categorical features ──
    subsection("Categorical splits")

    # Net gamma sign
    for sign in ("positive", "negative"):
        subset = results[results["net_gamma_sign"] == sign]
        if len(subset) == 0:
            continue
        w1 = (subset["winner"] == "1dte").sum()
        pct = w1 / len(subset) if len(subset) > 0 else 0
        print(f"  Net gamma {sign}: 1 DTE won {w1}/{len(subset)} ({pct:.0%})")

    # Regime zone
    print()
    for zone in sorted(results["regime_zone"].unique()):
        subset = results[results["regime_zone"] == zone]
        if len(subset) < 2:
            continue
        w1 = (subset["winner"] == "1dte").sum()
        pct = w1 / len(subset) if len(subset) > 0 else 0
        print(f"  Regime '{zone}': 1 DTE won {w1}/{len(subset)} ({pct:.0%})")

    # Friday / OPEX
    for label, col in [("Friday", "is_friday"), ("OPEX", "is_opex")]:
        yes = results[results[col] == True]  # noqa: E712
        no = results[results[col] == False]  # noqa: E712
        if len(yes) > 0:
            w1_yes = (yes["winner"] == "1dte").sum()
            pct_yes = w1_yes / len(yes)
            print(f"  {label}: 1 DTE won {w1_yes}/{len(yes)} ({pct_yes:.0%})")
        if len(no) > 0:
            w1_no = (no["winner"] == "1dte").sum()
            pct_no = w1_no / len(no)
            print(f"  Non-{label}: 1 DTE won {w1_no}/{len(no)} ({pct_no:.0%})")

    # ── Per-day detail ──
    subsection("Per-day detail")
    print(
        f"  {'Date':<12s} {'Winner':>7s} {'0DTE':>6s} {'1DTE':>6s} "
        f"{'Margin':>7s} {'Conc0':>6s} {'Conc1':>6s} "
        f"{'MagR':>6s} {'Disagr':>7s} {'VIX':>5s}"
    )
    print(
        f"  {'─' * 12} {'─' * 7} {'─' * 6} {'─' * 6} "
        f"{'─' * 7} {'─' * 6} {'─' * 6} "
        f"{'─' * 6} {'─' * 7} {'─' * 5}"
    )

    for _, r in results.iterrows():
        date_str = pd.Timestamp(r["date"]).strftime("%Y-%m-%d")
        vix_str = f"{r['vix']:.1f}" if pd.notna(r.get("vix")) else "—"
        print(
            f"  {date_str:<12s} {r['winner']:>7s} "
            f"{r['dist_0dte']:>5.1f} {r['dist_1dte']:>5.1f} "
            f"{r['margin']:>6.1f} {r['conc_0dte']:>5.1%} "
            f"{r['conc_1dte']:>5.1%} "
            f"{r['mag_ratio']:>5.2f} {r['peak_disagree']:>6.1f} "
            f"{vix_str:>5s}"
        )

    # ── Summary & decision rule ──
    subsection("Potential decision rules")

    if signals:
        print("  Detected signals:")
        for label, direction, strength, desc in signals:
            print(f"    {strength.upper()}: {label} is {direction} when 1 DTE wins")
            print(f"           ({desc})")
        print()

    # Test simple threshold rules
    best_rule = None
    best_accuracy = 0.5  # baseline = always pick 0 DTE

    # Rule 1: Low 0 DTE concentration → 1 DTE
    if "conc_0dte" in results.columns:
        for threshold in [0.10, 0.15, 0.20, 0.25, 0.30]:
            pred = results["conc_0dte"].apply(
                lambda x, t=threshold: "1dte" if x < t else "0dte"
            )
            acc = (pred == results["winner"]).mean()
            if acc > best_accuracy:
                best_accuracy = acc
                best_rule = (
                    f"If 0 DTE concentration < {threshold:.0%}, use 1 DTE",
                    acc,
                )

    # Rule 2: High magnitude ratio → 1 DTE
    if "mag_ratio" in results.columns:
        for threshold in [0.5, 1.0, 2.0, 5.0, 10.0]:
            pred = results["mag_ratio"].apply(
                lambda x, t=threshold: "1dte" if x > t else "0dte"
            )
            acc = (pred == results["winner"]).mean()
            if acc > best_accuracy:
                best_accuracy = acc
                best_rule = (
                    f"If 1DTE/0DTE peak ratio > {threshold:.1f}, use 1 DTE",
                    acc,
                )

    # Rule 3: High peak disagreement → 1 DTE
    if "peak_disagree" in results.columns:
        for threshold in [10, 20, 30, 50, 75]:
            pred = results["peak_disagree"].apply(
                lambda x, t=threshold: "1dte" if x > t else "0dte"
            )
            acc = (pred == results["winner"]).mean()
            if acc > best_accuracy:
                best_accuracy = acc
                best_rule = (
                    f"If peak disagreement > {threshold} pts, use 1 DTE",
                    acc,
                )

    # Rule 4: Negative net gamma → 1 DTE
    if "net_gamma_sign" in results.columns:
        pred = results["net_gamma_sign"].apply(
            lambda x: "1dte" if x == "negative" else "0dte"
        )
        acc = (pred == results["winner"]).mean()
        if acc > best_accuracy:
            best_accuracy = acc
            best_rule = (
                "If net gamma is negative, use 1 DTE",
                acc,
            )

    baseline_acc = (results["winner"] == "0dte").mean()
    print(f"  Baseline (always use 0 DTE): {baseline_acc:.0%} accuracy")

    if best_rule:
        rule_text, rule_acc = best_rule
        lift = rule_acc - baseline_acc
        print(f"  Best rule: {rule_text}")
        print(f"  Accuracy:  {rule_acc:.0%} (+{lift:.0%} over baseline)")

        if lift > 0.10:
            takeaway(
                f"'{rule_text}' improves accuracy by {lift:.0%}.\n"
                "            When this condition is met, anchor BWB "
                "to the 1 DTE prox-centroid instead."
            )
        elif lift > 0.0:
            takeaway(
                f"Best rule adds {lift:.0%} — marginal improvement.\n"
                "            Accumulate more data before relying on "
                "this rule for live trading."
            )
        else:
            takeaway(
                "No simple rule beats always using 0 DTE.\n"
                "            Stick with 0 DTE prox-centroid as the "
                "primary BWB anchor."
            )
    else:
        takeaway(
            "No decision rule found that beats baseline.\n"
            "            Stick with 0 DTE prox-centroid for now."
        )

    # ── Cross-validated sklearn decision tree ──
    _sklearn_regime_model(results, baseline_acc)


def _sklearn_regime_model(
    results: pd.DataFrame,
    baseline_acc: float,
) -> None:
    """
    Train a DecisionTreeClassifier (depth=1) with TimeSeriesSplit
    cross-validation to predict which DTE gamma profile wins.

    This provides out-of-sample accuracy estimates, unlike the manual
    threshold rules above which evaluate on the same data they're fit on.
    """
    subsection("Cross-validated decision tree (out-of-sample)")

    feature_cols = [
        c
        for c in [
            "conc_0dte",
            "conc_1dte",
            "spread_0dte",
            "spread_1dte",
            "mag_ratio",
            "peak_disagree",
            "vix",
            "agg_net_gamma",
            "gamma_asymmetry",
        ]
        if c in results.columns
    ]

    if len(feature_cols) < 2:
        print("  Insufficient features for sklearn model — skipping.")
        return

    X = results[feature_cols].copy()
    le = LabelEncoder()
    y = le.fit_transform(results["winner"])  # 0dte=0, 1dte=1

    n_samples = len(X)
    if n_samples < 10:
        print(f"  Only {n_samples} samples — need 10+ for cross-validation.")
        return

    n_splits = min(3, n_samples // 3)
    if n_splits < 2:
        print("  Too few samples for TimeSeriesSplit — skipping.")
        return

    pipe = make_pipeline(
        SimpleImputer(strategy="median"),
        StandardScaler(),
        DecisionTreeClassifier(
            max_depth=1,
            random_state=42,
            class_weight="balanced",
        ),
    )

    tscv = TimeSeriesSplit(n_splits=n_splits)
    scores = cross_val_score(pipe, X, y, cv=tscv, scoring="accuracy")

    cv_mean = scores.mean()
    cv_std = scores.std()
    print(f"  Features: {', '.join(feature_cols)}")
    print(f"  TimeSeriesSplit folds: {n_splits}")
    print(f"  CV accuracy: {cv_mean:.0%} ± {cv_std:.0%}")
    print(f"  Baseline:    {baseline_acc:.0%} (always 0 DTE)")

    lift = cv_mean - baseline_acc
    if lift > 0.05:
        # Fit on all data to inspect the learned rule
        pipe.fit(X, y)
        tree = pipe[-1]
        if tree.tree_.feature[0] >= 0:
            feat_idx = tree.tree_.feature[0]
            feat_name = feature_cols[feat_idx]
            # Inverse-transform the split threshold back to original scale
            row = np.zeros((1, len(feature_cols)))
            row[0, feat_idx] = tree.tree_.threshold[0]
            threshold = pipe[1].inverse_transform(row)[0][feat_idx]
            print(f"  Learned split: {feat_name} ≤ {threshold:.4g}")

        takeaway(
            f"Cross-validated tree adds {lift:+.0%} over baseline.\n"
            "            This is out-of-sample — more reliable than\n"
            "            the in-sample threshold rules above."
        )
    elif lift > 0.0:
        takeaway(
            f"CV tree adds only {lift:+.0%} — marginal.\n"
            "            More data needed before trusting this model."
        )
    else:
        takeaway(
            "CV tree does not beat baseline out-of-sample.\n"
            "            Stick with 0 DTE prox-centroid."
        )


def gamma_concentration(snapshot: pd.DataFrame) -> float:
    """Fraction of total |gamma| in the top 3 strikes."""
    s = snapshot.copy()
    s["call_gamma_oi"] = pd.to_numeric(s["call_gamma_oi"], errors="coerce")
    s["put_gamma_oi"] = pd.to_numeric(s["put_gamma_oi"], errors="coerce")
    s["abs_g"] = (s["call_gamma_oi"].fillna(0) + s["put_gamma_oi"].fillna(0)).abs()
    total = s["abs_g"].sum()
    if total == 0:
        return 0.0
    top3 = s.nlargest(3, "abs_g")["abs_g"].sum()
    return float(top3 / total)


def backtest_composite_strategy() -> None:
    """
    Backtest the concentration-gated composite strategy.

    Strategy:
      1. Compute 0 DTE gamma concentration (top-3 share)
      2. HIGH concentration (≥ threshold): trust 0 DTE prox-centroid
      3. LOW concentration (< threshold): switch to 1 DTE prox-centroid
      4. Confidence tiers based on alignment of 0 DTE and 1 DTE centroids

    Compares against baselines:
      A) Always use 0 DTE prox-centroid
      B) Always use 1 DTE prox-centroid
    """
    section("8. COMPOSITE STRATEGY BACKTEST")
    print("  Concentration-gated 0 DTE / 1 DTE switching strategy\n")

    df_0dte = load_strike_data("0dte")
    df_1dte = load_strike_data("1dte")

    if len(df_1dte) == 0 or df_1dte["date"].nunique() < 3:
        print("  Insufficient 1 DTE data — skipping backtest.")
        return

    SNAP_CASCADE = ["19:30", "19:00", "20:00", "20:15"]

    dates_0 = set(df_0dte["date"].unique())
    dates_1 = set(df_1dte["date"].unique())
    common_dates = sorted(dates_0 & dates_1)

    if len(common_dates) < 5:
        print(f"  Only {len(common_dates)} common dates — need 5+.")
        return

    # ── Collect per-day profiles ──
    day_profiles: list[dict] = []

    for date in common_dates:
        day_0 = df_0dte[df_0dte["date"] == date]
        day_1 = df_1dte[df_1dte["date"] == date]
        settlement = float(day_0["settlement"].iloc[0])

        snap_0, snap_1 = None, None
        for cp in SNAP_CASCADE:
            if snap_0 is None:
                snap_0 = find_nearest_snapshot(day_0, cp)
            if snap_1 is None:
                snap_1 = find_nearest_snapshot(day_1, cp)
        if snap_0 is None or snap_1 is None:
            continue

        prof_0 = compute_gamma_profile(snap_0)
        prof_1 = compute_gamma_profile(snap_1)
        if not prof_0 or not prof_1:
            continue

        conc = gamma_concentration(snap_0)
        centroid_0 = prof_0["prox_centroid"]
        centroid_1 = prof_1["prox_centroid"]
        disagreement = abs(centroid_0 - centroid_1)

        dist_0 = abs(settlement - centroid_0)
        dist_1 = abs(settlement - centroid_1)

        # Find 1 DTE gamma wall (pos peak) nearest the 0 DTE centroid
        wall_1dte_near_0dte = prof_1["pos_peak_strike"]
        # If the 1 DTE prox centroid is closer to the 0 DTE centroid
        # than the 1 DTE pos peak, use the centroid instead
        if abs(centroid_1 - centroid_0) < abs(prof_1["pos_peak_strike"] - centroid_0):
            wall_1dte_near_0dte = centroid_1
        dist_1_anchored = abs(settlement - wall_1dte_near_0dte)

        day_profiles.append(
            {
                "date": date,
                "settlement": settlement,
                "conc_0dte": conc,
                "centroid_0dte": centroid_0,
                "centroid_1dte": centroid_1,
                "disagreement": disagreement,
                "dist_0dte": dist_0,
                "dist_1dte": dist_1,
                "dist_1dte_anchored": dist_1_anchored,
                "actual_winner": "1dte" if dist_1 < dist_0 else "0dte",
            }
        )

    if len(day_profiles) < 5:
        print(f"  Only {len(day_profiles)} usable days — need 5+.")
        return

    results = pd.DataFrame(day_profiles)
    n = len(results)

    # ── Baselines ──
    subsection("Baselines")

    baseline_0 = results["dist_0dte"].mean()
    baseline_1 = results["dist_1dte"].mean()
    baseline_0_w10 = (results["dist_0dte"] <= 10).mean()
    baseline_1_w10 = (results["dist_1dte"] <= 10).mean()

    print(
        f"  Always 0 DTE prox-centroid:  "
        f"avg {baseline_0:.1f} pts, {baseline_0_w10:.0%} within ±10"
    )
    print(
        f"  Always 1 DTE prox-centroid:  "
        f"avg {baseline_1:.1f} pts, {baseline_1_w10:.0%} within ±10"
    )

    # ── Sweep concentration thresholds ──
    subsection("Concentration threshold sweep")
    print("  Strategy: if 0 DTE conc < threshold, use 1 DTE; else 0 DTE\n")

    print(
        f"  {'Threshold':>10s} {'Avg Dist':>9s} {'±10':>5s} {'±20':>5s} "
        f"{'Switch%':>8s} {'vs Base':>8s}"
    )
    print(f"  {'─' * 10} {'─' * 9} {'─' * 5} {'─' * 5} {'─' * 8} {'─' * 8}")

    best_thresh = 0.0
    best_avg = baseline_0  # must beat always-0-DTE

    for thresh in [0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85]:
        dists = []
        switches = 0
        for _, r in results.iterrows():
            if r["conc_0dte"] < thresh:
                dists.append(r["dist_1dte"])
                switches += 1
            else:
                dists.append(r["dist_0dte"])

        arr = np.array(dists)
        avg = arr.mean()
        w10 = (arr <= 10).mean()
        w20 = (arr <= 20).mean()
        switch_pct = switches / n
        delta = baseline_0 - avg

        marker = " ◀" if avg < best_avg else ""
        if avg < best_avg:
            best_avg = avg
            best_thresh = thresh

        print(
            f"  {thresh:>9.0%} {avg:>8.1f} {w10:>4.0%} {w20:>4.0%} "
            f"{switch_pct:>7.0%} {delta:>+7.1f}{marker}"
        )

    print(f"\n  Best threshold: {best_thresh:.0%} (avg {best_avg:.1f} pts)")

    # ── Run best strategy with confidence tiers ──
    subsection(f"Strategy detail (threshold = {best_thresh:.0%})")

    CONFIDENCE_TIERS = [
        ("HIGH — aligned", 10),
        ("MEDIUM — mild disagreement", 20),
        ("LOW — strong disagreement", float("inf")),
    ]

    print(
        f"  {'Date':<12s} {'Settle':>7s} {'Conc':>6s} {'Regime':>8s} "
        f"{'Anchor':>8s} {'Dist':>6s} {'0DTE':>6s} {'1DTE':>6s} "
        f"{'Conf':>6s} {'Better?':>8s}"
    )
    print(
        f"  {'─' * 12} {'─' * 7} {'─' * 6} {'─' * 8} "
        f"{'─' * 8} {'─' * 6} {'─' * 6} {'─' * 6} "
        f"{'─' * 6} {'─' * 8}"
    )

    strat_dists = []
    confidence_results = {"HIGH": [], "MEDIUM": [], "LOW": []}

    for _, r in results.iterrows():
        date_str = pd.Timestamp(r["date"]).strftime("%Y-%m-%d")
        conc = r["conc_0dte"]

        if conc < best_thresh:
            regime = "1DTE"
            anchor = r["centroid_1dte"]
        else:
            regime = "0DTE"
            anchor = r["centroid_0dte"]

        dist = abs(r["settlement"] - anchor)
        strat_dists.append(dist)

        # Confidence tier
        disagree = r["disagreement"]
        conf = "LOW"
        for tier_name, tier_max in CONFIDENCE_TIERS:
            if disagree <= tier_max:
                conf = tier_name.split(" —")[0]
                break

        confidence_results[conf].append(dist)

        # Did the strategy beat always-0DTE?
        better = dist < r["dist_0dte"]
        same = abs(dist - r["dist_0dte"]) < 0.01
        marker = "✓" if better else ("=" if same else "✗")

        print(
            f"  {date_str:<12s} {r['settlement']:>7.1f} "
            f"{conc:>5.0%} {regime:>8s} "
            f"{anchor:>7.0f} {dist:>5.1f} "
            f"{r['dist_0dte']:>5.1f} {r['dist_1dte']:>5.1f} "
            f"{conf:>6s} {marker:>8s}"
        )

    # ── Summary ──
    subsection("Strategy summary")

    strat_arr = np.array(strat_dists)
    strat_avg = strat_arr.mean()
    strat_w10 = (strat_arr <= 10).mean()
    strat_w20 = (strat_arr <= 20).mean()
    improvement = baseline_0 - strat_avg
    beat_count = sum(1 for s, b in zip(strat_dists, results["dist_0dte"]) if s < b)

    print(f"  {'Strategy':<28s} {'Avg':>7s} {'±10':>5s} {'±20':>5s}")
    print(f"  {'─' * 28} {'─' * 7} {'─' * 5} {'─' * 5}")
    print(
        f"  {'Always 0 DTE':<28s} {baseline_0:>6.1f} "
        f"{baseline_0_w10:>4.0%} "
        f"{(results['dist_0dte'] <= 20).mean():>4.0%}"
    )
    print(
        f"  {'Always 1 DTE':<28s} {baseline_1:>6.1f} "
        f"{baseline_1_w10:>4.0%} "
        f"{(results['dist_1dte'] <= 20).mean():>4.0%}"
    )
    print(
        f"  {'Composite (conc-gated)':<28s} {strat_avg:>6.1f} "
        f"{strat_w10:>4.0%} {strat_w20:>4.0%}"
    )

    print(f"\n  Improvement over baseline: {improvement:+.1f} pts avg")
    print(f"  Beat baseline on {beat_count}/{n} days ({beat_count / n:.0%})")

    # Confidence tier breakdown
    print("\n  Confidence tier accuracy:")
    for tier in ("HIGH", "MEDIUM", "LOW"):
        tier_dists = confidence_results[tier]
        if tier_dists:
            tier_avg = np.mean(tier_dists)
            tier_w10 = sum(1 for d in tier_dists if d <= 10) / len(tier_dists)
            print(
                f"    {tier:<8s}  n={len(tier_dists):<3d}  "
                f"avg {tier_avg:.1f} pts, {tier_w10:.0%} within ±10"
            )
        else:
            print(f"    {tier:<8s}  n=0")

    # ── Final recommendation ──
    if improvement > 0.5:
        takeaway(
            f"Composite strategy beats always-0-DTE by "
            f"{improvement:.1f} pts.\n"
            f"            Rule: if 0 DTE concentration < {best_thresh:.0%}, "
            f"switch to 1 DTE prox-centroid.\n"
            "            When 0 DTE and 1 DTE centroids align within 10 pts,"
            " highest confidence."
        )
    elif improvement > 0:
        takeaway(
            f"Composite strategy is marginally better "
            f"({improvement:+.1f} pts).\n"
            "            The signal exists but needs more data to confirm.\n"
            f"            Tentative rule: switch to 1 DTE when "
            f"0 DTE conc < {best_thresh:.0%}."
        )
    else:
        takeaway(
            "Composite strategy does not beat always-0-DTE.\n"
            "            Stick with 0 DTE prox-centroid as primary anchor."
        )


# ── Plotting ──────────────────────────────────────────────────


def generate_plots(df: pd.DataFrame) -> None:
    """Generate visualization plots from the 0DTE strike data."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn as sns

    # ── Style (matches visualize.py) ──
    sns.set_theme(style="darkgrid", palette="muted")
    plt.rcParams.update(
        {
            "figure.facecolor": "#1a1a2e",
            "axes.facecolor": "#16213e",
            "axes.edgecolor": "#555",
            "axes.labelcolor": "#ccc",
            "text.color": "#ccc",
            "xtick.color": "#aaa",
            "ytick.color": "#aaa",
            "grid.color": "#333",
            "grid.alpha": 0.5,
            "font.size": 11,
        }
    )

    COLORS = {
        "green": "#2ecc71",
        "red": "#e74c3c",
        "blue": "#3498db",
        "orange": "#f39c12",
        "purple": "#9b59b6",
        "cyan": "#1abc9c",
        "pink": "#e91e63",
        "gray": "#95a5a6",
    }

    PLOT_DIR.mkdir(exist_ok=True)
    dates = sorted(df["date"].unique())

    # ── Plot 1: Prox-Centroid vs Settlement Scatter ──────────

    # Recompute per-day prox-centroid predictions at T-30min
    scatter_rows = []
    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])

        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            snapshot = find_nearest_snapshot(day_data, "19:00")
        if snapshot is None:
            continue

        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue

        prox_pred = profile["prox_centroid"]
        scatter_rows.append(
            {
                "prediction_error": prox_pred - settlement,
                "settlement_dist": settlement - prox_pred,
            }
        )

    if len(scatter_rows) >= 3:
        pd.DataFrame(scatter_rows)

        # Compute confidence tiers: need both 0DTE and 1DTE data.
        # Load 1DTE for confidence tiers.
        try:
            df_1dte = load_strike_data("1dte")
            dates_1 = set(df_1dte["date"].unique())
        except Exception:
            df_1dte = pd.DataFrame()
            dates_1 = set()

        SNAP_CASCADE = ["19:30", "19:00", "20:00", "20:15"]
        conf_rows = []
        for date in dates:
            day_data = df[df["date"] == date]
            settlement = float(day_data["settlement"].iloc[0])

            snap_0 = find_nearest_snapshot(day_data, "19:30")
            if snap_0 is None:
                snap_0 = find_nearest_snapshot(day_data, "19:00")
            if snap_0 is None:
                continue

            prof_0 = compute_gamma_profile(snap_0)
            if not prof_0:
                continue

            prox_pred = prof_0["prox_centroid"]
            error = prox_pred - settlement

            # Determine confidence tier from centroid disagreement
            conf = "MEDIUM"  # default when no 1DTE data
            if date in dates_1 and len(df_1dte) > 0:
                day_1 = df_1dte[df_1dte["date"] == date]
                snap_1 = None
                for cp in SNAP_CASCADE:
                    snap_1 = find_nearest_snapshot(day_1, cp)
                    if snap_1 is not None:
                        break
                if snap_1 is not None:
                    prof_1 = compute_gamma_profile(snap_1)
                    if prof_1:
                        disagree = abs(
                            prof_0["prox_centroid"] - prof_1["prox_centroid"]
                        )
                        if disagree <= 10:
                            conf = "HIGH"
                        elif disagree <= 20:
                            conf = "MEDIUM"
                        else:
                            conf = "LOW"

            conf_rows.append(
                {
                    "error": error,
                    "confidence": conf,
                }
            )

        conf_df = pd.DataFrame(conf_rows)

        conf_colors = {
            "HIGH": COLORS["green"],
            "MEDIUM": COLORS["orange"],
            "LOW": COLORS["red"],
        }

        fig, ax = plt.subplots(figsize=(10, 7))

        for tier in ("HIGH", "MEDIUM", "LOW"):
            subset = conf_df[conf_df["confidence"] == tier]
            if len(subset) == 0:
                continue
            ax.scatter(
                subset["error"],
                subset["error"].abs(),
                c=conf_colors[tier],
                label=f"{tier} ({len(subset)})",
                alpha=0.7,
                s=50,
                edgecolors="white",
                linewidths=0.3,
            )

        # Reference bands
        ax.axhspan(0, 10, color=COLORS["green"], alpha=0.08, label="Within +/-10 pts")
        ax.axhspan(10, 20, color=COLORS["orange"], alpha=0.06, label="Within +/-20 pts")

        ax.axvline(0, color="#666", linewidth=0.8, linestyle="--")

        ax.set_xlabel("Prox-Centroid Prediction Error (pts from settlement)")
        ax.set_ylabel("|Prediction Error| (abs distance)")
        ax.set_title(
            "Pin Analysis: Prox-Centroid vs Settlement",
            fontsize=14,
            fontweight="bold",
        )
        ax.legend(loc="upper right", framealpha=0.8)

        fig.savefig(
            PLOT_DIR / "pin_settlement.png",
            dpi=150,
            bbox_inches="tight",
        )
        plt.close(fig)
        print("  Saved: ml/plots/pin_settlement.png")
    else:
        print("  Skipped pin_settlement.png (insufficient data)")

    # ── Plot 2: Time-Decay Curve ─────────────────────────────

    cp_labels = []
    cp_avg_dists = []

    for cp_name, cp_time in CHECKPOINTS.items():
        dists = []
        for date in dates:
            day_data = df[df["date"] == date]
            settlement = float(day_data["settlement"].iloc[0])
            snapshot = find_nearest_snapshot(day_data, cp_time)
            if snapshot is None:
                continue
            profile = compute_gamma_profile(snapshot)
            if not profile:
                continue
            # Use best predictor (prox-centroid) for time decay
            dists.append(abs(settlement - profile["prox_centroid"]))

        if dists:
            # Short label from checkpoint name
            short = cp_name.split("(")[0].strip()
            cp_labels.append(short)
            cp_avg_dists.append(np.mean(dists))

    if len(cp_labels) >= 2:
        fig, ax = plt.subplots(figsize=(9, 6))

        ax.plot(
            cp_labels,
            cp_avg_dists,
            color=COLORS["cyan"],
            marker="o",
            markersize=8,
            linewidth=2.5,
            markeredgecolor="white",
            markeredgewidth=1,
        )

        # Fill area under curve
        ax.fill_between(
            cp_labels,
            cp_avg_dists,
            alpha=0.15,
            color=COLORS["cyan"],
        )

        # Annotate each point
        for _i, (label, val) in enumerate(zip(cp_labels, cp_avg_dists)):
            ax.annotate(
                f"{val:.1f}",
                (label, val),
                textcoords="offset points",
                xytext=(0, 12),
                ha="center",
                fontsize=10,
                color=COLORS["cyan"],
                fontweight="bold",
            )

        ax.set_xlabel("Time Checkpoint")
        ax.set_ylabel("Avg Distance to Settlement (pts)")
        ax.set_title(
            "Settlement Prediction Improves Near Close",
            fontsize=14,
            fontweight="bold",
        )

        # Rotate x labels if needed
        plt.xticks(rotation=15, ha="right")

        fig.savefig(
            PLOT_DIR / "pin_time_decay.png",
            dpi=150,
            bbox_inches="tight",
        )
        plt.close(fig)
        print("  Saved: ml/plots/pin_time_decay.png")
    else:
        print("  Skipped pin_time_decay.png (insufficient data)")

    # ── Plot 3: Composite Strategy Comparison ────────────────

    # Need both 0DTE and 1DTE data for composite comparison.
    # Recompute baselines and composite strategy distances.
    try:
        df_1dte_comp = load_strike_data("1dte")
    except Exception:
        df_1dte_comp = pd.DataFrame()

    if len(df_1dte_comp) > 0 and df_1dte_comp["date"].nunique() >= 3:
        dates_0 = set(df["date"].unique())
        dates_1 = set(df_1dte_comp["date"].unique())
        common_dates = sorted(dates_0 & dates_1)

        if len(common_dates) >= 5:
            SNAP_CASCADE = ["19:30", "19:00", "20:00", "20:15"]

            dists_always_0 = []
            dists_always_1 = []
            dists_composite = []
            composite_w10_list = []

            for date in common_dates:
                day_0 = df[df["date"] == date]
                day_1 = df_1dte_comp[df_1dte_comp["date"] == date]
                settlement = float(day_0["settlement"].iloc[0])

                snap_0, snap_1 = None, None
                for cp in SNAP_CASCADE:
                    if snap_0 is None:
                        snap_0 = find_nearest_snapshot(day_0, cp)
                    if snap_1 is None:
                        snap_1 = find_nearest_snapshot(day_1, cp)
                if snap_0 is None or snap_1 is None:
                    continue

                prof_0 = compute_gamma_profile(snap_0)
                prof_1 = compute_gamma_profile(snap_1)
                if not prof_0 or not prof_1:
                    continue

                conc = gamma_concentration(snap_0)
                dist_0 = abs(settlement - prof_0["prox_centroid"])
                dist_1 = abs(settlement - prof_1["prox_centroid"])

                dists_always_0.append(dist_0)
                dists_always_1.append(dist_1)

                # Composite: use concentration threshold sweep
                # (use 0.65 as a reasonable default; the exact best
                # threshold was computed in backtest but we use a
                # sensible middle value here)
                if conc < 0.65:
                    dists_composite.append(dist_1)
                    composite_w10_list.append(dist_1 <= 10)
                else:
                    dists_composite.append(dist_0)
                    composite_w10_list.append(dist_0 <= 10)

            if len(dists_always_0) >= 3:
                strategies = ["Always 0DTE", "Always 1DTE", "Composite\n(conc-gated)"]
                avgs = [
                    np.mean(dists_always_0),
                    np.mean(dists_always_1),
                    np.mean(dists_composite),
                ]
                w10_rates = [
                    np.mean([d <= 10 for d in dists_always_0]),
                    np.mean([d <= 10 for d in dists_always_1]),
                    np.mean(composite_w10_list),
                ]

                fig, ax = plt.subplots(figsize=(8, 6))

                bar_colors = [
                    COLORS["blue"],
                    COLORS["orange"],
                    COLORS["green"],
                ]

                bars = ax.bar(
                    strategies,
                    avgs,
                    color=bar_colors,
                    edgecolor="white",
                    linewidth=0.5,
                    width=0.55,
                )

                # Value labels on bars
                for bar, avg, w10 in zip(bars, avgs, w10_rates):
                    ax.text(
                        bar.get_x() + bar.get_width() / 2,
                        bar.get_height() + 0.5,
                        f"{avg:.1f} pts",
                        ha="center",
                        va="bottom",
                        fontsize=12,
                        fontweight="bold",
                        color="#ccc",
                    )
                    ax.text(
                        bar.get_x() + bar.get_width() / 2,
                        bar.get_height() / 2,
                        f"+/-10: {w10:.0%}",
                        ha="center",
                        va="center",
                        fontsize=10,
                        color="white",
                        fontweight="bold",
                    )

                ax.set_ylabel("Avg Distance to Settlement (pts)\n(lower is better)")
                ax.set_ylim(0, max(avgs) * 1.35)
                ax.set_title(
                    "0DTE vs 1DTE vs Composite Strategy",
                    fontsize=14,
                    fontweight="bold",
                )

                # Add "lower is better" arrow annotation
                ax.annotate(
                    "lower is better",
                    xy=(0.02, 0.95),
                    xycoords="axes fraction",
                    fontsize=9,
                    color=COLORS["gray"],
                    fontstyle="italic",
                )

                fig.savefig(
                    PLOT_DIR / "pin_composite.png",
                    dpi=150,
                    bbox_inches="tight",
                )
                plt.close(fig)
                print("  Saved: ml/plots/pin_composite.png")
            else:
                print("  Skipped pin_composite.png (insufficient common data)")
        else:
            print("  Skipped pin_composite.png (< 5 common dates)")
    else:
        print("  Skipped pin_composite.png (insufficient 1DTE data)")

    plt.close("all")


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Settlement Pin Risk Analysis",
    )
    parser.add_argument(
        "--plot",
        action="store_true",
        help="Save plots to ml/plots/",
    )
    args = parser.parse_args()

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
        print("  No max pain data yet (run build-features?backfill=true after deploy)")

    print("Loading OI per-strike data ...")
    oi_df = load_oi_per_strike()
    oi_count = oi_df["date"].nunique() if len(oi_df) > 0 else 0
    if oi_count > 0:
        print(f"  {oi_count} days with per-strike OI ({len(oi_df):,} total rows)")
    else:
        print("  No OI data yet (run backfill-oi-per-strike.mjs after deploy)")

    analyze_settlement_gravity(df)
    analyze_time_improvement(df)
    analyze_directional_bias(df)
    analyze_all_predictors(df, max_pain_df, oi_df)
    analyze_per_day_detail(df, max_pain_df)
    key_findings(df, max_pain_df)
    analyze_dte_comparison()
    analyze_dte_regime()
    backtest_composite_strategy()

    if args.plot:
        section("GENERATING PLOTS")
        generate_plots(df)

    # Save findings — compute T-30min predictor accuracy summary
    dates = sorted(df["date"].unique())
    predictor_methods = {
        "peak_gamma": "peak_gamma_strike",
        "pos_peak": "pos_peak_strike",
        "pos_centroid": "pos_centroid",
        "prox_centroid": "prox_centroid",
        "gamma_centroid": "gamma_centroid",
    }
    method_dists: dict[str, list[float]] = {k: [] for k in predictor_methods}
    for date in dates:
        day_data = df[df["date"] == date]
        settlement = float(day_data["settlement"].iloc[0])
        snapshot = find_nearest_snapshot(day_data, "19:30")
        if snapshot is None:
            continue
        profile = compute_gamma_profile(snapshot)
        if not profile:
            continue
        for method_name, key in predictor_methods.items():
            method_dists[method_name].append(abs(settlement - profile[key]))

    pin_accuracy: dict[str, dict] = {}
    for method_name, dists_list in method_dists.items():
        if dists_list:
            arr = np.array(dists_list)
            pin_accuracy[method_name] = {
                "avg_distance": round(float(arr.mean()), 1),
                "median_distance": round(float(np.median(arr)), 1),
                "within_10": round(float((arr <= 10).mean()), 3),
                "within_20": round(float((arr <= 20).mean()), 3),
                "n_days": len(dists_list),
            }

    # Gamma asymmetry correlation with settlement direction
    asym_corr = None
    if "settlement_direction" in df.columns:
        try:
            from scipy.stats import pointbiserialr

            day_asymmetries = []
            day_directions = []
            for date in dates:
                day_data = df[df["date"] == date]
                settlement_dir = day_data["settlement"].iloc[0]
                day_open = day_data["day_open"].iloc[0]
                snapshot = find_nearest_snapshot(day_data, "19:30")
                if snapshot is None:
                    continue
                profile = compute_gamma_profile(snapshot)
                if not profile:
                    continue
                asym = profile["pos_gamma_above"] - profile["pos_gamma_below"]
                settled_up = float(settlement_dir) > float(day_open)
                day_asymmetries.append(asym)
                day_directions.append(1.0 if settled_up else 0.0)
            if len(day_asymmetries) >= 5:
                r, p = pointbiserialr(day_directions, day_asymmetries)
                asym_corr = {
                    "r": round(float(r), 3),
                    "p": round(float(p), 3),
                    "n": len(day_asymmetries),
                }
        except Exception:
            pass

    save_section_findings(
        "pin_analysis",
        {
            "pin_accuracy_by_method": pin_accuracy,
            "asymmetry_correlation": asym_corr,
            "n_days": len(dates),
        },
    )

    print()


if __name__ == "__main__":
    main()
