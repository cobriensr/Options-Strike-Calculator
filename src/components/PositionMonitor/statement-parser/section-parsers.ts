import type {
  AccountSummary,
  CashEntry,
  ExecutedTrade,
  OpenLeg,
  OrderEntry,
  OrderLeg,
  PnLEntry,
  PnLSummary,
  TradeLeg,
} from '../types';
import {
  parseCSVLine,
  parseCurrency,
  parsePercentage,
  parseShortDate,
  parseTosDate,
} from './value-parsers';

// ── Section Detection ──────────────────────────────────────

export interface SectionBounds {
  readonly headerIndex: number;
  readonly dataStart: number;
  readonly dataEnd: number;
}

/**
 * Split the CSV into its six sections by detecting section headers.
 * Returns a map of section name → line index ranges.
 */
export function findSections(lines: string[]): Map<string, SectionBounds> {
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

export function parseCashBalance(
  lines: string[],
  bounds: SectionBounds,
): CashEntry[] {
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

export function parseOrderHistory(
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

export function parseTradeHistory(
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

export function parseOptions(
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

export function parsePnL(
  lines: string[],
  bounds: SectionBounds,
): PnLSummary {
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

export function parseAccountSummarySection(
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
