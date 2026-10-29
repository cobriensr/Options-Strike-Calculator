/**
 * GET /api/cron/archive-gexbot-eod
 *
 * Nightly capture of GEXBot's end-of-day report ZIPs (60 tickers). Each ZIP
 * is validated, stored in private R2 and indexed in `gexbot_eod_reports`.
 * Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
 *
 * Schedule: `0 2,12,19,23 * * *` UTC, every day. Runs that find nothing new
 * (weekends, or a day already captured) make no download.
 *
 * Served date decides the key: the `Content-Disposition` date is the report
 * date. A row for (ticker, served date) means skip (`notYetPublished` when
 * older than expected, else `skipped`); no row means store it under the
 * served date, even when older than expected (catch-up).
 *
 * Per ticker: index an object already in R2 first (no download), else
 * download. Concurrency 3, in priority order. Budget: start nothing new at
 * 600 s, abort in-flight downloads at 740 s (maxDuration 800). A 429 stops
 * new requests. Tickers not attempted for either reason are `leftover`.
 *
 * Status: `deriveCronStatus(failed, attempted)`; leftovers make a would-be
 * `success` into `partial`. A lost day is caught by the separate audit cron.
 *
 * All state is run-scoped (R1). Per-run fields go in `metadata`, which the
 * wrapper puts in the Axiom `meta` string (no new top-level keys).
 *
 * Environment: GEXBOT_API_KEY, CRON_SECRET, DATABASE_URL, R2_*
 */

import {
  deriveCronStatus,
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import {
  fetchEodTickers,
  indexExistingObject,
  latestEligibleReportDate,
  listStoredTickers,
  requestEodReport,
  storeEodReport,
} from '../_lib/gexbot-eod.js';
import { EodZipError, validateEodZip } from '../_lib/gexbot-eod-zip.js';
import { Sentry } from '../_lib/sentry.js';
import { mapWithConcurrency } from '../_lib/uw-fetch.js';

export const config = { maxDuration: 800 };

const CONCURRENCY = 3;
/** No new download starts at or after this elapsed time. */
const START_CUTOFF_MS = 600_000;
/** In-flight downloads are aborted at this elapsed time. */
const ABORT_AT_MS = 740_000;
const EXPECTED_ENTRIES = 15;
const REASON_MAX_CHARS = 120;

/** Short, stable reason string so failures group in Sentry and Axiom. */
function reasonOf(err: unknown): string {
  if (err instanceof EodZipError) return `zip_${err.reason}`;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('truncated')) return 'truncated';
  if (msg.startsWith('r2_verify_failed')) return 'r2_verify_failed';
  if (msg === 'object_without_metadata') return msg;
  return `error: ${msg.slice(0, REASON_MAX_CHARS)}`;
}

export default withCronInstrumentation(
  'archive-gexbot-eod',
  async (ctx): Promise<CronResult> => {
    const apiKey = process.env.GEXBOT_API_KEY;
    if (!apiKey) throw new Error('GEXBOT_API_KEY is not configured');

    const { tickers, rejected } = await fetchEodTickers();
    if (rejected.length > 0) {
      ctx.logger.warn({ rejected }, 'archive-gexbot-eod rejected tickers');
    }
    const expected = latestEligibleReportDate(new Date());

    // Stored tickers per report date, filled lazily and once per date.
    const storedByDate = new Map<string, Promise<Set<string>>>();
    const storedFor = (date: string): Promise<Set<string>> => {
      let p = storedByDate.get(date);
      if (p == null) {
        p = listStoredTickers(date);
        storedByDate.set(date, p);
        p.catch(() => storedByDate.delete(date));
      }
      return p;
    };
    const expectedStored = await storedFor(expected);
    const todo = tickers.filter((t) => !expectedStored.has(t));

    const elapsed = (): number => Date.now() - ctx.startTimeMs;
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, ABORT_AT_MS - elapsed()),
    );

    let stored = 0;
    let indexedFromR2 = 0;
    let skipped = 0;
    let notYetPublished = 0;
    let bytes = 0;
    let stop = false;
    let stopReason: 'quota' | 'budget' | null = null;
    const failed: { ticker: string; reason: string }[] = [];
    const leftover: string[] = [];
    const entryCountWarnings: { ticker: string; entryCount: number }[] = [];

    const recordFailure = (
      ticker: string,
      err?: unknown,
      reason = reasonOf(err),
    ): void => {
      failed.push({ ticker, reason });
      ctx.logger.warn({ ticker, reason, err }, 'gexbot-eod ticker failed');
    };
    const isAbort = (err: unknown): boolean =>
      controller.signal.aborted &&
      (err === controller.signal.reason ||
        (err instanceof Error && err.name === 'AbortError'));

    const processTicker = async (ticker: string): Promise<void> => {
      if (!stop && elapsed() >= START_CUTOFF_MS) {
        stop = true;
        stopReason ??= 'budget';
      }
      if (stop || controller.signal.aborted) {
        leftover.push(ticker);
        return;
      }
      try {
        if ((await indexExistingObject(ticker, expected)) === 'indexed') {
          indexedFromR2 += 1;
          (await storedFor(expected)).add(ticker);
          return;
        }
        // The index lookup can outlive a 429 or the budget; re-check before
        // spending a request.
        if (stop || elapsed() >= START_CUTOFF_MS || controller.signal.aborted) {
          if (!stop) stopReason ??= 'budget';
          stop = true;
          leftover.push(ticker);
          return;
        }
        const res = await requestEodReport(apiKey, ticker, controller.signal);
        if (res.kind === 'quota') {
          stop = true;
          stopReason = 'quota';
          leftover.push(ticker);
          return;
        }
        if (res.kind === 'http_error') {
          recordFailure(ticker, undefined, `http_${res.status}`);
          return;
        }
        if (res.kind === 'bad_response') {
          recordFailure(ticker, undefined, res.reason);
          return;
        }
        const have = await storedFor(res.servedDate).catch(async (err) => {
          await res.discard();
          throw err;
        });
        if (have.has(ticker)) {
          await res.discard();
          if (res.servedDate < expected) notYetPublished += 1;
          else skipped += 1;
          return;
        }
        const body = await res.readBody();
        const { entryCount } = validateEodZip(body, ticker, res.servedDate);
        await storeEodReport({
          ticker,
          date: res.servedDate,
          body,
          entryCount,
        });
        have.add(ticker);
        stored += 1;
        bytes += body.length;
        if (entryCount !== EXPECTED_ENTRIES) {
          entryCountWarnings.push({ ticker, entryCount });
          ctx.logger.warn(
            { ticker, entryCount },
            'archive-gexbot-eod unexpected entry count',
          );
        }
      } catch (err) {
        // Only the abort itself is leftover. validateEodZip and
        // storeEodReport ignore the signal, so their errors stay failures.
        if (isAbort(err)) {
          stopReason ??= 'budget';
          leftover.push(ticker);
          return;
        }
        recordFailure(ticker, err);
      }
    };

    try {
      await mapWithConcurrency(todo, CONCURRENCY, processTicker);
    } finally {
      clearTimeout(abortTimer);
    }

    const attempted =
      stored + indexedFromR2 + skipped + notYetPublished + failed.length;
    let status = deriveCronStatus(failed.length, attempted);
    // The expected report was not captured in either case.
    if ((leftover.length > 0 || notYetPublished > 0) && status === 'success') {
      status = 'partial';
    }

    // Leftover-only runs (429, budget) deliberately send no Sentry event:
    // the audit cron catches a day that never completes (Ruling 15).
    if (failed.length > 0) {
      Sentry.captureMessage('GEXBot EOD capture had failures', {
        level: 'error',
        fingerprint: ['gexbot-eod', 'capture-failed'],
        extra: {
          expectedDate: expected,
          failed: failed.slice(0, 100),
          failedCount: failed.length,
        },
      });
    }
    if (entryCountWarnings.length > 0) {
      Sentry.captureMessage('GEXBot EOD report entry count differs', {
        level: 'warning',
        fingerprint: ['gexbot-eod', 'entry-count'],
        extra: { expectedDate: expected, entryCountWarnings },
      });
    }
    ctx.logger.info(
      { expected, stored, indexedFromR2, failed: failed.length, stopReason },
      'archive-gexbot-eod completed',
    );

    return {
      status,
      rows: stored + indexedFromR2,
      metadata: {
        expectedDate: expected,
        tickers: tickers.length,
        stored,
        indexedFromR2,
        skipped,
        notYetPublished,
        failed,
        leftover,
        stopReason,
        bytes,
        entryCountWarnings,
        rejectedTickers: rejected,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
