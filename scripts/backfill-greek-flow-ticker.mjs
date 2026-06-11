#!/usr/bin/env node

/**
 * One-shot historical backfill of `greek_flow_per_ticker_history` from
 * UW REST `/stock/{ticker}/greek-flow`. Pulls per-minute directional
 * delta/vega flow + OTM variants + totals for the lottery universe.
 *
 * Distinct from `backfill-greek-flow.mjs` (which targets the
 * /group-flow/{group}/greek-flow/{expiry} endpoint for 0DTE SPX).
 *
 * Spec: docs/superpowers/specs/lottery-dir-delta-eda-2026-05-04.md
 *       Phase 1 Task 1.2.
 *
 * Idempotent: ON CONFLICT (ticker, ts, source) DO NOTHING.
 * Resumable: queries MAX(ts) per ticker; BYPASS_RESUME=1 forces full
 * re-fetch (useful for filling gaps).
 *
 * Filters:
 *   - 08:30-15:00 CT (13:30-20:00 UTC)
 *   - skip empty (ticker, date) responses
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL=... node scripts/backfill-greek-flow-ticker.mjs
 *
 * Optional env:
 *   DAYS=90              — calendar-day lookback
 *   TICKERS=TSLA,NVDA    — comma-separated subset
 *   DRY_RUN=1            — fetch + parse, no DB writes
 *   BATCH_SIZE=500
 *   CONCURRENCY=3
 *   BYPASS_RESUME=1      — re-fetch every date
 */

import { neon } from '@neondatabase/serverless';

import { getTradingDays } from './_lib/trading-days.mjs';

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

const LOTTERY_TICKERS_ALL = [
  'USAR',
  'WMT',
  'STX',
  'SOUN',
  'RIVN',
  'TSM',
  'SNDK',
  'XOM',
  'WDC',
  'SQQQ',
  'NDXP',
  'USO',
  'TNA',
  'RDDT',
  'SMCI',
  'TSLL',
  'SNOW',
  'TEAM',
  'RKLB',
  'SOFI',
  'RUTW',
  'TSLA',
  'SOXS',
  'WULF',
  'SLV',
  'SMH',
  'UBER',
  'MSTR',
  'TQQQ',
  'RIOT',
  'SOXL',
  'UNH',
  'QQQ',
  'RBLX',
  'SPY',
  'IWM',
  'MU',
  'META',
  'AMD',
  'NVDA',
  'INTC',
  'MSFT',
  'AMZN',
  'PLTR',
  'AVGO',
  'GOOGL',
  'GOOG',
  'COIN',
  'HOOD',
  'MRVL',
  'ORCL',
  'AAPL',
];

const TICKER_FILTER = (process.env.TICKERS ?? '')
  .split(',')
  .map((t) => t.trim().toUpperCase())
  .filter(Boolean);
const tickers =
  TICKER_FILTER.length > 0
    ? LOTTERY_TICKERS_ALL.filter((t) => TICKER_FILTER.includes(t))
    : LOTTERY_TICKERS_ALL;

function isInSessionCT(tapeTimeUtc) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
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
  const hh = h === 24 ? 0 : h;
  const mod = hh * 60 + m;
  return mod >= 510 && mod < 900;
}

async function getMaxTsByTicker() {
  if (DRY_RUN) return new Map();
  const rows = await sql`
    SELECT ticker, MAX(ts)::text AS max_ts
    FROM greek_flow_per_ticker_history
    WHERE source = ${SOURCE}
    GROUP BY ticker
  `;
  const map = new Map();
  for (const r of rows) map.set(r.ticker, r.max_ts);
  return map;
}

class RateLimitError extends Error {
  constructor(msg, retryAfterSec) {
    super(msg);
    this.retryAfterSec = retryAfterSec;
  }
}

async function fetchGreekFlow(ticker, date) {
  const url = `${UW_BASE}/stock/${ticker}/greek-flow?date=${date}`;
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
    console.warn(`  UW ${res.status} ${ticker} ${date}: ${body.slice(0, 100)}`);
    return [];
  }
  const json = await res.json();
  return json.data ?? [];
}

function parseRow(ticker, raw) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ticker,
    ts: raw.timestamp,
    dirDeltaFlow: num(raw.dir_delta_flow),
    dirVegaFlow: num(raw.dir_vega_flow),
    otmDirDeltaFlow: num(raw.otm_dir_delta_flow),
    otmDirVegaFlow: num(raw.otm_dir_vega_flow),
    totalDeltaFlow: num(raw.total_delta_flow),
    totalVegaFlow: num(raw.total_vega_flow),
    otmTotalDeltaFlow: num(raw.otm_total_delta_flow),
    otmTotalVegaFlow: num(raw.otm_total_vega_flow),
    transactions: raw.transactions ?? null,
    volume: raw.volume ?? null,
  };
}

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
        r.ticker,
        r.ts,
        r.dirDeltaFlow,
        r.dirVegaFlow,
        r.otmDirDeltaFlow,
        r.otmDirVegaFlow,
        r.totalDeltaFlow,
        r.totalVegaFlow,
        r.otmTotalDeltaFlow,
        r.otmTotalVegaFlow,
        r.transactions,
        r.volume,
        SOURCE,
      );
    }
    const queryText = `
      INSERT INTO greek_flow_per_ticker_history (
        ticker, ts,
        dir_delta_flow, dir_vega_flow,
        otm_dir_delta_flow, otm_dir_vega_flow,
        total_delta_flow, total_vega_flow,
        otm_total_delta_flow, otm_total_vega_flow,
        transactions, volume,
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

async function backfillTickerDate(ticker, date) {
  let raws;
  try {
    raws = await fetchGreekFlow(ticker, date);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const wait = (err.retryAfterSec + Math.random() * 2) * 1000;
      console.warn(
        `  rate-limited on ${ticker} ${date}; sleeping ${(wait / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
      raws = await fetchGreekFlow(ticker, date);
    } else {
      throw err;
    }
  }
  if (raws.length === 0) {
    return { fetched: 0, kept: 0, stored: 0, empty: true };
  }
  const kept = raws
    .filter((r) => isInSessionCT(r.timestamp))
    .map((r) => parseRow(ticker, r));
  const stored = await storeBatch(kept);
  return { fetched: raws.length, kept: kept.length, stored, empty: false };
}

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
      const perTicker = {
        fetched: 0,
        kept: 0,
        stored: 0,
        empty: 0,
        skipped: 0,
      };
      for (const date of dates) {
        if (process.env.BYPASS_RESUME !== '1' && maxDate && date < maxDate) {
          perTicker.skipped++;
          totals.skipped++;
          continue;
        }
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

async function main() {
  const dates = getTradingDays(DAYS);
  console.log(
    `Backfilling /stock/{ticker}/greek-flow → greek_flow_per_ticker_history`,
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
  const totals = await pmapTickers(tickers, dates, maxTsByTicker, CONCURRENCY);
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
