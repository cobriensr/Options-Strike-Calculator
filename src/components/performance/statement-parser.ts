/**
 * Client-side parser for single-day thinkorswim paperMoney
 * account statement CSV exports.
 *
 * Main export: parseStatement(csv, spotPrice) → DailyStatement
 *
 * This parser is completely independent from api/_lib/csv-parser.ts.
 * It runs entirely in the browser — no server dependencies.
 */

import type {
  AccountSummary,
  CashEntry,
  ClosedSpread,
  ClosedSpreadOutcome,
  DailyStatement,
  DataQualityWarning,
  ExecutedTrade,
  ExecutionQuality,
  HedgePosition,
  IronCondor,
  NakedPosition,
  OpenLeg,
  OrderEntry,
  OrderLeg,
  PnLEntry,
  PnLSummary,
  PortfolioRisk,
  RejectionReason,
  SlippageEntry,
  Spread,
  SpreadType,
  TradeLeg,
  TrdDescription,
  WarningCode,
  WarningSeverity,
} from './types';

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

/** Max strike distance (points) to consider two legs a spread */
const MAX_WING_WIDTH = 50;

/** SPX multiplier */
const MULTIPLIER = 100;

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
  if (!value || !value.trim()) return 0;
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
  if (!value || !value.trim()) return 0;
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
function parseShortDate(dateStr: string): string {
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
    direction: direction as 'SOLD' | 'BOT',
    quantity: Math.abs(Number.parseInt(qtyToken, 10)),
    spreadType,
    symbol,
    multiplier: Number.parseInt(multiplierStr, 10),
    expiryLabel,
    expiration: parseTosDate(expDate),
    strikes,
    optionType: optionType as 'CALL' | 'PUT',
    fillPrice: Number.parseFloat(priceStr),
  };
}

// ── Section Detection ──────────────────────────────────────

interface SectionBounds {
  readonly headerIndex: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

/**
 * Split the CSV into its six sections by detecting section headers.
 * Returns a map of section name → line index ranges.
 */
function findSections(lines: string[]): Map<string, SectionBounds> {
  const sectionNames = [
    'Cash Balance',
    'Account Order History',
    'Account Trade History',
    'Options',
    'Profits and Losses',
    'Account Summary',
  ];

  const sections = new Map<string, SectionBounds>();
  const sectionIndices: Array<{ name: string; idx: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (sectionNames.includes(trimmed)) {
      sectionIndices.push({ name: trimmed, idx: i });
    }
  }

  for (let s = 0; s < sectionIndices.length; s++) {
    const { name, idx } = sectionIndices[s]!;
    const nextIdx =
      s + 1 < sectionIndices.length ? sectionIndices[s + 1]!.idx : lines.length;

    // Data starts after the section title line (idx + 1)
    // so parsers can find the column header row themselves
    sections.set(name, {
      headerIndex: idx,
      dataStart: idx + 1,
      dataEnd: nextIdx,
    });
  }

  return sections;
}

// ── Section Parsers ────────────────────────────────────────

function parseCashBalance(lines: string[], bounds: SectionBounds): CashEntry[] {
  const entries: CashEntry[] = [];

  // Find the column header row
  let headerIdx = -1;
  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    if (lines[i]!.includes('DATE') && lines[i]!.includes('BALANCE')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return entries;

  for (let i = headerIdx + 1; i < bounds.dataEnd; i++) {
    const line = lines[i]!.trim();
    if (!line) break;

    const fields = parseCSVLine(line);
    if (fields.length < 9) continue;

    const typeStr = (fields[2] ?? '').trim();
    if (!['BAL', 'TRD', 'EXP', 'LIQ'].includes(typeStr)) continue;

    // Clean ref number — strip ="..." wrapper
    let refNumber = fields[3] ?? '';
    const refMatch = /^="?(\d+)"?$/.exec(refNumber);
    if (refMatch) refNumber = refMatch[1]!;

    entries.push({
      date: parseShortDate(fields[0]!),
      time: fields[1]!,
      type: typeStr as CashEntry['type'],
      refNumber: refNumber || null,
      description: fields[4]!,
      miscFees: parseCurrency(fields[5]!),
      commissions: parseCurrency(fields[6]!),
      amount: parseCurrency(fields[7]!),
      balance: parseCurrency(fields[8]!),
    });
  }

  return entries;
}

function parseOrderHistory(
  lines: string[],
  bounds: SectionBounds,
): OrderEntry[] {
  const orders: OrderEntry[] = [];

  // Find header row
  let headerIdx = -1;
  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    if (lines[i]!.includes('Time Placed') && lines[i]!.includes('Status')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return orders;

  let currentOrder: {
    notes: string;
    timePlaced: string;
    spread: string;
    legs: OrderLeg[];
    price: number;
    orderType: string;
    tif: string;
    status: string;
    statusDetail: string;
    isReplacement: boolean;
  } | null = null;

  for (let i = headerIdx + 1; i < bounds.dataEnd; i++) {
    const line = lines[i]!.trim();
    if (!line) break;

    const fields = parseCSVLine(line);
    if (fields.length < 14) continue;

    const timePlaced = (fields[2] ?? '').trim();
    const spread = (fields[3] ?? '').trim();
    const side = (fields[4] ?? '').trim().toUpperCase();
    const qtyStr = (fields[5] ?? '').trim();
    const posEffect = (fields[6] ?? '').trim().toUpperCase();
    const symbol = (fields[7] ?? '').trim();
    const exp = (fields[8] ?? '').trim();
    const strikeStr = (fields[9] ?? '').trim();
    const type = (fields[10] ?? '').trim().toUpperCase();
    const priceStr = (fields[11] ?? '').trim();
    const orderType = (fields[12] ?? '').trim();
    const tif = (fields[13] ?? '').trim();
    const status = fields.length > 14 ? (fields[14] ?? '').trim() : '';

    // Primary row has Time Placed populated
    if (timePlaced) {
      // Save previous order if exists
      if (currentOrder) {
        orders.push({
          ...currentOrder,
          legs: [...currentOrder.legs],
        });
      }

      const notes = (fields[0] ?? '').trim();
      const isReplacement = notes.includes('RE#');

      // Parse status detail (e.g. rejection reason)
      let statusDetail = '';
      const statusBase = status;
      const rejPrefix = 'REJECTED:';
      const rejMatch = statusBase.toUpperCase().startsWith(rejPrefix)
        ? statusBase.slice(rejPrefix.length).trim()
        : null;
      if (rejMatch) {
        statusDetail = rejMatch;
      }

      currentOrder = {
        notes,
        timePlaced,
        spread,
        legs: [],
        price: Number.parseFloat(priceStr) || 0,
        orderType,
        tif,
        status: rejMatch ? 'REJECTED' : statusBase,
        statusDetail,
        isReplacement,
      };
    }

    // Add leg (both primary and continuation rows)
    if (currentOrder && side && symbol && strikeStr && type) {
      const qty = Number.parseInt(qtyStr.replace('+', ''), 10);
      const strike = Number.parseFloat(strikeStr);
      if (!Number.isNaN(qty) && !Number.isNaN(strike)) {
        const parsedPosEffect =
          posEffect === 'TO OPEN' || posEffect === 'TO CLOSE'
            ? posEffect
            : 'TO OPEN';
        currentOrder.legs.push({
          side: side === 'BUY' ? 'BUY' : 'SELL',
          qty: Math.abs(qty),
          posEffect: parsedPosEffect as 'TO OPEN' | 'TO CLOSE',
          symbol,
          exp: exp ? parseTosDate(exp) : '',
          strike,
          type: type === 'PUT' ? 'PUT' : 'CALL',
        });
      }
    }
  }

  // Push last order
  if (currentOrder) {
    orders.push({
      ...currentOrder,
      legs: [...currentOrder.legs],
    });
  }

  return orders;
}

function parseTradeHistory(
  lines: string[],
  bounds: SectionBounds,
): ExecutedTrade[] {
  const trades: ExecutedTrade[] = [];

  // Find header row
  let headerIdx = -1;
  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    if (lines[i]!.includes('Exec Time') && lines[i]!.includes('Strike')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return trades;

  let currentTrade: {
    execTime: string;
    spread: string;
    legs: TradeLeg[];
    netPrice: number;
    orderType: string;
  } | null = null;

  for (let i = headerIdx + 1; i < bounds.dataEnd; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Trade history lines start with comma
    if (!line.startsWith(',')) break;

    const fields = parseCSVLine(line);

    const execTimeRaw = (fields[1] ?? '').trim();
    const spread = (fields[2] ?? '').trim();
    const side = (fields[3] ?? '').trim().toUpperCase();
    const qtyStr = (fields[4] ?? '').trim();
    const posEffect = (fields[5] ?? '').trim().toUpperCase();
    const symbol = (fields[6] ?? '').trim();
    const exp = (fields[7] ?? '').trim();
    const strikeStr = (fields[8] ?? '').trim();
    const type = (fields[9] ?? '').trim().toUpperCase();
    const priceStr = (fields[10] ?? '').trim();
    const netPriceStr = (fields[11] ?? '').trim();
    const orderType = (fields[12] ?? '').trim();

    // Primary row has Exec Time populated
    if (execTimeRaw) {
      // Save previous trade
      if (currentTrade) {
        trades.push({
          ...currentTrade,
          legs: [...currentTrade.legs],
        });
      }

      const netPrice = Number.parseFloat(netPriceStr) || 0;

      currentTrade = {
        execTime: execTimeRaw,
        spread,
        legs: [],
        netPrice,
        orderType,
      };
    }

    // Add leg (both primary and continuation rows)
    if (currentTrade && side && symbol && strikeStr && type) {
      const qty = Number.parseInt(qtyStr.replace('+', ''), 10);
      const strike = Number.parseFloat(strikeStr);
      const price = Number.parseFloat(priceStr) || 0;

      if (!Number.isNaN(qty) && !Number.isNaN(strike)) {
        const parsedPosEffect =
          posEffect === 'TO OPEN' || posEffect === 'TO CLOSE'
            ? posEffect
            : 'TO OPEN';

        // Continuation rows have CREDIT/DEBIT in netPriceStr
        let creditDebit: 'CREDIT' | 'DEBIT' | null = null;
        if (netPriceStr.toUpperCase() === 'CREDIT') creditDebit = 'CREDIT';
        else if (netPriceStr.toUpperCase() === 'DEBIT') creditDebit = 'DEBIT';

        currentTrade.legs.push({
          side: side === 'BUY' ? 'BUY' : 'SELL',
          qty: Math.abs(qty),
          posEffect: parsedPosEffect as 'TO OPEN' | 'TO CLOSE',
          symbol,
          exp: exp ? parseTosDate(exp) : '',
          strike,
          type: type === 'PUT' ? 'PUT' : 'CALL',
          price,
          creditDebit,
        });
      }
    }
  }

  // Push last trade
  if (currentTrade) {
    trades.push({
      ...currentTrade,
      legs: [...currentTrade.legs],
    });
  }

  return trades;
}

function parseOptions(
  lines: string[],
  bounds: SectionBounds,
): { legs: OpenLeg[]; hasMark: boolean } {
  const legs: OpenLeg[] = [];
  let hasMark = false;

  // Find header row
  let headerIdx = -1;
  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    if (
      lines[i]!.includes('Symbol') &&
      lines[i]!.includes('Option Code') &&
      lines[i]!.includes('Strike')
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { legs, hasMark };

  const headerFields = parseCSVLine(lines[headerIdx]!);
  const markIdx = headerFields.findIndex((f) => f.toLowerCase() === 'mark');
  const markValueIdx = headerFields.findIndex(
    (f) => f.toLowerCase() === 'mark value',
  );
  hasMark = markIdx >= 0 || markValueIdx >= 0;

  for (let i = headerIdx + 1; i < bounds.dataEnd; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith(',OVERALL')) break;

    const fields = parseCSVLine(line);
    if (fields.length < 7) continue;

    const symbol = (fields[0] ?? '').trim();
    if (!symbol) continue;

    const optionCode = (fields[1] ?? '').trim();
    const exp = (fields[2] ?? '').trim();
    const strikeStr = (fields[3] ?? '').trim();
    const type = (fields[4] ?? '').trim().toUpperCase();
    const qtyStr = (fields[5] ?? '').trim();
    const tradePriceStr = (fields[6] ?? '').trim();

    const strike = Number.parseFloat(strikeStr);
    const qty = Number.parseInt(qtyStr.replace('+', ''), 10);
    const tradePrice = Number.parseFloat(tradePriceStr);

    if (Number.isNaN(strike) || Number.isNaN(qty)) continue;
    if (type !== 'CALL' && type !== 'PUT') continue;

    // Preserve sign from the original quantity string
    const signedQty = qtyStr.startsWith('-') ? -Math.abs(qty) : Math.abs(qty);

    const mark =
      markIdx >= 0 && fields[markIdx]
        ? Number.parseFloat(fields[markIdx]!)
        : null;
    const markValue =
      markValueIdx >= 0 && fields[markValueIdx]
        ? parseCurrency(fields[markValueIdx]!)
        : null;

    legs.push({
      symbol,
      optionCode,
      exp: parseTosDate(exp),
      strike,
      type: type as 'CALL' | 'PUT',
      qty: signedQty,
      tradePrice: Number.isNaN(tradePrice) ? 0 : tradePrice,
      mark: mark !== null && !Number.isNaN(mark) ? mark : null,
      markValue: markValue !== null ? markValue : null,
    });
  }

  return { legs, hasMark };
}

function parsePnL(lines: string[], bounds: SectionBounds): PnLSummary {
  const entries: PnLEntry[] = [];
  let totals: PnLEntry | null = null;

  // Find header row
  let headerIdx = -1;
  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    if (
      lines[i]!.includes('Symbol') &&
      lines[i]!.includes('P/L Open') &&
      lines[i]!.includes('P/L Day')
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { entries, totals };

  for (let i = headerIdx + 1; i < bounds.dataEnd; i++) {
    const line = lines[i]!.trim();
    if (!line) break;

    const fields = parseCSVLine(line);
    if (fields.length < 9) continue;

    const symbol = (fields[0] ?? '').trim();
    const description = (fields[1] ?? '').trim();

    const entry: PnLEntry = {
      symbol,
      description,
      plOpen: parseCurrency(fields[2]!),
      plPct: parsePercentage(fields[3]!),
      plDay: parseCurrency(fields[4]!),
      plYtd: parseCurrency(fields[5]!),
      plDiff: parseCurrency(fields[6]!),
      marginReq: parseCurrency(fields[7]!),
      markValue: parseCurrency(fields[8]!),
    };

    if (description === 'OVERALL TOTALS') {
      totals = entry;
    } else {
      entries.push(entry);
    }
  }

  return { entries, totals };
}

function parseAccountSummarySection(
  lines: string[],
  bounds: SectionBounds,
): AccountSummary {
  const summary: Record<string, number> = {};

  for (let i = bounds.dataStart; i < bounds.dataEnd; i++) {
    const line = lines[i]!.trim();
    if (!line) break;

    const fields = parseCSVLine(line);
    if (fields.length < 2) continue;

    const key = (fields[0] ?? '').trim();
    const value = parseCurrency(fields[1]!);
    summary[key] = value;
  }

  return {
    netLiquidatingValue: summary['Net Liquidating Value'] ?? 0,
    stockBuyingPower: summary['Stock Buying Power'] ?? 0,
    optionBuyingPower: summary['Option Buying Power'] ?? 0,
    equityCommissionsYtd: summary['Equity Commissions & Fees YTD'] ?? 0,
  };
}

// ── Position Grouping ──────────────────────────────────────

interface GroupResult {
  readonly spreads: Spread[];
  readonly ironCondors: IronCondor[];
  readonly hedges: HedgePosition[];
  readonly naked: NakedPosition[];
}

/**
 * Build a spread from a short leg and long leg.
 * Determines PCS vs CCS, computes risk metrics.
 */
function buildSpread(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
  spotPrice: number,
  cashEntries: CashEntry[],
): Spread {
  const contracts = Math.abs(shortLeg.qty);
  const wingWidth = Math.abs(shortLeg.strike - longLeg.strike);

  // Credit = |shortTradePrice| - |longTradePrice|
  const creditPerContract =
    Math.abs(shortLeg.tradePrice) - Math.abs(longLeg.tradePrice);
  const creditReceived = creditPerContract * MULTIPLIER * contracts;
  const maxProfit = creditReceived;
  const maxLoss = wingWidth * MULTIPLIER * contracts - creditReceived;
  const riskRewardRatio = maxProfit > 0 ? maxLoss / maxProfit : Infinity;

  const isPCS = shortLeg.type === 'PUT';
  const breakeven = isPCS
    ? shortLeg.strike - creditPerContract
    : shortLeg.strike + creditPerContract;

  const spreadType: SpreadType = isPCS
    ? 'PUT_CREDIT_SPREAD'
    : 'CALL_CREDIT_SPREAD';

  // Cross-reference with trade history for entry time/price
  const { entryTime, entryNetPrice } = matchTradeEntry(
    shortLeg,
    longLeg,
    trades,
  );

  // Current value from marks
  const hasMarks = shortLeg.mark !== null || longLeg.mark !== null;
  const currentValue = hasMarks
    ? round2(
        (shortLeg.mark ?? 0) * shortLeg.qty * MULTIPLIER +
          (longLeg.mark ?? 0) * longLeg.qty * MULTIPLIER,
      )
    : null;

  // Open P&L
  const openPnl =
    currentValue !== null
      ? round2(creditReceived - Math.abs(currentValue))
      : null;

  // Pct of max profit
  const pctOfMaxProfit =
    openPnl !== null && maxProfit > 0
      ? round2((openPnl / maxProfit) * 100)
      : null;

  // Distance to short strike
  const distanceToShortStrike = isPCS
    ? round2(spotPrice - shortLeg.strike)
    : round2(shortLeg.strike - spotPrice);
  const distanceToShortStrikePct =
    spotPrice > 0 ? round2((distanceToShortStrike / spotPrice) * 100) : null;

  // Entry commissions from cash entries
  const entryCommissions = computeEntryCommissions(
    shortLeg,
    longLeg,
    trades,
    cashEntries,
  );

  return {
    spreadType,
    shortLeg,
    longLeg,
    contracts,
    wingWidth,
    creditReceived: round2(creditReceived),
    maxProfit: round2(maxProfit),
    maxLoss: round2(Math.max(0, maxLoss)),
    riskRewardRatio: round2(riskRewardRatio),
    breakeven: round2(breakeven),
    entryTime,
    entryNetPrice,
    currentValue,
    openPnl,
    pctOfMaxProfit,
    distanceToShortStrike,
    distanceToShortStrikePct,
    nearestShortStrike: shortLeg.strike,
    entryCommissions,
  };
}

/**
 * Compute entry commissions for a spread by cross-referencing
 * cash entries by matching trade ref numbers, or estimate
 * from trade data.
 */
function computeEntryCommissions(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
  cashEntries: CashEntry[],
): number {
  // Try to find the matching trade to get a ref number
  for (const trade of trades) {
    const openLegs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    const hasShort = openLegs.some(
      (l) =>
        l.side === 'SELL' &&
        l.strike === shortLeg.strike &&
        l.type === shortLeg.type,
    );
    const hasLong = openLegs.some(
      (l) =>
        l.side === 'BUY' &&
        l.strike === longLeg.strike &&
        l.type === longLeg.type,
    );

    if (hasShort && hasLong) {
      // Find commission entries close in time to this trade
      for (const cash of cashEntries) {
        if (cash.type !== 'TRD') continue;
        if (cash.commissions === 0) continue;
        // Match by description containing strike info
        const desc = cash.description;
        const shortStr = shortLeg.strike.toString();
        const longStr = longLeg.strike.toString();
        if (desc.includes(shortStr) || desc.includes(longStr)) {
          return Math.abs(cash.commissions);
        }
      }
      break;
    }
  }

  return 0;
}

/**
 * Try to find the trade entry matching a spread's legs.
 */
function matchTradeEntry(
  shortLeg: OpenLeg,
  longLeg: OpenLeg,
  trades: ExecutedTrade[],
): {
  entryTime: string | null;
  entryNetPrice: number | null;
} {
  for (const trade of trades) {
    const legs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    if (legs.length < 2) continue;

    const hasShort = legs.some(
      (l) =>
        l.side === 'SELL' &&
        l.strike === shortLeg.strike &&
        l.type === shortLeg.type,
    );
    const hasLong = legs.some(
      (l) =>
        l.side === 'BUY' &&
        l.strike === longLeg.strike &&
        l.type === longLeg.type,
    );

    if (hasShort && hasLong) {
      return {
        entryTime: trade.execTime,
        entryNetPrice: trade.netPrice,
      };
    }
  }
  return { entryTime: null, entryNetPrice: null };
}

/**
 * Group open legs into spreads, iron condors, hedges, and
 * naked positions.
 *
 * Step 1: Detect iron condors (PCS + CCS pair, same qty)
 * Step 2: Match remaining legs into vertical spreads
 * Step 3: Classify leftover longs as hedges, shorts as naked
 */
export function groupIntoSpreads(
  legs: OpenLeg[],
  trades: ExecutedTrade[],
  spotPrice: number,
  cashEntries: CashEntry[],
): GroupResult {
  // Separate by expiration + symbol for grouping
  const byExpSymbol = new Map<string, OpenLeg[]>();
  for (const leg of legs) {
    const key = `${leg.symbol}:${leg.exp}`;
    const arr = byExpSymbol.get(key) ?? [];
    arr.push(leg);
    byExpSymbol.set(key, arr);
  }

  const allSpreads: Spread[] = [];
  const allICs: IronCondor[] = [];
  const allHedges: HedgePosition[] = [];
  const allNaked: NakedPosition[] = [];

  for (const groupLegs of byExpSymbol.values()) {
    const remaining = [...groupLegs];
    const usedIndices = new Set<number>();

    // ─ Step 1: Find vertical pairs for IC detection ──────
    const putSpreads = findVerticalPairs(remaining, 'PUT', usedIndices);
    const callSpreads = findVerticalPairs(remaining, 'CALL', usedIndices);

    // Try to pair PCS + CCS into ICs
    const usedPCS = new Set<number>();
    const usedCCS = new Set<number>();

    for (let p = 0; p < putSpreads.length; p++) {
      if (usedPCS.has(p)) continue;
      const pcs = putSpreads[p]!;

      for (let c = 0; c < callSpreads.length; c++) {
        if (usedCCS.has(c)) continue;
        const ccs = callSpreads[c]!;

        // Match: same absolute qty
        if (Math.abs(pcs.shortLeg.qty) === Math.abs(ccs.shortLeg.qty)) {
          usedPCS.add(p);
          usedCCS.add(c);

          const putSpread = buildSpread(
            pcs.shortLeg,
            pcs.longLeg,
            trades,
            spotPrice,
            cashEntries,
          );
          const callSpread = buildSpread(
            ccs.shortLeg,
            ccs.longLeg,
            trades,
            spotPrice,
            cashEntries,
          );

          const contracts = Math.abs(pcs.shortLeg.qty);
          const totalCreditPerContract =
            Math.abs(pcs.shortLeg.tradePrice) -
            Math.abs(pcs.longLeg.tradePrice) +
            Math.abs(ccs.shortLeg.tradePrice) -
            Math.abs(ccs.longLeg.tradePrice);
          const totalCredit = totalCreditPerContract * MULTIPLIER * contracts;

          const putWingWidth = Math.abs(
            pcs.shortLeg.strike - pcs.longLeg.strike,
          );
          const callWingWidth = Math.abs(
            ccs.shortLeg.strike - ccs.longLeg.strike,
          );
          const widerWing = Math.max(putWingWidth, callWingWidth);
          const maxLoss = widerWing * MULTIPLIER * contracts - totalCredit;

          const breakevenLow = pcs.shortLeg.strike - totalCreditPerContract;
          const breakevenHigh = ccs.shortLeg.strike + totalCreditPerContract;

          // Find IC entry time from trade history
          let icEntryTime: string | null = null;
          if (putSpread.entryTime) icEntryTime = putSpread.entryTime;
          else if (callSpread.entryTime) icEntryTime = callSpread.entryTime;

          allICs.push({
            spreadType: 'IRON_CONDOR',
            putSpread,
            callSpread,
            contracts,
            totalCredit: round2(totalCredit),
            maxProfit: round2(totalCredit),
            maxLoss: round2(Math.max(0, maxLoss)),
            riskRewardRatio:
              totalCredit > 0
                ? round2(Math.max(0, maxLoss) / totalCredit)
                : Infinity,
            breakevenLow: round2(breakevenLow),
            breakevenHigh: round2(breakevenHigh),
            putWingWidth,
            callWingWidth,
            entryTime: icEntryTime,
          });

          break;
        }
      }
    }

    // Remaining unpaired verticals
    for (let p = 0; p < putSpreads.length; p++) {
      if (usedPCS.has(p)) continue;
      const pair = putSpreads[p]!;
      allSpreads.push(
        buildSpread(
          pair.shortLeg,
          pair.longLeg,
          trades,
          spotPrice,
          cashEntries,
        ),
      );
    }
    for (let c = 0; c < callSpreads.length; c++) {
      if (usedCCS.has(c)) continue;
      const pair = callSpreads[c]!;
      allSpreads.push(
        buildSpread(
          pair.shortLeg,
          pair.longLeg,
          trades,
          spotPrice,
          cashEntries,
        ),
      );
    }

    // ─ Step 3: Hedges & Naked ────────────────────────────
    for (let i = 0; i < remaining.length; i++) {
      if (usedIndices.has(i)) continue;
      const leg = remaining[i]!;

      if (leg.qty > 0) {
        // Long position = hedge
        const entryCost =
          Math.abs(leg.tradePrice) * MULTIPLIER * Math.abs(leg.qty);
        const hedgeCurrentValue = leg.markValue !== null ? leg.markValue : null;
        const hedgeOpenPnl =
          hedgeCurrentValue !== null
            ? round2(hedgeCurrentValue - entryCost)
            : null;
        allHedges.push({
          leg,
          direction: 'LONG',
          protectionSide: leg.type,
          strikeProtected: leg.strike,
          contracts: Math.abs(leg.qty),
          entryCost,
          currentValue: hedgeCurrentValue,
          openPnl: hedgeOpenPnl,
        });
      } else {
        // Short without matching long = naked
        allNaked.push({
          leg,
          contracts: Math.abs(leg.qty),
          type: leg.type,
        });
      }
    }
  }

  return {
    spreads: allSpreads,
    ironCondors: allICs,
    hedges: allHedges,
    naked: allNaked,
  };
}

/**
 * Find vertical spread pairs (short + long) for a given
 * option type. Mutates usedIndices to mark consumed legs.
 * Returns pairs sorted by tightest wing width first.
 */
function findVerticalPairs(
  legs: OpenLeg[],
  optionType: 'CALL' | 'PUT',
  usedIndices: Set<number>,
): Array<{ shortLeg: OpenLeg; longLeg: OpenLeg }> {
  // Find all shorts and longs of this type
  const shorts: Array<{ leg: OpenLeg; idx: number }> = [];
  const longs: Array<{ leg: OpenLeg; idx: number }> = [];

  for (let i = 0; i < legs.length; i++) {
    if (usedIndices.has(i)) continue;
    const leg = legs[i]!;
    if (leg.type !== optionType) continue;

    if (leg.qty < 0) shorts.push({ leg, idx: i });
    else if (leg.qty > 0) longs.push({ leg, idx: i });
  }

  // Build all valid pairings, sorted by wing width ascending
  const candidates: Array<{
    si: number;
    li: number;
    width: number;
  }> = [];

  for (let s = 0; s < shorts.length; s++) {
    for (let l = 0; l < longs.length; l++) {
      const shortLeg = shorts[s]!.leg;
      const longLeg = longs[l]!.leg;

      // Matching absolute qty
      if (Math.abs(shortLeg.qty) !== Math.abs(longLeg.qty)) continue;

      const width = Math.abs(shortLeg.strike - longLeg.strike);
      if (width <= 0 || width > MAX_WING_WIDTH) continue;

      // Validate PCS vs CCS strike ordering
      if (optionType === 'PUT') {
        // PCS: short put has HIGHER strike
        if (shortLeg.strike <= longLeg.strike) continue;
      } else {
        // CCS: short call has LOWER strike
        if (shortLeg.strike >= longLeg.strike) continue;
      }

      candidates.push({ si: s, li: l, width });
    }
  }

  // Tightest width first for greedy matching
  candidates.sort((a, b) => a.width - b.width);

  const usedShorts = new Set<number>();
  const usedLongs = new Set<number>();
  const pairs: Array<{
    shortLeg: OpenLeg;
    longLeg: OpenLeg;
  }> = [];

  for (const c of candidates) {
    if (usedShorts.has(c.si) || usedLongs.has(c.li)) continue;

    usedShorts.add(c.si);
    usedLongs.add(c.li);

    const shortEntry = shorts[c.si]!;
    const longEntry = longs[c.li]!;

    usedIndices.add(shortEntry.idx);
    usedIndices.add(longEntry.idx);

    pairs.push({
      shortLeg: shortEntry.leg,
      longLeg: longEntry.leg,
    });
  }

  return pairs;
}

// ── Closed Spread Matching ─────────────────────────────────

export function matchClosedSpreads(trades: ExecutedTrade[]): ClosedSpread[] {
  const closedSpreads: ClosedSpread[] = [];

  // Find trades that have TO CLOSE legs
  const closeTrades = trades.filter((t) =>
    t.legs.some((l) => l.posEffect === 'TO CLOSE'),
  );
  const openTrades = trades.filter((t) =>
    t.legs.some((l) => l.posEffect === 'TO OPEN'),
  );

  // Index opening trades by their leg signatures
  interface OpenSpread {
    trade: ExecutedTrade;
    shortLeg: TradeLeg;
    longLeg: TradeLeg;
    used: boolean;
  }

  const openSpreads: OpenSpread[] = [];
  for (const trade of openTrades) {
    const openLegs = trade.legs.filter((l) => l.posEffect === 'TO OPEN');
    if (openLegs.length !== 2) continue;

    const sellLeg = openLegs.find((l) => l.side === 'SELL');
    const buyLeg = openLegs.find((l) => l.side === 'BUY');
    if (!sellLeg || !buyLeg) continue;
    if (sellLeg.type !== buyLeg.type) continue;

    openSpreads.push({
      trade,
      shortLeg: sellLeg,
      longLeg: buyLeg,
      used: false,
    });
  }

  for (const closeTrade of closeTrades) {
    const closeLegs = closeTrade.legs.filter((l) => l.posEffect === 'TO CLOSE');
    if (closeLegs.length !== 2) continue;

    // BUY TO CLOSE covers the short
    // SELL TO CLOSE covers the long
    const btcLeg = closeLegs.find((l) => l.side === 'BUY');
    const stcLeg = closeLegs.find((l) => l.side === 'SELL');
    if (!btcLeg || !stcLeg) continue;

    // Find matching open spread
    for (const openSpread of openSpreads) {
      if (openSpread.used) continue;

      if (
        openSpread.shortLeg.strike === btcLeg.strike &&
        openSpread.shortLeg.type === btcLeg.type &&
        openSpread.longLeg.strike === stcLeg.strike &&
        openSpread.longLeg.type === stcLeg.type &&
        openSpread.shortLeg.qty === btcLeg.qty
      ) {
        openSpread.used = true;

        const contracts = openSpread.shortLeg.qty;
        const wingWidth = Math.abs(
          openSpread.shortLeg.strike - openSpread.longLeg.strike,
        );
        const openCredit = Math.abs(openSpread.trade.netPrice);
        const closeDebit = Math.abs(closeTrade.netPrice);
        const realizedPnl = (openCredit - closeDebit) * MULTIPLIER * contracts;

        const isPCS = openSpread.shortLeg.type === 'PUT';

        // maxLoss for returnOnRisk
        const maxLoss =
          wingWidth * MULTIPLIER * contracts -
          openCredit * MULTIPLIER * contracts;
        const returnOnRisk = maxLoss > 0 ? round2(realizedPnl / maxLoss) : 0;

        // creditCapturedPct
        const openCreditDollars = openCredit * MULTIPLIER * contracts;
        const creditCapturedPct =
          openCreditDollars > 0
            ? round2((realizedPnl / openCreditDollars) * 100)
            : 0;

        // holdTimeMinutes
        const holdTimeMinutes = computeHoldTime(
          openSpread.trade.execTime,
          closeTrade.execTime,
        );

        // outcome
        const outcome = classifyOutcome(realizedPnl, openCreditDollars);

        closedSpreads.push({
          spreadType: isPCS ? 'PUT_CREDIT_SPREAD' : 'CALL_CREDIT_SPREAD',
          shortStrike: openSpread.shortLeg.strike,
          longStrike: openSpread.longLeg.strike,
          optionType: openSpread.shortLeg.type,
          contracts,
          wingWidth,
          openCredit: round2(openCredit),
          closeDebit: round2(closeDebit),
          realizedPnl: round2(realizedPnl),
          openTime: openSpread.trade.execTime,
          closeTime: closeTrade.execTime,
          returnOnRisk,
          creditCapturedPct,
          holdTimeMinutes,
          outcome,
        });

        break;
      }
    }
  }

  return closedSpreads;
}

// ── Portfolio Risk ─────────────────────────────────────────

export function computePortfolioRisk(
  spreads: Spread[],
  ironCondors: IronCondor[],
  hedges: HedgePosition[],
  naked: NakedPosition[],
  accountSummary: AccountSummary,
  _pnl: PnLSummary,
  spotPrice: number,
): PortfolioRisk {
  let callSideRisk = 0;
  let putSideRisk = 0;

  // Standalone verticals add to their respective side
  for (const spread of spreads) {
    if (spread.spreadType === 'PUT_CREDIT_SPREAD') {
      putSideRisk += spread.maxLoss;
    } else if (spread.spreadType === 'CALL_CREDIT_SPREAD') {
      callSideRisk += spread.maxLoss;
    }
  }

  // IC max loss = wider wing. At expiry only one side can
  // lose, but we count it against BOTH sides conservatively.
  for (const ic of ironCondors) {
    callSideRisk += ic.maxLoss;
    putSideRisk += ic.maxLoss;
  }

  // Hedge values
  let callHedgeValue = 0;
  let putHedgeValue = 0;
  for (const hedge of hedges) {
    if (hedge.protectionSide === 'CALL') {
      callHedgeValue += hedge.entryCost;
    } else {
      putHedgeValue += hedge.entryCost;
    }
  }

  const netCallRisk = Math.max(0, callSideRisk - callHedgeValue);
  const netPutRisk = Math.max(0, putSideRisk - putHedgeValue);
  const totalMaxLoss = Math.max(netPutRisk, netCallRisk);

  // Total credit
  let totalCredit = 0;
  for (const spread of spreads) {
    totalCredit += spread.creditReceived;
  }
  for (const ic of ironCondors) {
    totalCredit += ic.totalCredit;
  }

  // Total contracts
  let totalContracts = 0;
  for (const spread of spreads) {
    totalContracts += spread.contracts;
  }
  for (const ic of ironCondors) {
    // Each IC has 4 legs but 2 spread sides
    totalContracts += ic.contracts * 2;
  }
  for (const h of hedges) {
    totalContracts += h.contracts;
  }
  for (const n of naked) {
    totalContracts += n.contracts;
  }

  // Nearest short strike distance
  let nearestDistance = Infinity;
  const updateNearest = (s: Spread) => {
    const dist = Math.abs(s.shortLeg.strike - spotPrice);
    if (dist < nearestDistance) nearestDistance = dist;
  };
  spreads.forEach(updateNearest);
  for (const ic of ironCondors) {
    updateNearest(ic.putSpread);
    updateNearest(ic.callSpread);
  }
  if (nearestDistance === Infinity) nearestDistance = 0;

  // Breakeven levels from put/call credit spreads
  let lowestShortPutStrike = Infinity;
  let highestShortCallStrike = -Infinity;
  let totalPutCreditPerContract = 0;
  let totalCallCreditPerContract = 0;
  let putSpreadCount = 0;
  let callSpreadCount = 0;

  for (const spread of spreads) {
    const creditPerContract =
      spread.creditReceived / (spread.contracts * MULTIPLIER);
    if (spread.spreadType === 'PUT_CREDIT_SPREAD') {
      if (spread.shortLeg.strike < lowestShortPutStrike) {
        lowestShortPutStrike = spread.shortLeg.strike;
      }
      totalPutCreditPerContract += creditPerContract;
      putSpreadCount++;
    } else if (spread.spreadType === 'CALL_CREDIT_SPREAD') {
      if (spread.shortLeg.strike > highestShortCallStrike) {
        highestShortCallStrike = spread.shortLeg.strike;
      }
      totalCallCreditPerContract += creditPerContract;
      callSpreadCount++;
    }
  }
  for (const ic of ironCondors) {
    const putCredit = ic.putSpread.creditReceived / (ic.contracts * MULTIPLIER);
    const callCredit =
      ic.callSpread.creditReceived / (ic.contracts * MULTIPLIER);
    if (ic.putSpread.shortLeg.strike < lowestShortPutStrike) {
      lowestShortPutStrike = ic.putSpread.shortLeg.strike;
    }
    if (ic.callSpread.shortLeg.strike > highestShortCallStrike) {
      highestShortCallStrike = ic.callSpread.shortLeg.strike;
    }
    totalPutCreditPerContract += putCredit;
    totalCallCreditPerContract += callCredit;
    putSpreadCount++;
    callSpreadCount++;
  }

  const breakevenLow =
    putSpreadCount > 0
      ? round2(lowestShortPutStrike - totalPutCreditPerContract)
      : null;
  const breakevenHigh =
    callSpreadCount > 0
      ? round2(highestShortCallStrike + totalCallCreditPerContract)
      : null;

  // Buying power fields
  const nlv = accountSummary.netLiquidatingValue;
  const buyingPowerAvailable = accountSummary.optionBuyingPower;
  const buyingPowerUsed = nlv - buyingPowerAvailable;
  const buyingPowerUtilization = nlv > 0 ? round2(buyingPowerUsed / nlv) : 0;
  const canAbsorbMaxLoss = buyingPowerAvailable > totalMaxLoss;

  // Concentration: largest single spread maxLoss / totalMaxLoss
  let largestMaxLoss = 0;
  for (const spread of spreads) {
    if (spread.maxLoss > largestMaxLoss) {
      largestMaxLoss = spread.maxLoss;
    }
  }
  for (const ic of ironCondors) {
    if (ic.maxLoss > largestMaxLoss) {
      largestMaxLoss = ic.maxLoss;
    }
  }
  const concentration =
    totalMaxLoss > 0 ? round2(largestMaxLoss / totalMaxLoss) : 0;

  return {
    callSideRisk: round2(callSideRisk),
    putSideRisk: round2(putSideRisk),
    callHedgeValue: round2(callHedgeValue),
    putHedgeValue: round2(putHedgeValue),
    netCallRisk: round2(netCallRisk),
    netPutRisk: round2(netPutRisk),
    totalMaxLoss: round2(totalMaxLoss),
    totalCredit: round2(totalCredit),
    totalContracts,
    spotPrice,
    nearestShortStrikeDistance: round2(nearestDistance),
    nakedCount: naked.length,
    breakevenLow,
    breakevenHigh,
    buyingPowerUsed: round2(buyingPowerUsed),
    buyingPowerAvailable: round2(buyingPowerAvailable),
    buyingPowerUtilization,
    canAbsorbMaxLoss,
    concentration,
  };
}

// ── Execution Quality ──────────────────────────────────────

export function computeExecutionQuality(
  orders: OrderEntry[],
  trades: ExecutedTrade[],
): ExecutionQuality {
  const fills: SlippageEntry[] = [];

  // Match orders to fills for slippage calculation
  for (const trade of trades) {
    const matchingOrder = findMatchingOrder(trade, orders);

    if (matchingOrder && matchingOrder.price > 0) {
      const slippage = trade.netPrice - matchingOrder.price;
      const primaryLeg = trade.legs[0];

      if (primaryLeg) {
        fills.push({
          orderTime: matchingOrder.timePlaced,
          fillTime: trade.execTime,
          symbol: primaryLeg.symbol,
          strike: primaryLeg.strike,
          type: primaryLeg.type,
          spread: trade.spread,
          limitPrice: matchingOrder.price,
          fillPrice: trade.netPrice,
          slippage: round2(slippage),
          contracts: primaryLeg.qty,
        });
      }
    }
  }

  const totalSlippage = fills.reduce((sum, f) => sum + f.slippage, 0);
  const avgSlippage = fills.length > 0 ? totalSlippage / fills.length : 0;

  // Total slippage in dollars
  const totalSlippageDollars = fills.reduce(
    (sum, f) => sum + f.slippage * MULTIPLIER * f.contracts,
    0,
  );

  // Count order outcomes
  const filledOrders = orders.filter((o) => o.status.includes('FILLED')).length;
  const rejectedOrders = orders.filter((o) => o.status === 'REJECTED').length;
  const canceledOrders = orders.filter((o) =>
    o.status.includes('CANCELED'),
  ).length;
  const totalOrders = orders.length;
  const fillRate = totalOrders > 0 ? filledOrders / totalOrders : 0;

  // Count replacement chains
  const replacementChains = orders.filter((o) => o.isReplacement).length;

  // Rejection & cancellation rates
  const rejectionRate =
    totalOrders > 0 ? round2(rejectedOrders / totalOrders) : 0;
  const cancellationRate =
    totalOrders > 0 ? round2(canceledOrders / totalOrders) : 0;

  // Rejection reasons grouped by statusDetail
  const reasonCounts = new Map<string, number>();
  for (const order of orders) {
    if (order.status === 'REJECTED' && order.statusDetail) {
      const reason = order.statusDetail;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const rejectionReasons: RejectionReason[] = [];
  for (const [reason, count] of reasonCounts) {
    rejectionReasons.push({ reason, count });
  }
  rejectionReasons.sort((a, b) => b.count - a.count);

  // Trade timing
  let firstTradeTime: string | null = null;
  let lastTradeTime: string | null = null;
  if (trades.length > 0) {
    const sorted = [...trades].sort((a, b) => {
      const ta = new Date(a.execTime).getTime();
      const tb = new Date(b.execTime).getTime();
      return ta - tb;
    });
    firstTradeTime = sorted[0]!.execTime;
    lastTradeTime = sorted.at(-1)!.execTime;
  }

  let tradingSessionMinutes: number | null = null;
  let tradesPerHour: number | null = null;
  if (firstTradeTime && lastTradeTime) {
    const firstMs = new Date(firstTradeTime).getTime();
    const lastMs = new Date(lastTradeTime).getTime();
    if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
      const diffMs = lastMs - firstMs;
      tradingSessionMinutes = Math.round(diffMs / 60_000);
      const hours = diffMs / 3_600_000;
      tradesPerHour = hours > 0 ? round2(trades.length / hours) : null;
    }
  }

  return {
    fills,
    averageSlippage: round2(avgSlippage),
    totalSlippageDollars: round2(totalSlippageDollars),
    fillRate: round2(fillRate),
    rejectedOrders,
    canceledOrders,
    replacementChains,
    rejectionRate,
    cancellationRate,
    rejectionReasons,
    firstTradeTime,
    lastTradeTime,
    tradingSessionMinutes,
    tradesPerHour,
  };
}

/**
 * Try to match an executed trade to its originating order.
 * Match by: closest time before fill, same spread type,
 * and matching leg strikes/types.
 */
function findMatchingOrder(
  trade: ExecutedTrade,
  orders: OrderEntry[],
): OrderEntry | null {
  const tradeLeg = trade.legs[0];
  if (!tradeLeg) return null;

  let bestMatch: OrderEntry | null = null;
  let bestTimeDiff = Infinity;

  for (const order of orders) {
    if (!order.status.includes('FILLED')) continue;
    if (order.spread !== trade.spread) continue;

    // Check if any order leg matches the primary trade leg
    const hasMatch = order.legs.some(
      (ol) =>
        ol.strike === tradeLeg.strike &&
        ol.type === tradeLeg.type &&
        ol.side === tradeLeg.side,
    );
    if (!hasMatch) continue;

    // Prefer closest time
    const orderTime = new Date(order.timePlaced).getTime();
    const tradeTime = new Date(trade.execTime).getTime();
    const diff = Math.abs(tradeTime - orderTime);

    if (diff < bestTimeDiff) {
      bestTimeDiff = diff;
      bestMatch = order;
    }
  }

  return bestMatch;
}

// ── Data Quality Warnings ──────────────────────────────────

export function generateWarnings(
  cashEntries: CashEntry[],
  openLegs: OpenLeg[],
  hasMark: boolean,
  pnl: PnLSummary,
  naked: NakedPosition[],
  sections: Map<string, SectionBounds>,
  spreads: Spread[],
  ironCondors: IronCondor[],
): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  // Always emit PAPER_TRADING
  warnings.push(
    makeWarning(
      'PAPER_TRADING',
      'info',
      'This data is from a paperMoney account.' + ' Results are simulated.',
    ),
  );

  // MISSING_MARK
  if (!hasMark && openLegs.length > 0) {
    warnings.push(
      makeWarning(
        'MISSING_MARK',
        'warn',
        'Options section lacks Mark/Mark Value columns.' +
          ' Current market values unavailable.',
      ),
    );
  }

  // UNMATCHED_SHORT
  for (const n of naked) {
    const msg =
      `Naked short ${n.type} at strike ` +
      `${n.leg.strike} (${n.contracts} contracts).` +
      ' No matching long leg found.';
    warnings.push(
      makeWarning(
        'UNMATCHED_SHORT',
        'error',
        msg,
        `Option code: ${n.leg.optionCode}`,
      ),
    );
  }

  // BALANCE_DISCONTINUITY
  for (let i = 1; i < cashEntries.length; i++) {
    const prev = cashEntries[i - 1]!;
    const curr = cashEntries[i]!;
    if (curr.type === 'BAL') continue;

    const expectedBalance =
      prev.balance + curr.amount + curr.miscFees + curr.commissions;
    const diff = Math.abs(expectedBalance - curr.balance);

    if (diff > 0.02) {
      const expected = expectedBalance.toFixed(2);
      const actual = curr.balance.toFixed(2);
      const diffStr = diff.toFixed(2);
      const detail =
        `Expected ${expected}, got ${actual}` + ` (diff: ${diffStr})`;
      warnings.push(
        makeWarning(
          'BALANCE_DISCONTINUITY',
          'warn',
          `Balance mismatch after ${curr.type}` + ` at ${curr.time}.`,
          detail,
        ),
      );
    }
  }

  // MISSING_SECTION
  const expectedSections = [
    'Cash Balance',
    'Account Order History',
    'Account Trade History',
    'Options',
    'Profits and Losses',
    'Account Summary',
  ];
  for (const name of expectedSections) {
    if (!sections.has(name)) {
      warnings.push(
        makeWarning(
          'MISSING_SECTION',
          'warn',
          `Expected section "${name}" not found in CSV.`,
        ),
      );
    }
  }

  // PNL_MISMATCH — compare computed credit to P&L section
  if (pnl.totals) {
    let computedOpenPnl = 0;
    for (const spread of spreads) {
      computedOpenPnl += spread.creditReceived;
    }
    for (const ic of ironCondors) {
      computedOpenPnl += ic.totalCredit;
    }

    // Flag large discrepancies between reported and computed
    if (pnl.totals.markValue !== 0 && computedOpenPnl !== 0) {
      const reported = pnl.totals.plOpen;
      if (openLegs.length > 0 && Math.abs(reported) > computedOpenPnl * 5) {
        const reportedStr = reported.toFixed(2);
        warnings.push(
          makeWarning(
            'PNL_MISMATCH',
            'warn',
            `Reported P/L Open ($${reportedStr})` +
              ' may not match computed positions.',
            'This can happen if positions were' + ' opened on prior days.',
          ),
        );
      }
    }
  }

  return warnings;
}

function makeWarning(
  code: WarningCode,
  severity: WarningSeverity,
  message: string,
  detail?: string,
): DataQualityWarning {
  return detail
    ? { code, severity, message, detail }
    : { code, severity, message };
}

// ── Utilities ──────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute hold time in minutes between two time strings.
 * Returns null if either time cannot be parsed.
 */
function computeHoldTime(openTime: string, closeTime: string): number | null {
  const openMs = new Date(openTime).getTime();
  const closeMs = new Date(closeTime).getTime();
  if (Number.isNaN(openMs) || Number.isNaN(closeMs)) return null;
  const diffMs = closeMs - openMs;
  if (diffMs < 0) return null;
  return Math.round(diffMs / 60_000);
}

/**
 * Classify a closed spread outcome based on realized P&L.
 */
function classifyOutcome(
  realizedPnl: number,
  openCreditDollars: number,
): ClosedSpreadOutcome {
  const scratchThreshold = openCreditDollars * 0.05;
  if (Math.abs(realizedPnl) <= scratchThreshold) return 'SCRATCH';
  if (realizedPnl < 0) return 'LOSS';
  if (realizedPnl >= openCreditDollars * 0.95) return 'FULL_PROFIT';
  return 'PARTIAL_PROFIT';
}

// ── Main Parser ────────────────────────────────────────────

/**
 * Parse a single-day thinkorswim paperMoney account
 * statement CSV.
 *
 * @param csv — Raw CSV text from the export
 * @param spotPrice — Current SPX spot price
 * @returns Fully parsed and analyzed DailyStatement
 */
export function parseStatement(csv: string, spotPrice: number): DailyStatement {
  const lines = csv.split(/\r?\n/);
  const sections = findSections(lines);

  // ── Parse each section ─────────────────────────────────

  const cashEntries = sections.has('Cash Balance')
    ? parseCashBalance(lines, sections.get('Cash Balance')!)
    : [];

  const orders = sections.has('Account Order History')
    ? parseOrderHistory(lines, sections.get('Account Order History')!)
    : [];

  const trades = sections.has('Account Trade History')
    ? parseTradeHistory(lines, sections.get('Account Trade History')!)
    : [];

  const optionsResult = sections.has('Options')
    ? parseOptions(lines, sections.get('Options')!)
    : { legs: [], hasMark: false };
  const openLegs = optionsResult.legs;

  const pnl = sections.has('Profits and Losses')
    ? parsePnL(lines, sections.get('Profits and Losses')!)
    : { entries: [], totals: null };

  const accountSummary = sections.has('Account Summary')
    ? parseAccountSummarySection(lines, sections.get('Account Summary')!)
    : {
        netLiquidatingValue: 0,
        stockBuyingPower: 0,
        optionBuyingPower: 0,
        equityCommissionsYtd: 0,
      };

  // ── Derive date from first cash entry or first trade ───

  let date = '';
  if (cashEntries.length > 0) {
    date = cashEntries[0]!.date;
  } else if (trades.length > 0) {
    // Extract date from exec time "3/27/26 09:29:13"
    const timeParts = trades[0]!.execTime.split(' ');
    if (timeParts[0]) {
      date = parseShortDate(timeParts[0]);
    }
  }

  // ── Group positions ────────────────────────────────────

  const grouped = groupIntoSpreads(openLegs, trades, spotPrice, cashEntries);

  // ── Estimate P&L from aggregate when marks are missing ─

  const allSpreadsLackMarks =
    grouped.spreads.every((s) => s.currentValue === null) &&
    grouped.ironCondors.every(
      (ic) =>
        ic.putSpread.currentValue === null &&
        ic.callSpread.currentValue === null,
    );

  if (allSpreadsLackMarks && pnl.totals && pnl.totals.plOpen !== 0) {
    const aggPnl = pnl.totals.plOpen;
    // Total credit across all open positions
    const totalCredit =
      grouped.spreads.reduce((s, sp) => s + sp.creditReceived, 0) +
      grouped.ironCondors.reduce((s, ic) => s + ic.totalCredit, 0);

    if (totalCredit > 0) {
      // Distribute aggregate P&L proportionally by credit weight
      for (let i = 0; i < grouped.spreads.length; i++) {
        const sp = grouped.spreads[i]!;
        const weight = sp.creditReceived / totalCredit;
        const estPnl = round2(aggPnl * weight);
        const estPct =
          sp.maxProfit > 0
            ? round2((estPnl / sp.maxProfit) * 100)
            : null;
        // Replace the spread with estimated values
        (grouped.spreads as Spread[])[i] = {
          ...sp,
          openPnl: estPnl,
          pctOfMaxProfit: estPct,
        };
      }
      for (let i = 0; i < grouped.ironCondors.length; i++) {
        const ic = grouped.ironCondors[i]!;
        const weight = ic.totalCredit / totalCredit;
        const estPnl = round2(aggPnl * weight);
        const putWeight =
          ic.putSpread.creditReceived / ic.totalCredit;
        const callWeight =
          ic.callSpread.creditReceived / ic.totalCredit;
        const putPnl = round2(estPnl * putWeight);
        const callPnl = round2(estPnl * callWeight);
        (grouped.ironCondors as IronCondor[])[i] = {
          ...ic,
          putSpread: {
            ...ic.putSpread,
            openPnl: putPnl,
            pctOfMaxProfit:
              ic.putSpread.maxProfit > 0
                ? round2((putPnl / ic.putSpread.maxProfit) * 100)
                : null,
          },
          callSpread: {
            ...ic.callSpread,
            openPnl: callPnl,
            pctOfMaxProfit:
              ic.callSpread.maxProfit > 0
                ? round2((callPnl / ic.callSpread.maxProfit) * 100)
                : null,
          },
        };
      }
    }
  }

  // ── Match closed spreads ───────────────────────────────

  const closedSpreads = matchClosedSpreads(trades);

  // ── Compute analytics ──────────────────────────────────

  const portfolioRisk = computePortfolioRisk(
    grouped.spreads,
    grouped.ironCondors,
    grouped.hedges,
    grouped.naked,
    accountSummary,
    pnl,
    spotPrice,
  );

  const executionQuality = computeExecutionQuality(orders, trades);

  const warnings = generateWarnings(
    cashEntries,
    openLegs,
    optionsResult.hasMark,
    pnl,
    grouped.naked,
    sections,
    grouped.spreads,
    grouped.ironCondors,
  );

  return {
    date,
    cashEntries,
    orders,
    trades,
    openLegs,
    pnl,
    accountSummary,
    spreads: grouped.spreads,
    ironCondors: grouped.ironCondors,
    hedges: grouped.hedges,
    nakedPositions: grouped.naked,
    closedSpreads,
    portfolioRisk,
    executionQuality,
    warnings,
  };
}
