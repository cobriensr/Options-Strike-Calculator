#!/usr/bin/env python
"""VACUUM ANALYZE ws_gex_strike_expiry via psycopg2 (Neon HTTP times out at 30s).

The 2026-05-13 EXPLAIN showed 122k heap fetches on the 561k-row index-only
scan that powers getTimestampsForDay, blowing out Neon's file cache and
stacking 188 concurrent waiters. VACUUM rebuilds the visibility map +
reclaims dead tuples, restoring index-only-scan-without-heap behavior.

VACUUM (not FULL) is non-blocking — safe to run during market hours.
"""
import os
import re
import sys
import time

import psycopg2

ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env.local')
with open(ENV) as f:
    for line in f:
        m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip('"').strip("'"))

conn = psycopg2.connect(os.environ['DATABASE_URL'])
conn.autocommit = True  # VACUUM cannot run inside an explicit transaction.

for tbl in ('ws_gex_strike_expiry', 'gex_strike_0dte'):
    t0 = time.time()
    with conn.cursor() as cur:
        cur.execute(f'VACUUM (ANALYZE, VERBOSE) {tbl}')
    print(f'VACUUM ANALYZE {tbl} done in {time.time() - t0:.1f}s', flush=True)

with conn.cursor() as cur:
    cur.execute("""
        SELECT relname, n_live_tup, n_dead_tup,
               last_vacuum::text, last_analyze::text
        FROM pg_stat_user_tables
        WHERE relname IN ('ws_gex_strike_expiry', 'gex_strike_0dte')
        ORDER BY relname
    """)
    for r in cur.fetchall():
        print(r)
conn.close()
