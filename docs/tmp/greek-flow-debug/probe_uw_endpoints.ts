/**
 * Probe UW Greek Flow endpoints to find which one matches the web display.
 *
 * UW's web Greek Flow panel for SPY on 2026-05-01 shows:
 *   - Cumulative OTM Dir Delta = 17,609.44 at 8:33 AM CT
 *   - End-of-session cumulative ≈ -3,570,000
 *
 * Our DB (populated by /stock/SPY/greek-flow?date=2026-05-01) shows:
 *   - Cumulative at 8:33 AM CT = +103,038
 *   - End-of-session cumulative = -96,178
 *
 * This script queries both:
 *   A. /stock/SPY/greek-flow?date=2026-05-01            (all expiries)
 *   B. /stock/SPY/greek-flow/2026-05-01?date=2026-05-01 (0DTE expiry only)
 *
 * Computes cumulative OTM Dir Delta for each and prints the value at
 * 8:33 AM CT plus end-of-session, so we can identify which (if either)
 * matches the web display.
 *
 * Run: npx tsx docs/tmp/greek-flow-debug/probe_uw_endpoints.ts
 *
 * Requires: UW_API_KEY in .env.local
 */
import 'dotenv/config';

const apiKey = process.env.UW_API_KEY;
if (!apiKey) {
  console.error('UW_API_KEY not set');
  process.exit(1);
}

const TARGET_DATE = '2026-05-01';
const TARGET_TICKER = 'SPY';
const REFERENCE_TIME_CT = '08:33';

interface Tick {
  timestamp: string;
  otm_dir_delta_flow: string;
  total_delta_flow: string;
  dir_delta_flow: string;
  expiry?: string;
}

async function fetchUw<T>(path: string): Promise<T[]> {
  const url = `https://api.unusualwhales.com/api${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`UW ${path} → ${res.status}: ${body}`);
  }
  const body = (await res.json()) as { data: T[] };
  return body.data ?? [];
}

function ctOfTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function summarize(label: string, ticks: Tick[]) {
  if (ticks.length === 0) {
    console.log(`\n=== ${label}: 0 ticks ===`);
    return;
  }
  // Sort ascending by timestamp
  const sorted = [...ticks].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  let cum = 0;
  let cumAt833: number | null = null;
  let max = -Infinity;
  let min = Infinity;
  let firstTs = sorted[0]?.timestamp ?? '';
  let lastTs = sorted.at(-1)?.timestamp ?? '';
  for (const t of sorted) {
    const v = Number.parseFloat(t.otm_dir_delta_flow);
    if (!Number.isFinite(v)) continue;
    cum += v;
    if (cum > max) max = cum;
    if (cum < min) min = cum;
    const ct = ctOfTimestamp(t.timestamp);
    if (ct === REFERENCE_TIME_CT && cumAt833 == null) {
      cumAt833 = cum;
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(`  ticks: ${sorted.length}`);
  console.log(`  first ts: ${firstTs}`);
  console.log(`  last ts:  ${lastTs}`);
  console.log(
    `  cumulative at ${REFERENCE_TIME_CT} CT: ${cumAt833 == null ? '(no tick at that minute)' : cumAt833.toFixed(2)}`,
  );
  console.log(`  cumulative max: ${max.toFixed(2)}`);
  console.log(`  cumulative min: ${min.toFixed(2)}`);
  console.log(`  cumulative end: ${cum.toFixed(2)}`);
}

async function main() {
  console.log(
    `Probing UW Greek Flow endpoints for ${TARGET_TICKER} ${TARGET_DATE}`,
  );
  console.log(
    `Reference: UW web shows OTM Dir Delta cumulative = 17,609.44 at ${REFERENCE_TIME_CT} CT, ≈ -3,570,000 EOD`,
  );

  // A. all-expiries (what our cron uses)
  const a = await fetchUw<Tick>(
    `/stock/${TARGET_TICKER}/greek-flow?date=${TARGET_DATE}`,
  );
  summarize('A. /stock/SPY/greek-flow?date=2026-05-01 (all expiries)', a);

  // B. 0DTE-only via expiry path
  const b = await fetchUw<Tick>(
    `/stock/${TARGET_TICKER}/greek-flow/${TARGET_DATE}?date=${TARGET_DATE}`,
  );
  summarize(
    'B. /stock/SPY/greek-flow/2026-05-01?date=2026-05-01 (0DTE only)',
    b,
  );

  // Print the raw 8:30-8:35 ticks from each so we can sanity-check
  console.log('\n=== A first 6 ticks (raw values) ===');
  console.table(
    a
      .slice()
      .sort((x, y) => x.timestamp.localeCompare(y.timestamp))
      .slice(0, 6)
      .map((t) => ({
        ts_ct: ctOfTimestamp(t.timestamp),
        otm_dir_delta_flow: t.otm_dir_delta_flow,
        dir_delta_flow: t.dir_delta_flow,
        total_delta_flow: t.total_delta_flow,
      })),
  );
  console.log('\n=== B first 6 ticks (raw values) ===');
  console.table(
    b
      .slice()
      .sort((x, y) => x.timestamp.localeCompare(y.timestamp))
      .slice(0, 6)
      .map((t) => ({
        ts_ct: ctOfTimestamp(t.timestamp),
        otm_dir_delta_flow: t.otm_dir_delta_flow,
        dir_delta_flow: t.dir_delta_flow,
        total_delta_flow: t.total_delta_flow,
      })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
