"""
Pipeline Health Monitor — Check data freshness, completeness, and stationarity.

Validates that the ML training data pipeline is healthy by checking
freshness of key tables, feature completeness trends, label coverage,
column null rates, and feature stationarity.

Usage:
    python3 ml/health.py

Requires: pip install psycopg2-binary pandas numpy
"""

import sys
from datetime import datetime, timedelta

try:
    import pandas as pd
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas numpy")
    sys.exit(1)

from utils import load_data, get_connection, section, subsection, verdict, takeaway


# ── Constants ──────────────────────────────────────────────────

KEY_FEATURE_COLUMNS = [
    "vix",
    "gex_oi_t1",
    "flow_agreement_t1",
    "charm_pattern",
    "prev_day_range_pts",
    "realized_vol_5d",
]


# ── Helpers ────────────────────────────────────────────────────

def most_recent_business_day() -> datetime:
    """Return the most recent business day (Mon-Fri) as of today."""
    today = datetime.now()
    offset = 0
    # Saturday = 5, Sunday = 6
    if today.weekday() == 5:
        offset = 1
    elif today.weekday() == 6:
        offset = 2
    return (today - timedelta(days=offset)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def business_days_between(d1: datetime, d2: datetime) -> int:
    """Count business days between two dates (exclusive of d2)."""
    if d1 > d2:
        d1, d2 = d2, d1
    days = 0
    current = d1 + timedelta(days=1)
    while current <= d2:
        if current.weekday() < 5:
            days += 1
        current += timedelta(days=1)
    return days


# ── Check 1: Data Freshness ────────────────────────────────────

def check_freshness(warnings: list[str], failures: list[str]) -> None:
    section("1. DATA FRESHNESS")

    target = most_recent_business_day()
    print(f"  Most recent business day: {target:%Y-%m-%d}")

    tables = [
        ("training_features", "Training Features", 1),
        ("outcomes", "Outcomes", 1),
        ("day_labels", "Day Labels", 1),
    ]

    for table, label, max_gap in tables:
        subsection(label)
        try:
            df = load_data(f"SELECT date FROM {table} ORDER BY date DESC LIMIT 1")
        except SystemExit:
            msg = f"{label}: table missing or query failed"
            failures.append(msg)
            print(f"  FAIL: {msg}")
            continue

        if df.empty:
            msg = f"{label}: no rows found"
            failures.append(msg)
            print(f"  FAIL: {msg}")
            continue

        latest = df.index[0]
        if isinstance(latest, pd.Timestamp):
            latest_dt = latest.to_pydatetime().replace(tzinfo=None)
        else:
            latest_dt = datetime.combine(latest, datetime.min.time())

        gap = business_days_between(latest_dt, target)
        print(f"  Latest row: {latest_dt:%Y-%m-%d}")
        print(f"  Business days since last update: {gap}")

        if gap > max_gap:
            msg = f"{label}: {gap} business days stale (max {max_gap})"
            warnings.append(msg)
            print(f"  WARN: {msg}")
        else:
            print(verdict(True, "data is current"))


# ── Check 2: Feature Completeness Trend ────────────────────────

def check_completeness(warnings: list[str], _failures: list[str]) -> None:
    section("2. FEATURE COMPLETENESS TREND")

    df = load_data("""
        SELECT date, feature_completeness
        FROM training_features
        ORDER BY date DESC
        LIMIT 10
    """)

    if len(df) < 2:
        msg = "Not enough training_features rows for completeness check"
        warnings.append(msg)
        print(f"  WARN: {msg}")
        return

    df = df.sort_index()
    completeness = df["feature_completeness"].astype(float)

    subsection("Last 10 Days")
    for dt, val in completeness.items():
        flag = " << LOW" if val < 0.90 else ""
        print(f"  {dt:%Y-%m-%d}  {val:.2%}{flag}")

    # Check for any day below 0.90
    low_days = completeness[completeness < 0.90]
    if len(low_days) > 0:
        msg = (f"Feature completeness below 90% on "
               f"{len(low_days)} of last {len(completeness)} days")
        warnings.append(msg)
        print(f"\n  WARN: {msg}")

    # Trend check: last 5 vs prior 5
    if len(completeness) >= 10:
        prior_5 = completeness.iloc[:5].mean()
        last_5 = completeness.iloc[5:].mean()
        print(f"\n  Prior 5-day avg: {prior_5:.2%}")
        print(f"  Last  5-day avg: {last_5:.2%}")
        if last_5 < prior_5:
            diff = prior_5 - last_5
            msg = (f"Completeness trending down: "
                   f"{last_5:.2%} vs {prior_5:.2%} (delta {diff:.2%})")
            warnings.append(msg)
            print(f"  WARN: {msg}")
        else:
            print(verdict(True, "completeness stable or improving"))
    else:
        print(f"\n  Only {len(completeness)} days available; need 10 for trend check")


# ── Check 3: Label Extraction Health ───────────────────────────

def check_labels(warnings: list[str], failures: list[str]) -> None:
    section("3. LABEL EXTRACTION HEALTH")

    conn = get_connection()
    try:
        cur = conn.cursor()

        cur.execute("SELECT COUNT(*) FROM training_features")
        total_features = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM day_labels")
        total_labels = cur.fetchone()[0]

        # Recent 5 days coverage
        cur.execute("""
            SELECT COUNT(*) FROM (
                SELECT date FROM training_features
                ORDER BY date DESC LIMIT 5
            ) t
        """)
        recent_features = cur.fetchone()[0]

        cur.execute("""
            SELECT COUNT(*) FROM day_labels
            WHERE date IN (
                SELECT date FROM training_features
                ORDER BY date DESC LIMIT 5
            )
        """)
        recent_labels = cur.fetchone()[0]
    finally:
        conn.close()

    if total_features == 0:
        msg = "No training_features rows found"
        failures.append(msg)
        print(f"  FAIL: {msg}")
        return

    overall_pct = total_labels / total_features
    recent_pct = recent_labels / recent_features if recent_features > 0 else 0.0

    subsection("Coverage")
    print(f"  Total days with features: {total_features}")
    print(f"  Total days with labels:   {total_labels}")
    print(f"  Overall label coverage:   {overall_pct:.0%}")
    print(f"\n  Recent 5 days: {recent_labels}/{recent_features} labeled ({recent_pct:.0%})")

    if recent_pct < overall_pct and recent_features > 0:
        msg = (f"Recent label coverage ({recent_pct:.0%}) is lower "
               f"than overall ({overall_pct:.0%})")
        warnings.append(msg)
        print(f"  WARN: {msg}")
    else:
        print(verdict(True, "recent label coverage is on par"))


# ── Check 4: Column Coverage ──────────────────────────────────

def check_column_coverage(warnings: list[str], _failures: list[str]) -> None:
    section("4. COLUMN COVERAGE (key features, last 10 days)")

    cols_sql = ", ".join(KEY_FEATURE_COLUMNS)
    df = load_data(f"""
        SELECT date, {cols_sql}
        FROM training_features
        ORDER BY date DESC
        LIMIT 10
    """)

    if len(df) < 2:
        msg = "Not enough rows for column coverage check"
        warnings.append(msg)
        print(f"  WARN: {msg}")
        return

    n_rows = len(df)
    subsection(f"Null rates over {n_rows} recent days")

    for col in KEY_FEATURE_COLUMNS:
        if col not in df.columns:
            msg = f"Column '{col}' missing from training_features"
            warnings.append(msg)
            print(f"  WARN: {msg}")
            continue

        null_count = df[col].isnull().sum()
        null_pct = null_count / n_rows
        flag = " << HIGH" if null_pct > 0.20 else ""
        print(f"  {col:25s}  {null_count}/{n_rows} null ({null_pct:.0%}){flag}")

        if null_pct > 0.20:
            msg = f"'{col}' is {null_pct:.0%} null in last {n_rows} days"
            warnings.append(msg)


# ── Check 5: Stationarity Alerts ──────────────────────────────

def check_stationarity(warnings: list[str], _failures: list[str]) -> None:
    section("5. STATIONARITY ALERTS (regime change detection)")

    monitor_cols = ["vix", "gex_oi_t1", "flow_agreement_t1"]

    cols_sql = ", ".join(monitor_cols)
    df_all = load_data(f"""
        SELECT date, {cols_sql}
        FROM training_features
        ORDER BY date ASC
    """)

    if len(df_all) < 15:
        msg = "Not enough data for stationarity check (need 15+ days)"
        warnings.append(msg)
        print(f"  WARN: {msg}")
        return

    df_recent = df_all.tail(10)

    subsection("Recent 10-day mean vs overall mean")

    for col in monitor_cols:
        if col not in df_all.columns:
            continue

        all_vals = df_all[col].dropna().astype(float)
        recent_vals = df_recent[col].dropna().astype(float)

        if len(all_vals) < 10 or len(recent_vals) < 3:
            print(f"  {col:25s}  insufficient data")
            continue

        overall_mean = all_vals.mean()
        overall_std = all_vals.std()
        recent_mean = recent_vals.mean()

        if overall_std == 0:
            print(f"  {col:25s}  zero variance (all identical)")
            continue

        z_score = (recent_mean - overall_mean) / overall_std
        flag = ""
        if abs(z_score) > 2:
            direction = "above" if z_score > 0 else "below"
            msg = (f"'{col}' regime shift: recent mean {recent_mean:.2f} "
                   f"is {abs(z_score):.1f} SD {direction} overall mean "
                   f"{overall_mean:.2f}")
            warnings.append(msg)
            flag = " << REGIME SHIFT"

        print(f"  {col:25s}  overall {overall_mean:>8.2f} (SD {overall_std:.2f})"
              f"  recent {recent_mean:>8.2f}  z={z_score:+.1f}{flag}")


# ── Check 6: Summary ──────────────────────────────────────────

def print_summary(warnings: list[str], failures: list[str]) -> None:
    section("SUMMARY")

    if failures:
        status = "FAIL"
    elif warnings:
        status = "WARN"
    else:
        status = "PASS"

    print(f"\n  Overall status: {status}")

    if failures:
        subsection("Failures")
        for f in failures:
            print(f"  - {f}")

    if warnings:
        subsection("Warnings")
        for w in warnings:
            print(f"  - {w}")

    if not failures and not warnings:
        takeaway("All pipeline health checks passed. Data is fresh and stable.")
    elif failures:
        takeaway("Pipeline has failures that need immediate attention.")
    else:
        takeaway("Pipeline is functional but has warnings to investigate.")

    print()


# ── Main ───────────────────────────────────────────────────────

def main() -> None:
    print("Pipeline Health Monitor")
    print(f"  Run time: {datetime.now():%Y-%m-%d %H:%M:%S}")

    warnings: list[str] = []
    failures: list[str] = []

    check_freshness(warnings, failures)
    check_completeness(warnings, failures)
    check_labels(warnings, failures)
    check_column_coverage(warnings, failures)
    check_stationarity(warnings, failures)
    print_summary(warnings, failures)

    if warnings or failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
