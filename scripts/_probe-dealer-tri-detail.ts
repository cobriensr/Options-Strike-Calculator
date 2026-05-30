import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const J = (x: unknown) => JSON.stringify(x);

(async () => {
  // GexBot scalars history on LF fires
  console.log(
    '--- LF fires: gex_zero_gamma history (the real GexBot history) ---',
  );
  console.log(
    J(
      await sql`SELECT min(date) lo, max(date) hi, count(*) total,
        count(gex_zero_gamma) zg, count(gex_net_put_dex) npd, count(gex_spot) spot,
        count(distinct date) FILTER (WHERE gex_zero_gamma IS NOT NULL) zg_days
        FROM lottery_finder_fires`,
    ),
  );
  console.log('sample SPX/SPY/QQQ fires with gex scalars:');
  console.log(
    J(
      await sql`SELECT underlying_symbol, count(*) n, count(gex_zero_gamma) zg
        FROM lottery_finder_fires WHERE gex_zero_gamma IS NOT NULL
        GROUP BY underlying_symbol ORDER BY n DESC LIMIT 10`,
    ),
  );

  // periscope value semantics & expiry
  console.log('\n--- periscope gamma value sample (one snapshot) ---');
  console.log(
    J(
      await sql`SELECT captured_at, expiry, strike, value FROM periscope_snapshots
        WHERE panel='gamma' AND captured_at = (
          SELECT max(captured_at) FROM periscope_snapshots WHERE panel='gamma')
        ORDER BY strike LIMIT 40`,
    ),
  );
  console.log(
    '\nperiscope: how many distinct expiries per captured_at (0DTE check)?',
  );
  console.log(
    J(
      await sql`SELECT captured_at::date d, count(distinct expiry) exps, count(distinct captured_at) snaps
        FROM periscope_snapshots WHERE panel='gamma'
        GROUP BY d ORDER BY d DESC LIMIT 8`,
    ),
  );
  console.log('\nperiscope: is expiry == captured date (0DTE)? recent rows');
  console.log(
    J(
      await sql`SELECT captured_at::date cap_d, expiry, count(*) n FROM periscope_snapshots
        WHERE panel='gamma' AND captured_at >= '2026-05-20'
        GROUP BY cap_d, expiry ORDER BY cap_d DESC, n DESC LIMIT 20`,
    ),
  );

  // ws_gex SPX net gamma sign sample
  console.log(
    '\n--- ws_gex SPX: net gamma sign over the day (sum across strikes per minute) ---',
  );
  console.log(
    J(
      await sql`SELECT ts_minute,
        sum(call_gamma_oi) - sum(put_gamma_oi) AS net_g, count(*) strikes
        FROM ws_gex_strike_expiry WHERE ticker='SPX'
        GROUP BY ts_minute ORDER BY ts_minute LIMIT 5`,
    ),
  );
})();
