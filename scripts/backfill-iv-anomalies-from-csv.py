"""
Backfill: synthetic alerts that would have fired across the 10-day UW EOD
CSVs given the current production detector gates.

Replay rules (matches production fetch-strike-iv.ts):

  - Watchlist: 13 tickers in STRIKE_IV_TICKERS
  - Minute-bucket cadence (matches cron's 1-min polling)
  - Market hours only (13:30-20:00 UTC = 8:30-15:00 CT)
  - vol/OI ≥ 5× (cumulative volume through minute / start-of-day OI)
  - max(ask%, bid%) ≥ 65% (CUMULATIVE through minute) — uses REAL tape side
    from CSV instead of the live IV-spread proxy
  - OTM ±3% of spot at evaluation minute
  - Per-ticker min OI tiers from constants.ts

Constraints / what does NOT replay:

  - skew_delta and Z-score IV signals — CSVs have trade prints, not OPRA
    bid/ask quotes, so we can't reconstruct iv_mid/iv_bid/iv_ask. The
    primary vol/OI hard filter still applies, and the IV signals are
    almost always downstream of vol/OI in production anyway.

Output:

  scripts/eod-flow-analysis/output/backfill-alerts/
    alerts-all.json           — flat list of all alerts (machine-readable)
    summary.txt               — human-readable headlines per ticker / day

Usage:

    ml/.venv/bin/python scripts/backfill-iv-anomalies-from-csv.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import duckdb

# ── Paths ────────────────────────────────────────────────────

CSV_DIR = Path.home() / "Downloads" / "EOD-OptionFlow"
SCRIPT_DIR = Path(__file__).parent
OUT_DIR = SCRIPT_DIR / "eod-flow-analysis" / "output" / "backfill-alerts"

# ── Detector settings (mirrors api/_lib/constants.ts) ────────

WATCHLIST = (
    "SPXW", "NDXP", "SPY", "QQQ", "IWM", "SMH",
    "NVDA", "TSLA", "META", "MSFT", "SNDK", "MSTR", "MU",
)
VOL_OI_THRESHOLD = 5.0
SIDE_DOMINANCE_THRESHOLD = 0.65
SILENCE_MIN = 15

# OTM range, bifurcated 2026-04-25: index/broad ETFs ±3%, single names + sector ETF ±5%.
OTM_RANGE_PCT_INDEX = 0.03
OTM_RANGE_PCT_SINGLE_NAME = 0.05
INDEX_TICKERS = {"SPXW", "NDXP", "SPY", "QQQ", "IWM"}

# Per-ticker min OI tiers (mirrors STRIKE_IV_MIN_OI_*) — loosened 2026-04-25
# after the rescope study showed 60-89% single-name flow being dropped by OI.
MIN_OI = {
    "SPXW": 300, "NDXP": 300,
    "SPY": 150, "QQQ": 150,
    "IWM": 75, "SMH": 100,
    "NVDA": 500, "TSLA": 500, "META": 500, "MSFT": 500,
    "SNDK": 100, "MSTR": 100, "MU": 100,
}


def replay_day(con: duckdb.DuckDBPyConnection, csv_path: Path) -> list[dict[str, Any]]:
    """Replay one day's CSV → list of synthetic alerts (pre-dedup)."""
    watchlist_sql = "(" + ", ".join(f"'{t}'" for t in WATCHLIST) + ")"
    min_oi_cases = "\n            ".join(
        f"WHEN '{t}' THEN {oi}" for t, oi in MIN_OI.items()
    )
    otm_range_cases = "\n            ".join(
        f"WHEN '{t}' THEN {OTM_RANGE_PCT_INDEX if t in INDEX_TICKERS else OTM_RANGE_PCT_SINGLE_NAME}"
        for t in WATCHLIST
    )

    q = f"""
    WITH raw AS (
      SELECT
        executed_at,
        date_trunc('minute', executed_at) AS minute,
        CASE
          WHEN option_chain_id LIKE 'SPXW%' THEN 'SPXW'
          WHEN option_chain_id LIKE 'NDXP%' THEN 'NDXP'
          ELSE underlying_symbol
        END AS ticker,
        strike,
        option_type AS opt_side,
        expiry,
        size,
        CASE WHEN side = 'ask' THEN size ELSE 0 END AS ask_size_inc,
        CASE WHEN side = 'bid' THEN size ELSE 0 END AS bid_size_inc,
        open_interest,
        underlying_price,
        premium,
        price
      FROM read_csv_auto('{csv_path}', header=true, sample_size=100000)
      WHERE canceled = false
        AND open_interest > 0
    ),
    filtered AS (
      SELECT * FROM raw
      WHERE ticker IN {watchlist_sql}
        AND EXTRACT(HOUR FROM executed_at) * 60 + EXTRACT(MINUTE FROM executed_at)
            BETWEEN 13*60+30 AND 20*60
    ),
    minute_agg AS (
      SELECT
        minute, ticker, strike, opt_side, expiry,
        SUM(size) AS minute_size,
        SUM(ask_size_inc) AS minute_ask,
        SUM(bid_size_inc) AS minute_bid,
        SUM(premium) AS minute_premium,
        ANY_VALUE(open_interest) AS oi,
        LAST(underlying_price ORDER BY executed_at) AS spot,
        LAST(price ORDER BY executed_at) AS opt_price
      FROM filtered
      GROUP BY 1, 2, 3, 4, 5
    ),
    cumulative AS (
      SELECT
        *,
        SUM(minute_size) OVER w AS cum_size,
        SUM(minute_ask) OVER w AS cum_ask,
        SUM(minute_bid) OVER w AS cum_bid,
        SUM(minute_premium) OVER w AS cum_premium
      FROM minute_agg
      WINDOW w AS (
        PARTITION BY ticker, strike, opt_side, expiry
        ORDER BY minute
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    ),
    gated AS (
      SELECT
        *,
        cum_size::DOUBLE / oi AS vol_oi_ratio,
        cum_ask::DOUBLE / NULLIF(cum_size, 0) AS ask_pct,
        cum_bid::DOUBLE / NULLIF(cum_size, 0) AS bid_pct,
        CASE ticker
            {min_oi_cases}
            ELSE 9999999
        END AS min_oi_floor,
        CASE ticker
            {otm_range_cases}
            ELSE 0
        END AS otm_range_pct
      FROM cumulative
      WHERE oi > 0
    )
    SELECT
      minute,
      ticker,
      strike,
      opt_side,
      expiry,
      vol_oi_ratio,
      ask_pct,
      bid_pct,
      oi,
      cum_size,
      cum_premium,
      spot,
      opt_price,
      CASE WHEN ask_pct >= bid_pct THEN ask_pct ELSE bid_pct END AS dominance,
      CASE WHEN ask_pct >= bid_pct THEN 'ask' ELSE 'bid' END AS side_dominant
    FROM gated
    WHERE vol_oi_ratio >= {VOL_OI_THRESHOLD}
      AND oi >= min_oi_floor
      AND CASE WHEN ask_pct >= bid_pct THEN ask_pct ELSE bid_pct END
          >= {SIDE_DOMINANCE_THRESHOLD}
      AND (
        (opt_side = 'call' AND strike >  spot AND strike <= spot * (1 + otm_range_pct))
        OR
        (opt_side = 'put'  AND strike <  spot AND strike >= spot * (1 - otm_range_pct))
      )
    ORDER BY minute, ticker, strike
    """
    rows = con.execute(q).fetchall()
    cols = [c[0] for c in con.description]
    return [dict(zip(cols, r)) for r in rows]


def apply_silence_dedup(alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Mirror the live aggregation: a (ticker, strike, side, expiry) compound
    key only fires once per `SILENCE_MIN` minutes. Within a silence
    window, the FIRST minute is the canonical alert; subsequent firings
    are dropped (production keeps them as in-place updates on the active
    row, but for backtest visibility the first minute is the right
    "alert fired here" stake in the ground).
    """
    seen: dict[tuple, Any] = {}
    deduped = []
    for a in alerts:
        key = (a["ticker"], float(a["strike"]), a["opt_side"], str(a["expiry"]))
        last_minute = seen.get(key)
        cur_minute = a["minute"]
        if last_minute is None or (cur_minute - last_minute).total_seconds() / 60 >= SILENCE_MIN:
            deduped.append(a)
            seen[key] = cur_minute
    return deduped


def annotate_outcome(con: duckdb.DuckDBPyConnection, csv_path: Path,
                     alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    For each deduped alert, compute the option's PEAK price after the
    alert fires (within the same trading day). This is the rough EOD
    "what happened next" — would the alert have been actionable.
    Returns alerts with `peak_after`, `peak_after_pct`, `eod_close_pct`.
    """
    if not alerts:
        return alerts

    # Pull peak + close prices per (ticker, strike, side, expiry) AFTER the alert minute
    # in one query, then attach.
    peak_q = f"""
    WITH raw AS (
      SELECT
        executed_at,
        CASE
          WHEN option_chain_id LIKE 'SPXW%' THEN 'SPXW'
          WHEN option_chain_id LIKE 'NDXP%' THEN 'NDXP'
          ELSE underlying_symbol
        END AS ticker,
        strike,
        option_type AS opt_side,
        expiry,
        price
      FROM read_csv_auto('{csv_path}', header=true, sample_size=100000)
      WHERE canceled = false
    )
    SELECT
      ticker, strike, opt_side, expiry,
      MAX(executed_at) AS day_last_ts,
      MAX(price) AS day_high_price,
      LAST(price ORDER BY executed_at) AS day_close_price
    FROM raw
    GROUP BY ticker, strike, opt_side, expiry
    """
    rows = con.execute(peak_q).fetchall()
    eod_by_key: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        ticker, strike, side, expiry, last_ts, high, close = r
        key = (ticker, float(strike), side, str(expiry))
        eod_by_key[key] = {
            "day_high": float(high) if high is not None else None,
            "day_close": float(close) if close is not None else None,
        }

    out = []
    for a in alerts:
        key = (a["ticker"], float(a["strike"]), a["opt_side"], str(a["expiry"]))
        eod = eod_by_key.get(key, {})
        entry_price = a.get("opt_price")
        peak_pct = None
        close_pct = None
        if entry_price and entry_price > 0:
            if eod.get("day_high"):
                peak_pct = (eod["day_high"] - entry_price) / entry_price
            if eod.get("day_close"):
                close_pct = (eod["day_close"] - entry_price) / entry_price
        a2 = dict(a)
        a2["entry_price"] = entry_price
        a2["day_high"] = eod.get("day_high")
        a2["day_close"] = eod.get("day_close")
        a2["peak_pct"] = peak_pct
        a2["close_pct"] = close_pct
        out.append(a2)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    csv_files = sorted(CSV_DIR.glob("bot-eod-report-*.csv"))
    if not csv_files:
        print(f"No CSVs found in {CSV_DIR}", file=sys.stderr)
        sys.exit(1)

    con = duckdb.connect()
    all_alerts: list[dict[str, Any]] = []

    for csv in csv_files:
        date_str = csv.stem.replace("bot-eod-report-", "")
        size_gb = csv.stat().st_size / 1e9
        print(f"[replay] {date_str} ({size_gb:.1f}GB)...", file=sys.stderr)

        raw = replay_day(con, csv)
        deduped = apply_silence_dedup(raw)
        annotated = annotate_outcome(con, csv, deduped)
        for a in annotated:
            a["date"] = date_str
            a["minute"] = a["minute"].isoformat() if a.get("minute") else None
            a["expiry"] = str(a["expiry"]) if a.get("expiry") else None
        print(
            f"[done]   {date_str}: {len(raw)} firings → {len(deduped)} alerts after 15-min silence",
            file=sys.stderr,
        )
        all_alerts.extend(annotated)

    # ── Write JSON ──
    out_json = OUT_DIR / "alerts-all.json"
    out_json.write_text(json.dumps(all_alerts, default=str, indent=2))
    print(f"\nWrote {len(all_alerts)} alerts → {out_json}", file=sys.stderr)

    # ── Headlines ──
    write_summary(all_alerts)


def write_summary(alerts: list[dict[str, Any]]) -> None:
    lines = []
    lines.append("# IV Anomaly Backfill — what would have fired (10-day UW EOD CSV replay)")
    lines.append(f"  Total alerts (after 15-min silence dedup): {len(alerts)}")
    lines.append("")

    # ── Per-ticker summary ──
    by_ticker: dict[str, list[dict[str, Any]]] = {}
    for a in alerts:
        by_ticker.setdefault(a["ticker"], []).append(a)

    lines.append("## Per-ticker alert counts + outcome distribution")
    lines.append(f"  {'Ticker':<7} {'Alerts':>7} {'Days':>5} "
                 f"{'AvgPeak':>9} {'AvgClose':>9} {'PeakWins':>10} {'PeakLoses':>10} {'AskDom':>7}")
    for ticker in WATCHLIST:
        tlist = by_ticker.get(ticker, [])
        if not tlist:
            lines.append(f"  {ticker:<7} {0:>7}")
            continue
        days = len({a["date"] for a in tlist})
        peaks = [a["peak_pct"] for a in tlist if a.get("peak_pct") is not None]
        closes = [a["close_pct"] for a in tlist if a.get("close_pct") is not None]
        peak_wins = sum(1 for p in peaks if p >= 0.30)
        peak_loses = sum(1 for p in peaks if p <= -0.30)
        ask_dom = sum(1 for a in tlist if a.get("side_dominant") == "ask")
        avg_peak = sum(peaks) / len(peaks) if peaks else 0.0
        avg_close = sum(closes) / len(closes) if closes else 0.0
        lines.append(
            f"  {ticker:<7} {len(tlist):>7} {days:>5} "
            f"{avg_peak*100:>+8.1f}% {avg_close*100:>+8.1f}% "
            f"{peak_wins:>10} {peak_loses:>10} {ask_dom:>7}"
        )

    # ── Per-day count ──
    lines.append("")
    lines.append("## Alerts per day")
    by_day: dict[str, int] = {}
    for a in alerts:
        by_day[a["date"]] = by_day.get(a["date"], 0) + 1
    for d in sorted(by_day.keys()):
        lines.append(f"  {d}: {by_day[d]:>4}")

    # ── Top 30 by peak return (sanity) ──
    lines.append("")
    lines.append("## Top 30 alerts by peak return (entry → intraday high)")
    lines.append(f"  {'Date':<12} {'CT':<6} {'Ticker':<6} {'Strike':>8} {'C/P':<3} {'Exp':<11} "
                 f"{'Ratio':>7} {'Dom':>5} {'Side':<5} {'Entry$':>7} {'Peak$':>7} {'Peak%':>7} {'Close%':>7}")
    sortable = [a for a in alerts if a.get("peak_pct") is not None]
    sortable.sort(key=lambda a: a["peak_pct"], reverse=True)
    for a in sortable[:30]:
        side = "C" if a["opt_side"] == "call" else "P"
        ct = a["minute"][11:16] if a.get("minute") else "?"
        # CT = UTC-5 in April (EDT), so subtract 5 hours from displayed UTC HH:MM
        try:
            hh, mm = ct.split(":")
            ct_disp = f"{(int(hh)-5)%24:02d}:{mm}"
        except Exception:
            ct_disp = ct
        entry = a.get("entry_price") or 0
        peak = a.get("day_high") or 0
        peak_pct = a.get("peak_pct") or 0
        close_pct = a.get("close_pct") or 0
        ratio = a.get("vol_oi_ratio") or 0
        dom = a.get("dominance") or 0
        lines.append(
            f"  {a['date']:<12} {ct_disp:<6} {a['ticker']:<6} {float(a['strike']):>8.1f} {side:<3} "
            f"{a['expiry']:<11} {ratio:>6.1f}× {dom*100:>4.0f}% {a['side_dominant']:<5} "
            f"${entry:>6.2f} ${peak:>6.2f} {peak_pct*100:>+6.1f}% {close_pct*100:>+6.1f}%"
        )

    # ── Bottom 20 by peak return (the losers) ──
    lines.append("")
    lines.append("## Bottom 20 alerts by peak return (worst — never went in the money)")
    lines.append(f"  {'Date':<12} {'CT':<6} {'Ticker':<6} {'Strike':>8} {'C/P':<3} {'Exp':<11} "
                 f"{'Ratio':>7} {'Dom':>5} {'Side':<5} {'Entry$':>7} {'Peak$':>7} {'Peak%':>7} {'Close%':>7}")
    sortable.sort(key=lambda a: a["peak_pct"])
    for a in sortable[:20]:
        side = "C" if a["opt_side"] == "call" else "P"
        ct = a["minute"][11:16] if a.get("minute") else "?"
        try:
            hh, mm = ct.split(":")
            ct_disp = f"{(int(hh)-5)%24:02d}:{mm}"
        except Exception:
            ct_disp = ct
        entry = a.get("entry_price") or 0
        peak = a.get("day_high") or 0
        peak_pct = a.get("peak_pct") or 0
        close_pct = a.get("close_pct") or 0
        ratio = a.get("vol_oi_ratio") or 0
        dom = a.get("dominance") or 0
        lines.append(
            f"  {a['date']:<12} {ct_disp:<6} {a['ticker']:<6} {float(a['strike']):>8.1f} {side:<3} "
            f"{a['expiry']:<11} {ratio:>6.1f}× {dom*100:>4.0f}% {a['side_dominant']:<5} "
            f"${entry:>6.2f} ${peak:>6.2f} {peak_pct*100:>+6.1f}% {close_pct*100:>+6.1f}%"
        )

    text = "\n".join(lines)
    out_path = OUT_DIR / "summary.txt"
    out_path.write_text(text)
    print(text)
    print(f"\nSummary: {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
