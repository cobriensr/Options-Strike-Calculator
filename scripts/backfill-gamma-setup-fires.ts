#!/usr/bin/env tsx
/**
 * One-shot backfill of ws_gamma_setup_fires from historical SPX 1-min
 * candles + periscope_snapshots + futures_bars (ES) + vol_realized.
 *
 * Walks every RTH minute since the index_candles_1m table was populated
 * (~2026-02-26) and simulates what the live `detect-gamma-setups` cron
 * would have inserted at each minute. Uses the production
 * `api/_lib/gamma-detector.ts` pure functions directly so the backfill
 * is cycle-accurate with what live will produce going forward.
 *
 * After the bar-by-bar pass completes, also fills ret_15/30/60m/eod
 * for every inserted fire by replaying the EOD-outcome backfill logic
 * inline (so we end up with a fully-resolved historical ledger in one
 * pass).
 *
 * Run:   npx tsx scripts/backfill-gamma-setup-fires.ts
 * Args:  --from YYYY-MM-DD --to YYYY-MM-DD  (default: all available history)
 *
 * Idempotent: UNIQUE(fired_at, signal_type, node_strike) on the table +
 * `ON CONFLICT DO NOTHING` on insert means re-running is safe and only
 * inserts new fires. Re-running the outcome fill also only touches rows
 * where ret_30m is still NULL.
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

import {
  detectE1,
  detectE5,
  detectPcsMonday,
  getConfidenceTier,
  getDowLabel,
  PREDAY_5D_RET_THRESHOLD,
  PREDAY_IV_RANK_THRESHOLD,
  PERISCOPE_MAX_AGE_MIN,
  type Bar,
  type ConfidenceTier,
  type DayContext,
  type DowLabel,
  type GammaNode,
  type SignalType,
} from '../api/_lib/gamma-detector.js';

config({ path: '.env.local' });

const SQL_URL =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';
if (!SQL_URL) throw new Error('DATABASE_URL_UNPOOLED not set');

const sql = neon(SQL_URL);

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_FROM = '2026-02-26'; // earliest SPX candle data
const DEFAULT_TO = '2026-05-22';
const LATEST_EVENT_CT_MINUTES = 14 * 60; // skip post-14:00 CT events (matches detector)
const BAR_LOOKBACK = 20; // matches detect-gamma-setups (loadRecentBars)

// ============================================================
// CLI ARGS
// ============================================================

function parseArgs(): { from: string; to: string } {
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from' && argv[i + 1]) {
      from = argv[i + 1]!;
      i += 1;
    } else if (argv[i] === '--to' && argv[i + 1]) {
      to = argv[i + 1]!;
      i += 1;
    }
  }
  return { from, to };
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

async function loadBars(from: string, to: string): Promise<RawBar[]> {
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
  from: string,
  to: string,
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

type IvRankRaw = string | number | null;

async function loadVolRealized(): Promise<VolRow[]> {
  const rows = (await sql`
    SELECT date::text AS date, iv_rank
    FROM vol_realized
    ORDER BY date ASC
  `) as Array<{ date: string; iv_rank: IvRankRaw }>;
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
 * ES basis at `tsMs`: last-bar minus 5-bars-ago for both ES and SPX
 * inside a 6-minute window. Mirrors `computeEsBasisChange5m` semantics
 * using preloaded arrays.
 */
function computeEsBasisAt(
  esBars: ReadonlyArray<{ ts_ms: number; close: number }>,
  spxBars: ReadonlyArray<RawBar>,
  tsMs: number,
): number | null {
  const windowMs = 6 * 60 * 1000;
  const startMs = tsMs - windowMs;

  const esWindow = esBars.filter((b) => b.ts_ms >= startMs && b.ts_ms <= tsMs);
  if (esWindow.length < 6) return null;
  const spxWindow = spxBars.filter(
    (b) => b.ts_ms >= startMs && b.ts_ms <= tsMs,
  );
  if (spxWindow.length < 6) return null;

  const esNow = esWindow[esWindow.length - 1]!.close;
  const esThen = esWindow[esWindow.length - 6]!.close;
  const spxNow = spxWindow[spxWindow.length - 1]!.close;
  const spxThen = spxWindow[spxWindow.length - 6]!.close;
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

async function backfillOutcomes(): Promise<number> {
  const pending = (await sql`
    SELECT id, fired_at, signal_type, bar_close
    FROM ws_gamma_setup_fires
    WHERE ret_30m IS NULL
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
    `) as Array<{ close: string | number | null }>;
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

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const { from, to } = parseArgs();
  console.log(`backfill window: ${from} → ${to}`);

  const t0 = Date.now();
  console.log('loading bars + periscope + ES + vol_realized...');
  const [bars, peri, esBars, vol] = await Promise.all([
    loadBars(from, to),
    loadPeriscopeNodes(from, to),
    loadEsBars(from, to),
    loadVolRealized(),
  ]);
  console.log(
    `  bars=${bars.length}  periscope_snapshots=${peri.snapshots.length}  es_bars=${esBars.length}  vol_realized=${vol.length}  (${Date.now() - t0}ms)`,
  );

  const dayCtxs = buildDayContexts(bars, vol);
  console.log(`  built day-contexts for ${dayCtxs.size} days`);

  // Walk every bar, simulate detection. Need a sliding window of 20.
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
      is_fomc_day: false, // not wired to economic_events for backfill
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
    const esBasis = computeEsBasisAt(esBars, bars, currentBar.ts_ms);

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
        is_fomc_day: false,
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
        is_fomc_day: false,
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
        is_fomc_day: false,
        is_dom_1_5: dayCtx.is_dom_1_5,
        is_dom_16_20: dayCtx.is_dom_16_20,
      });
    }
  }

  console.log(
    `evaluated ${evaluated} bars (with non-empty periscope snapshot), generated ${fires.length} candidate fires`,
  );

  const inserted = await insertFires(fires);
  console.log(`inserted ${inserted} new fires (rest were dupes or skipped)`);

  console.log('filling forward-return outcomes...');
  const updated = await backfillOutcomes();
  console.log(`outcome backfill updated ${updated} rows`);

  console.log(`\ndone in ${(Date.now() - t0) / 1000}s`);

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
    mean_30m: string | number | null;
  }>;
  console.log('\n=== Final ws_gamma_setup_fires summary ===');
  for (const r of summary) {
    console.log(
      `  ${r.signal_type}: n=${r.n}, wins=${r.wins}, mean_ret_30m=${r.mean_30m}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
