/**
 * The pieces of scripts/repair-range-pos-splits.mjs: the repair table, the
 * per-row decision, the backup document and the undo plan, the report lines,
 * the SQL, and the two runs (repair and undo) that wire them together.
 *
 * Why this exists: the 10-29 backfill (scripts/backfill-range-pos.mjs)
 * compared UW's 1-min candles, which UW adjusts for later splits, with the
 * fire's stored spot_at_first, which isn't. computeRangePos clamps the gap
 * to 0 or 1, so 1,183 CRWD and SOXS fires were pinned. This script puts
 * them right: it rescales the stored spot onto the candles' scale and
 * recomputes, and blanks (NULL) a row it can't place. It reuses the
 * backfill's computeRangePos and split guard (range-pos-backfill.mjs) so the
 * two can't disagree about what a split looks like.
 *
 * Spec: docs/superpowers/specs/2026-11-19-range-pos-split-repair-and-badge-text.md
 * (Task 2).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { WRITE_BATCH } from './backfill-cli.mjs';
import {
  chunk,
  computeRangePos,
  fetchDayCandles,
  isSplitMismatch,
  preTriggerRange,
  retryTransientDb,
  runPool,
  summarizeFailures,
} from './range-pos-backfill.mjs';

// ── What to repair ─────────────────────────────────────────

/**
 * The two split tickers and the dates the 10-29 backfill pinned them on.
 * Both windows start 2026-05-18: before that the cron filled range_pos live,
 * from same-day unadjusted candles, and those values are right.
 * `spotScale` puts the stored spot on the scale of UW's adjusted candles.
 */
export const SPLIT_REPAIRS = Object.freeze([
  Object.freeze({
    ticker: 'CRWD',
    from: '2026-05-18',
    to: '2026-07-01',
    spotScale: 0.25,
    note:
      '4-for-1 split between 07-01 and 07-07: stored spot ÷ UW candle close at ' +
      'the trigger minute was 3.986 to 4.019 on 6 fires; 928 rows, all pinned at 1',
  }),
  Object.freeze({
    ticker: 'SOXS',
    from: '2026-05-18',
    to: '2026-07-10',
    spotScale: 10,
    note:
      '1-for-10 reverse split between 07-10 and 07-17: stored spot ÷ UW candle ' +
      'close at the trigger minute was 0.1000 to 0.1008 on 6 fires; 255 rows, all pinned at 0',
  }),
]);

/** UW's plan allows 3 requests in flight per key. */
const UW_CONCURRENCY = 3;

// ── Arguments ──────────────────────────────────────────────

/**
 * Parse the CLI flags. Throws with a message naming the bad one.
 *   --apply               write (the default is a dry run that writes nothing)
 *   --undo <backup.json>  restore the rows a backup lists; a dry run too
 *                         unless --apply comes with it
 *   --allow-market-hours  run the repair inside the 08:15-15:30 CT window
 */
export function parseRepairArgs(argv) {
  const args = { apply: false, undoPath: null, allowMarketHours: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      args.apply = true;
    } else if (flag === '--allow-market-hours') {
      args.allowMarketHours = true;
    } else if (flag === '--undo') {
      const path = argv[++i];
      if (path == null || path === '' || path.startsWith('--')) {
        throw new Error('--undo needs the path of a backup file');
      }
      args.undoPath = path;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

// ── The per-row decision ───────────────────────────────────

function isoOf(time) {
  return time instanceof Date ? time.toISOString() : time;
}

/**
 * Decide one stored row against its day's candles. `row.old` is the stored
 * value as text; `row.spot` a number or null. Four outcomes:
 *   - notArtifact: the raw spot passes the split guard (a NULL or non-finite
 *     spot, or a day with no candle before the trigger, does too). Untouched.
 *   - repaired: the raw spot fails and spot × spotScale passes; `next` is
 *     computeRangePos at the scaled spot.
 *   - blanked, `next: null`: the scaled spot passes but computeRangePos
 *     can't place it (a flat range), or raw and scaled both fail (a spot ≤ 0
 *     fails both).
 * `next` means nothing for notArtifact.
 */
export function planRow(row, candles, spotScale) {
  const spot = row.spot == null ? Number.NaN : Number(row.spot);
  const range = preTriggerRange(candles, row.trigger_time_ct);
  const base = {
    id: row.id,
    trigger: isoOf(row.trigger_time_ct),
    old: row.old,
    spot,
    scaledSpot: null,
    low: range?.low ?? null,
    high: range?.high ?? null,
    next: null,
  };
  if (!isSplitMismatch(candles, row.trigger_time_ct, spot)) {
    return { ...base, outcome: 'notArtifact' };
  }
  const scaledSpot = spot * spotScale;
  const scaled = { ...base, scaledSpot };
  if (isSplitMismatch(candles, row.trigger_time_ct, scaledSpot)) {
    return { ...scaled, outcome: 'blanked' };
  }
  const next = computeRangePos(candles, row.trigger_time_ct, scaledSpot);
  return next == null
    ? { ...scaled, outcome: 'blanked' }
    : { ...scaled, outcome: 'repaired', next };
}

/**
 * Plan one ticker-day from what fetchDayCandles returned. A UW error or an
 * empty day plans nothing and returns the failure: the day's rows stay as
 * they are and the caller counts them as failed.
 */
export function planTickerDay(rows, outcome, spotScale) {
  if (outcome.kind === 'ok') {
    return {
      plans: rows.map((row) => planRow(row, outcome.candles, spotScale)),
      failure: null,
    };
  }
  const failure =
    outcome.kind === 'empty'
      ? { status: 'empty', detail: 'UW returned no candles' }
      : { status: outcome.status, detail: outcome.detail };
  return { plans: [], failure };
}

/** Rows grouped by ticker and date, ordered by ticker then date. */
export function groupByDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const key = `${row.ticker} ${row.date}`;
    const day = byDay.get(key);
    if (day) day.rows.push(row);
    else byDay.set(key, { ticker: row.ticker, date: row.date, rows: [row] });
  }
  return [...byDay.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date),
  );
}

/** The rows an apply run writes: repaired and blanked, values as text. */
export function writableRows(plans) {
  return plans
    .filter((p) => p.outcome !== 'notArtifact')
    .map((p) => ({
      id: p.id,
      next: p.next == null ? null : String(p.next),
      old: p.old,
    }));
}

// ── Report ─────────────────────────────────────────────────

/** Min, median and max of the values, or null when there are none. */
export function valueSpread(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median, max: sorted.at(-1) };
}

function compareIds(a, b) {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Up to 2 rows per ticker for a hand check: the repaired rows with the
 * lowest and highest id (the blanked ones when nothing was repaired).
 */
export function pickSamples(plans) {
  const repaired = plans.filter((p) => p.outcome === 'repaired');
  const pool =
    repaired.length > 0
      ? repaired
      : plans.filter((p) => p.outcome === 'blanked');
  const sorted = [...pool].sort(compareIds);
  if (sorted.length <= 1) return sorted;
  return [sorted[0], sorted.at(-1)];
}

/**
 * One ticker's totals. Every selected row is exactly one of repaired,
 * blanked, notArtifact or failed (its day failed), and a tally that doesn't
 * add up throws rather than print a wrong report.
 */
export function summarizeTicker({
  ticker,
  rowCount,
  plans,
  failed,
  written,
  changedSinceRead,
}) {
  const count = (outcome) => plans.filter((p) => p.outcome === outcome).length;
  const repaired = count('repaired');
  const blanked = count('blanked');
  const notArtifact = count('notArtifact');
  const accounted = repaired + blanked + notArtifact + failed;
  if (accounted !== rowCount) {
    throw new Error(
      `${ticker}: ${rowCount} rows but ${accounted} accounted for`,
    );
  }
  return {
    ticker,
    rows: rowCount,
    repaired,
    blanked,
    notArtifact,
    failed,
    written,
    changedSinceRead,
    newValues: valueSpread(
      plans.filter((p) => p.outcome === 'repaired').map((p) => p.next),
    ),
    samples: pickSamples(plans),
  };
}

/** A number to at most 6 decimals, without float noise (40.70100000000001). */
function fmt(value) {
  return value == null ? 'n/a' : String(Number(value.toFixed(6)));
}

function formatSample(p) {
  return (
    `    id ${p.id} · trigger ${p.trigger} · spot ${fmt(p.spot)} · ` +
    `scaled ${fmt(p.scaledSpot)} · range ${fmt(p.low)} to ${fmt(p.high)} · ` +
    `old ${p.old} · new ${p.next == null ? 'NULL' : fmt(p.next)}`
  );
}

/** The report block for one ticker. */
export function formatTickerReport(summary, repair, { apply }) {
  const s = summary;
  const verb = apply ? 'written' : 'would write';
  const lines = [
    `${s.ticker}  ${repair.from} to ${repair.to} · spot × ${repair.spotScale}`,
    `  ${repair.note}`,
    `  rows ${s.rows} · repaired ${s.repaired} · blanked ${s.blanked} · ` +
      `notArtifact ${s.notArtifact} · failed ${s.failed}`,
    `  ${verb} ${s.written} · changed since read ${s.changedSinceRead}`,
  ];
  if (s.newValues == null) {
    lines.push('  new values: none');
  } else {
    const { min, median, max } = s.newValues;
    lines.push(
      `  new values (n=${s.repaired}): min ${fmt(min)} · median ${fmt(median)} · max ${fmt(max)}`,
    );
  }
  if (s.samples.length > 0) {
    lines.push('  samples for the hand check:');
    for (const p of s.samples) lines.push(formatSample(p));
  }
  return lines;
}

/** One line per ticker-day, printed the same on a dry run and an apply. */
export function formatDayLine(day) {
  const count = (outcome) =>
    day.plans.filter((p) => p.outcome === outcome).length;
  const failed = day.failure == null ? 0 : day.rows.length;
  const why = day.failure == null ? '' : ` (UW ${day.failure.status})`;
  return (
    `${day.ticker} ${day.date}  rows ${day.rows.length} · ` +
    `repaired ${count('repaired')} · blanked ${count('blanked')} · ` +
    `notArtifact ${count('notArtifact')} · failed ${failed}${why}`
  );
}

// ── Backup and undo ────────────────────────────────────────

export const BACKUP_VERSION = 1;
/** Relative to the repo root the script runs from; docs/tmp/ is gitignored. */
export const BACKUP_DIR = 'docs/tmp/range-pos-split-repair';

/** backup-<UTC stamp>.json, with no colons so Windows takes it. */
export function backupFileName(now) {
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `backup-${stamp}.json`;
}

export function backupPath(now) {
  return `${BACKUP_DIR}/${backupFileName(now)}`;
}

/**
 * The backup of every selected row before any write: the values this run
 * read, so --undo can put them back. `rows` come from selectRepairRows.
 */
export function buildBackup({ rows, createdAt }) {
  return {
    version: BACKUP_VERSION,
    createdAt: createdAt.toISOString(),
    repairs: SPLIT_REPAIRS.map(({ ticker, from, to, spotScale }) => ({
      ticker,
      from,
      to,
      spotScale,
    })),
    rows: rows.map((row) => ({
      id: row.id,
      ticker: row.ticker,
      date: row.date,
      trigger_time_ct: isoOf(row.trigger_time_ct),
      spot: row.spot,
      old: row.old,
    })),
  };
}

const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;

/** Read a backup's text back into a document; throws on anything else. */
export function parseBackup(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`backup is not valid JSON: ${err.message}`, {
      cause: err,
    });
  }
  if (doc?.version !== BACKUP_VERSION || !Array.isArray(doc.rows)) {
    throw new Error('not a range_pos split-repair backup (version 1)');
  }
  for (const [i, row] of doc.rows.entries()) {
    const validOld =
      row?.old === null ||
      (typeof row?.old === 'string' && NUMERIC_TEXT.test(row.old));
    if (
      typeof row?.id !== 'string' ||
      !/^\d+$/.test(row.id) ||
      typeof row.ticker !== 'string' ||
      !validOld
    ) {
      throw new Error(`backup row ${i} is malformed`);
    }
  }
  return doc;
}

/**
 * Check the text read back from disk against the document that was written.
 * A backup that can't be read back is no backup, so the run stops.
 */
export function verifyBackupText(doc, text) {
  const back = parseBackup(text);
  if (JSON.stringify(back.rows) !== JSON.stringify(doc.rows)) {
    throw new Error('backup read-back does not match what was written');
  }
}

/**
 * The rows --undo restores: those in the backup whose ticker is in
 * SPLIT_REPAIRS. The rest are rejected, never written.
 */
export function undoPlan(doc) {
  const known = new Set(SPLIT_REPAIRS.map((r) => r.ticker));
  const restore = [];
  const rejected = [];
  for (const row of doc.rows) {
    if (known.has(row.ticker)) {
      restore.push({ id: row.id, ticker: row.ticker, old: row.old });
    } else {
      rejected.push({ id: row.id, ticker: row.ticker });
    }
  }
  return { restore, rejected };
}

// ── SQL ────────────────────────────────────────────────────

/**
 * Every row the repair may touch for one ticker: inside the window (both
 * ends included) and holding a value. `old` is read as text, so what the
 * backup keeps and the write guard compares is the stored value exactly.
 */
const SELECT_ROWS_SQL = `
  SELECT id::text AS id,
         to_char(date, 'YYYY-MM-DD') AS date,
         trigger_time_ct,
         spot_at_first::float8 AS spot,
         range_pos_at_trigger::text AS old
  FROM lottery_finder_fires
  WHERE underlying_symbol = $1
    AND date BETWEEN $2::date AND $3::date
    AND range_pos_at_trigger IS NOT NULL
  ORDER BY id`;

/**
 * One UPDATE for up to WRITE_BATCH rows (R5), a conditional write (R6): a
 * row is written only while it still holds the value this run read, so a row
 * another writer changed since is skipped and counted. Values go over as
 * text into numeric[], as the backfill does; a NULL element is a blank.
 * @neondatabase/serverless 1.1.0 renders a JS array as a Postgres array
 * literal with null as an unquoted NULL and everything else as quoted text
 * (probed 2026-11-19 with a stubbed fetch), so a blank reaches Postgres as SQL
 * NULL. IS NOT DISTINCT FROM, because `=` never matches NULL.
 */
const APPLY_SQL = `
  WITH written AS (
    UPDATE lottery_finder_fires AS f
    SET range_pos_at_trigger = v.new_pos
    FROM unnest($1::bigint[], $2::numeric[], $3::numeric[])
      AS v(id, new_pos, old_pos)
    WHERE f.id = v.id
      AND f.range_pos_at_trigger IS NOT DISTINCT FROM v.old_pos
    RETURNING 1
  )
  SELECT COUNT(*)::int AS n FROM written`;

/**
 * Put the backed-up values back. Conditional on the row differing from its
 * backed-up value, so a row already restored is skipped and a second undo
 * writes nothing. The row's own underlying_symbol must be one of
 * SPLIT_REPAIRS' tickers ($3), not just the label the backup file carries
 * (undoPlan checks that), so a hand-edited file can't restore another
 * ticker's row.
 */
const RESTORE_SQL = `
  WITH restored AS (
    UPDATE lottery_finder_fires AS f
    SET range_pos_at_trigger = v.old_pos
    FROM unnest($1::bigint[], $2::numeric[]) AS v(id, old_pos)
    WHERE f.id = v.id
      AND f.underlying_symbol = ANY($3::text[])
      AND f.range_pos_at_trigger IS DISTINCT FROM v.old_pos
    RETURNING 1
  )
  SELECT COUNT(*)::int AS n FROM restored`;

/** The rows of one repair, as the backup and the planner take them. */
export async function selectRepairRows(sql, repair) {
  const rows = await retryTransientDb(() =>
    sql.query(SELECT_ROWS_SQL, [repair.ticker, repair.from, repair.to]),
  );
  return rows.map((r) => ({
    id: r.id,
    ticker: repair.ticker,
    date: r.date,
    trigger_time_ct: new Date(r.trigger_time_ct).toISOString(),
    spot: r.spot == null ? null : Number(r.spot),
    old: r.old,
  }));
}

/**
 * Run `writeBatch` over the rows in WRITE_BATCH chunks, one at a time,
 * yielding `{ size, written }` after each. A caller that tallies as it goes
 * still knows what landed when a later batch throws.
 *
 * The write goes through retryTransientDb, so an UPDATE that committed
 * before its response was lost is retried and finds its rows already
 * changed: the count reads low and the data is right.
 */
async function* inBatches(rows, writeBatch) {
  for (const batch of chunk(rows, WRITE_BATCH)) {
    const [{ n }] = await retryTransientDb(() => writeBatch(batch));
    yield { size: batch.length, written: n };
  }
}

/** `rows` are `{ id, next, old }` from writableRows. */
export function applyInBatches(sql, rows) {
  return inBatches(rows, (batch) =>
    sql.query(APPLY_SQL, [
      batch.map((r) => r.id),
      batch.map((r) => r.next),
      batch.map((r) => r.old),
    ]),
  );
}

/** `rows` are `{ id, old }` from undoPlan. */
export function restoreInBatches(sql, rows) {
  const tickers = SPLIT_REPAIRS.map((r) => r.ticker);
  return inBatches(rows, (batch) =>
    sql.query(RESTORE_SQL, [
      batch.map((r) => r.id),
      batch.map((r) => r.old),
      tickers,
    ]),
  );
}

// ── The runs ───────────────────────────────────────────────

async function writeBackup(rows, say) {
  const createdAt = new Date();
  const file = backupPath(createdAt);
  const doc = buildBackup({ rows, createdAt });
  await mkdir(dirname(file), { recursive: true });
  // 'wx': a file already at this path is an error, never overwritten. The
  // name has one-second resolution, so a second run in the same second, or a
  // stale file, must not replace an earlier run's record of the values.
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  verifyBackupText(doc, await readFile(file, 'utf8'));
  say(`backup: ${file} (${doc.rows.length} rows, read back OK)`);
  return file;
}

function sayFailures(failures, say) {
  say();
  say(`UW failures by status (${failures.length} ticker-days):`);
  for (const f of summarizeFailures(failures)) {
    const e = f.example;
    say(
      `  ${f.status.padEnd(10)} ${String(f.count).padStart(5)}  e.g. ${e.ticker} ${e.date}: ${e.detail}`,
    );
  }
  if (failures.length > 0) {
    say(
      '  those days were left untouched; re-run to repair them (rows already ' +
        'repaired come out the same)',
    );
  }
}

/**
 * The repair: read the rows, fetch each ticker-day's candles (3 at a time),
 * plan every row, and with `apply` write the backup, read it back, then
 * write in guarded batches. Without `apply` it does everything but the
 * backup and the writes. Prints through `say`. Throws on a DB error or a
 * backup that can't be written or read back, before any write in that case.
 * Returns `{ exitCode, summaries, failures, backupFile }`; the exit code is 1
 * when a UW day failed.
 */
export async function runRepair({ sql, apiKey, apply, say }) {
  say(`range_pos split repair${apply ? '' : ' (DRY RUN: no writes)'}`);
  const selected = [];
  const counts = [];
  for (const repair of SPLIT_REPAIRS) {
    const rows = await selectRepairRows(sql, repair);
    counts.push(`${repair.ticker} ${rows.length}`);
    selected.push(...rows);
  }
  say(`${selected.length} rows selected (${counts.join(', ')})`);

  const scaleOf = new Map(SPLIT_REPAIRS.map((r) => [r.ticker, r.spotScale]));
  const days = groupByDay(selected);
  await runPool(days, UW_CONCURRENCY, async (day) => {
    const outcome = await fetchDayCandles(apiKey, day.ticker, day.date);
    Object.assign(
      day,
      planTickerDay(day.rows, outcome, scaleOf.get(day.ticker)),
    );
  });
  say();
  for (const day of days) say(formatDayLine(day));

  const backupFile = apply ? await writeBackup(selected, say) : null;

  const failures = [];
  const summaries = [];
  let writtenSoFar = 0;
  for (const repair of SPLIT_REPAIRS) {
    const tickerDays = days.filter((d) => d.ticker === repair.ticker);
    const plans = tickerDays.flatMap((d) => d.plans);
    const failedDays = tickerDays.filter((d) => d.failure != null);
    for (const d of failedDays) {
      failures.push({ ticker: d.ticker, date: d.date, ...d.failure });
    }
    const toWrite = writableRows(plans);
    let written = 0;
    let changedSinceRead = 0;
    if (apply) {
      try {
        for await (const r of applyInBatches(sql, toWrite)) {
          written += r.written;
          changedSinceRead += r.size - r.written;
          writtenSoFar += r.written;
        }
      } catch (err) {
        say(
          `write failed on ${repair.ticker} after ${writtenSoFar} rows written. ` +
            `The values before this run are in ${backupFile}: undo from that ` +
            'file, not from the backup a re-run writes (which holds the ' +
            'partly repaired values). A re-run is safe.',
        );
        throw err;
      }
    } else {
      written = toWrite.length;
    }
    summaries.push(
      summarizeTicker({
        ticker: repair.ticker,
        rowCount: selected.filter((r) => r.ticker === repair.ticker).length,
        plans,
        failed: failedDays.reduce((n, d) => n + d.rows.length, 0),
        written,
        changedSinceRead,
      }),
    );
  }

  say();
  say(`── range_pos split repair report (${apply ? 'APPLIED' : 'DRY RUN'}) ──`);
  for (const [i, summary] of summaries.entries()) {
    for (const line of formatTickerReport(summary, SPLIT_REPAIRS[i], {
      apply,
    })) {
      say(line);
    }
  }
  if (apply) {
    say(
      '  (changed since read: rows another writer changed first, or rows of ' +
        'an UPDATE that committed before its response was lost and was ' +
        'retried; the data is correct)',
    );
  }
  sayFailures(failures, say);
  if (!apply) {
    say();
    say(
      'DRY RUN: nothing written. Re-run with --apply to write; the backup ' +
        'is written first.',
    );
  }
  return {
    exitCode: failures.length > 0 ? 1 : 0,
    summaries,
    failures,
    backupFile,
  };
}

/**
 * The undo: read a backup and, with `apply`, put its rows back (only those
 * whose ticker is in SPLIT_REPAIRS). Without `apply` it reports the plan and
 * writes nothing. Throws on an unreadable backup or a DB error.
 * Returns `{ exitCode, restored, rejected }`.
 */
export async function runUndo({ sql, backupPath: file, apply, say }) {
  const doc = parseBackup(await readFile(file, 'utf8'));
  const { restore, rejected } = undoPlan(doc);
  say(
    `range_pos split repair UNDO${apply ? '' : ' (DRY RUN: no writes)'} from ${file}`,
  );
  say(
    `backup made ${doc.createdAt ?? 'at an unknown time'}: ` +
      `${doc.rows.length} rows listed, ${restore.length} to restore`,
  );
  if (rejected.length > 0) {
    say(
      `rejected ${rejected.length} row(s) of tickers outside SPLIT_REPAIRS ` +
        `(not written): ids ${rejected.map((r) => r.id).join(', ')}`,
    );
  }
  let restored = 0;
  if (apply) {
    try {
      for await (const r of restoreInBatches(sql, restore))
        restored += r.written;
    } catch (err) {
      say(`undo failed after ${restored} rows restored; re-run to finish`);
      throw err;
    }
    say(
      `restored ${restored} of ${restore.length} rows (the rest were already ` +
        'at their backed-up value)',
    );
  } else {
    say('DRY RUN: nothing written. Re-run with --apply to restore.');
  }
  return { exitCode: 0, restored, rejected: rejected.length };
}
