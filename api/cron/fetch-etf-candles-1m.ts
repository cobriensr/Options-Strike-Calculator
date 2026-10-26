/**
 * GET /api/cron/fetch-etf-candles-1m
 *
 * Fetches 1-minute OHLCV candles for SPY and QQQ from the Unusual Whales
 * /stock/{ticker}/ohlc/1m endpoint and stores them as raw prices in the
 * etf_candles_1m table.
 *
 * Why this cron exists instead of reusing fetch-spx-candles-1m:
 *   fetch-spx-candles-1m also fetches SPY from UW, but it multiplies every
 *   bar by the live SPX/SPY ratio to produce SPX-equivalent prices before
 *   storing — the stored values are NOT raw SPY OHLC. This cron stores the
 *   raw ETF prices untouched, which is what the spike-return enrichment
 *   cron needs to compute accurate 5/15/30-min forward returns on each
 *   vega_spike_events row.
 *
 * Phase 5 of the Dir Vega Spike Monitor:
 *   The enrich-vega-spike-returns cron (Phase 5b) reads etf_candles_1m to
 *   look up the close price N minutes after each spike timestamp and writes
 *   fwd_return_5m / fwd_return_15m / fwd_return_30m back onto the spike row.
 *
 * Write path (review remediation D1, 2026-10-26):
 *   UW returns the whole day on every call (~390+ candles per ticker late in
 *   the session). One SELECT reads each ticker's high-water mark (latest
 *   stored minute since ET midnight); only candles after it go to Postgres,
 *   in one batched INSERT per ticker (`bulkUpsert`, ON CONFLICT DO NOTHING).
 *   This replaced one awaited INSERT per candle (~780 round-trips a run).
 *   HWM-only means a minute that first appears after a later minute is
 *   stored is never backfilled (nor is a bar dropped as malformed once a
 *   later valid one lands). That is acceptable because SPY and QQQ trade
 *   every regular-session minute and UW documents no late or out-of-order
 *   bars.
 *
 * The still-forming bar is never written. UW's docs: "The most recent
 * intraday candle is still forming, and its start_time is the start of the
 * current bucket", and the latest bar is the one with the maximum
 * start_time. Writing it would let DO NOTHING plus the HWM freeze a partial
 * bar for good, so a candle is kept only if it starts before BOTH the
 * minute the request was made in and UW's newest candle. The clock alone is
 * not enough: cronJitter fires 0–8 s past the minute, and if UW hasn't
 * opened the next bucket yet, the minute the clock calls closed is still
 * UW's newest, forming bar.
 *
 * Failures surface: a UW error, an empty payload (abnormal inside the gated
 * window, which `date=today` fills with pre-market bars from 04:00 ET) or a
 * DB reject fails that ticker (one Sentry exception each), and the run
 * reports 'partial' / 'error' via deriveCronStatus; 'error' turns the Sentry
 * cron monitor red. A failed HWM read throws to the wrapper (500 + Sentry +
 * Axiom 'error'). Malformed candles (unparseable start_time, price or
 * volume) are dropped, counted and raised as one Sentry warning per ticker,
 * so one bad row can't fail the whole batch every minute.
 *
 * Storage: etf_candles_1m (migration #94), UNIQUE (ticker, timestamp).
 *
 * Total API calls per invocation: 2 (SPY + QQQ in parallel)
 *
 * Schedule: vercel.json registers `* 13-21 * * 1-5` (every minute).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import { cronJitter, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import {
  withCronInstrumentation,
  deriveCronStatus,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// Tickers this cron fetches 1-minute OHLC for. Derive the leg count from
// this list so status demotion can never silently break if a ticker is
// added (the prior `failureCount === 2` hardcode made 'error' unreachable
// the moment a third ticker landed).
const TICKERS = ['SPY', 'QQQ'] as const;
type Ticker = (typeof TICKERS)[number];

// Per-attempt budget for each Neon call (HWM read, batched write).
const DB_ATTEMPT_TIMEOUT_MS = 10_000;

const MINUTE_MS = 60_000;

// ── Types ───────────────────────────────────────────────────

interface UWCandleRow {
  start_time: string; // ISO timestamp: "2026-04-27T14:32:00.000Z"
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: number;
}

interface EtfCandleRow extends Record<string, unknown> {
  ticker: Ticker;
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number | null;
}

const COLUMNS = [
  'ticker',
  'timestamp',
  'open',
  'high',
  'low',
  'close',
  'volume',
] as const satisfies readonly (keyof EtfCandleRow)[];

interface TickerCounts {
  /** Candles UW returned. */
  fetched: number;
  /** Closed, valid candles after the high-water mark: the rows sent. */
  new: number;
  /**
   * Rows sent in a write that succeeded (bulkUpsert's input count; ON
   * CONFLICT skips are not subtracted). 0 when the write failed.
   */
  stored: number;
  /**
   * fetched − new: at or below the HWM, still forming (by the clock or as
   * UW's newest candle), or malformed.
   */
  skipped: number;
  /**
   * Closed candles after the HWM dropped for an unparseable start_time,
   * price or volume (an unparseable start_time counts wherever it falls).
   */
  malformed: number;
}

// ── High-water mark ─────────────────────────────────────────

/**
 * Latest stored minute per ticker since ET midnight of `today`, as epoch
 * ms. A ticker with no rows today is absent (null HWM). The bound is
 * `::date::timestamp AT TIME ZONE` because a bare date compares as UTC
 * midnight, 4–5 h early.
 */
async function loadHighWaterMarks(
  sql: ReturnType<typeof getDb>,
  today: string,
): Promise<Map<string, number>> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT ticker, MAX(timestamp) AS hwm
      FROM etf_candles_1m
      WHERE ticker = ANY(${[...TICKERS]}::text[])
        AND timestamp >= (${today}::date::timestamp AT TIME ZONE 'America/New_York')
      GROUP BY ticker
    `,
    2,
    DB_ATTEMPT_TIMEOUT_MS,
  )) as Array<{ ticker: string; hwm: Date | string }>;
  // Neon returns TIMESTAMPTZ as a Date; new Date() accepts either form.
  return new Map(rows.map((r) => [r.ticker, new Date(r.hwm).getTime()]));
}

// ── Candle selection ────────────────────────────────────────

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  );
}

/** `volume` is BIGINT: absent is fine, a fraction fails the whole INSERT. */
function isValidVolume(value: unknown): boolean {
  return (
    value == null || (isNumeric(value) && Number.isSafeInteger(Number(value)))
  );
}

/**
 * Keep candles that are closed, newer than the HWM and well-formed;
 * de-duplicate by minute and sort oldest first. Closed means starting
 * before both `clockMinuteMs` and UW's newest candle (max start_time),
 * which UW documents as still forming whatever our clock says. Prices and
 * volume are validated only after the time filters, so a bad bar that is
 * already behind the HWM isn't re-counted on every run.
 */
function selectNewCandles(
  ticker: Ticker,
  candles: readonly UWCandleRow[],
  hwmMs: number | undefined,
  clockMinuteMs: number,
): { rows: EtfCandleRow[]; malformed: number } {
  const parsed = candles.map((c) => ({ c, ts: Date.parse(c.start_time) }));
  const newestMs = Math.max(
    ...parsed.map(({ ts }) => ts).filter((ts) => Number.isFinite(ts)),
  );
  const formingFromMs = Math.min(clockMinuteMs, newestMs);

  const byMinute = new Map<number, EtfCandleRow>();
  let malformed = 0;
  for (const { c, ts } of parsed) {
    if (!Number.isFinite(ts)) {
      malformed++;
      continue;
    }
    if (ts >= formingFromMs) continue; // still forming
    if (hwmMs !== undefined && ts <= hwmMs) continue; // already stored
    if (
      ![c.open, c.high, c.low, c.close].every(isNumeric) ||
      !isValidVolume(c.volume)
    ) {
      malformed++;
      continue;
    }
    if (byMinute.has(ts)) continue;
    byMinute.set(ts, {
      ticker,
      timestamp: new Date(ts).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      // Write the value isValidVolume checked: BIGINT rejects '1.0'.
      volume: c.volume == null ? null : Number(c.volume),
    });
  }
  const rows = [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
  return { rows, malformed };
}

// ── Per-ticker ingest ───────────────────────────────────────

/**
 * Fetch, filter and write one ticker. Fills `counts` as it goes so the
 * caller can still report what was fetched when the write rejects; any
 * rejection fails the ticker.
 */
async function ingestTicker(
  sql: ReturnType<typeof getDb>,
  apiKey: string,
  today: string,
  ticker: Ticker,
  hwmMs: number | undefined,
  counts: TickerCounts,
): Promise<void> {
  // Taken BEFORE the fetch, so it is never later than the minute UW answers
  // in: an early clock can only hold a closed bar back one run. On its own
  // it can't spot the forming bar (UW may not have opened this minute's
  // bucket yet); selectNewCandles also drops UW's newest candle.
  const clockMinuteMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

  const candles = await withRetry(() =>
    uwFetch<UWCandleRow>(apiKey, `/stock/${ticker}/ohlc/1m?date=${today}`),
  );
  counts.fetched = candles.length;
  // uwFetch only flags a missing `data`; `data: []` arrives silently.
  if (candles.length === 0) {
    metrics.increment('fetch_etf_candles_1m.empty_payload');
    throw new Error(
      `fetch-etf-candles-1m: UW returned no 1m candles for ${ticker}`,
    );
  }

  const { rows, malformed } = selectNewCandles(
    ticker,
    candles,
    hwmMs,
    clockMinuteMs,
  );
  counts.new = rows.length;
  counts.skipped = candles.length - rows.length;
  counts.malformed = malformed;

  // conflictUpdateColumns: [] → ON CONFLICT DO NOTHING (closed OHLC bars
  // don't restate). Retries are idempotent because of DO NOTHING on the
  // source-derived (ticker, timestamp) key, which matters: withDbRetry's
  // per-attempt timeout doesn't cancel the first attempt, so two can be in
  // flight at once. (One statement / one transaction past 500 rows gives
  // atomicity, not idempotency.)
  const { rows: stored } = await withDbRetry(
    () =>
      bulkUpsert({
        sql,
        table: 'etf_candles_1m',
        columns: COLUMNS,
        rows,
        conflictTarget: '(ticker, timestamp)',
        conflictUpdateColumns: [],
      }),
    2,
    DB_ATTEMPT_TIMEOUT_MS,
  ).catch((err: unknown) => {
    // Write failures only; the caller reports every ticker failure.
    metrics.increment('fetch_etf_candles_1m.store_error');
    throw err;
  });
  counts.stored = stored;
}

// ── Handler ─────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-etf-candles-1m',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today, logger } = ctx;
    await cronJitter();

    const sql = getDb();
    // Throws to the wrapper on failure: without a HWM there is nothing
    // safe to diff against, and the DB is the thing that's down.
    const hwm = await loadHighWaterMarks(sql, today);

    const counts = Object.fromEntries(
      TICKERS.map((t) => [
        t,
        { fetched: 0, new: 0, stored: 0, skipped: 0, malformed: 0 },
      ]),
    ) as Record<Ticker, TickerCounts>;

    // allSettled isolates each ticker: a UW error or a DB reject on one
    // still lets the other land (BE-CRON-H4), and marks only that ticker
    // failed.
    const settled = await Promise.allSettled(
      TICKERS.map((t) =>
        ingestTicker(sql, apiKey, today, t, hwm.get(t), counts[t]),
      ),
    );

    let failureCount = 0;
    settled.forEach((outcome, i) => {
      const ticker = TICKERS[i]!;
      if (outcome.status === 'rejected') {
        failureCount++;
        logger.warn(
          { err: outcome.reason, ticker, ...counts[ticker] },
          'fetch-etf-candles-1m: ticker failed',
        );
        Sentry.captureException(outcome.reason, { tags: { ticker } });
      }
      const { malformed } = counts[ticker];
      if (malformed > 0) {
        logger.warn(
          { ticker, malformed },
          'fetch-etf-candles-1m: dropped malformed candles',
        );
        metrics.increment('fetch_etf_candles_1m.malformed');
        Sentry.captureMessage(
          'fetch-etf-candles-1m: malformed UW candles dropped',
          { level: 'warning', extra: { ticker, malformed } },
        );
      }
    });

    const status = deriveCronStatus(failureCount, TICKERS.length);

    logger.info(
      { tickers: counts, failureCount, status },
      'fetch-etf-candles-1m completed',
    );

    return {
      status,
      metadata: {
        failureCount,
        tickers: counts,
        // Existing Axiom top-level columns; everything else lands in meta.
        spy_candles: counts.SPY.fetched,
        spy_stored: counts.SPY.stored,
        spy_skipped: counts.SPY.skipped,
        qqq_candles: counts.QQQ.fetched,
        qqq_stored: counts.QQQ.stored,
        qqq_skipped: counts.QQQ.skipped,
      },
    };
  },
);
