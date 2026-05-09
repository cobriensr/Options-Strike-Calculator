/**
 * Pure HTML → SnapshotRow[] parser for the UW Periscope Market Maker
 * Exposures Table page.
 *
 * Kept pure (no Playwright dependency) so unit tests can feed in fixture
 * HTML without booting a browser. The runtime path in scrape.ts calls
 * `await page.content()` and hands the string here.
 *
 * DOM contract (verified against a real capture, 2026-05-07 14:50–15:00):
 *
 *   <div class="card_cardTitleText__kcI4N">
 *     <span>Net Charm Heat Map - SPX</span>
 *     <span ...>Underlying: ($7337.07)</span>
 *     ...
 *   </div>
 *
 *   <div data-sentry-component="DropdownFilter">
 *     <span class="text-xs">Expiry</span>
 *     <span class="text-base">2026-05-07</span>
 *   </div>
 *   <div data-sentry-component="DropdownFilter">
 *     <span class="text-xs">Greek</span>
 *     <span class="text-base">Charm</span>
 *   </div>
 *
 *   <table class="table_table__L4o9O">
 *     <tbody>
 *       <tr class="table_row__wxw5u">
 *         <td></td>
 *         <td class="table_stickyCol__r8NtE table_left__otU2P">
 *           <div><span>7,400</span></div>
 *         </td>
 *         <td class="text-right">
 *           <div title="Charm: 23.88">23.88</div>
 *         </td>
 *         <td></td>
 *       </tr>
 *     </tbody>
 *   </table>
 *
 * The TITLE attribute on the value cell is the source of truth — the
 * inner text is sometimes abbreviated (e.g. "235K"), but the title
 * always carries the canonical string. We parse from title.
 *
 * Value formats observed in titles:
 *   "0", "-0.01", "0.25", "23.88"            — plain
 *   "15,404.71", "-46,325.35"                 — comma-separated thousands
 *   "235K", "-2.36M", "444M", "-819M"         — K/M/B suffix
 */

import { parse, type HTMLElement } from 'node-html-parser';
import type { Panel, SnapshotRow } from './types.js';

export interface PageHeader {
  /** SPX spot at capture time, parsed from "Underlying: ($X)". */
  spot: number;
  /** Selected expiry as YYYY-MM-DD. */
  expiry: string;
  /** Currently-selected Greek (lowercased). */
  panel: Panel;
  /** Timeframe label as shown in the UI, e.g. "14:50 - 15:00". */
  timeframe: string;
}

const VALUE_PATTERN = /^(-?\d+(?:\.\d+)?)([KMB]?)$/;
const UNDERLYING_PATTERN = /Underlying:\s*\(\$([\d.]+)\)/;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LABEL_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\w+)\s+(\d{1,2})$/;
const MONTH_3LETTER: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Convert a Periscope date-picker label like "Thu, May 7" into a
 * YYYY-MM-DD string for the given year. Returns null if the label
 * doesn't match the expected shape (week-day, month-name, day-of-month).
 *
 * The label has no year on it — we trust the caller to supply the
 * correct year (typically `new Date().getFullYear()` for live runs,
 * or a fixed value in fixture-based tests).
 */
export function parseDateLabel(label: string, year: number): string | null {
  const m = DATE_LABEL_PATTERN.exec(label.trim());
  if (!m) return null;
  const monthName = m[1];
  const dayStr = m[2];
  if (monthName === undefined || dayStr === undefined) return null;
  const monthNum = MONTH_3LETTER[monthName.toLowerCase().slice(0, 3)];
  if (monthNum === undefined) return null;
  const day = dayStr.padStart(2, '0');
  const month = String(monthNum).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse the value-cell title string into a number.
 *
 * Returns null if the string is not parseable. Callers that want a
 * default of 0 should `?? 0` at the call site — we don't fold that in
 * here because "no value present" is a real signal worth preserving
 * from "value is genuinely zero".
 */
export function parseValueString(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;

  // Strip thousands commas first. The K/M/B suffix never coexists with
  // commas in real captures, so this is safe.
  const cleaned = trimmed.replaceAll(',', '');

  const match = VALUE_PATTERN.exec(cleaned);
  if (!match) return null;

  const numStr = match[1];
  const suffix = match[2];
  if (numStr === undefined) return null;

  const base = Number.parseFloat(numStr);
  if (!Number.isFinite(base)) return null;

  switch (suffix) {
    case 'K':
      return base * 1_000;
    case 'M':
      return base * 1_000_000;
    case 'B':
      return base * 1_000_000_000;
    default:
      return base;
  }
}

/**
 * Extract the value out of a `title="<Greek>: <value>"` attribute.
 *
 * Returns null if the attribute shape doesn't match (missing colon,
 * empty value, etc.) — useful for skipping malformed cells without
 * crashing the whole pass.
 */
export function parseTitleValue(title: string): number | null {
  const colon = title.indexOf(':');
  if (colon === -1) return null;
  return parseValueString(title.slice(colon + 1));
}

/**
 * Find the dropdown row whose label `<span class="text-xs">` matches
 * the given label (case-insensitive). Returns the value `<span>`'s
 * text content trimmed, or null if not found.
 *
 * Used for both Expiry and Greek dropdowns since they share markup.
 */
function readDropdownValue(root: HTMLElement, label: string): string | null {
  const labelLc = label.toLowerCase();
  const dropdowns = root.querySelectorAll(
    'div[data-sentry-component="DropdownFilter"]',
  );
  for (const dd of dropdowns) {
    const spans = dd.querySelectorAll('span');
    let matched = false;
    let valueText: string | null = null;
    for (const span of spans) {
      const cls = span.getAttribute('class') ?? '';
      const text = span.textContent.trim();
      if (cls.includes('text-xs') && text.toLowerCase() === labelLc) {
        matched = true;
      } else if (matched && cls.includes('text-base')) {
        valueText = text;
        break;
      }
    }
    if (matched && valueText !== null) return valueText;
  }
  return null;
}

/**
 * Parse the page header (spot / expiry / panel / timeframe). Throws on
 * required-field absence — the scraper should treat header-parse
 * failure as a fatal "page not rendered yet" condition and retry the
 * tick rather than write garbage rows.
 *
 * `year` provides the calendar year for the date-picker label (which
 * has no year on it). Defaults to the current UTC year when omitted.
 */
export function parseHeader(html: string, year?: number): PageHeader {
  const root = parse(html);

  // Spot: "Underlying: ($7337.07)" lives inside a span with that text.
  // Walk all spans and regex-match the first that contains "Underlying:".
  // We don't anchor on a specific class because UW renames Tailwind hashes.
  let spot: number | null = null;
  for (const span of root.querySelectorAll('span')) {
    const m = UNDERLYING_PATTERN.exec(span.textContent);
    if (m?.[1]) {
      const v = Number.parseFloat(m[1]);
      if (Number.isFinite(v) && v > 0) {
        spot = v;
        break;
      }
    }
  }
  if (spot === null) {
    throw new Error('parseHeader: could not find Underlying spot price');
  }

  // Expiry: prefer the date-picker label (always YYYY-MM-DD-derivable
  // when DTE=0 narrows by date) over the Expiry dropdown (which reads
  // "All" when in Multi mode and is irrelevant under DTE=0). Fall back
  // to the Expiry dropdown for fixture/test contexts that don't render
  // a date picker.
  let expiry: string | null = null;
  const dateBtn = root.querySelector(
    '[data-testid="date-picker-button"] span[role="button"]',
  );
  const dateLabel = dateBtn?.textContent.trim() ?? '';
  if (dateLabel !== '') {
    expiry = parseDateLabel(dateLabel, year ?? new Date().getUTCFullYear());
  }
  if (expiry === null) {
    const dropdownExpiry = readDropdownValue(root, 'Expiry');
    if (dropdownExpiry !== null && EXPIRY_PATTERN.test(dropdownExpiry)) {
      expiry = dropdownExpiry;
    }
  }
  if (expiry === null) {
    throw new Error(
      `parseHeader: could not derive expiry from date picker ("${dateLabel}") or Expiry dropdown`,
    );
  }

  const greekRaw = readDropdownValue(root, 'Greek');
  if (greekRaw === null) {
    throw new Error('parseHeader: Greek dropdown value not found');
  }
  const greekLc = greekRaw.toLowerCase();
  if (greekLc !== 'gamma' && greekLc !== 'charm' && greekLc !== 'vanna') {
    throw new Error(
      `parseHeader: unexpected Greek value "${greekRaw}" — expected one of Gamma/Charm/Vanna`,
    );
  }
  const panel: Panel = greekLc;

  // Timeframe lives next to a "Timeframe:" label span; pull the sibling.
  let timeframe = '';
  for (const span of root.querySelectorAll('span')) {
    if (span.textContent.trim() === 'Timeframe:') {
      const next = span.nextElementSibling;
      if (next?.tagName === 'SPAN') {
        timeframe = next.textContent.trim().replaceAll(/\s+/g, ' ');
        break;
      }
    }
  }

  return { spot, expiry, panel, timeframe };
}

/**
 * Parse the per-strike rows out of the data table. The panel is
 * supplied by the caller (read from the header) rather than inferred
 * from the title prefix — letting one source of truth (the dropdown
 * value) cover all rows is simpler than trusting per-cell title
 * prefixes.
 */
export function parseTableRows(
  html: string,
  panel: Panel,
  capturedAt: string,
  expiry: string,
  timeframe: string,
): SnapshotRow[] {
  const root = parse(html);
  const rows: SnapshotRow[] = [];

  for (const tr of root.querySelectorAll('tr.table_row__wxw5u')) {
    // Strike: first <span> inside the sticky-left <td>.
    const strikeTd = tr.querySelector(
      'td.table_stickyCol__r8NtE.table_left__otU2P',
    );
    const strikeSpan = strikeTd?.querySelector('span');
    const strikeText = strikeSpan?.textContent.trim().replaceAll(',', '') ?? '';
    const strike = Number.parseInt(strikeText, 10);
    if (!Number.isFinite(strike)) continue;

    // Value: the <div> with a title="<Greek>: <value>" attribute lives
    // inside a <td class="text-right">. Multiple text-right cells exist
    // (the spacer cells too) — find the one whose div has a title.
    let value: number | null = null;
    const valueDivs = tr.querySelectorAll('td div[title]');
    for (const div of valueDivs) {
      const title = div.getAttribute('title');
      if (title == null) continue;
      const v = parseTitleValue(title);
      if (v !== null) {
        value = v;
        break;
      }
    }
    if (value === null) continue;

    rows.push({
      capturedAt,
      expiry,
      panel,
      strike,
      value,
      timeframe,
    });
  }

  return rows;
}

/**
 * One-shot parse: extracts the header AND rows, stamps `capturedAt`,
 * and returns both for the caller to log + persist.
 *
 * Throws on header-parse failure (page not yet rendered or DOM drift).
 */
export function parsePage(
  html: string,
  capturedAt: string,
  year?: number,
): { header: PageHeader; rows: SnapshotRow[] } {
  // Default the year to the year of capturedAt (not the live calendar
  // year). Critical for historical backfills: the date picker shows
  // "Fri, Nov 14" with no year, and parseDateLabel needs to know
  // whether that's 2025 or 2026. Using capturedAt's year ties parsing
  // to the slot's actual ISO timestamp instead of `Date.now()`.
  const fromCapturedAt = Number.parseInt(capturedAt.slice(0, 4), 10);
  const resolvedYear =
    year ?? (Number.isFinite(fromCapturedAt) ? fromCapturedAt : undefined);
  const header = parseHeader(html, resolvedYear);
  const rows = parseTableRows(
    html,
    header.panel,
    capturedAt,
    header.expiry,
    header.timeframe,
  );
  return { header, rows };
}
