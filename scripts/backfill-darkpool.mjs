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

async function fetchDarkPoolBlocks(date) {
  const params = new URLSearchParams({
    min_premium: '5000000',
    limit: '500',
    date,
  });

  const res = await fetch(`${UW_BASE}/darkpool/SPY?${params}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status} for ${date}: ${text.slice(0, 100)}`);
    return [];
  }

  const body = await res.json();
  const trades = body.data ?? [];

  // Same filters as darkpool.ts
  return trades.filter(
    (t) =>
      !t.canceled &&
      (t.trade_settlement === 'regular' ||
        t.trade_settlement === 'regular_settlement') &&
      t.sale_cond_codes !== 'average_price_trade' &&
      t.trade_code !== 'derivative_priced',
  );
}

// ── Cluster trades (mirrors clusterDarkPoolTrades) ──────────

function clusterTrades(trades) {
  if (trades.length === 0) return [];

  // Group into $0.50 price bands
  const bands = new Map();
  for (const trade of trades) {
    const price = Number.parseFloat(trade.price);
    if (Number.isNaN(price)) continue;
    const band = Math.round(price * 2) / 2;
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(trade);
  }

  const clusters = [];
  for (const [band, bandTrades] of bands) {
    let totalPremium = 0;
    let totalShares = 0;
    let buyerInitiated = 0;
    let sellerInitiated = 0;
    let neutral = 0;
    let latestTime = '';
    let priceLow = Infinity;
    let priceHigh = -Infinity;

    for (const t of bandTrades) {
      const price = Number.parseFloat(t.price);
      const ask = Number.parseFloat(t.nbbo_ask);
      const bid = Number.parseFloat(t.nbbo_bid);
      const premium = Number.parseFloat(t.premium);

      if (!Number.isNaN(premium)) totalPremium += premium;
      totalShares += t.size;

      if (price < priceLow) priceLow = price;
      if (price > priceHigh) priceHigh = price;
      if (t.executed_at > latestTime) latestTime = t.executed_at;

      if (!Number.isNaN(ask) && !Number.isNaN(bid)) {
        const mid = (ask + bid) / 2;
        if (price >= ask - 0.005) {
          buyerInitiated++;
        } else if (price <= bid + 0.005) {
          sellerInitiated++;
        } else if (price >= mid) {
          buyerInitiated++;
        } else {
          sellerInitiated++;
        }
      } else {
        neutral++;
      }
    }

    clusters.push({
      spyPriceLow: priceLow,
      spyPriceHigh: priceHigh,
      spxApprox: Math.round(band * spyToSpxRatio),
      totalPremium,
      tradeCount: bandTrades.length,
      totalShares,
      buyerInitiated,
      sellerInitiated,
      neutral,
      latestTime,
    });
  }

  return clusters.sort((a, b) => b.totalPremium - a.totalPremium);
}

// ── Store clusters ──────────────────────────────────────────

async function storeClusters(date, clusters) {
  // Delete existing data for this date (full replace)
  await sql`DELETE FROM dark_pool_levels WHERE date = ${date}`;

  const now = new Date().toISOString();
  let stored = 0;

  for (const c of clusters) {
    try {
      await sql`
        INSERT INTO dark_pool_levels (
          date, spx_approx, spy_price_low, spy_price_high,
          total_premium, trade_count, total_shares,
          buyer_initiated, seller_initiated, neutral,
          latest_time, updated_at
        ) VALUES (
          ${date}, ${c.spxApprox}, ${c.spyPriceLow}, ${c.spyPriceHigh},
          ${c.totalPremium}, ${c.tradeCount}, ${c.totalShares},
          ${c.buyerInitiated}, ${c.sellerInitiated}, ${c.neutral},
          ${c.latestTime || null}, ${now}
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

  const totals = { trades: 0, clusters: 0, stored: 0, skipped: 0 };

  for (const date of tradingDays) {
    // Rate limit — UW API is generous but don't abuse it
    await new Promise((r) => setTimeout(r, 500));

    const trades = await fetchDarkPoolBlocks(date);

    if (trades.length === 0) {
      console.log(`  ${date}: no trades`);
      totals.skipped++;
      continue;
    }

    const clusters = clusterTrades(trades);
    const stored = await storeClusters(date, clusters);

    const topLevel = clusters[0];
    const topStr = topLevel
      ? `top: SPX ~${topLevel.spxApprox} ${fmtPremium(topLevel.totalPremium)}`
      : '';

    totals.trades += trades.length;
    totals.clusters += clusters.length;
    totals.stored += stored;

    console.log(
      `  ${date}: ${trades.length} trades → ${clusters.length} clusters (${stored} stored) ${topStr}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total trades fetched: ${totals.trades}`);
  console.log(`  Total clusters: ${totals.clusters}`);
  console.log(`  Stored: ${totals.stored}`);
  console.log(`  Days skipped (no data): ${totals.skipped}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
