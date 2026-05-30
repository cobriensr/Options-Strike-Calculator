#!/usr/bin/env tsx
/**
 * Honest test of the TAKE-IT gate on conviction — realized dollars,
 * truly out-of-sample for the MODEL.
 *
 * Provenance (2026-05-29 investigation): the takeit XGBoost model trained
 * on fires dated 2026-01-02 … 2026-05-15 (frozen v2026-05-16, backfilled
 * to all rows). Therefore any date ≤ 2026-05-15 is IN-SAMPLE for the model
 * and overstates its edge. The only honest holdout is dates > 2026-05-15.
 *
 * We split exactly at the model cutoff and report takeit gates (on top of
 * conviction geometry, and on all fires) for both regimes, on BOTH realized
 * exit policies plus % peak. A real edge must persist in the model-OOS
 * window (> 2026-05-15) on realized dollars — not just % peak, not just
 * in-sample.
 *
 * Read-only. Run: npx tsx scripts/analyze-conviction-takeit-oos-2026-05-29.ts
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.env.local' });
const sql = neon(process.env.DATABASE_URL!);

const MODEL_CUTOFF = '2026-05-15'; // last date in takeit training set

interface Fire {
  ms: number;
  date: string;
  ot: 'C' | 'P';
  strike: number;
  peak: number | null;
  trail: number | null;
  tier50: number | null;
  takeit: number | null;
  tod: string | null;
  entry: number | null;
}

async function load(): Promise<Fire[][]> {
  const PAGE = 40_000;
  type Raw = Record<string, unknown>;
  const rows: Raw[] = [];
  for (let lastId = 0; ; ) {
    const page = (await sql`
      SELECT id, underlying_symbol, date, trigger_time_ct AS ts, option_type, strike,
             peak_ceiling_pct, realized_trail30_10_pct, realized_tier50_holdeod_pct,
             takeit_prob, tod, entry_price
      FROM lottery_finder_fires
      WHERE peak_ceiling_pct IS NOT NULL AND id > ${lastId}
      ORDER BY id ASC LIMIT ${PAGE}
    `) as unknown as Raw[];
    if (page.length === 0) break;
    rows.push(...page);
    lastId = Number(page[page.length - 1]!.id);
    if (page.length < PAGE) break;
  }
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  const byKey = new Map<string, Fire[]>();
  for (const r of rows) {
    const ms = Date.parse(String(r.ts));
    if (!Number.isFinite(ms)) continue;
    const dateStr =
      typeof r.date === 'string'
        ? r.date
        : new Date(r.date as string).toISOString().slice(0, 10);
    const fire: Fire = {
      ms,
      date: dateStr,
      ot: r.option_type === 'C' ? 'C' : 'P',
      strike: Number(r.strike),
      peak: num(r.peak_ceiling_pct),
      trail: num(r.realized_trail30_10_pct),
      tier50: num(r.realized_tier50_holdeod_pct),
      takeit: num(r.takeit_prob),
      tod: (r.tod as string) ?? null,
      entry: num(r.entry_price),
    };
    const key = `${r.underlying_symbol}|${dateStr}`;
    const arr = byKey.get(key);
    if (arr) arr.push(fire);
    else byKey.set(key, [fire]);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.sort((a, b) => a.ms - b.ms);
  return groups;
}

function markConviction(fires: Fire[]): boolean[] {
  const spreadMs = 15 * 60_000;
  const mark = new Array<boolean>(fires.length).fill(false);
  for (let lo = 0; lo < fires.length; lo++) {
    let hi = lo;
    while (
      hi + 1 < fires.length &&
      fires[hi + 1]!.ms - fires[lo]!.ms <= spreadMs
    )
      hi += 1;
    if (hi - lo + 1 < 3) continue;
    let calls = 0;
    let puts = 0;
    const strikes = new Set<number>();
    for (let k = lo; k <= hi; k++) {
      strikes.add(fires[k]!.strike);
      if (fires[k]!.ot === 'C') calls += 1;
      else puts += 1;
    }
    const singleBias = (calls > 0 && puts === 0) || (puts > 0 && calls === 0);
    if (singleBias && strikes.size >= 2)
      for (let k = lo; k <= hi; k++) mark[k] = true;
  }
  return mark;
}

const vals = (fires: Fire[], sel: (f: Fire) => number | null) =>
  fires.map(sel).filter((v): v is number => v != null);
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const pct = (xs: number[], p: (x: number) => boolean) =>
  xs.length ? (xs.filter(p).length / xs.length) * 100 : null;
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));

const takeit = (t: number) => (f: Fire) => (f.takeit ?? -1) >= t;
const cheap = (c: number) => (f: Fire) => (f.entry ?? 1e9) <= c;
const and =
  (...ps: ((f: Fire) => boolean)[]) =>
  (f: Fire) =>
    ps.every((p) => p(f));

function row(label: string, fires: Fire[]): string {
  const tr = vals(fires, (f) => f.trail);
  const t5 = vals(fires, (f) => f.tier50);
  const p = vals(fires, (f) => f.peak);
  return (
    `| ${label} | ${fires.length} | ${f1(mean(tr))} | ${f1(pct(tr, (x) => x > 0))}% | ` +
    `${f1(mean(t5))} | ${f1(pct(t5, (x) => x > 0))}% | ${f1(pct(p, (x) => x >= 50))}% |`
  );
}
const HEADER =
  '| bucket | n | trail30 mean% | trail30 win% | **tier50 mean%** | tier50 win% | hit≥50% peak |\n' +
  '|---|---|---|---|---|---|---|';

(async () => {
  console.log('Loading LF …');
  const groups = await load();
  const allFires = groups.flat();

  const conv: Fire[] = [];
  for (const g of groups) {
    const marks = markConviction(g);
    g.forEach((f, i) => {
      if (marks[i]) conv.push(f);
    });
  }

  const sections: string[] = [];
  for (const [tag, keep] of [
    [
      `MODEL-OOS — dates > ${MODEL_CUTOFF} (the honest test)`,
      (f: Fire) => f.date > MODEL_CUTOFF,
    ],
    [
      `model-in-sample — dates ≤ ${MODEL_CUTOFF} (biased, ref only)`,
      (f: Fire) => f.date <= MODEL_CUTOFF,
    ],
  ] as const) {
    const allS = allFires.filter(keep);
    const convS = conv.filter(keep);
    const dts = [...new Set(allS.map((f) => f.date))].sort();
    const out: string[] = [
      `### ${tag}`,
      '',
      `Dates: ${dts[0]}…${dts.at(-1)} (${dts.length} sessions, ${allS.length} fires).`,
      '',
      HEADER,
    ];
    out.push(row('ALL fires (baseline)', allS));
    out.push(row('conviction geometry only', convS));
    out.push(row('conviction + takeit≥0.5', convS.filter(takeit(0.5))));
    out.push(row('conviction + takeit≥0.6', convS.filter(takeit(0.6))));
    out.push(row('conviction + takeit≥0.7', convS.filter(takeit(0.7))));
    out.push(
      row(
        'conviction + takeit≥0.6 + cheap≤1',
        convS.filter(and(takeit(0.6), cheap(1))),
      ),
    );
    out.push(
      row('ALL fires + takeit≥0.6 (no conviction)', allS.filter(takeit(0.6))),
    );
    sections.push(out.join('\n'));
  }

  const out =
    `# Conviction × TAKE-IT — model-OOS realized check — LF — 2026-05-29\n\n` +
    `takeit model trained through **${MODEL_CUTOFF}**; only dates after it are a ` +
    `true holdout for the model. trail30 = trailing-stop policy, tier50 = +50% ` +
    `target else hold-EOD. A real edge must show positive realized mean (or clearly ` +
    `better than the same-regime baseline) in the MODEL-OOS block, not just % peak.\n\n` +
    sections.join('\n\n') +
    '\n';

  const path = 'docs/tmp/conviction-takeit-oos-2026-05-29.md';
  writeFileSync(path, out);
  console.log(`\nWrote ${path}\n`);
  console.log(out);
})();
