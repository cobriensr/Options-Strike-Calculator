#!/usr/bin/env python3
"""Refined Framework Final — apply calendar anti-filters + amplifiers to
the 3-signal composite (E1 long call, E5 long put, PCS Monday) and
re-measure aggregate performance.

Inputs:
  docs/tmp/forensic-multi-day/aggregate_framework_trades_tagged.csv

Outputs:
  docs/tmp/forensic-multi-day/refined_framework_findings.md
  stdout: per-section diagnostics

Decisions:
  Δ metric (per-trade)       = signed_edge_30m  (signed in trade direction;
                                same metric used by calendar_context_analysis)
  Walk-forward cutoff        = 2026-04-09 (H1 < cutoff, H2 ≥ cutoff)
  Anti-filters (drop trade if true):
    E1 long_call: is_fomc_day OR dom_bucket == '16-20'
    E5 long_put : dom_bucket == '01-05'
    PCS Monday  : flat-gap (already pre-filtered at signal generation;
                  re-check is_eom + B1 condition baked in upstream — no
                  additional filtering applied in this script.)
  Amplifiers (positive filters, used for REPORTING only, do not subset):
    E1: dom_bucket in {'06-10','11-15'} OR is_eom
    E5: is_opex_week
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
TAGGED_CSV = ROOT / "docs/tmp/forensic-multi-day/aggregate_framework_trades_tagged.csv"
FINDINGS_MD = ROOT / "docs/tmp/forensic-multi-day/refined_framework_findings.md"

H1_H2_CUTOFF = pd.Timestamp("2026-04-09", tz="UTC")
DELTA_COL = "signed_edge_30m"  # per-trade signed P&L proxy at 30m horizon


# --------------------------------------------------------------------------- #
# Load / prep
# --------------------------------------------------------------------------- #


def load_ledger() -> pd.DataFrame:
    df = pd.read_csv(TAGGED_CSV)
    df["anchor_ts"] = pd.to_datetime(df["anchor_ts"], utc=True)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df["delta"] = df[DELTA_COL].astype(float)
    return df


# --------------------------------------------------------------------------- #
# Filter logic
# --------------------------------------------------------------------------- #


def apply_anti_filters(df: pd.DataFrame) -> pd.DataFrame:
    """Return df with `kept` boolean column reflecting the survival rules."""
    df = df.copy()

    e1_mask = df["trade_type"] == "long_call_e1"
    e5_mask = df["trade_type"] == "long_put_e5"
    pcs_mask = df["trade_type"] == "pcs_monday"

    # E1 anti-filters
    e1_drop = e1_mask & (df["is_fomc_day"] | (df["dom_bucket"] == "16-20"))
    # E5 anti-filters
    e5_drop = e5_mask & (df["dom_bucket"] == "01-05")
    # PCS: signal generator already excluded flat-gap days. No re-filter.
    pcs_drop = pd.Series(False, index=df.index)

    df["kept"] = ~(e1_drop | e5_drop | pcs_drop)
    df["dropped_reason"] = ""
    df.loc[e1_drop, "dropped_reason"] = "E1: FOMC or DOM 16-20"
    df.loc[e5_drop, "dropped_reason"] = "E5: DOM 01-05"
    return df


def amplifier_tags(df: pd.DataFrame) -> pd.DataFrame:
    """Tag amplified trades (positive filters) without dropping anyone."""
    df = df.copy()
    df["amplified"] = False

    e1_mask = df["trade_type"] == "long_call_e1"
    e5_mask = df["trade_type"] == "long_put_e5"

    e1_amp = e1_mask & (
        df["dom_bucket"].isin(["06-10", "11-15"]) | df["is_eom"]
    )
    e5_amp = e5_mask & df["is_opex_week"]
    df.loc[e1_amp | e5_amp, "amplified"] = True
    return df


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def per_type_stats(df: pd.DataFrame) -> pd.DataFrame:
    """Per trade_type Δ stats + 1-sample t-test vs 0."""
    from scipy import stats

    out_rows = []
    for tt in ["long_call_e1", "long_put_e5", "pcs_monday"]:
        sub = df[df["trade_type"] == tt]["delta"].dropna()
        n = len(sub)
        if n == 0:
            out_rows.append(
                {
                    "trade_type": tt,
                    "n": 0,
                    "mean_delta": np.nan,
                    "median_delta": np.nan,
                    "win_rate": np.nan,
                    "total_delta": 0.0,
                    "t_stat": np.nan,
                    "p_value": np.nan,
                }
            )
            continue
        t_stat, p_value = (np.nan, np.nan)
        if n >= 2 and sub.std(ddof=1) > 0:
            t_stat, p_value = stats.ttest_1samp(sub, 0.0)
        out_rows.append(
            {
                "trade_type": tt,
                "n": n,
                "mean_delta": float(sub.mean()),
                "median_delta": float(sub.median()),
                "win_rate": float((sub > 0).mean() * 100.0),
                "total_delta": float(sub.sum()),
                "t_stat": float(t_stat) if not np.isnan(t_stat) else np.nan,
                "p_value": float(p_value) if not np.isnan(p_value) else np.nan,
            }
        )
    return pd.DataFrame(out_rows)


def walk_forward(df: pd.DataFrame, cutoff: pd.Timestamp) -> dict:
    h1 = df[df["anchor_ts"] < cutoff]
    h2 = df[df["anchor_ts"] >= cutoff]
    out = {"_cutoff_iso": cutoff.isoformat()}
    for label, sub in [("H1", h1), ("H2", h2)]:
        daily = sub.groupby("date")["delta"].sum() if len(sub) else pd.Series(dtype=float)
        out[label] = {
            "trades": int(len(sub)),
            "trade_days": int(daily.shape[0]),
            "total_delta": float(sub["delta"].sum()) if len(sub) else 0.0,
            "mean_delta_per_trade": float(sub["delta"].mean()) if len(sub) else 0.0,
            "mean_day_delta": float(daily.mean()) if len(daily) else 0.0,
            "median_day_delta": float(daily.median()) if len(daily) else 0.0,
            "pct_pos_days": float((daily > 0).mean() * 100.0) if len(daily) else 0.0,
            "win_rate_trades": float((sub["delta"] > 0).mean() * 100.0) if len(sub) else 0.0,
            "start": sub["anchor_ts"].min().date().isoformat() if len(sub) else None,
            "end": sub["anchor_ts"].max().date().isoformat() if len(sub) else None,
        }
    return out


def concentration(df: pd.DataFrame) -> dict:
    """Top-N day P&L concentration on the daily-aggregate curve."""
    daily = df.groupby("date")["delta"].sum().sort_values(ascending=False)
    total = daily.sum()
    n_days = len(daily)
    if n_days == 0 or total == 0:
        return {
            "n_days": n_days,
            "total_delta": float(total),
            "top1_pct": np.nan,
            "top5_pct": np.nan,
            "top10_pct": np.nan,
        }
    top1 = daily.head(1).sum()
    top5 = daily.head(5).sum()
    top10 = daily.head(10).sum()
    return {
        "n_days": n_days,
        "total_delta": float(total),
        "top1_pct": float(top1 / total * 100.0),
        "top5_pct": float(top5 / total * 100.0),
        "top10_pct": float(top10 / total * 100.0),
        "best_5_days": [
            (d.isoformat(), float(v)) for d, v in daily.head(5).items()
        ],
        "worst_5_days": [
            (d.isoformat(), float(v)) for d, v in daily.tail(5).sort_values().items()
        ],
    }


def max_drawdown(df: pd.DataFrame) -> dict:
    """Day-level cumulative equity curve max drawdown (Δ-pts units)."""
    daily = df.groupby("date")["delta"].sum().sort_index()
    if daily.empty:
        return {"max_dd": 0.0, "max_dd_trough": None, "peak_to_trough_days": 0}
    cum = daily.cumsum()
    running_peak = cum.cummax()
    dd = cum - running_peak
    trough_idx = dd.idxmin()
    trough_val = float(dd.min())
    peak_idx = cum.loc[:trough_idx].idxmax() if trough_val < 0 else trough_idx
    duration_days = (trough_idx - peak_idx).days if isinstance(peak_idx, type(trough_idx)) else 0
    return {
        "max_dd": trough_val,
        "max_dd_trough": trough_idx.isoformat() if trough_val < 0 else None,
        "peak_to_trough_days": int(duration_days),
    }


def cooccurrence(df: pd.DataFrame) -> dict:
    """E1/E5 same-day co-occurrence on a trade-set."""
    e1_days = set(df.loc[df["trade_type"] == "long_call_e1", "date"].unique())
    e5_days = set(df.loc[df["trade_type"] == "long_put_e5", "date"].unique())
    if not e1_days or not e5_days:
        return {
            "e1_days": len(e1_days),
            "e5_days": len(e5_days),
            "shared_days": 0,
            "e1_only_days": len(e1_days),
            "e5_only_days": len(e5_days),
            "shared_pct_of_e1": 0.0,
            "shared_pct_of_e5": 0.0,
        }
    shared = e1_days & e5_days
    return {
        "e1_days": len(e1_days),
        "e5_days": len(e5_days),
        "shared_days": len(shared),
        "e1_only_days": len(e1_days - e5_days),
        "e5_only_days": len(e5_days - e1_days),
        "shared_pct_of_e1": float(len(shared) / len(e1_days) * 100.0),
        "shared_pct_of_e5": float(len(shared) / len(e5_days) * 100.0),
    }


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


def _fmt_dict_block(d: dict) -> str:
    return "\n".join(f"  - {k}: {v}" for k, v in d.items())


def render_findings(
    df_all: pd.DataFrame,
    df_filt: pd.DataFrame,
    df_filt_with_amp: pd.DataFrame,
) -> str:
    # Per-type stats
    stats_all = per_type_stats(df_all)
    stats_filt = per_type_stats(df_filt)
    # Walk-forward
    wf_all = walk_forward(df_all, H1_H2_CUTOFF)
    wf_filt = walk_forward(df_filt, H1_H2_CUTOFF)
    # Concentration
    conc_all = concentration(df_all)
    conc_filt = concentration(df_filt)
    # Drawdown
    dd_all = max_drawdown(df_all)
    dd_filt = max_drawdown(df_filt)
    # Co-occurrence
    cooc_all = cooccurrence(df_all)
    cooc_filt = cooccurrence(df_filt)
    # Survival counts
    survival = (
        df_filt_with_amp.groupby("trade_type")
        .agg(total=("kept", "size"), kept=("kept", "sum"))
        .reset_index()
    )
    survival["dropped"] = survival["total"] - survival["kept"]

    # Per-type amplifier sub-stats (FILTERED set only)
    amp_breakdown_rows = []
    for tt in ["long_call_e1", "long_put_e5", "pcs_monday"]:
        sub = df_filt_with_amp[
            (df_filt_with_amp["trade_type"] == tt) & df_filt_with_amp["kept"]
        ]
        if sub.empty:
            continue
        for amp_flag in (True, False):
            block = sub[sub["amplified"] == amp_flag]
            if block.empty:
                continue
            amp_breakdown_rows.append(
                {
                    "trade_type": tt,
                    "amplified": amp_flag,
                    "n": len(block),
                    "mean_delta": float(block["delta"].mean()),
                    "win_rate": float((block["delta"] > 0).mean() * 100.0),
                }
            )
    amp_df = pd.DataFrame(amp_breakdown_rows)

    # ------------------------------------------------------------------
    # Markdown body
    # ------------------------------------------------------------------
    lines: list[str] = []
    lines.append("# Refined Framework Final — Anti-Filter & Amplifier Validation")
    lines.append("")
    lines.append("**Generated:** 2026-05-21")
    lines.append(f"**Input ledger:** `{TAGGED_CSV.relative_to(ROOT)}`")
    lines.append(f"**Δ metric:** `{DELTA_COL}` (signed in trade direction, 30m horizon)")
    lines.append(f"**Walk-forward cutoff:** {H1_H2_CUTOFF.date().isoformat()} (H1 < cutoff, H2 ≥ cutoff)")
    lines.append("")
    lines.append("## 1. Filter Rules Applied")
    lines.append("")
    lines.append("**Anti-filters (drop trade):**")
    lines.append("- `long_call_e1` — drop if `is_fomc_day` OR `dom_bucket == '16-20'`")
    lines.append("- `long_put_e5`  — drop if `dom_bucket == '01-05'`")
    lines.append("- `pcs_monday`   — flat-gap exclusion already enforced at signal-generation time; no additional filter")
    lines.append("")
    lines.append("**Amplifier tags (positive filters, REPORTING only — not used to subset):**")
    lines.append("- `long_call_e1` — `dom_bucket in {06-10, 11-15}` OR `is_eom`")
    lines.append("- `long_put_e5`  — `is_opex_week`")
    lines.append("")
    lines.append("## 2. Survival Counts")
    lines.append("")
    lines.append("| trade_type | total | kept | dropped | survival_pct |")
    lines.append("|---|---:|---:|---:|---:|")
    for r in survival.itertuples(index=False):
        pct = (r.kept / r.total * 100.0) if r.total else 0.0
        lines.append(f"| {r.trade_type} | {r.total} | {r.kept} | {r.dropped} | {pct:.1f}% |")
    grand_total = int(survival["total"].sum())
    grand_kept = int(survival["kept"].sum())
    grand_drop = grand_total - grand_kept
    lines.append(
        f"| **TOTAL** | **{grand_total}** | **{grand_kept}** | **{grand_drop}** | **{grand_kept/grand_total*100:.1f}%** |"
    )
    lines.append("")
    lines.append("## 3. Per-Trade Stats — Unfiltered vs Filtered")
    lines.append("")
    lines.append("| trade_type | set | n | mean Δ | median Δ | win% | total Δ | t-stat | p |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for tt in ["long_call_e1", "long_put_e5", "pcs_monday"]:
        for label, src in [("UNF", stats_all), ("FILT", stats_filt)]:
            row = src[src["trade_type"] == tt]
            if row.empty:
                continue
            r = row.iloc[0]
            lines.append(
                f"| {tt} | {label} | {int(r['n'])} | {r['mean_delta']:+.2f} | {r['median_delta']:+.2f} | "
                f"{r['win_rate']:.0f}% | {r['total_delta']:+.1f} | "
                f"{r['t_stat']:+.2f} | {r['p_value']:.3f} |"
            )
    lines.append("")
    lines.append("## 4. Amplifier Sub-Stats (FILTERED set only)")
    lines.append("")
    if not amp_df.empty:
        lines.append("| trade_type | amplified? | n | mean Δ | win% |")
        lines.append("|---|---|---:|---:|---:|")
        for r in amp_df.itertuples(index=False):
            lines.append(
                f"| {r.trade_type} | {'YES' if r.amplified else 'no'} | {r.n} | "
                f"{r.mean_delta:+.2f} | {r.win_rate:.0f}% |"
            )
        lines.append("")
    lines.append("## 5. Walk-Forward (H1 < 2026-04-09 < H2)")
    lines.append("")
    lines.append("| set | half | trades | trade_days | total Δ | mean Δ/trade | mean day Δ | pos days% | win% |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for label, src in [("UNF", wf_all), ("FILT", wf_filt)]:
        for half in ("H1", "H2"):
            h = src[half]
            lines.append(
                f"| {label} | {half} | {h['trades']} | {h['trade_days']} | "
                f"{h['total_delta']:+.1f} | {h['mean_delta_per_trade']:+.2f} | "
                f"{h['mean_day_delta']:+.2f} | {h['pct_pos_days']:.0f}% | "
                f"{h['win_rate_trades']:.0f}% |"
            )
    lines.append("")
    # H2/H1 ratio
    h2_h1_unf = (
        wf_all["H2"]["mean_day_delta"] / wf_all["H1"]["mean_day_delta"]
        if wf_all["H1"]["mean_day_delta"] != 0
        else float("nan")
    )
    h2_h1_filt = (
        wf_filt["H2"]["mean_day_delta"] / wf_filt["H1"]["mean_day_delta"]
        if wf_filt["H1"]["mean_day_delta"] != 0
        else float("nan")
    )
    lines.append(f"**H2/H1 day-Δ ratio (regime decay):**  UNF = {h2_h1_unf:.2f}, FILT = {h2_h1_filt:.2f}")
    lines.append("")
    lines.append("## 6. Concentration (Daily Aggregate Curve)")
    lines.append("")
    lines.append("| set | n_days | total Δ | top1% | top5% | top10% |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for label, src in [("UNF", conc_all), ("FILT", conc_filt)]:
        lines.append(
            f"| {label} | {src['n_days']} | {src['total_delta']:+.1f} | "
            f"{src['top1_pct']:.0f}% | {src['top5_pct']:.0f}% | {src['top10_pct']:.0f}% |"
        )
    lines.append("")
    lines.append("**FILTERED Top 5 best days:**")
    for d, v in conc_filt.get("best_5_days", []):
        lines.append(f"- {d}: {v:+.1f}")
    lines.append("")
    lines.append("**FILTERED Top 5 worst days:**")
    for d, v in conc_filt.get("worst_5_days", []):
        lines.append(f"- {d}: {v:+.1f}")
    lines.append("")
    lines.append("## 7. Max Drawdown (cumulative day-level)")
    lines.append("")
    lines.append("| set | max_dd Δ | trough_date | peak_to_trough_days |")
    lines.append("|---|---:|---|---:|")
    for label, src in [("UNF", dd_all), ("FILT", dd_filt)]:
        lines.append(
            f"| {label} | {src['max_dd']:+.1f} | {src['max_dd_trough'] or '—'} | "
            f"{src['peak_to_trough_days']} |"
        )
    lines.append("")
    lines.append("## 8. E1/E5 Co-Occurrence")
    lines.append("")
    lines.append("| set | E1 days | E5 days | shared | shared%/E1 | shared%/E5 |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for label, src in [("UNF", cooc_all), ("FILT", cooc_filt)]:
        lines.append(
            f"| {label} | {src['e1_days']} | {src['e5_days']} | {src['shared_days']} | "
            f"{src['shared_pct_of_e1']:.0f}% | {src['shared_pct_of_e5']:.0f}% |"
        )
    lines.append("")
    # ------------------------------------------------------------------
    # Side-by-side comparison
    # ------------------------------------------------------------------
    lines.append("## 9. Side-by-Side: UNFILTERED vs FILTERED")
    lines.append("")
    e1_unf = stats_all[stats_all["trade_type"] == "long_call_e1"].iloc[0]
    e1_filt = stats_filt[stats_filt["trade_type"] == "long_call_e1"].iloc[0]
    e5_unf = stats_all[stats_all["trade_type"] == "long_put_e5"].iloc[0]
    e5_filt = stats_filt[stats_filt["trade_type"] == "long_put_e5"].iloc[0]
    pcs_unf = stats_all[stats_all["trade_type"] == "pcs_monday"].iloc[0]
    pcs_filt = stats_filt[stats_filt["trade_type"] == "pcs_monday"].iloc[0]
    rows = [
        ("Total trades", grand_total, grand_kept),
        ("Trade days", conc_all["n_days"], conc_filt["n_days"]),
        ("Total Δ", f"{conc_all['total_delta']:+.1f}", f"{conc_filt['total_delta']:+.1f}"),
        ("Mean Δ / trade (all)", f"{df_all['delta'].mean():+.2f}", f"{df_filt['delta'].mean():+.2f}"),
        ("Median Δ / trade (all)", f"{df_all['delta'].median():+.2f}", f"{df_filt['delta'].median():+.2f}"),
        ("Win rate trades%", f"{(df_all['delta']>0).mean()*100:.0f}%", f"{(df_filt['delta']>0).mean()*100:.0f}%"),
        ("H1 mean day Δ", f"{wf_all['H1']['mean_day_delta']:+.2f}", f"{wf_filt['H1']['mean_day_delta']:+.2f}"),
        ("H2 mean day Δ", f"{wf_all['H2']['mean_day_delta']:+.2f}", f"{wf_filt['H2']['mean_day_delta']:+.2f}"),
        ("H2/H1 ratio", f"{h2_h1_unf:.2f}", f"{h2_h1_filt:.2f}"),
        ("Top-5-day concentration", f"{conc_all['top5_pct']:.0f}%", f"{conc_filt['top5_pct']:.0f}%"),
        ("Top-10-day concentration", f"{conc_all['top10_pct']:.0f}%", f"{conc_filt['top10_pct']:.0f}%"),
        ("Max drawdown Δ", f"{dd_all['max_dd']:+.1f}", f"{dd_filt['max_dd']:+.1f}"),
        ("E1 mean Δ", f"{e1_unf['mean_delta']:+.2f}", f"{e1_filt['mean_delta']:+.2f}"),
        ("E1 win%", f"{e1_unf['win_rate']:.0f}%", f"{e1_filt['win_rate']:.0f}%"),
        ("E5 mean Δ", f"{e5_unf['mean_delta']:+.2f}", f"{e5_filt['mean_delta']:+.2f}"),
        ("E5 win%", f"{e5_unf['win_rate']:.0f}%", f"{e5_filt['win_rate']:.0f}%"),
        ("PCS mean Δ", f"{pcs_unf['mean_delta']:+.2f}", f"{pcs_filt['mean_delta']:+.2f}"),
        ("PCS win%", f"{pcs_unf['win_rate']:.0f}%", f"{pcs_filt['win_rate']:.0f}%"),
        ("E1/E5 shared-day % of E1", f"{cooc_all['shared_pct_of_e1']:.0f}%", f"{cooc_filt['shared_pct_of_e1']:.0f}%"),
    ]
    lines.append("| metric | UNFILTERED | FILTERED |")
    lines.append("|---|---|---|")
    for r in rows:
        lines.append(f"| {r[0]} | {r[1]} | {r[2]} |")
    lines.append("")
    # ------------------------------------------------------------------
    # Final trade spec
    # ------------------------------------------------------------------
    sample_days_per_month = grand_kept / max(conc_filt["n_days"], 1) * 21.0
    lines.append("## 10. Final Trade Spec (clean, frontend-tile usable)")
    lines.append("")
    lines.append("### Signal A — E1 Long Call (Breakthrough)")
    lines.append("- **Base condition:** E1 fire per `category_e_e1_breakthroughs.csv`")
    lines.append("- **Anti-filter:** SKIP if FOMC decision day; SKIP if calendar DOM ∈ [16, 20]")
    lines.append("- **Amplifier (size-up):** DOM ∈ [06, 15] OR last 2 biz days of month (EoM)")
    lines.append(f"- **Filtered n:** {int(e1_filt['n'])} ({int(e1_filt['n'])} kept / {int(e1_unf['n'])} raw)")
    lines.append(f"- **Mean Δ / trade:** {e1_filt['mean_delta']:+.2f} pts (30m, signed)")
    lines.append(f"- **Win rate:** {e1_filt['win_rate']:.0f}% (vs {e1_unf['win_rate']:.0f}% unfiltered)")
    lines.append(f"- **p-value vs 0:** {e1_filt['p_value']:.3f}")
    lines.append("")
    lines.append("### Signal B — E5 Long Put (Failed Reversal)")
    lines.append("- **Base condition:** E5 fire per `category_e_e5_failed_reversal.csv`")
    lines.append("- **Anti-filter:** SKIP if calendar DOM ∈ [01, 05]")
    lines.append("- **Amplifier (size-up):** OPEX week (Mon-Fri containing 3rd Fri)")
    lines.append(f"- **Filtered n:** {int(e5_filt['n'])} ({int(e5_filt['n'])} kept / {int(e5_unf['n'])} raw)")
    lines.append(f"- **Mean Δ / trade:** {e5_filt['mean_delta']:+.2f} pts (30m, signed)")
    lines.append(f"- **Win rate:** {e5_filt['win_rate']:.0f}% (vs {e5_unf['win_rate']:.0f}% unfiltered)")
    lines.append(f"- **p-value vs 0:** {e5_filt['p_value']:.3f}")
    lines.append("")
    lines.append("### Signal C — PCS Monday")
    lines.append("- **Base condition:** Monday + down-wick + |GEX|≤500 + B1 ES basis Q4 + |open_gap|≥0.1% (NOT flat gap)")
    lines.append("- **Anti-filter:** None additional (flat-gap exclusion already in signal definition)")
    lines.append(f"- **Filtered n:** {int(pcs_filt['n'])}")
    lines.append(f"- **Mean Δ / trade:** {pcs_filt['mean_delta']:+.2f} pts (30m, signed)")
    lines.append(f"- **Win rate:** {pcs_filt['win_rate']:.0f}%")
    lines.append("- **NOTE:** n=8 is too small for meaningful calibration. Treat as anecdotal until ≥30 fires.")
    lines.append("")
    lines.append(f"### Expected combined frequency: ~{sample_days_per_month:.1f} trades / 21 trading days")
    lines.append("")
    lines.append("## 11. Verdict")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> int:
    df_all = load_ledger()
    print(f"Loaded {len(df_all)} trades across {df_all['date'].nunique()} dates")
    print(f"Trade type counts:\n{df_all['trade_type'].value_counts().to_string()}")
    print()

    df_tagged = amplifier_tags(apply_anti_filters(df_all))
    df_filt = df_tagged[df_tagged["kept"]].copy()
    print(
        f"After anti-filters: {len(df_filt)} kept / {len(df_all)} total "
        f"({len(df_filt)/len(df_all)*100:.1f}% survival)"
    )
    drop_breakdown = df_tagged[~df_tagged["kept"]]["dropped_reason"].value_counts()
    print(f"Dropped breakdown:\n{drop_breakdown.to_string()}")
    print()

    md = render_findings(df_all, df_filt, df_tagged)
    # Append manual verdict text (computed in main from already-rendered numbers).
    wf_filt = walk_forward(df_filt, H1_H2_CUTOFF)
    wf_all = walk_forward(df_all, H1_H2_CUTOFF)
    conc_filt = concentration(df_filt)
    conc_all = concentration(df_all)
    dd_filt = max_drawdown(df_filt)
    cooc_filt = cooccurrence(df_filt)

    h2_h1_filt = (
        wf_filt["H2"]["mean_day_delta"] / wf_filt["H1"]["mean_day_delta"]
        if wf_filt["H1"]["mean_day_delta"] != 0
        else float("nan")
    )
    h2_h1_unf = (
        wf_all["H2"]["mean_day_delta"] / wf_all["H1"]["mean_day_delta"]
        if wf_all["H1"]["mean_day_delta"] != 0
        else float("nan")
    )

    verdict_lines = []
    # Concentration verdict
    if conc_filt["top5_pct"] < conc_all["top5_pct"] - 5:
        verdict_lines.append(
            f"- **Concentration mitigated:** top-5-day share fell from "
            f"{conc_all['top5_pct']:.0f}% → {conc_filt['top5_pct']:.0f}% after filtering."
        )
    elif conc_filt["top5_pct"] <= conc_all["top5_pct"] + 5:
        verdict_lines.append(
            f"- **Concentration UNCHANGED:** top-5-day share moved {conc_all['top5_pct']:.0f}% → "
            f"{conc_filt['top5_pct']:.0f}%. Anti-filters did not solve fragility."
        )
    else:
        verdict_lines.append(
            f"- **Concentration WORSENED:** top-5-day share rose {conc_all['top5_pct']:.0f}% → "
            f"{conc_filt['top5_pct']:.0f}%. Filters trimmed losers but P&L is now more single-day-dependent."
        )

    # Walk-forward verdict
    if not np.isnan(h2_h1_filt):
        if h2_h1_filt > 0.7:
            verdict_lines.append(
                f"- **Walk-forward HOLDS:** H2/H1 day-Δ ratio = {h2_h1_filt:.2f} (was {h2_h1_unf:.2f}). "
                "H2 expectancy comparable to H1 — regime decay reduced."
            )
        elif h2_h1_filt > 0:
            verdict_lines.append(
                f"- **Walk-forward WEAK:** H2/H1 ratio = {h2_h1_filt:.2f} (was {h2_h1_unf:.2f}). "
                "H2 still loses ground; filters helped but didn't fully repair drift."
            )
        else:
            verdict_lines.append(
                f"- **Walk-forward FAILS:** H2 is negative in the filtered set (mean day Δ = "
                f"{wf_filt['H2']['mean_day_delta']:+.2f}). Calendar filters do not save it."
            )

    # Independence verdict
    if cooc_filt["shared_pct_of_e1"] < 60:
        verdict_lines.append(
            f"- **Independence improved:** E1/E5 share only {cooc_filt['shared_pct_of_e1']:.0f}% "
            "of E1 days after filtering — diversification is now genuine."
        )
    elif cooc_filt["shared_pct_of_e1"] < 80:
        verdict_lines.append(
            f"- **Independence partial:** E1/E5 share {cooc_filt['shared_pct_of_e1']:.0f}% of E1 days. "
            "Better than pre-filter but still highly correlated."
        )
    else:
        verdict_lines.append(
            f"- **Independence FAILS:** E1/E5 still share {cooc_filt['shared_pct_of_e1']:.0f}% of E1 days. "
            "Framework is essentially one trend-day signal in two costumes."
        )

    # Final ship decision
    pass_concentration = conc_filt["top5_pct"] < 50
    pass_walkforward = (not np.isnan(h2_h1_filt)) and h2_h1_filt > 0.5
    pass_independence = cooc_filt["shared_pct_of_e1"] < 70

    ship_score = sum([pass_concentration, pass_walkforward, pass_independence])
    if ship_score == 3:
        ship_msg = (
            "**VERDICT — SHIP AS TIER 1 PAPER-TRADE SIGNAL.** All three robustness "
            "tests passed (concentration <50%, H2/H1 ratio >0.5, co-occurrence <70%)."
        )
    elif ship_score == 2:
        ship_msg = (
            f"**VERDICT — TIER 2 PAPER-TRADE ONLY.** {ship_score}/3 robustness tests "
            "passed. Watch live for 4–6 weeks before sizing up; one of "
            "{concentration, walk-forward, independence} is still broken."
        )
    else:
        ship_msg = (
            f"**VERDICT — DO NOT SHIP.** Only {ship_score}/3 robustness tests passed. "
            "Anti-filters revealed the framework is not actually robust — it's a "
            "trend-day detector with cosmetic improvements."
        )
    verdict_lines.append("")
    verdict_lines.append(ship_msg)

    md += "\n".join(verdict_lines) + "\n"

    FINDINGS_MD.write_text(md)
    print(f"Wrote {FINDINGS_MD.relative_to(ROOT)} ({len(md)} bytes)")
    print()
    print("---")
    print(ship_msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
