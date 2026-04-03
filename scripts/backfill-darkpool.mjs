#!/usr/bin/env node

/**
 * Backfill dark pool levels for recent trading days.
 *
 * Fetches SPY dark pool block trades from Unusual Whales, clusters them
 * by $0.50 price band, translates to SPX levels, and stores in the
 * dark_pool_levels table. Same logic as the cron + darkpool.ts module.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-darkpool.mjs
 *   node scripts/backfill-darkpool.mjs 10       # 10 days (default 30)
 *   node scripts/backfill-darkpool.mjs 5 10     # 5 days, ratio=10
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

// ── Parse args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const days = Number.parseInt(args[0] ?? '30', 10);
const spyToSpxRatio = Number.parseFloat(args[1] ?? '10');

// ── Generate last N trading days ────────────────────────────

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

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

// ── Fetch dark pool blocks ──────────────────────────────────

async function fetchAllTrades(date) {
  const all = [];
  let olderThan;

  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      min_premium: '0',
      limit: '500',
      date,
    });
    if (olderThan != null) params.set('older_than', String(olderThan));

    const res = await fetch(`${UW_BASE}/darkpool/SPY?${params}`, {
      headers: { Authorization: `Bearer ${UW_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`  UW API ${res.status} page ${page}: ${text.slice(0, 100)}`);
      break;
    }

    const body = await res.json();
    const batch = body.data ?? [];

    if (batch.length === 0) break;
    all.push(...batch);

    const oldest = batch.at(-1);
    if (!oldest) break;

    const oldestTs = Math.floor(new Date(oldest.executed_at).getTime() / 1000);
    if (olderThan != null && oldestTs >= olderThan) break;
    olderThan = oldestTs;

    if (batch.length < 500) break;

    // Rate limit: UW allows 120 req/60s = 2/sec. Use 600ms to stay safe.
    await new Promise((r) => setTimeout(r, 600));
  }

  // Same filters as darkpool.ts
  return all.filter(
    (t) =>
      !t.canceled &&
      !t.ext_hour_sold_codes &&
      (t.trade_settlement === 'regular' ||
        t.trade_settlement === 'regular_settlement') &&
      t.sale_cond_codes !== 'average_price_trade' &&
      t.trade_code !== 'derivative_priced',
  );
}

// ── Aggregate per $1 SPX level (mirrors aggregateDarkPoolLevels) ─

function aggregateLevels(trades) {
  if (trades.length === 0) return [];

  const levels = new Map();

  for (const trade of trades) {
    const price = Number.parseFloat(trade.price);
    if (Number.isNaN(price)) continue;

    const spxLevel = Math.round(price * spyToSpxRatio);
    const premium = Number.parseFloat(trade.premium) || 0;

    const existing = levels.get(spxLevel) ?? {
      totalPremium: 0,
      tradeCount: 0,
      totalShares: 0,
      latestTime: '',
    };

    existing.totalPremium += premium;
    existing.tradeCount += 1;
    existing.totalShares += trade.size;
    if (trade.executed_at > existing.latestTime) {
      existing.latestTime = trade.executed_at;
    }

    levels.set(spxLevel, existing);
  }

  return [...levels.entries()]
    .map(([spxLevel, data]) => ({ spxLevel, ...data }))
    .sort((a, b) => b.totalPremium - a.totalPremium);
}

// ── Store levels ────────────────────────────────────────────

async function storeLevels(date, levels) {
  await sql`DELETE FROM dark_pool_levels WHERE date = ${date}`;

  const now = new Date().toISOString();
  let stored = 0;

  for (const l of levels) {
    try {
      await sql`
        INSERT INTO dark_pool_levels (
          date, spx_approx, total_premium, trade_count, total_shares,
          latest_time, updated_at
        ) VALUES (
          ${date}, ${l.spxLevel}, ${l.totalPremium},
          ${l.tradeCount}, ${l.totalShares},
          ${l.latestTime || null}, ${now}
        )
      `;
      stored++;
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return stored;
}

// ── Format premium ──────────────────────────────────────────

function fmtPremium(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  return `$${(abs / 1e3).toFixed(0)}K`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling dark pool levels (SPY → SPX, ratio=${spyToSpxRatio})`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays.at(-1)})\n`,
  );

  const totals = { trades: 0, levels: 0, stored: 0, skipped: 0 };

  for (const date of tradingDays) {
    // Pause between dates to let the rate limit window reset
    await new Promise((r) => setTimeout(r, 2_000));

    const trades = await fetchAllTrades(date);

    if (trades.length === 0) {
      console.log(`  ${date}: no trades`);
      totals.skipped++;
      continue;
    }

    const levels = aggregateLevels(trades);
    const stored = await storeLevels(date, levels);

    const top = levels[0];
    const topStr = top
      ? `top: SPX ${top.spxLevel} ${fmtPremium(top.totalPremium)}`
      : '';

    totals.trades += trades.length;
    totals.levels += levels.length;
    totals.stored += stored;

    console.log(
      `  ${date}: ${trades.length} trades → ${levels.length} levels (${stored} stored) ${topStr}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total trades fetched: ${totals.trades}`);
  console.log(`  Total levels: ${totals.levels}`);
  console.log(`  Stored: ${totals.stored}`);
  console.log(`  Days skipped (no data): ${totals.skipped}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
