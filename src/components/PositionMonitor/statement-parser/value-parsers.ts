import type { TrdDescription } from '../types';

// ── Constants ──────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

// ── CSV / Value Parsing ────────────────────────────────────

/** Parse a CSV line handling quoted fields with commas */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse all currency formats:
 *  "1,800.00" → 1800
 *  ($150.00)  → -150
 *  -26.00     → -26
 *  "$310,000.00" → 310000
 *  ""         → 0
 */
export function parseCurrency(value: string): number {
  if (!value?.trim()) return 0;
  let cleaned = value.replaceAll(/[$,\s"]/g, '');

  // Parenthesized negative: ($150.00) or (150.00)
  const parenMatch = /^\((.+)\)$/.exec(cleaned);
  if (parenMatch) {
    cleaned = parenMatch[1]!;
    const parsed = Number.parseFloat(cleaned);
    return Number.isNaN(parsed) ? 0 : -parsed;
  }

  // Ref number format: ="5320628961" — not a currency
  if (cleaned.startsWith('=')) return 0;

  const parsed = Number.parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Parse percentage: "-0.74%" → -0.0074
 */
export function parsePercentage(value: string): number {
  if (!value?.trim()) return 0;
  let cleaned = value.replaceAll(/[%\s"]/g, '');

  // Parenthesized negative: (0.74%)
  const parenMatch = /^\((.+)\)$/.exec(cleaned);
  if (parenMatch) {
    cleaned = parenMatch[1]!;
    const parsed = Number.parseFloat(cleaned);
    return Number.isNaN(parsed) ? 0 : -parsed / 100;
  }

  const parsed = Number.parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed / 100;
}

/**
 * Parse thinkorswim date: "27 MAR 26" → "2026-03-27"
 */
export function parseTosDate(dateStr: string): string {
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length !== 3) return dateStr;

  const [day, month, year] = parts;
  const mm = MONTH_MAP[month!.toUpperCase()];
  if (!mm) return dateStr;

  const yyyy = year!.length === 2 ? `20${year}` : year!;
  return `${yyyy}-${mm}-${day!.padStart(2, '0')}`;
}

/**
 * Parse short date: "3/27/26" → "2026-03-27"
 */
export function parseShortDate(dateStr: string): string {
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return dateStr;

  const [month, day, year] = parts;
  const yyyy = year!.length === 2 ? `20${year}` : year!;
  const mm = month!.padStart(2, '0');
  const dd = day!.padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse the rich TRD description string.
 *
 * Example:
 *  "SOLD -20 VERTICAL SPX 100 (Weeklys) 27 MAR 26 6495/6515 CALL @.90"
 *  "tAndroid BOT +10 SINGLE SPX 100 (Weeklys) 27 MAR 26 6335 PUT @.65"
 */
export function parseTrdDescription(desc: string): TrdDescription | null {
  // Strip platform prefixes like "tAndroid"
  let cleaned = desc.trim();
  const prefixMatch = /^(?:tAndroid|tDesktop|tWeb)\s+/i.exec(cleaned);
  if (prefixMatch) {
    cleaned = cleaned.slice(prefixMatch[0].length);
  }

  // Parse the description by splitting on spaces, then
  // reassembling the known fields. This avoids a single
  // complex regex that exceeds sonarjs/regex-complexity.
  const tokens = cleaned.split(/\s+/);
  if (tokens.length < 10) return null;

  const direction = tokens[0]!.toUpperCase();
  if (direction !== 'SOLD' && direction !== 'BOT') return null;

  const qtyToken = tokens[1]!;
  const spreadType = tokens[2]!;
  const symbol = tokens[3]!;
  const multiplierStr = tokens[4]!;

  // Find parenthesized expiry label
  const joinedRest = tokens.slice(5).join(' ');
  const parenStart = joinedRest.indexOf('(');
  const parenEnd = joinedRest.indexOf(')');
  if (parenStart < 0 || parenEnd < 0) return null;

  const expiryLabel = joinedRest.slice(parenStart + 1, parenEnd);
  const afterParen = joinedRest
    .slice(parenEnd + 1)
    .trim()
    .split(/\s+/);
  // afterParen: [day, month, year, strikes, CALL|PUT, @price]
  if (afterParen.length < 6) return null;

  const expDate = `${afterParen[0]} ${afterParen[1]} ${afterParen[2]}`;
  const strikes = afterParen[3]!;
  const optionType = afterParen[4]!.toUpperCase();
  if (optionType !== 'CALL' && optionType !== 'PUT') return null;

  const priceStr = afterParen[5]!.startsWith('@')
    ? afterParen[5]!.slice(1)
    : afterParen[5]!;

  return {
    direction,
    quantity: Math.abs(Number.parseInt(qtyToken, 10)),
    spreadType,
    symbol,
    multiplier: Number.parseInt(multiplierStr, 10),
    expiryLabel,
    expiration: parseTosDate(expDate),
    strikes,
    optionType,
    fillPrice: Number.parseFloat(priceStr),
  };
}
