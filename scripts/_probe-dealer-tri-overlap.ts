import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);
const J = (x: unknown) => JSON.stringify(x);

(async () => {
  // gexbot_snapshots SPX: what scalars are non-null, and z_mlgamma/z_msgamma range
  console.log('--- gexbot_snapshots SPX non-null scalar coverage ---');
  console.log(
    J(
      await sql`SELECT count(*) n,
        count(spot) spot, count(zero_gamma) zg, count(net_dex) net_dex,
        count(z_mlgamma) zml, count(z_msgamma) zms, count(sum_gex_oi) sgo,
        count(major_pos_oi) mpo, count(major_neg_oi) mno,
        min(captured_at) lo, max(captured_at) hi
        FROM gexbot_snapshots WHERE ticker='SPX'`,
    ),
  );
  console.log(
    '\ngexbot SPX z_mlgamma vs z_msgamma vs spot (do they straddle spot?)',
  );
  console.log(
    J(
      await sql`SELECT captured_at, spot, z_mlgamma, z_msgamma, net_dex, net_put_dex
        FROM gexbot_snapshots WHERE ticker='SPX'
        AND captured_at::date='2026-05-29'
        ORDER BY captured_at LIMIT 4`,
    ),
  );
  // Does ES_SPX have zero_gamma where SPX doesn't?
  console.log('\n--- gexbot ES_SPX zero_gamma / spot coverage ---');
  console.log(
    J(
      await sql`SELECT count(*) n, count(zero_gamma) zg, count(spot) spot,
        count(z_mlgamma) zml FROM gexbot_snapshots WHERE ticker='ES_SPX'`,
    ),
  );
  console.log(
    J(
      await sql`SELECT captured_at, spot, zero_gamma, z_mlgamma, z_msgamma, net_dex
        FROM gexbot_snapshots WHERE ticker='ES_SPX' AND captured_at::date='2026-05-29'
        ORDER BY captured_at LIMIT 3`,
    ),
  );

  // The triple-overlap day: which dates have all three for SPX?
  console.log('\n--- per-date presence of each source (SPX) ---');
  const wsDays =
    await sql`SELECT DISTINCT ts_minute::date d FROM ws_gex_strike_expiry WHERE ticker='SPX'`;
  const periDays =
    await sql`SELECT DISTINCT captured_at::date d FROM periscope_snapshots WHERE panel='gamma'`;
  const gbDays =
    await sql`SELECT DISTINCT captured_at::date d FROM gexbot_snapshots WHERE ticker='SPX' AND net_dex IS NOT NULL`;
  console.log(
    'ws_gex SPX days:',
    J(
      (wsDays as Record<string, unknown>[]).map((r) =>
        String(r.d).slice(0, 10),
      ),
    ),
  );
  console.log(
    'gexbot SPX days:',
    J(
      (gbDays as Record<string, unknown>[]).map((r) =>
        String(r.d).slice(0, 10),
      ),
    ),
  );
  console.log('periscope days (count):', (periDays as unknown[]).length);
  console.log(
    'periscope first/last:',
    J([
      String(
        (periDays as Record<string, unknown>[])
          .map((r) => String(r.d))
          .sort()[0],
      ),
      String(
        (periDays as Record<string, unknown>[])
          .map((r) => String(r.d))
          .sort()
          .at(-1),
      ),
    ]),
  );

  // index_candles_1m SPX minute timezone check
  console.log('\n--- index_candles_1m SPX sample around midday 2026-05-29 ---');
  console.log(
    J(
      await sql`SELECT timestamp, market_time, close, spx_schwab_price FROM index_candles_1m
        WHERE symbol='SPX' AND date='2026-05-29' ORDER BY timestamp LIMIT 3`,
    ),
  );
})();
