#!/usr/bin/env python
"""Per-table autovacuum tuning on the hottest tables.

Default Postgres autovacuum thresholds (50 + 20% of n_live_tup) are
calibrated for tables that change occasionally. ws_gex_strike_expiry
takes ~117k UPSERTs per minute during market hours — at 65M live rows,
default would wait for 13M dead tuples before vacuuming, which never
happens during a session. Result: stale visibility map → 122k heap
fetches on an index-only scan → file cache thrashing → 188 hung
backends. The 2026-05-13 incident.

Lowering scale_factor to 1% (vacuum) / 0.5% (analyze) trips autovacuum
at ~660k / 330k dead tuples — frequent enough to keep VM fresh,
infrequent enough not to thrash.
"""
import os
import re
import time

import psycopg2

ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env.local')
with open(ENV) as f:
    for line in f:
        m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))

TABLES = (
    'ws_gex_strike_expiry',
    'gex_strike_0dte',
    'ws_option_trades',
)

conn = psycopg2.connect(os.environ['DATABASE_URL'])
conn.autocommit = True

for tbl in TABLES:
    t0 = time.time()
    with conn.cursor() as cur:
        cur.execute(
            f"""
            ALTER TABLE {tbl} SET (
                autovacuum_vacuum_scale_factor = 0.01,
                autovacuum_analyze_scale_factor = 0.005,
                autovacuum_vacuum_threshold = 1000,
                autovacuum_analyze_threshold = 1000
            )
            """,
        )
    print(f'tuned {tbl} in {time.time() - t0:.2f}s', flush=True)

# Confirm
with conn.cursor() as cur:
    cur.execute("""
        SELECT relname, reloptions
        FROM pg_class
        WHERE relname = ANY(%s)
        ORDER BY relname
    """, (list(TABLES),))
    for r in cur.fetchall():
        print(r)
conn.close()
