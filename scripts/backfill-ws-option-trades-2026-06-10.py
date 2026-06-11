"""One-shot backfill of ws_option_trades for 2026-06-10.

uw-stream resumed STAGGERED after today's outage — different tickers
came back online at different times (some from ~09:51 CT / 14:51 UTC,
others only at ~10:14:57 CT / 15:14 UTC). A flat (hour, ticker) skip
list like the 2026-05-20 backfill is therefore too coarse: it would
either re-insert rows the live daemon already has for an early-resuming
ticker, or leave a gap for a late-resuming one inside the same hour.

Strategy — PER-TICKER CUTOFF:
  For each universe ticker, query ws_option_trades for that ticker's
  existing `min(executed_at)` today. A CSV row is loaded ONLY if its
  executed_at is strictly BEFORE that ticker's existing-min. Tickers
  with NO existing rows today get the whole session loaded. This is
  more precise than the (hour, ticker) skip-list and respects the
  staggered resume exactly.

Source: the GEXBot EOD CSV (bot-eod-report-2026-06-10.csv, ~12M rows,
3.3 GB). Streamed row-by-row via the `csv` module — never loaded into
memory whole. Filtered early to the Lottery Finder universe + session
window + valid price/size.

ws_trade_id: the CSV carries no canonical UW `id`, so we synthesise a
STABLE UUIDv5 from (executed_at | option_chain | price | size | side)
with a fixed namespace baked into this script (same pattern as the
2026-05-04 / 2026-05-20 backfills). Re-runs synthesise the same id for
the same logical print → ON CONFLICT (ws_trade_id) DO NOTHING dedups.

raw_payload — GAMMA (the one improvement over prior CSV backfills):
  The CSV carries per-print gamma (column #21), delta, theta, vega.
  We embed gamma (plus delta/theta/vega) into raw_payload as JSON so
  the detect/replay path can read it via `raw_payload->>'gamma'`
  (migration #168 — populates gamma_at_trigger on both
  lottery_finder_fires and silent_boom_alerts). The 2026-05-20 /
  2026-05-04 backfills wrote only a `backfill_source` marker, so their
  replays got NULL gamma; this one does not.

Universe: read at runtime from uw-stream/src/config.py `_LOTTERY_TICKERS`
(the source of truth, ~88 tickers) — NOT a stale hardcoded copy.

Side: the CSV `side` column is already one of bid/ask/mid/no_side, so
we map it directly to the table's allowed set; anything unexpected →
'no_side'.

Usage:
    set -a; source .env.local; set +a
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-06-10.py            # dry-run
    ml/.venv/bin/python scripts/backfill-ws-option-trades-2026-06-10.py --apply    # writes
"""

from __future__ import annotations

import argparse
import ast
import csv
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

CSV_PATH = (
    "/Users/charlesobrien/Downloads/EOD-OptionFlow/"
    "bot-eod-report-2026-06-10.csv"
)

# Backfill day in UTC. CSV rows must be inside this session window to be
# kept: 13:30:00 UTC (cash open) → 21:00:00 UTC (close).
DAY_START_UTC = datetime(2026, 6, 10, 13, 30, 0, tzinfo=timezone.utc)
DAY_END_UTC = datetime(2026, 6, 10, 21, 0, 0, tzinfo=timezone.utc)

# Path to uw-stream's config — _LOTTERY_TICKERS is the source of truth
# for the WS subscription universe. We parse the frozenset literal out
# of it at runtime rather than copy a stale snapshot in here.
CONFIG_PATH = (
    Path(__file__).resolve().parent.parent
    / "uw-stream"
    / "src"
    / "config.py"
)

# Stable namespace for UUIDv5 derivation — a one-shot value unique to
# this script so identical rows aren't collided across the 05-04/05-20
# backfill namespaces.
UUID_NAMESPACE = uuid.UUID("3f0e1d2c-6a7b-58c9-9d0e-061013300abc")

BATCH_SIZE = 5000

# CSV `side` values are already canonical for ws_option_trades' allowed
# set {ask, bid, mid, no_side}. Anything outside this set → 'no_side'.
_ALLOWED_SIDES = frozenset({"ask", "bid", "mid", "no_side"})

COLUMNS = (
    "ws_trade_id",
    "ticker",
    "option_chain",
    "option_type",
    "strike",
    "expiry",
    "executed_at",
    "price",
    "size",
    "underlying_price",
    "side",
    "implied_volatility",
    "delta",
    "open_interest",
    "canceled",
    "raw_payload",
)

INSERT_SQL = (
    f"INSERT INTO ws_option_trades ({', '.join(COLUMNS)}) VALUES %s "
    "ON CONFLICT (ws_trade_id) DO NOTHING"
)

BACKFILL_SOURCE = "bot-eod-report-2026-06-10.csv"


def load_universe() -> frozenset[str]:
    """Parse _LOTTERY_TICKERS out of uw-stream/src/config.py at runtime.

    config.py imports pydantic / channel_registry and instantiates a
    Settings() at module load, which would require env vars we don't
    have here — so we DON'T import it. Instead we extract just the
    `_LOTTERY_TICKERS = frozenset({...})` literal with a regex + ast,
    which is hermetic and side-effect-free.
    """
    text = CONFIG_PATH.read_text()
    m = re.search(
        r"_LOTTERY_TICKERS:\s*frozenset\[str\]\s*=\s*frozenset\(\s*"
        r"(\{.*?\})\s*,?\s*\)",
        text,
        re.DOTALL,
    )
    if not m:
        raise RuntimeError(
            f"could not locate _LOTTERY_TICKERS literal in {CONFIG_PATH}"
        )
    # ast.literal_eval parses the captured `{...}` source directly;
    # inline `# ...` comments inside the braces are tokenised as
    # comments (whitespace) so they don't interfere.
    tickers = ast.literal_eval(m.group(1))
    if not isinstance(tickers, set) or not tickers:
        raise RuntimeError("parsed _LOTTERY_TICKERS is empty or not a set")
    return frozenset(str(t) for t in tickers)


def _parse_float(s: str) -> float | None:
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v != v:  # NaN
        return None
    return v


def _parse_int(s: str) -> int | None:
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        v = _parse_float(s)
        return int(v) if v is not None else None


def _parse_decimal(s: str) -> Decimal | None:
    v = _parse_float(s)
    if v is None:
        return None
    return Decimal(str(v))


def _parse_executed_at(s: str) -> datetime:
    # CSV format: "2026-06-10 13:30:00.003249+00"
    # fromisoformat needs a 'T' separator and an explicit colon in tz.
    if " " in s:
        s = s.replace(" ", "T", 1)
    if s.endswith("+00"):
        s = s[:-3] + "+00:00"
    return datetime.fromisoformat(s)


def _canonical_side(s: str) -> str:
    s = (s or "").strip()
    return s if s in _ALLOWED_SIDES else "no_side"


def _make_uuid(executed_at_iso: str, option_chain: str, price: str,
               size: str, side: str) -> uuid.UUID:
    key = f"{executed_at_iso}|{option_chain}|{price}|{size}|{side}"
    return uuid.uuid5(UUID_NAMESPACE, key)


def _build_raw_payload(gamma: str, delta: str, theta: str,
                       vega: str) -> str:
    """raw_payload JSON. gamma is read by the detect/replay path via
    `raw_payload->>'gamma'` (migration #168 — gamma_at_trigger). Stored
    as the raw CSV numeric string when present, null when empty/absent.
    """
    def numeric_or_none(v: str) -> float | None:
        return _parse_float(v)

    return json.dumps(
        {
            "gamma": numeric_or_none(gamma),
            "delta": numeric_or_none(delta),
            "theta": numeric_or_none(theta),
            "vega": numeric_or_none(vega),
            "backfill_source": BACKFILL_SOURCE,
        },
    )


def fetch_per_ticker_min(con, universe: frozenset[str],
                         ) -> dict[str, datetime]:
    """Return {ticker: existing min(executed_at) today} for tickers that
    already have ws_option_trades rows in the session window. Tickers
    absent from this map have NO live rows → whole session is loaded.
    """
    cur = con.cursor()
    cur.execute(
        """
        SELECT ticker, MIN(executed_at) AS min_ts
        FROM ws_option_trades
        WHERE executed_at >= %s AND executed_at < %s
          AND ticker = ANY(%s)
        GROUP BY ticker
        """,
        (DAY_START_UTC, DAY_END_UTC, list(universe)),
    )
    out: dict[str, datetime] = {}
    for ticker, min_ts in cur.fetchall():
        if min_ts is not None:
            out[ticker] = min_ts
    cur.close()
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, runs in dry-run mode "
             "(reports counts, no DB writes).",
    )
    args = parser.parse_args()

    if not Path(CSV_PATH).is_file():
        print(f"ERROR: csv not found: {CSV_PATH}", file=sys.stderr)
        return 2

    db_url = (
        os.environ.get("DATABASE_URL_UNPOOLED")
        or os.environ.get("DATABASE_URL")
    )
    if not db_url:
        print(
            "ERROR: DATABASE_URL or DATABASE_URL_UNPOOLED must be set "
            "(source .env.local first).",
            file=sys.stderr,
        )
        return 2

    universe = load_universe()

    print(f"csv:      {CSV_PATH}", flush=True)
    print(f"window:   {DAY_START_UTC} → {DAY_END_UTC}", flush=True)
    print(f"universe: {len(universe)} tickers (from {CONFIG_PATH.name})",
          flush=True)
    print(f"mode:     {'APPLY' if args.apply else 'DRY-RUN'}", flush=True)

    con = psycopg2.connect(db_url)
    con.autocommit = False

    per_ticker_min = fetch_per_ticker_min(con, universe)
    print(
        f"existing: {len(per_ticker_min)}/{len(universe)} tickers already "
        f"have rows today",
        flush=True,
    )
    # Sorted preview of the staggered resume — first 12 by resume time.
    resume_preview = sorted(per_ticker_min.items(), key=lambda x: x[1])[:12]
    for tkr, mn in resume_preview:
        print(f"  resume  {tkr:6s}  {mn.isoformat()}", flush=True)
    no_live = sorted(t for t in universe if t not in per_ticker_min)
    print(
        f"no-live (whole session loaded): {len(no_live)} tickers"
        + (f" — {', '.join(no_live[:20])}" if no_live else ""),
        flush=True,
    )
    print(flush=True)

    cur = con.cursor()

    total_seen = 0
    total_in_universe = 0
    total_in_window = 0
    total_after_cutoff_skip = 0  # skipped: at/after this ticker's live min
    total_invalid = 0
    total_kept = 0
    total_inserted = 0
    kept_by_ticker: dict[str, int] = {}
    t0 = time.monotonic()
    batch: list[tuple] = []

    def flush() -> None:
        nonlocal batch, total_inserted
        if not batch:
            return
        if args.apply:
            execute_values(cur, INSERT_SQL, batch, page_size=BATCH_SIZE)
            con.commit()
            total_inserted += cur.rowcount
        else:
            total_inserted += len(batch)
        batch = []

    with open(CSV_PATH, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            total_seen += 1
            if total_seen % 1_000_000 == 0:
                elapsed = time.monotonic() - t0
                print(
                    f"  seen={total_seen:,} in_universe={total_in_universe:,} "
                    f"in_window={total_in_window:,} "
                    f"cutoff_skipped={total_after_cutoff_skip:,} "
                    f"kept={total_kept:,} elapsed={elapsed:.1f}s",
                    flush=True,
                )

            ticker = row["underlying_symbol"]
            if ticker not in universe:
                continue
            total_in_universe += 1

            executed_at = _parse_executed_at(row["executed_at"])
            if executed_at < DAY_START_UTC or executed_at >= DAY_END_UTC:
                continue
            total_in_window += 1

            # PER-TICKER CUTOFF: keep only rows strictly before the
            # ticker's existing live min. Tickers absent from the map
            # (no live rows) keep the whole session.
            existing_min = per_ticker_min.get(ticker)
            if existing_min is not None and executed_at >= existing_min:
                total_after_cutoff_skip += 1
                continue

            price_str = row["price"]
            size_str = row["size"]
            price = _parse_float(price_str)
            size = _parse_int(size_str)
            if price is None or size is None or price <= 0 or size <= 0:
                total_invalid += 1
                continue

            option_chain = row["option_chain_id"]
            side = _canonical_side(row["side"])

            ws_trade_id = _make_uuid(
                executed_at.isoformat(), option_chain,
                price_str, size_str, side,
            )

            option_type = "C" if row["option_type"] == "call" else "P"
            strike = _parse_decimal(row["strike"]) or Decimal(0)
            expiry = datetime.strptime(row["expiry"], "%Y-%m-%d").date()
            raw_payload = _build_raw_payload(
                row.get("gamma", ""),
                row.get("delta", ""),
                row.get("theta", ""),
                row.get("vega", ""),
            )

            batch.append((
                str(ws_trade_id),
                ticker,
                option_chain,
                option_type,
                strike,
                expiry,
                executed_at,
                Decimal(price_str),
                size,
                _parse_decimal(row["underlying_price"]),
                side,
                _parse_decimal(row["implied_volatility"]),
                _parse_decimal(row["delta"]),
                _parse_int(row["open_interest"]),
                row["canceled"] == "t",
                raw_payload,
            ))
            total_kept += 1
            kept_by_ticker[ticker] = kept_by_ticker.get(ticker, 0) + 1

            if len(batch) >= BATCH_SIZE:
                flush()

    flush()
    cur.close()
    con.close()

    elapsed = time.monotonic() - t0
    print()
    print(f"DONE in {elapsed:.1f}s")
    print(f"  csv rows seen:              {total_seen:,}")
    print(f"  in universe:                {total_in_universe:,}")
    print(f"  in window:                  {total_in_window:,}")
    print(f"  skipped (>= ticker live min): {total_after_cutoff_skip:,}")
    print(f"  invalid price/size:         {total_invalid:,}")
    print(f"  kept (queued for insert):   {total_kept:,}")
    print(f"  inserted (or would insert): {total_inserted:,}")
    print()
    print("projected inserts by ticker (top 40 by row count):")
    top = sorted(kept_by_ticker.items(), key=lambda x: -x[1])[:40]
    for tkr, n in top:
        print(f"  {tkr:6s}  {n:>12,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
