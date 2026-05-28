// scripts/backfill-takeit-scores.mjs
//
// Backfill takeit_prob on historical rows by re-using the production
// scoring code path. Idempotent (WHERE takeit_prob IS NULL), resumable,
// batched. Run via:
//   make takeit-backfill
//   make takeit-backfill FEED=lottery
//   make takeit-backfill FEED=silent_boom SINCE=2026-03-01 LIMIT=10000
//
// Pre-flight: source .env.local for DATABASE_URL + BLOB_READ_WRITE_TOKEN.
//
// Invocation: npx tsx scripts/backfill-takeit-scores.mjs
// (tsx required — imports api/_lib/*.ts TypeScript source directly;
//  no compiled .js files exist in this repo. Precedent: all scripts/*.ts
//  files that import api/_lib use tsx, e.g. replay-silent-boom-2026-05-20.ts)

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  scoreLottery,
  scoreSilentBoom,
  loadTakeitDetectContext,
} from '../api/_lib/takeit-detect.ts';

dotenvConfig({ path: '.env.local' });

const FEED = process.env.FEED ?? 'both';
const SINCE = process.env.SINCE ?? null; // YYYY-MM-DD
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const BATCH_SIZE = 2000;

const sql = neon(process.env.DATABASE_URL);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.resolve('scripts/output', `backfill-takeit-${runId}.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
};

async function main() {
  const feeds = FEED === 'both' ? ['lottery', 'silent_boom'] : [FEED];

  for (const feed of feeds) {
    // loadTakeitDetectContext uses the AlertType discriminant (no underscore).
    const ctxKey = feed === 'lottery' ? 'lottery' : 'silentboom';

    // For historical backfill the sequential-context window (recent same-type
    // fires, cross-type co-fires, prior-session win rates) cannot be
    // reconstructed accurately from NOW() queries. Stubs return empty arrays
    // so sequential features resolve to 0 / null — correct for retrospective
    // ML analysis. The bundle + row-level features are unchanged.
    const ctx = await loadTakeitDetectContext(ctxKey, {
      fetchRecentSameType: async () => [],
      fetchRecentOtherTypeByChain: async () => [],
      fetchPriorSessionWinRateByTicker: async () => [],
    });

    if (!ctx) {
      log(`${feed}: no bundle available, skipping`);
      continue;
    }
    log(
      `${feed}: bundle version=${ctx.bundle.version} schema=${ctx.bundle.xgb_json_schema}`,
    );

    const table =
      feed === 'lottery' ? 'lottery_finder_fires' : 'silent_boom_alerts';
    const scoreFn = feed === 'lottery' ? scoreLottery : scoreSilentBoom;

    let totalScored = 0;
    let totalNull = 0;
    let lastId = 0;

    while (true) {
      const where = [
        `takeit_prob IS NULL`,
        `id > ${lastId}`,
        SINCE ? `date >= '${SINCE}'::date` : null,
      ]
        .filter(Boolean)
        .join(' AND ');

      const batch = await sql.unsafe(
        `SELECT * FROM ${table} WHERE ${where} ORDER BY id LIMIT ${BATCH_SIZE}`,
      );
      if (!batch.length) {
        log(`${feed}: no more rows, done`);
        break;
      }
      log(
        `${feed}: batch of ${batch.length} rows starting at id=${batch[0].id}`,
      );

      const updates = [];
      for (const row of batch) {
        const { prob, version } = scoreFn(ctx, row);
        if (prob == null) {
          totalNull += 1;
        } else {
          totalScored += 1;
        }
        updates.push({ id: row.id, prob, version });
      }

      // Persist in a single transaction per batch
      await sql.transaction(
        updates.map(
          (u) => sql`
            UPDATE ${sql.unsafe(table)}
            SET takeit_prob = ${u.prob},
                takeit_model_version = ${u.version}
            WHERE id = ${u.id}
          `,
        ),
      );

      lastId = batch[batch.length - 1].id;
      log(
        `${feed}: progress scored=${totalScored} null=${totalNull} lastId=${lastId}`,
      );

      if (LIMIT && totalScored + totalNull >= LIMIT) {
        log(`${feed}: hit LIMIT=${LIMIT}, stopping`);
        break;
      }
    }
    log(`${feed}: COMPLETE scored=${totalScored} null=${totalNull}`);
  }

  log(`backfill done. log: ${logPath}`);
}

try {
  await main();
} catch (err) {
  log(
    `Backfill failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
}
