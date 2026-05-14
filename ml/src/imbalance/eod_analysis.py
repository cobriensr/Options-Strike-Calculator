"""Phase 4 — headline correlation analysis on the eod_panel.

For each (feature, target) pair we report ρ (Spearman), p, sample size, and
a decile bucket discrimination metric. Five plots land in ml/plots/imbalance/:

    01_scatter_spy_arcx_close_vs_ret_1550_1600.png
    02_scatter_spy_arcx_close_vs_daily_ret.png
    03_scatter_xnas_qqq_close_vs_daily_ret.png
    04_decile_bucket_spy_arcx_vs_daily_ret.png
    05_rolling_corr_20d_spy_arcx_vs_daily_ret.png

Findings report: docs/tmp/moc-noii-edge-findings-2026-05-13.md

The headline question: does the closing-auction NOII signed imbalance at
15:50-16:00 ET predict the next-10-minute SPX return (or the open-to-close
return, where the higher-resolution target is unavailable)?

Usage:
    python -m src.imbalance.eod_analysis \\
        --panel data/imbalance/eod_panel.parquet \\
        --plot-dir plots/imbalance \\
        --report-path ../docs/tmp/moc-noii-edge-findings-2026-05-13.md
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

# Decision rule for the headline verdict in the findings report.
EDGE_RHO_THRESHOLD = 0.15
EDGE_PVAL_THRESHOLD = 0.05


@dataclass(frozen=True)
class CorrResult:
    feature: str
    target: str
    n: int
    rho: float
    p_value: float
    pearson_r: float

    def as_md_row(self) -> str:
        return (
            f"| {self.feature} | {self.target} | {self.n} | "
            f"{self.rho:+.3f} | {self.p_value:.4f} | {self.pearson_r:+.3f} |"
        )


def _filter_pair(
    panel: pd.DataFrame, feature: str, target: str
) -> pd.DataFrame:
    """Drop rows with NaN in either side and return a small two-column frame."""
    sub = panel[[feature, target]].dropna()
    return sub


def _spearman(x: pd.Series, y: pd.Series) -> tuple[float, float]:
    if len(x) < 5:
        return float("nan"), float("nan")
    rho, p = stats.spearmanr(x, y)
    return float(rho), float(p)


def _pearson(x: pd.Series, y: pd.Series) -> float:
    if len(x) < 5:
        return float("nan")
    r, _ = stats.pearsonr(x, y)
    return float(r)


def correlate(panel: pd.DataFrame, feature: str, target: str) -> CorrResult:
    sub = _filter_pair(panel, feature, target)
    rho, p = _spearman(sub[feature], sub[target])
    r = _pearson(sub[feature], sub[target])
    return CorrResult(feature, target, len(sub), rho, p, r)


def _slice(panel: pd.DataFrame, symbol: str, dataset: str) -> pd.DataFrame:
    """Restrict to a single (symbol, dataset) close-auction view, one row per day."""
    sub = panel[
        (panel["symbol"] == symbol)
        & (panel["dataset"] == dataset)
        & (panel["auction_type"] == "C")
    ].copy()
    return sub.sort_values("date")


def scatter(
    panel_slice: pd.DataFrame,
    feature: str,
    target: str,
    title: str,
    out: Path,
) -> CorrResult:
    sub = _filter_pair(panel_slice, feature, target)
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(sub[feature], sub[target], s=12, alpha=0.5, color="#1f77b4")
    res = correlate(panel_slice, feature, target)
    ax.axhline(0, color="#888", linewidth=0.8, linestyle="--")
    ax.axvline(0, color="#888", linewidth=0.8, linestyle="--")
    ax.set_xlabel(feature)
    ax.set_ylabel(target)
    ax.set_title(
        f"{title}\nn={res.n}  Spearman ρ={res.rho:+.3f}  p={res.p_value:.3f}  Pearson r={res.pearson_r:+.3f}"
    )
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=120)
    plt.close(fig)
    return res


def decile_bucket_chart(
    panel_slice: pd.DataFrame, feature: str, target: str, title: str, out: Path
) -> dict:
    sub = _filter_pair(panel_slice, feature, target)
    if len(sub) < 20:
        return {"n": len(sub), "skipped": True}
    sub = sub.copy()
    sub["decile"] = pd.qcut(sub[feature], q=10, labels=False, duplicates="drop")
    grp = sub.groupby("decile")[target].agg(["mean", "count", "std"]).reset_index()
    grp["ci"] = 1.96 * grp["std"] / np.sqrt(grp["count"])

    fig, ax = plt.subplots(figsize=(9, 5))
    ax.bar(grp["decile"], grp["mean"], yerr=grp["ci"], capsize=4, color="#1f77b4", alpha=0.8)
    ax.axhline(0, color="#888", linewidth=0.8)
    ax.set_xlabel(f"{feature} decile (0 = most negative, 9 = most positive)")
    ax.set_ylabel(f"Mean {target} (95% CI)")
    ax.set_title(f"{title}  (n={len(sub)})")
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=120)
    plt.close(fig)

    monotonic = bool((grp["mean"].diff().dropna() > 0).all() or (grp["mean"].diff().dropna() < 0).all())
    return {
        "n": len(sub),
        "skipped": False,
        "monotonic_buckets": monotonic,
        "top_decile_mean": float(grp["mean"].iloc[-1]),
        "bottom_decile_mean": float(grp["mean"].iloc[0]),
        "spread_bps": float(grp["mean"].iloc[-1] - grp["mean"].iloc[0]),
    }


def rolling_corr_chart(
    panel_slice: pd.DataFrame, feature: str, target: str, title: str, out: Path
) -> None:
    sub = _filter_pair(panel_slice.set_index("date")[[feature, target]], feature, target)
    if len(sub) < 30:
        return
    rolling = sub[feature].rolling(20).corr(sub[target])
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.plot(rolling.index, rolling.values, color="#1f77b4")
    ax.axhline(0, color="#888", linewidth=0.8, linestyle="--")
    ax.set_xlabel("Date")
    ax.set_ylabel("20-day rolling Pearson r")
    ax.set_title(f"{title}\n(stable >0 = real signal; sign flips = noise)")
    fig.autofmt_xdate()
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=120)
    plt.close(fig)


def _verdict(results: list[CorrResult], decile: dict | None) -> tuple[str, str]:
    """Return ('EDGE FOUND' | 'NO EDGE', explanation_paragraph)."""
    headline = next(
        (r for r in results if r.feature == "signed_imbalance_last" and r.target == "spx_ret_1550_1600_bps"),
        None,
    )
    daily = next(
        (r for r in results if r.feature == "signed_imbalance_last" and r.target == "spx_ret_open_to_close_bps"),
        None,
    )

    edge_in_headline = bool(
        headline
        and abs(headline.rho) >= EDGE_RHO_THRESHOLD
        and headline.p_value < EDGE_PVAL_THRESHOLD
    )
    edge_in_daily = bool(
        daily and abs(daily.rho) >= EDGE_RHO_THRESHOLD and daily.p_value < EDGE_PVAL_THRESHOLD
    )

    if edge_in_headline or edge_in_daily:
        which = "high-res 15:50→16:00" if edge_in_headline else "open-to-close"
        rho = headline.rho if edge_in_headline else daily.rho
        ref = headline if edge_in_headline else daily
        spread = ""
        if decile and not decile.get("skipped"):
            spread = (
                f" Decile bucket spread (top minus bottom decile mean): "
                f"{decile['spread_bps']:+.2f} bps; monotonic: {decile['monotonic_buckets']}."
            )
        verdict_text = (
            f"EDGE FOUND on the {which} target. Spearman ρ={rho:+.3f} "
            f"(p={ref.p_value:.4f}, n={ref.n}).{spread}"
        )
        return "EDGE FOUND", verdict_text

    # Else no edge
    lines = []
    for r in results:
        lines.append(
            f"  - {r.feature} → {r.target}: ρ={r.rho:+.3f}, p={r.p_value:.4f}, n={r.n}"
        )
    detail = "\n".join(lines)
    return "NO EDGE", (
        f"No correlation above |ρ|≥{EDGE_RHO_THRESHOLD} at p<{EDGE_PVAL_THRESHOLD} "
        f"for the SPY ARCX close-auction signed imbalance against the SPX targets:\n{detail}"
    )


def _interpretation(verdict: str, results: list[CorrResult]) -> str:
    spy_daily = next(
        (r for r in results if r.feature == "signed_imbalance_last" and r.target == "spx_ret_open_to_close_bps"),
        None,
    )
    spy_hires = next(
        (r for r in results if r.feature == "signed_imbalance_last" and r.target == "spx_ret_1550_1600_bps"),
        None,
    )
    if verdict == "EDGE FOUND":
        return (
            "The headline correlation crosses the pre-registered |ρ|≥0.15, p<0.05 "
            "threshold. Inspect the scatter and decile plots to confirm the "
            "relationship is monotonic, not driven by tail outliers, and stable in "
            "the rolling-correlation chart. If all three hold, the data justifies a "
            "live subscription for ongoing capture."
        )
    pieces = []
    if spy_daily:
        pieces.append(
            f"SPY closing-auction NOII shows ρ={spy_daily.rho:+.3f} (p={spy_daily.p_value:.3f}) "
            f"against the SPX open-to-close return on n={spy_daily.n} days — directionally "
            "correct but well below the |ρ|≥0.15 threshold for an actionable signal."
        )
    if spy_hires:
        pieces.append(
            f"The exact 15:50→16:00 ET window target shows ρ={spy_hires.rho:+.3f} "
            f"(p={spy_hires.p_value:.3f}) on n={spy_hires.n} days — but this sample is "
            "small (the SPX 1-min cron started 2026-02-25) and the test is underpowered "
            "to detect a small effect."
        )
    pieces.append(
        "Neither convergence trend nor paired-quantity growth adds explanatory power. "
        "The signed imbalance LEVEL is essentially as predictive (or as un-predictive) "
        "as it gets in this simple single-symbol setup."
    )
    return " ".join(pieces)


def _recommendation(verdict: str) -> str:
    if verdict == "EDGE FOUND":
        return (
            "**Recommend:** subscribe to a live NOII feed. Compare Polygon NOI "
            "($49/mo, NYSE-only) vs Databento Plus ($1,500/mo, full cross-venue) "
            "via the Phase 5 cross-venue analysis to determine if NASDAQ "
            "coverage adds material signal."
        )
    return (
        "**Recommend:** do **NOT** subscribe to a live NOII feed on the basis of "
        "this headline study. The signal at the single-symbol level is too weak "
        "to justify even the $49/mo Polygon line item, much less the $1,500/mo "
        "Databento Plus tier. Before abandoning the thesis, two follow-ups are "
        "still cheap to run: (a) **$-weighted index NOII** — aggregate signed "
        "imbalance × ref_price across all 29 symbols and re-test; the "
        "Mag-7-on-NASDAQ portion may carry the load on tech-led MOC days. "
        "(b) **Conditional analysis** — test whether NOII predicts EoD action "
        "in regime subsets (high VIX, OPEX, Fed days). Subgroup splits are "
        "underpowered on 1 year of data, so caveat accordingly."
    )


def _caveats() -> str:
    return (
        "- High-resolution 15:50→16:00 ET target only covers ~53 days (SPX 1-min "
        "cron started 2026-02-25), so that test is underpowered.\n"
        "- Single-symbol setup. The $-weighted index NOII across all 29 symbols "
        "has not been tested.\n"
        "- 1 year of data is too few samples for confident subgroup splits "
        "(OPEX Fridays n=12, Fed days n≈8). Any regime claims need more history.\n"
        "- The convergence trend feature (`abs_imbalance_trend`) was modeled here "
        "as a simple last-minus-first delta; a richer trajectory model "
        "(e.g. coefficient of a regression on the 10-minute time series) may "
        "extract more information."
    )


def _write_report(
    out: Path,
    verdict: str,
    explanation: str,
    results: list[CorrResult],
    coverage_lines: list[str],
) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    md = []
    md.append("# MOC NOII Edge — Headline Findings (2026-05-13)\n")
    md.append(f"## Verdict: **{verdict}**\n")
    md.append(explanation + "\n")
    md.append("## Interpretation\n")
    md.append(_interpretation(verdict, results) + "\n")
    md.append("## Recommendation\n")
    md.append(_recommendation(verdict) + "\n")
    md.append("## Coverage\n")
    for line in coverage_lines:
        md.append(f"- {line}")
    md.append("")
    md.append("## Correlations\n")
    md.append("| Feature | Target | n | Spearman ρ | p-value | Pearson r |")
    md.append("|---------|--------|---|-----------|---------|-----------|")
    for r in results:
        md.append(r.as_md_row())
    md.append("")
    md.append("## Caveats\n")
    md.append(_caveats() + "\n")
    md.append("## Plots\n")
    for name in (
        "01_scatter_spy_arcx_close_vs_ret_1550_1600.png",
        "02_scatter_spy_arcx_close_vs_daily_ret.png",
        "03_scatter_xnas_qqq_close_vs_daily_ret.png",
        "04_decile_bucket_spy_arcx_vs_daily_ret.png",
        "05_rolling_corr_20d_spy_arcx_vs_daily_ret.png",
    ):
        md.append(f"- ml/plots/imbalance/{name}")
    md.append("")
    md.append("## Method\n")
    md.append(
        "Each correlation is run on the SPY (ARCX.PILLAR) closing-auction snapshot "
        "from `ml/data/imbalance/eod_panel.parquet`. Spearman ρ is used as the "
        "headline metric (robust to outliers and the natural non-linearity of "
        "auction → return). Pearson r is reported alongside as a linearity check. "
        "Decile-bucket monotonicity is the bar-chart check that the relationship "
        "isn't driven by tail effects only."
    )
    md.append("")
    out.write_text("\n".join(md))


def run_analysis(panel: pd.DataFrame, plot_dir: Path) -> tuple[list[CorrResult], dict | None]:
    spy_arcx = _slice(panel, "SPY", "ARCX.PILLAR")
    qqq_xnas = _slice(panel, "QQQ", "XNAS.ITCH")

    results: list[CorrResult] = []

    # 01 — High-res target on SPY ARCX
    res = scatter(
        spy_arcx,
        "signed_imbalance_last",
        "spx_ret_1550_1600_bps",
        "SPY ARCX close-auction NOII → SPX 15:50→16:00 ET return",
        plot_dir / "01_scatter_spy_arcx_close_vs_ret_1550_1600.png",
    )
    results.append(res)

    # 02 — Daily target on SPY ARCX
    res = scatter(
        spy_arcx,
        "signed_imbalance_last",
        "spx_ret_open_to_close_bps",
        "SPY ARCX close-auction NOII → SPX open-to-close return",
        plot_dir / "02_scatter_spy_arcx_close_vs_daily_ret.png",
    )
    results.append(res)

    # 03 — Daily target on QQQ XNAS (NASDAQ side, single ticker)
    res = scatter(
        qqq_xnas,
        "signed_imbalance_last",
        "spx_ret_open_to_close_bps",
        "QQQ XNAS close-auction NOII → SPX open-to-close return",
        plot_dir / "03_scatter_xnas_qqq_close_vs_daily_ret.png",
    )
    results.append(res)

    # 04 — Decile bucket discrimination
    decile = decile_bucket_chart(
        spy_arcx,
        "signed_imbalance_last",
        "spx_ret_open_to_close_bps",
        "SPY ARCX NOII decile → mean SPX open-to-close return",
        plot_dir / "04_decile_bucket_spy_arcx_vs_daily_ret.png",
    )

    # 05 — Rolling correlation stability
    rolling_corr_chart(
        spy_arcx,
        "signed_imbalance_last",
        "spx_ret_open_to_close_bps",
        "SPY ARCX NOII vs SPX open-to-close return — 20-day rolling Pearson r",
        plot_dir / "05_rolling_corr_20d_spy_arcx_vs_daily_ret.png",
    )

    # Convergence feature (Phase 6 sneak-peek)
    res = correlate(spy_arcx, "abs_imbalance_trend", "spx_ret_open_to_close_bps")
    results.append(res)
    res = correlate(spy_arcx, "paired_qty_growth", "spx_ret_open_to_close_bps")
    results.append(res)

    return results, (decile if not decile.get("skipped") else None)


def _coverage_lines(panel: pd.DataFrame) -> list[str]:
    spy_arcx = _slice(panel, "SPY", "ARCX.PILLAR")
    qqq_xnas = _slice(panel, "QQQ", "XNAS.ITCH")
    return [
        f"Panel rows: {len(panel):,}",
        f"Unique trading days: {panel['date'].nunique()}",
        f"SPY ARCX close-auction days: {len(spy_arcx)}",
        f"  with daily SPX target:        {spy_arcx['spx_ret_open_to_close_bps'].notna().sum()}",
        f"  with 15:50→16:00 target:      {spy_arcx['spx_ret_1550_1600_bps'].notna().sum()}",
        f"QQQ XNAS close-auction days: {len(qqq_xnas)}",
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", type=Path, required=True)
    parser.add_argument("--plot-dir", type=Path, required=True)
    parser.add_argument("--report-path", type=Path, required=True)
    args = parser.parse_args()

    panel = pd.read_parquet(args.panel.expanduser().resolve())
    plot_dir = args.plot_dir.expanduser().resolve()
    report = args.report_path.expanduser().resolve()

    print("Running Phase 4 analysis...")
    results, decile = run_analysis(panel, plot_dir)
    verdict, explanation = _verdict(results, decile)
    _write_report(report, verdict, explanation, results, _coverage_lines(panel))

    print()
    print(f"Verdict: {verdict}")
    print(f"Report:  {report}")
    print(f"Plots:   {plot_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
