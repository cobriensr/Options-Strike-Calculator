#!/usr/bin/env node
/**
 * Per-file coverage floor gate. `npm run review` runs it right after
 * `vitest run --coverage`, from the repo root.
 *
 * Reads coverage/lcov.info (written by vitest's lcov reporter) under the
 * working directory, prints each file below a floor as
 * `file: branches 42.0% < 50%`, and exits 1. Also exits 1 when the report is
 * missing, empty or malformed, so a broken coverage run cannot pass. On
 * success prints one summary line. Floors and logic live in
 * scripts/_lib/coverage-floor.mjs.
 *
 * Run standalone, it checks whatever report is on disk, however old. Only the
 * `npm run review` chain guarantees a fresh one, because vitest's default
 * `coverage.clean` wipes coverage/ before each coverage run.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateLcov } from './_lib/coverage-floor.mjs';

const REPORT = 'coverage/lcov.info';

function main() {
  const root = process.cwd();
  let text;
  try {
    text = readFileSync(path.join(root, REPORT), 'utf8');
  } catch (err) {
    const reason =
      err?.code === 'ENOENT' ? 'not found' : `unreadable (${err?.message})`;
    console.error(
      `coverage floor: FAILED, ${REPORT} ${reason}. ` +
        'It is written by `vitest run --coverage` (lcov reporter); run that first.',
    );
    return 1;
  }

  const { ok, messages } = evaluateLcov(text, { root });
  const print = ok ? console.log : console.error;
  for (const message of messages) print(message);
  return ok ? 0 : 1;
}

process.exitCode = main();
