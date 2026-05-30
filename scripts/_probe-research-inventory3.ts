import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
type Row = Record<string, unknown>;
const j = (x: unknown) => JSON.stringify(x);
async function safe(label: string, fn: () => Promise<unknown>) {
  try {
    console.log(`\n=== ${label} ===`);
    console.log(j(await fn()));
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${(e as Error).message}`);
  }
}
(async () => {
  await safe('market_snapshots daily SPX OHLC coverage', async () => {
    const r =
      (await sql`SELECT count(*) n, count(DISTINCT date) ndays, min(date) d0, max(date) d1,
      count(*) FILTER (WHERE spx_high IS NOT NULL) nohlc,
      count(*) FILTER (WHERE vix IS NOT NULL) nvix,
      count(*) FILTER (WHERE vix9d IS NOT NULL) nvix9d
      FROM market_snapshots`) as Row[];
    return r[0];
  });
  // rows per day in market_snapshots (it's intraday entry_time snapshots, not 1/day)
  await safe('market_snapshots rows-per-day sample', async () => {
    const r =
      (await sql`SELECT date d, count(*) n, count(DISTINCT entry_time) net FROM market_snapshots GROUP BY 1 ORDER BY 1 DESC LIMIT 5`) as Row[];
    return r;
  });
  // gexbot archive audit: what was archived (history exists in Blob, not live DB)
  await safe('gexbot_archive_audit', async () => {
    const r =
      (await sql`SELECT table_name, min(archive_date) d0, max(archive_date) d1, count(*) n FROM gexbot_archive_audit GROUP BY 1`) as Row[];
    return r;
  });
  // confirm lottery_finder_fires trigger_time_ct type + tz
  await safe('lottery_finder_fires key col types', async () => {
    const r =
      (await sql`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='lottery_finder_fires' AND column_name IN ('date','trigger_time_ct','gex_captured_at')`) as Row[];
    return r;
  });
  // index_candles_1m timestamp type
  await safe('index_candles_1m + spot_exposures col types', async () => {
    const r =
      (await sql`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE (table_name='index_candles_1m' AND column_name IN ('date','timestamp'))
         OR (table_name='spot_exposures' AND column_name IN ('date','timestamp'))
         OR (table_name='gexbot_snapshots' AND column_name IN ('captured_at','source_timestamp'))
      ORDER BY table_name, column_name`) as Row[];
    return r;
  });
})();
