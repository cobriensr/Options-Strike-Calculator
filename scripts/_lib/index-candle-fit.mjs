/**
 * The refit's pure parts (spec decision 9, docs/superpowers/specs/
 * 2026-11-24-spx-candle-placeholder-repair.md): read a day's minute price
 * file, fit the day's index ÷ ETF ratio to it under the gates, and check a
 * mapped day against Schwab's daily high and low. No I/O but readSpots' one
 * file read; the repair tool (index-candle-repair.mjs) wires these in.
 *
 *   - readSpots: `<dir>/<SYMBOL>-<date>-spots.json`, as the tape tool's
 *     `--export-spots` writes it;
 *   - fitRatio: the median of price ÷ UW ETF close over the regular minutes
 *     present in both, with the matched-minute, scatter and deviation gates;
 *   - levelCheck: the mapped regular rows against Schwab's daily range.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cashSessionMinutes } from '../../src/data/marketHours.ts';
import { regularBars } from './candles-backfill.mjs';

/**
 * The refit's bounds (spec decision 9), tuned on history before the spec:
 *   spxMinShare    SPX needs this share of cashSessionMinutes(date) matched
 *   ndxMinMinutes  NDX needs this many matched minutes: the floor bounds the
 *                  median's sampling error (about ±0.6 pt at scatter 6)
 *   ndxMaxScatter  NDX parity's scatter bound, in index points
 *   maxDeviation   |fitted ÷ close ratio − 1| bound, both symbols
 *   levelBound     the level check's bound per symbol, in index points
 */
export const FIT = Object.freeze({
  spxMinShare: 0.99,
  ndxMinMinutes: 150,
  ndxMaxScatter: 6,
  maxDeviation: 0.0015,
  levelBound: Object.freeze({ SPX: 2, NDX: 6 }),
});

/** The price file source each symbol's fit needs. */
const SOURCE_FOR = { SPX: 'tape', NDX: 'parity' };

const SOURCES = new Set(Object.values(SOURCE_FOR));

const MINUTE_MS = 60_000;

/** A number for a reason: six significant digits, no float noise. */
function fmt(value) {
  return String(Number(value.toPrecision(6)));
}

/** A signed number for a reason: +2.5, -0.4. */
function fmtSigned(value) {
  return value < 0 ? fmt(value) : `+${fmt(value)}`;
}

/** The median of a non-empty array of numbers: the mean of the middle two when even. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── The price file ─────────────────────────────────────────

/**
 * Read `<dir>/<SYMBOL>-<date>-spots.json`:
 *   { ok: true, source, minutes: Map<UTC epoch minute, price> }
 *   | { ok: false, reason }
 * Never throws. A file that is missing, unreadable, not JSON, not an object,
 * for another symbol or date, from a source other than `tape` or `parity`,
 * without minutes, or holding a minute key that is not a whole number or a
 * price that is not a finite number is `ok: false`, the reason naming the file
 * and what is wrong. Whether the source suits the symbol is fitRatio's gate.
 */
export async function readSpots(dir, symbol, date) {
  const name = `${symbol}-${date}-spots.json`;
  let text;
  try {
    text = await readFile(path.join(dir, name), 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason:
        err?.code === 'ENOENT'
          ? `no price file ${name} in ${dir}`
          : `cannot read price file ${name} in ${dir}: ${err?.code ?? err?.message}`,
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${name} is not JSON: ${err.message}` };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: `${name} is not a JSON object` };
  }
  if (body.symbol !== symbol) {
    return {
      ok: false,
      reason: `${name} is for symbol ${body.symbol}, not ${symbol}`,
    };
  }
  if (body.date !== date) {
    return {
      ok: false,
      reason: `${name} is for date ${body.date}, not ${date}`,
    };
  }
  if (!SOURCES.has(body.source)) {
    return {
      ok: false,
      reason: `${name} has source ${JSON.stringify(body.source)}, not tape or parity`,
    };
  }
  return minutesOf(name, body);
}

/** The ok answer, or the failure, for a parsed file's `minutes` object. */
function minutesOf(name, body) {
  const { minutes: raw } = body;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0
  ) {
    return { ok: false, reason: `${name} has no minutes` };
  }
  const minutes = new Map();
  for (const [key, price] of Object.entries(raw)) {
    // A whole epoch minute: digits only, so "", "-5", "1.5" and "2.9e7" fail.
    const minute = /^\d+$/.test(key) ? Number(key) : Number.NaN;
    if (!Number.isSafeInteger(minute)) {
      return {
        ok: false,
        reason: `${name} has minute key ${JSON.stringify(key)}, not a whole UTC epoch minute`,
      };
    }
    if (!Number.isFinite(price)) {
      return {
        ok: false,
        reason: `${name} has no finite price for minute ${key}`,
      };
    }
    minutes.set(minute, price);
  }
  return { ok: true, source: body.source, minutes };
}

// ── The fit ────────────────────────────────────────────────

/** The matched-minute floor for `symbol` on `date`, and how it is worded. */
function minutesFloor(symbol, date) {
  if (symbol === 'NDX') {
    return {
      floor: FIT.ndxMinMinutes,
      basis: '',
    };
  }
  const session = cashSessionMinutes(date);
  return {
    // At least one minute: a median of nothing is no ratio, whatever the date.
    floor: Math.max(1, Math.ceil(FIT.spxMinShare * session)),
    basis: ` (${fmt(FIT.spxMinShare * 100)}% of its ${session} cash minutes)`,
  };
}

/**
 * Fit the day's index ÷ ETF ratio to the minute price file `spots`:
 *   { ok: true, ratio, matched, scatter } | { ok: false, reason }
 *
 * `bars` are the UW ETF bars as fetchUwCandles returns them, `spots` a
 * readSpots answer (`{ source, minutes }`; `ok` is not read), `closeRatio` the
 * Schwab close ratio (ratioFor). The inputs are regularBars(bars, date): a
 * bar is matched to the file by its start, as a UTC epoch minute, the minute
 * whose prints the tape tool groups. A bar with no price in the file, or no
 * close above 0, is not matched.
 *
 * `ratio` is the median of price ÷ ETF close; `scatter` the median of
 * |e − median(e)|, e = price − ETF close × ratio. The gates, each failing with
 * a reason that names the measure, its value and the bound:
 *   - source: SPX needs `tape`, NDX `parity`;
 *   - matched minutes: SPX at least ceil(0.99 × cashSessionMinutes(date)), NDX
 *     at least 150;
 *   - NDX scatter at most 6 pt (SPX is not gated on it);
 *   - |ratio ÷ closeRatio − 1| at most 0.0015.
 */
export function fitRatio({ symbol, date, bars, spots, closeRatio }) {
  const source = SOURCE_FOR[symbol];
  if (source === undefined) {
    return { ok: false, reason: `no fit for symbol ${symbol}` };
  }
  if (spots.source !== source) {
    return {
      ok: false,
      reason: `price file source ${spots.source} is not ${source}, which ${symbol} needs`,
    };
  }

  const matches = [];
  for (const { bar, ts } of regularBars(bars, date)) {
    const price = spots.minutes.get(Math.floor(ts / MINUTE_MS));
    const close = Number(bar.close);
    if (price !== undefined && close > 0) matches.push({ price, close });
  }
  const matched = matches.length;
  const { floor, basis } = minutesFloor(symbol, date);
  if (matched < floor) {
    return {
      ok: false,
      reason: `matched minutes ${matched} is under the ${floor} an ${symbol} day needs${basis}`,
    };
  }

  const ratio = median(matches.map(({ price, close }) => price / close));
  const residuals = matches.map(({ price, close }) => price - close * ratio);
  const centre = median(residuals);
  const scatter = median(residuals.map((e) => Math.abs(e - centre)));
  if (symbol === 'NDX' && scatter > FIT.ndxMaxScatter) {
    return {
      ok: false,
      reason: `scatter ${fmt(scatter)} is over the ${FIT.ndxMaxScatter} pt an NDX day allows`,
    };
  }
  const deviation = Math.abs(ratio / closeRatio - 1);
  if (deviation > FIT.maxDeviation) {
    return {
      ok: false,
      reason:
        `fitted ratio ${fmt(ratio)} is ${fmt(deviation)} from the close ratio ` +
        `${fmt(closeRatio)}, over the ${FIT.maxDeviation} allowed`,
    };
  }
  return { ok: true, ratio, matched, scatter };
}

// ── The level check ────────────────────────────────────────

/**
 * Check a mapped day against Schwab's daily range: `{ ok, dh, dl, reason? }`.
 * `rows` are toIndexRows' index rows, `high` and `low` Schwab's daily high and
 * low (extremesFor). `dh` is the highest regular row high minus `high`, `dl`
 * the lowest regular row low minus `low`. The day fails when `dh` and `dl`
 * share a sign and the smaller of |dh| and |dl| is over FIT.levelBound[symbol]:
 * a ratio error moves both extremes together, where a live day usually misses
 * one alone. Pre- and post-market rows are not read. A day with no regular
 * row, a range Schwab did not give, or a symbol with no bound fails, with `dh`
 * and `dl` null.
 */
export function levelCheck({ symbol, rows, high, low }) {
  const bound = FIT.levelBound[symbol];
  if (bound === undefined) {
    return {
      ok: false,
      dh: null,
      dl: null,
      reason: `no level bound for ${symbol}`,
    };
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return {
      ok: false,
      dh: null,
      dl: null,
      reason: `no usable Schwab daily high and low for ${symbol}: ${high}, ${low}`,
    };
  }
  const regular = rows.filter((row) => row.market_time === 'r');
  if (regular.length === 0) {
    return {
      ok: false,
      dh: null,
      dl: null,
      reason: `no regular rows to check for ${symbol}`,
    };
  }
  const dh = Math.max(...regular.map((row) => row.high)) - high;
  const dl = Math.min(...regular.map((row) => row.low)) - low;
  const sameSide = (dh > 0 && dl > 0) || (dh < 0 && dl < 0);
  const smaller = Math.min(Math.abs(dh), Math.abs(dl));
  if (sameSide && smaller > bound) {
    return {
      ok: false,
      dh,
      dl,
      reason:
        `${symbol} regular range misses Schwab's daily range on one side: ` +
        `dh ${fmtSigned(dh)}, dl ${fmtSigned(dl)}, the smaller miss ` +
        `${fmt(smaller)} is over the ${bound} pt allowed`,
    };
  }
  return { ok: true, dh, dl };
}
