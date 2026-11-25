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
 * SQL is tagged templates only: sql.transaction takes lazy statements, and
 * only a tagged template is lazy on both neon and the pglite test client.
 * Inserts are unnest batches of at most WRITE_BATCH (500) rows (R5).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { cashSessionMinutes } from '../../src/data/marketHours.ts';
import {
  DayFailure,
  WRITE_BATCH,
  chunk,
  classifyFailure,
  marketHoursRefusal,
  retryTransientDb,
  tradingDaysInRange,
} from './backfill-cli.mjs';
import {
  INDEXES,
  UW_CANDLE_LIMIT,
  fetchUwCandles,
  ratioFor,
  toIndexRows,
} from './candles-backfill.mjs';
import { schwabCronsBusyRefusal } from './schwab-local.mjs';

// ── The lists ──────────────────────────────────────────────

/**
 * Spec decision 2: exact dates, never a range that touches another day. The
 * trading days come from src/data/marketHours.ts (Good Friday 2026-04-03 is
 * not one). The test pins the counts and the ends.
 */
const LIST_RANGES = {
  'spx-repair': [['2026-02-25', '2026-04-10']],
  'ndx-repair': [['2026-03-23', '2026-05-01']],
  'ndx-fill': [['2026-02-25', '2026-03-20']],
  gap: [
    ['2026-09-21', '2026-09-30'],
    ['2026-10-08', '2026-10-15'],
  ],
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
});

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
 */
export function checkMappedDay({ symbol, date, rows, settlement, ndxClose }) {
  const tolerance = CLOSE_TOLERANCE[symbol];
  if (tolerance == null) throw new RangeError(`no day check for ${symbol}`);
  const regular = rows.filter((r) => r.market_time === 'r');
  const expected = cashSessionMinutes(date);
  if (regular.length === 0 || regular.length !== expected) {
    return fail(
      `${regular.length} regular bars, expected ${expected} for ${date}`,
    );
  }
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
  let basis;
  try {
    basis = ratioFor(closes, symbol, date);
  } catch (err) {
    if (err instanceof DayFailure) return skip(err.kind, err.message);
    throw err;
  }

  const answer = await fetchUwCandles(uwKey, etf, date, waitForSlot);
  if (answer.kind === 'error') {
    const { kind, detail } = classifyFailure(answer);
    return skip(kind, `UW ${etf} bars for ${date}: ${answer.status} ${detail}`);
  }
  if (answer.kind === 'empty') {
    return skip('other', `UW has no ${etf} bars for ${date}`);
  }
  if (answer.rows.length >= UW_CANDLE_LIMIT) {
    return skip(
      'other',
      `UW returned ${answer.rows.length} ${etf} bars for ${date}, its ` +
        `${UW_CANDLE_LIMIT}-row cap: the day may be cut short`,
    );
  }

  const { rows, dropped } = toIndexRows(symbol, date, answer.rows, basis.ratio);
  const check = checkMappedDay({
    symbol,
    date,
    rows,
    settlement: symbol === 'SPX' ? await readSettlement(sql, date) : null,
    ndxClose: symbol === 'NDX' ? basis.indexClose : null,
  });
  if (!check.ok) {
    const noun = dropped === 1 ? 'bar' : 'bars';
    const lost =
      dropped > 0 ? ` (${dropped} ${noun} dropped as malformed)` : '';
    return skip('other', `${check.reason}${lost}`);
  }
  return { ok: true, rows, ratio: basis.ratio, dropped };
}

/**
 * Every stored row of `symbol` on `date`, every column as text (what a backup
 * keeps, so a restore is exact to the microsecond whatever the session time
 * zone: a timestamptz renders with its offset), plus `epoch_ms` to match
 * minutes and `selected`, whether the delete predicate takes the row. One
 * statement, so the selection and the kept rows come from one snapshot.
 * ORDER BY names the table: a bare `timestamp` would sort by the text alias.
 */
function readDay(sql, symbol, date, selection) {
  const bound = {
    createdFrom: null,
    createdThrough: null,
    createdBefore: null,
    timestampBefore: null,
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
               ${selection.kind}::text = 'repair'
               AND (${bound.createdFrom}::timestamptz IS NULL
                    OR created_at >= ${bound.createdFrom}::timestamptz)
               AND (${bound.createdThrough}::timestamptz IS NULL
                    OR created_at <= ${bound.createdThrough}::timestamptz)
               AND (${bound.createdBefore}::timestamptz IS NULL
                    OR created_at < ${bound.createdBefore}::timestamptz)
               AND (${bound.timestampBefore}::timestamptz IS NULL
                    OR timestamp < ${bound.timestampBefore}::timestamptz)
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

/** Why the request must not touch the table, or null. Checked before any read. */
function requestProblem({ symbol, date, list, rows, ratio, backupDir, apply }) {
  const symbols = LIST_SYMBOL_MAP.get(list);
  if (symbols == null) return `unknown list ${list}`;
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
    list,
    ratio,
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

  const statements = [];
  if (selected.length > 0) {
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
  return {
    ...counts,
    deleted,
    inserted: insertedIds.length,
    manifest: manifestFile,
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
  return [
    `${manifest.symbol} ${manifest.date}, repair of list ${manifest.list}`,
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
]);

/**
 * Parse the CLI flags into a plan, or throw a message naming the problem
 * (the CLI exits 2 on it). Either
 *   --symbol SPX|NDX  and one of  --list <name>  or  --date D  [--apply]
 * which returns `{ mode: 'repair', symbol, list, dates, apply }` (a --date
 * must belong to a list of that symbol; `list` is that list), or
 *   --undo <manifest>  [--apply]
 * which returns `{ mode: 'undo', manifest, apply }`, or
 *   --lottery-spots  [--apply]
 * which returns `{ mode: 'lottery-spots', apply }` and takes no other flag
 * (scripts/_lib/lottery-spot-repair.mjs). Without --apply all three only
 * report: the default is a dry run.
 */
export function parseRepairArgs(argv) {
  const got = { symbol: null, list: null, date: null, undo: null };
  let apply = false;
  let lotterySpots = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (flag === '--lottery-spots') {
      lotterySpots = true;
      continue;
    }
    const spec = VALUE_FLAGS.get(flag);
    if (spec == null) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!spec.valid(value)) throw new Error(spec.message(value));
    if (got[spec.key] != null) throw new Error(`${flag} given twice`);
    got[spec.key] = value;
  }

  if (lotterySpots) {
    if (Object.values(got).some((value) => value != null)) {
      throw new Error('--lottery-spots takes only --apply');
    }
    return { mode: 'lottery-spots', apply };
  }
  if (got.undo != null) {
    if (got.symbol != null || got.list != null || got.date != null) {
      throw new Error('--undo takes only --apply');
    }
    return { mode: 'undo', manifest: got.undo, apply };
  }
  if (got.symbol == null) throw new Error('--symbol is required (SPX or NDX)');
  const { symbol } = got;
  if (got.list == null && got.date == null) {
    throw new Error('one of --list or --date is required');
  }
  if (got.list != null && got.date != null) {
    throw new Error('give only one of --list or --date');
  }
  if (got.list != null) {
    const symbols = LIST_SYMBOL_MAP.get(got.list);
    if (symbols == null) {
      throw new Error(
        `unknown list ${got.list} (${[...LIST_DATES.keys()].join(', ')})`,
      );
    }
    if (!symbols.includes(symbol)) {
      throw new Error(
        `${got.list} is a list for ${symbols.join(' and ')}, not ${symbol}`,
      );
    }
    return {
      mode: 'repair',
      symbol,
      list: got.list,
      dates: [...LIST_DATES.get(got.list)],
      apply,
    };
  }
  const list = [...LIST_DATES.keys()].find(
    (name) =>
      LIST_SYMBOL_MAP.get(name).includes(symbol) &&
      LIST_DATES.get(name).includes(got.date),
  );
  if (list == null) {
    throw new Error(`${got.date} is not in any ${symbol} list`);
  }
  return { mode: 'repair', symbol, list, dates: [got.date], apply };
}
