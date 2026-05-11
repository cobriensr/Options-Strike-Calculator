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

import { type Browser, type Page } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pino from 'pino';

// Stealth plugin bundle — 17+ evasion modules that patch the most
// common Chromium-automation tells (chrome.runtime, navigator.plugins,
// WebGL vendor/renderer, iframe.contentWindow, permissions API, etc.).
// UW's anti-bot returns "No data available" for historical dates when
// it detects automation; the basic --disable-blink-features +
// navigator.webdriver patch isn't enough on its own. Wrapping
// chromiumExtra once at module-load time so every browser launched
// through this module gets the full stealth bundle.
chromiumExtra.use(StealthPlugin());
import { LOG_LEVEL, UW_AUTH_STATE_PATH, UW_PERISCOPE_URL } from './config.js';
import { insertSnapshots } from './db.js';
import { parseDateLabel, parsePage } from './parser.js';
import type { Panel, SnapshotRow } from './types.js';

// US equity-options market holidays. SPX trading is closed on these
// dates. Maintained inline because the periscope-scraper service does
// not pull a holiday calendar from anywhere else; if the user backfills
// a year not covered here, dates that fall on holidays will produce
// "No data available" and the scraper logs + skips them, so the
// holiday list is a perf optimization (skip-without-attempt), not a
// correctness gate.
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  '2025-01-01',
  '2025-01-20',
  '2025-02-17',
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

const logger = pino({ level: LOG_LEVEL });

/** Greeks present in the table view's dropdown, in capture order. */
const GREEKS_TO_CAPTURE: ReadonlyArray<{ panel: Panel; label: string }> = [
  { panel: 'gamma', label: 'Gamma' },
  { panel: 'charm', label: 'Charm' },
  { panel: 'vanna', label: 'Vanna' },
];

// ── Time-window helpers (used by both walkers and the backfill loop) ──

const TIMEFRAME_PATTERN = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

/** "8:20" → "08:20"; "08:20" → "08:20". Stable HH:MM string compare. */
function normalizeHhmm(hhmm: string): string {
  const parts = hhmm.split(':');
  const h = parts[0] ?? '0';
  const m = parts[1] ?? '0';
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Extract the slot-start time from a Periscope timeframe label. */
function parseTimeframeStart(label: string): string | null {
  const m = label.match(TIMEFRAME_PATTERN);
  if (m?.[1] == null) return null;
  return normalizeHhmm(m[1]);
}

/**
 * Today's date in America/Chicago, formatted as YYYY-MM-DD. Used by
 * the live scraper to walk the date picker to the current trading
 * day regardless of whatever's saved in the storageState.
 *
 * `Intl.DateTimeFormat` with `en-CA` locale yields ISO-style
 * YYYY-MM-DD format directly — no manual zero-padding needed.
 */
function todayInCT(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Advance an HH:MM string by 10 minutes. "08:20" → "08:30", "08:50" → "09:00". */
function nextTimeframe(slotStartHhmm: string): string {
  const [hStr, mStr] = slotStartHhmm.split(':');
  const totalMin =
    Number.parseInt(hStr ?? '0', 10) * 60 +
    Number.parseInt(mStr ?? '0', 10) +
    10;
  const newH = Math.floor(totalMin / 60);
  const newM = totalMin % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// computeCapturedAt + isCtInRth live in ./dates.ts so unit tests can
// exercise them without booting config.ts (which validates env vars
// at module load). Imported for internal use AND re-exported so
// existing callers (and tests) keep working unchanged.
import { computeCapturedAt } from './dates.js';
export { computeCapturedAt };

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
/**
 * Open the Expiry filter, switch to Single mode, and click the row
 * matching `targetYmd` (YYYY-MM-DD). Returns true on success.
 *
 * UW Periscope renders the Expiry popover into a Radix portal with two
 * tabs (Multi / Single). In Single mode, the popover body is a
 * `<table><tfoot><tr>` list where each row's first `<span class="text-base">`
 * holds a label like `05/08/2026 (0d)`. Clicking the matching row
 * narrows the chart to that single expiry — the user-validated path
 * for working pre-market data on a fresh trading day, since DTE=[0,0]
 * mode renders empty before the first session trades.
 *
 * The function:
 *   1. Locates the Expiry trigger (DropdownFilter with `Expiry` label).
 *   2. Clicks it to open the popover.
 *   3. Clicks the `Single` tab if present.
 *   4. Finds the row whose label starts with the converted `MM/DD/YYYY`.
 *   5. Clicks it and waits for the trigger pill to update.
 *
 * Returns false on any of: trigger not found, Single tab missing, or
 * target date not present in the row list (e.g. a holiday). Callers
 * should fall back to DTE=[0,0] in that case.
 */
async function setExpirySingle(
  page: Page,
  targetYmd: string,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetYmd)) {
    throw new Error(`setExpirySingle: invalid target "${targetYmd}"`);
  }
  const [yyyy, mm, dd] = targetYmd.split('-');
  const targetMdy = `${mm}/${dd}/${yyyy}`;

  const trigger = page
    .locator('div[data-sentry-component="DropdownFilter"]')
    .filter({ has: page.locator('span', { hasText: /^Expiry$/ }) })
    .first();
  if ((await trigger.count()) === 0) {
    logger.warn('setExpirySingle: Expiry trigger not found');
    return false;
  }

  // The DropdownFilter container has multiple clickable children
  // (label, value, info icon). Clicking the container's center can
  // land on the info icon's `DropdownIcon` popover instead of the
  // Expiry filter. Click the value span (`span.text-base` — currently
  // shows "All" or a single-mode date) which is unambiguously the
  // filter trigger.
  const triggerValue = trigger.locator('span.text-base').first();
  await triggerValue.click({ timeout: 5_000 });
  // Probe verified 1500ms is the right settle window for Radix popper
  // mount + content render in this app.
  await page.waitForTimeout(1_500);

  // Find the popover whose content is the Expiry filter (contains a
  // Switch component for Multi/Single tabs). Multiple Radix poppers can
  // be mounted at once — picking by content keeps us off help-icon
  // tooltips and other unrelated poppers.
  const allPoppers = page.locator('[data-radix-popper-content-wrapper]');
  const popperCount = await allPoppers.count();
  let popoverIdx = -1;
  for (let i = 0; i < popperCount; i += 1) {
    const switchCount = await allPoppers
      .nth(i)
      .locator('[data-sentry-component="Switch"]')
      .count();
    if (switchCount > 0) {
      popoverIdx = i;
      break;
    }
  }
  if (popoverIdx === -1) {
    logger.warn(
      { popperCount },
      'setExpirySingle: Expiry popover (with Switch) not found among open Radix poppers',
    );
    await page.keyboard.press('Escape');
    return false;
  }
  const popover = allPoppers.nth(popoverIdx);

  // Click the Single tab. The probe (scripts/periscope-controls-probe.mjs)
  // verified this exact selector + click sequence works to switch the
  // popover from Multi (HierarchicalMultiSelect tree) to Single (flat
  // <table><tfoot><tr> list of MM/DD/YYYY (Nd) labels).
  //
  // BUT: across consecutive setExpirySingle calls (e.g. range backfill
  // walking date-by-date) the popover often opens already on Single
  // because the prior call left it pinned. Re-clicking the active tab
  // toggles it OFF on UW's Switch component, leaving the popover
  // empty and the next row.click() failing with rowCount=0. Detect
  // the pre-existing Single state by checking whether the date list
  // is ALREADY populated on popover open; if yes, skip the tab click.
  const preexistingDateRows = await popover
    .locator('span.text-base')
    .filter({ hasText: /^\d{2}\/\d{2}\/\d{4}/ })
    .count();
  if (preexistingDateRows === 0) {
    const singleTab = popover
      .locator('[data-sentry-component="Switch"]')
      .locator('div', { hasText: /^Single$/ })
      .first();
    if ((await singleTab.count()) === 0) {
      logger.warn('setExpirySingle: Single tab not found in popover');
      await page.keyboard.press('Escape');
      return false;
    }
    await singleTab.click({ timeout: 3_000 });
    // After the Switch toggles to Single, UW lazy-loads the date list.
    // Wait for either a row with `MM/DD/YYYY` to appear OR a 5s timeout.
    await page
      .locator('span.text-base', { hasText: /^\d{2}\/\d{2}\/\d{4}/ })
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(500);
  } else {
    logger.debug(
      { preexistingDateRows },
      'setExpirySingle: popover already in Single mode — skipping tab click',
    );
  }

  // Find the row whose first text-base span starts with MM/DD/YYYY.
  // The row label is `MM/DD/YYYY (Nd)` so we match on prefix.
  const rows = popover.locator('tr', {
    has: page.locator('span.text-base', {
      hasText: new RegExp(`^${escapeRegex(targetMdy)}\\b`),
    }),
  });
  const rowCount = await rows.count();
  if (rowCount === 0) {
    // Known issue (2026-05-08 testing): in headless mode UW's Single
    // popover currently renders only an "All" placeholder row instead
    // of the date list captured by the headed probe — likely a UW UI
    // change since 2026-05-07 OR a headless-detection guard. Fall back
    // to DTE=[0,0]+walkDate. Re-probe with the headed
    // periscope-controls-probe.mjs script to confirm the new markup
    // when UW is up; the rest of this function is ready to consume it.
    const fullHtmlLen = (await popover.innerHTML().catch(() => '')).length;
    logger.warn(
      { targetYmd, targetMdy, fullHtmlLen },
      'setExpirySingle: Single-mode date list not populated — UW UI may have changed',
    );
    await page.keyboard.press('Escape');
    return false;
  }

  await rows.first().click({ timeout: 3_000 });
  // After click, the popover should close and the trigger pill should
  // update to the YYYY-MM-DD or MM/DD/YYYY label. Give UW a beat to
  // refetch + repaint the table for the new expiry.
  await page.waitForTimeout(2_000);

  logger.info(
    { targetYmd, targetMdy },
    'setExpirySingle: clicked target date row',
  );
  return true;
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  logger.info({ minVal, maxVal }, 'setDTEZero: input values after fill');

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

  // Open the popover. Radix's close animation from a prior option
  // click can swallow the next trigger click if we re-click too fast
  // — the click registers but Radix's "click outside" handler treats
  // it as a no-op against the just-finished popover. Settle first,
  // use force:true to bypass actionability flicker, and retry once
  // if the popover doesn't appear.
  let popoverOpen = false;
  for (let attempt = 0; attempt < 2 && !popoverOpen; attempt += 1) {
    await page.waitForTimeout(attempt === 0 ? 800 : 1_500);
    await trigger.click({ timeout: 5_000, force: true });
    try {
      await page
        .locator('[data-radix-popper-content-wrapper]')
        .last()
        .waitFor({ state: 'visible', timeout: 3_500 });
      popoverOpen = true;
    } catch {
      logger.warn(
        { label, attempt: attempt + 1 },
        'selectGreek: popover did not open after trigger click — retrying',
      );
    }
  }
  if (!popoverOpen) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new Error(
      `selectGreek: popover did not open for "${label}" after 2 attempts`,
    );
  }

  const option = page.getByText(label, { exact: true }).last();
  try {
    await option.waitFor({ state: 'visible', timeout: 3_000 });
    await option.scrollIntoViewIfNeeded({ timeout: 2_000 });
    await option.click({ timeout: 3_000 });
  } catch (err) {
    // Diagnostic: dump popover text + take a screenshot so we can
    // SEE the page state when the option isn't clickable.
    const popover = page.locator('[data-radix-popper-content-wrapper]').last();
    const popoverText =
      (await popover.textContent().catch(() => null)) ?? '<unreadable>';
    const screenshotPath = `/tmp/periscope-fail-${label}-${Date.now()}.png`;
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => undefined);
    logger.warn(
      {
        label,
        popoverText: popoverText.replaceAll(/\s+/g, ' ').slice(0, 300),
        screenshotPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'selectGreek: option not clickable — screenshot saved',
    );
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

/**
 * Walk the date picker chevrons until the displayed label matches the
 * target YYYY-MM-DD. UW's date picker label looks like "Thu, May 7"
 * — we parse the current label via parseDateLabel + the target's year,
 * then click prev or next based on direction. Caps at 30 attempts to
 * prevent infinite loops on unparseable labels.
 */
async function walkDateToTarget(page: Page, targetYmd: string): Promise<void> {
  const yearStr = targetYmd.slice(0, 4);
  const year = Number.parseInt(yearStr, 10);
  if (!Number.isFinite(year)) {
    throw new Error(`walkDateToTarget: invalid target "${targetYmd}"`);
  }

  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const prevBtn = page.getByLabel('Previous day').first();
  const nextBtn = page.getByLabel('Next day').first();

  // Decide between the day-chevron path (cheap for ±1-3 days) and the
  // calendar widget (cheap for big jumps). Sequential day-chevron
  // clicks past ~10 in a row appear to trip UW's anti-bot — historical
  // backfills returned 0 rows for every slot until the calendar path
  // was added. Threshold is conservative: anything more than 5
  // calendar-days hops over to the calendar.
  const currentLabel = ((await labelLoc.textContent()) ?? '').trim();
  const currentYmd = parseDateLabel(currentLabel, year);
  if (currentYmd === targetYmd) {
    logger.debug(
      { targetYmd, attempts: 0 },
      'walkDateToTarget: already on target',
    );
    return;
  }
  if (currentYmd != null) {
    const daysApart = Math.abs(daysBetweenYmd(currentYmd, targetYmd));
    if (daysApart > 5) {
      await walkDateViaCalendar(page, targetYmd);
      return;
    }
  }

  // Cap at 200 — covers a full half-year walk if the storageState's
  // saved date is far from the target (which happens on the first day
  // of a multi-month backfill range). Within a range loop, day-to-day
  // walks are 1-3 clicks so the cap is never hit in steady state.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const label = ((await labelLoc.textContent()) ?? '').trim();
    const ymd = parseDateLabel(label, year);
    if (ymd === targetYmd) {
      logger.debug(
        { targetYmd, attempts: attempt },
        'walkDateToTarget: matched (day-chevron path)',
      );
      return;
    }
    if (ymd === null) {
      throw new Error(
        `walkDateToTarget: cannot parse current label "${label}"`,
      );
    }
    if (ymd > targetYmd) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkDateToTarget: did not reach ${targetYmd} after 200 chevron clicks`,
  );
}

/**
 * Calendar-based date walker. Used for big jumps (multi-month backfills)
 * where the day-chevron path would (a) take 80+ clicks and (b) get
 * throttled by UW's anti-bot.
 *
 * Flow:
 *   1. Click `[data-testid="date-picker-button"]` to open the calendar.
 *   2. Read the month-header label ("May 2026"). Compute month delta vs.
 *      the target.
 *   3. Click `aria-label="Previous month"` (or Next) the required number
 *      of times.
 *   4. Click the day cell — `<button>` containing `<span
 *      class="font-medium">{day}</span>`. Skip disabled cells (UW marks
 *      non-trading days with `disabled` + `cursor-not-allowed`).
 *   5. The calendar should auto-close on day-click; if not, press Esc.
 */
async function walkDateViaCalendar(
  page: Page,
  targetYmd: string,
): Promise<void> {
  const targetYear = Number.parseInt(targetYmd.slice(0, 4), 10);
  const targetMonth = Number.parseInt(targetYmd.slice(5, 7), 10); // 1-12
  const targetDay = Number.parseInt(targetYmd.slice(8, 10), 10);

  // Step 1: open the calendar
  const datePill = page.locator('[data-testid="date-picker-button"]').first();
  await datePill.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 2-3: walk months until the header matches target. The header
  // is unique inside the popup — match it by regex on text.
  const monthHeader = page.locator('text=/^[A-Z][a-z]+ 20[0-9]{2}$/').first();
  const prevMonth = page.getByLabel('Previous month').first();
  const nextMonth = page.getByLabel('Next month').first();
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const headerText = ((await monthHeader.textContent()) ?? '').trim();
    const m = /^([A-Z][a-z]+) (20[0-9]{2})$/.exec(headerText);
    if (m == null) {
      throw new Error(
        `walkDateViaCalendar: unparseable month header "${headerText}"`,
      );
    }
    const curMonth = MONTH_NAME_TO_NUM[m[1]!] ?? 0;
    const curYear = Number.parseInt(m[2]!, 10);
    if (curYear === targetYear && curMonth === targetMonth) {
      break;
    }
    const curMonths = curYear * 12 + curMonth;
    const targetMonths = targetYear * 12 + targetMonth;
    if (curMonths > targetMonths) {
      await prevMonth.click({ timeout: 3_000 });
    } else {
      await nextMonth.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(300);
  }

  // Step 4: click the day cell. Filter to enabled cells only — disabled
  // cells (non-trading days, dates outside UW's retention window) are
  // marked with the `disabled` attribute.
  const dayCell = page
    .locator(
      `button:not([disabled]):has(span.font-medium:text-is("${targetDay}"))`,
    )
    .first();
  await dayCell.click({ timeout: 5_000 });
  await page.waitForTimeout(800);

  // Step 5: confirm the date pill now reflects the target (the popup
  // should auto-close on day-click; if it didn't, the assertion still
  // works because the pill text reflects the new selection).
  const labelLoc = page
    .locator('[data-testid="date-picker-button"] span[role="button"]')
    .first();
  const finalLabel = ((await labelLoc.textContent()) ?? '').trim();
  const finalYmd = parseDateLabel(finalLabel, targetYear);
  if (finalYmd !== targetYmd) {
    // Try to dismiss the popup before throwing so subsequent clicks
    // aren't shadowed.
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(
      `walkDateViaCalendar: pill shows "${finalLabel}" (parsed=${finalYmd ?? 'null'}) after click — wanted ${targetYmd}`,
    );
  }
  logger.debug({ targetYmd }, 'walkDateViaCalendar: matched');
}

const MONTH_NAME_TO_NUM: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

/** Calendar-day diff between two YYYY-MM-DD strings (target - current).
 *  Negative when current > target. Used to decide whether to use the
 *  day-chevron path or the calendar path. */
function daysBetweenYmd(currentYmd: string, targetYmd: string): number {
  const a = new Date(`${currentYmd}T12:00:00Z`).getTime();
  const b = new Date(`${targetYmd}T12:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Enumerate trading days (Mon-Fri, US-market non-holidays) from
 * `startDate` through `endDate`, inclusive. Both bounds are YYYY-MM-DD.
 *
 * Uses UTC throughout — date arithmetic is purely calendrical here, no
 * intraday timezone questions. The returned dates are themselves the
 * trading-session calendar dates the scraper will navigate to.
 */
export function tradingDaysBetween(
  startDate: string,
  endDate: string,
): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(
      `tradingDaysBetween: invalid bound — start="${startDate}" end="${endDate}"`,
    );
  }
  while (cursor.getTime() <= end.getTime()) {
    const ymd = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5 && !US_MARKET_HOLIDAYS.has(ymd)) {
      out.push(ymd);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Walk the timeframe-widget chevrons until the displayed slot starts at
 * `targetStartHhmm`. Caps at 80 attempts (covers the full 8:20–15:00
 * day plus a buffer).
 */
async function walkTimeframeToTarget(
  page: Page,
  targetStartHhmm: string,
): Promise<void> {
  const target = normalizeHhmm(targetStartHhmm);
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  const labelSpan = container.locator('span').last();
  const prevBtn = container.locator('button').first();
  const nextBtn = container.locator('button').last();

  // The first label after a date change is often "Latest" — UW's
  // default setting that resolves to the most-recent slot during RTH
  // but is non-parseable on historical dates. We treat any
  // null-parse result as "click prev to escape into specific-time
  // territory" rather than throwing. Cap raised to 90 so the escape
  // attempts plus a full session walk-back fit within budget.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const label = ((await labelSpan.textContent()) ?? '').trim();
    const currentStart = parseTimeframeStart(label);
    if (currentStart === target) {
      logger.debug(
        { target, attempts: attempt },
        'walkTimeframeToTarget: matched',
      );
      return;
    }
    if (currentStart === null) {
      // Likely "Latest" or another non-HHMM label. Click prev to step
      // into specific-time territory; the next iteration will parse.
      logger.debug(
        { label, target },
        'walkTimeframeToTarget: non-HHMM label, clicking prev to escape',
      );
      await prevBtn.click({ timeout: 3_000 });
    } else if (currentStart > target) {
      await prevBtn.click({ timeout: 3_000 });
    } else {
      await nextBtn.click({ timeout: 3_000 });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `walkTimeframeToTarget: did not reach ${target} after 90 chevron clicks`,
  );
}

/**
 * Advance the timeframe by one slot (10 min forward) by clicking the
 * next-chevron button. Caller is responsible for the post-click
 * settle wait — we don't impose one here so the caller can absorb
 * jitter (e.g. data fetch) however suits.
 */
async function advanceTimeframeOneSlot(page: Page): Promise<void> {
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  await container.locator('button').last().click({ timeout: 3_000 });
}

/**
 * Step the timeframe one slot backwards (10 min earlier). Used to
 * escape the "Latest" sentinel when it renders empty — pre-market /
 * post-close, the most recent specific slot has data even when
 * "Latest" appears empty in DTE=[0,0] mode.
 */
async function rewindTimeframeOneSlot(page: Page): Promise<void> {
  const container = page
    .locator('div.rounded-full')
    .filter({ has: page.locator('span', { hasText: /^Timeframe:$/ }) })
    .first();
  await container.locator('button').first().click({ timeout: 3_000 });
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

  // Anti-detection flags. Validated 2026-05-08: UW Periscope serves a
  // stripped-down Single-mode dropdown (only an "All" placeholder, no
  // date list) when navigator.webdriver is true OR the
  // AutomationControlled blink feature is on. Headed runs without
  // these flags get the full 1.2 MB popover with 20 dates; headless
  // got 2 KB. These flags + the init script below close the gap.
  const browser = await chromiumExtra.launch({
    headless,
    slowMo: headless ? 0 : 250,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
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
      // Real Chrome UA — `HeadlessChrome` in the default Playwright UA
      // is the most common automation tell.
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Chicago',
    });
    // Hide navigator.webdriver before any page script runs.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    return await fn(browser, page);
  } finally {
    await browser.close();
  }
}

/**
 * Capture rows for the three Greeks at the current page state. Assumes
 * the page is already on the right date / timeframe / DTE filter — this
 * function only handles the Greek-cycling + parsing.
 *
 * `capturedAt` is stamped on every emitted row. For live ticks pass
 * `new Date().toISOString()`. For backfill, pass a per-slot timestamp
 * computed from the slot's end time.
 */
async function captureCurrentSlot(
  page: Page,
  capturedAt: string,
): Promise<SnapshotRow[]> {
  // Empty-state short-circuit: this page state has no data (e.g. an
  // expiry/date combo that resolves to nothing). Bail cleanly.
  if ((await page.getByText(/no data available/i).count()) > 0) {
    logger.warn('captureCurrentSlot: "No data available" — returning 0 rows');
    return [];
  }

  const slotRows: SnapshotRow[] = [];
  // Anchor: the timeframe we read from the FIRST Greek (gamma). All
  // subsequent Greeks must come from the same slot — Greek-cycling
  // takes 5–10s and UW publishes a new 10-min slot every 10 min, so
  // mid-cycle rollover would silently mix two slots into one
  // captured_at. When drift is detected, walk the timeframe widget
  // back to the anchor and re-parse the panel.
  let anchorTimeframe: string | null = null;
  let anchorStart: string | null = null;

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

    if ((await page.getByText(/no data available/i).count()) > 0) {
      logger.info({ panel: greek.panel }, 'no data for this Greek — skipping');
      continue;
    }

    let html = await page.content();
    let parsed = parsePage(html, capturedAt);

    if (parsed.header.panel !== greek.panel) {
      logger.warn(
        { expected: greek.panel, got: parsed.header.panel },
        'panel mismatch — skipping this Greek',
      );
      continue;
    }

    if (anchorTimeframe === null) {
      // First Greek — record the anchor.
      anchorTimeframe = parsed.header.timeframe;
      anchorStart = parseTimeframeStart(parsed.header.timeframe);
    } else if (parsed.header.timeframe !== anchorTimeframe) {
      // Drift detected — UW rolled to a new slot mid-cycle. Walk the
      // timeframe back to the anchor and re-parse the same Greek.
      logger.info(
        {
          panel: greek.panel,
          anchor: anchorTimeframe,
          got: parsed.header.timeframe,
        },
        'timeframe drift — realigning to gamma anchor',
      );
      if (anchorStart != null) {
        try {
          await walkTimeframeToTarget(page, anchorStart);
          await page.waitForTimeout(1_500);
          html = await page.content();
          parsed = parsePage(html, capturedAt);
          if (parsed.header.timeframe !== anchorTimeframe) {
            logger.warn(
              {
                panel: greek.panel,
                anchor: anchorTimeframe,
                got: parsed.header.timeframe,
              },
              'realign did not converge — committing rows with drifted timeframe',
            );
          }
        } catch (err) {
          logger.warn(
            {
              panel: greek.panel,
              err: err instanceof Error ? err.message : String(err),
            },
            'walkTimeframeToTarget failed during realign — committing drifted rows',
          );
        }
      }
    }

    logger.info(
      {
        panel: greek.panel,
        rows: parsed.rows.length,
        spot: parsed.header.spot,
        expiry: parsed.header.expiry,
        timeframe: parsed.header.timeframe,
        anchorTimeframe,
        capturedAt,
      },
      'parsed Greek',
    );
    slotRows.push(...parsed.rows);
  }

  return slotRows;
}

/**
 * Wait until the page either renders table rows OR has "No data
 * available" persisting for a full poll cycle. UW takes a few seconds
 * to refetch and repaint after a date change; a fixed wait too short
 * yields a stale "no data" read on a date that DOES have data (UW
 * Periscope publishes 10-min slots from ~5:50 CT onward every trading
 * day).
 *
 * Returns true if rows are present, false on persistent "no data".
 * Throws on overall timeout.
 */
async function waitForTableReady(
  page: Page,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveNoData = 0;
  while (Date.now() < deadline) {
    const rowCount = await page.locator('tr.table_row__wxw5u').count();
    if (rowCount > 0) return true;
    const noDataCount = await page.getByText(/no data available/i).count();
    if (noDataCount > 0) {
      consecutiveNoData += 1;
      // Five consecutive "no data" reads spaced 1s apart = genuinely
      // empty (e.g. weekend/holiday). Fewer isn't enough — after a
      // date-walk UW takes 5–10s to refetch and the empty state
      // persists during the request.
      if (consecutiveNoData >= 5) return false;
    } else {
      consecutiveNoData = 0;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    'waitForTableReady: neither rows nor "no data" stabilized within timeout',
  );
}

export async function scrapeAllPanels(): Promise<SnapshotRow[]> {
  return await withBrowser(async (_browser, page) => {
    // Live mode prep order is critical: storageState often restores a
    // stale date from the last --login session, and DTE=[0,0] resolves
    // its expiry against whatever date the page thinks is "current".
    // If we apply DTE=[0,0] BEFORE walking the date forward, the filter
    // gets computed against the stale date and the table renders
    // empty even when today's data exists. So: navigate, walk to today
    // FIRST, wait for the table to populate, THEN apply DTE=[0,0].
    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });

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

    const today = todayInCT();

    // Filter strategy for live mode: prefer Single-Expiry mode for
    // today's date — this is the user-validated path that works
    // pre-market. DTE=[0,0] is empirically empty pre-market on a
    // fresh trading day even when Single-Expiry shows full data.
    //
    // Fall back to walkDateToTarget + DTE=[0,0] when Single-Expiry
    // can't find today's row (holiday, weekend, or markup change).
    let usedSingleExpiry = false;
    try {
      usedSingleExpiry = await setExpirySingle(page, today);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'setExpirySingle threw — falling back to DTE=[0,0]',
      );
    }

    if (usedSingleExpiry) {
      const ready = await waitForTableReady(page);
      logger.info(
        { today, ready, mode: 'single-expiry' },
        'live tick prep complete',
      );
    } else {
      logger.info(
        { today },
        'Single-Expiry unavailable — falling back to walk-date + DTE=[0,0]',
      );
      try {
        await walkDateToTarget(page, today);
        const ready = await waitForTableReady(page);
        logger.info({ today, ready }, 'walked date picker to today');
      } catch (err) {
        logger.warn(
          {
            today,
            err: err instanceof Error ? err.message : String(err),
          },
          'walkDateToTarget(today) failed — proceeding anyway',
        );
      }

      await setDTEZero(page);
      await page.waitForTimeout(2_000);

      // "Latest" sentinel can render empty pre-market in DTE=[0,0] mode
      // even when specific 10-min slots have data. If the table still
      // shows "No data available" at this point, step back one slot to
      // land on the most recent specific timeframe and re-check.
      if ((await page.getByText(/no data available/i).count()) > 0) {
        logger.info(
          'still empty after DTE=[0,0] — rewinding timeframe one slot to escape "Latest"',
        );
        try {
          await rewindTimeframeOneSlot(page);
          const ready = await waitForTableReady(page);
          logger.info({ ready }, 'after timeframe rewind');
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'rewindTimeframeOneSlot failed — proceeding to capture anyway',
          );
        }
      }
    }

    return await captureCurrentSlot(page, new Date().toISOString());
  });
}

/**
 * Backfill mode: walk to a specific historical date, then iterate
 * 10-min timeframe slots from `startHhmm` through `endHhmm`, capturing
 * Gamma + Charm + Vanna at each. Used to seed the database with a
 * full day's intraday history in one run.
 *
 * The captured_at on each row is computed from the slot's END time
 * (e.g. an "08:20 - 08:30" slot stamps captured_at=08:30) so a
 * backfilled day reproduces the live cron's row stamping.
 */
export async function scrapeBackfill(
  targetDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<SnapshotRow[]> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);

  return await withBrowser(async (_browser, page) => {
    logger.info(
      { targetDate, startHhmm: startNorm, endHhmm: endNorm },
      'backfill: starting',
    );

    // Unified backfill prep: navigate, walk the date if needed, then pin
    // Expiry=Single to the target date. DTE=[0,0] does NOT work for
    // historical reads — UW returns "No data available" even when the
    // chart's selected date matches the requested date (verified
    // 2026-05-08 against multiple Nov 2025 dates). The Expiry=Single
    // dropdown DOES list historical dates once the chart has been
    // walked to them (rows like "11/14/2025 (0d)") so we use it for
    // every backfill regardless of today vs. historical.
    logger.info(
      { url: UW_PERISCOPE_URL, targetDate },
      'backfill: navigating + walking date + setting Expiry=Single',
    );
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    const firstRow = page.locator('tr.table_row__wxw5u').first();
    const emptyState = page.getByText(/no data available/i).first();
    try {
      await Promise.race([
        firstRow.waitFor({ state: 'visible', timeout: 20_000 }),
        emptyState.waitFor({ state: 'visible', timeout: 20_000 }),
      ]);
    } catch {
      logger.warn('initial page render did not settle within 20s');
    }

    // Walk the chart date to the target. Required for historical reads
    // because Single-Expiry's dropdown only lists dates near the chart's
    // current selected date — clicking the calendar puts us in the right
    // frame so the dropdown contains targetDate.
    if (targetDate !== todayInCT()) {
      await walkDateToTarget(page, targetDate);
      await page.waitForTimeout(1_500);
    }

    const ok = await setExpirySingle(page, targetDate);
    if (!ok) {
      throw new Error(
        `backfill: setExpirySingle(${targetDate}) failed — UW UI may have changed or date is outside Single-mode dropdown`,
      );
    }
    await waitForTableReady(page);

    await walkTimeframeToTarget(page, startNorm);
    await page.waitForTimeout(1_500);

    const allRows: SnapshotRow[] = [];
    let currentStart = startNorm;
    let slotsScanned = 0;

    while (currentStart <= endNorm) {
      const slotEnd = nextTimeframe(currentStart);
      const capturedAt = computeCapturedAt(targetDate, slotEnd);

      logger.info(
        { slot: `${currentStart}-${slotEnd}`, capturedAt },
        'backfill: scraping slot',
      );

      const slotRows = await captureCurrentSlot(page, capturedAt);
      allRows.push(...slotRows);
      slotsScanned += 1;

      const nextStart = nextTimeframe(currentStart);
      if (nextStart > endNorm) break;

      await advanceTimeframeOneSlot(page);
      // Wait for table to re-render under the new timeframe. UW's
      // data fetch is ~1s under DTE=0 + specific date.
      await page.waitForTimeout(1_500);

      currentStart = nextStart;
    }

    logger.info(
      { totalRows: allRows.length, slotsScanned },
      'backfill: complete',
    );
    return allRows;
  });
}

/**
 * Scrape every trading day in [startDate, endDate], skipping weekends
 * and US-market holidays. Inserts rows per-day so progress is durable
 * — a process kill mid-loop leaves prior days in the DB intact.
 *
 * Returns a summary; rows are NOT returned (they're already inserted).
 * Errors on any single day log + continue to the next day.
 */
export async function scrapeBackfillRange(
  startDate: string,
  endDate: string,
  startHhmm: string,
  endHhmm: string,
): Promise<{
  totalRowsInserted: number;
  daysScanned: number;
  daysFailed: string[];
  totalDays: number;
}> {
  const startNorm = normalizeHhmm(startHhmm);
  const endNorm = normalizeHhmm(endHhmm);
  const dates = tradingDaysBetween(startDate, endDate);

  return await withBrowser(async (_browser, page) => {
    logger.info(
      {
        startDate,
        endDate,
        totalDays: dates.length,
        startHhmm: startNorm,
        endHhmm: endNorm,
      },
      'backfill range: starting',
    );
    if (dates.length === 0) {
      logger.warn(
        { startDate, endDate },
        'backfill range: no trading days in range',
      );
      return {
        totalRowsInserted: 0,
        daysScanned: 0,
        daysFailed: [],
        totalDays: 0,
      };
    }

    // Range backfill prep: navigate to Periscope but DON'T set DTE=0-0.
    // Each day inside the loop walks the calendar to its date and uses
    // setExpirySingle(date) to pin Expiry to that day's 0DTE — which is
    // the only filter path that actually returns rows for historical
    // dates (DTE=0-0 returns "No data available", verified 2026-05-08).
    logger.info({ url: UW_PERISCOPE_URL }, 'navigating to periscope');
    await page.goto(UW_PERISCOPE_URL, { waitUntil: 'networkidle' });
    const firstRow = page.locator('tr.table_row__wxw5u').first();
    const emptyState = page.getByText(/no data available/i).first();
    try {
      await Promise.race([
        firstRow.waitFor({ state: 'visible', timeout: 20_000 }),
        emptyState.waitFor({ state: 'visible', timeout: 20_000 }),
      ]);
    } catch {
      logger.warn('initial page render did not settle within 20s');
    }

    let totalRowsInserted = 0;
    let daysScanned = 0;
    const daysFailed: string[] = [];

    for (const [idx, date] of dates.entries()) {
      const dayStarted = Date.now();
      const progress = `${idx + 1}/${dates.length}`;
      logger.info({ date, progress }, 'backfill range: starting day');

      try {
        await walkDateToTarget(page, date);
        await page.waitForTimeout(1_500);
        const ok = await setExpirySingle(page, date);
        if (!ok) {
          throw new Error(
            `setExpirySingle(${date}) failed — date may be outside Single-mode dropdown for this chart frame`,
          );
        }
        await waitForTableReady(page);
        await walkTimeframeToTarget(page, startNorm);
        await page.waitForTimeout(1_500);

        const dayRows: SnapshotRow[] = [];
        let currentStart = startNorm;
        let slotsScanned = 0;

        while (currentStart <= endNorm) {
          const slotEnd = nextTimeframe(currentStart);
          const capturedAt = computeCapturedAt(date, slotEnd);
          const slotRows = await captureCurrentSlot(page, capturedAt);
          dayRows.push(...slotRows);
          slotsScanned += 1;

          const nextStart = nextTimeframe(currentStart);
          if (nextStart > endNorm) break;
          await advanceTimeframeOneSlot(page);
          await page.waitForTimeout(1_500);
          currentStart = nextStart;
        }

        // Insert this day's rows. ON CONFLICT DO NOTHING in db.ts means
        // a re-run for the same day is idempotent.
        const inserted = await insertSnapshots(dayRows);
        totalRowsInserted += inserted;
        daysScanned += 1;

        logger.info(
          {
            date,
            progress,
            slotsScanned,
            rowsParsed: dayRows.length,
            inserted,
            totalRowsInserted,
            daysFailed: daysFailed.length,
            ms: Date.now() - dayStarted,
          },
          'backfill range: day complete',
        );
      } catch (err) {
        daysFailed.push(date);
        logger.error(
          {
            date,
            progress,
            err: err instanceof Error ? err.message : String(err),
            ms: Date.now() - dayStarted,
          },
          'backfill range: day failed — continuing to next',
        );
        // Try to escape any stuck modal/popover state before next day.
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }

    logger.info(
      { totalRowsInserted, daysScanned, daysFailed, totalDays: dates.length },
      'backfill range: complete',
    );
    return {
      totalRowsInserted,
      daysScanned,
      daysFailed,
      totalDays: dates.length,
    };
  });
}
