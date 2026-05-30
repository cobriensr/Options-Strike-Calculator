#!/usr/bin/env python
"""
Idea #2, Phase 1 v2 (stats): does the INTRADAY spot-vs-zero-gamma regime predict
range compression, out-of-sample? Correctly-oriented replacement for v1's
confounded opening-snapshot test.

Hypothesis: more session time long-γ (spot > flip) -> SMALLER realized range vs
VIX1D-implied (compression) -> NEGATIVE correlation. Decisive GO/NO-GO for Phase 2.

Input : docs/tmp/range-phase1v2-data.csv  Output: docs/tmp/expected-range-phase1v2-2026-05-29.md
Run: ml/.venv/bin/python scripts/analyze_range_phase1v2_2026_05_29.py
"""

import numpy as np
import pandas as pd
from scipy import stats


def fit_eval(train, test, with_g):
    def design(d):
        cols = [np.ones(len(d)), d["implied_sigma_pct"].to_numpy()]
        if with_g:
            cols.append(d["long_gamma_frac"].to_numpy())
        return np.column_stack(cols)

    beta, *_ = np.linalg.lstsq(design(train), train["realized_range_pct"].to_numpy(), rcond=None)
    pred = design(test) @ beta
    return float(np.mean(np.abs(pred - test["realized_range_pct"].to_numpy()))), beta


def block_cv(df, k=5):
    folds = np.array_split(np.arange(len(df)), k)
    b, g = [], []
    for f in folds:
        te, tr = df.iloc[f], df.drop(df.index[f])
        if len(te) < 3:
            continue
        b.append(fit_eval(tr, te, False)[0])
        g.append(fit_eval(tr, te, True)[0])
    return float(np.mean(b)), float(np.mean(g))


def main():
    df = pd.read_csv("docs/tmp/range-phase1v2-data.csv", parse_dates=["date"]).sort_values("date")
    df = df.dropna(subset=["range_over_implied", "realized_range_pct", "implied_sigma_pct", "long_gamma_frac"])
    n = len(df)

    rho_f, p_f = stats.spearmanr(df.long_gamma_frac, df.range_over_implied)
    rho_d, p_d = stats.spearmanr(df.mean_norm_dist, df.range_over_implied)

    # quantile bins of long_gamma_frac -> mean range/implied (expect DECREASING).
    # labels=False + duplicates=drop handles the spike of frac==1.0 days.
    df = df.copy()
    df["terc"] = pd.qcut(df.long_gamma_frac, 3, labels=False, duplicates="drop")
    nb = int(df["terc"].nunique())
    terc = df.groupby("terc", observed=True)["range_over_implied"].agg(["mean", "median", "count"])

    def terc_name(i):
        if i == 0:
            return "lowest γ-time"
        if i == nb - 1:
            return "highest γ-time"
        return f"mid ({i})"

    base_mae, gam_mae = block_cv(df)
    cv_imp = (base_mae - gam_mae) / base_mae * 100
    _, beta_full = fit_eval(df, df, True)
    gamma_coef = beta_full[-1]  # negative = more long-γ → smaller range (compress)

    L = ["# Idea #2 Phase 1 v2 — intraday spot-vs-zero-gamma regime → range? (OOS)", ""]
    L += [
        f"n = **{n}** days ({df.date.min():%Y-%m-%d} … {df.date.max():%Y-%m-%d}; bound by "
        f"zero_gamma_levels history). Predictor = `long_gamma_frac` (share of session spot "
        f"ABOVE the zero-gamma flip = dealer long-γ time). Hypothesis: higher → compression "
        f"→ NEGATIVE corr with range/implied.",
        "",
        "> ⚠️ Power: n=43 and the window is long-γ-heavy (mean frac 0.69). Read as "
        "corroboration of the n=37 prior, not independent proof.",
        "",
        "## A. Correlation (full sample)",
        f"- Spearman(long_gamma_frac, range/implied) = **{rho_f:+.2f}**, p = {p_f:.3f}",
        f"- Spearman(mean_norm_dist, range/implied)  = **{rho_d:+.2f}**, p = {p_d:.3f}",
        "  (negative ρ = more long-γ time / further above flip → tighter range = compression)",
        "",
        "## B. Range/implied by long-γ-time tercile (expect decreasing)",
        "",
        "| tercile | mean range/implied | median | n |",
        "|---|---|---|---|",
    ]
    for idx, r in terc.iterrows():
        L.append(f"| {terc_name(int(idx))} | {r['mean']:.2f} | {r['median']:.2f} | {int(r['count'])} |")
    L += [
        "",
        "## C. Out-of-sample incremental value (5-fold time-block CV)",
        f"- VIX1D-only MAE {base_mae:.4f} → VIX1D + long_gamma_frac MAE {gam_mae:.4f} = "
        f"**{cv_imp:+.1f}%** (positive = regime helps)",
        f"- full-sample γ coefficient = **{gamma_coef:+.3f}** (negative = compression direction)",
        "",
        "## Verdict",
        "",
    ]
    compress_dir = rho_f < 0 and gamma_coef < 0
    if compress_dir and p_f < 0.10 and cv_imp > 1:
        v = ("**GO.** The intraday long-γ regime predicts compression in the right direction, "
             "is (near-)significant, and adds OOS range info over VIX1D. Reconciled with the "
             "prior — build Phase 2 (calibrated band) on spot-vs-flip regime.")
    elif compress_dir and (p_f < 0.20 or cv_imp > 1):
        v = ("**WEAK-GO.** Compression direction is right and shows up OOS, but n=43 keeps it "
             "shy of significance. Worth building a Phase 2 calibration prototype, but treat as "
             "provisional and re-confirm as history grows.")
    elif compress_dir:
        v = ("**INCONCLUSIVE (right sign, weak).** Direction matches the prior but neither "
             "significance nor OOS lift is convincing at n=43. Hold for more history.")
    else:
        v = ("**NO-GO.** The intraday regime does NOT compress range in this sample — even with "
             "the corrected instrument. The vol-compression edge does not reproduce here; do "
             "not build Phase 2 on it.")
    L += [v, ""]

    with open("docs/tmp/expected-range-phase1v2-2026-05-29.md", "w") as f:
        f.write("\n".join(L) + "\n")
    print("Wrote docs/tmp/expected-range-phase1v2-2026-05-29.md")
    print("\n".join(L[-14:]))


if __name__ == "__main__":
    main()
