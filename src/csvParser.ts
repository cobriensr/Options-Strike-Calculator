import type { VIXDataMap } from './types';

/**
 * Parses a VIX OHLC CSV string into a date-keyed map.
 * Handles both YYYY-MM-DD and MM/DD/YYYY date formats.
 * Expects columns: Date, Open, High, Low, Close (case-insensitive).
 */
export function parseVixCSV(csvText: string): VIXDataMap {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return {};

  const headerLine = lines[0];
  if (!headerLine) return {};

  const cols = headerLine.toLowerCase().split(',').map((c) => c.trim());
  const dateIdx = cols.findIndex((c) => c.includes('date'));
  const openIdx = cols.findIndex((c) => c === 'open');
  const highIdx = cols.findIndex((c) => c === 'high');
  const lowIdx = cols.findIndex((c) => c === 'low');
  const closeIdx = cols.findIndex((c) => c === 'close' || c === 'adj close');

  if (dateIdx === -1) return {};

  const data: Record<string, { open: number | null; high: number | null; low: number | null; close: number | null }> = {};

  for (let i = 1; i < lines.length; i++) {
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
      return Number.isNaN(num) ? null : num;
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
