#!/usr/bin/env node

/**
 * Backfill vol surface data for recent trading days.
 *
 * Fetches the UW term structure, realized vol, and IV rank endpoints
 * for each historical date and stores the results in vol_term_structure
 * and vol_realized tables.
 *
 * Usage:
 *   node scripts/backfill-vol-surface.mjs          # 30 days (default)
 *   node scripts/backfill-vol-surface.mjs 10       # 10 days
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

const args = process.argv.slice(2);
const days = Number.parseInt(args[0] ?? '30', 10);

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

// ── UW API fetcher ──────────────────────────────────────────

async function uwFetch(path) {
  const res = await fetch(`${UW_BASE}${path}`, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(`  UW API ${res.status}: ${text.slice(0, 100)}`);
    return null;
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store term structure rows ───────────────────────────────

async function storeTermStructure(date, rows) {
  let stored = 0;
  for (const row of rows) {
    const daysVal = Number.parseInt(String(row.dte ?? row.days), 10);
    const volatility = Number.parseFloat(row.volatility);
    const impliedMove =
      Number.parseFloat(row.implied_move_perc ?? row.implied_move) || null;

    if (Number.isNaN(daysVal) || Number.isNaN(volatility)) continue;

    try {
      await sql`
        INSERT INTO vol_term_structure (
          date, days, volatility, implied_move
        ) VALUES (
          ${date}, ${daysVal}, ${volatility},
          ${impliedMove}
        )
        ON CONFLICT (date, days) DO NOTHING
      `;
      stored++;
    } catch (err) {
      console.warn(
        `  TS insert error for ${date} d=${daysVal}: ${err.message}`,
      );
    }
  }
  return stored;
}

// ── Store realized vol + IV rank ────────────────────────────

async function storeRealizedVol(date, rvRows, rankRows) {
  // Find the entry matching the date (or last entry)
  const findRow = (rows) => {
    if (!rows || rows.length === 0) return null;
    const match = rows.find((r) => r.date === date);
    return match ?? rows.at(-1);
  };

  const rvRow = findRow(rvRows);
  const rankRow = findRow(rankRows);

  if (!rvRow && !rankRow) return false;

  const iv30d =
    rvRow?.implied_volatility != null
      ? Number.parseFloat(rvRow.implied_volatility)
      : null;
  const rv30d =
    rvRow?.realized_volatility != null
      ? Number.parseFloat(rvRow.realized_volatility)
      : null;

  // Compute derived fields
  let ivRvSpread = null;
  let ivOverpricingPct = null;
  if (iv30d != null && rv30d != null && rv30d > 0) {
    ivRvSpread = iv30d - rv30d;
    ivOverpricingPct = ((iv30d - rv30d) / rv30d) * 100;
  }

  const ivRank =
    (rankRow?.iv_rank_1y ?? rankRow?.iv_rank) != null
      ? Number.parseFloat(rankRow.iv_rank_1y ?? rankRow.iv_rank)
      : null;

  try {
    await sql`
      INSERT INTO vol_realized (
        date, iv_30d, rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank
      ) VALUES (
        ${date}, ${iv30d}, ${rv30d},
        ${ivRvSpread}, ${ivOverpricingPct}, ${ivRank}
      )
      ON CONFLICT (date) DO UPDATE SET
        iv_30d = EXCLUDED.iv_30d,
        rv_30d = EXCLUDED.rv_30d,
        iv_rv_spread = EXCLUDED.iv_rv_spread,
        iv_overpricing_pct = EXCLUDED.iv_overpricing_pct,
        iv_rank = EXCLUDED.iv_rank
    `;
    return true;
  } catch (err) {
    console.warn(`  RV insert error for ${date}: ${err.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(
    'Backfilling vol surface data (term structure + realized vol + IV rank)',
  );
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} → ${tradingDays.at(-1)})\n`,
  );

  let tsStored = 0;
  let rvStored = 0;
  let skipped = 0;
  let errors = 0;

  for (const date of tradingDays) {
    // Rate limit: 600ms between dates
    await new Promise((r) => setTimeout(r, 600));

    // Fetch all 3 endpoints
    const [tsData, rvData, rankData] = await Promise.all([
      uwFetch(`/stock/SPX/volatility/term-structure?date=${date}`),
      uwFetch(`/stock/SPX/volatility/realized?date=${date}`),
      uwFetch(`/stock/SPX/iv-rank?date=${date}`),
    ]);

    // Term structure
    if (tsData && tsData.length > 0) {
      const n = await storeTermStructure(date, tsData);
      tsStored += n;
      console.log(`  ${date}: ${n} term structure rows`);
    } else {
      console.log(`  ${date}: no term structure data`);
    }

    // Realized vol + IV rank
    if (rvData || rankData) {
      const ok = await storeRealizedVol(date, rvData, rankData);
      if (ok) {
        const iv = rvData?.at(-1)?.implied_volatility;
        const rv = rvData?.at(-1)?.realized_volatility;
        const rank = rankData?.at(-1)?.iv_rank_1y ?? rankData?.at(-1)?.iv_rank;
        console.log(
          `  ${date}: RV stored` +
            (iv != null ? ` IV=${(Number(iv) * 100).toFixed(1)}%` : '') +
            (rv != null ? ` RV=${(Number(rv) * 100).toFixed(1)}%` : '') +
            (rank != null ? ` Rank=${Number(rank).toFixed(0)}` : ''),
        );
        rvStored++;
      } else {
        errors++;
      }
    } else {
      console.log(`  ${date}: no realized vol / IV rank data`);
      skipped++;
    }
  }

  console.log('\nDone!');
  console.log(`  Term structure rows: ${tsStored}`);
  console.log(`  Realized vol days: ${rvStored}`);
  console.log(`  Skipped (no data): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
