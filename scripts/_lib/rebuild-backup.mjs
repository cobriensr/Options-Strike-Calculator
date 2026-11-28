/**
 * Backup, scoped delete and restore for the rebuilds of Runbook C (spec
 * docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md, decision
 * 8; plan docs/superpowers/plans/2026-11-25-spx-candle-placeholder-repair.md,
 * Task 11). Several rebuilds (the gamma-fire delete and re-detection, the
 * outcome refill, the day-context update) have no dry run, so each is preceded
 * by a backup made here, and `restoreRows` undoes it. A bug here writes to
 * production with no undo, so every write is guarded twice: before the
 * transaction, in code, and inside it, in SQL.
 *
 * The tables are an allowlist (BACKUP_TABLES). A backup is two files in
 * `<backup dir>/rebuild/`: `<table>-<first>..<last>-<UTC stamp>.jsonl` (one
 * JSON object per row, every column as text) and, beside it, `<same>.manifest.json`
 * (table, key column, the dates in scope, column names and types, row count and
 * the file's SHA-256). Every mutation takes the .jsonl and refuses unless the
 * manifest is there and matches it, and the backup holds exactly the rows the
 * mutation will touch, column for column, on dates that cover the whole window.
 * A restore deletes everything in the backup's dates, so a backup is of at most
 * MAX_DATES days, none of them today or later (ET), and the file's name and
 * rows are checked against the manifest's dates (the checksum covers the file,
 * not the manifest). The three writers are a dry run unless `apply` is true.
 *
 * Keys, from information_schema at run time (and the migrations):
 *   ws_gamma_setup_fires   `id BIGSERIAL PRIMARY KEY` (#179), with
 *                          UNIQUE (fired_at, signal_type, node_strike)
 *   training_features, day_labels, day_embeddings, flow_regime_0dte_daily
 *                          `date DATE PRIMARY KEY` (#9, #10, #73, #189)
 * A table whose primary key is not one column is refused.
 *
 * A date in scope is the table's DATE column, or for fired_at (timestamptz)
 * `(fired_at AT TIME ZONE 'America/New_York')::date`, the ET session date.
 *
 * The Neon HTTP driver has no interactive transaction: `sql.transaction([...])`
 * runs a fixed list of statements, and a later one cannot read an earlier
 * one's result. So the in-transaction re-check is built from what such a list
 * can do:
 *   - the write only matches rows that are still exactly the backed-up ones (a
 *     SHA-256 of every column of the row, computed by Postgres, against the one
 *     computed here from the backup). The hash covers the journal columns, and
 *     the check before the transaction already refused a journal entry, so a
 *     fire with one now has either changed since (no match) or was refused;
 *   - the last statement raises, by casting a message to an integer, unless the
 *     scope now holds what the write should have left. A raise rolls the whole
 *     transaction back, and the error is turned into a RebuildRefusal.
 * So a fire inserted, a row changed, or a journal entry written between the
 * check and the write makes the write refuse and change nothing.
 *
 * Identifiers cannot be bound parameters. They reach SQL only through
 * `sql.unsafe`, and only from BACKUP_TABLES or from information_schema for an
 * allowlisted table, always quoted (types the same way, after a closed list).
 * Every value is a bound parameter.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getETDateStr } from '../../src/utils/timezone.ts';
import { EXIT_FAILED, EXIT_OK } from './backfill-cli.mjs';
import {
  parseBackupText,
  stampOf,
  writeBackup,
} from './index-candle-repair.mjs';

/** The tables this tool backs up, and the date column that scopes each. */
export const BACKUP_TABLES = Object.freeze({
  training_features: 'date',
  day_labels: 'date',
  ws_gamma_setup_fires: 'fired_at',
  flow_regime_0dte_daily: 'date',
  day_embeddings: 'date',
});

const GAMMA_TABLE = 'ws_gamma_setup_fires';

/**
 * The manual journal columns of ws_gamma_setup_fires (migration #179,
 * db-migrations.ts:5079-5083): a fire with `trade_taken = true` or a non-NULL
 * value in any of the other four is never deleted. hasJournalEntry spells them
 * out; requireGammaShape fails the run if the table no longer has them.
 */
const JOURNAL_COLUMNS = Object.freeze([
  'trade_taken',
  'trade_premium_cost',
  'trade_premium_close',
  'trade_pnl_dollars',
  'trade_notes',
]);

/** The outcome columns the NULLing clears (and the only `ret_` columns the table may have). */
const RETURN_COLUMNS = Object.freeze([
  'ret_15m',
  'ret_30m',
  'ret_60m',
  'ret_eod',
]);

/**
 * The most days one backup, delete or NULLing covers. A restore deletes every
 * row in its backup's dates, so the scope must stay a slice of a table, never
 * the table: 62 days is two months (the runbook's widest window is 51 days),
 * and no span of that size reaches back over a table's whole history. It also
 * bounds the size of every statement. A production probe measured 370 days of
 * day_embeddings, the widest rows, at about 6.5 MB; Neon's cap is 64 MB.
 */
export const MAX_DATES = 62;

/** A restore insert holds at most this many rows ... */
export const RESTORE_BATCH_ROWS = 500;
/**
 * ... and about this many bytes of values. This keeps one statement's text
 * moderate; it does not bound the request. All batches go in one
 * `sql.transaction` call, so one HTTP request, and its total is bounded by
 * MAX_DATES (62 days of rows), not by this.
 */
const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;

/** A refusal: the tool saw a reason not to write, and wrote nothing. */
export class RebuildRefusal extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RebuildRefusal';
  }
}

// ── Identifiers, types, dates ──────────────────────────────

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

function assertAllowedTable(table) {
  if (typeof table === 'string' && Object.hasOwn(BACKUP_TABLES, table)) return;
  throw new RebuildRefusal(
    `${JSON.stringify(table)} is not one of the tables this tool handles ` +
      `(${Object.keys(BACKUP_TABLES).join(', ')})`,
  );
}

/** information_schema data_type -> the type a text value is cast to. */
const CAST_TYPES = new Map([
  ['bigint', 'bigint'],
  ['integer', 'integer'],
  ['smallint', 'smallint'],
  ['numeric', 'numeric'],
  ['double precision', 'double precision'],
  ['real', 'real'],
  ['boolean', 'boolean'],
  ['date', 'date'],
  ['timestamp with time zone', 'timestamp with time zone'],
  ['timestamp without time zone', 'timestamp without time zone'],
  ['jsonb', 'jsonb'],
  ['json', 'json'],
  ['text', 'text'],
  // Through text, so a char(n) or varchar(n) column is assigned, not truncated
  // by the cast itself.
  ['character varying', 'text'],
  ['character', 'text'],
]);

/** The only user-defined type: day_embeddings.embedding, vector(2000), migration #73. */
const USER_TYPES = new Set(['vector']);

/** The type to cast a text value to, or null when there is no safe cast. */
function castTypeOf({ data_type: dataType, udt_name: udtName }) {
  if (dataType === 'USER-DEFINED') {
    return USER_TYPES.has(udtName) ? udtName : null;
  }
  return CAST_TYPES.get(dataType) ?? null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function assertIsoDate(value, what) {
  if (!isIsoDate(value)) {
    throw new RebuildRefusal(
      `${what} needs a YYYY-MM-DD date, got ${JSON.stringify(value)}`,
    );
  }
}

const DAY_MS = 86_400_000;

/** Every calendar day from `from` to `to`, both included. */
export function datesBetween(from, to) {
  assertIsoDate(from, 'the start');
  assertIsoDate(to, 'the end');
  const end = Date.parse(`${to}T00:00:00Z`);
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) {
    if (days.length === MAX_DATES) {
      throw new RebuildRefusal(
        `${from} .. ${to} is more than ${MAX_DATES} days; use several backups`,
      );
    }
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  if (days.length === 0) {
    throw new RebuildRefusal(`${from} is after ${to}`);
  }
  return days;
}

/** A list of dates: sorted, without repeats, each a real date, at most MAX_DATES. */
function normalizeDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new RebuildRefusal('give at least one date');
  }
  for (const d of dates) assertIsoDate(d, 'every date');
  const unique = [...new Set(dates)].sort();
  if (unique.length > MAX_DATES) {
    throw new RebuildRefusal(
      `${unique.length} dates is more than ${MAX_DATES}; use several backups`,
    );
  }
  return unique;
}

/**
 * `--dates`: comma-separated items, each a date or a `from..to` range of
 * calendar days. A day with no row is simply not there.
 */
export function parseDatesSpec(spec) {
  if (typeof spec !== 'string') throw new RebuildRefusal('give the dates');
  const days = [];
  for (const item of spec.split(',')) {
    const bounds = item.split('..');
    if (bounds.length === 1) {
      assertIsoDate(item, 'every date');
      days.push(item);
    } else if (bounds.length === 2) {
      days.push(...datesBetween(bounds[0], bounds[1]));
    } else {
      throw new RebuildRefusal(
        `${JSON.stringify(item)} is not a YYYY-MM-DD date or a from..to range`,
      );
    }
  }
  return normalizeDates(days);
}

// ── The table, as information_schema describes it ──────────

/** The ET session date of a timestamptz column, or a DATE column as it is. */
function scopeExpression(column) {
  if (column.type === 'date') return column.ident;
  if (column.type === 'timestamp with time zone') {
    return `(${column.ident} AT TIME ZONE 'America/New_York')::date`;
  }
  return null;
}

/**
 * The ET session date of a timestamptz as Postgres writes it under the pinned
 * UTC session (`2026-03-26 15:00:00.123456+00`), or null if it is not one.
 */
function etDateOfTimestampText(text) {
  if (typeof text !== 'string') return null;
  const at = new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isNaN(at.getTime()) ? null : getETDateStr(at);
}

/**
 * What a run needs to know about `table`, from the rows information_schema
 * gave for its columns and its primary key. Pure; throws a RebuildRefusal for a
 * table it could not back up and restore faithfully: a column with no safe cast
 * back from text, no usable date column, or a primary key that is not one
 * column.
 */
export function buildTableInfo(table, columnRows, keyColumns) {
  assertAllowedTable(table);
  if (columnRows.length === 0) {
    throw new RebuildRefusal(
      `${table} has no columns in information_schema (does the table exist?)`,
    );
  }
  const columns = columnRows.map((row) => ({
    name: row.column_name,
    ident: quoteIdent(row.column_name),
    dataType: row.data_type,
    type: castTypeOf(row),
    generated: row.is_generated === 'ALWAYS',
  }));
  const uncastable = columns.filter((c) => c.type == null);
  if (uncastable.length > 0) {
    throw new RebuildRefusal(
      `${table} has no safe cast back from text for ` +
        uncastable.map((c) => `${c.name} (${c.dataType})`).join(', ') +
        ', so a backup of it could not be restored',
    );
  }

  const dateColumn = BACKUP_TABLES[table];
  const dateCol = columns.find((c) => c.name === dateColumn);
  if (dateCol == null) {
    throw new RebuildRefusal(`${table} has no date column ${dateColumn}`);
  }
  const scopeExpr = scopeExpression(dateCol);
  if (scopeExpr == null) {
    throw new RebuildRefusal(
      `${table}: the date column ${dateColumn} is ${dateCol.dataType}, ` +
        'not date or timestamp with time zone',
    );
  }

  const [keyColumn, ...rest] = keyColumns;
  const keyCol = columns.find((c) => c.name === keyColumn);
  if (keyCol == null || rest.length > 0) {
    throw new RebuildRefusal(
      `${table} must have a one-column primary key (found ` +
        `${keyColumns.length === 0 ? 'none' : keyColumns.join(', ')})`,
    );
  }

  return {
    table,
    tableIdent: quoteIdent(table),
    columns,
    dateColumn,
    scopeExpr,
    keyColumn,
    keyIdent: keyCol.ident,
    keyArrayType: `${keyCol.type}[]`,
    selectList: columns.map((c) => `${c.ident}::text AS ${c.ident}`).join(', '),
    /** The date a row (columns as text) is in scope on, as scopeExpr computes it. */
    scopeDateOf:
      dateCol.type === 'date'
        ? (row) => row[dateColumn]
        : (row) => etDateOfTimestampText(row[dateColumn]),
  };
}

async function describeTable(sql, table) {
  assertAllowedTable(table);
  const columnRows = await sql`
    SELECT column_name, data_type, udt_name, is_generated
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table}
    ORDER BY ordinal_position`;
  const keyRows = await sql`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = current_schema()
      AND tc.table_name = ${table}
    ORDER BY kcu.ordinal_position`;
  return buildTableInfo(
    table,
    columnRows,
    keyRows.map((r) => r.column_name),
  );
}

/** ws_gamma_setup_fires must still have the columns the delete and the NULLing spell out. */
function requireGammaShape(info) {
  const names = new Set(info.columns.map((c) => c.name));
  const missing = [...JOURNAL_COLUMNS, ...RETURN_COLUMNS].filter(
    (n) => !names.has(n),
  );
  const returns = [...names].filter((n) => n.startsWith('ret_'));
  const odd = returns.filter((n) => !RETURN_COLUMNS.includes(n));
  const keyIsId = info.keyColumn === 'id' && info.keyArrayType === 'bigint[]';
  if (!keyIsId || missing.length > 0 || odd.length > 0) {
    throw new RebuildRefusal(
      `${GAMMA_TABLE} is not the table this tool was written for ` +
        `(key ${info.keyColumn}` +
        (missing.length > 0 ? `, missing ${missing.join(', ')}` : '') +
        (odd.length > 0 ? `, unknown ${odd.join(', ')}` : '') +
        '); review the tool before running it',
    );
  }
}

// ── Rows, rows as text, and their fingerprint ──────────────

/** The shape of a backup row for writeBackup / parseBackupText: exactly these columns, each text or null. */
function rowShape(names) {
  return {
    isRow: (value) =>
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === names.length &&
      names.every((n) => Object.hasOwn(value, n)) &&
      Object.values(value).every((v) => v === null || typeof v === 'string'),
    project: (value) => Object.fromEntries(names.map((n) => [n, value[n]])),
  };
}

/**
 * The rows of `info.table` whose date is in `days`, every column as text, by
 * key. The time zone is pinned for the read: timestamptz text carries the
 * session's offset, and a backup must read the same however it is compared.
 */
async function readScopeRows(sql, info, days) {
  const results = await sql.transaction([
    sql`SET LOCAL TimeZone = 'UTC'`,
    sql`SELECT ${sql.unsafe(info.selectList)}
        FROM ${sql.unsafe(info.tableIdent)}
        WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
        ORDER BY ${sql.unsafe(info.tableIdent)}.${sql.unsafe(info.keyIdent)}`,
  ]);
  return results[1].map((row) =>
    Object.fromEntries(info.columns.map((c) => [c.name, row[c.name] ?? null])),
  );
}

const NULL_MARK = '\u0001N';
const FIELD_SEP = '\u001f';

/** SHA-256 of a row's text values (NULL marked), as Postgres computes it in rowHashSql. */
function rowHash(row, columns) {
  return createHash('sha256')
    .update(
      columns.map((c) => row[c.name] ?? NULL_MARK).join(FIELD_SEP),
      'utf8',
    )
    .digest('hex');
}

/** The same hash as SQL, for the row `alias`; `||` rather than concat_ws, which stops at 100 arguments. */
function rowHashSql(columns, alias) {
  const fields = columns
    .map((c) => `coalesce(${alias}.${c.ident}::text, chr(1) || 'N')`)
    .join(` || chr(31) || `);
  return `encode(sha256(convert_to(${fields}, 'UTF8')), 'hex')`;
}

// ── The backup files ───────────────────────────────────────

const MANIFEST_VERSION = 1;

const manifestPathOf = (backupPath) =>
  `${backupPath.slice(0, -'.jsonl'.length)}.manifest.json`;

const sha256 = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function parseManifest(text, file) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new RebuildRefusal(`${file} is not valid JSON: ${err.message}`, {
      cause: err,
    });
  }
  const valid =
    doc?.version === MANIFEST_VERSION &&
    typeof doc.table === 'string' &&
    typeof doc.keyColumn === 'string' &&
    typeof doc.dateColumn === 'string' &&
    Array.isArray(doc.dates) &&
    doc.dates.length > 0 &&
    doc.dates.length <= MAX_DATES &&
    // Real dates, ascending and without repeats, as backupRows writes them:
    // the file name is checked against the first and the last.
    doc.dates.every(
      (d, i, all) => isIsoDate(d) && (i === 0 || all[i - 1] < d),
    ) &&
    Array.isArray(doc.columns) &&
    doc.columns.every(
      (c) => typeof c?.name === 'string' && typeof c.type === 'string',
    ) &&
    Number.isInteger(doc.rowCount) &&
    doc.rowCount >= 0 &&
    typeof doc.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(doc.sha256);
  if (!valid) {
    throw new RebuildRefusal(
      `${file} is not a rebuild backup manifest (version ${MANIFEST_VERSION})`,
    );
  }
  return doc;
}

/** `number noun` with the plural s. */
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The first few of `items`, and how many more. */
function listSome(items, limit = 5) {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit
    ? `${shown} and ${items.length - limit} more`
    : shown;
}

/** What changed in the columns of the table since the manifest was written, or null. */
function columnChanges(info, manifest) {
  const live = new Map(info.columns.map((c) => [c.name, c.type]));
  const kept = new Map(manifest.columns.map((c) => [c.name, c.type]));
  const added = [...live.keys()].filter((n) => !kept.has(n));
  const removed = [...kept.keys()].filter((n) => !live.has(n));
  const retyped = [...kept.keys()].filter(
    (n) => live.has(n) && live.get(n) !== kept.get(n),
  );
  const parts = [
    added.length > 0 && `added: ${added.join(', ')}`,
    removed.length > 0 && `removed: ${removed.join(', ')}`,
    retyped.length > 0 && `retyped: ${retyped.join(', ')}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * The backup at `backupPath` (a .jsonl from backupRows) for `info.table`, or a
 * RebuildRefusal: the file and its manifest must exist, the manifest must be
 * valid and for this table and key, the file's name must begin as backupRows
 * named it (table and the manifest's first and last date), the file must still
 * be the one the manifest checksummed, the table's columns must be the ones
 * backed up, no key may repeat, and every row must be on one of the manifest's
 * dates. Returns `{ path, manifest, rows }`.
 */
async function loadBackup(backupPath, info) {
  requireBackupPath(backupPath);
  let text;
  try {
    text = await readFile(backupPath, 'utf8');
  } catch (err) {
    throw new RebuildRefusal(
      `cannot read the backup ${backupPath}: ${err.code ?? err.message}`,
      { cause: err },
    );
  }
  const manifestPath = manifestPathOf(backupPath);
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (err) {
    throw new RebuildRefusal(
      `the backup has no manifest beside it (${manifestPath}: ` +
        `${err.code ?? err.message}); only a backup made by --backup is accepted`,
      { cause: err },
    );
  }
  const manifest = parseManifest(manifestText, manifestPath);
  if (manifest.table !== info.table) {
    throw new RebuildRefusal(
      `the backup is of ${manifest.table}, not ${info.table}`,
    );
  }
  if (
    manifest.keyColumn !== info.keyColumn ||
    manifest.dateColumn !== info.dateColumn
  ) {
    throw new RebuildRefusal(
      `the backup's key or date column differs from ${info.table}'s ` +
        `(${manifest.keyColumn}, ${manifest.dateColumn})`,
    );
  }
  // The checksum covers the file, not the manifest, and the manifest's dates
  // are what a restore deletes. The name backupRows gave the file carries the
  // first and last of them, so a manifest edited to reach further is caught.
  const namePrefix = `${manifest.table}-${manifest.dates[0]}..${manifest.dates.at(-1)}-`;
  if (!basename(backupPath).startsWith(namePrefix)) {
    throw new RebuildRefusal(
      `the backup's file name does not match its manifest (expected it to ` +
        `begin ${namePrefix}): ${basename(backupPath)}`,
    );
  }
  if (sha256(text) !== manifest.sha256) {
    throw new RebuildRefusal(
      `the backup file ${backupPath} does not match its manifest ` +
        '(checksum differs): it was edited or cut short after it was taken',
    );
  }
  const changes = columnChanges(info, manifest);
  if (changes != null) {
    throw new RebuildRefusal(
      `the columns of ${info.table} have changed since the backup (${changes})`,
    );
  }
  const rows = parseBackupText(
    text,
    backupPath,
    rowShape(info.columns.map((c) => c.name)),
  );
  if (rows.length !== manifest.rowCount) {
    throw new RebuildRefusal(
      `the backup ${backupPath} holds ${rows.length} rows, its manifest says ${manifest.rowCount}`,
    );
  }
  const keys = rows.map((r) => r[info.keyColumn]);
  if (keys.includes(null) || new Set(keys).size !== keys.length) {
    throw new RebuildRefusal(
      `the backup ${backupPath} has a row with no key, or a repeated key`,
    );
  }
  // Every row must be on one of the manifest's dates, so the dates a restore
  // deletes over are the dates of the rows it puts back.
  const inScope = new Set(manifest.dates);
  const stray = rows.filter((r) => !inScope.has(info.scopeDateOf(r)));
  if (stray.length > 0) {
    const where = stray.map(
      (r) => `${r[info.keyColumn]} on ${info.scopeDateOf(r)}`,
    );
    throw new RebuildRefusal(
      `the backup ${backupPath} holds rows outside the backup's dates: ${listSome(where)}`,
    );
  }
  return { path: backupPath, manifest, rows };
}

/**
 * The backup must be of every day of the window the write covers: a restore
 * puts back (and clears) only the backup's own dates, so a window that is wider
 * leaves the undo partial. A day with no fires is still a day to cover.
 */
function assertBackupCovers(backup, days, window) {
  const covered = new Set(backup.manifest.dates);
  const missing = days.filter((d) => !covered.has(d));
  if (missing.length > 0) {
    throw new RebuildRefusal(
      `the backup's dates do not cover the window ${window} ` +
        `(missing ${listSome(missing)}): a restore would not put those days ` +
        'back. Take a backup of the whole window.',
    );
  }
}

function requireBackupPath(backupPath) {
  if (typeof backupPath !== 'string' || backupPath === '') {
    throw new RebuildRefusal(
      'this needs the backup file (--backup-file <path>)',
    );
  }
  if (!backupPath.endsWith('.jsonl')) {
    throw new RebuildRefusal(
      `the backup file must be a .jsonl written by --backup, got ${backupPath}`,
    );
  }
}

/**
 * Check the live rows against the backup, key by key and column by column.
 * Throws a RebuildRefusal naming every kind of difference: a live row the
 * backup lacks, a backed-up row that is not live, a row that differs.
 */
function assertBackupMatches(live, backup, info, { noun, what }) {
  const liveByKey = new Map(live.map((r) => [r[info.keyColumn], r]));
  const backedByKey = new Map(backup.rows.map((r) => [r[info.keyColumn], r]));
  const problems = [];

  const unbacked = [...liveByKey.keys()].filter((k) => !backedByKey.has(k));
  if (unbacked.length > 0) {
    const n = unbacked.length;
    const liveNoun = `live ${noun}`;
    problems.push(
      `${count(n, liveNoun)} ${n === 1 ? 'is' : 'are'} not in the backup (${listSome(unbacked)})`,
    );
  }
  const gone = [...backedByKey.keys()].filter((k) => !liveByKey.has(k));
  if (gone.length > 0) {
    const n = gone.length;
    problems.push(
      `${count(n, noun)} in the backup ${n === 1 ? 'is' : 'are'} not live (${listSome(gone)})`,
    );
  }
  const changed = [];
  for (const [key, row] of liveByKey) {
    const kept = backedByKey.get(key);
    if (kept == null) continue;
    const differing = info.columns
      .filter((c) => row[c.name] !== kept[c.name])
      .map((c) => c.name);
    if (differing.length > 0)
      changed.push(`id ${key}: ${differing.join(', ')}`);
  }
  if (changed.length > 0) {
    const n = changed.length;
    problems.push(
      `${count(n, noun)} ${n === 1 ? 'differs' : 'differ'} from the backup (${listSome(changed, 3)})`,
    );
  }

  if (problems.length > 0) {
    throw new RebuildRefusal(
      `the backup ${basename(backup.path)} does not match ${what}: ` +
        `${problems.join('; ')}. Take a fresh backup of exactly these rows.`,
    );
  }
}

// ── Raising inside a transaction ───────────────────────────

const GUARD_MARK = 'rebuild-backup guard';
const guardMessage = (reason) => `${GUARD_MARK}: ${reason}`;

/**
 * Run a transaction; when its last statement raised our guard (see the header),
 * the transaction is already rolled back, and the failure is a RebuildRefusal
 * with `refusal` as its text. Any other error is the database's own and goes
 * up unchanged.
 */
async function runGuarded(run, refusal) {
  try {
    return await run();
  } catch (err) {
    if (String(err?.message ?? '').includes(GUARD_MARK)) {
      throw new RebuildRefusal(refusal, { cause: err });
    }
    throw err;
  }
}

// ── backupRows ─────────────────────────────────────────────

/**
 * Back up the rows of `table` whose date column falls on `dates` (the ET
 * session date for fired_at), every column as text, to
 * `<backupDir>/rebuild/<table>-<first>..<last>-<UTC stamp>.jsonl`, with a
 * manifest beside it. Read-only on the database. Never overwrites a file. An
 * empty scope is still recorded, so that a restore removes what the rebuild
 * adds there. At most MAX_DATES days, and none on or after today's ET date:
 * a restore deletes everything in the backup's dates, so a session still being
 * written must not be in them. Returns `{ rows, path, manifestPath }` (`rows`
 * is the count).
 */
export async function backupRows(sql, { table, dates, backupDir }) {
  assertAllowedTable(table);
  const days = normalizeDates(dates);
  const today = getETDateStr(new Date());
  const open = days.filter((d) => d >= today);
  if (open.length > 0) {
    throw new RebuildRefusal(
      `the backup would cover ${listSome(open)}, on or after today ` +
        `(${today}, ET): a session still being written cannot be backed up`,
    );
  }
  if (typeof backupDir !== 'string' || backupDir === '') {
    throw new RebuildRefusal('a backup needs a backup directory');
  }
  const info = await describeTable(sql, table);
  const rows = await readScopeRows(sql, info, days);

  const dir = join(backupDir, 'rebuild');
  const base = join(
    dir,
    `${table}-${days[0]}..${days.at(-1)}-${stampOf(new Date())}`,
  );
  const path = `${base}.jsonl`;
  const manifestPath = `${base}.manifest.json`;
  await writeBackup(dir, path, rows, rowShape(info.columns.map((c) => c.name)));
  const manifest = {
    version: MANIFEST_VERSION,
    table,
    keyColumn: info.keyColumn,
    dateColumn: info.dateColumn,
    dates: days,
    columns: info.columns.map((c) => ({ name: c.name, type: c.type })),
    rowCount: rows.length,
    sha256: sha256(await readFile(path, 'utf8')),
    createdAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { rows: rows.length, path, manifestPath };
}

// ── deleteGammaFires ───────────────────────────────────────

/** Whether a live fire (columns as text) carries a manual journal entry. */
function hasJournalEntry(row) {
  return (
    row.trade_taken === 'true' ||
    row.trade_premium_cost != null ||
    row.trade_premium_close != null ||
    row.trade_pnl_dollars != null ||
    row.trade_notes != null
  );
}

/**
 * Delete the ws_gamma_setup_fires whose ET session date is in `from .. to`
 * (both included), once `backupPath` is a backup of exactly those fires.
 * Refuses (a RebuildRefusal, nothing written) unless the backup exists and its
 * manifest is intact; its dates cover every day of the window (a restore puts
 * back only the backup's own dates); its rows are the live fires of the
 * window, column for column; and no fire has `trade_taken = true` or a
 * non-NULL `trade_*` value. The transaction checks again: it deletes only fires
 * that are still exactly the backed-up ones (so none has gained a journal
 * entry), and raises, rolling the delete back, if any fire of the window is
 * left. Without `apply` it does the checks and stops: a dry run.
 * Returns `{ deleted }` (a dry run `{ deleted: 0, wouldDelete, dryRun: true }`).
 */
export async function deleteGammaFires(
  sql,
  { from, to, backupPath, apply = false },
) {
  const days = datesBetween(from, to);
  requireBackupPath(backupPath);
  const info = await describeTable(sql, GAMMA_TABLE);
  requireGammaShape(info);
  const backup = await loadBackup(backupPath, info);
  assertBackupCovers(backup, days, `${from} .. ${to}`);
  const live = await readScopeRows(sql, info, days);

  const journaled = live.filter(hasJournalEntry);
  if (journaled.length > 0) {
    const n = journaled.length;
    throw new RebuildRefusal(
      `${n} of the ${count(live.length, 'fire')} ${n === 1 ? 'carries' : 'carry'} ` +
        'a journal entry (trade_taken or a trade_* value), so nothing is ' +
        `deleted: ids ${listSome(journaled.map((r) => r.id))}`,
    );
  }
  assertBackupMatches(live, backup, info, {
    noun: 'fire',
    what: `the fires on ${from} .. ${to}`,
  });
  if (!apply) return { deleted: 0, wouldDelete: live.length, dryRun: true };
  if (live.length === 0) return { deleted: 0 };

  const ids = backup.rows.map((r) => r.id);
  const hashes = backup.rows.map((r) => rowHash(r, info.columns));
  const results = await runGuarded(
    () =>
      sql.transaction([
        sql`SET LOCAL TimeZone = 'UTC'`,
        sql`DELETE FROM ws_gamma_setup_fires AS f
            USING unnest(${ids}::bigint[], ${hashes}::text[]) AS b(id, hash)
            WHERE f.id = b.id
              AND ${sql.unsafe(rowHashSql(info.columns, 'f'))} = b.hash
            RETURNING f.id::text AS id`,
        sql`SELECT CAST(CASE WHEN EXISTS (
                SELECT 1 FROM ws_gamma_setup_fires
                WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
              ) THEN ${guardMessage(`fires of ${from} .. ${to} are left after the delete`)}::text
              ELSE '0' END AS integer) AS guard`,
      ]),
    `the fires on ${from} .. ${to} changed between the check and the delete ` +
      '(a fire was added, changed or given a journal entry). Nothing was deleted.',
  );
  return { deleted: results[1].length };
}

// ── nullGammaReturns ───────────────────────────────────────

/**
 * Set ret_15m, ret_30m, ret_60m and ret_eod to NULL on every fire whose ET
 * session date is `date`, once `backupPath` is a backup of exactly those fires
 * (the same rules as deleteGammaFires, journal entries aside: the journal
 * columns are not touched). Nothing but those four columns changes. The
 * transaction updates only fires that are still exactly the backed-up ones and
 * raises, rolling back, unless every fire of the date is there and has all four
 * NULL. Without `apply` it does the checks and stops: a dry run. Returns
 * `{ updated }`, the fires of the date (a dry run `{ updated: 0, wouldUpdate,
 * dryRun: true }`). The backup's dates must include `date`.
 */
export async function nullGammaReturns(
  sql,
  { date, backupPath, apply = false },
) {
  assertIsoDate(date, '--date');
  requireBackupPath(backupPath);
  const days = [date];
  const info = await describeTable(sql, GAMMA_TABLE);
  requireGammaShape(info);
  const backup = await loadBackup(backupPath, info);
  assertBackupCovers(backup, days, date);
  const live = await readScopeRows(sql, info, days);

  assertBackupMatches(live, backup, info, {
    noun: 'fire',
    what: `the fires on ${date}`,
  });
  if (!apply) return { updated: 0, wouldUpdate: live.length, dryRun: true };
  if (live.length === 0) return { updated: 0 };

  const ids = backup.rows.map((r) => r.id);
  const hashes = backup.rows.map((r) => rowHash(r, info.columns));
  const results = await runGuarded(
    () =>
      sql.transaction([
        sql`SET LOCAL TimeZone = 'UTC'`,
        sql`UPDATE ws_gamma_setup_fires AS f
            SET ret_15m = NULL, ret_30m = NULL, ret_60m = NULL, ret_eod = NULL
            FROM unnest(${ids}::bigint[], ${hashes}::text[]) AS b(id, hash)
            WHERE f.id = b.id
              AND ${sql.unsafe(rowHashSql(info.columns, 'f'))} = b.hash
            RETURNING f.id::text AS id`,
        sql`SELECT CAST(CASE WHEN (
                SELECT count(*) FROM ws_gamma_setup_fires
                WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
              ) = ${live.length}::int
              AND NOT EXISTS (
                SELECT 1 FROM ws_gamma_setup_fires
                WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
                  AND (ret_15m IS NOT NULL OR ret_30m IS NOT NULL
                       OR ret_60m IS NOT NULL OR ret_eod IS NOT NULL)
              ) THEN '0'
              ELSE ${guardMessage(`the fires of ${date} are not all NULLed after the update`)}::text
              END AS integer) AS guard`,
      ]),
    `the fires on ${date} changed between the check and the update ` +
      '(a fire was added or changed). Nothing was changed.',
  );
  return { updated: results[1].length };
}

// ── restoreRows ────────────────────────────────────────────

/**
 * Split rows into batches of at most RESTORE_BATCH_ROWS rows and about
 * RESTORE_BATCH_BYTES of values (R5: by rows and bytes). Order is kept; a row
 * larger than the byte limit is a batch of its own.
 */
export function chunkRows(rows) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Object.values(row).reduce(
      (n, v) => n + (v?.length ?? 0) + 8,
      0,
    );
    if (
      batch.length > 0 &&
      (batch.length === RESTORE_BATCH_ROWS ||
        bytes + size > RESTORE_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * One INSERT of `rows` (text values, as the backup holds them): the batch is a
 * single bound jsonb parameter, read back by jsonb_to_recordset as text columns
 * and cast to each column's type (`::vector` for an embedding). A generated
 * column is left out; it is computed. RETURNING the keys, as text.
 */
export function restoreInsertStatement(sql, info, rows) {
  const insertable = info.columns.filter((c) => !c.generated);
  const names = insertable.map((c) => c.ident).join(', ');
  const casts = insertable.map((c) => `x.${c.ident}::${c.type}`).join(', ');
  const defs = insertable.map((c) => `${c.ident} text`).join(', ');
  const payload = JSON.stringify(
    rows.map((r) =>
      Object.fromEntries(insertable.map((c) => [c.name, r[c.name]])),
    ),
  );
  return sql`INSERT INTO ${sql.unsafe(info.tableIdent)} (${sql.unsafe(names)})
    SELECT ${sql.unsafe(casts)}
    FROM jsonb_to_recordset(${payload}::jsonb) AS x(${sql.unsafe(defs)})
    RETURNING ${sql.unsafe(info.keyIdent)}::text AS key`;
}

/** The journal columns of ws_gamma_setup_fires, as described by information_schema. */
const journalColumnsOf = (info) =>
  info.columns.filter((c) => JOURNAL_COLUMNS.includes(c.name));

/**
 * Refuse a restore of ws_gamma_setup_fires that would delete a live fire in
 * the backup's scope whose journal entry the backup does not hold: a fire with
 * a journal entry, that is not in the backup or is there with other journal
 * values (a restore puts the backup's journal back, so it must be the live one).
 */
async function assertJournalSurvives(sql, info, days, backup) {
  const live = await readScopeRows(sql, info, days);
  const kept = new Map(backup.rows.map((r) => [r[info.keyColumn], r]));
  const lost = live.filter(
    (row) =>
      hasJournalEntry(row) &&
      !JOURNAL_COLUMNS.every((c) => row[c] === kept.get(row.id)?.[c]),
  );
  if (lost.length > 0) {
    const n = lost.length;
    throw new RebuildRefusal(
      `${n} of the ${count(live.length, 'fire')} in the restore's scope ` +
        `${n === 1 ? 'carries' : 'carry'} a journal entry the backup does not ` +
        `hold (ids ${listSome(lost.map((r) => r.id))}), and a restore would ` +
        'delete it. Nothing was changed.',
    );
  }
}

/**
 * The restore's DELETE: every row in the backup's dates or on a backed-up key.
 * For ws_gamma_setup_fires a fire is kept when it has a journal entry and the
 * backup does not hold its journal columns with the same values (compared by
 * the same SHA-256 as the writers); the final count check of the transaction
 * then raises. RETURNING the keys, as text.
 */
function restoreDeleteStatement(sql, info, backup) {
  const days = backup.manifest.dates;
  const keys = backup.rows.map((r) => r[info.keyColumn]);
  const keyArray = sql.unsafe(info.keyArrayType);
  if (info.table !== GAMMA_TABLE) {
    return sql`DELETE FROM ${sql.unsafe(info.tableIdent)}
        WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
           OR ${sql.unsafe(info.keyIdent)} = ANY(${keys}::${keyArray})
        RETURNING ${sql.unsafe(info.keyIdent)}::text AS key`;
  }
  const journal = journalColumnsOf(info);
  const journalHashes = backup.rows.map((r) => rowHash(r, journal));
  return sql`DELETE FROM ws_gamma_setup_fires AS f
      WHERE (${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
             OR f.id = ANY(${keys}::bigint[]))
        AND NOT (
          (f.trade_taken OR f.trade_premium_cost IS NOT NULL
           OR f.trade_premium_close IS NOT NULL
           OR f.trade_pnl_dollars IS NOT NULL OR f.trade_notes IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(${keys}::bigint[], ${journalHashes}::text[]) AS b(id, hash)
            WHERE b.id = f.id
              AND ${sql.unsafe(rowHashSql(journal, 'f'))} = b.hash))
      RETURNING f.id::text AS key`;
}

/**
 * Put `table` back as `backupPath` held it: in ONE transaction delete every
 * row in the backup's scope (its dates, and any row on a backed-up key), then
 * re-insert the backed-up rows with their own keys, each text value cast back
 * to its column's type, in batches (RESTORE_BATCH_ROWS). The scope is
 * deleted, not only the backed-up keys: the rows a rebuild created (new ids
 * after a delete and re-detect, rows for days that had none) are what the
 * restore must remove. The transaction raises, rolling back, unless the scope
 * holds exactly the backed-up rows at the end; any database error (a
 * constraint, say) rolls it back too, so a failed restore leaves the table as
 * it was. Refuses a backup of another table, a changed column list, or a file
 * that fails its checksum.
 *
 * ws_gamma_setup_fires carries manual journal entries, which deleteGammaFires
 * never deletes, so the restore does not either: it refuses (before the
 * transaction, and in a dry run too) when a live fire in the scope has a
 * journal entry that the backup does not hold with the same values, and inside
 * the transaction its DELETE skips such a fire, so the final count check
 * raises and rolls everything back.
 *
 * Without `apply` it does the checks and stops: a dry run. Returns `{ restored,
 * deleted }` (a dry run `{ restored: 0, wouldRestore, wouldDelete, notInBackup,
 * dryRun: true }`).
 */
export async function restoreRows(sql, { table, backupPath, apply = false }) {
  assertAllowedTable(table);
  requireBackupPath(backupPath);
  const info = await describeTable(sql, table);
  if (table === GAMMA_TABLE) requireGammaShape(info);
  const backup = await loadBackup(backupPath, info);
  const days = backup.manifest.dates;
  const keys = backup.rows.map((r) => r[info.keyColumn]);
  const keyArray = sql.unsafe(info.keyArrayType);
  if (table === GAMMA_TABLE) {
    await assertJournalSurvives(sql, info, days, backup);
  }

  const [counts] = await sql`
    SELECT count(*)::int AS live,
           (count(*) FILTER (
             WHERE NOT (${sql.unsafe(info.keyIdent)} = ANY(${keys}::${keyArray}))
           ))::int AS extra
    FROM ${sql.unsafe(info.tableIdent)}
    WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])`;
  if (!apply) {
    return {
      restored: 0,
      wouldRestore: backup.rows.length,
      wouldDelete: counts.live,
      notInBackup: counts.extra,
      dryRun: true,
    };
  }

  const batches = chunkRows(backup.rows);
  const results = await runGuarded(
    () =>
      sql.transaction([
        restoreDeleteStatement(sql, info, backup),
        ...batches.map((batch) => restoreInsertStatement(sql, info, batch)),
        sql`SELECT CAST(CASE WHEN (
                SELECT count(*) FROM ${sql.unsafe(info.tableIdent)}
                WHERE ${sql.unsafe(info.scopeExpr)} = ANY(${days}::date[])
                   OR ${sql.unsafe(info.keyIdent)} = ANY(${keys}::${keyArray})
              ) = ${keys.length}::int THEN '0'
              ELSE ${guardMessage(`${table} does not hold exactly the backed-up rows after the restore`)}::text
              END AS integer) AS guard`,
      ]),
    `${table} changed during the restore (a row appeared in the backup's ` +
      'scope, or a fire gained a journal entry). Nothing was changed.',
  );
  const restored = results
    .slice(1, 1 + batches.length)
    .reduce((n, rows) => n + rows.length, 0);
  return { restored, deleted: results[0].length };
}

// ── The command line ───────────────────────────────────────

/** Value flags: where the value goes, and what to call a missing one. */
const VALUE_FLAGS = new Map([
  ['--backup', { key: 'backup', what: 'a table' }],
  ['--dates', { key: 'dates', what: 'a list or from..to range of dates' }],
  ['--from', { key: 'from', what: 'a YYYY-MM-DD date' }],
  ['--to', { key: 'to', what: 'a YYYY-MM-DD date' }],
  ['--date', { key: 'date', what: 'a YYYY-MM-DD date' }],
  ['--restore', { key: 'restore', what: 'a table' }],
  ['--backup-file', { key: 'backupFile', what: 'a path' }],
]);

const SWITCH_FLAGS = new Map([
  ['--apply', 'apply'],
  ['--delete-gamma-fires', 'deleteGammaFires'],
  ['--null-gamma-returns', 'nullGammaReturns'],
]);

/**
 * The modes: the flag that selects one and the key it sets, the other keys it
 * needs, and the ones it may take. Any other flag given is an error.
 */
const MODES = {
  backup: { flag: '--backup', own: 'backup', needs: ['dates'], takes: [] },
  'delete-gamma-fires': {
    flag: '--delete-gamma-fires',
    own: 'deleteGammaFires',
    needs: ['from', 'to', 'backupFile'],
    takes: ['apply'],
  },
  'null-gamma-returns': {
    flag: '--null-gamma-returns',
    own: 'nullGammaReturns',
    needs: ['date', 'backupFile'],
    takes: ['apply'],
  },
  restore: {
    flag: '--restore',
    own: 'restore',
    needs: ['backupFile'],
    takes: ['apply'],
  },
};

/** parse key -> the flag that sets it, for messages. */
const FLAG_OF = new Map(
  [...VALUE_FLAGS, ...SWITCH_FLAGS].map(([flag, spec]) => [
    typeof spec === 'string' ? spec : spec.key,
    flag,
  ]),
);

function isWord(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('--');
}

/**
 * Parse the CLI flags into a plan, or throw a message naming the problem (the
 * CLI exits 2 on it). Exactly one of
 *   --backup <table> --dates <list|from..to>
 *   --delete-gamma-fires --from D --to D --backup-file <path> [--apply]
 *   --null-gamma-returns --date D --backup-file <path> [--apply]
 *   --restore <table> --backup-file <path> [--apply]
 * Without --apply the three that write only report: dry run is the default.
 * --backup always writes its file (it never touches the database) and takes no
 * --apply. Returns `{ mode, ... }` with `apply` for the three writers.
 */
export function parseRebuildArgs(argv) {
  /** parse key -> its value (a switch is `true`). */
  const given = new Map();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const switched = SWITCH_FLAGS.get(flag);
    if (switched != null) {
      given.set(switched, true);
      continue;
    }
    const spec = VALUE_FLAGS.get(flag);
    if (spec == null) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!isWord(value)) {
      throw new Error(`${flag} needs ${spec.what}, got ${value}`);
    }
    if (given.has(spec.key)) throw new Error(`${flag} given twice`);
    given.set(spec.key, value);
  }

  const selected = Object.entries(MODES).filter(([, m]) => given.has(m.own));
  if (selected.length !== 1) {
    throw new Error(
      'give exactly one of --backup, --delete-gamma-fires, ' +
        '--null-gamma-returns or --restore',
    );
  }
  const [[mode, spec]] = selected;
  if (mode === 'backup' && given.has('apply')) {
    throw new Error(
      '--backup writes only its file (it never touches the database), ' +
        'so it takes no --apply',
    );
  }
  const allowed = new Set([spec.own, ...spec.needs, ...spec.takes]);
  for (const key of given.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`${FLAG_OF.get(key)} does not go with ${spec.flag}`);
    }
  }
  for (const key of spec.needs) {
    if (!given.has(key)) {
      throw new Error(`${spec.flag} needs ${FLAG_OF.get(key)}`);
    }
  }

  const apply = given.has('apply');
  const backupFile = given.get('backupFile');
  switch (mode) {
    case 'backup': {
      const table = given.get('backup');
      assertAllowedTable(table);
      return { mode, table, dates: parseDatesSpec(given.get('dates')) };
    }
    case 'delete-gamma-fires': {
      const [from, to] = [given.get('from'), given.get('to')];
      datesBetween(from, to);
      return { mode, from, to, backupFile, apply };
    }
    case 'null-gamma-returns': {
      const date = given.get('date');
      assertIsoDate(date, '--date');
      return { mode, date, backupFile, apply };
    }
    default: {
      const table = given.get('restore');
      assertAllowedTable(table);
      return { mode, table, backupFile, apply };
    }
  }
}

const rowsOf = (n) => count(n, 'row');
const firesOf = (n) => count(n, 'fire');

/**
 * Run a parsed plan against `sql`. Returns `{ lines, exitCode }`: 0 for a
 * done or dry-run result, 1 for a RebuildRefusal (the line says REFUSED and
 * why). A database failure is not caught: it propagates, the transaction
 * already rolled back, for the CLI to report. `backupDir` is the folder
 * `backup` mode writes under (`<backupDir>/rebuild/`).
 */
export async function runRebuildBackup(sql, plan, { backupDir } = {}) {
  if (
    plan.mode === 'backup' &&
    (typeof backupDir !== 'string' || backupDir === '')
  ) {
    throw new Error('runRebuildBackup: backup mode needs a backup directory');
  }
  // Dry run unless the plan says apply: a plan with no `apply` writes nothing.
  const apply = plan.apply === true;
  try {
    return {
      lines: await execute(sql, plan, { backupDir, apply }),
      exitCode: EXIT_OK,
    };
  } catch (err) {
    if (err instanceof RebuildRefusal) {
      return { lines: [`REFUSED: ${err.message}`], exitCode: EXIT_FAILED };
    }
    throw err;
  }
}

const DRY_NOTE = (verb) =>
  `DRY RUN: nothing written. Re-run with --apply to ${verb}.`;

async function execute(sql, plan, { backupDir, apply }) {
  const dry = !apply;
  switch (plan.mode) {
    case 'backup': {
      const { table, dates } = plan;
      const { rows, path, manifestPath } = await backupRows(sql, {
        table,
        dates,
        backupDir,
      });
      return [
        `Backed up ${rowsOf(rows)} of ${table} (${dates[0]} .. ${dates.at(-1)}) to ${path}`,
        `  manifest: ${manifestPath}`,
        ...(rows === 0
          ? [
              '  (nothing in scope: the file records the empty scope, so a ' +
                'restore removes what the rebuild adds there)',
            ]
          : []),
      ];
    }
    case 'delete-gamma-fires': {
      const { from, to, backupFile } = plan;
      const head = `${GAMMA_TABLE}: delete the fires on ${from} .. ${to}`;
      const result = await deleteGammaFires(sql, {
        from,
        to,
        backupPath: backupFile,
        apply,
      });
      return dry
        ? [
            `${head} (DRY RUN)`,
            `  backup: ${backupFile}`,
            `  would delete ${firesOf(result.wouldDelete)}`,
            DRY_NOTE('delete'),
          ]
        : [
            head,
            `  backup: ${backupFile}`,
            `Deleted ${firesOf(result.deleted)}.`,
          ];
    }
    case 'null-gamma-returns': {
      const { date, backupFile } = plan;
      const head = `${GAMMA_TABLE}: NULL ret_15m, ret_30m, ret_60m and ret_eod on ${date}`;
      const result = await nullGammaReturns(sql, {
        date,
        backupPath: backupFile,
        apply,
      });
      return dry
        ? [
            `${head} (DRY RUN)`,
            `  backup: ${backupFile}`,
            `  would null the returns of ${firesOf(result.wouldUpdate)}`,
            DRY_NOTE('update'),
          ]
        : [
            head,
            `  backup: ${backupFile}`,
            `Nulled the returns of ${firesOf(result.updated)}.`,
          ];
    }
    default: {
      const { table, backupFile } = plan;
      const head = `${table}: restore from the backup`;
      const result = await restoreRows(sql, {
        table,
        backupPath: backupFile,
        apply,
      });
      return dry
        ? [
            `${head} (DRY RUN)`,
            `  backup: ${backupFile}`,
            `  would delete ${rowsOf(result.wouldDelete)} in scope ` +
              `(${result.notInBackup} not in the backup) and re-insert ` +
              rowsOf(result.wouldRestore),
            DRY_NOTE('restore'),
          ]
        : [
            head,
            `  backup: ${backupFile}`,
            `Restored ${rowsOf(result.restored)} of ${table} ` +
              `(${rowsOf(result.deleted)} removed first).`,
          ];
    }
  }
}
