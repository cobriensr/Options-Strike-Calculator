/**
 * Dump macro feature tables to CSV for the 4/13 - 5/1 backtest window.
 * Output:
 *   outputs/macro_flow.csv         — flow_data (all sources)
 *   outputs/macro_spot_gex.csv     — spot_exposures (SPX aggregate GEX)
 *   outputs/macro_strike_gex.csv   — strike_exposures (SPX, NDX, SPY, QQQ per-strike)
 *
 * Run: npx tsx docs/tmp/options-flow-analysis/scripts/dump_macro_tables.ts
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { writeFileSync } from 'fs';
import { join } from 'path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const sql = neon(url);

const WINDOW_START = '2026-04-13';
const WINDOW_END = '2026-05-02'; // exclusive end → covers 5/1 fully
const OUT = 'docs/tmp/options-flow-analysis/outputs';

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0] as object);
  const header = cols.join(',');
  const lines = rows.map((r) =>
    cols
      .map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        const s = v instanceof Date ? v.toISOString() : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );
  return [header, ...lines].join('\n');
}

async function main() {
  console.log('Dumping flow_data...');
  const flow = (await sql`
    SELECT date, timestamp, source, ncp, npp, net_volume, otm_ncp, otm_npp
    FROM flow_data
    WHERE date >= ${WINDOW_START}::date AND date < ${WINDOW_END}::date
    ORDER BY source, timestamp
  `) as Array<Record<string, unknown>>;
  writeFileSync(join(OUT, 'macro_flow.csv'), toCsv(flow));
  console.log(`  ${flow.length} rows → outputs/macro_flow.csv`);

  console.log('Dumping spot_exposures (SPX)...');
  const spot = (await sql`
    SELECT date, timestamp, ticker, price,
           gamma_oi, gamma_vol, gamma_dir,
           charm_oi, charm_vol, charm_dir,
           vanna_oi, vanna_vol, vanna_dir
    FROM spot_exposures
    WHERE date >= ${WINDOW_START}::date AND date < ${WINDOW_END}::date
    ORDER BY ticker, timestamp
  `) as Array<Record<string, unknown>>;
  writeFileSync(join(OUT, 'macro_spot_gex.csv'), toCsv(spot));
  console.log(`  ${spot.length} rows → outputs/macro_spot_gex.csv`);

  console.log('Dumping strike_exposures (SPX, NDX, SPY, QQQ)...');
  // Chunk by ticker AND date to stay under Neon's 64MB response limit.
  // For ETF-style alerts (SPY/QQQ) we get the full per-strike GEX; for SPX
  // we keep ±3% ATM band to fit (alerts on SPX 0DTE are typically ATM).
  const tickerBands: Array<[string, number]> = [
    ['NDX', 0.05],
    ['QQQ', 0.05],
    ['SPY', 0.05],
    ['SPX', 0.03],
  ];
  const dates: string[] = [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17',
    '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24',
    '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30', '2026-05-01',
  ];
  const allStk: Array<Record<string, unknown>> = [];
  for (const [ticker, band] of tickerBands) {
    let tcount = 0;
    for (const d of dates) {
      const chunk = (await sql`
        SELECT date, timestamp, ticker, expiry, strike, price,
               call_gamma_oi, put_gamma_oi,
               call_gamma_ask, call_gamma_bid,
               put_gamma_ask, put_gamma_bid,
               call_charm_oi, put_charm_oi,
               call_delta_oi, put_delta_oi,
               call_vanna_oi, put_vanna_oi
        FROM strike_exposures
        WHERE date = ${d}::date
          AND ticker = ${ticker}
          AND price > 0
          AND ABS(strike / price - 1) <= ${band}
        ORDER BY expiry, strike, timestamp
      `) as Array<Record<string, unknown>>;
      tcount += chunk.length;
      allStk.push(...chunk);
    }
    console.log(`    ${ticker} (band ${band}): ${tcount} rows`);
  }
  writeFileSync(join(OUT, 'macro_strike_gex.csv'), toCsv(allStk));
  console.log(`  ${allStk.length} rows total → outputs/macro_strike_gex.csv`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
