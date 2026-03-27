/**
 * Holistic paperMoney CSV Parser
 *
 * Parses the ENTIRE thinkorswim paperMoney account statement CSV,
 * cross-referencing multiple sections to build a complete picture:
 *
 * 1. OPTIONS section → current open positions (ground truth for what's on now)
 * 2. ACCOUNT TRADE HISTORY → all trades executed today (opens + closes)
 * 3. CASH BALANCE → starting balance, total credits/debits
 * 4. PROFITS AND LOSSES → P/L Day, P/L YTD, Mark Value
 * 5. ACCOUNT SUMMARY → Net Liquidating Value
 *
 * Cross-referencing logic:
 * - Open positions come from the Options section (authoritative)
 * - Trade History identifies which spreads were opened AND closed today
 *   (TO OPEN legs with matching TO CLOSE legs = realized P&L)
 * - Trade History TO OPEN legs WITHOUT matching TO CLOSE = still open
 *   (used as fallback if Options section is missing)
 *
 * This replaces the old parsePaperMoneyCSV which only read one section.
 */

import type { PositionLeg } from './db.js';

// ── Types ───────────────────────────────────────────────────

export interface ParsedTrade {
  putCall: 'PUT' | 'CALL';
  strike: number;
  expiration: string;
  quantity: number; // negative = short, positive = long
  price: number; // per-contract fill price
  netPrice: number; // spread net price (credit/debit)
  posEffect: 'TO OPEN' | 'TO CLOSE';
  execTime: string; // raw exec time string
  spreadType: string; // VERTICAL, SINGLE, etc.
}

export interface ClosedSpread {
  type: 'CALL CREDIT SPREAD' | 'PUT CREDIT SPREAD';
  shortStrike: number;
  longStrike: number;
  width: number;
  contracts: number;
  openCredit: number; // per-spread credit received
  closeDebit: number; // per-spread debit paid to close
  realizedPnl: number; // total P&L for this spread
  openTime: string;
  closeTime: string;
}

export interface ParsedCSV {
  /** Current open position legs (from Options section) */
  openLegs: PositionLeg[];
  /** Trades that were opened AND closed today (from Trade History) */
  closedSpreads: ClosedSpread[];
  /** All trades executed today (from Trade History) */
  allTrades: ParsedTrade[];
  /** Day P&L from Profits and Losses section */
  dayPnl: number | null;
  /** YTD P&L from Profits and Losses section */
  ytdPnl: number | null;
  /** Net Liquidating Value from Account Summary */
  netLiquidatingValue: number | null;
  /** Starting cash balance */
  startingBalance: number | null;
  /** Whether the Options section was found */
  hasOptionsSection: boolean;
}

// ── Month map for date parsing ──────────────────────────────

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

/** Parse "27 MAR 26" → "2026-03-27" */
export function parseTosExpiration(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 3) return raw;
  const [day, month, year] = parts;
  const mm = MONTH_MAP[month!.toUpperCase()];
  if (!mm) return raw;
  const yyyy = year!.length === 2 ? `20${year}` : year!;
  return `${yyyy}-${mm}-${day!.padStart(2, '0')}`;
}

/** Parse "$450.00" → 450, "($1,050.00)" → -1050, handle commas */
export function parseDollarValue(raw: string): number {
  const cleaned = raw.replaceAll(/[$,\s]/g, '');
  const match = /^\((.+)\)$/.exec(cleaned);
  if (match) return -Number.parseFloat(match[1]!);
  return Number.parseFloat(cleaned);
}

/** Parse a CSV line handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
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

// ── Section finders ─────────────────────────────────────────

function findSectionStart(lines: string[], sectionName: string): number {
  return lines.findIndex((line) => line.trim() === sectionName);
}

function findHeaderRow(
  lines: string[],
  afterIdx: number,
  requiredFields: string[],
  maxLookAhead = 5,
): number {
  for (
    let i = afterIdx + 1;
    i < Math.min(afterIdx + maxLookAhead + 1, lines.length);
    i++
  ) {
    const line = lines[i]!;
    if (requiredFields.every((f) => line.includes(f))) {
      return i;
    }
  }
  return -1;
}

// ── Parse Options section (open positions) ──────────────────

function parseOptionsSection(lines: string[]): PositionLeg[] {
  // Find the Options header — flexible match
  const headerIdx = lines.findIndex((line) =>
    line.startsWith('Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price'),
  );
  if (headerIdx < 0) return [];

  const headerFields = parseCSVLine(lines[headerIdx]!);
  const hasMarkValue = headerFields.some((f) =>
    f.toLowerCase().includes('mark value'),
  );

  const legs: PositionLeg[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith(',OVERALL TOTALS')) break;

    const fields = parseCSVLine(line);
    if (fields.length < 7) continue;

    const [symbol, optionCode, exp, strikeStr, type, qtyStr, tradePrice] =
      fields;

    if (symbol !== 'SPX') continue;

    const putCall = type!.toUpperCase() as 'PUT' | 'CALL';
    if (putCall !== 'PUT' && putCall !== 'CALL') continue;

    const strike = Number.parseFloat(strikeStr!);
    const quantity = Number.parseInt(qtyStr!.replace('+', ''), 10);
    const avgPrice = Number.parseFloat(tradePrice!);
    const expiration = parseTosExpiration(exp!);

    if (Number.isNaN(strike) || Number.isNaN(quantity)) continue;

    // Mark Value is the last column when present (may have a Mark column before it)
    let marketValue = 0;
    if (hasMarkValue && fields.length >= 9) {
      marketValue = parseDollarValue(fields[8]!);
    }

    legs.push({
      putCall,
      symbol: optionCode || `SPX_${strike}${putCall[0]}`,
      strike,
      expiration,
      quantity,
      averagePrice: avgPrice,
      marketValue,
      delta: undefined,
      theta: undefined,
      gamma: undefined,
    });
  }

  return legs;
}

// ── Parse Trade History (all trades today) ───────────────────

function parseTradeHistory(lines: string[]): ParsedTrade[] {
  const sectionIdx = findSectionStart(lines, 'Account Trade History');
  if (sectionIdx < 0) return [];

  const headerIdx = findHeaderRow(lines, sectionIdx, ['Exec Time', 'Strike']);
  if (headerIdx < 0) return [];

  const trades: ParsedTrade[] = [];
  let currentSpreadType = '';
  let currentExecTime = '';

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    // Stop at the next section (line that doesn't start with comma)
    if (!line.startsWith(',')) break;

    const fields = parseCSVLine(line);

    // Primary row has execTime in fields[1], continuation rows have empty fields[1]
    const execTime = fields[1]?.trim();
    const spreadType = fields[2]?.trim();
    const qtyStr = fields[4]?.trim();
    const posEffect = fields[5]?.trim();
    const symbol = fields[6]?.trim();
    const exp = fields[7]?.trim();
    const strikeStr = fields[8]?.trim();
    const type = fields[9]?.trim();
    const priceStr = fields[10]?.trim();
    const netPriceStr = fields[11]?.trim();

    // Track spread context from primary rows
    if (execTime) {
      currentExecTime = execTime;
      if (spreadType) currentSpreadType = spreadType;
    }

    if (!symbol || symbol !== 'SPX') continue;
    if (!type || !strikeStr || !priceStr) continue;

    const putCall = type.toUpperCase() as 'PUT' | 'CALL';
    if (putCall !== 'PUT' && putCall !== 'CALL') continue;

    const strike = Number.parseFloat(strikeStr);
    const legPrice = Number.parseFloat(priceStr);
    if (Number.isNaN(strike) || Number.isNaN(legPrice)) continue;

    const quantity = Number.parseInt(qtyStr?.replace('+', '') ?? '0', 10);
    if (quantity === 0 || Number.isNaN(quantity)) continue;

    const effect =
      posEffect === 'TO OPEN' || posEffect === 'TO CLOSE'
        ? posEffect
        : 'TO OPEN';

    // Net price: parse if it's a number (primary rows), ignore CREDIT/DEBIT text
    let netPrice = 0;
    if (netPriceStr) {
      const parsed = Number.parseFloat(netPriceStr);
      if (!Number.isNaN(parsed)) netPrice = parsed;
    }

    trades.push({
      putCall,
      strike,
      expiration: parseTosExpiration(exp!),
      quantity,
      price: legPrice,
      netPrice,
      posEffect: effect,
      execTime: currentExecTime,
      spreadType: currentSpreadType,
    });
  }

  return trades;
}

// ── Identify closed spreads from Trade History ──────────────

function identifyClosedSpreads(trades: ParsedTrade[]): ClosedSpread[] {
  // Group trades by strike+type+posEffect
  const opens = trades.filter((t) => t.posEffect === 'TO OPEN');
  const closes = trades.filter((t) => t.posEffect === 'TO CLOSE');

  if (closes.length === 0) return [];

  // Match close legs with open legs by strike and type
  const closedSpreads: ClosedSpread[] = [];
  const usedCloseIndices = new Set<number>();

  // Group opens into spreads (pair short+long of same type from same exec time)
  const openSpreads: Array<{
    shortLeg: ParsedTrade;
    longLeg: ParsedTrade;
    netCredit: number;
  }> = [];

  // Sort opens by exec time to group spread legs together
  const sortedOpens = [...opens].sort((a, b) =>
    a.execTime.localeCompare(b.execTime),
  );

  for (let i = 0; i < sortedOpens.length; i++) {
    const a = sortedOpens[i]!;
    if (a.quantity >= 0) continue; // short legs only

    // Find the matching long leg (same type, same exec time, closest strike)
    for (let j = 0; j < sortedOpens.length; j++) {
      if (i === j) continue;
      const b = sortedOpens[j]!;
      if (
        b.quantity <= 0 ||
        b.putCall !== a.putCall ||
        b.execTime !== a.execTime
      )
        continue;

      const width = Math.abs(b.strike - a.strike);
      if (width > 0 && width <= 50) {
        openSpreads.push({
          shortLeg: a,
          longLeg: b,
          netCredit: Math.abs(a.price) - Math.abs(b.price),
        });
        break;
      }
    }
  }

  // Now match each open spread with its close
  for (const spread of openSpreads) {
    // Find close legs matching this spread's strikes
    const closeShortIdx = closes.findIndex(
      (c, idx) =>
        !usedCloseIndices.has(idx) &&
        c.strike === spread.shortLeg.strike &&
        c.putCall === spread.shortLeg.putCall &&
        c.posEffect === 'TO CLOSE',
    );

    if (closeShortIdx < 0) continue;

    const closeLongIdx = closes.findIndex(
      (c, idx) =>
        !usedCloseIndices.has(idx) &&
        c.strike === spread.longLeg.strike &&
        c.putCall === spread.longLeg.putCall &&
        c.posEffect === 'TO CLOSE',
    );

    if (closeLongIdx < 0) continue;

    usedCloseIndices.add(closeShortIdx);
    usedCloseIndices.add(closeLongIdx);

    const closeShort = closes[closeShortIdx]!;
    const closeLong = closes[closeLongIdx]!;

    const contracts = Math.abs(spread.shortLeg.quantity);
    const openCredit = spread.netCredit;
    const closeDebit = Math.abs(closeShort.price) - Math.abs(closeLong.price);
    const realizedPnl = (openCredit - closeDebit) * 100 * contracts;

    const type: 'CALL CREDIT SPREAD' | 'PUT CREDIT SPREAD' =
      spread.shortLeg.putCall === 'CALL'
        ? 'CALL CREDIT SPREAD'
        : 'PUT CREDIT SPREAD';

    closedSpreads.push({
      type,
      shortStrike: spread.shortLeg.strike,
      longStrike: spread.longLeg.strike,
      width: Math.abs(spread.longLeg.strike - spread.shortLeg.strike),
      contracts,
      openCredit: Math.round(openCredit * 100) / 100,
      closeDebit: Math.round(closeDebit * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      openTime: spread.shortLeg.execTime,
      closeTime: closeShort.execTime,
    });
  }

  return closedSpreads;
}

// ── Parse P&L and Account Summary ───────────────────────────

function parsePnLSection(lines: string[]): {
  dayPnl: number | null;
  ytdPnl: number | null;
} {
  // Find the SPX P&L line in "Profits and Losses" section
  for (const line of lines) {
    if (line.startsWith('SPX,')) {
      const fields = parseCSVLine(line);
      // Fields: Symbol, Description, P/L Open, P/L %, P/L Day, P/L YTD, ...
      const dayPnl = fields[4] ? parseDollarValue(fields[4]) : null;
      const ytdPnl = fields[5] ? parseDollarValue(fields[5]) : null;
      return {
        dayPnl: dayPnl && !Number.isNaN(dayPnl) ? dayPnl : null,
        ytdPnl: ytdPnl && !Number.isNaN(ytdPnl) ? ytdPnl : null,
      };
    }
  }
  return { dayPnl: null, ytdPnl: null };
}

function parseAccountSummary(lines: string[]): {
  netLiquidatingValue: number | null;
} {
  for (const line of lines) {
    if (line.startsWith('Net Liquidating Value,')) {
      const fields = parseCSVLine(line);
      const val = fields[1] ? parseDollarValue(fields[1]) : null;
      return {
        netLiquidatingValue: val && !Number.isNaN(val) ? val : null,
      };
    }
  }
  return { netLiquidatingValue: null };
}

function parseStartingBalance(lines: string[]): number | null {
  for (const line of lines) {
    if (line.includes('Cash balance at the start of business day')) {
      const fields = parseCSVLine(line);
      const val = fields[fields.length - 1];
      if (val) {
        const parsed = parseDollarValue(val);
        return Number.isNaN(parsed) ? null : parsed;
      }
    }
  }
  return null;
}

// ── Main parser ─────────────────────────────────────────────

/**
 * Parse the entire paperMoney CSV export holistically.
 *
 * Returns:
 * - openLegs: current open positions (from Options section)
 * - closedSpreads: spreads opened and closed today (from Trade History)
 * - allTrades: every trade executed today
 * - dayPnl / ytdPnl: from P&L section
 * - netLiquidatingValue: from Account Summary
 * - hasOptionsSection: whether the Options section was found
 */
export function parseFullCSV(csv: string): ParsedCSV {
  const lines = csv.split(/\r?\n/);

  // 1. Parse Options section (open positions)
  const openLegs = parseOptionsSection(lines);
  const hasOptionsSection = openLegs.length > 0;

  // 2. Parse Trade History (all trades today)
  const allTrades = parseTradeHistory(lines);

  // 3. Identify closed spreads from Trade History
  const closedSpreads = identifyClosedSpreads(allTrades);

  // 4. If no Options section, derive open positions from Trade History
  //    (TO OPEN legs without matching TO CLOSE = still open)
  if (!hasOptionsSection && allTrades.length > 0) {
    const openTrades = allTrades.filter((t) => t.posEffect === 'TO OPEN');
    const closeTrades = allTrades.filter((t) => t.posEffect === 'TO CLOSE');

    // Build a usage count map for close trades
    const closeUsage = new Map<string, number>();
    for (const c of closeTrades) {
      const key = `${c.strike}_${c.putCall}`;
      closeUsage.set(key, (closeUsage.get(key) ?? 0) + Math.abs(c.quantity));
    }

    for (const t of openTrades) {
      const key = `${t.strike}_${t.putCall}`;
      const closedQty = closeUsage.get(key) ?? 0;
      const openQty = Math.abs(t.quantity);
      const remainingQty = openQty - closedQty;

      if (remainingQty > 0) {
        // Partially or fully open
        const sign = t.quantity > 0 ? 1 : -1;
        openLegs.push({
          putCall: t.putCall,
          symbol: `SPX_${t.strike}${t.putCall[0]}`,
          strike: t.strike,
          expiration: t.expiration,
          quantity: sign * remainingQty,
          averagePrice: t.price,
          marketValue: 0,
          delta: undefined,
          theta: undefined,
          gamma: undefined,
        });
        // Consume the close usage
        if (closedQty > 0) {
          closeUsage.set(key, Math.max(0, closedQty - openQty));
        }
      } else {
        // Fully closed — consume from close usage
        closeUsage.set(key, closedQty - openQty);
      }
    }
  }

  // 5. Parse P&L section
  const { dayPnl, ytdPnl } = parsePnLSection(lines);

  // 6. Parse Account Summary
  const { netLiquidatingValue } = parseAccountSummary(lines);

  // 7. Parse starting balance
  const startingBalance = parseStartingBalance(lines);

  return {
    openLegs,
    closedSpreads,
    allTrades,
    dayPnl,
    ytdPnl,
    netLiquidatingValue,
    startingBalance,
    hasOptionsSection,
  };
}

/**
 * Build a human-readable summary that includes BOTH open positions
 * and today's closed trades for complete context.
 */
export function buildFullSummary(parsed: ParsedCSV, spxPrice?: number): string {
  const lines: string[] = [];

  // ── Open positions ──────────────────────────────────────
  if (parsed.openLegs.length > 0) {
    // Group into spreads for display
    const calls = parsed.openLegs.filter((l) => l.putCall === 'CALL');
    const puts = parsed.openLegs.filter((l) => l.putCall === 'PUT');

    const openSpreads = pairForDisplay(calls, puts, spxPrice);
    lines.push(
      `=== OPEN SPX 0DTE Positions (${openSpreads.length} spread${openSpreads.length !== 1 ? 's' : ''}) ===`,
    );
    if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
    lines.push('');

    for (const s of openSpreads) {
      lines.push(s);
    }
    lines.push('');
  } else {
    lines.push('=== NO OPEN SPX 0DTE POSITIONS ===');
    lines.push('');
  }

  // ── Closed trades today ─────────────────────────────────
  if (parsed.closedSpreads.length > 0) {
    const totalRealized = parsed.closedSpreads.reduce(
      (sum, s) => sum + s.realizedPnl,
      0,
    );
    lines.push(
      `=== Closed Today: ${parsed.closedSpreads.length} spread${parsed.closedSpreads.length !== 1 ? 's' : ''} | Realized P&L: $${totalRealized.toLocaleString()} ===`,
    );

    const closedCCS = parsed.closedSpreads.filter(
      (s) => s.type === 'CALL CREDIT SPREAD',
    );
    const closedPCS = parsed.closedSpreads.filter(
      (s) => s.type === 'PUT CREDIT SPREAD',
    );

    if (closedCCS.length > 0) {
      lines.push(`  CCS closed (${closedCCS.length}):`);
      for (const s of closedCCS) {
        lines.push(
          `    ${s.shortStrike}/${s.longStrike}C | ${s.contracts} contracts | Credit: $${s.openCredit.toFixed(2)} → Closed: $${s.closeDebit.toFixed(2)} | P&L: $${s.realizedPnl.toLocaleString()}`,
        );
      }
    }
    if (closedPCS.length > 0) {
      lines.push(`  PCS closed (${closedPCS.length}):`);
      for (const s of closedPCS) {
        lines.push(
          `    ${s.shortStrike}/${s.longStrike}P | ${s.contracts} contracts | Credit: $${s.openCredit.toFixed(2)} → Closed: $${s.closeDebit.toFixed(2)} | P&L: $${s.realizedPnl.toLocaleString()}`,
        );
      }
    }
    lines.push('');
  }

  // ── Account context ─────────────────────────────────────
  if (
    parsed.dayPnl != null ||
    parsed.ytdPnl != null ||
    parsed.netLiquidatingValue != null
  ) {
    lines.push('=== Account ===');
    if (parsed.dayPnl != null)
      lines.push(`  Day P&L (SPX): $${parsed.dayPnl.toLocaleString()}`);
    if (parsed.ytdPnl != null)
      lines.push(`  YTD P&L: $${parsed.ytdPnl.toLocaleString()}`);
    if (parsed.netLiquidatingValue != null)
      lines.push(
        `  Net Liquidating Value: $${parsed.netLiquidatingValue.toLocaleString()}`,
      );
  }

  return lines.join('\n');
}

// ── Helper: pair legs into spread display lines ─────────────

function pairForDisplay(
  calls: PositionLeg[],
  puts: PositionLeg[],
  spxPrice?: number,
): string[] {
  const lines: string[] = [];

  function formatGroup(group: PositionLeg[], label: string): void {
    const shorts = group
      .filter((l) => l.quantity < 0)
      .sort((a, b) => a.strike - b.strike);
    const longs = group
      .filter((l) => l.quantity > 0)
      .sort((a, b) => a.strike - b.strike);

    if (shorts.length === 0) return;

    lines.push(`${label}:`);
    const usedLongs = new Set<number>();

    for (const short of shorts) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < longs.length; i++) {
        if (usedLongs.has(i)) continue;
        const dist = Math.abs(longs[i]!.strike - short.strike);
        if (dist < bestDist && dist <= 50) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        usedLongs.add(bestIdx);
        const long = longs[bestIdx]!;
        const width = Math.abs(long.strike - short.strike);
        const credit =
          Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
        const cushion =
          spxPrice != null
            ? short.putCall === 'CALL'
              ? Math.round(short.strike - spxPrice)
              : Math.round(spxPrice - short.strike)
            : null;
        const cushionLabel =
          short.putCall === 'CALL' ? 'above SPX' : 'below SPX';

        lines.push(
          `  Short ${short.strike}${short.putCall[0]} / Long ${long.strike}${long.putCall[0]} | ${Math.abs(short.quantity)} contracts | Credit: $${credit.toFixed(2)} | Width: ${width} pts` +
            (cushion != null
              ? ` | Cushion: ${cushion} pts ${cushionLabel}`
              : ''),
        );
      } else {
        lines.push(
          `  Short ${short.strike}${short.putCall[0]} (unpaired) | ${Math.abs(short.quantity)} contracts`,
        );
      }
    }
  }

  formatGroup(calls, 'CALL CREDIT SPREADS');
  formatGroup(puts, 'PUT CREDIT SPREADS');

  return lines;
}
