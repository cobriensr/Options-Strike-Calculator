/**
 * Frontend OCC + Unusual Whales URL parser.
 *
 * Server-side `parseOccSymbol` / `parseFreeText` live in api/_lib/occ.ts;
 * this file is a focused frontend equivalent so the AddContractForm
 * paste-to-prefill flow doesn't need a network round-trip just to know
 * what the user dropped in.
 *
 * Supports three input shapes, returning `null` from `tryParseOccChain`
 * on anything else so the caller can treat parse-fail as "leave the
 * form alone":
 *
 *   1. Bare OCC body — padded (`NVDA  260522P00225000`, 21 chars) or
 *      unpadded (`TSLA261016C00800000`, 16-21 chars). Case-insensitive.
 *   2. UW option-chain URL (path-style):
 *      `[https://[www.]]unusualwhales.com/option-chain/<OCC>`
 *   3. UW flow URL (query-style):
 *      `[https://[www.]]unusualwhales.com/flow/option_chains?chain=<OCC>`
 *      (other query params allowed in any order).
 *
 * `tryParseUwTicker` provides a softer ticker-only fallback for the
 * flow URL when `?chain=<TICKER>` carries only a root symbol (no
 * OCC tail). That lets the form prefill at least the Ticker field
 * when a user pastes a flow page they hadn't drilled into yet.
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

const OCC_BODY_RE = /^[A-Z][A-Z0-9.-]{0,5}\d{6}[CP]\d{8}$/;
const BARE_OCC_RE = /^([A-Z][A-Z0-9.-]{0,5}\s{0,5}\d{6}[CP]\d{8})$/i;
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,5}$/;

/**
 * Pull the OCC body out of an Unusual Whales URL, if present.
 * Handles both `/option-chain/<OCC>` and `/flow/option_chains?chain=<OCC>`.
 * Returns the upper-cased OCC body, or null if not a UW URL or no body
 * present in either slot.
 */
function extractOccFromUwUrl(input: string): string | null {
  // Add a protocol when missing so the URL constructor accepts
  // bare-host inputs like `unusualwhales.com/...`.
  const withProto = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'unusualwhales.com') return null;

  // /option-chain/<OCC>
  const pathMatch = /^\/option-chain\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
  if (pathMatch) {
    const body = pathMatch[1]!.toUpperCase();
    return OCC_BODY_RE.test(body) ? body : null;
  }

  // /flow/option_chains?chain=<OCC>
  if (url.pathname === '/flow/option_chains') {
    const chain = url.searchParams.get('chain');
    if (chain != null) {
      const upper = chain.toUpperCase();
      if (OCC_BODY_RE.test(upper)) return upper;
    }
  }
  return null;
}

/**
 * Try to parse a UW URL or bare OCC body into structured fields.
 * Returns `null` on any input that isn't recognizable (whitespace,
 * non-OCC text, malformed body, ticker-only flow URL) — the caller
 * decides whether to surface a hint or fall back to a softer parse.
 */
export function tryParseOccChain(input: string): ParsedOccChain | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  let occBody: string | null = extractOccFromUwUrl(trimmed);
  if (occBody == null) {
    const bareMatch = BARE_OCC_RE.exec(trimmed);
    if (bareMatch) occBody = bareMatch[1]!.toUpperCase();
  }
  if (occBody == null) return null;

  // Normalize to canonical form (root + 15-char tail, no internal whitespace).
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

/**
 * Softer fallback for UW flow URLs that carry only a ticker, e.g.
 * `unusualwhales.com/flow/option_chains?chain=NFLX`. Returns the
 * upper-cased root symbol or null. Used by the AddContractForm to
 * prefill the Ticker field when no specific contract is in the URL.
 *
 * Returns null when the URL already contains a full OCC body — the
 * caller should prefer `tryParseOccChain` in that case.
 */
export function tryParseUwTicker(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const withProto = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'unusualwhales.com') return null;
  if (url.pathname !== '/flow/option_chains') return null;

  const chain = url.searchParams.get('chain');
  if (chain == null) return null;
  const upper = chain.toUpperCase();
  // Skip if the chain param actually carries a full OCC body — the
  // structured parser handles that case and returns more info.
  if (OCC_BODY_RE.test(upper)) return null;
  return TICKER_RE.test(upper) ? upper : null;
}
