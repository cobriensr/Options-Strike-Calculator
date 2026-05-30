#!/usr/bin/env tsx
/**
 * Idea #2, Phase 1 (data build): assemble the daily feature table for the
 * "does dealer gamma explain realized range beyond VIX" crux test.
 *
 * Per trading day (SPX regular session):
 *   - realized_range_pct = (day high − day low) / first-regular-open × 100
 *   - vix1d (1-day VIX, the right implied vol for a 0DTE daily range)
 *   - implied_sigma_pct = vix1d / sqrt(252)   (annualized → 1-day σ in %)
 *   - opening dealer gamma (gamma_oi AND gamma_dir) sampled at the row
 *     nearest the regular open (fully known by ~9:00 CT → no lookahead)
 *
 * CRITICAL CHECK: prints the sign distribution of gamma_oi vs gamma_dir.
 * If one is a positive magnitude that never crosses zero (the ws_gex trap),
 * it's NOT signed dealer gamma and we must use the other. The downstream
 * Python stats use whichever field actually carries a sign.
 *
 * Writes docs/tmp/range-phase1-data.csv. Read-only.
 * Run: npx tsx scripts/analyze-range-phase1-build-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const d10 = (v: unknown): string =>
  typeof v === 'string'
    ? v.slice(0, 10)
    : new Date(v as string).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

(async () => {
  // 1) Per-day realized range + regular-session open timestamp.
  const candles = (await sql`
    SELECT date,
           (array_agg(open ORDER BY timestamp))[1] AS open_first,
           max(high) AS hi, min(low) AS lo,
           (array_agg(close ORDER BY timestamp DESC))[1] AS close_last,
           min(timestamp) AS open_ts
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND market_time = 'r'
    GROUP BY date
    ORDER BY date ASC
  `) as unknown as Record<string, unknown>[];

  // 2) All spot_exposures (small table, ~18k rows) — pick opening gamma in JS.
  const expo = (await sql`
    SELECT date, timestamp, gamma_oi, gamma_dir, price
    FROM spot_exposures
    WHERE ticker = 'SPX'
    ORDER BY timestamp ASC
  `) as unknown as Record<string, unknown>[];
  const expoByDate = new Map<
    string,
    { ts: number; gamma_oi: number | null; gamma_dir: number | null }[]
  >();
  for (const r of expo) {
    const k = d10(r.date);
    const arr = expoByDate.get(k) ?? [];
    arr.push({
      ts: Date.parse(String(r.timestamp)),
      gamma_oi: num(r.gamma_oi),
      gamma_dir: num(r.gamma_dir),
    });
    expoByDate.set(k, arr);
  }

  // 3) vix1d / vix per day (dedupe market_snapshots to first non-null).
  const snaps = (await sql`
    SELECT date, vix1d, vix
    FROM market_snapshots
    WHERE vix1d IS NOT NULL OR vix IS NOT NULL
    ORDER BY date ASC, entry_time ASC
  `) as unknown as Record<string, unknown>[];
  const vixByDate = new Map<
    string,
    { vix1d: number | null; vix: number | null }
  >();
  for (const r of snaps) {
    const k = d10(r.date);
    if (!vixByDate.has(k))
      vixByDate.set(k, { vix1d: num(r.vix1d), vix: num(r.vix) });
  }

  const SQRT252 = Math.sqrt(252);
  const rows: Record<string, number | string>[] = [];
  let goiPos = 0,
    goiNeg = 0,
    gdirPos = 0,
    gdirNeg = 0;
  let skipNoExpo = 0,
    skipNoGamma = 0;
  const offsets: number[] = [];

  for (const c of candles) {
    const date = d10(c.date);
    const open = num(c.open_first);
    const hi = num(c.hi);
    const lo = num(c.lo);
    const openTs = Date.parse(String(c.open_ts));
    if (open == null || hi == null || lo == null || !Number.isFinite(openTs))
      continue;

    // Opening gamma = FIRST spot_exposures row with a populated (non-zero)
    // gamma_oi at/after the cash open. spot_exposures carries ~3h of
    // premarket rows (from ~10:30 UTC) and `gamma_dir` is frequently 0, so a
    // naive nearest-row match lands on empty rows — gamma_oi is the reliably
    // populated signed field (the production regime sign). No lookahead:
    // first populated reading in [open−5min, open+120min] is known by ~mid-AM.
    const expos = expoByDate.get(date);
    if (!expos) {
      skipNoExpo++;
      continue;
    }
    let best: {
      ts: number;
      gamma_oi: number | null;
      gamma_dir: number | null;
    } | null = null;
    for (const e of expos) {
      const dt = e.ts - openTs;
      if (dt < -5 * 60_000 || dt > 120 * 60_000) continue;
      if (e.gamma_oi == null || e.gamma_oi === 0) continue; // need populated signed γ
      best = e;
      break;
    }
    if (best == null) {
      skipNoGamma++;
      continue;
    }
    offsets.push(Math.round((best.ts - openTs) / 60_000));

    const vx = vixByDate.get(date);
    const vix1d = vx?.vix1d ?? null;
    const vix = vx?.vix ?? null;
    const impliedVol = vix1d ?? vix; // prefer 1-day VIX
    if (impliedVol == null) continue;

    const realizedRangePct = ((hi - lo) / open) * 100;
    const impliedSigmaPct = impliedVol / SQRT252;
    const gOi = best.gamma_oi;
    const gDir = best.gamma_dir;
    if (gOi != null) {
      if (gOi > 0) goiPos++;
      else goiNeg++;
    }
    if (gDir != null) {
      if (gDir > 0) gdirPos++;
      else gdirNeg++;
    }

    rows.push({
      date,
      realized_range_pct: +realizedRangePct.toFixed(4),
      vix1d: vix1d ?? '',
      vix: vix ?? '',
      implied_sigma_pct: +impliedSigmaPct.toFixed(4),
      range_over_implied: +(realizedRangePct / impliedSigmaPct).toFixed(4),
      gamma_oi: gOi ?? '',
      gamma_dir: gDir ?? '',
      spot_open: open,
    });
  }

  const header = Object.keys(rows[0]!).join(',');
  const csv = [header, ...rows.map((r) => Object.values(r).join(','))].join(
    '\n',
  );
  writeFileSync('docs/tmp/range-phase1-data.csv', csv + '\n');

  // Diagnostics — especially the signed-vs-magnitude check.
  const rr = rows.map((r) => Number(r.realized_range_pct));
  const roi = rows.map((r) => Number(r.range_over_implied));
  const meanOf = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const medOff = offsets.length
    ? [...offsets].sort((a, b) => a - b)[Math.floor(offsets.length / 2)]
    : null;
  console.log(
    `Days: ${rows.length} (${rows[0]?.date} … ${rows.at(-1)?.date})  | skipped: noExpo ${skipNoExpo}, noPopulatedGamma ${skipNoGamma}`,
  );
  console.log(
    `opening-γ offset after cash open: median ${medOff}min, max ${offsets.length ? Math.max(...offsets) : '—'}min`,
  );
  console.log(
    `gamma_oi  sign: +${goiPos} / −${goiNeg} / 0:${rows.length - goiPos - goiNeg}`,
  );
  console.log(
    `gamma_dir sign: +${gdirPos} / −${gdirNeg} / 0:${rows.length - gdirPos - gdirNeg}`,
  );
  console.log(
    `realized_range_pct: mean ${meanOf(rr).toFixed(2)}  min ${Math.min(...rr).toFixed(2)}  max ${Math.max(...rr).toFixed(2)}`,
  );
  console.log(
    `range_over_implied: mean ${meanOf(roi).toFixed(2)} (realized H-L as multiple of 1-day implied σ)`,
  );
  console.log(`Wrote docs/tmp/range-phase1-data.csv`);
})();
