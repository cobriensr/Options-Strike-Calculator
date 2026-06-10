# ml/experiments/exit-timing-engine/run_a1_build_dataset.py
"""A1: build the per-minute decision dataset from the parquet full tape.

RESUMABLE: output partitioned by entry-month into cfg.DATASET_DIR/part-YYYY-MM.parquet,
written atomically (.tmp -> rename). Months whose part already exists are skipped,
so a sleep/kill resumes where it left off. Reads each daily parquet once
(predicate-pushdown), stream-assembles + frees per fire, logs per-month progress.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a1_build_dataset.py
Env: DATABASE_URL (required); A1_SMOKE_DATES=<N> (optional, last N sessions).
"""
from __future__ import annotations

import os
import sys
from collections import Counter
from pathlib import Path

import pandas as pd
import psycopg2
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.dataset import build_fire_rows, select_session_dates
from exit_engine.path_reconstruction import assemble_multiday_path

TRADE_COLS = [
    "executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled",
    "implied_volatility", "delta", "gamma", "underlying_price", "strike", "option_type",
]
FLUSH_ROWS = 1_000_000


def load_fires(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id, date, entry_time_ct, entry_price,
               option_chain_id, option_type, mode, peak_ceiling_pct
        FROM lottery_finder_fires
        WHERE mode = ANY(%(modes)s) AND entry_price > 0 AND peak_ceiling_pct IS NOT NULL
        ORDER BY date, entry_time_ct
        """,
        conn, params={"modes": list(cfg.IN_UNIVERSE_MODES)},
    )


def _parquet_path(date_str: str) -> Path | None:
    for pat in (cfg.PARQUET_TRADES_PATTERN, cfg.PARQUET_FULLTAPE_PATTERN):
        p = cfg.PARQUET_DIR / pat.format(date=date_str)
        if p.exists():
            return p
    return None


def _available_dates() -> list[str]:
    dates: set[str] = set()
    for suffix in ("-trades.parquet", "-fulltape.parquet"):
        for p in cfg.PARQUET_DIR.glob(f"*{suffix}"):
            dates.add(p.name[: -len(suffix)])
    return sorted(dates)


def _minutes_to_close(path: pd.DataFrame) -> list[float]:
    out = []
    for ts in path["minute"]:
        ct = ts.tz_convert("America/Chicago")
        close = ct.replace(hour=cfg.EOD_CT_HOUR, minute=0, second=0, microsecond=0)
        out.append(max(0.0, (close - ct).total_seconds() / 60.0))
    return out


def _build_one_month(month_fids, fires_by_id, available, out_part) -> dict:
    """Reconstruct one entry-month's fires; write out_part atomically. Returns tallies."""
    date_to_fire_ids: dict[str, list[int]] = {}
    last_date_fire_ids: dict[str, list[int]] = {}
    for fid in month_fids:
        fire = fires_by_id[fid]
        max_sessions = cfg.MAX_HOLD_DAYS if fire.mode == cfg.MODE_MULTIDAY else 1
        needed = select_session_dates(fire.date_str, available, max_sessions)
        if not needed:
            continue
        for d in needed:
            date_to_fire_ids.setdefault(d, []).append(fid)
        last_date_fire_ids.setdefault(needed[-1], []).append(fid)

    tally = {"fires": 0, "rows": 0, "modes": Counter(), "within": 0, "total": 0}
    if not date_to_fire_ids:
        return tally

    tmp = out_part.parent / (out_part.name + f".{os.getpid()}.tmp")
    writer = None
    schema = None
    buf: list[pd.DataFrame] = []
    buf_rows = 0
    frames: dict[int, list[pd.DataFrame]] = {
        fid: [] for fids in date_to_fire_ids.values() for fid in fids
    }

    def flush():
        nonlocal writer, schema, buf, buf_rows
        if not buf:
            return
        df = pd.concat(buf, ignore_index=True)
        buf = []
        buf_rows = 0
        if schema is None:
            tbl = pa.Table.from_pandas(df, preserve_index=False)
            schema = tbl.schema
            writer = pq.ParquetWriter(str(tmp), schema)
        else:
            tbl = pa.Table.from_pandas(df, schema=schema, preserve_index=False)
        writer.write_table(tbl)

    for date_str in sorted(date_to_fire_ids):
        base = _parquet_path(date_str)
        if base is not None:
            fids = date_to_fire_ids[date_str]
            wanted = list({fires_by_id[f].option_chain_id for f in fids})
            day = pd.read_parquet(base, columns=TRADE_COLS, filters=[("option_chain_id", "in", wanted)])
            if not day.empty:
                day["executed_at"] = pd.to_datetime(day["executed_at"], utc=True)
                by_chain = dict(tuple(day.groupby("option_chain_id", observed=True)))
                for f in fids:
                    ch = fires_by_id[f].option_chain_id
                    if ch in by_chain:
                        frames[f].append(by_chain[ch])
            del day
        for fid in last_date_fire_ids.get(date_str, []):
            dframes = frames.pop(fid, [])
            if not dframes:
                continue
            fire = fires_by_id[fid]
            path = assemble_multiday_path(dframes, fire.entry_ts, float(fire.entry_price))
            if path.empty:
                continue
            rows = build_fire_rows(
                path, fire_id=fid, date=fire.date_str, mode=fire.mode,
                entry_price=float(fire.entry_price),
                minutes_to_close=_minutes_to_close(path),
                theta=cfg.THETA_FORWARD_DEFAULT,
            )
            buf.append(rows)
            buf_rows += len(rows)
            tally["fires"] += 1
            tally["rows"] += len(rows)
            tally["modes"][fire.mode] += 1
            rebuilt = (path["mid"].max() - fire.entry_price) / fire.entry_price * 100.0
            tally["total"] += 1
            if abs(float(fire.peak_ceiling_pct) - float(rebuilt)) <= 5.0:
                tally["within"] += 1
            if buf_rows >= FLUSH_ROWS:
                flush()

    flush()
    if writer is not None:
        writer.close()
        tmp.replace(out_part)  # atomic finalize
    return tally


def main() -> int:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("Missing DATABASE_URL", file=sys.stderr)
        return 1
    with psycopg2.connect(db_url) as conn:
        fires = load_fires(conn)
    if fires.empty:
        print("No in-universe fires found.")
        return 1
    fires["entry_ts"] = pd.to_datetime(fires["entry_time_ct"], utc=True)
    fires["date_str"] = fires["date"].astype(str)

    available = _available_dates()
    if not available:
        print(f"No parquet files in {cfg.PARQUET_DIR}", file=sys.stderr)
        return 1
    smoke = os.environ.get("A1_SMOKE_DATES")
    if smoke:
        n = int(smoke)
        available = available[-n:]
        print(f"SMOKE MODE: last {n} sessions ({available[0]} .. {available[-1]})", flush=True)

    fires_by_id = {int(f.id): f for f in fires.itertuples(index=False)}
    months: dict[str, list[int]] = {}
    for fid, fire in fires_by_id.items():
        months.setdefault(fire.date_str[:7], []).append(fid)

    cfg.DATASET_DIR.mkdir(parents=True, exist_ok=True)
    # NOTE: no global *.tmp cleanup here — temp files are per-process (pid-suffixed)
    # so parallel single-month builds don't delete each other's in-progress writes.
    # Orphaned tmps from a crash are ignored (skip-check + readers match part-*.parquet).

    ordered = sorted(months)
    only = os.environ.get("A1_ONLY_MONTH")
    if only:
        ordered = [m for m in ordered if m == only]
        print(f"ONLY-MONTH MODE: building {only} only", flush=True)
    run = {"fires": 0, "rows": 0, "modes": Counter(), "within": 0, "total": 0}
    for i, month in enumerate(ordered, 1):
        out_part = cfg.DATASET_DIR / f"part-{month}.parquet"
        if out_part.exists():
            print(f"[{i}/{len(ordered)}] {month}: already built — skip", flush=True)
            continue
        t = _build_one_month(months[month], fires_by_id, available, out_part)
        run["fires"] += t["fires"]; run["rows"] += t["rows"]
        run["modes"] += t["modes"]; run["within"] += t["within"]; run["total"] += t["total"]
        print(f"[{i}/{len(ordered)}] {month}: fires={t['fires']:,} rows={t['rows']:,} "
              f"(run cum fires={run['fires']:,})", flush=True)

    parts = sorted(cfg.DATASET_DIR.glob("part-*.parquet"))
    rows_disk = sum(pq.read_metadata(str(p)).num_rows for p in parts)
    print(f"parts on disk:        {len(parts)}")
    print(f"total rows on disk:   {rows_disk:,}")
    print(f"this run: fires={run['fires']:,} rows={run['rows']:,} by_mode={dict(run['modes'])}")
    if run["total"]:
        print(f"peak rebuild within 5pp (this run, mid vs trade-price): {run['within'] / run['total'] * 100:.1f}%")
    print(f"dataset dir: {cfg.DATASET_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
