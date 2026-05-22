#!/usr/bin/env node
// Cross-check: enumerate ALL AMZN Silent Boom + Lottery Finder fires on
// 2026-05-21 so we can tell whether the 265C 5/27 audit covers the full
// story, or whether other contracts (e.g. 255P) fired earlier.

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL);

const sb = await sql`
  SELECT option_chain_id, strike, option_type, expiry,
         bucket_ct, entry_price, spike_volume, ask_pct, vol_oi
  FROM silent_boom_alerts
  WHERE underlying_symbol = 'AMZN' AND date = '2026-05-21'
  ORDER BY bucket_ct ASC
`;
console.log(`\nSilent Boom AMZN fires 2026-05-21: ${sb.length}`);
for (const r of sb) {
  console.log(
    ` ${r.option_chain_id} ${r.strike}${r.option_type} ${r.expiry}` +
      ` @ ${new Date(r.bucket_ct).toISOString()}` +
      ` size=${r.spike_volume} ask=${(Number(r.ask_pct) * 100).toFixed(0)}%` +
      ` volOi=${(Number(r.vol_oi) * 100).toFixed(0)}% entry=$${r.entry_price}`,
  );
}

const lf = await sql`
  SELECT option_chain_id, strike, option_type, expiry,
         trigger_time_ct, entry_price, alert_seq
  FROM lottery_finder_fires
  WHERE underlying_symbol = 'AMZN' AND date = '2026-05-21'
  ORDER BY trigger_time_ct ASC
`;
console.log(`\nLottery Finder AMZN fires 2026-05-21: ${lf.length}`);
for (const r of lf) {
  console.log(
    ` ${r.option_chain_id} ${r.strike}${r.option_type} ${r.expiry}` +
      ` @ ${new Date(r.trigger_time_ct).toISOString()}` +
      ` seq=${r.alert_seq} entry=$${r.entry_price}`,
  );
}
