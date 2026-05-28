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
const LIMIT = process.env.LIMIT ? Number.parseInt(process.env.LIMIT, 10) : null;

// Guard against typos like FEED=silentboom (TAKE-IT AlertType spelling) — the
// dispatch below silently routes anything non-'lottery'/'both' to silent_boom,
// which would corrupt the wrong table. Mirrors scripts/takeit-rollback.mjs.
if (FEED !== 'both' && FEED !== 'lottery' && FEED !== 'silent_boom') {
  console.error(
    `Invalid FEED: "${FEED}". Expected 'lottery', 'silent_boom', or 'both'.`,
  );
  process.exit(1);
}
// 2000 rows keeps the in-memory updates[] array and the per-batch transaction
// payload small (~2000 x {id, prob, version} objects). At 10k+ the tagged-
// template objects in sql.transaction() become measurable; leave this at 2000
// unless profiled.
const BATCH_SIZE = 2000;

if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error(`Invalid SINCE format: "${SINCE}". Expected YYYY-MM-DD.`);
  process.exit(1);
}

if (LIMIT !== null && (Number.isNaN(LIMIT) || LIMIT <= 0)) {
  console.error(
    `Invalid LIMIT: "${process.env.LIMIT}". Expected a positive integer.`,
  );
  process.exit(1);
}

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
    //
    // NOTE: backfilled takeit_prob values will differ from live-cron values
    // for rows where sequential context would have been non-empty. For ML
    // training purposes, treat backfilled rows as "no-session-context" samples
    // — they are valid training data but not directly comparable to live scores.
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

      // Persist in a single transaction per batch.
      // Atomicity: if this transaction throws, none of the 2000 rows are updated.
      // Re-running the script is safe — WHERE takeit_prob IS NULL re-selects the
      // same batch from the same lastId checkpoint.
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
