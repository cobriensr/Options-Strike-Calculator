"""Parameterized reload of ws_option_trades from the UW Full Tape parquet.

ws_option_trades for some historical days (e.g. 2026-05-04, 2026-05-20)
was pruned by the cleanup cron, which broke the corrected, cooldown-fixed
lottery-fire replay (the replay reads its tape from ws_option_trades). This
script re-hydrates ws_option_trades for an arbitrary day from the archived
Full Tape parquet so the corrected replay has its source data back.

Generalizes scripts/backfill-ws-option-trades-2026-05-26.py:

  - `--date YYYY-MM-DD` (required) derives the parquet path
    `~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet` and the
    UTC window `{date} 13:00 → 21:00` (full RTH, same as the 05-26 backfill).
  - Universe is read at runtime from uw-stream/src/config.py `_LOTTERY_TICKERS`
    (not hardcoded) so it never drifts from the live WS subscription set.
  - raw_payload carries the Greeks the detector reads — most importantly
    gamma (detect-lottery-fires.ts extracts it via raw_payload->>'gamma',
    migration #168). The 05-26 backfill only wrote a {backfill_source}
    marker, which is why a reload from that script would leave the replay's
    gamma_at_trigger NULL. We include gamma/delta/theta/vega from the parquet.

Field mapping (parquet col → ws_option_trades col):

  id                   → ws_trade_id   (canonical UUID — primary dedupe key)
  underlying_symbol    → ticker
  option_chain_id      → option_chain
  option_type          → option_type   ('call' → 'C', 'put' → 'P')
  strike               → strike
  expiry               → expiry
  executed_at          → executed_at
  price                → price
  size                 → size
  underlying_price     → underlying_price
  tags  → side         (derive from tags array literal exactly like
                        uw-stream/src/handlers/option_trades._derive_side:
                        'ask_side'→'ask', 'bid_side'→'bid',
                        'mid_side'→'mid', else 'no_side')
  implied_volatility   → implied_volatility
  delta                → delta
  open_interest        → open_interest
  canceled             → canceled
  {gamma,delta,theta,vega,backfill_source} → raw_payload  (JSON)

Dedup is a plain ON CONFLICT (ws_trade_id) DO NOTHING — idempotent against
whatever the live daemon captured (and a no-op on re-run).

Usage:
    set -a; source .env.local; set +a
    ml/.venv/bin/python scripts/reload-ws-option-trades-from-fulltape.py --date 2026-05-04
    ml/.venv/bin/python scripts/reload-ws-option-trades-from-fulltape.py --date 2026-05-04 --apply
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import polars as pl
import psycopg2
from psycopg2.extras import execute_values

REPO_ROOT = Path(__file__).resolve().parent.parent
PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"

BATCH_SIZE = 5000

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

# Greek columns threaded into raw_payload (confirmed present in the
# full-tape parquet schema, all Float64): gamma/delta/theta/vega. Gamma is
# the load-bearing one — the detector reads raw_payload->>'gamma'.
# delta/theta/vega ride along for completeness so a future detector field
# can read them too. `delta` is already projected as a top-level column
# (→ ws_option_trades.delta), so only the OTHER three are added to the
# parquet scan projection here — re-adding `delta` would be a duplicate
# output name. The raw_payload JSON build reads all four from the row.
_EXTRA_GREEK_COLS = ("gamma", "theta", "vega")

_TAG_TO_SIDE: dict[str, str] = {
    "ask_side": "ask",
    "bid_side": "bid",
    "mid_side": "mid",
}


def _load_lottery_tickers() -> frozenset[str]:
    """Read `_LOTTERY_TICKERS` from uw-stream/src/config.py at runtime.

    config.py imports `channel_registry` and constructs a `Settings()` at
    module import (which needs env vars). To avoid that we load only the
    `_LOTTERY_TICKERS` frozenset by exec'ing the module's source up to the
    point we need — but the simplest robust path is to import the module
    with its src dir on sys.path while tolerating the Settings() failure.

    We instead parse the frozenset directly to avoid the env-var-dependent
    Settings() construction at the bottom of config.py.
    """
    config_path = REPO_ROOT / "uw-stream" / "src" / "config.py"
    if not config_path.is_file():
        raise FileNotFoundError(f"uw-stream config not found: {config_path}")

    # Put uw-stream/src on sys.path so `import channel_registry` resolves,
    # then import config as a module. The module-level `settings = Settings()`
    # needs env vars (database_url, uw_api_key); those are present when the
    # caller sources .env.local, so a normal import works. If it fails we
    # fall back to source parsing.
    src_dir = config_path.parent
    sys.path.insert(0, str(src_dir))
    try:
        spec = importlib.util.spec_from_file_location("uw_stream_config", config_path)
        if spec is None or spec.loader is None:
            raise ImportError("could not build import spec for config.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        tickers = getattr(module, "_LOTTERY_TICKERS")
        return frozenset(tickers)
    except Exception as exc:  # noqa: BLE001 — fall back to AST parse
        print(
            f"  (config.py import failed: {exc!r}; parsing frozenset from source)",
            file=sys.stderr,
        )
        return _parse_lottery_tickers_from_source(config_path)
    finally:
        if sys.path and sys.path[0] == str(src_dir):
            sys.path.pop(0)


def _parse_lottery_tickers_from_source(config_path: Path) -> frozenset[str]:
    """Fallback: extract the `_LOTTERY_TICKERS = frozenset({...})` literal
    via the AST without executing the module (no env vars needed)."""
    import ast

    def _is_target(node: ast.AST) -> ast.AST | None:
        """Return the assigned value node if `node` assigns _LOTTERY_TICKERS.

        config.py declares it as an *annotated* assignment
        (`_LOTTERY_TICKERS: frozenset[str] = frozenset({...})`), which is an
        ast.AnnAssign — but a plain `_LOTTERY_TICKERS = frozenset({...})`
        (ast.Assign) is handled too in case the annotation is ever dropped.
        """
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "_LOTTERY_TICKERS"
        ):
            return node.value
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "_LOTTERY_TICKERS"
        ):
            return node.value
        return None

    tree = ast.parse(config_path.read_text())
    for node in ast.walk(tree):
        value = _is_target(node)
        if value is None:
            continue
        # frozenset({...}) → evaluate the literal set inside the call.
        if isinstance(value, ast.Call) and value.args:
            return frozenset(ast.literal_eval(value.args[0]))
    raise ValueError(
        f"_LOTTERY_TICKERS frozenset literal not found in {config_path}"
    )


def _derive_side(tags: str | None) -> str:
    """Parse a Postgres array literal like '{ask_side,bullish,etf}' and
    return the canonical side. Mirrors
    uw-stream/src/handlers/option_trades._derive_side semantics.
    """
    if not tags:
        return "no_side"
    inner = tags.strip()
    if inner.startswith("{"):
        inner = inner[1:]
    if inner.endswith("}"):
        inner = inner[:-1]
    if not inner:
        return "no_side"
    for tag in inner.split(","):
        t = tag.strip()
        if t in _TAG_TO_SIDE:
            return _TAG_TO_SIDE[t]
    return "no_side"


def _option_type_short(s: str | None) -> str | None:
    if s == "call":
        return "C"
    if s == "put":
        return "P"
    return None


def _to_decimal(v: float | None) -> Decimal | None:
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return Decimal(str(v))


def _clean_float(v: float | None) -> float | None:
    """Coerce a parquet float into a JSON-safe value (None for NaN/inf)."""
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


def _fetch_coverage(con, day_start: datetime, day_end: datetime) -> dict[int, int]:
    """Return {hour_utc: row_count} for ws_option_trades on the day."""
    cur = con.cursor()
    cur.execute(
        """
        SELECT EXTRACT(HOUR FROM executed_at)::int AS hr, COUNT(*)
        FROM ws_option_trades
        WHERE executed_at >= %s AND executed_at < %s
        GROUP BY hr
        ORDER BY hr
        """,
        (day_start, day_end),
    )
    rows = {int(hr): int(n) for hr, n in cur.fetchall()}
    cur.close()
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--date",
        required=True,
        help="Trading day to reload, YYYY-MM-DD (e.g. 2026-05-04).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually insert rows. Without this flag, runs in dry-run mode "
        "(reports projected counts, no DB writes).",
    )
    args = parser.parse_args()

    try:
        day = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        print(f"ERROR: --date must be YYYY-MM-DD, got {args.date!r}", file=sys.stderr)
        return 2

    parquet_path = PARQUET_DIR / f"{args.date}-fulltape.parquet"
    day_start_utc = datetime(day.year, day.month, day.day, 13, 0, 0, tzinfo=timezone.utc)
    day_end_utc = datetime(day.year, day.month, day.day, 21, 0, 0, tzinfo=timezone.utc)

    if not parquet_path.is_file():
        print(f"ERROR: parquet not found: {parquet_path}", file=sys.stderr)
        return 2

    db_url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not db_url:
        print(
            "ERROR: DATABASE_URL or DATABASE_URL_UNPOOLED must be set "
            "(source .env.local first).",
            file=sys.stderr,
        )
        return 2

    lottery_tickers = _load_lottery_tickers()

    print(f"date:     {args.date}", flush=True)
    print(f"parquet:  {parquet_path}", flush=True)
    print(f"window:   {day_start_utc} → {day_end_utc}", flush=True)
    print(f"universe: {len(lottery_tickers)} tickers (from uw-stream/src/config.py)", flush=True)
    print(f"mode:     {'APPLY' if args.apply else 'DRY-RUN'}", flush=True)
    print(flush=True)

    con = psycopg2.connect(db_url)
    con.autocommit = False

    coverage_before = _fetch_coverage(con, day_start_utc, day_end_utc)
    print("ws_option_trades coverage BEFORE (rows per UTC hour):", flush=True)
    for hr in range(day_start_utc.hour, day_end_utc.hour):
        print(f"  {hr:02d}:00  {coverage_before.get(hr, 0):>10,}", flush=True)
    print(f"  total: {sum(coverage_before.values()):,}", flush=True)
    print(flush=True)

    # Stream the parquet with predicate pushdown so we never materialise
    # the full multi-million-row frame in memory.
    needed_cols = [
        "id",
        "underlying_symbol",
        "option_chain_id",
        "option_type",
        "strike",
        "expiry",
        "executed_at",
        "price",
        "size",
        "underlying_price",
        "tags",
        "implied_volatility",
        "delta",
        "open_interest",
        "canceled",
        *_EXTRA_GREEK_COLS,
    ]
    lf = (
        pl.scan_parquet(parquet_path)
        .select(needed_cols)
        .filter(
            pl.col("underlying_symbol").is_in(list(lottery_tickers))
            & pl.col("executed_at").is_between(
                day_start_utc,
                day_end_utc,
                closed="left",
            )
            & pl.col("id").is_not_null()
            & (pl.col("price") > 0)
            & (pl.col("size") > 0)
        )
    )

    t0 = time.monotonic()
    print("→ Collecting filtered rows (streaming)...", flush=True)
    df = lf.collect(engine="streaming")
    print(
        f"  filtered rows: {df.height:,} ({time.monotonic() - t0:.1f}s)",
        flush=True,
    )

    cur = con.cursor()
    batch: list[tuple] = []
    total_kept = 0
    total_inserted = 0
    total_invalid = 0
    kept_by_ticker: dict[str, int] = {}

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

    for row in df.iter_rows(named=True):
        opt_type = _option_type_short(row["option_type"])
        if opt_type is None:
            total_invalid += 1
            continue
        executed_at: datetime = row["executed_at"]
        if executed_at.tzinfo is None:
            executed_at = executed_at.replace(tzinfo=timezone.utc)

        raw_payload = json.dumps(
            {
                "gamma": _clean_float(row["gamma"]),
                "delta": _clean_float(row["delta"]),
                "theta": _clean_float(row["theta"]),
                "vega": _clean_float(row["vega"]),
                "backfill_source": f"fulltape-{args.date}.parquet-regen",
            }
        )

        batch.append(
            (
                row["id"],
                row["underlying_symbol"],
                row["option_chain_id"],
                opt_type,
                _to_decimal(row["strike"]) or Decimal(0),
                row["expiry"],
                executed_at,
                _to_decimal(row["price"]),
                int(row["size"]),
                _to_decimal(row["underlying_price"]),
                _derive_side(row["tags"]),
                _to_decimal(row["implied_volatility"]),
                _to_decimal(row["delta"]),
                int(row["open_interest"]) if row["open_interest"] is not None else None,
                bool(row["canceled"]) if row["canceled"] is not None else False,
                raw_payload,
            )
        )
        total_kept += 1
        kept_by_ticker[row["underlying_symbol"]] = (
            kept_by_ticker.get(row["underlying_symbol"], 0) + 1
        )

        if len(batch) >= BATCH_SIZE:
            flush()

    flush()

    coverage_after = (
        _fetch_coverage(con, day_start_utc, day_end_utc) if args.apply else coverage_before
    )
    cur.close()
    con.close()

    elapsed = time.monotonic() - t0
    print(flush=True)
    print(f"DONE in {elapsed:.1f}s", flush=True)
    print(f"  rows kept (queued for insert): {total_kept:,}", flush=True)
    print(f"  invalid option_type:           {total_invalid:,}", flush=True)
    print(f"  inserted (or would insert):    {total_inserted:,}", flush=True)
    print(flush=True)

    if args.apply:
        print("ws_option_trades coverage AFTER (rows per UTC hour):", flush=True)
        for hr in range(day_start_utc.hour, day_end_utc.hour):
            before = coverage_before.get(hr, 0)
            after = coverage_after.get(hr, 0)
            delta = after - before
            print(f"  {hr:02d}:00  {after:>10,}  (Δ +{delta:,})", flush=True)
        print(
            f"  total: {sum(coverage_after.values()):,} "
            f"(Δ +{sum(coverage_after.values()) - sum(coverage_before.values()):,})",
            flush=True,
        )
        print(flush=True)

    print("projected inserts by ticker (top 30):", flush=True)
    top = sorted(kept_by_ticker.items(), key=lambda x: -x[1])[:30]
    for tkr, n in top:
        print(f"  {tkr:6s}  {n:>10,}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
