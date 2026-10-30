/**
 * GET /api/cron/archive-gexbot-eod
 *
 * Nightly capture of GEXBot's end-of-day report ZIPs (60 tickers). Each ZIP
 * is validated, stored in private R2 and indexed in `gexbot_eod_reports`.
 * Spec: docs/superpowers/specs/2026-10-28-gexbot-eod-capture-design.md
 *
 * Schedule: `0 2,12-21,23 * * *` UTC, every day: hourly from 12:00 to 21:00
 * UTC, so a missing report keeps being retried until its download window
 * closes (17:00 ET on the next trading day). A run with nothing missing makes
 * no report request (one `/tickers` call and one DB query).
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
 * Retries: a ticker gets up to 3 attempts, waiting 15 s then 45 s. Retried:
 * network errors, HTTP 5xx/408, bad responses, truncated or invalid ZIPs, R2
 * and DB errors. Not retried: 429 (stops the run), other 4xx and
 * `object_without_metadata`. A wait that would cross the 600 s cutoff, or a
 * stop flag, sends the ticker to `leftover`. Three consecutive
 * `notYetPublished` results stop the run (`stopReason` `not_published`) so a
 * late GEXBot does not cost 60 requests per hourly run.
 *
 * Status: `deriveCronStatus(failed, attempted)`; leftovers make a would-be
 * `success` into `partial`. A lost day is reported by the separate audit cron
 * after the window closes.
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
/** Waits before the 2nd and 3rd attempt of a ticker (3 attempts in all). */
const RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];
/** Consecutive `notYetPublished` results that stop the run. */
const NOT_PUBLISHED_STOP_AFTER = 3;

type StopReason = 'quota' | 'budget' | 'not_published';

/** What one attempt at one ticker came to. */
type Attempt =
  | { kind: 'stored' | 'indexed' | 'skipped' | 'not_published' | 'leftover' }
  | { kind: 'failed'; reason: string; err?: unknown; retryable: boolean };

/**
 * Sleep that ends early (resolving false) when the signal aborts, and always
 * clears its timer and listener (R1).
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Short, stable reason string so failures group in Sentry and Axiom. */
function reasonOf(err: unknown): string {
  if (err instanceof EodZipError) return `zip_${err.reason}`;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('truncated')) return 'truncated';
  if (msg.startsWith('r2_verify_failed')) return 'r2_verify_failed';
  if (msg === 'object_without_metadata') return msg;
  // undici reports every network failure as `fetch failed`; the real cause
  // (ECONNRESET, UND_ERR_HEADERS_TIMEOUT, ...) is only on `cause.code`.
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return `error: ${msg.slice(0, REASON_MAX_CHARS)}${suffix}`;
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
    // Catch-up: the served date was older than expected and had no row. Each
    // catch-up ticker adds 1 to `caughtUp` and exactly one of `indexedFromR2`
    // (object already in R2) or `storedCount` (downloaded and stored).
    let caughtUp = 0;
    let skipped = 0;
    let notYetPublished = 0;
    let bytes = 0;
    let stop = false;
    let stopReason: StopReason | null = null;
    // Tickers that needed a retry, and those stored or indexed after one.
    let retried = 0;
    let recoveredByRetry = 0;
    // Consecutive notYetPublished results, in completion order.
    let notPublishedStreak = 0;
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

    /** One attempt at one ticker; never throws. Counters move only on success. */
    const attemptTicker = async (ticker: string): Promise<Attempt> => {
      if (!stop && elapsed() >= START_CUTOFF_MS) {
        stop = true;
        stopReason ??= 'budget';
      }
      if (stop || controller.signal.aborted) return { kind: 'leftover' };
      try {
        if ((await indexExistingObject(ticker, expected)) === 'indexed') {
          indexedFromR2 += 1;
          (await storedFor(expected)).add(ticker);
          return { kind: 'indexed' };
        }
        // The index lookup can outlive a 429 or the budget; re-check before
        // spending a request.
        if (stop || elapsed() >= START_CUTOFF_MS || controller.signal.aborted) {
          if (!stop) stopReason ??= 'budget';
          stop = true;
          return { kind: 'leftover' };
        }
        const res = await requestEodReport(apiKey, ticker, controller.signal);
        if (res.kind === 'quota') {
          stop = true;
          stopReason = 'quota';
          return { kind: 'leftover' };
        }
        if (res.kind === 'http_error') {
          return {
            kind: 'failed',
            reason: `http_${res.status}`,
            retryable: res.status >= 500 || res.status === 408,
          };
        }
        if (res.kind === 'bad_response') {
          return { kind: 'failed', reason: res.reason, retryable: true };
        }
        const have = await storedFor(res.servedDate).catch(async (err) => {
          await res.discard();
          throw err;
        });
        if (have.has(ticker)) {
          await res.discard();
          if (res.servedDate < expected) {
            notYetPublished += 1;
            return { kind: 'not_published' };
          }
          skipped += 1;
          return { kind: 'skipped' };
        }
        const isCatchUp = res.servedDate !== expected;
        if (isCatchUp) {
          // An older report with no row may already sit in R2 (e.g. a rescue
          // object); index it instead of downloading the ZIP again.
          const indexed = await indexExistingObject(
            ticker,
            res.servedDate,
          ).catch(async (err) => {
            await res.discard();
            throw err;
          });
          if (indexed === 'indexed') {
            await res.discard();
            have.add(ticker);
            caughtUp += 1;
            indexedFromR2 += 1;
            return { kind: 'indexed' };
          }
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
        if (isCatchUp) caughtUp += 1;
        bytes += body.length;
        if (entryCount !== EXPECTED_ENTRIES) {
          entryCountWarnings.push({ ticker, entryCount });
          ctx.logger.warn(
            { ticker, entryCount },
            'archive-gexbot-eod unexpected entry count',
          );
        }
        return { kind: 'stored' };
      } catch (err) {
        // Only the abort itself is leftover. validateEodZip and
        // storeEodReport ignore the signal, so their errors stay failures.
        if (isAbort(err)) {
          stopReason ??= 'budget';
          return { kind: 'leftover' };
        }
        const reason = reasonOf(err);
        return {
          kind: 'failed',
          reason,
          err,
          // A missing-metadata object stays that way until a human looks.
          retryable: reason !== 'object_without_metadata',
        };
      }
    };

    /** Books a ticker's final, non-leftover outcome. */
    const finish = (kind: Attempt['kind'], afterRetry: boolean): void => {
      if (afterRetry && (kind === 'stored' || kind === 'indexed')) {
        recoveredByRetry += 1;
      }
      if (kind !== 'not_published') {
        notPublishedStreak = 0;
        return;
      }
      notPublishedStreak += 1;
      if (notPublishedStreak >= NOT_PUBLISHED_STOP_AFTER && !stop) {
        stop = true;
        stopReason = 'not_published';
      }
    };

    const processTicker = async (ticker: string): Promise<void> => {
      let attempt = 1;
      for (;;) {
        const result = await attemptTicker(ticker);
        if (result.kind === 'leftover') {
          leftover.push(ticker);
          return;
        }
        if (result.kind !== 'failed') {
          finish(result.kind, attempt > 1);
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt - 1];
        // After the abort a failure is a real one (the abort did not cause
        // it), so it is booked as failed, as before retries existed.
        if (
          !result.retryable ||
          delay === undefined ||
          controller.signal.aborted
        ) {
          finish('failed', false);
          recordFailure(ticker, result.err, result.reason);
          return;
        }
        // Never start an attempt, or sleep, at or past the start cutoff.
        if (stop || elapsed() + delay >= START_CUTOFF_MS) {
          stopReason ??= 'budget';
          leftover.push(ticker);
          return;
        }
        attempt += 1;
        if (attempt === 2) retried += 1;
        ctx.logger.warn(
          { ticker, attempt, reason: result.reason },
          'gexbot-eod retry',
        );
        if (!(await abortableSleep(delay, controller.signal))) {
          stopReason ??= 'budget';
          leftover.push(ticker);
          return;
        }
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
    // The expected report was not captured in any of these cases.
    if (
      (leftover.length > 0 || notYetPublished > 0 || caughtUp > 0) &&
      status === 'success'
    ) {
      status = 'partial';
    }

    // Leftover-only runs (429, budget, not published) deliberately send no
    // Sentry event: the audit cron reports a day that is lost (Ruling 15).
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
        // Not `stored`/`skipped`: those are Axiom top-level columns that
        // auto-prefill-premarket fills with booleans.
        storedCount: stored,
        indexedFromR2,
        caughtUp,
        skippedCount: skipped,
        notYetPublished,
        failed,
        leftover,
        stopReason,
        retried,
        recoveredByRetry,
        bytes,
        entryCountWarnings,
        rejectedTickers: rejected,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
