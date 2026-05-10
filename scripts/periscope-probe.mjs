#!/usr/bin/env node
/**
 * scripts/periscope-probe.mjs
 *
 * Phase 0 probe for the periscope-html-ingestion pipeline.
 * Spec: docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md
 *
 * What this does
 * --------------
 * One-shot Playwright session that captures the rendered HTML + a
 * screenshot of UW Periscope for the user's currently-configured
 * panels (Gamma / Charm / Vanna / Positions). Output lands in
 * docs/tmp/periscope-probe/<timestamp>/. The user hands those files
 * back so Claude can write the production selectors in
 * periscope-scraper/src/scrape.ts.
 *
 * Two-step flow (avoids fragile cookie copying)
 * ----------------------------------------------
 * Step 1 — log in once. Run with `--login`. A headed browser opens
 * to unusualwhales.com. Log in manually, then close the window.
 * The script saves your authenticated session to
 * `~/.periscope-probe-auth.json` (gitignored — never commit).
 *
 * Step 2 — capture. Run without flags. The script reuses the saved
 * session, navigates to PERISCOPE_URL, waits for the chart to render,
 * then writes:
 *   docs/tmp/periscope-probe/<timestamp>/page.html   — full DOM snapshot
 *   docs/tmp/periscope-probe/<timestamp>/page.png    — screenshot for cross-ref
 *   docs/tmp/periscope-probe/<timestamp>/meta.json   — URL, viewport, timing
 *
 * Pre-reqs
 * --------
 *   - Node 24+
 *   - Playwright installed at the repo root: `npm i -D playwright`
 *     (one-time; install Chromium with `npx playwright install chromium`)
 *   - PERISCOPE_URL env var pointing at a 4-panel Periscope view, e.g.
 *     `https://unusualwhales.com/periscope?....` Configure your
 *     preferred panels (Gamma + Charm + Vanna + Positions) in the UW
 *     UI BEFORE running this — the probe captures whatever's rendered.
 *
 * Usage
 * -----
 *   PERISCOPE_URL='https://...' node scripts/periscope-probe.mjs --login
 *   PERISCOPE_URL='https://...' node scripts/periscope-probe.mjs
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const AUTH_PATH = join(homedir(), '.periscope-probe-auth.json');
const OUT_ROOT = resolve(process.cwd(), 'docs/tmp/periscope-probe');

const PERISCOPE_URL = process.env.PERISCOPE_URL;
const LOGIN_BASE = 'https://unusualwhales.com/login';

const isLoginMode = process.argv.includes('--login');

function ts() {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}

async function loginFlow() {
  // Use the OS-installed Chrome (channel: 'chrome') instead of Playwright's
  // bundled Chromium, with the AutomationControlled blink feature disabled.
  // Google's "this browser is not secure" check fires on Playwright's
  // bundled Chromium because of automation fingerprints; system Chrome with
  // this flag often passes. Falls back to Chromium if Chrome isn't installed.
  console.log('▸ Login mode. Opening system Chrome (anti-detection mode)…');
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (err) {
    console.warn('▸ System Chrome not available, falling back to Chromium.');
    console.warn(
      `▸ Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn('▸ Google login may reject this browser. If it does, see');
    console.warn(
      '▸ scripts/periscope-probe.mjs comments for cookie-paste fallback.',
    );
    browser = await chromium.launch({ headless: false });
  }
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto(LOGIN_BASE);
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log('  A browser window opened. Steps:');
  console.log('    1. Log in to Unusual Whales.');
  console.log('    2. Navigate to:');
  console.log(
    '         https://unusualwhales.com/periscope/market-exposures-table',
  );
  console.log('    3. Configure the view: set Date, Timeframe, Expiry, Greek');
  console.log('       to whatever should be the scraper default.');
  console.log('    4. CLOSE the browser window when done.');
  console.log('');
  console.log(
    '  Why step 3 matters: UW persists view filters in localStorage.',
  );
  console.log('  storageState only captures localStorage from origins you');
  console.log('  actually visited in this session, so navigating to Periscope');
  console.log('  + configuring is what makes the scraper inherit your view.');
  console.log('────────────────────────────────────────────────────────────');
  console.log('');
  await page.waitForEvent('close', { timeout: 15 * 60 * 1000 });
  const state = await context.storageState();
  await browser.close();

  // Guard: if the user closed the window without actually logging in (or
  // if a stale cookie auto-logged them in BEFORE the dialog rendered),
  // the saved state is useless. Detect via cookie count + bail loudly.
  const cookieCount = state.cookies?.length ?? 0;
  if (cookieCount === 0) {
    console.error(
      '▸ ERROR: storage state is empty (no cookies). Did you actually log in?',
    );
    console.error(
      '▸ Re-run with --login and complete the UW login form before closing the browser.',
    );
    process.exit(1);
  }

  await writeFile(AUTH_PATH, JSON.stringify(state, null, 2), 'utf8');
  console.log(`▸ Saved auth state to ${AUTH_PATH} (${cookieCount} cookies)`);
  console.log(
    '▸ Now re-run without --login (and with PERISCOPE_URL set) to capture.',
  );
}

async function captureFlow() {
  if (!PERISCOPE_URL) {
    console.error(
      'ERROR: PERISCOPE_URL is required. Set it to your Periscope URL.',
    );
    process.exit(1);
  }
  if (!existsSync(AUTH_PATH)) {
    console.error(
      `ERROR: ${AUTH_PATH} not found. Run with --login first to save auth.`,
    );
    process.exit(1);
  }

  const stamp = ts();
  const outDir = join(OUT_ROOT, stamp);
  await mkdir(outDir, { recursive: true });

  console.log(`▸ Launching headless Chromium…`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1920, height: 1200 },
  });
  const page = await context.newPage();

  console.log(`▸ Navigating to ${PERISCOPE_URL}…`);
  const navStart = Date.now();
  await page.goto(PERISCOPE_URL, { waitUntil: 'networkidle' });

  // Periscope renders values via JS after the network settles. Wait a
  // bit longer for the bars/values to fully populate. The probe is
  // forgiving — if the chart is slow we'd rather wait than capture
  // a partial DOM.
  await page.waitForTimeout(5000);

  const html = await page.content();
  await writeFile(join(outDir, 'page.html'), html, 'utf8');

  await page.screenshot({
    path: join(outDir, 'page.png'),
    fullPage: true,
  });

  const meta = {
    captured_at: new Date().toISOString(),
    url: PERISCOPE_URL,
    nav_duration_ms: Date.now() - navStart,
    viewport: { width: 1920, height: 1200 },
    user_agent: await page.evaluate(() => navigator.userAgent),
    html_bytes: html.length,
  };
  await writeFile(
    join(outDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );

  await browser.close();

  console.log(`▸ Captured to ${outDir}`);
  console.log(`▸ Files: page.html (${html.length} bytes), page.png, meta.json`);
  console.log(
    `▸ Hand the page.html file back so Claude can write the scraper selectors.`,
  );
}

if (isLoginMode) {
  await loginFlow();
} else {
  await captureFlow();
}
