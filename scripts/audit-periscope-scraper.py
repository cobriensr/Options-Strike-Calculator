"""
Audit script: pull a random sample of full-coverage trading days from
periscope_snapshots and write each day to its own tab in an Excel workbook
so the user can spot-check scraper accuracy against the live UW Periscope UI.

Run: ml/.venv/bin/python scripts/audit-periscope-scraper.py
Output: docs/tmp/periscope-scraper-audit-<today>.xlsx
"""

from __future__ import annotations

import random
from datetime import date
from pathlib import Path

import pandas as pd
import psycopg2

REPO = Path(__file__).resolve().parent.parent
ENV_PATH = REPO / '.env.local'
OUT_PATH = REPO / 'docs' / 'tmp' / f'periscope-scraper-audit-{date.today().isoformat()}.xlsx'
SAMPLE_SIZE = 5
SEED = 20260510


def load_database_url() -> str:
    for line in ENV_PATH.read_text().splitlines():
        if line.startswith('DATABASE_URL='):
            return line.split('=', 1)[1].strip().strip('"')
    raise RuntimeError('DATABASE_URL not found in .env.local')


def main() -> None:
    conn = psycopg2.connect(load_database_url(), sslmode='require')
    cur = conn.cursor()

    cur.execute(
        """
        SELECT (captured_at AT TIME ZONE 'America/Chicago')::date AS d
        FROM periscope_snapshots
        WHERE captured_at >= '2025-11-01'
        GROUP BY 1
        HAVING COUNT(DISTINCT timeframe) >= 35
           AND COUNT(DISTINCT panel) >= 3
        ORDER BY 1
        """
    )
    days = [row[0] for row in cur.fetchall()]
    print(f'Found {len(days)} full-coverage days')

    rng = random.Random(SEED)
    bucket_size = max(1, len(days) // SAMPLE_SIZE)
    picks = sorted(
        {rng.choice(days[i : i + bucket_size]) for i in range(0, len(days), bucket_size)}
    )[:SAMPLE_SIZE]
    print(f'Sampled days: {picks}')

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(OUT_PATH, engine='openpyxl') as writer:
        summary_rows = []

        for d in picks:
            cur.execute(
                """
                SELECT
                  timeframe,
                  panel,
                  strike,
                  value::float AS value,
                  (captured_at AT TIME ZONE 'America/Chicago')::time AS captured_ct,
                  expiry
                FROM periscope_snapshots
                WHERE (captured_at AT TIME ZONE 'America/Chicago')::date = %s
                ORDER BY timeframe ASC, panel ASC, strike ASC
                """,
                (d,),
            )
            cols = [c[0] for c in cur.description]
            df = pd.DataFrame(cur.fetchall(), columns=cols)

            sheet = d.isoformat()
            df.to_excel(writer, sheet_name=sheet, index=False)

            ws = writer.sheets[sheet]
            ws.freeze_panes = 'A2'
            for col_idx, col in enumerate(df.columns, start=1):
                width = min(max(len(col), df[col].astype(str).map(len).max() if len(df) else 0) + 2, 28)
                ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = width

            summary_rows.append(
                {
                    'date': d.isoformat(),
                    'rows': len(df),
                    'timeframes': df['timeframe'].nunique(),
                    'panels': ', '.join(sorted(df['panel'].unique())),
                    'strikes_min': df['strike'].min() if len(df) else None,
                    'strikes_max': df['strike'].max() if len(df) else None,
                    'first_slot': df['timeframe'].min() if len(df) else None,
                    'last_slot': df['timeframe'].max() if len(df) else None,
                }
            )
            print(f'  {sheet}: {len(df):,} rows, {df["timeframe"].nunique()} timeframes')

        summary = pd.DataFrame(summary_rows)
        summary.to_excel(writer, sheet_name='_summary', index=False)
        ws = writer.sheets['_summary']
        ws.freeze_panes = 'A2'
        for col_idx, col in enumerate(summary.columns, start=1):
            width = min(max(len(col), summary[col].astype(str).map(len).max()) + 2, 28)
            ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = width

        # Move _summary to first tab
        wb = writer.book
        wb.move_sheet('_summary', offset=-len(picks))

    conn.close()
    size_kb = OUT_PATH.stat().st_size // 1024
    print(f'\nWrote {OUT_PATH.relative_to(REPO)} ({size_kb} KB)')


if __name__ == '__main__':
    main()
