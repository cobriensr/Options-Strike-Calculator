"""
Bot EOD options flow — leave-one-out stability check.

For each of the N trading days, recompute the premium-threshold sweep
on the remaining N-1 days. The spread of per-cell touch rates across
those N runs tells us whether the headline finding (premium scaling
at 0.3-1% OTM) is a cross-session effect or a lucky day artifact.

Interpretation guide:
  - LOO range <  5 pp  → rock-solid, 1 day's data doesn't move it
  - LOO range  5-15 pp → moderate day-dependence; signal real but shaky
  - LOO range > 15 pp  → fragile; pattern driven by 1-2 specific days

Uses pre-computed path stats (computed once on all 8 days); each LOO
run just filters out one day and re-aggregates. That's O(n_cells)
work per LOO, not O(full path computation).

Outputs under `ml/plots/eod-flow-stability/`:
  stability_{N}min.csv          — per (symbol, distance, threshold) with
                                   mean/min/max/std across LOO runs.
  stability_sweep_{N}min.png   — threshold-sweep plot with min/max bands
  signal_cells_{N}min.txt      — console-style summary of key cells

Usage:
  ml/.venv/bin/python src/eod_flow_stability.py
"""

from __future__ import annotations

import sys
import time

try:
    import duckdb
    import matplotlib.pyplot as plt
    import pandas as pd
    import seaborn as sns
except ImportError as e:
    print(f"Missing dependency: {e}")
    sys.exit(1)

from eod_flow_forward_returns import (  # noqa: E402
    _attach_direction_and_signed,
    _attach_forward_returns,
    _attach_path_stats,
    _load_minute_spot,
)
from eod_flow_premium_threshold import (  # noqa: E402
    DISTANCE_BUCKETS,
    MIN_CELL_N,
    PREMIUM_THRESHOLDS,
    _assign_buckets,
    _distance_bucket_labels,
    _load_all_otm_buckets,
)
from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

FLOW_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow"
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-stability"
PLOT_ROOT.mkdir(parents=True, exist_ok=True)

BUCKET_SIZES: tuple[int, ...] = (1, 5)

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
        "font.size": 9,
        "text.parse_math": False,
    }
)


# ── Core loop ─────────────────────────────────────────────


def _sweep(df: pd.DataFrame) -> pd.DataFrame:
    """Threshold sweep: for each (symbol, distance, threshold) cell,
    compute touch rate over candidates meeting the cumulative filter.
    """
    rows = []
    for sym in sorted(df["symbol"].dropna().unique()):
        for _lo, _hi, dist_label in DISTANCE_BUCKETS:
            for threshold in PREMIUM_THRESHOLDS:
                cell = df[
                    (df["symbol"] == sym)
                    & (df["distance_bucket"] == dist_label)
                    & (df["total_premium"] >= threshold)
                ]
                if len(cell) < MIN_CELL_N:
                    continue
                rows.append(
                    {
                        "symbol": sym,
                        "distance_bucket": dist_label,
                        "threshold": threshold,
                        "n": len(cell),
                        "touch_pct": float(cell["touched_strike"].mean() * 100),
                    }
                )
    return pd.DataFrame(rows)


def _loo_stability(enriched: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (full_sample_sweep, loo_long_df). loo_long_df has one
    row per (exclude_date, symbol, distance, threshold)."""
    full = _sweep(enriched)
    dates = sorted(enriched["date"].unique())
    loo_frames = []
    for d in dates:
        sub = enriched[enriched["date"] != d]
        run = _sweep(sub)
        run["exclude_date"] = str(d)
        loo_frames.append(run)
    loo = pd.concat(loo_frames, ignore_index=True)
    return full, loo


def _summarize_stability(full: pd.DataFrame, loo: pd.DataFrame) -> pd.DataFrame:
    """Join full-sample with LOO mean/min/max/std per cell."""
    agg = (
        loo.groupby(["symbol", "distance_bucket", "threshold"])
        .agg(
            loo_mean=("touch_pct", "mean"),
            loo_min=("touch_pct", "min"),
            loo_max=("touch_pct", "max"),
            loo_std=("touch_pct", "std"),
            loo_runs=("touch_pct", "count"),
        )
        .reset_index()
    )
    agg["loo_range"] = agg["loo_max"] - agg["loo_min"]
    merged = agg.merge(
        full[["symbol", "distance_bucket", "threshold", "touch_pct", "n"]].rename(
            columns={"touch_pct": "full_sample_touch_pct", "n": "full_sample_n"}
        ),
        on=["symbol", "distance_bucket", "threshold"],
        how="left",
    )
    merged["verdict"] = merged["loo_range"].map(
        lambda r: "robust" if r < 5 else ("moderate" if r < 15 else "fragile")
    )
    return merged.sort_values(["symbol", "distance_bucket", "threshold"]).reset_index(
        drop=True
    )


# ── Plotting ──────────────────────────────────────────────


def _plot_stability_sweep(
    full: pd.DataFrame, loo: pd.DataFrame, bucket_min: int
) -> None:
    """Per symbol, one panel: threshold-sweep lines with min/max LOO bands."""
    symbols = sorted(full["symbol"].dropna().unique())
    if not symbols:
        return
    fig, axes = plt.subplots(
        1,
        len(symbols),
        figsize=(5.2 * len(symbols), 4.5),
        sharey=True,
        constrained_layout=True,
    )
    if len(symbols) == 1:
        axes = [axes]

    cmap = plt.get_cmap("viridis")
    dist_labels = _distance_bucket_labels()
    agg = (
        loo.groupby(["symbol", "distance_bucket", "threshold"])
        .agg(loo_min=("touch_pct", "min"), loo_max=("touch_pct", "max"))
        .reset_index()
    )

    for ax, sym in zip(axes, symbols, strict=True):
        for i, dist in enumerate(dist_labels):
            full_line = full[
                (full["symbol"] == sym) & (full["distance_bucket"] == dist)
            ].sort_values("threshold")
            band = agg[
                (agg["symbol"] == sym) & (agg["distance_bucket"] == dist)
            ].sort_values("threshold")
            if full_line.empty:
                continue
            color = cmap(i / max(len(dist_labels) - 1, 1))
            ax.plot(
                full_line["threshold"],
                full_line["touch_pct"],
                marker="o",
                color=color,
                linewidth=1.5,
                label=dist,
            )
            if not band.empty:
                ax.fill_between(
                    band["threshold"],
                    band["loo_min"],
                    band["loo_max"],
                    color=color,
                    alpha=0.18,
                    linewidth=0,
                )
        ax.set_xscale("log")
        ax.set_xlabel("premium threshold $ (log)")
        ax.set_title(sym, color="#fff")
        ax.axhline(
            15,
            color="#aaa",
            linewidth=0.8,
            linestyle="--",
            alpha=0.5,
            label="~baseline 15%",
        )
        ax.legend(loc="best", fontsize=7, facecolor="#1a1a2e", edgecolor="#555")
    axes[0].set_ylabel("touch % (full sample line, LOO min/max shaded)")
    fig.suptitle(
        f"Leave-one-out stability ({bucket_min}-min buckets) — "
        "shaded band = min/max touch rate across 8 LOO runs",
        color="#fff",
        fontsize=11,
    )
    out = PLOT_ROOT / f"stability_sweep_{bucket_min}min.png"
    plt.savefig(out, dpi=130)
    plt.close(fig)
    print(f"  wrote {out.relative_to(ML_ROOT)}")


# ── Main ──────────────────────────────────────────────────


def _build_spot_cache(
    conn: duckdb.DuckDBPyConnection, dates: list[str]
) -> dict[tuple[str, str], pd.DataFrame]:
    cache: dict[tuple[str, str], pd.DataFrame] = {}
    for d in dates:
        full = _load_minute_spot(conn, d)
        if full.empty:
            continue
        for sym in full["symbol"].unique():
            cache[(sym, d)] = full[full["symbol"] == sym].copy()
    return cache


def main() -> int:
    section("EOD Flow Stability — leave-one-out premium-threshold check")

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute("PRAGMA memory_limit='6GB'")

    all_dates = sorted(
        {p.name.removeprefix("date=") for p in FLOW_PARQUET_ROOT.glob("date=*")}
    )
    print(f"  dates: {len(all_dates)} ({all_dates[0]} … {all_dates[-1]})")

    subsection("Build minute-spot cache")
    t0 = time.monotonic()
    spot_cache = _build_spot_cache(conn, all_dates)
    print(f"  cache entries: {len(spot_cache)} in {time.monotonic() - t0:.1f}s")

    per_bucket_summaries: dict[int, pd.DataFrame] = {}

    for bucket_min in BUCKET_SIZES:
        subsection(f"Enrich + LOO sweep — {bucket_min}-min buckets")
        raw = _load_all_otm_buckets(conn, bucket_min)
        raw["date"] = pd.to_datetime(raw["date"]).dt.date.astype(str)
        t_enrich = time.monotonic()
        enriched = _attach_forward_returns(raw, spot_cache)
        enriched = _attach_direction_and_signed(enriched)
        enriched = _attach_path_stats(enriched, spot_cache)
        enriched = _assign_buckets(enriched)
        print(
            f"  candidates: {len(enriched):,}  "
            f"enriched in {time.monotonic() - t_enrich:.1f}s"
        )

        full, loo = _loo_stability(enriched)
        stability = _summarize_stability(full, loo)
        stability.to_csv(PLOT_ROOT / f"stability_{bucket_min}min.csv", index=False)
        print(f"  wrote stability_{bucket_min}min.csv ({len(stability)} cells)")

        # Focus report: the signal cells in the 0.3-1% OTM band.
        signal = stability[
            stability["distance_bucket"].isin(["0.3-0.5%", "0.5-1%"])
        ].copy()
        signal = signal[signal["loo_runs"] == len(all_dates)]
        signal_cols = [
            "symbol",
            "distance_bucket",
            "threshold",
            "full_sample_n",
            "full_sample_touch_pct",
            "loo_mean",
            "loo_min",
            "loo_max",
            "loo_range",
            "verdict",
        ]
        signal_view = signal[signal_cols].copy()
        for c in (
            "full_sample_touch_pct",
            "loo_mean",
            "loo_min",
            "loo_max",
            "loo_range",
        ):
            signal_view[c] = signal_view[c].round(1)
        print()
        print(f"  Signal cells ({bucket_min}-min), LOO stability:")
        print(signal_view.to_string(index=False))

        _plot_stability_sweep(full, loo, bucket_min)
        per_bucket_summaries[bucket_min] = stability

    conn.close()

    # Headline: count robust vs fragile in the signal band.
    headline_rows = []
    for bm, stab in per_bucket_summaries.items():
        sig = stab[stab["distance_bucket"].isin(["0.3-0.5%", "0.5-1%"])]
        sig = sig[sig["loo_runs"] == len(all_dates)]
        counts = sig["verdict"].value_counts().to_dict()
        headline_rows.append(
            {
                "bucket_min": bm,
                "robust_cells": int(counts.get("robust", 0)),
                "moderate_cells": int(counts.get("moderate", 0)),
                "fragile_cells": int(counts.get("fragile", 0)),
                "total_signal_cells": int(len(sig)),
            }
        )
    headline = pd.DataFrame(headline_rows)
    headline.to_csv(PLOT_ROOT / "verdict_headline.csv", index=False)
    print()
    print("  Verdict headline (signal band: 0.3-1% OTM):")
    print(headline.to_string(index=False))

    save_section_findings(
        "eod_flow_stability",
        {"headline": headline.to_dict(orient="records")},
    )
    takeaway(
        "Leave-one-out stability complete. See "
        f"{PLOT_ROOT.relative_to(ML_ROOT)}/stability_{{N}}min.csv for per-cell "
        "verdicts and stability_sweep_*.png for visual bands."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
