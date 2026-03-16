import type { VIXDataMap } from '../types';

/** Maximum rows to parse (35+ years of daily data) */
const MAX_ROWS = 15_000;

/** VIX values outside this range are treated as invalid */
const MIN_VIX = 0;
const MAX_VIX = 200;

/**
 * Parses a VIX OHLC CSV string into a date-keyed map.
 * Handles both YYYY-MM-DD and MM/DD/YYYY date formats.
 * Expects columns: Date, Open, High, Low, Close (case-insensitive).
 *
 * Guards:
 *   - Caps at MAX_ROWS (15,000) to prevent memory issues
 *   - Rejects values outside [0, 200] (historical VIX max ~82)
 *   - Rejects Infinity values from malformed numeric strings
 */
export function parseVixCSV(csvText: string): VIXDataMap {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return {};

  const headerLine = lines[0];
  if (!headerLine) return {};

  const cols = headerLine
    .toLowerCase()
    .split(',')
    .map((c) => c.trim());
  const dateIdx = cols.findIndex((c) => c.includes('date'));
  const openIdx = cols.indexOf('open');
  const highIdx = cols.indexOf('high');
  const lowIdx = cols.indexOf('low');
  const closeIdx = cols.includes('close')
    ? cols.indexOf('close')
    : cols.indexOf('adj close');

  if (dateIdx === -1) return {};

  const data: Record<
    string,
    {
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
    }
  > = {};

  const rowLimit = Math.min(lines.length, MAX_ROWS + 1); // +1 for header
  for (let i = 1; i < rowLimit; i++) {
    const line = lines[i];
    if (!line) continue;

    const parts = line.split(',').map((p) => p.trim());
    const rawDate = parts[dateIdx];
    if (!rawDate) continue;

    let dateKey = rawDate;

    // Convert MM/DD/YYYY to YYYY-MM-DD
    if (rawDate.includes('/')) {
      const dateParts = rawDate.split('/');
      const m = dateParts[0];
      const d = dateParts[1];
      const y = dateParts[2];
      if (m && d && y) {
        const year = y.length === 2 ? '20' + y : y;
        dateKey = year + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
      }
    }

    const parseCol = (idx: number): number | null => {
      if (idx < 0) return null;
      const val = parts[idx];
      if (val === undefined || val === '') return null;
      const num = Number.parseFloat(val);
      if (!Number.isFinite(num)) return null;
      if (num < MIN_VIX || num > MAX_VIX) return null;
      return num;
    };

    data[dateKey] = {
      open: parseCol(openIdx),
      high: parseCol(highIdx),
      low: parseCol(lowIdx),
      close: parseCol(closeIdx),
    };
  }

  return data;
}
