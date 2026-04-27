/**
 * Capture orchestration — spawns scripts/capture-trace-live.ts and
 * parses the JSON output. The script holds all the TRACE-DOM specifics
 * (selectors, slider scrubbing, auth via storageState); the daemon stays
 * agnostic about how the bytes get produced.
 *
 * The daemon and the capture script must run on the same machine until
 * we move auth + headless Chromium to a hosted runtime. v1 deployment
 * is "run on user's MacBook during market hours."
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Path to the capture script. The daemon lives at <repo>/daemon/src/,
 * the script lives at <repo>/scripts/. From the daemon's CWD we resolve
 * via __dirname (../../scripts/capture-trace-live.ts) so the same path
 * works in dev (tsx) and a future bundle.
 */
const CAPTURE_SCRIPT_PATH = join(
  __dirname,
  '..',
  '..',
  'scripts',
  'capture-trace-live.ts',
);

export interface CaptureResult {
  images: {
    gamma: string;
    charm: string;
    delta: string;
  };
  spot: number;
  stabilityPct: number | null;
  capturedAt: string;
}

export interface RunCaptureOptions {
  logger: Logger;
  /**
   * Hard timeout for the full capture cycle (ms). Defaults to 180_000.
   * Sequential init of 3 chart pages on browserless RTT is ~30s each,
   * plus 3 parallel screenshots and JSON write. Slot 1 of the first
   * test backfill ran 89.6s — right at the old 90s edge. 180s gives
   * comfortable headroom; slots are 5 min apart so it doesn't compete
   * with the next tick.
   */
  timeoutMs?: number;
  /** Backfill: ET trading day (YYYY-MM-DD). Live mode if omitted. */
  date?: string;
  /** Backfill: CT wall-clock time (HH:MM). Live mode if omitted. */
  time?: string;
}

/**
 * Run the capture script as a child process. Resolves with the parsed
 * JSON on exit code 0, throws on non-zero exit or stdout that fails to
 * parse. The process is killed after `timeoutMs` to keep the daemon's
 * tick budget bounded — if a single TRACE page is hung, we'd rather
 * miss this cycle than queue up subsequent ones.
 */
export async function runCapture(
  opts: RunCaptureOptions,
): Promise<CaptureResult> {
  const { logger, timeoutMs = 180_000, date, time } = opts;

  if (!existsSync(CAPTURE_SCRIPT_PATH)) {
    throw new Error(
      `capture-trace-live.ts not found at ${CAPTURE_SCRIPT_PATH}`,
    );
  }

  return await new Promise<CaptureResult>((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // npx is the consistent entry point — both `tsx scripts/...` and
    // `npx tsx scripts/...` work, but `npx` is what the project's other
    // scripts use, so we match that. spawn (NOT shell) keeps the args
    // strictly typed and avoids quoting pitfalls.
    //
    // Backfill mode: pass --date / --time flags through. Live mode: no
    // extra args, the script captures current data.
    const args = ['tsx', CAPTURE_SCRIPT_PATH];
    if (date) args.push('--date', date);
    if (time) args.push('--time', time);
    const child = spawn('npx', args, {
      cwd: join(__dirname, '..', '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(
        { timeoutMs, durationMs: Date.now() - startedAt },
        'Capture script timed out — killing',
      );
      child.kill('SIGTERM');
      // Hard-kill backstop after 5s if SIGTERM is ignored.
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`capture spawn failed: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        reject(new Error(`capture timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `capture exited code=${code} signal=${signal} stderr=${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as CaptureResult;
        if (
          !parsed.images?.gamma ||
          !parsed.images.charm ||
          !parsed.images.delta
        ) {
          reject(new Error('capture output missing one or more image bytes'));
          return;
        }
        if (typeof parsed.spot !== 'number' || !Number.isFinite(parsed.spot)) {
          reject(new Error('capture output has invalid spot'));
          return;
        }
        logger.info(
          {
            durationMs,
            spot: parsed.spot,
            stabilityPct: parsed.stabilityPct,
            gammaBytes: parsed.images.gamma.length,
            charmBytes: parsed.images.charm.length,
            deltaBytes: parsed.images.delta.length,
          },
          'Capture script returned successfully',
        );
        resolve(parsed);
      } catch (err) {
        reject(
          new Error(
            `capture stdout JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (first 200 chars: ${stdout.slice(0, 200)})`,
          ),
        );
      }
    });
  });
}
