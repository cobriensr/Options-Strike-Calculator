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
from exit_engine.dataset import build_fire_rows
from exit_engine.path_reconstruction import assemble_multiday_path

EOD_CT_HOUR = 15
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


def _minutes_to_close(path: pd.DataFrame) -> list[float]:
    out = []
    for ts in path["minute"]:
        ct = ts.tz_convert("America/Chicago")
        close = ct.replace(hour=EOD_CT_HOUR, minute=0, second=0, microsecond=0)
        out.append((close - ct).total_seconds() / 60.0)
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

    all_rows: list[pd.DataFrame] = []
    peak_checks: list[tuple[float, float]] = []
    days_present, days_missing = set(), set()

    for date_str, day_fires in fires.groupby(fires["date"].astype(str)):
        base = _parquet_path(date_str)
        if base is None:
            days_missing.add(date_str)
            continue
        days_present.add(date_str)
        for fire in day_fires.itertuples(index=False):
            day_frames = []
            for offset in range(cfg.MAX_HOLD_DAYS if fire.mode == cfg.MODE_MULTIDAY else 1):
                d = (pd.Timestamp(date_str) + pd.Timedelta(days=offset)).strftime("%Y-%m-%d")
                p = _parquet_path(d)
                if p is None:
                    break
                trades = pd.read_parquet(p, columns=TRADE_COLS)
                trades = trades[trades["option_chain_id"] == fire.option_chain_id].copy()
                if not trades.empty:
                    trades["executed_at"] = pd.to_datetime(trades["executed_at"], utc=True)
                    day_frames.append(trades)
            if not day_frames:
                continue
            path = assemble_multiday_path(day_frames, fire.entry_ts, float(fire.entry_price))
            if path.empty:
                continue
            rows = build_fire_rows(
                path, fire_id=int(fire.id), date=date_str, mode=fire.mode,
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
    print(f"fires reconstructed:   {dataset['fire_id'].nunique():,}")
    print(f"decision rows:         {len(dataset):,}")
    print(f"days present/missing:  {len(days_present)}/{len(days_missing)}")
    print(f"by mode:\n{dataset.groupby('mode')['fire_id'].nunique()}")
    print(f"peak rebuild within 5pp of stored: {within:.1f}%  (sanity check)")
    print(f"wrote {cfg.DATASET_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
