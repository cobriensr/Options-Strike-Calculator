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
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function loginFlow() {
  console.log('▸ Login mode. Opening headed Chromium…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_BASE);
  console.log('▸ A browser window has opened. Log in to UW manually.');
  console.log("▸ When you're done, CLOSE the browser window to save state.");
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
