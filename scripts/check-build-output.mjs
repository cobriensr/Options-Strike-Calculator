#!/usr/bin/env node
/**
 * Build-output gate. `npm run review` runs it right after `vite build`, from
 * the repo root.
 *
 * Reads dist/index.html and every .js file in dist/assets under the working
 * directory, prints each problem and exits 1. Also exits 1 when dist/ or
 * dist/index.html is missing, so a skipped build cannot pass. On success
 * prints one summary line. The rules live in scripts/_lib/build-output.mjs.
 *
 * Run standalone, it checks whatever build is on disk, however old.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { checkBuildOutput } from './_lib/build-output.mjs';

const DIST = 'dist';

/** Served path (`/assets/x.js`) -> source for every JS file in dist/assets. */
function readChunks(dist) {
  const chunks = new Map();
  const assets = path.join(dist, 'assets');
  if (!existsSync(assets)) return chunks;
  for (const name of readdirSync(assets)) {
    if (name.endsWith('.js')) {
      chunks.set(
        `/assets/${name}`,
        readFileSync(path.join(assets, name), 'utf8'),
      );
    }
  }
  return chunks;
}

function main() {
  const dist = path.join(process.cwd(), DIST);
  const hint = 'It is written by `vite build`; run that first.';
  if (!existsSync(dist)) {
    console.error(`build output: FAILED, ${DIST}/ not found. ${hint}`);
    return 1;
  }
  const indexPath = path.join(dist, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(
      `build output: FAILED, ${DIST}/index.html not found. ${hint}`,
    );
    return 1;
  }

  const { ok, messages } = checkBuildOutput({
    html: readFileSync(indexPath, 'utf8'),
    chunks: readChunks(dist),
  });
  const print = ok ? console.log : console.error;
  for (const message of messages) print(message);
  return ok ? 0 : 1;
}

process.exitCode = main();
