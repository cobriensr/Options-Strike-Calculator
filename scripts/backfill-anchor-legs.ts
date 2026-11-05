/**
 * Step 2 of the anchor-column history backfill: apply (or compare) the NDJSON
 * that ml/src/anchor_backfill_extract.py wrote. The logic is in
 * scripts/_lib/anchor-backfill.ts.
 *
 *   npx tsx scripts/backfill-anchor-legs.ts --dry-run
 *   npx tsx scripts/backfill-anchor-legs.ts --compare wsref-2026-10-27.json wsref-2026-10-28.json
 *   npx tsx scripts/backfill-anchor-legs.ts --dates 2026-10-27 [--force]
 *
 * Default mode WRITES to the database DATABASE_URL points at (production, in
 * .env.local). --dry-run and --compare never touch it. Dates default to every
 * out/*.ndjson, oldest first; a date with an out/{date}.applied marker is
 * skipped unless --force.
 *
 * Options:
 *   --out <dir>        NDJSON directory (default docs/tmp/anchor-backfill/out)
 *   --dates d1 d2 ...  only these dates
 *   --dry-run          counts only, no writes
 *   --compare f1 ...   parity vs reference JSON files (no DB), exit 1 on gate fail
 *   --report <path>    compare report (default <out>/../compare-report.txt);
 *                      the first 50 mismatches go beside it as .mismatches.json
 *   --env-file <path>  .env.local to load (default: the nearest one up the tree)
 *   --force            reapply dates that have a done marker
 */

import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  applyDate,
  compareToReference,
  formatCompareReport,
  formatDateResult,
  parseNdjson,
  type ExtractLine,
  type Reference,
} from './_lib/anchor-backfill.js';

interface Args {
  out: string;
  dates: string[];
  dryRun: boolean;
  force: boolean;
  compare: string[];
  report: string | null;
  envFile: string | null;
}

const FLAGS_WITH_LISTS = new Set(['--dates', '--compare']);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'docs/tmp/anchor-backfill/out',
    dates: [],
    dryRun: false,
    force: false,
    compare: [],
    report: null,
    envFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value == null) throw new Error(`${flag} needs a value`);
      return value;
    };
    if (FLAGS_WITH_LISTS.has(flag)) {
      const values: string[] = [];
      while (argv[i + 1] != null && !argv[i + 1]?.startsWith('--')) {
        i += 1;
        values.push(argv[i] ?? '');
      }
      if (values.length === 0) throw new Error(`${flag} needs a value`);
      if (flag === '--dates') args.dates = values;
      else args.compare = values;
    } else if (flag === '--out') args.out = next();
    else if (flag === '--report') args.report = next();
    else if (flag === '--env-file') args.envFile = next();
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--force') args.force = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

/** --env-file, else the nearest .env.local up the tree (a worktree sits under the main checkout). */
function loadEnv(explicit: string | null): void {
  let found = explicit != null && existsSync(explicit) ? explicit : null;
  let dir = resolve('.');
  while (found == null) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) found = candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (found == null) throw new Error('no .env.local found; pass --env-file');
  config({ path: found, quiet: true });
}

function datesIn(out: string, only: string[]): string[] {
  const all = readdirSync(out)
    .map((f) => /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(f)?.[1])
    .filter((d): d is string => d != null)
    .sort();
  if (only.length === 0) return all;
  const missing = only.filter((d) => !all.includes(d));
  if (missing.length > 0) {
    throw new Error(`no NDJSON in ${out} for: ${missing.join(', ')}`);
  }
  return [...only].sort();
}

function runCompare(args: Args, dates: string[]): number {
  const reference: Reference = {};
  for (const file of args.compare) {
    Object.assign(reference, JSON.parse(readFileSync(file, 'utf8')));
  }
  const covered = new Set(Object.keys(reference).map((k) => k.split('|')[0]));
  const tapeByDate = new Map<string, ExtractLine[]>();
  for (const date of dates.filter((d) => covered.has(d))) {
    const file = join(args.out, `${date}.ndjson`);
    tapeByDate.set(date, parseNdjson(readFileSync(file, 'utf8'), file));
  }
  const report = compareToReference(tapeByDate, reference);
  const text = formatCompareReport(report);
  console.log(text);
  const reportPath =
    args.report ?? join(dirname(resolve(args.out)), 'compare-report.txt');
  writeFileSync(reportPath, `${text}\n`);
  writeFileSync(
    reportPath.replace(/\.txt$/, '') + '.mismatches.json',
    JSON.stringify(report.mismatches, null, 2),
  );
  console.log(`report: ${reportPath}`);
  return report.pass ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dates = datesIn(args.out, args.dates);
  if (args.compare.length > 0) return runCompare(args, dates);
  if (!args.dryRun) loadEnv(args.envFile);
  for (const date of dates) {
    const result = await applyDate(date, {
      outDir: args.out,
      dryRun: args.dryRun,
      force: args.force,
    });
    console.log(formatDateResult(result, date, args.dryRun));
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
