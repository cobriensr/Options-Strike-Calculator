/**
 * Stage 2 of the iv_anomalies full-replay backfill.
 *
 * Consumes per-minute aggregate JSONL files from `backfill-aggregate.py`,
 * runs the SAME `detectAnomalies()` and `classifyFlowPhase()` functions
 * the live cron uses, and inserts the resulting flags into `iv_anomalies`
 * with a `'backfill'` marker in `flag_reasons` so they're distinguishable
 * from production rows.
 *
 * Zero drift from production logic: imports the actual detector module
 * (`api/_lib/iv-anomaly.ts`). Whatever fires here would have fired in
 * production given the same data. The only thing that's NOT replayed is
 * `context_snapshot` — cross-asset fields (VIX, GEX, dark prints) require
 * data from other tables that wasn't captured for the historical dates.
 * Those fields stay null on backfill rows.
 *
 * Usage:
 *     npx tsx scripts/backfill-detect.ts
 *     npx tsx scripts/backfill-detect.ts --clear-existing  # delete prior backfill rows first
 */

import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectAnomalies,
  classifyFlowPhase,
  strikeKey,
  type StrikeSample,
} from '../api/_lib/iv-anomaly.ts';
import { Z_WINDOW_SIZE } from '../api/_lib/constants.ts';
import type { ContextSnapshot } from '../api/_lib/anomaly-context.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

loadEnv({ path: join(REPO_ROOT, '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set — load .env.local first');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const BUCKETS_DIR = join(
  REPO_ROOT,
  'scripts/eod-flow-analysis/output/backfill-buckets',
);

interface AggBucket {
  ticker: string;
  strike: number;
  opt_side: 'call' | 'put';
  expiry: string;
  ts: string;
  iv_mid: number | null;
  iv_ask: number | null;
  iv_bid: number | null;
  volume: number;
  oi: number;
  spot: number;
}

function makeEmptyContext(): ContextSnapshot {
  return {
    spot_delta_5m: null,
    spot_delta_15m: null,
    spot_delta_60m: null,
    vwap_distance: null,
    volume_percentile: null,
    spx_delta_15m: null,
    spy_delta_15m: null,
    qqq_delta_15m: null,
    iwm_delta_15m: null,
    es_delta_15m: null,
    nq_delta_15m: null,
    ym_delta_15m: null,
    rty_delta_15m: null,
    nq_ofi_1h: null,
    vix_level: null,
    vix_delta_5m: null,
    vix_delta_15m: null,
    vix_term_1d: null,
    vix_term_9d: null,
    vix_30d_spot: null,
    dxy_delta_15m: null,
    tlt_delta_15m: null,
    gld_delta_15m: null,
    uso_delta_15m: null,
    recent_flow_alerts: [],
    spx_recent_dark_prints: [],
    econ_release_t_minus: null,
    econ_release_t_plus: null,
    econ_release_name: null,
    institutional_program_latest: null,
    net_flow_5m: null,
    nope_current: null,
    put_premium_0dte_pctile: null,
    zero_gamma_level: null,
    zero_gamma_distance_pct: null,
  };
}

function bucketToSample(b: AggBucket): StrikeSample {
  // DuckDB outputs `YYYY-MM-DD HH:mm:ss±HH` (space-sep, ±HH offset with
  // no minutes). JS Date.parse needs `±HH:MM`, so we normalize to that.
  let normalized = b.ts.replace(' ', 'T');
  // Match a trailing ±HH that's NOT already ±HH:MM
  normalized = normalized.replace(/([+-])(\d{2})$/, '$1$2:00');
  const tsIso = new Date(normalized).toISOString();
  return {
    ticker: b.ticker,
    strike: b.strike,
    side: b.opt_side,
    expiry: b.expiry,
    iv_mid: b.iv_mid,
    iv_bid: b.iv_bid,
    iv_ask: b.iv_ask,
    volume: b.volume,
    oi: b.oi,
    ts: tsIso,
  };
}

async function processFile(filename: string): Promise<number> {
  const filepath = join(BUCKETS_DIR, filename);
  const content = readFileSync(filepath, 'utf8').trim();
  if (!content) return 0;

  const buckets: AggBucket[] = content
    .split('\n')
    .map((line) => JSON.parse(line) as AggBucket);

  // Group by (ticker, minute) so each chronological step processes a full
  // ticker snapshot — same shape the live cron operates on.
  const byTickerMinute = new Map<string, AggBucket[]>();
  for (const b of buckets) {
    const key = `${b.ticker}|${b.ts}`;
    const existing = byTickerMinute.get(key);
    if (existing) existing.push(b);
    else byTickerMinute.set(key, [b]);
  }
  // Sort by minute then ticker so history accumulates correctly across
  // tickers within the same minute.
  const sortedKeys = [...byTickerMinute.keys()].sort((a, b) => {
    const [tickerA, tsA] = a.split('|');
    const [tickerB, tsB] = b.split('|');
    if (tsA !== tsB) return tsA!.localeCompare(tsB!);
    return tickerA!.localeCompare(tickerB!);
  });

  // Per-ticker rolling history Map<strikeKey, StrikeSample[]> — DESC by ts,
  // matching what loadHistoryForTicker() returns in production.
  const historyByTicker = new Map<string, Map<string, StrikeSample[]>>();
  let inserted = 0;

  for (const key of sortedKeys) {
    const [ticker, ts] = key.split('|');
    if (!ticker || !ts) continue;

    const minuteBucket = byTickerMinute.get(key)!;
    const samples = minuteBucket.map(bucketToSample);
    const spot = minuteBucket[0]!.spot;

    let history = historyByTicker.get(ticker);
    if (!history) {
      history = new Map<string, StrikeSample[]>();
      historyByTicker.set(ticker, history);
    }

    const flags = detectAnomalies(samples, history, spot);

    if (flags.length > 0) {
      const ctx = makeEmptyContext();
      const ctxJson = JSON.stringify(ctx);
      for (const flag of flags) {
        const flowPhase = classifyFlowPhase(flag, ctx);
        const flagReasons = [...flag.flag_reasons, 'backfill'];
        // Clamp side_skew to [0, 1] before insert. Production gets this
        // from BS-inverted quote IVs which have a well-formed spread,
        // but the backfill's per-trade IV averaging can produce
        // degenerate spreads (iv_ask ≈ iv_bid) that blow up the
        // ratio. NUMERIC(4,3) caps at 9.999.
        const clampedSideSkew =
          flag.side_skew == null
            ? null
            : Math.min(1, Math.max(0, flag.side_skew));
        await sql`
          INSERT INTO iv_anomalies (
            ticker, strike, side, expiry,
            spot_at_detect, iv_at_detect,
            skew_delta, z_score, ask_mid_div, vol_oi_ratio,
            side_skew, side_dominant,
            flag_reasons, flow_phase, context_snapshot, ts
          ) VALUES (
            ${flag.ticker}, ${flag.strike}, ${flag.side}, ${flag.expiry},
            ${flag.spot_at_detect}, ${flag.iv_at_detect},
            ${flag.skew_delta}, ${flag.z_score}, ${flag.ask_mid_div}, ${flag.vol_oi_ratio},
            ${clampedSideSkew}, ${flag.side_dominant},
            ${flagReasons}, ${flowPhase}, ${ctxJson}::jsonb,
            ${flag.ts}
          )
        `;
        inserted += 1;
      }
    }

    // Append this minute's samples to history buffer (DESC by ts ⇒ unshift).
    for (const s of samples) {
      const k = strikeKey(s.ticker, s.strike, s.side, s.expiry);
      let buf = history.get(k);
      if (!buf) {
        buf = [];
        history.set(k, buf);
      }
      buf.unshift(s);
      if (buf.length > Z_WINDOW_SIZE) buf.length = Z_WINDOW_SIZE;
    }
  }

  return inserted;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--clear-existing')) {
    const result = (await sql`
      DELETE FROM iv_anomalies
      WHERE 'backfill' = ANY(flag_reasons)
      RETURNING id
    `) as Array<{ id: number }>;
    console.log(`Cleared ${result.length} prior backfill rows`);
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
    process.stderr.write(`[replay] ${f}... `);
    const n = await processFile(f);
    process.stderr.write(`${n} alerts inserted\n`);
    total += n;
  }
  console.log(`\nTotal: ${total} alerts inserted into iv_anomalies`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
