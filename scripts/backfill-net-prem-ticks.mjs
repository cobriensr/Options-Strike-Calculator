#!/usr/bin/env node

/**
 * One-shot historical backfill of `net_flow_per_ticker_history` from
 * UW REST `/stock/{ticker}/net-prem-ticks`. Pulls per-minute net-flow
 * deltas (NCP, NPP, NCV, NPV plus per-ticker bid/ask side splits) for
 * the lottery universe across the last N days.
 *
 * Spec: docs/superpowers/specs/lottery-net-flow-eda-2026-05-03.md
 *       Phase 1 Task 1.2.
 *
 * Idempotent: ON CONFLICT (ticker, ts, source) DO NOTHING.
 * Resumable: queries MAX(ts) per ticker before fetching and skips
 * (ticker, date) pairs already fully covered.
 *
 * Filters (matching session-window memory rules):
 *   - 08:30–15:00 CT (13:30–20:00 UTC) — drop pre/after-market ticks
 *   - skip empty (ticker, date) responses (weekends/holidays)
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL=... node scripts/backfill-net-prem-ticks.mjs
 *
 * Optional env:
 *   DAYS=90              — calendar-day lookback (default 90; user has
 *                          90-day UW WebSocket plan retention)
 *   TICKERS=TSLA,NVDA    — comma-separated subset of the lottery list
 *   DRY_RUN=1            — fetch + parse, no DB writes
 *   BATCH_SIZE=500       — rows per batched INSERT
 *   CONCURRENCY=3        — concurrent ticker fetches
 *
 * The lottery ticker universe below is the union of LOTTERY_V3_TICKERS
 * and LOTTERY_EXTENDED_TICKERS in api/_lib/lottery-finder.ts.
 * KEEP IN SYNC with that source — this is a one-shot backfill so a
 * snapshot copy is acceptable; for live ingest, the WS daemon already
 * handles per-ticker subscriptions.
 */

import { neon } from '@neondatabase/serverless';

// ── Env + config ────────────────────────────────────────────

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN === '1';
const DAYS = Number.parseInt(process.env.DAYS ?? '90', 10);
const BATCH_SIZE = Number.parseInt(process.env.BATCH_SIZE ?? '500', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '3', 10);

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DRY_RUN && !DATABASE_URL) {
  console.error('Missing DATABASE_URL (or set DRY_RUN=1 to skip writes)');
  process.exit(1);
}

const sql = DRY_RUN ? null : neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';
const SOURCE = 'rest';

// LOTTERY_V3_TICKERS ∪ LOTTERY_EXTENDED_TICKERS (deduped) — see header.
const LOTTERY_TICKERS_ALL = [
  'USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM', 'WDC',
  'SQQQ', 'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL', 'SNOW', 'TEAM',
  'RKLB', 'SOFI', 'RUTW', 'TSLA', 'SOXS', 'WULF', 'SLV', 'SMH', 'UBER',
  'MSTR', 'TQQQ', 'RIOT', 'SOXL', 'UNH', 'QQQ', 'RBLX', 'SPY', 'IWM',
  'MU', 'META', 'AMD', 'NVDA', 'INTC', 'MSFT', 'AMZN', 'PLTR', 'AVGO',
  'GOOGL', 'GOOG', 'COIN', 'HOOD', 'MRVL', 'ORCL', 'AAPL',
];

const TICKER_FILTER = (process.env.TICKERS ?? '')
  .split(',')
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const tickers =
  TICKER_FILTER.length > 0
    ? LOTTERY_TICKERS_ALL.filter((t) => TICKER_FILTER.includes(t))
    : LOTTERY_TICKERS_ALL;

// ── Trading-day generator ────────────────────────────────────

function getTradingDays(count) {
  const dates = [];
  const d = new Date();
  // Include today if a weekday (UW returns whatever's printed so far).
  const today = d.getDay();
  if (today !== 0 && today !== 6) {
    dates.push(d.toISOString().slice(0, 10));
  }
  while (dates.length < count) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.reverse();
}

// ── Session-window filter (08:30–15:00 CT) ───────────────────

// CT == UTC-6 (CDT) or UTC-5 (CST). Easiest robust check: convert
// the row's UTC `tape_time` into the wall-clock minute-of-day in
// America/Chicago and gate on [510, 899] (08:30 .. 14:59 inclusive).
function isInSessionCT(tapeTimeUtc) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  // Parts: [{type:'hour',value:'8'}, {type:'literal',value:':'}, {type:'minute',value:'30'}]
  const parts = fmt.formatToParts(new Date(tapeTimeUtc));
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '-1',
    10,
  );
  const m = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '-1',
    10,
  );
  if (h < 0 || m < 0) return false;
  // Intl returns "24" for midnight when hour12:false — clamp.
  const hh = h === 24 ? 0 : h;
  const mod = hh * 60 + m;
  return mod >= 510 && mod < 900; // 08:30 .. 14:59
}

// ── Resumability: max ts per ticker ──────────────────────────

async function getMaxTsByTicker() {
  if (DRY_RUN) return new Map();
  const rows = await sql`
    SELECT ticker, MAX(ts)::text AS max_ts
    FROM net_flow_per_ticker_history
    WHERE source = ${SOURCE}
    GROUP BY ticker
  `;
  const map = new Map();
  for (const r of rows) map.set(r.ticker, r.max_ts);
  return map;
}

// ── UW fetch ─────────────────────────────────────────────────

async function fetchNetPremTicks(ticker, date) {
  const url = `${UW_BASE}/stock/${ticker}/net-prem-ticks?date=${date}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new RateLimitError(
      `429 for ${ticker} ${date}; retry-after=${retryAfter ?? 'unset'}`,
      Number.parseInt(retryAfter ?? '5', 10),
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(
      `  UW ${res.status} ${ticker} ${date}: ${body.slice(0, 100)}`,
    );
    return [];
  }
  const json = await res.json();
  return json.data ?? [];
}

class RateLimitError extends Error {
  constructor(msg, retryAfterSec) {
    super(msg);
    this.retryAfterSec = retryAfterSec;
  }
}

// ── Parse + filter ───────────────────────────────────────────

// UW response columns (per OpenAPI line 4956):
//   tape_time (ISO UTC), date, net_call_premium (string), net_call_volume,
//   net_put_premium (string), net_put_volume,
//   call_volume, call_volume_ask_side, call_volume_bid_side,
//   put_volume, put_volume_ask_side, put_volume_bid_side
function parseRow(ticker, raw) {
  return {
    ticker,
    ts: raw.tape_time,
    netCallPrem: Number.parseFloat(raw.net_call_premium ?? '0') || 0,
    netCallVol: raw.net_call_volume ?? 0,
    netPutPrem: Number.parseFloat(raw.net_put_premium ?? '0') || 0,
    netPutVol: raw.net_put_volume ?? 0,
    callVolume: raw.call_volume ?? 0,
    callVolumeAsk: raw.call_volume_ask_side ?? 0,
    callVolumeBid: raw.call_volume_bid_side ?? 0,
    putVolume: raw.put_volume ?? 0,
    putVolumeAsk: raw.put_volume_ask_side ?? 0,
    putVolumeBid: raw.put_volume_bid_side ?? 0,
  };
}

// ── Batched INSERT ──────────────────────────────────────────

// Uses sql.query() for arbitrary-arity multi-row INSERTs — the
// tagged-template form can't express variable VALUES lists. Pattern
// matches scripts/backfill-dark-pool-prints.mjs for consistency.
async function storeBatch(rows) {
  if (DRY_RUN || rows.length === 0) return rows.length;
  let stored = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const placeholders = [];
    const values = [];
    let p = 1;
    for (const r of chunk) {
      const ph = [];
      for (let k = 0; k < 13; k++) ph.push(`$${p++}`);
      placeholders.push(`(${ph.join(',')})`);
      values.push(
        r.ticker, r.ts,
        r.netCallPrem, r.netCallVol,
        r.netPutPrem, r.netPutVol,
        r.callVolume, r.callVolumeAsk, r.callVolumeBid,
        r.putVolume, r.putVolumeAsk, r.putVolumeBid,
        SOURCE,
      );
    }
    const queryText = `
      INSERT INTO net_flow_per_ticker_history (
        ticker, ts,
        net_call_prem, net_call_vol,
        net_put_prem, net_put_vol,
        call_volume, call_volume_ask_side, call_volume_bid_side,
        put_volume, put_volume_ask_side, put_volume_bid_side,
        source
      ) VALUES ${placeholders.join(',')}
      ON CONFLICT (ticker, ts, source) DO NOTHING
      RETURNING id
    `;
    try {
      const result = await sql.query(queryText, values);
      stored += Array.isArray(result)
        ? result.length
        : (result.rows?.length ?? 0);
    } catch (err) {
      console.warn(`  batch insert error: ${err.message}`);
    }
  }
  return stored;
}

// ── Per-(ticker, date) ──────────────────────────────────────

async function backfillTickerDate(ticker, date) {
  // Light retry on 429: wait + one retry with jitter.
  let raws;
  try {
    raws = await fetchNetPremTicks(ticker, date);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const wait = (err.retryAfterSec + Math.random() * 2) * 1000;
      console.warn(
        `  rate-limited on ${ticker} ${date}; sleeping ${(wait / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
      raws = await fetchNetPremTicks(ticker, date);
    } else {
      throw err;
    }
  }
  if (raws.length === 0) {
    return { fetched: 0, kept: 0, stored: 0, empty: true };
  }
  const kept = raws
    .filter((r) => isInSessionCT(r.tape_time))
    .map((r) => parseRow(ticker, r));
  const stored = await storeBatch(kept);
  return { fetched: raws.length, kept: kept.length, stored, empty: false };
}

// ── Concurrency: per-ticker pool with N workers ─────────────

async function pmapTickers(tickerList, dates, maxTsByTicker, concurrency) {
  const totals = {
    pairs: 0,
    fetched: 0,
    kept: 0,
    stored: 0,
    empty: 0,
    skipped: 0,
  };
  const queue = [...tickerList];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const ticker = queue.shift();
      if (!ticker) break;
      const maxTs = maxTsByTicker.get(ticker) ?? null;
      const maxDate = maxTs ? maxTs.slice(0, 10) : null;
      let perTicker = { fetched: 0, kept: 0, stored: 0, empty: 0, skipped: 0 };
      for (const date of dates) {
        // Resumability: skip dates strictly before the latest covered
        // date. Re-fetch the latest-covered date in case it was partial.
        if (maxDate && date < maxDate) {
          perTicker.skipped++;
          totals.skipped++;
          continue;
        }
        // Small jitter to spread fetches.
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
        try {
          const r = await backfillTickerDate(ticker, date);
          perTicker.fetched += r.fetched;
          perTicker.kept += r.kept;
          perTicker.stored += r.stored;
          if (r.empty) perTicker.empty++;
        } catch (err) {
          console.warn(`  ${ticker} ${date} failed: ${err.message}`);
        }
        totals.pairs++;
      }
      console.log(
        `  ${ticker}: fetched=${perTicker.fetched} kept=${perTicker.kept} stored=${perTicker.stored} empty=${perTicker.empty} skipped=${perTicker.skipped}`,
      );
      totals.fetched += perTicker.fetched;
      totals.kept += perTicker.kept;
      totals.stored += perTicker.stored;
      totals.empty += perTicker.empty;
    }
  });
  await Promise.all(workers);
  return totals;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const dates = getTradingDays(DAYS);
  console.log(
    `Backfilling /stock/{ticker}/net-prem-ticks → net_flow_per_ticker_history`,
  );
  console.log(
    `  tickers: ${tickers.length}  days: ${dates.length}  range: ${dates[0]} → ${dates.at(-1)}`,
  );
  console.log(
    `  concurrency: ${CONCURRENCY}  batch: ${BATCH_SIZE}  dry_run: ${DRY_RUN}`,
  );

  const maxTsByTicker = await getMaxTsByTicker();
  if (maxTsByTicker.size > 0) {
    console.log(
      `  resumability: ${maxTsByTicker.size} tickers have prior data; will skip dates < their max`,
    );
  }

  const startWall = Date.now();
  const totals = await pmapTickers(
    tickers,
    dates,
    maxTsByTicker,
    CONCURRENCY,
  );
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);

  console.log('');
  console.log(`Done in ${elapsed}s`);
  console.log(`  pairs processed: ${totals.pairs}`);
  console.log(`  rows fetched:    ${totals.fetched}`);
  console.log(`  rows kept (CT):  ${totals.kept}`);
  console.log(`  rows stored:     ${totals.stored}`);
  console.log(`  empty days:      ${totals.empty}`);
  console.log(`  pre-skipped:     ${totals.skipped}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
