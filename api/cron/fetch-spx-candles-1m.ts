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
 * symbol flows run in parallel with per-symbol error isolation — an
 * NDX Schwab failure does not block SPX, and vice versa.
 *
 * Storage:
 *   - All candles returned by UW are stored, including premarket
 *     (`pr`) and postmarket (`po`). Filtering is done by the reader
 *     so future premarket/postmarket use cases aren't blocked.
 *   - ON CONFLICT (symbol, date, timestamp) DO NOTHING keeps the cron
 *     idempotent when UW returns a timestamp we already have.
 *   - Each row's symbol-specific anchor column (spx_schwab_price for
 *     SPX rows, ndx_schwab_price for NDX rows) is best-effort UPDATEd
 *     to the live Schwab close so reads can prefer the verified close
 *     over the SPY/QQQ-derived approximation for the current minute.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
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
import { reportCronRun } from '../_lib/axiom.js';

// ── Types ───────────────────────────────────────────────────

type IndexSymbol = 'SPX' | 'NDX';
type EtfTicker = 'SPY' | 'QQQ';

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
  market_time: 'pr' | 'r' | 'po';
}

/** Normalized row ready for insert into index_candles_1m. */
interface IndexCandleRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  market_time: 'pr' | 'r' | 'po';
}

/** Per-symbol pipeline configuration. */
interface IndexConfig {
  symbol: IndexSymbol;
  etfTicker: EtfTicker;
  schwabIndexSymbol: '$SPX' | '$NDX';
}

const SPX_CONFIG: IndexConfig = {
  symbol: 'SPX',
  etfTicker: 'SPY',
  schwabIndexSymbol: '$SPX',
};

const NDX_CONFIG: IndexConfig = {
  symbol: 'NDX',
  etfTicker: 'QQQ',
  schwabIndexSymbol: '$NDX',
};

/** Aggregate per-symbol result for the cron response body. */
interface SymbolResult {
  symbol: IndexSymbol;
  stored: number;
  skipped: number;
  ratio?: number;
  indexPrice?: number;
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
async function fetchSchwabRatios(): Promise<Map<IndexSymbol, RatioResult | null>> {
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

// ── Fetch helper ────────────────────────────────────────────

async function fetchETFCandles1m(
  apiKey: string,
  etfTicker: EtfTicker,
  date: string,
): Promise<UWCandleRow[]> {
  const params = new URLSearchParams({
    date,
    limit: '500',
  });

  return uwFetch<UWCandleRow>(apiKey, `/stock/${etfTicker}/ohlc/1m?${params}`);
}

// ── Transform helper ────────────────────────────────────────

/**
 * Translate UW ETF rows into index-equivalent DB rows using the live
 * ratio. Filters out any row with NaN OHLC values (defensive). Per-symbol
 * metric increments so a partial-data NDX day vs partial-data SPX day
 * can be distinguished in dashboards.
 */
function translateRows(
  rows: UWCandleRow[],
  ratio: number,
  symbol: IndexSymbol,
): IndexCandleRow[] {
  const translated: IndexCandleRow[] = [];

  for (const row of rows) {
    const open = Number.parseFloat(row.open) * ratio;
    const high = Number.parseFloat(row.high) * ratio;
    const low = Number.parseFloat(row.low) * ratio;
    const close = Number.parseFloat(row.close) * ratio;

    if (
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close)
    ) {
      metrics.increment(
        `fetch_spx_candles_1m.ohlc_invalid_${symbol.toLowerCase()}`,
      );
      continue;
    }

    translated.push({
      timestamp: new Date(row.start_time).toISOString(),
      open,
      high,
      low,
      close,
      volume: row.volume,
      market_time: row.market_time,
    });
  }

  return translated;
}

// ── Store helper ────────────────────────────────────────────

async function storeCandles(
  rows: IndexCandleRow[],
  symbol: IndexSymbol,
  today: string,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      rows.map(
        (row) => txn`
          INSERT INTO index_candles_1m (
            symbol, date, timestamp, open, high, low, close, volume, market_time
          )
          VALUES (
            ${symbol}, ${today}, ${row.timestamp},
            ${row.open}, ${row.high}, ${row.low}, ${row.close},
            ${row.volume}, ${row.market_time}
          )
          ON CONFLICT (symbol, date, timestamp) DO NOTHING
          RETURNING id
        `,
      ),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return { stored, skipped: rows.length - stored };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, symbol },
      'Batch index_candles_1m insert failed',
    );
    return { stored: 0, skipped: rows.length };
  }
}

// ── Anchor helper ───────────────────────────────────────────

/**
 * UPDATE the per-symbol Schwab-verified anchor on the current minute's
 * row. Each symbol has its own column (spx_schwab_price for SPX,
 * ndx_schwab_price for NDX) — Postgres tagged-template SQL cannot
 * interpolate column names safely, so each branch is written out.
 *
 * Best-effort: failures are logged but do not abort the cron — the
 * candle is already stored, the anchor is just a refinement.
 */
async function anchorIndexPrice(
  symbol: IndexSymbol,
  indexPrice: number,
  today: string,
  currentMinuteTs: string,
): Promise<void> {
  const sql = getDb();
  if (symbol === 'SPX') {
    await sql`
      UPDATE index_candles_1m
      SET spx_schwab_price = ${indexPrice}
      WHERE symbol = 'SPX'
        AND date = ${today}
        AND timestamp = ${currentMinuteTs}
        AND spx_schwab_price IS NULL
    `;
  } else {
    await sql`
      UPDATE index_candles_1m
      SET ndx_schwab_price = ${indexPrice}
      WHERE symbol = 'NDX'
        AND date = ${today}
        AND timestamp = ${currentMinuteTs}
        AND ndx_schwab_price IS NULL
    `;
  }
}

// ── Per-symbol pipeline ─────────────────────────────────────

async function processIndex(
  config: IndexConfig,
  ratioResult: RatioResult | null,
  apiKey: string,
  today: string,
  currentMinuteTs: string,
): Promise<SymbolResult> {
  const { symbol, etfTicker } = config;

  if (ratioResult === null) {
    metrics.increment(
      `fetch_spx_candles_1m.ratio_unavailable_${symbol.toLowerCase()}`,
    );
    return {
      symbol,
      stored: 0,
      skipped: 0,
      reason: `${symbol}/${etfTicker} ratio unavailable from Schwab`,
    };
  }

  const { ratio, indexPrice } = ratioResult;

  const rawRows = await withRetry(() =>
    fetchETFCandles1m(apiKey, etfTicker, today),
  );

  if (rawRows.length === 0) {
    return { symbol, stored: 0, skipped: 0, ratio, indexPrice, reason: 'No 1m candles' };
  }

  const translated = translateRows(rawRows, ratio, symbol);

  if (translated.length === 0) {
    return {
      symbol,
      stored: 0,
      skipped: 0,
      ratio,
      indexPrice,
      reason: 'No valid 1m candles after filter',
    };
  }

  const result = await withRetry(() => storeCandles(translated, symbol, today));

  // Anchor (best-effort)
  try {
    await anchorIndexPrice(symbol, indexPrice, today, currentMinuteTs);
  } catch (updateErr) {
    logger.warn(
      { updateErr, symbol, currentMinuteTs },
      `fetch-spx-candles-1m: ${symbol.toLowerCase()}_schwab_price UPDATE failed`,
    );
  }

  // Data quality check
  if (result.stored > 10) {
    const qcRows = await getDb()`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE volume > 0) AS nonzero
      FROM index_candles_1m
      WHERE symbol = ${symbol}
        AND date = ${today}
    `;
    const { total, nonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-spx-candles-1m',
      table: 'index_candles_1m',
      date: today,
      sourceFilter: `1-minute ${etfTicker} candles translated to ${symbol}`,
      total: Number(total),
      nonzero: Number(nonzero),
    });
  }

  return {
    symbol,
    stored: result.stored,
    skipped: result.skipped,
    ratio,
    indexPrice,
  };
}

/**
 * Wrap processIndex with a catch-all so a thrown error from one symbol
 * cannot poison the Promise.all and abort the other symbol's flow.
 * Logs the error and returns a SymbolResult with the failure reason.
 */
async function processIndexSafe(
  config: IndexConfig,
  ratioResult: RatioResult | null,
  apiKey: string,
  today: string,
  currentMinuteTs: string,
): Promise<SymbolResult> {
  try {
    return await processIndex(config, ratioResult, apiKey, today, currentMinuteTs);
  } catch (err) {
    Sentry.captureException(err);
    logger.error(
      { err, symbol: config.symbol },
      `fetch-spx-candles-1m: ${config.symbol} flow threw`,
    );
    return {
      symbol: config.symbol,
      stored: 0,
      skipped: 0,
      reason: `${config.symbol} flow threw: ${(err as Error).message ?? 'unknown'}`,
    };
  }
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey, today } = guard;

  await cronJitter();

  const startTime = Date.now();

  try {
    const ratios = await fetchSchwabRatios();

    const now = new Date();
    now.setSeconds(0, 0);
    const currentMinuteTs = now.toISOString();

    // Per-symbol error isolation: NDX failure does not block SPX, and
    // vice versa. processIndexSafe wraps each flow so a thrown error
    // becomes a SymbolResult with a reason rather than rejecting the
    // Promise.all.
    const [spxResult, ndxResult] = await Promise.all([
      processIndexSafe(
        SPX_CONFIG,
        ratios.get('SPX') ?? null,
        apiKey,
        today,
        currentMinuteTs,
      ),
      processIndexSafe(
        NDX_CONFIG,
        ratios.get('NDX') ?? null,
        apiKey,
        today,
        currentMinuteTs,
      ),
    ]);

    const totalStored = spxResult.stored + ndxResult.stored;

    logger.info(
      {
        spx: spxResult,
        ndx: ndxResult,
        totalStored,
        date: today,
      },
      'fetch-spx-candles-1m completed',
    );

    await reportCronRun('fetch-spx-candles-1m', {
      status: 'ok',
      spx: spxResult,
      ndx: ndxResult,
      totalStored,
      durationMs: Date.now() - startTime,
    });

    // Top-level fields mirror SPX for backward compatibility with
    // existing monitors / dashboards that key on { stored, ratio,
    // spxPrice, reason }. Per-symbol detail is in the spx / ndx blocks.
    const spxStoredField: number | false = spxResult.reason
      ? false
      : spxResult.stored;

    return res.status(200).json({
      job: 'fetch-spx-candles-1m',
      success: true,
      stored: spxStoredField,
      skipped: spxResult.skipped,
      ratio:
        spxResult.ratio != null
          ? Math.round(spxResult.ratio * 10000) / 10000
          : undefined,
      spxPrice: spxResult.indexPrice,
      reason: spxResult.reason,
      spx: spxResult,
      ndx: ndxResult,
      totalStored,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    Sentry.setTag('cron.job', 'fetch-spx-candles-1m');
    Sentry.captureException(err);
    logger.error({ err }, 'fetch-spx-candles-1m error');
    return res.status(500).json({ error: 'Internal error' });
  }
}
