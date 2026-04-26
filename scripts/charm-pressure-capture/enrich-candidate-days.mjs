#!/usr/bin/env node
/**
 * Enrich candidate-days.csv with SPX-equivalent daily OHLC + regime
 * classification, from the `day_embeddings` table (ES front-month, used as
 * an SPX proxy — daily range/direction is functionally identical).
 *
 *   node --env-file=.env.local scripts/charm-pressure-capture/enrich-candidate-days.mjs
 *
 * Reads:  scripts/charm-pressure-capture/candidate-days.csv
 * Writes: scripts/charm-pressure-capture/candidate-days.csv (in place)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'candidate-days.csv');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL not set. Run with: node --env-file=.env.local ...',
  );
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pull daily OHLC from two sources, then unify by date:
//
//   1. `day_embeddings` (ES front-month, parquet-fed via the Railway
//      sidecar) — covers most of the study window but lags ~7 days behind
//      live because the parquet archive is only refreshed when a fresh
//      Databento batch is converted and uploaded.
//
//   2. `spx_candles_1m` (SPX cash, Schwab streaming feed → Postgres) —
//      covers the trailing ~2 months and has no parquet dependency.
//
// `day_embeddings` wins where present (longer history, ES-consistent with
// existing analog-retrieval embeddings); `spx_candles_1m` aggregate fills
// in any date the parquet hasn't caught up to. We accept that the tail
// (Postgres-fed) days use SPX prices instead of ES — daily *range* is
// what regime classification depends on, and ES vs SPX range differs by
// only ~1-3 points on most days.
//
// `prev_close` is computed in JS over the unified, date-sorted set so
// LAG works correctly across the source boundary.
// ---------------------------------------------------------------------------

// Source 1: day_embeddings (filter spread rows so LAG-able).
const dayEmbedRows = await sql`
  SELECT
    date::text                                   AS date,
    day_open                                     AS spx_open,
    day_high                                     AS spx_high,
    day_low                                      AS spx_low,
    day_close                                    AS spx_close,
    range_pt                                     AS realized_range_dollars,
    vix_bucket                                   AS vix_bucket,
    'day_embeddings'                             AS source
  FROM day_embeddings
  WHERE date >= '2024-06-01' AND date <= '2026-04-24'
    AND symbol NOT LIKE '%-%'
  ORDER BY date
`;

// Source 2: spx_candles_1m, aggregated to daily OHLC for any dates the
// first source didn't cover. Restrict to regular-hours bars so open/close
// match the cash session.
const haveDates = new Set(dayEmbedRows.map((r) => r.date));
const spxAggRows = await sql`
  WITH ranked AS (
    SELECT
      date,
      timestamp,
      open, high, low, close,
      ROW_NUMBER() OVER (PARTITION BY date ORDER BY timestamp ASC)  AS first_idx,
      ROW_NUMBER() OVER (PARTITION BY date ORDER BY timestamp DESC) AS last_idx
    FROM spx_candles_1m
    WHERE date >= '2024-06-01' AND date <= '2026-04-24'
      AND market_time = 'r'
  )
  SELECT
    date::text                                            AS date,
    MAX(CASE WHEN first_idx = 1 THEN open END)::float8    AS spx_open,
    MAX(high)::float8                                     AS spx_high,
    MIN(low)::float8                                      AS spx_low,
    MAX(CASE WHEN last_idx = 1 THEN close END)::float8    AS spx_close,
    (MAX(high) - MIN(low))::float8                        AS realized_range_dollars,
    NULL::text                                            AS vix_bucket,
    'spx_candles_1m'                                      AS source
  FROM ranked
  GROUP BY date
  ORDER BY date
`;

const fillRows = spxAggRows.filter((r) => !haveDates.has(r.date));

// Merge + sort to compute prev_close coherently across the boundary.
const merged = [...dayEmbedRows, ...fillRows].sort((a, b) =>
  a.date.localeCompare(b.date),
);
let prev = null;
for (const r of merged) {
  r.spx_prev_close = prev;
  prev = Number(r.spx_close);
}

const byDate = new Map();
for (const r of merged) byDate.set(r.date, r);

console.log(
  `Sources: ${dayEmbedRows.length} from day_embeddings + ${fillRows.length} from spx_candles_1m = ${merged.length} total`,
);

// ---------------------------------------------------------------------------
// Read candidate CSV
// ---------------------------------------------------------------------------

const text = readFileSync(csvPath, 'utf8');
const lines = text.split('\n').filter((l) => l.length > 0);
const header = lines[0].split(',');
const dataLines = lines.slice(1).map((l) => l.split(','));

const idx = (col) => header.indexOf(col);

console.log(`Read ${dataLines.length} candidate-day rows`);

// ---------------------------------------------------------------------------
// Compute regime cutoffs from non-event days only
// ---------------------------------------------------------------------------

const isEventIdx = idx('is_event');
const dateIdx = idx('date');

const nonEventRanges = [];
for (const r of dataLines) {
  if (r[isEventIdx] === '1') continue;
  const src = byDate.get(r[dateIdx]);
  if (!src || src.realized_range_dollars == null || src.spx_prev_close == null)
    continue;
  const range = Number(src.realized_range_dollars);
  const prev = Number(src.spx_prev_close);
  if (!Number.isFinite(range) || !Number.isFinite(prev) || prev <= 0) continue;
  nonEventRanges.push((range / prev) * 100);
}

nonEventRanges.sort((a, b) => a - b);
const p33 = nonEventRanges[Math.floor(nonEventRanges.length * 0.33)];
const p67 = nonEventRanges[Math.floor(nonEventRanges.length * 0.67)];

console.log(
  `Non-event range_pct percentiles: p33=${p33?.toFixed(3)}, p67=${p67?.toFixed(3)} ` +
    `(n=${nonEventRanges.length})`,
);

// ---------------------------------------------------------------------------
// Fill in price + regime columns
// ---------------------------------------------------------------------------

const fillCols = {
  spx_open: idx('spx_open'),
  spx_high: idx('spx_high'),
  spx_low: idx('spx_low'),
  spx_close: idx('spx_close'),
  spx_prev_close: idx('spx_prev_close'),
  realized_range_dollars: idx('realized_range_dollars'),
  realized_range_pct: idx('realized_range_pct'),
  regime: idx('regime'),
};

let enriched = 0;
let missing = 0;

const clearRow = (r) => {
  for (const c of Object.values(fillCols)) r[c] = '';
};

for (const r of dataLines) {
  const src = byDate.get(r[dateIdx]);
  if (!src) {
    clearRow(r);
    missing += 1;
    continue;
  }
  const open = Number(src.spx_open);
  const high = Number(src.spx_high);
  const low = Number(src.spx_low);
  const close = Number(src.spx_close);
  const prev = Number(src.spx_prev_close);
  const range = Number(src.realized_range_dollars);

  if ([open, high, low, close, prev, range].some((v) => !Number.isFinite(v))) {
    clearRow(r);
    missing += 1;
    continue;
  }

  const rangePct = (range / prev) * 100;

  let regime;
  if (r[isEventIdx] === '1') {
    regime = 'event';
  } else if (rangePct <= p33) {
    regime = 'range_bound';
  } else if (rangePct >= p67) {
    regime = 'trending';
  } else {
    regime = 'mixed';
  }

  r[fillCols.spx_open] = open.toFixed(2);
  r[fillCols.spx_high] = high.toFixed(2);
  r[fillCols.spx_low] = low.toFixed(2);
  r[fillCols.spx_close] = close.toFixed(2);
  r[fillCols.spx_prev_close] = prev.toFixed(2);
  r[fillCols.realized_range_dollars] = range.toFixed(2);
  r[fillCols.realized_range_pct] = rangePct.toFixed(3);
  r[fillCols.regime] = regime;

  enriched += 1;
}

// ---------------------------------------------------------------------------
// Write back
// ---------------------------------------------------------------------------

const out = [header.join(','), ...dataLines.map((r) => r.join(','))].join('\n');
writeFileSync(csvPath, `${out}\n`);

console.log('');
console.log(`Enriched: ${enriched} rows`);
console.log(
  `Missing:  ${missing} rows (no day_embeddings match — likely most recent days)`,
);
console.log('');

// Regime distribution
const regimeCounts = {};
for (const r of dataLines) {
  const reg = r[fillCols.regime] || '(blank)';
  regimeCounts[reg] = (regimeCounts[reg] ?? 0) + 1;
}
console.log('Regime distribution:');
for (const [k, v] of Object.entries(regimeCounts).sort()) {
  console.log(`  ${k.padEnd(15)} ${v}`);
}
