#!/usr/bin/env node
/**
 * One-shot: add YAML frontmatter (status + date) to every spec under
 * docs/superpowers/specs/ that doesn't already have one.
 *
 * Heuristic:
 *   - "Shipped"        — at least one commit message contains the exact
 *                        topic (dash or space variant) as a substring.
 *   - "Likely Shipped" — fallback when the first word of the topic
 *                        (≥4 chars) appears as a whole word in any
 *                        commit message.
 *   - "TBD"            — neither matched. Human review to promote to
 *                        Drafted / In-Flight / Pending / Abandoned.
 *
 * Idempotent: re-runs skip any spec that already starts with `---`.
 * Run from repo root:  node scripts/add-spec-status-headers.mjs
 *
 * Followups (after running):
 *   - `git diff --stat docs/superpowers/specs/` to see scope
 *   - Spot-check a few "Shipped" verdicts against git log
 *   - Hand-promote "TBD" → final status as you touch each spec
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const SPECS_DIR = 'docs/superpowers/specs';
const DATE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/;

// One-shot internal script invoking `git`, which is a trusted binary on
// every dev / CI machine that runs this repo. No user-supplied input.
// eslint-disable-next-line sonarjs/no-os-command-from-path
const allCommits = execSync('git log --pretty=format:%s', {
  encoding: 'utf-8',
})
  .split('\n')
  .map((s) => s.toLowerCase());

function findStatus(topic) {
  const dashed = topic.toLowerCase();
  const spaced = dashed.replace(/-/g, ' ');

  const exact = allCommits.some(
    (c) => c.includes(dashed) || c.includes(spaced),
  );
  if (exact) return 'Shipped';

  const firstWord = dashed.split('-')[0];
  if (firstWord.length >= 4) {
    const wordRe = new RegExp(`\\b${firstWord}\\b`, 'i');
    if (allCommits.some((c) => wordRe.test(c))) return 'Likely Shipped';
  }

  return 'TBD';
}

const files = await readdir(SPECS_DIR);
let modified = 0;
let skipped = 0;
const byStatus = { Shipped: 0, 'Likely Shipped': 0, TBD: 0 };

for (const file of files) {
  if (!file.endsWith('.md')) continue;

  const path = join(SPECS_DIR, file);
  const content = await readFile(path, 'utf-8');

  if (content.startsWith('---\n')) {
    skipped++;
    continue;
  }

  const match = file.match(DATE_RE);
  if (!match) {
    console.error(`SKIP (no date in filename): ${file}`);
    skipped++;
    continue;
  }

  const [, topic, date] = match;
  const status = findStatus(topic);
  byStatus[status]++;

  const frontmatter = `---\nstatus: ${status}\ndate: ${date}\n---\n\n`;
  await writeFile(path, frontmatter + content);
  modified++;
}

console.log(`Modified ${modified} files. Skipped ${skipped}.`);
console.log('By status:', byStatus);
