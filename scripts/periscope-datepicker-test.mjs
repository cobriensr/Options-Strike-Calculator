#!/usr/bin/env node
/**
 * scripts/periscope-datepicker-test.mjs
 *
 * Standalone proof-of-concept for driving the UW Periscope date picker
 * via Playwright. The page has a 3-element widget:
 *
 *   <button aria-label="Previous day">  ← prev chevron
 *   <span role="button">Thu, May 7</span>  ← current date label (clickable)
 *   <button aria-label="Next day">       ← next chevron
 *
 * This script tests two interactions:
 *   1. Click the prev chevron, observe the label change.
 *   2. Click the next chevron to restore.
 *
 * If both work, we have everything we need to drive the date picker
 * from the production scraper (walk forward/backward until the label
 * matches the target date).
 *
 * Usage:
 *   PERISCOPE_URL='https://unusualwhales.com/periscope/market-exposures-table' \
 *     node scripts/periscope-datepicker-test.mjs
 *
 * Reads the auth state from ~/.periscope-probe-auth.json (created by
 * scripts/periscope-probe.mjs --login). HEADED so you can watch the
 * interaction visually — that catches issues like "the chevron click
 * fired but UW didn't repaint" that a headless run would miss.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const AUTH_PATH = join(homedir(), '.periscope-probe-auth.json');
const PERISCOPE_URL = process.env.PERISCOPE_URL;

if (!PERISCOPE_URL) {
  console.error('ERROR: PERISCOPE_URL env var is required.');
  process.exit(1);
}
if (!existsSync(AUTH_PATH)) {
  console.error(`ERROR: ${AUTH_PATH} not found. Run periscope-probe.mjs --login first.`);
  process.exit(1);
}

async function main() {
  console.log('▸ Launching headed Chromium so you can watch...');
  const browser = await chromium.launch({ headless: false, slowMo: 250 });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1920, height: 1200 },
  });
  const page = await context.newPage();

  console.log(`▸ Navigating to ${PERISCOPE_URL}...`);
  await page.goto(PERISCOPE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // The date label is a <span role="button"> sandwiched between two
  // <button aria-label="Previous day"> / <button aria-label="Next day">.
  // We locate the picker container via the prev/next aria-labels rather
  // than a tailwind hash class.
  const prevDayBtn = page.getByLabel('Previous day').first();
  const nextDayBtn = page.getByLabel('Next day').first();
  const dateLabel = page
    .locator('span[role="button"]')
    .filter({ hasText: /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/ })
    .first();

  // Read the initial label.
  const initialDate = (await dateLabel.textContent())?.trim() ?? '';
  console.log(`▸ Initial date label:  "${initialDate}"`);

  // Click "Previous day" and confirm the label updates.
  console.log('▸ Clicking Previous day...');
  await prevDayBtn.click();
  await page.waitForTimeout(1500); // let the page re-render

  const afterPrev = (await dateLabel.textContent())?.trim() ?? '';
  console.log(`▸ After Previous day:  "${afterPrev}"`);

  if (afterPrev === initialDate) {
    console.error('✗ Previous day click did NOT change the label.');
    console.error('  The chevron click might have failed, or UW updates the');
    console.error('  label asynchronously beyond the 1.5s wait.');
  } else {
    console.log('✓ Previous day changed the label.');
  }

  // Click "Next day" to restore.
  console.log('▸ Clicking Next day to restore...');
  await nextDayBtn.click();
  await page.waitForTimeout(1500);

  const afterNext = (await dateLabel.textContent())?.trim() ?? '';
  console.log(`▸ After Next day:      "${afterNext}"`);

  if (afterNext === initialDate) {
    console.log('✓ Next day restored the original date.');
  } else {
    console.warn(
      `⚠ Next day landed on "${afterNext}" — expected "${initialDate}".`,
    );
    console.warn('  Some markets skip weekends; that may be the cause.');
  }

  console.log('\n▸ Summary:');
  console.log(`    initial:    ${initialDate}`);
  console.log(`    after prev: ${afterPrev}`);
  console.log(`    after next: ${afterNext}`);

  console.log('\n▸ Browser will stay open for 30s so you can inspect.');
  await page.waitForTimeout(30_000);
  await browser.close();
}

main().catch((err) => {
  console.error('▸ Test failed:', err);
  process.exit(1);
});
