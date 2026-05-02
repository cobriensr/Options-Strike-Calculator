/**
 * One-shot backfill — captures every 5-min slot for a single ET trading
 * day, posts each batch to /api/trace-live-analyze with the historical
 * `capturedAt` so it lands in the right time bucket on the dashboard.
 *
 * Usage:
 *   cd daemon
 *   npx tsx --env-file=.env src/backfill.ts --date 2026-04-22
 *
 * Iterates 78 slots × ~25s wall-clock per slot ≈ 35 min total. Cost:
 * ~$3 / day at Sonnet 4.6 (76 captures × ~$0.04). Backfilling 10 days =
 * ~$30. Rate-limited to 6/min to respect the API rate-limit guard.
 *
 * Skips:
 *   - weekends + NYSE-closed dates (the script will set the date but TRACE
 *     won't have data, so the GEX query will return null and we skip).
 *   - slots before 09:35 ET / after 15:55 ET (16:00 close - 5 min).
 *   - half-day close handled via the same 12:55 ET cutoff as the daemon.
 *
 * Per-slot processing lives in `processSlot` which returns a discriminated
 * outcome the loop body switches on for counter accumulation.
 */

import { neon } from '@neondatabase/serverless';
import type { Logger } from 'pino';
import { loadConfig, type DaemonConfig } from './config.js';
import { makeLogger } from './logger.js';
import { runCapture } from './capture.js';
import { fetchGexLandscape } from './gex.js';
import { postTraceLiveAnalyze } from './api-client.js';
import { computeCapturedAtIso } from '../../src/utils/trace-live-tz.js';
import { sleep } from './utils/sleep.js';

interface BackfillArgs {
  date: string;
  /** CT start time (default 08:35 = 09:35 ET). */
  startCt?: string;
  /** CT end time (default 14:55 = 15:55 ET). */
  endCt?: string;
}

function parseArgs(): BackfillArgs {
  const argv = process.argv.slice(2);
  let date: string | null = null;
  let startCt: string | undefined;
  let endCt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') date = argv[++i] ?? null;
    else if (a === '--start') startCt = argv[++i];
    else if (a === '--end') endCt = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stderr.write(
        'Usage: backfill --date YYYY-MM-DD [--start HH:MM (CT, default 08:35)] [--end HH:MM (CT, default 14:55)]\n',
      );
      process.exit(0);
    }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    process.stderr.write(
      'FATAL: --date YYYY-MM-DD is required (ET trading day)\n',
    );
    process.exit(1);
  }
  return { date, startCt, endCt };
}

interface Slot {
  hourCt: number;
  minuteCt: number;
  /** Formatted as 'HH:MM' for the capture script's --time arg. */
  hhmm: string;
}

function buildSlots(startCt: string, endCt: string, stepMin: number): Slot[] {
  const [sh, sm] = startCt.split(':').map(Number) as [number, number];
  const [eh, em] = endCt.split(':').map(Number) as [number, number];
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const slots: Slot[] = [];
  for (let m = start; m <= end; m += stepMin) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    slots.push({
      hourCt: h,
      minuteCt: min,
      hhmm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    });
  }
  return slots;
}

/**
 * Check whether a trace_live_analyses row already exists for the given
 * captured_at. Used to skip slots previous runs already completed —
 * avoids the per-slot Anthropic cost, browserless usage, and blob
 * writes when re-running a backfill that partially succeeded.
 *
 * Match window is ±60s to absorb any nanosecond-level rounding between
 * runs of the TZ probe; in practice timestamps should be identical.
 */
async function hasExistingRow(
  databaseUrl: string,
  capturedAt: string,
): Promise<boolean> {
  const sql = neon(databaseUrl);
  const rows = (await sql`
    SELECT 1
    FROM trace_live_analyses
    WHERE captured_at BETWEEN
      (${capturedAt}::timestamptz - INTERVAL '60 seconds')
      AND (${capturedAt}::timestamptz + INTERVAL '60 seconds')
    LIMIT 1
  `) as Array<unknown>;
  return rows.length > 0;
}

/**
 * Discriminated outcome of `processSlot`. The loop body switches on
 * `outcome` to update the running counters; an exhaustive `switch`
 * with a `never`-typed default forces compile-time review of every
 * consumer when a new variant is added.
 */
export type SlotOutcome =
  | { outcome: 'succeeded'; capturedAt: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'alreadyDone'; capturedAt: string }
  | { outcome: 'failed'; error: unknown };

/**
 * Process a single backfill slot end-to-end. Returns a discriminated
 * outcome describing success / skip / already-in-DB / failure. Never
 * throws — failures collapse to `{ outcome: 'failed', error }`.
 */
export async function processSlot(
  slot: Slot,
  config: DaemonConfig,
  logger: Logger,
  date: string,
): Promise<SlotOutcome> {
  try {
    // Idempotency check: if a previous run already wrote this slot's
    // row, skip the entire capture+gex+post chain. Saves ~$0.04 per
    // slot in Anthropic cost + browserless units + blob writes when
    // re-running a backfill that partially succeeded earlier.
    const targetCapturedAt = computeCapturedAtIso(
      date,
      slot.hourCt,
      slot.minuteCt,
    );
    const existed = await hasExistingRow(config.databaseUrl, targetCapturedAt);
    if (existed) {
      logger.info(
        { capturedAt: targetCapturedAt },
        'Slot already in DB — skipping (idempotent)',
      );
      return { outcome: 'alreadyDone', capturedAt: targetCapturedAt };
    }

    logger.info('Slot start');

    const capture = await runCapture({
      logger,
      date,
      time: slot.hhmm,
    });

    const gex = await fetchGexLandscape({
      databaseUrl: config.databaseUrl,
      capturedAt: capture.capturedAt,
      logger,
    });
    if (!gex) {
      logger.warn(
        'No GEX snapshot for this slot — skipping (cron may have been down)',
      );
      return {
        outcome: 'skipped',
        reason: 'no-gex-snapshot',
      };
    }

    await postTraceLiveAnalyze({
      endpoint: config.endpoint,
      ownerSecret: config.ownerSecret,
      logger,
      capturedAt: capture.capturedAt,
      spot: capture.spot,
      stabilityPct: capture.stabilityPct,
      etTimeLabel: `${slot.hhmm} CT`,
      images: capture.images,
      gex,
    });
    logger.info('Slot complete');
    return { outcome: 'succeeded', capturedAt: capture.capturedAt };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Slot failed',
    );
    return { outcome: 'failed', error: err };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = loadConfig();
  const logger = makeLogger(config.logLevel);

  // 6 calls / min = 10s gap between starts. Capture takes ~25s; adding 10s
  // post-completion waits keeps the rate-limit headroom safe even if a
  // single cycle finishes faster than expected.
  const RATE_LIMIT_GAP_MS = 10_000;
  const STEP_MIN = 5;
  const start = args.startCt ?? '08:35';
  const end = args.endCt ?? '14:55';
  const slots = buildSlots(start, end, STEP_MIN);

  logger.info(
    {
      date: args.date,
      slots: slots.length,
      window: `${start}–${end} CT`,
      step: `${STEP_MIN}min`,
      estTotalMs: slots.length * (25_000 + RATE_LIMIT_GAP_MS),
    },
    'Backfill starting',
  );

  let succeeded = 0;
  let skipped = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const slotLogger = logger.child({
      slot: `${i + 1}/${slots.length}`,
      time: slot.hhmm,
    });

    const result = await processSlot(slot, config, slotLogger, args.date);
    switch (result.outcome) {
      case 'succeeded':
        succeeded++;
        break;
      case 'alreadyDone':
        alreadyDone++;
        // No rate-limit gap needed for a no-op.
        if (i < slots.length - 1) continue;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'failed':
        failed++;
        break;
      default: {
        // Exhaustiveness guard — adding a new variant forces this
        // switch to be revisited at compile time.
        const _exhaustive: never = result;
        throw new Error(`Unhandled slot outcome: ${JSON.stringify(_exhaustive)}`);
      }
    }

    // Rate-limit gap. Last slot doesn't wait. `alreadyDone` already
    // continues above so it never reaches here.
    if (i < slots.length - 1) {
      await sleep(RATE_LIMIT_GAP_MS);
    }
  }

  logger.info(
    {
      date: args.date,
      total: slots.length,
      succeeded,
      alreadyDone,
      skipped,
      failed,
    },
    'Backfill complete',
  );
  process.exit(failed > 0 && succeeded === 0 && alreadyDone === 0 ? 1 : 0);
}

// Only invoke `main` when this module is the entry point. `tsx
// src/backfill.ts` sets `import.meta.url` to a `file://` URL matching
// `process.argv[1]`; under vitest the file is dynamically imported,
// so the URLs differ and `main` is skipped (preventing the test runner
// from triggering the CLI's `process.exit(1)` for missing --date).
const invokedAsEntrypoint =
  import.meta.url ===
  (process.argv[1] ? `file://${process.argv[1]}` : undefined);
if (invokedAsEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
