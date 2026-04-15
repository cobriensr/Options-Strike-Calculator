"""
Phase 4.5 — NOPE EDA

Tests whether SPY NOPE (Net Options Pricing Effect) features carry
meaningful directional and regime signal for 0DTE SPX decisions.

Questions addressed:
  Q1  Does nope_t1 at 10:00 ET predict settlement direction better than chance?
  Q2  Does NOPE+Market Tide agreement yield a higher win rate than either alone?
  Q3  Do AM sign flips correlate with intraday range (chop indicator)?
  Q4  Does nope_am_cum_delta correlate with the full-session price move?
  Q5  Does |NOPE| magnitude predict move magnitude (conviction)?

Outputs:
  ml/plots/nope_direction_by_sign.png
  ml/plots/nope_mt_agreement.png
  ml/plots/nope_flips_vs_range.png
  ml/plots/nope_cumdelta_vs_move.png
  ml/plots/nope_magnitude_vs_move.png
  ml/findings.json → section "nope_eda"

Usage:
  ml/.venv/bin/python src/nope_eda.py

Requires NOPE_FEATURES populated in training_features (run build-features
cron or backfill first). The script degrades gracefully when data is
insufficient — plots and findings reflect the observed sample size.
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

from utils import (  # noqa: E402
    ML_ROOT,
    NOPE_FEATURES,
    load_data,
    save_section_findings,
    section,
    subsection,
    takeaway,
    verdict,
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

MIN_N_FOR_TEST = 10  # Below this, we note "insufficient data" rather than test.

# ── Data loading ─────────────────────────────────────────────


def load_data_nope() -> pd.DataFrame:
    """Join training_features (with NOPE columns) to outcomes."""
    return load_data(
        """
        SELECT f.date,
               f.nope_t1, f.nope_t2, f.nope_t3, f.nope_t4,
               f.nope_am_mean, f.nope_am_sign_flips, f.nope_am_cum_delta,
               f.mt_ncp_t1, f.mt_npp_t1,
               o.day_open, o.settlement, o.day_range_pts, o.close_vs_open
        FROM training_features f
        LEFT JOIN outcomes o ON o.date = f.date
        ORDER BY f.date ASC
        """
    )


# ── Analysis helpers ─────────────────────────────────────────


def _insufficient(label: str, n: int) -> None:
    print(f"  Skipped {label}: n={n} (need >= {MIN_N_FOR_TEST}).")


def _has_nope_data(df: pd.DataFrame) -> pd.DataFrame:
    """Subset to rows where nope_t1 is populated."""
    return df[df["nope_t1"].notna()].copy()


# ── Q1: Directional predictive power of nope_t1 ──────────────


def q1_direction_by_sign(df: pd.DataFrame) -> dict:
    subsection("Q1: Does nope_t1 sign predict settlement direction?")
    d = _has_nope_data(df).dropna(subset=["settlement", "day_open", "nope_t1"])
    if len(d) < MIN_N_FOR_TEST:
        _insufficient("Q1", len(d))
        return {"question": "q1", "status": "insufficient_data", "n": len(d)}

    d["nope_sign"] = np.sign(d["nope_t1"].astype(float))
    d["up_day"] = d["settlement"].astype(float) > d["day_open"].astype(float)
    # Drop zero-sign rows (rare, but avoid grouping surprise).
    d = d[d["nope_sign"] != 0]

    grouped = d.groupby("nope_sign", observed=True)["up_day"].agg(["mean", "count"])
    # Fisher's exact on 2x2 sign vs outcome
    table = pd.crosstab(d["nope_sign"] > 0, d["up_day"])
    if table.shape == (2, 2) and table.to_numpy().min() > 0:
        _, p_value = stats.fisher_exact(table)
    else:
        p_value = np.nan

    overall_up = float(d["up_day"].mean())
    pos_win = float(grouped.loc[1, "mean"]) if 1 in grouped.index else np.nan
    neg_win = float(grouped.loc[-1, "mean"]) if -1 in grouped.index else np.nan

    print(f"  n = {len(d)}, baseline up-rate = {overall_up:.1%}")
    print(
        f"  Positive NOPE @ T1 → up rate: {pos_win:.1%} "
        f"(n={int(grouped.loc[1, 'count']) if 1 in grouped.index else 0})"
    )
    print(
        f"  Negative NOPE @ T1 → up rate: {neg_win:.1%} "
        f"(n={int(grouped.loc[-1, 'count']) if -1 in grouped.index else 0})"
    )
    if not np.isnan(p_value):
        print(f"  Fisher's exact p = {p_value:.4f}")

    # Plot
    fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
    labels = ["Negative NOPE", "Positive NOPE"]
    win_rates = [neg_win, pos_win]
    colors = [COLORS["red"], COLORS["green"]]
    bars = ax.bar(labels, win_rates, color=colors, edgecolor="#222")
    ax.axhline(overall_up, color=COLORS["gray"], linestyle="--", label="baseline")
    for bar, rate in zip(bars, win_rates, strict=False):
        if not np.isnan(rate):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                rate + 0.01,
                f"{rate:.0%}",
                ha="center",
                fontsize=11,
                color="#fff",
            )
    ax.set_ylim(0, 1)
    ax.set_ylabel("Up-day rate (settlement > open)")
    ax.set_title(
        f"NOPE @ T1 sign vs settlement direction (n={len(d)})\nFisher p = {p_value:.3f}"
        if not np.isnan(p_value)
        else f"NOPE @ T1 sign vs settlement direction (n={len(d)})"
    )
    ax.legend()
    plt.savefig(PLOT_DIR / "nope_direction_by_sign.png", dpi=150)
    plt.close(fig)

    verdict_str = verdict(
        confirmed=not np.isnan(p_value) and p_value < 0.05,
        caveat=f"p = {p_value:.3f}, n = {len(d)}"
        if not np.isnan(p_value)
        else f"n = {len(d)} too small for inference",
    )
    print(verdict_str)
    return {
        "question": "q1_direction_by_sign",
        "n": len(d),
        "baseline_up_rate": overall_up,
        "positive_nope_up_rate": pos_win,
        "negative_nope_up_rate": neg_win,
        "p_value": None if np.isnan(p_value) else float(p_value),
    }


# ── Q2: NOPE × Market Tide agreement premium ────────────────


def q2_mt_agreement(df: pd.DataFrame) -> dict:
    subsection("Q2: NOPE+Market Tide agreement — does it beat either alone?")
    d = _has_nope_data(df).dropna(
        subset=["nope_t1", "mt_ncp_t1", "settlement", "day_open"]
    )
    if len(d) < MIN_N_FOR_TEST:
        _insufficient("Q2", len(d))
        return {"question": "q2", "status": "insufficient_data", "n": len(d)}

    d["nope_bull"] = d["nope_t1"].astype(float) > 0
    d["mt_bull"] = d["mt_ncp_t1"].astype(float) > 0
    d["up_day"] = d["settlement"].astype(float) > d["day_open"].astype(float)

    agree_bull = d[d["nope_bull"] & d["mt_bull"]]
    agree_bear = d[(~d["nope_bull"]) & (~d["mt_bull"])]
    disagree = d[d["nope_bull"] != d["mt_bull"]]

    rows = [
        ("Agree bullish", agree_bull),
        ("Agree bearish", agree_bear),
        ("Disagree", disagree),
    ]
    win_rates = []
    counts = []
    for name, sub in rows:
        if name == "Agree bearish":
            # Up-day rate here should invert — agreement on bearish means
            # prediction is "down". Report "correct prediction rate".
            correct = float((~sub["up_day"]).mean()) if len(sub) else np.nan
        elif name == "Agree bullish":
            correct = float(sub["up_day"].mean()) if len(sub) else np.nan
        else:
            # Disagree: no directional prediction — report up-rate for reference.
            correct = float(sub["up_day"].mean()) if len(sub) else np.nan
        win_rates.append(correct)
        counts.append(len(sub))
        print(
            f"  {name}: n={len(sub)}, correct rate = {correct:.1%}"
            if len(sub)
            else f"  {name}: n=0"
        )

    # Plot
    fig, ax = plt.subplots(figsize=(9, 5), constrained_layout=True)
    labels = [f"{name}\n(n={n})" for (name, _), n in zip(rows, counts, strict=False)]
    colors = [COLORS["green"], COLORS["red"], COLORS["gray"]]
    bars = ax.bar(labels, win_rates, color=colors, edgecolor="#222")
    baseline = float(d["up_day"].mean())
    ax.axhline(baseline, color=COLORS["blue"], linestyle="--", label="overall up-rate")
    for bar, rate in zip(bars, win_rates, strict=False):
        if not np.isnan(rate):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                rate + 0.01,
                f"{rate:.0%}",
                ha="center",
                fontsize=11,
                color="#fff",
            )
    ax.set_ylim(0, 1)
    ax.set_ylabel("Correct directional prediction rate")
    ax.set_title(f"NOPE × Market Tide agreement (T1, n={len(d)})")
    ax.legend()
    plt.savefig(PLOT_DIR / "nope_mt_agreement.png", dpi=150)
    plt.close(fig)

    takeaway_text = (
        f"Agree-bull correct rate: {win_rates[0]:.1%}, "
        f"agree-bear correct rate: {win_rates[1]:.1%}, "
        f"disagree up-rate: {win_rates[2]:.1%}"
    )
    takeaway(takeaway_text)
    return {
        "question": "q2_mt_agreement",
        "n": len(d),
        "agree_bull_correct_rate": win_rates[0] if not np.isnan(win_rates[0]) else None,
        "agree_bear_correct_rate": win_rates[1] if not np.isnan(win_rates[1]) else None,
        "disagree_up_rate": win_rates[2] if not np.isnan(win_rates[2]) else None,
        "agree_bull_n": counts[0],
        "agree_bear_n": counts[1],
        "disagree_n": counts[2],
    }


# ── Q3: AM sign flips ↔ intraday range ──────────────────────


def q3_flips_vs_range(df: pd.DataFrame) -> dict:
    subsection("Q3: Do AM sign flips correlate with wider day ranges?")
    d = _has_nope_data(df).dropna(subset=["nope_am_sign_flips", "day_range_pts"])
    if len(d) < MIN_N_FOR_TEST:
        _insufficient("Q3", len(d))
        return {"question": "q3", "status": "insufficient_data", "n": len(d)}

    flips = d["nope_am_sign_flips"].astype(float)
    rng = d["day_range_pts"].astype(float)
    rho, p_value = stats.spearmanr(flips, rng)

    print(f"  n = {len(d)}, Spearman ρ = {rho:.3f}, p = {p_value:.4f}")

    fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
    ax.scatter(flips, rng, alpha=0.6, color=COLORS["orange"], edgecolor="#222")
    # Trend line
    if len(d) >= MIN_N_FOR_TEST:
        coef = np.polyfit(flips, rng, 1)
        xs = np.linspace(flips.min(), flips.max(), 50)
        ax.plot(xs, np.polyval(coef, xs), color=COLORS["blue"], linestyle="--")
    ax.set_xlabel("AM NOPE sign flips")
    ax.set_ylabel("Day range (pts)")
    ax.set_title(f"Sign flips vs day range (n={len(d)}, ρ={rho:.2f}, p={p_value:.3f})")
    plt.savefig(PLOT_DIR / "nope_flips_vs_range.png", dpi=150)
    plt.close(fig)

    print(verdict(rho > 0 and p_value < 0.05, f"ρ={rho:.2f}, p={p_value:.3f}"))
    return {
        "question": "q3_flips_vs_range",
        "n": len(d),
        "spearman_rho": float(rho),
        "p_value": float(p_value),
    }


# ── Q4: Cumulative delta ↔ afternoon move ───────────────────


def q4_cumdelta_vs_move(df: pd.DataFrame) -> dict:
    subsection("Q4: Does nope_am_cum_delta predict the full-session move?")
    d = _has_nope_data(df).dropna(subset=["nope_am_cum_delta", "close_vs_open"])
    if len(d) < MIN_N_FOR_TEST:
        _insufficient("Q4", len(d))
        return {"question": "q4", "status": "insufficient_data", "n": len(d)}

    cum = d["nope_am_cum_delta"].astype(float)
    move = d["close_vs_open"].astype(float)
    r, p_value = stats.pearsonr(cum, move)

    print(f"  n = {len(d)}, Pearson r = {r:.3f}, p = {p_value:.4f}")

    fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
    colors = np.where(move > 0, COLORS["green"], COLORS["red"])
    ax.scatter(cum, move, c=colors, alpha=0.6, edgecolor="#222")
    if len(d) >= MIN_N_FOR_TEST:
        coef = np.polyfit(cum, move, 1)
        xs = np.linspace(cum.min(), cum.max(), 50)
        ax.plot(xs, np.polyval(coef, xs), color=COLORS["blue"], linestyle="--")
    ax.axhline(0, color=COLORS["gray"], linewidth=0.5)
    ax.axvline(0, color=COLORS["gray"], linewidth=0.5)
    ax.set_xlabel("AM cumulative NOPE delta (call_delta − put_delta)")
    ax.set_ylabel("Close − Open (pts)")
    ax.set_title(
        f"AM cum_delta vs session move (n={len(d)}, r={r:.2f}, p={p_value:.3f})"
    )
    plt.savefig(PLOT_DIR / "nope_cumdelta_vs_move.png", dpi=150)
    plt.close(fig)

    print(verdict(r > 0 and p_value < 0.05, f"r={r:.2f}, p={p_value:.3f}"))
    return {
        "question": "q4_cumdelta_vs_move",
        "n": len(d),
        "pearson_r": float(r),
        "p_value": float(p_value),
    }


# ── Q5: Magnitude as conviction ─────────────────────────────


def q5_magnitude_vs_move(df: pd.DataFrame) -> dict:
    subsection("Q5: Does |NOPE @ T1| predict absolute move magnitude?")
    d = _has_nope_data(df).dropna(subset=["nope_t1", "close_vs_open"])
    if len(d) < MIN_N_FOR_TEST:
        _insufficient("Q5", len(d))
        return {"question": "q5", "status": "insufficient_data", "n": len(d)}

    mag = d["nope_t1"].astype(float).abs()
    abs_move = d["close_vs_open"].astype(float).abs()
    rho, p_value = stats.spearmanr(mag, abs_move)

    # Bucket by magnitude tercile for a cleaner plot
    d = d.assign(mag=mag.to_numpy(), abs_move=abs_move.to_numpy())
    d["mag_bucket"] = pd.qcut(
        d["mag"],
        q=3,
        labels=["low |NOPE|", "mid |NOPE|", "high |NOPE|"],
        duplicates="drop",
    )
    bucket_means = d.groupby("mag_bucket", observed=True)["abs_move"].agg(
        ["mean", "count"]
    )

    print(f"  n = {len(d)}, Spearman ρ = {rho:.3f}, p = {p_value:.4f}")
    for label, row in bucket_means.iterrows():
        print(f"  {label}: mean |move| = {row['mean']:.1f} pts (n={int(row['count'])})")

    fig, ax = plt.subplots(figsize=(8, 5), constrained_layout=True)
    if not bucket_means.empty:
        labels = [str(x) for x in bucket_means.index]
        ax.bar(
            labels,
            bucket_means["mean"].to_numpy(),
            color=[COLORS["blue"], COLORS["purple"], COLORS["orange"]],
            edgecolor="#222",
        )
    ax.set_ylabel("Mean |close − open| (pts)")
    ax.set_title(f"|NOPE @ T1| magnitude vs move size (n={len(d)}, ρ={rho:.2f})")
    plt.savefig(PLOT_DIR / "nope_magnitude_vs_move.png", dpi=150)
    plt.close(fig)

    print(verdict(rho > 0 and p_value < 0.05, f"ρ={rho:.2f}, p={p_value:.3f}"))
    return {
        "question": "q5_magnitude_vs_move",
        "n": len(d),
        "spearman_rho": float(rho),
        "p_value": float(p_value),
        "bucket_means": {
            str(k): {"mean_abs_move": float(v["mean"]), "n": int(v["count"])}
            for k, v in bucket_means.to_dict(orient="index").items()
        },
    }


# ── Main ─────────────────────────────────────────────────────


def main() -> None:
    section("NOPE EDA — Phase 4.5")
    df = load_data_nope()
    print(
        f"Loaded {len(df)} rows; NOPE populated on {_has_nope_data(df).shape[0]} of them."
    )

    if _has_nope_data(df).empty:
        print("\n  No NOPE data yet. Run backfill-nope and build-features first:")
        print("    node scripts/backfill-nope.mjs 60")
        print(
            "    curl 'https://<host>/api/cron/build-features?backfill=true' -H 'Authorization: Bearer $CRON_SECRET'"
        )
        save_section_findings(
            "nope_eda",
            {
                "status": "no_data",
                "note": "NOPE columns empty in training_features — backfill and build-features needed.",
                "features": NOPE_FEATURES,
            },
        )
        return

    findings = {
        "n_rows_total": int(len(df)),
        "n_rows_with_nope": int(_has_nope_data(df).shape[0]),
        "features": NOPE_FEATURES,
        "results": {},
    }
    findings["results"]["q1"] = q1_direction_by_sign(df)
    findings["results"]["q2"] = q2_mt_agreement(df)
    findings["results"]["q3"] = q3_flips_vs_range(df)
    findings["results"]["q4"] = q4_cumdelta_vs_move(df)
    findings["results"]["q5"] = q5_magnitude_vs_move(df)

    save_section_findings("nope_eda", findings)
    print("\nDone. Plots saved to ml/plots/nope_*.png; findings in ml/findings.json.")


if __name__ == "__main__":
    main()
