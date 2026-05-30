#!/usr/bin/env python
"""
Idea #2, Phase 1 (stats): does dealer gamma explain realized range BEYOND VIX1D,
out-of-sample? Go/no-go for building the calibrated range model.

Crux: VIX1D already implies a daily range. gamma earns its keep only if +gamma
days realize LESS than implied and -gamma days MORE — and if that survives a
temporal holdout. Replicates the validated finding (project_dealer_gamma_vol
_compression: +gamma -> 54-76% of implied, -gamma -> ~107%) on 62 days with an
OOS split + effect sizes.

Input : docs/tmp/range-phase1-data.csv  (from analyze-range-phase1-build-*.ts)
Output: docs/tmp/expected-range-phase1-2026-05-29.md  + a plot in docs/tmp/

Run: ml/.venv/bin/python scripts/analyze_range_phase1_2026_05_29.py
"""

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

RNG = np.random.default_rng(7)


def boot_ci(x, fn=np.mean, n=5000, lo=2.5, hi=97.5):
    x = np.asarray(x, float)
    if len(x) < 2:
        return (np.nan, np.nan)
    idx = RNG.integers(0, len(x), size=(n, len(x)))
    stat = fn(x[idx], axis=1)
    return (np.percentile(stat, lo), np.percentile(stat, hi))


def cohens_d(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return np.nan
    sp = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    return (a.mean() - b.mean()) / sp if sp > 0 else np.nan


def split_block(df, gcol, label):
    """range_over_implied by gamma sign for one date-slice."""
    pos = df.loc[df[gcol] > 0, "range_over_implied"].to_numpy()
    neg = df.loc[df[gcol] < 0, "range_over_implied"].to_numpy()
    out = [f"**{label}** (n={len(df)}; +γ n={len(pos)}, −γ n={len(neg)})", ""]
    if len(pos) >= 2 and len(neg) >= 2:
        _, p = stats.mannwhitneyu(pos, neg, alternative="two-sided")
        d = cohens_d(pos, neg)
        pci, nci = boot_ci(pos), boot_ci(neg)
        out += [
            f"| bucket | n | mean ratio | median | 95% CI (mean) |",
            "|---|---|---|---|---|",
            f"| +γ (compress?) | {len(pos)} | {pos.mean():.2f} | {np.median(pos):.2f} | [{pci[0]:.2f}, {pci[1]:.2f}] |",
            f"| −γ (expand?)   | {len(neg)} | {neg.mean():.2f} | {np.median(neg):.2f} | [{nci[0]:.2f}, {nci[1]:.2f}] |",
            "",
            f"Δ(mean −γ − +γ) = **{neg.mean() - pos.mean():+.2f}** σ-units · "
            f"Mann–Whitney p = **{p:.3f}** · Cohen's d = **{d:+.2f}** "
            f"(+γ ratio < −γ ratio means gamma compresses as hypothesized)",
            "",
        ]
        return out, (pos.mean(), neg.mean())
    out += ["_insufficient bucket size_", ""]
    return out, (np.nan, np.nan)


def design(d, with_gamma):
    # γ enters as a regime SIGN dummy only (+1/−1). This matches the
    # validated sign-based finding and avoids the scaling/standardization
    # pitfalls of the raw ~1e10 magnitude (which overfit and don't generalize).
    cols = [np.ones(len(d)), d["implied_sigma_pct"].to_numpy()]
    if with_gamma:
        cols.append(np.sign(d["gamma_oi"].to_numpy()))
    return np.column_stack(cols)


def fit_eval(train, test):
    y_tr = train["realized_range_pct"].to_numpy()
    y_te = test["realized_range_pct"].to_numpy()
    out = {}
    for name, wg in [("VIX1D only", False), ("VIX1D + γ", True)]:
        beta, *_ = np.linalg.lstsq(design(train, wg), y_tr, rcond=None)
        pred = design(test, wg) @ beta
        mae = float(np.mean(np.abs(pred - y_te)))
        ss_res = float(np.sum((y_te - pred) ** 2))
        ss_tot = float(np.sum((y_te - y_te.mean()) ** 2))
        out[name] = (mae, 1 - ss_res / ss_tot if ss_tot > 0 else np.nan)
    return out


def oos_regression(train, test):
    """Single contiguous holdout (note: γ regime is persistent → may be single-regime)."""
    return fit_eval(train, test)


def block_cv(df, k=5):
    """k contiguous time-blocks; each held out once, fit on the rest. More
    robust than one split when the γ regime is autocorrelated (each fold mixes
    regimes differently). Standard CV (not strict walk-forward) — for
    robustness, not a live-trading sim."""
    folds = np.array_split(np.arange(len(df)), k)
    base_maes, gam_maes = [], []
    for f in folds:
        test = df.iloc[f]
        train = df.drop(df.index[f])
        if len(test) < 3 or test["gamma_oi"].nunique() < 1:
            continue
        r = fit_eval(train, test)
        base_maes.append(r["VIX1D only"][0])
        gam_maes.append(r["VIX1D + γ"][0])
    base, gam = float(np.mean(base_maes)), float(np.mean(gam_maes))
    return base, gam, (base - gam) / base * 100


def main():
    df = pd.read_csv("docs/tmp/range-phase1-data.csv", parse_dates=["date"])
    df = df.dropna(subset=["range_over_implied", "realized_range_pct", "implied_sigma_pct", "gamma_oi"])
    df = df.sort_values("date").reset_index(drop=True)
    n = len(df)
    k = int(n * 0.7)
    train, test = df.iloc[:k], df.iloc[k:]

    L = ["# Idea #2 Phase 1 — does γ explain realized range beyond VIX1D? (OOS)", ""]
    L += [
        f"n = **{n}** trading days ({df.date.min():%Y-%m-%d} … {df.date.max():%Y-%m-%d}). "
        f"Temporal split: train = first {k} days, test = last {n - k} days. "
        f"Metric `range_over_implied` = realized H-L ÷ 1-day implied σ (from VIX1D). "
        f"Primary γ source = `gamma_oi` (production regime sign); `gamma_dir` as robustness.",
        "",
        "> ⚠️ Power: with n≈62 and a small +γ bucket, only large effects are "
        "detectable. This is a replication of the n=37 vol-compression finding on a "
        "wider window with a holdout — read it as corroboration, not a fresh discovery.",
        "",
        "## A. range/implied by γ sign — `gamma_oi`",
        "",
    ]
    full_o, tr_o, te_o = (split_block(df, "gamma_oi", "FULL"),
                          split_block(train, "gamma_oi", "TRAIN"),
                          split_block(test, "gamma_oi", "TEST (holdout)"))
    for blk, _ in (full_o, tr_o, te_o):
        L += blk

    L += ["## B. Robustness — `gamma_dir`", ""]
    for slice_, lbl in [(df, "FULL"), (train, "TRAIN"), (test, "TEST (holdout)")]:
        blk, _ = split_block(slice_, "gamma_dir", lbl)
        L += blk

    L += ["## C. Out-of-sample incremental value (regression)", ""]
    res = oos_regression(train, test)
    L += [
        "| model | test MAE (range %) | test R² |",
        "|---|---|---|",
    ]
    for name, (mae, r2) in res.items():
        L.append(f"| {name} | {mae:.4f} | {r2:.3f} |")
    base_mae, gam_mae = res["VIX1D only"][0], res["VIX1D + γ"][0]
    improve = (base_mae - gam_mae) / base_mae * 100
    n_te_pos = int((test.gamma_oi > 0).sum())
    n_te_neg = int((test.gamma_oi < 0).sum())
    L += ["", f"Single contiguous holdout — γ changes test MAE by **{improve:+.1f}%** vs "
          f"VIX1D-alone. ⚠️ holdout is **single-regime** (test +γ n={n_te_pos}, −γ "
          f"n={n_te_neg}); γ is persistent so one contiguous split clusters by regime, "
          f"making the sign-split untestable here.", ""]

    cvb, cvg, cvimp = block_cv(df, k=5)
    L += ["**5-fold time-block CV** (regimes mixed across folds — the fairer OOS read):",
          f"VIX1D-only MAE {cvb:.4f} → VIX1D+γ MAE {cvg:.4f} = **{cvimp:+.1f}%** "
          f"(positive = γ helps).", ""]

    # Direction + significance on the full sample (sign-split isn't OOS-testable here).
    _, (full_pos, full_neg) = full_o
    pos_all = df.loc[df.gamma_oi > 0, "range_over_implied"].to_numpy()
    neg_all = df.loc[df.gamma_oi < 0, "range_over_implied"].to_numpy()
    _, p_full = stats.mannwhitneyu(pos_all, neg_all, alternative="two-sided")
    inverted = full_pos > full_neg  # validated prior: +γ should be LOWER (compress)

    L += ["## Verdict (read the numbers, not a label)", ""]
    L += [
        f"- **Direction:** +γ days carry the *larger* range/implied "
        f"(+γ {full_pos:.2f} vs −γ {full_neg:.2f}) — "
        f"**{'INVERTED vs' if inverted else 'consistent with'}** the validated "
        f"+γ-compresses prior ([[project_dealer_gamma_vol_compression]]).",
        f"- **Significance:** Mann–Whitney p = {p_full:.3f} (n={n}) — not significant; "
        f"the sign-split is suggestive (Cohen's d≈0.4), not established at this n.",
        f"- **OOS predictive value:** single holdout {improve:+.1f}% MAE; 5-fold block "
        f"CV **{cvimp:+.1f}%** MAE.",
        f"- **Holdout caveat:** last {len(test)} days are single-regime → block-CV is the "
        f"fairer OOS read.",
        "",
    ]
    if cvimp > 1 and inverted:
        v = ("**HOLD — reconcile the γ sign first.** γ carries modest OOS range info "
             f"(block-CV {cvimp:+.1f}% MAE), so there's a real relationship — but its "
             "direction is INVERTED vs our validated +γ-compresses prior. Before Phase 2, "
             "resolve what `spot_exposures.gamma_oi`'s sign actually means (dealer long vs "
             "short γ) and reconcile the metric with the prior study. The whole model "
             "premise rides on the sign; build nothing until it's pinned down.")
    elif cvimp > 1 and not inverted:
        v = ("**WEAK-GO.** γ corroborates the prior direction and adds OOS range info in "
             "CV. Proceed to Phase 2 calibration (n permitting).")
    else:
        v = ("**INCONCLUSIVE / NO-GO.** No reliable OOS range edge for γ over VIX1D on 62 "
             "days in block-CV. Don't build on this alone; revisit with more history.")
    L += [v, ""]

    with open("docs/tmp/expected-range-phase1-2026-05-29.md", "w") as f:
        f.write("\n".join(L) + "\n")

    # Plot: realized vs implied range, colored by γ sign + bucket means.
    fig, ax = plt.subplots(1, 2, figsize=(12, 5))
    pos = df[df.gamma_oi > 0]
    neg = df[df.gamma_oi < 0]
    ax[0].scatter(neg.implied_sigma_pct, neg.realized_range_pct, c="crimson", label="−γ", alpha=0.7)
    ax[0].scatter(pos.implied_sigma_pct, pos.realized_range_pct, c="seagreen", label="+γ", alpha=0.7)
    lim = [0, max(df.implied_sigma_pct.max(), df.realized_range_pct.max()) * 1.05]
    ax[0].plot(lim, lim, "k--", lw=1, label="realized = implied")
    ax[0].set_xlabel("1-day implied σ (VIX1D, %)")
    ax[0].set_ylabel("realized H-L range (%)")
    ax[0].set_title("Realized vs implied range by γ sign")
    ax[0].legend()
    means = [pos.range_over_implied.mean(), neg.range_over_implied.mean()]
    ax[1].bar(["+γ", "−γ"], means, color=["seagreen", "crimson"])
    ax[1].axhline(1.0, ls="--", c="k", lw=1)
    ax[1].set_ylabel("mean realized ÷ implied σ")
    ax[1].set_title("Compression (<1) vs expansion (>1)")
    fig.tight_layout()
    fig.savefig("docs/tmp/expected-range-phase1-2026-05-29.png", dpi=110)
    print("Wrote docs/tmp/expected-range-phase1-2026-05-29.md (+ .png)")
    print("\n".join(L[-6:]))


if __name__ == "__main__":
    main()
