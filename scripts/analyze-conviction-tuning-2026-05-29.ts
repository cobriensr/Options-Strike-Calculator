#!/usr/bin/env tsx
/**
 * Conviction tuning probe — two questions in one pass:
 *
 *  A. WITHIN-TICKER/TOD CONTROL — does conviction add edge beyond being
 *     a proxy for "good ticker in the morning"? For each (ticker, tod)
 *     cell we compare conviction-cluster fires vs non-conviction fires in
 *     the SAME cell, then report the volume-weighted paired lift. If the
 *     average within-cell lift ≈ 0, the tag is a proxy and tuning the
 *     gate can't help. If positive, there's residual signal to tune toward.
 *
 *  B. THRESHOLD SWEEP — vary minFires / maxSpread / TAKE-IT floor and
 *     report, for each combo: % of ticker-days tagged (selectivity),
 *     fires tagged, hit≥50%, mean peak, and lift vs the all-fires
 *     baseline. Shows whether tightening buys both rarity AND edge.
 *
 * Per-fire conviction membership uses the SAME maximal-contiguous-window
 * semantics as the production findEarliestConvictionWindow, so a fire is
 * "conviction" iff it sits in a ≤maxSpread window of ≥minFires same-bias
 * fires across ≥2 strikes — matching when the live badge is lit.
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-tuning-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

interface Fire {
  ms: number;
  ot: 'C' | 'P';
  strike: number;
  peak: number | null;
  takeit: number | null;
  tod: string | null;
}

interface RawRow {
  underlying_symbol: string;
  date: string;
  ts: string;
  option_type: string;
  strike: number;
  peak_ceiling_pct: number | null;
  takeit_prob: number | null;
  tod: string | null;
  id: number;
}

interface Group {
  ticker: string;
  fires: Fire[]; // time-sorted
}

async function load(
  table: string,
  tsCol: string,
  hasTod: boolean,
): Promise<Group[]> {
  const PAGE = 40_000;
  const rows: RawRow[] = [];
  for (let lastId = 0; ; ) {
    const todSel = hasTod ? sql`tod` : sql`NULL AS tod`;
    const page = (await sql`
      SELECT id, underlying_symbol, date, ${sql.unsafe(tsCol)} AS ts,
             option_type, strike, peak_ceiling_pct, takeit_prob, ${todSel}
      FROM ${sql.unsafe(table)}
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as RawRow[];
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }

  const byKey = new Map<string, { ticker: string; fires: Fire[] }>();
  for (const r of rows) {
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const dateStr =
      typeof r.date === 'string'
        ? r.date
        : new Date(r.date).toISOString().slice(0, 10);
    const key = `${r.underlying_symbol}|${dateStr}`;
    const fire: Fire = {
      ms,
      ot: r.option_type === 'C' ? 'C' : 'P',
      strike: Number(r.strike),
      peak: r.peak_ceiling_pct == null ? null : Number(r.peak_ceiling_pct),
      takeit: r.takeit_prob == null ? null : Number(r.takeit_prob),
      tod: r.tod,
    };
    const g = byKey.get(key);
    if (g) g.fires.push(fire);
    else byKey.set(key, { ticker: r.underlying_symbol, fires: [fire] });
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.fires.sort((a, b) => a.ms - b.ms);
  return groups;
}

/**
 * Mark each fire true if it lies in a maximal ≤spreadMs window anchored
 * at some lo with ≥minFires fires, single bias, ≥2 distinct strikes.
 * When `floor` is set, only fires with takeit ≥ floor are eligible.
 */
function markConviction(
  fires: Fire[],
  minFires: number,
  spreadMs: number,
  floor: number | null,
): boolean[] {
  const elig = fires.filter((f) => floor == null || (f.takeit ?? -1) >= floor);
  const mark = new Map<Fire, boolean>();
  for (const f of elig) mark.set(f, false);
  for (let lo = 0; lo < elig.length; lo++) {
    let hi = lo;
    while (
      hi + 1 < elig.length &&
      elig[hi + 1]!.ms - elig[lo]!.ms <= spreadMs
    ) {
      hi += 1;
    }
    const count = hi - lo + 1;
    if (count < minFires) continue;
    let calls = 0;
    let puts = 0;
    const strikes = new Set<number>();
    for (let k = lo; k <= hi; k++) {
      strikes.add(elig[k]!.strike);
      if (elig[k]!.ot === 'C') calls += 1;
      else puts += 1;
    }
    const singleBias = (calls > 0 && puts === 0) || (puts > 0 && calls === 0);
    if (singleBias && strikes.size >= 2) {
      for (let k = lo; k <= hi; k++) mark.set(elig[k]!, true);
    }
  }
  return fires.map((f) => mark.get(f) ?? false);
}

const hit50 = (fires: Fire[]) => {
  const p = fires.map((f) => f.peak).filter((v): v is number => v != null);
  return p.length ? (p.filter((x) => x >= 50).length / p.length) * 100 : null;
};
const meanPeak = (fires: Fire[]) => {
  const p = fires.map((f) => f.peak).filter((v): v is number => v != null);
  return p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
};
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

// ----------------------------------------------------------------------
function withinTickerControl(groups: Group[]): string {
  // cell = ticker|tod ; collect conviction vs non-conviction fires
  const cells = new Map<string, { conv: Fire[]; non: Fire[] }>();
  for (const g of groups) {
    const marks = markConviction(g.fires, 3, 15 * 60_000, null);
    g.fires.forEach((f, i) => {
      const cellKey = `${g.ticker}|${f.tod ?? 'NA'}`;
      const c = cells.get(cellKey) ?? { conv: [], non: [] };
      if (marks[i]) c.conv.push(f);
      else c.non.push(f);
      cells.set(cellKey, c);
    });
  }
  const MIN = 30;
  let wSum = 0;
  let wLift = 0;
  let pos = 0;
  let neg = 0;
  const rows: { cell: string; nConv: number; lift: number }[] = [];
  for (const [cell, c] of cells) {
    if (c.conv.length < MIN || c.non.length < MIN) continue;
    const hc = hit50(c.conv);
    const hn = hit50(c.non);
    if (hc == null || hn == null) continue;
    const lift = hc - hn;
    const w = Math.min(c.conv.length, c.non.length);
    wSum += w;
    wLift += w * lift;
    if (lift > 0) pos += 1;
    else neg += 1;
    rows.push({ cell, nConv: c.conv.length, lift });
  }
  const avg = wSum ? wLift / wSum : null;
  rows.sort((a, b) => b.nConv - a.nConv);
  const top = rows
    .slice(0, 20)
    .map(
      (r) =>
        `| ${r.cell} | ${r.nConv} | ${r.lift > 0 ? '+' : ''}${r.lift.toFixed(1)}pp |`,
    )
    .join('\n');
  return (
    `Cells with ≥${MIN} fires in both arms: **${pos + neg}** ` +
    `(${pos} conviction>control, ${neg} conviction≤control).\n` +
    `**Volume-weighted within-cell lift (conviction − non-conviction hit≥50%): ` +
    `${avg == null ? '—' : (avg > 0 ? '+' : '') + avg.toFixed(2) + 'pp'}**\n\n` +
    `| ticker\\|tod | n conv | within-cell lift |\n|---|---|---|\n${top}\n`
  );
}

function sweep(groups: Group[], baseline: number): string {
  const totalDays = groups.length;
  const minFiresOpts = [3, 4, 5, 6];
  const spreadOpts = [15, 10, 7, 5];
  const floorOpts: (number | null)[] = [null, 0.5, 0.6];
  const lines: string[] = [];
  lines.push(
    '| minFires | maxSpread | takeit floor | tagged-days% | fires | hit≥50% | lift vs base | mean peak% |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const floor of floorOpts) {
    for (const mf of minFiresOpts) {
      for (const sp of spreadOpts) {
        let taggedDays = 0;
        const tagged: Fire[] = [];
        for (const g of groups) {
          const marks = markConviction(g.fires, mf, sp * 60_000, floor);
          let any = false;
          g.fires.forEach((f, i) => {
            if (marks[i]) {
              tagged.push(f);
              any = true;
            }
          });
          if (any) taggedDays += 1;
        }
        const h = hit50(tagged);
        const lift = h == null ? null : h - baseline;
        lines.push(
          `| ${mf} | ${sp}m | ${floor ?? '—'} | ${((taggedDays / totalDays) * 100).toFixed(1)}% | ${tagged.length} | ${f1(h)}% | ${lift == null ? '—' : (lift > 0 ? '+' : '') + lift.toFixed(1)} | ${f1(meanPeak(tagged))} |`,
        );
      }
    }
  }
  return lines.join('\n');
}

(async () => {
  console.log('Loading LF …');
  const lf = await load('lottery_finder_fires', 'trigger_time_ct', true);
  console.log(`  ${lf.length} ticker-days`);
  console.log('Loading SB …');
  const sb = await load('silent_boom_alerts', 'bucket_ct', false);
  console.log(`  ${sb.length} ticker-days`);

  const lfBase = hit50(lf.flatMap((g) => g.fires))!;
  const sbBase = hit50(sb.flatMap((g) => g.fires))!;

  const out =
    `# Conviction tuning probe — 2026-05-29\n\n` +
    `## A. Within-ticker/TOD control (does conviction beat the same ticker+slot?)\n\n` +
    `### Lottery Finder (baseline hit≥50% = ${lfBase.toFixed(1)}%)\n\n` +
    withinTickerControl(lf) +
    `\n### Silent Boom (baseline hit≥50% = ${sbBase.toFixed(1)}%)\n\n` +
    withinTickerControl(sb) +
    `\n## B. Threshold sweep\n\n` +
    `### Lottery Finder (baseline ${lfBase.toFixed(1)}%)\n\n` +
    sweep(lf, lfBase) +
    `\n\n### Silent Boom (baseline ${sbBase.toFixed(1)}%)\n\n` +
    sweep(sb, sbBase) +
    '\n';

  const path = 'docs/tmp/conviction-tuning-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
