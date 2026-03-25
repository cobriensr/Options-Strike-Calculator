"""
Phase 1.5: Exploratory Data Analysis

Validates trading rules, calibrates confidence, ranks features, and
identifies patterns in 31 days of structured trading data.

Usage:
    python3 ml/eda.py

Requires: pip install psycopg2-binary pandas scikit-learn scipy
"""

import sys
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    import psycopg2
    from scipy import stats
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas scikit-learn scipy")
    sys.exit(1)


# ── Data Loading ─────────────────────────────────────────────

def load_env() -> dict[str, str]:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    env = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def load_data() -> pd.DataFrame:
    env = load_env()
    conn = psycopg2.connect(env["DATABASE_URL"], sslmode="require")
    try:
        df = pd.read_sql_query("""
            SELECT f.*, o.settlement, o.day_open, o.day_high, o.day_low,
                   o.day_range_pts, o.day_range_pct, o.close_vs_open,
                   o.vix_close, o.vix1d_close,
                   l.recommended_structure, l.structure_correct,
                   l.confidence AS label_confidence,
                   l.charm_diverged, l.naive_charm_signal,
                   l.spx_flow_signal, l.market_tide_signal,
                   l.spy_flow_signal, l.gex_signal,
                   l.range_category, l.settlement_direction,
                   l.flow_was_directional
            FROM training_features f
            LEFT JOIN outcomes o ON o.date = f.date
            LEFT JOIN day_labels l ON l.date = f.date
            ORDER BY f.date ASC
        """, conn, parse_dates=["date"])
    finally:
        conn.close()
    return df.set_index("date").sort_index()


def section(title: str) -> None:
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}\n")


def subsection(title: str) -> None:
    print(f"\n  --- {title} ---\n")


# ── Analysis 1: Rule Validation ──────────────────────────────

def rule_validation(df: pd.DataFrame) -> None:
    section("1. RULE VALIDATION")

    has_range = df["day_range_pts"].notna()
    dr = df.loc[has_range].copy()
    dr["day_range_pts"] = dr["day_range_pts"].astype(float)

    # Rule 16: Negative GEX → wider ranges
    subsection("Rule 16: GEX vs Range")
    if "gex_oi_t1" in dr.columns:
        gex = dr["gex_oi_t1"].dropna().astype(float)
        rng = dr.loc[gex.index, "day_range_pts"]
        r, p = stats.pearsonr(gex, rng)
        print(f"  GEX OI (T1) vs Day Range: r = {r:+.3f}, p = {p:.3f}")

        # Split into positive/negative GEX
        pos_gex = dr[dr["gex_oi_t1"].astype(float) > 0]["day_range_pts"]
        neg_gex = dr[dr["gex_oi_t1"].astype(float) <= 0]["day_range_pts"]
        if len(pos_gex) > 1 and len(neg_gex) > 1:
            print(f"  Positive GEX days ({len(pos_gex)}): {pos_gex.mean():.0f} pts avg range")
            print(f"  Negative GEX days ({len(neg_gex)}): {neg_gex.mean():.0f} pts avg range")
            verdict = "CONFIRMED" if neg_gex.mean() > pos_gex.mean() else "NOT CONFIRMED"
            print(f"  Verdict: {verdict}")
        else:
            print("  Not enough data to split by GEX sign")

    # VIX1D inversion → range-bound
    subsection("VIX1D Inversion vs Range")
    if "vix1d_vix_ratio" in dr.columns:
        ratio = dr["vix1d_vix_ratio"].dropna().astype(float)
        rng = dr.loc[ratio.index, "day_range_pts"]
        r, p = stats.pearsonr(ratio, rng)
        print(f"  VIX1D/VIX ratio vs Day Range: r = {r:+.3f}, p = {p:.3f}")

        inverted = dr[dr["vix1d_vix_ratio"].astype(float) < 0.80]["day_range_pts"]
        normal = dr[dr["vix1d_vix_ratio"].astype(float) >= 0.80]["day_range_pts"]
        if len(inverted) > 1 and len(normal) > 1:
            print(f"  Inverted days (ratio < 0.80, n={len(inverted)}): {inverted.mean():.0f} pts avg range")
            print(f"  Normal days (ratio >= 0.80, n={len(normal)}): {normal.mean():.0f} pts avg range")
            verdict = "CONFIRMED" if inverted.mean() < normal.mean() else "NOT CONFIRMED"
            print(f"  Verdict: {verdict} (inverted = tighter range)")

    # Charm pattern → range
    subsection("Charm Pattern vs Range")
    if "charm_pattern" in dr.columns:
        for pattern in dr["charm_pattern"].dropna().unique():
            subset = dr[dr["charm_pattern"] == pattern]["day_range_pts"]
            if len(subset) > 0:
                print(f"  {pattern:20s} n={len(subset):2d}  avg={subset.mean():.0f} pts  "
                      f"median={subset.median():.0f} pts")

    # Flow agreement → directionality
    subsection("Flow Agreement vs Settlement Direction")
    if "flow_agreement_t1" in dr.columns and "settlement_direction" in dr.columns:
        for direction in ["UP", "DOWN"]:
            subset = dr[dr["settlement_direction"] == direction]["flow_agreement_t1"].dropna().astype(float)
            if len(subset) > 0:
                print(f"  {direction} days (n={len(subset)}): agreement = {subset.mean():.1f} avg")

        # Does high agreement predict direction?
        high_agree = dr[dr["flow_agreement_t1"].astype(float) >= 4]
        low_agree = dr[dr["flow_agreement_t1"].astype(float) < 4]
        if len(high_agree) > 0:
            ha_correct = (high_agree["flow_was_directional"] == True).sum()
            print(f"  High agreement (>=4, n={len(high_agree)}): flow predicted direction {ha_correct}/{len(high_agree)} times")
        if len(low_agree) > 0:
            la_correct = (low_agree["flow_was_directional"] == True).sum()
            print(f"  Low agreement (<4, n={len(low_agree)}): flow predicted direction {la_correct}/{len(low_agree)} times")

    # Friday effect
    subsection("Day of Week vs Range")
    if "day_of_week" in dr.columns:
        day_names = {0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat"}
        for dow in sorted(dr["day_of_week"].dropna().astype(int).unique()):
            subset = dr[dr["day_of_week"].astype(int) == dow]["day_range_pts"]
            if len(subset) > 0:
                name = day_names.get(dow, str(dow))
                print(f"  {name:3s} (n={len(subset):2d}): {subset.mean():.0f} pts avg, "
                      f"{subset.median():.0f} median")


# ── Analysis 2: Confidence Calibration ───────────────────────

def confidence_calibration(df: pd.DataFrame) -> None:
    section("2. CONFIDENCE CALIBRATION")

    labeled = df[df["structure_correct"].notna()].copy()
    if "label_confidence" not in labeled.columns or labeled["label_confidence"].isna().all():
        print("  No confidence data available")
        return

    for conf in labeled["label_confidence"].dropna().unique():
        subset = labeled[labeled["label_confidence"] == conf]
        correct = subset["structure_correct"].sum()
        total = len(subset)
        pct = correct / total if total > 0 else 0

        # Range stats for this confidence level
        rng = subset["day_range_pts"].dropna().astype(float)
        range_str = f"range {rng.mean():.0f} pts avg" if len(rng) > 0 else "no range data"

        print(f"  {conf:12s}  {correct}/{total} correct ({pct:.0%})  {range_str}")

    # Is confidence predictive?
    if len(labeled["label_confidence"].dropna().unique()) > 1:
        print()
        overall = labeled["structure_correct"].sum() / len(labeled)
        print(f"  Overall accuracy: {labeled['structure_correct'].sum()}/{len(labeled)} ({overall:.0%})")
        print(f"  If confidence doesn't differentiate accuracy, it's not adding signal for sizing.")


# ── Analysis 3: Structure Outcome Analysis ───────────────────

def structure_analysis(df: pd.DataFrame) -> None:
    section("3. STRUCTURE OUTCOME ANALYSIS")

    labeled = df[df["recommended_structure"].notna()].copy()

    subsection("Accuracy by Structure")
    for struct in labeled["recommended_structure"].dropna().unique():
        subset = labeled[labeled["recommended_structure"] == struct]
        has_correct = subset[subset["structure_correct"].notna()]
        if len(has_correct) > 0:
            correct = has_correct["structure_correct"].sum()
            total = len(has_correct)
            rng = subset["day_range_pts"].dropna().astype(float)
            range_str = f"avg range {rng.mean():.0f} pts" if len(rng) > 0 else ""
            print(f"  {struct:25s}  {correct}/{total} correct ({correct/total:.0%})  {range_str}")

    # What conditions produced failures?
    subsection("Failure Analysis")
    failures = labeled[labeled["structure_correct"] == False]
    if len(failures) == 0:
        print("  No failures to analyze")
        return

    for _, row in failures.iterrows():
        date = row.name
        print(f"\n  {date:%Y-%m-%d}:")
        if pd.notna(row.get("recommended_structure")):
            print(f"    Structure: {row['recommended_structure']}")
        if pd.notna(row.get("vix")):
            print(f"    VIX: {float(row['vix']):.1f}")
        if pd.notna(row.get("vix1d_vix_ratio")):
            print(f"    VIX1D/VIX: {float(row['vix1d_vix_ratio']):.2f}")
        if pd.notna(row.get("gex_oi_t1")):
            print(f"    GEX OI (T1): {float(row['gex_oi_t1'])/1e9:.1f}B")
        if pd.notna(row.get("charm_pattern")):
            print(f"    Charm: {row['charm_pattern']}")
        if pd.notna(row.get("flow_agreement_t1")):
            print(f"    Flow Agreement: {float(row['flow_agreement_t1']):.0f}")
        if pd.notna(row.get("day_range_pts")):
            print(f"    Day Range: {float(row['day_range_pts']):.0f} pts")
        if pd.notna(row.get("range_category")):
            print(f"    Range Category: {row['range_category']}")

    # Majority class baseline
    subsection("Phase 2 Baseline")
    majority = labeled["recommended_structure"].value_counts().iloc[0]
    majority_class = labeled["recommended_structure"].value_counts().index[0]
    total = len(labeled[labeled["structure_correct"].notna()])
    print(f"  Majority class: always predict '{majority_class}' = {majority}/{total} ({majority/total:.0%})")
    print(f"  Phase 2 must beat this baseline with walk-forward validation.")


# ── Analysis 4: Feature Importance ───────────────────────────

def feature_importance(df: pd.DataFrame) -> None:
    section("4. FEATURE IMPORTANCE (PRE-ML)")

    # Features vs structure_correct (point-biserial correlation)
    subsection("Features Correlated with Structure Correctness")
    labeled = df[df["structure_correct"].notna()].copy()
    target = labeled["structure_correct"].astype(float)

    numeric_cols = labeled.select_dtypes(include=[np.number]).columns
    # Exclude metadata/outcome columns
    exclude = {"feature_completeness", "day_range_pts", "day_range_pct",
               "settlement", "day_open", "day_high", "day_low", "close_vs_open",
               "vix_close", "vix1d_close", "structure_correct", "label_completeness",
               "day_of_week", "is_friday", "is_event_day"}
    feature_cols = [c for c in numeric_cols if c not in exclude]

    correlations = []
    for col in feature_cols:
        vals = labeled[col].dropna().astype(float)
        if len(vals) < 10:
            continue
        common = target.loc[vals.index]
        if common.std() == 0 or vals.std() == 0:
            continue
        r, p = stats.pointbiserialr(common, vals)
        correlations.append((col, r, p, len(vals)))

    correlations.sort(key=lambda x: abs(x[1]), reverse=True)

    print(f"  {'Feature':40s} {'r':>8s} {'p':>8s} {'n':>5s}")
    print(f"  {'-'*40} {'-'*8} {'-'*8} {'-'*5}")
    for col, r, p, n in correlations[:15]:
        sig = "*" if p < 0.10 else " "
        print(f"  {col:40s} {r:+8.3f} {p:8.3f} {n:5d} {sig}")

    if correlations:
        print(f"\n  (* = p < 0.10, suggestive but not conclusive with n={len(labeled)})")

    # Features vs range category (ANOVA)
    subsection("Features Predicting Range Category")
    has_range = df[df["range_category"].notna()].copy()
    if len(has_range) < 10:
        print("  Not enough range data")
        return

    categories = has_range["range_category"].unique()
    f_scores = []

    for col in feature_cols:
        groups = []
        for cat in categories:
            vals = has_range[has_range["range_category"] == cat][col].dropna().astype(float)
            if len(vals) >= 2:
                groups.append(vals.values)
        if len(groups) >= 2:
            f_stat, p = stats.f_oneway(*groups)
            if not np.isnan(f_stat):
                f_scores.append((col, f_stat, p))

    f_scores.sort(key=lambda x: x[1], reverse=True)

    print(f"  {'Feature':40s} {'F':>8s} {'p':>8s}")
    print(f"  {'-'*40} {'-'*8} {'-'*8}")
    for col, f_stat, p in f_scores[:15]:
        sig = "**" if p < 0.05 else "*" if p < 0.10 else " "
        print(f"  {col:40s} {f_stat:8.2f} {p:8.3f} {sig}")

    if f_scores:
        print(f"\n  (** = p < 0.05, * = p < 0.10)")


# ── Analysis 5: Charm Pattern Deep Dive ──────────────────────

def charm_analysis(df: pd.DataFrame) -> None:
    section("5. CHARM PATTERN DEEP DIVE")

    has_charm = df[df["charm_pattern"].notna()].copy()
    if len(has_charm) < 5:
        print("  Not enough charm data")
        return

    subsection("Charm Pattern vs Outcomes")
    for pattern in sorted(has_charm["charm_pattern"].unique()):
        subset = has_charm[has_charm["charm_pattern"] == pattern]
        n = len(subset)

        rng = subset["day_range_pts"].dropna().astype(float)
        correct = subset[subset["structure_correct"].notna()]
        accuracy = correct["structure_correct"].sum() / len(correct) if len(correct) > 0 else float("nan")

        structs = subset["recommended_structure"].value_counts()
        top_struct = f"{structs.index[0]} ({structs.iloc[0]})" if len(structs) > 0 else "N/A"

        settlement = subset["settlement_direction"].value_counts()
        direction = f"UP={settlement.get('UP', 0)}/DOWN={settlement.get('DOWN', 0)}"

        range_str = f"{rng.mean():.0f} pts avg" if len(rng) > 0 else "no data"

        print(f"  {pattern:20s}  n={n:2d}  range={range_str:15s}  "
              f"accuracy={accuracy:.0%}  {direction}  top={top_struct}")

    # Charm + GEX interaction
    subsection("Charm x GEX Interaction")
    if "gex_oi_t1" in has_charm.columns:
        has_both = has_charm[has_charm["gex_oi_t1"].notna()].copy()
        has_both["neg_gex"] = has_both["gex_oi_t1"].astype(float) < 0
        has_both["drp"] = has_both["day_range_pts"].astype(float)

        for charm in sorted(has_both["charm_pattern"].unique()):
            for gex_label, gex_val in [("Neg GEX", True), ("Pos GEX", False)]:
                subset = has_both[(has_both["charm_pattern"] == charm) & (has_both["neg_gex"] == gex_val)]
                if len(subset) >= 2:
                    rng = subset["drp"]
                    print(f"  {charm:20s} + {gex_label:7s}  n={len(subset):2d}  "
                          f"range={rng.mean():.0f} pts avg")


# ── Analysis 6: Flow Agreement ───────────────────────────────

def flow_analysis(df: pd.DataFrame) -> None:
    section("6. FLOW AGREEMENT ANALYSIS")

    has_flow = df[df["flow_agreement_t1"].notna()].copy()
    has_flow["fa1"] = has_flow["flow_agreement_t1"].astype(float)

    subsection("Agreement Level vs Range")
    for threshold in [2, 3, 4, 5, 6]:
        above = has_flow[has_flow["fa1"] >= threshold]["day_range_pts"].dropna().astype(float)
        below = has_flow[has_flow["fa1"] < threshold]["day_range_pts"].dropna().astype(float)
        if len(above) >= 2 and len(below) >= 2:
            print(f"  Agreement >= {threshold}: {above.mean():.0f} pts avg (n={len(above)}), "
                  f"< {threshold}: {below.mean():.0f} pts avg (n={len(below)})")

    # T1 → T2 evolution
    subsection("Agreement Evolution (T1 to T2)")
    if "flow_agreement_t2" in has_flow.columns:
        has_both = has_flow[has_flow["flow_agreement_t2"].notna()].copy()
        has_both["fa2"] = has_both["flow_agreement_t2"].astype(float)
        has_both["delta_fa"] = has_both["fa2"] - has_both["fa1"]
        has_both["drp"] = has_both["day_range_pts"].astype(float)

        increasing = has_both[has_both["delta_fa"] > 0]
        decreasing = has_both[has_both["delta_fa"] < 0]
        stable = has_both[has_both["delta_fa"] == 0]

        for label, subset in [("Increasing", increasing), ("Decreasing", decreasing), ("Stable", stable)]:
            if len(subset) > 0:
                rng = subset["drp"].dropna()
                range_str = f"{rng.mean():.0f} pts avg" if len(rng) > 0 else "no data"
                print(f"  {label:12s} agreement (n={len(subset)}): range = {range_str}")

    # Per-source flow direction at T1 vs settlement
    subsection("Individual Source Direction vs Settlement")
    sources = [
        ("mt_ncp_t1", "Market Tide"),
        ("spx_ncp_t1", "SPX Net Flow"),
        ("spy_ncp_t1", "SPY Net Flow"),
        ("qqq_ncp_t1", "QQQ Net Flow"),
        ("spy_etf_ncp_t1", "SPY ETF Tide"),
        ("qqq_etf_ncp_t1", "QQQ ETF Tide"),
        ("zero_dte_ncp_t1", "0DTE Index"),
    ]

    for col, label in sources:
        if col not in has_flow.columns:
            continue
        has_both = has_flow[[col, "settlement_direction"]].dropna()
        if len(has_both) < 5:
            continue

        ncp = has_both[col].astype(float)
        direction = has_both["settlement_direction"]

        # Did NCP direction match settlement direction?
        predicted_up = ncp > 0
        actual_up = direction == "UP"
        correct = (predicted_up == actual_up).sum()
        total = len(has_both)

        print(f"  {label:20s}  {correct}/{total} correct ({correct/total:.0%})")


# ── Main ─────────────────────────────────────────────────────

def main() -> None:
    print("Loading data ...")
    df = load_data()
    print(f"  {len(df)} days loaded ({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})")
    print(f"  {df['structure_correct'].notna().sum()} days with labels")
    print(f"  {df['day_range_pts'].notna().sum()} days with outcomes")

    rule_validation(df)
    confidence_calibration(df)
    structure_analysis(df)
    feature_importance(df)
    charm_analysis(df)
    flow_analysis(df)

    section("NEXT STEPS")
    print("  1. Deploy source name fix and re-backfill to get etf_tide_divergence + ncp_npp_gap_spx")
    print("  2. Re-run this analysis after backfill")
    print("  3. Continue accumulating daily data toward Phase 2 (need 60-80 labeled days)")
    print("  4. Re-run clustering at 50 days (ml/clustering.py)")
    print()


if __name__ == "__main__":
    main()
