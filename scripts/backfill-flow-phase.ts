/**
 * Re-run classifyFlowPhase() on backfill iv_anomalies rows now that we
 * can reconstruct VIX context from market_snapshots.
 *
 * The original full-replay script (backfill-detect.ts) inserted every
 * row with an empty ContextSnapshot, which biased classifyFlowPhase
 * toward 'reactive' (the default when no axis tilts decisively). The
 * vix_delta_15m axis is the strongest signal for early/mid/reactive
 * separation — populating it from market_snapshots reclassifies
 * historical alerts to match what the live cron would have produced.
 *
 * VIX coverage is sparse on the first few days of the backfill window
 * (market_snapshots is event-driven by the user running the
 * calculator). Rows whose timestamp can't find a VIX value within a
 * 60-min staleness window stay as 'reactive' — same fallback the live
 * classifier would produce.
 *
 * Updates flow_phase + context_snapshot's vix_level and vix_delta_15m
 * fields. All other context fields stay null.
 *
 * Usage:
 *     npx tsx scripts/backfill-flow-phase.ts
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFlowPhase, type AnomalyFlag } from '../api/_lib/iv-anomaly.ts';
import type { ContextSnapshot } from '../api/_lib/anomaly-context.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

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

const VIX_STALENESS_MS = 60 * 60 * 1000;

interface VixPoint {
  ts: number; // ms
  vix: number;
}

async function loadVixSeries(startDate: string, endDate: string): Promise<VixPoint[]> {
  const rows = (await sql`
    SELECT created_at AS ts, vix
    FROM market_snapshots
    WHERE created_at >= ${startDate}
      AND created_at < ${endDate}
      AND vix IS NOT NULL
    ORDER BY created_at ASC
  `) as Array<{ ts: string | Date; vix: string | number }>;
  return rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts.getTime() : Date.parse(String(r.ts)),
    vix: Number(r.vix),
  }));
}

/** Find latest VIX point with ts ≤ targetMs and ts ≥ targetMs - staleness. */
function vixAt(series: VixPoint[], targetMs: number): number | null {
  // Binary search for upper bound
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.ts <= targetMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return null;
  const candidate = series[lo - 1]!;
  if (targetMs - candidate.ts > VIX_STALENESS_MS) return null;
  return candidate.vix;
}

function buildContext(
  vixNow: number | null,
  vixDelta15m: number | null,
): ContextSnapshot {
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
    vix_level: vixNow,
    vix_delta_5m: null,
    vix_delta_15m: vixDelta15m,
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

async function main(): Promise<void> {
  console.error('[load] VIX series for 2026-04-13..04-25...');
  const vixSeries = await loadVixSeries('2026-04-13', '2026-04-25');
  console.error(`[load] ${vixSeries.length} VIX points`);

  type NullableNumeric = string | number | null;
  interface BackfillRow {
    id: number;
    ticker: string;
    strike: string | number;
    side: string;
    expiry: string | Date;
    spot_at_detect: string | number;
    iv_at_detect: string | number;
    skew_delta: NullableNumeric;
    z_score: NullableNumeric;
    ask_mid_div: NullableNumeric;
    vol_oi_ratio: NullableNumeric;
    side_skew: NullableNumeric;
    side_dominant: string | null;
    flag_reasons: string[];
    flow_phase: string | null;
    ts: string | Date;
  }
  console.error('[load] backfill iv_anomalies rows...');
  const rows = (await sql`
    SELECT id, ticker, strike, side, expiry, spot_at_detect, iv_at_detect,
      skew_delta, z_score, ask_mid_div, vol_oi_ratio, side_skew, side_dominant,
      flag_reasons, flow_phase, ts
    FROM iv_anomalies
    WHERE 'backfill' = ANY(flag_reasons)
    ORDER BY ts ASC
  `) as BackfillRow[];
  console.error(`[load] ${rows.length} backfill rows`);

  let updated = 0;
  let kept = 0;
  let withVix = 0;

  for (const row of rows) {
    const tsMs = row.ts instanceof Date ? row.ts.getTime() : Date.parse(String(row.ts));
    const vixNow = vixAt(vixSeries, tsMs);
    const vixPrev = vixAt(vixSeries, tsMs - 15 * 60 * 1000);
    const vixDelta = vixNow != null && vixPrev != null ? vixNow - vixPrev : null;
    if (vixNow != null) withVix += 1;

    const ctx = buildContext(vixNow, vixDelta);

    const flag: AnomalyFlag = {
      ticker: row.ticker,
      strike: Number(row.strike),
      side: row.side as 'call' | 'put',
      expiry:
        row.expiry instanceof Date
          ? row.expiry.toISOString().slice(0, 10)
          : String(row.expiry).slice(0, 10),
      spot_at_detect: Number(row.spot_at_detect),
      iv_at_detect: Number(row.iv_at_detect),
      skew_delta: row.skew_delta == null ? null : Number(row.skew_delta),
      z_score: row.z_score == null ? null : Number(row.z_score),
      ask_mid_div: row.ask_mid_div == null ? null : Number(row.ask_mid_div),
      vol_oi_ratio: row.vol_oi_ratio == null ? null : Number(row.vol_oi_ratio),
      side_skew: row.side_skew == null ? null : Number(row.side_skew),
      side_dominant: row.side_dominant as 'ask' | 'bid' | 'mixed' | null,
      flag_reasons: row.flag_reasons,
      ts:
        row.ts instanceof Date
          ? row.ts.toISOString()
          : new Date(row.ts).toISOString(),
    };

    const newPhase = classifyFlowPhase(flag, ctx);
    if (newPhase !== row.flow_phase) {
      const ctxJson = JSON.stringify(ctx);
      await sql`
        UPDATE iv_anomalies
        SET flow_phase = ${newPhase},
            context_snapshot = ${ctxJson}::jsonb
        WHERE id = ${row.id}
      `;
      updated += 1;
    } else {
      kept += 1;
    }
  }

  console.log(`\nProcessed ${rows.length} rows`);
  console.log(`  ${withVix} had VIX data within ${VIX_STALENESS_MS / 60000}min staleness`);
  console.log(`  ${updated} flow_phase reclassifications written`);
  console.log(`  ${kept} unchanged`);

  // Final phase distribution
  const dist = (await sql`
    SELECT flow_phase, COUNT(*) AS rows
    FROM iv_anomalies WHERE 'backfill' = ANY(flag_reasons)
    GROUP BY flow_phase ORDER BY rows DESC
  `) as Array<{ flow_phase: string | null; rows: string | number }>;
  console.log('\nFinal flow_phase distribution:');
  for (const d of dist) console.log(`  ${d.flow_phase ?? 'null'}: ${d.rows}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
