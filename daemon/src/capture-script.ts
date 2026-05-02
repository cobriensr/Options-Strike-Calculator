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
 * The auth flow, selectors, DOM helpers, and failure-diagnostics live
 * in `daemon/src/capture/`. This file is the orchestration shell:
 * connect → login → setup 3 chart pages → screenshot → emit JSON.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { loginIfNeeded } from './capture/auth.js';
import { CHART_TYPES, type ChartKey } from './capture/selectors.js';
import {
  captureChartImage,
  ensureChartType,
  ensureGexToggleOn,
  ensureStrikeZoom,
  readSpotPrice,
  readStability,
} from './capture/dom-helpers.js';

// Query params are LOAD-BEARING. Without `traceSym=SPX` SpotGamma may
// render a symbol-selection prompt (or fall back to anonymous preview)
// instead of the chart. `mktActor=mm` selects Market Maker mode which
// is what the historical capture-trace.ts study used.
const TRACE_URL =
  process.env.TRACE_URL ??
  'https://dashboard.spotgamma.com/trace?mktActor=mm&traceSym=SPX';

const LOGIN_URL =
  process.env.TRACE_LOGIN_URL ?? 'https://dashboard.spotgamma.com/login';

const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS ??
  'wss://production-sfo.browserless.io/chromium/playwright';

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
    await loginIfNeeded(loginPage, {
      email,
      password,
      traceUrl: TRACE_URL,
      loginUrl: LOGIN_URL,
    });
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
