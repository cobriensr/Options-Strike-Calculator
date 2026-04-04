"""
Shared utilities for ML scripts.

Provides common data loading, DB connection, validation, and formatting helpers
used across clustering.py, eda.py, and visualize.py.
"""

import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

# Suppress sklearn SimpleImputer warning for columns with all-NaN values.
# These columns (e.g., iv_crush_rate, iv_at_t2) are legitimately sparse in
# early pipeline stages and get dropped or filled downstream.
warnings.filterwarnings(
    "ignore",
    message="Skipping features without any observed values",
    category=UserWarning,
    module="sklearn.impute",
)

# Suppress scipy ConstantInputWarning from pointbiserialr/pearsonr.
# Constant-input columns are expected when features have zero variance
# over the (still small) labeled dataset.
from scipy.stats import ConstantInputWarning

warnings.filterwarnings("ignore", category=ConstantInputWarning)

import pandas as pd

# Root of the ml/ directory (parent of src/)
ML_ROOT = Path(__file__).resolve().parent.parent
import psycopg2
from sqlalchemy import create_engine


# ── Feature Groups (shared across scripts) ─────────────────
# Canonical lists used by clustering.py, phase2_early.py, etc.
# Scripts may extend these with their own additions.

VOLATILITY_FEATURES: list[str] = [
    "vix", "vix1d", "vix1d_vix_ratio", "vix_vix9d_ratio",
]

GEX_FEATURES_T1T2: list[str] = [
    "gex_oi_t1", "gex_oi_t2",
    "gex_vol_t1", "gex_vol_t2",
    "gex_dir_t1", "gex_dir_t2",
]

GREEK_FEATURES_CORE: list[str] = [
    "agg_net_gamma", "dte0_net_charm", "dte0_charm_pct",
    "charm_slope",
]

DARK_POOL_FEATURES: list[str] = [
    "dp_total_premium",
    "dp_cluster_count", "dp_top_cluster_dist",
    "dp_support_premium", "dp_resistance_premium",
    "dp_support_resistance_ratio", "dp_concentration",
]

OPTIONS_VOLUME_FEATURES: list[str] = [
    "opt_call_volume", "opt_put_volume",
    "opt_call_oi", "opt_put_oi",
    "opt_call_premium", "opt_put_premium",
    "opt_bullish_premium", "opt_bearish_premium",
    "opt_call_vol_ask", "opt_put_vol_bid",
    "opt_vol_pcr", "opt_oi_pcr", "opt_premium_ratio",
    "opt_call_vol_vs_avg30", "opt_put_vol_vs_avg30",
]

IV_PCR_FEATURES: list[str] = [
    "iv_open", "iv_max", "iv_range", "iv_crush_rate",
    "iv_spike_count", "iv_at_t2",
    "pcr_open", "pcr_max", "pcr_min", "pcr_range",
    "pcr_trend_t1_t2", "pcr_spike_count",
]

MAX_PAIN_FEATURES: list[str] = [
    "max_pain_0dte", "max_pain_dist",
]

OI_CHANGE_FEATURES: list[str] = [
    "oic_net_oi_change", "oic_call_oi_change", "oic_put_oi_change",
    "oic_oi_change_pcr", "oic_net_premium", "oic_call_premium",
    "oic_put_premium", "oic_ask_ratio", "oic_multi_leg_pct",
    "oic_top_strike_dist", "oic_concentration",
]

VOL_SURFACE_FEATURES: list[str] = [
    "iv_ts_slope_0d_30d", "iv_ts_contango", "iv_ts_spread",
    "uw_rv_30d", "uw_iv_rv_spread", "uw_iv_overpricing_pct",
    "iv_rank",
]


# ── Environment & DB ────────────────────────────────────────

def load_env() -> dict[str, str]:
    """Load environment variables from .env file, falling back to os.environ."""
    env: dict[str, str] = dict(os.environ)
    env_path = ML_ROOT.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def get_connection() -> psycopg2.extensions.connection:
    """Get a Postgres connection with error handling."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    try:
        conn = psycopg2.connect(database_url, sslmode="require",
                                connect_timeout=10)
    except psycopg2.OperationalError as e:
        print(f"Error: Could not connect to database: {e}")
        print("  Check DATABASE_URL in .env and network connectivity.")
        sys.exit(1)
    return conn


def load_data(query: str) -> pd.DataFrame:
    """Execute a SQL query and return a DataFrame indexed by date."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    try:
        engine = create_engine(database_url)
        df = pd.read_sql_query(query, engine, parse_dates=["date"])
    except Exception as e:
        print(f"Error: Query failed: {e}")
        sys.exit(1)
    finally:
        engine.dispose()
    return df.set_index("date").sort_index()


# ── Data Validation ─────────────────────────────────────────

def validate_dataframe(
    df: pd.DataFrame,
    *,
    min_rows: int = 5,
    required_columns: list[str] | None = None,
    range_checks: dict[str, tuple[float, float]] | None = None,
) -> None:
    """
    Validate a DataFrame before processing.

    Raises SystemExit on fatal issues, prints warnings for non-fatal ones.

    Args:
        df: DataFrame to validate.
        min_rows: Minimum expected row count.
        required_columns: Columns that must exist.
        range_checks: Dict of column -> (min, max) for sanity checks.
    """
    # Row count
    if len(df) < min_rows:
        print(f"Error: Only {len(df)} rows loaded (minimum {min_rows} required).")
        print("  Check that the database has sufficient data.")
        sys.exit(1)

    # Required columns
    if required_columns:
        missing = [c for c in required_columns if c not in df.columns]
        if missing:
            print(f"Error: Missing required columns: {missing}")
            print(f"  Available columns: {sorted(df.columns.tolist())[:20]}...")
            sys.exit(1)

    # Range checks (warnings, not fatal)
    if range_checks:
        for col, (lo, hi) in range_checks.items():
            if col not in df.columns:
                continue
            vals = df[col].dropna().astype(float)
            if len(vals) == 0:
                continue
            out_of_range = ((vals < lo) | (vals > hi)).sum()
            if out_of_range > 0:
                print(f"  Warning: {out_of_range} values in '{col}' "
                      f"outside expected range [{lo}, {hi}]")

    # Duplicate index check
    dupes = df.index.duplicated().sum()
    if dupes > 0:
        print(f"  Warning: {dupes} duplicate dates in index")

    # Null coverage summary
    null_pct = df.isnull().mean()
    high_null = null_pct[null_pct > 0.5]
    if len(high_null) > 0:
        print(f"  Warning: {len(high_null)} columns are >50% null: "
              f"{high_null.index.tolist()[:10]}")


# ── Formatting Helpers ──────────────────────────────────────

def section(title: str) -> None:
    """Print a section header."""
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")


def subsection(title: str) -> None:
    """Print a subsection header."""
    print(f"\n  --- {title} ---\n")


def verdict(confirmed: bool, caveat: str = "") -> str:
    """Format a rule validation verdict."""
    tag = "CONFIRMED" if confirmed else "NOT CONFIRMED"
    return f"  >> {tag}{f' -- {caveat}' if caveat else ''}"


def takeaway(text: str) -> None:
    """Print a takeaway line."""
    print(f"\n  TAKEAWAY: {text}")


# ── Findings Persistence ───────────────────────────────────────


def _upsert_findings_db(findings: dict) -> None:
    """Upsert consolidated findings into ml_findings table."""
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO ml_findings (id, findings, updated_at)
            VALUES (1, %s, NOW())
            ON CONFLICT (id) DO UPDATE
              SET findings = EXCLUDED.findings,
                  updated_at = NOW()
            """,
            (json.dumps(findings, default=str),),
        )
        conn.commit()
        cur.close()
        conn.close()
        print("  Saved: ml_findings table (DB)")
    except Exception as e:
        print(f"  Warning: Could not upsert ml_findings to DB: {e}")
        print("  (findings.json was still saved locally)")


def save_section_findings(section_name: str, data: dict) -> None:
    """
    Write a named section into the consolidated ml/findings.json.

    Read-modify-writes the file so multiple scripts can each contribute
    their own section without clobbering each other. After writing the
    file, upserts the full consolidated JSON to the ml_findings DB table.
    """
    findings_path = ML_ROOT / "findings.json"

    try:
        # Load existing findings if present
        if findings_path.exists():
            findings = json.loads(findings_path.read_text())
        else:
            findings = {}

        # Update the section
        findings[section_name] = data

        # Update metadata
        findings["generated_at"] = datetime.now(timezone.utc).isoformat(
            timespec="seconds"
        )

        # Maintain pipeline_sections list
        sections = findings.get("pipeline_sections", [])
        if section_name not in sections:
            sections.append(section_name)
        findings["pipeline_sections"] = sections

        # Write back
        findings_path.write_text(
            json.dumps(findings, indent=2, default=str) + "\n"
        )
        print(f"  Saved: ml/findings.json (section: {section_name})")

        # Persist to DB
        _upsert_findings_db(findings)

    except Exception as e:
        print(f"  Warning: Could not save findings for '{section_name}': {e}")
