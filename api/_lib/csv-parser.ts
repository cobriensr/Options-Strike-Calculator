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
 */

import type { PositionLeg } from './db.js';

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
  const mm = MONTH_MAP[month!.toUpperCase()];
  if (!mm) return raw;
  const yyyy = year!.length === 2 ? `20${year}` : year!;
  return `${yyyy}-${mm}-${day!.padStart(2, '0')}`;
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
    (line) => line.trim() === 'Account Trade History',
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
  const closes = trades.filter((t) => t.posEffect === 'TO CLOSE');

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
      if (width > 0 && width <= 50) {
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
  for (const line of lines) {
    if (line.startsWith('SPX,')) {
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
    if (line.startsWith('Net Liquidating Value,')) {
      const fields = parseCSVLine(line);
      const val = fields[1] ? parseDollarValue(fields[1]) : null;
      return { netLiquidatingValue: val && !Number.isNaN(val) ? val : null };
    }
  }
  return { netLiquidatingValue: null };
}

function parseStartingBalance(lines: string[]): number | null {
  for (const line of lines) {
    if (line.includes('Cash balance at the start of business day')) {
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

// ── Summary builder ─────────────────────────────────────────

/**
 * Build a human-readable summary including open positions,
 * closed trades, and account context.
 */
export function buildFullSummary(parsed: ParsedCSV, spxPrice?: number): string {
  const lines: string[] = [];

  // ── Open positions (using trade-history pairs, not flat legs) ──
  // Build open spread pairs from VERTICAL TO OPEN trades that haven't
  // been closed. This avoids the flat Options section's aggregated
  // quantities which can't distinguish shared long strikes.
  const openSpreads = buildOpenSpreadsFromTrades(parsed.allTrades, spxPrice);

  if (openSpreads.length > 0) {
    lines.push(
      `=== OPEN SPX 0DTE Positions (${openSpreads.length} defined-risk spread${openSpreads.length !== 1 ? 's' : ''}, NO naked legs) ===`,
    );
    if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
    lines.push('');
    for (const s of openSpreads) {
      lines.push(s);
    }
    lines.push('');
  } else if (parsed.openLegs.length > 0) {
    // Fallback to flat legs if trade history is empty
    const calls = parsed.openLegs.filter((l) => l.putCall === 'CALL');
    const puts = parsed.openLegs.filter((l) => l.putCall === 'PUT');
    const spreadLines = pairForDisplay(calls, puts, spxPrice);
    const spreadCount = spreadLines.filter((l) =>
      l.startsWith('  Short'),
    ).length;
    lines.push(
      `=== OPEN SPX 0DTE Positions (${spreadCount} spread${spreadCount !== 1 ? 's' : ''}) ===`,
    );
    if (spxPrice) lines.push(`SPX at fetch time: ${spxPrice}`);
    lines.push('');
    for (const s of spreadLines) {
      lines.push(s);
    }
    lines.push('');
  } else {
    lines.push('=== NO OPEN SPX 0DTE POSITIONS ===', '');
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

  // ── Max risk calculation (correct for IC) ────────────────
  if (parsed.openLegs.length > 0) {
    const calls = parsed.openLegs.filter((l) => l.putCall === 'CALL');
    const puts = parsed.openLegs.filter((l) => l.putCall === 'PUT');
    const callRisk = computeSideMaxRisk(calls);
    const putRisk = computeSideMaxRisk(puts);

    if (callRisk > 0 || putRisk > 0) {
      lines.push('=== Max Risk ===');
      if (callRisk > 0 && putRisk > 0) {
        // Iron condor: only ONE side can be max loss at a time
        lines.push(
          `  Call side max risk: $${callRisk.toLocaleString()} | Put side max risk: $${putRisk.toLocaleString()}`,
          `  Worst-case max risk: $${Math.max(callRisk, putRisk).toLocaleString()} (only one side of an IC can be max loss — calls and puts cannot both be ITM simultaneously)`,
        );
      } else {
        const totalRisk = callRisk + putRisk;
        const side = callRisk > 0 ? 'Call' : 'Put';
        lines.push(`  ${side} side max risk: $${totalRisk.toLocaleString()}`);
      }
      lines.push('');
    }
  }

  // ── Day P&L context (no account balances) ───────────────
  if (parsed.dayPnl != null) {
    lines.push(
      `=== Today's P&L ===`,
      `  Day P&L (SPX): $${parsed.dayPnl.toLocaleString()}`,
    );
  }

  return lines.join('\n');
}

// ── Helper: build open spreads from trade history ────────────
// Uses explicit VERTICAL trade pairs instead of flat leg matching,
// so shared long strikes (e.g., 6525P +40 from two spreads) are
// correctly attributed to their respective spread pairs.

function buildOpenSpreadsFromTrades(
  allTrades: ParsedTrade[],
  spxPrice?: number,
): string[] {
  // Track net opens: each VERTICAL TO OPEN adds a pair,
  // each VERTICAL TO CLOSE removes one.
  interface SpreadPair {
    shortStrike: number;
    longStrike: number;
    type: 'PUT' | 'CALL';
    qty: number;
    credit: number;
    width: number;
    openTime: string;
    closed: boolean;
  }

  const pairs: SpreadPair[] = [];
  const bflyLines: string[] = [];

  // Group trades by time (trades with same execTime are one VERTICAL)
  const tradesByTime = new Map<string, ParsedTrade[]>();
  for (const t of allTrades) {
    const existing = tradesByTime.get(t.execTime) ?? [];
    existing.push(t);
    tradesByTime.set(t.execTime, existing);
  }

  for (const [time, legs] of tradesByTime) {
    if (legs.length < 2) continue;

    const openLegs = legs.filter((l) => l.posEffect === 'TO OPEN');
    const closeLegs = legs.filter((l) => l.posEffect === 'TO CLOSE');

    // 3-leg BUTTERFLY / BWB trades
    if (openLegs.length === 3) {
      const buys = openLegs.filter((l) => l.quantity > 0);
      const sells = openLegs.filter((l) => l.quantity < 0);
      if (
        buys.length === 2 &&
        sells.length === 1 &&
        buys[0]!.putCall === buys[1]!.putCall &&
        buys[0]!.putCall === sells[0]!.putCall
      ) {
        const sell = sells[0]!;
        const middleStrike = sell.strike;
        const wingStrikes = buys
          .map((b) => b.strike)
          .sort((a, b) => a - b);
        const lowerStrike = wingStrikes[0]!;
        const upperStrike = wingStrikes[1]!;
        const contracts = Math.abs(buys[0]!.quantity);
        const lowerWidth = middleStrike - lowerStrike;
        const upperWidth = upperStrike - middleStrike;
        const isBrokenWing = lowerWidth !== upperWidth;
        const label = isBrokenWing ? 'BWB' : 'BFLY';
        const typeChar = sell.putCall === 'CALL' ? 'CALL' : 'PUT';
        const debit = Math.abs(sell.netPrice) * 100 * contracts;
        const narrowerWidth = Math.min(lowerWidth, upperWidth);
        const maxProfit = narrowerWidth * 100 * contracts - debit;

        bflyLines.push(
          `  ${label} ${lowerStrike}/${middleStrike}/${upperStrike} ${typeChar} x${contracts} — ` +
            `debit $${debit.toLocaleString('en-US', { maximumFractionDigits: 0 })}, ` +
            `max profit at ${middleStrike}, ` +
            `wings ${lowerWidth}/${upperWidth}` +
            (maxProfit > 0
              ? `, max profit $${maxProfit.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              : ''),
        );
      }
    }

    if (openLegs.length === 2) {
      const sell = openLegs.find((l) => l.quantity < 0);
      const buy = openLegs.find((l) => l.quantity > 0);
      if (sell && buy && sell.putCall === buy.putCall) {
        pairs.push({
          shortStrike: sell.strike,
          longStrike: buy.strike,
          type: sell.putCall,
          qty: Math.abs(sell.quantity),
          credit: sell.netPrice,
          width: Math.abs(sell.strike - buy.strike),
          openTime: time,
          closed: false,
        });
      }
    }

    if (closeLegs.length === 2) {
      const btc = closeLegs.find((l) => l.quantity > 0);
      if (btc) {
        // Mark matching open spread as closed
        for (const p of pairs) {
          if (
            !p.closed &&
            p.shortStrike === btc.strike &&
            p.type === btc.putCall
          ) {
            p.closed = true;
            break;
          }
        }
      }
    }
  }

  const openPairs = pairs.filter((p) => !p.closed);
  if (openPairs.length === 0 && bflyLines.length === 0) return [];

  const sorted = openPairs.sort((a, b) => a.shortStrike - b.shortStrike);

  const spreadLines = sorted.map((p) => {
    const typeLabel = p.type === 'PUT' ? 'PCS' : 'CCS';
    const maxLoss = p.width * 100 * p.qty - p.credit * 100 * p.qty;
    const cushion =
      spxPrice != null
        ? p.type === 'PUT'
          ? spxPrice - p.shortStrike
          : p.shortStrike - spxPrice
        : null;
    const cushionStr =
      cushion != null ? `, ${cushion.toFixed(0)} pts cushion` : '';
    return (
      `  ${typeLabel} ${p.shortStrike}/${p.longStrike} x${p.qty} — ` +
      `credit $${(p.credit * 100 * p.qty).toFixed(0)}, ` +
      `max loss $${maxLoss.toFixed(0)}, ` +
      `${p.width} wide${cushionStr}`
    );
  });

  return [...spreadLines, ...bflyLines];
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

// ── Helper: compute max risk for one side of positions ───────

function computeSideMaxRisk(legs: PositionLeg[]): number {
  const shorts = legs
    .filter((l) => l.quantity < 0)
    .sort((a, b) => a.strike - b.strike);
  const longs = legs
    .filter((l) => l.quantity > 0)
    .sort((a, b) => a.strike - b.strike);

  let totalRisk = 0;
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
      const credit = Math.abs(short.averagePrice) - Math.abs(long.averagePrice);
      const maxLoss = (width - credit) * 100 * Math.abs(short.quantity);
      totalRisk += Math.max(0, maxLoss);
    }
  }

  return Math.round(totalRisk);
}
