# ml/experiments/exit-timing-engine/run_a1_build_dataset.py
"""A1: build the per-minute decision dataset from the parquet full tape.

Run: ml/.venv/bin/python ml/experiments/exit-timing-engine/run_a1_build_dataset.py
Env: DATABASE_URL must be set (vercel env pull .env.local).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd
import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from exit_engine import config as cfg
from exit_engine.dataset import build_fire_rows, select_session_dates
from exit_engine.path_reconstruction import assemble_multiday_path

TRADE_COLS = ["executed_at", "option_chain_id", "nbbo_bid", "nbbo_ask", "price", "canceled"]


def load_fires(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id, date, entry_time_ct, entry_price,
               option_chain_id, option_type, mode,
               peak_ceiling_pct
        FROM lottery_finder_fires
        WHERE mode = ANY(%(modes)s)
          AND entry_price > 0
          AND peak_ceiling_pct IS NOT NULL
        ORDER BY date, entry_time_ct
        """,
        conn,
        params={"modes": list(cfg.IN_UNIVERSE_MODES)},
    )


def _parquet_path(date_str: str) -> Path | None:
    for pat in (cfg.PARQUET_TRADES_PATTERN, cfg.PARQUET_FULLTAPE_PATTERN):
        p = cfg.PARQUET_DIR / pat.format(date=date_str)
        if p.exists():
            return p
    return None


def _available_dates() -> list[str]:
    """Sorted YYYY-MM-DD strings that actually have a parquet (trades or fulltape),
    so multi-day reconstruction skips weekends/holidays automatically."""
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

    # Plan: each fire's needed trading sessions + a date -> fires index, so each
    # daily parquet is read exactly ONCE and serves every fire that needs it.
    fires_by_id = {int(f.id): f for f in fires.itertuples(index=False)}
    fire_dates: dict[int, list[str]] = {}
    date_to_fire_ids: dict[str, list[int]] = {}
    for fid, fire in fires_by_id.items():
        max_sessions = cfg.MAX_HOLD_DAYS if fire.mode == cfg.MODE_MULTIDAY else 1
        needed = select_session_dates(fire.date_str, available, max_sessions)
        if not needed:
            continue
        fire_dates[fid] = needed
        for d in needed:
            date_to_fire_ids.setdefault(d, []).append(fid)

    frames: dict[int, list[pd.DataFrame]] = {fid: [] for fid in fire_dates}
    days_read = 0
    for date_str in sorted(date_to_fire_ids):
        base = _parquet_path(date_str)
        if base is None:
            continue
        day_fids = date_to_fire_ids[date_str]
        wanted = {fires_by_id[fid].option_chain_id for fid in day_fids}
        day = pd.read_parquet(base, columns=TRADE_COLS)
        day = day[day["option_chain_id"].isin(wanted)].copy()
        days_read += 1
        if day.empty:
            continue
        day["executed_at"] = pd.to_datetime(day["executed_at"], utc=True)
        by_chain = dict(tuple(day.groupby("option_chain_id", observed=True)))
        for fid in day_fids:
            ch = fires_by_id[fid].option_chain_id
            if ch in by_chain:
                frames[fid].append(by_chain[ch])

    all_rows: list[pd.DataFrame] = []
    peak_checks: list[tuple[float, float]] = []
    for fid, day_frames in frames.items():
        if not day_frames:
            continue
        fire = fires_by_id[fid]
        path = assemble_multiday_path(day_frames, fire.entry_ts, float(fire.entry_price))
        if path.empty:
            continue
        rows = build_fire_rows(
            path, fire_id=fid, date=fire.date_str, mode=fire.mode,
            entry_price=float(fire.entry_price),
            minutes_to_close=_minutes_to_close(path),
            theta=cfg.THETA_FORWARD_DEFAULT,
        )
        all_rows.append(rows)
        rebuilt_peak = (path["mid"].max() - fire.entry_price) / fire.entry_price * 100.0
        peak_checks.append((float(fire.peak_ceiling_pct), float(rebuilt_peak)))

    if not all_rows:
        print("No reconstructable paths.")
        return 1
    dataset = pd.concat(all_rows, ignore_index=True)
    cfg.DATASET_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_parquet(cfg.DATASET_PARQUET, index=False)

    checks = pd.DataFrame(peak_checks, columns=["stored", "rebuilt"])
    within = (abs(checks["stored"] - checks["rebuilt"]) <= 5.0).mean() * 100
    print(f"fires planned:         {len(fire_dates):,}")
    print(f"fires reconstructed:   {dataset['fire_id'].nunique():,}")
    print(f"decision rows:         {len(dataset):,}")
    print(f"daily parquets read:   {days_read} (one per needed session)")
    print(f"by mode:\n{dataset.groupby('mode')['fire_id'].nunique()}")
    print(f"peak rebuild within 5pp of stored: {within:.1f}%  (sanity check)")
    print(f"wrote {cfg.DATASET_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
