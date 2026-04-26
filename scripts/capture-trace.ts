/**
 * Shared SpotGamma TRACE capture script. Captures ONE chart type per
 * run; pick via CHART env var:
 *
 *   CHART=charm npx tsx scripts/capture-trace.ts   # → charm-pressure-capture/
 *   CHART=delta npx tsx scripts/capture-trace.ts   # → delta-pressure-capture/
 *   CHART=gamma npx tsx scripts/capture-trace.ts   # → gamma-capture/
 *
 * Default if CHART is unset: charm. HEADLESS=0 to watch the browser.
 *
 * For each `selected=Y` row in the chart's candidate-days.csv, captures
 * four PNGs at 08:30 / 12:00 / 14:30 / 15:00 CT. The 14:30 CT slot
 * matches the last valid moment of SpotGamma's Stability% 9:30–3:30 ET
 * window. Three CSVs (one per chart folder) hold per-chart pin features
 * separately so the EDA can compare across chart types.
 *
 *   # one-time auth (writes scripts/charm-pressure-capture/.trace-storage.json)
 *   npx tsx scripts/charm-pressure-capture/save-storage.ts
 *
 * Output (per CHART):
 *   - PNGs: scripts/<chart-folder>/screenshots/<date>/{open,mid,close,eod}.png
 *   - CSV:  scripts/<chart-folder>/candidate-days.csv (stability_*,
 *           spot_at_*_capture columns updated for that chart's run)
 */

import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auth lives with the original charm capture folder where save-storage.ts
// wrote it; all three chart runs share this single login state.
const STORAGE_PATH = join(
  __dirname,
  'charm-pressure-capture',
  '.trace-storage.json',
);

type ChartKey = 'charm' | 'delta' | 'gamma';
type ChartType = 'Charm Pressure' | 'Delta Pressure' | 'Gamma';

const CHART_NAMES: Record<ChartKey, ChartType> = {
  charm: 'Charm Pressure',
  delta: 'Delta Pressure',
  gamma: 'Gamma',
};

// Per-chart output folders. gamma-capture has no "-pressure-" infix to
// match the existing project naming for the gamma study folder.
const CHART_FOLDERS: Record<ChartKey, string> = {
  charm: 'charm-pressure-capture',
  delta: 'delta-pressure-capture',
  gamma: 'gamma-capture',
};

function parseChartKey(): ChartKey {
  const raw = (process.env.CHART ?? 'charm').toLowerCase();
  if (raw === 'charm' || raw === 'delta' || raw === 'gamma') return raw;
  throw new Error(
    `CHART must be charm | delta | gamma (got "${process.env.CHART ?? ''}")`,
  );
}

const CHART_KEY = parseChartKey();
const CHART_TYPE = CHART_NAMES[CHART_KEY];
const CHART_FOLDER = join(__dirname, CHART_FOLDERS[CHART_KEY]);
const CSV_PATH = join(CHART_FOLDER, 'candidate-days.csv');
const SCREENSHOTS_DIR = join(CHART_FOLDER, 'screenshots');

const TRACE_URL =
  process.env.TRACE_URL ?? 'https://dashboard.spotgamma.com/trace';

// ---------------------------------------------------------------------------
// Capture schedule (CT). The 14:30 CT close capture matches 15:30 ET, which
// is the last valid moment of SpotGamma's Stability% 9:30–3:30 ET window.
// ---------------------------------------------------------------------------

interface CaptureSlot {
  label: 'open' | 'mid' | 'close' | 'eod';
  hourCt: number;
  minuteCt: number;
}

// Four captures per day:
//   open / mid / close — within the Stability% valid window (9:30–3:30 ET)
//   eod                — 15:00 CT (16:00 ET), post-close. Stability% is
//                        invalid here; this slot exists for the visual:
//                        confirms where SPX actually settled vs the close
//                        slot's prediction. The CSV already has spx_close
//                        from day_embeddings enrichment so we don't scrape
//                        spot/stability for this slot.
const SLOTS: CaptureSlot[] = [
  { label: 'open', hourCt: 8, minuteCt: 30 },
  { label: 'mid', hourCt: 12, minuteCt: 0 },
  { label: 'close', hourCt: 14, minuteCt: 30 },
  { label: 'eod', hourCt: 15, minuteCt: 0 },
];

// ---------------------------------------------------------------------------
// TRACE DOM selectors — REVIEW + UPDATE after first run.
//
// SpotGamma's chart UI is undocumented, and Playwright's auto-discovery
// doesn't ship with selector hints, so the values below are best-effort
// guesses based on the screenshots in the spec. Open TRACE in DevTools,
// inspect each control, and replace the placeholder selector with the
// most stable role-based or aria-labeled match available.
// ---------------------------------------------------------------------------

interface TraceSelectors {
  /** Date input (the calendar widget at the top right of the chart). */
  datePicker: (page: Page) => Locator;

  /** Chart-type dropdown (Charm Pressure / Delta Pressure / Gamma). */
  chartTypeDropdown: (page: Page) => Locator;

  /** 0DTE GEX toggle — must be ON for the study. */
  gexToggle: (page: Page) => Locator;

  /** Strike Plot Zoom slider — must be at value 8 for consistent crops. */
  strikeZoomSlider: (page: Page) => Locator;

  /** The historical playback slider's underlying range input. */
  timeSlider: (page: Page) => Locator;

  /** The Stability % gauge — its inner text contains "11%" or similar. */
  stabilityGauge: (page: Page) => Locator;

  /** SPX header readout — the numeric value next to "^SPX:". */
  spxHeader: (page: Page) => Locator;

  /** Camera / "download chart" button on the heatmap pane. */
  cameraButton: (page: Page) => Locator;
}

const TRACE_SELECTORS: TraceSelectors = {
  // MUI DatePicker — actual <input> with a date-ish aria-label/placeholder.
  datePicker: (page) =>
    page
      .locator(
        'input[aria-label*="date" i], input[placeholder*="YYYY" i], input[placeholder*="MM" i]',
      )
      .first(),

  // Chart-type dropdown is a div with role="combobox" containing the
  // visible text "Charm Pressure" / "Delta Pressure" / "Gamma".
  chartTypeDropdown: (page) =>
    page
      .locator('[role="combobox"]')
      .filter({ hasText: /^(Charm Pressure|Delta Pressure|Gamma)$/ })
      .first(),

  // 0DTE GEX toggle — TRACE wraps an <input type="checkbox"> in a
  // <label> whose visible <p> contains "0DTE GEX". role="switch" is NOT
  // present on this element, so we target by parent label's text.
  gexToggle: (page) =>
    page
      .locator('label')
      .filter({ has: page.locator('p', { hasText: /^0DTE GEX$/ }) })
      .locator('input[type="checkbox"]'),

  // Strike Plot Zoom — MUI Slider with input[type="range"]. We don't have
  // the actual aria-label confirmed yet, so target by proximity to the
  // "Strike Plot Zoom" label text. Falls back to "first range input that
  // isn't the timestamp slider" if the label-anchored selector misses.
  strikeZoomSlider: (page) =>
    page
      .locator(
        'input[type="range"][aria-label*="strike" i], ' +
          'input[type="range"][aria-label*="zoom" i]',
      )
      .first(),

  // Time-playback slider: input[type="range"] with aria-label="timestamp"
  // (confirmed from real DOM).
  timeSlider: (page) =>
    page.locator('input[type="range"][aria-label="timestamp"]'),

  // Stability gauge: <div role="meter" aria-valuenow="21.738..."> — read
  // aria-valuenow directly for sub-percent precision.
  stabilityGauge: (page) => page.locator('[role="meter"]').first(),

  // Header structure: ^SPX: 7163.85 | +0.70 (0.01%).
  spxHeader: (page) => page.locator(String.raw`text=/\^SPX:/`).locator('..'),

  // Camera/download button — distinctive SVG with viewBox="0 0 1000 1000"
  // (ordinary MUI icons use 0 0 24 24). Wrapped in some clickable parent;
  // we click that parent rather than the SVG itself.
  cameraButton: (page) =>
    page.locator(
      'button:has(svg[viewBox="0 0 1000 1000"]), [role="button"]:has(svg[viewBox="0 0 1000 1000"])',
    ),
};

// ---------------------------------------------------------------------------
// CSV io
// ---------------------------------------------------------------------------

interface CsvDoc {
  header: string[];
  rows: string[][];
  index: Map<string, number>;
}

function readCsv(): CsvDoc {
  const text = readFileSync(CSV_PATH, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0]!.split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  const index = new Map<string, number>();
  header.forEach((c, i) => index.set(c, i));
  return { header, rows, index };
}

function writeCsv(doc: CsvDoc): void {
  const out = [doc.header.join(','), ...doc.rows.map((r) => r.join(','))].join(
    '\n',
  );
  writeFileSync(CSV_PATH, `${out}\n`);
}

// ---------------------------------------------------------------------------
// TRACE interactions
// ---------------------------------------------------------------------------

async function ensureGexToggleOn(page: Page): Promise<void> {
  const sw = TRACE_SELECTORS.gexToggle(page);
  try {
    await sw.waitFor({ state: 'attached', timeout: 3000 });
    // The toggle is a real <input type="checkbox">; isChecked() reads
    // the element's `checked` property (the live state), unlike
    // getAttribute('aria-checked') which returns null because this
    // toggle doesn't expose aria-checked.
    const isOn = await sw.isChecked();
    if (!isOn) {
      // Click the visual switch (the input is hidden behind it). MUI
      // routes the click through to the input.
      await sw.dispatchEvent('click');
      await page.waitForTimeout(800);
    }
  } catch {
    console.warn(
      '  ensureGexToggleOn: could not find/verify 0DTE GEX toggle; ' +
        'inspect first capture and re-run if disabled.',
    );
  }
}

async function ensureStrikeZoom(page: Page, target = 8): Promise<void> {
  // MUI Slider: focus + ArrowRight/ArrowLeft are the canonical way to
  // change value because they fire React's onChange. Setting
  // aria-valuenow directly does not.
  const slider = TRACE_SELECTORS.strikeZoomSlider(page);
  try {
    await slider.waitFor({ state: 'visible', timeout: 3000 });
    const current = Number(
      (await slider.getAttribute('aria-valuenow')) ?? '-1',
    );
    if (current === target) return;
    if (!Number.isFinite(current) || current < 0) {
      // Slider domain unknown — fall through to focus + Home + N right-presses.
      await slider.focus();
      await page.keyboard.press('Home');
      for (let i = 0; i < target; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      return;
    }
    const delta = target - current;
    await slider.focus();
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < Math.abs(delta); i += 1) {
      await page.keyboard.press(key);
    }
  } catch {
    console.warn(
      `  ensureStrikeZoom: could not set zoom=${target}; ` +
        'inspect first capture and re-run if frame is wrong.',
    );
  }
}

async function ensureChartType(page: Page, type: ChartType): Promise<void> {
  // Mis-typed captures would silently corrupt the dataset, so we MUST
  // land on the requested type. Read live, click + select-option, then
  // verify by reading back. Throw on mismatch so the caller can skip
  // the day rather than save the wrong chart under the requested name.
  const dropdown = TRACE_SELECTORS.chartTypeDropdown(page);
  await dropdown.waitFor({ state: 'visible', timeout: 5000 });
  const current = (await dropdown.textContent())?.trim();
  if (current === type) return;

  await dropdown.click();
  // Animations + portal mount take a beat — give the menu time before
  // hunting for options.
  await page.waitForTimeout(800);

  // TRACE's dropdown may be MUI Select (role=option in role=listbox),
  // a Mantine Select (role=menuitem in role=menu), or a custom popper
  // with no roles at all. Try each candidate locator in order; first
  // one that clicks wins.
  const exactNameRe = new RegExp(`^\\s*${type}\\s*$`);
  const candidates: Locator[] = [
    page.getByRole('option', { name: type, exact: true }),
    page.getByRole('menuitem', { name: type, exact: true }),
    page
      .locator('[role="listbox"], [role="menu"], [role="presentation"]')
      .getByText(exactNameRe)
      .first(),
    // Plain <li> in any open popup, filtered by exact text.
    page.locator('li').filter({ hasText: exactNameRe }).first(),
    // Last-ditch: any visible element with exact matching text that
    // isn't the dropdown trigger itself.
    page.getByText(exactNameRe).nth(1),
  ];

  let clicked = false;
  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 2000 });
      clicked = true;
      break;
    } catch {
      /* try next strategy */
    }
  }

  if (!clicked) {
    // Diagnostic dump: print everything that looks like a menu option so
    // the next iteration knows the real DOM shape.
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
      .catch(() => []);
    throw new Error(
      `could not click option "${type}". Visible after dropdown click: ${JSON.stringify(dump)}`,
    );
  }

  // Chart re-fetch + remount of the slider takes a beat after dropdown change.
  await page.waitForTimeout(1500);
  const after = (await dropdown.textContent())?.trim();
  if (after !== type) {
    throw new Error(
      `chart type did not switch: wanted "${type}", got "${after ?? 'null'}"`,
    );
  }
}

async function setDate(page: Page, dateIso: string): Promise<void> {
  // MUI X DatePicker is a segmented masked input. `fill()` updates the
  // value but doesn't always fire the chart-refetch onChange handler.
  // pressSequentially with realistic delays gets each segment's parser
  // to fire its own change event. But pressSequentially occasionally
  // drops keystrokes (typically in the day segment), so we retry up to
  // 3 times until the input read-back matches.
  const picker = TRACE_SELECTORS.datePicker(page);
  await picker.waitFor({ state: 'visible', timeout: 5000 });

  let actualInput = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await picker.click();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
    );
    await page.keyboard.press('Backspace');
    // Slightly slower delay on retries — gives the mask parser more time
    // to settle between keystrokes.
    await picker.pressSequentially(dateIso, { delay: 50 + attempt * 30 });
    await page.keyboard.press('Enter');
    await picker.press('Tab').catch(() => {});
    await page.waitForTimeout(800);
    actualInput = await picker.inputValue().catch(() => '');
    if (actualInput === dateIso) break;
  }

  if (actualInput && actualInput !== dateIso) {
    throw new Error(`date set wrong: wanted ${dateIso}, got ${actualInput}`);
  }
  // Final wait for the chart to fully re-render after the successful set.
  await page.waitForTimeout(1700);

  // Verify the *chart* navigated, not just the input. The chart's
  // x-axis label shows the human-readable date (e.g. "Aug 4, 2025"),
  // and that label is updated only when the data successfully reloads.
  // If the input is right but the chart didn't navigate, throw and
  // skip — captures would be from the wrong day otherwise.
  const expected = humanReadableDate(dateIso);
  const chartLabel = await page
    .locator(`text=/${expected.regex}/`)
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  if (!chartLabel) {
    throw new Error(
      `chart did not navigate to ${dateIso} (label "${expected.label}" not visible)`,
    );
  }
}

function humanReadableDate(dateIso: string): { label: string; regex: string } {
  // ISO YYYY-MM-DD → "Mon D, YYYY" (matches the chart x-axis legend).
  const parts = dateIso.split('-').map(Number);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[parts[1]! - 1] ?? '???';
  const label = `${month} ${parts[2]}, ${parts[0]}`;
  // Regex needs no escapes for the date pattern; safe characters only.
  return { label, regex: `${month} ${parts[2]}, ${parts[0]}` };
}

interface SliderCalibration {
  startMinutes: number; // slider value=0 corresponds to this minute-of-day
  endMinutes: number; // slider value=sliderMax corresponds to this minute-of-day
  sliderMax: number; // the slider's max attribute — varies per date (e.g., 507)
}

function parseClockToMinutes(text: string | null): number | null {
  if (!text) return null;
  const match = /^(\d+):(\d+)/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function setSliderRaw(page: Page, value: number): Promise<void> {
  const slider = TRACE_SELECTORS.timeSlider(page);
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

async function calibrateSlider(page: Page): Promise<SliderCalibration> {
  // Probe the slider at value=0 and value=max, read the actual reported
  // times via aria-valuetext. CRITICAL: the slider's max attribute
  // varies per date (e.g., 100 for some, 507 for others — it represents
  // the number of available data ticks), so we must read it instead of
  // assuming 0-100.
  const slider = TRACE_SELECTORS.timeSlider(page);
  const maxAttr = await slider.getAttribute('max').catch(() => null);
  const sliderMax = Number.parseInt(maxAttr ?? '100', 10);

  await setSliderRaw(page, 0);
  const startText = await slider.getAttribute('aria-valuetext');
  await setSliderRaw(page, sliderMax);
  const endText = await slider.getAttribute('aria-valuetext');

  const start = parseClockToMinutes(startText) ?? 0;
  let end = parseClockToMinutes(endText) ?? 1440;

  if (start > end) end += 24 * 60;
  return { startMinutes: start, endMinutes: end, sliderMax };
}

function timeToCalibratedValue(
  targetMinutes: number,
  cal: SliderCalibration,
): number {
  // Adjust target to match the calibration's scale. If the calibration
  // crosses midnight (end > 1440) and target is small, target is "today".
  let t = targetMinutes;
  if (cal.endMinutes >= 1440 && t < cal.startMinutes) t += 24 * 60;
  const span = cal.endMinutes - cal.startMinutes;
  if (span <= 0) return cal.sliderMax;
  const frac = (t - cal.startMinutes) / span;
  return Math.round(Math.max(0, Math.min(cal.sliderMax, frac * cal.sliderMax)));
}

async function setSliderToTime(
  page: Page,
  hourCt: number,
  minuteCt: number,
  cal: SliderCalibration,
): Promise<void> {
  // Linear interpolation gets us into the ballpark; the slider's
  // actual value→time mapping isn't perfectly linear (data density
  // varies by region of the day), so we iteratively refine: set,
  // read aria-valuetext, compute drift, adjust value by drift /
  // (minutes-per-pct-point), retry. Stops within 5 min of target.
  const slider = TRACE_SELECTORS.timeSlider(page);
  await slider.waitFor({ state: 'visible', timeout: 5000 });

  const targetMinutes = hourCt * 60 + minuteCt;
  const span = cal.endMinutes - cal.startMinutes;
  const minutesPerPoint = span / cal.sliderMax;

  let value = timeToCalibratedValue(targetMinutes, cal);
  let actualText: string | null = null;

  const adjustToScale = (m: number): number =>
    cal.endMinutes >= 1440 && m < cal.startMinutes ? m + 1440 : m;
  const targetAdjusted = adjustToScale(targetMinutes);

  // Track best (value, drift, text) across attempts. The slider's
  // value-to-time mapping is non-uniform: adjacent values can jump
  // 5-30 min in some regions, so naive iteration can oscillate
  // between two values that bracket the target. Keeping the best-so-far
  // means oscillation costs us iterations but never lands worse.
  let bestValue = value;
  let bestDrift = Number.POSITIVE_INFINITY;
  let bestText: string | null = null;
  const seen = new Set<number>();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (seen.has(value)) break; // already tried this value
    seen.add(value);

    await setSliderRaw(page, value);
    await page.waitForTimeout(300);
    actualText = await slider.getAttribute('aria-valuetext').catch(() => null);
    const actualMinutes = parseClockToMinutes(actualText);
    if (actualMinutes === null) break;

    const drift = adjustToScale(actualMinutes) - targetAdjusted;
    if (Math.abs(drift) < Math.abs(bestDrift)) {
      bestValue = value;
      bestDrift = drift;
      bestText = actualText;
    }
    // 15-min tolerance: the slider's resolution is ~5–10 min in dense
    // regions, larger in sparse ones. Within 15 min is "good enough"
    // for the study — the heatmap doesn't change dramatically.
    if (Math.abs(drift) <= 15) break;

    const adjustment =
      -Math.sign(drift) *
      Math.max(1, Math.ceil(Math.abs(drift) / minutesPerPoint));
    const next = Math.max(0, Math.min(cal.sliderMax, value + adjustment));
    if (next === value) break;
    value = next;
  }

  // If the final value isn't the best, restore the best.
  if (value !== bestValue) {
    await setSliderRaw(page, bestValue);
    await page.waitForTimeout(300);
    actualText = bestText;
    value = bestValue;
  }

  if (actualText) console.log(`    slider → ${actualText} (value=${value})`);
}

// Regex literals compiled once at module load. Using RegExp.prototype.test
// + matchAll style avoids the typescript-eslint preference for .exec over
// String.prototype.match.
const SPOT_PRICE_RE = /(\d{3,5}\.\d{2})/;

function firstGroup(re: RegExp, text: string): string | null {
  const matches = [...text.matchAll(new RegExp(re.source, re.flags + 'g'))];
  return matches[0]?.[1] ?? null;
}

async function readStability(page: Page): Promise<number | null> {
  // <div role="meter" aria-valuenow="21.7385..."> — sub-integer precision,
  // gracefully null on older days where the gauge isn't rendered.
  const gauge = TRACE_SELECTORS.stabilityGauge(page);
  try {
    await gauge.waitFor({ state: 'visible', timeout: 3000 });
    const v = await gauge.getAttribute('aria-valuenow');
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readSpotPrice(page: Page): Promise<number | null> {
  const node = TRACE_SELECTORS.spxHeader(page);
  try {
    const text = await node.textContent();
    if (!text) return null;
    const m = firstGroup(SPOT_PRICE_RE, text);
    return m === null ? null : Number(m);
  } catch {
    return null;
  }
}

async function downloadChart(page: Page, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });

  // Some chart libraries (Plotly, ECharts, react-financial-charts) hide the
  // export/camera button until you hover over the chart pane. Pre-hover any
  // element with role="figure" / "img" / canvas to surface the modebar.
  await page
    .locator('canvas, [role="figure"], [role="img"]')
    .first()
    .hover({ timeout: 1000 })
    .catch(() => {});

  // Try the real camera button → browser download path with a short
  // timeout. Both the wait and the click swallow their own errors so
  // a fast-failing click doesn't leave the wait promise as an
  // unhandled rejection (which would crash the process 5s later).
  // If neither yields a download, fall back to a Playwright
  // screenshot — pixel-different from the canonical camera export but
  // fine for HSV color extraction.
  const downloadPromise = page
    .waitForEvent('download', { timeout: 5_000 })
    .catch(() => null);
  await TRACE_SELECTORS.cameraButton(page)
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  const download = await downloadPromise;
  if (download) {
    await download.saveAs(destPath);
    return;
  }

  // Screenshot fallback. Crop to the chart container if we can find it,
  // else full viewport. Either gets the heatmap; the EDA only needs
  // pixel-color accuracy in the heatmap region.
  const chartLocator = page.locator('canvas, [role="figure"], main').first();
  try {
    await chartLocator.screenshot({ path: destPath });
  } catch {
    await page.screenshot({ path: destPath });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function captureAll(browser: Browser, doc: CsvDoc): Promise<void> {
  const context = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await context.newPage();

  // Empirically, after ~50 date navigations TRACE's chart stops loading
  // full RTH data — slider domain shrinks to "22:30 → 8:43" pre-market
  // only. Refreshing the page resets that state. We do it both at
  // startup, every REFRESH_EVERY days as prevention, and reactively
  // when we detect a too-narrow slider domain.
  const REFRESH_EVERY = 25;
  // 14:30 CT = 870 minutes from midnight. If the slider can't reach
  // here, the chart didn't load full session data.
  const MIN_DOMAIN_END_MINUTES = 870;

  const initSession = async (): Promise<void> => {
    await page.goto(TRACE_URL);
    await page.waitForTimeout(2000);
    await ensureChartType(page, CHART_TYPE);
    await ensureGexToggleOn(page);
    await ensureStrikeZoom(page, 8);
  };
  await initSession();

  const dateIdx = doc.index.get('date')!;
  const selectedIdx = doc.index.get('selected')!;
  // CSV columns to fill per slot. `eod` intentionally has no entries:
  // Stability% is invalid past 3:30 PM ET, and spx_close is already
  // populated by the enricher from day_embeddings/spx_candles_1m.
  const slotCsvCols: Record<
    CaptureSlot['label'],
    { stability?: string; spot?: string }
  > = {
    open: { stability: 'stability_open', spot: 'spot_at_open_capture' },
    mid: { stability: 'stability_mid', spot: 'spot_at_mid_capture' },
    close: { stability: 'stability_close', spot: 'spot_at_close_capture' },
    eod: {},
  };

  let captured = 0;
  let skipped = 0;

  for (const row of doc.rows) {
    if (row[selectedIdx] !== 'Y') continue;
    const date = row[dateIdx]!;

    // Skip if all 4 PNGs for this chart's run already exist on disk.
    const allExist = SLOTS.every((slot) =>
      existsSync(join(SCREENSHOTS_DIR, date, `${slot.label}.png`)),
    );
    if (allExist) {
      console.log(`[exists] ${date}`);
      continue;
    }

    try {
      // Periodic preventive refresh so we don't hit the "stuck chart"
      // state in the middle of a run.
      if (captured > 0 && captured % REFRESH_EVERY === 0) {
        console.log(`  ↻ refresh after ${captured} captures`);
        await initSession();
      }

      console.log(`→ ${date} setDate`);
      await setDate(page, date);
      // setDate can sometimes follow a chart-type reset on TRACE's side;
      // reassert the requested chart type before calibrating the slider.
      await ensureChartType(page, CHART_TYPE);
      let cal = await calibrateSlider(page);

      // Reactive refresh: if the slider domain can't reach our latest
      // target, the chart's data didn't fully load. Refresh and re-set.
      const adjustedEnd =
        cal.endMinutes >= 1440 ? cal.endMinutes - 1440 : cal.endMinutes;
      if (adjustedEnd < MIN_DOMAIN_END_MINUTES) {
        console.log(
          `  ⚠ ${date} domain ends at ${Math.floor(adjustedEnd / 60)}:${String(adjustedEnd % 60).padStart(2, '0')}; refreshing`,
        );
        await initSession();
        await setDate(page, date);
        await ensureChartType(page, CHART_TYPE);
        cal = await calibrateSlider(page);
        const retryEnd =
          cal.endMinutes >= 1440 ? cal.endMinutes - 1440 : cal.endMinutes;
        if (retryEnd < MIN_DOMAIN_END_MINUTES) {
          throw new Error(
            `slider domain still too narrow after refresh (ends ${Math.floor(retryEnd / 60)}:${String(retryEnd % 60).padStart(2, '0')})`,
          );
        }
      }

      console.log(
        `  · ${date} slider domain ${Math.floor(cal.startMinutes / 60)}:${String(cal.startMinutes % 60).padStart(2, '0')} → ${Math.floor((cal.endMinutes % 1440) / 60)}:${String(cal.endMinutes % 60).padStart(2, '0')}`,
      );

      for (const slot of SLOTS) {
        const dest = join(SCREENSHOTS_DIR, date, `${slot.label}.png`);
        if (existsSync(dest)) continue;

        console.log(`  · ${date} ${slot.label} setSlider`);
        await setSliderToTime(page, slot.hourCt, slot.minuteCt, cal);
        // Header readouts (Stability%, SPX spot) are chart-independent
        // values, but we read them inside each chart's run so each
        // per-chart CSV gets its own slider-aligned snapshot. Slider
        // drift can vary slightly between runs; keeping each CSV's
        // values aligned with that CSV's PNGs avoids subtle skew.
        console.log(`  · ${date} ${slot.label} readDOM`);
        const stability = await readStability(page);
        const spot = await readSpotPrice(page);
        const cols = slotCsvCols[slot.label];
        if (cols.stability && stability !== null) {
          row[doc.index.get(cols.stability)!] = stability.toFixed(2);
        }
        if (cols.spot && spot !== null) {
          row[doc.index.get(cols.spot)!] = spot.toFixed(2);
        }

        console.log(`  · ${date} ${slot.label} download`);
        await downloadChart(page, dest);
      }
      captured += 1;
      console.log(`[${captured}] ✓ ${date}`);
    } catch (err) {
      skipped += 1;
      console.error(`[skip] ${date} → ${(err as Error).message}`);
    }

    // Politeness gap; SpotGamma rate-limits aren't published.
    await page.waitForTimeout(1500);
    // Periodic flush so a crash doesn't lose hours of work.
    if (captured % 5 === 0) writeCsv(doc);
  }

  writeCsv(doc);
  console.log(`Done. captured=${captured} skipped=${skipped}`);
  await context.close();
}

async function main(): Promise<void> {
  if (!existsSync(STORAGE_PATH)) {
    throw new Error(
      `Missing ${STORAGE_PATH}. Run scripts/charm-pressure-capture/save-storage.ts first to log into TRACE.`,
    );
  }
  if (!existsSync(CSV_PATH)) {
    throw new Error(
      `Missing ${CSV_PATH}. Seed it from charm's CSV: cp scripts/charm-pressure-capture/candidate-days.csv ${CSV_PATH}`,
    );
  }
  console.log(`▶ chart=${CHART_KEY} (${CHART_TYPE})`);
  console.log(`  csv:  ${CSV_PATH}`);
  console.log(`  pngs: ${SCREENSHOTS_DIR}`);
  const doc = readCsv();
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== '0',
  });
  try {
    await captureAll(browser, doc);
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
