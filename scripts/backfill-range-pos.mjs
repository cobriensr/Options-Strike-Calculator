#!/usr/bin/env node

/**
 * Backfill range_pos_at_trigger on historical lottery_finder_fires.
 *
 * For every fire where range_pos_at_trigger IS NULL, fetches the
 * underlying's 1-min OHLC candles from Unusual Whales for the fire's
 * trading date, then computes (spot_at_first − session_low) /
 * (session_high − session_low) over the candle prefix at or before
 * trigger_time_ct. Writes the result via UPDATE. NULL stays NULL on
 * UW failure or insufficient data (the score-bonus layer treats NULL
 * as "no penalty").
 *
 * Idempotent: only touches rows where the column is NULL.
 *
 * Performance:
 *   - Groups fires by (ticker, date) so each UW endpoint call is
 *     hit exactly once per unique pair.
 *   - Sequential UW calls (no concurrency) — UW limit on the stock-
 *     ohlc endpoint is ~120/min for the Advanced tier; this is well
 *     under that even on a 626K-row backfill.
 *   - Batches the UPDATE in per-(ticker,date) groups so the round
 *     trip count is bounded by unique pairs, not row count.
 *
 * Usage:
 *   UW_API_KEY=... DATABASE_URL=... node scripts/backfill-range-pos.mjs
 *
 * Options:
 *   --limit N         Cap the number of (ticker, date) groups processed.
 *   --dry-run         Compute but don't UPDATE — useful for sanity checks.
 *
 * Source: docs/superpowers/specs/lottery-silentboom-eda-impl-2026-05-16.md
 * Phase F. Schema column added in migration #153.
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
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const groupLimit =
  limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] ?? '0', 10) : 0;

// ── UW client ──────────────────────────────────────────────

async function fetchStockCandles1m(ticker, date) {
  const url = `${UW_BASE}/stock/${ticker}/ohlc/1m?date=${date}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${UW_API_KEY}` },
    });
    if (!res.ok) {
      console.warn(
        `  UW ${ticker} ${date} → HTTP ${res.status}; leaving NULL`,
      );
      return [];
    }
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch (err) {
    console.warn(`  UW ${ticker} ${date} → ${err.message}; leaving NULL`);
    return [];
  }
}

function computeRangePos(candles, triggerTimeMs, spot) {
  let high = -Infinity;
  let low = Infinity;
  let sawCandle = false;
  for (const c of candles) {
    const ms = new Date(c.start_time).getTime();
    if (!Number.isFinite(ms) || ms > triggerTimeMs) continue;
    sawCandle = true;
    const h = Number.parseFloat(c.high);
    const l = Number.parseFloat(c.low);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  if (!sawCandle) return null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }
  const pos = (spot - low) / (high - low);
  if (!Number.isFinite(pos)) return null;
  return Math.max(0, Math.min(1, pos));
}

// ── Pull groups + rows ─────────────────────────────────────

console.log('Querying NULL range_pos_at_trigger groups…');
const groups = await sql`
  SELECT
    underlying_symbol AS ticker,
    date::text AS date,
    COUNT(*)::int AS n
  FROM lottery_finder_fires
  WHERE range_pos_at_trigger IS NULL
  GROUP BY underlying_symbol, date
  ORDER BY date DESC, underlying_symbol
  ${groupLimit > 0 ? sql`LIMIT ${groupLimit}` : sql``}
`;

console.log(
  `Found ${groups.length} (ticker, date) groups; ` +
    `${groups.reduce((acc, g) => acc + g.n, 0)} total rows to update.`,
);

let groupsProcessed = 0;
let rowsUpdated = 0;
let rowsLeftNull = 0;

for (const g of groups) {
  groupsProcessed++;
  console.log(
    `[${groupsProcessed}/${groups.length}] ${g.ticker} ${g.date} (${g.n} fires)`,
  );
  const candles = await fetchStockCandles1m(g.ticker, g.date);
  if (candles.length === 0) {
    rowsLeftNull += g.n;
    continue;
  }
  // Pull the fires for this (ticker, date) group with their trigger
  // time + spot_at_first so we can compute per-row range_pos.
  const fires = await sql`
    SELECT id, trigger_time_ct, spot_at_first::float AS spot
    FROM lottery_finder_fires
    WHERE underlying_symbol = ${g.ticker}
      AND date = ${g.date}::date
      AND range_pos_at_trigger IS NULL
  `;
  for (const f of fires) {
    const triggerMs =
      f.trigger_time_ct instanceof Date
        ? f.trigger_time_ct.getTime()
        : new Date(f.trigger_time_ct).getTime();
    const rangePos = computeRangePos(candles, triggerMs, f.spot);
    if (rangePos == null) {
      rowsLeftNull++;
      continue;
    }
    if (dryRun) {
      rowsUpdated++;
      continue;
    }
    await sql`
      UPDATE lottery_finder_fires
      SET range_pos_at_trigger = ${rangePos}
      WHERE id = ${f.id}
    `;
    rowsUpdated++;
  }
}

console.log('\n── Backfill summary ──');
console.log(`  Groups processed:  ${groupsProcessed}`);
console.log(
  `  Rows updated:      ${rowsUpdated}${dryRun ? ' (dry-run)' : ''}`,
);
console.log(`  Rows left NULL:    ${rowsLeftNull}`);
