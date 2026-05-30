import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const J = (x: unknown) => JSON.stringify(x);

(async () => {
  // strike ranges of each source around midday 2026-05-29
  console.log('--- ws_gex SPX strike range at one minute ---');
  console.log(
    J(
      await sql`SELECT min(strike) lo, max(strike) hi, count(*) n,
        min(price) px FROM ws_gex_strike_expiry
        WHERE ticker='SPX' AND ts_minute='2026-05-29T17:00:00Z'`,
    ),
  );
  console.log('--- periscope gamma strike range at ~17:00Z ---');
  console.log(
    J(
      await sql`SELECT min(strike) lo, max(strike) hi, count(*) n
        FROM periscope_snapshots WHERE panel='gamma'
        AND captured_at::date='2026-05-29'
        AND captured_at BETWEEN '2026-05-29T16:55:00Z' AND '2026-05-29T17:05:00Z'`,
    ),
  );
  // ws_gex per-strike net near spot — is the flip clean near 7575?
  console.log('--- ws_gex per-strike net near spot 7575 (17:00Z) ---');
  console.log(
    J(
      await sql`SELECT strike, call_gamma_oi - put_gamma_oi AS net
        FROM ws_gex_strike_expiry
        WHERE ticker='SPX' AND ts_minute='2026-05-29T17:00:00Z'
        AND strike BETWEEN 7500 AND 7650 ORDER BY strike`,
    ),
  );
  // periscope value sum sign and per-strike near spot
  console.log('--- periscope gamma near spot (17:00Z window) ---');
  console.log(
    J(
      await sql`SELECT strike, value FROM periscope_snapshots WHERE panel='gamma'
        AND captured_at BETWEEN '2026-05-29T16:55:00Z' AND '2026-05-29T17:05:00Z'
        AND strike BETWEEN 7500 AND 7650 ORDER BY strike`,
    ),
  );
})();
