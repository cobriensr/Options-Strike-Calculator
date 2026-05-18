/**
 * OCC Options Symbology helpers.
 *
 * Pure module — no DB, no fetch, no globals. All inputs / outputs are
 * values or thrown Errors.
 *
 * The OCC Options Symbology Initiative defines a 21-character option
 * symbol of the form:
 *
 *   <root><YYMMDD><C|P><strike>
 *
 * Where:
 *   - root:   underlying ticker, left-aligned, space-padded to 6 chars
 *   - YYMMDD: 2-digit year, month, day of expiry
 *   - C|P:    'C' for call, 'P' for put
 *   - strike: strike × 1000, zero-padded to 8 digits (last 3 digits = cents)
 *
 * Example: NVDA 2026-05-22 225 Put → `NVDA  260522P00225000`.
 */

export interface OccBuildInput {
  ticker: string;
  expiry: Date | string;
  side: 'C' | 'P';
  strike: number;
}

export interface OccParsed {
  ticker: string;
  /** ISO date, YYYY-MM-DD */
  expiry: string;
  side: 'C' | 'P';
  strike: number;
}

export interface FreeTextParsed {
  ticker: string;
  expiry: Date;
  side: 'C' | 'P';
  strike: number;
  direction: 'long' | 'short';
  entry_price?: number;
  quantity?: number;
}

/**
 * Build a 21-character OCC option symbol from structured input.
 *
 * Throws on:
 *   - ticker longer than 6 characters (no truncation)
 *   - ticker containing whitespace or being empty
 *   - side not exactly 'C' or 'P'
 *   - non-finite or non-positive strike
 *   - expiry that is not a Date or YYYY-MM-DD string
 */
export function toOccSymbol(input: OccBuildInput): string {
  const { ticker, expiry, side, strike } = input;

  if (typeof ticker !== 'string' || ticker.length === 0) {
    throw new Error('toOccSymbol: ticker must be a non-empty string');
  }
  if (/\s/.test(ticker)) {
    throw new Error('toOccSymbol: ticker must not contain whitespace');
  }
  if (ticker.length > 6) {
    throw new Error(
      `toOccSymbol: ticker "${ticker}" exceeds 6 characters (OCC limit)`,
    );
  }
  if (side !== 'C' && side !== 'P') {
    throw new Error(
      `toOccSymbol: side must be 'C' or 'P' (uppercase), got ${JSON.stringify(side)}`,
    );
  }
  if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0) {
    throw new Error(
      `toOccSymbol: strike must be a finite positive number, got ${String(strike)}`,
    );
  }

  const expiryDate = coerceExpiryToDate(expiry);
  const yy = String(expiryDate.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(expiryDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(expiryDate.getUTCDate()).padStart(2, '0');

  const rootPadded = ticker.toUpperCase().padEnd(6, ' ');
  // Strike × 1000, rounded to integer to handle floating-point dust
  // (e.g. 397.5 × 1000 in IEEE754). 8-digit zero-pad, with the last
  // 3 digits representing thousandths of a dollar (i.e. fractional cents).
  const strikeInt = Math.round(strike * 1000);
  if (strikeInt <= 0 || strikeInt > 99_999_999) {
    throw new Error(
      `toOccSymbol: strike ${String(strike)} out of OCC range (1..99999.999)`,
    );
  }
  const strikePadded = String(strikeInt).padStart(8, '0');

  return `${rootPadded}${yy}${mm}${dd}${side}${strikePadded}`;
}

/**
 * Parse a 21-character OCC option symbol back into structured fields.
 *
 * Throws on any input that doesn't match the OCC layout. The 2-digit
 * year is expanded with the same pivot the CBOE uses: years 00..49 →
 * 2000..2049, years 50..99 → 1950..1999. In practice every 0DTE-era
 * symbol falls in the 2000s window.
 */
export function parseOccSymbol(occ: string): OccParsed {
  if (typeof occ !== 'string' || occ.length !== 21) {
    throw new Error(
      `parseOccSymbol: input must be a 21-character OCC symbol, got length ${
        typeof occ === 'string' ? occ.length : typeof occ
      }`,
    );
  }

  const rootPadded = occ.slice(0, 6);
  const yy = occ.slice(6, 8);
  const mm = occ.slice(8, 10);
  const dd = occ.slice(10, 12);
  const side = occ.slice(12, 13);
  const strikeStr = occ.slice(13, 21);

  const ticker = rootPadded.trimEnd();
  if (ticker.length === 0 || /\s/.test(ticker)) {
    throw new Error(`parseOccSymbol: invalid ticker root "${rootPadded}"`);
  }
  if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) {
    throw new Error(`parseOccSymbol: invalid date segment "${yy}${mm}${dd}"`);
  }
  if (side !== 'C' && side !== 'P') {
    throw new Error(`parseOccSymbol: invalid side "${side}"`);
  }
  if (!/^\d{8}$/.test(strikeStr)) {
    throw new Error(`parseOccSymbol: invalid strike segment "${strikeStr}"`);
  }

  const yyNum = Number.parseInt(yy, 10);
  const mmNum = Number.parseInt(mm, 10);
  const ddNum = Number.parseInt(dd, 10);
  if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) {
    throw new Error(
      `parseOccSymbol: out-of-range date ${yy}-${mm}-${dd} in "${occ}"`,
    );
  }
  const fullYear = yyNum < 50 ? 2000 + yyNum : 1900 + yyNum;
  const expiry = `${String(fullYear)}-${mm}-${dd}`;

  const strike = Number.parseInt(strikeStr, 10) / 1000;

  return { ticker, expiry, side, strike };
}

/**
 * Parse a free-text contract description into structured fields.
 *
 * Accepted shapes (case-insensitive on side and direction):
 *
 *   NVDA 225P 05/22/26 @ 4.30 x 5 long
 *   NVDA 225P 05/22/26 @ 4.30 x 5
 *   NVDA 225P 05/22/2026 @ 4.30 x 5
 *   short NVDA 225P 05/22/26 @ 4.30 x 5
 *   NVDA 225C 05/22/26
 *
 *   TSLA261016C00800000 @ 4.30 x 5 long
 *   https://unusualwhales.com/option-chain/TSLA261016C00800000 @ 4.30 x 5
 *   https://unusualwhales.com/flow/option_chains?chain=NFLX260522P00091000 @ 4 x 1
 *
 * Order is: optional `long|short` prefix, then EITHER a natural-language
 * `ticker strike+side date` OR an OCC symbol / Unusual Whales option-chain
 * URL, then optional `@ <entry>` and `x <qty>`, optional trailing
 * `long|short` (overrides the prefix).
 *
 * The parser is strict — anything that doesn't match throws a descriptive
 * Error. Side must be 'C' or 'P' uppercase in the strike token; lowercase
 * 'p'/'c' is rejected (callers must canonicalize before parsing).
 */
export function parseFreeText(input: string): FreeTextParsed {
  if (typeof input !== 'string') {
    throw new Error('parseFreeText: input must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('parseFreeText: empty input');
  }

  // Parse in stages to keep each regex simple. The full grammar is:
  //
  //   [long|short] TICKER STRIKE+SIDE MM/DD/YY[YY] [@ entry] [x qty] [long|short]
  //
  // Step 1: peel off any leading "long " / "short " direction prefix.
  // Step 2: peel off any trailing " long" / " short" direction suffix.
  // Step 3: peel off " x <qty>" if present.
  // Step 4: peel off " @ <entry>" if present.
  // Step 5: match the remaining "TICKER STRIKE+SIDE DATE" with one regex.
  //
  // Trailing direction wins over prefix if both appear.

  const failParse = (): never => {
    throw new Error(
      `parseFreeText: could not parse "${input}". Expected e.g. "NVDA 225P 05/22/26 @ 4.30 x 5 long".`,
    );
  };

  let remaining = trimmed;
  let directionPrefix: string | undefined;
  let directionSuffix: string | undefined;
  let rawEntry: string | undefined;
  let rawQty: string | undefined;

  const prefixMatch = /^(long|short)\s+/i.exec(remaining);
  if (prefixMatch) {
    directionPrefix = prefixMatch[1];
    remaining = remaining.slice(prefixMatch[0].length);
  }

  // Each peel trims trailing whitespace, then matches a fixed-width
  // suffix (no \s* / \s+ on the leading edge) to avoid ambiguous
  // backtracking. Whitespace tolerance around `@` / `x` is preserved
  // because we trim after every step.
  remaining = remaining.trimEnd();
  const suffixMatch = /[ \t](long|short)$/i.exec(remaining);
  if (suffixMatch) {
    directionSuffix = suffixMatch[1];
    remaining = remaining.slice(0, suffixMatch.index).trimEnd();
  }

  const qtyMatch = /x[ \t]*(\d+)$/i.exec(remaining);
  if (qtyMatch) {
    rawQty = qtyMatch[1];
    remaining = remaining.slice(0, qtyMatch.index).trimEnd();
  }

  const entryMatch = /@[ \t]*(\d+(?:\.\d+)?)$/.exec(remaining);
  if (entryMatch) {
    rawEntry = entryMatch[1];
    remaining = remaining.slice(0, entryMatch.index).trimEnd();
  }

  // OCC fast-path: paste of "TSLA261016C00800000" or the equivalent
  // Unusual Whales URL "https://unusualwhales.com/option-chain/<OCC>".
  // If `remaining` is exactly one of these forms we resolve ticker /
  // expiry / strike / side from the OCC fields directly and skip the
  // natural-language core regex. Trailing `@ entry x qty long|short`
  // suffixes have already been peeled above, so the OCC token sits
  // alone at this point.
  let ticker: string;
  let strike: number;
  let side: 'C' | 'P';
  let expiry: Date;
  const occToken = extractOccToken(remaining);
  if (occToken !== null) {
    const occ = parseOccSymbol(normalizeOccSymbol(occToken));
    ticker = occ.ticker;
    strike = occ.strike;
    side = occ.side;
    // parseOccSymbol returns YYYY-MM-DD; coerce to a UTC Date so the
    // caller-facing FreeTextParsed shape matches the natural-language
    // branch below.
    expiry = coerceExpiryToDate(occ.expiry);
  } else {
    // Core: ticker, strike+side, date. Side is matched case-insensitively
    // here so we can give a precise "must be uppercase" error below rather
    // than a generic parse failure.
    const corePattern =
      /^([A-Z][A-Z0-9.-]{0,5})\s+(\d+(?:\.\d+)?)([CPcp])\s+(\d{1,2}\/\d{1,2}\/\d{2,4})$/;
    const match = corePattern.exec(remaining);
    if (!match) {
      failParse();
    }

    const rawTicker = match?.[1] ?? '';
    const rawStrike = match?.[2] ?? '';
    const rawSide = match?.[3] ?? '';
    const rawDate = match?.[4] ?? '';

    // Reject lowercase side in the strike token. We use a case-insensitive
    // regex so we can give a clearer error than "no match" — but the spec
    // demands strict uppercase for the contract side.
    if (rawSide !== 'C' && rawSide !== 'P') {
      throw new Error(
        `parseFreeText: side must be uppercase 'C' or 'P', got "${rawSide}" in "${input}"`,
      );
    }

    ticker = rawTicker.toUpperCase();
    if (ticker.length > 6) {
      throw new Error(
        `parseFreeText: ticker "${ticker}" exceeds 6 characters (OCC limit)`,
      );
    }

    strike = Number.parseFloat(rawStrike);
    if (!Number.isFinite(strike) || strike <= 0) {
      throw new Error(`parseFreeText: invalid strike "${rawStrike}"`);
    }

    expiry = parseUsDate(rawDate);
    side = rawSide;
  }

  let entry_price: number | undefined;
  if (rawEntry !== undefined) {
    entry_price = Number.parseFloat(rawEntry);
    if (!Number.isFinite(entry_price) || entry_price <= 0) {
      throw new Error(`parseFreeText: invalid entry price "${rawEntry}"`);
    }
  }

  let quantity: number | undefined;
  if (rawQty !== undefined) {
    quantity = Number.parseInt(rawQty, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`parseFreeText: invalid quantity "${rawQty}"`);
    }
  }

  // Trailing direction wins over prefix, matching natural reading.
  const directionRaw = (
    directionSuffix ??
    directionPrefix ??
    'long'
  ).toLowerCase();
  if (directionRaw !== 'long' && directionRaw !== 'short') {
    // Should be unreachable given the regex alternation, but keeps the
    // type narrowing honest.
    throw new Error(`parseFreeText: invalid direction "${directionRaw}"`);
  }

  return {
    ticker,
    expiry,
    side,
    strike,
    direction: directionRaw,
    ...(entry_price !== undefined ? { entry_price } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
  };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function coerceExpiryToDate(expiry: Date | string): Date {
  if (expiry instanceof Date) {
    if (Number.isNaN(expiry.getTime())) {
      throw new Error('toOccSymbol: expiry Date is Invalid Date');
    }
    return expiry;
  }
  if (typeof expiry === 'string') {
    const m = ISO_DATE_RE.exec(expiry);
    if (!m) {
      throw new Error(
        `toOccSymbol: expiry string must be YYYY-MM-DD, got "${expiry}"`,
      );
    }
    const year = Number.parseInt(m[1] ?? '', 10);
    const month = Number.parseInt(m[2] ?? '', 10);
    const day = Number.parseInt(m[3] ?? '', 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(
        `toOccSymbol: expiry "${expiry}" has out-of-range fields`,
      );
    }
    // Build in UTC so getUTC*() returns the same calendar components we
    // were handed. We don't care about wall-clock time of day for an
    // expiry — just the date.
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    ) {
      throw new Error(
        `toOccSymbol: expiry "${expiry}" is not a real calendar date`,
      );
    }
    return d;
  }
  throw new Error(
    `toOccSymbol: expiry must be Date or YYYY-MM-DD string, got ${typeof expiry}`,
  );
}

const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

function parseUsDate(s: string): Date {
  const m = US_DATE_RE.exec(s);
  if (!m) {
    throw new Error(
      `parseFreeText: invalid date "${s}", expected MM/DD/YY[YY]`,
    );
  }
  const monthStr = m[1] ?? '';
  const dayStr = m[2] ?? '';
  const yearStr = m[3] ?? '';
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const yearRaw = Number.parseInt(yearStr, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`parseFreeText: date "${s}" has out-of-range fields`);
  }
  let year: number;
  if (yearStr.length === 2) {
    year = yearRaw < 50 ? 2000 + yearRaw : 1900 + yearRaw;
  } else if (yearStr.length === 4) {
    year = yearRaw;
  } else {
    throw new Error(`parseFreeText: year must be 2 or 4 digits in "${s}"`);
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`parseFreeText: "${s}" is not a real calendar date`);
  }
  return d;
}

// OCC fast-path helpers — match either a bare OCC symbol (with or
// without root padding) or an Unusual Whales URL carrying a full OCC
// body, in either of two shapes:
//   1. `[https://[www.]]unusualwhales.com/option-chain/<OCC>` (path-style)
//   2. `[https://[www.]]unusualwhales.com/flow/option_chains?chain=<OCC>`
// Body shape: <root 1–6><YYMMDD 6 digits><C|P><strike 8 digits>.
const OCC_BODY_RE = /^[A-Z][A-Z0-9.-]{0,5}\d{6}[CP]\d{8}$/;
// Root may include trailing spaces (OCC's 6-char padding) — match a
// flexible internal whitespace and normalize after.
const BARE_OCC_RE = /^([A-Z][A-Z0-9.-]{0,5}\s{0,5}\d{6}[CP]\d{8})$/i;

/**
 * Try to extract an OCC symbol from a fully-trimmed input that's
 * supposed to BE either a bare OCC or a UW URL (no surrounding
 * grammar). Returns the OCC body (uppercase) or `null` when neither
 * shape matches. Trailing `@ entry x qty` etc. must already be
 * peeled by the caller.
 */
function extractOccToken(input: string): string | null {
  const trimmed = input.trim();

  // URL path: try parsing as a UW URL (either shape) before falling
  // back to bare-OCC. The `URL` constructor needs a protocol, so
  // prepend `https://` for protocol-less inputs like
  // `unusualwhales.com/option-chain/<OCC>`.
  if (/^(?:https?:\/\/)?(?:www\.)?unusualwhales\.com\//i.test(trimmed)) {
    const withProto = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      const url = new URL(withProto);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      if (host === 'unusualwhales.com') {
        const pathMatch = /^\/option-chain\/([A-Za-z0-9.-]+)$/.exec(
          url.pathname,
        );
        if (pathMatch) {
          const body = pathMatch[1]!.toUpperCase();
          if (OCC_BODY_RE.test(body)) return body;
        }
        if (url.pathname === '/flow/option_chains') {
          const chain = url.searchParams.get('chain');
          if (chain != null) {
            const upper = chain.toUpperCase();
            if (OCC_BODY_RE.test(upper)) return upper;
          }
        }
      }
    } catch {
      // Malformed URL — fall through to bare-OCC attempt.
    }
  }

  const bareMatch = BARE_OCC_RE.exec(trimmed);
  if (bareMatch) return bareMatch[1]!.toUpperCase();
  return null;
}

/**
 * Normalize a UW-style unpadded OCC token (e.g. `TSLA261016C00800000`)
 * to the 21-character canonical form parseOccSymbol expects (root
 * right-padded with spaces). Pass-through for already-padded inputs.
 * The fixed tail is 15 chars (6 date + 1 side + 8 strike), so any
 * length between 16 and 21 has a unique root slice.
 */
function normalizeOccSymbol(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length < 16 || cleaned.length > 21) {
    throw new Error(
      `parseFreeText: OCC token length ${String(cleaned.length)} out of range (16-21)`,
    );
  }
  const rootLen = cleaned.length - 15;
  return cleaned.slice(0, rootLen).padEnd(6, ' ') + cleaned.slice(rootLen);
}
