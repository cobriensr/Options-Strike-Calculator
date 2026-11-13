/**
 * The scope and the report of the volume-null step of the contract-mix repair
 * (`--stores volume-null`, owner ruling 2026-11-12, M1 of the Task 5 final review).
 *
 * Phase 5b recomputed the `volume_ratio` of RTY, CL, GC and ZN snapshot rows from
 * 20-day windows that Phase 5a had mostly emptied: each ratio divides by the average
 * of the few UTC-day groups that survive, so it is not a 20-day ratio. The owner
 * ruled them out ("Blank all 7,146"): set them back to NULL. The RTY, CL and ZN rows
 * on the April clean days (04-13 to 04-17) moved about 3% and stay.
 *
 * The scope is read from the 5b apply backup (`backup-<time>.jsonl` of
 * futures-derived-recompute.ts, one line per row it wrote): the distinct ids of the
 * `snapshots` and `stale` lines whose `to` holds a `volumeRatio`, minus the April
 * rows above. The value the apply last wrote to an id is its guard: the UPDATE
 * blanks the row only while it still holds that value, so a row changed since is
 * left alone and named. The apply ran snapshots, then stale (plan.json `steps`), so
 * an id with a value in both takes the stale line's. The planning, the guarded
 * UPDATE and the verify are in futures-derived-recompute.ts.
 */

import { z } from 'zod';
import {
  CLEAN_TRADING_DAYS,
  ctTradingDay,
  isThinRoot,
  type ThinRoot,
} from './futures-thin-roots.js';

/** The CT trading days of the April clean block, where RTY, CL and ZN keep 5b's ratio. */
const APRIL_CLEAN_DAYS: readonly string[] = CLEAN_TRADING_DAYS.filter((d) =>
  d.startsWith('2026-04-'),
);
/** The June clean days (06-01 and 06-08). */
const JUNE_CLEAN_DAYS: readonly string[] = CLEAN_TRADING_DAYS.filter((d) =>
  d.startsWith('2026-06-'),
);

/** Where 5b's rewrites fall, by time: from the span end to the end of its 20-day window. */
const SPAN_END_MS = Date.UTC(2026, 5, 15, 14, 11);
const JUNE_16_OPEN_MS = Date.UTC(2026, 5, 16, 4, 0);
const WINDOW_END_MS = Date.UTC(2026, 6, 5, 14, 11);

const VOLUME_NULL_REGIONS = [
  'juneClean',
  'june15',
  'june16ToJuly5',
  'gcAprilClean',
  'elsewhere',
] as const;
export type VolumeNullRegion = (typeof VOLUME_NULL_REGIONS)[number];

const REGION_LABEL: Record<VolumeNullRegion, string> = {
  juneClean: 'June clean days (06-01, 06-08)',
  june15: '06-15 14:11Z to 06-16 04:00Z',
  june16ToJuly5: '06-16 04:00Z to 07-05 14:11Z',
  gcAprilClean: 'GC on the April clean days',
  elsewhere: 'anywhere else (the ruling names none)',
};

/** One row to blank, as the 5b backup names it. */
export interface VolumeNullTarget {
  id: number;
  symbol: ThinRoot;
  tsMs: number;
  /** The volume_ratio the 5b apply last wrote to the row, at the column's 4 decimals. */
  guard: number;
  region: VolumeNullRegion;
}

export interface VolumeNullScope {
  path: string;
  /** The non-blank lines of the file. */
  lines: number;
  /** Distinct ids with a volumeRatio in the `to` of a snapshots or stale line. */
  writers: number;
  /** Of those, ids with one in both steps: the stale line's value is the guard. */
  inBothSteps: number;
  /** Of those, ids whose last write was NULL: nothing to blank. */
  wroteNull: number;
  /** RTY, CL and ZN rows on the April clean days: they keep 5b's value. */
  keptApril: number;
  /** The rows the ruling blanks, by id. */
  targets: VolumeNullTarget[];
}

const STEP_ORDER = { snapshots: 0, stale: 1 } as const;

const headSchema = z.object({ step: z.string() });
const lineSchema = z.object({
  step: z.enum(['snapshots', 'stale']),
  id: z.number().int().positive(),
  symbol: z.string(),
  row: z.object({ ts: z.string(), symbol: z.string() }),
  to: z.object({ volumeRatio: z.number().nullable().optional() }),
});

/** The region of a row the ruling blanks. */
export function regionOf(symbol: string, tsMs: number): VolumeNullRegion {
  const day = ctTradingDay(tsMs);
  if (symbol === 'GC' && APRIL_CLEAN_DAYS.includes(day)) return 'gcAprilClean';
  if (JUNE_CLEAN_DAYS.includes(day)) return 'juneClean';
  if (tsMs >= SPAN_END_MS && tsMs < JUNE_16_OPEN_MS) return 'june15';
  if (tsMs >= JUNE_16_OPEN_MS && tsMs < WINDOW_END_MS) return 'june16ToJuly5';
  return 'elsewhere';
}

/** True for a row 5b's value stays on: RTY, CL or ZN on a day of the April clean block. */
const keepsFiveBValue = (symbol: string, tsMs: number): boolean =>
  symbol !== 'GC' && APRIL_CLEAN_DAYS.includes(ctTradingDay(tsMs));

/**
 * The ids the ruling blanks, from the text of the 5b apply backup. A line that is
 * not JSON, a snapshots or stale line without an id, symbol, ts or a numeric
 * `volumeRatio`, a symbol that differs from its row's, and a root that is not a thin
 * root all throw with `label:line`: the scope is the contract of a write.
 */
export function parseVolumeNullScope(
  text: string,
  label: string,
): VolumeNullScope {
  const byId = new Map<
    number,
    {
      step: keyof typeof STEP_ORDER;
      value: number | null;
      symbol: ThinRoot;
      tsMs: number;
    }
  >();
  const seen = new Set<string>();
  let lines = 0;
  let inBothSteps = 0;
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    lines += 1;
    const where = `${label}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const head = headSchema.safeParse(json);
    if (!head.success) throw new Error(`${where}: not a plan line (no step)`);
    if (head.data.step !== 'snapshots' && head.data.step !== 'stale') continue;
    const parsed = lineSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${where}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
      );
    }
    const { step, id, symbol, row, to } = parsed.data;
    if (to.volumeRatio === undefined) continue;
    if (row.symbol !== symbol) {
      throw new Error(
        `${where}: symbol ${symbol} but its row says ${row.symbol}`,
      );
    }
    if (!isThinRoot(symbol)) {
      throw new Error(`${where}: ${symbol} is not a thin root`);
    }
    const tsMs = Date.parse(row.ts);
    if (Number.isNaN(tsMs)) {
      throw new Error(`${where}: row ts "${row.ts}" is not a date`);
    }
    const key = `${step}:${id}`;
    if (seen.has(key))
      throw new Error(`${where}: id ${id} twice in step ${step}`);
    seen.add(key);
    const before = byId.get(id);
    if (before != null) {
      inBothSteps += 1;
      // Both lines name the same row; the step that ran later wrote last.
      if (STEP_ORDER[before.step] > STEP_ORDER[step]) continue;
    }
    byId.set(id, { step, value: to.volumeRatio, symbol, tsMs });
  }

  const targets: VolumeNullTarget[] = [];
  let wroteNull = 0;
  let keptApril = 0;
  for (const [id, w] of [...byId].sort(([a], [b]) => a - b)) {
    if (w.value === null) {
      wroteNull += 1;
      continue;
    }
    if (keepsFiveBValue(w.symbol, w.tsMs)) {
      keptApril += 1;
      continue;
    }
    targets.push({
      id,
      symbol: w.symbol,
      tsMs: w.tsMs,
      guard: w.value,
      region: regionOf(w.symbol, w.tsMs),
    });
  }
  return {
    path: label,
    lines,
    writers: byId.size,
    inBothSteps,
    wroteNull,
    keptApril,
    targets,
  };
}

// ── The plan and its report ─────────────────────────────────────────────────

/** A row to blank: the target and the whole row as it is now (the backup holds it). */
export interface VolumeNullRow {
  target: VolumeNullTarget;
  row: Record<string, unknown>;
}

export interface VolumeNullPlan {
  scope: VolumeNullScope;
  /** Still there and holding the guard value: the rows the apply blanks. */
  rows: VolumeNullRow[];
  /** No row with that id and symbol. */
  gone: VolumeNullTarget[];
  /** The row holds another value than the one 5b wrote (a number, as the column prints it). */
  changed: { target: VolumeNullTarget; current: string }[];
  /** Already NULL: blanked by an earlier run, nothing left to do. */
  alreadyNull: number;
}

const ROOTS: readonly ThinRoot[] = ['RTY', 'CL', 'GC', 'ZN'];

const isoSecond = (tsMs: number): string =>
  new Date(tsMs).toISOString().replace('.000Z', 'Z');

const targetLine = (t: VolumeNullTarget): string =>
  `${t.symbol} ${isoSecond(t.tsMs)} id ${t.id}: 5b wrote ${t.guard}`;

/** The rows to blank by region, each with its roots, then by root. */
function breakdownText(rows: readonly VolumeNullRow[]): string[] {
  const out = ['  rows to blank, by region (and root):'];
  for (const region of VOLUME_NULL_REGIONS) {
    const mine = rows.filter((r) => r.target.region === region);
    if (mine.length === 0 && region === 'elsewhere') continue;
    const roots = ROOTS.map(
      (root) =>
        `${root} ${mine.filter((r) => r.target.symbol === root).length}`,
    ).join(', ');
    out.push(`    ${REGION_LABEL[region]}: ${mine.length} (${roots})`);
  }
  const byRoot = ROOTS.map(
    (root) => `${root} ${rows.filter((r) => r.target.symbol === root).length}`,
  ).join(', ');
  out.push(`  rows to blank, by root: ${byRoot}`);
  return out;
}

/** The volume-null section of the dry run's report. */
export function volumeNullText(plan: VolumeNullPlan): string[] {
  const { scope } = plan;
  const out = [
    'futures_snapshots.volume_ratio of RTY, CL, GC and ZN (--stores volume-null; --null-volume-ratio sets it to NULL, off by default; owner ruling 2026-11-12: "Blank all 7,146")',
    '  5b recomputed these ratios from 20-day windows that 5a had mostly emptied, so each rests on a few leftover UTC-day groups. Blanked: the rows 5b wrote; kept: RTY, CL and ZN on the April clean days 04-13 to 04-17 (they moved about 3%).',
    `  scope file ${scope.path}: ${scope.lines} lines; ${scope.writers} ids write a volume_ratio in the snapshots or stale step (${scope.inBothSteps} in both: the stale step ran later, its value is the guard); ${scope.wroteNull} of them wrote NULL`,
    `  kept, RTY, CL and ZN on the April clean days: ${scope.keptApril}`,
    `  targets: ${scope.targets.length}`,
    `  rows to blank (still there and holding the value 5b wrote): ${plan.rows.length}`,
    `  already NULL: ${plan.alreadyNull}`,
    `  gone: ${plan.gone.length}${plan.gone.length === 0 ? '' : ' (no row with that id and symbol):'}`,
    ...plan.gone.map((t) => `    ${targetLine(t)}`),
    `  changed since 5b: ${plan.changed.length}${plan.changed.length === 0 ? '' : ' (the row holds another value, so it is left alone):'}`,
    ...plan.changed.map((c) => `    ${targetLine(c.target)}, now ${c.current}`),
    ...breakdownText(plan.rows),
    '  A rerun of 5b plans no volume_ratio for a lifted thin root (it neither computes nor writes one), so it does not bring these values back.',
  ];
  return out;
}

/** Why `--apply --null-volume-ratio` must refuse: the count of the dry run you approved. Empty without the flag. */
export function checkVolumeNullGate(
  o: { nullVolumeRatio: boolean; expectVolumeNulls: number | null },
  planned: number,
): string[] {
  if (!o.nullVolumeRatio) return [];
  if (o.expectVolumeNulls == null) {
    return [
      '--null-volume-ratio needs --expect-volume-nulls N: the count of the dry run you approved',
    ];
  }
  if (o.expectVolumeNulls !== planned) {
    return [
      `the fresh plan blanks ${planned} volume_ratio values, --expect-volume-nulls ${o.expectVolumeNulls} was given`,
    ];
  }
  return [];
}
