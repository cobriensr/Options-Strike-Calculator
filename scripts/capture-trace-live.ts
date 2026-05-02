/**
 * Single-cycle TRACE capture for the live daemon AND for backfill mode.
 *
 * Modes:
 *   Live (no flags):       captures current data, reads spot/stability now.
 *   Backfill (--date and optionally --time): sets the DatePicker, scrubs
 *                                            the time slider to the target
 *                                            CT time, captures historical
 *                                            data for that timestamp.
 *
 * Captures gamma + charm + delta heatmaps in PARALLEL (three browser
 * contexts, all calling screenshot in `Promise.all`) so the three images
 * depict the same wall-clock instant — load-bearing for the cross-chart
 * override hierarchy. Connects to **browserless.io** (no local Chromium
 * needed) — set `BROWSERLESS_TOKEN` env var.
 *
 * Output (stdout): `{ images: { gamma: base64, charm: base64, delta: base64 },
 *                     spot: number, stabilityPct: number | null,
 *                     capturedAt: string }`
 *
 * Auth: reuses scripts/charm-pressure-capture/.trace-storage.json (the
 * gitignored login state from `save-storage.ts`). The cookies are passed
 * to the remote browserless context via `newContext({ storageState })`.
 *
 * Usage:
 *   npx tsx scripts/capture-trace-live.ts
 *   npx tsx scripts/capture-trace-live.ts --date 2026-04-22 --time 09:35
 *
 * Selectors are duplicated from capture-trace.ts (intentional v1 trade-off:
 * keeps the daemon shippable without refactoring the 600-line historical
 * capture script). Source of truth for any selector change: capture-trace.ts.
 */

// Use @playwright/test's chromium (root-level devDep) — has the same API
// as playwright-core's but ships pre-bundled with the project's other
// e2e specs and the historical capture-trace.ts. The daemon shells back
// to the root node_modules via cwd; do not change to playwright-core
// without also bumping the daemon's resolution path.
import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCapturedAtIso } from '../src/utils/trace-live-tz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STORAGE_PATH = join(
  __dirname,
  'charm-pressure-capture',
  '.trace-storage.json',
);

const TRACE_URL =
  process.env.TRACE_URL ?? 'https://dashboard.spotgamma.com/trace';

// Browserless v2 — production-sfo is the US West endpoint.
// /chromium/playwright is the native-Playwright-protocol path (faster
// than CDP for our use case).
const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS ??
  'wss://production-sfo.browserless.io/chromium/playwright';

type ChartKey = 'gamma' | 'charm' | 'delta';
type ChartType = 'Charm Pressure' | 'Delta Pressure' | 'Gamma';

const CHART_TYPES: Record<ChartKey, ChartType> = {
  gamma: 'Gamma',
  charm: 'Charm Pressure',
  delta: 'Delta Pressure',
};

// ---------------------------------------------------------------------------
// CLI parsing — --date YYYY-MM-DD --time HH:MM (CT). Both optional;
// supplied together for backfill, neither for live.
// ---------------------------------------------------------------------------

interface Args {
  date: string | null;
  time: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { date: null, time: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i] ?? null;
    else if (a === '--time') out.time = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      process.stderr.write(
        'Usage: capture-trace-live [--date YYYY-MM-DD --time HH:MM]\n',
      );
      process.exit(0);
    }
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    process.stderr.write(`Invalid --date: ${out.date}\n`);
    process.exit(1);
  }
  if (out.time && !/^\d{1,2}:\d{2}$/.test(out.time)) {
    process.stderr.write(`Invalid --time: ${out.time}\n`);
    process.exit(1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selectors — duplicated from capture-trace.ts. SoT: capture-trace.ts.
// ---------------------------------------------------------------------------

const SEL = {
  datePicker: (page: Page): Locator =>
    page
      .locator(
        'input[aria-label*="date" i], input[placeholder*="YYYY" i], input[placeholder*="MM" i]',
      )
      .first(),
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
  timeSlider: (page: Page): Locator =>
    page.locator('input[type="range"][aria-label="timestamp"]'),
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
  // Animations + portal mount take a beat — give the menu time before
  // hunting for options. Bumped from 800ms to match the historical
  // capture-trace.ts; remote browserless adds RTT to every step.
  await page.waitForTimeout(1200);

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
      await c.click({ timeout: 3000 });
      clicked = true;
      break;
    } catch {
      /* try next */
    }
  }

  if (!clicked) {
    // Diagnostic dump — print everything that looks like a menu option
    // so the next iteration knows the real DOM shape. Same approach as
    // capture-trace.ts. Also save a screenshot to /tmp for visual debug.
    const dump = await page
      .locator('[role="option"], [role="menuitem"], li')
      .evaluateAll((els) =>
        els
          .map((el) => {
            const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
            const text = (el.textContent ?? '').trim().slice(0, 60);
            return text ? `${role}="${text}"` : null;
          })
          .filter(Boolean)
          .slice(0, 30),
      )
      .catch(() => [] as Array<string | null>);

    const screenshotPath = `/tmp/trace-live-fail-${type.replace(/\s+/g, '-')}-${Date.now()}.png`;
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {
        /* don't fail the error path on a failed screenshot */
      });

    throw new Error(
      `could not click option "${type}". ` +
        `Visible after dropdown click: ${JSON.stringify(dump)}. ` +
        `Screenshot saved to ${screenshotPath}`,
    );
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

// ---------------------------------------------------------------------------
// Backfill — date + time-slider scrubbing. Ported from capture-trace.ts.
// ---------------------------------------------------------------------------

async function setDate(page: Page, dateIso: string): Promise<void> {
  const picker = SEL.datePicker(page);
  await picker.waitFor({ state: 'visible', timeout: 5000 });
  let actual = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await picker.click();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
    );
    await page.keyboard.press('Backspace');
    await picker.pressSequentially(dateIso, { delay: 50 + attempt * 30 });
    await page.keyboard.press('Enter');
    await picker.press('Tab').catch(() => {});
    await page.waitForTimeout(800);
    actual = await picker.inputValue().catch(() => '');
    if (actual === dateIso) break;
  }
  if (actual && actual !== dateIso) {
    throw new Error(`date set wrong: wanted ${dateIso}, got ${actual}`);
  }
  await page.waitForTimeout(1700);
}

interface SliderCal {
  startMin: number;
  endMin: number;
  max: number;
}

function parseClockToMin(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d+):(\d+)/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function setSliderRaw(page: Page, value: number): Promise<void> {
  const slider = SEL.timeSlider(page);
  await slider.evaluate((el, val: number) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, String(val));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(500);
}

async function calibrateSlider(page: Page): Promise<SliderCal> {
  const slider = SEL.timeSlider(page);
  const maxAttr = await slider.getAttribute('max').catch(() => null);
  const max = Number.parseInt(maxAttr ?? '100', 10);
  await setSliderRaw(page, 0);
  const startText = await slider.getAttribute('aria-valuetext');
  await setSliderRaw(page, max);
  const endText = await slider.getAttribute('aria-valuetext');
  const startMin = parseClockToMin(startText) ?? 0;
  let endMin = parseClockToMin(endText) ?? 1440;
  if (startMin > endMin) endMin += 1440;
  return { startMin, endMin, max };
}

async function setSliderToTime(
  page: Page,
  hourCt: number,
  minuteCt: number,
  cal: SliderCal,
): Promise<void> {
  const slider = SEL.timeSlider(page);
  await slider.waitFor({ state: 'visible', timeout: 5000 });
  // CT → ET: add 60 min (slider's aria-valuetext is in ET).
  const targetEtMin = hourCt * 60 + minuteCt + 60;
  const span = cal.endMin - cal.startMin;
  const minPerPoint = span / cal.max;
  const adjustToScale = (m: number): number =>
    cal.endMin >= 1440 && m < cal.startMin ? m + 1440 : m;
  const targetAdj = adjustToScale(targetEtMin);

  let value = Math.round(
    Math.max(
      0,
      Math.min(cal.max, ((targetAdj - cal.startMin) / span) * cal.max),
    ),
  );
  let bestValue = value;
  let bestDrift = Number.POSITIVE_INFINITY;
  const seen = new Set<number>();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (seen.has(value)) break;
    seen.add(value);
    await setSliderRaw(page, value);
    await page.waitForTimeout(300);
    const text = await slider.getAttribute('aria-valuetext').catch(() => null);
    const actualMin = parseClockToMin(text);
    if (actualMin === null) break;
    const drift = adjustToScale(actualMin) - targetAdj;
    if (Math.abs(drift) < Math.abs(bestDrift)) {
      bestValue = value;
      bestDrift = drift;
    }
    if (Math.abs(drift) <= 15) break;
    const next = Math.max(
      0,
      Math.min(
        cal.max,
        value -
          Math.sign(drift) *
            Math.max(1, Math.ceil(Math.abs(drift) / minPerPoint)),
      ),
    );
    if (next === value) break;
    value = next;
  }
  if (value !== bestValue) {
    await setSliderRaw(page, bestValue);
    await page.waitForTimeout(300);
  }
}

// ---------------------------------------------------------------------------
// Read header values + screenshot.
// ---------------------------------------------------------------------------

async function readSpotPrice(page: Page): Promise<number | null> {
  try {
    const text = await SEL.spxHeader(page).textContent();
    if (!text) return null;
    const m = SPOT_PRICE_RE.exec(text);
    if (!m) return null;
    const n = Number((m[1] ?? '').replace(/,/g, ''));
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
  const candidates: Locator[] = [
    page.locator('canvas').first(),
    page.locator('[role="figure"]').first(),
    page.locator('main').first(),
  ];
  for (const c of candidates) {
    try {
      await c.waitFor({ state: 'visible', timeout: 1500 });
      const buffer = await c.screenshot({ type: 'png' });
      return buffer.toString('base64');
    } catch {
      /* try next */
    }
  }
  const buffer = await page.screenshot({ type: 'png' });
  return buffer.toString('base64');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function setupChartPage(
  browser: Browser,
  chart: ChartKey,
  args: Args,
): Promise<{ page: Page; sliderCal: SliderCal | null }> {
  const ctx = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await ctx.newPage();
  // Match capture-trace.ts EXACTLY — that script captured 100 days
  // flawlessly, so the goto+wait+ensure* sequence below is the
  // canonical incantation. Critically: NO `{ waitUntil: 'networkidle' }`
  // — TRACE has live polling/WebSocket connections so networkidle never
  // fires; the goto would time out at 30s and proceed against a half-
  // loaded page where the chart-type combobox isn't interactive.
  // Default `load` waits for DOMContentLoaded + load event, which is
  // all TRACE actually needs.
  await page.goto(TRACE_URL);
  await page.waitForTimeout(2000);
  await ensureChartType(page, CHART_TYPES[chart]);
  await ensureGexToggleOn(page);
  await ensureStrikeZoom(page, 8);

  let sliderCal: SliderCal | null = null;
  if (args.date) {
    await setDate(page, args.date);
    sliderCal = await calibrateSlider(page);
    if (args.time) {
      const [h, m] = args.time.split(':').map(Number) as [number, number];
      await setSliderToTime(page, h, m, sliderCal);
    }
  }

  return { page, sliderCal };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(STORAGE_PATH)) {
    process.stderr.write(
      `FATAL: TRACE auth not found at ${STORAGE_PATH}.\n` +
        `Run: npx tsx scripts/charm-pressure-capture/save-storage.ts\n`,
    );
    process.exit(2);
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) {
    process.stderr.write(
      'FATAL: BROWSERLESS_TOKEN env var required (browserless.io API token)\n',
    );
    process.exit(3);
  }

  const wsEndpoint = `${BROWSERLESS_WS}?token=${encodeURIComponent(token)}`;
  const browser = await chromium.connect({ wsEndpoint, timeout: 30_000 });

  // capturedAt: in live mode = now (script start). In backfill mode = the
  // historical UTC instant the user is targeting (date + time CT → UTC).
  // Backfill path uses the shared TZ probe so daemon/src/backfill.ts can
  // pre-compute the same value for its idempotency check.
  let capturedAt: string;
  if (args.date && args.time) {
    const [h, m] = args.time.split(':').map(Number) as [number, number];
    capturedAt = computeCapturedAtIso(args.date, h, m);
  } else {
    capturedAt = new Date().toISOString();
  }

  try {
    const charts: ChartKey[] = ['gamma', 'charm', 'delta'];
    // Sequential init — matches capture-trace.ts's pattern. Three
    // simultaneous TRACE loads from the same auth session can cause
    // server-side rate limiting or partial renders. Parallel was a
    // premature optimization; what actually needs same-instant timing
    // is the SCREENSHOT step at the bottom, not the setup. Setup adds
    // ~30s total wall-clock vs ~10s parallel, but reliable.
    const pageMap = new Map<ChartKey, Page>();
    for (const c of charts) {
      const setup = await setupChartPage(browser, c, args);
      pageMap.set(c, setup.page);
    }

    const gammaPage = pageMap.get('gamma')!;
    const [spot, stabilityPct] = await Promise.all([
      readSpotPrice(gammaPage),
      readStability(gammaPage),
    ]);

    if (spot == null) {
      throw new Error('could not read spot price from TRACE header');
    }

    const [gammaB64, charmB64, deltaB64] = await Promise.all([
      captureChartImage(pageMap.get('gamma')!),
      captureChartImage(pageMap.get('charm')!),
      captureChartImage(pageMap.get('delta')!),
    ]);

    const out = {
      images: { gamma: gammaB64, charm: charmB64, delta: deltaB64 },
      spot,
      stabilityPct,
      capturedAt,
    };
    // Stdout is a pipe to the parent process. macOS pipe buffer = 64KB;
    // our payload is ~1MB. We MUST wait for the kernel to acknowledge the
    // write before the process exits, otherwise process.exit() leaves
    // bytes in flight and the parent gets truncated JSON. Use the
    // callback form of write() — fires after the data is fully drained.
    const json = JSON.stringify(out);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // Successful return — let the finally block close the browser, then
    // Node's natural exit drains stdout one more time. No process.exit(0):
    // exit() is synchronous and would race with stdout drain on the rare
    // case the callback above didn't yet flush the kernel buffer.
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
