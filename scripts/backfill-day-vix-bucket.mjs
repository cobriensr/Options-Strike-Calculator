#!/usr/bin/env node

/**
 * Populate the vix_bucket column on day_embeddings rows from the
 * static VIX OHLC file in public/vix-data.json. Buckets use fixed
 * thresholds on VIX close:
 *    low      < 15
 *    normal   15 ≤ VIX < 22
 *    elevated 22 ≤ VIX < 30
 *    crisis   ≥ 30
 *
 * Rows where VIX isn't in the JSON (weekends, pre-1990 backfills)
 * stay NULL; the forecast module treats NULL as "no regime data,
 * fall back to unstratified cohort".
 *
 * Bulk-update strategy: one CASE statement per chunk of dates so we
 * keep the number of round-trips to Neon small AND avoid the serverless
 * driver's concurrent-statement memory ceiling that a per-row Promise.all
 * hits with ~9000 rows.
 *
 * Idempotent — safe to re-run.
 *
 * Usage: source .env.local && node scripts/backfill-day-vix-bucket.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}
const sql = neon(DATABASE_URL);

function bucketOf(close) {
  if (close < 15) return 'low';
  if (close < 22) return 'normal';
  if (close < 30) return 'elevated';
  return 'crisis';
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const vixPath = resolve(scriptDir, '..', 'public', 'vix-data.json');
  const raw = JSON.parse(readFileSync(vixPath, 'utf8'));

  const entries = Object.entries(raw)
    .map(([date, ohlc]) => {
      const close = Number(ohlc.close ?? ohlc.c);
      return Number.isFinite(close) ? { date, bucket: bucketOf(close) } : null;
    })
    .filter(Boolean);

  console.log(`Backfilling vix_bucket for ${entries.length} VIX dates`);

  // Sequential chunks — each issues ONE UPDATE ... FROM VALUES statement
  // with CHUNK rows baked into the VALUES list. 500 rows per UPDATE keeps
  // the server-side plan tree modest (no per-row query replans) and
  // takes ~20 round-trips instead of 9000.
  const CHUNK = 500;
  let updated = 0;
  const startWall = Date.now();
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const dates = slice.map((e) => e.date);
    const buckets = slice.map((e) => e.bucket);
    // UNNEST-with-zip is the Postgres idiom for bulk UPDATE against a
    // paired-array VALUES set without needing a temp table.
    const rows = await sql`
      UPDATE day_embeddings d
      SET vix_bucket = v.bucket
      FROM (
        SELECT unnest(${dates}::date[]) AS date,
               unnest(${buckets}::text[]) AS bucket
      ) v
      WHERE d.date = v.date
      RETURNING d.date
    `;
    updated += rows.length;
    const pct = (Math.min(i + CHUNK, entries.length) / entries.length) * 100;
    console.log(
      `  [${pct.toFixed(1)}%] chunk ${Math.floor(i / CHUNK) + 1} — rows updated this batch: ${rows.length} (total: ${updated})`,
    );
  }

  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n✓ Backfill complete in ${elapsed}s`);
  console.log(`  rows updated: ${updated}`);

  const [byBucket] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE vix_bucket = 'low')      AS low,
      COUNT(*) FILTER (WHERE vix_bucket = 'normal')   AS normal,
      COUNT(*) FILTER (WHERE vix_bucket = 'elevated') AS elevated,
      COUNT(*) FILTER (WHERE vix_bucket = 'crisis')   AS crisis,
      COUNT(*) FILTER (WHERE vix_bucket IS NULL)      AS null_count
    FROM day_embeddings
  `;
  console.log(
    `  distribution: low=${byBucket.low} normal=${byBucket.normal} elevated=${byBucket.elevated} crisis=${byBucket.crisis} null=${byBucket.null_count}`,
  );
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
