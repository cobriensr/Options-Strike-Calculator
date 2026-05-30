#!/usr/bin/env tsx
/**
 * Idea #2, Phase 1 v2 (data build): replace the (confounded) opening gamma_oi
 * snapshot with the INTRADAY spot-vs-zero-gamma regime — the instrument the
 * sign-reconciliation said the validated vol-compression prior actually used.
 *
 * Per trading day (SPX regular session):
 *   - long_gamma_frac = share of session minutes with spot > zero_gamma flip
 *     (dealers net long γ → compression regime). Computed over zero_gamma_levels
 *     rows inside the regular-session window.
 *   - mean_norm_dist = mean (spot − zero_gamma)/spot × 100 (signed distance above
 *     the flip, %)
 *   - realized_range_pct, vix1d, implied_sigma_pct, range_over_implied (as v1)
 *
 * Hypothesis (correctly oriented now): MORE time long-γ (high long_gamma_frac)
 * → SMALLER range/implied (compression). Expect NEGATIVE corr.
 *
 * Writes docs/tmp/range-phase1v2-data.csv. Read-only.
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
  const candles = (await sql`
    SELECT date,
           (array_agg(open ORDER BY timestamp))[1] AS open_first,
           max(high) AS hi, min(low) AS lo,
           min(timestamp) AS open_ts, max(timestamp) AS close_ts
    FROM index_candles_1m
    WHERE symbol = 'SPX' AND market_time = 'r'
    GROUP BY date ORDER BY date ASC
  `) as unknown as Record<string, unknown>[];

  // zero_gamma_levels: per-minute SPX flip level + spot. Non-null flip only.
  const zg = (await sql`
    SELECT ts, spot, zero_gamma
    FROM zero_gamma_levels
    WHERE ticker = 'SPX' AND zero_gamma IS NOT NULL AND spot IS NOT NULL
    ORDER BY ts ASC
  `) as unknown as Record<string, unknown>[];
  const zgRows = zg
    .map((r) => ({
      ts: Date.parse(String(r.ts)),
      spot: num(r.spot)!,
      flip: num(r.zero_gamma)!,
    }))
    .filter((r) => Number.isFinite(r.ts));

  const snaps = (await sql`
    SELECT date, vix1d, vix FROM market_snapshots
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
  const fracs: number[] = [];

  for (const c of candles) {
    const date = d10(c.date);
    const open = num(c.open_first),
      hi = num(c.hi),
      lo = num(c.lo);
    const openTs = Date.parse(String(c.open_ts));
    const closeTs = Date.parse(String(c.close_ts));
    if (open == null || hi == null || lo == null || !Number.isFinite(openTs))
      continue;

    const inWin = zgRows.filter((r) => r.ts >= openTs && r.ts <= closeTs);
    if (inWin.length < 10) continue; // need enough intraday coverage
    const above = inWin.filter((r) => r.spot > r.flip).length;
    const longGammaFrac = above / inWin.length;
    const meanNormDist =
      inWin.reduce((s, r) => s + ((r.spot - r.flip) / r.spot) * 100, 0) /
      inWin.length;

    const vx = vixByDate.get(date);
    const impliedVol = vx?.vix1d ?? vx?.vix ?? null;
    if (impliedVol == null) continue;

    const realizedRangePct = ((hi - lo) / open) * 100;
    const impliedSigmaPct = impliedVol / SQRT252;
    fracs.push(longGammaFrac);
    rows.push({
      date,
      realized_range_pct: +realizedRangePct.toFixed(4),
      vix1d: vx?.vix1d ?? '',
      implied_sigma_pct: +impliedSigmaPct.toFixed(4),
      range_over_implied: +(realizedRangePct / impliedSigmaPct).toFixed(4),
      long_gamma_frac: +longGammaFrac.toFixed(4),
      mean_norm_dist: +meanNormDist.toFixed(4),
      zg_minutes: inWin.length,
    });
  }

  const header = Object.keys(rows[0]!).join(',');
  writeFileSync(
    'docs/tmp/range-phase1v2-data.csv',
    [header, ...rows.map((r) => Object.values(r).join(','))].join('\n') + '\n',
  );
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`Days: ${rows.length} (${rows[0]?.date} … ${rows.at(-1)?.date})`);
  console.log(
    `long_gamma_frac: mean ${mean(fracs).toFixed(2)}, min ${Math.min(...fracs).toFixed(2)}, max ${Math.max(...fracs).toFixed(2)}`,
  );
  console.log(
    `days mostly long-γ (frac>0.5): ${fracs.filter((f) => f > 0.5).length} / ${fracs.length}`,
  );
  console.log('Wrote docs/tmp/range-phase1v2-data.csv');
})();
