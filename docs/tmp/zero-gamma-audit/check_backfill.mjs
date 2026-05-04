import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

console.log('=== SPY 2026-05-01 — 5 OTM call + 5 OTM put around spot ===');
const rows = await sql`
  SELECT strike::numeric AS strike, price::numeric AS spot,
         call_gamma_oi::numeric + put_gamma_oi::numeric AS net_gamma,
         (call_gamma_ask_vol::numeric - call_gamma_bid_vol::numeric)
           - (put_gamma_ask_vol::numeric - put_gamma_bid_vol::numeric) AS cust_flow,
         ts_minute
  FROM ws_gex_strike_expiry
  WHERE ticker = 'SPY' AND expiry = '2026-05-01'::date
  ORDER BY strike ASC
`;
console.log(`rows: ${rows.length}`);
const spot = Number(rows[0]?.spot);
console.log(`spot: ${spot}`);
const otmCalls = rows.filter((r) => Number(r.strike) > spot).slice(0, 5);
const otmPuts = rows.filter((r) => Number(r.strike) < spot).slice(-5);
console.log('\nOTM puts (5 nearest):');
for (const r of otmPuts) {
  console.log(
    `  K=${Number(r.strike).toFixed(0)}  netγ=${Number(r.net_gamma).toExponential(2)}  custFlow=${Number(r.cust_flow).toExponential(2)}`,
  );
}
console.log('OTM calls (5 nearest):');
for (const r of otmCalls) {
  console.log(
    `  K=${Number(r.strike).toFixed(0)}  netγ=${Number(r.net_gamma).toExponential(2)}  custFlow=${Number(r.cust_flow).toExponential(2)}`,
  );
}
