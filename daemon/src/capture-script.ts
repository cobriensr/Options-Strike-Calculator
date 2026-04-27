/**
 * Single-cycle TRACE capture for the Railway-hosted daemon.
 *
 * Differs from scripts/capture-trace-live.ts (used for local backfill):
 *   - Connects to browserless.io (no local Chromium)
 *   - Auto-logs into SpotGamma at the start of every tick using
 *     TRACE_EMAIL + TRACE_PASSWORD env vars (no stored cookies needed)
 *   - Designed to be spawned by daemon/src/capture.ts as a child process
 *
 * Auto-login flow: navigate to TRACE_URL → if redirected to login page,
 * fill email + password → submit → wait for redirect back to /trace.
 * If already authenticated (rare since we don't persist state), skip.
 *
 * Output (stdout): `{ images: { gamma: base64, charm: base64, delta: base64 },
 *                     spot: number, stabilityPct: number | null,
 *                     capturedAt: string }`
 *
 * Selectors duplicated from scripts/capture-trace.ts. SoT: capture-trace.ts.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const TRACE_URL =
  process.env.TRACE_URL ?? 'https://dashboard.spotgamma.com/trace';

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

// ============================================================
// Selectors — duplicated from scripts/capture-trace.ts.
// ============================================================

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

// ============================================================
// Auto-login. SpotGamma uses a simple email + password form (no MFA
// per user confirmation). If the form selectors drift, capture a
// screenshot to /tmp on failure for diagnosis.
// ============================================================

async function loginIfNeeded(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(TRACE_URL);
  await page.waitForTimeout(2000);

  // Detect login state by URL after redirect, OR by presence of a
  // password field. Either signal means we're not yet authenticated.
  const url = page.url();
  const onLogin =
    /\/login|\/sign[-_]?in|\/auth/i.test(url) ||
    (await page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false));

  if (!onLogin) {
    return;
  }

  // SpotGamma uses MUI form with id="login-username" (note: type="text",
  // NOT type="email") + id="login-password". MUI wires
  // `<label for="login-username">Email *</label>`, so getByLabel works
  // as a robust fallback if the IDs ever change.
  const emailField = page
    .locator('#login-username')
    .or(page.getByLabel('Email').first())
    .first();
  const passwordField = page
    .locator('#login-password')
    .or(page.getByLabel('Password').first())
    .first();

  await emailField.waitFor({ state: 'visible', timeout: 8000 });
  await emailField.fill(email);
  await passwordField.fill(password);

  // SpotGamma's submit button literally reads "Login" (case-sensitive).
  const submitCandidates: Locator[] = [
    page.getByRole('button', { name: 'Login', exact: true }),
    page.locator('button[type="submit"]').first(),
    page.getByRole('button', { name: /sign\s*in|log\s*in|login/i }).first(),
  ];
  let submitted = false;
  for (const c of submitCandidates) {
    try {
      await c.click({ timeout: 3000 });
      submitted = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!submitted) {
    await passwordField.press('Enter');
  }

  await page
    .waitForURL(/\/trace|\/dashboard/, { timeout: 30_000 })
    .catch(async () => {
      const finalUrl = page.url();
      const screenshotPath = `/tmp/trace-login-fail-${Date.now()}.png`;
      await page
        .screenshot({ path: screenshotPath, fullPage: true })
        .catch(() => {
          /* ignore */
        });
      throw new Error(
        `Login did not redirect to /trace within 30s. Final URL: ${finalUrl}. Screenshot: ${screenshotPath}`,
      );
    });
  await page.waitForTimeout(2000);
}

// ============================================================
// Page setup helpers
// ============================================================

async function ensureChartType(page: Page, type: ChartType): Promise<void> {
  const dropdown = SEL.chartTypeDropdown(page);
  try {
    await dropdown.waitFor({ state: 'visible', timeout: 8000 });
  } catch (waitErr) {
    // Combobox never appeared. We're probably on /trace but the page
    // is in some unexpected state — modal, welcome banner, subscription
    // gate, or different render path on browserless. Dump the URL +
    // title + a full-page screenshot so the user can SEE what landed.
    const finalUrl = page.url();
    const title = await page.title().catch(() => 'unknown');
    const screenshotPath = `/tmp/trace-no-combobox-${type.replace(/\s+/g, '-')}-${Date.now()}.png`;
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {
        /* ignore */
      });
    // Also dump any visible top-level UI hints — buttons, dialogs, etc.
    const visibleHints = await page
      .locator('button:visible, [role="dialog"]:visible, h1:visible, h2:visible')
      .evaluateAll(
        (els): string[] =>
          (els as unknown as Array<{ textContent: string | null }>)
            .map((el) => (el.textContent ?? '').trim().slice(0, 80))
            .filter((s): s is string => s.length > 0)
            .slice(0, 20),
      )
      .catch(() => [] as string[]);
    throw new Error(
      `chart-type combobox not visible after 8s. ` +
        `URL: ${finalUrl} ` +
        `Title: "${title}" ` +
        `Visible UI: ${JSON.stringify(visibleHints)} ` +
        `Screenshot: ${screenshotPath} ` +
        `(originalErr: ${waitErr instanceof Error ? waitErr.message : String(waitErr)})`,
    );
  }
  const current = (await dropdown.textContent())?.trim();
  if (current === type) return;

  await dropdown.click();
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
    // evaluateAll runs in the browser context (DOM available at runtime).
    // Daemon's tsconfig is Node-only (no DOM lib); cast to a minimal
    // DOM-shaped interface to satisfy the type-checker.
    interface MinimalElement {
      getAttribute(name: string): string | null;
      tagName: string;
      textContent: string | null;
    }
    const dump = await page
      .locator('[role="option"], [role="menuitem"], li')
      .evaluateAll(
        (els): Array<string | null> =>
          (els as unknown as MinimalElement[])
            .map((el): string | null => {
              const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
              const text = (el.textContent ?? '').trim().slice(0, 60);
              return text ? `${role}="${text}"` : null;
            })
            .filter((s): s is string => s !== null)
            .slice(0, 30),
      )
      .catch(() => [] as Array<string | null>);
    const screenshotPath = `/tmp/trace-live-fail-${type.replace(/\s+/g, '-')}-${Date.now()}.png`;
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {
        /* ignore */
      });
    throw new Error(
      `could not click option "${type}". Visible: ${JSON.stringify(dump)}. Screenshot: ${screenshotPath}`,
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
    /* tolerate */
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
    /* tolerate */
  }
}

async function readSpotPrice(page: Page): Promise<number | null> {
  try {
    const text = await SEL.spxHeader(page).textContent();
    if (!text) return null;
    const m = text.match(SPOT_PRICE_RE);
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

// ============================================================
// Main
// ============================================================

async function setupChartPage(
  context: BrowserContext,
  chart: ChartKey,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(TRACE_URL);
  await page.waitForTimeout(2000);
  await ensureChartType(page, CHART_TYPES[chart]);
  await ensureGexToggleOn(page);
  await ensureStrikeZoom(page, 8);
  return page;
}

async function main(): Promise<void> {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) {
    process.stderr.write('FATAL: BROWSERLESS_TOKEN env var required\n');
    process.exit(3);
  }
  const email = process.env.TRACE_EMAIL;
  const password = process.env.TRACE_PASSWORD;
  if (!email || !password) {
    process.stderr.write(
      'FATAL: TRACE_EMAIL and TRACE_PASSWORD env vars required\n',
    );
    process.exit(4);
  }

  const wsEndpoint = `${BROWSERLESS_WS}?token=${encodeURIComponent(token)}`;
  const browser: Browser = await chromium.connect({
    wsEndpoint,
    timeout: 30_000,
  });
  const startedAt = new Date();

  try {
    // Single context: login once, all 3 chart pages inherit the cookie.
    const context = await browser.newContext();
    const loginPage = await context.newPage();
    await loginIfNeeded(loginPage, email, password);
    await loginPage.close();

    const charts: ChartKey[] = ['gamma', 'charm', 'delta'];
    const pageMap = new Map<ChartKey, Page>();
    for (const c of charts) {
      const page = await setupChartPage(context, c);
      pageMap.set(c, page);
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
      capturedAt: startedAt.toISOString(),
    };

    // Drain stdout fully before exit (pipe buffer is 64KB on macOS,
    // payload is ~1MB).
    const json = JSON.stringify(out);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
