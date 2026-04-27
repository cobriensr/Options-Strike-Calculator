/**
 * Single-cycle TRACE capture for the live daemon.
 *
 * Captures gamma + charm + delta heatmaps in PARALLEL (three browser
 * contexts, all clicking screenshot in `Promise.all`) so the three
 * images depict the same wall-clock instant — load-bearing for the
 * cross-chart override hierarchy. The daemon spawns this script every
 * 5 minutes during market hours, parses the JSON output from stdout,
 * and POSTs it to /api/trace-live-analyze.
 *
 * Output (stdout): `{ images: { gamma: base64, charm: base64, delta: base64 },
 *                     spot: number, stabilityPct: number | null,
 *                     capturedAt: string }`
 *
 * Auth: reuses scripts/charm-pressure-capture/.trace-storage.json (the
 * gitignored login state from `save-storage.ts`). The daemon and this
 * script must run on the same machine until we move browserless+auth
 * to a hosted runtime.
 *
 * Selectors are duplicated from capture-trace.ts (intentional v1 trade-off:
 * keeps the daemon shippable without refactoring the 600-line historical
 * capture script). Source of truth for any selector change: capture-trace.ts.
 *
 * Usage: `npx tsx scripts/capture-trace-live.ts` — set HEADLESS=0 to debug.
 */

import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STORAGE_PATH = join(
  __dirname,
  'charm-pressure-capture',
  '.trace-storage.json',
);

const TRACE_URL =
  process.env.TRACE_URL ?? 'https://dashboard.spotgamma.com/trace';

type ChartKey = 'gamma' | 'charm' | 'delta';
type ChartType = 'Charm Pressure' | 'Delta Pressure' | 'Gamma';

const CHART_TYPES: Record<ChartKey, ChartType> = {
  gamma: 'Gamma',
  charm: 'Charm Pressure',
  delta: 'Delta Pressure',
};

// ---------------------------------------------------------------------------
// Selectors — duplicated from capture-trace.ts. SoT: capture-trace.ts.
// ---------------------------------------------------------------------------

const SEL = {
  chartTypeDropdown: (page: Page): Locator =>
    page
      .locator('[role="combobox"]')
      .filter({ hasText: /^(Charm Pressure|Delta Pressure|Gamma)$/ })
      .first(),
  gexToggle: (page: Page): Locator =>
    page
      .locator('label')
      .filter({ has: page.locator('p', { hasText: /^0DTE GEX$/ }) })
      .locator('input[type="checkbox"]'),
  strikeZoomSlider: (page: Page): Locator =>
    page
      .locator(
        'input[type="range"][aria-label*="strike" i], input[type="range"][aria-label*="zoom" i]',
      )
      .first(),
  stabilityGauge: (page: Page): Locator =>
    page.locator('[role="meter"]').first(),
  spxHeader: (page: Page): Locator =>
    page.locator(String.raw`text=/\^SPX:/`).locator('..'),
};

const SPOT_PRICE_RE = /\^SPX:\s*([\d,.]+)/;

// ---------------------------------------------------------------------------
// Page setup helpers — port of equivalents in capture-trace.ts.
// ---------------------------------------------------------------------------

async function ensureChartType(page: Page, type: ChartType): Promise<void> {
  const dropdown = SEL.chartTypeDropdown(page);
  await dropdown.waitFor({ state: 'visible', timeout: 8000 });
  const current = (await dropdown.textContent())?.trim();
  if (current === type) return;

  await dropdown.click();
  await page.waitForTimeout(800);

  const exactNameRe = new RegExp(`^\\s*${type}\\s*$`);
  const candidates: Locator[] = [
    page.getByRole('option', { name: type, exact: true }),
    page.getByRole('menuitem', { name: type, exact: true }),
    page
      .locator('[role="listbox"], [role="menu"], [role="presentation"]')
      .getByText(exactNameRe)
      .first(),
    page.locator('li').filter({ hasText: exactNameRe }).first(),
    page.getByText(exactNameRe).nth(1),
  ];

  let clicked = false;
  for (const c of candidates) {
    try {
      await c.click({ timeout: 2000 });
      clicked = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!clicked) {
    throw new Error(`could not select chart type "${type}"`);
  }
  await page.waitForTimeout(1500);
  const after = (await dropdown.textContent())?.trim();
  if (after !== type) {
    throw new Error(`chart type mismatch: wanted "${type}", got "${after}"`);
  }
}

async function ensureGexToggleOn(page: Page): Promise<void> {
  const sw = SEL.gexToggle(page);
  try {
    await sw.waitFor({ state: 'attached', timeout: 3000 });
    if (!(await sw.isChecked())) {
      await sw.dispatchEvent('click');
      await page.waitForTimeout(800);
    }
  } catch {
    /* tolerate missing toggle on this build */
  }
}

async function ensureStrikeZoom(page: Page, target = 8): Promise<void> {
  const slider = SEL.strikeZoomSlider(page);
  try {
    await slider.waitFor({ state: 'visible', timeout: 3000 });
    const cur = Number((await slider.getAttribute('aria-valuenow')) ?? '-1');
    if (cur === target) return;
    if (!Number.isFinite(cur) || cur < 0) {
      await slider.focus();
      await page.keyboard.press('Home');
      for (let i = 0; i < target; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      return;
    }
    const delta = target - cur;
    await slider.focus();
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < Math.abs(delta); i += 1) {
      await page.keyboard.press(key);
    }
  } catch {
    /* tolerate; first frame still readable */
  }
}

async function readSpotPrice(page: Page): Promise<number | null> {
  try {
    const text = await SEL.spxHeader(page).textContent();
    if (!text) return null;
    const m = SPOT_PRICE_RE.exec(text);
    if (!m) return null;
    const cleaned = (m[1] ?? '').replace(/,/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readStability(page: Page): Promise<number | null> {
  try {
    const v = await SEL.stabilityGauge(page).getAttribute('aria-valuenow');
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function captureChartImage(page: Page): Promise<string> {
  // Element screenshot of the chart canvas — pixel-faithful and fast.
  // The historical capture script uses a download-event flow, but that
  // saves to disk; for the daemon we want raw bytes in-process.
  const target = page.locator('canvas, [role="figure"], main').first();
  const buffer = await target.screenshot({ type: 'png' });
  return buffer.toString('base64');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function setupChartPage(
  browser: Browser,
  chart: ChartKey,
): Promise<Page> {
  const ctx = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await ctx.newPage();
  await page.goto(TRACE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await ensureChartType(page, CHART_TYPES[chart]);
  await ensureGexToggleOn(page);
  await ensureStrikeZoom(page, 8);
  // Brief settle for React to finish painting the heatmap layers.
  await page.waitForTimeout(1500);
  return page;
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_PATH)) {
    process.stderr.write(
      `FATAL: TRACE auth not found at ${STORAGE_PATH}.\n` +
        `Run: npx tsx scripts/charm-pressure-capture/save-storage.ts\n`,
    );
    process.exit(2);
  }

  const headless = process.env.HEADLESS !== '0';
  const browser = await chromium.launch({ headless });
  const startedAt = new Date();

  try {
    const charts: ChartKey[] = ['gamma', 'charm', 'delta'];
    // Bring up all 3 pages in parallel — each page has its own context so
    // chart-type is sticky per page.
    const pages = await Promise.all(
      charts.map((c) => setupChartPage(browser, c)),
    );
    const pageMap = new Map<ChartKey, Page>();
    pages.forEach((p, i) => pageMap.set(charts[i]!, p));

    // Read spot + stability from the gamma page (any page would do; gamma
    // is the canonical reference).
    const gammaPage = pageMap.get('gamma')!;
    const [spot, stabilityPct] = await Promise.all([
      readSpotPrice(gammaPage),
      readStability(gammaPage),
    ]);

    if (spot == null) {
      throw new Error('could not read spot price from TRACE header');
    }

    // Same-instant capture: parallel screenshots.
    const [gammaB64, charmB64, deltaB64] = await Promise.all([
      captureChartImage(pageMap.get('gamma')!),
      captureChartImage(pageMap.get('charm')!),
      captureChartImage(pageMap.get('delta')!),
    ]);

    const out = {
      images: {
        gamma: gammaB64,
        charm: charmB64,
        delta: deltaB64,
      },
      spot,
      stabilityPct,
      capturedAt: startedAt.toISOString(),
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } finally {
    await browser.close().catch(() => {
      /* swallow teardown errors */
    });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
