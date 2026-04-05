#!/usr/bin/env node

/**
 * Backfill analysis embeddings for historical analysis retrieval.
 *
 * Fetches all entry-mode analyses that lack an analysis_embedding,
 * joins with market_snapshots (for regime context) and outcomes
 * (for settlement/correctness), builds a structured summary, generates
 * a 2000-d embedding via OpenAI, and stores it on the analyses row.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... DATABASE_URL="postgresql://..." node scripts/backfill-analysis-embeddings.mjs
 *   node scripts/backfill-analysis-embeddings.mjs --dry-run    # build summaries, skip embedding + DB writes
 *   node scripts/backfill-analysis-embeddings.mjs --all        # include midday/review (default: entry only)
 *   node scripts/backfill-analysis-embeddings.mjs --force      # re-embed even if embedding already exists
 */

import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Parse args ──────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const allModes = rawArgs.includes('--all');
const force = rawArgs.includes('--force');

if (dryRun)
  console.log(
    'DRY RUN — will build summaries but skip embedding + DB writes\n',
  );
if (allModes) console.log('Including all modes (entry, midday, review)\n');
if (force)
  console.log('FORCE — re-embedding analyses that already have embeddings\n');

// ── Build summary (mirrors buildAnalysisSummary in embeddings.ts) ──

function buildSummary(row) {
  const parts = [];

  // Market state
  parts.push(`date:${row.date}`);
  parts.push(`mode:${row.mode}`);
  if (row.vix != null) parts.push(`VIX:${row.vix}`);
  if (row.vix1d != null) parts.push(`VIX1D:${row.vix1d}`);
  if (row.spx != null) parts.push(`SPX:${row.spx}`);
  if (row.vix_term_signal) parts.push(`term:${row.vix_term_signal}`);
  if (row.regime_zone) parts.push(`GEX:${row.regime_zone}`);
  if (row.dow_label) parts.push(`dow:${row.dow_label}`);

  // Recommendation
  parts.push(`structure:${row.structure}`);
  if (row.suggested_delta != null) parts.push(`delta:${row.suggested_delta}`);
  parts.push(`confidence:${row.confidence}`);
  if (row.hedge) parts.push(`hedge:${row.hedge}`);

  // Outcome (from outcomes table + review in full_response)
  if (row.settlement != null) parts.push(`settlement:${row.settlement}`);
  if (row.was_correct != null)
    parts.push(`correct:${row.was_correct ? 'yes' : 'no'}`);

  return parts.join(' | ');
}

// ── Generate embedding ──────────────────────────────────────

async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-large',
    input: text,
    dimensions: 2000,
  });
  return response.data[0]?.embedding ?? null;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Fetch analyses with optional joins
  const modeFilter = allModes ? '' : "AND a.mode = 'entry'";
  const embeddingFilter = force ? '' : 'AND a.analysis_embedding IS NULL';

  const rows = await sql.unsafe(`
    SELECT
      a.id,
      TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
      a.mode,
      a.structure,
      a.confidence,
      a.suggested_delta,
      a.spx,
      a.vix,
      a.vix1d,
      a.hedge,
      a.entry_time,
      -- Snapshot context (may be NULL if no snapshot linked)
      ms.vix_term_signal,
      ms.regime_zone,
      ms.dow_label,
      -- Outcome (may be NULL if no outcome yet)
      o.settlement,
      -- wasCorrect from review in full_response
      (a.full_response->'review'->>'wasCorrect')::boolean AS was_correct
    FROM analyses a
    LEFT JOIN market_snapshots ms ON ms.id = a.snapshot_id
    LEFT JOIN outcomes o ON o.date = a.date
    WHERE 1=1
      ${modeFilter}
      ${embeddingFilter}
    ORDER BY a.date ASC, a.created_at ASC
  `);

  console.log(`Found ${rows.length} analyses to process\n`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const summary = buildSummary(row);
    const label = `[${row.date} ${row.mode} ${row.entry_time}]`;

    if (dryRun) {
      console.log(`${label} ${summary}`);
      skipped++;
      continue;
    }

    try {
      const embedding = await generateEmbedding(summary);
      if (!embedding) {
        console.error(`${label} Embedding returned null — skipping`);
        failed++;
        continue;
      }

      const vectorLiteral = `[${embedding.join(',')}]`;
      await sql.unsafe(
        `UPDATE analyses
         SET analysis_embedding = $1::vector
         WHERE id = $2`,
        [vectorLiteral, row.id],
      );

      console.log(`${label} ✓ ${summary.slice(0, 80)}...`);
      success++;

      // Rate limit: OpenAI embedding API has generous limits but be polite
      if (success % 10 === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`${label} ✗ ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone: ${success} embedded, ${failed} failed, ${skipped} skipped`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
