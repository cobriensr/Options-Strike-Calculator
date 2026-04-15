"""
Flow Alerts EDA (skeleton)

Initial EDA for the `flow_alerts` table (UW 0-1 DTE SPXW repeated-hit
flow). Five questions, each generating a single plot:

  Q1  Distribution of alert characteristics (premium, ask-ratio, distance)
  Q2  Time-of-day distribution (minute + hour in CT)
  Q3  Directional contribution (bullish / bearish / neutral classification)
  Q4  Forward returns (15-min) by alert_rule × type
  Q5  Premium vs forward return (15-min) scatter with Pearson r

Outputs:
  ml/plots/flow_q1_distributions.png
  ml/plots/flow_q2_time_of_day.png
  ml/plots/flow_q3_directional.png
  ml/plots/flow_q4_returns_by_rule.png
  ml/plots/flow_q5_premium_vs_return.png
  ml/findings.json → section "flow_eda"

Usage:
  ml/.venv/bin/python src/flow_eda.py

Degrades gracefully when the table is empty (prints a message and
returns 0 without plotting).
"""

from __future__ import annotations

import sys

try:
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
    from scipy import stats
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install matplotlib seaborn scipy pandas")
    sys.exit(1)

from load_flow_alerts import (  # noqa: E402
    load_flow_alerts,
    load_flow_alerts_with_outcomes,
)
from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

# ── Paths and style ─────────────────────────────────────────

PLOT_DIR = ML_ROOT / "plots"
PLOT_DIR.mkdir(exist_ok=True)

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
    "gray": "#95a5a6",
}

MIN_N = 10  # Below this, skip statistical tests but still render plots.


# ── Directional classifier ─────────────────────────────────


def _classify_direction(row) -> str:
    """Classify an alert as bullish / bearish / neutral.

    Bullish: OTM call (type=call & NOT is_itm)
    Bearish: OTM put  (type=put  & NOT is_itm)
    Neutral: ITM on either side.
    """
    is_itm = bool(row.get("is_itm")) if pd.notna(row.get("is_itm")) else False
    t = str(row.get("type") or "").lower()
    if is_itm:
        return "neutral"
    if t == "call":
        return "bullish"
    if t == "put":
        return "bearish"
    return "neutral"


# ── Q1: Distributions ──────────────────────────────────────


def q1_distributions(df: pd.DataFrame) -> dict:
    subsection("Q1: Alert characteristic distributions")
    n = len(df)
    print(f"  n = {n}")

    premium = pd.to_numeric(df.get("total_premium"), errors="coerce").dropna()
    ask_ratio = pd.to_numeric(df.get("ask_side_ratio"), errors="coerce").dropna()
    dist_pct = pd.to_numeric(df.get("distance_pct"), errors="coerce").dropna()
    rule_counts = (
        df.get("alert_rule", pd.Series(dtype=str))
        .astype(str)
        .value_counts()
        .sort_index()
    )

    fig, axes = plt.subplots(2, 2, figsize=(12, 9), constrained_layout=True)

    # Premium (log scale)
    ax = axes[0, 0]
    if len(premium) > 0:
        pos = premium[premium > 0]
        if len(pos) > 0:
            ax.hist(
                np.log10(pos),
                bins=30,
                color=COLORS["blue"],
                edgecolor="#222",
            )
        ax.set_xlabel("log10(total_premium $)")
    ax.set_title(f"Total premium (n={len(premium)})")

    # Ask-side ratio
    ax = axes[0, 1]
    if len(ask_ratio) > 0:
        ax.hist(
            ask_ratio,
            bins=25,
            range=(0, 1),
            color=COLORS["orange"],
            edgecolor="#222",
        )
    ax.set_xlabel("ask_side_ratio")
    ax.set_title(f"Ask-side ratio (n={len(ask_ratio)})")

    # Distance pct
    ax = axes[1, 0]
    if len(dist_pct) > 0:
        ax.hist(
            dist_pct,
            bins=30,
            color=COLORS["purple"],
            edgecolor="#222",
        )
        ax.axvline(0, color=COLORS["gray"], linewidth=0.8, linestyle="--")
    ax.set_xlabel("distance_pct (strike - spot) / spot")
    ax.set_title(f"Distance pct (n={len(dist_pct)})")

    # Alert rule counts
    ax = axes[1, 1]
    if not rule_counts.empty:
        ax.bar(
            rule_counts.index,
            rule_counts.to_numpy(),
            color=COLORS["green"],
            edgecolor="#222",
        )
        ax.tick_params(axis="x", rotation=20, labelsize=9)
    ax.set_ylabel("count")
    ax.set_title(f"Alert rule counts (n={int(rule_counts.sum())})")

    fig.suptitle(f"Flow alerts — distributions (N={n})", color="#fff")
    plt.savefig(PLOT_DIR / "flow_q1_distributions.png", dpi=150)
    plt.close(fig)

    return {
        "question": "q1_distributions",
        "n": n,
        "premium_median": float(premium.median()) if len(premium) else None,
        "premium_p95": (float(premium.quantile(0.95)) if len(premium) else None),
        "ask_ratio_median": (float(ask_ratio.median()) if len(ask_ratio) else None),
        "distance_pct_median": (float(dist_pct.median()) if len(dist_pct) else None),
        "alert_rule_counts": {str(k): int(v) for k, v in rule_counts.items()},
    }


# ── Q2: Time of day ────────────────────────────────────────


def q2_time_of_day(df: pd.DataFrame) -> dict:
    subsection("Q2: Time-of-day distribution")
    mod = pd.to_numeric(df.get("minute_of_day"), errors="coerce").dropna()
    n = len(mod)
    print(f"  n = {n}")

    fig, axes = plt.subplots(1, 2, figsize=(13, 5), constrained_layout=True)

    # Minute-of-day histogram (CT minute — session 510..899 = 08:30-14:59)
    ax = axes[0]
    if n > 0:
        ax.hist(
            mod,
            bins=range(510, 905, 5),
            color=COLORS["blue"],
            edgecolor="#222",
        )
    ax.set_xlim(510, 900)
    ax.set_xlabel("minute of day (CT)")
    ax.set_ylabel("count")
    ax.set_title(f"Alerts by minute-of-day CT (n={n})")

    # Hour-of-day bar chart (CT hour 8..14)
    ax = axes[1]
    hour_counts: dict[int, int] = {}
    if n > 0:
        hours = (mod // 60).astype(int)
        hour_counts = hours.value_counts().sort_index().to_dict()
        ax.bar(
            list(hour_counts.keys()),
            list(hour_counts.values()),
            color=COLORS["orange"],
            edgecolor="#222",
        )
        ax.set_xticks(sorted(hour_counts.keys()))
    ax.set_xlabel("hour of day (CT)")
    ax.set_ylabel("count")
    ax.set_title("Alerts by hour-of-day (CT)")

    fig.suptitle("Flow alerts — time-of-day", color="#fff")
    plt.savefig(PLOT_DIR / "flow_q2_time_of_day.png", dpi=150)
    plt.close(fig)

    return {
        "question": "q2_time_of_day",
        "n": n,
        "minute_median": float(mod.median()) if n else None,
        "hour_counts_ct": {int(k): int(v) for k, v in hour_counts.items()},
    }


# ── Q3: Directional contribution ───────────────────────────


def q3_directional(df: pd.DataFrame) -> dict:
    subsection("Q3: Directional contribution")
    if df.empty:
        return {"question": "q3_directional", "n": 0, "counts": {}}

    classes = df.apply(_classify_direction, axis=1)
    counts = classes.value_counts().to_dict()
    for k in ("bullish", "bearish", "neutral"):
        counts.setdefault(k, 0)
    n = int(sum(counts.values()))
    print(
        f"  bullish={counts['bullish']}, bearish={counts['bearish']}, "
        f"neutral={counts['neutral']} (n={n})"
    )

    fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
    order = ["bullish", "neutral", "bearish"]
    ax.bar(
        order,
        [counts[k] for k in order],
        color=[COLORS["green"], COLORS["gray"], COLORS["red"]],
        edgecolor="#222",
    )
    for i, k in enumerate(order):
        ax.text(i, counts[k], str(counts[k]), ha="center", va="bottom", color="#fff")
    ax.set_ylabel("count")
    ax.set_title(f"Flow alerts — directional classification (n={n})")
    plt.savefig(PLOT_DIR / "flow_q3_directional.png", dpi=150)
    plt.close(fig)

    bull = counts["bullish"]
    bear = counts["bearish"]
    ratio = (bull / bear) if bear else None
    if ratio is not None:
        takeaway(f"bullish/bearish ratio = {ratio:.2f}")

    return {
        "question": "q3_directional",
        "n": n,
        "counts": {k: int(v) for k, v in counts.items()},
        "bullish_bearish_ratio": ratio,
    }


# ── Q4: Forward returns by rule × type ─────────────────────


def q4_returns_by_rule(df: pd.DataFrame) -> dict:
    subsection("Q4: Forward returns (15m) by alert_rule × type")
    if "ret_fwd_15" not in df.columns:
        print("  Skipped: ret_fwd_15 not present.")
        return {"question": "q4_returns_by_rule", "status": "no_outcome"}

    d = df.dropna(subset=["ret_fwd_15", "alert_rule", "type"]).copy()
    n = len(d)
    print(f"  n with ret_fwd_15 = {n}")
    if n == 0:
        return {"question": "q4_returns_by_rule", "status": "insufficient", "n": 0}

    grouped = d.groupby(["alert_rule", "type"], observed=True)["ret_fwd_15"].agg(
        ["mean", "count"]
    )

    fig, ax = plt.subplots(figsize=(10, 5), constrained_layout=True)
    labels = [f"{r}\n{t}" for r, t in grouped.index]
    colors = [
        COLORS["green"] if t == "call" else COLORS["red"] for _, t in grouped.index
    ]
    means_bps = grouped["mean"].to_numpy() * 10_000  # to basis points
    ax.bar(labels, means_bps, color=colors, edgecolor="#222")
    ax.axhline(0, color=COLORS["gray"], linewidth=0.8)
    ax.set_ylabel("mean 15-min forward return (bps)")
    ax.set_title(f"Forward return (15m) by rule × type (n={n})")
    ax.tick_params(axis="x", rotation=15, labelsize=9)
    plt.savefig(PLOT_DIR / "flow_q4_returns_by_rule.png", dpi=150)
    plt.close(fig)

    groups_json = {
        f"{r}|{t}": {
            "mean_ret_fwd_15": float(row["mean"]),
            "n": int(row["count"]),
        }
        for (r, t), row in grouped.to_dict(orient="index").items()
    }
    return {
        "question": "q4_returns_by_rule",
        "n": n,
        "groups": groups_json,
    }


# ── Q5: Premium vs forward return ──────────────────────────


def q5_premium_vs_return(df: pd.DataFrame) -> dict:
    subsection("Q5: total_premium vs ret_fwd_15")
    required = {"total_premium", "ret_fwd_15", "type"}
    if not required.issubset(df.columns):
        print(f"  Skipped: missing columns ({required - set(df.columns)})")
        return {"question": "q5_premium_vs_return", "status": "no_outcome"}

    d = df.dropna(subset=["total_premium", "ret_fwd_15"]).copy()
    d = d[d["total_premium"] > 0]
    n = len(d)
    print(f"  n = {n}")

    if n < MIN_N:
        # Still render an (empty-ish) scatter so the pipeline produces a plot.
        fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
        ax.set_title(f"Premium vs 15m return (insufficient n={n})")
        ax.set_xlabel("log10(total_premium $)")
        ax.set_ylabel("ret_fwd_15")
        plt.savefig(PLOT_DIR / "flow_q5_premium_vs_return.png", dpi=150)
        plt.close(fig)
        return {
            "question": "q5_premium_vs_return",
            "status": "insufficient",
            "n": n,
        }

    log_prem = np.log10(d["total_premium"].to_numpy())
    ret = d["ret_fwd_15"].to_numpy()
    r, p_value = stats.pearsonr(log_prem, ret)

    colors = np.where(d["type"].str.lower() == "call", COLORS["green"], COLORS["red"])

    fig, ax = plt.subplots(figsize=(9, 5), constrained_layout=True)
    ax.scatter(log_prem, ret, c=colors, alpha=0.6, edgecolor="#222")
    coef = np.polyfit(log_prem, ret, 1)
    xs = np.linspace(log_prem.min(), log_prem.max(), 50)
    ax.plot(xs, np.polyval(coef, xs), color=COLORS["blue"], linestyle="--")
    ax.axhline(0, color=COLORS["gray"], linewidth=0.8)
    ax.set_xlabel("log10(total_premium $)")
    ax.set_ylabel("ret_fwd_15 (decimal)")
    ax.set_title(
        f"Premium vs 15m forward return — Pearson r={r:.3f}, p={p_value:.3f} (n={n})"
    )
    plt.savefig(PLOT_DIR / "flow_q5_premium_vs_return.png", dpi=150)
    plt.close(fig)

    return {
        "question": "q5_premium_vs_return",
        "n": n,
        "pearson_r": float(r),
        "p_value": float(p_value),
    }


# ── Main ───────────────────────────────────────────────────


def main() -> None:
    section("Flow Alerts EDA (skeleton)")
    df = load_flow_alerts()
    if df.empty:
        print(
            "No flow_alerts rows yet. "
            "Run scripts/backfill-flow-alerts.mjs or wait for cron."
        )
        save_section_findings(
            "flow_eda",
            {
                "status": "no_data",
                "note": (
                    "flow_alerts table empty. Cron ingestion begins at next "
                    "market open; backfill script lands separately."
                ),
            },
        )
        return

    findings: dict = {
        "n_rows_total": int(len(df)),
        "results": {},
    }
    findings["results"]["q1"] = q1_distributions(df)
    findings["results"]["q2"] = q2_time_of_day(df)
    findings["results"]["q3"] = q3_directional(df)

    df_out = load_flow_alerts_with_outcomes()
    if not df_out.empty and "ret_fwd_15" in df_out.columns:
        findings["results"]["q4"] = q4_returns_by_rule(df_out)
        findings["results"]["q5"] = q5_premium_vs_return(df_out)
    else:
        print("\nSkipping Q4-Q5 (no forward-return data yet).")
        findings["results"]["q4"] = {"status": "no_outcome"}
        findings["results"]["q5"] = {"status": "no_outcome"}

    save_section_findings("flow_eda", findings)
    print("\nDone. Plots saved to ml/plots/flow_*.png; findings in ml/findings.json.")


if __name__ == "__main__":
    main()
