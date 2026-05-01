"""
One-shot backfill: populate the precision-stack overlay columns on
gamma_squeeze_events from strike_iv_snapshots.

Stamps three values per existing event:
  - hhi_neighborhood        Herfindahl of cross-strike notional concentration
                            within ±0.5% of spot at fire time. Lower = diffuse.
  - iv_morning_vol_corr     Pearson correlation of per-minute (Δ implied_vol,
                            Δ cumulative volume) for the strike, restricted
                            to executed_at ≤ 11:00 CT.
  - precision_stack_pass    True iff HHI ≤ p30 of universe-day AND
                            iv_morning_vol_corr ≥ p80 of universe-day.

Outputs a CSV report at docs/tmp/precision-stack-backfill-<UTC-date>.csv
plus a per-day summary printed to stdout.

Usage:
    ml/.venv/bin/python scripts/backfill-precision-stack.py

Prereq: migration 104 must be applied (script verifies and exits otherwise).

Spec: docs/superpowers/specs/precision-stack-overlay-2026-04-30.md
"""

from __future__ import annotations

import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
    import psycopg2
    from psycopg2.extras import RealDictCursor, execute_values
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Install: ml/.venv/bin/pip install psycopg2-binary numpy pandas", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = REPO_ROOT / ".env.local"
OUT_DIR = REPO_ROOT / "docs" / "tmp"

# Constants — keep in sync with api/_lib/precision-stack.ts (Phase 2).
PROXIMITY_BAND_PCT = 0.005
IV_MORNING_CUTOFF_HOUR_CT = 11
HHI_PASS_PERCENTILE = 0.30
IV_VOL_CORR_PASS_PERCENTILE = 0.80
MIN_IV_SAMPLES = 5
MIN_BAND_STRIKES = 3


def load_env_local() -> dict[str, str]:
    env: dict[str, str] = dict(os.environ)
    if ENV_LOCAL.exists():
        for line in ENV_LOCAL.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, val = line.partition("=")
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def connect(env: dict[str, str]):
    url = env.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not in env / .env.local", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url, sslmode="require", connect_timeout=10)


def verify_migration(cur) -> None:
    cur.execute("SELECT MAX(id) AS max_id FROM schema_migrations")
    row = cur.fetchone()
    max_id = row["max_id"] if row else None
    if max_id is None or max_id < 104:
        print(
            f"Migration 104 not applied (latest: {max_id}). "
            f"Run POST /api/journal/init or apply migrate first.",
            file=sys.stderr,
        )
        sys.exit(1)
    cur.execute(
        """
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'gamma_squeeze_events'
           AND column_name IN ('hhi_neighborhood','iv_morning_vol_corr','precision_stack_pass')
        """
    )
    cols = {r["column_name"] for r in cur.fetchall()}
    missing = {"hhi_neighborhood", "iv_morning_vol_corr", "precision_stack_pass"} - cols
    if missing:
        print(f"Missing columns on gamma_squeeze_events: {sorted(missing)}", file=sys.stderr)
        sys.exit(1)


def fetch_events(cur) -> list[dict]:
    cur.execute(
        """
        SELECT id, ticker, strike, side, expiry, ts, spot_at_detect
          FROM gamma_squeeze_events
         ORDER BY ts
        """
    )
    return cur.fetchall()


def compute_hhi(cur, event: dict) -> float | None:
    """
    Approximate the strike's neighborhood band at fire time using
    strike_iv_snapshots. Premium proxy = volume × mid_price × 100.
    Pull the latest snapshot per strike at-or-before the event's ts.
    """
    spot = float(event["spot_at_detect"])
    band_low = spot * (1 - PROXIMITY_BAND_PCT)
    band_high = spot * (1 + PROXIMITY_BAND_PCT)
    cur.execute(
        """
        SELECT DISTINCT ON (strike)
               strike, volume, mid_price
          FROM strike_iv_snapshots
         WHERE ticker = %s
           AND side = %s
           AND expiry = %s
           AND ts <= %s
           AND ts >= (%s::timestamptz - INTERVAL '15 minutes')
           AND strike BETWEEN %s AND %s
        ORDER BY strike, ts DESC
        """,
        (
            event["ticker"],
            event["side"],
            event["expiry"],
            event["ts"],
            event["ts"],
            band_low,
            band_high,
        ),
    )
    rows = cur.fetchall()
    if len(rows) < MIN_BAND_STRIKES:
        return None
    notionals = [
        float(r["volume"]) * float(r["mid_price"]) * 100
        for r in rows
        if r["volume"] is not None
        and r["mid_price"] is not None
        and float(r["volume"]) > 0
        and float(r["mid_price"]) > 0
    ]
    total = sum(notionals)
    if total <= 0 or len(notionals) < MIN_BAND_STRIKES:
        return None
    shares = [n / total for n in notionals]
    return float(sum(s * s for s in shares))


def compute_iv_morning_vol_corr(cur, event: dict) -> float | None:
    """
    Pearson correlation of per-minute (Δ iv_mid, Δ volume) on the strike,
    restricted to executed_at ≤ 11:00 CT on the event's trading date.
    """
    cur.execute(
        """
        WITH per_min AS (
            SELECT date_trunc('minute', ts AT TIME ZONE 'America/Chicago') AS minute_ct,
                   AVG(iv_mid) AS iv,
                   MAX(volume) AS cum_volume
              FROM strike_iv_snapshots
             WHERE ticker = %s
               AND strike = %s
               AND side = %s
               AND expiry = %s
               AND DATE(ts AT TIME ZONE 'America/Chicago') = DATE(%s::timestamptz AT TIME ZONE 'America/Chicago')
               AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Chicago') < %s
               AND iv_mid IS NOT NULL
               AND iv_mid > 0
               AND iv_mid < 5
             GROUP BY 1
        )
        SELECT minute_ct, iv, cum_volume
          FROM per_min
         ORDER BY minute_ct
        """,
        (
            event["ticker"],
            event["strike"],
            event["side"],
            event["expiry"],
            event["ts"],
            IV_MORNING_CUTOFF_HOUR_CT,
        ),
    )
    rows = cur.fetchall()
    if len(rows) < MIN_IV_SAMPLES:
        return None
    iv = np.array([float(r["iv"]) for r in rows])
    vol = np.array([float(r["cum_volume"]) for r in rows])
    iv_change = np.diff(iv)
    vol_change = np.diff(vol)
    if len(iv_change) < MIN_IV_SAMPLES:
        return None
    if iv_change.std() == 0 or vol_change.std() == 0:
        return None
    corr = float(np.corrcoef(iv_change, vol_change)[0, 1])
    if not np.isfinite(corr):
        return None
    return corr


def main() -> None:
    env = load_env_local()
    conn = connect(env)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=RealDictCursor)

    verify_migration(cur)

    events = fetch_events(cur)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] events to backfill: {len(events)}", flush=True)

    enriched: list[dict] = []
    for i, ev in enumerate(events):
        hhi = compute_hhi(cur, ev)
        iv_vol = compute_iv_morning_vol_corr(cur, ev)
        enriched.append({**ev, "hhi": hhi, "iv_vol_corr": iv_vol})
        if (i + 1) % 50 == 0:
            print(f"  … {i + 1} / {len(events)}", flush=True)

    # Per-day percentiles → set precision_stack_pass.
    df = pd.DataFrame(enriched)
    df["trade_date_ct"] = pd.to_datetime(df["ts"], utc=True).dt.tz_convert("America/Chicago").dt.date
    df["precision_stack_pass"] = False
    for date, sub in df.groupby("trade_date_ct"):
        valid = sub.dropna(subset=["hhi", "iv_vol_corr"])
        if len(valid) < 3:
            continue
        hhi_p30 = valid["hhi"].quantile(HHI_PASS_PERCENTILE)
        iv_p80 = valid["iv_vol_corr"].quantile(IV_VOL_CORR_PASS_PERCENTILE)
        passing = (
            (df["trade_date_ct"] == date)
            & df["hhi"].le(hhi_p30)
            & df["iv_vol_corr"].ge(iv_p80)
        )
        df.loc[passing, "precision_stack_pass"] = True

    # Persist back to gamma_squeeze_events.
    print(f"[{datetime.now().strftime('%H:%M:%S')}] writing back to DB …", flush=True)
    update_rows = [
        (
            None if pd.isna(r["hhi"]) else float(r["hhi"]),
            None if pd.isna(r["iv_vol_corr"]) else float(r["iv_vol_corr"]),
            bool(r["precision_stack_pass"]),
            int(r["id"]),
        )
        for _, r in df.iterrows()
    ]
    execute_values(
        cur,
        """
        UPDATE gamma_squeeze_events AS g
           SET hhi_neighborhood     = v.hhi_neighborhood::numeric,
               iv_morning_vol_corr  = v.iv_morning_vol_corr::numeric,
               precision_stack_pass = v.precision_stack_pass::boolean
          FROM (VALUES %s) AS v(hhi_neighborhood, iv_morning_vol_corr, precision_stack_pass, id)
         WHERE g.id = v.id
        """,
        update_rows,
        template="(%s, %s, %s, %s)",
    )
    conn.commit()
    print(f"  → {len(update_rows)} rows updated", flush=True)

    # Per-day summary.
    print(f"\n=== Per-day precision-stack summary ===")
    summary = (
        df.groupby("trade_date_ct")
        .agg(
            events=("id", "count"),
            with_hhi=("hhi", lambda s: s.notna().sum()),
            with_iv=("iv_vol_corr", lambda s: s.notna().sum()),
            passing=("precision_stack_pass", "sum"),
        )
        .reset_index()
    )
    print(summary.to_string(index=False))

    # CSV report.
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_csv = OUT_DIR / f"precision-stack-backfill-{today_str}.csv"
    with out_csv.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "id", "ticker", "strike", "side", "expiry", "ts_utc",
            "trade_date_ct", "spot_at_detect", "hhi", "iv_vol_corr",
            "precision_stack_pass",
        ])
        for _, r in df.iterrows():
            w.writerow([
                r["id"], r["ticker"], r["strike"], r["side"], r["expiry"],
                r["ts"].isoformat() if hasattr(r["ts"], "isoformat") else r["ts"],
                r["trade_date_ct"], r["spot_at_detect"],
                "" if pd.isna(r["hhi"]) else f"{r['hhi']:.6f}",
                "" if pd.isna(r["iv_vol_corr"]) else f"{r['iv_vol_corr']:.6f}",
                "true" if r["precision_stack_pass"] else "false",
            ])
    print(f"\nReport: {out_csv}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
