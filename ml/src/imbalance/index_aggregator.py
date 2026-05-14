"""Phase 5 — $-weighted index NOII aggregation across all 29 symbols.

For each (date, auction_type='C') we compute a notional-weighted aggregate of
signed_imbalance across three venue groupings:

    NYSE+ARCA only       — Polygon NOI equivalent ($49/mo product coverage)
                            Symbols: SPY, IWM, VOO, DIA (ARCX) + 13 NYSE
                            single names (XNYS)
    NASDAQ only          — what Polygon does NOT cover
                            Symbols: QQQ + 11 NASDAQ-listed mega-caps (XNAS)
    All venues combined  — what Databento Plus would deliver live ($1,500/mo)

Each symbol's notional contribution is `signed_imbalance × ref_price`. The
$-weighted sum gives us a single index-level NOII per (date, group). We then
correlate that against the same SPX targets as Phase 4 and report whether
the cross-venue aggregation crosses the |ρ|≥0.15 threshold that single
symbols failed to cross.

Decision rule from the spec:
    R²(all) / R²(NYSE+ARCA) > 1.15  →  NASDAQ adds material signal
    Else                            →  Polygon NOI ($49) is sufficient

Usage:
    python -m src.imbalance.index_aggregator \\
        --panel data/imbalance/eod_panel.parquet \\
        --report-path ../docs/tmp/moc-noii-edge-findings-2026-05-13.md
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from scipy import stats

# Primary venue per symbol. NASDAQ runs UTP crosses for many NYSE-listed and
# Arca-listed names, but those messages are mostly status pings with zero
# imbalance — the real auction lives on the primary listing venue.
PRIMARY_VENUE: dict[str, str] = {
    # Arca-listed ETFs
    "SPY": "ARCX.PILLAR",
    "IWM": "ARCX.PILLAR",
    "VOO": "ARCX.PILLAR",
    "DIA": "ARCX.PILLAR",
    # NASDAQ-listed
    "QQQ": "XNAS.ITCH",
    "AAPL": "XNAS.ITCH",
    "MSFT": "XNAS.ITCH",
    "NVDA": "XNAS.ITCH",
    "META": "XNAS.ITCH",
    "AMZN": "XNAS.ITCH",
    "GOOGL": "XNAS.ITCH",
    "GOOG": "XNAS.ITCH",
    "TSLA": "XNAS.ITCH",
    "AVGO": "XNAS.ITCH",
    "COST": "XNAS.ITCH",
    "NFLX": "XNAS.ITCH",
    # NYSE-listed
    "BRK.B": "XNYS.PILLAR",
    "JPM": "XNYS.PILLAR",
    "LLY": "XNYS.PILLAR",
    "V": "XNYS.PILLAR",
    "XOM": "XNYS.PILLAR",
    "UNH": "XNYS.PILLAR",
    "WMT": "XNYS.PILLAR",
    "MA": "XNYS.PILLAR",
    "PG": "XNYS.PILLAR",
    "HD": "XNYS.PILLAR",
    "JNJ": "XNYS.PILLAR",
    "BAC": "XNYS.PILLAR",
    "ABBV": "XNYS.PILLAR",
}

NYSE_ARCA_GROUP: set[str] = {
    s for s, v in PRIMARY_VENUE.items() if v in ("XNYS.PILLAR", "ARCX.PILLAR")
}
NASDAQ_GROUP: set[str] = {s for s, v in PRIMARY_VENUE.items() if v == "XNAS.ITCH"}
ALL_SYMBOLS: set[str] = set(PRIMARY_VENUE)


@dataclass(frozen=True)
class AggCorr:
    group: str
    feature: str
    target: str
    n: int
    rho: float
    p_value: float
    r_squared: float

    def as_md_row(self) -> str:
        return (
            f"| {self.group} | {self.feature} | {self.target} | {self.n} | "
            f"{self.rho:+.3f} | {self.p_value:.4f} | {self.r_squared:.4f} |"
        )


def _filter_primary(panel: pd.DataFrame) -> pd.DataFrame:
    """Keep only rows where the row's (symbol, dataset) matches the primary
    listing venue. Drops the NASDAQ-Cross-for-NYSE-listed rows (mostly noise)."""
    primary_pairs = set(PRIMARY_VENUE.items())
    return panel[
        panel[["symbol", "dataset"]].apply(tuple, axis=1).isin(primary_pairs)
    ].copy()


def aggregate_notional(
    panel: pd.DataFrame, symbols: set[str], position: str
) -> pd.DataFrame:
    """Sum `signed_imbalance_{position} × ref_price_{position}` across the
    given symbols, per (date) for close-auction snapshots.

    `position` must be 'first' or 'last' to pick the at-15:50 or at-15:59
    snapshot per the snapshot schema.

    Returns a DataFrame indexed by date with a single `notional` column
    (dollars of signed imbalance)."""
    if position not in ("first", "last"):
        raise ValueError(f"position must be 'first' or 'last', got {position!r}")
    qty_col = f"signed_imbalance_{position}"
    px_col = f"ref_price_{position}"

    sub = panel[(panel["auction_type"] == "C") & (panel["symbol"].isin(symbols))].copy()
    # Drop rows missing either side of the multiplication
    sub = sub.dropna(subset=[qty_col, px_col])
    sub["notional"] = sub[qty_col] * sub[px_col]
    agg = sub.groupby("date", as_index=True)["notional"].sum().to_frame()
    return agg


def correlate_group(
    panel: pd.DataFrame,
    targets: pd.DataFrame,
    group_name: str,
    symbols: set[str],
    position: str,
    target_col: str,
) -> AggCorr:
    """Aggregate notional for a group and correlate against a target column.

    `targets` is the per-(date,symbol,auction_type) panel — we take the
    median value of `target_col` per date because every (symbol, auction)
    row shares the same date-level SPX target (left-joined upstream)."""
    agg = aggregate_notional(panel, symbols, position)
    daily_target = targets.groupby("date")[target_col].first()
    joined = agg.join(daily_target.rename("target")).dropna()
    if len(joined) < 5:
        return AggCorr(
            group_name,
            f"notional_{position}",
            target_col,
            len(joined),
            float("nan"),
            float("nan"),
            float("nan"),
        )
    rho, p = stats.spearmanr(joined["notional"], joined["target"])
    # R² of an OLS-equivalent univariate regression
    r, _ = stats.pearsonr(joined["notional"], joined["target"])
    return AggCorr(
        group=group_name,
        feature=f"notional_{position}",
        target=target_col,
        n=len(joined),
        rho=float(rho),
        p_value=float(p),
        r_squared=float(r) ** 2,
    )


def run_phase5(panel: pd.DataFrame) -> tuple[list[AggCorr], dict]:
    """Run the full Phase-5 comparison and return all correlations + the
    decision dict."""
    panel = _filter_primary(panel)

    groups = {
        "NYSE+ARCA only": NYSE_ARCA_GROUP,
        "NASDAQ only": NASDAQ_GROUP,
        "All venues": ALL_SYMBOLS,
    }
    targets = ["spx_ret_open_to_close_bps", "spx_ret_1550_1600_bps"]
    positions = ["first", "last"]

    results: list[AggCorr] = []
    for group_name, syms in groups.items():
        for tgt in targets:
            for pos in positions:
                results.append(
                    correlate_group(panel, panel, group_name, syms, pos, tgt)
                )

    # Build decisions for BOTH positions:
    #   - notional_first: live-actionable at 15:50:00 ET (predictive)
    #   - notional_last:  converged state at 15:59:59 (mostly explanatory)
    def _pick(group: str, position: str) -> AggCorr | None:
        return next(
            (
                r
                for r in results
                if r.group == group
                and r.feature == f"notional_{position}"
                and r.target == "spx_ret_open_to_close_bps"
            ),
            None,
        )

    def _build_decision(position: str, kind_label: str) -> dict:
        nyse = _pick("NYSE+ARCA only", position)
        all_v = _pick("All venues", position)
        nyse_r2 = nyse.r_squared if nyse else float("nan")
        all_r2 = all_v.r_squared if all_v else float("nan")
        ratio = (all_r2 / nyse_r2) if (nyse and nyse_r2 > 0) else float("nan")
        adds = bool(
            ratio > 1.15
            and (all_v.p_value if all_v else 1.0) < 0.10
            and abs(all_v.rho if all_v else 0) > 0.15
        )
        return {
            "position": position,
            "kind": kind_label,
            "nyse_r2": nyse_r2,
            "all_r2": all_r2,
            "ratio": ratio,
            "nasdaq_adds_material_info": adds,
        }

    predictive = _build_decision(
        "first", "predictive (15:50:00 first print, live-actionable)"
    )
    explanatory = _build_decision("last", "explanatory (15:59:59 converged, post-hoc)")

    if predictive["nasdaq_adds_material_info"]:
        rec = (
            "Predictive index-aggregate NOII (15:50 first print) shows NASDAQ "
            "adding material signal beyond NYSE+ARCA. Live trading edge "
            "justifies Databento Plus ($1,500/mo) - Polygon NOI ($49/mo, "
            "NYSE-only) would miss the actionable Mag-7 portion."
        )
    elif explanatory["nasdaq_adds_material_info"]:
        rec = (
            "At the LIVE-ACTIONABLE (15:50 first print) level, NASDAQ does "
            "NOT add material predictive signal beyond NYSE+ARCA. The post-hoc "
            "(15:59 converged) aggregate DOES improve with NASDAQ inclusion "
            "(ρ "
            f"{(_pick('All venues', 'last').rho if _pick('All venues', 'last') else 0):+.3f} "
            "vs "
            f"{(_pick('NYSE+ARCA only', 'last').rho if _pick('NYSE+ARCA only', 'last') else 0):+.3f}), "
            "but that's a CONSEQUENCE of the day's tape rather than a leading "
            "signal. **Conclusion: Polygon NOI ($49/mo) is sufficient if a "
            "live subscription is ever justified; Databento Plus does not pay "
            "for itself on this signal alone.**"
        )
    else:
        rec = (
            "NASDAQ does NOT add material signal beyond NYSE+ARCA aggregation "
            "in either the predictive (first print) or explanatory (converged) "
            "feature. Polygon NOI ($49/mo, NYSE-only) is sufficient if a live "
            "subscription is ever justified. Databento Plus is overkill."
        )

    return results, {
        "predictive": predictive,
        "explanatory": explanatory,
        "recommendation": rec,
    }


def _decision_block(decision: dict) -> list[str]:
    threshold = "Threshold: ratio > 1.15 AND |ρ| > 0.15 AND p < 0.10"
    return [
        f"#### {decision['kind']}\n",
        f"- R²(NYSE+ARCA): **{decision['nyse_r2']:.4f}**",
        f"- R²(All venues): **{decision['all_r2']:.4f}**",
        f"- Ratio: **{decision['ratio']:.3f}**",
        f"- {threshold}",
        f"- NASDAQ adds material info? **{decision['nasdaq_adds_material_info']}**",
        "",
    ]


def append_phase5_section(report: Path, results: list[AggCorr], decision: dict) -> None:
    """Append Phase 5 section to the existing findings report."""
    if not report.exists():
        raise FileNotFoundError(report)
    md = ["", "## Phase 5 — $-Weighted Index NOII Aggregation\n"]
    md.append(
        "Aggregates `signed_imbalance × ref_price` across multiple symbols "
        "per venue grouping, then correlates the $-weighted notional against "
        "the same SPX targets. The hypothesis: index-level aggregation may "
        "show signal that single-symbol views miss, especially on tech-led "
        "MOC days where Mag-7 carries the imbalance.\n"
    )

    md.append("### Decisions\n")
    md.extend(_decision_block(decision["predictive"]))
    md.extend(_decision_block(decision["explanatory"]))

    md.append("### Recommendation\n")
    md.append(decision["recommendation"])
    md.append("")

    md.append("### Full correlation table\n")
    md.append("| Group | Feature | Target | n | Spearman ρ | p-value | R² |")
    md.append("|-------|---------|--------|---|-----------|---------|-----|")
    for r in results:
        md.append(r.as_md_row())
    md.append("")

    existing = report.read_text().rstrip()
    report.write_text(existing + "\n" + "\n".join(md))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", type=Path, required=True)
    parser.add_argument("--report-path", type=Path, required=True)
    args = parser.parse_args()

    panel = pd.read_parquet(args.panel.expanduser().resolve())
    report = args.report_path.expanduser().resolve()

    print("Running Phase 5 — cross-venue aggregation...")
    results, decision = run_phase5(panel)
    append_phase5_section(report, results, decision)

    for key in ("predictive", "explanatory"):
        d = decision[key]
        print()
        print(f"{d['kind']}")
        print(f"  R² NYSE+ARCA: {d['nyse_r2']:.4f}")
        print(f"  R² All venues: {d['all_r2']:.4f}")
        print(
            f"  Ratio: {d['ratio']:.3f}  →  NASDAQ adds material info? {d['nasdaq_adds_material_info']}"
        )
    print()
    print(decision["recommendation"])
    print()
    print(f"Phase 5 section appended to {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
