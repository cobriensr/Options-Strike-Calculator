"""
Phase 4 EDA — baseline label slices (no PNG features yet).

Computes the pin outcome labels from OHLC alone and slices the pin rate by
regime + event flags + day-of-week. This is the cheapest possible EDA: it
needs no pixel extraction, only the candidate-days CSV that's already
populated by the enricher. The output sets the base rate + conditional
rates that any chart-feature-derived signal will have to BEAT to justify
the screenshot pipeline.

Inputs:
    scripts/charm-pressure-capture/candidate-days.csv
    scripts/delta-pressure-capture/candidate-days.csv
    scripts/gamma-capture/candidate-days.csv

Outputs:
    scripts/charm-pressure-capture/findings/phase4-baseline-labels.md
    scripts/charm-pressure-capture/findings/phase4-baseline-labels.json
    scripts/charm-pressure-capture/plots/pin_rate_by_regime.png
    scripts/charm-pressure-capture/plots/pin_distance_distribution.png
    scripts/charm-pressure-capture/plots/realized_range_by_regime.png

Run with:
    ml/.venv/bin/python scripts/charm-pressure-capture/eda_baseline_labels.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CHARM_CSV = ROOT / "scripts/charm-pressure-capture/candidate-days.csv"
DELTA_CSV = ROOT / "scripts/delta-pressure-capture/candidate-days.csv"
GAMMA_CSV = ROOT / "scripts/gamma-capture/candidate-days.csv"

OUT_DIR = ROOT / "scripts/charm-pressure-capture/findings"
PLOT_DIR = ROOT / "scripts/charm-pressure-capture/plots"
OUT_DIR.mkdir(parents=True, exist_ok=True)
PLOT_DIR.mkdir(parents=True, exist_ok=True)

# Pin definition — committed in the spec.
# Soft pin: |spx_close - nearest_25pt_strike| <= $5
# Tight pin: same with $2 tolerance (secondary metric)
SOFT_PIN_TOL = 5.0
TIGHT_PIN_TOL = 2.0
STRIKE_GRID = 25.0


def nearest_strike(close: float) -> float:
    """SPX 25-pt strike grid: round to nearest multiple of 25."""
    return round(close / STRIKE_GRID) * STRIKE_GRID


def pin_distance(close: float) -> float:
    """Signed distance from close to the nearest 25-pt strike. abs() ≤ 12.5 by construction."""
    return close - nearest_strike(close)


def load_charm() -> pd.DataFrame:
    """Charm CSV is the canonical source for OHLC + regime + event flags + labels.
    Delta/gamma CSVs were seeded from charm's CSV and have identical OHLC; we only
    load charm here since the labels are chart-independent.
    """
    df = pd.read_csv(CHARM_CSV)
    df = df[df["selected"] == "Y"].copy()
    # Coerce numerics — the CSV stores them as strings.
    for col in ["spx_open", "spx_high", "spx_low", "spx_close", "spx_prev_close",
                "realized_range_dollars", "realized_range_pct"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ["is_fomc", "is_cpi", "is_nfp", "is_monthly_opex",
                "is_quarterly_opex", "is_half_day", "is_event"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)
    df["date"] = pd.to_datetime(df["date"])
    return df


def compute_labels(df: pd.DataFrame) -> pd.DataFrame:
    """Add pin_realized_strike, pin_distance_close, pin_realized (binary, ≤$5),
    pin_realized_tight (binary, ≤$2)."""
    df = df.copy()
    df["pin_realized_strike"] = df["spx_close"].apply(nearest_strike)
    df["pin_distance_close"] = df["spx_close"].apply(pin_distance)
    df["abs_pin_distance"] = df["pin_distance_close"].abs()
    df["pin_realized"] = (df["abs_pin_distance"] <= SOFT_PIN_TOL).astype(int)
    df["pin_realized_tight"] = (df["abs_pin_distance"] <= TIGHT_PIN_TOL).astype(int)
    return df


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion. Better than normal-approx
    for small n where p is near 0 or 1 — and we have plenty of small subsamples."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z**2 / n
    center = p + z**2 / (2 * n)
    spread = z * np.sqrt(p * (1 - p) / n + z**2 / (4 * n**2))
    return ((center - spread) / denom, (center + spread) / denom)


def slice_table(df: pd.DataFrame, group_col: str, label_col: str = "pin_realized") -> pd.DataFrame:
    """Pin rate by group with sample size and Wilson 95% CI."""
    rows = []
    for grp, sub in df.groupby(group_col):
        n = len(sub)
        k = int(sub[label_col].sum())
        rate = k / n if n else 0.0
        lo, hi = wilson_ci(k, n)
        rows.append({
            "group": grp,
            "n": n,
            "pinned": k,
            "rate": rate,
            "ci_lo": lo,
            "ci_hi": hi,
        })
    return pd.DataFrame(rows).sort_values("group")


def plot_pin_rate_by_regime(slices: pd.DataFrame, base_rate: float, title: str, out_path: Path) -> None:
    """Bar chart of pin rate by regime with Wilson CIs and base-rate reference line."""
    fig, ax = plt.subplots(figsize=(8, 5))
    x = np.arange(len(slices))
    rates = slices["rate"].values
    ci_lo = slices["ci_lo"].values
    ci_hi = slices["ci_hi"].values
    yerr = np.array([rates - ci_lo, ci_hi - rates])
    ax.bar(x, rates, yerr=yerr, capsize=6, color=["#3a7bd5", "#d54a3a", "#888"])
    ax.axhline(base_rate, color="black", linestyle="--", linewidth=1, label=f"Base rate {base_rate:.2f}")
    ax.set_xticks(x)
    labels = [f'{g}\n(n={n})' for g, n in zip(slices["group"], slices["n"])]
    ax.set_xticklabels(labels)
    ax.set_ylabel("Pin rate (≤$5 of nearest 25-pt strike)")
    ax.set_ylim(0, 1)
    ax.set_title(title)
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_pin_distance_distribution(df: pd.DataFrame, out_path: Path) -> None:
    """Histogram of signed pin_distance_close with $5 and $2 tolerance bands."""
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.hist(df["pin_distance_close"], bins=25, edgecolor="white", color="#3a7bd5")
    for tol, color, label in [
        (SOFT_PIN_TOL, "#d54a3a", f"Soft pin ±${SOFT_PIN_TOL:.0f}"),
        (TIGHT_PIN_TOL, "#7d3ad5", f"Tight pin ±${TIGHT_PIN_TOL:.0f}"),
    ]:
        ax.axvline(tol, color=color, linestyle="--", linewidth=1, label=label)
        ax.axvline(-tol, color=color, linestyle="--", linewidth=1)
    ax.set_xlabel("spx_close − nearest_25pt_strike (signed dollars)")
    ax.set_ylabel("Count")
    ax.set_title("Distribution of close-to-strike distance (n=100)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_realized_range_by_regime(df: pd.DataFrame, out_path: Path) -> None:
    """Box plot of realized range % by regime — sanity check that the regime
    classification actually separates calm vs trending days."""
    regimes = sorted(df["regime"].dropna().unique())
    data = [df[df["regime"] == r]["realized_range_pct"].values for r in regimes]
    fig, ax = plt.subplots(figsize=(8, 5))
    bp = ax.boxplot(data, labels=regimes, showmeans=True, patch_artist=True)
    for patch, color in zip(bp["boxes"], ["#3a7bd5", "#d54a3a", "#888"]):
        patch.set_facecolor(color)
        patch.set_alpha(0.6)
    ax.set_ylabel("Realized range %")
    ax.set_title("Realized range by regime (sanity check)")
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def fmt_slice(slices: pd.DataFrame) -> str:
    lines = ["| group | n | pinned | rate | 95% CI |", "|---|---|---|---|---|"]
    for _, row in slices.iterrows():
        lines.append(
            f"| {row['group']} | {row['n']} | {row['pinned']} | "
            f"{row['rate']:.3f} | [{row['ci_lo']:.3f}, {row['ci_hi']:.3f}] |"
        )
    return "\n".join(lines)


def main() -> None:
    df = load_charm()
    df = compute_labels(df)

    n = len(df)
    base_rate = df["pin_realized"].mean()
    base_rate_tight = df["pin_realized_tight"].mean()
    base_lo, base_hi = wilson_ci(int(df["pin_realized"].sum()), n)

    by_regime = slice_table(df, "regime", "pin_realized")
    by_regime_tight = slice_table(df, "regime", "pin_realized_tight")
    by_event = slice_table(df, "is_event", "pin_realized")
    by_fomc = slice_table(df, "is_fomc", "pin_realized")
    by_opex_q = slice_table(df, "is_quarterly_opex", "pin_realized")
    by_opex_m = slice_table(df, "is_monthly_opex", "pin_realized")
    by_dow = slice_table(df, "day_of_week", "pin_realized")

    # Plots
    plot_pin_rate_by_regime(
        by_regime, base_rate,
        f"Pin rate (±$5) by regime — overall base rate {base_rate:.2f}",
        PLOT_DIR / "pin_rate_by_regime.png",
    )
    plot_pin_distance_distribution(df, PLOT_DIR / "pin_distance_distribution.png")
    plot_realized_range_by_regime(df, PLOT_DIR / "realized_range_by_regime.png")

    # Findings JSON (machine readable)
    findings = {
        "phase": "phase4-baseline-labels",
        "n": n,
        "pin_definition": {
            "soft_pin_tol": SOFT_PIN_TOL,
            "tight_pin_tol": TIGHT_PIN_TOL,
            "strike_grid": STRIKE_GRID,
        },
        "base_rate": {
            "soft_5": base_rate,
            "soft_5_ci": [base_lo, base_hi],
            "tight_2": base_rate_tight,
        },
        "pin_distance_stats": {
            "mean": float(df["pin_distance_close"].mean()),
            "median": float(df["pin_distance_close"].median()),
            "std": float(df["pin_distance_close"].std()),
            "abs_mean": float(df["abs_pin_distance"].mean()),
            "abs_median": float(df["abs_pin_distance"].median()),
        },
        "by_regime_soft": by_regime.to_dict(orient="records"),
        "by_regime_tight": by_regime_tight.to_dict(orient="records"),
        "by_event": by_event.to_dict(orient="records"),
        "by_fomc": by_fomc.to_dict(orient="records"),
        "by_quarterly_opex": by_opex_q.to_dict(orient="records"),
        "by_monthly_opex": by_opex_m.to_dict(orient="records"),
        "by_day_of_week": by_dow.to_dict(orient="records"),
    }
    (OUT_DIR / "phase4-baseline-labels.json").write_text(
        json.dumps(findings, indent=2, default=str)
    )

    # Findings markdown (human readable)
    md = f"""# Phase 4 — baseline label slices

**Date:** 2026-04-25
**Sample:** n={n} selected days from charm-pressure-pin-study
**Pin definition:** |spx_close − nearest_25pt_strike| ≤ ${SOFT_PIN_TOL:.0f} (soft), ≤ ${TIGHT_PIN_TOL:.0f} (tight)

## Base rate

- **Soft pin (±$5):** {base_rate:.3f} ({int(df['pin_realized'].sum())}/{n}), Wilson 95% CI [{base_lo:.3f}, {base_hi:.3f}]
- **Tight pin (±$2):** {base_rate_tight:.3f} ({int(df['pin_realized_tight'].sum())}/{n})

A 25-pt strike grid means a UNIFORM-RANDOM close would land within ±$5 with
probability {2 * SOFT_PIN_TOL / STRIKE_GRID:.2f} = {2 * SOFT_PIN_TOL / STRIKE_GRID * 100:.0f}%.
Anything statistically above that is *evidence of clustering at strikes*. Anything below
is evidence of *avoidance*.

## Pin rate × regime (soft, ±$5)

{fmt_slice(by_regime)}

## Pin rate × regime (tight, ±$2)

{fmt_slice(by_regime_tight)}

## Pin rate × is_event (any FOMC / CPI / NFP / quarterly OpEx)

{fmt_slice(by_event)}

## Pin rate × is_fomc

{fmt_slice(by_fomc)}

## Pin rate × is_quarterly_opex

{fmt_slice(by_opex_q)}

## Pin rate × is_monthly_opex

{fmt_slice(by_opex_m)}

## Pin rate × day_of_week

{fmt_slice(by_dow)}

## Pin distance distribution

- Mean (signed): ${df['pin_distance_close'].mean():.2f}
- Median (signed): ${df['pin_distance_close'].median():.2f}
- Std: ${df['pin_distance_close'].std():.2f}
- |Distance| mean: ${df['abs_pin_distance'].mean():.2f}
- |Distance| median: ${df['abs_pin_distance'].median():.2f}

A signed mean far from zero indicates systematic bias (e.g., closes tend to land
above the nearest strike → upward drift on these stratified days). A high |distance|
median means most days don't pin tightly even when they pin softly.

## Plots

- `plots/pin_rate_by_regime.png` — pin rate per regime with Wilson 95% CIs and base-rate reference.
- `plots/pin_distance_distribution.png` — histogram of signed pin distance with ±$5 and ±$2 bands.
- `plots/realized_range_by_regime.png` — box plot of realized range % by regime (sanity check).

## Interpretation cheat-sheet

- **If by_regime shows range_bound >> trending >> event** → regime label discriminates and
  any chart feature has to add lift *conditional on regime*, not unconditionally.
- **If by_regime is flat** → the regime classification didn't separate signal from noise;
  the chart features have a much bigger job (and a much lower prior of finding edge).
- **If is_fomc / is_quarterly_opex shows lower pin rate than base** → events are noise days
  and excluding them sharpens the in-regime study.
- **If pin_distance has signed bias > $1** → there's directional drift in the sample that
  interacts with pin direction; need to control for it in any conditional slicing.

## Caveats

- **Stability% is only populated on 7/100 days** — the gauge isn't rendered for older
  TRACE dates. Stratification by stability tertile is deferred until a stability-rich
  sample is available (likely post-2025-04 dates).
- **spot_at_*_capture columns are stale** (every row reads 7163.85) — DOM-read bug in the
  capture script. Doesn't affect labels (which use OHLC) but invalidates spot-vs-pin features
  until the capture bug is fixed.
- **Selection bucket bias** — the sample was stratified 50/30/20 across regimes; conditional
  rates are unbiased *within* a bucket but not directly comparable to the population pin rate.
"""
    (OUT_DIR / "phase4-baseline-labels.md").write_text(md)

    # Console summary
    print(f"n={n}, soft pin rate={base_rate:.3f} [{base_lo:.3f}, {base_hi:.3f}]")
    print(f"tight pin rate={base_rate_tight:.3f}")
    print(f"|pin distance| median=${df['abs_pin_distance'].median():.2f}, "
          f"mean=${df['abs_pin_distance'].mean():.2f}")
    print()
    print("by regime (soft):")
    print(by_regime.to_string(index=False))
    print()
    print("by is_event:")
    print(by_event.to_string(index=False))
    print()
    print(f"Wrote: {OUT_DIR / 'phase4-baseline-labels.md'}")
    print(f"Wrote: {OUT_DIR / 'phase4-baseline-labels.json'}")
    print(f"Wrote 3 plots: {PLOT_DIR}")


if __name__ == "__main__":
    main()
