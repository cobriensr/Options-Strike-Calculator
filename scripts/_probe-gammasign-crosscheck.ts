#!/usr/bin/env tsx
/**
 * Gamma Sign Convention Cross-Check (READ-ONLY PROBE)
 *
 * Empirically determines what spot_exposures.gamma_oi > 0 MEANS by comparing against:
 * 1. zero_gamma_levels.net_gamma_at_spot (the derivative-based gamma at current spot)
 * 2. Spot vs zero-gamma distance (which regime: long or short)
 *
 * Answers the question: does gamma_oi > 0 align with net_gamma_at_spot > 0?
 * And does spot_exposures.gamma_oi sign match the vol-compression finding?
 *
 * Run: npx tsx scripts/_probe-gammasign-crosscheck.ts
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const d10 = (v: unknown): string =>
  typeof v === 'string'
    ? v.slice(0, 10)
    : new Date(v as string).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

interface ExposureRow {
  date: string;
  timestamp: string;
  gamma_oi: number | null;
  price: number;
}

interface ZeroGammaRow {
  date: string;
  ts: string;
  spot: number;
  net_gamma_at_spot: number | null;
  zero_gamma: number | null;
}

interface DailyRec {
  date: string;
  expos_gamma_oi: number | null;
  expo_price: number;
  zg_net_gamma: number | null;
  zg_zero_gamma: number | null;
  zg_spot: number;
  spot_above_zg: boolean | null;
  gamma_oi_sign: string;
  net_gamma_sign: string;
  regime_align: boolean | null;
}

(async () => {
  console.log('=== Gamma Sign Convention Cross-Check ===\n');

  // Load spot_exposures for SPX (opening gamma per day)
  const expos = (await sql`
    SELECT date, timestamp, gamma_oi, price
    FROM spot_exposures
    WHERE ticker = 'SPX'
    ORDER BY date ASC, timestamp ASC
  `) as unknown as ExposureRow[];

  // Group by date, take first non-null gamma_oi
  const expoByDate = new Map<string, ExposureRow>();
  for (const r of expos) {
    const k = d10(r.date);
    if (!expoByDate.has(k) && r.gamma_oi != null && r.gamma_oi !== 0) {
      expoByDate.set(k, r);
    }
  }

  // Load zero_gamma_levels for SPX (use first snapshot of each day)
  const zgRows = (await sql`
    SELECT ticker, (ts AT TIME ZONE 'America/New_York')::date AS date,
           ts, spot, net_gamma_at_spot, zero_gamma
    FROM zero_gamma_levels
    WHERE ticker = 'SPX'
    ORDER BY date ASC, ts ASC
  `) as unknown as ZeroGammaRow[];

  const zgByDate = new Map<string, ZeroGammaRow>();
  for (const r of zgRows) {
    const k = d10(r.date);
    if (!zgByDate.has(k)) {
      zgByDate.set(k, r);
    }
  }

  // Cross-join on date
  const allDates = new Set<string>();
  expoByDate.forEach((_, d) => allDates.add(d));
  zgByDate.forEach((_, d) => allDates.add(d));

  const records: DailyRec[] = [];
  for (const date of Array.from(allDates).sort()) {
    const e = expoByDate.get(date);
    const z = zgByDate.get(date);

    if (!e || !z) continue; // Both required

    const gammaOi = num(e.gamma_oi);
    const netGamma = num(z.net_gamma_at_spot);
    const zg = num(z.zero_gamma);
    const spot = num(z.spot);

    if (gammaOi == null || netGamma == null || zg == null || spot == null)
      continue;

    const spotAboveZg = spot > zg;
    const gammaOiSign = gammaOi > 0 ? '+' : gammaOi < 0 ? '−' : '0';
    const netGammaSign = netGamma > 0 ? '+' : netGamma < 0 ? '−' : '0';
    const regimeAlign = gammaOi > 0 === netGamma > 0; // Do signs agree?

    records.push({
      date,
      expos_gamma_oi: gammaOi,
      expo_price: e.price,
      zg_net_gamma: netGamma,
      zg_zero_gamma: zg,
      zg_spot: spot,
      spot_above_zg: spotAboveZg,
      gamma_oi_sign: gammaOiSign,
      net_gamma_sign: netGammaSign,
      regime_align: regimeAlign,
    });
  }

  // Summary statistics
  const gammaOiPos = records.filter((r) => r.expos_gamma_oi! > 0).length;
  const gammaOiNeg = records.filter((r) => r.expos_gamma_oi! < 0).length;
  const netGammaPos = records.filter((r) => r.zg_net_gamma! > 0).length;
  const netGammaNeg = records.filter((r) => r.zg_net_gamma! < 0).length;
  const signAgreement = records.filter((r) => r.regime_align).length;
  const spotAboveZgDays = records.filter((r) => r.spot_above_zg).length;

  // vol-compression finding: spot above ZG (+γ) should have SMALLER ranges
  // → gamma_oi > 0 should align with net_gamma > 0
  const alignmentPct = ((signAgreement / records.length) * 100).toFixed(1);

  console.log(
    `Days with both spot_exposures.gamma_oi and zero_gamma_levels data: ${records.length}\n`,
  );
  console.log(`spot_exposures.gamma_oi sign distribution:`);
  console.log(`  Positive: ${gammaOiPos}  |  Negative: ${gammaOiNeg}\n`);
  console.log(`zero_gamma_levels.net_gamma_at_spot sign distribution:`);
  console.log(
    `  Positive (long γ): ${netGammaPos}  |  Negative (short γ): ${netGammaNeg}\n`,
  );
  console.log(
    `Days spot ABOVE zero-gamma (regime = +γ suppression): ${spotAboveZgDays}\n`,
  );
  console.log(`SIGN ALIGNMENT (gamma_oi > 0 ⟺ net_gamma_at_spot > 0):`);
  console.log(
    `  ${signAgreement}/${records.length} = ${alignmentPct}% AGREE\n`,
  );

  // If alignment is HIGH, then spot_exposures.gamma_oi IS a signed dealer gamma regime indicator
  // If alignment is LOW, then they measure different things (absolute vs relative)

  if (parseFloat(alignmentPct) > 85) {
    console.log(
      '✓ STRONG ALIGNMENT: spot_exposures.gamma_oi and net_gamma_at_spot agree.',
    );
    console.log(
      '  → gamma_oi > 0 means dealers net LONG gamma (suppression)\n',
    );
  } else if (parseFloat(alignmentPct) < 60) {
    console.log(
      '✗ WEAK/INVERTED ALIGNMENT: spot_exposures.gamma_oi and net_gamma_at_spot DISAGREE.',
    );
    console.log(
      '  → These measure different things (absolute vs spot-relative regime)\n',
    );
  } else {
    console.log(
      '~ MODERATE ALIGNMENT: partial correlation between the two metrics.\n',
    );
  }

  // Detailed sample (first 20 records)
  console.log('Sample (first 20 days):');
  console.log(
    'Date       | gamma_oi | net_γ@spot | ZG    | spot   | spotAboveZG | signs | agree?',
  );
  console.log('-'.repeat(85));
  for (let i = 0; i < Math.min(20, records.length); i++) {
    const r = records[i]!;
    const sa = r.spot_above_zg ? 'yes' : 'no ';
    const ag = r.regime_align ? 'YES' : 'NO ';
    console.log(
      `${r.date} | ${String(r.expos_gamma_oi!.toFixed(0)).padStart(8)} | ${String(r.zg_net_gamma!.toFixed(0)).padStart(10)} | ${r.zg_zero_gamma!.toFixed(0).padStart(5)} | ${r.zg_spot!.toFixed(0).padStart(6)} | ${sa}        | ${r.gamma_oi_sign}${r.net_gamma_sign}   | ${ag}`,
    );
  }

  console.log(`\n✓ Wrote cross-check report (no file — review above)`);
})().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
