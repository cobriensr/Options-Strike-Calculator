"""IV-anomaly Phase D1 — path-shape extraction with regime slicing.

What Phase A/B/C left out: the **shape of the trade between entry
and outcome**. An alert that "wins" with +60% peak having gone -80%
first is unholdable. An alert that "loses" but never went below
-30% before EOD is a manageable bet.

Per-alert path features (computed from full premium + spot trajectory):

  mae_to_peak_pct  — worst drawdown from entry on the way to peak
  mae_to_close_pct — worst drawdown from entry holding to EOD
  time_in_itm_pct  — % of post-first-ITM minutes spent ITM
  n_itm_re_entries — OTM→ITM re-entry count after first touch
  peak_before_itm  — bool: did premium peak before strike went ITM?

Sliced by ticker × regime × side using D0's regime classifier.

Outputs:
- ml/data/iv-anomaly-path-shape.parquet
- ml/findings/iv-anomaly-path-shape-2026-04-25.json
- ml/reports/iv-anomaly-path-shape-2026-04-25.md
- ml/plots/iv-anomaly-path-shape/*.png
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(REPO_ROOT / "ml"))

from iv_anomaly_utils import (  # noqa: E402
    aggregate_pnl,
    apply_best_strategy,
    attach_regime,
    load_session_regime_labels,
    pick_best_strategy_per_ticker_regime,
    silence_pandas_psycopg2_warning,
    to_jsonable,
)

silence_pandas_psycopg2_warning()
ENV_LOCAL = REPO_ROOT / ".env.local"
OUT_DATA = REPO_ROOT / "ml" / "data" / "iv-anomaly-path-shape.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-path-shape-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-path-shape-2026-04-25.md"
OUT_PLOTS = REPO_ROOT / "ml" / "plots" / "iv-anomaly-path-shape"


def load_env() -> None:
    if not ENV_LOCAL.exists():
        return
    for line in ENV_LOCAL.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k, v.strip().strip('"'))


def fetch_premium_trajectory(conn) -> pd.DataFrame:
    """Full per-minute premium trajectory per anomaly from alert_ts forward.

    Truncates when the strike goes ITM (snapshots only store OTM strikes
    by design). That truncation IS path-shape information — it tells us
    when the strike crossed.
    """
    sql = """
    SELECT a.id AS anomaly_id, s.ts, s.mid_price
    FROM iv_anomalies a
    JOIN strike_iv_snapshots s
      ON s.ticker = a.ticker AND s.strike = a.strike
      AND s.side = a.side AND s.expiry = a.expiry
      AND s.ts >= a.ts
      AND s.ts <= (a.expiry::timestamptz + interval '21 hours')
    WHERE 'backfill' = ANY(a.flag_reasons)
    ORDER BY a.id, s.ts
    """
    print("[query 1/2] premium trajectory per anomaly...", file=sys.stderr)
    return pd.read_sql_query(sql, conn)


def fetch_spot_trajectory(conn) -> pd.DataFrame:
    """Per-minute spot per ticker (for ITM-persistence calculations)."""
    sql = """
    SELECT ticker, ts, MAX(spot) AS spot
    FROM strike_iv_snapshots
    WHERE ts >= '2026-04-13' AND ts < '2026-04-25'
    GROUP BY ticker, ts
    ORDER BY ticker, ts
    """
    print("[query 2/2] spot trajectory per ticker...", file=sys.stderr)
    return pd.read_sql_query(sql, conn)


def compute_path_features(
    outcomes: pd.DataFrame,
    premium: pd.DataFrame,
    spot: pd.DataFrame,
) -> pd.DataFrame:
    """Per-alert path-shape features."""
    # Index premium by anomaly for quick slicing
    print(f"Indexing {len(premium):,} premium rows...", file=sys.stderr)
    premium = premium.sort_values(["anomaly_id", "ts"])
    prem_by_id = {aid: g for aid, g in premium.groupby("anomaly_id")}

    # Index spot by ticker for quick slicing
    spot = spot.sort_values(["ticker", "ts"])
    spot_by_ticker = {t: g for t, g in spot.groupby("ticker")}

    rows = []
    for _, alert in outcomes.iterrows():
        aid = int(alert["anomaly_id"])
        entry = float(alert["entry_premium"])
        alert_ts = pd.Timestamp(alert["alert_ts"])
        close_ts = pd.Timestamp(alert["close_ts"]) if pd.notna(alert["close_ts"]) else None
        first_itm_ts = pd.Timestamp(alert["first_itm_ts"]) if pd.notna(alert["first_itm_ts"]) else None
        ticker = alert["ticker"]
        strike = float(alert["strike"])
        side = alert["side"]

        traj = prem_by_id.get(aid)
        if traj is not None and len(traj) > 0 and entry > 0 and pd.notna(entry):
            prices = traj["mid_price"].astype(float).to_numpy()
            ts_seq = pd.to_datetime(traj["ts"]).to_numpy()
            peak_idx = int(np.argmax(prices))
            peak_ts = ts_seq[peak_idx]

            # MAE to peak: min from entry to peak.
            # Phase A-E review fix #2: when peak_idx == 0 (entry IS the
            # peak), `prices[:1].min()` collapses to the entry itself, so
            # `mae_to_peak_pct = 0` regardless. That conflates "no
            # drawdown to peak" with "no data to compute" — set NaN
            # instead, and let the multi-sample case populate normally.
            if peak_idx == 0:
                min_to_peak = np.nan
                mae_to_peak_pct = np.nan
            else:
                min_to_peak = float(prices[: peak_idx + 1].min())
                mae_to_peak_pct = (min_to_peak - entry) / entry if entry > 0 else np.nan

            # MAE to close (last trajectory point, which truncates at ITM crossing or EOD)
            min_to_close = float(prices.min())
            mae_to_close_pct = (min_to_close - entry) / entry if entry > 0 else np.nan

            premium_truncated_at = pd.Timestamp(ts_seq[-1]) if len(ts_seq) > 0 else None
            n_premium_samples = int(len(prices))
        else:
            min_to_peak = np.nan
            mae_to_peak_pct = np.nan
            min_to_close = np.nan
            mae_to_close_pct = np.nan
            peak_ts = None
            premium_truncated_at = None
            n_premium_samples = 0

        # ITM persistence — needs spot trajectory from first_itm_ts to close_ts
        time_in_itm_pct = np.nan
        n_itm_re_entries = np.nan
        if first_itm_ts is not None and close_ts is not None:
            spot_traj = spot_by_ticker.get(ticker)
            if spot_traj is not None and len(spot_traj) > 0:
                window = spot_traj[
                    (spot_traj["ts"] >= first_itm_ts) & (spot_traj["ts"] <= close_ts)
                ]
                if len(window) > 0:
                    spots = window["spot"].astype(float).to_numpy()
                    if side == "call":
                        in_itm = spots >= strike
                    else:
                        in_itm = spots <= strike
                    time_in_itm_pct = float(in_itm.mean() * 100.0)
                    # OTM→ITM re-entry count
                    transitions = np.diff(in_itm.astype(int))
                    n_itm_re_entries = int((transitions == 1).sum())

        # peak_before_itm: did premium peak land before first-ITM?
        peak_before_itm = None
        if first_itm_ts is not None and peak_ts is not None:
            peak_before_itm = pd.Timestamp(peak_ts) < first_itm_ts

        rows.append({
            "anomaly_id": aid,
            "ticker": ticker,
            "strike": strike,
            "side": side,
            "expiry": alert["expiry"],
            "alert_ts": alert_ts,
            "first_itm_ts": first_itm_ts,
            "close_ts": close_ts,
            "entry_premium": entry,
            "min_premium_to_peak": min_to_peak,
            "mae_to_peak_pct": mae_to_peak_pct,
            "min_premium_to_close": min_to_close,
            "mae_to_close_pct": mae_to_close_pct,
            "n_premium_samples": n_premium_samples,
            "peak_premium_pct": float(alert["peak_premium_pct"]) if pd.notna(alert["peak_premium_pct"]) else np.nan,
            "premium_truncated_at": premium_truncated_at,
            "time_in_itm_pct": time_in_itm_pct,
            "n_itm_re_entries": n_itm_re_entries,
            "peak_before_itm": peak_before_itm,
            "touched_itm": int(alert["touched_itm"]),
        })

    return pd.DataFrame(rows)


def _attach_path_regime(outcomes: pd.DataFrame, path: pd.DataFrame) -> pd.DataFrame:
    """Attach session-bounded regime labels onto path-shape rows.

    Joins per-anomaly date from outcomes onto path rows, then merges
    the shared regime-labels parquet via `attach_regime`. Replaces the
    Phase D1 inline alert-clustering computation.
    """
    o = outcomes.copy()
    o["alert_ct"] = pd.to_datetime(o["alert_ts"], utc=True).dt.tz_convert("US/Central")
    o["date"] = o["alert_ct"].dt.date
    o_slim = o[["anomaly_id", "date"]]
    p = path.merge(o_slim, on="anomaly_id", how="left")
    return attach_regime(p, load_session_regime_labels())


# ──────── Aggregation ────────

def aggregate_path_shape(df: pd.DataFrame) -> pd.DataFrame:
    """Per-(ticker, regime, side) path-shape stats."""
    g = df.groupby(["ticker", "regime", "side"]).agg(
        n=("anomaly_id", "count"),
        median_mae_to_peak=("mae_to_peak_pct", "median"),
        mean_mae_to_peak=("mae_to_peak_pct", "mean"),
        median_mae_to_close=("mae_to_close_pct", "median"),
        mean_mae_to_close=("mae_to_close_pct", "mean"),
        median_peak_pct=("peak_premium_pct", "median"),
        median_time_in_itm=("time_in_itm_pct", "median"),
        median_n_itm_reentries=("n_itm_re_entries", "median"),
        # Phase A-E review fix #14: dropna() before computing the rate so
        # alerts that never touched ITM (peak_before_itm = None) don't get
        # silently lumped in as "peak NOT before ITM". Now this metric is
        # truly conditional on touched_itm = 1.
        pct_peak_before_itm=("peak_before_itm", lambda x: float(x.dropna().mean() * 100) if x.dropna().size > 0 else float("nan")),
        touched_itm_pct=("touched_itm", lambda x: float(x.mean() * 100)),
    )
    return g.round(3)


def winners_vs_losers_mae(df: pd.DataFrame) -> pd.DataFrame:
    """For 'eventual winners' (peak_pct > 0.30) vs losers, what's the MAE to peak?"""
    df = df.dropna(subset=["mae_to_peak_pct", "peak_premium_pct"]).copy()
    df["winner_30"] = df["peak_premium_pct"] >= 0.30
    g = df.groupby(["ticker", "regime", "side", "winner_30"]).agg(
        n=("anomaly_id", "count"),
        median_mae=("mae_to_peak_pct", "median"),
        p25_mae=("mae_to_peak_pct", lambda x: float(np.percentile(x, 25))),
        p75_mae=("mae_to_peak_pct", lambda x: float(np.percentile(x, 75))),
    )
    return g.round(3)


# ──────── Plotting ────────

def plot_mae_to_peak_distribution(df: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    sub = df.dropna(subset=["mae_to_peak_pct", "peak_premium_pct"])
    sub = sub[sub["peak_premium_pct"] >= 0.30]  # eventual winners only
    if len(sub) == 0:
        return
    for ticker in sorted(sub["ticker"].unique()):
        tsub = sub[sub["ticker"] == ticker]
        if len(tsub) < 20:
            continue
        fig, ax = plt.subplots(figsize=(10, 4.5))
        regimes_present = ["chop", "mild_trend_up", "strong_trend_up", "mild_trend_down", "strong_trend_down", "extreme_up", "extreme_down"]
        # Only keep regimes that ACTUALLY have rows after the
        # MAE/peak_pct dropna and the new single-sample exclusion (Phase
        # A-E review fix #3) — otherwise zero-length data lists trip
        # matplotlib's boxplot label-length check.
        regimes_present = [r for r in regimes_present if len(tsub[tsub["regime"] == r]) > 0]
        if not regimes_present:
            plt.close(fig)
            continue
        data = [tsub[tsub["regime"] == r]["mae_to_peak_pct"].values * 100 for r in regimes_present]
        labels = [f"{r}\n(n={len(d)})" for r, d in zip(regimes_present, data)]
        ax.boxplot(data, tick_labels=labels, showmeans=True)
        ax.set_ylabel("MAE before peak (%)")
        ax.set_title(f"{ticker} — drawdown before peak (eventual winners only, peak_pct ≥ 30%)")
        ax.axhline(-50, color="r", linestyle="--", alpha=0.5, label="-50% threshold")
        ax.legend()
        ax.grid(axis="y", alpha=0.3)
        plt.tight_layout()
        fig.savefig(out_dir / f"{ticker}-mae-to-peak.png", dpi=120)
        plt.close(fig)


def plot_aggregate_winner_loser_mae(df: pd.DataFrame, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    sub = df.dropna(subset=["mae_to_peak_pct", "peak_premium_pct"]).copy()
    # Phase A-E review fix #3: alerts with only 1 premium sample have
    # `peak_premium_pct == 0` mechanically (peak == entry), and would
    # land in the `loser (<0%)` bucket below — but they're "no path
    # data," not real losers. Exclude them.
    sub = sub[sub["n_premium_samples"] > 1]
    sub["category"] = pd.cut(
        sub["peak_premium_pct"],
        bins=[-np.inf, 0, 0.30, 1.0, np.inf],
        labels=["loser (<0%)", "small_win (0-30%)", "decent_win (30-100%)", "big_win (>100%)"],
    )
    by_cat = sub.groupby("category", observed=True)["mae_to_peak_pct"].agg(["count", "median"]).round(3)
    fig, ax = plt.subplots(figsize=(10, 4.5))
    cats = ["loser (<0%)", "small_win (0-30%)", "decent_win (30-100%)", "big_win (>100%)"]
    # Keep only categories that have BOTH a series with samples AND a row
    # in by_cat — otherwise data/labels lengths mismatch and boxplot raises.
    cats = [
        c for c in cats
        if c in sub["category"].cat.categories
        and c in by_cat.index
        and len(sub[sub["category"] == c]) > 0
    ]
    data = [sub[sub["category"] == c]["mae_to_peak_pct"].values * 100 for c in cats]
    labels = [f"{c}\n(n={by_cat.loc[c, 'count']:,})" for c in cats]
    if data:
        ax.boxplot(data, tick_labels=labels, showmeans=True, showfliers=False)
    ax.set_ylabel("MAE before peak (%)")
    ax.set_title("Drawdown before peak by eventual outcome (all tickers, all regimes)")
    ax.axhline(-50, color="r", linestyle="--", alpha=0.5, label="-50% threshold")
    ax.axhline(-80, color="darkred", linestyle="--", alpha=0.5, label="-80% threshold")
    ax.legend()
    ax.grid(axis="y", alpha=0.3)
    plt.tight_layout()
    fig.savefig(out_dir / "aggregate-mae-by-outcome.png", dpi=120)
    plt.close(fig)


# ──────── Main ────────

def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    print("Loading outcomes parquet...", file=sys.stderr)
    outcomes = pd.read_parquet(REPO_ROOT / "ml" / "data" / "iv-anomaly-outcomes.parquet")

    with psycopg2.connect(db_url) as conn:
        prem = fetch_premium_trajectory(conn)
        spot = fetch_spot_trajectory(conn)

    print(f"Computing path features for {len(outcomes):,} alerts...", file=sys.stderr)
    path = compute_path_features(outcomes, prem, spot)

    print("Attaching regime labels...", file=sys.stderr)
    path = _attach_path_regime(outcomes, path)

    OUT_DATA.parent.mkdir(parents=True, exist_ok=True)
    path.to_parquet(OUT_DATA, index=False)
    print(f"Wrote {OUT_DATA} ({len(path):,} rows)", file=sys.stderr)

    # Aggregations
    g_path = aggregate_path_shape(path)
    g_winloss = winners_vs_losers_mae(path)

    # ──────── JSON findings ────────
    findings = {
        "n_total": int(len(path)),
        "n_with_premium_trajectory": int((path["n_premium_samples"] > 0).sum()),
        "n_touched_itm": int(path["touched_itm"].sum()),
        "aggregate_path_shape": g_path.reset_index().to_dict(orient="records"),
        "winners_vs_losers_mae": g_winloss.reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=to_jsonable))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown report ────────
    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# IV-Anomaly Path-Shape (Phase D1) — 2026-04-25")
    lines.append(f"**Sample:** {len(path):,} alerts, "
                 f"{(path['n_premium_samples'] > 0).sum():,} with premium trajectory, "
                 f"{int(path['touched_itm'].sum()):,} touched ITM.")
    lines.append("")
    lines.append("**Definitions:**")
    lines.append("")
    lines.append("- `mae_to_peak_pct` — worst drawdown from entry on the way to peak (negative is bad)")
    lines.append("- `mae_to_close_pct` — worst drawdown from entry holding to last trajectory sample")
    lines.append("- `time_in_itm_pct` — % of post-first-ITM minutes where spot was ITM")
    lines.append("- `n_itm_re_entries` — count of OTM→ITM transitions after first touch (whip-saw indicator)")
    lines.append("- `peak_before_itm` — premium peaked BEFORE strike crossed (pure IV play, not directional)")
    lines.append("")
    lines.append("**Caveat:** premium trajectory truncates when the alert's strike crosses ITM "
                 "(snapshot table only stores OTM strikes). MAE_to_close is therefore the worst "
                 "drawdown *on the OTM portion* of the path — does NOT capture post-ITM drawdowns "
                 "(which exist when an ITM premium retraces and the strike re-OTMs).")
    lines.append("")

    # MAE by outcome category (the key chart)
    lines.append("## Drawdown before peak — eventual winners vs losers")
    lines.append("")
    lines.append("Reading: a winner with median MAE -40% means the median *eventual winner* went down 40% before bouncing.")
    lines.append("")
    sub = path.dropna(subset=["mae_to_peak_pct", "peak_premium_pct"]).copy()
    sub["category"] = pd.cut(
        sub["peak_premium_pct"],
        bins=[-np.inf, 0, 0.30, 1.0, np.inf],
        labels=["loser (<0%)", "small_win (0-30%)", "decent_win (30-100%)", "big_win (>100%)"],
    )
    cat_summary = sub.groupby("category", observed=True)["mae_to_peak_pct"].agg(
        ["count", "median", lambda x: float(np.percentile(x, 25)), lambda x: float(np.percentile(x, 75))],
    )
    cat_summary.columns = ["n", "median_mae", "p25_mae", "p75_mae"]
    lines.append("| outcome category | n | median MAE | p25 | p75 |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for cat, row in cat_summary.iterrows():
        lines.append(
            f"| {cat} | {int(row['n']):,} | {row['median_mae']*100:+.1f}% | "
            f"{row['p25_mae']*100:+.1f}% | {row['p75_mae']*100:+.1f}% |"
        )
    lines.append("")

    # Per-(ticker, regime, side) path stats
    lines.append("## Per-ticker × regime × side — path-shape")
    lines.append("")
    lines.append("| ticker | regime | side | n | med MAE→peak | med MAE→close | med peak% | med time in ITM | med re-entries | touched% | peak→ITM% |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (ticker, regime, side), row in g_path.iterrows():
        n = int(row["n"])
        if n < 10:
            continue
        lines.append(
            f"| {ticker} | {regime} | {side} | {n:,} | "
            f"{row['median_mae_to_peak']*100:+.1f}% | "
            f"{row['median_mae_to_close']*100:+.1f}% | "
            f"{row['median_peak_pct']*100:+.1f}% | "
            f"{row['median_time_in_itm']:.0f}% | "
            f"{row['median_n_itm_reentries']:.0f} | "
            f"{row['touched_itm_pct']:.1f}% | "
            f"{row['pct_peak_before_itm']:.1f}% |"
        )
    lines.append("")

    # Winners vs losers MAE per ticker × regime × side (callable bucket)
    lines.append("## Winners (peak ≥ 30%) — MAE before peak by ticker × regime × side")
    lines.append("")
    lines.append("Big numbers means \"eventual winners endured deep drawdowns first\". "
                 "Indicates the regime/ticker is *psychologically punishing* even when right.")
    lines.append("")
    lines.append("| ticker | regime | side | n winners | median MAE | p25 | p75 |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: |")
    win_only = g_winloss.xs(True, level="winner_30", drop_level=True)
    for (ticker, regime, side), row in win_only.iterrows():
        n = int(row["n"])
        if n < 5:
            continue
        lines.append(
            f"| {ticker} | {regime} | {side} | {n} | "
            f"{row['median_mae']*100:+.1f}% | "
            f"{row['p25_mae']*100:+.1f}% | "
            f"{row['p75_mae']*100:+.1f}% |"
        )
    lines.append("")

    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")

    # ──────── Plots ────────
    plot_aggregate_winner_loser_mae(path, OUT_PLOTS)
    plot_mae_to_peak_distribution(path, OUT_PLOTS)
    print(f"Wrote plots to {OUT_PLOTS}")


if __name__ == "__main__":
    main()
