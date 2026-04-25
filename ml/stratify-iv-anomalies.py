"""
Phase C of the IV-anomaly signal-vs-price study.

Slices the Phase B backtest output by each of the 8 detector-gate
dimensions to find which gates concentrate winners vs losers. Output
informs production constant tuning per ticker.

Inputs:
    ml/data/iv-anomaly-backtest-2026-04-25.parquet (Phase B output)

Outputs:
    ml/findings/iv-anomaly-stratified-2026-04-25.json
    ml/reports/iv-anomaly-stratified-2026-04-25.md

The 8 questions:
  1. Per-ticker peak-return distribution
  2. Signal-stack stratification (1 reason vs 2 vs 3)
  3. Time-of-day effect (session phase)
  4. Vol/OI threshold tuning
  5. OTM-distance effect
  6. Side-skew sensitivity
  7. flow_phase outcome differentiation
  8. side_dominant effect

For each, computes win rate + mean PnL on the BEST non-oracle strategy
per ticker (carried over from Phase B) so we're comparing actionable
trades, not the cheating-oracle peak ceiling.

Usage:
    ml/.venv/bin/python ml/stratify-iv-anomalies.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
INPUT_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
FINDINGS_PATH = REPO_ROOT / "ml" / "findings" / "iv-anomaly-stratified-2026-04-25.json"
REPORT_PATH = REPO_ROOT / "ml" / "reports" / "iv-anomaly-stratified-2026-04-25.md"

# Per-ticker best non-oracle strategy (computed in Phase B and copied here
# for stratification — different tickers warrant different exit playbooks).
BEST_STRATEGY: dict[str, str] = {
    "NDXP": "pnl_eod",
    "META": "pnl_eod",
    "MSFT": "pnl_eod",
    "MU": "pnl_eod",
    "QQQ": "pnl_eod",
    "SPY": "pnl_eod",
    "SPXW": "pnl_eod",
    "NVDA": "pnl_eod",
    "IWM": "pnl_itm_touch",
    "TSLA": "pnl_itm_touch",
    "MSTR": "pnl_itm_touch",
    "SNDK": "pnl_itm_touch",
    "SMH": "pnl_itm_touch",
}


def load_backtest() -> pd.DataFrame:
    if not INPUT_PATH.exists():
        raise RuntimeError(
            f"Phase B output not found at {INPUT_PATH}. Run backtest-iv-anomalies.py first."
        )
    df = pd.read_parquet(INPUT_PATH)
    print(f"[load] {len(df)} alerts from backtest", file=sys.stderr)

    # Pick the best-strategy PnL per row based on its ticker.
    df["best_pnl"] = df.apply(
        lambda r: r[BEST_STRATEGY.get(r["ticker"], "pnl_eod")], axis=1
    )
    df = df[df["best_pnl"].notna()].copy()
    print(f"[load] {len(df)} valid alerts after dropping no-best-pnl", file=sys.stderr)
    return df


def stratify(df: pd.DataFrame, by: str, bins: list[float] | None = None,
             labels: list[str] | None = None) -> pd.DataFrame:
    """Group by `by` (or by binned numeric), compute win rate + PnL stats."""
    work = df.copy()
    group_col = by
    if bins is not None and labels is not None:
        work[f"{by}_bucket"] = pd.cut(work[by], bins=bins, labels=labels)
        group_col = f"{by}_bucket"
    rows = []
    for k, sub in work.groupby(group_col, observed=True):
        valid = sub["best_pnl"].dropna()
        if len(valid) == 0:
            continue
        rows.append(
            {
                "bucket": str(k),
                "n": len(valid),
                "win_rate": (valid > 0).mean(),
                "win_rate_30pct": (valid >= 0.30).mean(),
                "mean_pnl": valid.mean(),
                "median_pnl": valid.median(),
                "max_loss": valid.min(),
                "max_gain": valid.max(),
            }
        )
    return pd.DataFrame(rows)


def per_ticker_stratify(df: pd.DataFrame, by: str, bins=None, labels=None) -> pd.DataFrame:
    """Stratify but with ticker as a second axis."""
    rows = []
    for ticker, sub in df.groupby("ticker", observed=True):
        slc = stratify(sub, by, bins, labels)
        if slc.empty:
            continue
        slc.insert(0, "ticker", ticker)
        rows.append(slc)
    if not rows:
        return pd.DataFrame()
    return pd.concat(rows, ignore_index=True)


def fmt_pct(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{x * 100:+.1f}%"


def fmt_pct_unsigned(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def render_table(df: pd.DataFrame, group_col: str, title: str) -> str:
    if df.empty:
        return f"### {title}\n\n_No data._\n"
    has_ticker = "ticker" in df.columns
    cols = ["ticker"] if has_ticker else []
    cols += [group_col, "n", "win%", "30%+ win", "mean", "median", "max loss", "max gain"]
    lines = [f"### {title}\n"]
    lines.append("| " + " | ".join(cols) + " |")
    lines.append("| " + " | ".join(["---"] * len(cols)) + " |")
    for _, r in df.iterrows():
        cells = []
        if has_ticker:
            cells.append(str(r["ticker"]))
        cells.append(str(r["bucket"]))
        cells.append(str(r["n"]))
        cells.append(fmt_pct_unsigned(r["win_rate"]))
        cells.append(fmt_pct_unsigned(r["win_rate_30pct"]))
        cells.append(fmt_pct(r["mean_pnl"]))
        cells.append(fmt_pct(r["median_pnl"]))
        cells.append(fmt_pct(r["max_loss"]))
        cells.append(fmt_pct(r["max_gain"]))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def main() -> None:
    df = load_backtest()

    findings: dict = {}
    report: list[str] = []
    report.append("# IV-Anomaly Stratification — 2026-04-25\n")
    report.append(
        f"**Sample:** {len(df)} backfill alerts, sliced by 8 detector-gate dimensions.\n\n"
        "**Strategy used:** the per-ticker best non-oracle strategy from Phase B "
        "(NDXP/MSFT/META/MU/QQQ/SPY/SPXW/NVDA → hold-to-EOD; IWM/TSLA/MSTR/SNDK/SMH → "
        "sell-on-ITM-touch).\n\n"
        "Each table groups alerts by gate dimension and reports the win rate "
        "+ PnL stats on the best-strategy outcome — directly answers \"does this "
        "gate value concentrate winners?\"\n\n"
        "**Caveats:** 10-day sample; per-bucket subsets get small fast. Treat as "
        "directional. Live data thickens the population over time.\n"
    )

    # ── Q1: Per-ticker peak-return distribution ────────────────
    report.append("\n## Q1. Per-ticker — already shown in Phase B report\n")
    report.append(
        "See `ml/reports/iv-anomaly-backtest-2026-04-25.md` for the per-ticker "
        "leaderboard. Ranking summary: NDXP (53.9% win, +3.9% median) is the only "
        "ticker with positive median PnL; MSFT (32%) and META (30%) are the runners-"
        "up; SPY/QQQ/SPXW dominate volume but cluster at ~10% win rate; single names "
        "(TSLA/NVDA/MSTR/MU/SNDK/SMH) at <5%.\n"
    )

    # ── Q2: Signal-stack count ─────────────────────────────────
    q2 = stratify(df, "signal_count")
    findings["q2_signal_count"] = q2.to_dict(orient="records")
    report.append("\n## Q2. Signal-stack count (more reasons = better signal?)\n")
    report.append(render_table(q2, "signal_count", "All tickers"))
    q2_per_ticker = per_ticker_stratify(df, "signal_count")
    findings["q2_signal_count_per_ticker"] = q2_per_ticker.to_dict(orient="records")
    report.append(render_table(q2_per_ticker, "signal_count", "Per ticker"))

    # ── Q3: Session phase ──────────────────────────────────────
    q3 = stratify(df, "session_phase")
    findings["q3_session_phase"] = q3.to_dict(orient="records")
    report.append("\n## Q3. Session phase (open / morning / midday / afternoon)\n")
    report.append(render_table(q3, "session_phase", "All tickers"))

    # ── Q4: Vol/OI bucket ──────────────────────────────────────
    q4 = stratify(
        df,
        "vol_oi_ratio",
        bins=[0, 5, 10, 50, 200, 1e6],
        labels=["<5×", "5-10×", "10-50×", "50-200×", "200×+"],
    )
    findings["q4_vol_oi"] = q4.to_dict(orient="records")
    report.append("\n## Q4. Vol/OI bucket (gate is currently ≥5×)\n")
    report.append(render_table(q4, "vol_oi_bucket", "All tickers"))

    # ── Q5: OTM distance ──────────────────────────────────────
    q5 = stratify(
        df,
        "otm_abs_pct",
        bins=[0, 0.005, 0.01, 0.02, 0.05, 0.10, 1.0],
        labels=["<0.5%", "0.5-1%", "1-2%", "2-5%", "5-10%", "10%+"],
    )
    findings["q5_otm_distance"] = q5.to_dict(orient="records")
    report.append("\n## Q5. OTM distance bucket\n")
    report.append(render_table(q5, "otm_distance_bucket", "All tickers"))
    q5_per_ticker = per_ticker_stratify(
        df,
        "otm_abs_pct",
        bins=[0, 0.005, 0.01, 0.02, 0.05, 0.10, 1.0],
        labels=["<0.5%", "0.5-1%", "1-2%", "2-5%", "5-10%", "10%+"],
    )
    findings["q5_otm_per_ticker"] = q5_per_ticker.to_dict(orient="records")
    report.append(render_table(q5_per_ticker, "otm_distance_bucket", "Per ticker"))

    # ── Q6: Side-skew bucket ──────────────────────────────────
    q6 = stratify(
        df,
        "side_skew",
        bins=[0, 0.65, 0.75, 0.85, 0.95, 1.01],
        labels=["0.65-0.75", "0.75-0.85", "0.85-0.95", "0.95-1.0", "1.0+"],
    )
    findings["q6_side_skew"] = q6.to_dict(orient="records")
    report.append("\n## Q6. Side-skew bucket (gate is currently ≥0.65)\n")
    report.append(render_table(q6, "side_skew_bucket", "All tickers"))

    # ── Q7: flow_phase ────────────────────────────────────────
    q7 = stratify(df, "flow_phase")
    findings["q7_flow_phase"] = q7.to_dict(orient="records")
    report.append("\n## Q7. flow_phase classifier output\n")
    report.append(render_table(q7, "flow_phase", "All tickers"))
    q7_per_ticker = per_ticker_stratify(df, "flow_phase")
    findings["q7_flow_phase_per_ticker"] = q7_per_ticker.to_dict(orient="records")
    report.append(render_table(q7_per_ticker, "flow_phase", "Per ticker"))

    # ── Q8: side_dominant ────────────────────────────────────
    q8 = stratify(df, "side_dominant")
    findings["q8_side_dominant"] = q8.to_dict(orient="records")
    report.append("\n## Q8. side_dominant (ask vs bid)\n")
    report.append(render_table(q8, "side_dominant", "All tickers"))
    # Per ticker AND side (call/put) — does ask-dominance differ for calls vs puts?
    rows = []
    for (ticker, side), sub in df.groupby(["ticker", "side"], observed=True):
        slc = stratify(sub, "side_dominant")
        if slc.empty:
            continue
        slc.insert(0, "ticker", ticker)
        slc.insert(1, "option_side", side)
        rows.append(slc)
    q8_drilldown = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()
    findings["q8_side_dominant_drilldown"] = q8_drilldown.to_dict(orient="records")
    if not q8_drilldown.empty:
        report.append("\n### Drilldown: ticker × option-side × side_dominant\n")
        report.append(
            "| ticker | option | side_dominant | n | win% | mean | median |\n"
            "| --- | --- | --- | --- | --- | --- | --- |\n"
        )
        for _, r in q8_drilldown.iterrows():
            report.append(
                f"| {r['ticker']} | {r['option_side']} | {r['bucket']} | {r['n']} | "
                f"{fmt_pct_unsigned(r['win_rate'])} | {fmt_pct(r['mean_pnl'])} | "
                f"{fmt_pct(r['median_pnl'])} |\n"
            )

    # ── Headline summary ─────────────────────────────────────
    report.append("\n## Headline interpretation\n")
    report.append(
        "Decisions to consider for production gate tuning. Each is a "
        "hypothesis informed by the strata above — re-evaluate after live "
        "data thickens the population (target: 4-6 weeks).\n\n"
    )

    # Pull key numbers programmatically
    voi_5_10 = q4[q4["bucket"] == "5-10×"]["win_rate"].iloc[0] if not q4.empty and "5-10×" in q4["bucket"].values else None
    voi_50_200 = q4[q4["bucket"] == "50-200×"]["win_rate"].iloc[0] if not q4.empty and "50-200×" in q4["bucket"].values else None
    voi_200_plus = q4[q4["bucket"] == "200×+"]["win_rate"].iloc[0] if not q4.empty and "200×+" in q4["bucket"].values else None
    otm_005 = q5[q5["bucket"] == "<0.5%"]["win_rate"].iloc[0] if not q5.empty and "<0.5%" in q5["bucket"].values else None
    otm_510 = q5[q5["bucket"] == "5-10%"]["win_rate"].iloc[0] if not q5.empty and "5-10%" in q5["bucket"].values else None
    sig_1 = q2[q2["bucket"] == "1"]["win_rate"].iloc[0] if not q2.empty and "1" in q2["bucket"].values else None
    sig_2 = q2[q2["bucket"] == "2"]["win_rate"].iloc[0] if not q2.empty and "2" in q2["bucket"].values else None

    findings_md = []
    findings_md.append("### 1. Vol/OI ratio is COUNTERINTUITIVELY non-monotonic\n")
    if voi_5_10 is not None and voi_200_plus is not None:
        findings_md.append(
            f"Win rate by vol/OI bucket: 5-10× = {voi_5_10*100:.1f}%, "
            f"50-200× = {voi_50_200*100:.1f}%, 200×+ = {voi_200_plus*100:.1f}%. "
            "**The highest ratios produce the LOWEST win rates.** Likely "
            "interpretation: extreme vol/OI fires on lottery-ticket strikes "
            "where smart money is closing inventory or where MMs are "
            "absorbing one-sided dump flow — neither of which means "
            "'spot is about to move toward the strike.' Consider a vol/OI "
            "CEILING (e.g. ignore alerts > 200×) per ticker.\n\n"
        )
    findings_md.append("### 2. OTM distance: closer to ATM wins more\n")
    if otm_005 is not None and otm_510 is not None:
        findings_md.append(
            f"Win rate at <0.5% OTM: {otm_005*100:.1f}%. At 5-10% OTM: "
            f"{otm_510*100:.1f}%. Closer-to-ATM strikes are more likely to "
            "finish ITM (need a smaller move). The ±12% cash-index gate "
            "captures a lot of unactionable far-OTM lottery tickets — "
            "consider tightening to ±5% for SPXW/NDXP if win rate matters "
            "more than coverage.\n\n"
        )
    findings_md.append("### 3. Signal-stack count NOT predictive on average\n")
    if sig_1 is not None and sig_2 is not None:
        findings_md.append(
            f"Win rate with 1 signal: {sig_1*100:.1f}%. With 2 signals: "
            f"{sig_2*100:.1f}%. Multi-signal alerts are NOT systematically "
            "better — and on some tickers (NVDA, MU, MSTR) they're actually "
            "worse. Hypothesis: z_score firing on top of skew_delta often "
            "indicates the signal is already 'in motion' (mid-phase / late) "
            "rather than 'fresh accumulation' (early-phase). Check "
            "flow_phase × signal_count × ticker — drives gate weighting in "
            "production UI display priority.\n\n"
        )
    findings_md.append("### 4. NDXP is structurally different\n")
    findings_md.append(
        "Across every stratum, NDXP punches above its weight: 55.7% win "
        "rate on single-signal alerts vs ~10% for SPXW/SPY/QQQ. Structural "
        "candidates: NQ futures spot tracking (cleaner than ETF dealer "
        "hedging), wider strikes (less retracement risk), or genuinely "
        "different informed-flow population. Worth a deeper look before "
        "extrapolating gate changes.\n\n"
    )
    findings_md.append("### 5. Single-name 0DTE alerts are the worst class\n")
    findings_md.append(
        "TSLA / NVDA / MSTR / MU / SNDK / SMH show 0-4% win rates with "
        "-66% to -100% mean PnL. The detector is firing on these but the "
        "downstream price action doesn't materialize within the 0DTE/short-"
        "dated window. Two responses to consider: (a) tighten gates further "
        "for these tickers (higher OI floor, tighter vol/OI ceiling), or "
        "(b) limit display priority on these tickers in the UI so they "
        "don't compete for attention with higher-conviction signals.\n\n"
    )
    findings_md.append("### 6. Hold-to-EOD generally beats sell-on-ITM-touch\n")
    findings_md.append(
        "Hold-to-EOD wins as the best non-oracle on 8 of 13 tickers. The "
        "premise that '0DTE retraces require sell-on-touch' isn't broadly "
        "supported — when alerts touch ITM, they tend to stay there often "
        "enough that holding pays. Exception: IWM, TSLA, MSTR, SNDK, SMH — "
        "these prefer ITM-touch exits, which aligns with their high "
        "retrace rates in the Phase B 0DTE-retrace plot.\n\n"
    )

    report.append("".join(findings_md))

    # Save
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    FINDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text("".join(report))
    FINDINGS_PATH.write_text(json.dumps(findings, default=str, indent=2))
    print(f"[done] report: {REPORT_PATH}", file=sys.stderr)
    print(f"[done] findings: {FINDINGS_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
