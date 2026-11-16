/**
 * Backfill `cum_ncp_at_fire` + `cum_npp_at_fire` on lottery_finder_fires AND
 * silent_boom_alerts rows that have none (the detector wrote them without flow,
 * or the fire pre-dates the columns). Group by (ticker, date), read the
 * cumulative ticker net-flow series ONCE per group, binary-search each fire's
 * value, and write one batched UPDATE per group.
 *
 * The series is `fetchTickerFlowSeries` (api/_lib/ticker-flow-snapshot.ts),
 * the same one the detectors use, so a repaired row holds what a healthy live
 * run would have stored: the websocket rows up to the fire. This script used
 * to carry its own copy of the series SQL, a UNION ALL of the WS tick table and
 * the per-minute history table, which counts a day twice once the history is
 * loaded (21:25 UTC); it filled 2,159 rows at about twice their flow on
 * 2026-11-15. Spec: docs/superpowers/specs/lottery-flow-repair-and-indexes-2026-11-15.md.
 *
 * Idempotent: only rows where cum_ncp_at_fire IS NULL are selected, and every
 * UPDATE re-checks that. Tickers with no flow rows on the day (outside the WS
 * universe, no history) end with an empty series and stay NULL, as does a fire
 * that precedes the first tick; the feeds tolerate NULL.
 */

import type { getDb } from '../../api/_lib/db.js';
import {
  fetchTickerFlowSeries,
  flowAtFireTime,
} from '../../api/_lib/ticker-flow-snapshot.js';

type Sql = ReturnType<typeof getDb>;

/** Rows per UPDATE, as everywhere in this repo's batch writes (R5). */
const WRITE_CHUNK = 500;

export type TableChoice = 'lottery' | 'silentboom' | 'both';

export interface BackfillOptions {
  table: TableChoice;
  ticker: string | null;
  /** `YYYY-MM-DD`, or null for every date. */
  date: string | null;
  /** Cap on (ticker, date) groups, 0 for none. */
  limit: number;
  dryRun: boolean;
}

export interface CliArgs extends BackfillOptions {
  envFile: string | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/backfill-ticker-flow-at-fire.ts [options]

Fills cum_ncp_at_fire and cum_npp_at_fire on lottery_finder_fires and
silent_boom_alerts rows where they are NULL, from the ticker's net-flow series
(the websocket rows up to the fire; history only for a ticker-day with none).
Writes only where the column is still NULL. Reads and writes the database
DATABASE_URL points at (production, in .env.local).

Options:
  --limit N                         cap the (ticker, date) groups processed
  --table lottery|silentboom|both   restrict to one table (default both)
  --ticker TICKER                   only this ticker
  --date YYYY-MM-DD                 only this date
  --dry-run                         compute and report, write nothing
  --env-file <path>                 .env.local to load (default: nearest up the tree)
  --help, -h                        print this and exit`;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    table: 'both',
    ticker: null,
    date: null,
    limit: 0,
    dryRun: false,
    envFile: null,
    help: false,
  };
  const valueOf = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--limit') {
      const value = valueOf(flag, i);
      if (!/^\d+$/.test(value)) throw new Error('--limit needs a whole number');
      args.limit = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--table') {
      const value = valueOf(flag, i);
      if (value !== 'lottery' && value !== 'silentboom' && value !== 'both') {
        throw new Error('--table must be one of: lottery | silentboom | both');
      }
      args.table = value;
      i += 1;
    } else if (flag === '--ticker') {
      args.ticker = valueOf(flag, i);
      i += 1;
    } else if (flag === '--date') {
      const value = valueOf(flag, i);
      if (!isIsoDate(value)) {
        throw new Error(`--date ${value} is not a YYYY-MM-DD date`);
      }
      args.date = value;
      i += 1;
    } else if (flag === '--env-file') {
      args.envFile = valueOf(flag, i);
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

export interface Group {
  ticker: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** Rows with NULL flow across the selected tables. */
  nRows: number;
}

/**
 * The (ticker, date) groups that hold a NULL-flow row in the selected tables,
 * newest date first. The predicate has no index behind it, so a run without
 * `--date` scans both fire tables (the Phase B repair bounds it by date).
 */
export async function selectNullFlowGroups(
  sql: Sql,
  opts: Pick<BackfillOptions, 'table' | 'ticker' | 'date' | 'limit'>,
): Promise<Group[]> {
  const rows = (await sql`
    SELECT ticker, date::text AS date, SUM(n_rows)::int AS n_rows
    FROM (
      SELECT underlying_symbol AS ticker, date, COUNT(*) AS n_rows
      FROM lottery_finder_fires
      WHERE cum_ncp_at_fire IS NULL
        AND ${opts.table}::text IN ('lottery', 'both')
        AND (${opts.ticker ?? null}::text IS NULL OR underlying_symbol = ${opts.ticker ?? ''})
        AND (${opts.date ?? null}::date IS NULL OR date = ${opts.date ?? '1970-01-01'}::date)
      GROUP BY underlying_symbol, date
      UNION ALL
      SELECT underlying_symbol AS ticker, date, COUNT(*) AS n_rows
      FROM silent_boom_alerts
      WHERE cum_ncp_at_fire IS NULL
        AND ${opts.table}::text IN ('silentboom', 'both')
        AND (${opts.ticker ?? null}::text IS NULL OR underlying_symbol = ${opts.ticker ?? ''})
        AND (${opts.date ?? null}::date IS NULL OR date = ${opts.date ?? '1970-01-01'}::date)
      GROUP BY underlying_symbol, date
    ) combined
    GROUP BY ticker, date
    ORDER BY date DESC, ticker
    LIMIT ${opts.limit > 0 ? opts.limit : null}::int
  `) as Array<{ ticker: string; date: string; n_rows: number }>;
  return rows.map((r) => ({ ticker: r.ticker, date: r.date, nRows: r.n_rows }));
}

export interface BackfillSummary {
  groups: number;
  emptyGroups: number;
  lotteryUpdated: number;
  silentUpdated: number;
  /** Rows in groups whose series was empty. */
  leftNullEmptySeries: number;
  /** Rows whose fire precedes the first tick of a non-empty series. */
  leftNullPreSeries: number;
}

interface FireRow {
  id: string;
  at: Date | string;
}

const toMs = (v: Date | string): number =>
  v instanceof Date ? v.getTime() : new Date(v).getTime();

interface PlannedUpdate {
  id: string;
  ncp: number;
  npp: number;
}

/** The NULL-flow rows of one group, as (id, fire time). */
async function nullRows(
  sql: Sql,
  table: 'lottery' | 'silentboom',
  group: Group,
): Promise<FireRow[]> {
  return (
    table === 'lottery'
      ? await sql`
          SELECT id::text AS id, trigger_time_ct AS at
          FROM lottery_finder_fires
          WHERE underlying_symbol = ${group.ticker}
            AND date = ${group.date}::date
            AND cum_ncp_at_fire IS NULL
          ORDER BY id`
      : await sql`
          SELECT id::text AS id, bucket_ct AS at
          FROM silent_boom_alerts
          WHERE underlying_symbol = ${group.ticker}
            AND date = ${group.date}::date
            AND cum_ncp_at_fire IS NULL
          ORDER BY id`
  ) as FireRow[];
}

/** Write the planned values, 500 to a statement, only where still NULL. */
async function writeUpdates(
  sql: Sql,
  table: 'lottery' | 'silentboom',
  updates: readonly PlannedUpdate[],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const chunk = updates.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((u) => u.id);
    const ncp = chunk.map((u) => u.ncp);
    const npp = chunk.map((u) => u.npp);
    const done = (
      table === 'lottery'
        ? await sql`
            UPDATE lottery_finder_fires AS f
            SET cum_ncp_at_fire = u.ncp, cum_npp_at_fire = u.npp
            FROM unnest(${ids}::bigint[], ${ncp}::numeric[], ${npp}::numeric[])
              AS u(id, ncp, npp)
            WHERE f.id = u.id AND f.cum_ncp_at_fire IS NULL
            RETURNING f.id`
        : await sql`
            UPDATE silent_boom_alerts AS f
            SET cum_ncp_at_fire = u.ncp, cum_npp_at_fire = u.npp
            FROM unnest(${ids}::bigint[], ${ncp}::numeric[], ${npp}::numeric[])
              AS u(id, ncp, npp)
            WHERE f.id = u.id AND f.cum_ncp_at_fire IS NULL
            RETURNING f.id`
    ) as Array<{ id: unknown }>;
    written += done.length;
  }
  return written;
}

/**
 * Backfill every selected group. A database error propagates (nothing is
 * caught), so a failed run exits non-zero and a rerun finishes it. On a dry run
 * the counts are what would be written.
 */
export async function runBackfill(
  sql: Sql,
  opts: BackfillOptions,
  onGroup?: (group: Group, index: number, total: number) => void,
): Promise<BackfillSummary> {
  const groups = await selectNullFlowGroups(sql, opts);
  const summary: BackfillSummary = {
    groups: groups.length,
    emptyGroups: 0,
    lotteryUpdated: 0,
    silentUpdated: 0,
    leftNullEmptySeries: 0,
    leftNullPreSeries: 0,
  };
  const tables: Array<'lottery' | 'silentboom'> =
    opts.table === 'both' ? ['lottery', 'silentboom'] : [opts.table];

  for (const [index, group] of groups.entries()) {
    onGroup?.(group, index, groups.length);
    const series = await fetchTickerFlowSeries(sql, group.ticker, group.date);
    if (series.ts.length === 0) {
      summary.emptyGroups += 1;
      summary.leftNullEmptySeries += group.nRows;
      continue;
    }
    for (const table of tables) {
      const updates: PlannedUpdate[] = [];
      for (const row of await nullRows(sql, table, group)) {
        const { cumNcp, cumNpp } = flowAtFireTime(
          series,
          new Date(toMs(row.at)),
        );
        if (cumNcp == null || cumNpp == null) {
          summary.leftNullPreSeries += 1;
          continue;
        }
        updates.push({ id: row.id, ncp: cumNcp, npp: cumNpp });
      }
      const count = opts.dryRun
        ? updates.length
        : await writeUpdates(sql, table, updates);
      if (table === 'lottery') summary.lotteryUpdated += count;
      else summary.silentUpdated += count;
    }
  }
  return summary;
}

export function formatSummary(
  summary: BackfillSummary,
  dryRun: boolean,
): string {
  const tag = dryRun ? ' (dry-run)' : '';
  return [
    '── Backfill summary ──',
    `  Groups processed:        ${summary.groups}`,
    `  Empty-series groups:     ${summary.emptyGroups}`,
    `  Lottery rows updated:    ${summary.lotteryUpdated}${tag}`,
    `  Silent boom rows updated:${summary.silentUpdated}${tag}`,
    `  Left NULL (no series):   ${summary.leftNullEmptySeries}`,
    `  Left NULL (pre-series):  ${summary.leftNullPreSeries}`,
  ].join('\n');
}
