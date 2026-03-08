#!/usr/bin/env node

/**
 * Converts a VIX OHLC CSV file to the JSON format used by the app.
 *
 * Usage:
 *   node scripts/convert-vix-csv.mjs path/to/vix.csv
 *
 * Output is written to public/vix-data.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/convert-vix-csv.mjs <path-to-csv>');
  process.exit(1);
}

const csvText = readFileSync(resolve(csvPath), 'utf-8');
const lines = csvText.trim().split('\n');

if (lines.length < 2) {
  console.error('CSV has no data rows');
  process.exit(1);
}

const cols = lines[0].toLowerCase().split(',').map((c) => c.trim());
const dateIdx = cols.findIndex((c) => c.includes('date'));
const openIdx = cols.findIndex((c) => c === 'open');
const highIdx = cols.findIndex((c) => c === 'high');
const lowIdx = cols.findIndex((c) => c === 'low');
const closeIdx = cols.findIndex((c) => c === 'close' || c === 'adj close');

if (dateIdx === -1) {
  console.error('No "Date" column found in CSV');
  process.exit(1);
}

const data = {};
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',').map((p) => p.trim());
  if (parts.length <= dateIdx || !parts[dateIdx]) { skipped++; continue; }

  let dateKey = parts[dateIdx];

  // Convert MM/DD/YYYY to YYYY-MM-DD
  if (dateKey.includes('/')) {
    const [m, d, y] = dateKey.split('/');
    const year = y.length === 2 ? '20' + y : y;
    dateKey = year + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
  }

  const parseCol = (idx) => {
    if (idx < 0 || idx >= parts.length) return null;
    const val = parseFloat(parts[idx]);
    return isNaN(val) ? null : val;
  };

  data[dateKey] = {
    open: parseCol(openIdx),
    high: parseCol(highIdx),
    low: parseCol(lowIdx),
    close: parseCol(closeIdx),
  };
}

const outputPath = resolve(__dirname, '..', 'public', 'vix-data.json');
writeFileSync(outputPath, JSON.stringify(data));

const count = Object.keys(data).length;
const dates = Object.keys(data).sort();
const fileSize = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(0);

console.log(`Converted ${count} days of VIX data`);
console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
console.log(`Skipped ${skipped} invalid rows`);
console.log(`Output: ${outputPath} (${fileSize} KB)`);
