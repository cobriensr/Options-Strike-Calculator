/**
 * Phase 2a — Periscope Market Maker Exposures Table scraper.
 *
 * Loads the UW Periscope table view in headless Chromium, cycles through
 * the three Greeks (Gamma / Charm / Vanna) by clicking the Greek
 * dropdown, captures the rendered HTML after each switch, and parses
 * per-strike values via the pure parser.
 *
 * Auth: the runtime expects a Playwright `storageState` JSON at
 * UW_AUTH_STATE_PATH (created locally via `scripts/periscope-probe.mjs
 * --login`, then uploaded to Railway as a base64-encoded env var that
 * the `start` step decodes to disk — see README).
 *
 * Page-state assumptions (the user pre-configures the saved view):
 *   - Expiry: today (set in UW UI before the storageState was saved)
 *   - Timeframe: defaults to "Latest" — UW resolves to the most recent
 *     10-min slice during RTH automatically.
 *   - Greek: cycled by this scraper, not pre-set.
 *
 * The page lives at /periscope/market-exposures-table; the URL has no
 * query params for state, so dropdown clicks are the only way to
 * switch Greeks. Same approach Periscope users would take by hand.
 *
 * Spec: docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 *       (Phase 2 — scraper)
 */

import { chromium, type Browser, type Page } from 'playwright';
import pino from 'pino';
import { LOG_LEVEL, UW_PERISCOPE_URL } from './config.js';
import { parsePage } from './parser.js';
import type { Panel, SnapshotRow } from './types.js';

const logger = pino({ level: LOG_LEVEL });

/** Greeks present in the table view's dropdown, in capture order. */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; label: string }> = [
  { panel: 'gamma', label: 'Gamma' },
  { panel: 'charm', label: 'Charm' },
  { panel: 'vanna', label: 'Vanna' },
];

/** Where the Playwright storageState JSON lives. */
const AUTH_STATE_PATH =
  process.env.UW_AUTH_STATE_PATH ?? '/data/uw-auth-state.json';

/**
 * Click the Greek dropdown trigger and pick the named option.
 *
 * The dropdown trigger is the `<div data-sentry-component="DropdownFilter">`
 * that contains a `<span>Greek</span>` label. Clicking it opens a Radix
 * popover; the option to click is a popover item with the matching text.
 *
 * If the trigger already shows the target label (e.g. first iteration
 * happens to land on the user's pre-saved Greek), this no-ops by returning
 * early — saves an unneeded click + render cycle.
 */
async function selectGreek(page: Page, label: string): Promise<void> {
  // Locate the Greek dropdown trigger by walking from the "Greek" text-xs
  // span up to its DropdownFilter ancestor.
  const trigger = page
    .locator('div[data-sentry-component="DropdownFilter"]')
    .filter({ has: page.locator('span', { hasText: /^Greek$/ }) })
    .first();

  // Read the currently-displayed Greek (the text-base sibling). If it
  // already matches our target, skip the click.
  const currentText = (
    await trigger.locator('span.text-base').first().textContent()
  )?.trim();
  if (currentText === label) {
    logger.debug({ label }, 'selectGreek: already on target, skipping click');
    return;
  }

  await trigger.click({ timeout: 5_000 });

  // The popover renders into a portal at body level. Find the menu item
  // by its text content. Radix UI menu items typically have role="menuitem".
  const option = page
    .getByRole('menuitem', { name: new RegExp(`^${label}$`, 'i') })
    .first();
  await option.click({ timeout: 5_000 });

  // Wait for the trigger's text-base span to display the new Greek
  // label. Playwright's locator-based wait avoids serialising a function
  // into the browser context (which would force a `dom` lib in tsconfig).
  await trigger
    .locator('span.text-base')
    .filter({ hasText: new RegExp(`^${label}$`, 'i') })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });

  // Small settle wait: the data table re-renders asynchronously after
  // the dropdown commit. Empirically ~500ms is enough on the captured
  // page; we give 1s to absorb network jitter.
  await page.waitForTimeout(1_000);
}

async function withBrowser<T>(
  fn: (browser: Browser, page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      storageState: AUTH_STATE_PATH,
      viewport: { width: 1920, height: 1200 },
    });
    const page = await context.newPage();
    return await fn(browser, page);
  } finally {
    await browser.close();
  }
}

export async function scrapeAllPanels(): Promise<SnapshotRow[]> {
  return await withBrowser(async (_browser, page) => {
    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });

    // Wait for the data table to render. The first row's appearance is a
    // sufficient signal that React hydration + initial data fetch are done.
    await page.waitForSelector('tr.table_row__wxw5u', { timeout: 30_000 });
    // Extra settle so the values populate (the `<tr>` shells render before
    // their inner `<div title="...">` cells have data).
    await page.waitForTimeout(2_000);

    const allRows: SnapshotRow[] = [];
    const capturedAt = new Date().toISOString();

    for (const greek of GREEKS_TO_CAPTURE) {
      await selectGreek(page, greek.label);

      const html = await page.content();
      const { header, rows } = parsePage(html, capturedAt);

      // Sanity: header.panel must match what we just selected. If UW
      // re-rendered to a different Greek (race condition, click missed),
      // the dropdown text would be stale and we'd write wrong panel rows.
      if (header.panel !== greek.panel) {
        logger.warn(
          { expected: greek.panel, got: header.panel },
          'panel mismatch — skipping this Greek',
        );
        continue;
      }

      logger.info(
        {
          panel: greek.panel,
          rows: rows.length,
          spot: header.spot,
          expiry: header.expiry,
          timeframe: header.timeframe,
        },
        'parsed Greek',
      );
      allRows.push(...rows);
    }

    return allRows;
  });
}
