"""
Stage 1 of the iv_anomalies full-replay backfill.

Aggregates UW EOD CSVs into per-minute, per-(ticker, strike, side, expiry)
StrikeSample-shape records. Outputs JSONL — one row per minute-bucket —
ready for the TypeScript detector replay in `backfill-detect.ts`.

The CSV's per-trade `implied_volatility` field is the key input that
makes the full-replay possible:

    iv_mid = volume-weighted avg(IV) across all trades in the minute
    iv_ask = volume-weighted avg(IV) across trades where side='ask'
    iv_bid = volume-weighted avg(IV) across trades where side='bid'

Cumulative volume across minutes per (ticker, strike, side, expiry) is
computed via window function — matches production's day-running
totalVolume from Schwab.

Filters (ALL applied so the TS replay matches production exactly):
  - canceled = false
  - open_interest > 0
  - implied_volatility in (0.001, 5.0]   (drops degenerate IVs)
  - market hours (13:30-20:00 UTC)
  - ticker in STRIKE_IV_TICKERS

Note: deliberately does NOT pre-filter to OTM strikes or apply OI
floors. The TS detector applies those as part of detectAnomalies()'
internal logic — feeding it a wider sample also gives skew_delta the
neighbor strikes it needs.

Outputs:
    scripts/eod-flow-analysis/output/backfill-buckets/<date>-buckets.jsonl

Usage:
    ml/.venv/bin/python scripts/backfill-aggregate.py
    ml/.venv/bin/python scripts/backfill-aggregate.py --force   # reprocess existing
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb

CSV_DIR = Path.home() / "Downloads" / "EOD-OptionFlow"
SCRIPT_DIR = Path(__file__).parent
OUT_DIR = SCRIPT_DIR / "eod-flow-analysis" / "output" / "backfill-buckets"

WATCHLIST = (
    "SPXW", "NDXP", "SPY", "QQQ", "IWM", "SMH",
    "NVDA", "TSLA", "META", "MSFT", "SNDK", "MSTR", "MU",
)


def aggregate_day(con: duckdb.DuckDBPyConnection, csv_path: Path, out_path: Path) -> None:
    """Run the per-minute aggregation SQL and write JSONL output."""
    watchlist_sql = "(" + ", ".join(f"'{t}'" for t in WATCHLIST) + ")"
    q = f"""
    COPY (
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
          implied_volatility AS iv,
          price,
          size,
          side,
          open_interest,
          underlying_price
        FROM read_csv_auto('{csv_path}', header=true, sample_size=100000)
        WHERE canceled = false
          AND open_interest > 0
          AND implied_volatility IS NOT NULL
          AND implied_volatility > 0.001
          AND implied_volatility <= 5.0
      ),
      filtered AS (
        SELECT * FROM raw
        WHERE ticker IN {watchlist_sql}
          AND EXTRACT(HOUR FROM executed_at) * 60 + EXTRACT(MINUTE FROM executed_at)
              BETWEEN 13*60+30 AND 20*60
      ),
      -- UW does not surface underlying_price for NDX/NDXP options.
      -- Derive NDX spot from same-minute QQQ spot * NDX_QQQ_RATIO (~40.5).
      -- This is good to ±1-2% on any given day, plenty accurate for the
      -- ±12% OTM gate to bucket strikes.
      qqq_minute_spot AS (
        SELECT
          date_trunc('minute', executed_at) AS minute,
          LAST(underlying_price ORDER BY executed_at) AS qqq_spot
        FROM filtered
        WHERE ticker = 'QQQ' AND underlying_price IS NOT NULL
        GROUP BY 1
      ),
      minute_aggs AS (
        SELECT
          ticker,
          strike,
          opt_side,
          expiry::VARCHAR AS expiry,
          minute::VARCHAR AS ts,
          SUM(iv * size)::DOUBLE / NULLIF(SUM(size), 0) AS iv_mid,
          SUM(CASE WHEN side='ask' THEN iv * size ELSE 0 END)::DOUBLE
            / NULLIF(SUM(CASE WHEN side='ask' THEN size ELSE 0 END), 0) AS iv_ask,
          SUM(CASE WHEN side='bid' THEN iv * size ELSE 0 END)::DOUBLE
            / NULLIF(SUM(CASE WHEN side='bid' THEN size ELSE 0 END), 0) AS iv_bid,
          -- Volume-weighted trade price = closest analog to production's
          -- quote-midpoint mid_price field. Stored in strike_iv_snapshots
          -- so the chart drilldown's hover-price label has historical data.
          SUM(price * size)::DOUBLE / NULLIF(SUM(size), 0) AS mid_price,
          SUM(size)::BIGINT AS minute_size,
          ANY_VALUE(open_interest) AS oi,
          LAST(underlying_price ORDER BY executed_at) AS spot
        FROM filtered
        GROUP BY ticker, strike, opt_side, expiry, minute
      )
      SELECT
        m.ticker,
        m.strike,
        m.opt_side,
        m.expiry,
        m.ts,
        m.iv_mid,
        m.iv_ask,
        m.iv_bid,
        m.mid_price,
        SUM(m.minute_size) OVER (
          PARTITION BY m.ticker, m.strike, m.opt_side, m.expiry
          ORDER BY m.ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS volume,
        m.oi,
        COALESCE(
          m.spot,
          CASE WHEN m.ticker IN ('NDXP', 'NDX') THEN q.qqq_spot * 40.5 END
        ) AS spot
      FROM minute_aggs m
      LEFT JOIN qqq_minute_spot q ON q.minute::VARCHAR = m.ts
      ORDER BY m.ticker, m.ts, m.strike, m.opt_side, m.expiry
    ) TO '{out_path}' (FORMAT 'JSON', ARRAY false)
    """
    con.execute(q)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Reprocess existing days")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    csv_files = sorted(CSV_DIR.glob("bot-eod-report-*.csv"))
    if not csv_files:
        print(f"No CSVs found in {CSV_DIR}", file=sys.stderr)
        sys.exit(1)

    con = duckdb.connect()
    for csv in csv_files:
        date = csv.stem.replace("bot-eod-report-", "")
        out = OUT_DIR / f"{date}-buckets.jsonl"
        if out.exists() and not args.force:
            print(f"[skip] {date}", file=sys.stderr)
            continue
        size_gb = csv.stat().st_size / 1e9
        print(f"[agg]  {date} ({size_gb:.1f}GB)...", file=sys.stderr)
        aggregate_day(con, csv, out)
        bytes_out = out.stat().st_size
        print(f"[done] {date} → {out.name} ({bytes_out/1e6:.1f}MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
