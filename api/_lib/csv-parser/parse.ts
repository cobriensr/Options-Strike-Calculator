/**
 * Holistic paperMoney CSV Parser — parsing layer.
 *
 * Tokenizes the thinkorswim paperMoney account statement CSV and emits
 * a typed `ParsedCSV` view of:
 *
 * 1. OPTIONS section → current open positions (ground truth)
 * 2. ACCOUNT TRADE HISTORY → all trades executed today
 * 3. PROFITS AND LOSSES → P/L Day, P/L YTD
 * 4. ACCOUNT SUMMARY → Net Liquidating Value
 * 5. CASH BALANCE → starting balance
 *
 * The summary/Claude-context builder lives next door in `./summary.ts`
 * and consumes the `ParsedCSV` exported here.
 */

import type { PositionLeg } from '../db.js';
import { MAX_RECOGNIZED_SPREAD_WIDTH } from './internals.js';

// ── Constants ───────────────────────────────────────────────

/**
 * Thinkorswim CSV label strings. Extracted to a single location so that
 * if TOS changes their export format we have one place to update, and
 * the label dependencies are discoverable by grep.
 */
const TOS_LABELS = {
  STARTING_BALANCE: 'Cash balance at the start of business day',
  NET_LIQ_PREFIX: 'Net Liquidating Value,',
  SPX_PNL_PREFIX: 'SPX,',
  PNL_SECTION: 'Profits and Losses',
  TRADE_HISTORY_SECTION: 'Account Trade History',
  OPTIONS_HEADER_PREFIX: 'Symbol,Option Code,Exp,Strike,Type,Qty,Trade Price',
} as const;

// ── Types ───────────────────────────────────────────────────

export interface ParsedTrade {
  putCall: 'PUT' | 'CALL';
  strike: number;
  expiration: string;
  quantity: number;
  price: number;
  netPrice: number;
  posEffect: 'TO OPEN' | 'TO CLOSE';
  execTime: string;
  spreadType: string;
}

export interface ClosedSpread {
  type: 'CALL CREDIT SPREAD' | 'PUT CREDIT SPREAD';
  shortStrike: number;
  longStrike: number;
  width: number;
  contracts: number;
  openCredit: number;
  closeDebit: number;
  realizedPnl: number;
  openTime: string;
  closeTime: string;
}

export interface ParsedCSV {
  openLegs: PositionLeg[];
  closedSpreads: ClosedSpread[];
  allTrades: ParsedTrade[];
  dayPnl: number | null;
  ytdPnl: number | null;
  netLiquidatingValue: number | null;
  startingBalance: number | null;
  hasOptionsSection: boolean;
}

// ── Helpers ─────────────────────────────────────────────────

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
  if (!day || !month || !year) return raw;
  const mm = MONTH_MAP[month.toUpperCase()];
  if (!mm) return raw;
  const yyyy = year.length === 2 ? `20${year}` : year;
  return `${yyyy}-${mm}-${day.padStart(2, '0')}`;
}

/** Parse "$450.00" → 450, "($1,050.00)" → -1050 */
function parseDollarValue(raw: string): number {
  const cleaned = raw.replaceAll(/[$,\s]/g, '');
  const match = /^\((.+)\)$/.exec(cleaned);
  if (match) return -Number.parseFloat(match[1]!);
  return Number.parseFloat(cleaned);
}

/** Parse a CSV line handling quoted fields with commas */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
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
    if (requiredFields.every((f) => lines[i]!.includes(f))) {
      return i;
    }
  }
  return -1;
}

// ── Parse Options section (open positions) ──────────────────

function parseOptionsSection(lines: string[]): PositionLeg[] {
  const headerIdx = lines.findIndex((line) =>
    line.startsWith(TOS_LABELS.OPTIONS_HEADER_PREFIX),
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
    if (!exp || !strikeStr || !type || !qtyStr || !tradePrice) continue;

    const putCall = type.toUpperCase() as 'PUT' | 'CALL';
    if (putCall !== 'PUT' && putCall !== 'CALL') continue;

    const strike = Number.parseFloat(strikeStr);
    const quantity = Number.parseInt(qtyStr.replace('+', ''), 10);
    const avgPrice = Number.parseFloat(tradePrice);
    const expiration = parseTosExpiration(exp);

    if (Number.isNaN(strike) || Number.isNaN(quantity)) continue;

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

// ── Parse Trade History ─────────────────────────────────────

function parseTradeHistory(lines: string[]): ParsedTrade[] {
  const sectionIdx = lines.findIndex(
    (line) => line.trim() === TOS_LABELS.TRADE_HISTORY_SECTION,
  );
  if (sectionIdx < 0) return [];

  const headerIdx = findHeaderRow(lines, sectionIdx, ['Exec Time', 'Strike']);
  if (headerIdx < 0) return [];

  const trades: ParsedTrade[] = [];
  let currentSpreadType = '';
  let currentExecTime = '';

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (!line.startsWith(',')) break;

    const fields = parseCSVLine(line);

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

// ── Identify closed spreads ─────────────────────────────────

function identifyClosedSpreads(trades: ParsedTrade[]): ClosedSpread[] {
  const opens = trades.filter((t) => t.posEffect === 'TO OPEN');
  // Sort closes by exec time ascending so FIFO matching picks the earliest
  // unmatched close for each open spread. Without this, two identical opens
  // at different times could match the wrong close (the first in array order
  // rather than the first in time order).
  const closes = trades
    .filter((t) => t.posEffect === 'TO CLOSE')
    .sort((a, b) => a.execTime.localeCompare(b.execTime));

  if (closes.length === 0) return [];

  const closedSpreads: ClosedSpread[] = [];

  // Group open trades into spreads (pair short+long of same type near same exec time)
  const openSpreads: Array<{
    shortLeg: ParsedTrade;
    longLeg: ParsedTrade;
    netCredit: number;
  }> = [];

  const sortedOpens = [...opens].sort((a, b) =>
    a.execTime.localeCompare(b.execTime),
  );
  const usedOpenIndices = new Set<number>();

  for (let i = 0; i < sortedOpens.length; i++) {
    if (usedOpenIndices.has(i)) continue;
    const a = sortedOpens[i]!;
    if (a.quantity >= 0) continue;

    for (let j = 0; j < sortedOpens.length; j++) {
      if (i === j || usedOpenIndices.has(j)) continue;
      const b = sortedOpens[j]!;
      if (
        b.quantity <= 0 ||
        b.putCall !== a.putCall ||
        b.execTime !== a.execTime
      )
        continue;

      const width = Math.abs(b.strike - a.strike);
      if (width > 0 && width <= MAX_RECOGNIZED_SPREAD_WIDTH) {
        usedOpenIndices.add(i);
        usedOpenIndices.add(j);
        openSpreads.push({
          shortLeg: a,
          longLeg: b,
          netCredit: Math.abs(a.price) - Math.abs(b.price),
        });
        break;
      }
    }
  }

  // Match each open spread with its close
  const usedCloseIndices = new Set<number>();

  for (const spread of openSpreads) {
    const closeShortIdx = closes.findIndex(
      (c, idx) =>
        !usedCloseIndices.has(idx) &&
        c.strike === spread.shortLeg.strike &&
        c.putCall === spread.shortLeg.putCall,
    );
    if (closeShortIdx < 0) continue;

    const closeLongIdx = closes.findIndex(
      (c, idx) =>
        !usedCloseIndices.has(idx) &&
        c.strike === spread.longLeg.strike &&
        c.putCall === spread.longLeg.putCall,
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

    closedSpreads.push({
      type:
        spread.shortLeg.putCall === 'CALL'
          ? 'CALL CREDIT SPREAD'
          : 'PUT CREDIT SPREAD',
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
  // Anchor the SPX search to AFTER the "Profits and Losses" section
  // header. Without this anchor, the parser would find the first `SPX,`
  // line in the file — which on any real TOS export with open SPX
  // option positions is an Options-section row (e.g. "SPX,<opt-code>,
  // <exp>,5700,CALL,-1,..."). Parsing fields[4]=strike and fields[5]=
  // type as dollar values would silently return the strike (5700) as
  // dayPnl, which then flows into the Claude analyze context as a
  // false daily P&L. See csv-parser/parse.test.ts for the regression fixture.
  const sectionStart = lines.findIndex((line) =>
    line.startsWith(TOS_LABELS.PNL_SECTION),
  );
  if (sectionStart === -1) return { dayPnl: null, ytdPnl: null };

  for (let i = sectionStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Blank line or a new section header terminates the P&L block
    if (line.trim() === '') continue;
    if (line.startsWith(TOS_LABELS.SPX_PNL_PREFIX)) {
      const fields = parseCSVLine(line);
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
    if (line.startsWith(TOS_LABELS.NET_LIQ_PREFIX)) {
      const fields = parseCSVLine(line);
      const val = fields[1] ? parseDollarValue(fields[1]) : null;
      return { netLiquidatingValue: val && !Number.isNaN(val) ? val : null };
    }
  }
  return { netLiquidatingValue: null };
}

function parseStartingBalance(lines: string[]): number | null {
  for (const line of lines) {
    if (line.includes(TOS_LABELS.STARTING_BALANCE)) {
      const fields = parseCSVLine(line);
      const val = fields.at(-1);
      if (val) {
        const parsed = parseDollarValue(val);
        return Number.isNaN(parsed) ? null : parsed;
      }
    }
  }
  return null;
}

// ── Main parser ─────────────────────────────────────────────

export function parseFullCSV(csv: string): ParsedCSV {
  const lines = csv.split(/\r?\n/);

  // 1. Options section (open positions — authoritative)
  const openLegs = parseOptionsSection(lines);
  const hasOptionsSection = openLegs.length > 0;

  // 2. Trade History (all trades today)
  const allTrades = parseTradeHistory(lines);

  // 3. Closed spreads from Trade History
  const closedSpreads = identifyClosedSpreads(allTrades);

  // 4. Fallback: if no Options section, derive open positions from Trade History
  if (!hasOptionsSection && allTrades.length > 0) {
    const openTrades = allTrades.filter((t) => t.posEffect === 'TO OPEN');
    const closeTrades = allTrades.filter((t) => t.posEffect === 'TO CLOSE');

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
        if (closedQty > 0) {
          closeUsage.set(key, Math.max(0, closedQty - openQty));
        }
      } else {
        closeUsage.set(key, closedQty - openQty);
      }
    }
  }

  // 5–7. Account data
  const { dayPnl, ytdPnl } = parsePnLSection(lines);
  const { netLiquidatingValue } = parseAccountSummary(lines);
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
