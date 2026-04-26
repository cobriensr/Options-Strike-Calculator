/**
 * One-time interactive login to SpotGamma TRACE that persists the auth
 * state for `capture.ts` to reuse. Run this once; rerun whenever the
 * cookie expires or you log out.
 *
 *   npx tsx scripts/charm-pressure-capture/save-storage.ts
 *
 * What happens:
 *   1. Chromium launches with a visible window and navigates to TRACE.
 *   2. You log in manually (handle MFA, cookie banners, whatever).
 *   3. Once you're sitting on the TRACE chart, return to the terminal
 *      and press Enter.
 *   4. The script writes `.trace-storage.json` to this directory; that
 *      file contains your session cookies + localStorage. It's
 *      gitignored.
 *
 * Why interactive: TRACE auth almost certainly involves SpotGamma
 * SSO, MFA, and bot-protection challenges that are hostile to a fully
 * scripted login. One-time human-in-the-loop is the maintainable
 * answer.
 */

import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORAGE_PATH = join(__dirname, '.trace-storage.json');
const TRACE_URL =
  process.env.TRACE_URL ?? 'https://dashboard.spotgamma.com/trace';

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Opening ${TRACE_URL} — log in manually, then press Enter here.`);
  await page.goto(TRACE_URL);

  // Wait for user to press Enter on stdin. Pause stdin after to release
  // its hold on the event loop so the process can exit cleanly.
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });

  await context.storageState({ path: STORAGE_PATH });
  console.log(`Saved auth state to ${STORAGE_PATH}`);
  await browser.close();
  process.exit(0);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
