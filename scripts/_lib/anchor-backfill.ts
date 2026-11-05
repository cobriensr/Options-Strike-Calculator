/**
 * Step 2 of the anchor-column history backfill (extract step:
 * ml/src/anchor_backfill_extract.py). Reads the NDJSON the extract wrote,
 * runs the production `describeAnchor` on each anchor, and writes the five
 * columns onto lottery_finder_fires / silent_boom_alerts. It lives here, not
 * in the entry script, so vitest covers it (scripts/_lib/**).
 *
 * Writes are batched `unnest` UPDATEs (500 rows) and conditional, so a rerun
 * never overwrites a live-written or already-backfilled row (R6). `--compare`
 * checks the tape-derived values against a reference captured from the
 * production lookup and makes no DB call. Spec:
 * docs/superpowers/specs/2026-10-28-classifier-replacement-design.md
 * ("History backfill from the full tape").
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  describeAnchor,
  type AnchorLegs,
  type TapePrint,
} from '../../api/_lib/anchor-legs.js';
import { getDb, withDbRetry } from '../../api/_lib/db.js';

/** Rows per UPDATE statement (R5: batch around 500 rows). */
export const WRITE_CHUNK = 500;

/** Parity gate (spec): agreement floors and the one-sided ceiling, percent. */
export const GATE_MIN_ANCHOR_ID_PCT = 99.5;
export const GATE_MIN_LEG_KIND_PCT = 99.5;
export const GATE_MAX_ONE_SIDED_PCT = 0.5;

/** How many mismatches `--compare` writes out. */
export const MISMATCH_SAMPLE = 50;

// ── Parse ───────────────────────────────────────────────────────────────────

export const TABLES = ['lottery_finder_fires', 'silent_boom_alerts'] as const;
export type BackfillTable = (typeof TABLES)[number];

const tapePrintSchema = z.object({
  wsTradeId: z.string().min(1),
  optionChain: z.string().min(1),
  optionType: z.enum(['C', 'P']),
  strike: z.number(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  executedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:]{8}\.\d{3}Z$/),
  price: z.number(),
  size: z.number(),
  tradeCode: z.string().nullable(),
});

const lineSchema = z.object({
  table: z.enum(TABLES),
  id: z.number().int().positive(),
  anchor: tapePrintSchema.nullable(),
  siblings: z.array(tapePrintSchema),
});

export interface ExtractLine {
  table: BackfillTable;
  id: number;
  anchor: TapePrint | null;
  siblings: TapePrint[];
}

/** Validate every NDJSON line; a bad one throws with `file:line`. */
export function parseNdjson(text: string, file: string): ExtractLine[] {
  const lines: ExtractLine[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const where = `${file}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const parsed = lineSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${where}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`,
      );
    }
    lines.push(parsed.data);
  });
  return lines;
}

// ── Describe and map to columns ─────────────────────────────────────────────

/** The five columns, exactly as detect-lottery-fires.ts / detect-silent-boom.ts write them. */
export interface AnchorColumns {
  anchor_ws_trade_id: string | null;
  anchor_trade_code: string | null;
  anchor_leg_kind: string | null;
  spread_shape: string | null;
  /** JSON.stringify(spreadLegs): camelCase SpreadLeg objects, for ::jsonb. */
  spread_legs: string | null;
}

export function describeLine(line: ExtractLine): AnchorLegs | null {
  return line.anchor == null
    ? null
    : describeAnchor(line.anchor, line.siblings);
}

export function toColumns(anchor: AnchorLegs): AnchorColumns {
  return {
    anchor_ws_trade_id: anchor.anchorWsTradeId,
    anchor_trade_code: anchor.anchorTradeCode,
    anchor_leg_kind: anchor.legKind,
    spread_shape: anchor.spreadShape,
    spread_legs:
      anchor.spreadLegs == null ? null : JSON.stringify(anchor.spreadLegs),
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

export interface TableCounts {
  updated: number;
  /** Already had an anchor column set (live-written or backfilled earlier). */
  skipped: number;
  /** No anchor in the tape: left NULL, which means unknown. */
  noAnchor: number;
}

export interface DateResult {
  date: string;
  counts: Record<BackfillTable, TableCounts>;
  /** Wall-clock seconds the date took (the spec's timing probe reads this). */
  seconds: number;
}

interface IdRow {
  id: string | number;
}

type ColumnRow = AnchorColumns & { id: number };

/**
 * One batched UPDATE, returning the ids it wrote. `AND t.date = ${date}`
 * ties each write to the tape day that produced it, so a misnamed or copied
 * NDJSON can't write to another day. The table name cannot be a bind
 * parameter; one literal statement per table keeps every identifier a code
 * constant.
 */
async function updateBatch(
  table: BackfillTable,
  date: string,
  batch: ColumnRow[],
): Promise<number> {
  const sql = getDb();
  const ids = batch.map((r) => r.id);
  const wsIds = batch.map((r) => r.anchor_ws_trade_id);
  const codes = batch.map((r) => r.anchor_trade_code);
  const kinds = batch.map((r) => r.anchor_leg_kind);
  const shapes = batch.map((r) => r.spread_shape);
  const legs = batch.map((r) => r.spread_legs);
  // Idempotent (the conditional WHERE), so a transient retry is safe.
  const rows = (await withDbRetry(() =>
    table === 'lottery_finder_fires'
      ? sql`
          UPDATE lottery_finder_fires t
             SET anchor_ws_trade_id = v.ws_id,
                 anchor_trade_code = v.code,
                 anchor_leg_kind = v.kind,
                 spread_shape = v.shape,
                 spread_legs = v.legs::jsonb
            FROM unnest(${ids}::bigint[], ${wsIds}::uuid[], ${codes}::text[],
                        ${kinds}::text[], ${shapes}::text[], ${legs}::text[])
                 AS v(id, ws_id, code, kind, shape, legs)
           WHERE t.id = v.id
             AND t.date = ${date}::date
             AND t.anchor_ws_trade_id IS NULL
             AND t.anchor_leg_kind IS NULL
          RETURNING t.id`
      : sql`
          UPDATE silent_boom_alerts t
             SET anchor_ws_trade_id = v.ws_id,
                 anchor_trade_code = v.code,
                 anchor_leg_kind = v.kind,
                 spread_shape = v.shape,
                 spread_legs = v.legs::jsonb
            FROM unnest(${ids}::bigint[], ${wsIds}::uuid[], ${codes}::text[],
                        ${kinds}::text[], ${shapes}::text[], ${legs}::text[])
                 AS v(id, ws_id, code, kind, shape, legs)
           WHERE t.id = v.id
             AND t.date = ${date}::date
             AND t.anchor_ws_trade_id IS NULL
             AND t.anchor_leg_kind IS NULL
          RETURNING t.id`,
  )) as IdRow[];
  return rows.length;
}

export function markerPath(outDir: string, date: string): string {
  return join(outDir, `${date}.applied`);
}

export interface ApplyOptions {
  outDir: string;
  /** No writes and no marker; the same counts, from the NDJSON alone. */
  dryRun?: boolean;
  /** Reapply a date that has a done marker. */
  force?: boolean;
}

/**
 * Apply one date. Returns null when its done marker exists (and not forced).
 * A DB error throws with the date, table and batch index, and no marker is
 * written: a failed batch is never counted as success.
 */
export async function applyDate(
  date: string,
  opts: ApplyOptions,
): Promise<DateResult | null> {
  const marker = markerPath(opts.outDir, date);
  if (!opts.force && existsSync(marker)) return null;
  const started = performance.now();
  const file = join(opts.outDir, `${date}.ndjson`);
  const lines = parseNdjson(readFileSync(file, 'utf8'), file);

  const counts: Record<BackfillTable, TableCounts> = {
    lottery_finder_fires: { updated: 0, skipped: 0, noAnchor: 0 },
    silent_boom_alerts: { updated: 0, skipped: 0, noAnchor: 0 },
  };
  for (const table of TABLES) {
    const rows: ColumnRow[] = [];
    for (const line of lines) {
      if (line.table !== table) continue;
      const legs = describeLine(line);
      if (legs == null) counts[table].noAnchor += 1;
      else rows.push({ id: line.id, ...toColumns(legs) });
    }
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const batch = rows.slice(i, i + WRITE_CHUNK);
      if (opts.dryRun) {
        counts[table].updated += batch.length;
        continue;
      }
      const batchIndex = i / WRITE_CHUNK;
      let written: number;
      try {
        written = await updateBatch(table, date, batch);
      } catch (err) {
        throw new Error(
          `apply failed: date ${date}, table ${table}, batch ${batchIndex}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      counts[table].updated += written;
      counts[table].skipped += batch.length - written;
    }
  }
  if (!opts.dryRun) writeFileSync(marker, `${new Date().toISOString()}\n`);
  const seconds = (performance.now() - started) / 1000;
  return { date, counts, seconds };
}

export function formatDateResult(
  result: DateResult | null,
  date: string,
  dryRun: boolean,
): string {
  if (result == null) return `${date} skipped (done marker exists)`;
  const part = (label: string, c: TableCounts) =>
    `${label} updated=${c.updated} skipped=${c.skipped} no_anchor=${c.noAnchor}`;
  const mode = dryRun ? 'dry-run ' : '';
  const secs = `secs=${result.seconds.toFixed(1)}`;
  return `${date} ${mode}${part('lf', result.counts.lottery_finder_fires)} | ${part('sb', result.counts.silent_boom_alerts)} | ${secs}`;
}

// ── Compare against a production-lookup reference ───────────────────────────

export type Reference = Record<string, AnchorLegs | null>;

export interface CompareStats {
  /** Rows on either side (union of tape lines and reference keys). */
  rows: number;
  /** Both sides found an anchor. */
  both: number;
  /** Exactly one side found an anchor. */
  oneSided: number;
  anchorIdAgree: number;
  legKindAgree: number;
  shapeAgree: number;
  legsAgree: number;
  /** Tape lines the reference has no key for / reference keys with no line. */
  missingRef: number;
  missingLine: number;
}

export interface Mismatch {
  key: string;
  kind: 'one_sided' | 'anchor_id' | 'leg_kind' | 'shape' | 'legs';
  tape: AnchorLegs | null;
  reference: AnchorLegs | null;
}

export interface CompareReport {
  overall: CompareStats;
  perDate: Record<string, CompareStats>;
  /** Count of every mismatch by class (not just the sample). */
  mismatchClasses: Record<Mismatch['kind'], number>;
  /** The first MISMATCH_SAMPLE mismatches, in key order. */
  mismatches: Mismatch[];
  pass: boolean;
  failures: string[];
}

const newStats = (): CompareStats => ({
  rows: 0,
  both: 0,
  oneSided: 0,
  anchorIdAgree: 0,
  legKindAgree: 0,
  shapeAgree: 0,
  legsAgree: 0,
  missingRef: 0,
  missingLine: 0,
});

export const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : (part / whole) * 100;

const keyPrefix = (table: BackfillTable): string =>
  table === 'lottery_finder_fires' ? 'lf' : 'sb';

/**
 * Compare tape-derived AnchorLegs with a reference, keyed
 * `{date}|lf:{id}` / `{date}|sb:{id}`. Only dates present in `tapeByDate`
 * are compared, and only reference keys of those dates.
 */
export function compareToReference(
  tapeByDate: Map<string, ExtractLine[]>,
  reference: Reference,
): CompareReport {
  const perDate: Record<string, CompareStats> = {};
  const overall = newStats();
  const mismatches: Mismatch[] = [];
  const mismatchClasses: CompareReport['mismatchClasses'] = {
    one_sided: 0,
    anchor_id: 0,
    leg_kind: 0,
    shape: 0,
    legs: 0,
  };
  const note = (m: Mismatch) => {
    mismatchClasses[m.kind] += 1;
    if (mismatches.length < MISMATCH_SAMPLE) mismatches.push(m);
  };

  for (const [date, lines] of [...tapeByDate].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const stats = newStats();
    perDate[date] = stats;
    const seen = new Set<string>();
    for (const line of lines) {
      const key = `${date}|${keyPrefix(line.table)}:${line.id}`;
      seen.add(key);
      stats.rows += 1;
      if (!(key in reference)) {
        stats.missingRef += 1;
        continue;
      }
      const tape = describeLine(line);
      const ref = reference[key] ?? null;
      if ((tape == null) !== (ref == null)) {
        stats.oneSided += 1;
        note({ key, kind: 'one_sided', tape, reference: ref });
        continue;
      }
      if (tape == null || ref == null) continue; // neither found an anchor
      stats.both += 1;
      if (tape.anchorWsTradeId === ref.anchorWsTradeId)
        stats.anchorIdAgree += 1;
      else note({ key, kind: 'anchor_id', tape, reference: ref });
      if (tape.legKind === ref.legKind) stats.legKindAgree += 1;
      else note({ key, kind: 'leg_kind', tape, reference: ref });
      if (tape.spreadShape === ref.spreadShape) stats.shapeAgree += 1;
      else note({ key, kind: 'shape', tape, reference: ref });
      if (isDeepStrictEqual(tape.spreadLegs, ref.spreadLegs))
        stats.legsAgree += 1;
      else note({ key, kind: 'legs', tape, reference: ref });
    }
    const prefix = `${date}|`;
    for (const key of Object.keys(reference)) {
      if (key.startsWith(prefix) && !seen.has(key)) {
        stats.missingLine += 1;
        stats.rows += 1;
      }
    }
    for (const field of Object.keys(stats) as (keyof CompareStats)[]) {
      overall[field] += stats[field];
    }
  }

  const failures: string[] = [];
  const anchorPct = pct(overall.anchorIdAgree, overall.both);
  const kindPct = pct(overall.legKindAgree, overall.both);
  const oneSidedPct = pct(overall.oneSided, overall.rows);
  if (overall.both === 0)
    failures.push('no rows where both sides found an anchor');
  if (anchorPct < GATE_MIN_ANCHOR_ID_PCT)
    failures.push(
      `anchor-id agreement ${anchorPct.toFixed(2)}% < ${GATE_MIN_ANCHOR_ID_PCT}%`,
    );
  if (kindPct < GATE_MIN_LEG_KIND_PCT)
    failures.push(
      `legKind agreement ${kindPct.toFixed(2)}% < ${GATE_MIN_LEG_KIND_PCT}%`,
    );
  if (oneSidedPct > GATE_MAX_ONE_SIDED_PCT)
    failures.push(
      `one-sided ${oneSidedPct.toFixed(2)}% > ${GATE_MAX_ONE_SIDED_PCT}%`,
    );
  return {
    overall,
    perDate,
    mismatchClasses,
    mismatches,
    pass: failures.length === 0,
    failures,
  };
}

function statsLine(label: string, s: CompareStats): string {
  const p = (n: number, d: number) => `${pct(n, d).toFixed(2)}%`;
  return [
    `${label}: rows=${s.rows} n_both=${s.both}`,
    `anchor-id ${p(s.anchorIdAgree, s.both)}`,
    `legKind ${p(s.legKindAgree, s.both)}`,
    `spreadShape ${p(s.shapeAgree, s.both)}`,
    `spreadLegs ${p(s.legsAgree, s.both)}`,
    `one-sided ${p(s.oneSided, s.rows)} (${s.oneSided})`,
    `missing_ref=${s.missingRef} missing_line=${s.missingLine}`,
  ].join('  ');
}

export function formatCompareReport(report: CompareReport): string {
  const out = [statsLine('OVERALL', report.overall)];
  for (const [date, stats] of Object.entries(report.perDate)) {
    out.push(statsLine(date, stats));
  }
  out.push(`mismatch classes: ${JSON.stringify(report.mismatchClasses)}`);
  out.push(
    report.pass ? 'GATE: PASS' : `GATE: FAIL (${report.failures.join('; ')})`,
  );
  return out.join('\n');
}
