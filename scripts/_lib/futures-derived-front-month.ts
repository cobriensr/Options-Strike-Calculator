/**
 * The `--repair front-month` profile of the derived-store recompute (Phase 6b of
 * docs/superpowers/specs/2026-11-06-futures-session-front-month.md), and the
 * reader of the Phase 6 bar backup that profile attributes from.
 *
 * Phase 6 (scripts/backfill-futures-bars.ts --repair) rewrote prod `futures_bars`
 * for the UTC days 2026-07-28 to 11-11 from the exchange's own prints: it
 * rewrote bars built from the wrong contract month, deleted bars no print
 * backs, filled minutes that had no bar, and tagged bars with their contract.
 * Three stores saved values computed from the bars as they were; the recompute
 * (futures-derived-recompute.ts) finds the ones a changed bar fed.
 */

import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { FUTURES_SYMBOLS } from '../../api/_lib/futures-derive.js';
import type { BackupBar } from './futures-derived-attribution.js';

export type BackupAction = 'rewrite' | 'delete' | 'fill' | 'tag';

export interface FrontMonthProfile {
  /** The UTC days Phase 6 changed bars in, half-open. */
  span: { startMs: number; endMs: number };
  /**
   * The end of the Phase 6 write run: a stored row from here on read the
   * repaired bars when it was written, so it is outside the scope.
   */
  writtenUntilMs: number;
  /** The Phase 6 backup: the run it must belong to and the lines it must hold. */
  backup: { runId: string; totals: Readonly<Record<BackupAction, number>> };
  /** Apart from the contract-mix work dir, whose done markers would skip steps. */
  defaultWorkDir: string;
}

export const FRONT_MONTH: FrontMonthProfile = {
  span: {
    startMs: Date.UTC(2026, 6, 28),
    endMs: Date.UTC(2026, 10, 12),
  },
  writtenUntilMs: Date.UTC(2026, 10, 13, 5, 16),
  backup: {
    runId: '2026-11-13T05-10-59Z',
    totals: { rewrite: 9411, delete: 194, fill: 79802, tag: 536310 },
  },
  defaultWorkDir: 'docs/tmp/futures-derived-recompute-front-month',
};

// ── The Phase 6 backup ──────────────────────────────────────────────────────

const ACTIONS: readonly BackupAction[] = ['rewrite', 'delete', 'fill', 'tag'];

const priceText = z
  .string()
  .refine((s) => s.trim() !== '' && Number.isFinite(Number(s)), 'not a number');

/** A stored bar as `fetchFuturesBars` returns it: prices as text, the volume a number. */
const barRow = z.object({
  ts: z.string(),
  open: priceText,
  high: priceText,
  low: priceText,
  close: priceText,
  volume: z.number().finite(),
});

/**
 * One schema per action, strict on the line's own keys: a fill that also carries
 * a `row`, or a delete an `after`, is a line this reader does not understand, and
 * the values it reads from `row` and `after` are the only ones that count.
 */
const lineKeys = { runId: z.string(), symbol: z.string() } as const;
const lineSchemas = {
  rewrite: z.strictObject({
    ...lineKeys,
    action: z.literal('rewrite'),
    row: barRow,
    after: barRow,
  }),
  delete: z.strictObject({
    ...lineKeys,
    action: z.literal('delete'),
    row: barRow,
  }),
  fill: z.strictObject({
    ...lineKeys,
    action: z.literal('fill'),
    after: barRow,
  }),
  tag: z.strictObject({
    ...lineKeys,
    action: z.literal('tag'),
    row: z.object({ ts: z.string() }),
    after: z.object({ contract: z.string() }),
  }),
} as const;

export interface FrontMonthBackup {
  /**
   * A rewrite as an `update` with the values it replaced, a delete, a fill with
   * the bar it added, in file order. A tag changes no value and is not here.
   */
  bars: BackupBar[];
  /** Every action of the file, tags included. */
  counts: Record<BackupAction, number>;
}

const isoSecond = (tsMs: number): string =>
  new Date(tsMs).toISOString().replace('.000Z', 'Z');

/** The symbols as numbers, so a (symbol, ts) pair is one exact double key. */
const SYMBOL_INDEX = new Map<string, number>(
  FUTURES_SYMBOLS.map((s, i) => [s, i]),
);

/** Lines of a file, whatever the chunking; the last one needs no final newline. */
async function* linesOf(path: string): AsyncGenerator<string> {
  let carry = '';
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      const parts = (carry + String(chunk)).split('\n');
      carry = parts.pop() ?? '';
      yield* parts;
    }
    if (carry !== '') yield carry;
  } finally {
    stream.destroy();
  }
}

function barOf(
  op: BackupBar['op'],
  symbol: string,
  tsMs: number,
  r: z.infer<typeof barRow>,
): BackupBar {
  return {
    op,
    symbol,
    tsMs,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: r.volume,
  };
}

/**
 * Reads the Phase 6 backup, one line at a time (the file is about 185 MB), and
 * refuses a file that is not exactly that run's, before any database read: the
 * error names the file and the line. A line is refused for another run id, an
 * action or symbol it does not know, a changed bar (rewrite, delete, fill)
 * outside the span, a bar listed twice (any action), a rewrite whose after bar
 * is another minute, or a value that does not read; and the file for line counts
 * per action that differ from the pinned ones, which catches a cut or a
 * different file. The profile is passed in whole so its pins are read in one
 * place.
 */
export async function readFrontMonthBackup(
  path: string,
  profile: Pick<FrontMonthProfile, 'span' | 'backup'>,
): Promise<FrontMonthBackup> {
  const { span, backup: pins } = profile;
  const counts: Record<BackupAction, number> = {
    rewrite: 0,
    delete: 0,
    fill: 0,
    tag: 0,
  };
  const bars: BackupBar[] = [];
  const firstLine = new Map<number, number>();
  let lineNo = 0;
  for await (const raw of linesOf(path)) {
    lineNo += 1;
    if (raw.trim() === '') continue;
    const where = `${path}:${lineNo}`;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${where}: not JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    if (json == null || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(`${where}: is not an object`);
    }
    const head = json as {
      runId?: unknown;
      action?: unknown;
      symbol?: unknown;
    };
    if (head.runId !== pins.runId) {
      throw new Error(
        `${where}: runId "${String(head.runId)}" is not "${pins.runId}"`,
      );
    }
    const action = ACTIONS.find((a) => a === head.action);
    if (action == null) {
      throw new Error(`${where}: unknown action "${String(head.action)}"`);
    }
    const symbolIndex = SYMBOL_INDEX.get(String(head.symbol));
    if (symbolIndex == null) {
      throw new Error(`${where}: unknown symbol "${String(head.symbol)}"`);
    }
    const symbol = String(head.symbol);
    const parsed = lineSchemas[action].safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // A key the schema does not know has no path of its own: the message names it.
      const what = [issue?.path.join('.'), issue?.message ?? 'invalid']
        .filter((part) => part != null && part !== '')
        .join(' ');
      throw new Error(`${where}: ${what}`);
    }
    const data = parsed.data as Partial<{
      row: z.infer<typeof barRow>;
      after: z.infer<typeof barRow>;
    }>;
    const ts = (action === 'fill' ? data.after?.ts : data.row?.ts) ?? '';
    const tsMs = Date.parse(ts);
    if (Number.isNaN(tsMs))
      throw new Error(`${where}: ts "${ts}" is not a date`);
    if (action !== 'tag' && (tsMs < span.startMs || tsMs >= span.endMs)) {
      throw new Error(
        `${where}: ts ${ts} is outside the span ${isoSecond(span.startMs)} .. ${isoSecond(span.endMs)}`,
      );
    }
    if (
      action === 'rewrite' &&
      data.after != null &&
      Date.parse(data.after.ts) !== tsMs
    ) {
      throw new Error(
        `${where}: the after bar is ${data.after.ts}, the row ${ts}`,
      );
    }
    // symbol index < 8, ts < 2^50: one exact number per (symbol, minute).
    const key = tsMs * 8 + symbolIndex;
    const earlier = firstLine.get(key);
    if (earlier != null) {
      throw new Error(
        `${where}: ${symbol} ${ts} is listed again (first at line ${earlier})`,
      );
    }
    firstLine.set(key, lineNo);
    counts[action] += 1;
    if (action === 'rewrite' && data.row != null) {
      bars.push(barOf('update', symbol, tsMs, data.row));
    } else if (action === 'delete' && data.row != null) {
      bars.push(barOf('delete', symbol, tsMs, data.row));
    } else if (action === 'fill' && data.after != null) {
      bars.push(barOf('fill', symbol, tsMs, data.after));
    }
  }
  const off = ACTIONS.map(
    (a) => `${a} ${counts[a]} (pinned ${pins.totals[a]})`,
  );
  if (ACTIONS.some((a) => counts[a] !== pins.totals[a])) {
    throw new Error(
      `${path}: the totals are not the pinned ones: ${off.join(', ')}`,
    );
  }
  return { bars, counts };
}

/** The UTC calendar date (YYYY-MM-DD) of a time: `ts AT TIME ZONE 'UTC'` in the tables. */
const utcDateOf = (tsMs: number): string =>
  new Date(tsMs).toISOString().slice(0, 10);

/**
 * The UTC dates on which Phase 6 rewrote, deleted or filled a bar of `symbol`
 * (a delete and a rewrite keyed by the stored row's ts, a fill by the bar it
 * added; a tag changes no bar and is not in `bars`). A snapshot row on one of
 * these dates is on a repaired day; any other row the plan changes is reached
 * only through the 20-day volume window, or across a UTC midnight. The owner's
 * measured scope (15,255 rows) counted by this rule.
 */
export function repairedDays(
  bars: readonly BackupBar[],
  symbol: string,
): Set<string> {
  return new Set(
    bars.filter((b) => b.symbol === symbol).map((b) => utcDateOf(b.tsMs)),
  );
}

/** True when the UTC date of `tsMs` is one of `days`. */
export const onRepairedDay = (
  days: ReadonlySet<string>,
  tsMs: number,
): boolean => days.has(utcDateOf(tsMs));

/**
 * The report header's backup line: the lines in the file, each action apart (a
 * fill is a new bar, not an update), and each root's share of the three that
 * change a value, so the Phase 6 report's totals can be checked against it.
 */
export function frontMonthBackupLine(
  path: string,
  backup: FrontMonthBackup,
  roots: readonly string[],
): string {
  const { counts, bars } = backup;
  const lines = ACTIONS.reduce((n, a) => n + counts[a], 0);
  const perRoot = (op: BackupBar['op']): string =>
    roots
      .map(
        (r) =>
          `${r} ${bars.filter((b) => b.op === op && b.symbol === r).length}`,
      )
      .join(', ');
  return (
    `bar backup ${path}: ${lines} lines (rewrites ${counts.rewrite}, deletes ${counts.delete}, fills ${counts.fill}, ` +
    `tags ${counts.tag} skipped: a tag changes no value); ` +
    `rewritten by root: ${perRoot('update')}; deleted by root: ${perRoot('delete')}; filled by root: ${perRoot('fill')}`
  );
}
