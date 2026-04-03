#!/usr/bin/env node

/**
 * Verify dark pool clustering by showing raw trades → clusters for a date.
 *
 * Fetches raw SPY dark pool trades, applies the same filters and clustering
 * as the cron, and prints a detailed breakdown so you can trace each trade
 * into its cluster and verify the aggregation.
 *
 * Usage:
 *   env $(grep -v '^#' .env | xargs) node scripts/verify-darkpool.mjs
 *   node scripts/verify-darkpool.mjs 2026-04-02     # specific date
 *   node scripts/verify-darkpool.mjs 2026-04-02 3   # top 3 clusters only
 */

const UW_API_KEY = process.env.UW_API_KEY;
if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}

const UW_BASE = 'https://api.unusualwhales.com/api';
const args = process.argv.slice(2);
const date = args[0] ?? new Date().toISOString().slice(0, 10);
const maxClusters = Number.parseInt(args[1] ?? '999', 10);
const spyToSpxRatio = 10;

// ── Fetch ───────────────────────────────────────────────────

async function fetchTrades() {
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
    console.error(`API error ${res.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Helpers ─────────────────────────────────────────────────

function fmtPremium(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(0)}K`;
  return `$${a.toFixed(0)}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Chicago',
  });
}

function classifyDirection(price, bid, ask) {
  if (isNaN(ask) || isNaN(bid)) return 'NEUTRAL';
  const mid = (ask + bid) / 2;
  if (price >= ask - 0.005) return 'BUYER';
  if (price <= bid + 0.005) return 'SELLER';
  return price >= mid ? 'BUYER' : 'SELLER';
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const allTrades = await fetchTrades();
  console.log(`\n═══ DARK POOL VERIFICATION: ${date} ═══\n`);
  console.log(`Raw trades from API: ${allTrades.length}`);

  // Show what gets filtered
  const canceled = allTrades.filter((t) => t.canceled);
  const extHours = allTrades.filter((t) => t.ext_hour_sold_codes);
  const avgPrice = allTrades.filter(
    (t) => t.sale_cond_codes === 'average_price_trade',
  );
  const derivPriced = allTrades.filter(
    (t) => t.trade_code === 'derivative_priced',
  );
  const nonRegular = allTrades.filter(
    (t) =>
      t.trade_settlement !== 'regular' &&
      t.trade_settlement !== 'regular_settlement',
  );

  console.log(`  Canceled: ${canceled.length}`);
  console.log(`  Extended hours: ${extHours.length}`);
  console.log(`  Average price: ${avgPrice.length}`);
  console.log(`  Derivative priced: ${derivPriced.length}`);
  console.log(`  Non-regular settlement: ${nonRegular.length}`);

  // Apply filters
  const trades = allTrades.filter(
    (t) =>
      !t.canceled &&
      !t.ext_hour_sold_codes &&
      (t.trade_settlement === 'regular' ||
        t.trade_settlement === 'regular_settlement') &&
      t.sale_cond_codes !== 'average_price_trade' &&
      t.trade_code !== 'derivative_priced',
  );
  console.log(`  After filtering: ${trades.length} trades\n`);

  if (trades.length === 0) {
    console.log('No trades after filtering.');
    return;
  }

  // ── Show each trade ─────────────────────────────────────

  // Group into $0.50 bands
  const bands = new Map();
  for (const t of trades) {
    const price = Number.parseFloat(t.price);
    if (isNaN(price)) continue;
    const band = Math.round(price * 2) / 2;
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(t);
  }

  // Sort bands by total premium
  const sortedBands = [...bands.entries()]
    .map(([band, bandTrades]) => {
      const totalPremium = bandTrades.reduce(
        (s, t) => s + (Number.parseFloat(t.premium) || 0),
        0,
      );
      return { band, trades: bandTrades, totalPremium };
    })
    .sort((a, b) => b.totalPremium - a.totalPremium);

  // Show top N clusters with their trades
  const showing = sortedBands.slice(0, maxClusters);

  for (const { band, trades: bt, totalPremium } of showing) {
    const spx = Math.round(band * spyToSpxRatio);
    let buyers = 0;
    let sellers = 0;
    let neutral = 0;
    let totalShares = 0;
    let latestTime = '';

    console.log(
      `── SPY $${band.toFixed(2)} → SPX ~${spx} ── ${bt.length} trades ── ${fmtPremium(totalPremium)} ──`,
    );
    console.log(
      '  ' +
        'Time'.padEnd(14) +
        'Price'.padEnd(10) +
        'Size'.padEnd(8) +
        'Premium'.padEnd(12) +
        'Bid'.padEnd(8) +
        'Ask'.padEnd(8) +
        'Dir'.padEnd(8) +
        'Codes',
    );
    console.log('  ' + '─'.repeat(80));

    for (const t of bt.sort((a, b) =>
      a.executed_at.localeCompare(b.executed_at),
    )) {
      const price = Number.parseFloat(t.price);
      const bid = Number.parseFloat(t.nbbo_bid);
      const ask = Number.parseFloat(t.nbbo_ask);
      const premium = Number.parseFloat(t.premium);
      const dir = classifyDirection(price, bid, ask);

      if (dir === 'BUYER') buyers++;
      else if (dir === 'SELLER') sellers++;
      else neutral++;

      totalShares += t.size;
      if (t.executed_at > latestTime) latestTime = t.executed_at;

      const codes = [
        t.sale_cond_codes,
        t.trade_code,
        t.ext_hour_sold_codes,
      ]
        .filter(Boolean)
        .join(', ');

      console.log(
        '  ' +
          fmtTime(t.executed_at).padEnd(14) +
          `$${price.toFixed(2)}`.padEnd(10) +
          String(t.size).padEnd(8) +
          fmtPremium(premium).padEnd(12) +
          `$${bid.toFixed(2)}`.padEnd(8) +
          `$${ask.toFixed(2)}`.padEnd(8) +
          dir.padEnd(8) +
          (codes || '-'),
      );
    }

    const netDir =
      buyers > sellers ? 'BUY' : sellers > buyers ? 'SELL' : 'MIXED';

    console.log('  ' + '─'.repeat(80));
    console.log(
      `  TOTAL: ${fmtPremium(totalPremium)} | ${totalShares.toLocaleString()} shares | ${buyers}B/${sellers}S/${neutral}N → ${netDir} | latest: ${fmtTime(latestTime)}`,
    );
    console.log();
  }

  if (sortedBands.length > maxClusters) {
    console.log(
      `  ... and ${sortedBands.length - maxClusters} more clusters\n`,
    );
  }

  // ── Summary ─────────────────────────────────────────────
  const grandTotal = sortedBands.reduce((s, b) => s + b.totalPremium, 0);
  console.log(`═══ SUMMARY ═══`);
  console.log(`  Clusters: ${sortedBands.length}`);
  console.log(`  Total premium: ${fmtPremium(grandTotal)}`);
  console.log(`  Total trades: ${trades.length}`);
}

try {
  await main();
} catch (err) {
  console.error('Verification failed:', err);
  process.exit(1);
}
