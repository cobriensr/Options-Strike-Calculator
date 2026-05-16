#!/usr/bin/env node
/**
 * Backfill ws_gex_strike_expiry from UW REST historical endpoint.
 *
 * The live data source is the UW WebSocket channel
 * `gex_strike_expiry:<TICKER>` (handled by the uw-stream daemon). For
 * historical dates that predate the daemon, the REST endpoint
 * `/stock/{ticker}/spot-exposures/expiry-strike?date=…&expirations[]=…`
 * returns the equivalent end-of-day snapshot. Available since 2025-01-16
 * per the UW spec.
 *
 * Field name mapping: REST emits `call_gamma_ask` (no suffix); the WS
 * channel and our table use `call_gamma_ask_vol`. Same data — UW just
 * names them differently across endpoints. This script does the rename.
 *
 * For each (ticker, date), calls UW once with `expirations[]={date}` to
 * pin to that day's 0DTE expiry, then UPSERTs every returned strike
 * into ws_gex_strike_expiry. The endpoint returns the *latest* snapshot
 * for the requested date — for past dates that's the EOD value; for
 * today during market hours it's "now."
 *
 * Usage:
 *   # Last N trading days back from today (default 30):
 *   UW_API_KEY=… DATABASE_URL=… node scripts/backfill-gex-strike-expiry.mjs
 *   node scripts/backfill-gex-strike-expiry.mjs 90
 *
 *   # Explicit dates:
 *   node scripts/backfill-gex-strike-expiry.mjs 2026-05-01
 *   node scripts/backfill-gex-strike-expiry.mjs 2026-04-29 2026-04-30 2026-05-01
 *
 *   # Subset of tickers:
 *   TICKERS=SPY node scripts/backfill-gex-strike-expiry.mjs 60
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
const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ')
  .split(',')
  .map((s) => s.trim());

// Footgun guard — the GEX Landscape's WS reader aliases SPX → SPXW
// (api/_lib/db-gex-strike-expiry.ts::resolveStoredTicker) because
// uw-stream subscribes to gex_strike_expiry:SPXW, not :SPX. Running
// this script with TICKERS=SPX would write SPX-labeled rows that the
// panel can no longer read. Use TICKERS=SPXW for SPX 0DTE backfills.
if (TICKERS.includes('SPX')) {
  console.error(
    'ERROR: TICKERS=SPX is a footgun for the GEX Landscape — the WS reader\n' +
      'aliases SPX → SPXW (see resolveStoredTicker). Use TICKERS=SPXW so the\n' +
      'rows you backfill are visible to the panel.',
  );
  process.exit(1);
}

// Args may be either a single integer (= last N trading days) or a list
// of explicit YYYY-MM-DD dates.
const args = process.argv.slice(2);
const explicitDates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const days =
  explicitDates.length === 0 ? Number.parseInt(args[0] ?? '30', 10) : 0;

// ── Generate trading-day list ───────────────────────────────

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// ── Fetch ─────────────────────────────────────────────────

async function fetchExpiryStrike(ticker, date) {
  // expirations[] = date pins to that day's 0DTE expiry. limit=500 is
  // the endpoint's max; SPY/QQQ have ~80 strikes per expiry so this is
  // ample.
  const url = `${UW_BASE}/stock/${ticker}/spot-exposures/expiry-strike?expirations[]=${date}&date=${date}&limit=500`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(
      `  UW ${res.status} for ${ticker} ${date}: ${body.slice(0, 200)}`,
    );
    return [];
  }
  const json = await res.json();
  return json.data ?? [];
}

// ── UPSERT ─────────────────────────────────────────────────

/**
 * Map the REST row shape to ws_gex_strike_expiry columns.
 *
 * REST: call_gamma_ask, call_gamma_bid (no _vol suffix).
 * Table: call_gamma_ask_vol, call_gamma_bid_vol.
 *
 * `time` (REST) → ts_minute (table, truncated to whole minute).
 *
 * `expiry` is supplied as a parameter because the REST row sometimes
 * omits it when the request was scoped to a single expiry.
 */
function mapToTableRow(row, ticker, expiry) {
  const t = row.time ?? row.timestamp;
  const tsMinute = t
    ? new Date(
        new Date(t).getTime() - (new Date(t).getTime() % 60_000),
      ).toISOString()
    : new Date(`${expiry}T21:00:00Z`).toISOString(); // fallback: 4 PM ET

  return {
    ticker,
    expiry,
    strike: row.strike,
    ts_minute: tsMinute,
    price: row.price,
    call_gamma_oi: row.call_gamma_oi,
    put_gamma_oi: row.put_gamma_oi,
    call_charm_oi: row.call_charm_oi,
    put_charm_oi: row.put_charm_oi,
    call_vanna_oi: row.call_vanna_oi,
    put_vanna_oi: row.put_vanna_oi,
    call_gamma_vol: row.call_gamma_vol,
    put_gamma_vol: row.put_gamma_vol,
    call_charm_vol: row.call_charm_vol,
    put_charm_vol: row.put_charm_vol,
    call_vanna_vol: row.call_vanna_vol,
    put_vanna_vol: row.put_vanna_vol,
    call_gamma_ask_vol: row.call_gamma_ask,
    call_gamma_bid_vol: row.call_gamma_bid,
    put_gamma_ask_vol: row.put_gamma_ask,
    put_gamma_bid_vol: row.put_gamma_bid,
    call_charm_ask_vol: row.call_charm_ask,
    call_charm_bid_vol: row.call_charm_bid,
    put_charm_ask_vol: row.put_charm_ask,
    put_charm_bid_vol: row.put_charm_bid,
    call_vanna_ask_vol: row.call_vanna_ask,
    call_vanna_bid_vol: row.call_vanna_bid,
    put_vanna_ask_vol: row.put_vanna_ask,
    put_vanna_bid_vol: row.put_vanna_bid,
    raw_payload: row,
  };
}

async function upsertOne(r) {
  const result = await sql`
    INSERT INTO ws_gex_strike_expiry (
      ticker, expiry, strike, ts_minute, price,
      call_gamma_oi, put_gamma_oi,
      call_charm_oi, put_charm_oi,
      call_vanna_oi, put_vanna_oi,
      call_gamma_vol, put_gamma_vol,
      call_charm_vol, put_charm_vol,
      call_vanna_vol, put_vanna_vol,
      call_gamma_ask_vol, call_gamma_bid_vol,
      put_gamma_ask_vol, put_gamma_bid_vol,
      call_charm_ask_vol, call_charm_bid_vol,
      put_charm_ask_vol, put_charm_bid_vol,
      call_vanna_ask_vol, call_vanna_bid_vol,
      put_vanna_ask_vol, put_vanna_bid_vol,
      raw_payload
    )
    VALUES (
      ${r.ticker}, ${r.expiry}, ${r.strike}, ${r.ts_minute}, ${r.price},
      ${r.call_gamma_oi}, ${r.put_gamma_oi},
      ${r.call_charm_oi}, ${r.put_charm_oi},
      ${r.call_vanna_oi}, ${r.put_vanna_oi},
      ${r.call_gamma_vol}, ${r.put_gamma_vol},
      ${r.call_charm_vol}, ${r.put_charm_vol},
      ${r.call_vanna_vol}, ${r.put_vanna_vol},
      ${r.call_gamma_ask_vol}, ${r.call_gamma_bid_vol},
      ${r.put_gamma_ask_vol}, ${r.put_gamma_bid_vol},
      ${r.call_charm_ask_vol}, ${r.call_charm_bid_vol},
      ${r.put_charm_ask_vol}, ${r.put_charm_bid_vol},
      ${r.call_vanna_ask_vol}, ${r.call_vanna_bid_vol},
      ${r.put_vanna_ask_vol}, ${r.put_vanna_bid_vol},
      ${JSON.stringify(r.raw_payload)}::jsonb
    )
    ON CONFLICT (ticker, expiry, strike, ts_minute) DO UPDATE SET
      price                 = EXCLUDED.price,
      call_gamma_oi         = EXCLUDED.call_gamma_oi,
      put_gamma_oi          = EXCLUDED.put_gamma_oi,
      call_charm_oi         = EXCLUDED.call_charm_oi,
      put_charm_oi          = EXCLUDED.put_charm_oi,
      call_vanna_oi         = EXCLUDED.call_vanna_oi,
      put_vanna_oi          = EXCLUDED.put_vanna_oi,
      call_gamma_vol        = EXCLUDED.call_gamma_vol,
      put_gamma_vol         = EXCLUDED.put_gamma_vol,
      call_charm_vol        = EXCLUDED.call_charm_vol,
      put_charm_vol         = EXCLUDED.put_charm_vol,
      call_vanna_vol        = EXCLUDED.call_vanna_vol,
      put_vanna_vol         = EXCLUDED.put_vanna_vol,
      call_gamma_ask_vol    = EXCLUDED.call_gamma_ask_vol,
      call_gamma_bid_vol    = EXCLUDED.call_gamma_bid_vol,
      put_gamma_ask_vol     = EXCLUDED.put_gamma_ask_vol,
      put_gamma_bid_vol     = EXCLUDED.put_gamma_bid_vol,
      call_charm_ask_vol    = EXCLUDED.call_charm_ask_vol,
      call_charm_bid_vol    = EXCLUDED.call_charm_bid_vol,
      put_charm_ask_vol     = EXCLUDED.put_charm_ask_vol,
      put_charm_bid_vol     = EXCLUDED.put_charm_bid_vol,
      call_vanna_ask_vol    = EXCLUDED.call_vanna_ask_vol,
      call_vanna_bid_vol    = EXCLUDED.call_vanna_bid_vol,
      put_vanna_ask_vol     = EXCLUDED.put_vanna_ask_vol,
      put_vanna_bid_vol     = EXCLUDED.put_vanna_bid_vol,
      raw_payload           = EXCLUDED.raw_payload
    RETURNING (xmax = 0) AS was_insert
  `;
  return result[0]?.was_insert === true;
}

// ── Main ──────────────────────────────────────────────────

async function backfillDate(date) {
  for (const ticker of TICKERS) {
    await new Promise((r) => setTimeout(r, 250));
    const restRows = await fetchExpiryStrike(ticker, date);
    if (restRows.length === 0) {
      console.log(`  ${date} ${ticker}: 0 rows`);
      continue;
    }
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    for (const restRow of restRows) {
      try {
        const tableRow = mapToTableRow(restRow, ticker, date);
        if (await upsertOne(tableRow)) inserted++;
        else updated++;
      } catch (err) {
        failed++;
        console.error(`  ${ticker} strike ${restRow.strike}: ${err.message}`);
      }
    }
    console.log(
      `  ${date} ${ticker}: ${restRows.length} ticks → ${inserted} new, ${updated} updated, ${failed} failed`,
    );
  }
}

async function main() {
  const dates =
    explicitDates.length > 0
      ? explicitDates.slice().sort()
      : getTradingDays(days);

  console.log(`Backfilling ws_gex_strike_expiry (UPSERT)`);
  console.log(`Tickers: ${TICKERS.join(', ')}`);
  console.log(`Days: ${dates.length} (${dates[0]} to ${dates.at(-1)})\n`);

  for (const date of dates) {
    await backfillDate(date);
  }

  console.log('\nDone.');
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
