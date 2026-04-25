"""IV-anomaly Phase E3+E4+E5 — VIX direction, GEX position, macro events.

Three light cross-asset enrichments combined into one script (each
joins exactly one table to the alerts parquet, so no point in
splitting):

- E3: VIX direction over 30 min before alert_ts (market_snapshots)
- E4: nearest top-3 abs_gex strike for alert's (date, expiry) (greek_exposure_strike)
- E5: minutes to nearest economic event (economic_events)

Each emits its own findings JSON + report.

Outputs:
- ml/findings/iv-anomaly-vix-direction-2026-04-25.json
- ml/findings/iv-anomaly-gex-position-2026-04-25.json
- ml/findings/iv-anomaly-macro-events-2026-04-25.json
- ml/reports/iv-anomaly-vix-direction-2026-04-25.md
- ml/reports/iv-anomaly-gex-position-2026-04-25.md
- ml/reports/iv-anomaly-macro-events-2026-04-25.md
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_LOCAL = REPO_ROOT / ".env.local"
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
NON_ORACLE = ["pnl_itm_touch", "pnl_eod"]


def load_env() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


def regime_label(pct: float) -> str:
    if pd.isna(pct):
        return "unknown"
    a = abs(pct)
    if a < 0.25:
        return "chop"
    direction = "up" if pct > 0 else "down"
    if a < 1.0:
        return f"mild_trend_{direction}"
    if a < 2.0:
        return f"strong_trend_{direction}"
    return f"extreme_{direction}"


def attach_regime(df: pd.DataFrame) -> pd.DataFrame:
    df["alert_ct"] = pd.to_datetime(df["alert_ts"], utc=True).dt.tz_convert("US/Central")
    df["date"] = df["alert_ct"].dt.date
    day = (
        df.sort_values("alert_ct")
        .groupby(["ticker", "date"])
        .agg(first_spot=("spot_at_detect", "first"), last_spot=("close_spot", "last"))
        .reset_index()
    )
    day["pct_change"] = (day["last_spot"] - day["first_spot"]) / day["first_spot"] * 100.0
    day["regime"] = day["pct_change"].apply(regime_label)
    return df.merge(day[["ticker", "date", "regime"]], on=["ticker", "date"], how="left")


def pick_best(df: pd.DataFrame) -> dict:
    best = {}
    ticker_level = {}
    for ticker, sub in df.groupby("ticker"):
        scores = {s: sub[s].dropna().mean() / sub[s].dropna().std() for s in NON_ORACLE if sub[s].dropna().std()}
        ticker_level[ticker] = max(scores, key=scores.get) if scores else "pnl_eod"
    for (ticker, regime), sub in df.groupby(["ticker", "regime"]):
        if len(sub) >= 30:
            scores = {s: sub[s].dropna().mean() / sub[s].dropna().std() for s in NON_ORACLE if sub[s].dropna().std()}
            best[(ticker, regime)] = max(scores, key=scores.get) if scores else ticker_level[ticker]
        else:
            best[(ticker, regime)] = ticker_level[ticker]
    return best


def aggregate(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
    )
    return g.round(2)


def emit_table(lines: list[str], title: str, table: pd.DataFrame, min_n: int = 30) -> None:
    lines.append(f"## {title}")
    lines.append("")
    cols = list(table.index.names)
    header = "| " + " | ".join(cols + ["n", "win%", "mean%", "mean $"]) + " |"
    sep = "| " + " | ".join(["---"] * len(cols) + ["---:"] * 4) + " |"
    lines.append(header)
    lines.append(sep)
    for idx, row in table.iterrows():
        n = int(row["n"])
        if n < min_n:
            continue
        ix = idx if isinstance(idx, tuple) else (idx,)
        vals = " | ".join(str(v) for v in ix)
        lines.append(
            f"| {vals} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")


# ──────── E3 — VIX direction ────────

def run_e3(df: pd.DataFrame, conn) -> None:
    """VIX direction over 30 min before alert_ts."""
    print("[E3] fetching market_snapshots...", file=sys.stderr)
    sql = """
    SELECT date, entry_time, vix, vix1d, vix9d
    FROM market_snapshots
    WHERE date >= '2026-04-13' AND date < '2026-04-25'
    ORDER BY date, entry_time
    """
    snaps = pd.read_sql_query(sql, conn)
    # entry_time is text like "10:15 AM CT" or "pre-market". Strip " CT" suffix and
    # filter out non-time entries before parsing.
    cleaned = snaps["entry_time"].astype(str).str.replace(r"\s*CT\s*$", "", regex=True).str.strip()
    snaps["entry_time_clean"] = cleaned
    snaps = snaps[snaps["entry_time_clean"].str.match(r"^\d{1,2}:\d{2}\s*(AM|PM)$", case=False, na=False)].copy()
    snaps["snap_ts"] = pd.to_datetime(
        snaps["date"].astype(str) + " " + snaps["entry_time_clean"],
        format="%Y-%m-%d %I:%M %p",
        errors="coerce",
    )
    snaps["snap_ts"] = (
        snaps["snap_ts"].dt.tz_localize("US/Central", ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
    )
    snaps = snaps.dropna(subset=["snap_ts", "vix"]).sort_values("snap_ts").reset_index(drop=True)
    snaps["vix"] = snaps["vix"].astype(float)
    print(f"[E3] {len(snaps):,} usable VIX snapshots after cleanup", file=sys.stderr)

    # For each alert, find latest snap at or before alert_ts and 30min-before snap
    feats = []
    for _, alert in df.iterrows():
        alert_ts = alert["alert_ts"]
        prior_30 = alert_ts - pd.Timedelta(minutes=30)
        recent = snaps[(snaps["snap_ts"] <= alert_ts) & (snaps["snap_ts"] >= prior_30 - pd.Timedelta(minutes=10))]
        if len(recent) < 2:
            feats.append({"vix_at_alert": np.nan, "vix_change_30m": np.nan, "vix_regime": "unknown"})
            continue
        vix_now = float(recent.iloc[-1]["vix"])
        vix_then = float(recent.iloc[0]["vix"])
        delta = vix_now - vix_then
        if delta > 0.2:
            r = "rising"
        elif delta < -0.2:
            r = "falling"
        else:
            r = "flat"
        feats.append({"vix_at_alert": vix_now, "vix_change_30m": delta, "vix_regime": r})

    df = df.copy()
    df = pd.concat([df.reset_index(drop=True), pd.DataFrame(feats).reset_index(drop=True)], axis=1)

    findings = {
        "n_total": int(len(df)),
        "n_with_vix": int((~df["vix_regime"].eq("unknown")).sum()),
        "by_vix_regime": aggregate(df, ["vix_regime", "side"]).reset_index().to_dict(orient="records"),
        "by_vix_regime_outer_regime": aggregate(df, ["regime", "vix_regime", "side"]).reset_index().to_dict(orient="records"),
    }
    out_findings = REPO_ROOT / "ml" / "findings" / "iv-anomaly-vix-direction-2026-04-25.json"
    out_findings.write_text(json.dumps(findings, indent=2, default=str))
    print(f"[E3] wrote {out_findings}")

    lines: list[str] = []
    lines.append("# IV-Anomaly VIX Direction (Phase E3) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts; {int((~df['vix_regime'].eq('unknown')).sum()):,} with VIX features computed.")
    lines.append("")
    lines.append("**Method:** for each alert, computes VIX change over the 30-min window ending at alert_ts. "
                 "Rising = +0.2pt or more; falling = -0.2pt or more; flat = in between.")
    lines.append("")
    emit_table(lines, "VIX regime × side (aggregate)", aggregate(df, ["vix_regime", "side"]))
    emit_table(lines, "Outer regime × VIX direction × side", aggregate(df, ["regime", "vix_regime", "side"]))
    out_report = REPO_ROOT / "ml" / "reports" / "iv-anomaly-vix-direction-2026-04-25.md"
    out_report.write_text("\n".join(lines))
    print(f"[E3] wrote {out_report}")


# ──────── E4 — GEX position ────────

def run_e4(df: pd.DataFrame, conn) -> None:
    """For each SPX-family alert, position relative to nearest top-3 abs_gex strike."""
    print("[E4] fetching greek_exposure_strike...", file=sys.stderr)
    sql = """
    SELECT date, expiry, strike, abs_gex, net_gex
    FROM greek_exposure_strike
    WHERE date >= '2026-04-13' AND date < '2026-04-25'
    ORDER BY date, expiry, abs_gex DESC
    """
    gex = pd.read_sql_query(sql, conn)
    gex["strike"] = gex["strike"].astype(float)
    gex["abs_gex"] = gex["abs_gex"].astype(float)
    gex["net_gex"] = gex["net_gex"].astype(float)
    # Top-3 abs_gex strikes per (date, expiry)
    top3 = (
        gex.sort_values(["date", "expiry", "abs_gex"], ascending=[True, True, False])
        .groupby(["date", "expiry"])
        .head(3)
    )

    feats = []
    for _, alert in df.iterrows():
        ad = alert["date"]
        ae = alert["expiry"]
        a_strike = float(alert["strike"])
        a_spot = float(alert["spot_at_detect"]) if pd.notna(alert["spot_at_detect"]) else np.nan
        sub = top3[(top3["date"] == ad) & (top3["expiry"].astype(str) == str(ae))]
        if len(sub) == 0 or pd.isna(a_spot):
            feats.append({
                "n_top3_gex": 0, "nearest_gex_strike": np.nan, "dist_to_gex_pct": np.nan,
                "gex_above_or_below": "missing", "alert_in_gex_zone": False, "nearest_gex_net": np.nan,
            })
            continue
        sub = sub.copy()
        sub["dist"] = (sub["strike"] - a_strike).abs()
        nearest = sub.sort_values("dist").iloc[0]
        nearest_strike = float(nearest["strike"])
        nearest_net = float(nearest["net_gex"])
        # Position of nearest top-3 GEX strike vs current spot
        if nearest_strike > a_spot:
            pos = "above_spot"
        elif nearest_strike < a_spot:
            pos = "below_spot"
        else:
            pos = "at_spot"
        # Is the alert strike in the gamma zone (between spot and nearest top-3 GEX)?
        in_zone = (
            (a_spot <= a_strike <= nearest_strike) or (nearest_strike <= a_strike <= a_spot)
        )
        feats.append({
            "n_top3_gex": int(len(sub)),
            "nearest_gex_strike": nearest_strike,
            "dist_to_gex_pct": float((nearest_strike - a_spot) / a_spot * 100),
            "gex_above_or_below": pos,
            "alert_in_gex_zone": bool(in_zone),
            "nearest_gex_net": nearest_net,
        })

    df = df.copy()
    df = pd.concat([df.reset_index(drop=True), pd.DataFrame(feats).reset_index(drop=True)], axis=1)

    # Restrict to SPX-family for reporting (other tickers may not have greek_exposure_strike rows)
    spx_family = df[df["ticker"].isin(["SPXW", "SPY", "QQQ", "NDXP", "IWM"])].copy()

    findings = {
        "n_total": int(len(df)),
        "n_with_gex": int((~df["gex_above_or_below"].eq("missing")).sum()),
        "by_gex_position": aggregate(df, ["gex_above_or_below", "side"]).reset_index().to_dict(orient="records"),
        "by_gex_zone": aggregate(df, ["alert_in_gex_zone", "side"]).reset_index().to_dict(orient="records"),
        "by_gex_position_regime": aggregate(spx_family, ["regime", "gex_above_or_below", "side"]).reset_index().to_dict(orient="records"),
    }
    out_findings = REPO_ROOT / "ml" / "findings" / "iv-anomaly-gex-position-2026-04-25.json"
    out_findings.write_text(json.dumps(findings, indent=2, default=str))
    print(f"[E4] wrote {out_findings}")

    lines: list[str] = []
    lines.append("# IV-Anomaly GEX Position (Phase E4) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts; {int((~df['gex_above_or_below'].eq('missing')).sum()):,} with GEX features computed.")
    lines.append("")
    lines.append("**Method:** for each alert, finds the top-3 abs_gex strikes for that (date, expiry) and "
                 "checks the position of the *nearest* one relative to current spot. "
                 "`alert_in_gex_zone` is true when the alert strike is between spot and the nearest top-3 GEX.")
    lines.append("")
    emit_table(lines, "Nearest top-3 GEX above/below spot × side", aggregate(df, ["gex_above_or_below", "side"]))
    emit_table(lines, "Alert strike in gamma zone × side", aggregate(df, ["alert_in_gex_zone", "side"]))
    emit_table(lines, "SPX-family: regime × GEX position × side", aggregate(spx_family, ["regime", "gex_above_or_below", "side"]))
    out_report = REPO_ROOT / "ml" / "reports" / "iv-anomaly-gex-position-2026-04-25.md"
    out_report.write_text("\n".join(lines))
    print(f"[E4] wrote {out_report}")


# ──────── E5 — Macro events ────────

def run_e5(df: pd.DataFrame, conn) -> None:
    print("[E5] fetching economic_events...", file=sys.stderr)
    sql = """
    SELECT event_time, event_name, event_type
    FROM economic_events
    WHERE event_time >= '2026-04-13' AND event_time < '2026-04-25'
    ORDER BY event_time
    """
    events = pd.read_sql_query(sql, conn)
    events["event_time"] = pd.to_datetime(events["event_time"], utc=True)
    high_impact_keywords = ("FOMC", "CPI", "PPI", "NFP", "Nonfarm", "Retail Sales", "GDP", "Powell")
    events["high_impact"] = events["event_name"].str.contains("|".join(high_impact_keywords), case=False, na=False)
    high = events[events["high_impact"]].sort_values("event_time").reset_index(drop=True)
    print(f"[E5] {len(events)} total events, {len(high)} high-impact in window", file=sys.stderr)

    feats = []
    for _, alert in df.iterrows():
        alert_ts = alert["alert_ts"]
        if len(high) == 0:
            feats.append({"nearest_event_minutes": np.nan, "in_event_window": False, "nearest_event_name": None})
            continue
        deltas = (high["event_time"] - alert_ts).dt.total_seconds() / 60.0
        idx_min = deltas.abs().idxmin()
        nearest_min = float(deltas.loc[idx_min])
        feats.append({
            "nearest_event_minutes": nearest_min,
            "in_event_window": bool(abs(nearest_min) < 30),
            "nearest_event_name": str(high.loc[idx_min, "event_name"]),
        })

    df = df.copy()
    df = pd.concat([df.reset_index(drop=True), pd.DataFrame(feats).reset_index(drop=True)], axis=1)

    findings = {
        "n_total": int(len(df)),
        "n_high_impact_events_in_window": int(len(high)),
        "by_in_event_window": aggregate(df, ["in_event_window", "side"]).reset_index().to_dict(orient="records"),
        "by_in_event_window_regime": aggregate(df, ["regime", "in_event_window", "side"]).reset_index().to_dict(orient="records"),
        "events_in_window": [
            {"event_time": str(r["event_time"]), "name": str(r["event_name"]), "type": str(r["event_type"])}
            for _, r in high.iterrows()
        ],
    }
    out_findings = REPO_ROOT / "ml" / "findings" / "iv-anomaly-macro-events-2026-04-25.json"
    out_findings.write_text(json.dumps(findings, indent=2, default=str))
    print(f"[E5] wrote {out_findings}")

    lines: list[str] = []
    lines.append("# IV-Anomaly Macro Events (Phase E5) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts; {len(high)} high-impact events in window "
                 "(FOMC, CPI, PPI, NFP, Retail Sales, GDP, Powell).")
    lines.append("")
    if len(high) > 0:
        lines.append("**Events in window:**")
        lines.append("")
        for _, r in high.head(20).iterrows():
            lines.append(f"- {r['event_time']} — {r['event_name']}")
        lines.append("")
    lines.append("**Method:** event window = ±30 min of alert_ts.")
    lines.append("")
    emit_table(lines, "In-event window × side", aggregate(df, ["in_event_window", "side"]))
    emit_table(lines, "Outer regime × in_event_window × side", aggregate(df, ["regime", "in_event_window", "side"]))
    out_report = REPO_ROOT / "ml" / "reports" / "iv-anomaly-macro-events-2026-04-25.md"
    out_report.write_text("\n".join(lines))
    print(f"[E5] wrote {out_report}")


# ──────── Main ────────

def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    df = pd.read_parquet(BACKTEST_PATH)
    df["alert_ts"] = pd.to_datetime(df["alert_ts"], utc=True)
    df = attach_regime(df)
    best = pick_best(df)
    df["best_strategy"] = df.apply(lambda r: best.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1)
    df["best_pnl_pct"] = df.apply(lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan, axis=1)
    df["entry_dollars"] = df["entry_premium"].astype(float) * 100.0
    df["best_dollar"] = df["entry_dollars"] * df["best_pnl_pct"]

    with psycopg2.connect(db_url) as conn:
        run_e3(df, conn)
        run_e4(df, conn)
        run_e5(df, conn)


if __name__ == "__main__":
    main()
