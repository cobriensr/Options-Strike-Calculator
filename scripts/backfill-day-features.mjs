#!/usr/bin/env node

/**
 * Backfill the day_features table (Phase C) from the engineered-vector
 * sidecar endpoint. Analogous to backfill-day-embeddings.mjs but:
 *
 *   - Uses /archive/day-features instead of /archive/day-summary
 *   - No OpenAI call (vector comes straight from the sidecar)
 *   - Writes to day_features (60-dim) not day_embeddings (2000-dim)
 *
 * Idempotent: re-running refreshes rows (useful when the feature set
 * version bumps). Skips weekends; skips dates the sidecar returns 404
 * for (holidays, halts, or insufficient first-hour bars).
 *
 * Usage:
 *   source .env.local && node scripts/backfill-day-features.mjs
 *
 * Optional env:
 *   BACKFILL_START  — YYYY-MM-DD (default 2010-06-07)
 *   BACKFILL_END    — YYYY-MM-DD (default yesterday UTC)
 *   SIDECAR_URL     — required
 *   DATABASE_URL    — required
 *   CONCURRENCY     — default 4 (sidecar DuckDB bottleneck means
 *                     higher values buy nothing until that's fixed)
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

const FEATURE_SET = 'first_hour_pct_change_v1';
const EXPECTED_DIM = 60;

for (const [k, v] of Object.entries({ SIDECAR_URL, DATABASE_URL })) {
  if (!v) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
}

const sql = neon(DATABASE_URL);

async function fetchBatch(fromIso, toIso) {
  // Single sidecar call returns ALL rows in [from, to]. Amortizes the
  // DuckDB Parquet scan over the whole chunk — typical throughput is
  // ~500-1000 rows/sec in the sidecar vs ~0.1 rows/sec per-date.
  const res = await fetch(
    `${SIDECAR_URL}/archive/day-features-batch?from=${fromIso}&to=${toIso}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sidecar ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.rows ?? [];
}

async function upsertMany(rows) {
  // Neon's serverless driver tops out at ~100 params per statement
  // comfortably, so batch by date. Each row has fixed params; 50 at
  // a time keeps us well under any limit and lets us recover from a
  // partial failure without redoing the whole chunk.
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (r) => {
        if (
          !Array.isArray(r.vector) ||
          r.vector.length !== EXPECTED_DIM ||
          !r.vector.every((v) => Number.isFinite(v))
        ) {
          return;
        }
        const vectorLiteral = `[${r.vector.join(',')}]`;
        await sql`
          INSERT INTO day_features
            (date, symbol, features, feature_set)
          VALUES (
            ${r.date}::date,
            ${r.symbol ?? 'ES'},
            ${vectorLiteral}::vector,
            ${FEATURE_SET}
          )
          ON CONFLICT (date) DO UPDATE SET
            symbol = EXCLUDED.symbol,
            features = EXCLUDED.features,
            feature_set = EXCLUDED.feature_set,
            created_at = NOW()
        `;
      }),
    );
  }
}

// Date arithmetic helper — add N months to a YYYY-MM-DD string, clamp
// to the overall end date, return YYYY-MM-DD.
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
    await upsertMany(rows);
    counters.upserted += rows.length;
  } catch (err) {
    counters.failed += 1;
    console.warn(`  ${fromIso}..${toIso}: ${err.message}`);
  }
}

// Build a list of 6-month [from, to] ranges spanning START → END.
// Small enough that each batched sidecar call stays snappy (<30s) and
// the 3-year cap on the batch endpoint is never touched. Sequential
// execution — the batched endpoint already does the parallelism we
// need internally; running ranges concurrently would just re-saturate
// the sidecar the way the per-row script did.
function buildRanges(startIso, endIso) {
  const ranges = [];
  let cur = startIso;
  while (cur <= endIso) {
    const stop = addMonthsClamped(cur, 6, endIso);
    ranges.push([cur, stop]);
    if (stop === endIso) break;
    // Next range starts the day after `stop` — no overlap, no gap.
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
    `Backfilling day_features from ${START} through ${END} (batched, 6-month chunks)`,
  );
  const ranges = buildRanges(START, END);
  console.log(`  ${ranges.length} 6-month chunks in range\n`);

  const counters = { upserted: 0, failed: 0, emptyChunks: 0 };
  const startWall = Date.now();

  for (const [i, [from, to]] of ranges.entries()) {
    const chunkStart = Date.now();
    await handleRange(from, to, counters);
    const elapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
    const pct = (((i + 1) / ranges.length) * 100).toFixed(1);
    console.log(
      `  [${pct}%] ${from}..${to} ${elapsed}s — upserted=${counters.upserted} failed=${counters.failed}`,
    );
  }

  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n✓ Backfill complete in ${elapsed}s`);
  console.log(`  upserted:     ${counters.upserted}`);
  console.log(`  empty chunks: ${counters.emptyChunks}`);
  console.log(`  failed:       ${counters.failed}`);

  const [row] = await sql`SELECT COUNT(*)::int AS n FROM day_features`;
  console.log(`\n  day_features rows in DB: ${row.n}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
