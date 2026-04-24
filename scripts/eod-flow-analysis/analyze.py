"""
Multi-day EOD option-flow analyzer.

Processes daily UW-bot CSVs from ~/Downloads/EOD-OptionFlow/, generates
per-day chain-aggregate parquet files, and rolls up multi-day insights
across the 7-ticker watchlist + cross-asset outliers.

Usage:
    # Process all unprocessed days + refresh rollup
    python analyze.py

    # Process one day + refresh rollup
    python analyze.py --day 2026-04-25

    # Just refresh rollup (no day processing)
    python analyze.py --rollup-only

    # Reprocess a day (overwrite existing parquet)
    python analyze.py --day 2026-04-23 --force

Outputs (under scripts/eod-flow-analysis/output/):
    by-day/<date>-chains.parquet   — per-chain EOD aggregates
    cumulative-rollup.json         — multi-day metrics
    cumulative-headlines.txt       — human-readable summary
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Optional

import duckdb

CSV_DIR = Path("/Users/charlesobrien/Downloads/EOD-OptionFlow")
SCRIPT_DIR = Path(__file__).parent
OUT_DIR = SCRIPT_DIR / "output"
BY_DAY_DIR = OUT_DIR / "by-day"
ROLLUP_JSON = OUT_DIR / "cumulative-rollup.json"
HEADLINES_FILE = OUT_DIR / "cumulative-headlines.txt"

# Detector ticker watchlist (post 2026-04-24 expansion)
WATCHLIST = ["SPXW", "NDXP", "SPY", "QQQ", "IWM", "NVDA", "SNDK"]

# Per-day parquet filters (keep file size small)
MIN_VOL_OI_RATIO = 5.0
MIN_PREMIUM = 100_000  # $100K floor for parquet inclusion

CSV_PATTERN = re.compile(r"^bot-eod-report-(\d{4}-\d{2}-\d{2})\.csv$")


def find_csvs() -> dict[str, Path]:
    """Map date_str -> CSV path for every report file in CSV_DIR."""
    out: dict[str, Path] = {}
    for csv in CSV_DIR.glob("bot-eod-report-*.csv"):
        match = CSV_PATTERN.match(csv.name)
        if match:
            out[match.group(1)] = csv
    return dict(sorted(out.items()))


def process_day(date_str: str, csv_path: Path, *, force: bool = False) -> Path:
    """Process one day's CSV → parquet of chain aggregates."""
    out_path = BY_DAY_DIR / f"{date_str}-chains.parquet"
    if out_path.exists() and not force:
        print(f"[skip]    {date_str} already processed", file=sys.stderr)
        return out_path

    size_gb = csv_path.stat().st_size / 1e9
    print(f"[process] {date_str} ({size_gb:.1f}GB)...", file=sys.stderr)

    con = duckdb.connect()
    con.execute(
        f"""
        COPY (
            SELECT
                '{date_str}' AS trade_date,
                option_chain_id,
                CASE
                    WHEN option_chain_id LIKE 'SPXW%' THEN 'SPXW'
                    WHEN option_chain_id LIKE 'NDXP%' THEN 'NDXP'
                    ELSE FIRST(underlying_symbol)
                END AS ticker,
                FIRST(underlying_symbol) AS underlying_symbol,
                FIRST(strike) AS strike,
                FIRST(option_type) AS option_type,
                FIRST(expiry) AS expiry,
                FIRST(equity_type) AS equity_type,
                FIRST(sector) AS sector,
                SUM(size) AS total_size,
                SUM(premium) AS total_premium,
                MAX(volume) AS day_volume,
                MAX(open_interest) AS day_oi,
                SUM(CASE WHEN side='ask' THEN size ELSE 0 END) AS ask_size,
                SUM(CASE WHEN side='bid' THEN size ELSE 0 END) AS bid_size,
                MIN(executed_at) AS first_ts,
                MAX(executed_at) AS last_ts,
                FIRST(price  ORDER BY executed_at) AS first_price,
                LAST(price   ORDER BY executed_at) AS last_price,
                FIRST(underlying_price ORDER BY executed_at) AS first_underlying,
                LAST(underlying_price  ORDER BY executed_at) AS last_underlying,
                COUNT(*) AS trade_count
            FROM read_csv_auto('{csv_path}', header=true, sample_size=100000)
            WHERE canceled = false
              AND open_interest > 0
              AND volume::DOUBLE / open_interest >= {MIN_VOL_OI_RATIO}
              AND premium >= {MIN_PREMIUM}
            GROUP BY option_chain_id
        ) TO '{out_path}' (FORMAT PARQUET)
    """
    )
    print(f"[done]    {date_str} → {out_path.name}", file=sys.stderr)
    return out_path


def rollup() -> dict:
    """Aggregate across all per-day parquets."""
    parquets = sorted(BY_DAY_DIR.glob("*-chains.parquet"))
    if not parquets:
        return {"days": [], "stats": {}, "tickers": [], "repeat_strikes": []}

    parquet_glob = str(BY_DAY_DIR / "*-chains.parquet")
    con = duckdb.connect()
    con.execute(
        f"""
        CREATE TABLE chains AS
        SELECT *,
            CASE WHEN total_size > 0 THEN ask_size::DOUBLE / total_size ELSE NULL END AS ask_pct,
            CASE WHEN total_size > 0 THEN bid_size::DOUBLE / total_size ELSE NULL END AS bid_pct,
            CASE WHEN day_oi > 0 THEN day_volume::DOUBLE / day_oi ELSE NULL END AS vol_oi_ratio,
            CASE WHEN first_price > 0 THEN (last_price - first_price) / first_price ELSE NULL END AS opt_return,
            CASE WHEN first_underlying > 0
                 THEN (last_underlying - first_underlying) / first_underlying
                 ELSE NULL END AS und_return,
            EXTRACT(HOUR FROM first_ts) * 60 + EXTRACT(MINUTE FROM first_ts) AS first_minute_utc
        FROM read_parquet('{parquet_glob}')
    """
    )

    days = sorted({r[0] for r in con.execute("SELECT DISTINCT trade_date FROM chains").fetchall()})

    # ── Per-ticker rollup ──
    ticker_rows = con.execute(
        """
        SELECT
            ticker,
            COUNT(*) AS chains,
            COUNT(DISTINCT trade_date) AS active_days,
            SUM(total_premium) AS total_premium,
            AVG(vol_oi_ratio) AS avg_ratio,
            MAX(vol_oi_ratio) AS peak_ratio,
            -- Directional bets and their outcomes
            SUM(CASE WHEN ask_pct >= 0.65 THEN 1 ELSE 0 END) AS ask_dominant_chains,
            SUM(CASE WHEN ask_pct >= 0.65 AND opt_return > 0.10 THEN 1 ELSE 0 END) AS ask_winners,
            SUM(CASE WHEN ask_pct >= 0.65 AND opt_return < -0.10 THEN 1 ELSE 0 END) AS ask_losers,
            -- Bid-side
            SUM(CASE WHEN bid_pct >= 0.65 THEN 1 ELSE 0 END) AS bid_dominant_chains,
            -- Calls vs puts split for ASK-side directional
            SUM(CASE WHEN ask_pct >= 0.65 AND option_type='call' THEN 1 ELSE 0 END) AS ask_call_chains,
            SUM(CASE WHEN ask_pct >= 0.65 AND option_type='put' THEN 1 ELSE 0 END) AS ask_put_chains
        FROM chains
        GROUP BY ticker
        ORDER BY total_premium DESC
        LIMIT 50
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    tickers = [dict(zip(cols, r)) for r in ticker_rows]

    # ── Repeat strikes (same ticker × strike × side × expiry across multiple days) ──
    repeat_rows = con.execute(
        """
        SELECT
            ticker,
            strike,
            option_type,
            expiry,
            COUNT(DISTINCT trade_date) AS days_active,
            SUM(total_premium) AS total_premium,
            AVG(vol_oi_ratio) AS avg_ratio,
            AVG(ask_pct) AS avg_ask_pct,
            AVG(opt_return) AS avg_opt_return,
            STRING_AGG(DISTINCT trade_date::VARCHAR, ',' ORDER BY trade_date) AS dates
        FROM chains
        GROUP BY ticker, strike, option_type, expiry
        HAVING COUNT(DISTINCT trade_date) >= 2
        ORDER BY total_premium DESC
        LIMIT 30
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    repeat_strikes = [dict(zip(cols, r)) for r in repeat_rows]

    # ── Per-day stats ──
    daily_rows = con.execute(
        """
        SELECT
            trade_date,
            COUNT(*) AS chains,
            SUM(total_premium) AS total_premium,
            -- Bullish-call ratio (sign of macro tape)
            SUM(CASE WHEN option_type='call' AND ask_pct >= 0.65 THEN total_premium ELSE 0 END) AS bullish_call_prem,
            SUM(CASE WHEN option_type='put'  AND ask_pct >= 0.65 THEN total_premium ELSE 0 END) AS bearish_put_prem,
            -- Average underlying return on chains that day (proxy for spot direction)
            AVG(und_return) AS avg_und_return
        FROM chains
        GROUP BY trade_date
        ORDER BY trade_date
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    daily = [dict(zip(cols, r)) for r in daily_rows]

    # ── Top 30 single-name (non-ETF/Index) chains by premium across all days ──
    single_name_rows = con.execute(
        """
        SELECT
            trade_date, ticker, strike, option_type, expiry,
            day_volume, day_oi, vol_oi_ratio, total_premium,
            ask_pct, bid_pct, opt_return, und_return, first_ts
        FROM chains
        WHERE (equity_type NOT IN ('ETF', 'Index') OR equity_type IS NULL)
          AND total_premium >= 1000000
        ORDER BY total_premium DESC
        LIMIT 30
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    single_names = [dict(zip(cols, r)) for r in single_name_rows]

    # ── Watchlist directional ASK winners + losers across all days ──
    watch_winners_rows = con.execute(
        """
        SELECT
            trade_date, ticker, strike, option_type, expiry,
            vol_oi_ratio, total_premium, ask_pct, opt_return, und_return, first_ts
        FROM chains
        WHERE ticker IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK')
          AND ask_pct >= 0.65
          AND opt_return >= 0.30
        ORDER BY opt_return DESC
        LIMIT 30
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    watch_winners = [dict(zip(cols, r)) for r in watch_winners_rows]

    watch_losers_rows = con.execute(
        """
        SELECT
            trade_date, ticker, strike, option_type, expiry,
            vol_oi_ratio, total_premium, ask_pct, opt_return, und_return, first_ts
        FROM chains
        WHERE ticker IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK')
          AND ask_pct >= 0.65
          AND opt_return <= -0.30
        ORDER BY opt_return ASC
        LIMIT 30
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    watch_losers = [dict(zip(cols, r)) for r in watch_losers_rows]

    # ── Out-of-watchlist tickers (candidates for future addition) ──
    candidate_rows = con.execute(
        """
        SELECT
            ticker,
            COUNT(*) AS chains,
            COUNT(DISTINCT trade_date) AS active_days,
            SUM(total_premium) AS total_premium,
            AVG(vol_oi_ratio) AS avg_ratio,
            SUM(CASE WHEN ask_pct >= 0.65 THEN 1 ELSE 0 END) AS dir_chains,
            SUM(CASE WHEN ask_pct >= 0.65 AND opt_return > 0.10 THEN 1 ELSE 0 END) AS ask_winners
        FROM chains
        WHERE ticker NOT IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK','SPX','NDX')
          AND (equity_type NOT IN ('ETF','Index') OR equity_type IS NULL)
        GROUP BY ticker
        HAVING COUNT(DISTINCT trade_date) >= 2
           AND SUM(total_premium) >= 5000000
        ORDER BY total_premium DESC
        LIMIT 25
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    candidates = [dict(zip(cols, r)) for r in candidate_rows]

    # ── 8:30 CT clustering check ──
    # 8:30 CT = 13:30 UTC = 13*60 + 30 = 810 minutes
    morning_rows = con.execute(
        """
        SELECT
            trade_date,
            SUM(CASE WHEN first_minute_utc BETWEEN 810 AND 840 THEN 1 ELSE 0 END) AS first_30min,
            SUM(CASE WHEN first_minute_utc BETWEEN 810 AND 840 AND ask_pct >= 0.65 THEN 1 ELSE 0 END) AS first_30min_directional,
            COUNT(*) AS total_chains
        FROM chains
        WHERE ask_pct >= 0.65
        GROUP BY trade_date
        ORDER BY trade_date
    """
    ).fetchall()
    cols = [c[0] for c in con.description]
    morning_stats = [dict(zip(cols, r)) for r in morning_rows]

    return {
        "days": days,
        "daily_stats": daily,
        "tickers": tickers,
        "repeat_strikes": repeat_strikes,
        "single_names": single_names,
        "watchlist_winners": watch_winners,
        "watchlist_losers": watch_losers,
        "out_of_watchlist_candidates": candidates,
        "morning_clustering": morning_stats,
    }


def write_headlines(rollup: dict) -> str:
    """Generate human-readable summary."""
    lines: list[str] = []
    days = rollup.get("days", [])
    lines.append(f"# EOD Option-Flow Multi-Day Rollup ({len(days)} days)")
    lines.append(f"  Date range: {days[0] if days else '?'} → {days[-1] if days else '?'}")
    lines.append("")

    # Daily stats
    lines.append("## Per-day summary")
    lines.append(f"  {'Date':<12} {'Chains':>7} {'Premium':>14} {'Bullish $':>14} {'Bearish $':>14} {'AvgUnd':>7}")
    for d in rollup.get("daily_stats", []):
        prem = d.get("total_premium") or 0
        bcp = d.get("bullish_call_prem") or 0
        bpp = d.get("bearish_put_prem") or 0
        und = d.get("avg_und_return") or 0
        lines.append(
            f"  {str(d['trade_date']):<12} {d['chains']:>7} ${prem:>12,.0f} "
            f"${bcp:>12,.0f} ${bpp:>12,.0f} {und*100:>+6.2f}%"
        )

    # Top tickers
    lines.append("")
    lines.append("## Top tickers by total outsized premium (across all days)")
    lines.append(f"  {'Ticker':<8} {'Chains':>7} {'Days':>5} {'Premium':>14} "
                 f"{'AvgRatio':>9} {'PeakRatio':>9} {'AskDom':>7} {'AskWins':>8} {'AskLoses':>8}")
    for t in rollup.get("tickers", [])[:20]:
        prem = t.get("total_premium") or 0
        avg_r = t.get("avg_ratio") or 0
        peak_r = t.get("peak_ratio") or 0
        lines.append(
            f"  {t['ticker']:<8} {t['chains']:>7} {t['active_days']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {peak_r:>8.1f}× {t['ask_dominant_chains']:>7} "
            f"{t['ask_winners']:>8} {t['ask_losers']:>8}"
        )

    # Repeat strikes
    lines.append("")
    lines.append("## Repeat strikes — same contract showing up on multiple days (persistent positioning)")
    lines.append(f"  {'Ticker':<8} {'Strike':>10} {'C/P':<3} {'Expiry':<11} {'Days':>5} "
                 f"{'Premium':>14} {'AvgRatio':>9} {'AvgAsk%':>7} {'AvgRet':>7}  Dates")
    for r in rollup.get("repeat_strikes", [])[:15]:
        side = "C" if r["option_type"] == "call" else "P"
        prem = r.get("total_premium") or 0
        avg_r = r.get("avg_ratio") or 0
        avg_a = r.get("avg_ask_pct") or 0
        avg_o = r.get("avg_opt_return") or 0
        lines.append(
            f"  {r['ticker']:<8} {float(r['strike']):>10.1f} {side:<3} "
            f"{str(r['expiry']):<11} {r['days_active']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {avg_a*100:>6.0f}% {avg_o*100:>+6.1f}%  {r['dates']}"
        )

    # Out-of-watchlist candidates
    lines.append("")
    lines.append("## OUT-OF-WATCHLIST single-name candidates (worth considering)")
    lines.append("  Filter: ≥2 active days, ≥$5M total outsized premium, single-name (not ETF/Index)")
    lines.append(f"  {'Ticker':<8} {'Chains':>7} {'Days':>5} {'Premium':>14} "
                 f"{'AvgRatio':>9} {'DirChains':>10} {'AskWins':>8}")
    for c in rollup.get("out_of_watchlist_candidates", [])[:20]:
        prem = c.get("total_premium") or 0
        avg_r = c.get("avg_ratio") or 0
        lines.append(
            f"  {c['ticker']:<8} {c['chains']:>7} {c['active_days']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {c['dir_chains']:>10} {c['ask_winners']:>8}"
        )

    # Watchlist winners
    lines.append("")
    lines.append("## Watchlist ASK-side WINNERS (≥30% option return, ≥65% ask, vol/OI≥5×)")
    lines.append(f"  {'Date':<12} {'Ticker':<7} {'Strike':>9} {'C/P':<3} {'Exp':<6} "
                 f"{'Ratio':>7} {'Premium':>11} {'Ask%':>5} {'OptRet':>8} {'UndRet':>7} {'First':<8}")
    for w in rollup.get("watchlist_winners", [])[:20]:
        side = "C" if w["option_type"] == "call" else "P"
        first = w.get("first_ts")
        first_str = first.strftime("%H:%M") if first else "?"
        ratio = w.get("vol_oi_ratio") or 0
        prem = w.get("total_premium") or 0
        ap = w.get("ask_pct") or 0
        opt_r = w.get("opt_return") or 0
        und_r = w.get("und_return") or 0
        lines.append(
            f"  {str(w['trade_date']):<12} {w['ticker']:<7} {float(w['strike']):>9.1f} {side:<3} "
            f"{str(w['expiry'])[-5:]:<6} {ratio:>6.1f}× ${prem:>10,.0f} "
            f"{ap*100:>4.0f}% {opt_r*100:>+7.1f}% {und_r*100:>+6.2f}% {first_str:<8}"
        )

    # Watchlist losers
    lines.append("")
    lines.append("## Watchlist ASK-side LOSERS (≤-30% option return)")
    lines.append(f"  {'Date':<12} {'Ticker':<7} {'Strike':>9} {'C/P':<3} {'Exp':<6} "
                 f"{'Ratio':>7} {'Premium':>11} {'Ask%':>5} {'OptRet':>8} {'UndRet':>7} {'First':<8}")
    for l in rollup.get("watchlist_losers", [])[:20]:
        side = "C" if l["option_type"] == "call" else "P"
        first = l.get("first_ts")
        first_str = first.strftime("%H:%M") if first else "?"
        ratio = l.get("vol_oi_ratio") or 0
        prem = l.get("total_premium") or 0
        ap = l.get("ask_pct") or 0
        opt_r = l.get("opt_return") or 0
        und_r = l.get("und_return") or 0
        lines.append(
            f"  {str(l['trade_date']):<12} {l['ticker']:<7} {float(l['strike']):>9.1f} {side:<3} "
            f"{str(l['expiry'])[-5:]:<6} {ratio:>6.1f}× ${prem:>10,.0f} "
            f"{ap*100:>4.0f}% {opt_r*100:>+7.1f}% {und_r*100:>+6.2f}% {first_str:<8}"
        )

    # Morning clustering
    lines.append("")
    lines.append("## 8:30-9:00 CT (open-auction window) directional flow %")
    lines.append("  Hypothesis: institutional desks place day's directional bets at the open.")
    lines.append(f"  {'Date':<12} {'TotalDir':>9} {'First30m':>10} {'%InOpen':>9}")
    for m in rollup.get("morning_clustering", []):
        f30 = m.get("first_30min_directional", 0)
        tot = m.get("total_chains", 0)
        pct = (f30 / tot * 100) if tot > 0 else 0
        lines.append(
            f"  {str(m['trade_date']):<12} {tot:>9} {f30:>10} {pct:>8.1f}%"
        )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--day", help="Process single date (YYYY-MM-DD)")
    parser.add_argument("--rollup-only", action="store_true",
                        help="Skip day processing, just refresh rollup")
    parser.add_argument("--no-rollup", action="store_true",
                        help="Process days but skip rollup refresh")
    parser.add_argument("--force", action="store_true",
                        help="Reprocess existing days")
    args = parser.parse_args()

    BY_DAY_DIR.mkdir(parents=True, exist_ok=True)

    if not args.rollup_only:
        csvs = find_csvs()
        if not csvs:
            print(f"No CSVs found in {CSV_DIR}", file=sys.stderr)
            sys.exit(1)

        targets = [args.day] if args.day else list(csvs.keys())
        for date_str in targets:
            if date_str not in csvs:
                print(f"[error]   No CSV for date {date_str}", file=sys.stderr)
                continue
            process_day(date_str, csvs[date_str], force=args.force)

    if not args.no_rollup:
        print("[rollup]  Aggregating across all parquets...", file=sys.stderr)
        result = rollup()
        ROLLUP_JSON.write_text(json.dumps(result, default=str, indent=2))
        headlines = write_headlines(result)
        HEADLINES_FILE.write_text(headlines)
        print(headlines)
        print(f"\nFull JSON rollup: {ROLLUP_JSON}", file=sys.stderr)
        print(f"Headlines:        {HEADLINES_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
