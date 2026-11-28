/**
 * Backfill of ws_gamma_setup_fires: the logic behind
 * scripts/backfill-gamma-setup-fires.ts, which is a thin wrapper that loads the
 * env, opens the DB handle and calls `runGammaBackfill`. It lives here so
 * vitest covers it (scripts/_lib/**); the script used to run `main()` at import.
 *
 * Four modes, all with an optional `--from/--to` window of inclusive ET session
 * dates (spec: docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md,
 * "Script flags"):
 *
 *   (default)        Walk every RTH minute of the window, simulate the live
 *                    detector, insert the fires, then fill the forward returns.
 *                    Reads Periscope rows from the scraper era only unless
 *                    `--include-gexbot`, and caps `--to` at the cutover.
 *   --dry-run        The default mode's detection, then print `date  fires` per
 *                    session date and stop. Writes nothing and never reads
 *                    ws_gamma_setup_fires (no outcome fill, no closing summary),
 *                    so it can run before the table is cleared.
 *   --outcomes-only  No detection, no insert: fill ret_15m/30m/60m/eod of the
 *                    fires still missing ret_30m. Not clamped to the cutover.
 *   --context-only   No detection, no insert, no outcome fill: for each ET date
 *                    in the window that has fires, rerun the detector's own
 *                    `loadDayContext` at 12:00 ET and rewrite that date's
 *                    prior_5d_ret, prior_iv_rank, pre_day_filter_fires,
 *                    open_gap_pct and confidence_tier (and nothing else). Needs
 *                    an explicit --from and --to. With --dry-run it prints the
 *                    stored and the new value of each column, the one dry run
 *                    that reads ws_gamma_setup_fires. Not clamped to the cutover.
 *
 * The outcome fill is limited to the window when `--from` or `--to` is passed
 * (a side left out takes its default); with neither it stays table-wide.
 *
 * Idempotent: UNIQUE(fired_at, signal_type, node_strike) with ON CONFLICT DO
 * NOTHING makes a rerun insert only new fires; the outcome fill only touches
 * rows whose ret_30m is still NULL; the day-context UPDATE sets the same values
 * on a rerun.
 *
 * `insertFires` and `backfillOutcomes` keep their per-row loops: this file is a
 * move, and batching them (R5) is later work.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

import {
  detectE1,
  detectE5,
  detectPcsMonday,
  getConfidenceTier,
  getDowLabel,
  loadDayContext,
  PREDAY_5D_RET_THRESHOLD,
  PREDAY_IV_RANK_THRESHOLD,
  PERISCOPE_MAX_AGE_MIN,
  type Bar,
  type ConfidenceTier,
  type DayContext,
  type DowLabel,
  type GammaNode,
  type SignalType,
} from '../../api/_lib/gamma-detector.js';
import { isFomcDecisionDay } from '../../api/_lib/fomc-schedule.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';

import {
  GEXBOT_INCLUDE_WARNING,
  resolveBackfillScope,
} from './uw-tuned-backfill.js';

type Sql = NeonQueryFunction<false, false>;

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_FROM = '2026-02-26'; // earliest SPX candle data
const DEFAULT_TO = '2026-05-22';
const LATEST_EVENT_CT_MINUTES = 14 * 60; // skip post-14:00 CT events (matches detector)
const BAR_LOOKBACK = 20; // matches detect-gamma-setups (loadRecentBars)

const USAGE =
  'usage: backfill-gamma-setup-fires.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] ' +
  '[--include-gexbot] [--dry-run] [--outcomes-only | --context-only]\n' +
  '  --context-only needs both --from and --to; --dry-run cannot go with --outcomes-only';

/** The five day-context columns `--context-only` rewrites, in SET order. */
const CONTEXT_COLUMNS = [
  'prior_5d_ret',
  'prior_iv_rank',
  'pre_day_filter_fires',
  'open_gap_pct',
  'confidence_tier',
] as const;

// ============================================================
// CLI ARGS
// ============================================================

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface GammaBackfillArgs {
  from: string;
  to: string;
  /** `--from` or `--to` was passed: the outcome fill is limited to the window. */
  windowExplicit: boolean;
  dryRun: boolean;
  outcomesOnly: boolean;
  contextOnly: boolean;
}

const isEtDate = (value: string): boolean =>
  etWallClockToUtcIso(value, 0) !== null;

/** Parse the flags. Anything unknown or contradictory is a UsageError (exit 2). */
export function parseArgs(argv: readonly string[]): GammaBackfillArgs {
  let from: string | null = null;
  let to: string | null = null;
  let dryRun = false;
  let outcomesOnly = false;
  let contextOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--from' || arg === '--to') {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new UsageError(`${arg} needs a YYYY-MM-DD value`);
      }
      if (!isEtDate(value)) {
        throw new UsageError(`${arg} ${value} is not a YYYY-MM-DD date`);
      }
      if (arg === '--from') from = value;
      else to = value;
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--outcomes-only') {
      outcomesOnly = true;
    } else if (arg === '--context-only') {
      contextOnly = true;
    } else if (arg !== '--include-gexbot') {
      // --include-gexbot is read by resolveBackfillScope, from the same argv.
      throw new UsageError(`unknown argument ${arg}`);
    }
  }

  if (contextOnly && outcomesOnly) {
    throw new UsageError('--context-only and --outcomes-only contradict');
  }
  if (contextOnly && (from == null || to == null)) {
    throw new UsageError('--context-only needs an explicit --from and --to');
  }
  if (dryRun && outcomesOnly) {
    throw new UsageError(
      '--dry-run has nothing to print with --outcomes-only: a dry run never reads ws_gamma_setup_fires',
    );
  }
  const range = { from: from ?? DEFAULT_FROM, to: to ?? DEFAULT_TO };
  if (range.from > range.to) {
    throw new UsageError(`--from ${range.from} is after --to ${range.to}`);
  }
  return {
    ...range,
    windowExplicit: from != null || to != null,
    dryRun,
    outcomesOnly,
    contextOnly,
  };
}

// ============================================================
// ET WINDOWS
// ============================================================

/** The calendar day after a YYYY-MM-DD date (pure date arithmetic, no zone). */
function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * The instants that bound the inclusive ET session dates `from`..`to`:
 * `[from 00:00 ET, (to + 1 day) 00:00 ET)`, so a one-day window holds that
 * whole ET day. Built with the repo's ET helper, never a fixed UTC offset: the
 * helper probes the zone's offset at noon, which is exact on every weekday
 * midnight (a DST switch lands at 02:00 on a Sunday, and fires exist only in
 * weekday RTH, so a bound on that Sunday cannot add or drop one).
 */
export function etWindowBounds(
  from: string,
  to: string,
): { startIso: string; endIso: string } {
  const startIso = etWallClockToUtcIso(from, 0);
  const endIso = etWallClockToUtcIso(nextDate(to), 0);
  if (startIso == null || endIso == null) {
    throw new Error(`bad ET window ${from} → ${to}`);
  }
  return { startIso, endIso };
}

/** 12:00 ET on a session date: inside the day in both DST phases. */
function etNoon(date: string): Date {
  const iso = etWallClockToUtcIso(date, 12 * 60);
  if (iso == null) throw new Error(`bad ET date ${date}`);
  return new Date(iso);
}

// ============================================================
// TYPES
// ============================================================

interface RawBar {
  ts_ms: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface RawNode {
  captured_ms: number;
  expiry: string;
  strike: number;
  value: number;
}

interface SnapshotMeta {
  captured_ms: number;
  expiry: string;
}

// ============================================================
// LOADERS
// ============================================================

async function loadBars(sql: Sql, from: string, to: string): Promise<RawBar[]> {
  const rows = (await sql`
    SELECT EXTRACT(EPOCH FROM timestamp) * 1000 AS ts_ms,
           date::text AS date,
           open, high, low, close
    FROM index_candles_1m
    WHERE symbol = 'SPX'
      AND market_time = 'r'
      AND date >= ${from}::date
      AND date <= ${to}::date
    ORDER BY timestamp ASC
  `) as Array<{
    ts_ms: string | number;
    date: string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
  }>;
  return rows.map((r) => ({
    ts_ms: Number(r.ts_ms),
    date: r.date,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

async function loadPeriscopeNodes(
  sql: Sql,
  from: string,
  to: string,
  cutoff: string | null,
): Promise<{
  bySnapshot: Map<string, RawNode[]>;
  snapshots: SnapshotMeta[];
}> {
  const rows = (await sql`
    SELECT EXTRACT(EPOCH FROM captured_at) * 1000 AS captured_ms,
           expiry::text AS expiry,
           strike, value
    FROM periscope_snapshots
    WHERE panel = 'gamma'
      AND expiry >= ${from}::date
      AND expiry <= ${to}::date
      AND value > 0
      AND (${cutoff}::timestamptz IS NULL
           OR captured_at < ${cutoff}::timestamptz)
    ORDER BY captured_at ASC, strike ASC
  `) as Array<{
    captured_ms: string | number;
    expiry: string;
    strike: number;
    value: string | number;
  }>;

  const bySnapshot = new Map<string, RawNode[]>();
  const snapshotKeys = new Set<string>();
  for (const r of rows) {
    const node: RawNode = {
      captured_ms: Number(r.captured_ms),
      expiry: r.expiry,
      strike: r.strike,
      value: Number(r.value),
    };
    const key = `${node.captured_ms}_${node.expiry}`;
    snapshotKeys.add(key);
    const list = bySnapshot.get(key) ?? [];
    list.push(node);
    bySnapshot.set(key, list);
  }

  // Build a sorted snapshot index for fast "latest before ts" lookups.
  const snapshots: SnapshotMeta[] = Array.from(snapshotKeys)
    .map((k) => {
      const [ms, expiry] = k.split('_');
      return { captured_ms: Number(ms), expiry: expiry! };
    })
    .sort((a, b) => a.captured_ms - b.captured_ms);

  return { bySnapshot, snapshots };
}

async function loadEsBars(
  sql: Sql,
  from: string,
  to: string,
): Promise<Array<{ ts_ms: number; close: number }>> {
  // Pull ES bars covering the window plus 10 min of slack on each side
  // (the ES basis lookup wants bars in the last 6 minutes of each event).
  const rows = (await sql`
    SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms, close
    FROM futures_bars
    WHERE symbol = 'ES'
      AND ts >= ${from}::date - INTERVAL '1 day'
      AND ts <= ${to}::date + INTERVAL '1 day'
    ORDER BY ts ASC
  `) as Array<{ ts_ms: string | number; close: string | number }>;
  return rows.map((r) => ({
    ts_ms: Number(r.ts_ms),
    close: Number(r.close),
  }));
}

interface VolRow {
  date: string;
  iv_rank: number | null;
}

type NumericCell = string | number | null;

async function loadVolRealized(sql: Sql): Promise<VolRow[]> {
  const rows = (await sql`
    SELECT date::text AS date, iv_rank
    FROM vol_realized
    ORDER BY date ASC
  `) as Array<{ date: string; iv_rank: NumericCell }>;
  return rows.map((r) => ({
    date: r.date,
    iv_rank: r.iv_rank == null ? null : Number(r.iv_rank),
  }));
}

// ============================================================
// DAY CONTEXT (pre-computed once per trading date)
// ============================================================

interface DayContextBuild {
  date: string;
  day_open: number;
  prior_close: number;
  open_gap_pct: number;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
}

function buildDayContexts(
  bars: ReadonlyArray<RawBar>,
  vol: ReadonlyArray<VolRow>,
): Map<string, DayContextBuild> {
  // Group bars by date
  const dailyOpens = new Map<string, number>();
  const dailyCloses = new Map<string, number>();
  const datesInOrder: string[] = [];
  for (const bar of bars) {
    if (!dailyOpens.has(bar.date)) {
      dailyOpens.set(bar.date, bar.open);
      datesInOrder.push(bar.date);
    }
    dailyCloses.set(bar.date, bar.close); // last bar wins
  }

  // Build iv_rank lookup
  const ivRankByDate = new Map<string, number | null>();
  for (const v of vol) ivRankByDate.set(v.date, v.iv_rank);

  const out = new Map<string, DayContextBuild>();
  for (let i = 0; i < datesInOrder.length; i += 1) {
    const date = datesInOrder[i]!;
    const dayOpen = dailyOpens.get(date)!;
    const priorDate = i > 0 ? datesInOrder[i - 1]! : null;
    const priorClose = priorDate ? (dailyCloses.get(priorDate) ?? 0) : 0;

    const openGapPct =
      priorClose > 0 && dayOpen > 0
        ? ((dayOpen - priorClose) / priorClose) * 100
        : 0;

    // 5-day return: today's prior_close vs 5 trading days before that
    let prior5d: number | null = null;
    if (i >= 6) {
      const newer = dailyCloses.get(datesInOrder[i - 1]!) ?? 0;
      const older = dailyCloses.get(datesInOrder[i - 6]!) ?? 0;
      if (older > 0) prior5d = (newer - older) / older;
    }
    const priorIvRank = priorDate
      ? (ivRankByDate.get(priorDate) ?? null)
      : null;
    const preDayFilter =
      prior5d != null &&
      priorIvRank != null &&
      prior5d < PREDAY_5D_RET_THRESHOLD &&
      priorIvRank > PREDAY_IV_RANK_THRESHOLD;

    out.set(date, {
      date,
      day_open: dayOpen,
      prior_close: priorClose,
      open_gap_pct: openGapPct,
      prior_5d_ret: prior5d,
      prior_iv_rank: priorIvRank,
      pre_day_filter_fires: preDayFilter,
    });
  }
  return out;
}

// ============================================================
// HELPERS
// ============================================================

function getDomFromDate(d: string): number {
  return Number.parseInt(d.slice(8, 10), 10);
}

function rawBarToBar(r: RawBar): Bar {
  return {
    timestamp: new Date(r.ts_ms),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  };
}

function rawNodeToGammaNode(n: RawNode): GammaNode {
  return { strike: n.strike, value: n.value };
}

/**
 * Find the latest periscope snapshot ≤ `tsMs` AND matching the expiry of
 * the event's trading day (0DTE), AND within PERISCOPE_MAX_AGE_MIN.
 */
function findLatestSnapshot(
  snapshots: ReadonlyArray<SnapshotMeta>,
  bySnapshot: Map<string, RawNode[]>,
  tsMs: number,
  eventDate: string,
): GammaNode[] {
  const maxAgeMs = PERISCOPE_MAX_AGE_MIN * 60 * 1000;
  // Walk backwards through snapshots (sorted ASC). For tighter perf this
  // could be binary-searched; with ~4K total snapshots the linear scan
  // from the end is fast enough.
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snap = snapshots[i]!;
    if (snap.captured_ms > tsMs) continue;
    if (tsMs - snap.captured_ms > maxAgeMs) break;
    if (snap.expiry !== eventDate) continue;
    const key = `${snap.captured_ms}_${snap.expiry}`;
    return (bySnapshot.get(key) ?? []).map(rawNodeToGammaNode);
  }
  return [];
}

/**
 * ES basis at `tsMs`. Mirrors `computeEsBasisChange5m` using preloaded
 * bars: SPX's newest bar in the 6-minute window and the bar 5 rows back
 * must be exactly 5 minutes apart, and ES is read at exactly those two
 * minutes (null when either ES bar is missing), so both legs cover the
 * same minutes.
 */
function computeEsBasisAt(
  esCloseByTs: ReadonlyMap<number, number>,
  spxBars: ReadonlyArray<RawBar>,
  tsMs: number,
): number | null {
  const windowMs = 6 * 60 * 1000;
  const startMs = tsMs - windowMs;

  const spxWindow = spxBars.filter(
    (b) => b.ts_ms >= startMs && b.ts_ms <= tsMs,
  );
  if (spxWindow.length < 6) return null;
  const spxNowBar = spxWindow.at(-1)!;
  const spxThenBar = spxWindow.at(-6)!;
  if (spxNowBar.ts_ms - spxThenBar.ts_ms !== 5 * 60 * 1000) return null;

  const esNow = esCloseByTs.get(spxNowBar.ts_ms);
  const esThen = esCloseByTs.get(spxThenBar.ts_ms);
  if (esNow == null || esThen == null) return null;

  const spxNow = spxNowBar.close;
  const spxThen = spxThenBar.close;
  return esNow - esThen - (spxNow - spxThen);
}

// ============================================================
// FIRE INSERTION (batched)
// ============================================================

interface InsertableFire {
  fired_at_iso: string;
  signal_type: SignalType;
  dow_label: DowLabel;
  confidence_tier: ConfidenceTier;
  spot_at_fire: number;
  node_strike: number;
  node_gex: number;
  bar_open: number;
  bar_high: number;
  bar_low: number;
  bar_close: number;
  bar_range: number;
  es_basis_change_5m: number | null;
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
  open_gap_pct: number;
  is_fomc_day: boolean;
  is_dom_1_5: boolean;
  is_dom_16_20: boolean;
}

async function insertFires(
  sql: Sql,
  fires: ReadonlyArray<InsertableFire>,
): Promise<number> {
  if (fires.length === 0) return 0;
  // Neon's tagged template doesn't support array binding nicely; loop
  // with ON CONFLICT DO NOTHING and count RETURNING ids. Batching of
  // 500 per round-trip keeps the request payload reasonable.
  let inserted = 0;
  const batchSize = 500;
  for (let i = 0; i < fires.length; i += batchSize) {
    const batch = fires.slice(i, i + batchSize);
    for (const f of batch) {
      const rows = (await sql`
        INSERT INTO ws_gamma_setup_fires (
          fired_at, signal_type, dow_label, confidence_tier,
          spot_at_fire, node_strike, node_gex,
          bar_open, bar_high, bar_low, bar_close, bar_range,
          es_basis_change_5m, prior_5d_ret, prior_iv_rank,
          pre_day_filter_fires, open_gap_pct,
          is_fomc_day, is_dom_1_5, is_dom_16_20
        ) VALUES (
          ${f.fired_at_iso}::timestamptz,
          ${f.signal_type}, ${f.dow_label}, ${f.confidence_tier},
          ${f.spot_at_fire}, ${f.node_strike}, ${f.node_gex},
          ${f.bar_open}, ${f.bar_high}, ${f.bar_low},
          ${f.bar_close}, ${f.bar_range},
          ${f.es_basis_change_5m}, ${f.prior_5d_ret}, ${f.prior_iv_rank},
          ${f.pre_day_filter_fires}, ${f.open_gap_pct},
          ${f.is_fomc_day}, ${f.is_dom_1_5}, ${f.is_dom_16_20}
        )
        ON CONFLICT (fired_at, signal_type, node_strike) DO NOTHING
        RETURNING id
      `) as Array<{ id: number }>;
      if (rows.length > 0) inserted += 1;
    }
  }
  return inserted;
}

// ============================================================
// OUTCOME BACKFILL (mirrors api/cron/backfill-gamma-setup-outcomes.ts)
// ============================================================

function signedReturn(
  signal: SignalType,
  entryClose: number,
  endClose: number,
): number {
  if (signal === 'e5_long_put') return entryClose - endClose;
  return endClose - entryClose;
}

/**
 * Fill ret_15m/30m/60m/eod for the fires still missing ret_30m. With `bounds`
 * only fires whose `fired_at` is in `[startIso, endIso)` are touched; null
 * keeps it table-wide (a NULL bound binds to -infinity / +infinity).
 */
async function backfillOutcomes(
  sql: Sql,
  bounds: { startIso: string; endIso: string } | null,
): Promise<number> {
  const startIso = bounds?.startIso ?? null;
  const endIso = bounds?.endIso ?? null;
  const pending = (await sql`
    SELECT id, fired_at, signal_type, bar_close
    FROM ws_gamma_setup_fires
    WHERE ret_30m IS NULL
      AND fired_at >= COALESCE(${startIso}::timestamptz, '-infinity'::timestamptz)
      AND fired_at < COALESCE(${endIso}::timestamptz, 'infinity'::timestamptz)
    ORDER BY fired_at ASC
  `) as Array<{
    id: number;
    fired_at: string | Date;
    signal_type: SignalType;
    bar_close: string | number;
  }>;

  console.log(`outcome-backfill: ${pending.length} pending fires`);

  let updated = 0;
  for (const row of pending) {
    const firedAt =
      row.fired_at instanceof Date ? row.fired_at : new Date(row.fired_at);
    const entry = Number(row.bar_close);

    const fwd = async (offsetMin: number): Promise<number | null> => {
      const target = new Date(firedAt.getTime() + offsetMin * 60_000);
      const targetIso = target.toISOString();
      const rows = (await sql`
        SELECT close FROM index_candles_1m
        WHERE symbol='SPX' AND market_time='r'
          AND timestamp >= ${targetIso}::timestamptz
          AND timestamp <= ${targetIso}::timestamptz + INTERVAL '90 minutes'
        ORDER BY timestamp ASC LIMIT 1
      `) as Array<{ close: string | number }>;
      const closeVal = rows.at(0)?.close;
      if (closeVal == null) return null;
      return signedReturn(row.signal_type, entry, Number(closeVal));
    };

    const ret15 = await fwd(15);
    const ret30 = await fwd(30);
    const ret60 = await fwd(60);

    const eodRows = (await sql`
      SELECT (array_agg(close ORDER BY timestamp DESC))[1] AS close
      FROM index_candles_1m
      WHERE symbol='SPX' AND market_time='r'
        AND date = (${firedAt.toISOString()}::timestamptz AT TIME ZONE 'America/New_York')::date
        AND timestamp >= ${firedAt.toISOString()}::timestamptz
    `) as Array<{ close: NumericCell }>;
    const eodClose = eodRows.at(0)?.close;
    const retEod =
      eodClose == null
        ? null
        : signedReturn(row.signal_type, entry, Number(eodClose));

    if (ret15 == null && ret30 == null && ret60 == null && retEod == null)
      continue;

    await sql`
      UPDATE ws_gamma_setup_fires
      SET ret_15m = ${ret15},
          ret_30m = ${ret30},
          ret_60m = ${ret60},
          ret_eod = ${retEod}
      WHERE id = ${row.id}
    `;
    updated += 1;
  }
  return updated;
}

/** The closing per-signal summary: it reads ws_gamma_setup_fires. */
async function printSummary(sql: Sql): Promise<void> {
  // Surface a tiny summary so the operator knows the tile will populate.
  const summary = (await sql`
    SELECT signal_type, COUNT(*) AS n,
           SUM(CASE WHEN ret_30m > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(ret_30m)::numeric(10,2) AS mean_30m
    FROM ws_gamma_setup_fires
    GROUP BY signal_type
    ORDER BY n DESC
  `) as Array<{
    signal_type: string;
    n: string | number;
    wins: string | number;
    mean_30m: NumericCell;
  }>;
  console.log('\n=== Final ws_gamma_setup_fires summary ===');
  for (const r of summary) {
    console.log(
      `  ${r.signal_type}: n=${r.n}, wins=${r.wins}, mean_ret_30m=${r.mean_30m}`,
    );
  }
}

// ============================================================
// DETECTION
// ============================================================

/**
 * Walk every bar, simulate detection with a sliding window of 20, and return
 * the candidate fires (before the table's UNIQUE key dedupes them) plus the
 * number of bars that had a non-empty Periscope snapshot.
 */
function detectFires(
  bars: ReadonlyArray<RawBar>,
  peri: {
    bySnapshot: Map<string, RawNode[]>;
    snapshots: SnapshotMeta[];
  },
  esCloseByTs: ReadonlyMap<number, number>,
  dayCtxs: ReadonlyMap<string, DayContextBuild>,
): { fires: InsertableFire[]; evaluated: number } {
  const fires: InsertableFire[] = [];
  let evaluated = 0;

  for (let i = BAR_LOOKBACK; i < bars.length; i += 1) {
    const currentBar = bars[i]!;
    const currentDate = currentBar.date;

    // Time-of-day gate (matches production detector — only fire before 14:00 CT
    // so the +60m forward window stays inside session).
    const ct = new Date(currentBar.ts_ms).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const [hh, mm] = ct.split(':').map(Number);
    const ctMinute = (hh ?? 0) * 60 + (mm ?? 0);
    if (ctMinute >= LATEST_EVENT_CT_MINUTES) continue;

    const dayCtxBuild = dayCtxs.get(currentDate);
    if (!dayCtxBuild) continue;

    const dowLabel = getDowLabel(new Date(currentBar.ts_ms));
    if (dowLabel == null) continue;

    const dom = getDomFromDate(currentDate);
    const dayCtx: DayContext = {
      today: currentDate,
      dow_label: dowLabel,
      day_open: dayCtxBuild.day_open,
      prior_close: dayCtxBuild.prior_close,
      open_gap_pct: dayCtxBuild.open_gap_pct,
      prior_5d_ret: dayCtxBuild.prior_5d_ret,
      prior_iv_rank: dayCtxBuild.prior_iv_rank,
      pre_day_filter_fires: dayCtxBuild.pre_day_filter_fires,
      is_fomc_day: isFomcDecisionDay(currentDate),
      is_dom_1_5: dom >= 1 && dom <= 5,
      is_dom_16_20: dom >= 16 && dom <= 20,
    };

    const tier = getConfidenceTier(dowLabel, dayCtx.pre_day_filter_fires);

    // Bars window (oldest-to-newest, last 20 bars including current).
    const windowBars: Bar[] = [];
    for (let j = i - BAR_LOOKBACK + 1; j <= i; j += 1) {
      windowBars.push(rawBarToBar(bars[j]!));
    }

    // Nodes from the latest periscope snapshot ≤ currentBar.ts and
    // expiry === currentDate (0DTE) and age ≤ 10 min.
    const nodes = findLatestSnapshot(
      peri.snapshots,
      peri.bySnapshot,
      currentBar.ts_ms,
      currentDate,
    );
    if (nodes.length === 0) continue;

    evaluated += 1;

    // ES basis at this bar's ts.
    const esBasis = computeEsBasisAt(esCloseByTs, bars, currentBar.ts_ms);

    // --- E1 ---
    const e1 = detectE1(windowBars, nodes);
    if (e1 != null) {
      fires.push({
        fired_at_iso: e1.holdBar.timestamp.toISOString(),
        signal_type: 'e1_long_call',
        dow_label: dowLabel,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: e1.node.strike,
        node_gex: e1.node.value,
        bar_open: e1.breakBar.open,
        bar_high: e1.breakBar.high,
        bar_low: e1.breakBar.low,
        bar_close: e1.breakBar.close,
        bar_range: e1.breakBar.high - e1.breakBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }

    // --- E5 ---
    const e5 = detectE5(windowBars, nodes);
    if (e5 != null) {
      fires.push({
        fired_at_iso: e5.breakBar.timestamp.toISOString(),
        signal_type: 'e5_long_put',
        dow_label: dowLabel,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: e5.node.strike,
        node_gex: e5.node.value,
        bar_open: e5.breakBar.open,
        bar_high: e5.breakBar.high,
        bar_low: e5.breakBar.low,
        bar_close: e5.breakBar.close,
        bar_range: e5.breakBar.high - e5.breakBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }

    // --- PCS Monday ---
    const pcs = detectPcsMonday(windowBars, nodes, dayCtx, esBasis);
    if (pcs != null) {
      fires.push({
        fired_at_iso: pcs.wickBar.timestamp.toISOString(),
        signal_type: 'pcs_monday',
        dow_label: dowLabel,
        confidence_tier: tier,
        spot_at_fire: currentBar.close,
        node_strike: pcs.node.strike,
        node_gex: pcs.node.value,
        bar_open: pcs.wickBar.open,
        bar_high: pcs.wickBar.high,
        bar_low: pcs.wickBar.low,
        bar_close: pcs.wickBar.close,
        bar_range: pcs.wickBar.high - pcs.wickBar.low,
        es_basis_change_5m: esBasis,
        prior_5d_ret: dayCtx.prior_5d_ret,
        prior_iv_rank: dayCtx.prior_iv_rank,
        pre_day_filter_fires: dayCtx.pre_day_filter_fires,
        open_gap_pct: dayCtx.open_gap_pct,
        is_fomc_day: dayCtx.is_fomc_day,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }
  }

  return { fires, evaluated };
}

/**
 * `date  fires` per session date of the window, the fires counted once per
 * table key (fired_at, signal_type, node_strike) as the insert would keep
 * them. A session date with bars and no fires prints 0.
 */
function printDryRunCounts(
  sessionDates: Iterable<string>,
  fires: ReadonlyArray<InsertableFire>,
): void {
  const keys = new Set<string>();
  const perDate = new Map<string, number>();
  for (const f of fires) {
    const key = `${f.fired_at_iso}|${f.signal_type}|${f.node_strike}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const date = getETDateStr(new Date(f.fired_at_iso));
    perDate.set(date, (perDate.get(date) ?? 0) + 1);
  }
  console.log('date  fires');
  for (const date of sessionDates) {
    console.log(`${date}  ${perDate.get(date) ?? 0}`);
  }
}

async function runDetection(
  sql: Sql,
  args: GammaBackfillArgs,
  argv: readonly string[],
): Promise<void> {
  const { includeGexbot, from, to, clamped, cutoff } = resolveBackfillScope(
    argv,
    args.from,
    args.to,
  );
  if (includeGexbot) console.warn(GEXBOT_INCLUDE_WARNING);
  if (clamped) {
    console.warn(
      `--to ${args.to} reaches the GEXBot era; capped at ${to}. Pass --include-gexbot to read it.`,
    );
  }
  console.log(`backfill window: ${from} → ${to}`);

  const t0 = Date.now();
  console.log('loading bars + periscope + ES + vol_realized...');
  const [bars, peri, esBars, vol] = await Promise.all([
    loadBars(sql, from, to),
    loadPeriscopeNodes(sql, from, to, cutoff),
    loadEsBars(sql, from, to),
    loadVolRealized(sql),
  ]);
  console.log(
    `  bars=${bars.length}  periscope_snapshots=${peri.snapshots.length}  futures_bars_es=${esBars.length}  vol_realized=${vol.length}  (${Date.now() - t0}ms)`,
  );

  const dayCtxs = buildDayContexts(bars, vol);
  console.log(`  built day-contexts for ${dayCtxs.size} days`);
  // ES close by exact minute, for the timestamp-aligned basis lookup.
  const esCloseByTs = new Map(esBars.map((b) => [b.ts_ms, b.close]));

  const { fires, evaluated } = detectFires(bars, peri, esCloseByTs, dayCtxs);

  console.log(
    `evaluated ${evaluated} bars (with non-empty periscope snapshot), generated ${fires.length} candidate fires`,
  );

  if (args.dryRun) {
    printDryRunCounts(dayCtxs.keys(), fires);
    console.log('\ndry run: nothing written');
    return;
  }

  const inserted = await insertFires(sql, fires);
  console.log(`inserted ${inserted} new fires (rest were dupes or skipped)`);

  console.log('filling forward-return outcomes...');
  const updated = await backfillOutcomes(sql, fillBounds(args));
  console.log(`outcome backfill updated ${updated} rows`);

  console.log(`\ndone in ${(Date.now() - t0) / 1000}s`);

  await printSummary(sql);
}

/** The outcome fill's window: the explicit `--from/--to` as typed, else none. */
function fillBounds(
  args: GammaBackfillArgs,
): { startIso: string; endIso: string } | null {
  return args.windowExplicit ? etWindowBounds(args.from, args.to) : null;
}

async function runOutcomesOnly(
  sql: Sql,
  args: GammaBackfillArgs,
): Promise<void> {
  const t0 = Date.now();
  console.log(
    args.windowExplicit
      ? `outcomes-only window: ${args.from} → ${args.to} (ET session dates)`
      : 'outcomes-only window: table-wide',
  );
  console.log('filling forward-return outcomes...');
  const updated = await backfillOutcomes(sql, fillBounds(args));
  console.log(`outcome backfill updated ${updated} rows`);

  console.log(`\ndone in ${(Date.now() - t0) / 1000}s`);

  await printSummary(sql);
}

// ============================================================
// CONTEXT-ONLY (owner decision 8)
// ============================================================

interface StoredContextFire {
  session_date: string;
  prior_5d_ret: NumericCell;
  prior_iv_rank: NumericCell;
  pre_day_filter_fires: boolean;
  open_gap_pct: NumericCell;
  confidence_tier: string;
}

interface NewContext {
  prior_5d_ret: number | null;
  prior_iv_rank: number | null;
  pre_day_filter_fires: boolean;
  open_gap_pct: number;
  confidence_tier: ConfidenceTier;
}

/** A value as printed, six-ish digits: the CHANGED flag compares these. */
function formatValue(value: string | number | boolean | null): string {
  if (value == null) return 'null';
  if (typeof value === 'boolean') return String(value);
  const num = Number(value);
  return Number.isNaN(num) ? String(value) : String(Number(num.toPrecision(8)));
}

function printContextDiff(
  date: string,
  fires: ReadonlyArray<StoredContextFire>,
  next: NewContext,
): void {
  console.log(`${date}  fires=${fires.length}`);
  for (const column of CONTEXT_COLUMNS) {
    const stored = [...new Set(fires.map((f) => formatValue(f[column])))];
    const fresh = formatValue(next[column]);
    const changed = stored.length !== 1 || stored[0] !== fresh;
    console.log(
      `  ${column.padEnd(20)}  stored ${stored.join(' / ')}  new ${fresh}${changed ? '  CHANGED' : ''}`,
    );
  }
}

async function runContextOnly(
  sql: Sql,
  args: GammaBackfillArgs,
): Promise<void> {
  const { from, to } = args;
  const { startIso, endIso } = etWindowBounds(from, to);
  console.log(
    `context-only window: ${from} → ${to} (ET session dates)${args.dryRun ? ', dry run' : ''}`,
  );

  // The fires in the window, grouped by their ET session date.
  const stored = (await sql`
    SELECT TO_CHAR(fired_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS session_date,
           prior_5d_ret::float8 AS prior_5d_ret,
           prior_iv_rank::float8 AS prior_iv_rank,
           pre_day_filter_fires,
           open_gap_pct::float8 AS open_gap_pct,
           confidence_tier
    FROM ws_gamma_setup_fires
    WHERE fired_at >= ${startIso}::timestamptz
      AND fired_at < ${endIso}::timestamptz
    ORDER BY fired_at ASC
  `) as StoredContextFire[];
  const firesByDate = new Map<string, StoredContextFire[]>();
  for (const fire of stored) {
    const list = firesByDate.get(fire.session_date) ?? [];
    list.push(fire);
    firesByDate.set(fire.session_date, list);
  }
  if (firesByDate.size === 0) {
    console.log(`no fires in ${from} → ${to}; nothing to update`);
    return;
  }

  // Every read first, so a failure here leaves the table untouched.
  const planned: Array<{ date: string; next: NewContext }> = [];
  for (const date of [...firesByDate.keys()].sort()) {
    const ctx = await loadDayContext(sql, etNoon(date));
    if (ctx.dow_label == null) {
      throw new Error(`${date} is not a weekday: it has no confidence tier`);
    }
    if (!Number.isFinite(ctx.day_open) || ctx.day_open <= 0) {
      throw new Error(
        `no SPX candles for ${date}; refusing to overwrite its day context`,
      );
    }
    planned.push({
      date,
      next: {
        prior_5d_ret: ctx.prior_5d_ret,
        prior_iv_rank: ctx.prior_iv_rank,
        pre_day_filter_fires: ctx.pre_day_filter_fires,
        open_gap_pct: ctx.open_gap_pct,
        confidence_tier: getConfidenceTier(
          ctx.dow_label,
          ctx.pre_day_filter_fires,
        ),
      },
    });
  }

  if (args.dryRun) {
    for (const { date, next } of planned) {
      printContextDiff(date, firesByDate.get(date) ?? [], next);
    }
    console.log(
      `\ndry run: nothing written (${planned.length} dates, ${stored.length} fires)`,
    );
    return;
  }

  console.log('date  fires  updated');
  let totalUpdated = 0;
  for (const { date, next } of planned) {
    const day = etWindowBounds(date, date);
    let rows: Array<{ id: number }>;
    try {
      rows = (await sql`
        UPDATE ws_gamma_setup_fires
        SET prior_5d_ret = ${next.prior_5d_ret},
            prior_iv_rank = ${next.prior_iv_rank},
            pre_day_filter_fires = ${next.pre_day_filter_fires},
            open_gap_pct = ${next.open_gap_pct},
            confidence_tier = ${next.confidence_tier}
        WHERE fired_at >= ${day.startIso}::timestamptz
          AND fired_at < ${day.endIso}::timestamptz
        RETURNING id
      `) as Array<{ id: number }>;
    } catch (err) {
      throw new Error(
        `updating ${date} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    totalUpdated += rows.length;
    console.log(
      `${date}  ${firesByDate.get(date)?.length ?? 0}  ${rows.length}`,
    );
  }
  console.log(
    `\ncontext-only: ${planned.length} dates, ${stored.length} fires, ${totalUpdated} updated`,
  );
}

// ============================================================
// ENTRY
// ============================================================

/**
 * Run the backfill the way the script's argv asks. Resolves to the exit code:
 * 0 done, 1 any failure (a DB error included: nothing past it is reported as
 * success), 2 a bad flag or combination, with nothing run.
 */
export async function runGammaBackfill(
  argv: readonly string[],
  sql: Sql,
): Promise<number> {
  let args: GammaBackfillArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  try {
    if (args.contextOnly) await runContextOnly(sql, args);
    else if (args.outcomesOnly) await runOutcomesOnly(sql, args);
    else await runDetection(sql, args, argv);
    return 0;
  } catch (err) {
    console.error('gamma-setup-fires backfill failed:', err);
    return 1;
  }
}
