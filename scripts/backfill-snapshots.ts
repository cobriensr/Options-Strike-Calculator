/**
 * Bulk-load historical strike_iv_snapshots rows from the per-minute
 * aggregate JSONL files produced by `backfill-aggregate.py`.
 *
 * Mirrors production's filter shape so the chart drilldown shows the
 * same density of data points as live:
 *   - OTM ±3% (index/broad ETF) or ±5% (single name + sector ETF)
 *   - Per-ticker OI floor (STRIKE_IV_MIN_OI_*)
 *   - Skip rows where iv_mid couldn't be inverted
 *
 * Differs from production in two ways (both intentional, neither lossy
 * for chart rendering):
 *   - `mid_price` = volume-weighted trade price within the minute
 *     bucket (production stores quote-midpoint at snapshot time;
 *     trade-weighted price is a close analog).
 *   - No real-time stamping — `ts` is the bucket minute from the CSV.
 *
 * Inserts in batches of BATCH_SIZE rows per multi-row VALUES statement
 * to keep the per-row Neon roundtrip cost amortized. ~3M rows in
 * ~100-300 batches @ ~200ms each ≈ 1-2 min total.
 *
 * Usage:
 *     npx tsx scripts/backfill-snapshots.ts
 *     npx tsx scripts/backfill-snapshots.ts --clear-historical  # delete 4/13-4/24 first
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STRIKE_IV_MIN_OI_CASH_INDEX,
  STRIKE_IV_MIN_OI_SPY_QQQ,
  STRIKE_IV_MIN_OI_IWM,
  STRIKE_IV_MIN_OI_SECTOR_ETF,
  STRIKE_IV_MIN_OI_HIGH_LIQ,
  STRIKE_IV_MIN_OI_SINGLE_NAME,
  STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX,
  STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF,
  STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME,
  type StrikeIVTicker,
} from '../api/_lib/constants.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Inline .env.local loader (no dotenv dep)
const envContent = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
for (const line of envContent.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && m[1] && m[2] !== undefined) {
    process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

const BUCKETS_DIR = join(
  REPO_ROOT,
  'scripts/eod-flow-analysis/output/backfill-buckets',
);
const BATCH_SIZE = 1000;

const CASH_INDEX = new Set<string>(['SPXW', 'NDXP']);
const BROAD_ETF = new Set<string>(['SPY', 'QQQ', 'IWM']);

function minOiFor(ticker: string): number {
  switch (ticker) {
    case 'SPXW':
    case 'NDXP':
      return STRIKE_IV_MIN_OI_CASH_INDEX;
    case 'SPY':
    case 'QQQ':
      return STRIKE_IV_MIN_OI_SPY_QQQ;
    case 'IWM':
      return STRIKE_IV_MIN_OI_IWM;
    case 'SMH':
      return STRIKE_IV_MIN_OI_SECTOR_ETF;
    case 'NVDA':
    case 'TSLA':
    case 'META':
    case 'MSFT':
      return STRIKE_IV_MIN_OI_HIGH_LIQ;
    case 'SNDK':
    case 'MSTR':
    case 'MU':
      return STRIKE_IV_MIN_OI_SINGLE_NAME;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

function otmRangePctFor(ticker: string): number {
  if (CASH_INDEX.has(ticker)) return STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX;
  if (BROAD_ETF.has(ticker)) return STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF;
  return STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME;
}

interface AggBucket {
  ticker: string;
  strike: number;
  opt_side: 'call' | 'put';
  expiry: string;
  ts: string;
  iv_mid: number | null;
  iv_ask: number | null;
  iv_bid: number | null;
  mid_price: number | null;
  volume: number;
  oi: number;
  spot: number;
}

interface SnapshotRow {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  spot: number;
  iv_mid: number;
  iv_bid: number | null;
  iv_ask: number | null;
  mid_price: number | null;
  oi: number;
  volume: number;
  ts: string;
}

function normalizeTs(ts: string): string {
  let normalized = ts.replace(' ', 'T');
  normalized = normalized.replace(/([+-])(\d{2})$/, '$1$2:00');
  return new Date(normalized).toISOString();
}

async function loadNqByMinute(date: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT ts, close
    FROM futures_bars
    WHERE symbol = 'NQ'
      AND ts >= ${date + 'T00:00:00Z'}::timestamptz
      AND ts <  ${date + 'T23:59:59Z'}::timestamptz
  `) as Array<{ ts: string | Date; close: string | number }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    const tsIso =
      r.ts instanceof Date ? r.ts.toISOString() : new Date(r.ts).toISOString();
    map.set(tsIso, Number(r.close));
  }
  return map;
}

function effectiveSpot(b: AggBucket, nqByMinute: Map<string, number>, tsIso: string): number {
  // NDX/NDXP: prefer NQ futures (Databento) over the QQQ-derived spot
  // baked into the JSONL. NQ tracks NDX with ~0.3% basis vs QQQ × 40.5
  // which is ~1% off — meaningful for chart/spot accuracy.
  if (b.ticker === 'NDXP' || b.ticker === 'NDX') {
    const nq = nqByMinute.get(tsIso);
    if (nq != null) return nq;
  }
  return b.spot;
}

function passesGates(b: AggBucket, spot: number): boolean {
  if (b.iv_mid == null || !Number.isFinite(b.iv_mid) || b.iv_mid <= 0) {
    return false;
  }
  if (b.oi < minOiFor(b.ticker)) return false;
  const range = otmRangePctFor(b.ticker);
  const lower = spot * (1 - range);
  const upper = spot * (1 + range);
  if (b.opt_side === 'call' && b.strike <= spot) return false;
  if (b.opt_side === 'put' && b.strike >= spot) return false;
  if (b.strike < lower || b.strike > upper) return false;
  return true;
}

async function insertBatch(rows: SnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Build a single multi-row VALUES INSERT. The Neon serverless driver's
  // tagged-template form would issue one statement per row — for 3M rows
  // that's hours of network roundtrips. Using parameterized placeholders
  // ($1, $2, …) lets us batch BATCH_SIZE rows per call.
  const cols = 12;
  const placeholders = rows
    .map((_, i) => {
      const base = i * cols;
      const parts: string[] = [];
      for (let j = 1; j <= cols; j += 1) parts.push(`$${base + j}`);
      return `(${parts.join(',')})`;
    })
    .join(',');

  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.ticker,
      r.strike,
      r.side,
      r.expiry,
      r.spot,
      r.iv_mid,
      r.iv_bid,
      r.iv_ask,
      r.mid_price,
      r.oi,
      r.volume,
      r.ts,
    );
  }

  await sql.query(
    `INSERT INTO strike_iv_snapshots (
       ticker, strike, side, expiry, spot,
       iv_mid, iv_bid, iv_ask, mid_price,
       oi, volume, ts
     ) VALUES ${placeholders}`,
    params,
  );
}

async function processFile(filename: string): Promise<number> {
  const filepath = join(BUCKETS_DIR, filename);
  const content = readFileSync(filepath, 'utf8').trim();
  if (!content) return 0;

  const date = filename.replace('-buckets.jsonl', '');
  const nqByMinute = await loadNqByMinute(date);

  const lines = content.split('\n');
  let kept = 0;
  let batch: SnapshotRow[] = [];

  for (const line of lines) {
    const b = JSON.parse(line) as AggBucket;
    const tsIso = normalizeTs(b.ts);
    const spot = effectiveSpot(b, nqByMinute, tsIso);
    if (!passesGates(b, spot)) continue;
    batch.push({
      ticker: b.ticker as StrikeIVTicker,
      strike: b.strike,
      side: b.opt_side,
      expiry: b.expiry,
      spot,
      iv_mid: b.iv_mid as number, // gated above
      iv_bid: b.iv_bid,
      iv_ask: b.iv_ask,
      mid_price: b.mid_price,
      oi: b.oi,
      volume: Math.round(b.volume),
      ts: tsIso,
    });
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      kept += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(batch);
    kept += batch.length;
  }
  return kept;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--clear-historical')) {
    const result = (await sql`
      DELETE FROM strike_iv_snapshots
      WHERE ts < '2026-04-25'::timestamptz
      RETURNING id
    `) as Array<{ id: number }>;
    console.log(`Cleared ${result.length} historical strike_iv_snapshots rows`);
  }

  const files = readdirSync(BUCKETS_DIR)
    .filter((f) => f.endsWith('-buckets.jsonl'))
    .sort();

  if (files.length === 0) {
    console.error(`No bucket files in ${BUCKETS_DIR}`);
    process.exit(1);
  }

  let total = 0;
  for (const f of files) {
    process.stderr.write(`[load] ${f}... `);
    const n = await processFile(f);
    process.stderr.write(`${n.toLocaleString()} rows\n`);
    total += n;
  }
  console.log(
    `\nTotal: ${total.toLocaleString()} rows inserted into strike_iv_snapshots`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
