/**
 * Probe: is the GEXBot capture pipeline actually recording data?
 *
 * Verifies, against the live Neon DB:
 *   1. Freshness   — latest captured_at per table + age in minutes
 *   2. Volume      — total rows + rows in the last 24h per table
 *   3. Coverage    — distinct tickers and (endpoint, category) combos seen
 *                    today; resolves the 112-vs-192 calls/min question by
 *                    showing which categories ACTUALLY land in api_capture
 *   4. Quality     — NULL rate on key scalar columns in gexbot_snapshots
 *   5. Size        — pg_total_relation_size per table (real, not estimated)
 *   6. Context fills — #180/#181 gex_* column hit-rate on the two alert tables
 *
 * Read-only. Run: npx tsx scripts/_probe-gexbot-capture-2026-05-29.ts
 */
import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL!);
type Row = Record<string, unknown>;

const GEXBOT_TICKERS = [
  'SPX',
  'ES_SPX',
  'NDX',
  'NQ_NDX',
  'RUT',
  'VIX',
  'SPY',
  'QQQ',
  'IWM',
  'TLT',
  'GLD',
  'USO',
  'TQQQ',
  'UVXY',
  'HYG',
  'SLV',
];

async function freshness(table: string, tsCol = 'captured_at') {
  const r = (await sql.query(
    `SELECT
       COUNT(*)::bigint                                          AS total,
       COUNT(*) FILTER (WHERE ${tsCol} > NOW() - INTERVAL '24 hours')::bigint AS last_24h,
       MAX(${tsCol})                                            AS latest,
       ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(${tsCol}))) / 60.0, 1) AS age_min
     FROM ${table}`,
  )) as Row[];
  const x = r[0];
  console.log(`\n── ${table}`);
  console.log(`   total rows : ${x.total}`);
  console.log(`   last 24h   : ${x.last_24h}`);
  console.log(`   latest     : ${x.latest ?? '(none)'}`);
  console.log(`   age (min)  : ${x.age_min ?? 'n/a'}`);
}

async function snapshotCoverage() {
  console.log('\n══ gexbot_snapshots — per-ticker coverage (last 24h) ══');
  const r = (await sql`
    SELECT ticker, COUNT(*)::bigint AS rows,
           MAX(captured_at) AS latest,
           ROUND(100.0 * COUNT(*) FILTER (WHERE spot IS NULL) / COUNT(*), 1) AS spot_null_pct,
           ROUND(100.0 * COUNT(*) FILTER (WHERE zero_gamma IS NULL) / COUNT(*), 1) AS zg_null_pct,
           ROUND(100.0 * COUNT(*) FILTER (WHERE zcvr IS NULL) / COUNT(*), 1) AS zcvr_null_pct
    FROM gexbot_snapshots
    WHERE captured_at > NOW() - INTERVAL '24 hours'
    GROUP BY ticker
    ORDER BY ticker
  `) as Row[];
  const seen = new Set(r.map((x) => String(x.ticker)));
  for (const x of r) {
    console.log(
      `   ${String(x.ticker).padEnd(7)} rows=${String(x.rows).padStart(4)} ` +
        `spotNull=${x.spot_null_pct}% zgNull=${x.zg_null_pct}% zcvrNull=${x.zcvr_null_pct}%`,
    );
  }
  const missing = GEXBOT_TICKERS.filter((t) => !seen.has(t));
  console.log(
    missing.length
      ? `   ⚠ MISSING tickers (no rows in 24h): ${missing.join(', ')}`
      : `   ✓ all 16 tickers present`,
  );
}

async function captureCoverage() {
  console.log(
    '\n══ gexbot_api_capture — (endpoint, category) breakdown (last 24h) ══',
  );
  const r = (await sql`
    SELECT endpoint, category,
           COUNT(*)::bigint AS rows,
           COUNT(DISTINCT ticker)::bigint AS tickers,
           MAX(captured_at) AS latest
    FROM gexbot_api_capture
    WHERE captured_at > NOW() - INTERVAL '24 hours'
    GROUP BY endpoint, category
    ORDER BY endpoint, category
  `) as Row[];
  for (const x of r) {
    console.log(
      `   ${String(x.endpoint).padEnd(8)} ${String(x.category).padEnd(20)} ` +
        `rows=${String(x.rows).padStart(5)} tickers=${x.tickers}`,
    );
  }
  console.log(`   → ${r.length} distinct (endpoint, category) combos seen`);
}

async function tableSizes() {
  console.log(
    '\n══ on-disk size (pg_total_relation_size — real, not estimated) ══',
  );
  const r = (await sql`
    SELECT relname AS table,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
           pg_size_pretty(pg_relation_size(c.oid))       AS heap_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND relname IN ('gexbot_snapshots', 'gexbot_api_capture', 'gexbot_archive_audit')
    ORDER BY pg_total_relation_size(c.oid) DESC
  `) as Row[];
  for (const x of r) {
    console.log(
      `   ${String(x.table).padEnd(22)} total=${x.total_size} (heap=${x.heap_size})`,
    );
  }
}

async function contextFills() {
  console.log(
    '\n══ #180/#181 gex_* context fill-rate on alert tables (last 24h) ══',
  );
  // Each table uses its own event-time column — no shared created_at.
  const tables: Array<[string, string]> = [
    ['silent_boom_alerts', 'inserted_at'],
    ['lottery_finder_fires', 'trigger_time_ct'],
  ];
  for (const [t, tsCol] of tables) {
    try {
      const r = (await sql.query(
        `SELECT COUNT(*)::bigint AS fires,
                COUNT(gex_spot)::bigint AS with_gex,
                ROUND(100.0 * COUNT(gex_spot) / NULLIF(COUNT(*), 0), 1) AS fill_pct
         FROM ${t}
         WHERE ${tsCol} > NOW() - INTERVAL '24 hours'`,
      )) as Row[];
      const x = r[0];
      console.log(
        `   ${t.padEnd(22)} fires=${x.fires} withGex=${x.with_gex} fill=${x.fill_pct ?? 'n/a'}%`,
      );
    } catch (e) {
      console.log(`   ${t.padEnd(22)} ERR ${(e as Error).message}`);
    }
  }
}

(async () => {
  console.log('GEXBot capture probe —', new Date().toISOString());
  const tsByTable: Array<[string, string]> = [
    ['gexbot_snapshots', 'captured_at'],
    ['gexbot_api_capture', 'captured_at'],
    ['gexbot_archive_audit', 'archived_at'],
  ];
  for (const [t, tsCol] of tsByTable) {
    try {
      await freshness(t, tsCol);
    } catch (e) {
      console.log(`\n── ${t}: ERR ${(e as Error).message}`);
    }
  }
  await snapshotCoverage();
  await captureCoverage();
  await tableSizes();
  await contextFills();
  console.log('\ndone.');
})();
