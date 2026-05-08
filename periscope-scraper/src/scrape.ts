/**
 * STUB — not yet implemented.
 *
 * This module is intentionally a stub until Phase 0 of the periscope HTML
 * ingestion spec is complete. Phase 0 runs `scripts/periscope-probe.mjs`
 * locally with a real UW session cookie, captures the rendered HTML for
 * each panel (Gamma / Charm / Vanna / Positions), and hands those samples
 * back so we can wire concrete Playwright selectors here.
 *
 * Why stub instead of speculative selectors: UW Periscope is a private
 * dynamic React UI. Guessing CSS / DOM paths blind would either silently
 * scrape nothing or scrape the wrong cells. A loud error in Sentry on the
 * first tick is the honest failure mode.
 *
 * When Phase 0 lands, replace `scrapeAllPanels` with real Playwright code:
 *   1. Launch chromium, set the UW session cookie on the unusualwhales.com
 *      domain, navigate to UW_PERISCOPE_URL.
 *   2. Wait for each panel to render (await page.waitForSelector).
 *   3. Parse `<div title="Gamma: 12,345.67">` style cells via Locator.evaluateAll,
 *      yielding { panel, strike, value } rows.
 *   4. Stamp every row with the same capturedAt and the chart's expiry date.
 *   5. Close the browser, return the rows.
 *
 * The spec is at:
 *   docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 */

import type { SnapshotRow } from './types.js';

export async function scrapeAllPanels(): Promise<SnapshotRow[]> {
  throw new Error(
    'scrape.ts is a stub — Phase 0 probe must run first to identify selectors. ' +
      'Run scripts/periscope-probe.mjs, capture the HTML, and wire selectors here.',
  );
}
