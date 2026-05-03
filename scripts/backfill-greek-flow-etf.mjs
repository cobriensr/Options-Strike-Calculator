#!/usr/bin/env node

/**
 * Local backfill script for ETF Greek (delta/vega) flow on SPY and QQQ.
 * Fetches from the all-expiries Greek Flow endpoint per ticker per day,
 * UPSERTING into vega_flow_etf so already-stored preliminary values get
 * overwritten with UW's current (post-reconciliation) numbers.
 *
 * Why UPSERT: UW restates per-minute aggregates as late prints and
 * cancellations resolve. The original ON CONFLICT DO NOTHING strategy
 * left preliminary live-day values frozen in place even after UW
 * finalized them — diverging by 5–40× on the May 2026 sessions before
 * we caught it.
 *
 * Usage:
 *   # Last N trading days (default 30):
 *   UW_API_KEY=... DATABASE_URL=... node scripts/backfill-greek-flow-etf.mjs
 *   node scripts/backfill-greek-flow-etf.mjs 5
 *
 *   # Explicit dates (any number, in any order):
 *   node scripts/backfill-greek-flow-etf.mjs 2026-05-01
 *   node scripts/backfill-greek-flow-etf.mjs 2026-04-29 2026-04-30 2026-05-01
 */

import { neon } from '@neondatabase/serverless';

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';
const TICKERS = ['SPY', 'QQQ'];

// Args may be either a single integer (= last N trading days) or a list
// of explicit YYYY-MM-DD dates.
const args = process.argv.slice(2);
const explicitDates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const days = explicitDates.length === 0
  ? Number.parseInt(args[0] ?? '30', 10)
  : 0;

// ── Generate last N trading days ────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Compute the calendar date AND day-of-week in US/Eastern (the market
 * timezone) so the two are internally consistent. The naive impl using
 * d.toISOString() + d.getDay() drifts by 1 day after ~7 PM CT because
 * toISOString() returns UTC while getDay() returns local — so a Friday
 * evening run produces date strings labeled Saturday and shifts the
 * whole window. Use ET for both halves.
 */
function getETDayInfo(d) {
  const date = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const weekday = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
  return { date, weekdayIdx: WEEKDAY_NAMES.indexOf(weekday) };
}

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

  while (dates.length < count) {
    const { date, weekdayIdx } = getETDayInfo(d);
    if (weekdayIdx !== 0 && weekdayIdx !== 6) {
      dates.push(date);
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return dates.reverse();
}

// ── Fetch Greek flow for one (ticker, date) ─────────────────

async function fetchGreekFlow(ticker, date) {
  const res = await fetch(
    `${UW_BASE}/stock/${ticker}/greek-flow?date=${date}`,
    { headers: { Authorization: `Bearer ${UW_API_KEY}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for ${ticker} ${date}: ${text.slice(0, 100)}`,
    );
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store every minute bar (no downsampling) ────────────────

async function storeTicks(ticks, ticker, date) {
  if (ticks.length === 0)
    return { inserted: 0, updated: 0, total: 0 };

  let inserted = 0;
  let updated = 0;

  for (const tick of ticks) {
    try {
      const result = await sql`
        INSERT INTO vega_flow_etf (
          ticker, date, timestamp,
          dir_vega_flow, otm_dir_vega_flow,
          total_vega_flow, otm_total_vega_flow,
          dir_delta_flow, otm_dir_delta_flow,
          total_delta_flow, otm_total_delta_flow,
          transactions, volume
        )
        VALUES (
          ${ticker}, ${date}, ${tick.timestamp},
          ${tick.dir_vega_flow}, ${tick.otm_dir_vega_flow},
          ${tick.total_vega_flow}, ${tick.otm_total_vega_flow},
          ${tick.dir_delta_flow}, ${tick.otm_dir_delta_flow},
          ${tick.total_delta_flow}, ${tick.otm_total_delta_flow},
          ${tick.transactions}, ${tick.volume}
        )
        ON CONFLICT (ticker, timestamp) DO UPDATE SET
          dir_vega_flow        = EXCLUDED.dir_vega_flow,
          otm_dir_vega_flow    = EXCLUDED.otm_dir_vega_flow,
          total_vega_flow      = EXCLUDED.total_vega_flow,
          otm_total_vega_flow  = EXCLUDED.otm_total_vega_flow,
          dir_delta_flow       = EXCLUDED.dir_delta_flow,
          otm_dir_delta_flow   = EXCLUDED.otm_dir_delta_flow,
          total_delta_flow     = EXCLUDED.total_delta_flow,
          otm_total_delta_flow = EXCLUDED.otm_total_delta_flow,
          transactions         = EXCLUDED.transactions,
          volume               = EXCLUDED.volume
        RETURNING (xmax = 0) AS was_insert
      `;
      if (result[0]?.was_insert) inserted++;
      else updated++;
    } catch (err) {
      console.warn(`  Upsert error: ${err.message}`);
    }
  }

  return { inserted, updated, total: ticks.length };
}

// ── Format for display ──────────────────────────────────────

function fmt(val) {
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

// ── Compute max |dir_vega_flow| across ticks ────────────────

function maxAbsDirVega(ticks) {
  let maxAbs = 0;
  let maxSigned = 0;
  for (const tick of ticks) {
    const v = Number.parseFloat(tick.dir_vega_flow);
    if (Number.isNaN(v)) continue;
    const abs = Math.abs(v);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxSigned = v;
    }
  }
  return maxSigned;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays =
    explicitDates.length > 0 ? explicitDates.slice().sort() : getTradingDays(days);

  console.log(
    `Backfilling ETF Greek Flow (SPY, QQQ — full 1-min resolution, UPSERT)`,
  );
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})`,
  );
  console.log(`Tickers: ${TICKERS.join(', ')}\n`);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalBars = 0;

  for (const date of tradingDays) {
    for (const ticker of TICKERS) {
      await new Promise((r) => setTimeout(r, 300));

      const ticks = await fetchGreekFlow(ticker, date);
      const result = await storeTicks(ticks, ticker, date);

      totalInserted += result.inserted;
      totalUpdated += result.updated;
      totalBars += result.total;

      const dvMax = ticks.length > 0 ? fmt(maxAbsDirVega(ticks)) : 'N/A';

      console.log(
        `  ${date} ${ticker}: ${result.total} ticks (${result.inserted} new, ${result.updated} updated) | dir_vega max: ${dvMax}`,
      );
    }
  }

  console.log(`\nDone!`);
  console.log(`  Days × tickers: ${tradingDays.length} × ${TICKERS.length}`);
  console.log(`  Total bars seen: ${totalBars}`);
  console.log(`  Inserted: ${totalInserted}`);
  console.log(`  Updated:  ${totalUpdated}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
