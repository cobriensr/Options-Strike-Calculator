/**
 * The logic of `--lottery-spots` in scripts/repair-index-candle-placeholders.mjs:
 * correct the stale `spot_at_event` and `strike_dist` of the Periscope lottery
 * fires on the gap days, from the repaired SPX one-minute candles. Spec:
 * docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md (Decision
 * 2 "keep them and report the count", Phase 4).
 *
 * Why the fires are wrong. On the gap days (09-22 -> 09-30 and 10-08 -> 10-15)
 * index_candles_1m had no SPX bars, and the finder's spot lookup had no date
 * bound (periscope-lottery-finder.ts fetchCandidates), so every fire read the
 * last bar of an earlier day: the 09-21 12:18 close, or the 10-07 close. On
 * 09-21 the bars stop at 12:18 ET (16:18Z), so that day's later fires read the
 * 12:18 close.
 *
 * The rules, from the finder (applyCallFilter, applyPutFilter):
 *   new_spot  the close of the latest SPX bar at or before fire_time on the
 *             fire's own ET session date (index_candles_1m.date), any
 *             market_time; none: the fire is left alone and listed (no_bar),
 *             because spot_at_event is NOT NULL
 *   new_dist  call: event_strike - spot, put: spot - event_strike. Never
 *             trade_strike, which is event_strike +- 50
 *   passes    a call needs event_strike > spot and dist >= 15, a put
 *             event_strike < spot and dist >= 10 (PERISCOPE_LOTTERY_THRESHOLDS)
 * Nothing is deleted (owner decision 2): a fire that no longer passes keeps
 * its row with the corrected spot and is counted. Only spot_at_event and
 * strike_dist are written; outcomes, trade_strike and entry_px are not.
 *
 * Plan, then apply:
 *   planLotterySpots   one SELECT, no writes
 *   applyLotterySpots  re-read the stored values of the fires to change, write
 *                      them to a JSONL backup (flag wx, read back), write the
 *                      manifest `committed: false`, then in one sql.transaction
 *                      run unnest UPDATEs of at most WRITE_BATCH (500) fires,
 *                      then rewrite the manifest `committed: true`
 *   undoLotterySpots   one transaction: put the backed-up values back
 * SQL is tagged templates only: sql.transaction takes lazy statements, and
 * only a tagged template is lazy on both neon and the pglite test client.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PERISCOPE_LOTTERY_THRESHOLDS } from '../../api/_lib/periscope-lottery-types.ts';
import {
  WRITE_BATCH,
  chunk,
  marketHoursRefusal,
  retryTransientDb,
} from './backfill-cli.mjs';
import { REPAIR_LISTS, stampOf } from './index-candle-repair.mjs';

// ── The scope ──────────────────────────────────────────────

/** 09-21's bars stop at 12:18 ET, so only its later fires read a stale spot. */
const PARTIAL_DATE = '2026-09-21';
const PARTIAL_AFTER = '2026-09-21T16:18:00Z';

/**
 * The fires to correct: those whose ET date is one of `dates` (the gap list
 * without 09-21, which the CLI's `gap` list also repairs), plus 09-21's fires
 * strictly after 16:18Z (a fire at 16:18:00 still reads that minute's real bar).
 */
export const LOTTERY_SPOT_SCOPE = Object.freeze({
  dates: Object.freeze(REPAIR_LISTS.gap.filter((d) => d !== PARTIAL_DATE)),
  partial: Object.freeze({ date: PARTIAL_DATE, after: PARTIAL_AFTER }),
});

const { CALL, PUT } = PERISCOPE_LOTTERY_THRESHOLDS;

/**
 * Whether the finder would still keep a fire: a call needs `strike > spot`
 * and a distance of at least 15, a put `strike < spot` and at least 10. `dist`
 * is the signed distance on the fire's own side (strike - spot for a call,
 * spot - strike for a put), so a distance at or past the minimum already means
 * the strike is on the right side of the spot: the finder's separate side
 * check (applyCallFilter, applyPutFilter) can never fail once this holds. The
 * table's CHECK allows only the two types.
 */
function stillPasses(fireType, dist) {
  const { STRIKE_DIST_MIN_PTS: minDist } =
    fireType === 'call_lottery' ? CALL : PUT;
  return dist >= minDist;
}

// ── Planning ───────────────────────────────────────────────

/**
 * The scope's fires with the spot the repaired candles give each, read in one
 * statement (one snapshot), writing nothing:
 *   `fires`   { id, fire_time, fire_type, event_strike, old_spot, new_spot,
 *             old_dist, new_dist, still_passes } for every fire that has a
 *             same-session bar, oldest first (`id` is text, `fire_time` an ISO
 *             string, the spots and distances numbers of at most 4 decimals)
 *   `no_bar`  { id, fire_time } for each fire that has none
 * The new spot is rounded to the column's 4 decimals in SQL and the distance
 * is exact numeric arithmetic on that, so what is planned is what is stored.
 * The fire's ET date is taken with AT TIME ZONE on the timestamptz, which does
 * not depend on the session time zone.
 */
export async function planLotterySpots(sql) {
  const { dates, partial } = LOTTERY_SPOT_SCOPE;
  const rows = await retryTransientDb(
    () => sql`
      SELECT f.id::text AS id,
             f.fire_time AS fire_time,
             f.fire_type AS fire_type,
             f.event_strike AS event_strike,
             f.spot_at_event::text AS old_spot,
             f.strike_dist::text AS old_dist,
             round(bar.close, 4)::text AS new_spot,
             (CASE f.fire_type
                WHEN 'call_lottery' THEN f.event_strike - round(bar.close, 4)
                ELSE round(bar.close, 4) - f.event_strike
              END)::text AS new_dist
      FROM periscope_lottery_fires f
      LEFT JOIN LATERAL (
        SELECT c.close
        FROM index_candles_1m c
        WHERE c.symbol = 'SPX'
          AND c.date = (f.fire_time AT TIME ZONE 'America/New_York')::date
          AND c.timestamp <= f.fire_time
        ORDER BY c.timestamp DESC
        LIMIT 1
      ) bar ON TRUE
      WHERE (f.fire_time AT TIME ZONE 'America/New_York')::date
              = ANY(${dates}::date[])
         OR ((f.fire_time AT TIME ZONE 'America/New_York')::date
               = ${partial.date}::date
             AND f.fire_time > ${partial.after}::timestamptz)
      ORDER BY f.fire_time, f.id`,
  );

  const fires = [];
  const noBar = [];
  for (const row of rows) {
    const fireTime = new Date(row.fire_time).toISOString();
    if (row.new_spot == null) {
      noBar.push({ id: row.id, fire_time: fireTime });
      continue;
    }
    const eventStrike = Number(row.event_strike);
    const spot = Number(row.new_spot);
    const dist = Number(row.new_dist);
    fires.push({
      id: row.id,
      fire_time: fireTime,
      fire_type: row.fire_type,
      event_strike: eventStrike,
      old_spot: Number(row.old_spot),
      new_spot: spot,
      old_dist: Number(row.old_dist),
      new_dist: dist,
      still_passes: stillPasses(row.fire_type, dist),
    });
  }
  return { fires, no_bar: noBar };
}

/** A fire whose stored spot or distance differs from the planned one. */
function isChanged(fire) {
  return fire.old_spot !== fire.new_spot || fire.old_dist !== fire.new_dist;
}

/**
 * What a plan says: `in_scope` fires (with or without a bar), how many
 * `updated` (those that change; an apply of a repaired table finds 0),
 * `no_longer_pass` (of those with a bar, whether or not they change: it is a
 * fact of the fire, so a second run reports the same number) and the
 * `no_bar` fires.
 */
function countPlan(plan) {
  return {
    in_scope: plan.fires.length + plan.no_bar.length,
    updated: plan.fires.filter(isChanged).length,
    no_longer_pass: plan.fires.filter((f) => !f.still_passes).length,
    no_bar: plan.no_bar,
  };
}

// ── Statements ─────────────────────────────────────────────

/** The stored spot and distance of `ids`, as text: what an UPDATE overwrites. */
function readStored(sql, ids) {
  return retryTransientDb(
    () => sql`
      SELECT id::text AS id, spot_at_event::text AS spot_at_event,
             strike_dist::text AS strike_dist
      FROM periscope_lottery_fires
      WHERE id = ANY(${ids}::bigint[])`,
  );
}

/** One unnest UPDATE of up to WRITE_BATCH fires: `rows` are { id, spot, dist }. */
function updateStatement(sql, rows) {
  return sql`
    UPDATE periscope_lottery_fires AS f
    SET spot_at_event = t.spot_at_event, strike_dist = t.strike_dist
    FROM unnest(
      ${rows.map((r) => r.id)}::bigint[],
      ${rows.map((r) => r.spot)}::numeric[],
      ${rows.map((r) => r.dist)}::numeric[]
    ) AS t(id, spot_at_event, strike_dist)
    WHERE f.id = t.id
    RETURNING f.id`;
}

function updatedCount(results) {
  return results.reduce((n, result) => n + result.length, 0);
}

// ── Backup files ───────────────────────────────────────────

const MANIFEST_VERSION = 1;
const LOTTERY_KIND = 'lottery-spots';
const CANDLE_KIND = 'index-candles';

const BACKUP_COLUMNS = ['id', 'spot_at_event', 'strike_dist'];

function backupRowOf(row) {
  return Object.fromEntries(BACKUP_COLUMNS.map((c) => [c, row[c]]));
}

function isBackupRow(row) {
  return (
    row !== null &&
    typeof row === 'object' &&
    BACKUP_COLUMNS.every((c) => typeof row[c] === 'string')
  );
}

/** A backup's JSONL text as rows; throws on a line that is not a backup row. */
function parseBackupText(text, file) {
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
    if (!isBackupRow(row)) {
      throw new Error(`backup ${file} line ${i + 1} is malformed`);
    }
    rows.push(backupRowOf(row));
  }
  return rows;
}

/**
 * Write `rows` as JSONL to `file` ('wx': an existing file is an error, never
 * overwritten), then read it back. A backup that cannot be read back is no
 * backup, so the run stops before anything is updated.
 */
async function writeBackup(backupDir, file, rows) {
  await mkdir(backupDir, { recursive: true });
  const text = rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  const back = parseBackupText(await readFile(file, 'utf8'), file);
  if (JSON.stringify(back) !== JSON.stringify(rows)) {
    throw new Error(`backup ${file} does not read back as written`);
  }
}

function isIdList(value) {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && /^\d+$/.test(id))
  );
}

/** Read a manifest's text; throws on anything that is not a lottery-spots one. */
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
    doc.kind === LOTTERY_KIND &&
    typeof doc.backup === 'string' &&
    isIdList(doc.backedUpIds) &&
    typeof doc.committed === 'boolean' &&
    (doc.updated == null || Number.isInteger(doc.updated));
  if (!valid) {
    throw new Error(
      `${file} is not a lottery-spots repair manifest (version 1)`,
    );
  }
  return doc;
}

/**
 * Which repair a manifest belongs to, for the CLI's one `--undo` flag:
 * 'lottery-spots' when it says so in its `kind`, else 'index-candles' (the
 * candle repair's manifests carry no kind, and it reports an unreadable one
 * in its own words). A file that cannot be read throws.
 */
export async function manifestKind(manifestFile) {
  const text = await readFile(manifestFile, 'utf8');
  try {
    return JSON.parse(text)?.kind === LOTTERY_KIND ? LOTTERY_KIND : CANDLE_KIND;
  } catch {
    return CANDLE_KIND;
  }
}

// ── Apply ──────────────────────────────────────────────────

/**
 * Write the plan's changes: back up what is about to be overwritten, then one
 * transaction of unnest UPDATEs. A fire whose spot and distance already equal
 * the plan is not touched, so a second run writes nothing, no files either.
 * Returns the plan's counts (see countPlan) with `updated` the rows the
 * transaction changed, plus `manifest` (its path) when anything was written.
 *
 * The backup is read from the table now, not taken from the plan, and the
 * run refuses a plan whose fires have changed or vanished since it was read
 * (`stale plan`): the backup must hold exactly what the UPDATE overwrites.
 *
 * Failure ordering, so that nothing is lost:
 *   - the backup is written and read back before the manifest, and the
 *     manifest before the transaction: a failed write ends the run with the
 *     table untouched;
 *   - a failed transaction rolls back whole; the manifest then stays
 *     `committed: false`, and an undo of it restores the values the table
 *     already holds;
 *   - after the commit the manifest is rewritten `committed: true`; if that
 *     write fails the error says so, and the leftover manifest still undoes
 *     the run (an undo does not read `committed`).
 * The transaction is not retried: it is idempotent, but a retry after a lost
 * response would report 0 updated for a run that wrote.
 */
export async function applyLotterySpots(sql, plan, { backupDir }) {
  const counts = countPlan(plan);
  const changed = plan.fires.filter(isChanged);
  if (changed.length === 0) return counts;
  if (typeof backupDir !== 'string') throw new Error('no backup directory');

  const stored = new Map(
    (
      await readStored(
        sql,
        changed.map((f) => f.id),
      )
    ).map((r) => [r.id, r]),
  );
  const stale = changed.filter((f) => {
    const row = stored.get(f.id);
    return (
      row == null ||
      Number(row.spot_at_event) !== f.old_spot ||
      Number(row.strike_dist) !== f.old_dist
    );
  });
  if (stale.length > 0) {
    throw new Error(
      `stale plan: ${stale.length} ${stale.length === 1 ? 'fire' : 'fires'} ` +
        `changed or vanished since the plan was read (first id ` +
        `${stale[0].id}); run the dry run again`,
    );
  }

  const base = join(backupDir, `${LOTTERY_KIND}-${stampOf(new Date())}`);
  const backupFile = `${base}.jsonl`;
  const manifestFile = `${base}.manifest.json`;
  const backedUp = changed.map((f) => backupRowOf(stored.get(f.id)));
  await writeBackup(backupDir, backupFile, backedUp);
  const manifest = {
    version: MANIFEST_VERSION,
    kind: LOTTERY_KIND,
    backup: backupFile,
    backedUpIds: backedUp.map((r) => r.id),
    noLongerPass: counts.no_longer_pass,
    noBar: plan.no_bar.map((f) => f.id),
    updated: null,
    committed: false,
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  const statements = chunk(changed, WRITE_BATCH).map((part) =>
    updateStatement(
      sql,
      part.map((f) => ({ id: f.id, spot: f.new_spot, dist: f.new_dist })),
    ),
  );
  let results;
  try {
    results = await sql.transaction(statements);
  } catch (err) {
    throw new Error(
      `the transaction failed (${err.message}). Nothing changed unless the ` +
        `response was lost; ${manifestFile} is still committed: false, and ` +
        '--undo is safe either way',
      { cause: err },
    );
  }
  const updated = updatedCount(results);

  try {
    await writeFile(
      manifestFile,
      `${JSON.stringify({ ...manifest, updated, committed: true }, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    throw new Error(
      `committed (${updated} updated) but the manifest ${manifestFile} could ` +
        `not be rewritten (${err.message}); it still says committed: false, ` +
        'and --undo restores the backed-up values either way',
      { cause: err },
    );
  }
  return { ...counts, updated, manifest: manifestFile };
}

/**
 * What the CLI runs: the plan's counts on a dry run (nothing is written, no
 * backup either), or the apply. `backupDir` is only read when something changes.
 */
export async function repairLotterySpots(sql, { apply, backupDir }) {
  const plan = await planLotterySpots(sql);
  if (!apply) return countPlan(plan);
  return applyLotterySpots(sql, plan, { backupDir });
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
  );
  const matches =
    rows.length === manifest.backedUpIds.length &&
    rows.every((r, i) => r.id === manifest.backedUpIds[i]);
  if (!matches) {
    throw new Error(
      `backup ${manifest.backup} does not match its manifest ${manifestFile} ` +
        '(row count or ids)',
    );
  }
  return { manifest, rows };
}

/**
 * Undo a run, in one transaction: put the backed-up spot and distance back on
 * the fires the run changed. Idempotent (a second undo writes the same
 * values), and safe for a manifest still `committed: false`: after a rolled
 * back run the table already holds those values. Returns `{ restored }`, the
 * rows the transaction touched.
 */
export async function undoLotterySpots(sql, manifestFile) {
  const { rows } = await loadUndo(manifestFile);
  if (rows.length === 0) return { restored: 0 };
  const statements = chunk(rows, WRITE_BATCH).map((part) =>
    updateStatement(
      sql,
      part.map((r) => ({
        id: r.id,
        spot: r.spot_at_event,
        dist: r.strike_dist,
      })),
    ),
  );
  return { restored: updatedCount(await sql.transaction(statements)) };
}

/** The lines of what undoLotterySpots(manifest) would do, read from the files only. */
export async function describeUndoLotterySpots(manifestFile) {
  const { manifest, rows } = await loadUndo(manifestFile);
  return [
    `periscope_lottery_fires spot repair, ${rows.length} ` +
      `${rows.length === 1 ? 'fire' : 'fires'} backed up`,
    `  restore their spot_at_event and strike_dist from ${manifest.backup}`,
  ];
}

// ── The CLI's side ─────────────────────────────────────────

/**
 * The refusal to print when the run may not start now, or null: only the
 * weekday market-hours window (backfill-cli's), with no flag to lift it. No
 * Schwab call is made, so the Schwab crons' window does not apply.
 */
export function lotterySpotsGuardRefusal() {
  return marketHoursRefusal({ allowMarketHours: false, offerFlag: false });
}

/** The lines that report a repairLotterySpots result, each no_bar fire by id and fire_time. */
export function lotterySpotLines(result, { apply }) {
  const { in_scope: inScope, updated, no_longer_pass: noLongerPass } = result;
  const noBar = result.no_bar;
  return [
    `  in scope: ${inScope} ${inScope === 1 ? 'fire' : 'fires'}`,
    `  ${apply ? 'updated' : 'would update'}: ${updated}`,
    `  no longer pass their filter (kept, not deleted): ${noLongerPass}`,
    `  no same-day SPX bar (left unchanged): ${noBar.length}`,
    ...noBar.map((f) => `    id ${f.id}  ${f.fire_time}`),
    ...(result.manifest == null ? [] : [`  manifest: ${result.manifest}`]),
  ];
}
