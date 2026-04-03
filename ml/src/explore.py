"""
ML Data Explorer — Query training data directly from Neon Postgres and explore.

Usage:
    python3 ml/explore.py                     # Pull all data, print summary
    python3 ml/explore.py --csv out.csv       # Save to CSV
    python3 ml/explore.py --after 2026-03-01  # Filter by date

Requires: pip install psycopg2-binary pandas
Reads DATABASE_URL from .env in the repo root.
"""

import argparse
import sys
from pathlib import Path

try:
    import pandas as pd
    import psycopg2
except ImportError:
    print("Missing dependencies. Run:\n  ml/.venv/bin/pip install psycopg2-binary pandas")
    sys.exit(1)

from utils import ML_ROOT


def load_env() -> dict[str, str]:
    """Read .env file from repo root into a dict."""
    env_path = ML_ROOT.parent / ".env"
    env = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def fetch_data(
    database_url: str,
    after: str | None = None,
    before: str | None = None,
    min_feature: float = 0.0,
    min_label: float = 0.0,
) -> pd.DataFrame:
    """Fetch training data directly from Neon Postgres."""
    query = """
        SELECT f.*,
            o.settlement, o.day_open, o.day_high, o.day_low,
            o.day_range_pts, o.day_range_pct, o.close_vs_open,
            o.vix_close, o.vix1d_close,
            l.analysis_id AS label_analysis_id,
            l.structure_correct, l.recommended_structure,
            l.confidence AS label_confidence, l.suggested_delta AS label_delta,
            l.charm_diverged, l.naive_charm_signal,
            l.spx_flow_signal, l.market_tide_signal,
            l.spy_flow_signal, l.gex_signal,
            l.flow_was_directional, l.settlement_direction,
            l.range_category, l.label_completeness
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        LEFT JOIN day_labels l ON l.date = f.date
        WHERE (%(after)s::date IS NULL OR f.date > %(after)s::date)
          AND (%(before)s::date IS NULL OR f.date < %(before)s::date)
          AND f.feature_completeness >= %(min_feature)s
          AND COALESCE(l.label_completeness, 0) >= %(min_label)s
        ORDER BY f.date ASC
    """
    params = {
        "after": after,
        "before": before,
        "min_feature": min_feature,
        "min_label": min_label,
    }

    conn = psycopg2.connect(database_url, sslmode="require")
    try:
        df = pd.read_sql_query(query, conn, params=params, parse_dates=["date"])
    finally:
        conn.close()

    if df.empty:
        print("No data returned.")
        return df

    df = df.set_index("date").sort_index()
    return df


def print_summary(df: pd.DataFrame) -> None:
    """Print a summary of the dataset."""
    print(f"\n{'='*60}")
    print(f"  ML Training Data: {len(df)} days, {len(df.columns)} columns")
    print(f"  Date range: {df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d}")
    print(f"{'='*60}\n")

    # Feature completeness
    if "feature_completeness" in df.columns:
        fc = df["feature_completeness"].astype(float)
        print(f"Feature completeness: {fc.mean():.1%} avg, {fc.min():.1%} min, {fc.max():.1%} max")

    # Label coverage
    if "structure_correct" in df.columns:
        labeled = df["structure_correct"].notna().sum()
        print(f"Labels: {labeled}/{len(df)} days have review labels ({labeled/len(df):.0%})")

    if "charm_diverged" in df.columns:
        charm_labeled = df["charm_diverged"].notna().sum()
        print(f"Charm divergence labels: {charm_labeled} days")

    # Outcomes coverage
    if "settlement" in df.columns:
        outcomes = df["settlement"].notna().sum()
        print(f"Outcomes: {outcomes}/{len(df)} days ({outcomes/len(df):.0%})")

    # Key feature distributions
    print("\n--- Key Features ---")
    numeric_features = [
        "vix", "vix1d", "vix1d_vix_ratio",
        "gex_oi_t1", "gex_oi_t4",
        "flow_agreement_t1", "flow_agreement_t4",
        "gamma_asymmetry", "charm_slope",
    ]
    present = [f for f in numeric_features if f in df.columns]
    if present:
        print(df[present].astype(float).describe().round(2).to_string())

    # Label distribution
    if "recommended_structure" in df.columns:
        print("\n--- Structure Distribution ---")
        print(df["recommended_structure"].value_counts().to_string())

    if "charm_pattern" in df.columns:
        print("\n--- Charm Pattern Distribution ---")
        print(df["charm_pattern"].value_counts().to_string())

    if "range_category" in df.columns:
        print("\n--- Range Category Distribution ---")
        print(df["range_category"].value_counts().to_string())

    # Correlation highlights
    if "settlement" in df.columns and "vix" in df.columns:
        range_cols = [c for c in ["day_range_pts", "vix", "vix1d", "vix1d_vix_ratio",
                                    "gex_oi_t1", "gamma_asymmetry"] if c in df.columns]
        if len(range_cols) > 1 and "day_range_pts" in df.columns:
            print("\n--- Correlations with Day Range ---")
            corr = df[range_cols].astype(float).corrwith(df["day_range_pts"].astype(float))
            for col, val in corr.items():
                if col != "day_range_pts" and pd.notna(val):
                    print(f"  {col:25s} {val:+.3f}")

    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Explore ML training data")
    parser.add_argument("--after", default=None, help="Only days after YYYY-MM-DD")
    parser.add_argument("--before", default=None, help="Only days before YYYY-MM-DD")
    parser.add_argument("--min-features", type=float, default=0.0, help="Min feature completeness")
    parser.add_argument("--min-labels", type=float, default=0.0, help="Min label completeness")
    parser.add_argument("--csv", default=None, help="Save to CSV file")
    args = parser.parse_args()

    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    print("Connecting to Neon Postgres ...")

    df = fetch_data(
        database_url=database_url,
        after=args.after,
        before=args.before,
        min_feature=args.min_features,
        min_label=args.min_labels,
    )

    if df.empty:
        sys.exit(0)

    print_summary(df)

    if args.csv:
        df.to_csv(args.csv)
        print(f"Saved to {args.csv}")


if __name__ == "__main__":
    main()
