"""
Data Milestone Tracker — Check progress toward ML pipeline milestones.

Counts labeled data, checks milestone thresholds, estimates arrival dates
for pending milestones, and suggests which scripts to run next.

Usage:
    python3 ml/milestone_check.py

Requires: pip install psycopg2-binary pandas
"""

import sys
from datetime import datetime, timedelta

try:
    import pandas as pd
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas")
    sys.exit(1)

from utils import get_connection, section, subsection, takeaway


# ── Helpers ───────────────────────────────────────────────────

def add_business_days(start: datetime, n: int) -> datetime:
    """Add n business days to a date."""
    current = start
    added = 0
    while added < n:
        current += timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current


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


# ── Data Counting ─────────────────────────────────────────────

def count_data() -> dict:
    """Query database for data volume metrics."""
    conn = get_connection()
    try:
        cur = conn.cursor()

        # Total days in training_features
        cur.execute("SELECT COUNT(*) FROM training_features")
        total_days = cur.fetchone()[0]

        # Date range
        cur.execute(
            "SELECT MIN(date), MAX(date) FROM training_features"
        )
        first_date, last_date = cur.fetchone()

        # Days with labels (structure_correct is not null)
        cur.execute("""
            SELECT COUNT(*)
            FROM training_features f
            JOIN day_labels l ON l.date = f.date
            WHERE l.structure_correct IS NOT NULL
        """)
        labeled_days = cur.fetchone()[0]

        # Days with outcomes (settlement is not null)
        cur.execute("""
            SELECT COUNT(*)
            FROM training_features f
            JOIN outcomes o ON o.date = f.date
            WHERE o.settlement IS NOT NULL
        """)
        outcome_days = cur.fetchone()[0]

        # Days with feature_completeness >= 0.80
        cur.execute("""
            SELECT COUNT(*)
            FROM training_features
            WHERE feature_completeness >= 0.80
        """)
        complete_days = cur.fetchone()[0]

        # Class distribution
        cur.execute("""
            SELECT recommended_structure, COUNT(*)
            FROM day_labels
            WHERE structure_correct IS NOT NULL
            GROUP BY recommended_structure
            ORDER BY COUNT(*) DESC
        """)
        class_dist = cur.fetchall()

        # Recent 10 days avg completeness
        cur.execute("""
            SELECT AVG(feature_completeness)
            FROM (
                SELECT feature_completeness
                FROM training_features
                ORDER BY date DESC
                LIMIT 10
            ) t
        """)
        recent_completeness = cur.fetchone()[0]

    finally:
        conn.close()

    # Parse class counts
    ic_days = 0
    sit_out_days = 0
    class_counts: dict[str, int] = {}
    for structure, count in class_dist:
        name = str(structure) if structure else "NULL"
        class_counts[name] = count
        if "IC" in name.upper() or "IRON CONDOR" in name.upper():
            ic_days += count
        if "SIT" in name.upper() and "OUT" in name.upper():
            sit_out_days += count

    return {
        "total_days": total_days,
        "labeled_days": labeled_days,
        "outcome_days": outcome_days,
        "complete_days": complete_days,
        "first_date": first_date,
        "last_date": last_date,
        "class_counts": class_counts,
        "ic_days": ic_days,
        "sit_out_days": sit_out_days,
        "recent_completeness": recent_completeness,
    }


# ── Milestone Definitions ────────────────────────────────────

MILESTONES = [
    (30, "Clustering + EDA (provisional)"),
    (45, "Phase 2 early experiment"),
    (50, "Re-run clustering (check permutation p)"),
    (60, "Phase 2 minimum viable dataset"),
    (80, "Phase 2 full training"),
    (100, "Phase 4: Intraday Range Regression"),
    (150, "Phase 6: Flow-Price Divergence Detector"),
    (200, "All models mature"),
]

CLASS_MILESTONES = [
    ("ic", 5, "Need for Phase 2 class balance"),
    ("sit_out", 1, "Needed for 4-class model"),
]


# ── Milestone Display ────────────────────────────────────────

def print_milestones(data: dict) -> None:
    section("MILESTONES")

    n = data["labeled_days"]
    today = datetime.now()

    # Find where current position sits
    printed_current = False

    for threshold, label in MILESTONES:
        if n >= threshold:
            print(f"  [\u2713] {threshold} days \u2014 {label}")
        else:
            if not printed_current:
                print(f"  [\u2713] {n} days \u2014 Current position")
                printed_current = True

            days_away = threshold - n
            est_date = add_business_days(today, days_away)
            print(
                f"  [ ] {threshold} days \u2014 {label} "
                f"(~{days_away} days away, est. {est_date:%b %-d})"
            )

    if not printed_current:
        print(f"  [\u2713] {n} days \u2014 Current position")

    # Class-balance milestones
    for key, threshold, label in CLASS_MILESTONES:
        if key == "ic":
            current = data["ic_days"]
            class_name = "IC"
        else:
            current = data["sit_out_days"]
            class_name = "SIT OUT"

        if current >= threshold:
            print(f"  [\u2713] {threshold}+ {class_name} days \u2014 {label}")
        else:
            print(
                f"  [!] {threshold}+ {class_name} days \u2014 {label} "
                f"(currently {current})"
            )


# ── Data Summary ──────────────────────────────────────────────

def print_data_summary(data: dict) -> None:
    section("DATA VOLUME")

    first = data["first_date"]
    last = data["last_date"]
    first_str = f"{first}" if first else "N/A"
    last_str = f"{last}" if last else "N/A"

    print(f"  Date range:             {first_str} to {last_str}")
    print(f"  Total feature days:     {data['total_days']}")
    print(f"  Days with labels:       {data['labeled_days']}")
    print(f"  Days with outcomes:     {data['outcome_days']}")
    print(f"  Days completeness >=80%:{data['complete_days']}")

    subsection("Class Distribution")
    if data["class_counts"]:
        for structure, count in data["class_counts"].items():
            print(f"  {structure:30s} {count:>4}")
    else:
        print("  No labeled data yet")

    print(f"\n  IC days:       {data['ic_days']}")
    print(f"  SIT OUT days:  {data['sit_out_days']}")


# ── Data Quality ──────────────────────────────────────────────

def print_quality(data: dict) -> None:
    section("DATA QUALITY")

    # Recent completeness
    rc = data["recent_completeness"]
    rc_str = f"{rc:.2%}" if rc is not None else "N/A"
    print(f"  Avg completeness (last 10 days): {rc_str}")

    # Label coverage
    total = data["total_days"]
    labeled = data["labeled_days"]
    if total > 0:
        coverage = labeled / total
        print(f"  Label coverage:                  {labeled}/{total} ({coverage:.0%})")
    else:
        print("  Label coverage:                  N/A (no data)")

    # Days since last data
    last = data["last_date"]
    if last:
        if isinstance(last, pd.Timestamp):
            last_dt = last.to_pydatetime().replace(tzinfo=None)
        elif hasattr(last, "timetuple"):
            last_dt = datetime.combine(last, datetime.min.time())
        else:
            last_dt = None

        if last_dt:
            gap = business_days_between(last_dt, datetime.now())
            print(f"  Business days since last data:    {gap}")


# ── Suggested Actions ─────────────────────────────────────────

def print_actions(data: dict) -> None:
    section("SUGGESTED ACTIONS")

    n = data["labeled_days"]
    actions: list[str] = []

    if n >= 30:
        actions.append("Run: make all (EDA + clustering + visualize)")
    if n >= 45:
        actions.append("Run: python3 phase2_early.py (feasibility check)")
    if n >= 50:
        actions.append(
            "Run: python3 clustering.py --plot (check if clusters stabilize)"
        )
    if n >= 60:
        actions.append(
            "Run: python3 phase2_early.py --shap (full Phase 2 training)"
        )
    if n >= 100:
        actions.append("Ready for Phase 4: Intraday Range Regression")

    if not actions:
        print(f"  Keep collecting data. Next milestone at 30 days "
              f"({30 - n} to go).")
    else:
        for action in actions:
            print(f"  - {action}")

    takeaway(
        f"{n} labeled days collected. "
        f"Next milestone: {next_milestone_label(n)}."
    )


def next_milestone_label(n: int) -> str:
    """Return a description of the next pending milestone."""
    for threshold, label in MILESTONES:
        if n < threshold:
            return f"{threshold} days ({label})"
    return "all milestones reached"


# ── Main ──────────────────────────────────────────────────────

def main() -> None:
    print("Data Milestone Tracker")
    print(f"  Run time: {datetime.now():%Y-%m-%d %H:%M:%S}")

    data = count_data()

    print_data_summary(data)
    print_milestones(data)
    print_quality(data)
    print_actions(data)

    print()


if __name__ == "__main__":
    main()
