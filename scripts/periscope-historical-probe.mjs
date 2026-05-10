#!/usr/bin/env node
/**
 * scripts/periscope-historical-probe.mjs
 *
 * Diagnostic probe to figure out why backfill returns "No data
 * available" for historical Periscope dates (Dec 2025 / Jan 2026).
 * The user has confirmed UW retains data back to Dec 10, 2025, so
 * the empty response is anti-bot detection rather than missing data.
 *
 * Captures HTML + screenshots + network log for TWO date scenarios in
 * one headed session:
 *   1. Today (2026-05-08) — known-good baseline. Should render data.
 *   2. 2026-01-02         — the date that returned 0 rows in backfill.
 *
 * Output lands in docs/tmp/periscope-historical-probe/<timestamp>/
 * with separate baseline/ and historical/ subdirs. The diff between
 * the two HTML files should expose the specific anti-bot signal UW
 * is using on historical reads.
 *
 * Usage:
 *   node scripts/periscope-historical-probe.mjs
 *
 * The probe is HEADED — you'll see Chromium open. It uses the same
 * storageState the live scraper uses (~/.periscope-probe-auth.json)
 * and the same stealth plugin bundle (puppeteer-extra-plugin-stealth
 * via playwright-extra) that's wired into the production scraper.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Plain playwright (no stealth) for this diagnostic — the goal here is
// to capture the calendar widget's DOM, not to evade detection. Plain
// playwright is what's installed at the repo root.

const AUTH_PATH = join(homedir(), '.periscope-probe-auth.json');
const URL = 'https://unusualwhales.com/periscope/market-exposures-table';
const STAMP = new Date().toISOString().replaceAll(/[.:T]/g, '-').slice(0, 19);
const OUT_ROOT = `docs/tmp/periscope-historical-probe/${STAMP}`;

if (!existsSync(AUTH_PATH)) {
  console.error(`❌ Auth state not found at ${AUTH_PATH}`);
  console.error('   Run scripts/periscope-probe.mjs --login first.');
  process.exit(2);
}

await mkdir(OUT_ROOT, { recursive: true });

async function captureScenario(page, label, navigateFn) {
  const dir = join(OUT_ROOT, label);
  await mkdir(dir, { recursive: true });
  console.log(`\n=== Scenario: ${label} ===`);
  console.log(`Output dir: ${dir}`);
  await navigateFn();
  // Settle
  await page.waitForTimeout(3000);
  const html = await page.content();
  await writeFile(join(dir, 'page.html'), html, 'utf8');
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true });
  // Capture pill state for inline comparison
  const pills = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll(
      '[data-testid*="pill" i], button, span',
    )) {
      const t = el.textContent?.trim() ?? '';
      if (/^(Expiry|DTE|Greek|Date|Strike)/i.test(t.split(/\s+/)[0] ?? '')) {
        out[el.tagName + ':' + el.className.slice(0, 40)] = t;
      }
    }
    return out;
  });
  await writeFile(join(dir, 'pills.json'), JSON.stringify(pills, null, 2));
  // Indicators of empty state
  const emptyCount = await page.locator('text=/no data available/i').count();
  // Captured rows: the table's tbody row count
  const dataRowCount = await page.locator('table tbody tr').count();
  console.log(`  Empty state markers: ${emptyCount}`);
  console.log(`  Data rows visible:   ${dataRowCount}`);
  console.log(`  HTML size (chars):   ${html.length}`);
  return { emptyCount, dataRowCount, htmlSize: html.length };
}

const browser = await chromium.launch({
  headless: false,
  slowMo: 250,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

try {
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // Capture network responses for diff
  const networkLog = [];
  context.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('unusualwhales.com') || url.includes('cloudflare')) {
      networkLog.push({
        url,
        status: resp.status(),
        headers: resp.headers(),
      });
    }
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5000);

  // Scenario 1: baseline (today's default state, no date walk)
  const baseline = await captureScenario(page, 'baseline-today', async () => {
    // No-op — we're already on default state.
  });

  // Scenario 2: actually walk to Nov 14, 2025 via the calendar widget
  // and capture the page state AFTER the walk. This tells us whether
  // the walk succeeded (pill shows the new date) AND whether UW serves
  // data for that date with the current filter set (DTE=0-0).
  const historical = await captureScenario(
    page,
    'walked-to-nov14',
    async () => {
      console.log(
        '  → Clicking date pill via [data-testid="date-picker-button"]',
      );
      const datePill = page
        .locator('[data-testid="date-picker-button"]')
        .first();
      await datePill.click();
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: join(OUT_ROOT, 'walked-to-nov14', '01-calendar-open.png'),
        fullPage: false,
      });

      // Walk months back from current ("May 2026") to "November 2025" — 6
      // clicks of the prev-month chevron.
      console.log('  → Walking months back via aria-label="Previous month"');
      const prevMonth = page.getByLabel('Previous month').first();
      for (let i = 0; i < 6; i += 1) {
        await prevMonth.click({ timeout: 3_000 });
        await page.waitForTimeout(300);
      }
      await page.screenshot({
        path: join(OUT_ROOT, 'walked-to-nov14', '02-on-nov-2025.png'),
        fullPage: false,
      });
      const monthHeader = await page
        .locator('text=/^[A-Z][a-z]+ 20[0-9]{2}$/')
        .first()
        .textContent();
      console.log(`     Month header now: "${monthHeader?.trim()}"`);

      // Click day 14 (must NOT be disabled)
      console.log('  → Clicking day cell 14');
      const dayCell = page
        .locator('button:not([disabled]):has(span.font-medium:text-is("14"))')
        .first();
      const dayCellCount = await dayCell.count();
      console.log(`     enabled "14" buttons: ${dayCellCount}`);
      if (dayCellCount > 0) {
        await dayCell.click({ timeout: 3_000 });
        await page.waitForTimeout(2500);
      }

      // After landing on Nov 14, try setting DTE=0-0 like the scraper
      // does and watch for data to appear over a long-ish window.
      console.log(
        '  → Setting DTE=0-0 manually + watching for table to populate',
      );
      const dteTrigger = page.locator('[data-testid="dte-filter"]').first();
      await dteTrigger.click({ timeout: 5_000 });
      await page.waitForTimeout(800);
      const minInput = page.getByPlaceholder(/min dte/i).first();
      const maxInput = page.getByPlaceholder(/max dte/i).first();
      await minInput.click();
      await minInput.fill('');
      await minInput.pressSequentially('0');
      await page.keyboard.press('Tab');
      await maxInput.click();
      await maxInput.fill('');
      await maxInput.pressSequentially('0');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');

      // Poll for up to 15 seconds. Log row count + empty marker count
      // every 1.5s so we can see the loading curve.
      for (let t = 0; t < 12; t += 1) {
        await page.waitForTimeout(1500);
        const rc = await page.locator('table tbody tr').count();
        const ec = await page.locator('text=/no data available/i').count();
        console.log(`     +${(t + 1) * 1.5}s: rows=${rc} emptyMarkers=${ec}`);
        if (rc > 0 && ec === 0) {
          console.log(
            '     ✓ Data populated — DTE=0-0 IS working on historical',
          );
          break;
        }
      }
      await page.screenshot({
        path: join(OUT_ROOT, 'walked-to-nov14', '04-after-dte-zero.png'),
        fullPage: false,
      });

      // Now: try opening the Expiry filter in Single mode and see whether
      // it lists 11/14/2025 as a selectable expiry. If yes, that's our
      // historical filter path (DTE=0-0 doesn't work for back-dates).
      console.log('  → Probing Expiry=Single dropdown for 11/14/2025');
      const expiryTrigger = page
        .locator('div[data-sentry-component="DropdownFilter"]')
        .filter({ has: page.locator('span', { hasText: /^Expiry$/ }) })
        .first();
      const expiryValue = expiryTrigger.locator('span.text-base').first();
      await expiryValue.click({ timeout: 3_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: join(OUT_ROOT, 'walked-to-nov14', '04-expiry-popover-multi.png'),
        fullPage: false,
      });

      // Click Single tab
      const allPoppers = page.locator('[data-radix-popper-content-wrapper]');
      const popperCount = await allPoppers.count();
      let popoverIdx = -1;
      for (let i = 0; i < popperCount; i += 1) {
        const switchCount = await allPoppers
          .nth(i)
          .locator('[data-sentry-component="Switch"]')
          .count();
        if (switchCount > 0) {
          popoverIdx = i;
          break;
        }
      }
      console.log(`     Expiry popover index (with Switch): ${popoverIdx}`);
      if (popoverIdx >= 0) {
        const popover = allPoppers.nth(popoverIdx);
        const singleTab = popover
          .locator('[data-sentry-component="Switch"]')
          .locator('div', { hasText: /^Single$/ })
          .first();
        const singleTabCount = await singleTab.count();
        console.log(`     Single tab matches: ${singleTabCount}`);
        if (singleTabCount > 0) {
          await singleTab.click({ timeout: 3_000 });
          await page.waitForTimeout(1500);
          await page.screenshot({
            path: join(
              OUT_ROOT,
              'walked-to-nov14',
              '05-expiry-popover-single.png',
            ),
            fullPage: false,
          });

          // List every date row visible (text-base spans matching MM/DD/YYYY).
          const dateRows = await popover
            .locator('span.text-base')
            .filter({ hasText: /^\d{2}\/\d{2}\/\d{4}/ })
            .allTextContents();
          console.log(`     Visible Single-mode date rows: ${dateRows.length}`);
          console.log(
            `     First 5 rows: ${JSON.stringify(dateRows.slice(0, 5))}`,
          );
          const includesNov14 = dateRows.some((t) => t.includes('11/14/2025'));
          console.log(`     Includes 11/14/2025? ${includesNov14}`);
          await writeFile(
            join(OUT_ROOT, 'walked-to-nov14', 'single-expiry-rows.json'),
            JSON.stringify({ dateRows, includesNov14 }, null, 2),
          );
          await page.keyboard.press('Escape');
        }
      }
      await page.waitForTimeout(500);

      // Now: what does the pill say? Is the table populated? Does "No data
      // available" appear?
      await page.screenshot({
        path: join(OUT_ROOT, 'walked-to-nov14', '03-after-day-click.png'),
        fullPage: false,
      });
      const pillText = await page
        .locator('[data-testid="date-picker-button"] span[role="button"]')
        .first()
        .textContent();
      const noDataCount = await page
        .locator('text=/no data available/i')
        .count();
      const tableRowCount = await page.locator('table tbody tr').count();
      console.log(`     Pill after day-click: "${pillText?.trim()}"`);
      console.log(`     "No data available" markers: ${noDataCount}`);
      console.log(`     Table rows: ${tableRowCount}`);
      await writeFile(
        join(OUT_ROOT, 'walked-to-nov14', 'page-state.json'),
        JSON.stringify(
          {
            pillText: pillText?.trim() ?? null,
            noDataCount,
            tableRowCount,
          },
          null,
          2,
        ),
      );
    },
  );

  await writeFile(
    join(OUT_ROOT, 'network.json'),
    JSON.stringify(networkLog, null, 2),
  );
  await writeFile(
    join(OUT_ROOT, 'summary.json'),
    JSON.stringify({ baseline, historical }, null, 2),
  );

  console.log('\n=== Summary ===');
  console.log(`baseline:    ${JSON.stringify(baseline)}`);
  console.log(`historical:  ${JSON.stringify(historical)}`);
  console.log(`network log: ${networkLog.length} responses captured`);
  console.log(`\nArtifacts in ${OUT_ROOT}/`);
  console.log(
    '  baseline-today/page.html       — what we get on the default May 8 view',
  );
  console.log(
    '  historical-2026-01-02/page.html — what we get after clicking the date pill',
  );
  console.log(
    '  historical-2026-01-02/after-pill-click.png — visual after the click',
  );
  console.log('  network.json                   — UW + Cloudflare responses');
} finally {
  // Leave the browser open for 30s so the user can interact / observe.
  console.log(
    '\nLeaving browser open for 30s for visual inspection. Ctrl-C to exit early.',
  );
  await new Promise((r) => setTimeout(r, 30_000));
  await browser.close();
}
