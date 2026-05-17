/**
 * Frontend OCC + Unusual Whales URL parser.
 *
 * Server-side `parseOccSymbol` / `parseFreeText` live in api/_lib/occ.ts;
 * this file is a focused frontend equivalent so the AddContractForm
 * paste-to-prefill flow doesn't need a network round-trip just to know
 * what the user dropped in.
 *
 * Supports two input shapes, returning `null` on anything else so the
 * caller can treat parse-fail as "leave the form alone":
 *
 *   1. Bare OCC body — padded (`NVDA  260522P00225000`, 21 chars) or
 *      unpadded (`TSLA261016C00800000`, 16-21 chars). Case-insensitive.
 *   2. Unusual Whales option-chain URL:
 *      `[https://[www.]]unusualwhales.com/option-chain/<OCC>`
 *
 * OCC body layout (last 15 chars are fixed):
 *   <root 1-6 chars><YYMMDD 6 digits><C|P><strike 8 digits>
 *
 * Last 3 strike digits are thousandths of a dollar (so 800000 → $800.00,
 * 397500 → $397.50). CBOE pivot: years 00-49 → 2000-2049, 50-99 → 1950-99.
 */

export interface ParsedOccChain {
  ticker: string;
  /** ISO date, YYYY-MM-DD */
  expiry: string;
  side: 'C' | 'P';
  strike: number;
}

const UW_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?unusualwhales\.com\/option-chain\/([A-Z][A-Z0-9.-]{0,5}\d{6}[CP]\d{8})$/i;
const BARE_OCC_RE = /^([A-Z][A-Z0-9.-]{0,5}\s{0,5}\d{6}[CP]\d{8})$/i;

/**
 * Try to parse a UW chain URL or bare OCC body into structured fields.
 * Returns `null` on any input that isn't recognizable (whitespace,
 * non-OCC text, malformed body) — the caller decides whether to
 * surface a hint.
 */
export function tryParseOccChain(input: string): ParsedOccChain | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let occBody: string | null = null;
  const urlMatch = UW_URL_RE.exec(trimmed);
  if (urlMatch) {
    occBody = urlMatch[1]!.toUpperCase();
  } else {
    const bareMatch = BARE_OCC_RE.exec(trimmed);
    if (bareMatch) occBody = bareMatch[1]!.toUpperCase();
  }
  if (occBody == null) return null;

  // Normalize to canonical 21-char form (root right-padded with spaces).
  // The 15-char fixed tail makes the root slice unambiguous.
  const cleaned = occBody.replace(/\s+/g, '');
  if (cleaned.length < 16 || cleaned.length > 21) return null;
  const rootLen = cleaned.length - 15;
  const root = cleaned.slice(0, rootLen);
  const tail = cleaned.slice(rootLen);

  const yy = tail.slice(0, 2);
  const mm = tail.slice(2, 4);
  const dd = tail.slice(4, 6);
  const side = tail.slice(6, 7);
  const strikeStr = tail.slice(7, 15);

  if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) {
    return null;
  }
  if (side !== 'C' && side !== 'P') return null;
  if (!/^\d{8}$/.test(strikeStr)) return null;

  const mmNum = Number.parseInt(mm, 10);
  const ddNum = Number.parseInt(dd, 10);
  if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) return null;

  const yyNum = Number.parseInt(yy, 10);
  const fullYear = yyNum < 50 ? 2000 + yyNum : 1900 + yyNum;
  const expiry = `${String(fullYear)}-${mm}-${dd}`;
  const strike = Number.parseInt(strikeStr, 10) / 1000;

  return { ticker: root, expiry, side, strike };
}
