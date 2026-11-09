/**
 * Local backfill of `market_internals` ($TICK, $ADD, $VOLD, $TRIN) from
 * Schwab's SETTLED 1-minute bars (spec:
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md, P0.5 and Tier 2).
 * The logic is in scripts/_lib/market-internals-backfill.ts, which uses the
 * same code as the post-close cron (api/_lib/market-internals-settle.ts).
 *
 *   npx tsx scripts/backfill-market-internals.ts                     # dry run, the cron's last 5 sessions
 *   npx tsx scripts/backfill-market-internals.ts --from 2026-09-21   # dry run, 09-21 to the newest session
 *   npx tsx scripts/backfill-market-internals.ts --from 2026-09-21 --to 2026-10-30 --apply
 *
 * The default is a DRY RUN: it reads Schwab and the table, prints per-day
 * inserted / updated / unchanged / rejected counts, and writes nothing.
 * `--apply` upserts: a stored row holding other values is REPLACED by the
 * settled one (the old script was DO NOTHING and left wrong rows in place).
 * It never deletes. Rows stamped outside the session (the old cron's
 * extended-hours $ADD and $VOLD rows) stay until an approved DELETE.
 *
 * WARNING: this runs against PRODUCTION. `.env.local` points at the
 * production Neon branch AND the production Upstash Redis that holds the live
 * Schwab token record. Both modes read Schwab and the table, and refresh the
 * token if it has run out, so it refuses to start on a weekday 13:00-22:59
 * UTC while the Schwab crons are active (the token refresh could race theirs).
 * Its refresh write is a compare-and-set (scripts/_lib/schwab-local.mjs).
 *
 * Options:
 *   --apply                write (without it: dry run)
 *   --dry-run              the default, said aloud; contradicts --apply
 *   --from YYYY-MM-DD      first session of the window (default: the cron's
 *                          last 5 sessions). Schwab serves ~35 sessions of
 *                          1-minute bars; older ones come back empty.
 *   --to YYYY-MM-DD        last session (default: the newest settled one)
 *   --allow-market-hours   start inside the busy window (a market holiday)
 *   --env-file <path>      .env.local to load (default: the nearest one up
 *                          the tree; a path that does not exist is an error)
 *
 * Environment: DATABASE_URL, UPSTASH_REDIS_REST_URL / _TOKEN (or the KV_*
 * names), SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET.
 *
 * Exit codes: 0 done, 1 a symbol failed or a bad argument or environment, 2
 * refused to start in the busy window.
 */

import { config } from 'dotenv';
import { Redis } from '@upstash/redis';

import { resolveEnvFile } from './_lib/anchor-backfill.js';
import {
  formatReport,
  parseArgs,
  resolveSessions,
  runBackfill,
} from './_lib/market-internals-backfill.js';
import {
  getSchwabAccessToken,
  readSchwabEnv,
  schwabCronsBusyRefusal,
} from './_lib/schwab-local.mjs';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const refusal = args.allowMarketHours ? null : schwabCronsBusyRefusal();
  if (refusal !== null) {
    console.error(refusal);
    return 2;
  }

  config({ path: resolveEnvFile(args.envFile, '.'), quiet: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');
  const env = readSchwabEnv();
  if (env.problem !== null) throw new Error(env.problem);
  if (!env.redisUrl || !env.redisToken || !env.clientId || !env.clientSecret) {
    throw new Error('Missing Schwab or Redis settings');
  }
  const { clientId, clientSecret } = env;
  const redis = new Redis({ url: env.redisUrl, token: env.redisToken });

  const sessions = resolveSessions(args, new Date());
  console.log(`Database host: ${new URL(databaseUrl).hostname}`);
  const report = await runBackfill({
    apply: args.apply,
    sessions,
    // A SchwabAuthError (no record, lapsed refresh token) is recorded by
    // runBackfill as that symbol's failure, with its message.
    getToken: () => getSchwabAccessToken(redis, { clientId, clientSecret }),
  });
  console.log(formatReport(report));
  return report.failures.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
