#!/usr/bin/env node

/**
 * Backfill the day_embeddings table from the 16-year ES archive.
 *
 * Uses the LEAKAGE-FREE prediction summary endpoint
 * (/archive/day-summary-prediction-batch) — fields only include
 * first-hour data (open, 1h delta, 1h high/low/range/vol). The EOD
 * close is intentionally omitted so embeddings don't carry future
 * information into analog retrieval.
 *
 * Pipeline:
 *   1. Fetch summaries in 6-month chunks (one batched sidecar call
 *      per chunk — single DuckDB scan vs N cold scans).
 *   2. Embed 100 summaries per OpenAI call (model accepts arrays).
 *   3. Upsert rows to Neon in parallel.
 *
 * Skips weekends + dates with no ES bars + dates with <10 first-hour
 * bars (sparse/halt days). Idempotent via ON CONFLICT DO UPDATE so
 * re-running refreshes existing rows.
 *
 * Usage:
 *   source .env.local && node scripts/backfill-day-embeddings.mjs
 *
 * Optional env:
 *   BACKFILL_START  — YYYY-MM-DD (default 2010-06-07)
 *   BACKFILL_END    — YYYY-MM-DD (default yesterday UTC)
 *   SIDECAR_URL     — required
 *   OPENAI_API_KEY  — required
 *   DATABASE_URL    — required (Neon Postgres)
 */

import process from 'node:process';

import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

// ── Config ─────────────────────────────────────────────────────────

const SIDECAR_URL = process.env.SIDECAR_URL?.trim().replace(/\/$/, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
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
const EMBED_BATCH_SIZE = 100;

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

function addMonthsClamped(fromIso, months, endIso) {
  const d = new Date(`${fromIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  const candidate = d.toISOString().slice(0, 10);
  return candidate < endIso ? candidate : endIso;
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

async function fetchSummariesBatch(fromIso, toIso) {
  const res = await fetch(
    `${SIDECAR_URL}/archive/day-summary-prediction-batch?from=${fromIso}&to=${toIso}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sidecar ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.rows ?? [];
}

async function embedBatch(texts) {
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMS,
  });
  return r.data.map((d) => d.embedding);
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

async function handleRange(fromIso, toIso, counters) {
  const rows = await fetchSummariesBatch(fromIso, toIso);
  if (rows.length === 0) {
    counters.emptyChunks += 1;
    return;
  }

  // Embed in sub-chunks of EMBED_BATCH_SIZE (OpenAI accepts arrays).
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const slice = rows.slice(i, i + EMBED_BATCH_SIZE);
    const texts = slice.map((r) => r.summary);
    let embeddings;
    try {
      embeddings = await embedBatch(texts);
    } catch (err) {
      counters.failed += slice.length;
      console.warn(`  ${fromIso}..${toIso} embed batch failed: ${err.message}`);
      continue;
    }

    if (embeddings.length !== slice.length) {
      counters.failed += slice.length;
      console.warn(
        `  embed returned ${embeddings.length} vectors for ${slice.length} inputs`,
      );
      continue;
    }

    await Promise.all(
      slice.map(async (r, j) => {
        const vec = embeddings[j];
        if (!vec || vec.length !== EMBEDDING_DIMS) {
          counters.failed += 1;
          return;
        }
        try {
          await upsert(r.date, r.symbol ?? 'ES', r.summary, vec);
          counters.upserted += 1;
        } catch (err) {
          counters.failed += 1;
          console.warn(`  ${r.date}: ${err.message}`);
        }
      }),
    );
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Backfilling day_embeddings (prediction summary) from ${START} through ${END}`,
  );
  const ranges = buildRanges(START, END);
  console.log(`  ${ranges.length} 6-month chunks\n`);

  const counters = { upserted: 0, failed: 0, emptyChunks: 0 };
  const startWall = Date.now();

  for (const [i, [from, to]] of ranges.entries()) {
    const t0 = Date.now();
    try {
      await handleRange(from, to, counters);
    } catch (err) {
      counters.failed += 1;
      console.warn(`  ${from}..${to} range failed: ${err.message}`);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const pct = (((i + 1) / ranges.length) * 100).toFixed(1);
    console.log(
      `  [${pct}%] ${from}..${to} ${elapsed}s — upserted=${counters.upserted} failed=${counters.failed}`,
    );
  }

  const totalElapsed = ((Date.now() - startWall) / 1000).toFixed(1);
  console.log(`\n✓ Backfill complete in ${totalElapsed}s`);
  console.log(`  upserted:     ${counters.upserted}`);
  console.log(`  empty chunks: ${counters.emptyChunks}`);
  console.log(`  failed:       ${counters.failed}`);

  const [row] = await sql`SELECT COUNT(*)::int AS n FROM day_embeddings`;
  console.log(`\n  day_embeddings rows in DB: ${row.n}`);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
