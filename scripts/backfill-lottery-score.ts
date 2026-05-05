/**
 * One-shot backfill for lottery_finder_fires.score (migration #126).
 *
 * Reads every row where score IS NULL, runs the canonical
 * `computeLotteryScore` from `api/_lib/lottery-score-weights.ts`
 * against the same columns the cron uses (underlying_symbol, mode,
 * entry_price, tod, option_type), and bulk-updates in batches.
 *
 * Zero drift: imports the production scoring function directly.
 *
 * Usage:
 *   npx tsx scripts/backfill-lottery-score.ts
 *   npx tsx scripts/backfill-lottery-score.ts --dry-run
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { computeLotteryScore } from '../api/_lib/lottery-score-weights.ts';
import type {
  LotteryMode,
  TimeOfDay,
} from '../api/_lib/lottery-finder.ts';

loadEnv({ path: '.env.local' });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL (run `vercel env pull .env.local`).');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

interface FireRow {
  id: number;
  underlying_symbol: string;
  mode: LotteryMode;
  entry_price: string; // neon returns NUMERIC as string
  tod: TimeOfDay;
  option_type: 'C' | 'P';
}

async function main() {
  const sql = neon(DATABASE_URL!);

  const totalRow = (await sql`
    SELECT COUNT(*)::int AS n FROM lottery_finder_fires WHERE score IS NULL
  `) as Array<{ n: number }>;
  const total = totalRow[0]?.n ?? 0;
  console.log(
    `[backfill-lottery-score] ${total} row(s) with score IS NULL` +
      (dryRun ? ' (dry run)' : ''),
  );
  if (total === 0) return;

  // Pull all candidate rows up front — score depends on stable columns,
  // so a single SELECT is fine. Memory for 100k rows of 6 fields is
  // trivial. We page the UPDATEs, not the SELECT.
  const rows = (await sql`
    SELECT id, underlying_symbol, mode, entry_price, tod, option_type
    FROM lottery_finder_fires
    WHERE score IS NULL
    ORDER BY id
  `) as FireRow[];

  // Distribution log so the user can sanity-check tier counts before
  // committing — same buckets the UI uses.
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0 };
  const updates = rows.map((r) => {
    const score = computeLotteryScore({
      ticker: r.underlying_symbol,
      mode: r.mode,
      entryPrice: Number.parseFloat(r.entry_price),
      tod: r.tod,
      optionType: r.option_type,
    });
    if (score >= 18) tierCounts.tier1 += 1;
    else if (score >= 12) tierCounts.tier2 += 1;
    else tierCounts.tier3 += 1;
    return { id: r.id, score };
  });

  console.log(
    `[backfill-lottery-score] tier distribution: tier1=${tierCounts.tier1} ` +
      `tier2=${tierCounts.tier2} tier3=${tierCounts.tier3}`,
  );

  if (dryRun) {
    console.log('[backfill-lottery-score] dry run, no writes performed.');
    return;
  }

  // Batch update via VALUES table — one round-trip per BATCH_SIZE
  // rows beats per-row UPDATEs. Cast to int explicitly so unnest()
  // infers correct types for the JOIN.
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const ids = batch.map((u) => u.id);
    const scores = batch.map((u) => u.score);
    await sql`
      UPDATE lottery_finder_fires AS f
      SET score = v.score
      FROM (
        SELECT id::int AS id, score::int AS score
        FROM unnest(
          ${ids}::int[],
          ${scores}::int[]
        ) AS t(id, score)
      ) AS v
      WHERE f.id = v.id
    `;
    written += batch.length;
    console.log(
      `[backfill-lottery-score] updated ${written}/${updates.length}`,
    );
  }

  // Sanity check — re-read the NULL count.
  const remainingRow = (await sql`
    SELECT COUNT(*)::int AS n FROM lottery_finder_fires WHERE score IS NULL
  `) as Array<{ n: number }>;
  const remaining = remainingRow[0]?.n ?? 0;
  if (remaining !== 0) {
    console.error(
      `[backfill-lottery-score] WARN: ${remaining} row(s) still NULL after update`,
    );
    process.exit(1);
  }
  console.log('[backfill-lottery-score] done.');
}

main().catch((err) => {
  console.error('[backfill-lottery-score] failed:', err);
  process.exit(1);
});
