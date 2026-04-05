"""
Phase 1.5: Exploratory Data Analysis

Validates trading rules, calibrates confidence, ranks features, and
identifies patterns in structured trading data.

Usage:
    python3 ml/eda.py

Requires: pip install psycopg2-binary pandas scipy statsmodels
"""

import sys
import warnings

try:
    import numpy as np
    import pandas as pd
    from scipy import stats
    from statsmodels.stats.multitest import multipletests
    from statsmodels.stats.proportion import proportion_confint
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install psycopg2-binary pandas scipy statsmodels")
    sys.exit(1)

from utils import (
    DARK_POOL_FEATURES,
    IV_PCR_FEATURES,
    OPTIONS_VOLUME_FEATURES,
    load_data,
    save_section_findings,
    section,
    subsection,
    takeaway,
    validate_dataframe,
    verdict,
)

# ── Data Loading ─────────────────────────────────────────────


def load_data_eda() -> pd.DataFrame:
    return load_data("""
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
    """)


# ── Analysis 1: Rule Validation ──────────────────────────────


def rule_validation(df: pd.DataFrame) -> None:
    section("1. RULE VALIDATION")
    print("  Testing whether your 16 rules hold against actual outcomes.\n")

    has_range = df["day_range_pts"].notna()
    dr = df.loc[has_range].copy()
    dr["day_range_pts"] = dr["day_range_pts"].astype(float)

    # Rule 16: Negative GEX → wider ranges
    subsection("Rule 16: Negative GEX should produce wider ranges")
    if "gex_oi_t1" in dr.columns:
        pos_gex = dr[dr["gex_oi_t1"].astype(float) > 0]["day_range_pts"]
        neg_gex = dr[dr["gex_oi_t1"].astype(float) <= 0]["day_range_pts"]
        if len(pos_gex) > 1 and len(neg_gex) > 1:
            print(
                f"  Positive GEX days (n={len(pos_gex)}):  {pos_gex.mean():.0f} pts avg range"
            )
            print(
                f"  Negative GEX days (n={len(neg_gex)}):  {neg_gex.mean():.0f} pts avg range"
            )
            diff = neg_gex.mean() - pos_gex.mean()
            # Compute Cohen's d effect size
            pooled_std = np.sqrt(
                (
                    (len(pos_gex) - 1) * pos_gex.std() ** 2
                    + (len(neg_gex) - 1) * neg_gex.std() ** 2
                )
                / (len(pos_gex) + len(neg_gex) - 2)
            )
            cohens_d = (
                (neg_gex.mean() - pos_gex.mean()) / pooled_std if pooled_std > 0 else 0
            )
            print(
                f"  Effect size: Cohen's d = {cohens_d:.2f} ({'large' if abs(cohens_d) >= 0.8 else 'medium' if abs(cohens_d) >= 0.5 else 'small'})"
            )
            confirmed = neg_gex.mean() > pos_gex.mean()
            print(
                verdict(
                    confirmed,
                    f"only {len(pos_gex)} positive GEX days in sample"
                    if len(pos_gex) < 5
                    else f"negative GEX adds {diff:+.0f} pts to avg range",
                )
            )
        else:
            print("  Not enough data to split by GEX sign")

    # VIX1D inversion → range-bound
    subsection("VIX1D Inversion: VIX1D << VIX should mean tighter range")
    if "vix1d_vix_ratio" in dr.columns:
        inverted = dr[dr["vix1d_vix_ratio"].astype(float) < 0.80]["day_range_pts"]
        normal = dr[dr["vix1d_vix_ratio"].astype(float) >= 0.80]["day_range_pts"]
        if len(inverted) > 1 and len(normal) > 1:
            print(
                f"  Inverted days  (VIX1D/VIX < 0.80, n={len(inverted)}):  {inverted.mean():.0f} pts avg"
            )
            print(
                f"  Normal days    (VIX1D/VIX >= 0.80, n={len(normal)}):  {normal.mean():.0f} pts avg"
            )
            confirmed = inverted.mean() < normal.mean()
            if confirmed:
                print(
                    verdict(
                        True,
                        f"inverted days are {normal.mean() - inverted.mean():.0f} pts tighter",
                    )
                )
            else:
                print(
                    verdict(
                        False,
                        f"inverted days are actually {inverted.mean() - normal.mean():.0f} pts WIDER",
                    )
                )

    # Charm pattern → range
    subsection("All-Negative Charm: Should produce larger ranges (trending days)")
    if "charm_pattern" in dr.columns:
        patterns = {}
        for pattern in sorted(dr["charm_pattern"].dropna().unique()):
            subset = dr[dr["charm_pattern"] == pattern]["day_range_pts"]
            if len(subset) > 0:
                patterns[pattern] = (len(subset), subset.mean(), subset.median())
                print(
                    f"  {pattern:20s}  n={len(subset):2d}   avg={subset.mean():.0f} pts   median={subset.median():.0f} pts"
                )

        if "all_negative" in patterns and len(patterns) > 1:
            neg_avg = patterns["all_negative"][1]
            other_avgs = [v[1] for k, v in patterns.items() if k != "all_negative"]
            overall_other = np.mean(other_avgs)
            confirmed = neg_avg > overall_other
            if confirmed:
                print(
                    verdict(
                        True,
                        f"all-negative averages {neg_avg:.0f} pts vs {overall_other:.0f} pts for others",
                    )
                )
            else:
                print(
                    verdict(
                        False,
                        f"all-negative is actually the NARROWEST at {neg_avg:.0f} pts",
                    )
                )
                takeaway(
                    "This contradicts the rule. All-negative charm (naive) may be\n"
                    "            unreliable -- Periscope Charm often contradicts it. With only\n"
                    f"            {patterns['all_negative'][0]} samples, monitor as data grows."
                )

    # Flow agreement → directionality
    subsection("Flow Agreement: High agreement should predict direction")
    if "flow_agreement_t1" in dr.columns and "settlement_direction" in dr.columns:
        high_agree = dr[dr["flow_agreement_t1"].astype(float) >= 4]
        low_agree = dr[dr["flow_agreement_t1"].astype(float) < 4]

        if len(high_agree) > 0:
            ha_correct = (high_agree["flow_was_directional"] == True).sum()
            ha_pct = ha_correct / len(high_agree)
            print(
                f"  High agreement (>=4 sources, n={len(high_agree)}):  "
                f"predicted direction {ha_correct}/{len(high_agree)} ({ha_pct:.0%})"
            )
        if len(low_agree) > 0:
            la_correct = (low_agree["flow_was_directional"] == True).sum()
            la_pct = la_correct / len(low_agree)
            print(
                f"  Low agreement  (<4 sources, n={len(low_agree)}):  "
                f"predicted direction {la_correct}/{len(low_agree)} ({la_pct:.0%})"
            )

        if len(high_agree) > 0 and len(low_agree) > 0:
            confirmed = ha_pct > la_pct
            print(
                verdict(
                    confirmed,
                    f"high agreement is {ha_pct - la_pct:+.0%} more accurate"
                    if confirmed
                    else "no meaningful difference",
                )
            )

    # Day of week
    subsection("Day of Week Effect")
    if "day_of_week" in dr.columns:
        day_names = {
            0: "Sun",
            1: "Mon",
            2: "Tue",
            3: "Wed",
            4: "Thu",
            5: "Fri",
            6: "Sat",
        }
        dow_data = []
        for dow in sorted(dr["day_of_week"].dropna().astype(int).unique()):
            subset = dr[dr["day_of_week"].astype(int) == dow]["day_range_pts"]
            if len(subset) > 0:
                name = day_names.get(dow, str(dow))
                dow_data.append((name, len(subset), subset.mean(), subset.median()))
                print(
                    f"  {name}  (n={len(subset):2d}):  {subset.mean():.0f} pts avg,  {subset.median():.0f} median"
                )

        if dow_data:
            widest = max(dow_data, key=lambda x: x[2])
            narrowest = min(dow_data, key=lambda x: x[2])
            takeaway(
                f"{widest[0]} has the widest ranges ({widest[2]:.0f} pts), "
                f"{narrowest[0]} the narrowest ({narrowest[2]:.0f} pts).\n"
                f"            Consider sizing down on {widest[0]}s or widening strikes."
            )


# ── Analysis 2: Confidence Calibration ───────────────────────


def confidence_calibration(df: pd.DataFrame) -> None:
    section("2. CONFIDENCE CALIBRATION")
    print("  Is Claude's confidence level actually predictive of accuracy?\n")

    labeled = df[df["structure_correct"].notna()].copy()
    if (
        "label_confidence" not in labeled.columns
        or labeled["label_confidence"].isna().all()
    ):
        print("  No confidence data available")
        return

    conf_data = []
    for conf in ["HIGH", "MODERATE", "LOW"]:
        subset = labeled[labeled["label_confidence"] == conf]
        if len(subset) == 0:
            continue
        correct = subset["structure_correct"].sum()
        total = len(subset)
        pct = correct / total

        rng = subset["day_range_pts"].dropna().astype(float)
        range_str = f"{rng.mean():.0f} pts avg range" if len(rng) > 0 else ""

        conf_data.append((conf, correct, total, pct))
        print(f"  {conf:12s}  {correct}/{total} correct ({pct:.0%})    {range_str}")

    if len(conf_data) >= 2:
        high = [c for c in conf_data if c[0] == "HIGH"]
        mod = [c for c in conf_data if c[0] == "MODERATE"]
        if high and mod:
            h_pct, m_pct = high[0][3], mod[0][3]
            gap = h_pct - m_pct
            if gap > 0.05:
                takeaway(
                    f"Confidence IS calibrated. HIGH is {gap:.0%} more accurate than MODERATE.\n"
                    "            Use confidence for position sizing -- larger on HIGH, smaller on MODERATE."
                )
            else:
                takeaway(
                    "Confidence is NOT well-calibrated. HIGH and MODERATE perform similarly.\n"
                    "            Don't use confidence level for sizing decisions."
                )


# ── Analysis 3: Structure Outcome Analysis ───────────────────


def structure_analysis(df: pd.DataFrame) -> None:
    section("3. STRUCTURE OUTCOMES")
    print("  Which structures work, which fail, and why?\n")

    labeled = df[df["recommended_structure"].notna()].copy()

    subsection("Accuracy by Structure")
    struct_data = []
    for struct in ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]:
        subset = labeled[labeled["recommended_structure"] == struct]
        has_correct = subset[subset["structure_correct"].notna()]
        if len(has_correct) == 0:
            continue
        correct = has_correct["structure_correct"].sum()
        total = len(has_correct)
        rng = subset["day_range_pts"].dropna().astype(float)
        range_avg = rng.mean() if len(rng) > 0 else 0
        struct_data.append((struct, correct, total, range_avg))
        lo, hi = proportion_confint(correct, total, method="wilson")
        print(
            f"  {struct:25s}  {correct}/{total} ({correct / total:.0%})  CI [{lo:.0%}-{hi:.0%}]   avg range {range_avg:.0f} pts"
        )

    if struct_data:
        best = max(struct_data, key=lambda x: x[1] / x[2])
        worst = min(struct_data, key=lambda x: x[1] / x[2])
        takeaway(
            f"{best[0]} is the most reliable ({best[1]}/{best[2]}).\n"
            f"            {worst[0]} has the lowest accuracy ({worst[1]}/{worst[2]}) -- "
            f"scrutinize these setups more carefully."
        )

    # Failure analysis
    failures = labeled[labeled["structure_correct"] == False]
    if len(failures) > 0:
        subsection("What went wrong on failure days?")

        for _, row in failures.iterrows():
            date = row.name
            struct = row.get("recommended_structure", "?")
            vix_str = f"VIX {float(row['vix']):.1f}" if pd.notna(row.get("vix")) else ""
            gex_str = (
                f"GEX {float(row['gex_oi_t1']) / 1e9:.0f}B"
                if pd.notna(row.get("gex_oi_t1"))
                else ""
            )
            charm_str = (
                row.get("charm_pattern", "")
                if pd.notna(row.get("charm_pattern"))
                else ""
            )
            range_str = (
                f"{float(row['day_range_pts']):.0f} pts"
                if pd.notna(row.get("day_range_pts"))
                else ""
            )
            cat_str = (
                row.get("range_category", "")
                if pd.notna(row.get("range_category"))
                else ""
            )
            print(
                f"  {date:%Y-%m-%d}  {struct:25s}  {vix_str:10s}  {gex_str:10s}  "
                f"{charm_str:15s}  {range_str:8s}  {cat_str}"
            )

        # Look for common patterns in failures
        if len(failures) >= 2:
            print()
            fail_gex = failures["gex_oi_t1"].dropna().astype(float)
            if len(fail_gex) > 0 and (fail_gex < 0).all():
                print("  PATTERN: All failures had negative GEX.")
            fail_charm = failures["charm_pattern"].dropna()
            common_charm = fail_charm.value_counts()
            if len(common_charm) > 0 and common_charm.iloc[0] >= 2:
                print(
                    f"  PATTERN: {common_charm.iloc[0]}/{len(failures)} failures had "
                    f"charm_pattern = '{common_charm.index[0]}'"
                )
            fail_range = failures["range_category"].dropna()
            if (fail_range == "WIDE").all() or (fail_range == "EXTREME").all():
                print(f"  PATTERN: All failures were {fail_range.iloc[0]} range days.")

    # Baseline
    subsection("Phase 2 Baseline")
    majority = labeled["recommended_structure"].value_counts()
    total_labeled = len(labeled[labeled["structure_correct"].notna()])
    print(
        f"  Always predicting '{majority.index[0]}' would be correct "
        f"{majority.iloc[0]}/{total_labeled} ({majority.iloc[0] / total_labeled:.0%})"
    )
    print("  Any ML model must beat this with walk-forward validation to be useful.")


# ── Analysis 4: Feature Importance ───────────────────────────


def feature_importance(df: pd.DataFrame) -> None:
    section("4. FEATURE IMPORTANCE")
    print("  Which features best predict structure correctness and range?\n")

    labeled = df[df["structure_correct"].notna()].copy()
    target = labeled["structure_correct"].astype(float)

    numeric_cols = labeled.select_dtypes(include=[np.number]).columns
    exclude = {
        "feature_completeness",
        "day_range_pts",
        "day_range_pct",
        "settlement",
        "day_open",
        "day_high",
        "day_low",
        "close_vs_open",
        "vix_close",
        "vix1d_close",
        "structure_correct",
        "label_completeness",
        "day_of_week",
        "is_friday",
        "is_event_day",
    }
    feature_cols = [c for c in numeric_cols if c not in exclude]

    # Structure correctness correlation
    subsection("Top predictors of whether the structure call was CORRECT")
    correlations = []
    for col in feature_cols:
        vals = labeled[col].dropna().astype(float)
        if len(vals) < 10:
            continue
        common = target.loc[vals.index]
        if common.std() == 0 or vals.std() == 0:
            continue
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="An input array is constant",
                category=stats.ConstantInputWarning,
            )
            r, p = stats.pointbiserialr(common, vals)
        correlations.append((col, r, p, len(vals)))

    correlations.sort(key=lambda x: abs(x[1]), reverse=True)

    # Apply Benjamini-Hochberg FDR correction
    # Filter out NaN p-values (from constant-input columns) before correction,
    # then map corrected q-values back; NaN p-values get NaN q-values.
    if len(correlations) > 1:
        raw_pvals = np.array([c[2] for c in correlations])
        valid_mask = ~np.isnan(raw_pvals)
        pvals_adj = np.full(len(raw_pvals), np.nan)
        if valid_mask.sum() > 1:
            _, pvals_adj[valid_mask], _, _ = multipletests(
                raw_pvals[valid_mask], method="fdr_bh"
            )
        elif valid_mask.sum() == 1:
            pvals_adj[valid_mask] = raw_pvals[valid_mask]
        correlations = [
            (col, r, p_raw, n, p_adj)
            for (col, r, p_raw, n), p_adj in zip(correlations, pvals_adj)
        ]

    for item in correlations[:10]:
        col, r, p_raw = item[0], item[1], item[2]
        p_adj = item[4] if len(item) > 4 else p_raw
        sig = " **" if p_adj < 0.05 else " *" if p_adj < 0.10 else ""
        direction = "higher = MORE correct" if r > 0 else "higher = LESS correct"
        print(
            f"  {col:35s}  r={r:+.3f}  p={p_raw:.3f}  q={p_adj:.3f}  ({direction}){sig}"
        )

    sig_features = [c[0] for c in correlations if (c[4] if len(c) > 4 else c[2]) < 0.10]
    if sig_features:
        takeaway(
            f"Pay attention to: {', '.join(sig_features[:5])}.\n"
            "            These had statistically suggestive correlations with getting the structure right."
        )

    # Range prediction
    subsection("Top predictors of RANGE CATEGORY (narrow vs wide vs extreme)")
    has_range = df[df["range_category"].notna()].copy()
    if len(has_range) < 10:
        print("  Not enough range data")
        return

    categories = has_range["range_category"].unique()
    f_scores = []

    for col in feature_cols:
        groups = []
        for cat in categories:
            vals = (
                has_range[has_range["range_category"] == cat][col]
                .dropna()
                .astype(float)
            )
            if len(vals) >= 2:
                groups.append(vals.values)
        if len(groups) >= 2:
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore", message="invalid value", category=RuntimeWarning
                )
                h_stat, p = stats.kruskal(*groups)
            if not np.isnan(h_stat):
                f_scores.append((col, h_stat, p))

    f_scores.sort(key=lambda x: x[1], reverse=True)

    if len(f_scores) > 1:
        raw_pvals = np.array([s[2] for s in f_scores])
        valid_mask = ~np.isnan(raw_pvals)
        pvals_adj = np.full(len(raw_pvals), np.nan)
        if valid_mask.sum() > 1:
            _, pvals_adj[valid_mask], _, _ = multipletests(
                raw_pvals[valid_mask], method="fdr_bh"
            )
        elif valid_mask.sum() == 1:
            pvals_adj[valid_mask] = raw_pvals[valid_mask]
        f_scores = [
            (col, h, p_raw, p_adj)
            for (col, h, p_raw), p_adj in zip(f_scores, pvals_adj)
        ]

    for item in f_scores[:10]:
        col, h_stat, p_raw = item[0], item[1], item[2]
        p_adj = item[3] if len(item) > 3 else p_raw
        sig = " **" if p_adj < 0.05 else " *" if p_adj < 0.10 else ""
        print(f"  {col:35s}  H={h_stat:6.2f}  p={p_raw:.3f}  q={p_adj:.3f}{sig}")

    strong = [c[0] for c in f_scores if (c[3] if len(c) > 3 else c[2]) < 0.05]
    if strong:
        takeaway(
            f"Strongest range predictors: {', '.join(strong[:4])}.\n"
            "            These features meaningfully separate NORMAL/WIDE/EXTREME days.\n"
            "            Use these to gauge expected range before entering."
        )


# ── Analysis 5: Charm Pattern Deep Dive ──────────────────────


def charm_analysis(df: pd.DataFrame) -> None:
    section("5. CHARM PATTERN DEEP DIVE")
    print("  How does naive charm pattern relate to outcomes?\n")

    has_charm = df[df["charm_pattern"].notna()].copy()
    if len(has_charm) < 5:
        print("  Not enough charm data")
        return

    for pattern in sorted(has_charm["charm_pattern"].unique()):
        subset = has_charm[has_charm["charm_pattern"] == pattern]
        n = len(subset)

        rng = subset["day_range_pts"].dropna().astype(float)
        correct = subset[subset["structure_correct"].notna()]
        accuracy = (
            correct["structure_correct"].sum() / len(correct)
            if len(correct) > 0
            else float("nan")
        )

        structs = subset["recommended_structure"].value_counts()
        top_struct = structs.index[0] if len(structs) > 0 else "N/A"

        settlement = subset["settlement_direction"].value_counts()
        up = settlement.get("UP", 0)
        down = settlement.get("DOWN", 0)
        bias = "bullish" if up > down else "bearish" if down > up else "neutral"

        range_str = f"{rng.mean():.0f} pts" if len(rng) > 0 else "?"

        print(
            f"  {pattern:20s}  n={n:2d}   range {range_str:>7s}   "
            f"accuracy {accuracy:.0%}   {bias:8s} ({up}U/{down}D)   -> {top_struct}"
        )

    # Actionable charm insights
    if (
        "all_negative" in has_charm["charm_pattern"].values
        and "all_positive" in has_charm["charm_pattern"].values
    ):
        neg_range = (
            has_charm[has_charm["charm_pattern"] == "all_negative"]["day_range_pts"]
            .dropna()
            .astype(float)
            .mean()
        )
        pos_range = (
            has_charm[has_charm["charm_pattern"] == "all_positive"]["day_range_pts"]
            .dropna()
            .astype(float)
            .mean()
        )
        neg_n = (has_charm["charm_pattern"] == "all_negative").sum()

        if neg_range < pos_range:
            takeaway(
                f"SURPRISING: All-negative charm days are NARROWER ({neg_range:.0f} pts)\n"
                f"            than all-positive ({pos_range:.0f} pts). This contradicts the\n"
                f"            'all-negative = trending day' rule. Possible explanation:\n"
                f"            naive charm is often wrong (Periscope contradicts it).\n"
                f"            Sample size is small (n={neg_n}), so keep watching."
            )
        else:
            takeaway(
                f"All-negative charm days ARE wider ({neg_range:.0f} pts vs {pos_range:.0f} pts).\n"
                "            The trending day rule holds in the data."
            )

    # Charm x GEX interaction
    subsection("Charm + GEX Interaction (which combos produce the widest ranges?)")
    if "gex_oi_t1" in has_charm.columns:
        has_both = has_charm[has_charm["gex_oi_t1"].notna()].copy()
        has_both["neg_gex"] = has_both["gex_oi_t1"].astype(float) < 0
        has_both["drp"] = has_both["day_range_pts"].astype(float)

        combos = []
        for charm in sorted(has_both["charm_pattern"].unique()):
            for gex_label, gex_val in [("neg GEX", True), ("pos GEX", False)]:
                subset = has_both[
                    (has_both["charm_pattern"] == charm)
                    & (has_both["neg_gex"] == gex_val)
                ]
                if len(subset) >= 2:
                    rng = subset["drp"].mean()
                    combos.append((charm, gex_label, len(subset), rng))
                    print(
                        f"  {charm:20s} + {gex_label:7s}  n={len(subset):2d}   range {rng:.0f} pts avg"
                    )

        if combos:
            widest = max(combos, key=lambda x: x[3])
            narrowest = min(combos, key=lambda x: x[3])
            takeaway(
                f"Widest range combo: {widest[0]} + {widest[1]} ({widest[3]:.0f} pts, n={widest[2]})\n"
                f"            Narrowest combo: {narrowest[0]} + {narrowest[1]} ({narrowest[3]:.0f} pts, n={narrowest[2]})\n"
                f"            Size positions accordingly."
            )


# ── Analysis 6: Flow Agreement ───────────────────────────────


def flow_analysis(df: pd.DataFrame) -> None:
    section("6. FLOW SOURCE RELIABILITY")
    print("  Which flow sources actually predict settlement direction?\n")

    has_flow = df[df["flow_agreement_t1"].notna()].copy()

    # Per-source reliability (the most actionable table)
    sources = [
        ("mt_ncp_t1", "Market Tide"),
        ("spx_ncp_t1", "SPX Net Flow"),
        ("spy_ncp_t1", "SPY Net Flow"),
        ("qqq_ncp_t1", "QQQ Net Flow"),
        ("spy_etf_ncp_t1", "SPY ETF Tide"),
        ("qqq_etf_ncp_t1", "QQQ ETF Tide"),
        ("zero_dte_ncp_t1", "0DTE Index"),
    ]

    source_results = []
    for col, label in sources:
        if col not in has_flow.columns:
            continue
        has_both = has_flow[[col, "settlement_direction"]].dropna()
        if len(has_both) < 5:
            continue

        ncp = has_both[col].astype(float)
        direction = has_both["settlement_direction"]
        predicted_up = ncp > 0
        actual_up = direction == "UP"
        correct = (predicted_up == actual_up).sum()
        total = len(has_both)
        pct = correct / total

        lo, hi = proportion_confint(correct, total, method="wilson")
        if lo > 0.50:  # CI entirely above chance
            rating = "USEFUL *"
        elif hi < 0.50:  # CI entirely below chance
            rating = "ANTI-SIGNAL *"
        elif pct >= 0.55:
            rating = "USEFUL (ns)"
        elif pct >= 0.45:
            rating = "COIN FLIP"
        elif pct >= 0.30:
            rating = "CONTRARIAN (ns)"
        else:
            rating = "ANTI-SIGNAL (ns)"

        # Only mark as significant if CI doesn't contain 0.50
        sig = " *" if hi < 0.50 or lo > 0.50 else ""
        source_results.append((label, correct, total, pct, rating))
        print(
            f"  {label:20s}  {correct}/{total} ({pct:.0%})  CI [{lo:.0%}-{hi:.0%}]  {rating}{sig}"
        )

    # Summarize
    useful = [s for s in source_results if s[4].startswith("USEFUL")]
    anti = [
        s
        for s in source_results
        if s[4].startswith("CONTRARIAN") or s[4].startswith("ANTI-SIGNAL")
    ]

    if useful or anti:
        trust = ", ".join(s[0] for s in useful) if useful else "none yet"
        fade = ", ".join(s[0] for s in anti) if anti else "none"
        takeaway(
            f"TRUST: {trust}\n"
            f"            FADE/IGNORE: {fade}\n"
            "            This directly validates Rule 10 (discount SPX flow when others disagree)."
        )

    # Flow agreement vs range
    subsection("Does high flow agreement predict range?")
    has_flow["fa1"] = has_flow["flow_agreement_t1"].astype(float)
    high = has_flow[has_flow["fa1"] >= 6]["day_range_pts"].dropna().astype(float)
    low = has_flow[has_flow["fa1"] < 6]["day_range_pts"].dropna().astype(float)
    if len(high) >= 2 and len(low) >= 2:
        print(
            f"  High agreement (>=6 sources, n={len(high)}):  {high.mean():.0f} pts avg"
        )
        print(f"  Low agreement  (<6 sources, n={len(low)}):  {low.mean():.0f} pts avg")
        if high.mean() < low.mean():
            takeaway(
                "Higher agreement = NARROWER ranges. When sources agree,\n"
                "            the market is more orderly -- good for premium selling."
            )
        else:
            takeaway(
                "Higher agreement = WIDER ranges. When sources agree,\n"
                "            the market moves more directionally."
            )


# ── Analysis 7: Dark Pool Signal ────────────────────────────


def dark_pool_analysis(df: pd.DataFrame) -> None:
    section("7. DARK POOL SIGNAL")
    print("  Does dark pool activity predict range or settlement direction?\n")

    dp_cols = [c for c in DARK_POOL_FEATURES if c in df.columns]
    if not dp_cols:
        print("  No dark pool features available yet")
        return

    has_dp = (
        df[df["dp_total_premium"].notna()].copy()
        if "dp_total_premium" in df.columns
        else df.head(0)
    )
    if len(has_dp) < 5:
        print(f"  Only {len(has_dp)} days with dark pool data -- need at least 5")
        return

    # DP bias vs settlement direction
    # Support/resistance ratio vs range
    subsection("DP Support/Resistance Ratio vs Range")
    if (
        "dp_support_resistance_ratio" in has_dp.columns
        and "day_range_pts" in has_dp.columns
    ):
        sr = has_dp[["dp_support_resistance_ratio", "day_range_pts"]].dropna()
        sr = sr.astype(float)
        if len(sr) >= 5:
            high_support = sr[sr["dp_support_resistance_ratio"] > 1.0]["day_range_pts"]
            high_resist = sr[sr["dp_support_resistance_ratio"] <= 1.0]["day_range_pts"]
            if len(high_support) > 0 and len(high_resist) > 0:
                print(
                    f"  Support > Resistance (n={len(high_support)}):  {high_support.mean():.0f} pts avg range"
                )
                print(
                    f"  Resistance >= Support (n={len(high_resist)}):  {high_resist.mean():.0f} pts avg range"
                )

    # DP concentration vs range
    subsection("DP Concentration vs Range")
    if "dp_concentration" in has_dp.columns and "day_range_pts" in has_dp.columns:
        conc = has_dp[["dp_concentration", "day_range_pts"]].dropna().astype(float)
        if len(conc) >= 5:
            median_conc = conc["dp_concentration"].median()
            high_conc = conc[conc["dp_concentration"] > median_conc]["day_range_pts"]
            low_conc = conc[conc["dp_concentration"] <= median_conc]["day_range_pts"]
            if len(high_conc) > 0 and len(low_conc) > 0:
                print(
                    f"  High concentration (n={len(high_conc)}):  {high_conc.mean():.0f} pts avg range"
                )
                print(
                    f"  Low concentration  (n={len(low_conc)}):  {low_conc.mean():.0f} pts avg range"
                )
                takeaway(
                    "Concentrated dark pool activity may signal institutional conviction "
                    "about support/resistance levels."
                )


# ── Analysis 8: Options Volume & Premium ────────────────────


def options_volume_analysis(df: pd.DataFrame) -> None:
    section("8. OPTIONS VOLUME & PREMIUM")
    print("  Do options flow metrics predict structure or range?\n")

    opt_cols = [c for c in OPTIONS_VOLUME_FEATURES if c in df.columns]
    if not opt_cols:
        print("  No options volume features available yet")
        return

    has_opt = (
        df[df["opt_vol_pcr"].notna()].copy()
        if "opt_vol_pcr" in df.columns
        else df.head(0)
    )
    if len(has_opt) < 5:
        print(f"  Only {len(has_opt)} days with options volume data -- need at least 5")
        return

    # PCR vs settlement direction
    subsection("Put/Call Volume Ratio vs Settlement Direction")
    if "opt_vol_pcr" in has_opt.columns and "settlement_direction" in has_opt.columns:
        has_both = has_opt[["opt_vol_pcr", "settlement_direction"]].dropna()
        has_both["opt_vol_pcr"] = has_both["opt_vol_pcr"].astype(float)
        if len(has_both) >= 5:
            high_pcr = has_both[has_both["opt_vol_pcr"] > 1.0]
            low_pcr = has_both[has_both["opt_vol_pcr"] <= 1.0]
            if len(high_pcr) > 0:
                up_pct = (high_pcr["settlement_direction"] == "UP").mean()
                print(
                    f"  High PCR >1.0 (n={len(high_pcr)}):  {up_pct:.0%} settled UP (contrarian signal?)"
                )
            if len(low_pcr) > 0:
                up_pct = (low_pcr["settlement_direction"] == "UP").mean()
                print(f"  Low PCR <=1.0 (n={len(low_pcr)}):  {up_pct:.0%} settled UP")

    # Bullish vs bearish premium and outcomes
    subsection("Bullish vs Bearish Premium vs Range")
    if (
        "opt_bullish_premium" in has_opt.columns
        and "opt_bearish_premium" in has_opt.columns
    ):
        prem = (
            has_opt[["opt_bullish_premium", "opt_bearish_premium", "day_range_pts"]]
            .dropna()
            .astype(float)
        )
        if len(prem) >= 5:
            prem["bull_bear_ratio"] = prem["opt_bullish_premium"] / prem[
                "opt_bearish_premium"
            ].replace(0, float("nan"))
            median_ratio = prem["bull_bear_ratio"].median()
            bull_heavy = prem[prem["bull_bear_ratio"] > median_ratio]["day_range_pts"]
            bear_heavy = prem[prem["bull_bear_ratio"] <= median_ratio]["day_range_pts"]
            if len(bull_heavy) > 0 and len(bear_heavy) > 0:
                print(
                    f"  Bullish-heavy days (n={len(bull_heavy)}):  {bull_heavy.mean():.0f} pts avg range"
                )
                print(
                    f"  Bearish-heavy days (n={len(bear_heavy)}):  {bear_heavy.mean():.0f} pts avg range"
                )

    # Volume vs 30-day average
    subsection("Unusual Volume (vs 30-day avg)")
    if "opt_call_vol_vs_avg30" in has_opt.columns:
        vol_ratio = (
            has_opt[["opt_call_vol_vs_avg30", "opt_put_vol_vs_avg30", "day_range_pts"]]
            .dropna()
            .astype(float)
        )
        if len(vol_ratio) >= 5:
            high_call = vol_ratio[vol_ratio["opt_call_vol_vs_avg30"] > 1.5][
                "day_range_pts"
            ]
            normal = vol_ratio[vol_ratio["opt_call_vol_vs_avg30"] <= 1.5][
                "day_range_pts"
            ]
            if len(high_call) > 0 and len(normal) > 0:
                print(
                    f"  High call volume (>1.5x avg, n={len(high_call)}):  {high_call.mean():.0f} pts range"
                )
                print(
                    f"  Normal call volume (n={len(normal)}):  {normal.mean():.0f} pts range"
                )


# ── Analysis 9: IV & PCR Dynamics ───────────────────────────


def iv_pcr_analysis(df: pd.DataFrame) -> None:
    section("9. IV & PCR DYNAMICS")
    print("  How do intraday IV and PCR patterns relate to outcomes?\n")

    iv_cols = [c for c in IV_PCR_FEATURES if c in df.columns]
    if not iv_cols:
        print("  No IV/PCR features available yet")
        return

    has_iv = df[df["iv_open"].notna()].copy() if "iv_open" in df.columns else df.head(0)
    if len(has_iv) < 5:
        print(f"  Only {len(has_iv)} days with IV monitor data -- need at least 5")
        return

    # IV crush rate vs structure correctness
    subsection("IV Crush Rate vs Structure Correctness")
    if "iv_crush_rate" in has_iv.columns and "structure_correct" in has_iv.columns:
        has_both = has_iv[["iv_crush_rate", "structure_correct"]].dropna()
        has_both["iv_crush_rate"] = has_both["iv_crush_rate"].astype(float)
        if len(has_both) >= 5:
            correct = has_both[has_both["structure_correct"] == True]["iv_crush_rate"]
            incorrect = has_both[has_both["structure_correct"] == False][
                "iv_crush_rate"
            ]
            if len(correct) > 0:
                print(
                    f"  Correct days (n={len(correct)}):  IV crush rate {correct.mean():.2f} avg"
                )
            if len(incorrect) > 0:
                print(
                    f"  Incorrect days (n={len(incorrect)}):  IV crush rate {incorrect.mean():.2f} avg"
                )

    # IV spike count vs range
    subsection("IV Spike Count vs Range")
    if "iv_spike_count" in has_iv.columns and "day_range_pts" in has_iv.columns:
        spikes = has_iv[["iv_spike_count", "day_range_pts"]].dropna().astype(float)
        if len(spikes) >= 5:
            has_spikes = spikes[spikes["iv_spike_count"] > 0]["day_range_pts"]
            no_spikes = spikes[spikes["iv_spike_count"] == 0]["day_range_pts"]
            if len(has_spikes) > 0 and len(no_spikes) > 0:
                print(
                    f"  Days with IV spikes (n={len(has_spikes)}):  {has_spikes.mean():.0f} pts avg range"
                )
                print(
                    f"  Days without spikes (n={len(no_spikes)}):  {no_spikes.mean():.0f} pts avg range"
                )
                if has_spikes.mean() > no_spikes.mean() * 1.2:
                    takeaway(
                        "IV spikes are associated with wider ranges. "
                        "Consider widening strikes when IV spikes early."
                    )

    # PCR trend
    subsection("PCR Trend (T1 to T2) vs Settlement")
    if "pcr_trend_t1_t2" in has_iv.columns and "settlement_direction" in has_iv.columns:
        pcr = has_iv[["pcr_trend_t1_t2", "settlement_direction"]].dropna()
        pcr["pcr_trend_t1_t2"] = pcr["pcr_trend_t1_t2"].astype(float)
        if len(pcr) >= 5:
            rising = pcr[pcr["pcr_trend_t1_t2"] > 0]
            falling = pcr[pcr["pcr_trend_t1_t2"] <= 0]
            if len(rising) > 0:
                up_pct = (rising["settlement_direction"] == "UP").mean()
                print(f"  Rising PCR (n={len(rising)}):  {up_pct:.0%} settled UP")
            if len(falling) > 0:
                up_pct = (falling["settlement_direction"] == "UP").mean()
                print(f"  Falling PCR (n={len(falling)}):  {up_pct:.0%} settled UP")


# ── Key Findings Summary ─────────────────────────────────────


def key_findings(df: pd.DataFrame) -> None:
    section("KEY FINDINGS SUMMARY")

    n_days = len(df)
    labeled = df[df["structure_correct"].notna()]
    n_labeled = len(labeled)
    n_correct = int(labeled["structure_correct"].sum()) if n_labeled > 0 else 0
    overall_pct = f"{n_correct / n_labeled:.0%}" if n_labeled > 0 else "N/A"

    print(
        f"\n  Dataset: {n_days} trading days, {n_labeled} with labels, "
        f"{n_correct}/{n_labeled} correct ({overall_pct})"
    )

    # Per-structure accuracy
    print("\n  STRUCTURE ACCURACY:")
    structs = ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]
    best_struct = ("", 0.0)
    worst_struct = ("", 1.0)
    for struct in structs:
        subset = labeled[labeled["recommended_structure"] == struct]
        has_correct = subset[subset["structure_correct"].notna()]
        if len(has_correct) == 0:
            continue
        correct = int(has_correct["structure_correct"].sum())
        total = len(has_correct)
        pct = correct / total
        print(f"  - {struct}: {correct}/{total} ({pct:.0%})")
        if pct >= best_struct[1]:
            best_struct = (struct, pct)
        if pct <= worst_struct[1]:
            worst_struct = (struct, pct)

    if best_struct[0]:
        print("\n  WHAT'S WORKING:")
        print(f"  - {best_struct[0]} has the highest accuracy ({best_struct[1]:.0%})")

    # Confidence calibration summary
    if "label_confidence" in labeled.columns:
        conf_accs = {}
        for conf in ["HIGH", "MODERATE", "LOW"]:
            subset = labeled[labeled["label_confidence"] == conf]
            if len(subset) > 0:
                c = subset["structure_correct"].sum()
                conf_accs[conf] = c / len(subset)
        if "HIGH" in conf_accs and "MODERATE" in conf_accs:
            gap = conf_accs["HIGH"] - conf_accs["MODERATE"]
            if gap > 0.05:
                print(
                    f"  - HIGH confidence is {conf_accs['HIGH']:.0%} accurate "
                    f"vs MODERATE at {conf_accs['MODERATE']:.0%}"
                )
                print("  - Confidence IS useful for position sizing")
            else:
                print(
                    "  - Confidence levels show similar accuracy — not useful for sizing"
                )

    # Failure patterns
    failures = labeled[labeled["structure_correct"] == False]
    if len(failures) > 0:
        print("\n  WHAT TO WATCH:")
        for struct in structs:
            n_fail = len(failures[failures["recommended_structure"] == struct])
            if n_fail > 0:
                print(f"  - {struct} has {n_fail} failure(s)")

        fail_gex = failures["gex_oi_t1"].dropna().astype(float)
        if len(fail_gex) > 0 and (fail_gex < 0).all():
            print("  - All failures occurred on negative GEX days")

    # Flow reliability summary
    if "settlement_direction" in df.columns:
        has_flow = df[df["settlement_direction"].notna()]
        sources = [
            ("spx_ncp_t1", "SPX Net Flow"),
            ("spy_etf_ncp_t1", "SPY ETF Tide"),
            ("qqq_etf_ncp_t1", "QQQ ETF Tide"),
            ("mt_ncp_t1", "Market Tide"),
            ("qqq_ncp_t1", "QQQ Net Flow"),
        ]
        useful = []
        anti = []
        for col, label in sources:
            if col not in has_flow.columns:
                continue
            subset = has_flow[[col, "settlement_direction"]].dropna()
            if len(subset) < 5:
                continue
            ncp = subset[col].astype(float)
            actual_up = subset["settlement_direction"] == "UP"
            pct = ((ncp > 0) == actual_up).sum() / len(subset)
            if pct >= 0.55:
                useful.append(f"{label} ({pct:.0%})")
            elif pct < 0.40:
                anti.append(f"{label} ({pct:.0%})")

        if useful or anti:
            print("\n  FLOW RELIABILITY (at T1):")
            if useful:
                print(f"  - Trust: {', '.join(useful)}")
            if anti:
                print(f"  - Fade/Ignore: {', '.join(anti)}")

    # Phase 2 readiness
    majority = labeled["recommended_structure"].value_counts()
    if len(majority) > 0:
        majority_pct = majority.iloc[0] / n_labeled if n_labeled > 0 else 0
        print("\n  FOR PHASE 2 (Structure Classification):")
        print(
            f"  - Majority class baseline: always predict "
            f"'{majority.index[0]}' = {majority_pct:.0%}"
        )
        target_days = 60
        remaining = max(0, target_days - n_labeled)
        if remaining > 0:
            print(f"  - Need ~{remaining} more labeled days (target: {target_days})")
        else:
            print(f"  - Data threshold met ({n_labeled} >= {target_days} days)")
    print()


# ── Persistence ─────────────────────────────────────────────


def save_findings(df: pd.DataFrame, labeled: pd.DataFrame) -> None:
    """Compute key metrics and save via shared helper."""

    n_days = len(df)
    n_labeled = len(labeled)
    n_correct = int(labeled["structure_correct"].sum()) if n_labeled > 0 else 0

    # ── EDA-specific data ──────────────────────────────────
    eda_data: dict = {}

    # Structure accuracy
    structure_acc = {}
    for struct in ["PUT CREDIT SPREAD", "CALL CREDIT SPREAD", "IRON CONDOR"]:
        subset = labeled[labeled["recommended_structure"] == struct]
        has_correct = subset[subset["structure_correct"].notna()]
        if len(has_correct) == 0:
            continue
        correct = int(has_correct["structure_correct"].sum())
        total = len(has_correct)
        structure_acc[struct] = {
            "correct": correct,
            "total": total,
            "rate": round(correct / total, 3),
        }
    eda_data["structure_accuracy"] = structure_acc

    # Confidence calibration
    conf_cal = {}
    if "label_confidence" in labeled.columns:
        for conf in ["HIGH", "MODERATE", "LOW"]:
            subset = labeled[labeled["label_confidence"] == conf]
            if len(subset) == 0:
                continue
            correct = int(subset["structure_correct"].sum())
            total = len(subset)
            conf_cal[conf] = {
                "correct": correct,
                "total": total,
                "rate": round(correct / total, 3),
            }
    eda_data["confidence_calibration"] = conf_cal

    # Flow reliability
    flow_rel = {}
    if "settlement_direction" in df.columns:
        has_flow = df[df["settlement_direction"].notna()]
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
            subset = has_flow[[col, "settlement_direction"]].dropna()
            if len(subset) < 5:
                continue
            ncp = subset[col].astype(float)
            actual_up = subset["settlement_direction"] == "UP"
            correct = int(((ncp > 0) == actual_up).sum())
            total = len(subset)
            flow_rel[label] = {
                "correct": correct,
                "total": total,
                "rate": round(correct / total, 3),
            }
    eda_data["flow_reliability"] = flow_rel

    # Majority baseline
    majority = labeled["recommended_structure"].value_counts()
    if len(majority) > 0:
        eda_data["majority_baseline"] = {
            "structure": majority.index[0],
            "rate": round(majority.iloc[0] / n_labeled, 3) if n_labeled else 0,
        }
    else:
        eda_data["majority_baseline"] = {"structure": "", "rate": 0}

    # Top correctness predictors
    target = labeled["structure_correct"].astype(float)
    numeric_cols = labeled.select_dtypes(include=[np.number]).columns
    exclude = {
        "feature_completeness",
        "day_range_pts",
        "day_range_pct",
        "settlement",
        "day_open",
        "day_high",
        "day_low",
        "close_vs_open",
        "vix_close",
        "vix1d_close",
        "structure_correct",
        "label_completeness",
        "day_of_week",
        "is_friday",
        "is_event_day",
    }
    feature_cols = [c for c in numeric_cols if c not in exclude]

    correlations = []
    for col in feature_cols:
        vals = labeled[col].dropna().astype(float)
        if len(vals) < 10:
            continue
        common = target.loc[vals.index]
        if common.std() == 0 or vals.std() == 0:
            continue
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="An input array is constant",
                category=stats.ConstantInputWarning,
            )
            r, p = stats.pointbiserialr(common, vals)
        if not np.isnan(r):
            correlations.append((col, float(r), float(p)))

    correlations.sort(key=lambda x: abs(x[1]), reverse=True)
    eda_data["top_correctness_predictors"] = [
        {"feature": col, "r": round(r, 3), "p": round(p, 3)}
        for col, r, p in correlations[:10]
    ]

    # Top range predictors (Kruskal-Wallis H)
    has_range = df[df["range_category"].notna()].copy()
    f_scores = []
    if len(has_range) >= 10:
        categories = has_range["range_category"].unique()
        for col in feature_cols:
            groups = []
            for cat in categories:
                vals = (
                    has_range[has_range["range_category"] == cat][col]
                    .dropna()
                    .astype(float)
                )
                if len(vals) >= 2:
                    groups.append(vals.values)
            if len(groups) >= 2:
                with warnings.catch_warnings():
                    warnings.filterwarnings(
                        "ignore", message="invalid value", category=RuntimeWarning
                    )
                    h_stat, p = stats.kruskal(*groups)
                if not np.isnan(h_stat):
                    f_scores.append((col, float(h_stat), float(p)))

    f_scores.sort(key=lambda x: x[1], reverse=True)
    eda_data["top_range_predictors"] = [
        {"feature": col, "H": round(h, 2), "p": round(p, 3)}
        for col, h, p in f_scores[:10]
    ]

    # ── Save dataset metadata as top-level key ─────────────
    dataset_data = {
        "total_days": n_days,
        "labeled_days": n_labeled,
        "date_range": [
            f"{df.index.min():%Y-%m-%d}",
            f"{df.index.max():%Y-%m-%d}",
        ],
        "overall_accuracy": round(n_correct / n_labeled, 3) if n_labeled else 0,
    }
    save_section_findings("dataset", dataset_data)

    # ── Save EDA section ───────────────────────────────────
    save_section_findings("eda", eda_data)


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    print("Loading data ...")
    df = load_data_eda()
    print(
        f"  {len(df)} days loaded ({df.index.min():%Y-%m-%d} to {df.index.max():%Y-%m-%d})"
    )
    print(f"  {df['structure_correct'].notna().sum()} days with labels")
    print(f"  {df['day_range_pts'].notna().sum()} days with outcomes")

    validate_dataframe(
        df,
        min_rows=5,
        required_columns=["day_range_pts"],
        range_checks={"vix": (9, 90)},
    )

    rule_validation(df)
    confidence_calibration(df)
    structure_analysis(df)
    feature_importance(df)
    charm_analysis(df)
    flow_analysis(df)
    dark_pool_analysis(df)
    options_volume_analysis(df)
    iv_pcr_analysis(df)
    key_findings(df)

    labeled = df[df["structure_correct"].notna()].copy()
    save_findings(df, labeled)


if __name__ == "__main__":
    main()
