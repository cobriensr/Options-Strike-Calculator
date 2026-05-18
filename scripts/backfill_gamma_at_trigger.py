"""Backfill gamma_at_trigger on lottery_finder_fires + silent_boom_alerts.

Migration #168 (2026-05-17) added `gamma_at_trigger` to both tables.
The detect crons populate it forward-only via raw_payload->>'gamma';
this script populates it on existing rows by computing volume-weighted
gamma over each row's trigger window from the full-tape parquet
archive at /Users/charlesobrien/Desktop/Eod-Full-Tape-parquet/.

Semantics:
  - Lottery Finder fires: rolling 5-min trailing window ending at
    trigger_time_ct (matches the v4 detector window).
  - Silent Boom alerts: the 5-min date_bin bucket starting at
    bucket_ct (matches the SB detector bucket).

Both systems compute `SUM(gamma * size) / SUM(size) FILTER WHERE
gamma IS NOT NULL` over their respective windows — same volume-
weighting the live cron uses.

Idempotency: every UPDATE is gated on `gamma_at_trigger IS NULL`, so
re-runs are safe. Rows already populated by the cron (post-#168) are
skipped.

Run modes:
    # smoke test — 1 date only, no DB writes
    ml/.venv/bin/python scripts/backfill_gamma_at_trigger.py --dry-run --date 2026-05-15

    # full backfill — both tables, all dates
    ml/.venv/bin/python scripts/backfill_gamma_at_trigger.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb
import psycopg2
from psycopg2.extras import execute_values

REPO_ROOT = Path(__file__).resolve().parents[1]
PARQUET_DIR = Path.home() / "Desktop" / "Eod-Full-Tape-parquet"


def load_env() -> str:
    env = REPO_ROOT / ".env.local"
    if not env.exists():
        sys.exit(f"Missing {env}")
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip('"').strip("'")
    sys.exit("DATABASE_URL not in .env.local")


def check_migration_applied(pg_conn) -> None:
    """Bail out with a clear message when migration #168 hasn't landed."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_name = 'lottery_finder_fires'
                 AND column_name = 'gamma_at_trigger'
            )
            """
        )
        has_lf = cur.fetchone()[0]
        cur.execute(
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_name = 'silent_boom_alerts'
                 AND column_name = 'gamma_at_trigger'
            )
            """
        )
        has_sb = cur.fetchone()[0]
    if not has_lf or not has_sb:
        print(
            "ERROR: gamma_at_trigger column missing\n"
            f"  lottery_finder_fires: {'OK' if has_lf else 'MISSING'}\n"
            f"  silent_boom_alerts:   {'OK' if has_sb else 'MISSING'}\n"
            "Apply migration #168 first. Two paths:\n"
            "  (1) Vercel deploy → next manual POST /api/journal/migrate\n"
            "      (requires OWNER_SECRET to be set in prod; per memory\n"
            "      feedback_owner_secret_empty_in_prod, it is currently\n"
            "      empty so this path 401s).\n"
            "  (2) Direct psql against Neon — fastest path:\n"
            "        psql $DATABASE_URL -c \"ALTER TABLE\n"
            "        lottery_finder_fires ADD COLUMN IF NOT EXISTS\n"
            "        gamma_at_trigger NUMERIC;\"\n"
            "        psql $DATABASE_URL -c \"ALTER TABLE\n"
            "        silent_boom_alerts ADD COLUMN IF NOT EXISTS\n"
            "        gamma_at_trigger NUMERIC;\"\n"
            "      Then re-run combined_score recreation + index per\n"
            "      api/_lib/db-migrations.ts:#168.\n"
            "Bailing out — re-run the script after the migration lands."
        )
        sys.exit(2)


def backfill_table(
    pg_conn,
    duck_con: duckdb.DuckDBPyConnection,
    table: str,
    time_col: str,
    window_kind: str,
    only_date: str | None,
    dry_run: bool,
) -> dict:
    """Populate gamma_at_trigger on `table` from parquet.

    Parameters:
      table       — 'lottery_finder_fires' or 'silent_boom_alerts'
      time_col    — 'trigger_time_ct' (LF) or 'bucket_ct' (SB)
      window_kind — 'trailing-5min' (LF) or 'bucket-5min' (SB)
      only_date   — restrict to a single date (smoke test) or None
      dry_run     — if True, compute but don't UPDATE

    Returns a summary dict.
    """
    date_filter = f"AND date = '{only_date}'" if only_date else ""
    with pg_conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, date::text AS date, option_chain_id, {time_col}
              FROM {table}
             WHERE gamma_at_trigger IS NULL
               {date_filter}
             ORDER BY date, id
            """
        )
        rows = cur.fetchall()
    total = len(rows)
    print(f"\n[{table}] {total:,} rows need backfill"
          + (f" (date filter: {only_date})" if only_date else ""))
    if total == 0:
        return {"table": table, "candidates": 0, "computed": 0, "updated": 0}

    # Group by date — each date is one parquet file.
    by_date: dict[str, list[tuple[int, str, object]]] = {}
    for fid, date, chain_id, ts in rows:
        by_date.setdefault(date, []).append((fid, chain_id, ts))

    computed = 0
    updated = 0
    for date, day_rows in sorted(by_date.items()):
        parquet_path = PARQUET_DIR / f"{date}-fulltape.parquet"
        if not parquet_path.exists():
            print(f"  [{date}] SKIP — no parquet file")
            continue

        # Build a probe DataFrame Duck can register.
        import pandas as pd
        probe = pd.DataFrame(
            day_rows, columns=["id", "option_chain_id", "ts"]
        )
        probe["ts"] = pd.to_datetime(probe["ts"], utc=True)

        duck_con.register("probe", probe)
        if window_kind == "trailing-5min":
            join_clause = (
                "t.executed_at <= p.ts "
                "AND t.executed_at > p.ts - INTERVAL '5 minutes'"
            )
        else:  # bucket-5min
            join_clause = (
                "t.executed_at >= p.ts "
                "AND t.executed_at < p.ts + INTERVAL '5 minutes'"
            )

        sql = f"""
            SELECT
              p.id AS id,
              SUM(t.gamma * t.size)
                FILTER (WHERE t.gamma IS NOT NULL)
                / NULLIF(SUM(t.size) FILTER (WHERE t.gamma IS NOT NULL), 0)
                AS computed_gamma
            FROM probe p
            JOIN read_parquet('{parquet_path}') t
              ON t.option_chain_id = p.option_chain_id
             AND t.canceled = false
             AND {join_clause}
            GROUP BY p.id
            HAVING computed_gamma IS NOT NULL
        """
        result = duck_con.execute(sql).df()
        duck_con.unregister("probe")

        computed_this_date = len(result)
        computed += computed_this_date
        print(f"  [{date}] {len(day_rows):,} candidates → "
              f"{computed_this_date:,} with computable gamma")
        if dry_run:
            if not result.empty:
                print(result.head(5).to_string(index=False))
            continue

        # Batch UPDATE via execute_values.
        if not result.empty:
            tuples = [
                (int(r.id), float(r.computed_gamma))
                for r in result.itertuples()
            ]
            with pg_conn.cursor() as cur:
                # execute_values default page_size=100 only reports
                # the LAST batch's rowcount. Bump page_size beyond the
                # likely per-day row count so the whole UPDATE runs in
                # a single statement and cur.rowcount is honest. 10000
                # comfortably covers TSLA-class chains' max fire-count
                # days; if a date ever exceeds that, the per-page
                # rowcount-loss is back to the prior (cosmetic) bug.
                execute_values(
                    cur,
                    f"""
                    UPDATE {table} AS t
                       SET gamma_at_trigger = v.gamma::numeric
                      FROM (VALUES %s) AS v(id, gamma)
                     WHERE t.id = v.id
                       AND t.gamma_at_trigger IS NULL
                    """,
                    tuples,
                    page_size=10000,
                )
                updated_this_date = cur.rowcount
            pg_conn.commit()
            updated += updated_this_date
            print(f"    UPDATED {updated_this_date:,} rows")
    return {
        "table": table,
        "candidates": total,
        "computed": computed,
        "updated": updated,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute gamma values but do NOT UPDATE the DB")
    parser.add_argument("--date", type=str, default=None,
                        help="Restrict to one YYYY-MM-DD (smoke test)")
    parser.add_argument("--table", choices=["lf", "sb", "both"], default="both",
                        help="Which table to backfill (default: both)")
    args = parser.parse_args()

    print(f"Mode: {'DRY-RUN (no writes)' if args.dry_run else 'LIVE'}")
    if args.date:
        print(f"Date filter: {args.date}")

    duck_con = duckdb.connect(":memory:")
    pg_conn = psycopg2.connect(load_env())
    pg_conn.autocommit = False
    check_migration_applied(pg_conn)

    summaries = []
    try:
        if args.table in ("lf", "both"):
            summaries.append(backfill_table(
                pg_conn, duck_con,
                table="lottery_finder_fires",
                time_col="trigger_time_ct",
                window_kind="trailing-5min",
                only_date=args.date,
                dry_run=args.dry_run,
            ))
        if args.table in ("sb", "both"):
            summaries.append(backfill_table(
                pg_conn, duck_con,
                table="silent_boom_alerts",
                time_col="bucket_ct",
                window_kind="bucket-5min",
                only_date=args.date,
                dry_run=args.dry_run,
            ))
    finally:
        pg_conn.close()
        duck_con.close()

    print("\n=== SUMMARY ===")
    for s in summaries:
        print(f"  {s['table']:30s}  candidates={s['candidates']:,}  "
              f"computed={s['computed']:,}  updated={s['updated']:,}")


if __name__ == "__main__":
    main()
