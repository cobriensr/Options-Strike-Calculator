/**
 * Audit: zero-gamma sign-convention + sample levels vs ATM strikes.
 *
 * 1. Inspect strike_exposures sign distributions for call_gamma_oi and
 *    put_gamma_oi — do dealers' calls really come in as positive and
 *    puts as negative? Are they "dealer perspective" or "customer
 *    perspective"?
 *
 * 2. Pull recent zero_gamma_levels rows for SPX/SPY/QQQ — do the
 *    derived levels look sane (within ±3% of spot)?
 *
 * 3. Look at the underlying gamma profile around spot for SPY — does
 *    it actually cross sign somewhere, or are most strikes the same
 *    sign (which would invalidate the "find the crossing" approach)?
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const sql = neon(url);

console.log('=== 1. Sign conventions on most-recent strike_exposures rows ===');
for (const ticker of ['SPX', 'SPY', 'QQQ']) {
  const rows = await sql`
    SELECT
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE call_gamma_oi::numeric > 0) AS call_pos,
      COUNT(*) FILTER (WHERE call_gamma_oi::numeric < 0) AS call_neg,
      COUNT(*) FILTER (WHERE put_gamma_oi::numeric > 0)  AS put_pos,
      COUNT(*) FILTER (WHERE put_gamma_oi::numeric < 0)  AS put_neg,
      AVG(call_gamma_oi::numeric) AS call_avg,
      AVG(put_gamma_oi::numeric) AS put_avg
    FROM strike_exposures
    WHERE ticker = ${ticker}
      AND timestamp = (SELECT MAX(timestamp) FROM strike_exposures WHERE ticker = ${ticker})
  `;
  const r = rows[0] ?? {};
  console.log(`  ${ticker}:`, {
    n: Number(r.n),
    calls_pos: Number(r.call_pos),
    calls_neg: Number(r.call_neg),
    puts_pos: Number(r.put_pos),
    puts_neg: Number(r.put_neg),
    call_avg: r.call_avg != null ? Number(r.call_avg).toFixed(2) : null,
    put_avg: r.put_avg != null ? Number(r.put_avg).toFixed(2) : null,
  });
}

console.log('\n=== 2. Recent zero_gamma_levels ===');
const recent = await sql`
  SELECT ticker, spot, zero_gamma, confidence, net_gamma_at_spot, ts
  FROM zero_gamma_levels
  WHERE ts > now() - interval '5 days'
  ORDER BY ts DESC
  LIMIT 20
`;
for (const r of recent) {
  const distancePct =
    r.zero_gamma != null
      ? (((Number(r.zero_gamma) - Number(r.spot)) / Number(r.spot)) * 100).toFixed(2)
      : null;
  console.log(
    `  ${r.ts.toISOString?.() ?? r.ts}  ${r.ticker.padEnd(4)}  spot=${Number(r.spot).toFixed(2)}  zg=${r.zero_gamma != null ? Number(r.zero_gamma).toFixed(2) : 'null'}  Δ=${distancePct ?? '—'}%  conf=${Number(r.confidence).toFixed(2)}  netγ@spot=${r.net_gamma_at_spot != null ? Number(r.net_gamma_at_spot).toFixed(0) : 'null'}`,
  );
}

console.log('\n=== 3. SPY gamma profile around spot (most-recent snapshot) ===');
const profile = await sql`
  WITH latest AS (
    SELECT MAX(timestamp) AS ts FROM strike_exposures WHERE ticker = 'SPY'
  )
  SELECT strike::numeric AS strike,
         price::numeric  AS spot,
         call_gamma_oi::numeric AS call_g,
         put_gamma_oi::numeric  AS put_g,
         (call_gamma_oi::numeric + put_gamma_oi::numeric) AS net_g
  FROM strike_exposures
  WHERE ticker = 'SPY' AND timestamp = (SELECT ts FROM latest)
  ORDER BY strike ASC
`;
if (profile.length === 0) {
  console.log('  (no rows)');
} else {
  const spot = Number(profile[0].spot);
  console.log(`  spot=${spot.toFixed(2)}`);
  // Show 5 strikes below and 5 above spot
  const sorted = profile
    .map((r) => ({
      strike: Number(r.strike),
      call_g: Number(r.call_g),
      put_g: Number(r.put_g),
      net_g: Number(r.net_g),
    }))
    .sort((a, b) => a.strike - b.strike);
  // Identify nearest to spot
  let nearestIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[nearestIdx].strike - spot)) {
      nearestIdx = i;
    }
  }
  const lo = Math.max(0, nearestIdx - 5);
  const hi = Math.min(sorted.length, nearestIdx + 6);
  for (let i = lo; i < hi; i++) {
    const r = sorted[i];
    const marker = i === nearestIdx ? '<-- nearest' : '';
    console.log(
      `  strike=${r.strike.toFixed(0).padStart(4)}  call_g=${r.call_g.toFixed(0).padStart(12)}  put_g=${r.put_g.toFixed(0).padStart(12)}  net_g=${r.net_g.toFixed(0).padStart(12)}  ${marker}`,
    );
  }
  // Also check: how many net_g sign flips are there across all strikes?
  let flips = 0;
  let negCount = 0;
  let posCount = 0;
  let zeroCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].net_g * sorted[i].net_g < 0) flips++;
    if (sorted[i].net_g > 0) posCount++;
    else if (sorted[i].net_g < 0) negCount++;
    else zeroCount++;
  }
  console.log(`\n  Profile-wide stats: ${sorted.length} strikes, pos=${posCount}, neg=${negCount}, zero=${zeroCount}, sign-flips=${flips}`);
}
