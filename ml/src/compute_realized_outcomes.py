"""Compute realized outcomes for periscope_analyses rows (post-hoc scoring).

Walks index_candles_1m forward from each unscored read's `read_time`
through the same calendar day's 15:00 CT close and simulates a textbook
execution against the row's `long_trigger` / `short_trigger`. Writes
back five columns (realized_r, realized_close_pts, realized_max_favorable_pts,
realized_max_adverse_pts, realized_trigger_fired) plus a `realized_computed_at`
audit timestamp via migration 132.

Textbook execution model (intentionally simple):
  - ENTRY = first bar whose high (long) / low (short) touches the trigger.
  - STOP  = key_levels.gamma_floor (long) / gamma_ceiling (short) when
            present, else trigger ± 5 SPX pts.
  - TARGET = key_levels.gamma_ceiling (long) / gamma_floor (short) when
             present, else trigger ± 10 SPX pts.
  - EXIT = whichever of (stop hit, target hit, 15:00 CT close) lands first.

The model does NOT capture sophisticated trade management — partial
profits, trailing stops, theta-driven adjustments, etc. Callers should
treat the realized_r value as a single-shot mechanical reference, not
the outcome of how a discretionary trader would have managed the read.

Debriefs are post-hoc and do not have a forward path to score, so they're
skipped. Reads with neither trigger set are also skipped — there's no
directional thesis to mechanically execute.

Usage:
    ml/.venv/bin/python ml/src/compute_realized_outcomes.py            # full backfill
    ml/.venv/bin/python ml/src/compute_realized_outcomes.py --dry-run  # print, don't write
    ml/.venv/bin/python ml/src/compute_realized_outcomes.py --limit 50
    ml/.venv/bin/python ml/src/compute_realized_outcomes.py --read-id 123

Environment:
    DATABASE_URL - Neon Postgres connection string
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime

import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor

log = logging.getLogger("compute_realized_outcomes")

# Default fallback offsets in SPX points when key_levels are absent.
DEFAULT_STOP_OFFSET_PTS = 5.0
DEFAULT_TARGET_OFFSET_PTS = 10.0

# How far forward we walk from read_time. Clipped at the same calendar
# day's 15:00 CT close in the candle query — this is just an upper bound.
LOOKAHEAD_HOURS = 6.5


@dataclass
class TriggerSimResult:
    """Outcome of simulating one directional thesis."""

    # Which trigger fired first ('long' / 'short') — None if it never fired.
    fired: str | None
    # 1-based candle index (within the bar window) where the trigger fired.
    # Used for bilateral resolution (whichever triggers first wins).
    fired_bar_idx: int | None
    # Realized exit price in SPX points.
    exit_price: float | None
    # The entry price (= trigger value at the bar where it triggered).
    entry_price: float | None
    # Stop and target levels actually used.
    stop_price: float | None
    target_price: float | None
    # Max favorable / adverse excursion (absolute, signed by direction).
    max_favorable_pts: float | None
    max_adverse_pts: float | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compute realized outcomes for periscope_analyses rows from "
            "index_candles_1m. Writes back realized_* columns added in "
            "migration 132."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap the number of rows scored in this run (default: no limit).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print would-be UPDATEs without writing to the DB.",
    )
    parser.add_argument(
        "--read-id",
        type=int,
        default=None,
        help="Score a single row by id (overrides the realized_computed_at filter).",
    )
    return parser.parse_args()


def load_unscored_rows(
    conn,
    *,
    limit: int | None,
    read_id: int | None,
) -> list[dict]:
    """Pull rows that need scoring.

    When --read-id is set, we ignore the realized_computed_at filter and
    re-score that single row (lets the user retry a single row after fixing
    a bad input, without manually nulling the column). Debriefs are skipped
    in either case — they have no forward path to score.
    """
    where_clauses = ["mode IN ('pre_trade', 'intraday')"]
    params: list = []

    if read_id is not None:
        where_clauses.append("id = %s")
        params.append(read_id)
    else:
        where_clauses.append("realized_computed_at IS NULL")
        # Only pull rows with at least one trigger — no thesis = unscorable.
        where_clauses.append("(long_trigger IS NOT NULL OR short_trigger IS NOT NULL)")

    limit_clause = f"LIMIT {int(limit)}" if limit else ""
    sql = f"""
        SELECT
            id,
            mode,
            trading_date,
            read_time,
            spot_at_read_time,
            long_trigger,
            short_trigger,
            key_levels
        FROM periscope_analyses
        WHERE {" AND ".join(where_clauses)}
        ORDER BY id ASC
        {limit_clause}
    """

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


def fetch_candles(
    conn,
    *,
    trading_date,
    read_time: datetime,
) -> pd.DataFrame:
    """Pull regular-hours SPX 1m candles from read_time → end of session.

    Returns an empty DataFrame when no rows land for the date — caller
    skips the row so a future re-run can score it once data arrives.
    """
    # psycopg2 can't substitute a Python value into an INTERVAL literal,
    # so we bind the lookahead via a (read_time + delta) parameter mul
    # using a `make_interval` call, which IS parameterizable.
    sql = """
        SELECT timestamp, open, high, low, close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = %s
          AND market_time = 'r'
          AND timestamp >= %s
          AND timestamp <= %s + make_interval(mins => %s)
        ORDER BY timestamp ASC
    """
    lookahead_minutes = int(LOOKAHEAD_HOURS * 60)
    with conn.cursor() as cur:
        cur.execute(
            sql,
            [
                trading_date,
                read_time,
                read_time,
                lookahead_minutes,
            ],
        )
        rows = cur.fetchall()

    if not rows:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close"])

    df = pd.DataFrame(rows, columns=["timestamp", "open", "high", "low", "close"])
    # NUMERIC columns come back as Decimal — coerce to float for arithmetic.
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float)
    return df


def parse_key_levels(raw) -> dict:
    """Coerce the JSONB key_levels payload to a dict (or {} when missing)."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return {}


def _finite_float(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except Exception:
        return None
    if not (f == f and f not in (float("inf"), float("-inf"))):  # NaN/Inf
        return None
    return f


def simulate_long(
    candles: pd.DataFrame,
    long_trigger: float,
    key_levels: dict,
) -> TriggerSimResult:
    """Walk candles forward; first bar that takes long_trigger is entry."""
    stop_lvl = _finite_float(key_levels.get("gamma_floor"))
    if stop_lvl is None:
        stop_lvl = long_trigger - DEFAULT_STOP_OFFSET_PTS
    target_lvl = _finite_float(key_levels.get("gamma_ceiling"))
    if target_lvl is None:
        target_lvl = long_trigger + DEFAULT_TARGET_OFFSET_PTS

    fired_idx: int | None = None
    exit_price: float | None = None
    max_high = float("-inf")
    min_low = float("inf")

    for i, bar in enumerate(candles.itertuples(index=False), start=1):
        if fired_idx is None:
            if bar.high >= long_trigger:
                fired_idx = i
                # On the entry bar, also evaluate stop/target intra-bar
                # using its high/low. Conservative: if both could resolve
                # within the bar we treat stop as taking precedence (a
                # touch-and-rip can't be distinguished from intra-bar data).
                max_high = bar.high
                min_low = bar.low
                if bar.low <= stop_lvl:
                    exit_price = stop_lvl
                    break
                if bar.high >= target_lvl:
                    exit_price = target_lvl
                    break
            continue
        # Already triggered — track excursions and look for stop / target.
        max_high = max(max_high, bar.high)
        min_low = min(min_low, bar.low)
        if bar.low <= stop_lvl:
            exit_price = stop_lvl
            break
        if bar.high >= target_lvl:
            exit_price = target_lvl
            break

    if fired_idx is None:
        return TriggerSimResult(
            fired=None,
            fired_bar_idx=None,
            exit_price=None,
            entry_price=None,
            stop_price=None,
            target_price=None,
            max_favorable_pts=None,
            max_adverse_pts=None,
        )

    # Fell through with no stop / target hit — exit at last close.
    if exit_price is None:
        exit_price = float(candles.iloc[-1]["close"])

    entry_price = long_trigger
    max_fav = max(0.0, max_high - entry_price) if max_high > float("-inf") else 0.0
    max_adv = max(0.0, entry_price - min_low) if min_low < float("inf") else 0.0

    return TriggerSimResult(
        fired="long",
        fired_bar_idx=fired_idx,
        exit_price=exit_price,
        entry_price=entry_price,
        stop_price=stop_lvl,
        target_price=target_lvl,
        max_favorable_pts=max_fav,
        max_adverse_pts=max_adv,
    )


def simulate_short(
    candles: pd.DataFrame,
    short_trigger: float,
    key_levels: dict,
) -> TriggerSimResult:
    """Walk candles forward; first bar that takes short_trigger is entry."""
    stop_lvl = _finite_float(key_levels.get("gamma_ceiling"))
    if stop_lvl is None:
        stop_lvl = short_trigger + DEFAULT_STOP_OFFSET_PTS
    target_lvl = _finite_float(key_levels.get("gamma_floor"))
    if target_lvl is None:
        target_lvl = short_trigger - DEFAULT_TARGET_OFFSET_PTS

    fired_idx: int | None = None
    exit_price: float | None = None
    max_high = float("-inf")
    min_low = float("inf")

    for i, bar in enumerate(candles.itertuples(index=False), start=1):
        if fired_idx is None:
            if bar.low <= short_trigger:
                fired_idx = i
                max_high = bar.high
                min_low = bar.low
                if bar.high >= stop_lvl:
                    exit_price = stop_lvl
                    break
                if bar.low <= target_lvl:
                    exit_price = target_lvl
                    break
            continue
        max_high = max(max_high, bar.high)
        min_low = min(min_low, bar.low)
        if bar.high >= stop_lvl:
            exit_price = stop_lvl
            break
        if bar.low <= target_lvl:
            exit_price = target_lvl
            break

    if fired_idx is None:
        return TriggerSimResult(
            fired=None,
            fired_bar_idx=None,
            exit_price=None,
            entry_price=None,
            stop_price=None,
            target_price=None,
            max_favorable_pts=None,
            max_adverse_pts=None,
        )

    if exit_price is None:
        exit_price = float(candles.iloc[-1]["close"])

    entry_price = short_trigger
    # Short P&L is mirrored: favorable = entry - low; adverse = high - entry.
    max_fav = max(0.0, entry_price - min_low) if min_low < float("inf") else 0.0
    max_adv = max(0.0, max_high - entry_price) if max_high > float("-inf") else 0.0

    return TriggerSimResult(
        fired="short",
        fired_bar_idx=fired_idx,
        exit_price=exit_price,
        entry_price=entry_price,
        stop_price=stop_lvl,
        target_price=target_lvl,
        max_favorable_pts=max_fav,
        max_adverse_pts=max_adv,
    )


def score_row(row: dict, candles: pd.DataFrame) -> dict:
    """Run the simulation for one DB row. Returns the realized_* update payload.

    Bilateral reads (both triggers set) simulate both sides and pick whichever
    fires first. If neither fires, realized_trigger_fired = 'neither' and
    R-multiples are null (the read called a setup but the market didn't take it).
    """
    long_trig = _finite_float(row.get("long_trigger"))
    short_trig = _finite_float(row.get("short_trigger"))
    key_levels = parse_key_levels(row.get("key_levels"))
    spot = _finite_float(row.get("spot_at_read_time"))

    long_res: TriggerSimResult | None = None
    short_res: TriggerSimResult | None = None
    if long_trig is not None:
        long_res = simulate_long(candles, long_trig, key_levels)
    if short_trig is not None:
        short_res = simulate_short(candles, short_trig, key_levels)

    chosen: TriggerSimResult | None = None
    if (
        long_res is not None
        and long_res.fired is not None
        and (short_res is None or short_res.fired is None)
    ):
        chosen = long_res
    elif (
        short_res is not None
        and short_res.fired is not None
        and (long_res is None or long_res.fired is None)
    ):
        chosen = short_res
    elif (
        long_res is not None
        and long_res.fired is not None
        and short_res is not None
        and short_res.fired is not None
    ):
        # Both sides fired — pick whichever earlier-indexed bar wins.
        long_idx = long_res.fired_bar_idx or 10**9
        short_idx = short_res.fired_bar_idx or 10**9
        chosen = long_res if long_idx <= short_idx else short_res

    realized_close_pts: float | None = None
    if not candles.empty and spot is not None:
        last_close = float(candles.iloc[-1]["close"])
        realized_close_pts = last_close - spot

    if chosen is None or chosen.fired is None:
        return {
            "realized_r": None,
            "realized_close_pts": realized_close_pts,
            "realized_max_favorable_pts": None,
            "realized_max_adverse_pts": None,
            "realized_trigger_fired": "neither",
        }

    # R-multiple. Stop distance is |entry - stop|; signed by P&L sign so a
    # long winner is +R and a short winner is also +R (move was favorable
    # to the simulated direction).
    #
    # Risk is clamped to a 1-pt minimum so degenerate stops (entry sitting
    # on top of the gamma floor / ceiling, or the +γ level above entry on
    # a long) still produce a defined R rather than dropping the row to
    # NULL. Real-world tick-tight stops are rare; this floor preserves
    # row-counts for EDA without materially distorting realized R.
    raw_risk = abs(chosen.entry_price - chosen.stop_price)
    risk = max(1.0, raw_risk)
    if chosen.fired == "long":
        pnl = chosen.exit_price - chosen.entry_price
    else:
        pnl = chosen.entry_price - chosen.exit_price
    realized_r: float | None = pnl / risk

    return {
        "realized_r": realized_r,
        "realized_close_pts": realized_close_pts,
        "realized_max_favorable_pts": chosen.max_favorable_pts,
        "realized_max_adverse_pts": chosen.max_adverse_pts,
        "realized_trigger_fired": chosen.fired,
    }


def write_update(conn, row_id: int, payload: dict) -> None:
    sql = """
        UPDATE periscope_analyses
        SET
            realized_r = %s,
            realized_close_pts = %s,
            realized_max_favorable_pts = %s,
            realized_max_adverse_pts = %s,
            realized_trigger_fired = %s,
            realized_computed_at = NOW()
        WHERE id = %s
    """
    with conn.cursor() as cur:
        cur.execute(
            sql,
            [
                payload["realized_r"],
                payload["realized_close_pts"],
                payload["realized_max_favorable_pts"],
                payload["realized_max_adverse_pts"],
                payload["realized_trigger_fired"],
                row_id,
            ],
        )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = parse_args()

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        log.error("DATABASE_URL not set")
        return 2

    conn = psycopg2.connect(database_url)
    try:
        rows = load_unscored_rows(
            conn,
            limit=args.limit,
            read_id=args.read_id,
        )
        log.info("loaded %d candidate rows", len(rows))

        scanned = 0
        scored = 0
        skipped_no_candles = 0
        skipped_no_trigger = 0
        failed = 0

        for row in rows:
            scanned += 1
            row_id = row["id"]
            long_trig = row.get("long_trigger")
            short_trig = row.get("short_trigger")
            if long_trig is None and short_trig is None:
                skipped_no_trigger += 1
                log.info("row %s: no triggers; skipping", row_id)
                continue

            try:
                candles = fetch_candles(
                    conn,
                    trading_date=row["trading_date"],
                    read_time=row["read_time"],
                )
            except Exception as err:  # pragma: no cover — defensive
                failed += 1
                log.exception("row %s: fetch_candles failed: %s", row_id, err)
                continue

            if candles.empty:
                skipped_no_candles += 1
                log.warning(
                    "row %s: zero candles for %s; leaving realized_computed_at NULL",
                    row_id,
                    row.get("trading_date"),
                )
                continue

            try:
                payload = score_row(row, candles)
            except Exception as err:  # pragma: no cover — defensive
                failed += 1
                log.exception("row %s: score_row failed: %s", row_id, err)
                continue

            if args.dry_run:
                log.info("[dry-run] row %s -> %s", row_id, payload)
            else:
                try:
                    write_update(conn, row_id, payload)
                    conn.commit()
                except Exception as err:  # pragma: no cover — defensive
                    failed += 1
                    conn.rollback()
                    log.exception("row %s: write_update failed: %s", row_id, err)
                    continue

            scored += 1

        log.info(
            "summary: scanned=%d scored=%d skipped_no_candles=%d "
            "skipped_no_trigger=%d failed=%d",
            scanned,
            scored,
            skipped_no_candles,
            skipped_no_trigger,
            failed,
        )
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
