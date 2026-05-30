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
  await safe('zero_gamma_levels', async () => {
    const r = (await sql`SELECT count(*) n, min(ts) ts0, max(ts) ts1,
      count(DISTINCT (ts AT TIME ZONE 'America/New_York')::date) ndays,
      count(*) FILTER (WHERE zero_gamma IS NOT NULL) nzg, count(DISTINCT ticker) ntk
      FROM zero_gamma_levels`) as Row[];
    return r[0];
  });
  await safe('gex_strike_0dte', async () => {
    const r =
      (await sql`SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays FROM gex_strike_0dte`) as Row[];
    const pd =
      (await sql`SELECT date d, count(*) n, count(DISTINCT timestamp) nts FROM gex_strike_0dte GROUP BY 1 ORDER BY 1 DESC LIMIT 5`) as Row[];
    return { summary: r[0], recent: pd };
  });
  await safe('market_internals', async () => {
    const r = (await sql`SELECT symbol, count(*) n, min(ts) ts0, max(ts) ts1,
      count(DISTINCT (ts AT TIME ZONE 'America/New_York')::date) ndays FROM market_internals GROUP BY 1`) as Row[];
    return r;
  });
  await safe('etf_candles_1m', async () => {
    const r = (await sql`SELECT count(*) n FROM etf_candles_1m`) as Row[];
    const cols =
      (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='etf_candles_1m' ORDER BY ordinal_position`) as Row[];
    return { n: r[0], cols: cols.map((c) => c.column_name) };
  });
  await safe('market_snapshots cols', async () => {
    const cols =
      (await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='market_snapshots' ORDER BY ordinal_position`) as Row[];
    return cols;
  });
  await safe('lottery_finder_fires gex_ coverage', async () => {
    const r =
      (await sql`SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays,
      count(*) FILTER (WHERE gex_captured_at IS NOT NULL) ngex,
      count(*) FILTER (WHERE gex_zero_gamma IS NOT NULL) nzg,
      count(*) FILTER (WHERE gex_net_put_dex IS NOT NULL) ndex
      FROM lottery_finder_fires`) as Row[];
    return r[0];
  });
  await safe('silent_boom_alerts gex_ coverage', async () => {
    const r =
      (await sql`SELECT count(*) n, min(date) d0, max(date) d1, count(DISTINCT date) ndays,
      count(*) FILTER (WHERE gex_captured_at IS NOT NULL) ngex
      FROM silent_boom_alerts`) as Row[];
    return r[0];
  });
  await safe('gexbot zero_gamma null-by-ticker', async () => {
    const r =
      (await sql`SELECT ticker, count(*) n, count(*) FILTER (WHERE zero_gamma IS NOT NULL) nzg,
      count(*) FILTER (WHERE one_net_put_dex IS NOT NULL) ndex FROM gexbot_snapshots GROUP BY 1 ORDER BY 1`) as Row[];
    return r;
  });
  await safe('futures_snapshots', async () => {
    const r = (await sql`SELECT count(*) n FROM futures_snapshots`) as Row[];
    const cols =
      (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='futures_snapshots' ORDER BY ordinal_position`) as Row[];
    return { n: r[0], cols: cols.map((c) => c.column_name) };
  });
})();
