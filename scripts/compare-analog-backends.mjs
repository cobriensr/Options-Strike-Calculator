#!/usr/bin/env node

/**
 * Backend-comparison report for day-analog retrieval.
 *
 * For each trading day in a configurable range, runs BOTH backends
 * (Phase B text embedding + Phase C engineered features) with a
 * temporal leakage guard (only considers analogs STRICTLY BEFORE the
 * target date), then computes:
 *
 *   - Top-k cohort from each backend
 *   - Overlap between the two cohorts
 *   - Each cohort's directional prediction (majority of analog closes
 *     above their opens -> UP, else DOWN)
 *   - Actual directional outcome for the target day (parsed from
 *     day_embeddings.summary close-delta)
 *   - Per-backend hit/miss on direction
 *
 * Emits a Markdown report at the path given by --out (default
 * comparison.md) with:
 *   - Per-day row with both cohorts side-by-side
 *   - Hit-rate summary
 *   - Interesting-disagreement section listing days where the two
 *     backends predicted OPPOSITE directions (the informative days)
 *
 * Prereqs:
 *   - day_embeddings populated (Phase B backfill complete)
 *   - day_features populated (Phase C backfill complete)
 *
 * Usage:
 *   source .env.local && node scripts/compare-analog-backends.mjs \
 *     --start 2024-01-01 --end 2024-12-31 --k 15 --out comparison.md
 *
 *   --every N : sample every Nth weekday (default 1 = all).
 */

import { writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

import { neon } from '@neondatabase/serverless';

function arg(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  return argv[i + 1];
}

const DATABASE_URL = globalThis.process?.env?.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  exit(1);
}

function yesterdayIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const START = arg('--start', '2024-01-01');
const END = arg('--end', yesterdayIso());
const K = Number.parseInt(arg('--k', '15'), 10);
const EVERY = Number.parseInt(arg('--every', '1'), 10);
const OUT = arg('--out', 'comparison.md');

const sql = neon(DATABASE_URL);

/** Pull signed close-delta from a summary string. NaN if no match. */
function parseCloseDelta(summary) {
  const m = /close \S+ \(([+-]?\d+\.\d+)\)/.exec(summary);
  return m ? Number(m[1]) : Number.NaN;
}

function isoDate(v) {
  return v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v).slice(0, 10);
}

async function textAnalogs(targetDate, k) {
  const rows = await sql`
    WITH target AS (
      SELECT embedding FROM day_embeddings WHERE date = ${targetDate}::date
    )
    SELECT de.date, de.summary,
           de.embedding <=> (SELECT embedding FROM target) AS distance
    FROM day_embeddings de, target
    WHERE de.date < ${targetDate}::date
    ORDER BY de.embedding <=> (SELECT embedding FROM target)
    LIMIT ${k}
  `;
  return rows.map((r) => ({
    date: isoDate(r.date),
    summary: r.summary,
    distance: Number(r.distance),
  }));
}

async function featuresAnalogs(targetDate, k) {
  const rows = await sql`
    WITH target AS (
      SELECT features FROM day_features WHERE date = ${targetDate}::date
    )
    SELECT df.date,
           df.features <=> (SELECT features FROM target) AS distance
    FROM day_features df, target
    WHERE df.date < ${targetDate}::date
    ORDER BY df.features <=> (SELECT features FROM target)
    LIMIT ${k}
  `;
  const dates = rows.map((r) => isoDate(r.date));
  const summaries = dates.length
    ? await sql`
        SELECT date, summary FROM day_embeddings WHERE date = ANY(${dates})
      `
    : [];
  const byDate = new Map(summaries.map((r) => [isoDate(r.date), r.summary]));
  return rows.map((r) => ({
    date: isoDate(r.date),
    summary: byDate.get(isoDate(r.date)) ?? '',
    distance: Number(r.distance),
  }));
}

function directionalPrediction(cohort) {
  const signs = cohort
    .map((c) => parseCloseDelta(c.summary))
    .filter((d) => Number.isFinite(d));
  if (signs.length === 0) return { pred: null, upCount: 0, n: 0 };
  const upCount = signs.filter((d) => d > 0).length;
  const pred = upCount > signs.length / 2 ? 'UP' : 'DOWN';
  return { pred, upCount, n: signs.length };
}

function overlapCount(a, b) {
  const aSet = new Set(a.map((x) => x.date));
  let n = 0;
  for (const x of b) if (aSet.has(x.date)) n++;
  return n;
}

async function candidateDates(startIso, endIso, every) {
  const rows = await sql`
    SELECT de.date
    FROM day_embeddings de
    INNER JOIN day_features df USING (date)
    WHERE de.date BETWEEN ${startIso}::date AND ${endIso}::date
    ORDER BY de.date
  `;
  const all = rows.map((r) => isoDate(r.date));
  return all.filter((_, i) => i % every === 0);
}

function targetActualDirection(targetSummary) {
  const d = parseCloseDelta(targetSummary);
  if (!Number.isFinite(d)) return null;
  return d > 0 ? 'UP' : 'DOWN';
}

async function run() {
  console.log(
    `Comparing backends across ${START} -> ${END} (k=${K}, every=${EVERY})`,
  );

  const dates = await candidateDates(START, END, EVERY);
  console.log(`  ${dates.length} target dates with both embeddings present`);

  const rows = [];
  const disagreements = [];

  let textHits = 0;
  let featuresHits = 0;
  let bothHit = 0;
  let bothMiss = 0;
  let overlapSum = 0;
  let overlapN = 0;

  for (const date of dates) {
    const [targetRow] = await sql`
      SELECT summary FROM day_embeddings WHERE date = ${date}::date
    `;
    const targetSummary = targetRow?.summary ?? '';
    const actualDir = targetActualDirection(targetSummary);

    const [tAn, fAn] = await Promise.all([
      textAnalogs(date, K),
      featuresAnalogs(date, K),
    ]);

    const tPred = directionalPrediction(tAn);
    const fPred = directionalPrediction(fAn);
    const overlap = overlapCount(tAn, fAn);
    overlapSum += overlap;
    overlapN += 1;

    const tHit = actualDir && tPred.pred === actualDir;
    const fHit = actualDir && fPred.pred === actualDir;
    if (tHit) textHits += 1;
    if (fHit) featuresHits += 1;
    if (tHit && fHit) bothHit += 1;
    if (!tHit && !fHit && actualDir) bothMiss += 1;

    rows.push({
      date,
      actualDir,
      actualDelta: parseCloseDelta(targetSummary),
      tPred: tPred.pred,
      tUpFrac: tPred.n ? tPred.upCount / tPred.n : 0,
      fPred: fPred.pred,
      fUpFrac: fPred.n ? fPred.upCount / fPred.n : 0,
      overlap,
      tHit,
      fHit,
    });

    if (actualDir && tPred.pred && fPred.pred && tPred.pred !== fPred.pred) {
      disagreements.push({
        date,
        actualDir,
        tPred: tPred.pred,
        fPred: fPred.pred,
      });
    }
  }

  const textRate = (100 * textHits) / Math.max(1, rows.length);
  const featuresRate = (100 * featuresHits) / Math.max(1, rows.length);
  const overlapMean = overlapSum / Math.max(1, overlapN);

  const md = [];
  md.push(`# Analog Backend Comparison\n`);
  md.push(`**Range**: ${START} -> ${END}  `);
  md.push(`**k**: ${K}  `);
  md.push(`**Sample cadence**: every ${EVERY} trading day(s)  `);
  md.push(`**N target dates**: ${rows.length}  \n`);

  md.push(`## Summary\n`);
  md.push(`| Metric | Text (B) | Features (C) |`);
  md.push(`| --- | --- | --- |`);
  md.push(
    `| Directional hit rate | ${textHits}/${rows.length} (${textRate.toFixed(1)}%) | ${featuresHits}/${rows.length} (${featuresRate.toFixed(1)}%) |`,
  );
  md.push(
    `| Both backends agreed on a hit | ${bothHit}/${rows.length} | --- |`,
  );
  md.push(`| Both missed | ${bothMiss}/${rows.length} | --- |`);
  md.push(
    `| Mean top-${K} overlap | ${overlapMean.toFixed(1)}/${K} (${((100 * overlapMean) / K).toFixed(0)}%) | --- |\n`,
  );

  md.push(`## Interesting disagreements (${disagreements.length})\n`);
  md.push(
    `Target dates where the two backends predicted OPPOSITE directions. The Winner column shows which backend (if either) matched the actual outcome. These are the days with the highest information value for deciding which backend to trust.\n`,
  );
  md.push(`| Date | Actual | Text pred | Features pred | Winner |`);
  md.push(`| --- | --- | --- | --- | --- |`);
  for (const d of disagreements) {
    const winner =
      d.actualDir === d.tPred
        ? 'text'
        : d.actualDir === d.fPred
          ? 'features'
          : '---';
    md.push(
      `| ${d.date} | ${d.actualDir} | ${d.tPred} | ${d.fPred} | ${winner} |`,
    );
  }
  md.push('');

  md.push(`## Per-date detail\n`);
  md.push(
    `| Date | Actual Δ | Text pred (up %) | Features pred (up %) | Overlap | T hit | F hit |`,
  );
  md.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    md.push(
      `| ${r.date} | ${r.actualDelta.toFixed(2)} (${r.actualDir ?? '?'}) | ${r.tPred ?? '?'} (${(100 * r.tUpFrac).toFixed(0)}%) | ${r.fPred ?? '?'} (${(100 * r.fUpFrac).toFixed(0)}%) | ${r.overlap}/${K} | ${r.tHit ? '✓' : '✗'} | ${r.fHit ? '✓' : '✗'} |`,
    );
  }
  md.push('');

  writeFileSync(OUT, md.join('\n'), 'utf8');
  console.log(`\n✓ Wrote ${OUT}`);
  console.log(
    `  text hit rate ${textRate.toFixed(1)}%  |  features hit rate ${featuresRate.toFixed(1)}%  |  overlap ${overlapMean.toFixed(1)}/${K}`,
  );
}

try {
  await run();
} catch (err) {
  console.error('Comparison failed:', err);
  exit(1);
}
