"""
Phase 6c — outcomes backfill for periscope_lottery_fires from local parquet.

For each row in `periscope_lottery_fires` where outcome_locked = FALSE,
opens the matching `~/Desktop/Bot-Eod-parquet/<expiry>-trades.parquet`,
filters to (expiry, trade_strike, side), and computes:

  - entry_px  — first canceled=False trade within +60s of fire_time
                (only if the row's existing entry_px is NULL)
  - peak_px / peak_pct / peak_time  — max trade price within
                fire_time + [0, HOLD_MINUTES]
  - eod_close_px — last trade price of the day for the contract
  - realized_r_peak / realized_r_eod — (price - entry_px) / entry_px
  - v4_badge for puts (entry_px <= 1.0)
  - outcome_locked = TRUE in all cases (no-trade fires lock at R=-1)

HOLD_MINUTES = 120 (calls) / 180 (puts) — matches the live enrichment
cron and the in-sample research thresholds.

Usage:
    ml/.venv/bin/python scripts/backfill_periscope_lottery_outcomes.py
    ml/.venv/bin/python scripts/backfill_periscope_lottery_outcomes.py --dry-run
    ml/.venv/bin/python scripts/backfill_periscope_lottery_outcomes.py --since 2026-04-13
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import timedelta
from pathlib import Path

import pandas as pd
import psycopg2
import psycopg2.extras
import pyarrow.parquet as pq
from dotenv import load_dotenv

PARQUET_DIR = Path.home() / "Desktop" / "Bot-Eod-parquet"
HOLD_MINUTES_CALL = 120
HOLD_MINUTES_PUT = 180


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--since", default=None, help="YYYY-MM-DD, only fires on/after this expiry")
    return p.parse_args()


def fetch_unenriched(conn, since: str | None) -> pd.DataFrame:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    sql = """
        SELECT id, fire_type, fire_time, expiry, trade_strike, entry_px
        FROM periscope_lottery_fires
        WHERE outcome_locked = FALSE
    """
    params: list[object] = []
    if since is not None:
        sql += " AND expiry >= %s::date"
        params.append(since)
    sql += " ORDER BY expiry, fire_time"
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows)


def open_parquet(expiry: str) -> pd.DataFrame | None:
    """Open the trades parquet for `expiry` (a YYYY-MM-DD string).

    Returns None if file missing. Loads only the columns we need.
    """
    fp = PARQUET_DIR / f"{expiry}-trades.parquet"
    if not fp.exists():
        return None
    # Columns in the user's parquet:
    #   executed_at, underlying_symbol, expiry, strike, option_type,
    #   price, canceled, …
    table = pq.read_table(
        fp,
        columns=[
            "executed_at",
            "underlying_symbol",
            "expiry",
            "strike",
            "option_type",
            "price",
            "canceled",
        ],
    )
    df = table.to_pandas()
    df["executed_at"] = pd.to_datetime(df["executed_at"], utc=True)
    # SPXW = 0DTE SPX root. Matches the live `WHERE ticker = 'SPXW'`
    # lookup. canceled column is stored as 't'/'f' strings in the
    # parquet (not bool) — check explicitly.
    mask = (
        (df["underlying_symbol"] == "SPXW")
        & (df["canceled"] == "f")
        & (df["price"] > 0)
    )
    return df.loc[mask].copy()


def filter_contract(
    trades: pd.DataFrame, expiry: str, strike: int, option_type: str
) -> pd.DataFrame:
    """Slice trades to a single 0DTE SPXW contract.

    Parquet stores `expiry` as datetime.date and `option_type` as the
    word "call"/"put"; coerce both to canonical comparisons.
    """
    side = "call" if option_type == "C" else "put"
    mask = (
        (trades["expiry"].astype(str) == expiry)
        & (trades["strike"] == float(strike))
        & (trades["option_type"] == side)
    )
    return trades.loc[mask].sort_values("executed_at")


def compute_outcomes(
    fire_row: dict,
    trades: pd.DataFrame,
) -> dict:
    """Compute outcome columns for a single fire."""
    # fire_time from DB comes back already-tz-aware (UTC); normalize
    # without re-applying the tz arg (pandas rejects that combination).
    raw_fire = fire_row["fire_time"]
    fire_time = pd.Timestamp(raw_fire)
    if fire_time.tzinfo is None:
        fire_time = fire_time.tz_localize("UTC")
    else:
        fire_time = fire_time.tz_convert("UTC")
    is_call = fire_row["fire_type"] == "call_lottery"
    horizon = HOLD_MINUTES_CALL if is_call else HOLD_MINUTES_PUT
    horizon_end = fire_time + timedelta(minutes=horizon)
    entry_window_end = fire_time + timedelta(seconds=60)

    # ── entry_px ─────────────────────────────────────────────
    existing_entry = fire_row.get("entry_px")
    if existing_entry is not None:
        entry_px = float(existing_entry)
    else:
        entry_window = trades[
            (trades["executed_at"] >= fire_time)
            & (trades["executed_at"] <= entry_window_end)
        ]
        if entry_window.empty:
            entry_px = None
        else:
            entry_px = float(entry_window.iloc[0]["price"])

    # ── hold-window peak ─────────────────────────────────────
    # `idxmax()` returns the FIRST occurrence of the max — if a
    # contract prints the peak price multiple times within the hold
    # window, peak_time will be the first touch (not the last). Peak_px
    # / peak_pct are unaffected (same value at both ticks); only
    # peak_time can shift by minutes. That's acceptable for the
    # backtesting view — the "first touch of peak" is the realistic
    # exit anyway.
    hold = trades[
        (trades["executed_at"] >= fire_time)
        & (trades["executed_at"] <= horizon_end)
    ]
    if hold.empty:
        peak_px = None
        peak_time = None
    else:
        idx = hold["price"].idxmax()
        peak_px = float(hold.loc[idx, "price"])
        peak_time = hold.loc[idx, "executed_at"].to_pydatetime()

    # ── EOD last trade ───────────────────────────────────────
    if trades.empty:
        eod_close_px = None
    else:
        eod_close_px = float(trades.iloc[-1]["price"])

    # ── realized R / peak% ───────────────────────────────────
    if entry_px is None or entry_px == 0:
        # No entry → cannot compute R. Lock at R=-1 like the live cron.
        realized_r_peak = -1.0
        realized_r_eod = -1.0
        peak_pct = None
    else:
        realized_r_peak = (
            (peak_px - entry_px) / entry_px if peak_px is not None else -1.0
        )
        realized_r_eod = (
            (eod_close_px - entry_px) / entry_px
            if eod_close_px is not None
            else -1.0
        )
        peak_pct = (peak_px / entry_px) * 100.0 if peak_px is not None else None

    # ── v4_badge recompute for puts (entry_px <= 1.0) ────────
    # Only update v4_badge for puts. Calls' v4 = QQQ flow balance which
    # is a separate DB lookup; backfill leaves call v4 alone.
    v4_badge_put = (
        (entry_px is not None and entry_px <= 1.0) if not is_call else None
    )

    return {
        "id": fire_row["id"],
        "fire_type": fire_row["fire_type"],
        "entry_px": entry_px,
        "peak_px": peak_px,
        "peak_pct": peak_pct,
        "peak_time": peak_time,
        "eod_close_px": eod_close_px,
        "realized_r_peak": realized_r_peak,
        "realized_r_eod": realized_r_eod,
        "v4_badge_put": v4_badge_put,
    }


def update_fire(conn, out: dict, dry_run: bool) -> None:
    if dry_run:
        return
    cur = conn.cursor()
    if out["fire_type"] == "put_lottery" and out["v4_badge_put"] is not None:
        cur.execute(
            """
            UPDATE periscope_lottery_fires
            SET entry_px        = COALESCE(entry_px, %s),
                peak_px         = %s,
                peak_pct        = %s,
                peak_time       = %s,
                eod_close_px    = %s,
                realized_r_peak = %s,
                realized_r_eod  = %s,
                v4_badge        = %s,
                outcome_locked  = TRUE
            WHERE id = %s
            """,
            (
                out["entry_px"],
                out["peak_px"],
                out["peak_pct"],
                out["peak_time"],
                out["eod_close_px"],
                out["realized_r_peak"],
                out["realized_r_eod"],
                out["v4_badge_put"],
                out["id"],
            ),
        )
    else:
        cur.execute(
            """
            UPDATE periscope_lottery_fires
            SET entry_px        = COALESCE(entry_px, %s),
                peak_px         = %s,
                peak_pct        = %s,
                peak_time       = %s,
                eod_close_px    = %s,
                realized_r_peak = %s,
                realized_r_eod  = %s,
                outcome_locked  = TRUE
            WHERE id = %s
            """,
            (
                out["entry_px"],
                out["peak_px"],
                out["peak_pct"],
                out["peak_time"],
                out["eod_close_px"],
                out["realized_r_peak"],
                out["realized_r_eod"],
                out["id"],
            ),
        )
    cur.close()


def main() -> None:
    args = parse_args()
    load_dotenv(".env.local")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("Missing DATABASE_URL — copy .env.local from Vercel first.")
        sys.exit(1)

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    fires = fetch_unenriched(conn, args.since)
    print(f"Found {len(fires)} unenriched fires")
    if fires.empty:
        conn.close()
        return

    # Group by expiry — load each parquet once per day
    totals = {"updated": 0, "winners_50pct": 0, "missing_parquet": 0, "no_trades": 0}

    for expiry, day_fires in fires.groupby("expiry"):
        expiry_str = str(expiry)
        trades = open_parquet(expiry_str)
        if trades is None:
            print(f"  {expiry_str}: parquet missing — locking {len(day_fires)} fires at R=-1")
            for _, row in day_fires.iterrows():
                out = {
                    "id": row["id"],
                    "fire_type": row["fire_type"],
                    "entry_px": row.get("entry_px"),
                    "peak_px": None,
                    "peak_pct": None,
                    "peak_time": None,
                    "eod_close_px": None,
                    "realized_r_peak": -1.0,
                    "realized_r_eod": -1.0,
                    "v4_badge_put": None,
                }
                update_fire(conn, out, args.dry_run)
                totals["missing_parquet"] += 1
            if not args.dry_run:
                conn.commit()
            continue

        winners_day = 0
        for _, row in day_fires.iterrows():
            opt_type = "C" if row["fire_type"] == "call_lottery" else "P"
            contract = filter_contract(
                trades, expiry_str, int(row["trade_strike"]), opt_type
            )
            out = compute_outcomes(row.to_dict(), contract)
            update_fire(conn, out, args.dry_run)
            totals["updated"] += 1
            if out["peak_pct"] is not None and out["peak_pct"] >= 150.0:
                winners_day += 1
                totals["winners_50pct"] += 1
            if contract.empty:
                totals["no_trades"] += 1
        if not args.dry_run:
            conn.commit()
        print(
            f"  {expiry_str}: {len(day_fires)} fires updated"
            f" ({winners_day} hit peak ≥ +50%)"
        )

    print("\nDone.")
    print(f"  Updated:           {totals['updated']}")
    print(f"  Hit peak ≥ +50%:   {totals['winners_50pct']}")
    print(f"  No trades found:   {totals['no_trades']}")
    print(f"  Missing parquet:   {totals['missing_parquet']}")
    if args.dry_run:
        print("  (no DB writes — dry-run mode)")
    conn.close()


if __name__ == "__main__":
    main()
