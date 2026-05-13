// Neon production diagnostics. Surfaces the most likely root causes
// for the p50 = 169s latency observed on /api/gex-strike-expiry:
//   1. Connection count vs. limit (Neon serverless ceiling)
//   2. Active queries / wait events (locks, IO wait)
//   3. Idle-in-transaction sessions (poison the connection pool)
//   4. Long-running queries (blocking the pool)
//   5. Autovacuum / autoanalyze freshness on the hot tables
//   6. Table sizes for the queries the slow endpoint runs
//   7. Cache hit ratio (low ratio = compute is under-spec'd)
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
);
const sql = neon(env.DATABASE_URL);

function hdr(t) {
  console.log(`\n── ${t} ${'─'.repeat(60 - t.length)}`);
}

hdr('1. Connection count vs. limit');
const conns = await sql`
  SELECT
    (SELECT count(*) FROM pg_stat_activity)             AS total,
    (SELECT count(*) FROM pg_stat_activity WHERE state='active')                            AS active,
    (SELECT count(*) FROM pg_stat_activity WHERE state='idle')                              AS idle,
    (SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction')               AS idle_in_tx,
    (SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction (aborted)')     AS idle_in_tx_aborted,
    (SELECT setting::int FROM pg_settings WHERE name='max_connections')                     AS max_conns
`;
console.log(conns[0]);

hdr('2. Active queries right now (top 10 oldest)');
const active = await sql`
  SELECT
    pid,
    EXTRACT(EPOCH FROM (NOW() - query_start))::int  AS seconds,
    state,
    wait_event_type,
    wait_event,
    substr(query, 1, 100)                            AS query_head
  FROM pg_stat_activity
  WHERE state != 'idle'
    AND pid != pg_backend_pid()
    AND query_start IS NOT NULL
  ORDER BY query_start ASC
  LIMIT 10
`;
for (const r of active) console.log(r);

hdr('3. Idle-in-transaction sessions');
const stuck = await sql`
  SELECT
    pid,
    EXTRACT(EPOCH FROM (NOW() - state_change))::int AS seconds_idle,
    application_name,
    substr(query, 1, 100)                            AS last_query
  FROM pg_stat_activity
  WHERE state LIKE 'idle in transaction%'
    AND pid != pg_backend_pid()
  ORDER BY state_change ASC
  LIMIT 10
`;
console.log(`count=${stuck.length}`);
for (const r of stuck) console.log(r);

hdr('4. Locks held by long waiters');
const blocked = await sql`
  SELECT
    bl.pid                                        AS waiter_pid,
    EXTRACT(EPOCH FROM (NOW() - bl.query_start))::int AS waiter_secs,
    substr(bl.query, 1, 80)                       AS waiter_query,
    kl.pid                                        AS blocker_pid,
    substr(kl.query, 1, 80)                       AS blocker_query
  FROM pg_stat_activity bl
  LEFT JOIN pg_locks bll ON bll.pid = bl.pid AND NOT bll.granted
  LEFT JOIN pg_locks klg ON klg.granted AND klg.locktype = bll.locktype
    AND klg.relation IS NOT DISTINCT FROM bll.relation
    AND klg.transactionid IS NOT DISTINCT FROM bll.transactionid
  LEFT JOIN pg_stat_activity kl ON kl.pid = klg.pid AND kl.pid != bl.pid
  WHERE bll.pid IS NOT NULL
`;
console.log(`count=${blocked.length}`);
for (const r of blocked) console.log(r);

hdr('5. Autovacuum / analyze freshness on hot tables');
const vac = await sql`
  SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 1) AS dead_pct,
    last_vacuum::text       AS last_vacuum,
    last_autovacuum::text   AS last_autovacuum,
    last_analyze::text      AS last_analyze,
    last_autoanalyze::text  AS last_autoanalyze
  FROM pg_stat_user_tables
  WHERE relname IN (
    'gex_strike_0dte',
    'ws_gex_strike_expiry',
    'ws_option_trades',
    'interval_ba_alerts',
    'dark_pool_prints',
    'gex_target_features'
  )
  ORDER BY relname
`;
for (const r of vac) console.log(r);

hdr('6. Hot table sizes');
const sizes = await sql`
  SELECT
    relname,
    pg_size_pretty(pg_total_relation_size(C.oid)) AS total_size,
    pg_size_pretty(pg_relation_size(C.oid))        AS heap_size,
    pg_size_pretty(pg_total_relation_size(C.oid) - pg_relation_size(C.oid)) AS index_size
  FROM pg_class C
  WHERE relname IN (
    'gex_strike_0dte',
    'ws_gex_strike_expiry',
    'ws_option_trades',
    'interval_ba_alerts',
    'dark_pool_prints'
  )
  ORDER BY pg_total_relation_size(C.oid) DESC
`;
for (const r of sizes) console.log(r);

hdr('7. Cache hit ratio (Postgres-level)');
const cache = await sql`
  SELECT
    sum(heap_blks_read) AS heap_read,
    sum(heap_blks_hit)  AS heap_hit,
    ROUND(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_read) + sum(heap_blks_hit), 0), 2) AS hit_ratio_pct
  FROM pg_statio_user_tables
`;
console.log(cache[0]);

hdr('8. Neon-specific: idle compute suspend?');
try {
  const neonInfo = await sql`SHOW neon.compute_id`;
  console.log('compute_id:', neonInfo[0]);
} catch (e) {
  console.log('SHOW neon.compute_id not supported on this version');
}

try {
  const startup = await sql`
    SELECT pg_postmaster_start_time()::text AS started_at,
           EXTRACT(EPOCH FROM (NOW() - pg_postmaster_start_time()))::int AS uptime_seconds
  `;
  console.log('postmaster:', startup[0]);
} catch (e) {
  console.log('uptime probe failed:', e.message);
}

hdr('9. Slowest recent statements (pg_stat_statements)');
try {
  const slow = await sql`
    SELECT
      ROUND(mean_exec_time::numeric, 1)                    AS mean_ms,
      ROUND(max_exec_time::numeric, 1)                     AS max_ms,
      calls,
      substr(query, 1, 120)                                 AS query_head
    FROM pg_stat_statements
    WHERE query NOT LIKE '%pg_stat_%'
      AND query NOT LIKE '%pg_locks%'
      AND mean_exec_time > 50
    ORDER BY mean_exec_time DESC
    LIMIT 10
  `;
  for (const r of slow) console.log(r);
} catch (e) {
  console.log('pg_stat_statements not enabled:', e.message);
}

process.exit(0);
