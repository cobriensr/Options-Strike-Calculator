#!/usr/bin/env node
/**
 * Generate candidate-days.csv for the Charm Pressure Pin Study.
 *
 * See docs/superpowers/specs/charm-pressure-pin-study-2026-04-25.md
 *
 * Pre-fills calendar-deterministic columns (date, dow, OpEx, holidays)
 * and best-effort event flags (FOMC/CPI/NFP) from training knowledge.
 * Everything else is left blank for the user to populate.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const WINDOW_START = '2024-06-03'; // first trading day of June 2024
const WINDOW_END = '2026-04-24'; // last fully-closed session before today

// ---------------------------------------------------------------------------
// NYSE full-day closes (regular holidays).
// Source: NYSE published calendar.
// ---------------------------------------------------------------------------

const HOLIDAYS = new Set([
  // 2024
  '2024-01-01',
  '2024-01-15',
  '2024-02-19',
  '2024-03-29',
  '2024-05-27',
  '2024-06-19',
  '2024-07-04',
  '2024-09-02',
  '2024-11-28',
  '2024-12-25',
  // 2025
  '2025-01-01',
  '2025-01-09', // Jan 9 = National Day of Mourning (Carter); confirm before relying
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
]);

// Half-day sessions (1pm ET close). Charm Pressure dynamics differ;
// excluded by default per spec open-questions.
const HALF_DAYS = new Set([
  // 2024
  '2024-07-03',
  '2024-11-29',
  '2024-12-24',
  // 2025
  '2025-07-03',
  '2025-11-28',
  '2025-12-24',
]);

// ---------------------------------------------------------------------------
// FOMC decision days. Verify at federalreserve.gov.
// Source: training-knowledge through Jan 2026 cutoff.
// ---------------------------------------------------------------------------

const FOMC_DAYS = new Set([
  // 2024
  '2024-06-12',
  '2024-07-31',
  '2024-09-18',
  '2024-11-07',
  '2024-12-18',
  // 2025
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
  // 2026
  '2026-01-28',
  '2026-03-18',
]);

// ---------------------------------------------------------------------------
// CPI release days. Verify at bls.gov/schedule/news_release/.
// Approximate; BLS publishes ~2nd full week of each month.
// ---------------------------------------------------------------------------

const CPI_DAYS = new Set([
  // 2024
  '2024-06-12',
  '2024-07-11',
  '2024-08-14',
  '2024-09-11',
  '2024-10-10',
  '2024-11-13',
  '2024-12-11',
  // 2025
  '2025-01-15',
  '2025-02-12',
  '2025-03-12',
  '2025-04-10',
  '2025-05-13',
  '2025-06-11',
  '2025-07-15',
  '2025-08-12',
  '2025-09-11',
  '2025-10-24',
  '2025-11-13',
  '2025-12-10',
  // 2026
  '2026-01-14',
  '2026-02-11',
  '2026-03-11',
  '2026-04-14',
]);

// ---------------------------------------------------------------------------
// NFP / Employment Situation release days. Typically 1st Friday of the month.
// Verify at bls.gov.
// ---------------------------------------------------------------------------

const NFP_DAYS = new Set([
  // 2024 (window starts Jun)
  '2024-07-05',
  '2024-08-02',
  '2024-09-06',
  '2024-10-04',
  '2024-11-01',
  '2024-12-06',
  // 2025
  '2025-01-10',
  '2025-02-07',
  '2025-03-07',
  '2025-04-04',
  '2025-05-02',
  '2025-06-06',
  '2025-07-03',
  '2025-08-01',
  '2025-09-05',
  '2025-10-03',
  '2025-11-07',
  '2025-12-05',
  // 2026
  '2026-01-09',
  '2026-02-06',
  '2026-03-06',
  '2026-04-02',
]);

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function* iterateDays(startISO, endISO) {
  const start = new Date(`${startISO}T00:00:00Z`);
  const end = new Date(`${endISO}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield new Date(d);
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function isWeekend(d) {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Returns true if `d` is the Nth occurrence of its weekday within its month.
 * Used for OpEx (3rd Friday) detection.
 */
function isNthDowOfMonth(d, n) {
  const day = d.getUTCDate();
  const ordinal = Math.ceil(day / 7);
  return ordinal === n;
}

function isMonthlyOpex(d) {
  return d.getUTCDay() === 5 && isNthDowOfMonth(d, 3);
}

function isQuarterlyOpex(d) {
  if (!isMonthlyOpex(d)) return false;
  const month = d.getUTCMonth(); // 0-indexed
  return month === 2 || month === 5 || month === 8 || month === 11;
}

// ---------------------------------------------------------------------------
// Build rows
// ---------------------------------------------------------------------------

const COLUMNS = [
  // Identity
  'date',
  'day_of_week',
  // Pre-filled event flags
  'is_fomc',
  'is_cpi',
  'is_nfp',
  'is_monthly_opex',
  'is_quarterly_opex',
  'is_half_day',
  'is_event',
  // User-filled price/regime
  'spx_open',
  'spx_high',
  'spx_low',
  'spx_close',
  'spx_prev_close',
  'realized_range_dollars',
  'realized_range_pct',
  'regime',
  // User-filled selection
  'selected',
  'selection_bucket',
  // User-filled charm pressure data
  'stability_open',
  'stability_mid',
  'stability_close',
  'spot_at_open_capture',
  'spot_at_mid_capture',
  'spot_at_close_capture',
  'pin_band_centroid_open',
  'pin_band_centroid_mid',
  'pin_band_centroid_close',
  'pin_band_width_close',
  'nearest_pos_gamma_strike_close',
  'nearest_pos_gamma_magnitude_close',
  // User-filled outcome
  'pin_realized',
  'pin_realized_strike',
  'pin_distance_close',
  'notes',
];

const rows = [];
let totalDays = 0;
let tradingDays = 0;
let fomcCount = 0;
let cpiCount = 0;
let nfpCount = 0;
let opexCount = 0;
let qopexCount = 0;
let halfDayCount = 0;
let eventCount = 0;

for (const d of iterateDays(WINDOW_START, WINDOW_END)) {
  totalDays += 1;
  if (isWeekend(d)) continue;

  const iso = isoDate(d);
  if (HOLIDAYS.has(iso)) continue;

  tradingDays += 1;

  const isFomc = FOMC_DAYS.has(iso);
  const isCpi = CPI_DAYS.has(iso);
  const isNfp = NFP_DAYS.has(iso);
  const isOpex = isMonthlyOpex(d);
  const isQopex = isQuarterlyOpex(d);
  const isHalf = HALF_DAYS.has(iso);
  const isEvent = isFomc || isCpi || isNfp || isQopex;

  if (isFomc) fomcCount += 1;
  if (isCpi) cpiCount += 1;
  if (isNfp) nfpCount += 1;
  if (isOpex) opexCount += 1;
  if (isQopex) qopexCount += 1;
  if (isHalf) halfDayCount += 1;
  if (isEvent) eventCount += 1;

  const row = {
    date: iso,
    day_of_week: DOW_NAMES[d.getUTCDay()],
    is_fomc: isFomc ? 1 : 0,
    is_cpi: isCpi ? 1 : 0,
    is_nfp: isNfp ? 1 : 0,
    is_monthly_opex: isOpex ? 1 : 0,
    is_quarterly_opex: isQopex ? 1 : 0,
    is_half_day: isHalf ? 1 : 0,
    is_event: isEvent ? 1 : 0,
  };

  rows.push(row);
}

// ---------------------------------------------------------------------------
// Emit CSV
// ---------------------------------------------------------------------------

const lines = [COLUMNS.join(',')];
for (const row of rows) {
  const values = COLUMNS.map((col) => {
    const v = row[col];
    return v === undefined || v === null ? '' : String(v);
  });
  lines.push(values.join(','));
}

const outPath = join(__dirname, 'candidate-days.csv');
writeFileSync(outPath, `${lines.join('\n')}\n`);

console.log(`Wrote ${rows.length} candidate days to ${outPath}`);
console.log('');
console.log(`  Window:           ${WINDOW_START} → ${WINDOW_END}`);
console.log(`  Calendar days:    ${totalDays}`);
console.log(`  Trading days:     ${tradingDays}`);
console.log(`  FOMC days:        ${fomcCount}`);
console.log(`  CPI days:         ${cpiCount}`);
console.log(`  NFP days:         ${nfpCount}`);
console.log(`  Monthly OpEx:     ${opexCount}`);
console.log(`  Quarterly OpEx:   ${qopexCount}`);
console.log(`  Half-days:        ${halfDayCount}`);
console.log(`  Any-event days:   ${eventCount}`);
