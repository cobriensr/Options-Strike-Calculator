import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const J = (x: unknown) => JSON.stringify(x);

(async () => {
  console.log('--- gexbot_snapshots: tickers + date range + sample sign ---');
  console.log(
    J(
      await sql`SELECT ticker, count(*) n, min(captured_at) lo, max(captured_at) hi,
        count(zero_gamma) zg, count(net_dex) nd
        FROM gexbot_snapshots GROUP BY ticker ORDER BY n DESC`,
    ),
  );
  console.log('\nsample gexbot row (SPX):');
  console.log(
    J(
      await sql`SELECT captured_at, ticker, spot, zero_gamma, net_dex, net_put_dex,
        z_mlgamma, z_msgamma, sum_gex_oi, min_dte
        FROM gexbot_snapshots WHERE ticker ILIKE 'SPX%' ORDER BY captured_at DESC LIMIT 3`,
    ),
  );

  console.log('\n--- ws_gex_strike_expiry: tickers + range ---');
  console.log(
    J(
      await sql`SELECT ticker, count(*) n, count(distinct ts_minute::date) days,
        min(ts_minute) lo, max(ts_minute) hi, count(distinct expiry) expiries
        FROM ws_gex_strike_expiry GROUP BY ticker ORDER BY n DESC`,
    ),
  );

  console.log('\n--- periscope_snapshots: panels + timeframe + range ---');
  console.log(
    J(
      await sql`SELECT panel, timeframe, count(*) n, count(distinct captured_at) snaps,
        min(captured_at) lo, max(captured_at) hi, count(distinct expiry) expiries
        FROM periscope_snapshots GROUP BY panel, timeframe ORDER BY n DESC`,
    ),
  );

  console.log('\n--- index_candles_1m: symbols + range ---');
  console.log(
    J(
      await sql`SELECT symbol, count(*) n, min(date) lo, max(date) hi
        FROM index_candles_1m GROUP BY symbol ORDER BY n DESC`,
    ),
  );
})();
