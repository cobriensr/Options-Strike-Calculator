import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({
  path: '/Users/charlesobrien/Documents/Workspace/strike-calculator/.env.local',
});
const sql = neon(process.env.DATABASE_URL);

for (const ticker of ['SPY', 'QQQ', 'SPX', 'NDX']) {
  const ts = await sql`
    SELECT DISTINCT ts_minute FROM ws_gex_strike_expiry
    WHERE ticker = ${ticker} AND expiry = '2026-05-01'::date
    ORDER BY ts_minute
  `;
  console.log(`${ticker} ws timestamps for 2026-05-01:`, ts.length, 'distinct');
  if (ts.length <= 5)
    console.log(
      '  →',
      ts.map((r) => r.ts_minute),
    );
}

// Legacy table SPX-only
const restTs = await sql`
  SELECT DISTINCT timestamp FROM gex_strike_0dte
  WHERE date = '2026-05-01'::date
  ORDER BY timestamp
`;
console.log(
  `\nlegacy gex_strike_0dte timestamps for 2026-05-01:`,
  restTs.length,
  'distinct',
);
if (restTs.length <= 5)
  console.log(
    '  →',
    restTs.map((r) => r.timestamp),
  );
else
  console.log(
    '  → first/last:',
    restTs[0].timestamp,
    '...',
    restTs.at(-1).timestamp,
  );
