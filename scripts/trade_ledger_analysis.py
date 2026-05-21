#!/usr/bin/env python3
"""
Trade-ledger analysis for the 2026-05-21 composite framework
(E1 long call + E5 long put + Monday PCS pocket).

Reads `docs/tmp/forensic-multi-day/aggregate_framework_trades.csv`,
produces a day-by-day equity curve, drawdown analysis, daily P&L
distribution, walk-forward stability check, position-sizing sanity
check, and a same-day signal-correlation diagnostic.

Outputs:
- docs/tmp/forensic-multi-day/equity_curve.png
- docs/tmp/forensic-multi-day/trade_ledger_findings.md
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
LEDGER_PATH = REPO_ROOT / "docs/tmp/forensic-multi-day/aggregate_framework_trades.csv"
PLOT_PATH = REPO_ROOT / "docs/tmp/forensic-multi-day/equity_curve.png"
FINDINGS_PATH = REPO_ROOT / "docs/tmp/forensic-multi-day/trade_ledger_findings.md"

# Position-sizing proxy (per task spec, very rough): 1 Δ-point ≈ $20 P&L
# on a typical 0DTE SPX vertical / debit spread.
DOLLARS_PER_DELTA_PT = 20.0


# --------------------------------------------------------------------------- #
# Load
# --------------------------------------------------------------------------- #


def load_ledger() -> pd.DataFrame:
    if not LEDGER_PATH.exists():
        raise FileNotFoundError(f"Trade ledger missing: {LEDGER_PATH}")
    df = pd.read_csv(LEDGER_PATH)
    required = {
        "trade_type",
        "anchor_ts",
        "ret_30m",
        "control_ret_30m",
    }
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Ledger missing required columns: {missing}")
    df["anchor_ts"] = pd.to_datetime(df["anchor_ts"], utc=True)
    df["delta"] = df["ret_30m"] - df["control_ret_30m"]
    df = df.sort_values("anchor_ts").reset_index(drop=True)
    df["date"] = df["anchor_ts"].dt.date
    return df


# --------------------------------------------------------------------------- #
# Per-day aggregation
# --------------------------------------------------------------------------- #


def per_day_aggregate(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (date, trade_type) plus a composite row per date."""

    # Build full grid of dates × types so days with zero trades show up as 0.
    all_dates = sorted(df["date"].unique())
    types = ["long_call_e1", "long_put_e5", "pcs_monday"]

    rows = []
    for d in all_dates:
        day_slice = df[df["date"] == d]
        # Intraday running cumulative delta for max-DD-within-day.
        intraday = (
            day_slice.sort_values("anchor_ts")["delta"].cumsum().to_numpy()
            if len(day_slice) > 0
            else np.array([0.0])
        )
        # Max drawdown within the day (max peak-to-trough on running cum).
        running_peak = np.maximum.accumulate(intraday) if len(intraday) > 0 else np.array([0.0])
        intraday_dd = float((intraday - running_peak).min())  # negative or 0
        best_trade = float(day_slice["delta"].max()) if len(day_slice) > 0 else 0.0
        worst_trade = float(day_slice["delta"].min()) if len(day_slice) > 0 else 0.0
        for t in types:
            sub = day_slice[day_slice["trade_type"] == t]
            rows.append(
                {
                    "date": d,
                    "trade_type": t,
                    "n_trades": int(len(sub)),
                    "delta_sum": float(sub["delta"].sum()),
                }
            )
        rows.append(
            {
                "date": d,
                "trade_type": "composite",
                "n_trades": int(len(day_slice)),
                "delta_sum": float(day_slice["delta"].sum()),
                "intraday_max_dd": intraday_dd,
                "best_trade_delta": best_trade,
                "worst_trade_delta": worst_trade,
            }
        )
    out = pd.DataFrame(rows)
    out["date"] = pd.to_datetime(out["date"])
    return out


# --------------------------------------------------------------------------- #
# Equity curves
# --------------------------------------------------------------------------- #


def equity_curves(daily: pd.DataFrame) -> dict[str, pd.DataFrame]:
    curves: dict[str, pd.DataFrame] = {}
    for t in ["long_call_e1", "long_put_e5", "pcs_monday", "composite"]:
        sub = daily[daily["trade_type"] == t].sort_values("date").copy()
        sub["cum_delta"] = sub["delta_sum"].cumsum()
        curves[t] = sub.reset_index(drop=True)
    return curves


def plot_equity_curves(curves: dict[str, pd.DataFrame], out_path: Path) -> None:
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)

    # Top: composite (heavy) + components (light)
    ax = axes[0]
    comp = curves["composite"]
    ax.plot(
        comp["date"],
        comp["cum_delta"],
        color="#0b5394",
        linewidth=2.2,
        label="Composite",
    )
    palette = {
        "long_call_e1": "#1f9d55",
        "long_put_e5": "#b91c1c",
        "pcs_monday": "#a16207",
    }
    for t in ["long_call_e1", "long_put_e5", "pcs_monday"]:
        c = curves[t]
        ax.plot(
            c["date"],
            c["cum_delta"],
            color=palette[t],
            linewidth=1.2,
            alpha=0.85,
            label=t,
        )
    ax.axhline(0, color="black", linewidth=0.6, linestyle="--", alpha=0.5)
    ax.set_ylabel("Cumulative Δ-points (event − control @ +30m)")
    ax.set_title(
        "Composite framework equity curves (2026-02-27 → 2026-05-19, n=254 trades, 50 trade days)"
    )
    ax.legend(loc="upper left", frameon=False)
    ax.grid(alpha=0.25)

    # Bottom: composite drawdown underwater plot
    ax = axes[1]
    cum = comp["cum_delta"].to_numpy()
    peak = np.maximum.accumulate(cum)
    dd = cum - peak
    ax.fill_between(comp["date"], dd, 0, color="#b91c1c", alpha=0.35)
    ax.plot(comp["date"], dd, color="#7f1d1d", linewidth=1.0)
    ax.axhline(0, color="black", linewidth=0.6, linestyle="--", alpha=0.5)
    ax.set_ylabel("Drawdown (Δ-points)")
    ax.set_xlabel("Date")
    ax.set_title("Composite underwater curve (peak-to-trough)")
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.grid(alpha=0.25)

    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=140)
    plt.close(fig)


# --------------------------------------------------------------------------- #
# Drawdown analysis
# --------------------------------------------------------------------------- #


def drawdown_stats(curve: pd.DataFrame) -> dict[str, float]:
    """Standard max-drawdown / underwater stats on a daily equity curve."""

    if curve.empty:
        return {
            "max_dd": 0.0,
            "max_dd_start": None,
            "max_dd_trough": None,
            "max_dd_recovery_days": None,
            "avg_dd_duration_days": 0.0,
            "n_drawdowns": 0,
        }
    cum = curve["cum_delta"].to_numpy()
    dates = curve["date"].to_numpy()
    peak = np.maximum.accumulate(cum)
    dd = cum - peak  # ≤ 0

    max_dd_val = float(dd.min())
    trough_i = int(np.argmin(dd))
    # Find peak before trough.
    peak_i = int(np.argmax(cum[: trough_i + 1])) if trough_i > 0 else 0
    # Recovery: first index after trough where cum >= cum[peak_i].
    recovery_i = None
    for i in range(trough_i + 1, len(cum)):
        if cum[i] >= cum[peak_i]:
            recovery_i = i
            break

    # All drawdown episodes (consecutive days underwater).
    underwater = dd < -1e-9
    durations: list[int] = []
    cur = 0
    for u in underwater:
        if u:
            cur += 1
        elif cur > 0:
            durations.append(cur)
            cur = 0
    if cur > 0:
        durations.append(cur)

    return {
        "max_dd": max_dd_val,
        "max_dd_start": pd.Timestamp(dates[peak_i]).date().isoformat()
        if max_dd_val < 0
        else None,
        "max_dd_trough": pd.Timestamp(dates[trough_i]).date().isoformat()
        if max_dd_val < 0
        else None,
        "max_dd_recovery_days": (
            int((dates[recovery_i] - dates[trough_i]) / np.timedelta64(1, "D"))
            if recovery_i is not None
            else None
        ),
        "avg_dd_duration_days": float(np.mean(durations)) if durations else 0.0,
        "n_drawdowns": len(durations),
    }


def worst_losing_streak(df: pd.DataFrame, trade_type: str) -> tuple[int, float]:
    """Longest run of trades with delta < 0 for a trade type, and its cumulative loss."""
    if trade_type == "composite":
        sub = df.sort_values("anchor_ts")
    else:
        sub = df[df["trade_type"] == trade_type].sort_values("anchor_ts")
    if sub.empty:
        return 0, 0.0
    best = 0
    cur = 0
    cur_sum = 0.0
    worst_sum = 0.0
    for delta in sub["delta"].to_numpy():
        if delta < 0:
            cur += 1
            cur_sum += float(delta)
            if cur > best:
                best = cur
                worst_sum = cur_sum
            elif cur == best and cur_sum < worst_sum:
                worst_sum = cur_sum
        else:
            cur = 0
            cur_sum = 0.0
    return best, worst_sum


# --------------------------------------------------------------------------- #
# Daily P&L distribution
# --------------------------------------------------------------------------- #


def daily_distribution(curve: pd.DataFrame) -> dict[str, float]:
    deltas = curve["delta_sum"].to_numpy()
    if len(deltas) == 0:
        return {}
    return {
        "n_days": int(len(deltas)),
        "median_day": float(np.median(deltas)),
        "mean_day": float(np.mean(deltas)),
        "std_day": float(np.std(deltas, ddof=1)) if len(deltas) > 1 else 0.0,
        "max_day": float(deltas.max()),
        "min_day": float(deltas.min()),
        "pct_pos_days": float((deltas > 0).mean() * 100.0),
        "pct_zero_days": float((np.abs(deltas) < 1e-9).mean() * 100.0),
        "pct_neg_days": float((deltas < 0).mean() * 100.0),
        "p10": float(np.percentile(deltas, 10)),
        "p25": float(np.percentile(deltas, 25)),
        "p75": float(np.percentile(deltas, 75)),
        "p90": float(np.percentile(deltas, 90)),
    }


# --------------------------------------------------------------------------- #
# Walk-forward by calendar date
# --------------------------------------------------------------------------- #


def walk_forward_by_date(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    """Split full calendar window in half by date midpoint."""
    min_d = df["anchor_ts"].min()
    max_d = df["anchor_ts"].max()
    midpoint = min_d + (max_d - min_d) / 2

    h1 = df[df["anchor_ts"] < midpoint]
    h2 = df[df["anchor_ts"] >= midpoint]

    out = {}
    for label, sub in [("H1", h1), ("H2", h2)]:
        daily_sum = sub.groupby("date")["delta"].sum()
        out[label] = {
            "trades": int(len(sub)),
            "trade_days": int(daily_sum.shape[0]),
            "total_delta": float(sub["delta"].sum()),
            "mean_delta_per_trade": float(sub["delta"].mean()) if len(sub) > 0 else 0.0,
            "median_day_delta": float(daily_sum.median()) if len(daily_sum) > 0 else 0.0,
            "mean_day_delta": float(daily_sum.mean()) if len(daily_sum) > 0 else 0.0,
            "pct_pos_days": float((daily_sum > 0).mean() * 100.0)
            if len(daily_sum) > 0
            else 0.0,
            "win_rate_trades": float((sub["delta"] > 0).mean() * 100.0)
            if len(sub) > 0
            else 0.0,
            "start": sub["anchor_ts"].min().date().isoformat() if len(sub) > 0 else None,
            "end": sub["anchor_ts"].max().date().isoformat() if len(sub) > 0 else None,
        }
    out["_midpoint"] = {"midpoint_iso": midpoint.isoformat()}
    return out


# --------------------------------------------------------------------------- #
# Same-day signal correlation
# --------------------------------------------------------------------------- #


def signal_correlation(df: pd.DataFrame) -> dict[str, float]:
    """Do E1 and E5 fire on the same days? If so, in what order?"""
    e1 = df[df["trade_type"] == "long_call_e1"]
    e5 = df[df["trade_type"] == "long_put_e5"]
    e1_days = set(e1["date"].unique())
    e5_days = set(e5["date"].unique())
    pcs = df[df["trade_type"] == "pcs_monday"]
    pcs_days = set(pcs["date"].unique())

    both = e1_days & e5_days
    e1_only = e1_days - e5_days
    e5_only = e5_days - e1_days

    # Within shared days, who fires first?
    e1_first = 0
    e5_first = 0
    interleaved = 0
    for d in both:
        e1_min = e1[e1["date"] == d]["anchor_ts"].min()
        e5_min = e5[e5["date"] == d]["anchor_ts"].min()
        e1_max = e1[e1["date"] == d]["anchor_ts"].max()
        e5_max = e5[e5["date"] == d]["anchor_ts"].max()
        if e1_max < e5_min:
            e5_first = e5_first  # E1 fully before E5
            e1_first += 1
        elif e5_max < e1_min:
            e5_first += 1
        else:
            interleaved += 1

    # Concentration of P&L on shared vs single-signal days.
    comp_per_day = df.groupby("date")["delta"].sum()
    shared = comp_per_day.loc[list(both)].sum() if both else 0.0
    e1_only_pnl = comp_per_day.loc[list(e1_only)].sum() if e1_only else 0.0
    e5_only_pnl = comp_per_day.loc[list(e5_only)].sum() if e5_only else 0.0

    return {
        "e1_days": len(e1_days),
        "e5_days": len(e5_days),
        "pcs_days": len(pcs_days),
        "shared_e1_e5_days": len(both),
        "e1_only_days": len(e1_only),
        "e5_only_days": len(e5_only),
        "shared_pct_of_e5_days": (len(both) / len(e5_days) * 100.0) if e5_days else 0.0,
        "e1_first_on_shared": e1_first,
        "e5_first_on_shared": e5_first,
        "interleaved_on_shared": interleaved,
        "shared_day_total_delta": float(shared),
        "e1_only_total_delta": float(e1_only_pnl),
        "e5_only_total_delta": float(e5_only_pnl),
    }


# --------------------------------------------------------------------------- #
# Concentration & RED FLAGS
# --------------------------------------------------------------------------- #


def concentration(curve: pd.DataFrame) -> dict[str, float]:
    total = float(curve["delta_sum"].sum())
    sorted_desc = curve.sort_values("delta_sum", ascending=False)
    top1 = float(sorted_desc.iloc[0]["delta_sum"]) if len(sorted_desc) > 0 else 0.0
    top5 = float(sorted_desc.head(5)["delta_sum"].sum()) if len(sorted_desc) > 0 else 0.0
    top10 = float(sorted_desc.head(10)["delta_sum"].sum()) if len(sorted_desc) > 0 else 0.0
    return {
        "total_delta": total,
        "top1_day_pct": (top1 / total * 100.0) if total != 0 else 0.0,
        "top5_days_pct": (top5 / total * 100.0) if total != 0 else 0.0,
        "top10_days_pct": (top10 / total * 100.0) if total != 0 else 0.0,
        "top1_day_date": sorted_desc.iloc[0]["date"].date().isoformat()
        if len(sorted_desc) > 0
        else None,
        "top1_day_delta": top1,
    }


# --------------------------------------------------------------------------- #
# Findings markdown
# --------------------------------------------------------------------------- #


def fmt(v, sign=False, prec=2):
    if v is None:
        return "—"
    if isinstance(v, (int, np.integer)):
        return f"{int(v):,d}"
    if sign:
        return f"{float(v):+.{prec}f}"
    return f"{float(v):.{prec}f}"


def write_findings(
    df: pd.DataFrame,
    daily: pd.DataFrame,
    curves: dict[str, pd.DataFrame],
    dd: dict[str, dict],
    streaks: dict[str, tuple[int, float]],
    dist: dict[str, dict],
    wf: dict,
    corr: dict,
    conc: dict,
) -> None:
    midpoint = wf["_midpoint"]["midpoint_iso"]
    h1, h2 = wf["H1"], wf["H2"]
    comp = curves["composite"]
    total_delta = float(comp["cum_delta"].iloc[-1]) if len(comp) > 0 else 0.0
    n_days = int(len(comp))
    trade_days_per_year = 252
    annualization = trade_days_per_year / n_days if n_days > 0 else 0

    annualized_delta = total_delta * annualization
    annualized_dollars = annualized_delta * DOLLARS_PER_DELTA_PT
    total_dollars = total_delta * DOLLARS_PER_DELTA_PT
    max_dd_comp = dd["composite"]
    max_dd_dollars = max_dd_comp["max_dd"] * DOLLARS_PER_DELTA_PT

    lines = []
    lines.append("# Trade Ledger Analysis — Composite Framework (2026-05-21)")
    lines.append("")
    lines.append(
        f"**Sample**: {df['anchor_ts'].min().date()} → {df['anchor_ts'].max().date()} "
        f"({n_days} trade days, {len(df)} trades)"
    )
    lines.append("")
    lines.append(
        "**Δ convention**: per-trade Δ = `ret_30m − control_ret_30m` (paired event vs same-time-of-day, same-day control)."
    )
    lines.append("")

    # ------------ Section 1: cumulative equity ------------ #
    lines.append("## 1. Cumulative equity (Δ-points)")
    lines.append("")
    lines.append("| Strategy | Total Δ | Final equity | First day | Last day |")
    lines.append("|---|---:|---:|---|---|")
    for t in ["long_call_e1", "long_put_e5", "pcs_monday", "composite"]:
        c = curves[t]
        total = float(c["delta_sum"].sum())
        final = float(c["cum_delta"].iloc[-1]) if len(c) > 0 else 0.0
        first = c["date"].iloc[0].date().isoformat() if len(c) > 0 else "—"
        last = c["date"].iloc[-1].date().isoformat() if len(c) > 0 else "—"
        lines.append(
            f"| {t} | {fmt(total, sign=True)} | {fmt(final, sign=True)} | {first} | {last} |"
        )
    lines.append("")
    lines.append("See `equity_curve.png` for the full daily curve + composite underwater plot.")
    lines.append("")

    # ------------ Section 2: drawdown ------------ #
    lines.append("## 2. Drawdown analysis (daily equity curve)")
    lines.append("")
    lines.append(
        "| Strategy | Max DD | DD start | DD trough | Recovery (days) | Avg DD duration | # DD episodes |"
    )
    lines.append("|---|---:|---|---|---:|---:|---:|")
    for t in ["long_call_e1", "long_put_e5", "pcs_monday", "composite"]:
        d = dd[t]
        rec = d["max_dd_recovery_days"]
        rec_str = f"{rec}" if rec is not None else "never recovered in-sample"
        lines.append(
            f"| {t} | {fmt(d['max_dd'], sign=True)} | {d['max_dd_start'] or '—'} | "
            f"{d['max_dd_trough'] or '—'} | {rec_str} | {fmt(d['avg_dd_duration_days'])} | {d['n_drawdowns']} |"
        )
    lines.append("")
    lines.append("### Worst consecutive losing streak (per-trade level)")
    lines.append("")
    lines.append("| Strategy | Streak length | Cumulative Δ during streak |")
    lines.append("|---|---:|---:|")
    for t, (n, s) in streaks.items():
        lines.append(f"| {t} | {n} | {fmt(s, sign=True)} |")
    lines.append("")

    # ------------ Section 3: daily P&L distribution ------------ #
    lines.append("## 3. Daily P&L distribution (composite)")
    lines.append("")
    d = dist["composite"]
    lines.append(f"- **N trade days**: {d['n_days']}")
    lines.append(f"- **Median day**: {fmt(d['median_day'], sign=True)} Δ-pts")
    lines.append(
        f"- **Mean day**: {fmt(d['mean_day'], sign=True)} Δ-pts (std {fmt(d['std_day'])})"
    )
    lines.append(f"- **Best day**: {fmt(d['max_day'], sign=True)} Δ-pts")
    lines.append(f"- **Worst day**: {fmt(d['min_day'], sign=True)} Δ-pts")
    lines.append(
        f"- **% positive days**: {fmt(d['pct_pos_days'])}%  /  "
        f"**% negative**: {fmt(d['pct_neg_days'])}%  /  "
        f"**% zero**: {fmt(d['pct_zero_days'])}%"
    )
    lines.append(
        f"- **Percentiles (Δ-pts)**: p10={fmt(d['p10'], sign=True)}, "
        f"p25={fmt(d['p25'], sign=True)}, p75={fmt(d['p75'], sign=True)}, "
        f"p90={fmt(d['p90'], sign=True)}"
    )
    lines.append("")
    lines.append("### Per-component breakdown")
    lines.append("")
    lines.append(
        "| Strategy | n days | median | mean | %pos | %neg | best | worst |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for t in ["long_call_e1", "long_put_e5", "pcs_monday"]:
        dd_t = dist[t]
        lines.append(
            f"| {t} | {dd_t['n_days']} | {fmt(dd_t['median_day'], sign=True)} | "
            f"{fmt(dd_t['mean_day'], sign=True)} | {fmt(dd_t['pct_pos_days'])}% | "
            f"{fmt(dd_t['pct_neg_days'])}% | {fmt(dd_t['max_day'], sign=True)} | "
            f"{fmt(dd_t['min_day'], sign=True)} |"
        )
    lines.append("")

    # ------------ Section 4: walk-forward by calendar date ------------ #
    lines.append("## 4. Walk-forward stability (calendar-date split)")
    lines.append("")
    lines.append(f"Midpoint date: **{midpoint[:10]}**")
    lines.append("")
    lines.append(
        "| Half | Window | Trades | Trade days | Total Δ | Mean Δ/trade | Mean Δ/day | Median Δ/day | %pos days | Win% trades |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for label in ["H1", "H2"]:
        h = wf[label]
        lines.append(
            f"| {label} | {h['start']} → {h['end']} | {h['trades']} | {h['trade_days']} | "
            f"{fmt(h['total_delta'], sign=True)} | {fmt(h['mean_delta_per_trade'], sign=True)} | "
            f"{fmt(h['mean_day_delta'], sign=True)} | {fmt(h['median_day_delta'], sign=True)} | "
            f"{fmt(h['pct_pos_days'])}% | {fmt(h['win_rate_trades'])}% |"
        )
    lines.append("")

    # ------------ Section 5: position-sizing sanity ------------ #
    lines.append("## 5. Position-sizing sanity check ($/Δ-pt proxy)")
    lines.append("")
    lines.append(
        f"Assuming **1 Δ-point ≈ ${DOLLARS_PER_DELTA_PT:.0f}** on a typical 0DTE SPX vertical:"
    )
    lines.append("")
    lines.append(
        f"- **Total Δ over sample**: {fmt(total_delta, sign=True)} pts → "
        f"**${total_dollars:+,.0f}** over {n_days} trade days"
    )
    lines.append(
        f"- **Mean day**: {fmt(dist['composite']['mean_day'], sign=True)} Δ-pts → "
        f"**${dist['composite']['mean_day'] * DOLLARS_PER_DELTA_PT:+,.0f}/day**"
    )
    lines.append(
        f"- **Annualized (252 td)**: {fmt(annualized_delta, sign=True)} Δ-pts → "
        f"**${annualized_dollars:+,.0f}/yr**"
    )
    lines.append(
        f"- **Max drawdown (composite)**: {fmt(max_dd_comp['max_dd'], sign=True)} Δ-pts → "
        f"**${max_dd_dollars:+,.0f}**"
    )
    lines.append(
        "- Caveat: 1 contract per trade; no slippage; no comms; no IV decay realism. "
        "Realized $/pt typically 50–80% of this proxy on real fills."
    )
    lines.append("")

    # ------------ Section 6: same-day signal correlation ------------ #
    lines.append("## 6. Same-day signal correlation (E1 vs E5)")
    lines.append("")
    lines.append(f"- **E1 trade days**: {corr['e1_days']}")
    lines.append(f"- **E5 trade days**: {corr['e5_days']}")
    lines.append(f"- **PCS-Monday trade days**: {corr['pcs_days']}")
    lines.append(
        f"- **Days where BOTH E1 and E5 fire**: {corr['shared_e1_e5_days']} "
        f"({fmt(corr['shared_pct_of_e5_days'])}% of E5 days)"
    )
    lines.append(f"- **E1-only days**: {corr['e1_only_days']}")
    lines.append(f"- **E5-only days**: {corr['e5_only_days']}")
    lines.append("")
    lines.append("**Within shared days, firing order:**")
    lines.append(f"- E1 fully before E5: {corr['e1_first_on_shared']}")
    lines.append(f"- E5 fully before E1: {corr['e5_first_on_shared']}")
    lines.append(f"- Interleaved (overlap): {corr['interleaved_on_shared']}")
    lines.append("")
    lines.append("**Δ-points by day-cohort:**")
    lines.append(f"- Shared days (both fire): {fmt(corr['shared_day_total_delta'], sign=True)}")
    lines.append(f"- E1-only days: {fmt(corr['e1_only_total_delta'], sign=True)}")
    lines.append(f"- E5-only days: {fmt(corr['e5_only_total_delta'], sign=True)}")
    lines.append("")

    # ------------ Section 7: concentration / RED FLAGS ------------ #
    lines.append("## 7. Concentration & RED FLAGS")
    lines.append("")
    lines.append(f"- **Total Δ**: {fmt(conc['total_delta'], sign=True)} pts across {n_days} days")
    lines.append(
        f"- **Single best day** ({conc['top1_day_date']}): {fmt(conc['top1_day_delta'], sign=True)} pts "
        f"= **{fmt(conc['top1_day_pct'])}%** of total"
    )
    lines.append(f"- **Top 5 days**: {fmt(conc['top5_days_pct'])}% of total Δ")
    lines.append(f"- **Top 10 days**: {fmt(conc['top10_days_pct'])}% of total Δ")
    lines.append("")
    lines.append("### Risk flags (interpretive)")
    flags = []
    if conc["top1_day_pct"] > 25:
        flags.append(
            f"- 🚩 **Single-day concentration**: {fmt(conc['top1_day_pct'])}% of all P&L from one day → fragile to that regime not repeating."
        )
    if conc["top5_days_pct"] > 60:
        flags.append(
            f"- 🚩 **5-day concentration**: {fmt(conc['top5_days_pct'])}% of P&L from 5 days (of {n_days})."
        )
    if max_dd_comp["max_dd_recovery_days"] is None:
        flags.append(
            f"- 🚩 **Unresolved drawdown**: composite max DD ({fmt(max_dd_comp['max_dd'], sign=True)} pts) never fully recovered in-sample."
        )
    if dist["composite"]["pct_neg_days"] > 50:
        flags.append(
            f"- 🚩 **More losing days than winning days**: {fmt(dist['composite']['pct_neg_days'])}% negative."
        )
    if h2["mean_day_delta"] < 0.5 * h1["mean_day_delta"] and h1["mean_day_delta"] > 0:
        flags.append(
            f"- 🚩 **H2 daily mean is <50% of H1**: regime decay risk ({fmt(h1['mean_day_delta'], sign=True)} → {fmt(h2['mean_day_delta'], sign=True)} per day)."
        )
    if corr["shared_pct_of_e5_days"] > 75 and corr["e5_days"] > 0:
        flags.append(
            f"- 🚩 **E5 fires almost only on E1 days** ({fmt(corr['shared_pct_of_e5_days'])}%): the two are NOT independent regime calls."
        )
    if streaks["composite"][0] >= 7:
        flags.append(
            f"- 🚩 **Composite losing streak ≥ 7 trades** ({streaks['composite'][0]}): live psychological pressure to expect."
        )
    if not flags:
        flags.append("- (none auto-detected above thresholds)")
    lines.extend(flags)
    lines.append("")

    FINDINGS_PATH.write_text("\n".join(lines))


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> int:
    df = load_ledger()
    daily = per_day_aggregate(df)
    curves = equity_curves(daily)
    plot_equity_curves(curves, PLOT_PATH)

    dd = {t: drawdown_stats(curves[t]) for t in curves}
    streaks = {
        t: worst_losing_streak(df, t)
        for t in ["long_call_e1", "long_put_e5", "pcs_monday", "composite"]
    }
    dist = {t: daily_distribution(curves[t]) for t in curves}
    wf = walk_forward_by_date(df)
    corr = signal_correlation(df)
    conc = concentration(curves["composite"])

    write_findings(df, daily, curves, dd, streaks, dist, wf, corr, conc)

    # Console summary so a human running the script sees the key numbers.
    comp = curves["composite"]
    total_delta = float(comp["cum_delta"].iloc[-1])
    print(f"Loaded {len(df)} trades over {len(curves['composite'])} trade days.")
    print(f"Composite total Δ: {total_delta:+.2f} pts (~${total_delta * DOLLARS_PER_DELTA_PT:+,.0f} @ ${DOLLARS_PER_DELTA_PT}/pt)")
    print(f"Composite max DD: {dd['composite']['max_dd']:+.2f} pts "
          f"({dd['composite']['max_dd_start']} → {dd['composite']['max_dd_trough']})")
    print(f"Top-1-day concentration: {conc['top1_day_pct']:.1f}% on {conc['top1_day_date']}")
    print(f"E1+E5 shared days: {corr['shared_e1_e5_days']} (of {corr['e5_days']} E5 days)")
    print(f"H1 mean Δ/day: {wf['H1']['mean_day_delta']:+.2f} | H2 mean Δ/day: {wf['H2']['mean_day_delta']:+.2f}")
    print(f"Wrote {FINDINGS_PATH}")
    print(f"Wrote {PLOT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
