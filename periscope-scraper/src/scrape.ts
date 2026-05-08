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
import {
  LOG_LEVEL,
  UW_AUTH_STATE_PATH,
  UW_PERISCOPE_URL,
} from './config.js';
import { parsePage } from './parser.js';
import type { Panel, SnapshotRow } from './types.js';

const logger = pino({ level: LOG_LEVEL });

/** Greeks present in the table view's dropdown, in capture order. */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; label: string }> = [
  { panel: 'gamma', label: 'Gamma' },
  { panel: 'charm', label: 'Charm' },
  { panel: 'vanna', label: 'Vanna' },
];

/**
 * Open the DTE filter popover and set Min/Max DTE to 0.
 *
 * The user trades 0DTE-only, so the canonical scrape filter is
 * DTE=[0,0]. This forces the table to show today's 0DTE expiry rows
 * and filters out everything else, matching what the user configures
 * by hand. More reliable than walking the Expiry tree.
 *
 * The DTE pill has `data-testid="dte-filter"` (stable), and the inputs
 * inside the popover have placeholders "Min dte" / "Max dte" — we
 * locate by those rather than by tailwind hash class.
 *
 * No-ops gracefully if the popover doesn't appear (e.g. UW renamed
 * the test-id) — the page just won't filter, and we'll see "No data
 * available" downstream which is the existing soft-fail path.
 */
async function setDTEZero(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="dte-filter"]').first();
  if ((await trigger.count()) === 0) {
    logger.warn('setDTEZero: dte-filter trigger not found — skipping');
    return;
  }
  await trigger.click({ timeout: 5_000 });
  // Popover opens via Radix portal — wait for the inputs to be paintable.
  await page.waitForTimeout(800);

  const minInput = page.getByPlaceholder(/min dte/i).first();
  const maxInput = page.getByPlaceholder(/max dte/i).first();

  if ((await minInput.count()) === 0 || (await maxInput.count()) === 0) {
    logger.warn('setDTEZero: Min/Max DTE inputs not found — skipping');
    await page.keyboard.press('Escape');
    return;
  }

  // Use pressSequentially-then-Tab so React sees a real keystroke per
  // character + the blur event UW likely uses to commit. fill() can
  // occasionally bypass the controlled-input handler if React batches
  // updates.
  await minInput.click();
  await minInput.fill('');
  await minInput.pressSequentially('0');
  await page.keyboard.press('Tab');
  await maxInput.click();
  await maxInput.fill('');
  await maxInput.pressSequentially('0');
  await page.keyboard.press('Tab');

  // Verify the inputs hold "0" before closing.
  const minVal = await minInput.inputValue();
  const maxVal = await maxInput.inputValue();
  logger.info(
    { minVal, maxVal },
    'setDTEZero: input values after fill',
  );

  // Close the popover. UW's filter applies on input change, so Escape
  // shouldn't undo it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_500);

  // Diagnostic: log what the trigger pills show now, so a flaky filter
  // commit shows up obviously in the next run's output.
  const pills: Record<string, string> = {};
  const dropdowns = page.locator('div[data-sentry-component="DropdownFilter"]');
  const dropdownCount = await dropdowns.count();
  for (let i = 0; i < dropdownCount; i += 1) {
    const dd = dropdowns.nth(i);
    const spans = dd.locator('span');
    const spanCount = await spans.count();
    let key = '';
    for (let j = 0; j < spanCount; j += 1) {
      const span = spans.nth(j);
      const cls = (await span.getAttribute('class')) ?? '';
      const txt = ((await span.textContent()) ?? '').trim();
      if (cls.includes('text-xs')) {
        key = txt;
      } else if (cls.includes('text-base') && key !== '') {
        pills[key] = txt;
        break;
      }
    }
  }
  const dateBtn = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  if ((await dateBtn.count()) > 0) {
    pills['__date'] = ((await dateBtn.textContent()) ?? '').trim();
  }
  logger.info({ pills }, 'setDTEZero: trigger pill state after apply');
}

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
  // Popover renders to a portal — give Radix a beat to mount.
  await page.waitForTimeout(500);

  // Vanna lives in a table footer (`tfoot > tr > td > span`) rather
  // than the simple flat list Gamma + Charm use. Scoping to the
  // popover wrapper has flaky `.last()` behavior across repeat
  // dropdown opens (stale wrappers from prior clicks). Page-wide
  // exact-text lookup is more robust — when the popover is open the
  // option text appears uniquely outside the trigger (which shows
  // the *previous* selection until commit), so collisions are
  // unlikely. scrollIntoViewIfNeeded handles tfoot rows that fall
  // below the popover's visible scroll area.
  const option = page.getByText(label, { exact: true }).last();
  try {
    await option.scrollIntoViewIfNeeded({ timeout: 2_000 });
    await option.click({ timeout: 3_000 });
  } catch (err) {
    // Diagnostic: dump nearby popover text so the next run shows
    // exactly which options were offered.
    const popover = page.locator('[data-radix-popper-content-wrapper]').last();
    const popoverText =
      (await popover.textContent().catch(() => null)) ?? '<unreadable>';
    logger.warn(
      {
        label,
        popoverText: popoverText.replaceAll(/\s+/g, ' ').slice(0, 300),
        err: err instanceof Error ? err.message : String(err),
      },
      'selectGreek: option not clickable — see popoverText',
    );
    // Close any open popover before bubbling so the next iteration
    // starts from a clean state.
    await page.keyboard.press('Escape').catch(() => undefined);
    throw err;
  }

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
  // HEADLESS=false launches a visible Chromium for debugging — pair
  // with FORCE_TICK=true to step through a single scrape pass while
  // watching the page. Production deploys leave HEADLESS unset so the
  // default `true` applies.
  const headless =
    (process.env.HEADLESS ?? 'true').trim().toLowerCase() !== 'false';
  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 250,
  });
  try {
    // Headless: 1920×1200 to render the full Periscope widescreen layout
    // for clean DOM extraction. Headed: shrink to 1366×768 (laptop-class)
    // so the window fits on a typical screen for visual debugging.
    const viewport = headless
      ? { width: 1920, height: 1200 }
      : { width: 1366, height: 768 };
    const context = await browser.newContext({
      storageState: UW_AUTH_STATE_PATH,
      viewport,
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

    // Wait for SOMETHING to render (table OR empty-state) before we
    // touch filters. The Expiry default is "All" which yields the
    // empty state — the DTE=[0,0] filter we apply next is what makes
    // data appear.
    const firstRow = page.locator('tr.table_row__wxw5u').first();
    const emptyState = page.getByText(/no data available/i).first();
    try {
      await Promise.race([
        firstRow.waitFor({ state: 'visible', timeout: 20_000 }),
        emptyState.waitFor({ state: 'visible', timeout: 20_000 }),
      ]);
    } catch {
      logger.warn(
        'neither table rows nor empty-state appeared after 20s — proceeding anyway',
      );
    }

    // Force DTE=[0,0] before anything else. The default filter combo
    // (Expiry="All" / DTE=any) yields the empty state; DTE=0 narrows
    // to today's 0DTE expiry which is what the user actually trades.
    await setDTEZero(page);

    // Settle: even when the table appears, the inner value cells
    // sometimes render a tick later than the `<tr>` shells.
    await page.waitForTimeout(2_000);

    // Empty-state short-circuit: when "No data available" is rendered,
    // the page header has no spot/min/max text and the data table isn't
    // mounted — parsePage would throw on missing Underlying. Bail with
    // an empty result so the caller gets a clean "0 rows" tick.
    if ((await page.getByText(/no data available/i).count()) > 0) {
      logger.warn(
        'Periscope shows "No data available" — likely outside RTH or filter mismatch. Returning 0 rows.',
      );
      return [];
    }

    const allRows: SnapshotRow[] = [];
    const capturedAt = new Date().toISOString();

    for (const greek of GREEKS_TO_CAPTURE) {
      try {
        await selectGreek(page, greek.label);
      } catch (err) {
        logger.warn(
          {
            panel: greek.panel,
            err: err instanceof Error ? err.message : String(err),
          },
          'selectGreek failed — skipping this Greek',
        );
        continue;
      }

      // Empty state can appear/disappear when switching Greeks if the
      // user's filters resolve to data for some but not others. Re-check
      // per Greek instead of trusting the initial gate.
      if ((await page.getByText(/no data available/i).count()) > 0) {
        logger.info(
          { panel: greek.panel },
          'no data for this Greek — skipping',
        );
        continue;
      }

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
