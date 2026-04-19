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
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '4', 10);
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

function* weekdaysBetween(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) {
      yield cur.toISOString().slice(0, 10);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function fetchFeatures(dateIso) {
  const res = await fetch(
    `${SIDECAR_URL}/archive/day-features?date=${dateIso}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.vector && body.vector.length === EXPECTED_DIM
    ? body.vector
    : null;
}

async function fetchSymbol(dateIso) {
  // Symbol isn't in the features response — peek the summary endpoint
  // once per date to grab it. Tiny cost; sidecar caches its DuckDB plan.
  const res = await fetch(`${SIDECAR_URL}/archive/day-summary?date=${dateIso}`);
  if (!res.ok) return 'ES';
  const body = await res.json();
  const parts = (body.summary ?? '').split(' ');
  return parts[1] ?? 'ES';
}

async function upsert(date, symbol, vector) {
  const vectorLiteral = `[${vector.join(',')}]`;
  await sql`
    INSERT INTO day_features
      (date, symbol, features, feature_set)
    VALUES (
      ${date}::date,
      ${symbol},
      ${vectorLiteral}::vector,
      ${FEATURE_SET}
    )
    ON CONFLICT (date) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      features = EXCLUDED.features,
      feature_set = EXCLUDED.feature_set,
      created_at = NOW()
  `;
}

async function handleOne(date, counters) {
  try {
    const vector = await fetchFeatures(date);
    if (!vector) {
      counters.skippedMissing += 1;
      return;
    }
    const symbol = await fetchSymbol(date);
    await upsert(date, symbol, vector);
    counters.upserted += 1;
  } catch (err) {
    counters.failed += 1;
    console.warn(`  ${date}: ${err.message}`);
  }
}

async function runPool(dates, concurrency, counters) {
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= dates.length) return;
    await handleOne(dates[i], counters);
    const done = counters.upserted + counters.skippedMissing + counters.failed;
    if (done % 100 === 0) {
      const pct = ((done / dates.length) * 100).toFixed(1);
      console.log(
        `  [${pct}%] upserted=${counters.upserted} skipped=${counters.skippedMissing} failed=${counters.failed}`,
      );
    }
    await next();
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, dates.length) }, next),
  );
}

async function main() {
  console.log(
    `Backfilling day_features from ${START} through ${END} (concurrency=${CONCURRENCY})`,
  );
  const dates = [...weekdaysBetween(START, END)];
  console.log(`  ${dates.length} weekdays in range\n`);

  const counters = { upserted: 0, skippedMissing: 0, failed: 0 };
  const startWall = Date.now();
  await runPool(dates, CONCURRENCY, counters);
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);

  console.log(`\n✓ Backfill complete in ${elapsed}s`);
  console.log(`  upserted:         ${counters.upserted}`);
  console.log(`  skipped (no data): ${counters.skippedMissing}`);
  console.log(`  failed:           ${counters.failed}`);

  const [row] = await sql`SELECT COUNT(*)::int AS n FROM day_features`;
  console.log(`\n  day_features rows in DB: ${row.n}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
