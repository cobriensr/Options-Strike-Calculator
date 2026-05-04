"""Analyze the per-fire net-flow features against lottery outcomes.

Reads features.parquet from extract_features.py and produces:
  1. Quartile-lift tables (lottery rate by feature quartile, per exit policy)
  2. Direction-match contingency (chi-squared)
  3. Stratified concentration check on top-2 features (per leakage rule)
  4. Correlation matrix
  5. Univariate scatter plots
  6. report.md summary

Run: `ml/.venv/bin/python ml/experiments/lottery-net-flow-eda/analyze.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from scipy.stats import chi2_contingency

EXPERIMENT_DIR = Path(__file__).parent
FEATURES_PARQUET = EXPERIMENT_DIR / "features.parquet"
PLOTS_DIR = Path(__file__).parents[2] / "plots" / "lottery-net-flow-eda"
REPORT_MD = EXPERIMENT_DIR / "report.md"

# Outcome thresholds.
LOTTERY_THRESHOLD_PCT = 100.0  # >= +100% realized = "lottery winner"
EXIT_POLICIES = [
    "realized_trail30_10_pct",
    "realized_hard30m_pct",
    "realized_tier50_holdeod_pct",
]
PRIMARY_POLICY = "realized_trail30_10_pct"  # the policy the UI defaults to
FEATURE_COLS = [
    "ncp_at_fire",
    "ncp_slope_5m",
    "ncp_slope_15m",
    "ncp_slope_30m",
    "asymmetry",
    "level_pct_of_day_high",
    "pre_fire_variance",
    "lead_time_to_peak_min",
]


def quartile_lift(df: pd.DataFrame, feature: str, outcome: str) -> pd.DataFrame:
    """Bin the feature into quartiles, report lottery rate + mean return per bucket."""
    sub = df[[feature, outcome]].dropna().copy()
    if len(sub) < 40:
        return pd.DataFrame()
    try:
        sub["q"] = pd.qcut(sub[feature], q=4, labels=["Q1", "Q2", "Q3", "Q4"], duplicates="drop")
    except ValueError:
        return pd.DataFrame()
    summary = (
        sub.groupby("q", observed=True)
        .agg(
            n=(outcome, "size"),
            mean_return_pct=(outcome, "mean"),
            median_return_pct=(outcome, "median"),
            lottery_rate=(outcome, lambda s: (s >= LOTTERY_THRESHOLD_PCT).mean()),
        )
        .reset_index()
    )
    baseline = (sub[outcome] >= LOTTERY_THRESHOLD_PCT).mean()
    summary["lift_vs_baseline"] = summary["lottery_rate"] - baseline
    return summary


def direction_match_contingency(df: pd.DataFrame, outcome: str) -> dict:
    sub = df[["direction_match", outcome]].dropna().copy()
    # Parquet roundtrip can return direction_match as object dtype with
    # Python booleans; cast explicitly so `~` is logical not bitwise.
    sub["direction_match"] = sub["direction_match"].astype(bool)
    sub["lottery"] = sub[outcome] >= LOTTERY_THRESHOLD_PCT
    table = pd.crosstab(sub["direction_match"], sub["lottery"])
    if table.shape != (2, 2):
        return {"error": f"contingency table not 2x2 (shape={table.shape})"}
    chi2, p, _, _ = chi2_contingency(table)
    rate_match = sub.loc[sub["direction_match"], "lottery"].mean()
    rate_no_match = sub.loc[~sub["direction_match"], "lottery"].mean()
    return {
        "table": table,
        "chi2": chi2,
        "p_value": p,
        "rate_match": rate_match,
        "rate_no_match": rate_no_match,
        "lift": rate_match - rate_no_match,
        "n_match": int(sub["direction_match"].sum()),
        "n_no_match": int(len(sub) - sub["direction_match"].sum()),
    }


def stratified_lift(
    df: pd.DataFrame, feature: str, outcome: str, strat_col: str
) -> pd.DataFrame:
    """Top-quartile lift broken down by a stratification column.

    Per `feedback_uniform_lift_is_leakage`: real signal concentrates in
    one or two strata; uniform lift across every stratum is a leakage
    fingerprint, not edge.
    """
    sub = df[[feature, outcome, strat_col]].dropna().copy()
    if len(sub) < 100:
        return pd.DataFrame()
    sub["lottery"] = sub[outcome] >= LOTTERY_THRESHOLD_PCT
    rows = []
    for stratum, group in sub.groupby(strat_col, observed=True):
        if len(group) < 30:
            continue
        try:
            q4_threshold = group[feature].quantile(0.75)
        except ValueError:
            continue
        in_q4 = group[feature] >= q4_threshold
        if in_q4.sum() < 5:
            continue
        rate_q4 = group.loc[in_q4, "lottery"].mean()
        rate_rest = group.loc[~in_q4, "lottery"].mean()
        rows.append(
            {
                "stratum": stratum,
                "n_total": len(group),
                "n_q4": int(in_q4.sum()),
                "rate_q4": rate_q4,
                "rate_rest": rate_rest,
                "lift": rate_q4 - rate_rest,
            }
        )
    return pd.DataFrame(rows).sort_values("lift", ascending=False)


def feature_score(df: pd.DataFrame, feature: str, outcome: str) -> float | None:
    """Lift between Q4 and Q1 for the feature — used to rank features."""
    summary = quartile_lift(df, feature, outcome)
    if summary.empty or len(summary) < 4:
        return None
    return float(summary["lottery_rate"].iloc[-1] - summary["lottery_rate"].iloc[0])


def plot_quartile_lifts(df: pd.DataFrame, feature: str) -> Path | None:
    fig, axes = plt.subplots(1, 3, figsize=(15, 4), sharey=True)
    for ax, policy in zip(axes, EXIT_POLICIES, strict=True):
        summary = quartile_lift(df, feature, policy)
        if summary.empty:
            ax.set_title(f"{policy} — insufficient data")
            ax.axis("off")
            continue
        ax.bar(summary["q"].astype(str), summary["lottery_rate"] * 100, color="steelblue")
        ax.axhline(
            (df[policy] >= LOTTERY_THRESHOLD_PCT).mean() * 100,
            color="red",
            linestyle="--",
            label=f"baseline {(df[policy] >= LOTTERY_THRESHOLD_PCT).mean() * 100:.1f}%",
        )
        ax.set_title(policy.replace("realized_", "").replace("_pct", ""))
        ax.set_xlabel("quartile")
        ax.set_ylabel("lottery rate (%)")
        ax.legend(fontsize=8)
    fig.suptitle(f"{feature} — lottery-rate lift by quartile", fontsize=12)
    fig.tight_layout()
    out_path = PLOTS_DIR / f"{feature}_quartile_lift.png"
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return out_path


def plot_correlation_matrix(df: pd.DataFrame) -> Path:
    cols = FEATURE_COLS + EXIT_POLICIES + ["peak_ceiling_pct"]
    sub = df[cols].dropna()
    fig, ax = plt.subplots(figsize=(11, 9))
    sns.heatmap(
        sub.corr(),
        annot=True,
        fmt=".2f",
        cmap="RdBu_r",
        center=0,
        vmin=-1,
        vmax=1,
        ax=ax,
        cbar_kws={"shrink": 0.8},
    )
    ax.set_title(f"Feature × outcome correlation (n={len(sub):,})")
    fig.tight_layout()
    out_path = PLOTS_DIR / "correlation_matrix.png"
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return out_path


def fmt_pct(x: float | None) -> str:
    if x is None or pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def fmt_pp(x: float | None) -> str:
    if x is None or pd.isna(x):
        return "—"
    return f"{x * 100:+.1f}pp"


def write_report(df: pd.DataFrame, ranked: list[tuple[str, float]]) -> None:
    """Author the findings memo. Flat tone — no 'ah-ha!' framing per
    `feedback_dont_jump_to_conclusions`."""
    lines: list[str] = []
    lines.append("# Lottery Net Flow EDA — Findings Memo")
    lines.append("")
    lines.append(
        "Generated by `ml/experiments/lottery-net-flow-eda/analyze.py`. "
        f"Inputs: `features.parquet` ({len(df):,} fires).",
    )
    lines.append("")

    # Sample composition
    n_with_features = df["ncp_at_fire"].notna().sum()
    n_calls = (df["option_type"] == "C").sum()
    n_puts = (df["option_type"] == "P").sum()
    n_cheap_pm = df["cheap_call_pm_tagged"].sum()
    n_reload = df["reload_tagged"].sum()
    baseline_primary = (df[PRIMARY_POLICY] >= LOTTERY_THRESHOLD_PCT).mean()

    lines.append("## Sample composition")
    lines.append("")
    lines.append(f"- Total fires (enriched): **{len(df):,}**")
    lines.append(
        f"- Fires with matched-day flow features: **{n_with_features:,}** "
        f"({n_with_features / len(df) * 100:.1f}%)"
    )
    lines.append(f"- Calls / Puts: {n_calls:,} / {n_puts:,}")
    lines.append(f"- Cheap-call-PM tagged: {n_cheap_pm:,}")
    lines.append(f"- RE-LOAD tagged: {n_reload:,}")
    lines.append(
        f"- Baseline lottery rate (≥+100% under {PRIMARY_POLICY}): **{baseline_primary * 100:.1f}%**"
    )
    lines.append("")

    # Feature ranking
    lines.append(f"## Feature ranking by Q4-Q1 lift (under {PRIMARY_POLICY})")
    lines.append("")
    lines.append("| Feature | Q4 - Q1 lift | Direction |")
    lines.append("| --- | ---: | :--- |")
    for feat, lift in ranked:
        sign = "↑ Q4 > Q1 (top quartile is higher-rate)" if lift > 0 else "↓ Q4 < Q1 (bottom quartile is higher-rate)"
        lines.append(f"| `{feat}` | {fmt_pp(lift)} | {sign} |")
    lines.append("")

    # Direction match
    dm = direction_match_contingency(df, PRIMARY_POLICY)
    if "error" not in dm:
        lines.append("## Direction-match (matched-side 5m slope > 0)")
        lines.append("")
        lines.append(
            f"- direction_match=True:  n={dm['n_match']:,}, "
            f"lottery_rate={fmt_pct(dm['rate_match'])}"
        )
        lines.append(
            f"- direction_match=False: n={dm['n_no_match']:,}, "
            f"lottery_rate={fmt_pct(dm['rate_no_match'])}"
        )
        lines.append(f"- Lift: {fmt_pp(dm['lift'])}")
        lines.append(
            f"- chi² = {dm['chi2']:.2f}, p = {dm['p_value']:.4g} "
            f"({'significant' if dm['p_value'] < 0.05 else 'NOT significant'} at α=0.05)"
        )
        lines.append("")

    # Top features deep dive
    lines.append("## Top 3 features — quartile breakdown (primary policy)")
    lines.append("")
    for feat, _ in ranked[:3]:
        summary = quartile_lift(df, feat, PRIMARY_POLICY)
        if summary.empty:
            continue
        lines.append(f"### `{feat}`")
        lines.append("")
        lines.append("| Quartile | n | mean return % | median return % | lottery rate | lift vs baseline |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
        for _, r in summary.iterrows():
            lines.append(
                f"| {r['q']} | {int(r['n']):,} | {r['mean_return_pct']:.1f} | {r['median_return_pct']:.1f} | "
                f"{fmt_pct(r['lottery_rate'])} | {fmt_pp(r['lift_vs_baseline'])} |"
            )
        lines.append("")

    # Concentration check on top feature
    if ranked:
        top_feat = ranked[0][0]
        lines.append(f"## Concentration check — `{top_feat}` (top feature)")
        lines.append("")
        lines.append(
            "Per `feedback_uniform_lift_is_leakage`: real signal concentrates "
            "in 1-2 strata; uniform lift across every stratum is a leakage "
            "fingerprint. Q4 means top-quartile of the feature within each stratum."
        )
        lines.append("")
        for strat in ["mode", "tod", "cheap_call_pm_tagged", "option_type"]:
            strat_df = stratified_lift(df, top_feat, PRIMARY_POLICY, strat)
            if strat_df.empty:
                continue
            lines.append(f"### Stratified by `{strat}`")
            lines.append("")
            lines.append("| stratum | n total | n Q4 | rate Q4 | rate rest | lift |")
            lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
            for _, r in strat_df.iterrows():
                lines.append(
                    f"| {r['stratum']} | {int(r['n_total']):,} | {int(r['n_q4']):,} | "
                    f"{fmt_pct(r['rate_q4'])} | {fmt_pct(r['rate_rest'])} | {fmt_pp(r['lift'])} |"
                )
            cv = strat_df["lift"].std() / abs(strat_df["lift"].mean()) if abs(strat_df["lift"].mean()) > 1e-9 else None
            if cv is not None:
                verdict = (
                    "LIKELY LEAKAGE — uniform lift across strata (CV < 0.5)"
                    if cv < 0.5
                    else "Likely real — concentrated lift (CV >= 0.5)"
                )
                lines.append("")
                lines.append(f"Coefficient of variation across strata: {cv:.2f} → **{verdict}**")
            lines.append("")

    # Plots index
    lines.append("## Plots")
    lines.append("")
    lines.append("- [Correlation matrix](../../plots/lottery-net-flow-eda/correlation_matrix.png)")
    for feat, _ in ranked[:5]:
        lines.append(f"- [{feat} quartile lift](../../plots/lottery-net-flow-eda/{feat}_quartile_lift.png)")
    lines.append("")

    # Recommendation
    lines.append("## Recommendation")
    lines.append("")
    if not ranked:
        lines.append("**KILL** — no feature met the minimum sample-size gate.")
    else:
        top_feat, top_lift = ranked[0]
        if abs(top_lift) < 0.02:
            lines.append(
                f"**KEEP-AS-INFORMATIONAL** — best feature `{top_feat}` shows only "
                f"{fmt_pp(top_lift)} Q4-Q1 lift, below practical-significance threshold (±2pp). "
                "Plateau-flag should ship as a UI badge but NOT as a selection filter."
            )
        elif abs(top_lift) >= 0.05:
            lines.append(
                f"**INVESTIGATE FURTHER** — `{top_feat}` shows {fmt_pp(top_lift)} Q4-Q1 lift. "
                "Run the concentration check above; if lift is concentrated in 1-2 strata "
                "(CV >= 0.5), open a follow-up spec for a selection-filter rollout. "
                "If lift is uniform across all strata, treat as suspect and re-EDA in 60 days."
            )
        else:
            lines.append(
                f"**MARGINAL** — `{top_feat}` shows {fmt_pp(top_lift)} Q4-Q1 lift. "
                "Within practical-significance band (2-5pp). Defer the selection-filter decision; "
                "ship plateau-flag as informational and re-EDA when fires history doubles."
            )

    REPORT_MD.write_text("\n".join(lines))
    print(f"wrote {REPORT_MD}")


def main() -> int:
    if not FEATURES_PARQUET.exists():
        print(f"Missing {FEATURES_PARQUET} — run extract_features.py first")
        return 1

    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    df = pd.read_parquet(FEATURES_PARQUET)
    print(f"loaded {len(df):,} fires from {FEATURES_PARQUET.name}")

    # Rank features by Q4-Q1 lift under the primary policy.
    ranked: list[tuple[str, float]] = []
    for feat in FEATURE_COLS:
        score = feature_score(df, feat, PRIMARY_POLICY)
        if score is not None:
            ranked.append((feat, score))
    ranked.sort(key=lambda kv: abs(kv[1]), reverse=True)
    print("\nFeature ranking by |Q4-Q1 lift|:")
    for feat, lift in ranked:
        print(f"  {feat:<28} {lift * 100:+.1f}pp")

    # Plots
    print("\ngenerating plots...")
    plot_correlation_matrix(df)
    for feat, _ in ranked[:5]:
        plot_quartile_lifts(df, feat)
    print(f"  wrote {len(ranked[:5]) + 1} plots to {PLOTS_DIR}")

    write_report(df, ranked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
