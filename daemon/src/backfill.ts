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
 */

import { neon } from '@neondatabase/serverless';
import { loadConfig } from './config.js';
import { makeLogger } from './logger.js';
import { runCapture } from './capture.js';
import { fetchGexLandscape } from './gex.js';
import { postTraceLiveAnalyze } from './api-client.js';

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

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute the exact `capturedAt` ISO the capture script will produce
 * for a given (date, CT time). Mirrors capture-trace-live.ts's TZ-probe
 * logic so the existence check below queries the right value.
 *
 * If the script's logic ever changes, this must change too — keep them
 * in lock-step.
 */
function computeCapturedAtIso(
  date: string,
  hourCt: number,
  minuteCt: number,
): string {
  const isoLocal = `${date}T${String(hourCt + 1).padStart(2, '0')}:${String(minuteCt).padStart(2, '0')}:00`;
  const probe = new Date(`${date}T12:00:00Z`);
  const etDateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const offsetParts = etDateFmt.formatToParts(probe);
  const tz = offsetParts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const offsetMatch = /GMT([+-]\d+)/.exec(tz);
  const offsetHours = offsetMatch ? Number.parseInt(offsetMatch[1]!, 10) : -5;
  const sign = offsetHours < 0 ? '-' : '+';
  const offsetStr = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
  return new Date(`${isoLocal}${offsetStr}`).toISOString();
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

    try {
      // Idempotency check: if a previous run already wrote this slot's
      // row, skip the entire capture+gex+post chain. Saves ~$0.04 per
      // slot in Anthropic cost + browserless units + blob writes when
      // re-running a backfill that partially succeeded earlier.
      const targetCapturedAt = computeCapturedAtIso(
        args.date,
        slot.hourCt,
        slot.minuteCt,
      );
      const existed = await hasExistingRow(
        config.databaseUrl,
        targetCapturedAt,
      );
      if (existed) {
        slotLogger.info(
          { capturedAt: targetCapturedAt },
          'Slot already in DB — skipping (idempotent)',
        );
        alreadyDone++;
        // No rate-limit gap needed for a no-op.
        continue;
      }

      slotLogger.info('Slot start');

      const capture = await runCapture({
        logger: slotLogger,
        date: args.date,
        time: slot.hhmm,
      });

      const gex = await fetchGexLandscape({
        databaseUrl: config.databaseUrl,
        capturedAt: capture.capturedAt,
        logger: slotLogger,
      });
      if (!gex) {
        slotLogger.warn(
          'No GEX snapshot for this slot — skipping (cron may have been down)',
        );
        skipped++;
        await sleep(RATE_LIMIT_GAP_MS);
        continue;
      }

      await postTraceLiveAnalyze({
        endpoint: config.endpoint,
        ownerSecret: config.ownerSecret,
        logger: slotLogger,
        capturedAt: capture.capturedAt,
        spot: capture.spot,
        stabilityPct: capture.stabilityPct,
        etTimeLabel: `${slot.hhmm} CT`,
        images: capture.images,
        gex,
      });
      slotLogger.info('Slot complete');
      succeeded++;
    } catch (err) {
      slotLogger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Slot failed',
      );
      failed++;
    }

    // Rate-limit gap. Last slot doesn't wait.
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

main().catch((err: unknown) => {
  process.stderr.write(
    `FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
