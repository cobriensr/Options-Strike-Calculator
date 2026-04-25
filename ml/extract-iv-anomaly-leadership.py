"""IV-anomaly Phase E1 — index-leadership cross-asset enrichment.

For each backfill alert, computes correlation/lead between SPX and the
NQ/ES/RTY futures basket over the 15-minute window ending at alert_ts.
Adds a `direction_consistent` flag — true when SPX, NQ, ES, RTY, and
the alerted underlying all moved the same direction over that window.

Hypothesis being tested: alerts that fire when the broader tape
already agrees with the alert direction (e.g., a call alert when
SPX+NQ+ES are all green over the prior 15 min) win meaningfully more
than alerts that fire on contradicted tape.

Outputs:
- ml/findings/iv-anomaly-leadership-2026-04-25.json
- ml/reports/iv-anomaly-leadership-2026-04-25.md
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
BACKTEST_PATH = REPO_ROOT / "ml" / "data" / "iv-anomaly-backtest-2026-04-25.parquet"
OUT_FINDINGS = REPO_ROOT / "ml" / "findings" / "iv-anomaly-leadership-2026-04-25.json"
OUT_REPORT = REPO_ROOT / "ml" / "reports" / "iv-anomaly-leadership-2026-04-25.md"

WINDOW_MIN = 15
LAG_MAX_MIN = 5
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


def fetch_index_grid(conn) -> pd.DataFrame:
    """Build a per-minute price grid for SPX, NQ, ES, RTY across the backfill window."""
    futures_sql = """
    SELECT symbol, ts, close
    FROM futures_bars
    WHERE symbol IN ('NQ','ES','RTY')
      AND ts >= '2026-04-13' AND ts < '2026-04-25'
    ORDER BY symbol, ts
    """
    spx_sql = """
    SELECT timestamp AS ts, close
    FROM spx_candles_1m
    WHERE timestamp >= '2026-04-13' AND timestamp < '2026-04-25'
    ORDER BY timestamp
    """
    print("[query 1/3] futures grid...", file=sys.stderr)
    fut = pd.read_sql_query(futures_sql, conn)
    fut["ts"] = pd.to_datetime(fut["ts"], utc=True)
    fut["close"] = fut["close"].astype(float)
    grid = fut.pivot_table(index="ts", columns="symbol", values="close", aggfunc="first")

    print("[query 2/3] SPX grid...", file=sys.stderr)
    spx = pd.read_sql_query(spx_sql, conn)
    spx["ts"] = pd.to_datetime(spx["ts"], utc=True)
    spx["close"] = spx["close"].astype(float)
    spx = spx.set_index("ts")["close"].rename("SPX")

    grid = grid.join(spx, how="outer").sort_index()
    return grid


def fetch_underlying_grid(conn) -> pd.DataFrame:
    """Per-ticker per-minute spot from strike_iv_snapshots (max(spot) per (ticker, ts))."""
    sql = """
    SELECT ticker, ts, MAX(spot) AS spot
    FROM strike_iv_snapshots
    WHERE ts >= '2026-04-13' AND ts < '2026-04-25'
    GROUP BY ticker, ts
    ORDER BY ticker, ts
    """
    print("[query 3/3] underlying spot grid...", file=sys.stderr)
    df = pd.read_sql_query(sql, conn)
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df["spot"] = df["spot"].astype(float)
    return df.pivot_table(index="ts", columns="ticker", values="spot", aggfunc="first")


def compute_returns(grid: pd.DataFrame) -> pd.DataFrame:
    return grid.pct_change()


def per_alert_features(
    alert_ts: pd.Timestamp,
    ticker: str,
    side: str,
    idx_returns: pd.DataFrame,
    und_returns: pd.DataFrame,
) -> dict:
    """Compute leadership features for one alert."""
    lo = alert_ts - pd.Timedelta(minutes=WINDOW_MIN)
    win_idx = idx_returns.loc[(idx_returns.index >= lo) & (idx_returns.index <= alert_ts)]
    if len(win_idx) < 5:
        return {
            "corr_nq_to_spx_15m": np.nan,
            "lag_nq_to_spx_15m": np.nan,
            "corr_es_to_spx_15m": np.nan,
            "corr_rty_to_spx_15m": np.nan,
            "corr_underlying_to_es_15m": np.nan,
            "magnitude_15m_pct": np.nan,
            "spx_dir_15m": np.nan,
            "nq_dir_15m": np.nan,
            "es_dir_15m": np.nan,
            "rty_dir_15m": np.nan,
            "und_dir_15m": np.nan,
            "direction_consistent": False,
            "alignment_with_alert": "missing",
        }

    spx = win_idx["SPX"].dropna()
    nq = win_idx["NQ"].dropna()
    es = win_idx["ES"].dropna()
    rty = win_idx["RTY"].dropna()

    common_nq = spx.index.intersection(nq.index)
    common_es = spx.index.intersection(es.index)
    common_rty = spx.index.intersection(rty.index)

    corr_nq = float(spx.loc[common_nq].corr(nq.loc[common_nq])) if len(common_nq) >= 5 else np.nan
    corr_es = float(spx.loc[common_es].corr(es.loc[common_es])) if len(common_es) >= 5 else np.nan
    corr_rty = float(spx.loc[common_rty].corr(rty.loc[common_rty])) if len(common_rty) >= 5 else np.nan

    # Lag of NQ vs SPX: argmax cross-correlation in [-LAG_MAX, +LAG_MAX]; positive = NQ leads SPX
    lag = np.nan
    if len(common_nq) >= 10:
        spx_v = spx.loc[common_nq].to_numpy()
        nq_v = nq.loc[common_nq].to_numpy()
        best_corr, best_lag = -np.inf, 0
        for k in range(-LAG_MAX_MIN, LAG_MAX_MIN + 1):
            if k > 0:
                a, b = nq_v[:-k], spx_v[k:]
            elif k < 0:
                a, b = nq_v[-k:], spx_v[:k]
            else:
                a, b = nq_v, spx_v
            if len(a) < 5 or np.std(a) == 0 or np.std(b) == 0:
                continue
            c = float(np.corrcoef(a, b)[0, 1])
            if c > best_corr:
                best_corr, best_lag = c, k
        lag = best_lag

    # Underlying corr vs ES (closest cousin to SPX for futures-traded underlyings)
    corr_und = np.nan
    und_dir = np.nan
    magnitude = np.nan
    if ticker in und_returns.columns:
        win_und = und_returns[ticker].loc[lo:alert_ts].dropna()
        if len(win_und) >= 5:
            common_und_es = win_und.index.intersection(es.index)
            if len(common_und_es) >= 5:
                corr_und = float(win_und.loc[common_und_es].corr(es.loc[common_und_es]))
            cum_ret = (1 + win_und).prod() - 1
            magnitude = float(cum_ret * 100.0)
            und_dir = float(np.sign(cum_ret))

    # Direction over the full window (cumulative return sign)
    def _cum_dir(s: pd.Series) -> float:
        if len(s) < 2:
            return float("nan")
        return float(np.sign((1 + s).prod() - 1))

    spx_dir = _cum_dir(spx)
    nq_dir = _cum_dir(nq)
    es_dir = _cum_dir(es)
    rty_dir = _cum_dir(rty)

    dirs = [spx_dir, nq_dir, es_dir, rty_dir]
    if not any(pd.isna(d) for d in dirs) and not pd.isna(und_dir):
        same = (np.array(dirs + [und_dir]) > 0).all() or (np.array(dirs + [und_dir]) < 0).all()
        direction_consistent = bool(same)
    else:
        direction_consistent = False

    # Alignment: do the index dirs match the alert direction?
    if pd.isna(spx_dir):
        align = "missing"
    elif side == "call":
        align = "aligned" if spx_dir > 0 else ("contradicted" if spx_dir < 0 else "neutral")
    else:  # put
        align = "aligned" if spx_dir < 0 else ("contradicted" if spx_dir > 0 else "neutral")

    return {
        "corr_nq_to_spx_15m": corr_nq,
        "lag_nq_to_spx_15m": lag,
        "corr_es_to_spx_15m": corr_es,
        "corr_rty_to_spx_15m": corr_rty,
        "corr_underlying_to_es_15m": corr_und,
        "magnitude_15m_pct": magnitude,
        "spx_dir_15m": spx_dir,
        "nq_dir_15m": nq_dir,
        "es_dir_15m": es_dir,
        "rty_dir_15m": rty_dir,
        "und_dir_15m": und_dir,
        "direction_consistent": direction_consistent,
        "alignment_with_alert": align,
    }


def _attach_session_regime(df: pd.DataFrame) -> pd.DataFrame:
    """Use shared session-bounded regime labels (Phase A-E review fix)."""
    return attach_regime(df, load_session_regime_labels())




def aggregate(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
    )
    return g.round(2)


def main() -> None:
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    df = pd.read_parquet(BACKTEST_PATH)
    df["alert_ts"] = pd.to_datetime(df["alert_ts"], utc=True)

    with psycopg2.connect(db_url) as conn:
        idx_grid = fetch_index_grid(conn)
        und_grid = fetch_underlying_grid(conn)

    print(f"Index grid: {len(idx_grid):,} rows × {idx_grid.shape[1]} cols", file=sys.stderr)
    print(f"Underlying grid: {len(und_grid):,} rows × {und_grid.shape[1]} cols", file=sys.stderr)

    idx_ret = compute_returns(idx_grid)
    und_ret = compute_returns(und_grid)

    print(f"Computing leadership features for {len(df):,} alerts...", file=sys.stderr)
    feats = []
    for i, alert in df.iterrows():
        feats.append(per_alert_features(
            alert["alert_ts"], alert["ticker"], alert["side"], idx_ret, und_ret,
        ))
        if (i + 1) % 2000 == 0:
            print(f"  ... {i+1:,} done", file=sys.stderr)
    feat_df = pd.DataFrame(feats)
    df = pd.concat([df.reset_index(drop=True), feat_df.reset_index(drop=True)], axis=1)

    df = _attach_session_regime(df)
    best = pick_best_strategy_per_ticker_regime(df)
    df["best_strategy"] = df.apply(lambda r: best.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1)
    df["best_pnl_pct"] = df.apply(lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan, axis=1)
    df["entry_dollars"] = df["entry_premium"].astype(float) * 100.0
    df["best_dollar"] = df["entry_dollars"] * df["best_pnl_pct"]

    # Quartile bucket on the SPX 15-min cumulative return magnitude
    df["spx_15m_ret_pct"] = df["spx_dir_15m"]  # placeholder; we use alignment label primarily

    findings = {
        "n_total": int(len(df)),
        "n_with_features": int((~df["alignment_with_alert"].eq("missing")).sum()),
        "by_alignment": aggregate(df, ["alignment_with_alert", "side"]).reset_index().to_dict(orient="records"),
        "by_alignment_regime": aggregate(df, ["regime", "alignment_with_alert", "side"]).reset_index().to_dict(orient="records"),
        "by_direction_consistent": aggregate(df, ["direction_consistent", "side"]).reset_index().to_dict(orient="records"),
        "by_direction_consistent_regime": aggregate(df, ["regime", "direction_consistent", "side"]).reset_index().to_dict(orient="records"),
        "by_alignment_per_ticker": aggregate(df, ["ticker", "alignment_with_alert", "side"]).reset_index().to_dict(orient="records"),
    }
    OUT_FINDINGS.parent.mkdir(parents=True, exist_ok=True)
    OUT_FINDINGS.write_text(json.dumps(findings, indent=2, default=to_jsonable))
    print(f"Wrote {OUT_FINDINGS}")

    # ──────── Markdown report ────────
    lines: list[str] = []
    lines.append("# IV-Anomaly Leadership (Phase E1) — 2026-04-25")
    lines.append(f"**Sample:** {len(df):,} alerts; {(~df['alignment_with_alert'].eq('missing')).sum():,} with leadership features computed.")
    lines.append("")
    lines.append("**Method:** for each alert, computes correlations (SPX vs NQ/ES/RTY) and "
                 "cumulative-return signs over the 15-minute window ending at alert_ts. "
                 "Direction consistent = SPX, NQ, ES, RTY, AND the alerted underlying ALL "
                 "moved the same direction. Alignment = SPX direction matches alert direction "
                 "(call→up, put→down).")
    lines.append("")
    lines.append("**Caveat:** SPX has 6.5h cash-session coverage; futures cover 24h. Alerts "
                 "outside SPX session show 'missing' alignment (~few percent of sample).")
    lines.append("")

    lines.append("## Aggregate — alignment vs side")
    lines.append("")
    lines.append("Direct test of the user's question: alerts on tape that already agrees vs disagrees.")
    lines.append("")
    lines.append("| alignment | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (a, side), row in aggregate(df, ["alignment_with_alert", "side"]).iterrows():
        lines.append(
            f"| {a} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Aggregate — direction_consistent vs side")
    lines.append("")
    lines.append("All 5 of (SPX, NQ, ES, RTY, underlying) moved same direction over 15-min window.")
    lines.append("")
    lines.append("| direction_consistent | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for (dc, side), row in aggregate(df, ["direction_consistent", "side"]).iterrows():
        lines.append(
            f"| {dc} | {side} | {int(row['n']):,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Per-regime × alignment × side")
    lines.append("")
    lines.append("Layered on top of D0's regime spine.")
    lines.append("")
    lines.append("| regime | alignment | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: |")
    for (regime, a, side), row in aggregate(df, ["regime", "alignment_with_alert", "side"]).iterrows():
        n = int(row["n"])
        if n < 30:
            continue
        lines.append(
            f"| {regime} | {a} | {side} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    lines.append("## Per-ticker × alignment × side")
    lines.append("")
    lines.append("| ticker | alignment | side | n | win% | mean% | mean $ |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: |")
    for (ticker, a, side), row in aggregate(df, ["ticker", "alignment_with_alert", "side"]).iterrows():
        n = int(row["n"])
        if n < 30:
            continue
        lines.append(
            f"| {ticker} | {a} | {side} | {n:,} | {row['win_pct']:.1f}% | "
            f"{row['mean_pct']*100:.1f}% | ${row['mean_dollar']:,.0f} |"
        )
    lines.append("")

    OUT_REPORT.parent.mkdir(parents=True, exist_ok=True)
    OUT_REPORT.write_text("\n".join(lines))
    print(f"Wrote {OUT_REPORT}")


if __name__ == "__main__":
    main()
