/**
 * Page-setup + read helpers for the TRACE capture flow.
 *
 * Each helper takes the active Playwright `Page` plus its own params.
 * On unrecoverable failure they delegate to `failWithDiagnostics` so
 * the daemon's pino logs always include a screenshot path.
 */

import type { Locator, Page } from '@playwright/test';
import { SEL, SPOT_PRICE_RE, type ChartType } from './selectors.js';
import { failWithDiagnostics } from './diagnostics.js';

export async function ensureChartType(
  page: Page,
  type: ChartType,
): Promise<void> {
  const dropdown = SEL.chartTypeDropdown(page);
  try {
    await dropdown.waitFor({ state: 'visible', timeout: 8000 });
  } catch (waitErr) {
    // Combobox never appeared. We're probably on /trace but the page
    // is in some unexpected state — modal, welcome banner, subscription
    // gate, or different render path on browserless. Dump the URL +
    // title + a full-page screenshot so the user can SEE what landed.
    const title = await page.title().catch(() => 'unknown');
    // Also dump any visible top-level UI hints — buttons, dialogs, etc.
    const visibleHints = await page
      .locator(
        'button:visible, [role="dialog"]:visible, h1:visible, h2:visible',
      )
      .evaluateAll((els): string[] =>
        (els as unknown as Array<{ textContent: string | null }>)
          .map((el) => (el.textContent ?? '').trim().slice(0, 80))
          .filter((s): s is string => s.length > 0)
          .slice(0, 20),
      )
      .catch(() => [] as string[]);
    await failWithDiagnostics(page, {
      label: `trace-no-combobox-${type.replace(/\s+/g, '-')}`,
      originalErr: waitErr,
      extra: {
        title: `"${title}"`,
        visibleUi: visibleHints,
        note: 'chart-type combobox not visible after 8s',
      },
    });
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
    await failWithDiagnostics(page, {
      label: `trace-live-fail-${type.replace(/\s+/g, '-')}`,
      extra: {
        wantedOption: `"${type}"`,
        visible: dump,
      },
    });
  }
  await page.waitForTimeout(1500);
  const after = (await dropdown.textContent())?.trim();
  if (after !== type) {
    throw new Error(`chart type mismatch: wanted "${type}", got "${after}"`);
  }
}

export async function ensureGexToggleOn(page: Page): Promise<void> {
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

export async function ensureStrikeZoom(page: Page, target = 8): Promise<void> {
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

export async function readSpotPrice(page: Page): Promise<number | null> {
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

export async function readStability(page: Page): Promise<number | null> {
  try {
    const v = await SEL.stabilityGauge(page).getAttribute('aria-valuenow');
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function captureChartImage(page: Page): Promise<string> {
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
