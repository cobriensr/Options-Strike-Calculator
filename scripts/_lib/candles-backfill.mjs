/**
 * The 1-minute candle backfills' own logic: etf_candles_1m (SPY, QQQ as UW
 * sends them) and index_candles_1m (SPX, NDX, translated from SPY and QQQ).
 * The CLI, the day loop and the failure bookkeeping are backfill-cli.mjs's;
 * the Schwab token is schwab-local.mjs's; the UW GET is uw-day-fetch.mjs's.
 * What is here is what only the candles need:
 *
 *   - planCandleDays: the flags and the trading days to fill;
 *   - the per-day ratio: loadSchwabCloses fetches the daily closes of $SPX,
 *     SPY, $NDX and QQQ from Schwab, ratioFor reads SPX close ÷ SPY close
 *     (NDX ÷ QQQ) for a date, ratioLines prints the table for review;
 *   - the bar mapping, mirroring api/cron/fetch-etf-candles-1m.ts and
 *     api/cron/fetch-spx-candles-1m.ts: toEtfRows, toIndexRows;
 *   - ETF_TARGET and INDEX_TARGET: each table's real unique key, for
 *     backfill-cli's storeRows (≤500-row INSERT ... ON CONFLICT DO NOTHING);
 *   - the two day workers, processEtfDay and processIndexDay, which fan out
 *     over tickers or symbols with runDayItems.
 *
 * Owner decision (2026-11-05): the summer SPX and NDX candles are UW's SPY and
 * QQQ 1-minute bars times a per-day ratio, SPX close ÷ SPY close and NDX close
 * ÷ QQQ close, both closes from Schwab's daily history for that date. Never the
 * old constants (10 and 41). A date with no ratio is a failed day, never a
 * fallback.
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md (P3.1).
 */

import { isTradingDay } from '../../src/data/marketHours.ts';
import { getETDateStr } from '../../src/utils/timezone.ts';
import {
  DayFailure,
  classifyFailure,
  planRangeDays,
  runDayItems,
  storeRows,
  summarizeItemRun,
} from './backfill-cli.mjs';
import {
  SCHWAB_BASE,
  getSchwabAccessToken,
  redactBody,
} from './schwab-local.mjs';
import { UW_BASE, fetchUwDayRows } from './uw-day-fetch.mjs';

// ── Constants ──────────────────────────────────────────────

/** Explicit UA: UW turns away some default client UAs (Python-urllib). */
export const UW_USER_AGENT = 'strike-calculator-candles-backfill (node)';

/**
 * UW's cap on /stock/{ticker}/ohlc/{size} rows ("limited to 2,500 elements").
 * A full extended session is about 960 one-minute bars (pr 330, r 390, po 240),
 * so a day that reaches the cap was cut short, and the day fails. The default
 * limit is far lower: the old etf script sent none and read a 500-bar slice.
 */
export const UW_CANDLE_LIMIT = 2500;

/** The tickers etf_candles_1m holds: what fetch-etf-candles-1m.ts covers. */
export const ETF_TICKERS = ['SPY', 'QQQ'];

/**
 * The index symbols index_candles_1m holds from this backfill, with the ETF
 * each is translated from and the Schwab symbol of the index close.
 * fetch-spx-candles-1m.ts covers the same two.
 */
export const INDEXES = [
  { symbol: 'SPX', etf: 'SPY', schwabIndex: '$SPX' },
  { symbol: 'NDX', etf: 'QQQ', schwabIndex: '$NDX' },
];

/** The four Schwab daily histories the two ratios need. */
const SCHWAB_SYMBOLS = INDEXES.flatMap((i) => [i.schwabIndex, i.etf]);

const DAY_MS = 86_400_000;

// ── Flags ──────────────────────────────────────────────────

/**
 * Parse the candle scripts' flags and pick the days to fill. Throws a message
 * naming the problem; the scripts exit 2 on it.
 *
 * Unlike the other retrofits there is no lookback default: --from and --to are
 * required, because the old 30-day default could not reach a gap, and the
 * ratio is fetched for the range. --to must be a finished ET day: for today
 * the live crons own the bars, and the day's last bar is still forming.
 * --limit keeps the first N trading days of the range, in order.
 */
export function planCandleDays(argv) {
  return planRangeDays(
    argv,
    'the candle backfills have no default window ' +
      '(the old 30-day one could not reach a gap)',
  );
}

// ── Schwab daily closes and the per-day ratio ──────────────

/**
 * Schwab's daily closes of `symbol` from `from` to `to` (YYYY-MM-DD, ET), as a
 * Map of ET date → close. One /pricehistory call: daily candles over the range
 * padded by two days each side (the candle stamp is a midnight of some zone,
 * and the date it names is read in ET below, the way fetch-outcomes.ts reads
 * it), never past now.
 *
 * Throws on an HTTP error (the status and a masked body), a network error or
 * timeout (the fetch's own), a body that isn't JSON or has no `candles` array
 * (a SyntaxError), and a candle that lands on a day that isn't a trading day
 * (a SyntaxError: the stamp-to-date mapping is wrong, which would shift every
 * ratio a day). A candle with no usable close (not a finite number above 0)
 * is left out, so its date reads as having no close.
 */
export async function fetchSchwabDailyCloses(accessToken, symbol, from, to) {
  const params = new URLSearchParams({
    symbol,
    periodType: 'year',
    frequencyType: 'daily',
    frequency: '1',
    startDate: String(Date.parse(`${from}T00:00:00Z`) - 2 * DAY_MS),
    endDate: String(
      Math.min(Date.parse(`${to}T23:59:59Z`) + 2 * DAY_MS, Date.now()),
    ),
  });
  const res = await fetch(`${SCHWAB_BASE}/pricehistory?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Schwab pricehistory ${symbol} HTTP ${res.status}: ${redactBody(text)}`,
    );
  }
  const body = await res.json();
  if (!Array.isArray(body?.candles)) {
    throw new SyntaxError(
      `Schwab pricehistory ${symbol}: no candles array in the response`,
    );
  }
  const closes = new Map();
  for (const candle of body.candles) {
    if (!Number.isFinite(candle?.close) || candle.close <= 0) continue;
    const date = getETDateStr(new Date(candle.datetime));
    if (!isTradingDay(date)) {
      throw new SyntaxError(
        `Schwab pricehistory ${symbol}: the daily candle stamped ` +
          `${candle.datetime} reads as ${date}, not a trading day`,
      );
    }
    closes.set(date, candle.close);
  }
  return closes;
}

/** A thrown error as the `{ kind, detail }` a missing ratio carries. */
function failureOf(err) {
  const { kind, detail } = classifyFailure(err);
  return { kind, detail };
}

/**
 * Schwab's daily closes for the four symbols, `from` to `to`, as a Map of
 * Schwab symbol → `{ closes: Map<date, close> }` or `{ failure: { kind,
 * detail } }`. Never throws: a symbol whose call fails is that failure, and
 * when the token itself can't be had (SchwabAuthError) all four are. A
 * failure surfaces as the failed days that needed it (ratioFor), so the run
 * reports it by name instead of ending.
 *
 * `redis` is an Upstash client; `creds` is `{ clientId, clientSecret }`.
 */
export async function loadSchwabCloses(redis, creds, from, to) {
  const closes = new Map();
  let token;
  try {
    token = await getSchwabAccessToken(redis, creds);
  } catch (err) {
    for (const symbol of SCHWAB_SYMBOLS) {
      closes.set(symbol, { failure: failureOf(err) });
    }
    return closes;
  }
  for (const symbol of SCHWAB_SYMBOLS) {
    try {
      closes.set(symbol, {
        closes: await fetchSchwabDailyCloses(token, symbol, from, to),
      });
    } catch (err) {
      closes.set(symbol, { failure: failureOf(err) });
    }
  }
  return closes;
}

/** One Schwab close: `{ close }`, or `{ failure }` saying why there is none. */
function closeOf(closes, schwabSymbol, date) {
  const entry = closes.get(schwabSymbol);
  if (entry?.failure) {
    return {
      failure: {
        kind: entry.failure.kind,
        detail: `Schwab ${schwabSymbol} daily history failed: ${entry.failure.detail}`,
      },
    };
  }
  const close = entry?.closes.get(date);
  if (!Number.isFinite(close) || close <= 0) {
    return {
      failure: {
        kind: 'other',
        detail: `Schwab has no ${schwabSymbol} daily close for ${date}`,
      },
    };
  }
  return { close };
}

/** The ratio for `symbol` on `date`: `{ ratio, indexClose, etfClose }` or `{ failure }`. */
function ratioOutcome(closes, symbol, date) {
  const { etf, schwabIndex } = INDEXES.find((i) => i.symbol === symbol);
  const index = closeOf(closes, schwabIndex, date);
  if (index.failure) return { failure: index.failure };
  const etfClose = closeOf(closes, etf, date);
  if (etfClose.failure) return { failure: etfClose.failure };
  return {
    ratio: index.close / etfClose.close,
    indexClose: index.close,
    etfClose: etfClose.close,
  };
}

/**
 * The ratio the index bars of `date` are scaled by: the index's Schwab daily
 * close over its ETF's, `{ ratio, indexClose, etfClose }`. Both closes come
 * from Schwab's daily history for that date (loadSchwabCloses), so they are
 * the same source. Throws a DayFailure when either is missing, the kind that
 * of the Schwab failure behind it (`other` for a date Schwab has no close
 * for). There is no fallback ratio.
 */
export function ratioFor(closes, symbol, date) {
  const outcome = ratioOutcome(closes, symbol, date);
  if (outcome.failure) {
    throw new DayFailure(
      outcome.failure.kind,
      `no ratio for ${symbol} on ${date}: ${outcome.failure.detail}`,
    );
  }
  return outcome;
}

/**
 * The ratio table to print before a run, one line per date with each index's
 * closes and ratio (or why it has none), under a header line. For the owner to
 * read before anything is written.
 */
export function ratioLines(closes, dates) {
  const lines = ['ratio = index close ÷ ETF close, Schwab daily, per date:'];
  for (const date of dates) {
    const parts = INDEXES.map(({ symbol, etf }) => {
      const outcome = ratioOutcome(closes, symbol, date);
      if (outcome.failure) {
        // One line each: a detail may hold a newline (a Schwab error body).
        const why = outcome.failure.detail.replaceAll(/\s+/g, ' ');
        return `${symbol} NO RATIO (${why})`;
      }
      return (
        `${symbol} ${outcome.indexClose} ÷ ${etf} ${outcome.etfClose} = ` +
        `${Number(outcome.ratio.toFixed(6))}`
      );
    });
    lines.push(`  ${date}  ${parts.join('  ')}`);
  }
  return lines;
}

// ── Bar mapping ────────────────────────────────────────────

/** market_time values the table's CHECK constraint accepts. */
const MARKET_TIMES = new Set(['pr', 'r', 'po']);

function isNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  );
}

function hasPrices(bar) {
  return [bar.open, bar.high, bar.low, bar.close].every(isNumeric);
}

/** BIGINT: a whole number the driver can carry. */
function isWholeNumber(value) {
  return isNumeric(value) && Number.isSafeInteger(Number(value));
}

/** etf_candles_1m: volume may be absent (nullable), never a fraction. */
function isEtfBar(bar) {
  return hasPrices(bar) && (bar.volume == null || isWholeNumber(bar.volume));
}

/** index_candles_1m: volume is NOT NULL and market_time is CHECKed. */
function isIndexBar(bar) {
  return (
    hasPrices(bar) &&
    isWholeNumber(bar.volume) &&
    MARKET_TIMES.has(bar.market_time)
  );
}

/**
 * The bars to write for ET `date`, oldest first, one per minute: `{ bar, ts }`
 * pairs, plus how many bars were left out. A bar is left out for an
 * unparseable start_time, a start_time on another ET day, prices or a volume
 * `isWellFormed` rejects, or a minute already taken (the first bar of a minute
 * wins, as in the live crons). `fetched` therefore equals kept + dropped.
 *
 * The live crons write every bar `?date=today` returns, tagged `today`. The
 * ET-day check is the backfill's own: UW documents the answer as the whole ET
 * day (its post-market bars fall on the next UTC date), so a bar on another
 * ET day is unexpected, and storing it under `date` would put one timestamp
 * under two dates (dark-pool-query.ts joins on the timestamp alone).
 */
function selectBars(bars, date, isWellFormed) {
  const byMinute = new Map();
  let dropped = 0;
  for (const bar of bars) {
    const ts = Date.parse(bar.start_time);
    if (
      !Number.isFinite(ts) ||
      getETDateStr(new Date(ts)) !== date ||
      !isWellFormed(bar) ||
      byMinute.has(ts)
    ) {
      dropped++;
      continue;
    }
    byMinute.set(ts, bar);
  }
  const picked = [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, bar]) => ({ bar, ts }));
  return { picked, dropped };
}

/**
 * UW bars → etf_candles_1m rows, as fetch-etf-candles-1m.ts writes them: the
 * prices exactly as UW sent them, the minute as an ISO time, volume a whole
 * number or null. `{ rows, dropped }`.
 */
export function toEtfRows(ticker, date, bars) {
  const { picked, dropped } = selectBars(bars, date, isEtfBar);
  const rows = picked.map(({ bar, ts }) => ({
    ticker,
    timestamp: new Date(ts).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume == null ? null : Number(bar.volume),
  }));
  return { rows, dropped };
}

/**
 * UW ETF bars → index_candles_1m rows, as fetch-spx-candles-1m.ts writes
 * them: each price times `ratio`, `date` the ET day, every session kept (pr,
 * r, po) with its market_time. `{ rows, dropped }`.
 *
 * spx_schwab_price and ndx_schwab_price are NULL on every backfilled row. On a
 * live row they hold the Schwab index price read seconds after that minute
 * closed ("use it for precise price level claims", claude-tools.ts), and no
 * per-minute Schwab price exists for these days. The day's close is a
 * day-level fact (outcomes.settlement), and putting it on every row would
 * claim a per-minute check that never happened. The readers handle NULL:
 * getSpxCandles (db-claude-tools.ts) maps it to null, and the tool text says
 * "when present".
 */
export function toIndexRows(symbol, date, bars, ratio) {
  const { picked, dropped } = selectBars(bars, date, isIndexBar);
  const rows = picked.map(({ bar, ts }) => ({
    symbol,
    date,
    timestamp: new Date(ts).toISOString(),
    open: Number(bar.open) * ratio,
    high: Number(bar.high) * ratio,
    low: Number(bar.low) * ratio,
    close: Number(bar.close) * ratio,
    volume: Number(bar.volume),
    market_time: bar.market_time,
    spx_schwab_price: null,
    ndx_schwab_price: null,
  }));
  return { rows, dropped };
}

// ── Writes ─────────────────────────────────────────────────
// storeRows (backfill-cli.mjs) writes DO NOTHING like the live crons: a closed
// bar doesn't restate, so the 07-22 partial day keeps the rows the live cron
// wrote that morning.

/** Where etf rows go: etf_candles_1m, UNIQUE (ticker, timestamp) (migration #94). */
export const ETF_TARGET = {
  table: 'etf_candles_1m',
  columns: ['ticker', 'timestamp', 'open', 'high', 'low', 'close', 'volume'],
  conflictTarget: '(ticker, timestamp)',
};

/** Where index rows go: index_candles_1m, UNIQUE (symbol, date, timestamp) (#112). */
export const INDEX_TARGET = {
  table: 'index_candles_1m',
  columns: [
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
  ],
  conflictTarget: '(symbol, date, timestamp)',
};

// ── UW ─────────────────────────────────────────────────────

/**
 * One UW GET /stock/{ticker}/ohlc/1m?date=&limit=2500 for an ET day, through
 * fetchUwDayRows: `waitForSlot()` (the throttle) before every attempt, one
 * retry after 1 s on a 5xx, a 429, a network error or a timeout. Never throws:
 *   { kind: 'ok', rows } | { kind: 'empty' }
 *   | { kind: 'error', status: 'http_<n>' | 'network' | 'timeout' | 'malformed', detail }
 * A 4xx is an error, never an empty day, and a bar with no string start_time
 * makes the answer malformed.
 */
export async function fetchUwCandles(apiKey, ticker, date, waitForSlot) {
  const url =
    `${UW_BASE}/stock/${encodeURIComponent(ticker)}/ohlc/1m` +
    `?date=${date}&limit=${UW_CANDLE_LIMIT}`;
  return fetchUwDayRows(url, apiKey, {
    rowField: 'start_time',
    rowLabel: 'candle',
    userAgent: UW_USER_AGENT,
    waitForSlot,
  });
}

/**
 * The bars of one ticker-day, or the UW error outcome, or a thrown error when
 * the answer has reached UW's row cap. `{ rows }` for an empty day is `[]`.
 */
async function barsOf(ctx, ticker, date) {
  const outcome = await fetchUwCandles(
    ctx.apiKey,
    ticker,
    date,
    ctx.waitForSlot,
  );
  if (outcome.kind === 'error') return { outcome };
  if (outcome.kind === 'empty') return { bars: [] };
  if (outcome.rows.length >= UW_CANDLE_LIMIT) {
    throw new Error(
      `UW returned ${outcome.rows.length} ${ticker} candles for ${date}, ` +
        `its ${UW_CANDLE_LIMIT}-row cap: the day may be cut short`,
    );
  }
  return { bars: outcome.rows };
}

// ── Day workers ────────────────────────────────────────────

/**
 * What a day worker needs, from the script:
 *   apiKey       the UW key
 *   sql          a Neon `sql` (null on a dry run)
 *   dryRun       fetch and map, write nothing
 *   waitForSlot  the UW throttle (createRequestThrottle)
 *   closes       processIndexDay only: loadSchwabCloses' answer
 */

async function ingestEtfTicker(ticker, date, ctx) {
  const { bars, outcome } = await barsOf(ctx, ticker, date);
  if (outcome) return outcome;
  const { rows, dropped } = toEtfRows(ticker, date, bars);
  const stored = await storeRows(ctx.sql, ETF_TARGET, rows, ctx);
  return {
    fetched: bars.length,
    stored,
    kept: rows.length,
    dropped,
    emptyItems: bars.length === 0 ? 1 : 0,
  };
}

/**
 * One day of etf_candles_1m: SPY and QQQ, each fetched, mapped and written.
 * A runDays worker. Returns `{ fetched, stored, kept, dropped, emptyItems }`
 * summed over the tickers (`fetched` the bars UW sent, `kept` the rows that
 * passed the filters, so the would-be count on a dry run, `stored` the rows
 * the database took, `emptyItems` how many tickers UW sent no bars for). One
 * ticker failing doesn't stop the other; the day then fails with the first
 * failure's kind (runDayItems).
 *
 * `emptyItems` is there because the other totals hide a hole: with SPY empty
 * and QQQ at 960 bars the day reads `fetched 960 stored 960`. It is not a
 * failure (a wholly empty day isn't either); summarizeCandleRun lists the
 * dates.
 */
export function processEtfDay(date, ctx) {
  return runDayItems(
    ETF_TICKERS,
    (ticker) => ingestEtfTicker(ticker, date, ctx),
    { label: 'tickers' },
  );
}

async function ingestIndex(symbol, date, ctx) {
  // The ratio first: with none there is no row to build, so UW isn't asked.
  const { ratio } = ratioFor(ctx.closes, symbol, date);
  const { etf } = INDEXES.find((i) => i.symbol === symbol);
  const { bars, outcome } = await barsOf(ctx, etf, date);
  if (outcome) return outcome;
  const { rows, dropped } = toIndexRows(symbol, date, bars, ratio);
  const stored = await storeRows(ctx.sql, INDEX_TARGET, rows, ctx);
  return {
    fetched: bars.length,
    stored,
    kept: rows.length,
    dropped,
    emptyItems: bars.length === 0 ? 1 : 0,
  };
}

/**
 * One day of index_candles_1m: SPX from SPY and NDX from QQQ, each at that
 * date's Schwab ratio. A runDays worker with processEtfDay's counts
 * (`emptyItems` counts the symbols whose ETF UW sent no bars for: SPX has no
 * rows when SPY is empty). A symbol with no ratio for the date fails
 * (ratioFor) before UW is asked for it; the other symbol still runs, and the
 * day fails with the first failure's kind.
 */
export function processIndexDay(date, ctx) {
  return runDayItems(
    INDEXES.map((i) => i.symbol),
    (symbol) => ingestIndex(symbol, date, ctx),
    { label: 'symbols' },
  );
}

// ── Report ─────────────────────────────────────────────────

/**
 * The end-of-run report for a runDays result of processEtfDay or
 * processIndexDay: backfill-cli's summary lines and exit code, plus one line
 * naming the days where some, not all, of the tickers or symbols had no bars
 * (summarizeItemRun). `itemCount` is how many items a day fans out over and
 * `itemLabel` what they are called ('tickers' or 'symbols').
 */
export function summarizeCandleRun(run, itemCount, itemLabel) {
  return summarizeItemRun(run, itemCount, itemLabel, 'bars');
}
