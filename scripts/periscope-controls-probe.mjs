#!/usr/bin/env node
/**
 * scripts/periscope-controls-probe.mjs
 *
 * Headed Playwright probe that opens the Timeframe and Expiry controls
 * in turn, captures the popover/expanded HTML, and reports element counts
 * for the common menu-item patterns. Used to figure out the exact
 * markup before wiring production click logic into scrape.ts.
 *
 * Outputs go to docs/tmp/periscope-controls/<timestamp>/:
 *   - timeframe-open.html  (full body innerHTML with Timeframe popover open)
 *   - expiry-open.html     (full body innerHTML with Expiry popover open)
 *   - notes.md             (counts + observations)
 *
 * Usage:
 *   PERISCOPE_URL='https://unusualwhales.com/periscope/market-exposures-table' \
 *     node scripts/periscope-controls-probe.mjs
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const AUTH_PATH = join(homedir(), '.periscope-probe-auth.json');
const OUT_ROOT = resolve(process.cwd(), 'docs/tmp/periscope-controls');
const PERISCOPE_URL = process.env.PERISCOPE_URL;

if (!PERISCOPE_URL) {
  console.error('ERROR: PERISCOPE_URL env var is required.');
  process.exit(1);
}
if (!existsSync(AUTH_PATH)) {
  console.error(`ERROR: ${AUTH_PATH} not found. Run periscope-probe.mjs --login first.`);
  process.exit(1);
}

function ts() {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}

async function captureOpenControl(page, name) {
  // Capture the entire body — popovers in Radix render to a portal at
  // body level, so the popover content is somewhere in there even
  // though the trigger is elsewhere.
  const bodyHtml = await page.evaluate(() => document.body.outerHTML);

  // Counts useful for figuring out the popover shape.
  const counts = await page.evaluate(() => ({
    menuitem: document.querySelectorAll('[role="menuitem"]').length,
    option: document.querySelectorAll('[role="option"]').length,
    listbox: document.querySelectorAll('[role="listbox"]').length,
    radixContent: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
    radixState: document.querySelectorAll('[data-state="open"]').length,
  }));

  return { bodyHtml, counts, name };
}

async function main() {
  const stamp = ts();
  const outDir = join(OUT_ROOT, stamp);
  await mkdir(outDir, { recursive: true });

  console.log('▸ Launching headed Chromium so you can watch...');
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1920, height: 1200 },
  });
  const page = await context.newPage();

  console.log(`▸ Navigating to ${PERISCOPE_URL}...`);
  await page.goto(PERISCOPE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // ── Timeframe ───────────────────────────────────────────────
  // The Timeframe widget is `<span>Timeframe:</span><span>14:50 - 15:00</span>`
  // wrapped in a clickable div. Click that div to see if it opens a
  // list of all timeframes (vs the chevrons just incrementing).
  console.log('\n▸ Trying to open Timeframe...');
  const timeframeArea = page
    .locator('div.cursor-pointer')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();

  if ((await timeframeArea.count()) === 0) {
    console.warn('  ✗ Could not find the Timeframe clickable area.');
  } else {
    const beforeText = (await timeframeArea.textContent())?.trim() ?? '';
    console.log(`  • current label: ${beforeText}`);
    try {
      await timeframeArea.click({ timeout: 3000 });
      await page.waitForTimeout(1500);

      const cap = await captureOpenControl(page, 'timeframe');
      await writeFile(
        join(outDir, 'timeframe-open.html'),
        cap.bodyHtml,
        'utf8',
      );
      console.log(`  ✓ Captured timeframe-open.html (${cap.bodyHtml.length} bytes)`);
      console.log(`  • element counts:`, cap.counts);
    } catch (err) {
      console.warn(`  ✗ Click on Timeframe area failed: ${err.message}`);
    }

    // Click somewhere else to close the popover before next probe.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ── Expiry ──────────────────────────────────────────────────
  // Expiry is a Radix DropdownFilter. Trigger is identifiable by the
  // "Expiry" label inside a div with data-sentry-component=DropdownFilter.
  console.log('\n▸ Trying to open Expiry...');
  const expiryTrigger = page
    .locator('div[data-sentry-component="DropdownFilter"]')
    .filter({ has: page.locator('span', { hasText: /^Expiry$/ }) })
    .first();

  if ((await expiryTrigger.count()) === 0) {
    console.warn('  ✗ Could not find the Expiry dropdown trigger.');
  } else {
    const beforeText = (await expiryTrigger.textContent())?.trim() ?? '';
    console.log(`  • current label: ${beforeText}`);
    try {
      await expiryTrigger.click({ timeout: 3000 });
      await page.waitForTimeout(1500);

      const cap = await captureOpenControl(page, 'expiry');
      await writeFile(
        join(outDir, 'expiry-open.html'),
        cap.bodyHtml,
        'utf8',
      );
      console.log(`  ✓ Captured expiry-open.html (${cap.bodyHtml.length} bytes)`);
      console.log(`  • element counts:`, cap.counts);
    } catch (err) {
      console.warn(`  ✗ Click on Expiry trigger failed: ${err.message}`);
    }
  }

  // Notes file with the counts so I can read it back without re-parsing.
  const notes = [
    `# Periscope controls probe — ${stamp}`,
    '',
    `URL: ${PERISCOPE_URL}`,
    '',
    'Each capture is a full body.outerHTML at the moment the dropdown',
    'is open. Popovers in Radix render into a portal, so the option',
    'list lives near the bottom of <body>, not next to the trigger.',
    '',
    '## What to look for in each file',
    '',
    '- `[role="menuitem"]` count → Radix menu pattern',
    '- `[role="option"]` + `[role="listbox"]` count → Radix select pattern',
    '- `[data-radix-popper-content-wrapper]` → Radix portal root',
    '- Text like "14:50 - 15:00", "2026-05-07" inside the popover → option labels',
    '',
  ].join('\n');
  await writeFile(join(outDir, 'notes.md'), notes, 'utf8');

  console.log(`\n▸ All captures in: ${outDir}`);
  console.log('▸ Browser stays open for 30s for visual inspection.');
  await page.waitForTimeout(30_000);
  await browser.close();
}

main().catch((err) => {
  console.error('▸ Probe failed:', err);
  process.exit(1);
});
