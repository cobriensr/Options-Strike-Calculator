#!/usr/bin/env node
/**
 * Summarize an `npm run review` log, one line per stage. Logic lives in
 * scripts/_lib/review-summary.mjs.
 *
 *   node scripts/review-summary.mjs review.log
 *   npm run review 2>&1 | node scripts/review-summary.mjs
 *
 * Prints pass, fail or not reached for type-check, eslint, prettier, vite
 * build, the build-output check, vitest, the coverage floor and the seal; a
 * failed stage is followed by its first few error lines, and the seal line
 * ends the output when the log has one.
 *
 * Exit codes: 0 every stage passed, 1 a stage failed or was not reached,
 * 2 the input could not be read or holds no review output.
 */
import { readFileSync } from 'node:fs';
import { decodeLog, summarizeReviewLog } from './_lib/review-summary.mjs';

const USAGE =
  'usage: node scripts/review-summary.mjs [logfile]  (or pipe the log in)';

/** @returns {Promise<Buffer>} everything on stdin */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function main(args) {
  const [file, ...rest] = args;
  if (
    rest.length > 0 ||
    file?.startsWith('-') ||
    (!file && process.stdin.isTTY)
  ) {
    console.error(USAGE);
    return 2;
  }

  let text;
  try {
    text = decodeLog(file ? readFileSync(file) : await readStdin());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`review-summary: cannot read ${file ?? 'stdin'}: ${reason}`);
    return 2;
  }

  const summary = summarizeReviewLog(text, { root: process.cwd() });
  if (!summary.recognised) {
    console.error(
      'review-summary: no `npm run review` output found in the input',
    );
    return 2;
  }
  console.log(summary.lines.join('\n'));
  return summary.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
