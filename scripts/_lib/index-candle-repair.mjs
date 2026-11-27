/**
 * The logic of scripts/repair-index-candle-placeholders.mjs: replace the
 * placeholder SPX and NDX one-minute rows in index_candles_1m with rows built
 * the owner-approved way (UW's SPY or QQQ final bar times that day's Schwab
 * daily-close ratio), one date and one symbol at a time, with a backup and an
 * undo. The CLI is arguments, guards and wiring; every decision is here.
 * Spec: docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md
 * (Findings and Decision 2).
 *
 * What is a placeholder:
 *   - SPX: SPY x 10.0000 on 2026-02-25 -> 04-10, written before 2026-04-11
 *     (the old backfill, then the live cron until its fix). On 04-10 the real
 *     bars start at 17:11Z, so only the timestamp clause tells them apart.
 *   - NDX: QQQ x 48 on 2026-03-23 -> 05-01, all from one batch written
 *     2026-05-03 23:21-23:36 UTC.
 *   The created_at cuts are what make a re-run safe: a repaired row is written
 *   after them, so it is never selected again. An undo restores the old
 *   created_at, so a later repair selects those rows again.
 *
 * One date, one transaction:
 *   prepareDay   fetch, map and check the day. No writes.
 *   repairDay    read the day's rows, back up the ones the predicate selects
 *                (JSONL, every column as text), write the manifest, then in one
 *                sql.transaction delete those rows and insert the mapped ones.
 *   undoRepair   one transaction: remove what the run inserted and put the
 *                backed-up rows back with their own id and created_at.
 *
 * The refit (spec decision 9) replaces a repaired date's rows with rows mapped
 * at a ratio fitted to a minute price file (the tape for SPX, NDXP parity for
 * NDX), the same way:
 *   findRefitManifest  which rows are the date's current repaired rows: the
 *                      one committed manifest whose inserted rows all still
 *                      exist (or, for a summer date, the 11-06 backfill's rows).
 *   prepareRefitDay    fetch, fit, map and check the day against Schwab's daily
 *                      range. No writes, and no close reference is read.
 *   refitDay           back up those rows, write a `kind: 'refit'` manifest,
 *                      then one transaction deletes them by id and inserts the
 *                      fitted rows. undoRepair undoes it unchanged.
 *   checkRefitDay      read-only: the stored regular rows against Schwab's
 *                      range, and the stored rows against the backup.
 *
 * SQL is tagged templates only: sql.transaction takes lazy statements, and
 * only a tagged template is lazy on both neon and the pglite test client.
 * Inserts are unnest batches of at most WRITE_BATCH (500) rows (R5).
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { cashSessionMinutes } from '../../src/data/marketHours.ts';
import {
  DayFailure,
  WRITE_BATCH,
  chunk,
  classifyFailure,
  formatRunSummary,
  marketHoursRefusal,
  retryTransientDb,
  summarizeRun,
  tradingDaysInRange,
} from './backfill-cli.mjs';
import {
  INDEXES,
  UW_CANDLE_LIMIT,
  extremesFor,
  fetchUwCandles,
  ratioFor,
  regularBars,
  toIndexRows,
} from './candles-backfill.mjs';
import { fitRatio, levelCheck, readSpots } from './index-candle-fit.mjs';
import { schwabCronsBusyRefusal } from './schwab-local.mjs';

// ── The lists ──────────────────────────────────────────────

/**
 * Spec decision 2: exact dates, never a range that touches another day. The
 * trading days come from src/data/marketHours.ts (Good Friday 2026-04-03 is
 * not one). The test pins the counts and the ends. `summer` (decision 9) is the
 * 2026-11-06 backfill's days: it is refit-only.
 */
const LIST_RANGES = {
  'spx-repair': [['2026-02-25', '2026-04-10']],
  'ndx-repair': [['2026-03-23', '2026-05-01']],
  'ndx-fill': [['2026-02-25', '2026-03-20']],
  gap: [
    ['2026-09-21', '2026-09-30'],
    ['2026-10-08', '2026-10-15'],
  ],
  summer: [['2026-07-22', '2026-09-04']],
};

export const REPAIR_LISTS = Object.freeze(
  Object.fromEntries(
    Object.entries(LIST_RANGES).map(([name, ranges]) => [
      name,
      Object.freeze(
        ranges.flatMap(([from, to]) => tradingDaysInRange(from, to)),
      ),
    ]),
  ),
);

/** Which symbols each list is for. */
export const LIST_SYMBOLS = Object.freeze({
  'spx-repair': Object.freeze(['SPX']),
  'ndx-repair': Object.freeze(['NDX']),
  'ndx-fill': Object.freeze(['NDX']),
  gap: Object.freeze(['SPX', 'NDX']),
  summer: Object.freeze(['SPX', 'NDX']),
});

/**
 * The lists only a refit may use: their rows come from the 11-06 backfill, not
 * from a placeholder the repair's delete predicate describes.
 */
const REFIT_ONLY_LISTS = new Set(['summer']);

/** Maps, so a list name like "constructor" is not found on a prototype. */
const LIST_DATES = new Map(Object.entries(REPAIR_LISTS));
const LIST_SYMBOL_MAP = new Map(Object.entries(LIST_SYMBOLS));
const SYMBOLS = INDEXES.map((i) => i.symbol);
const REPAIR_DATES = {
  SPX: new Set(REPAIR_LISTS['spx-repair']),
  NDX: new Set(REPAIR_LISTS['ndx-repair']),
};

// ── The delete predicate ───────────────────────────────────

/** SPX rows written before this are the placeholders (UTC midnight, 04-11). */
const SPX_CREATED_BEFORE = '2026-04-11T00:00:00Z';
/** On this date the live cron's fix landed mid-day... */
const SPX_CUT_DATE = '2026-04-10';
/** ...and its first real bar is the 13:11 ET one. Earlier rows are placeholders. */
const SPX_CUT_TIMESTAMP = '2026-04-10T17:11:00Z';
/** The one NDX batch: every row written in this window is a x48 placeholder. */
const NDX_BATCH_FROM = '2026-05-03T23:00:00Z';
const NDX_BATCH_THROUGH = '2026-05-03T23:59:59Z';

/**
 * What a repair of `symbol` on `date` may delete: `{ kind: 'repair', ... }`
 * with the bounds of the predicate, or `{ kind: 'fill' }` for a date the
 * symbol has no placeholder on (a fill or gap date: insert only). The bounds
 * are bound parameters of one tagged template (readDay), never spliced text:
 *   createdFrom      created_at >= (inclusive)
 *   createdThrough   created_at <= (inclusive)
 *   createdBefore    created_at <  (exclusive)
 *   timestampBefore  timestamp  <  (exclusive)
 * A null bound does not apply. Every repair selection has a created_at upper
 * bound, so a row written after the cut is never selected.
 */
export function deleteSelection(symbol, date) {
  if (!SYMBOLS.includes(symbol)) {
    throw new RangeError(`no repair for symbol ${symbol}`);
  }
  if (!REPAIR_DATES[symbol].has(date)) return { kind: 'fill' };
  if (symbol === 'SPX') {
    return {
      kind: 'repair',
      createdFrom: null,
      createdThrough: null,
      createdBefore: SPX_CREATED_BEFORE,
      timestampBefore: date === SPX_CUT_DATE ? SPX_CUT_TIMESTAMP : null,
    };
  }
  return {
    kind: 'repair',
    createdFrom: NDX_BATCH_FROM,
    createdThrough: NDX_BATCH_THROUGH,
    createdBefore: null,
    timestampBefore: null,
  };
}

// ── The day check ──────────────────────────────────────────

/** Points the last regular close may sit from its reference (spec Thresholds). */
const CLOSE_TOLERANCE = { SPX: 4, NDX: 15 };

function finiteOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fail(reason) {
  return { ok: false, reason };
}

/** Two decimals, no float noise, for a message. */
function pts(value) {
  return String(Number(value.toFixed(2)));
}

/**
 * The check a mapped day must pass before anything is written: the regular
 * bars number exactly cashSessionMinutes(date), and the last regular close is
 * within 4 pt of outcomes.settlement (SPX) or 15 pt of the Schwab $NDX daily
 * close (NDX). `rows` are toIndexRows' rows; `settlement` and `ndxClose` are
 * numbers or null. `{ ok: true }` or `{ ok: false, reason }`.
 *
 * A `fitted` day (spec decision 9) keeps the count check only: the closes are
 * auction prices the last regular bar often misses, so neither close check
 * applies, and no reference is read or needed.
 */
export function checkMappedDay({
  symbol,
  date,
  rows,
  settlement,
  ndxClose,
  fitted = false,
}) {
  const tolerance = CLOSE_TOLERANCE[symbol];
  if (tolerance == null) throw new RangeError(`no day check for ${symbol}`);
  const regular = rows.filter((r) => r.market_time === 'r');
  const expected = cashSessionMinutes(date);
  if (regular.length === 0 || regular.length !== expected) {
    return fail(
      `${regular.length} regular bars, expected ${expected} for ${date}`,
    );
  }
  if (fitted) return { ok: true };
  const reference = finiteOrNull(symbol === 'SPX' ? settlement : ndxClose);
  const referenceName =
    symbol === 'SPX' ? 'outcomes.settlement' : 'the Schwab $NDX daily close';
  if (reference == null) return fail(`no ${referenceName} for ${date}`);
  const last = regular.reduce((a, b) =>
    Date.parse(b.timestamp) > Date.parse(a.timestamp) ? b : a,
  );
  const distance = Math.abs(Number(last.close) - reference);
  if (distance > tolerance) {
    return fail(
      `the last regular close ${pts(Number(last.close))} is ${pts(distance)} pt ` +
        `from ${referenceName} ${pts(reference)} (limit ${tolerance} pt)`,
    );
  }
  return { ok: true };
}

// ── Reading ────────────────────────────────────────────────

/** outcomes.settlement for `date` as a number, or null when there is no row. */
async function readSettlement(sql, date) {
  const rows = await retryTransientDb(
    () => sql`
      SELECT settlement::float8 AS settlement
      FROM outcomes
      WHERE date = ${date}::date`,
  );
  return finiteOrNull(rows[0]?.settlement);
}

function skip(kind, reason) {
  return { ok: false, kind, reason };
}

/**
 * The day's Schwab ratio, `{ basis }` (ratioFor's answer), or the `{ skip }` a
 * date with no Schwab close gives. Anything else thrown is not a skipped day.
 */
function ratioOrSkip(closes, symbol, date) {
  try {
    return { basis: ratioFor(closes, symbol, date) };
  } catch (err) {
    if (err instanceof DayFailure) return { skip: skip(err.kind, err.message) };
    throw err;
  }
}

/**
 * UW's bars of `etf` on `date`, `{ bars }`, or the `{ skip }` for a UW error
 * (its kind kept), an empty answer, or one at UW's row cap (a day that may be
 * cut short). prepareDay and prepareRefitDay both ask this way.
 */
async function fetchDayBars({ etf, date, uwKey, waitForSlot }) {
  const answer = await fetchUwCandles(uwKey, etf, date, waitForSlot);
  if (answer.kind === 'error') {
    const { kind, detail } = classifyFailure(answer);
    return {
      skip: skip(
        kind,
        `UW ${etf} bars for ${date}: ${answer.status} ${detail}`,
      ),
    };
  }
  if (answer.kind === 'empty') {
    return { skip: skip('other', `UW has no ${etf} bars for ${date}`) };
  }
  if (answer.rows.length >= UW_CANDLE_LIMIT) {
    return {
      skip: skip(
        'other',
        `UW returned ${answer.rows.length} ${etf} bars for ${date}, its ` +
          `${UW_CANDLE_LIMIT}-row cap: the day may be cut short`,
      ),
    };
  }
  return { bars: answer.rows };
}

/**
 * Fetch, map and check one day, writing nothing:
 *   { ok: true, rows, ratio, dropped } | { ok: false, reason, kind }
 * `rows` are index_candles_1m rows (toIndexRows), `ratio` the Schwab
 * index-over-ETF close ratio, `dropped` the bars toIndexRows left out as
 * malformed, `kind` the failure kind of backfill-cli's classifyFailure.
 * Not ok, with the reason, for: no ratio (no Schwab close for the date, or the
 * Schwab call failed), a UW error, an empty answer, an answer at UW's row cap,
 * or a failed checkMappedDay. A database error is not a skipped day: it throws.
 */
export async function prepareDay(
  sql,
  { symbol, date, closes, uwKey, waitForSlot },
) {
  const { etf } = INDEXES.find((i) => i.symbol === symbol) ?? {};
  if (etf == null) throw new RangeError(`no repair for symbol ${symbol}`);

  // The ratio first: with none there is nothing to build, so UW is not asked.
  const priced = ratioOrSkip(closes, symbol, date);
  if (priced.skip) return priced.skip;
  const { basis } = priced;

  const fetched = await fetchDayBars({ etf, date, uwKey, waitForSlot });
  if (fetched.skip) return fetched.skip;

  const { rows, dropped } = toIndexRows(
    symbol,
    date,
    fetched.bars,
    basis.ratio,
  );
  const check = checkMappedDay({
    symbol,
    date,
    rows,
    settlement: symbol === 'SPX' ? await readSettlement(sql, date) : null,
    ndxClose: symbol === 'NDX' ? basis.indexClose : null,
  });
  if (!check.ok) return skip('other', `${check.reason}${droppedNote(dropped)}`);
  return { ok: true, rows, ratio: basis.ratio, dropped };
}

/** What to add to a failed day's reason when bars were left out as malformed. */
function droppedNote(dropped) {
  if (dropped <= 0) return '';
  return ` (${dropped} ${dropped === 1 ? 'bar' : 'bars'} dropped as malformed)`;
}

/**
 * Every stored row of `symbol` on `date`, every column as text (what a backup
 * keeps, so a restore is exact to the microsecond whatever the session time
 * zone: a timestamptz renders with its offset), plus `epoch_ms` to match
 * minutes and `selected`, whether the delete predicate takes the row. One
 * statement, so the selection and the kept rows come from one snapshot.
 * `selection` is deleteSelection's, or `{ kind: 'ids', ids }` for a refit,
 * which selects exactly those rows, or any other kind to select none (a
 * read-only look at the day). ORDER BY names the table: a bare `timestamp`
 * would sort by the text alias.
 */
function readDay(sql, symbol, date, selection) {
  const bound = {
    createdFrom: null,
    createdThrough: null,
    createdBefore: null,
    timestampBefore: null,
    ids: [],
    ...selection,
  };
  return retryTransientDb(
    () => sql`
      SELECT id::text AS id, symbol, date::text AS date,
             timestamp::text AS timestamp, open::text AS open,
             high::text AS high, low::text AS low, close::text AS close,
             volume::text AS volume, market_time,
             spx_schwab_price::text AS spx_schwab_price,
             ndx_schwab_price::text AS ndx_schwab_price,
             created_at::text AS created_at,
             (extract(epoch FROM timestamp) * 1000)::bigint::text AS epoch_ms,
             (
               (
                 ${selection.kind}::text = 'repair'
                 AND (${bound.createdFrom}::timestamptz IS NULL
                      OR created_at >= ${bound.createdFrom}::timestamptz)
                 AND (${bound.createdThrough}::timestamptz IS NULL
                      OR created_at <= ${bound.createdThrough}::timestamptz)
                 AND (${bound.createdBefore}::timestamptz IS NULL
                      OR created_at < ${bound.createdBefore}::timestamptz)
                 AND (${bound.timestampBefore}::timestamptz IS NULL
                      OR timestamp < ${bound.timestampBefore}::timestamptz)
               )
               OR id = ANY(${bound.ids}::int[])
             ) AS selected
      FROM index_candles_1m
      WHERE symbol = ${symbol}
        AND date = ${date}::date
      ORDER BY index_candles_1m.timestamp`,
  );
}

/** The database's own clock, as text with its offset: the run marker. */
async function readMarker(sql) {
  const rows = await retryTransientDb(() => sql`SELECT now()::text AS marker`);
  return rows[0].marker;
}

// ── Backup files ───────────────────────────────────────────

/** The backup columns, in a fixed order, all text (or null). */
const BACKUP_COLUMNS = [
  'id',
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
  'created_at',
];

function backupRowOf(row) {
  return Object.fromEntries(BACKUP_COLUMNS.map((c) => [c, row[c]]));
}

function isBackupRow(row) {
  return (
    row !== null &&
    typeof row === 'object' &&
    BACKUP_COLUMNS.every((c) => typeof row[c] === 'string' || row[c] === null)
  );
}

/** What this repair's backup rows look like, for parseBackupText and writeBackup. */
const CANDLE_BACKUP_ROWS = { isRow: isBackupRow, project: backupRowOf };

/**
 * A backup's JSONL text as rows; throws on a line that is not a backup row.
 * `shape` says what a row is: `isRow(value)` is whether a parsed line is one,
 * `project(value)` the row cut down to its columns, in their fixed order. Both
 * repairs' backups go through here (the lottery-spot repair passes its own).
 */
export function parseBackupText(text, file, { isRow, project }) {
  const rows = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`backup ${file} line ${i + 1} is malformed JSON`, {
        cause: err,
      });
    }
    if (!isRow(row)) {
      throw new Error(`backup ${file} line ${i + 1} is malformed`);
    }
    rows.push(project(row));
  }
  return rows;
}

/**
 * Write `rows` as JSONL to `file` ('wx': an existing file is an error, never
 * overwritten), then read it back with `shape` (see parseBackupText). A backup
 * that cannot be read back is no backup, so the run stops before anything is
 * changed. Shared with the lottery-spot repair.
 */
export async function writeBackup(backupDir, file, rows, shape) {
  await mkdir(backupDir, { recursive: true });
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  const back = parseBackupText(await readFile(file, 'utf8'), file, shape);
  if (JSON.stringify(back) !== JSON.stringify(rows)) {
    throw new Error(`backup ${file} does not read back as written`);
  }
}

const MANIFEST_VERSION = 1;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIdList(value) {
  return Array.isArray(value) && value.every(Number.isInteger);
}

/** Read a manifest's text; throws on anything that is not a version-1 one. */
function parseManifest(text, file) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest ${file} is not valid JSON: ${err.message}`, {
      cause: err,
    });
  }
  const valid =
    doc?.version === MANIFEST_VERSION &&
    SYMBOLS.includes(doc.symbol) &&
    ISO_DATE.test(doc.date) &&
    typeof doc.backup === 'string' &&
    isIdList(doc.backedUpIds) &&
    (doc.insertedIds == null || isIdList(doc.insertedIds)) &&
    typeof doc.marker === 'string' &&
    doc.marker !== '' &&
    typeof doc.committed === 'boolean';
  if (!valid) {
    throw new Error(
      `${file} is not an index-candle repair manifest (version 1)`,
    );
  }
  return doc;
}

// ── Statements ─────────────────────────────────────────────

const column = (rows, name) => rows.map((r) => r[name] ?? null);

/**
 * DELETE rows by id, kept to one symbol and date. A repair deletes exactly the
 * rows it backed up (nothing the predicate's SELECT did not see); an undo
 * removes exactly the rows the run inserted.
 */
function deleteByIdStatement(sql, symbol, date, ids) {
  return sql`
    DELETE FROM index_candles_1m
    WHERE symbol = ${symbol}
      AND date = ${date}::date
      AND id = ANY(${ids}::int[])
    RETURNING id`;
}

/** One unnest INSERT of up to WRITE_BATCH mapped rows; the unique key skips a row already there. */
function insertStatement(sql, rows) {
  return sql`
    INSERT INTO index_candles_1m
      (symbol, date, timestamp, open, high, low, close, volume, market_time,
       spx_schwab_price, ndx_schwab_price)
    SELECT t.symbol, t.date, t.timestamp, t.open, t.high, t.low, t.close,
           t.volume, t.market_time, t.spx_schwab_price, t.ndx_schwab_price
    FROM unnest(
      ${column(rows, 'symbol')}::text[],
      ${column(rows, 'date')}::date[],
      ${column(rows, 'timestamp')}::timestamptz[],
      ${column(rows, 'open')}::numeric[],
      ${column(rows, 'high')}::numeric[],
      ${column(rows, 'low')}::numeric[],
      ${column(rows, 'close')}::numeric[],
      ${column(rows, 'volume')}::bigint[],
      ${column(rows, 'market_time')}::text[],
      ${column(rows, 'spx_schwab_price')}::numeric[],
      ${column(rows, 'ndx_schwab_price')}::numeric[]
    ) AS t(symbol, date, timestamp, open, high, low, close, volume,
           market_time, spx_schwab_price, ndx_schwab_price)
    ON CONFLICT (symbol, date, timestamp) DO NOTHING
    RETURNING id`;
}

/**
 * Remove the rows a run inserted when the manifest never learned their ids (a
 * crash between the commit and the second manifest write): this symbol and
 * date, written since the run marker, and not one of the backed-up rows. The
 * run's own inserts get created_at = the transaction's now(), which is not
 * before the marker read just ahead of it.
 */
function removeSinceMarkerStatement(sql, manifest) {
  return sql`
    DELETE FROM index_candles_1m
    WHERE symbol = ${manifest.symbol}
      AND date = ${manifest.date}::date
      AND created_at >= ${manifest.marker}::timestamptz
      AND id <> ALL(${manifest.backedUpIds}::int[])
    RETURNING id`;
}

/** Put backed-up rows back with their own id and created_at; ON CONFLICT (id) skips a row already restored. */
function restoreStatement(sql, rows) {
  return sql`
    INSERT INTO index_candles_1m
      (id, symbol, date, timestamp, open, high, low, close, volume,
       market_time, spx_schwab_price, ndx_schwab_price, created_at)
    SELECT t.id, t.symbol, t.date, t.timestamp, t.open, t.high, t.low,
           t.close, t.volume, t.market_time, t.spx_schwab_price,
           t.ndx_schwab_price, t.created_at
    FROM unnest(
      ${column(rows, 'id')}::int[],
      ${column(rows, 'symbol')}::text[],
      ${column(rows, 'date')}::date[],
      ${column(rows, 'timestamp')}::timestamptz[],
      ${column(rows, 'open')}::numeric[],
      ${column(rows, 'high')}::numeric[],
      ${column(rows, 'low')}::numeric[],
      ${column(rows, 'close')}::numeric[],
      ${column(rows, 'volume')}::bigint[],
      ${column(rows, 'market_time')}::text[],
      ${column(rows, 'spx_schwab_price')}::numeric[],
      ${column(rows, 'ndx_schwab_price')}::numeric[],
      ${column(rows, 'created_at')}::timestamptz[]
    ) AS t(id, symbol, date, timestamp, open, high, low, close, volume,
           market_time, spx_schwab_price, ndx_schwab_price, created_at)
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
}

// ── repairDay ──────────────────────────────────────────────

function shownRatio(ratio) {
  return Number.isFinite(ratio) ? Number(ratio.toFixed(6)) : null;
}

/**
 * Why the request must not touch the table, or null. Checked before any read.
 * A refit may use every list; the plain repair not the refit-only ones.
 */
function requestProblem({
  symbol,
  date,
  list,
  rows,
  ratio,
  backupDir,
  apply,
  refit = false,
}) {
  const symbols = LIST_SYMBOL_MAP.get(list);
  if (symbols == null) return `unknown list ${list}`;
  if (!refit && REFIT_ONLY_LISTS.has(list)) {
    return `the ${list} list is for --refit only`;
  }
  if (!symbols.includes(symbol)) return `${symbol} is not in the ${list} list`;
  if (!LIST_DATES.get(list).includes(date)) {
    return `${date} is not in the ${list} list`;
  }
  // Rows to put back are what makes the delete safe: with none, a repair
  // would remove the placeholders and leave a hole.
  if (rows.length === 0) return 'no mapped rows to insert';
  const stray = rows.find((r) => r.symbol !== symbol || r.date !== date);
  if (stray != null) {
    return `a mapped row is ${stray.symbol} ${stray.date}, not ${symbol} ${date}`;
  }
  if (!Number.isFinite(ratio) || ratio <= 0) return `bad ratio ${ratio}`;
  if (apply && typeof backupDir !== 'string') return 'no backup directory';
  return null;
}

/**
 * 20261125T231500123Z: sortable, no colons (Windows). The lottery-spot repair
 * (lottery-spot-repair.mjs) stamps its files the same way.
 */
export function stampOf(now) {
  return now.toISOString().replaceAll(/[-:.]/g, '');
}

/**
 * The first half of a write, for repairDay and refitDay: back `selected` up
 * (every column, written and read back), then write the manifest beside it
 * with `committed: false` ('wx': never over an existing file). `fields` are
 * what the manifest records between the date and the backup: the list and
 * ratio, and for a refit its kind and ratios. The table is not touched.
 */
async function openReplacement(
  sql,
  { backupDir, symbol, date, selected, fields },
) {
  const marker = await readMarker(sql);
  const base = join(backupDir, `${symbol}-${date}-${stampOf(new Date())}`);
  const backupFile = `${base}.jsonl`;
  const manifestFile = `${base}.manifest.json`;
  const backedUp = selected.map(backupRowOf);
  await writeBackup(backupDir, backupFile, backedUp, CANDLE_BACKUP_ROWS);
  const manifest = {
    version: MANIFEST_VERSION,
    symbol,
    date,
    ...fields,
    backup: backupFile,
    backedUpIds: backedUp.map((r) => Number(r.id)),
    insertedIds: null,
    marker,
    committed: false,
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { manifest, manifestFile };
}

/**
 * The second half of a write (failure ordering: see repairDay): ONE
 * transaction deletes the manifest's backed-up rows by id, when it has any,
 * and inserts `toInsert` in batches of at most WRITE_BATCH; then the manifest
 * is rewritten `committed: true` with the inserted ids. `{ deleted,
 * insertedIds }`.
 */
async function commitReplacement(sql, { manifest, manifestFile, toInsert }) {
  const { symbol, date } = manifest;
  const statements = [];
  if (manifest.backedUpIds.length > 0) {
    statements.push(
      deleteByIdStatement(sql, symbol, date, manifest.backedUpIds),
    );
  }
  const insertFirst = statements.length;
  for (const part of chunk(toInsert, WRITE_BATCH)) {
    statements.push(insertStatement(sql, part));
  }
  let results;
  try {
    results = await sql.transaction(statements);
  } catch (err) {
    throw new Error(
      `${symbol} ${date}: the transaction failed (${err.message}). Nothing ` +
        `changed unless the response was lost; ${manifestFile} is still ` +
        'committed: false, and --undo reads that as "ids unknown" and is safe ' +
        'either way',
      { cause: err },
    );
  }
  const deleted = insertFirst === 0 ? 0 : results[0].length;
  const insertedIds = results
    .slice(insertFirst)
    .flatMap((result) => result.map((r) => Number(r.id)));

  try {
    await writeFile(
      manifestFile,
      `${JSON.stringify({ ...manifest, insertedIds, committed: true }, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    throw new Error(
      `${symbol} ${date}: committed (${deleted} deleted, ${insertedIds.length} ` +
        `inserted) but the manifest ${manifestFile} could not be rewritten ` +
        `(${err.message}); it still says committed: false, and --undo falls ` +
        'back to the run marker',
      { cause: err },
    );
  }
  return { deleted, insertedIds };
}

/**
 * Replace one symbol-date: read its rows, and with `apply` back up the ones
 * the delete predicate selects, write the manifest, then in ONE transaction
 * delete them and insert `rows` (the unique key skips a minute that is
 * already there). `rows` are prepareDay's, `ratio` its ratio, `list` the list
 * the date was picked from.
 *
 * Returns `{ date, symbol, ratio, deleted, inserted, uncovered }` (the ratio
 * to 6 decimals), plus `manifest` (its path) after an apply that wrote
 * anything, or `skipped: reason` when the request does not belong to its
 * list, has no rows or a bad ratio (nothing is read or written then), or when
 * the rows would leave a regular minute empty (see below; read-only so far).
 * Without `apply` it only reads: `deleted` and `inserted` are what an apply
 * would change.
 *
 * Coverage of what is deleted. The day check (prepareDay) gates the mapped
 * regular bars, but a stored row is deleted whether or not a mapped row
 * replaces it. So, before any write:
 *   - a selected regular (`market_time = 'r'`) minute with no mapped row
 *     refuses the date (`skipped: would leave N regular minutes empty`):
 *     repairDay does not trust its caller to have checked;
 *   - a selected pre- or post-market minute with no mapped row does not: the
 *     placeholder there held a wrong value anyway. It is counted in
 *     `uncovered`, in the dry run and the apply result alike.
 *
 * Failure ordering, so that nothing is lost:
 *   - the backup is written and read back before the manifest, and the
 *     manifest before the transaction: a failed write ends the run with the
 *     table untouched;
 *   - a failed transaction rolls back whole; the manifest then stays
 *     `committed: false`, which undoRepair reads as "ids unknown";
 *   - after the commit the manifest is rewritten with the inserted ids; if
 *     that write fails the error says so, and undoRepair falls back to the
 *     marker.
 * The transaction is not retried: after a lost response a retry would find
 * the first attempt's rows already there and record no inserted ids.
 */
export async function repairDay(
  sql,
  { symbol, date, list, rows, ratio, backupDir, apply },
) {
  const shown = shownRatio(ratio);
  const problem = requestProblem({
    symbol,
    date,
    list,
    rows,
    ratio,
    backupDir,
    apply,
  });
  if (problem != null) {
    return {
      date,
      symbol,
      ratio: shown,
      deleted: 0,
      inserted: 0,
      skipped: problem,
    };
  }

  const existing = await readDay(
    sql,
    symbol,
    date,
    deleteSelection(symbol, date),
  );
  const selected = existing.filter((r) => r.selected === true);
  // A minute a kept row holds is skipped by the insert: not "to insert".
  const keptMinutes = new Set(
    existing.filter((r) => r.selected !== true).map((r) => r.epoch_ms),
  );
  const toInsert = rows.filter(
    (r) => !keptMinutes.has(String(Date.parse(r.timestamp))),
  );
  // Selected minutes no mapped row replaces. Regular ones refuse the date.
  const mappedMinutes = new Set(
    rows.map((r) => String(Date.parse(r.timestamp))),
  );
  const unreplaced = selected.filter((r) => !mappedMinutes.has(r.epoch_ms));
  const regularHoles = unreplaced.filter((r) => r.market_time === 'r');
  const counts = {
    date,
    symbol,
    ratio: shown,
    uncovered: unreplaced.length - regularHoles.length,
  };
  if (regularHoles.length > 0) {
    const noun = regularHoles.length === 1 ? 'minute' : 'minutes';
    const first = new Date(Number(regularHoles[0].epoch_ms)).toISOString();
    return {
      ...counts,
      deleted: 0,
      inserted: 0,
      skipped:
        `would leave ${regularHoles.length} regular ${noun} empty ` +
        `(first ${first}): stored rows no mapped row replaces`,
    };
  }

  if (!apply) {
    return { ...counts, deleted: selected.length, inserted: toInsert.length };
  }
  if (selected.length === 0 && toInsert.length === 0) {
    return { ...counts, deleted: 0, inserted: 0 };
  }

  const opened = await openReplacement(sql, {
    backupDir,
    symbol,
    date,
    selected,
    fields: { list, ratio },
  });
  const { deleted, insertedIds } = await commitReplacement(sql, {
    ...opened,
    toInsert,
  });
  return {
    ...counts,
    deleted,
    inserted: insertedIds.length,
    manifest: opened.manifestFile,
  };
}

// ── Undo ───────────────────────────────────────────────────

/** The manifest and its backup rows, checked against each other, before any write. */
async function loadUndo(manifestFile) {
  const manifest = parseManifest(
    await readFile(manifestFile, 'utf8'),
    manifestFile,
  );
  const rows = parseBackupText(
    await readFile(manifest.backup, 'utf8'),
    manifest.backup,
    CANDLE_BACKUP_ROWS,
  );
  const matches =
    rows.length === manifest.backedUpIds.length &&
    rows.every(
      (r, i) =>
        r.symbol === manifest.symbol &&
        r.date === manifest.date &&
        Number(r.id) === manifest.backedUpIds[i],
    );
  if (!matches) {
    throw new Error(
      `backup ${manifest.backup} does not match its manifest ${manifestFile} ` +
        '(row count, ids, symbol or date)',
    );
  }
  return { manifest, rows };
}

/** Whether the manifest knows the ids the run inserted. */
function knowsInsertedIds(manifest) {
  return manifest.committed === true && Array.isArray(manifest.insertedIds);
}

/**
 * Undo a repair, in one transaction: remove the rows it inserted (by id, or,
 * for a manifest still `committed: false`, the rows of that symbol and date
 * written since the run marker that are not backed-up rows), then put the
 * backed-up rows back with their own id, created_at and values. Rows already
 * back are left (ON CONFLICT (id)), so a second undo changes nothing. A row
 * that would land on a minute another row now holds (a repair run again after
 * this one) is a unique violation: the whole undo rolls back and throws. Undo
 * runs newest first. Returns `{ restored, removed }`.
 */
export async function undoRepair(sql, manifestFile) {
  const { manifest, rows } = await loadUndo(manifestFile);
  const statements = [
    knowsInsertedIds(manifest)
      ? deleteByIdStatement(
          sql,
          manifest.symbol,
          manifest.date,
          manifest.insertedIds,
        )
      : removeSinceMarkerStatement(sql, manifest),
  ];
  for (const part of chunk(rows, WRITE_BATCH)) {
    statements.push(restoreStatement(sql, part));
  }
  const results = await sql.transaction(statements);
  return {
    removed: results[0].length,
    restored: results.slice(1).reduce((n, result) => n + result.length, 0),
  };
}

/** The lines of what undoRepair(manifest) would do, read from the files only. */
export async function describeUndo(manifestFile) {
  const { manifest, rows } = await loadUndo(manifestFile);
  const removal = knowsInsertedIds(manifest)
    ? `remove ${manifest.insertedIds.length} inserted rows (by id)`
    : `remove the ${manifest.symbol} ${manifest.date} rows written since ` +
      `${manifest.marker} that are not backed-up rows (by run marker: the ` +
      'manifest never learned the inserted ids)';
  const what = manifest.kind === 'refit' ? 'refit' : 'repair';
  return [
    `${manifest.symbol} ${manifest.date}, ${what} of list ${manifest.list}`,
    `  ${removal}`,
    `  restore ${rows.length} backed-up rows from ${manifest.backup}`,
  ];
}

// ── One date, prepare then repair ──────────────────────────

/**
 * The day worker of the CLI's runDays loop: prepareDay, then repairDay. A day
 * that cannot be prepared, or that repairDay refuses, throws a DayFailure
 * (kind from the failure, `other` for a refusal), so runDays records it
 * against the date and the run ends with exit code 1. Returns the counts
 * runDays wants: `fetched` and `stored` (0 on a dry run), with `deleted`,
 * `ratio`, `dropped`, `uncovered` and `manifest`, or `wouldDelete` and
 * `wouldInsert` on a dry run. `dropped` is the UW bars left out as malformed,
 * `uncovered` the stored pre- and post-market minutes no mapped row replaces;
 * runDays prints both on the date's line.
 */
export async function processRepairDay(
  sql,
  { symbol, date, list, closes, uwKey, waitForSlot, backupDir, apply },
) {
  const day = await prepareDay(sql, {
    symbol,
    date,
    closes,
    uwKey,
    waitForSlot,
  });
  if (!day.ok) throw new DayFailure(day.kind, day.reason);
  const result = await repairDay(sql, {
    symbol,
    date,
    list,
    rows: day.rows,
    ratio: day.ratio,
    backupDir,
    apply,
  });
  if (result.skipped != null) throw new DayFailure('other', result.skipped);
  const common = {
    fetched: day.rows.length,
    ratio: result.ratio,
    dropped: day.dropped,
    uncovered: result.uncovered,
  };
  if (!apply) {
    return {
      ...common,
      stored: 0,
      wouldDelete: result.deleted,
      wouldInsert: result.inserted,
    };
  }
  return {
    ...common,
    stored: result.inserted,
    deleted: result.deleted,
    ...(result.manifest == null ? {} : { manifest: result.manifest }),
  };
}

// ── The refit (spec decision 9) ────────────────────────────

const MINUTE_MS = 60_000;

/**
 * The 11-06 backfill wrote every summer row inside this one minute, with no
 * Schwab price: `created_at` in [FROM, BEFORE).
 */
const SUMMER_BACKFILL_FROM = '2026-11-06T22:19:00Z';
const SUMMER_BACKFILL_BEFORE = '2026-11-06T22:20:00Z';

/** --check: this share of the pairs must scale by ratio ÷ priorRatio... */
const SCALED_SHARE_MIN = 0.99;
/** ...within this relative error (both rows are one UW bar times a ratio). */
const SCALED_TOLERANCE = 1e-6;

/** The median of a non-empty array of numbers. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A point measure for a printed line: two decimals, never -0. */
function shownPoints(value) {
  return Number(value.toFixed(2)) + 0;
}

/**
 * Read `file` as a manifest a refit may replace the rows of: `{ doc }`, or
 * `{ why }` it is not one. A committed version-1 candle manifest, from a repair
 * (no `kind`) or a refit, for this symbol and date, with inserted rows. A
 * lottery manifest (its `kind`) never is.
 */
async function readCandidate(file, symbol, date) {
  let doc;
  try {
    doc = parseManifest(await readFile(file, 'utf8'), file);
  } catch {
    return { why: 'is not a readable version-1 candle manifest' };
  }
  if (doc.kind != null && doc.kind !== 'refit') {
    return { why: `is a ${doc.kind} manifest` };
  }
  if (doc.symbol !== symbol || doc.date !== date) {
    return { why: `is for ${doc.symbol} ${doc.date}` };
  }
  if (doc.committed !== true) return { why: 'is not committed' };
  if (!Array.isArray(doc.insertedIds) || doc.insertedIds.length === 0) {
    return { why: 'inserted no rows' };
  }
  return { doc };
}

/** How many of `ids` are rows of `symbol` on `date` now: one query. */
async function countRows(sql, symbol, date, ids) {
  const rows = await retryTransientDb(
    () => sql`
      SELECT id FROM index_candles_1m
      WHERE symbol = ${symbol}
        AND date = ${date}::date
        AND id = ANY(${ids}::int[])`,
  );
  return rows.length;
}

/**
 * The 11-06 backfill's rows of a summer date: that symbol and date, written in
 * the backfill's minute, with no Schwab price in the symbol's own column.
 */
async function readSummerBackfill(sql, symbol, date) {
  const rows = await retryTransientDb(
    () => sql`
      SELECT id FROM index_candles_1m
      WHERE symbol = ${symbol}
        AND date = ${date}::date
        AND created_at >= ${SUMMER_BACKFILL_FROM}::timestamptz
        AND created_at < ${SUMMER_BACKFILL_BEFORE}::timestamptz
        AND CASE WHEN ${symbol}::text = 'SPX'
                 THEN spx_schwab_price IS NULL
                 ELSE ndx_schwab_price IS NULL END
      ORDER BY id`,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Which rows a refit of `symbol` on `date` replaces, from the manifests in
 * `backupDir`:
 *   { ok: true, manifestPath, manifest, ids } | { ok: false, reason }
 * Every `<SYMBOL>-<date>-*.manifest.json` is read. A candidate is a committed
 * manifest of a repair or a refit for this symbol and date (readCandidate); it
 * qualifies when ALL its `insertedIds` are still rows of that symbol and date
 * (one query). Exactly one must qualify, or the date is not refit: no
 * manifest, two, or one with a row gone or changed to another symbol or date
 * means the current rows are not known, and a half-replaced day is worse than
 * a skipped one. After a refit only its own manifest qualifies, since the rows
 * it replaced are gone; after its undo the earlier one does again.
 *
 * A summer date with no qualifying manifest selects the 11-06 backfill's rows
 * instead (`manifestPath` and `manifest` null): the summer list never went
 * through the repair, so no manifest lists them. No such rows is a failure.
 */
export async function findRefitManifest(sql, { symbol, date, backupDir }) {
  if (typeof backupDir !== 'string') {
    return { ok: false, reason: 'no backup directory' };
  }
  let names;
  try {
    names = await readdir(backupDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        ok: false,
        reason: `cannot read the backup directory ${backupDir}: ${err?.code ?? err?.message}`,
      };
    }
    names = [];
  }
  const prefix = `${symbol}-${date}-`;
  const files = names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.manifest.json'))
    .sort();

  const qualified = [];
  const rejected = [];
  for (const name of files) {
    const manifestPath = join(backupDir, name);
    const candidate = await readCandidate(manifestPath, symbol, date);
    if (candidate.why != null) {
      rejected.push(`${name} ${candidate.why}`);
      continue;
    }
    const ids = candidate.doc.insertedIds;
    const there = await countRows(sql, symbol, date, ids);
    if (there !== ids.length) {
      rejected.push(
        `${name} lists ${ids.length} inserted rows, but only ${there} are ` +
          `${symbol} ${date} rows`,
      );
      continue;
    }
    qualified.push({ ok: true, manifestPath, manifest: candidate.doc, ids });
  }

  if (qualified.length > 1) {
    const list = qualified.map((q) => basename(q.manifestPath)).join(', ');
    return {
      ok: false,
      reason:
        `${qualified.length} manifests qualify for ${symbol} ${date} (${list}): ` +
        'refusing to guess which rows are current',
    };
  }
  if (qualified.length === 1) return qualified[0];

  const why = rejected.length > 0 ? ` (${rejected.join('; ')})` : '';
  if (LIST_DATES.get('summer').includes(date)) {
    const ids = await readSummerBackfill(sql, symbol, date);
    if (ids.length > 0) {
      return { ok: true, manifestPath: null, manifest: null, ids };
    }
    return {
      ok: false,
      reason:
        `no 11-06 backfill rows for ${symbol} ${date} (written 2026-11-06 ` +
        `22:19 UTC, no Schwab price) and no manifest qualifies${why}`,
    };
  }
  return {
    ok: false,
    reason:
      files.length === 0
        ? `no manifest for ${symbol} ${date} in ${backupDir}`
        : `no manifest for ${symbol} ${date} qualifies: ${rejected.join('; ')}`,
  };
}

/**
 * Fetch, fit, map and check one day for a refit, writing nothing:
 *   { ok: true, rows, ratio, closeRatio, source, matched, scatter, dh, dl,
 *     etfCloses, dropped } | { ok: false, kind, reason }
 * `ratio` is the fitted ratio, `closeRatio` Schwab's (a number), `etfCloses`
 * the UW ETF close of each regular bar by UTC epoch minute (refitDay measures
 * the prior ratio against it). Not ok, with the reason, for: no Schwab ratio,
 * a price file that is missing or wrong (read before UW is asked), a UW error
 * (kind kept), an empty or capped answer, a failed fit gate, a failed count
 * check, no Schwab daily range, or a failed level check.
 *
 * A fitted day reads no close reference: it never asks for outcomes.settlement
 * or compares a close with Schwab's, so a date with no `outcomes` row is refit
 * like the rest. `sql` is taken, and unused, so the two prepare functions are
 * called alike.
 */
export async function prepareRefitDay(
  sql,
  { symbol, date, closes, uwKey, waitForSlot, spotsDir },
) {
  const { etf } = INDEXES.find((i) => i.symbol === symbol) ?? {};
  if (etf == null) throw new RangeError(`no repair for symbol ${symbol}`);

  const priced = ratioOrSkip(closes, symbol, date);
  if (priced.skip) return priced.skip;
  const closeRatio = priced.basis.ratio;

  // A local file: read it before UW is asked.
  const spots = await readSpots(spotsDir, symbol, date);
  if (!spots.ok) return skip('other', spots.reason);

  const fetched = await fetchDayBars({ etf, date, uwKey, waitForSlot });
  if (fetched.skip) return fetched.skip;

  const fit = fitRatio({ symbol, date, bars: fetched.bars, spots, closeRatio });
  if (!fit.ok) return skip('other', fit.reason);

  const { rows, dropped } = toIndexRows(symbol, date, fetched.bars, fit.ratio);
  const check = checkMappedDay({ symbol, date, rows, fitted: true });
  if (!check.ok) return skip('other', `${check.reason}${droppedNote(dropped)}`);

  let extremes;
  try {
    extremes = extremesFor(closes, symbol, date);
  } catch (err) {
    if (err instanceof DayFailure) return skip(err.kind, err.message);
    throw err;
  }
  const level = levelCheck({ symbol, rows, ...extremes });
  if (!level.ok) return skip('other', level.reason);

  const etfCloses = new Map(
    regularBars(fetched.bars, date).map(({ bar, ts }) => [
      Math.floor(ts / MINUTE_MS),
      Number(bar.close),
    ]),
  );
  return {
    ok: true,
    rows,
    ratio: fit.ratio,
    closeRatio,
    source: spots.source,
    matched: fit.matched,
    scatter: fit.scatter,
    dh: level.dh,
    dl: level.dl,
    etfCloses,
    dropped,
  };
}

/**
 * The ratio the replaced rows carry, measured: the median, over their regular
 * minutes that have a UW bar in `etfCloses`, of the row's close over that bar's
 * close. Null when there is no such minute.
 */
function priorRatioOf(selected, etfCloses) {
  const ratios = [];
  for (const row of selected) {
    if (row.market_time !== 'r') continue;
    const etf = etfCloses.get(Math.floor(Number(row.epoch_ms) / MINUTE_MS));
    const close = Number(row.close);
    if (etf > 0 && close > 0) ratios.push(close / etf);
  }
  return ratios.length === 0 ? null : median(ratios);
}

/**
 * Replace one date's repaired rows with the fitted ones: the rows `found`
 * names (findRefitManifest), by id, symbol and date, for the rows `prepared`
 * maps (prepareRefitDay). With `apply`, back them up, write a manifest of
 * `kind: 'refit'`, then in ONE transaction delete them by id and insert the
 * mapped rows (a minute a kept row, such as a live row no manifest lists,
 * already holds is skipped by the unique key and not counted). Failure
 * ordering as repairDay's; undoRepair undoes a refit unchanged.
 *
 * Returns `{ date, symbol, ratio, closeRatio, priorRatio, replaced, inserted,
 * uncovered }` (the ratios to 6 decimals), plus `manifest` (its path) after an
 * apply, or `skipped: reason` with nothing read or written beyond the one
 * read, for: a request that does not belong to its list, no rows, a bad ratio,
 * a manifest row that is gone, a prior ratio that cannot be measured, or
 * coverage. Without `apply` it only reads: `replaced` and `inserted` are what
 * an apply would change.
 *
 * Coverage: every minute among the rows replaced, pre- and post-market
 * included, must get a new row. A refit deletes valid rows, unlike a
 * placeholder repair, so a thinner UW answer must not shrink the day: the date
 * is skipped with `uncovered: N` and nothing is written.
 *
 * `priorRatio` (spec decision 9) is measured from the rows replaced, not taken
 * from today's close ratio, which the summer's rows never recorded.
 */
export async function refitDay(
  sql,
  { symbol, date, list, prepared, found, backupDir, apply },
) {
  const { rows, ratio, closeRatio, etfCloses, source } = prepared;
  const counts = {
    date,
    symbol,
    ratio: shownRatio(ratio),
    closeRatio: shownRatio(closeRatio),
    priorRatio: null,
    replaced: 0,
    inserted: 0,
    uncovered: 0,
  };
  const problem =
    requestProblem({
      symbol,
      date,
      list,
      rows,
      ratio,
      backupDir,
      apply,
      refit: true,
    }) ?? (found.ids.length === 0 ? 'no rows to replace' : null);
  if (problem != null) return { ...counts, skipped: problem };

  const existing = await readDay(sql, symbol, date, {
    kind: 'ids',
    ids: found.ids,
  });
  const selected = existing.filter((r) => r.selected === true);
  if (selected.length !== found.ids.length) {
    return {
      ...counts,
      skipped:
        `rows to replace: ${selected.length} of the ${found.ids.length} are ` +
        `still ${symbol} ${date} rows`,
    };
  }

  const mappedMinutes = new Set(
    rows.map((r) => String(Date.parse(r.timestamp))),
  );
  const unreplaced = selected.filter((r) => !mappedMinutes.has(r.epoch_ms));
  if (unreplaced.length > 0) {
    const noun = unreplaced.length === 1 ? 'minute' : 'minutes';
    const first = new Date(Number(unreplaced[0].epoch_ms)).toISOString();
    return {
      ...counts,
      uncovered: unreplaced.length,
      skipped:
        `would leave ${unreplaced.length} ${noun} empty (first ${first}): ` +
        'stored rows no new row replaces',
    };
  }

  const prior = priorRatioOf(selected, etfCloses);
  if (prior == null) {
    return {
      ...counts,
      skipped:
        'the prior ratio cannot be measured: no replaced regular minute has ' +
        'a UW bar',
    };
  }

  const keptMinutes = new Set(
    existing.filter((r) => r.selected !== true).map((r) => r.epoch_ms),
  );
  const toInsert = rows.filter(
    (r) => !keptMinutes.has(String(Date.parse(r.timestamp))),
  );
  const result = {
    ...counts,
    priorRatio: shownRatio(prior),
    replaced: selected.length,
    inserted: toInsert.length,
  };
  if (!apply) return result;

  const opened = await openReplacement(sql, {
    backupDir,
    symbol,
    date,
    selected,
    fields: {
      list,
      kind: 'refit',
      refitOf: found.manifestPath,
      selectedBy: found.manifestPath == null ? 'summer-backfill' : 'manifest',
      ratio,
      closeRatio,
      priorRatio: prior,
      source,
    },
  });
  const { deleted, insertedIds } = await commitReplacement(sql, {
    ...opened,
    toInsert,
  });
  return {
    ...result,
    replaced: deleted,
    inserted: insertedIds.length,
    manifest: opened.manifestFile,
  };
}

/** The stored regular rows against Schwab's daily range: levelCheck's answer. */
function storedLevel(closes, symbol, date, regular) {
  let extremes;
  try {
    extremes = extremesFor(closes, symbol, date);
  } catch (err) {
    if (err instanceof DayFailure) {
      return { ok: false, dh: null, dl: null, reason: err.message };
    }
    throw err;
  }
  const rows = regular.map((r) => ({
    market_time: r.market_time,
    high: Number(r.high),
    low: Number(r.low),
  }));
  return levelCheck({ symbol, rows, ...extremes });
}

/**
 * How many stored rows scale their backed-up row (same minute) by `expected`
 * within SCALED_TOLERANCE: `{ share, reason? }`, `share` the matching part of
 * the pairs, null with no pair. It fails closed: a close that is not a number
 * is no match.
 */
function scaledShareOf(stored, backed, expected) {
  const before = new Map(
    backed.map((r) => [
      Math.floor(Date.parse(r.timestamp) / MINUTE_MS),
      Number(r.close),
    ]),
  );
  let pairs = 0;
  let matches = 0;
  for (const row of stored) {
    const was = before.get(Math.floor(Number(row.epoch_ms) / MINUTE_MS));
    if (was === undefined) continue;
    pairs += 1;
    const scale = Number(row.close) / was;
    if (Math.abs(scale / expected - 1) <= SCALED_TOLERANCE) matches += 1;
  }
  if (pairs === 0) {
    return { share: null, reason: 'no stored row pairs with a backed-up row' };
  }
  const share = matches / pairs;
  if (share >= SCALED_SHARE_MIN) return { share };
  return {
    share,
    reason:
      `${matches} of ${pairs} stored rows scale the backed-up row by the ` +
      `manifest's ratio ÷ priorRatio ${Number(expected.toPrecision(7))}, under ` +
      `the ${Math.round(SCALED_SHARE_MIN * 100)}% needed`,
  };
}

/**
 * Check a refit date after the write, read-only (`--check`):
 *   { ok, dh, dl, regular, scaledShare, reason? }
 * The date's current manifest (findRefitManifest) must be a refit's. Then
 *   - the stored regular rows go through levelCheck against Schwab's daily
 *     range (extremesFor): `dh`, `dl`;
 *   - each stored row is paired with the backed-up row of the same minute, and
 *     on at least 99% of the pairs `stored close ÷ backed-up close` must equal
 *     the manifest's `ratio ÷ priorRatio` within 1e-6 relative: both rows are
 *     one UW bar times a ratio, so this tells a fitted write from a close-ratio
 *     one on every date. `scaledShare` is the matching part of the pairs.
 * It fails closed, naming each check that failed in `reason`; `dh`, `dl` and
 * `scaledShare` are null where the check never ran. `regular` is the number of
 * stored regular rows.
 */
export async function checkRefitDay(sql, { symbol, date, closes, backupDir }) {
  const failed = (reason) => ({
    ok: false,
    dh: null,
    dl: null,
    regular: 0,
    scaledShare: null,
    reason,
  });
  const found = await findRefitManifest(sql, { symbol, date, backupDir });
  if (!found.ok) return failed(found.reason);
  const { manifest, manifestPath } = found;
  if (manifest?.kind !== 'refit') {
    const rows = manifest == null ? "the 11-06 backfill's" : "the repair's";
    return failed(
      `${symbol} ${date} has no refit manifest: its rows are ${rows}, not refit`,
    );
  }
  const { ratio, priorRatio } = manifest;
  const usable = (n) => Number.isFinite(n) && n > 0;
  if (!(usable(ratio) && usable(priorRatio))) {
    return failed(
      `the refit manifest ${basename(manifestPath)} has no usable ratio and priorRatio`,
    );
  }

  let backed;
  try {
    ({ rows: backed } = await loadUndo(manifestPath));
  } catch (err) {
    return failed(`cannot read the backup of ${manifestPath}: ${err.message}`);
  }
  const stored = await readDay(sql, symbol, date, { kind: 'check' });
  const regular = stored.filter((r) => r.market_time === 'r');
  const level = storedLevel(closes, symbol, date, regular);
  const share = scaledShareOf(stored, backed, ratio / priorRatio);
  const reasons = [level.reason, share.reason].filter((r) => r != null);
  return {
    ok: reasons.length === 0,
    dh: level.dh,
    dl: level.dl,
    regular: regular.length,
    scaledShare: share.share,
    ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
  };
}

/**
 * The day worker of the CLI's runDays loop for `--refit`: findRefitManifest,
 * then prepareRefitDay, then refitDay. A date whose current manifest is
 * already a refit's is left alone, with no UW call and no write, and counted
 * done: `{ fetched: 0, stored: 0, alreadyRefit: true, manifestPath }` (to
 * refit it again, undo its refit first; refitRunSummary prints it on its own
 * line, not as an empty day). A failed find, a day that cannot be
 * prepared (its UW kind kept) or a refit that skips the date throws a
 * DayFailure with the reason, so runDays records it against the date and the
 * run ends with exit code 1.
 *
 * Otherwise it returns the counts runDays wants, `fetched` (mapped rows) and
 * `stored` (0 on a dry run), with the measures runDays prints on the date's
 * line, in this order: the close, prior and fitted ratios, the matched
 * minutes, the scatter and `dh`/`dl` (two decimals), then `replaced` and
 * `manifest` after an apply or `wouldReplace` and `wouldInsert` on a dry run,
 * with `dropped` (UW bars left out as malformed) and `uncovered` between.
 */
export async function processRefitDay(
  sql,
  {
    symbol,
    date,
    list,
    closes,
    uwKey,
    waitForSlot,
    spotsDir,
    backupDir,
    apply,
  },
) {
  const found = await findRefitManifest(sql, { symbol, date, backupDir });
  if (!found.ok) throw new DayFailure('other', found.reason);
  if (found.manifest?.kind === 'refit') {
    return {
      fetched: 0,
      stored: 0,
      alreadyRefit: true,
      manifestPath: found.manifestPath,
    };
  }
  const prepared = await prepareRefitDay(sql, {
    symbol,
    date,
    closes,
    uwKey,
    waitForSlot,
    spotsDir,
  });
  if (!prepared.ok) throw new DayFailure(prepared.kind, prepared.reason);
  const result = await refitDay(sql, {
    symbol,
    date,
    list,
    prepared,
    found,
    backupDir,
    apply,
  });
  if (result.skipped != null) throw new DayFailure('other', result.skipped);
  const measures = {
    fetched: prepared.rows.length,
    stored: apply ? result.inserted : 0,
    closeRatio: result.closeRatio,
    priorRatio: result.priorRatio,
    fittedRatio: result.ratio,
    matched: prepared.matched,
    scatter: shownPoints(prepared.scatter),
    dh: shownPoints(prepared.dh),
    dl: shownPoints(prepared.dl),
  };
  const tail = { dropped: prepared.dropped, uncovered: result.uncovered };
  if (!apply) {
    return {
      ...measures,
      wouldReplace: result.replaced,
      wouldInsert: result.inserted,
      ...tail,
    };
  }
  return {
    ...measures,
    replaced: result.replaced,
    ...tail,
    manifest: result.manifest,
  };
}

/**
 * The day worker of the CLI's runDays loop for `--check`: checkRefitDay, with
 * a DayFailure (`other`) carrying its reason when the date does not pass. On a
 * pass, `{ fetched, stored: 0, dh, dl, scaledShare }`: the stored regular rows
 * read, the level misses to two decimals, and the matching share of the pairs
 * to four.
 */
export async function processCheckDay(
  sql,
  { symbol, date, closes, backupDir },
) {
  const out = await checkRefitDay(sql, { symbol, date, closes, backupDir });
  if (!out.ok) throw new DayFailure('other', out.reason);
  return {
    fetched: out.regular,
    stored: 0,
    dh: shownPoints(out.dh),
    dl: shownPoints(out.dl),
    scaledShare: Number(out.scaledShare.toFixed(4)),
  };
}

/**
 * The summary lines of a `--refit` run (runDays' result) and its exit code:
 * formatRunSummary's, except for the dates processRefitDay left alone as
 * already refit. Their `fetched 0` would list them under "empty days (UW had
 * no rows)", which they are not, so they are taken out of that list and given
 * a line of their own, `already refit: N dates`, ahead of any `stopped:` or
 * `not run` line. They stay counted done: the exit code is summarizeRun's.
 * (The value cannot carry it: runDays needs a whole `fetched`, and nothing was
 * fetched.) `{ lines, exitCode }`.
 */
export function refitRunSummary(run) {
  const summary = summarizeRun(run);
  const left = new Set(
    summary.okDays
      .filter(({ value }) => value.alreadyRefit === true)
      .map(({ date }) => date),
  );
  const lines = formatRunSummary({
    ...summary,
    emptyDays: summary.emptyDays.filter((date) => !left.has(date)),
  });
  if (left.size > 0) {
    const noun = left.size === 1 ? 'date' : 'dates';
    const stop = lines.findIndex(
      (line) => line.startsWith('stopped: ') || line.startsWith('not run ('),
    );
    lines.splice(
      stop === -1 ? lines.length : stop,
      0,
      `already refit: ${left.size} ${noun}`,
    );
  }
  return { lines, exitCode: summary.exitCode };
}

// ── The guards ─────────────────────────────────────────────

/**
 * The refusal to print when the run may not start now, or null: the weekday
 * market-hours window (UW's concurrency cap, backfill-cli's) first, then the
 * Schwab crons' weekday window (schwab-local's). The windows and the texts are
 * theirs, with `offerFlag: false`: this CLI has no --allow-market-hours, so
 * neither text names it. `runDays` is given the same choice for its mid-run
 * `stopped:` line.
 */
export function repairGuardRefusal() {
  return (
    marketHoursRefusal({ allowMarketHours: false, offerFlag: false }) ??
    schwabCronsBusyRefusal({ offerFlag: false })
  );
}

// ── The backup folder ──────────────────────────────────────

/**
 * The main checkout, from the output of `git rev-parse --path-format=absolute
 * --git-common-dir` (run in a worktree it names the main checkout's .git).
 * The backups live there, not in the worktree: that folder is gitignored and
 * survives the worktree's pruning. Throws on a path that is not a `.git`.
 */
export function mainCheckoutDir(gitCommonDirOutput) {
  let gitDir = String(gitCommonDirOutput).trim();
  while (gitDir.endsWith('/') || gitDir.endsWith('\\')) {
    gitDir = gitDir.slice(0, -1);
  }
  if (basename(gitDir) !== '.git') {
    throw new Error(`not a .git directory: ${JSON.stringify(gitDir)}`);
  }
  return dirname(gitDir);
}

/** docs/tmp/spx-candle-repair/ in the main checkout. */
export function defaultBackupDir(gitCommonDirOutput) {
  return join(
    mainCheckoutDir(gitCommonDirOutput),
    'docs',
    'tmp',
    'spx-candle-repair',
  );
}

// ── Flags ──────────────────────────────────────────────────

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function isWord(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('--');
}

/** The flags that take a value: where it goes, how it is checked, what to say. */
const VALUE_FLAGS = new Map([
  [
    '--symbol',
    {
      key: 'symbol',
      valid: (v) => SYMBOLS.includes(v),
      message: (v) => `--symbol must be SPX or NDX, got ${v}`,
    },
  ],
  [
    '--list',
    {
      key: 'list',
      valid: isWord,
      message: () => '--list needs a list name',
    },
  ],
  [
    '--date',
    {
      key: 'date',
      valid: isIsoDate,
      message: (v) => `--date needs a YYYY-MM-DD date, got ${v}`,
    },
  ],
  [
    '--undo',
    {
      key: 'undo',
      valid: isWord,
      message: () => '--undo needs the path of a manifest',
    },
  ],
  [
    '--spots',
    {
      key: 'spots',
      valid: isWord,
      message: () => '--spots needs the folder of the price files',
    },
  ],
]);

/** The flags that take no value, and the switch each turns on. */
const SWITCH_FLAGS = new Map([
  ['--apply', 'apply'],
  ['--lottery-spots', 'lotterySpots'],
  ['--refit', 'refit'],
  ['--check', 'check'],
]);

/**
 * The list a --list or --date names for `symbol`, `{ list, dates }`, or a
 * thrown message. A refit-only list (summer) is for --refit and --check.
 */
function listFor({ symbol, list, date }, refitAllowed) {
  if (list != null) {
    const symbols = LIST_SYMBOL_MAP.get(list);
    if (symbols == null) {
      throw new Error(
        `unknown list ${list} (${[...LIST_DATES.keys()].join(', ')})`,
      );
    }
    if (!symbols.includes(symbol)) {
      throw new Error(
        `${list} is a list for ${symbols.join(' and ')}, not ${symbol}`,
      );
    }
    if (!refitAllowed && REFIT_ONLY_LISTS.has(list)) {
      throw new Error(`the ${list} list is for --refit only`);
    }
    return { list, dates: [...LIST_DATES.get(list)] };
  }
  const found = [...LIST_DATES.keys()].find(
    (name) =>
      LIST_SYMBOL_MAP.get(name).includes(symbol) &&
      LIST_DATES.get(name).includes(date),
  );
  if (found == null) throw new Error(`${date} is not in any ${symbol} list`);
  if (!refitAllowed && REFIT_ONLY_LISTS.has(found)) {
    throw new Error(
      `${date} is in the ${found} list, which is for --refit only`,
    );
  }
  return { list: found, dates: [date] };
}

/**
 * Parse the CLI flags into a plan, or throw a message naming the problem
 * (the CLI exits 2 on it). Either
 *   --symbol SPX|NDX  and one of  --list <name>  or  --date D  [--apply]
 * which returns `{ mode: 'repair', symbol, list, dates, apply }` (a --date
 * must belong to a list of that symbol; `list` is that list; the summer list
 * is refit-only), or the same with
 *   --refit --spots <folder>
 * which returns `{ mode: 'refit', symbol, list, dates, apply, spots }` (the
 * folder of price files; any list), or the same with
 *   --check  (no --apply: it writes nothing)
 * which returns `{ mode: 'check', symbol, list, dates }`, or
 *   --undo <manifest>  [--apply]
 * which returns `{ mode: 'undo', manifest, apply }`, or
 *   --lottery-spots  [--apply]
 * which returns `{ mode: 'lottery-spots', apply }` and takes no other flag
 * (scripts/_lib/lottery-spot-repair.mjs). Without --apply the modes that write
 * only report: the default is a dry run.
 */
export function parseRepairArgs(argv) {
  const got = { symbol: null, list: null, date: null, undo: null, spots: null };
  const on = { apply: false, lotterySpots: false, refit: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const switched = SWITCH_FLAGS.get(flag);
    if (switched != null) {
      on[switched] = true;
      continue;
    }
    const spec = VALUE_FLAGS.get(flag);
    if (spec == null) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!spec.valid(value)) throw new Error(spec.message(value));
    if (got[spec.key] != null) throw new Error(`${flag} given twice`);
    got[spec.key] = value;
  }
  const { apply } = on;
  const modeFlag = on.refit || on.check;

  if (on.lotterySpots) {
    if (modeFlag || Object.values(got).some((value) => value != null)) {
      throw new Error('--lottery-spots takes only --apply');
    }
    return { mode: 'lottery-spots', apply };
  }
  if (got.undo != null) {
    const others = [got.symbol, got.list, got.date, got.spots];
    if (modeFlag || others.some((value) => value != null)) {
      throw new Error('--undo takes only --apply');
    }
    return { mode: 'undo', manifest: got.undo, apply };
  }
  if (on.refit && on.check) {
    throw new Error('give only one of --refit or --check');
  }
  if (got.spots != null && !on.refit) throw new Error('--spots needs --refit');
  if (on.refit && got.spots == null) {
    throw new Error('--refit needs --spots <folder> (the price files)');
  }
  if (on.check && apply) {
    throw new Error('--check writes nothing, so it takes no --apply');
  }
  if (got.symbol == null) throw new Error('--symbol is required (SPX or NDX)');
  const { symbol } = got;
  if (got.list == null && got.date == null) {
    throw new Error('one of --list or --date is required');
  }
  if (got.list != null && got.date != null) {
    throw new Error('give only one of --list or --date');
  }
  const { list, dates } = listFor(got, modeFlag);
  if (on.refit) {
    return { mode: 'refit', symbol, list, dates, apply, spots: got.spots };
  }
  if (on.check) return { mode: 'check', symbol, list, dates };
  return { mode: 'repair', symbol, list, dates, apply };
}
