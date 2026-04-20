#!/usr/bin/env node

/**
 * Backfill OHLC + asymmetric excursion columns on day_embeddings rows.
 *
 * Sources the data from the sidecar's /archive/day-summary-batch endpoint
 * (which emits structured open/high/low/close/range/up_excursion/
 * down_excursion alongside the existing text summary). Updates columns
 * added by migration #76 on pre-existing rows — the embedding vector
 * stays untouched. Skips rows that don't exist yet (those come from the
 * day_embeddings backfill); this script only fills in the numeric tail.
 *
 * Usage:
 *   source .env.local && node scripts/backfill-day-ohlc.mjs
 *
 * Optional env:
 *   BACKFILL_START  — YYYY-MM-DD (default 2010-06-07)
 *   BACKFILL_END    — YYYY-MM-DD (default yesterday UTC)
 *   SIDECAR_URL     — required
 *   DATABASE_URL    — required
 */

import process from 'node:process';

import { neon } from '@neondatabase/serverless';

const SIDECAR_URL = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL;
const START = process.env.BACKFILL_START ?? '2010-06-07';
const END =
  process.env.BACKFILL_END ??
  (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

for (const [k, v] of Object.entries({ SIDECAR_URL, DATABASE_URL })) {
  if (!v) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
}

const sql = neon(DATABASE_URL);

async function fetchBatch(fromIso, toIso) {
  const res = await fetch(
    `${SIDECAR_URL}/archive/day-summary-batch?from=${fromIso}&to=${toIso}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sidecar ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.rows ?? [];
}

async function updateMany(rows) {
  // Update existing day_embeddings rows. Rows that don't exist (holidays
  // and pre-existing-row gaps) silently no-op — the UPDATE's WHERE
  // clause filters them out.
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (r) => {
        // Only process rows with structured fields (post sidecar deploy).
        if (
          typeof r.open !== 'number' ||
          typeof r.high !== 'number' ||
          typeof r.low !== 'number' ||
          typeof r.close !== 'number'
        ) {
          return;
        }
        await sql`
          UPDATE day_embeddings SET
            day_open  = ${r.open},
            day_high  = ${r.high},
            day_low   = ${r.low},
            day_close = ${r.close},
            range_pt  = ${r.range},
            up_exc    = ${r.up_excursion},
            down_exc  = ${r.down_excursion}
          WHERE date = ${r.date}::date
        `;
      }),
    );
  }
}

function addMonthsClamped(fromIso, months, endIso) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  const candidate = d.toISOString().slice(0, 10);
  return candidate < endIso ? candidate : endIso;
}

async function handleRange(fromIso, toIso, counters) {
  try {
    const rows = await fetchBatch(fromIso, toIso);
    if (rows.length === 0) {
      counters.emptyChunks += 1;
      return;
    }
    await updateMany(rows);
    counters.fetched += rows.length;
  } catch (err) {
    counters.failed += 1;
    console.warn(`  ${fromIso}..${toIso}: ${err.message}`);
  }
}

function buildRanges(startIso, endIso) {
  const ranges = [];
  let cur = startIso;
  while (cur <= endIso) {
    const stop = addMonthsClamped(cur, 6, endIso);
    ranges.push([cur, stop]);
    if (stop === endIso) break;
    const next = new Date(new Date(`${stop}T00:00:00Z`).getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    if (next > endIso) break;
    cur = next;
  }
  return ranges;
}

async function main() {
  console.log(
    `Backfilling day_embeddings OHLC columns from ${START} through ${END}`,
  );
  const ranges = buildRanges(START, END);
  console.log(`  ${ranges.length} 6-month chunks\n`);

  const counters = { fetched: 0, failed: 0, emptyChunks: 0 };
  const startWall = Date.now();

  for (const [i, [from, to]] of ranges.entries()) {
    const chunkStart = Date.now();
    await handleRange(from, to, counters);
    const elapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
    const pct = (((i + 1) / ranges.length) * 100).toFixed(1);
    console.log(
      `  [${pct}%] ${from}..${to} ${elapsed}s — fetched=${counters.fetched} failed=${counters.failed}`,
    );
  }

  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n✓ Backfill complete in ${elapsed}s`);
  console.log(`  fetched:      ${counters.fetched}`);
  console.log(`  empty chunks: ${counters.emptyChunks}`);
  console.log(`  failed:       ${counters.failed}`);

  const [row] = await sql`
    SELECT COUNT(*)::int AS n
    FROM day_embeddings
    WHERE day_open IS NOT NULL
  `;
  console.log(`\n  day_embeddings rows with OHLC: ${row.n}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
