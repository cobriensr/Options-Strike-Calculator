#!/usr/bin/env node

/**
 * Backfill the day_embeddings table from the 16-year ES archive.
 *
 * Walks every weekday from 2010-06-07 through yesterday and for each
 * one:
 *   1. Fetches the canonical summary from the sidecar's
 *      /archive/day-summary endpoint.
 *   2. Embeds it via OpenAI text-embedding-3-large (2000 dims).
 *   3. UPSERTs into day_embeddings.
 *
 * Skips:
 *   - Weekends (no trading).
 *   - Dates the sidecar returns 404 for (market holidays, converter-
 *     missing data, or the single archive-boundary day).
 *
 * Idempotent: re-running against a populated table refreshes rows
 * (useful when the summary format changes). ~4000 days × 1 OpenAI
 * call each = ~$0.05 at list price; a few minutes of wall clock.
 *
 * Usage:
 *   source .env.local && node scripts/backfill-day-embeddings.mjs
 *
 * Optional env:
 *   BACKFILL_START  — YYYY-MM-DD (default: 2010-06-07)
 *   BACKFILL_END    — YYYY-MM-DD (default: yesterday in UTC)
 *   SIDECAR_URL     — required (typically set in .env.local for Vercel)
 *   OPENAI_API_KEY  — required
 *   DATABASE_URL    — required (Neon Postgres)
 *   CONCURRENCY     — parallel API calls (default 4)
 */

import process from 'node:process';

import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

// ── Config ─────────────────────────────────────────────────────────

const SIDECAR_URL = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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

const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMS = 2000;

for (const [k, v] of Object.entries({
  SIDECAR_URL,
  OPENAI_API_KEY,
  DATABASE_URL,
})) {
  if (!v) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sql = neon(DATABASE_URL);

// ── Helpers ────────────────────────────────────────────────────────

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

async function fetchSummary(dateIso) {
  const res = await fetch(`${SIDECAR_URL}/archive/day-summary?date=${dateIso}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.summary ?? null;
}

async function embed(text) {
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMS,
  });
  return r.data[0]?.embedding ?? null;
}

async function upsert(date, symbol, summary, embedding) {
  const vectorLiteral = `[${embedding.join(',')}]`;
  await sql`
    INSERT INTO day_embeddings
      (date, symbol, summary, embedding, embedding_model)
    VALUES (
      ${date}::date,
      ${symbol},
      ${summary},
      ${vectorLiteral}::vector,
      ${EMBEDDING_MODEL}
    )
    ON CONFLICT (date) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      summary = EXCLUDED.summary,
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      created_at = NOW()
  `;
}

async function handleOne(date, counters) {
  try {
    const summary = await fetchSummary(date);
    if (!summary) {
      counters.skippedMissing += 1;
      return;
    }
    // The canonical summary starts with "YYYY-MM-DD SYM | ...".
    const parts = summary.split(' ');
    const symbol = parts[1] ?? 'ES';
    const embedding = await embed(summary);
    if (!embedding || embedding.length !== EMBEDDING_DIMS) {
      counters.failed += 1;
      console.warn(`  ${date}: embed returned unexpected shape`);
      return;
    }
    await upsert(date, symbol, summary, embedding);
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

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Backfilling day_embeddings from ${START} through ${END} (concurrency=${CONCURRENCY})`,
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

  const [row] = await sql`SELECT COUNT(*)::int AS n FROM day_embeddings`;
  console.log(`\n  day_embeddings rows in DB: ${row.n}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
