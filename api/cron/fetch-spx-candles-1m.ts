/**
 * GET /api/cron/fetch-spx-candles-1m
 *
 * Fetches 1-minute OHLCV candles for both SPX and NDX from the Unusual
 * Whales API and stores them in the index_candles_1m table tagged with
 * the appropriate symbol. Runs every minute during market hours
 * (13-21 UTC, Mon-Fri) alongside fetch-gex-0dte so each GEX snapshot
 * has a matching price bar.
 *
 * SPY → SPX / QQQ → NDX translation: Cboe and Nasdaq prohibit external
 * distribution of proprietary index OHLC (SPX, VIX, RUT, NDX, etc.) via
 * API — only their web platforms are allowed. We fetch the corresponding
 * ETF candles (SPY, QQQ) and multiply by the live index/ETF ratio
 * (fetched from Schwab each run) to produce accurate index bars. A
 * hardcoded multiplier was wrong once SPX passed ~6000; the dynamic
 * ratio self-corrects regardless of index level and tracks dividend
 * basis drift over time.
 *
 * The cron file name remains `fetch-spx-candles-1m` for cron-schedule
 * stability; despite the name it now ingests both symbols. The two
 * symbol flows run sequentially (SPX, then NDX) with per-symbol error
 * isolation — an NDX Schwab failure does not block SPX, and vice versa.
 * Sequential execution keeps this handler from acquiring two UW
 * concurrency slots simultaneously, which used to put it at the back
 * of the global semaphore queue on busy minutes and trip
 * `MAX_ACQUIRE_ATTEMPTS` saturation alerts (Sentry issue 79). The added
 * latency is ~1 s and well under the cron's 60 s wall budget.
 *
 * Write path (review remediation D1b/D1d, 2026-10-26; same pattern as
 * fetch-etf-candles-1m):
 *   UW returns the whole day on every call. One SELECT reads each
 *   symbol's high-water mark (latest stored minute since ET midnight);
 *   only closed candles after it go to Postgres, in one batched INSERT per
 *   symbol (`bulkUpsert`, ON CONFLICT (symbol, date, timestamp) DO
 *   NOTHING). All sessions UW returns are kept, pre-market (`pr`),
 *   regular (`r`) and post-market (`po`), each tagged with its
 *   market_time; readers filter. HWM-only means a minute that first
 *   appears after a later minute is stored is never backfilled (nor is a
 *   bar dropped as malformed once a later valid one lands). That is
 *   acceptable because SPY and QQQ trade every regular-session minute and
 *   UW documents no late or out-of-order bars. A run that writes nothing
 *   (Schwab or UW down) leaves no gap: the next run's HWM diff picks the
 *   missed minutes up, translated at that run's ratio.
 *
 * The still-forming bar is never written. UW's docs: "The most recent
 * intraday candle is still forming, and its start_time is the start of the
 * current bucket", and the latest bar is the one with the maximum
 * start_time. Writing it would let DO NOTHING plus the HWM freeze a partial
 * bar for good (which the pre-2026-10-26 cron did on every run), so a
 * candle is kept only if it starts before BOTH the minute this run started
 * in and UW's newest candle. The clock alone is not enough: cronJitter
 * fires 0–8 s past the minute, and if UW hasn't opened the next bucket
 * yet, the minute the clock calls closed is still UW's newest, forming
 * bar. Readers therefore see the latest closed minute, not a frozen
 * partial of the current one.
 *
 * Schwab anchor: the symbol's own column (spx_schwab_price for SPX rows,
 * ndx_schwab_price for NDX rows) carries the live Schwab index price on
 * the row for the minute that closed just before this run, written in
 * the same INSERT. The quote is taken seconds after that minute ended, so
 * it stands in for that minute's close. When that minute is held back
 * (UW hasn't opened the next bucket), no row is anchored this run; the
 * next run anchors its own just-closed minute. Before 2026-10-26 the
 * anchor was an UPDATE on the current, still-forming minute's row.
 *
 * Failures surface: a missing Schwab ratio, a UW error, an empty payload
 * (abnormal inside the gated window, which `date=today` fills with
 * pre-market bars from 04:00 ET), a DB reject, or a failed data-quality
 * COUNT fails that symbol (one Sentry exception each, tagged with the
 * symbol). The run reports 'partial' when one symbol fails and 'error'
 * when both do; 'ok' means both landed. 'error' responds 500, which turns
 * the Sentry cron monitor red (withCronCheckin keys its check-in on the
 * HTTP status). A failed HWM read is a crash: 500, Sentry, Axiom 'error'.
 * Malformed candles (unparseable start_time, price, volume or
 * market_time) are dropped, counted and raised as one Sentry warning per
 * symbol, so one bad row can't fail the whole batch every minute.
 *
 * Storage: index_candles_1m (migrations #52, #54, #112–#114), UNIQUE
 * (symbol, date, timestamp).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import {
  deriveCronStatus,
  withCronCheckin,
} from '../_lib/cron-instrumentation.js';
import { getDb, withDbRetry } from '../_lib/db.js';
import { Sentry, metrics } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import {
  uwFetch,
  schwabFetch,
  cronGuard,
  cronJitter,
  checkDataQuality,
  withRetry,
} from '../_lib/api-helpers.js';
import { bulkUpsert } from '../_lib/bulk-upsert.js';
import { reportCronRun } from '../_lib/axiom.js';

const JOB = 'fetch-spx-candles-1m';

// Per-attempt budget for each Neon call (HWM read, batched write, QC).
const DB_ATTEMPT_TIMEOUT_MS = 10_000;

const MINUTE_MS = 60_000;

// ── Types ───────────────────────────────────────────────────

type IndexSymbol = 'SPX' | 'NDX';
type EtfTicker = 'SPY' | 'QQQ';
type MarketTime = 'pr' | 'r' | 'po';

/** market_time values the table's CHECK constraint accepts. */
const MARKET_TIMES: ReadonlySet<unknown> = new Set<MarketTime>([
  'pr',
  'r',
  'po',
]);

/** Minimal Schwab quote shape needed for ratio calculation. */
interface SchwabQuoteEntry {
  quote?: {
    lastPrice?: number;
  };
}

/** Per-symbol live ratio result returned by the Schwab fetch. */
interface RatioResult {
  symbol: IndexSymbol;
  ratio: number;
  indexPrice: number;
}

/** UW 1-minute candle row from /stock/<TICKER>/ohlc/1m. */
interface UWCandleRow {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  total_volume: number;
  start_time: string; // ISO timestamp: "2026-04-08T23:22:00Z"
  end_time: string;
  market_time: MarketTime;
}

/** Row written to index_candles_1m. */
interface IndexCandleRow extends Record<string, unknown> {
  symbol: IndexSymbol;
  date: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  market_time: MarketTime;
  spx_schwab_price: number | null;
  ndx_schwab_price: number | null;
}

const COLUMNS = [
  'symbol',
  'date',
  'timestamp',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'market_time',
  'spx_schwab_price',
  'ndx_schwab_price',
] as const satisfies readonly (keyof IndexCandleRow)[];

/** Per-symbol pipeline configuration. */
interface IndexConfig {
  symbol: IndexSymbol;
  etfTicker: EtfTicker;
}

/** Run order: SPX, then NDX (sequential; see the header). */
const INDEXES: readonly IndexConfig[] = [
  { symbol: 'SPX', etfTicker: 'SPY' },
  { symbol: 'NDX', etfTicker: 'QQQ' },
];

/** Per-symbol result for the response body and the Axiom `meta`. */
interface SymbolResult {
  symbol: IndexSymbol;
  /** Candles UW returned. */
  fetched: number;
  /** Closed, valid candles after the high-water mark: the rows sent. */
  new: number;
  /** Rows sent in a write that succeeded (ON CONFLICT skips not subtracted). */
  stored: number;
  /** fetched − new: at or below the HWM, still forming, or malformed. */
  skipped: number;
  /** Closed candles after the HWM dropped as malformed. */
  malformed: number;
  /** True when a stored row carries this run's Schwab anchor. */
  anchored: boolean;
  ratio?: number;
  indexPrice?: number;
  /** The error message when this symbol's leg failed. */
  reason?: string;
}

// ── Ratio fetch ─────────────────────────────────────────────

function validateRatio(
  symbol: IndexSymbol,
  etfTicker: EtfTicker,
  indexPrice: number | undefined,
  etfPrice: number | undefined,
): RatioResult | null {
  if (
    indexPrice == null ||
    etfPrice == null ||
    indexPrice <= 0 ||
    etfPrice <= 0
  ) {
    logger.warn(
      { symbol, etfTicker, indexPrice, etfPrice },
      `fetch-spx-candles-1m: Missing or invalid ${symbol}/${etfTicker} prices from Schwab`,
    );
    return null;
  }
  return { symbol, ratio: indexPrice / etfPrice, indexPrice };
}

/**
 * Fetch live ratios for SPX/SPY and NDX/QQQ in a single Schwab call.
 *
 * SPY × 10 was a valid approximation when SPX ≈ 5700. As SPX has moved
 * higher the ratio has drifted (~11.6× at SPX 6800) making a hardcoded
 * multiplier inaccurate by hundreds of points. The dividend basis drift
 * is even larger over a quarter — using the live ratio anchors each
 * minute's ETF candle to the real index level at that moment.
 *
 * Returns a Map keyed by index symbol; null entries indicate that
 * symbol's data was unavailable. Per-symbol failures are independent
 * (e.g. NDX missing while SPX is fine still lets SPX proceed).
 */
async function fetchSchwabRatios(): Promise<
  Map<IndexSymbol, RatioResult | null>
> {
  const result = await schwabFetch<Record<string, SchwabQuoteEntry>>(
    '/quotes?symbols=SPY%2C%24SPX%2CQQQ%2C%24NDX&fields=quote',
  );

  const ratios = new Map<IndexSymbol, RatioResult | null>();

  if (!result.ok) {
    logger.warn(
      { status: result.status },
      'fetch-spx-candles-1m: Schwab quote fetch failed',
    );
    ratios.set('SPX', null);
    ratios.set('NDX', null);
    return ratios;
  }

  ratios.set(
    'SPX',
    validateRatio(
      'SPX',
      'SPY',
      result.data['$SPX']?.quote?.lastPrice,
      result.data['SPY']?.quote?.lastPrice,
    ),
  );
  ratios.set(
    'NDX',
    validateRatio(
      'NDX',
      'QQQ',
      result.data['$NDX']?.quote?.lastPrice,
      result.data['QQQ']?.quote?.lastPrice,
    ),
  );

  return ratios;
}

// ── High-water mark ─────────────────────────────────────────

/**
 * Latest stored minute per symbol since ET midnight of `today`, as epoch
 * ms. A symbol with no rows today is absent (null HWM). The bound is
 * `::date::timestamp AT TIME ZONE` because a bare date compares as UTC
 * midnight, 4–5 h early. It reads `timestamp`, not the `date` column, so
 * a mis-tagged `date` can't hide today's rows from the diff.
 */
async function loadHighWaterMarks(
  sql: ReturnType<typeof getDb>,
  today: string,
): Promise<Map<string, number>> {
  const rows = (await withDbRetry(
    () => sql`
      SELECT symbol, MAX(timestamp) AS hwm
      FROM index_candles_1m
      WHERE symbol = ANY(${INDEXES.map((c) => c.symbol)}::text[])
        AND timestamp >= (${today}::date::timestamp AT TIME ZONE 'America/New_York')
      GROUP BY symbol
    `,
    2,
    DB_ATTEMPT_TIMEOUT_MS,
  )) as Array<{ symbol: string; hwm: Date | string }>;
  // Neon returns TIMESTAMPTZ as a Date; new Date() accepts either form.
  return new Map(rows.map((r) => [r.symbol, new Date(r.hwm).getTime()]));
}

// ── Fetch helper ────────────────────────────────────────────

async function fetchETFCandles1m(
  apiKey: string,
  etfTicker: EtfTicker,
  date: string,
): Promise<UWCandleRow[]> {
  // Intraday candles come newest first, so the limit keeps the newest 500.
  const params = new URLSearchParams({
    date,
    limit: '500',
  });

  return uwFetch<UWCandleRow>(apiKey, `/stock/${etfTicker}/ohlc/1m?${params}`);
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

/**
 * True when the candle can be written: numeric prices, an integer volume
 * (`volume` is BIGINT NOT NULL, so a fraction or null fails the whole
 * INSERT) and a market_time the CHECK constraint accepts.
 */
function isWellFormed(c: UWCandleRow): boolean {
  return (
    [c.open, c.high, c.low, c.close].every(isNumeric) &&
    isNumeric(c.volume) &&
    Number.isSafeInteger(Number(c.volume)) &&
    MARKET_TIMES.has(c.market_time)
  );
}

/**
 * Keep candles that are closed, newer than the HWM and well-formed;
 * translate them to index prices; de-duplicate by minute and sort oldest
 * first. Closed means starting before both `clockMinuteMs` and UW's newest
 * candle (max start_time), which UW documents as still forming whatever
 * our clock says. Candles are validated only after the time filters, so a
 * bad bar already behind the HWM isn't re-counted on every run. The row
 * for the minute just before `clockMinuteMs` carries the Schwab anchor.
 */
function selectNewCandles(
  symbol: IndexSymbol,
  today: string,
  candles: readonly UWCandleRow[],
  hwmMs: number | undefined,
  clockMinuteMs: number,
  { ratio, indexPrice }: RatioResult,
): { rows: IndexCandleRow[]; malformed: number } {
  const parsed = candles.map((c) => ({ c, ts: Date.parse(c.start_time) }));
  const newestMs = Math.max(
    ...parsed.map(({ ts }) => ts).filter((ts) => Number.isFinite(ts)),
  );
  const formingFromMs = Math.min(clockMinuteMs, newestMs);
  const anchorMs = clockMinuteMs - MINUTE_MS;

  const byMinute = new Map<number, IndexCandleRow>();
  let malformed = 0;
  for (const { c, ts } of parsed) {
    if (!Number.isFinite(ts)) {
      malformed++;
      continue;
    }
    if (ts >= formingFromMs) continue; // still forming
    if (hwmMs !== undefined && ts <= hwmMs) continue; // already stored
    if (!isWellFormed(c)) {
      malformed++;
      continue;
    }
    if (byMinute.has(ts)) continue;
    const anchor = ts === anchorMs ? indexPrice : null;
    byMinute.set(ts, {
      symbol,
      date: today,
      timestamp: new Date(ts).toISOString(),
      open: Number(c.open) * ratio,
      high: Number(c.high) * ratio,
      low: Number(c.low) * ratio,
      close: Number(c.close) * ratio,
      // Write the value isWellFormed checked: BIGINT rejects '1.0'.
      volume: Number(c.volume),
      market_time: c.market_time,
      spx_schwab_price: symbol === 'SPX' ? anchor : null,
      ndx_schwab_price: symbol === 'NDX' ? anchor : null,
    });
  }
  const rows = [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
  return { rows, malformed };
}

// ── Data quality ────────────────────────────────────────────

/** Alert (via checkDataQuality) when today's stored bars all have zero volume. */
async function checkStoredQuality(
  sql: ReturnType<typeof getDb>,
  { symbol, etfTicker }: IndexConfig,
  today: string,
): Promise<void> {
  const qcRows = (await withDbRetry(
    () => sql`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE volume > 0) AS nonzero
      FROM index_candles_1m
      WHERE symbol = ${symbol}
        AND date = ${today}
    `,
    2,
    DB_ATTEMPT_TIMEOUT_MS,
  )) as Array<{ total: string | number; nonzero: string | number }>;
  const { total, nonzero } = qcRows[0]!;
  await checkDataQuality({
    job: JOB,
    table: 'index_candles_1m',
    date: today,
    sourceFilter: `1-minute ${etfTicker} candles translated to ${symbol}`,
    total: Number(total),
    nonzero: Number(nonzero),
  });
}

// ── Per-symbol pipeline ─────────────────────────────────────

/**
 * Fetch, filter, translate and write one symbol. Fills `result` as it
 * goes so the caller can still report what was fetched (and stored) when
 * a later step rejects; any rejection fails the symbol.
 */
async function ingestIndex(
  sql: ReturnType<typeof getDb>,
  apiKey: string,
  today: string,
  config: IndexConfig,
  ratioResult: RatioResult | null,
  hwmMs: number | undefined,
  clockMinuteMs: number,
  result: SymbolResult,
): Promise<void> {
  const { symbol, etfTicker } = config;

  if (ratioResult === null) {
    metrics.increment(
      `fetch_spx_candles_1m.ratio_unavailable_${symbol.toLowerCase()}`,
    );
    throw new Error(
      `fetch-spx-candles-1m: ${symbol}/${etfTicker} ratio unavailable from Schwab`,
    );
  }
  result.ratio = ratioResult.ratio;
  result.indexPrice = ratioResult.indexPrice;

  const candles = await withRetry(() =>
    fetchETFCandles1m(apiKey, etfTicker, today),
  );
  result.fetched = candles.length;
  // uwFetch only flags a missing `data`; `data: []` arrives silently.
  if (candles.length === 0) {
    metrics.increment('fetch_spx_candles_1m.empty_payload');
    throw new Error(
      `fetch-spx-candles-1m: UW returned no 1m ${etfTicker} candles for ${symbol}`,
    );
  }

  const { rows, malformed } = selectNewCandles(
    symbol,
    today,
    candles,
    hwmMs,
    clockMinuteMs,
    ratioResult,
  );
  result.new = rows.length;
  result.skipped = candles.length - rows.length;
  result.malformed = malformed;

  // conflictUpdateColumns: [] → ON CONFLICT DO NOTHING (closed OHLC bars
  // don't restate). Retries are idempotent because of DO NOTHING on the
  // source-derived (symbol, date, timestamp) key, which matters:
  // withDbRetry's per-attempt timeout doesn't cancel the first attempt,
  // so two can be in flight at once.
  await withDbRetry(
    () =>
      bulkUpsert({
        sql,
        table: 'index_candles_1m',
        columns: COLUMNS,
        rows,
        conflictTarget: '(symbol, date, timestamp)',
        conflictUpdateColumns: [],
      }),
    2,
    DB_ATTEMPT_TIMEOUT_MS,
  ).catch((err: unknown) => {
    // Write failures only; the caller reports every symbol failure.
    metrics.increment('fetch_spx_candles_1m.store_error');
    throw err;
  });
  result.stored = rows.length;
  result.anchored = rows.some(
    (r) => r.spx_schwab_price != null || r.ndx_schwab_price != null,
  );

  if (result.stored > 10) await checkStoredQuality(sql, config, today);
}

/** 'ok' when every symbol landed; the historical Axiom value for success. */
function runStatus(failureCount: number): 'ok' | 'partial' | 'error' {
  const status = deriveCronStatus(failureCount, INDEXES.length);
  return status === 'partial' || status === 'error' ? status : 'ok';
}

// ── Handler ─────────────────────────────────────────────────

export default withCronCheckin(JOB, async (req, res) => {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  await cronJitter();

  const startTime = Date.now();

  try {
    const sql = getDb();
    // Throws to the catch on failure: without a HWM there is nothing safe
    // to diff against, and the DB is the thing that's down.
    const hwm = await loadHighWaterMarks(sql, today);

    // Taken BEFORE the Schwab quote and both UW fetches, so it is never
    // later than the minute UW answers in (an early clock can only hold a
    // closed bar back one run) and the anchor minute is the one that had
    // just closed when the quote was read.
    const clockMinuteMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const ratios = await fetchSchwabRatios();

    const results = {} as Record<IndexSymbol, SymbolResult>;
    let failureCount = 0;

    // Sequential (not Promise.all) so this handler only ever holds one
    // UW concurrency slot at a time. Running both legs in parallel
    // doubled this cron's slot demand and caused MAX_ACQUIRE_ATTEMPTS
    // saturation when 15+ minute-cadence UW crons collided on the
    // global cap-of-3 semaphore (Sentry issue 79). The per-symbol catch
    // isolates the legs: a failure on one still lets the other land.
    for (const config of INDEXES) {
      const { symbol } = config;
      const result: SymbolResult = {
        symbol,
        fetched: 0,
        new: 0,
        stored: 0,
        skipped: 0,
        malformed: 0,
        anchored: false,
      };
      results[symbol] = result;
      try {
        await ingestIndex(
          sql,
          apiKey,
          today,
          config,
          ratios.get(symbol) ?? null,
          hwm.get(symbol),
          clockMinuteMs,
          result,
        );
      } catch (err) {
        failureCount++;
        result.reason = err instanceof Error ? err.message : String(err);
        logger.warn({ err, ...result }, 'fetch-spx-candles-1m: symbol failed');
        Sentry.captureException(err, { tags: { symbol } });
      }
      if (result.malformed > 0) {
        logger.warn(
          { symbol, malformed: result.malformed },
          'fetch-spx-candles-1m: dropped malformed candles',
        );
        metrics.increment('fetch_spx_candles_1m.malformed');
        Sentry.captureMessage(
          'fetch-spx-candles-1m: malformed UW candles dropped',
          { level: 'warning', extra: { symbol, malformed: result.malformed } },
        );
      }
    }

    const { SPX: spx, NDX: ndx } = results;
    const status = runStatus(failureCount);
    const totalStored = spx.stored + ndx.stored;

    logger.info(
      { spx, ndx, totalStored, failureCount, status, date: today },
      'fetch-spx-candles-1m completed',
    );

    // Same top-level keys as before (status, totalStored, durationMs); the
    // spx / ndx objects land in Axiom's `meta`.
    await reportCronRun(JOB, {
      status,
      spx,
      ndx,
      totalStored,
      durationMs: Date.now() - startTime,
    });

    // Top-level fields mirror SPX for backward compatibility with
    // existing monitors / dashboards that key on { stored, ratio,
    // spxPrice, reason }. Per-symbol detail is in the spx / ndx blocks.
    // 'error' answers 500 so withCronCheckin sends an error check-in.
    return res.status(status === 'error' ? 500 : 200).json({
      job: JOB,
      status,
      success: status === 'ok',
      failureCount,
      stored: spx.reason == null ? spx.stored : false,
      skipped: spx.skipped,
      ratio:
        spx.ratio != null ? Math.round(spx.ratio * 10000) / 10000 : undefined,
      spxPrice: spx.indexPrice,
      reason: spx.reason,
      spx,
      ndx,
      totalStored,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', JOB);
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-spx-candles-1m error');
    await reportCronRun(JOB, {
      status: 'error',
      // Not an Axiom column, so it lands in `meta`.
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    });
    return res.status(500).json({ error: 'Internal error' });
  }
});
