#!/usr/bin/env node
/**
 * One-off audit: replay Silent Boom detector logic against AMZN 265C
 * 5/27 on 2026-05-21 (CT) to identify which threshold(s) gated out the
 * early-morning large-volume candles before the 10:25 CT x219 burst
 * finally fired. Read-only — no writes.
 *
 * Detector predicate (api/_lib/silent-boom.ts):
 *   1. cooldown:          ≥60 min since last fire on this chain
 *   2. silence:           median of prior 4 traded buckets ≤ 500
 *   3. absolute spike:    current bucket size ≥ 1,000
 *   4. spike ratio:       current ≥ 5.0 × max(baseline_median, 100)
 *   5. ask dominance:     ask_size / (ask_size + bid_size) ≥ 0.70
 *   6. OI floor:          max OI for chain ≥ 100
 *   7. vol/OI ratio:      size / maxOi ≥ 0.25
 *   8. multi-leg cap:     multi-leg share < 0.70
 *
 * Usage:
 *   node scripts/audit-silent-boom-amzn-2026-05-21.mjs
 */

import { neon } from '@neondatabase/serverless';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: '.env.local' });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set — run `vercel env pull .env.local`');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const TICKER = 'AMZN';
const STRIKE = 265;
const OPTION_TYPE = 'C';
const EXPIRY = '2026-05-27';
const DATE_START_UTC = '2026-05-21T13:30:00Z'; // 08:30 CT
const DATE_END_UTC = '2026-05-21T16:00:00Z'; // 11:00 CT

const SPEC = {
  baselineBuckets: 4,
  baselineMedianMax: 500,
  minSpikeVol: 1_000,
  spikeMultiplier: 5.0,
  askPctMin: 0.7,
  volOiMin: 0.25,
  cooldownMin: 60,
  minOi: 100,
  multiLegShareMax: 0.7,
};

const MULTI_LEG_CODES = new Set([
  'mlat',
  'mlet',
  'mlft',
  'mfto',
  'masl',
  'mesl',
  'mfsl',
  'mlct',
]);

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function fmt(n, places = 2) {
  return Number.isFinite(n) ? n.toFixed(places) : '—';
}

console.log(
  `\n=== Silent Boom replay: ${TICKER} ${STRIKE}${OPTION_TYPE} ${EXPIRY} ===`,
);
console.log(`Window: ${DATE_START_UTC} → ${DATE_END_UTC} (8:30–11:00 CT)\n`);

const rows = await sql`
  SELECT
    date_bin(INTERVAL '5 minutes', executed_at, TIMESTAMPTZ '2026-01-01') AS bucket_ts,
    SUM(size)::int AS size,
    SUM(CASE WHEN side = 'ask' THEN size ELSE 0 END)::int AS ask_size,
    SUM(CASE WHEN side = 'bid' THEN size ELSE 0 END)::int AS bid_size,
    SUM(CASE WHEN raw_payload->>'trade_code' IN (
      'mlat','mlet','mlft','mfto','masl','mesl','mfsl','mlct'
    ) THEN size ELSE 0 END)::int AS multi_leg_size,
    MAX(open_interest)::int AS max_oi,
    COUNT(*)::int AS print_count
  FROM ws_option_trades
  WHERE ticker = ${TICKER}
    AND strike = ${STRIKE}
    AND option_type = ${OPTION_TYPE}
    AND expiry = ${EXPIRY}
    AND executed_at >= ${DATE_START_UTC}
    AND executed_at < ${DATE_END_UTC}
    AND canceled = FALSE
    AND price > 0
  GROUP BY bucket_ts
  ORDER BY bucket_ts ASC
`;

if (rows.length === 0) {
  console.log(
    'No trades found in the window. Check ticker/strike/expiry or date.',
  );
  process.exit(0);
}

console.log(`Found ${rows.length} traded 5-min buckets.\n`);

// Replay the detector
const baseline = [];
let lastFireMs = null;
const fires = [];
const blocked = [];

const COL_FMT = '%-13s %6s %5s %5s %5s %5s %6s %5s | %-10s';
console.log(
  'bucket(CT)    size  ask% mlSh maxOI volOi spike base | result/why',
);
console.log('─'.repeat(110));

for (const row of rows) {
  const bucketMs = new Date(row.bucket_ts).getTime();
  const ctTime = new Date(bucketMs - 5 * 3600 * 1000)
    .toISOString()
    .slice(11, 16);
  const size = row.size;
  const askBid = row.ask_size + row.bid_size;
  const askPct = askBid > 0 ? row.ask_size / askBid : 0;
  const mlShare = size > 0 ? row.multi_leg_size / size : 0;
  const maxOi = row.max_oi || 0;
  const volOi = maxOi > 0 ? size / maxOi : 0;
  const baselineMed = median(baseline);
  const baselineRef = Math.max(baselineMed, 100);
  const spikeRatio = baselineRef > 0 ? size / baselineRef : 0;

  // Gate checks (sequential, like the detector)
  const fails = [];
  if (lastFireMs != null && bucketMs - lastFireMs < SPEC.cooldownMin * 60_000) {
    fails.push('cooldown');
  }
  if (
    baseline.length >= SPEC.baselineBuckets &&
    baselineMed > SPEC.baselineMedianMax
  ) {
    fails.push(`silence(med=${baselineMed.toFixed(0)})`);
  }
  if (size < SPEC.minSpikeVol) fails.push(`spike(${size}<1000)`);
  if (size < SPEC.spikeMultiplier * baselineRef) {
    fails.push(`ratio(${spikeRatio.toFixed(1)}x<5x)`);
  }
  if (askPct < SPEC.askPctMin)
    fails.push(`ask%(${(askPct * 100).toFixed(0)}<70)`);
  if (maxOi < SPEC.minOi) fails.push(`oi(${maxOi}<100)`);
  if (volOi < SPEC.volOiMin)
    fails.push(`volOi(${(volOi * 100).toFixed(0)}%<25%)`);
  if (mlShare >= SPEC.multiLegShareMax)
    fails.push(`ml(${(mlShare * 100).toFixed(0)}%≥70%)`);

  // Need ≥ baselineBuckets prior data to even be eligible
  const eligible = baseline.length >= SPEC.baselineBuckets;
  const result = !eligible
    ? `WARM(${baseline.length}/4 priors)`
    : fails.length === 0
      ? 'FIRE ★'
      : fails.join(',');

  console.log(
    `${ctTime.padEnd(13)} ${String(size).padStart(6)} ` +
      `${(askPct * 100).toFixed(0).padStart(4)}%  ` +
      `${(mlShare * 100).toFixed(0).padStart(3)}% ` +
      `${String(maxOi).padStart(5)} ` +
      `${(volOi * 100).toFixed(0).padStart(4)}% ` +
      `${spikeRatio.toFixed(1).padStart(5)}x ` +
      `${baselineMed.toFixed(0).padStart(5)} | ${result}`,
  );

  if (eligible && fails.length === 0) {
    fires.push({ ctTime, size, askPct, mlShare, maxOi, volOi, spikeRatio });
    lastFireMs = bucketMs;
  } else {
    blocked.push({ ctTime, size, fails });
  }

  baseline.push(size);
  if (baseline.length > SPEC.baselineBuckets) baseline.shift();
}

console.log('\n=== Summary ===');
console.log(`Fires:  ${fires.length}`);
console.log(`Blocked: ${blocked.length}`);
if (fires.length > 0) {
  for (const f of fires) {
    console.log(
      `  ★ ${f.ctTime} size=${f.size} ask=${(f.askPct * 100).toFixed(0)}% volOi=${(f.volOi * 100).toFixed(0)}% spike=${f.spikeRatio.toFixed(1)}x`,
    );
  }
}
