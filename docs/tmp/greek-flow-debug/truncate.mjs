/**
 * One-off: TRUNCATE vega_flow_etf because all stored values were the
 * preliminary live-day reads from UW; UW restates per-minute aggregates
 * post-hoc and the cron's ON CONFLICT DO NOTHING never picked up the
 * reconciled values. After truncating, the new UPSERT cron + reconcile
 * cron + backfill script will repopulate with current UW values.
 *
 * Run from repo root: node docs/tmp/greek-flow-debug/truncate.mjs
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing — pull .env.local with `vercel env pull .env.local`');
  process.exit(1);
}
const sql = neon(url);

const before = await sql`SELECT COUNT(*)::int AS n FROM vega_flow_etf`;
console.log(`Before: ${before[0]?.n ?? 0} rows`);

await sql`TRUNCATE vega_flow_etf`;

const after = await sql`SELECT COUNT(*)::int AS n FROM vega_flow_etf`;
console.log(`After:  ${after[0]?.n ?? 0} rows`);
