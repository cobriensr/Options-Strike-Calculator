"""
Shared utilities for ML scripts.

Provides common data loading, DB connection, validation, and formatting helpers
used across clustering.py, eda.py, and visualize.py.
"""

import json
import os
import sys
import time
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg2
from scipy.stats import ConstantInputWarning
from sqlalchemy import create_engine

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
warnings.filterwarnings("ignore", category=ConstantInputWarning)

# Root of the ml/ directory. This file lives at ml/src/utils/__init__.py,
# so we climb three parents: utils/ → src/ → ml/.
ML_ROOT = Path(__file__).resolve().parent.parent.parent

# ── Feature Groups (shared across scripts) ─────────────────
# Canonical lists used by clustering.py, phase2_early.py, etc.
# Scripts may extend these with their own additions.

VOLATILITY_FEATURES: list[str] = [
    "vix",
    "vix1d",
    "vix1d_vix_ratio",
    "vix_vix9d_ratio",
]

GEX_FEATURES_T1T2: list[str] = [
    "gex_oi_t1",
    "gex_oi_t2",
    "gex_vol_t1",
    "gex_vol_t2",
    "gex_dir_t1",
    "gex_dir_t2",
]

GREEK_FEATURES_CORE: list[str] = [
    "agg_net_gamma",
    "dte0_net_charm",
    "dte0_charm_pct",
    "charm_slope",
]

DARK_POOL_FEATURES: list[str] = [
    "dp_total_premium",
    "dp_cluster_count",
    "dp_top_cluster_dist",
    "dp_support_premium",
    "dp_resistance_premium",
    "dp_support_resistance_ratio",
    "dp_concentration",
]

OPTIONS_VOLUME_FEATURES: list[str] = [
    "opt_call_volume",
    "opt_put_volume",
    "opt_call_oi",
    "opt_put_oi",
    "opt_call_premium",
    "opt_put_premium",
    "opt_bullish_premium",
    "opt_bearish_premium",
    "opt_call_vol_ask",
    "opt_put_vol_bid",
    "opt_vol_pcr",
    "opt_oi_pcr",
    "opt_premium_ratio",
    "opt_call_vol_vs_avg30",
    "opt_put_vol_vs_avg30",
]

IV_PCR_FEATURES: list[str] = [
    "iv_open",
    "iv_max",
    "iv_range",
    "iv_crush_rate",
    "iv_spike_count",
    "iv_at_t2",
    "pcr_open",
    "pcr_max",
    "pcr_min",
    "pcr_range",
    "pcr_trend_t1_t2",
    "pcr_spike_count",
]

MAX_PAIN_FEATURES: list[str] = [
    "max_pain_0dte",
    "max_pain_dist",
]

OI_CHANGE_FEATURES: list[str] = [
    "oic_net_oi_change",
    "oic_call_oi_change",
    "oic_put_oi_change",
    "oic_oi_change_pcr",
    "oic_net_premium",
    "oic_call_premium",
    "oic_put_premium",
    "oic_ask_ratio",
    "oic_multi_leg_pct",
    "oic_top_strike_dist",
    "oic_concentration",
]

VOL_SURFACE_FEATURES: list[str] = [
    "iv_ts_slope_0d_30d",
    "iv_ts_contango",
    "iv_ts_spread",
    "uw_rv_30d",
    "uw_iv_rv_spread",
    "uw_iv_overpricing_pct",
    "iv_rank",
]

# ── NOPE (Net Options Pricing Effect) Features ───────────
# SPY NOPE tracks intraday dealer hedging pressure from options delta
# flow per unit of underlying stock volume. Positive = dealers buying
# stock to hedge (bullish tape pressure). Four checkpoint snapshots +
# three AM-window aggregates (09:30–11:30 ET).
NOPE_FEATURES: list[str] = [
    "nope_t1",  # NOPE at 10:00 ET
    "nope_t2",  # NOPE at 10:30 ET
    "nope_t3",  # NOPE at 11:00 ET
    "nope_t4",  # NOPE at 11:30 ET
    "nope_am_mean",  # Mean NOPE over 09:30–11:30 window
    "nope_am_sign_flips",  # Count of sign flips over AM window
    "nope_am_cum_delta",  # Σ (call_delta − put_delta) over AM window
]

# ── Futures Feature Groups ────────────────────────────────

ES_FEATURES: list[str] = [
    "es_momentum_t1",  # ES 1H return at T1 checkpoint (%)
    "es_momentum_t2",  # ES 1H return at T2 checkpoint (%)
    "es_spx_basis_t1",  # ES - SPX fair value at T1 (pts)
    "es_volume_ratio_t1",  # ES volume / 20-day avg at T1
    "es_overnight_range",  # Globex high - low (pts)
    "es_overnight_gap",  # Cash open - Globex close (pts)
    "es_gap_fill_pct_t1",  # How much of the gap filled by T1
    "es_vwap_deviation_t1",  # ES price - overnight VWAP at T1 (pts)
]

NQ_FEATURES: list[str] = [
    "nq_momentum_t1",  # NQ 1H return at T1 (%)
    "nq_es_ratio_t1",  # NQ/ES ratio at T1 (tech strength)
    "nq_es_ratio_change",  # NQ/ES ratio change from prior day close
    "nq_qqq_divergence_t1",  # sign(NQ momentum) vs sign(QQQ NCP) (1/-1)
]

VX_FEATURES: list[str] = [
    "vx_front_price",  # VX front month close/last
    "vx_term_spread",  # VX front - VX second (pts)
    "vx_term_slope_pct",  # (front - back) / back as percentage
    "vx_contango_signal",  # 1 = contango, -1 = backwardation
    "vx_basis",  # VX front - spot VIX (futures premium)
]

ZN_FEATURES: list[str] = [
    "zn_momentum_t1",  # ZN 1H return at T1 (%)
    "zn_daily_change",  # Prior day ZN change (%)
    "spx_zn_correlation_5d",  # 5-day rolling correlation SPX vs ZN
]

RTY_FEATURES: list[str] = [
    "rty_momentum_t1",  # RTY 1H return at T1 (%)
    "rty_es_divergence_t1",  # sign(RTY) vs sign(ES) agreement (1/-1)
]

CL_FEATURES: list[str] = [
    "cl_overnight_change_pct",  # % change from prior settlement to Globex close
    "cl_intraday_momentum_t1",  # % change from open to T1
    "cl_es_correlation_5d",  # 5-day rolling correlation CL vs ES
]

ES_OPTIONS_FEATURES: list[str] = [
    "es_put_oi_concentration",  # OI at largest put strike / total put OI
    "es_call_oi_concentration",  # OI at largest call strike / total call OI
    "es_options_max_pain_dist",  # Distance from ES to max pain strike (pts)
    "es_spx_gamma_agreement",  # ES and SPX gamma walls agree? (0-1 score)
    "es_put_buy_aggressor_pct",  # % of ES put vol from buy aggressors
    "es_call_buy_aggressor_pct",  # % of ES call vol from buy aggressors
    "es_options_net_delta",  # Sum of exchange delta x OI at ATM strikes
    "es_atm_iv",  # Exchange-computed IV at nearest ATM strike
]

FUTURES_FEATURES: list[str] = (
    ES_FEATURES
    + NQ_FEATURES
    + VX_FEATURES
    + ZN_FEATURES
    + RTY_FEATURES
    + CL_FEATURES
    + ES_OPTIONS_FEATURES
)


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
    """Get a Postgres connection, retrying transient Neon blips.

    Neon's serverless Postgres has multi-hour windows where connect() raises
    OperationalError/InterfaceError. Retry with bounded exponential backoff
    (6 attempts: 1,2,4,8,16,32s) so a single blip can't abort `make update`.
    A permanent failure (bad URL/auth) still exits 1 after the last attempt —
    semantics unchanged, we only paper over the transient case.

    Mirrors scripts/_pipeline_retry.connect_with_retry; kept inline here
    because ml/src/ and scripts/ aren't on a shared import path at runtime.
    """
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    attempts = 6
    for attempt in range(attempts):
        try:
            return psycopg2.connect(database_url, sslmode="require", connect_timeout=10)
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            if attempt == attempts - 1:
                print(f"Error: Could not connect to database: {e}")
                print("  Check DATABASE_URL in .env and network connectivity.")
                sys.exit(1)
            wait = min(60, 2**attempt)
            print(
                f"  [retry] DB connect attempt {attempt + 1}/{attempts} failed "
                f"({type(e).__name__}); retrying in {wait}s...",
                file=sys.stderr,
            )
            time.sleep(wait)
    # Unreachable: the loop returns a connection or sys.exit()s.
    raise RuntimeError("unreachable")  # pragma: no cover


def make_engine(database_url: str):
    """Build a SQLAlchemy engine on psycopg2, the driver this project installs.

    A bare `postgresql://` URL names no driver. SQLAlchemy 2.0 picked
    psycopg2 for it; 2.1 picks psycopg 3, which is not a dependency here, so
    the engine fails with ModuleNotFoundError. A bare `postgres://` URL (the
    older spelling some providers hand out) names no dialect at all, and
    SQLAlchemy raises NoSuchModuleError for it. Every ml/ engine goes through
    this helper so the driver never depends on the SQLAlchemy version. A URL
    that names its own driver is left alone.
    """
    for bare in ("postgresql://", "postgres://"):
        if database_url.startswith(bare):
            database_url = "postgresql+psycopg2://" + database_url.removeprefix(bare)
            break
    return create_engine(database_url)


def load_data(query: str) -> pd.DataFrame:
    """Execute a SQL query and return a DataFrame indexed by date."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)

    # Outside the try: an engine that cannot be built (a missing driver) must
    # raise as itself, not leave `engine` unbound for the finally below.
    engine = make_engine(database_url)
    try:
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
                print(
                    f"  Warning: {out_of_range} values in '{col}' "
                    f"outside expected range [{lo}, {hi}]"
                )

    # Duplicate index check
    dupes = df.index.duplicated().sum()
    if dupes > 0:
        print(f"  Warning: {dupes} duplicate dates in index")

    # Null coverage summary
    null_pct = df.isnull().mean()
    high_null = null_pct[null_pct > 0.5]
    if len(high_null) > 0:
        print(
            f"  Warning: {len(high_null)} columns are >50% null: "
            f"{high_null.index.tolist()[:10]}"
        )


# ── Formatting Helpers ──────────────────────────────────────


def section(title: str) -> None:
    """Print a section header."""
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print(f"{'=' * 70}")


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


_RESERVED_SECTIONS = frozenset({"generated_at", "pipeline_sections"})

# One atomic statement: merge a single top-level key into the singleton row.
# `||` replaces only the named keys; every other section already in the row,
# including ones this machine has never computed, is left alone. The row lock
# serializes concurrent writers, and under READ COMMITTED the second DO UPDATE
# re-reads the committed row, so two sections saved at once cannot lose each
# other. generated_at and pipeline_sections are kept in the same statement.
_MERGE_SECTION_SQL = """
    INSERT INTO ml_findings (id, findings, updated_at)
    VALUES (
      1,
      jsonb_build_object(
        %(name)s::text, %(data)s::jsonb,
        'generated_at', %(generated_at)s::text,
        'pipeline_sections', jsonb_build_array(%(name)s::text)
      ),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE
      SET findings = ml_findings.findings
            || jsonb_build_object(
                 %(name)s::text, %(data)s::jsonb,
                 'generated_at', %(generated_at)s::text)
            || jsonb_build_object(
                 'pipeline_sections',
                 CASE
                   WHEN COALESCE(ml_findings.findings->'pipeline_sections', '[]'::jsonb)
                        @> to_jsonb(%(name)s::text)
                   THEN COALESCE(ml_findings.findings->'pipeline_sections', '[]'::jsonb)
                   ELSE COALESCE(ml_findings.findings->'pipeline_sections', '[]'::jsonb)
                        || to_jsonb(%(name)s::text)
                 END),
          updated_at = NOW()
"""


def _null_non_finite(value: Any, section_name: str, path: str = "") -> Any:
    """Return `value` with every NaN or infinity replaced by None.

    Recurses through dicts, lists and tuples (tuples come back as lists, as
    JSON would write them) and returns a new structure; the caller's data is
    not mutated. Each replacement prints a warning naming the section and the
    key path. json.dumps writes a bare NaN token for a float subclass, which
    Postgres jsonb rejects, and sends a numpy float that is not a float
    subclass (float32, float16) through default=str, which would save the
    string "nan". Both are caught here, so a non-finite value is always null.
    """
    if isinstance(value, dict):
        return {
            key: _null_non_finite(
                item, section_name, f"{path}.{key}" if path else str(key)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [
            _null_non_finite(item, section_name, f"{path}[{i}]")
            for i, item in enumerate(value)
        ]
    if isinstance(value, (float, np.floating)) and not np.isfinite(value):
        print(
            f"  Warning: non-finite value in section '{section_name}' "
            f"at '{path or '<root>'}' saved as null"
        )
        return None
    return value


def _upsert_findings_db(section_name: str, data: dict, generated_at: str) -> None:
    """Merge ONE section into the ml_findings singleton row.

    Sends only the section this script computed, never the local findings.json,
    so a stale or test-made section in the local file cannot reach production
    and a section this machine lacks is not deleted there. Skips quietly when
    DATABASE_URL is unavailable (CI, local dev without .env); the JSON file is
    the primary artifact. A database error propagates: a save that did not
    reach the table must not look like one that did.
    """
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        return  # No DB configured — skip silently, JSON file is enough

    # allow_nan=False is the backstop: jsonb rejects NaN, and the caller has
    # already turned every non-finite float into null.
    payload = json.dumps(data, default=str, allow_nan=False)
    conn = psycopg2.connect(database_url, sslmode="require", connect_timeout=10)
    try:
        with conn, conn.cursor() as cur:  # commit on success, roll back on error
            cur.execute(
                _MERGE_SECTION_SQL,
                {"name": section_name, "data": payload, "generated_at": generated_at},
            )
    finally:
        conn.close()
    print("  Saved: ml_findings table (DB)")


def save_section_findings(section_name: str, data: dict) -> None:
    """
    Write a named section into the consolidated ml/findings.json.

    Read-modify-writes the file so multiple scripts can each contribute
    their own section without clobbering each other. The DB gets ONLY this
    section (a JSONB merge into ml_findings id 1), never the whole file.

    A non-finite float anywhere in a section is saved as null, with a printed
    warning. Errors are not swallowed: a database error propagates after the
    local file has been written, so a save that missed the table fails the
    script instead of printing a warning that scrolls past.
    """
    if section_name in _RESERVED_SECTIONS:
        raise ValueError(f"{section_name!r} is a metadata key, not a section")

    findings_path = ML_ROOT / "findings.json"

    # Load existing findings if present. A NaN an older run left in another
    # section is nulled too (with a warning naming that section) so it cannot
    # break the strict write below.
    if findings_path.exists():
        existing = json.loads(findings_path.read_text())
        findings = {
            name: _null_non_finite(section, name) for name, section in existing.items()
        }
    else:
        findings = {}

    # Update the section
    data = _null_non_finite(data, section_name)
    findings[section_name] = data

    # Update metadata
    generated_at = datetime.now(UTC).isoformat(timespec="seconds")
    findings["generated_at"] = generated_at

    # Maintain pipeline_sections list
    sections = findings.get("pipeline_sections", [])
    if section_name not in sections:
        sections.append(section_name)
    findings["pipeline_sections"] = sections

    # Write back
    findings_path.write_text(
        json.dumps(findings, indent=2, default=str, allow_nan=False) + "\n"
    )
    print(f"  Saved: ml/findings.json (section: {section_name})")

    # Persist to DB: this section only
    _upsert_findings_db(section_name, data, generated_at)
